#!/usr/bin/env python3
"""Prepared, not yet Linux-executed. Disposable network-none container only.
Never use on a live host; synthetic receipt proves filesystem custody only.
"""
import ctypes, fcntl, json, os, pathlib, shutil, subprocess, sys, uuid
if sys.platform != 'linux' or os.getuid() != 0 or not (pathlib.Path('/.dockerenv').exists() or pathlib.Path('/run/qorpera-isolated-linux-proof').is_file()):
    raise SystemExit('Requires root in a disposable Docker Linux container')
if sorted(os.listdir('/sys/class/net')) != ['lo']:
    raise SystemExit('Requires --network none')
if any(pathlib.Path(p).exists() for p in ['/var/run/docker.sock', '/run/lxd.socket', '/var/snap/lxd/common/lxd/unix.socket']):
    raise SystemExit('Refuses privileged host sockets')
probe = pathlib.Path(sys.argv[1]).resolve()
node = os.environ.get('QORPERA_PROOF_NODE') or shutil.which('node')
if not node or not probe.is_file(): raise SystemExit('Local Node and bundled probe required')
uid = gid = 20043
account = 'qorpera-office-provider'
passwd = pathlib.Path('/etc/passwd')
if any(line.split(':')[0] == account or line.split(':')[2] == str(uid) for line in passwd.read_text().splitlines()):
    raise SystemExit('Disposable fixture account already exists; refusing reuse')
# All following changes are confined to this disposable container writable layer.
with passwd.open('a') as f: f.write(f'{account}:x:{uid}:{gid}::/nonexistent:/usr/sbin/nologin\n')
root = pathlib.Path('/run') / ('qorpera-linux-fixture-' + str(uuid.uuid4()))
root.mkdir(mode=0o755)
namespace_root = pathlib.Path('/run/qorpera-office-provider')
namespace_root.mkdir(mode=0o755)  # Existing installation causes a hard refusal.
record = namespace_root / 'host-mount-namespace.json'
ns = os.readlink('/proc/self/ns/mnt')
boot = pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()
original_record = json.dumps({'schema':'qorpera.lxd-office-host-namespace/v1','bootId':boot,'namespace':ns})
record.write_text(original_record); record.chmod(0o444)
receipt = root/'synthetic-receipt.json'; receipt.write_text('{"synthetic":true,"originalOutcome":"unknown"}\n'); receipt.chmod(0o444)
locks = [root/'installation.lock', root/'adoption.lock']
fds=[]
for i,p in enumerate(locks):
    fd=os.open(p, os.O_CREAT|os.O_EXCL|os.O_RDWR,0o600)
    os.fchown(fd, 0 if i==0 else uid, 0 if i==0 else gid)
    fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB); fds.append(fd)
libc=ctypes.CDLL(None,use_errno=True)
def demote(no_new_privs=True, groups=None):
    def child():
        os.setgroups([gid] if groups is None else groups)
        os.setresgid(gid,gid,gid); os.setresuid(uid,uid,uid)
        if no_new_privs and libc.prctl(38,1,0,0,0)!=0: os._exit(98)
    return child
results=[]
def run(label, mode='boundary', expect=None, keep=None, as_root=False, nnp=True, groups=None):
    args=[node,str(probe),mode,str(receipt),*map(str,locks)]
    p=subprocess.run(args,pass_fds=tuple(fds if keep is None else keep),preexec_fn=None if as_root else demote(nnp,groups),stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=8,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C'})
    result={'case':label,'exitCode':p.returncode,'stdout':p.stdout,'stderr':p.stderr}
    result['passed']=(p.returncode==0 if expect is None else p.returncode!=0 and expect in p.stderr)
    results.append(result)
    if not result['passed']: raise RuntimeError('Probe failed: '+label)
    return json.loads(p.stdout) if p.returncode==0 else None
try:
    boundary=run('inherited root and provider flocks; protected file; namespace')
    fields=boundary['kernelFields']
    assert fields['Uid'].split()==[str(uid)]*4 and fields['Gid'].split()==[str(gid)]*4
    assert fields['Groups'].split()==[str(gid)] and fields['NoNewPrivs']=='1'
    assert all(int(fields[k],16)==0 for k in ['CapInh','CapPrm','CapEff','CapAmb'])
    results.append({'case':'actual uid gid saved IDs groups capabilities and NoNewPrivs','passed':True,'kernelFields':fields})
    run('missing installation FD',expect='OFFICE_INSTALL_KERNEL_LOCK_REQUIRED',keep=[fds[1]])
    run('missing adoption FD',expect='OFFICE_INSTALL_KERNEL_LOCK_REQUIRED',keep=[fds[0]])
    receipt.chmod(0o666)
    run('writable root receipt refused',expect='OFFICE_HOST_FILE_UNPROTECTED')
    receipt.chmod(0o444)
    run('metadata command rejects root',mode='metadata-rejection',expect='PROVIDER_UID_REQUIRED',as_root=True)
    run('metadata command rejects absent NoNewPrivs',mode='metadata-rejection',expect='PROCESS_PRIVILEGED',nnp=False)
    run('metadata command rejects supplementary root group',mode='metadata-rejection',expect='PROCESS_PRIVILEGED',groups=[gid,0])
    if isinstance(boundary['pid1Namespace'],dict) and boundary['pid1Namespace'].get('error') in ['EACCES','EPERM']:
        changed=json.loads(original_record);changed['bootId']='11111111-1111-4111-8111-111111111111';record.chmod(0o644);record.write_text(json.dumps(changed));record.chmod(0o444)
        run('real protected namespace fallback rejects wrong boot',expect='OFFICE_PROVIDER_BOOT_UNCONFIRMED')
    else:
        results.append({'case':'restricted PID1 namespace fallback','passed':False,'status':'not exercised; PID1 link readable'})
        raise RuntimeError('Mandatory restricted PID1 fallback was not exercised')
finally:
    print(json.dumps({'results':results,'synthetic':['receipt semantics','SQL','physical fence'], 'remaining':['full metadata command success','actual process kill and crash replay','root recovery operator'], 'containerFixtureRoot':str(root)},indent=2))
    record.chmod(0o644); record.write_text(original_record); record.chmod(0o444)
    # Retain files until parent captures stdout/evidence and removes this owned container.
