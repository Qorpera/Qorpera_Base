#!/usr/bin/env python3
import ctypes, fcntl, hashlib, json, os, pathlib, shutil, subprocess, sys
if sys.platform!='linux' or os.getuid()!=0 or not pathlib.Path('/run/qorpera-isolated-linux-proof').is_file() or sorted(os.listdir('/sys/class/net'))!=['lo']:
    raise SystemExit('Ephemeral isolated mount/network/PID namespace required')
node=os.environ.get('QORPERA_PROOF_NODE') or shutil.which('node');bundle=str(pathlib.Path(sys.argv[1]).resolve());output=pathlib.Path(sys.argv[2]);uid=gid=20043
libc=ctypes.CDLL(None,use_errno=True)
def demote():
    os.setgroups([gid]);os.setresgid(gid,gid,gid);os.setresuid(uid,uid,uid)
    if libc.prctl(38,1,0,0,0)!=0:os._exit(98)
def child(args,fds=()):
    return subprocess.run(['/usr/bin/setpriv','--reuid='+str(uid),'--regid='+str(gid),'--clear-groups','--inh-caps=-all','--ambient-caps=-all','--bounding-set=-all','--no-new-privs',node,bundle,*args],pass_fds=tuple(fds),stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=15,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C'})
def write(path,text,mode=0o444,owner=0):
    path=pathlib.Path(path);path.parent.mkdir(parents=True,exist_ok=True);path.write_text(text);path.chmod(mode);os.chown(path,owner,owner)
# Stub models only stopped systemd state and controlled process interruption;
# it does not prove service stoppage or any SQL/VM execution fence.
write('/run/qorpera-systemctl-fixture', '''#!/usr/bin/python3
import json,os,pathlib,signal
cfg=json.loads(pathlib.Path('/run/qorpera-fixture-control').read_text())
p=pathlib.Path('/run/qorpera-fixture-count')
n=int(p.read_text())+1;p.write_text(str(n))
if cfg['killAt']==n: os.kill(os.getppid(),signal.SIGKILL)
print('LoadState=loaded\\nActiveState=inactive\\nSubState=dead\\nMainPID=0\\nControlPID=0\\nJob=\\nUnitFileState=disabled')
''',0o555)
subprocess.run(['mount','--bind','/run/qorpera-systemctl-fixture','/usr/bin/systemctl'],check=True)
lines=[l for l in pathlib.Path('/proc/self/mountinfo').read_text().splitlines() if l.split()[4]=='/mnt/journal']
assert len(lines)==1
before,after=lines[0].split(' - ');a=before.split();b=after.split()
mount={'mountPoint':'/mnt/journal','root':a[3],'filesystem':b[0],'source':b[1]}
assert mount['filesystem'] in ['ext4','xfs','btrfs','zfs'], mount
write('/run/qorpera-mount.json',json.dumps(mount))
write('/run/qorpera-office-provider-install/install.lock','',0o600)
installation=os.open('/run/qorpera-office-provider-install/install.lock',os.O_RDWR);fcntl.flock(installation,fcntl.LOCK_EX|fcntl.LOCK_NB)
results=[]
for crash_at in [0,3,4]:
    root=pathlib.Path('/mnt/journal')/('state-'+str(crash_at));root.mkdir(mode=0o700);os.chown(root,uid,gid)
    p=child(['prepare',str(root),'/run/qorpera-mount.json'])
    if p.returncode: raise RuntimeError('prepare: '+p.stderr)
    packet=json.loads(p.stdout)
    write('/etc/qorpera-fixture/service.json',json.dumps(packet['config']))
    write('/etc/qorpera-fixture/policy.json',json.dumps(packet['policy']))
    write('/run/qorpera-fixture-packet.json',p.stdout)
    receipt=f"/etc/qorpera/office-provider/delete-dispositions/{packet['allocationId']}/{packet['auditId']}.json"
    write(receipt,json.dumps(packet['envelope']))
    write('/run/qorpera-fixture-control',json.dumps({'killAt':crash_at}))
    write('/run/qorpera-fixture-count','0',0o600,uid)
    lock=root/'adoption.lock';write(lock,'',0o600,uid)
    adoption=os.open(lock,os.O_RDWR);fcntl.flock(adoption,fcntl.LOCK_EX|fcntl.LOCK_NB)
    args=['metadata',str(root),'/run/qorpera-fixture-packet.json']
    first=child(args,[installation,adoption])
    stage={'case':'normal' if crash_at==0 else 'SIGKILL at boundary '+str(crash_at),'firstExitCode':first.returncode,'firstStdout':first.stdout,'firstStderr':first.stderr}
    if crash_at and first.returncode!=-9: raise RuntimeError(json.dumps(stage))
    if not crash_at and first.returncode: raise RuntimeError(json.dumps(stage))
    marker=root/packet['allocationId']/'000011.json'
    phase=root/f"reset-phase-{packet['allocationId']}-{packet['envelope']['plan']['resetId']}-5.json"
    stage['afterInterruption']={'markerPresent':marker.exists(),'phase5Present':phase.exists()}
    assert marker.exists()
    assert phase.exists()==(crash_at!=3)
    durable={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in [marker,phase] if p.exists()}
    write('/run/qorpera-fixture-control',json.dumps({'killAt':0}))
    replay=child(args,[installation,adoption]);stage['replayExitCode']=replay.returncode;stage['replayStdout']=replay.stdout;stage['replayStderr']=replay.stderr
    if replay.returncode: raise RuntimeError(json.dumps(stage))
    for path,digest in durable.items():assert hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()==digest
    verified=child(['verify',str(root),'/run/qorpera-fixture-packet.json']);stage['verifyExitCode']=verified.returncode;stage['verifyStdout']=verified.stdout;stage['verifyStderr']=verified.stderr
    if verified.returncode:raise RuntimeError(json.dumps(stage))
    stage['durablePublicationsPreserved']=len(durable);stage['passed']=True;results.append(stage)
    fcntl.flock(adoption,fcntl.LOCK_UN);os.close(adoption)
(output/'metadata-crash-results.json').write_text(json.dumps({'results':results,'mount':mount,'physicalSqlAndServiceState':'synthetic; no execution fence attested'},indent=2)+'\n')
print(json.dumps({'completed':True,'cases':len(results),'originalOutcome':'unknown','liveOperations':0}))
