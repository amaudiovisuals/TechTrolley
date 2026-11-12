"""Synthetic credentials/files only. Never imports project database settings."""
from datetime import timedelta
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from django.contrib.auth.models import User
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, TransactionTestCase, override_settings
from django.utils import timezone
from rest_framework.authtoken.models import Token
from rest_framework.test import APIClient
from PIL import Image
from .models import Conference, Employee, CompanySettings
from .serializers import ConferenceSerializer
from . import auth_views, user_views, profile_view
from rest_framework.authentication import SessionAuthentication

STRONG = 'Blue!Field-Maple-7832'
NEW = 'Copper!Valley-River-9364'
VALIDATORS = [
    {'NAME':'django.contrib.auth.password_validation.MinimumLengthValidator', 'OPTIONS':{'min_length':10}},
    {'NAME':'django.contrib.auth.password_validation.CommonPasswordValidator'},
    {'NAME':'django.contrib.auth.password_validation.NumericPasswordValidator'},
    {'NAME':'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
]

@override_settings(AUTH_PASSWORD_VALIDATORS=VALIDATORS)
class CredentialSecurityTests(TestCase):
    def setUp(self):
        self.user=User.objects.create_user('tech', email='tech@example.test', password=STRONG)
        self.admin=User.objects.create_user('admin', email='admin@example.test', password=STRONG)
        self.admin.profile.role='admin';self.admin.profile.save()
        self.token=Token.objects.create(user=self.user)
        self.client=APIClient();self.client.credentials(HTTP_AUTHORIZATION=f'Token {self.token.key}')

    def login(self, password=STRONG, email='tech@example.test'):
        return APIClient().post('/api/login/', {'email':email,'password':password}, format='json')

    def reset(self, **kwargs):
        self.client.force_authenticate(self.admin)
        return self.client.post('/api/users/reset-password/', {'email':self.user.email,'new_password':NEW,'current_password':STRONG,**kwargs},format='json')

    def test_login_retains_current_device_token_and_sets_no_store(self):
        response=self.login(email=' TECH@example.test ')
        self.assertEqual(response.status_code,200,response.data)
        self.assertEqual(response.data['token'],self.token.key)
        self.assertEqual(response['Cache-Control'],'no-store')

    def test_expired_token_refused_and_password_login_replaces_only_expired_token(self):
        Token.objects.filter(pk=self.token.pk).update(created=timezone.now()-timedelta(hours=25))
        self.assertEqual(self.client.get('/api/my-profile/').status_code,401)
        response=self.login();self.assertEqual(response.status_code,200)
        self.assertNotEqual(response.data['token'],self.token.key)
        self.assertEqual(self.client.get('/api/my-profile/').status_code,401)

    def test_future_token_is_refused(self):
        Token.objects.filter(pk=self.token.pk).update(created=timezone.now()+timedelta(hours=1))
        self.assertEqual(self.client.get('/api/my-profile/').status_code,401)

    def test_wrong_password_cannot_rotate_expired_token(self):
        Token.objects.filter(pk=self.token.pk).update(created=timezone.now()-timedelta(hours=25))
        self.assertEqual(self.login('wrong').status_code,400)
        self.assertTrue(Token.objects.filter(key=self.token.key).exists())

    def test_password_change_rejects_missing_wrong_short_common_numeric_similar_and_reused(self):
        for value in [None,False,12,{},'', 'short','password123','12345678901234','tech@example.test',STRONG]:
            from .models import CredentialAttempt
            CredentialAttempt.objects.all().delete()
            response=self.client.post('/api/change-password/',{'old_password':STRONG,'new_password':value},format='json')
            self.assertEqual(response.status_code,400,(value,response.data))
        self.assertEqual(self.client.post('/api/change-password/',{'old_password':None,'new_password':NEW},format='json').status_code,400)
        self.user.refresh_from_db();self.assertTrue(self.user.check_password(STRONG));self.assertTrue(Token.objects.filter(key=self.token.key).exists())

    def test_change_revokes_token_and_old_password_new_password_works(self):
        response=self.client.post('/api/change-password/',{'old_password':STRONG,'new_password':NEW},format='json')
        self.assertEqual(response.status_code,200,response.data);self.assertTrue(response.data['login_required'])
        self.assertFalse(Token.objects.filter(user=self.user).exists())
        self.assertEqual(self.client.get('/api/my-profile/').status_code,401)
        self.assertEqual(self.login().status_code,400);self.assertEqual(self.login(NEW).status_code,200)

    def test_change_rolls_back_password_and_token_if_revocation_fails(self):
        with patch('django.db.models.query.QuerySet.delete',side_effect=RuntimeError('injected revocation failure')):
            with self.assertRaises(RuntimeError):self.client.post('/api/change-password/',{'old_password':STRONG,'new_password':NEW},format='json')
        self.user.refresh_from_db();self.assertTrue(self.user.check_password(STRONG));self.assertTrue(Token.objects.filter(key=self.token.key).exists())

    def test_reset_requires_administrator_and_reauthentication(self):
        self.assertEqual(self.client.post('/api/users/reset-password/',{'email':self.user.email,'new_password':NEW,'current_password':STRONG},format='json').status_code,403)
        self.assertEqual(self.reset(current_password='wrong').status_code,400)
        self.assertEqual(self.reset(new_password='password123').status_code,400)
        self.user.refresh_from_db();self.assertTrue(self.user.check_password(STRONG))

    def test_reset_uses_supplied_validated_password_and_revokes_without_returning_password(self):
        response=self.reset();self.assertEqual(response.status_code,200,response.data)
        self.assertNotIn(NEW,str(response.data));self.assertFalse(response.data['login_required'])
        self.user.refresh_from_db();self.assertTrue(self.user.check_password(NEW));self.assertFalse(Token.objects.filter(user=self.user).exists())

    def test_reset_ambiguous_email_and_missing_login_refused_without_provisioning(self):
        User.objects.create_user('duplicate',email=self.user.email)
        self.assertEqual(self.reset().status_code,409)
        before=User.objects.count();self.assertEqual(self.reset(email='missing@example.test').status_code,409);self.assertEqual(User.objects.count(),before)

    def test_system_admin_provision_validates_password(self):
        self.client.force_authenticate(self.admin)
        response=self.client.post('/api/system-users/',{'email':'new@example.test','password':'short'},format='json')
        self.assertEqual(response.status_code,400);self.assertFalse(User.objects.filter(email='new@example.test').exists())

    def test_existing_role_update_does_not_replace_password_or_lose_identity(self):
        employee=Employee.objects.create(name='Tech',email=self.user.email,employee_id='T',user=self.user)
        self.client.force_authenticate(self.admin)
        response=self.client.put('/api/users/role/',{'email':self.user.email,'role':'accounts'},format='json')
        self.assertEqual(response.status_code,200,response.data)
        self.user.refresh_from_db();employee.refresh_from_db();self.assertTrue(self.user.check_password(STRONG));self.assertEqual(employee.user_id,self.user.pk);self.assertEqual(employee.role,'accounts')

    def test_logout_revokes_shared_token_and_is_not_anonymous(self):
        self.assertEqual(APIClient().post('/api/logout/').status_code,401)
        response=self.client.post('/api/logout/');self.assertEqual(response.status_code,200,response.data)
        self.assertEqual(response['Cache-Control'],'no-store');self.assertFalse(Token.objects.filter(user=self.user).exists())
        self.assertEqual(self.client.get('/api/my-profile/').status_code,401)

    def test_stale_authenticated_logout_cannot_revoke_replacement_token(self):
        old=self.token;old.delete();new=Token.objects.create(user=self.user)
        self.client.force_authenticate(self.user, token=old)
        self.assertEqual(self.client.post('/api/logout/').status_code,200)
        self.assertTrue(Token.objects.filter(key=new.key).exists())

    def test_stale_authenticated_password_change_refused_after_reset(self):
        old=self.token;old.delete();new=Token.objects.create(user=self.user)
        self.client.force_authenticate(self.user, token=old)
        self.assertEqual(self.client.post('/api/change-password/',{'old_password':STRONG,'new_password':NEW},format='json').status_code,401)
        self.user.refresh_from_db();self.assertTrue(self.user.check_password(STRONG));self.assertTrue(Token.objects.filter(key=new.key).exists())

    @override_settings(MIDDLEWARE=['django.contrib.sessions.middleware.SessionMiddleware','django.contrib.auth.middleware.AuthenticationMiddleware'],REST_FRAMEWORK={'DEFAULT_AUTHENTICATION_CLASSES':['rest_framework.authentication.SessionAuthentication'],'DEFAULT_PERMISSION_CLASSES':['rest_framework.permissions.IsAuthenticated']})
    @patch.object(auth_views.server_logout.cls, 'authentication_classes', [SessionAuthentication])
    @patch.object(user_views.change_password.cls, 'authentication_classes', [SessionAuthentication])
    @patch.object(profile_view.get_my_profile.cls, 'authentication_classes', [SessionAuthentication])
    def test_password_change_invalidates_existing_browser_sessions_too(self):
        first=APIClient();second=APIClient()
        self.assertTrue(first.login(username=self.user.username,password=STRONG));self.assertTrue(second.login(username=self.user.username,password=STRONG))
        self.assertEqual(second.get('/api/my-profile/').status_code,200)
        response=first.post('/api/change-password/',{'old_password':STRONG,'new_password':NEW},format='json')
        self.assertEqual(response.status_code,200,response.data)
        self.assertEqual(first.get('/api/my-profile/').status_code,403);self.assertEqual(second.get('/api/my-profile/').status_code,403)

    @override_settings(MIDDLEWARE=['django.contrib.sessions.middleware.SessionMiddleware','django.contrib.auth.middleware.AuthenticationMiddleware'],REST_FRAMEWORK={'DEFAULT_AUTHENTICATION_CLASSES':['rest_framework.authentication.SessionAuthentication'],'DEFAULT_PERMISSION_CLASSES':['rest_framework.permissions.IsAuthenticated']})
    @patch.object(auth_views.server_logout.cls, 'authentication_classes', [SessionAuthentication])
    @patch.object(user_views.change_password.cls, 'authentication_classes', [SessionAuthentication])
    @patch.object(profile_view.get_my_profile.cls, 'authentication_classes', [SessionAuthentication])
    def test_session_logout_flushes_current_session_and_revokes_shared_api_token(self):
        client=APIClient();self.assertTrue(client.login(username=self.user.username,password=STRONG))
        self.assertEqual(client.post('/api/logout/').status_code,200)
        self.assertEqual(client.get('/api/my-profile/').status_code,403);self.assertFalse(Token.objects.filter(user=self.user).exists())

    def test_malformed_login_and_ambiguous_email_refused(self):
        for value in [[],{},True,1]:self.assertEqual(self.login(email=value).status_code,400)
        User.objects.create_user('ambiguous',email=self.user.email,password=STRONG)
        self.assertEqual(self.login().status_code,400)


class PrivateMediaSecurityTests(TransactionTestCase):
    def setUp(self):
        self.temp=TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.override=override_settings(MEDIA_ROOT=self.temp.name);self.override.enable();self.addCleanup(self.override.disable)
        self.root=Path(self.temp.name);(self.root/'conference_pdfs').mkdir();(self.root/'company').mkdir()
        (self.root/'conference_pdfs'/'event.pdf').write_bytes(b'%PDF-1.4\nsynthetic only')
        self.event=Conference.objects.create(name='Private event',pdf_document='conference_pdfs/event.pdf')
        self.user=User.objects.create_user('media-tech',email='media-tech@example.test')
        self.employee=Employee.objects.create(name='Tech',employee_id='MEDIA',email=self.user.email,user=self.user)
        self.client=APIClient();self.client.force_authenticate(self.user)
        self.url=f'/api/conferences/{self.event.pk}/download-pdf/'

    def test_anonymous_pdf_refused(self):self.assertEqual(APIClient().get(self.url).status_code,401)

    def test_unassigned_technician_refused_and_assigned_allowed(self):
        self.assertEqual(self.client.get(self.url).status_code,403)
        self.event.assigned_employees.add(self.employee)
        response=self.client.get(self.url);self.assertEqual(response.status_code,200)
        self.assertEqual(b''.join(response.streaming_content),b'%PDF-1.4\nsynthetic only')
        self.assertEqual(response['Content-Type'],'application/pdf');self.assertIn('attachment',response['Content-Disposition'])
        self.assertEqual(response['Cache-Control'],'private, no-store');self.assertEqual(response['X-Content-Type-Options'],'nosniff')

    def test_warehouse_accounts_admin_and_boss_can_read(self):
        for role in ['godown_incharge','accounts','admin','boss']:
            self.user.profile.role=role;self.user.profile.save()
            response=self.client.get(self.url);self.assertEqual(response.status_code,200,role);response.close()

    def test_traversal_absolute_wrong_directory_missing_and_symlink_escape_refused(self):
        self.user.profile.role='admin';self.user.profile.save()
        (self.root/'company'/'other.pdf').write_bytes(b'%PDF-other')
        (self.root/'conference_pdfs'/'escape.pdf').symlink_to(self.root/'company'/'other.pdf')
        for name in ['../outside.pdf',str(self.root/'company'/'other.pdf'),'company/other.pdf','conference_pdfs/missing.pdf','conference_pdfs/escape.pdf']:
            Conference.objects.filter(pk=self.event.pk).update(pdf_document=name)
            self.assertEqual(self.client.get(self.url).status_code,404,name)

    def test_non_pdf_and_large_pdf_download_refused(self):
        self.user.profile.role='admin';self.user.profile.save()
        file=self.root/'conference_pdfs'/'event.pdf';file.write_bytes(b'<html>secret</html>')
        self.assertEqual(self.client.get(self.url).status_code,404)
        with file.open('wb') as f:f.write(b'%PDF-');f.truncate(20*1024*1024+1)
        self.assertEqual(self.client.get(self.url).status_code,404)

    def test_serializer_exposes_authorized_endpoint_not_media_storage_url(self):
        self.assertEqual(ConferenceSerializer(self.event).data['pdf_document'],self.url)

    def test_new_pdf_upload_rejects_html_and_oversize_and_preserves_stream(self):
        serializer=ConferenceSerializer()
        from rest_framework.exceptions import ValidationError
        with self.assertRaises(ValidationError):serializer.validate_pdf_document(SimpleUploadedFile('fake.pdf',b'<script>alert(1)</script>',content_type='application/pdf'))
        large=SimpleUploadedFile('large.pdf',b'%PDF-');large.size=20*1024*1024+1
        with self.assertRaises(ValidationError):serializer.validate_pdf_document(large)
        good=SimpleUploadedFile('valid.pdf',b'%PDF-1.4\nsynthetic');self.assertIs(serializer.validate_pdf_document(good),good);self.assertEqual(good.tell(),0)

    def test_only_configured_raster_logo_public_and_private_paths_never_accepted(self):
        image=BytesIO();Image.new('RGB',(2,2),'white').save(image,format='PNG')
        (self.root/'company'/'logo.png').write_bytes(image.getvalue())
        company=CompanySettings.objects.create(name='Public logo',logo='company/logo.png')
        response=APIClient().get('/api/public-logo/');self.assertEqual(response.status_code,200);self.assertEqual(response['Content-Type'],'image/png');response.close()
        company.logo='conference_pdfs/event.pdf';company.save()
        self.assertEqual(APIClient().get('/api/public-logo/').status_code,404)

    def test_active_html_svg_logo_is_not_served(self):
        (self.root/'company'/'logo.svg').write_text('<svg onload="alert(1)"></svg>')
        CompanySettings.objects.create(name='Bad old logo',logo='company/logo.svg')
        self.assertEqual(APIClient().get('/api/public-logo/').status_code,404)

from concurrent.futures import ThreadPoolExecutor
from threading import Event, Barrier
from unittest import skipUnless
from django.db import connection, close_old_connections
from django.test import TransactionTestCase

@skipUnless(connection.vendor=='postgresql','PostgreSQL row locks required')
class CredentialRaceTests(TransactionTestCase):
    def setUp(self):
        self.user=User.objects.create_user('race-tech',email='race-tech@example.test',password=STRONG)
        self.admin=User.objects.create_user('race-admin',email='race-admin@example.test',password=STRONG)
        self.admin.profile.role='admin';self.admin.profile.save()
        self.admin_token=Token.objects.create(user=self.admin)

    def thread(self, call):
        close_old_connections()
        try:return call()
        finally:close_old_connections()

    def login(self,password=STRONG):
        return APIClient().post('/api/login/',{'email':self.user.email,'password':password},format='json')

    def reset(self):
        client=APIClient();client.credentials(HTTP_AUTHORIZATION=f'Token {self.admin_token.key}')
        return client.post('/api/users/reset-password/',{'email':self.user.email,'new_password':NEW,'current_password':STRONG},format='json')

    def test_two_expired_logins_issue_one_replacement(self):
        token=Token.objects.create(user=self.user)
        Token.objects.filter(pk=token.pk).update(created=timezone.now()-timedelta(hours=25))
        start=Barrier(2)
        def call():start.wait(timeout=10);return self.login()
        with ThreadPoolExecutor(2) as pool:
            results=list(pool.map(lambda _:self.thread(call),range(2)))
        self.assertEqual([r.status_code for r in results],[200,200])
        self.assertEqual(results[0].data['token'],results[1].data['token'])
        self.assertNotEqual(results[0].data['token'],token.key);self.assertEqual(Token.objects.filter(user=self.user).count(),1)

    def test_reset_revokes_token_issued_by_inflight_old_password_login(self):
        from . import auth_views
        real=auth_views.authenticate;inside=Event();release=Event();reset_started=Event()
        def held(*args,**kwargs):
            inside.set();self.assertTrue(release.wait(timeout=10));return real(*args,**kwargs)
        def reset_call():reset_started.set();return self.reset()
        with patch('core.auth_views.authenticate',side_effect=held),ThreadPoolExecutor(2) as pool:
            login=pool.submit(self.thread,self.login);self.assertTrue(inside.wait(timeout=10))
            reset=pool.submit(self.thread,reset_call);self.assertTrue(reset_started.wait(timeout=10));release.set()
            self.assertEqual(login.result(timeout=20).status_code,200);self.assertEqual(reset.result(timeout=20).status_code,200)
        self.assertFalse(Token.objects.filter(user=self.user).exists());self.assertEqual(self.login().status_code,400)

    def test_login_waiting_for_reset_cannot_issue_token_with_old_password(self):
        real=User.save;inside=Event();release=Event();login_started=Event()
        def held(instance,*args,**kwargs):
            if instance.pk==self.user.pk and kwargs.get('update_fields')==['password']:
                inside.set();self.assertTrue(release.wait(timeout=10))
            return real(instance,*args,**kwargs)
        def login_call():login_started.set();return self.login()
        with patch.object(User,'save',held),ThreadPoolExecutor(2) as pool:
            reset=pool.submit(self.thread,self.reset);self.assertTrue(inside.wait(timeout=10))
            login=pool.submit(self.thread,login_call);self.assertTrue(login_started.wait(timeout=10));release.set()
            self.assertEqual(reset.result(timeout=20).status_code,200);self.assertEqual(login.result(timeout=20).status_code,400)
        self.assertFalse(Token.objects.filter(user=self.user).exists());self.assertEqual(self.login(NEW).status_code,200)
