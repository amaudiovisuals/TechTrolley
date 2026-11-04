"""Bounded inventory documents; never extracts ZIP members to the filesystem."""
import re
from io import BytesIO
from pathlib import PurePosixPath
from zipfile import ZipFile, BadZipFile
from xml.etree import ElementTree as ET
from django.core.files.uploadhandler import FileUploadHandler
from django.http import JsonResponse
from PIL import Image
from rest_framework.exceptions import APIException, ValidationError
from rest_framework.parsers import JSONParser, FormParser

MAX_WORKBOOK = 5 * 1024 * 1024
MAX_EXPANDED = 32 * 1024 * 1024
MAX_XML = 8 * 1024 * 1024
MAX_LOGO = 2 * 1024 * 1024
MAX_PDF = 20 * 1024 * 1024
MAX_ROWS, MAX_COLUMNS, MAX_CELLS = 5001, 64, 200000


class UploadRejected(APIException):
    status_code = 413
    default_detail = 'Upload exceeds the allowed size or file count.'
    default_code = 'upload_limit_exceeded'


AUTH_PATHS = {'/api/login/', '/api/change-password/', '/api/users/reset-password/', '/api/logout/'}


def body_limit(path): return 16*1024 if path in AUTH_PATHS else 10*1024*1024


def bounded_body(stream, limit):
    data=bytearray()
    while True:
        chunk=stream.read(min(65536,limit+1-len(data)))
        if not chunk: return BytesIO(data)
        data.extend(chunk)
        if len(data)>limit: raise UploadRejected('Request body exceeds the allowed size.')


class BoundedJSONParser(JSONParser):
    def parse(self, stream, media_type=None, parser_context=None):
        context = parser_context or {}
        bounded=bounded_body(stream,body_limit(getattr(context.get('request'), 'path', '')))
        return super().parse(bounded, media_type, context)


class BoundedFormParser(FormParser):
    def parse(self, stream, media_type=None, parser_context=None):
        context = parser_context or {}
        bounded=bounded_body(stream,body_limit(getattr(context.get('request'), 'path', '')))
        return super().parse(bounded, media_type, context)


class BoundedUploadHandler(FileUploadHandler):
    def __init__(self, request, field, limit):
        super().__init__(request); self.allowed_field=field; self.limit=limit; self.files=0; self.bytes=0
    def new_file(self, *args, **kwargs):
        super().new_file(*args, **kwargs); self.files+=1
        if self.files>1 or self.field_name!=self.allowed_field:
            raise UploadRejected('Send only the expected single file for this operation.')
    def receive_data_chunk(self, raw_data, start):
        self.bytes+=len(raw_data)
        if self.bytes>self.limit: raise UploadRejected()
        return raw_data
    def file_complete(self, file_size): return None


class UploadLimitsMiddleware:
    def __init__(self,get_response): self.get_response=get_response
    def __call__(self,request):
        if request.path.startswith('/api/'):
            try: size=int(request.META.get('CONTENT_LENGTH') or 0)
            except (ValueError,TypeError): size=-1
            maximum = body_limit(request.path) if request.path in AUTH_PATHS else 24*1024*1024
            if size<0 or size>maximum:
                return JsonResponse({'error':'request_size_limit','detail':'Request exceeds the allowed size.'},status=413)
            path=request.path
            field,limit=(('file',MAX_WORKBOOK) if path=='/api/upload-assets/' else
                ('logo',MAX_LOGO) if path=='/api/company-settings/' else
                ('pdf_document',MAX_PDF) if re.fullmatch(r'/api/conferences/(?:\d+/)?',path) else ('',0))
            request.upload_handlers.insert(0,BoundedUploadHandler(request,field,limit))
        return self.get_response(request)


def raster_logo(value):
    if value is None: return value
    if value.size<=0 or value.size>MAX_LOGO: raise ValidationError('Use a raster logo no larger than 2 MB.')
    try:
        value.seek(0)
        image=Image.open(value)
        if image.format not in {'PNG','JPEG','GIF','WEBP'} or image.width*image.height>16_000_000:
            raise ValidationError('Use a PNG, JPEG, GIF or WebP logo with at most 16 million pixels.')
        image.verify()
    except (OSError,ValueError,Image.DecompressionBombError):
        raise ValidationError('The logo is not a supported raster image.') from None
    finally: value.seek(0)
    return value


def column_number(label):
    result=0
    for ch in label: result=result*26+ord(ch)-64
    return result


def check_address(address):
    match=re.fullmatch(r'([A-Z]+)([1-9][0-9]*)',address or '')
    if not match or column_number(match[1])>MAX_COLUMNS or int(match[2])>MAX_ROWS:
        raise ValidationError('Workbook exceeds 5000 data rows or 64 columns.')


def read_inventory_workbook(file):
    if not file.name.lower().endswith('.xlsx') or not 0<file.size<=MAX_WORKBOOK:
        raise ValidationError('Use a values-only .xlsx workbook no larger than 5 MB.')
    try:
        file.seek(0)
        with ZipFile(file) as archive:
            entries=archive.infolist()
            if len(entries)>512 or sum(e.file_size for e in entries)>MAX_EXPANDED:
                raise ValidationError('Workbook ZIP expansion exceeds the allowed limit.')
            names=set();cells=0
            for entry in entries:
                name=entry.filename;parts=PurePosixPath(name).parts;lower=name.lower()
                if (entry.flag_bits&1 or name.startswith('/') or '\\' in name or '..' in parts or ':' in name or lower in names
                        or entry.file_size>MAX_XML or entry.file_size>1000*max(1,entry.compress_size)):
                    raise ValidationError('Workbook contains an unsafe or oversized ZIP entry.')
                names.add(lower)
                if any(word in lower for word in ('vbaproject','externallinks/','embeddings/')):
                    raise ValidationError('Macros, embedded objects and external workbook links are not allowed.')
                # Check actual inflated bytes and CRC; do not trust ZIP metadata.
                data=bytearray()
                with archive.open(entry) as stream:
                    while True:
                        chunk=stream.read(65536)
                        if not chunk: break
                        data.extend(chunk)
                        if len(data)>MAX_XML: raise ValidationError('Workbook entry exceeds the expanded-size limit.')
                if not lower.endswith(('.xml','.rels')): continue
                if b'\x00' in data or b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():
                    raise ValidationError('Use ordinary UTF-8 workbook XML without DTDs or entities.')
                xml=ET.fromstring(data)
                for node in xml.iter():
                    tag=node.tag.rsplit('}',1)[-1]
                    if tag=='Relationship' and node.get('TargetMode','').lower()=='external':
                        raise ValidationError('External workbook relationships are not allowed.')
                    if tag == 'Override' and any(v in node.get('ContentType','').lower() for v in ('macroenabled','vbaproject')):
                        raise ValidationError('Macro workbooks are not allowed.')
                    if lower.startswith('xl/worksheets/'):
                        if tag=='dimension':
                            for address in node.get('ref','').split(':'): check_address(address)
                        elif tag=='row':
                            if not (node.get('r','').isdigit() and 1<=int(node.get('r'))<=MAX_ROWS):
                                raise ValidationError('Workbook exceeds the row limit.')
                        elif tag=='c':
                            check_address(node.get('r'));cells+=1
                            if cells>MAX_CELLS: raise ValidationError('Workbook exceeds 200000 cells.')
                        elif tag=='f': raise ValidationError('Convert formulas to values before importing.')
            if not {'[content_types].xml','xl/workbook.xml'}<=names:
                raise ValidationError('This is not an ordinary XLSX workbook.')
        file.seek(0)
        from openpyxl import load_workbook
        from pandas import DataFrame
        workbook=load_workbook(file,read_only=True,data_only=True,keep_links=False)
        try:
            sheet=workbook.worksheets[0]
            if not sheet.max_row or not sheet.max_column or sheet.max_row>MAX_ROWS or sheet.max_column>MAX_COLUMNS:
                raise ValidationError('Workbook exceeds the allowed dimensions.')
            rows=list(sheet.iter_rows(max_row=sheet.max_row,max_col=sheet.max_column,values_only=True))
            header=[str(v).strip() if v is not None else '' for v in rows[0]]
            labels=[v.lower() for v in header if v]
            if len(labels)!=len(set(labels)) or not {'sku','serial number','serial'}&set(labels):
                raise ValidationError('Use distinct headers including SKU or Serial Number.')
            return DataFrame(rows[1:],columns=header)
        finally: workbook.close()
    except ValidationError: raise
    except (BadZipFile,ET.ParseError,KeyError,IndexError,ValueError,OSError,RuntimeError,NotImplementedError,OverflowError):
        raise ValidationError('The workbook is malformed or unsupported. Use the inventory template.') from None
    finally: file.seek(0)
