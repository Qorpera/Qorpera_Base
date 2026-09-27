#!/usr/bin/python3
import os,sys,stat,json,re,hashlib,base64
from pathlib import Path
BASE=Path('/etc/qorpera-native25-phql-a1');BUNDLE=Path('/opt/qorpera-native25-phql-a1/qorpera-runner-orchestrator-hour-v70.mjs')
FIXED={'QORPERA_SUPABASE_URL':'https://fixtureprojectref0001.supabase.co','QORPERA_RUNNER_ORCHESTRATOR_ID':'00000000-0000-4000-8000-000000000001','QORPERA_RUNNER_ORCHESTRATOR_CONTROL_STATE':'/var/lib/qorpera-native25-phql-a1/orchestrator/control.json','QORPERA_RUNNER_PROVIDER_ADAPTER':'native25-phql-a1','QORPERA_RUNNER_PROVIDER_URL':'http://127.0.0.1:18450','QORPERA_RUNNER_ORCHESTRATOR_POLL_MS':'2000','QORPERA_RUNNER_ORCHESTRATOR_CONCURRENCY':'1'}
VARIABLE={'QORPERA_SUPABASE_PUBLISHABLE_KEY','QORPERA_RUNNER_ORCHESTRATOR_CONTROL_TOKEN','QORPERA_RUNNER_PROVIDER_TOKEN'}
def need(v):
 if not v:raise RuntimeError('guard')
def read(path,mode,limit):
 need(path.resolve()==path)
 for parent in path.parents:
  s=parent.lstat();need(stat.S_ISDIR(s.st_mode) and s.st_uid==0 and not s.st_mode&0o6022)
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 with os.fdopen(fd,'rb') as f:
  s=os.fstat(f.fileno());need(stat.S_ISREG(s.st_mode) and s.st_uid==0 and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==mode and 0<s.st_size<=limit)
  if mode==0o440:need(s.st_gid==os.getgid())
  return f.read()
def main():
 need(sys.platform=='linux' and os.getuid()==os.geteuid()!=0 and os.getgid()==os.getegid());status=Path('/proc/self/status').read_text()
 for k in ['CapInh','CapPrm','CapEff','CapBnd','CapAmb']:need(re.search('^'+k+r':\s+0+$',status,re.M))
 need(re.search(r'^NoNewPrivs:\s+1$',status,re.M));need(set(os.getgroups())<= {os.getgid()})
 config=json.loads(read(BASE/'orchestrator-env.json',0o440,16384));need(set(config)=={'projectRef','env'} and config['projectRef']=='fixtureprojectref0001');env=config['env']
 need(set(env)==set(FIXED)|VARIABLE and all(env[k]==v for k,v in FIXED.items()) and all(isinstance(v,str) and v and '\0' not in v and '\n' not in v for v in env.values()))
 for k in ['QORPERA_RUNNER_ORCHESTRATOR_CONTROL_TOKEN','QORPERA_RUNNER_PROVIDER_TOKEN']:need(re.fullmatch('[A-Za-z0-9_-]{43}',env[k]))
 parts=env['QORPERA_SUPABASE_PUBLISHABLE_KEY'].split('.');need(len(parts)==3);claims=json.loads(base64.urlsafe_b64decode(parts[1]+'='*((4-len(parts[1])%4)%4)));need(claims.get('ref')==config['projectRef'] and claims.get('role')=='anon')
 need(hashlib.sha256(read(BUNDLE,0o444,1024*1024)).hexdigest()=='1111111111111111111111111111111111111111111111111111111111111111')
 p=Path('/var/lib/qorpera-native25-phql-a1/orchestrator');s=p.lstat();need(p.resolve()==p and stat.S_ISDIR(s.st_mode) and s.st_uid==os.getuid() and s.st_gid==os.getgid() and stat.S_IMODE(s.st_mode)==0o700)
 os.execve('/usr/bin/node',['/usr/bin/node','--jitless',str(BUNDLE)],{'PATH':'/usr/bin:/bin','HOME':str(p),'LANG':'C','LC_ALL':'C',**env})
try:main()
except Exception as error:
 frames=[];tb=error.__traceback__
 while tb is not None:frames.append({'function':tb.tb_frame.f_code.co_name,'line':tb.tb_lineno});tb=tb.tb_next
 sys.stderr.write(json.dumps({'state':'NATIVE25_ORCHESTRATOR_START_REFUSED','errorType':type(error).__name__,'errorFrames':frames[-8:]})+'\n');sys.exit(1)
