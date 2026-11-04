"""Synthetic shared budgets, local recovery preflight and bounded uploads."""
from datetime import timedelta
from io import BytesIO, StringIO
from unittest.mock import patch
from zipfile import ZipFile, ZIP_DEFLATED
import uuid
from django.contrib.auth.models import User
from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.management import call_command
from django.db import OperationalError
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient
from rest_framework.exceptions import ValidationError
from openpyxl import Workbook
from PIL import Image
from .auth_throttling import consume
from .models import CredentialAttempt, Asset, MovementReceipt, Employee
from .upload_safety import read_inventory_workbook, raster_logo, MAX_WORKBOOK, MAX_LOGO

PASSWORD='Blue!Field-Maple-7832'

def workbook(rows=None):
    wb=Workbook();sheet=wb.active
    for row in rows or [['SKU','Serial Number','Quantity','Type'],['NEW-1','SN-NEW-1',1,'Laptops']]:sheet.append(row)
    stream=BytesIO();wb.save(stream);wb.close();return stream.getvalue()

def uploaded(data=None,name='inventory.xlsx'):
    return SimpleUploadedFile(name,workbook() if data is None else data)

def rewrite_zip(data,entries):
    out=BytesIO()
    with ZipFile(BytesIO(data)) as old,ZipFile(out,'w',ZIP_DEFLATED) as new:
        for name in old.namelist():new.writestr(name,entries.pop(name,old.read(name)))
        for name,value in entries.items():new.writestr(name,value)
    return out.getvalue()

class CredentialBudgetTests(TestCase):
    def setUp(self):
        self.user=User.objects.create_user('budget',email='budget@example.test',password=PASSWORD)
        self.client=APIClient()
    def login(self,password='wrong',**headers):return self.client.post('/api/login/',{'email':self.user.email,'password':password},format='json',**headers)
    def test_login_ten_attempts_shared_across_clients_and_success_does_not_reset(self):
        for i in range(10):self.assertEqual(self.login(PASSWORD if i==0 else 'wrong',REMOTE_ADDR=f'192.0.2.{i+1}').status_code,200 if i==0 else 400)
        other=APIClient();response=other.post('/api/login/',{'email':self.user.email.upper(),'password':PASSWORD},format='json',REMOTE_ADDR='192.0.2.99')
        self.assertEqual(response.status_code,429);self.assertTrue(1<=int(response['Retry-After'])<=300)
    def test_spoofed_forwarded_headers_cannot_reset_peer_budget(self):
        with patch('core.auth_throttling.consume',wraps=consume) as calls:
            self.login(HTTP_X_FORWARDED_FOR='198.51.100.1',REMOTE_ADDR='192.0.2.1')
        self.assertEqual(calls.call_args_list[0].args[:2],('credential-peer','192.0.2.1'))
    def test_peer_budget_caps_malformed_and_distinct_account_requests(self):
        for n in range(60):self.assertEqual(self.client.post('/api/login/',[],format='json').status_code,400)
        response=self.login(PASSWORD);self.assertEqual(response.status_code,429)
        self.assertEqual(CredentialAttempt.objects.count(),1)
    def test_expiry_reopens_budget_without_erasing_other_scopes(self):
        now=timezone.now()
        for n in range(3):self.assertEqual(consume('synthetic','account',3,60,now),0)
        self.assertEqual(consume('synthetic','account',3,60,now),60)
        self.assertEqual(consume('synthetic','account',3,60,now+timedelta(seconds=60)),0)
        self.assertEqual(CredentialAttempt.objects.get().attempts,1)
    def test_database_failure_fails_closed_before_password_verification(self):
        with patch('core.auth_throttling.consume',side_effect=OperationalError('synthetic only')),patch('core.auth_views.authenticate') as auth:
            response=self.login(PASSWORD)
        self.assertEqual(response.status_code,503);auth.assert_not_called()
    def test_password_approval_budget_is_shared_between_change_and_reset(self):
        self.user.profile.role='admin';self.user.profile.save();self.client.force_authenticate(self.user)
        for n in range(10):
            response=self.client.post('/api/change-password/',{'old_password':'wrong','new_password':'Copper!Valley-River-9364'},format='json')
            self.assertEqual(response.status_code,400)
        response=self.client.post('/api/users/reset-password/',{'email':self.user.email,'current_password':PASSWORD,'new_password':'Copper!Valley-River-9364'},format='json')
        self.assertEqual(response.status_code,429);self.user.refresh_from_db();self.assertTrue(self.user.check_password(PASSWORD))
    def test_budget_keys_do_not_store_emails_ips_or_passwords(self):
        self.login();rows=list(CredentialAttempt.objects.values());self.assertEqual(len(rows),2)
        for row in rows:self.assertRegex(row['key'],r'^[a-f0-9]{64}$')
        self.assertNotIn(self.user.email,str(rows));self.assertNotIn('127.0.0.1',str(rows));self.assertNotIn(PASSWORD,str(rows))
    def test_pruning_is_bounded_and_keeps_live_budgets(self):
        now=timezone.now()
        for n in range(3):CredentialAttempt.objects.create(key=str(n),expires_at=now-timedelta(days=2))
        CredentialAttempt.objects.create(key='live',expires_at=now+timedelta(seconds=10))
        call_command('prune_credential_attempts',batch_size=2,stdout=StringIO())
        self.assertEqual(CredentialAttempt.objects.count(),2);self.assertTrue(CredentialAttempt.objects.filter(pk='live').exists())

class SavedWorkPreflightTests(TestCase):
    def setUp(self):
        self.user=User.objects.create_user('recover',email='recover@example.test');self.other=User.objects.create_user('other',email='other@example.test')
        self.client=APIClient();self.client.force_authenticate(self.user)
    def check(self,**fields):return self.client.post('/api/saved-work/recovery-check/',{'email':self.user.email,'request_ids':[],'confirmed_own_work':True,**fields},format='json')
    def test_authenticated_profile_marks_only_unique_current_email(self):
        self.assertTrue(self.client.get('/api/my-profile/').data['legacy_email_scope_allowed'])
        User.objects.create_user('duplicate-email',email=self.user.email.upper())
        self.assertFalse(self.client.get('/api/my-profile/').data['legacy_email_scope_allowed']);self.assertEqual(self.check().status_code,409)
    def test_preflight_is_read_only_and_returns_current_identity(self):
        response=self.check(request_ids=[str(uuid.uuid4())]);self.assertEqual(response.status_code,200)
        self.assertEqual(response.data['user_id'],self.user.pk);self.assertEqual(MovementReceipt.objects.count(),0);self.assertEqual(response['Cache-Control'],'no-store')
    def test_other_account_email_missing_confirmation_and_foreign_receipt_refused(self):
        self.assertEqual(self.check(email=self.other.email).status_code,409);self.assertEqual(self.check(confirmed_own_work=False).status_code,409)
        key=uuid.uuid4();MovementReceipt.objects.create(actor=self.other,request_id=key,payload_hash='synthetic')
        self.assertEqual(self.check(request_ids=[str(key)]).status_code,409)
    def test_exact_own_receipt_allowed_without_replaying_or_mutating(self):
        key=uuid.uuid4();MovementReceipt.objects.create(actor=self.user,request_id=key,payload_hash='synthetic',result={'retained':True})
        self.assertEqual(self.check(request_ids=[str(key)]).status_code,200);self.assertEqual(MovementReceipt.objects.get().result,{'retained':True})
    def test_anonymous_invalid_or_oversized_request_ids_refused(self):
        self.assertEqual(APIClient().post('/api/saved-work/recovery-check/',{},format='json').status_code,401)
        for value in [[None],['invalid'],[str(uuid.uuid4())]*501,{}]:self.assertEqual(self.check(request_ids=value).status_code,400)

class WorkbookSafetyTests(TestCase):
    def test_normal_values_only_workbook_reads_bounded_dataframe(self):
        frame=read_inventory_workbook(uploaded());self.assertEqual(len(frame),1);self.assertEqual(frame.iloc[0]['SKU'],'NEW-1')
    def test_xls_fake_zip_oversize_and_duplicate_headers_refused(self):
        for file in [uploaded(name='old.xls'),uploaded(b'not a zip'),uploaded(workbook([['SKU','sku'],['A','B']]))]:
            with self.assertRaises(ValidationError):read_inventory_workbook(file)
        file=uploaded();file.size=MAX_WORKBOOK+1
        with self.assertRaises(ValidationError):read_inventory_workbook(file)
    def test_formula_dimensions_and_unknown_header_refused(self):
        for rows in [[['SKU'],['=HYPERLINK("https://example.test","x")']],[['Unknown'],['x']]]:
            with self.assertRaises(ValidationError):read_inventory_workbook(uploaded(workbook(rows)))
        data=workbook()
        with ZipFile(BytesIO(data)) as z:sheet=z.read('xl/worksheets/sheet1.xml').replace(b'A1:D2',b'A1:XFD1048576')
        with self.assertRaises(ValidationError):read_inventory_workbook(uploaded(rewrite_zip(data,{'xl/worksheets/sheet1.xml':sheet})))
    def test_macros_external_links_entities_and_path_traversal_refused(self):
        for extra in [{'xl/vbaProject.bin':b'synthetic'},{'xl/externalLinks/link.xml':b'<x/>'},{'../outside.xml':b'<x/>'},{'xl/evil.xml':b'<!DOCTYPE x [<!ENTITY a "x">]><x>&a;</x>'},{'xl/external.rels':b'<Relationships><Relationship TargetMode="External" Target="https://example.test"/></Relationships>'}]:
            with self.assertRaises(ValidationError):read_inventory_workbook(uploaded(rewrite_zip(workbook(),extra)))
    def test_unused_binary_default_from_normal_sheetjs_exports_is_not_a_macro_payload(self):
        data=workbook()
        with ZipFile(BytesIO(data)) as z:content=z.read('[Content_Types].xml')
        declaration=b'<Default Extension="bin" ContentType="application/vnd.ms-excel.sheet.binary.macroEnabled.main"/>'
        safe=content.replace(b'</Types>',declaration+b'</Types>')
        frame=read_inventory_workbook(uploaded(rewrite_zip(data,{'[Content_Types].xml':safe})))
        self.assertEqual(len(frame),1)
        macro=content.replace(b'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',b'application/vnd.ms-excel.sheet.macroEnabled.main+xml')
        with self.assertRaises(ValidationError):read_inventory_workbook(uploaded(rewrite_zip(data,{'[Content_Types].xml':macro})))

    def test_zip_expansion_and_member_count_bounded(self):
        data=rewrite_zip(workbook(),{'xl/oversize.xml':b'x'*(8*1024*1024+1)})
        with self.assertRaises(ValidationError):read_inventory_workbook(uploaded(data))
        data=rewrite_zip(workbook(),{f'docProps/x{n}.xml':b'<x/>' for n in range(513)})
        with self.assertRaises(ValidationError):read_inventory_workbook(uploaded(data))
    def test_logo_types_size_and_pixels_checked_before_image_field(self):
        out=BytesIO();Image.new('RGB',(2,2),'white').save(out,format='PNG')
        file=SimpleUploadedFile('logo.png',out.getvalue());self.assertIs(raster_logo(file),file);self.assertEqual(file.tell(),0)
        for data in [b'<svg onload="alert(1)"></svg>',b'<html>x</html>']:
            with self.assertRaises(ValidationError):raster_logo(SimpleUploadedFile('fake.png',data))
        file.size=MAX_LOGO+1
        with self.assertRaises(ValidationError):raster_logo(file)

@override_settings(MIDDLEWARE=['core.upload_safety.UploadLimitsMiddleware'])
class UploadEndpointTests(TestCase):
    def setUp(self):
        self.user=User.objects.create_user('upload-admin');self.user.profile.role='admin';self.user.profile.save()
        self.client=APIClient();self.client.force_authenticate(self.user)
    def post(self,file,**kwargs):return self.client.post('/api/upload-assets/',{'file':file,**kwargs},format='multipart')
    def test_single_valid_import_creates_new_inventory(self):
        response=self.post(uploaded());self.assertEqual(response.status_code,201,response.data)
        self.assertEqual(response.data['created'],1);self.assertEqual(Asset.objects.get().serial_number,'SN-NEW-1')
    def test_bad_workbook_rejected_before_any_asset_writes(self):
        self.assertEqual(self.post(uploaded(b'<script>bad</script>')).status_code,400);self.assertEqual(Asset.objects.count(),0)
    def test_mixed_existing_and_new_rows_roll_back_and_keep_existing_custody_fields(self):
        asset=Asset.objects.create(sku='EXIST',serial_number='SN-EXIST',quantity=7,status='In Use');before=Asset.objects.values().get()
        data=workbook([['SKU','Serial Number','Quantity','Type'],['NEW-2','SN-NEW-2',1,'Laptops'],['EXIST','SN-EXIST',1,'Laptops']])
        response=self.post(uploaded(data));self.assertEqual(response.status_code,400,response.data);self.assertEqual(response.data['created'],0)
        self.assertEqual(Asset.objects.count(),1);self.assertEqual(before,Asset.objects.values().get(pk=asset.pk))
    def test_duplicate_serial_fractional_or_invalid_row_saves_nothing(self):
        for rows in [[['SKU','Serial Number','Quantity'],['A','S',1],['B','S',1]],[['SKU','Serial Number','Quantity'],['A','S',1.5]]]:
            response=self.post(uploaded(workbook(rows)));self.assertEqual(response.status_code,400,response.data);self.assertEqual(Asset.objects.count(),0)
    def test_warehouse_role_cannot_bulk_rewrite_stock(self):
        self.user.profile.role='godown_incharge';self.user.profile.save()
        self.assertEqual(self.post(uploaded()).status_code,201);before=Asset.objects.values().get();self.assertEqual(self.post(uploaded()).status_code,400);self.assertEqual(Asset.objects.values().get(),before)
    def test_stream_size_duplicate_files_unexpected_field_and_body_limits(self):
        self.assertEqual(self.post(uploaded(b'x'*(MAX_WORKBOOK+1))).status_code,413)
        self.assertEqual(self.client.post('/api/upload-assets/',{'file':[uploaded(),uploaded()]},format='multipart').status_code,413)
        self.assertEqual(self.client.post('/api/upload-assets/',{'other':uploaded()},format='multipart').status_code,413)
        response=self.client.generic('POST','/api/upload-assets/',b'',content_type='application/octet-stream',CONTENT_LENGTH=str(25*1024*1024))
        self.assertEqual(response.status_code,413);self.assertEqual(Asset.objects.count(),0)
    def test_settings_use_existing_non_one_id_and_keep_challan_counter(self):
        from .models import CompanySettings
        config=CompanySettings.objects.create(pk=77,name='Existing canonical issuer',next_challan_number=39,challan_prefix='KEEP')
        self.assertEqual(self.client.get('/api/company-settings/').data['name'],config.name)
        out=BytesIO();Image.new('RGB',(2,2),'white').save(out,format='PNG')
        response=self.client.post('/api/company-settings/',{'logo':SimpleUploadedFile('logo.png',out.getvalue(),content_type='image/png')},format='multipart')
        self.assertEqual(response.status_code,200,response.data);self.assertEqual(CompanySettings.objects.count(),1)
        config.refresh_from_db();self.assertEqual(config.pk,77);self.assertEqual(config.next_challan_number,39);self.assertEqual(config.challan_prefix,'KEEP');self.assertTrue(config.logo)

    def test_invalid_logo_does_not_create_a_new_company_configuration(self):
        from .models import CompanySettings
        response=self.client.post('/api/company-settings/',{'logo':SimpleUploadedFile('evil.png',b'<html>evil</html>')},format='multipart')
        self.assertEqual(response.status_code,400);self.assertEqual(CompanySettings.objects.count(),0)

    def test_pdf_stream_limit_is_413_before_event_creation(self):
        from .models import Conference
        file=SimpleUploadedFile('oversize.pdf',b'%PDF-'+b'x'*(20*1024*1024))
        response=self.client.post('/api/conferences/',{'name':'Too large','pdf_document':file},format='multipart')
        self.assertEqual(response.status_code,413,response.data);self.assertEqual(Conference.objects.count(),0)

    def test_pdf_and_valid_logo_still_save_through_multipart(self):
        from .models import Conference,CompanySettings
        response=self.client.post('/api/conferences/',{'name':'Valid upload','start_date':'2026-10-15','end_date':'2026-10-16','pdf_document':SimpleUploadedFile('small.pdf',b'%PDF-1.4 synthetic')},format='multipart')
        self.assertEqual(response.status_code,201,response.data);self.assertTrue(Conference.objects.get().pdf_document)
        out=BytesIO();Image.new('RGB',(2,2),'white').save(out,format='PNG')
        response=self.client.post('/api/company-settings/',{'logo':SimpleUploadedFile('logo.png',out.getvalue(),content_type='image/png')},format='multipart')
        self.assertEqual(response.status_code,200,response.data);self.assertTrue(CompanySettings.objects.get().logo)

    def test_database_failure_rolls_back_earlier_new_rows(self):
        from .serializers import AssetSerializer
        original=Asset.save;calls=[]
        def fail_second(instance,*args,**kwargs):
            calls.append(1)
            if len(calls)==2: raise OperationalError('synthetic DB failure')
            return original(instance,*args,**kwargs)
        rows=[['SKU','Serial Number','Quantity','Type'],['FIRST','FIRST-SN',1,'Laptops'],['SECOND','SECOND-SN',1,'Laptops']]
        with patch.object(Asset,'save',fail_second), self.assertLogs('core.views',level='ERROR'):response=self.post(uploaded(workbook(rows)))
        self.assertEqual(len(calls),2);self.assertEqual(response.status_code,500);self.assertEqual(Asset.objects.count(),0)

    def test_invalid_logo_is_400_and_stream_limit_is_413_without_saving(self):
        response=self.client.post('/api/company-settings/',{'logo':SimpleUploadedFile('evil.png',b'<html>evil</html>')},format='multipart');self.assertEqual(response.status_code,400)
        response=self.client.post('/api/company-settings/',{'logo':SimpleUploadedFile('large.png',b'x'*(MAX_LOGO+1))},format='multipart');self.assertEqual(response.status_code,413)

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest import skipUnless
from django.db import connection,close_old_connections
from django.test import TransactionTestCase

@skipUnless(connection.vendor=='postgresql','PostgreSQL row locks required')
class CredentialBudgetRaceTests(TransactionTestCase):
    def race(self,existing):
        if existing:self.assertEqual(consume('race-budget','same-account',3,300),0)
        barrier=Barrier(8)
        def worker(_):
            close_old_connections()
            try:barrier.wait(timeout=10);return consume('race-budget','same-account',3,300)
            finally:close_old_connections()
        with ThreadPoolExecutor(8) as pool:results=list(pool.map(worker,range(8)))
        self.assertEqual(sum(v==0 for v in results),2 if existing else 3)
        self.assertEqual(CredentialAttempt.objects.get().attempts,3)
    def test_first_bucket_creation_cannot_overshoot_across_connections(self):self.race(False)
    def test_existing_bucket_cannot_overshoot_across_connections(self):self.race(True)

class RequestParserBoundTests(TestCase):
    def test_json_and_form_actual_stream_limits_do_not_trust_declared_length(self):
        from types import SimpleNamespace
        from .upload_safety import BoundedJSONParser,BoundedFormParser,UploadRejected
        for C in [BoundedJSONParser,BoundedFormParser]:
            for path,limit in [('/api/login/',16*1024),('/api/conferences/',10*1024*1024)]:
                with self.assertRaises(UploadRejected):C().parse(BytesIO(b'x'*(limit+1)),parser_context={'request':SimpleNamespace(path=path)})
    def test_small_auth_json_and_form_parse_normally(self):
        from types import SimpleNamespace
        from .upload_safety import BoundedJSONParser,BoundedFormParser
        context={'request':SimpleNamespace(path='/api/login/')}
        class ShortReads(BytesIO):
            def read(self,n=-1):return super().read(min(3,n) if n>=0 else 3)
        self.assertEqual(BoundedJSONParser().parse(ShortReads(b'{"email":"synthetic@example.test"}'),parser_context=context)['email'],'synthetic@example.test')
        self.assertEqual(BoundedJSONParser().parse(BytesIO(b'{"email":"synthetic@example.test"}'),parser_context=context)['email'],'synthetic@example.test')
        self.assertEqual(BoundedFormParser().parse(BytesIO(b'email=synthetic%40example.test'),parser_context=context)['email'],'synthetic@example.test')
    def test_malformed_json_stays_a_400_parse_error(self):
        response=APIClient().post('/api/login/','{bad',content_type='application/json')
        self.assertEqual(response.status_code,400)
