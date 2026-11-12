"""Metadata-only literal scan; no network, settings import or business payload reads."""
import pathlib,subprocess,re,json,datetime,collections
root=pathlib.Path(__file__).resolve().parents[2]
def git(*args):return subprocess.check_output(['git','-C',str(root),*args])
rules={
 'private_key_header':re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
 'aws_access_key_shape':re.compile(rb'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b'),
 'google_api_key_shape':re.compile(rb'\bAIza[0-9A-Za-z_-]{30,}\b'),
 'fixed_django_secret_literal':re.compile(rb'''SECRET_KEY\s*=\s*['"][^'"\r\n]{16,}['"]'''),
 'potential_password_literal':re.compile(rb'''(?:password|PASSWORD|passwd)\s*[:=]\s*['"][^'"\r\n]{8,}['"]'''),
}
ext={'.py','.js','.jsx','.ts','.tsx','.yml','.yaml','.sh','.ps1','.bat','.env','.cjs','.mjs'}
# No DBs, dumps, inventory exports, PEM files or arbitrary JSON payloads are read.
def eligible(path):return pathlib.Path(path).suffix in ext and not any(x in pathlib.Path(path).parts for x in ('venv','node_modules','dist','__pycache__'))
objects=collections.defaultdict(set)
for line in git('rev-list','--objects','--all').decode().splitlines():
 parts=line.split(' ',1)
 if len(parts)==2 and eligible(parts[1]):objects[parts[0]].add(parts[1])
ids=list(objects);check=subprocess.run(['git','-C',str(root),'cat-file','--batch-check=%(objectname) %(objecttype) %(objectsize)'],input=('\n'.join(ids)+'\n').encode(),stdout=subprocess.PIPE,check=True).stdout
selected=[row.split()[0].decode() for row in check.splitlines() if row.split()[1]==b'blob' and int(row.split()[2])<=2*1024*1024]
raw=subprocess.run(['git','-C',str(root),'cat-file','--batch'],input=('\n'.join(selected)+'\n').encode(),stdout=subprocess.PIPE,check=True).stdout
pos=0;findings={k:set() for k in rules};blobs={k:0 for k in rules}
while pos<len(raw):
 end=raw.index(b'\n',pos);header=raw[pos:end].split();oid=header[0].decode();length=int(header[2]);data=raw[end+1:end+1+length];pos=end+2+length
 for rule,pattern in rules.items():
  if pattern.search(data):blobs[rule]+=1;findings[rule].update(objects[oid])
current={k:[] for k in rules};current_count=0
for base in ['backend/config','backend/core','frontend']:
 for p in (root/base).rglob('*'):
  name=p.relative_to(root).as_posix()
  if not p.is_file() or not eligible(name) or '/testing/' in name or '/tests' in name:continue
  current_count+=1;data=p.read_bytes()
  for rule,pattern in rules.items():
   if pattern.search(data):current[rule].append(name)
tracked=git('ls-files','-z').decode().split('\0');risk=[]
for name in tracked:
 if name and (pathlib.Path(name).suffix.lower() in {'.pem','.key','.sqlite3','.pyc','.sql','.dump','.xlsx','.csv'} or name.startswith(('data_dumps/','scripts/archive/')) or '/media/' in name):risk.append(name)
out={'recorded_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'read_only':True,'matched_values_returned':False,'business_database_used':False,'network_used':False,'history_commits':int(git('rev-list','--all','--count')),'history_source_blobs_scanned':len(selected),'history_blob_size_cap':2*1024*1024,'current_runtime_source_files_scanned':current_count,'current_runtime_matches':current,'history_matches':{k:{'matching_blobs':blobs[k],'paths':sorted(findings[k])} for k in rules},'tracked_private_or_generated_paths':risk,'limitations':['Shape/literal scan, not a complete secret detector or credential validity test.','History text source only, <=2MiB per blob; DBs/dumps/keys/inventory JSON/binary payloads not opened.','Potential-password literals include fixtures/placeholders; no values are reported.','Tracked artifacts include owner-moved/deleted paths: index/history cleanup remains a separate reviewed operation.','No real credential/token rotation, history rewriting, Git index edits or deletion.']}
import argparse
parser=argparse.ArgumentParser(description='Read-only source/history literal review; no matched values are returned.')
parser.add_argument('--output',required=True,type=pathlib.Path)
args=parser.parse_args()
p=args.output;p.write_text(json.dumps(out,indent=2)+'\n');print(json.dumps({'history_commits':out['history_commits'],'history_source_blobs':len(selected),'current_source_files':current_count,'current_matches':current,'history_matching_blob_counts':blobs,'tracked_private_or_generated_path_count':len(risk)},indent=2))
