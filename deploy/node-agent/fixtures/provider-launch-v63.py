# Provider v63: provider bytes 000000000000… (#234 run journal archive + dead-token cleanup, #235; source ebd1b13ee), v82 runtime image unchanged, env v54 (= v53 + software version).
# Provider v62: provider bytes 000000000000… (#231 login journal archive, source b7971d0f2), v82 runtime image unchanged, env v53 (= v52 + software version).
# Provider v61: provider bytes 000000000000… (#230 released-login scan), v82 signed runtime image 000000000000… (bundle 000000000000…, source cef154d30), env v52.
# Provider v60: provider bytes 000000000000… (unchanged from the v59 hotfix), v80 signed runtime image 000000000000… (bundle 000000000000…, source ad0c7a65b), env v51.
# Provider v59: hotfix provider bytes (000000000000…, PR #225 node refusal = typed admission refusal, source d2e0fbf0b), v70 image 000000000000… unchanged, env v50.
# Provider v58: v70 provider bytes (000000000000…), v70 signed runtime image 000000000000… (bundle 000000000000…, six changed guest artifacts, native Codex 000000000000… unchanged), env v49.
# Provider v57: v67 provider bytes (000000000000…), v67 signed runtime image 000000000000… (bundle 000000000000…, six changed guest artifacts, native Codex 000000000000… unchanged), env v48.
# Provider v56: v53 provider bytes (000000000000…), v55 signed runtime image 000000000000… (bundle 000000000000…, three changed guest artifacts incl. native Codex 000000000000…), env v45.
# Provider v55: v53 provider bytes (000000000000…), v55 signed runtime image 000000000000… (bundle 000000000000…, three changed guest artifacts incl. native Codex 000000000000…), env v45.
# Provider v54: v53 provider bytes (000000000000…), v55 signed runtime image 000000000000… (bundle 000000000000…, three changed guest artifacts incl. native Codex 000000000000…), env v45.
# Provider v53: login gateway repins a pending login to a locally restored identity (PR #178); v52 bytes otherwise.
# Provider v52: release-once and epoch recovery; preserves v51b lost-inventory fix.
#!/usr/bin/env python3
# Local prepared launcher (v51: v48 bundle bytes, v34 signed image dd338d16042b, env v42; v50: v48 bundle bytes, v30 signed image 6f10a089cbdb, env v41; v49: v48 bundle bytes, v29 signed image ec4fa88d0225, env v40; v48 bundle (a lost run without a guest no longer demands a recovery volume; v47: v46 bundle bytes, v28 signed image 6e83ccdd1f66, env v39 (retired run journals stay readable after an office credential rotation; v45: node retires login journals that never reserved; v44: login stays on its node; key check waits for the guest; v43: a new sign-in replaces the unfinished one; v42: preparing answer after 20 s; v41: login re-pinned to the restored generation): identity recovery inside a member login — node registrar capability file; v37 bundle df34295ab: typed admission refusals + reserving-journal retirement; v36: same v27 provider bundle from 11cb27366 with the isolated test office route; NEW provider state root provider-runs-v36 = the separate rollout lane the provider requires when its governed runtime configuration changes; v26 journals retained untouched); operator installs reviewed root-owned files first.
import os,sys,stat,json,re,hashlib,base64
from pathlib import Path
FIXED={'QORPERA_RUNNER_PROVIDER_BACKEND': 'lxd', 'QORPERA_RUNNER_PROVIDER_ADAPTER': 'native25-phql-a1', 'QORPERA_RUNNER_PROVIDER_HOST': '127.0.0.1', 'QORPERA_RUNNER_PROVIDER_PORT': '18450', 'QORPERA_RUNNER_NODE_ID': '00000000-0000-4000-8000-000000000001', 'QORPERA_RUNNER_PROVIDER_SOFTWARE_VERSION': '1111111111111111111111111111111111111111', 'QORPERA_SUPABASE_URL': 'https://fixtureprojectref0001.supabase.co', 'QORPERA_RUNNER_PROVIDER_STATE_ROOT': '/var/lib/qorpera-native25-phql-a1/provider-runs-v36', 'QORPERA_LXD_PROJECT': 'qn25b2', 'QORPERA_LXD_JOB_PROFILE': 'native25-job-a1', 'QORPERA_LXD_LOGIN_PROFILE': 'native25-login-a1', 'QORPERA_LXD_NETWORK_INTERFACE': 'eth0', 'QORPERA_LXD_IMAGE_SERVER': 'local', 'QORPERA_LXD_STORAGE_POOL': 'qorpera-vm', 'QORPERA_LXD_IDENTITY_VOLUME_PREFIX': 'phql-a1-identity-', 'QORPERA_LXD_IDENTITY_VOLUME_SIZE': '2GiB', 'QORPERA_LXD_ROOT_DISK_SIZE': '80GiB', 'QORPERA_LXD_CPU_LIMIT': '4', 'QORPERA_LXD_MEMORY_LIMIT': '8GiB', 'QORPERA_LXD_GUEST_ASSIGNMENT_PORT': '8082', 'QORPERA_LXD_GUEST_ASSIGNMENT_SOURCE': '10.41.0.1', 'QORPERA_LXD_NATIVE_BRIDGE_PORT': '8083', 'QORPERA_LXD_NATIVE_EXECUTION_GID': '42041', 'QORPERA_LXD_GUEST_READY_TIMEOUT_MS': '300000', 'QORPERA_LXD_GUEST_BOOTSTRAP_SERVICE': 'qorpera-lxd-runner-bootstrap.service', 'QORPERA_EPHEMERAL_RUNNER_IMAGE': 'localhost/qorpera/sandbox-probe:2222222222222222222222222222222222222222@sha256:1111111111111111111111111111111111111111111111111111111111111111', 'QORPERA_EPHEMERAL_RUNNER_PODMAN': '/usr/bin/podman', 'QORPERA_EPHEMERAL_RUNNER_ENTRYPOINT': '/qorpera/bin/run-job', 'QORPERA_EPHEMERAL_RUNNER_VERSION': '3333333333333333333333333333333333333333', 'QORPERA_CODEX_PATH': '/usr/local/bin/codex', 'QORPERA_CLAUDE_PATH': '/usr/local/bin/claude', 'QORPERA_LXD_LOGIN_STATE_ROOT': '/var/lib/qorpera-native25-phql-a1/provider-logins-v26', 'QORPERA_LXD_LOGIN_GATEWAY_HOST': '127.0.0.1', 'QORPERA_LXD_LOGIN_GATEWAY_PORT': '18447', 'QORPERA_LXD_LOGIN_BOOTSTRAP_SERVICE': 'qorpera-lxd-native-login-bootstrap.service', 'QORPERA_LXD_SOCKET': '/var/snap/lxd/common/lxd/unix.socket', 'QORPERA_LXD_OPERATION_TIMEOUT_SECONDS': '120', 'QORPERA_LXD_IMAGE_PROVENANCE': '/etc/qorpera-native25-phql-a1/image-provenance-v82.json', 'QORPERA_LXD_IMAGE_PROVENANCE_PUBLIC_KEY': '/etc/qorpera-native25-phql-a1/image-provenance-public-v82.pem', 'QORPERA_LXD_GUEST_PACKAGE_MANIFEST_SHA256': '2222222222222222222222222222222222222222222222222222222222222222', 'QORPERA_LXD_LOGIN_RECOVERY_REGISTRAR_CAPABILITY_FILE': '/etc/qorpera-native25-phql-a1/recovery-registrar', 'QORPERA_EPHEMERAL_RUNNER_IMAGE_ARCHIVE_SHA256': '3333333333333333333333333333333333333333333333333333333333333333', 'QORPERA_EPHEMERAL_RUNNER_IMAGE_COSIGN_BUNDLE_SHA256': '4444444444444444444444444444444444444444444444444444444444444444', 'QORPERA_NATIVE_RUNTIME': 'company-path-v1', 'QORPERA_NATIVE_CODEX_FENCE_PATH': '/opt/qorpera-harnesses/native-company/codex', 'QORPERA_NATIVE_CODEX_FENCE_SHA256': '5555555555555555555555555555555555555555555555555555555555555555', 'QORPERA_NATIVE_OBJECT_GATEWAY_URL': 'https://node.example.test:10000', 'QORPERA_LXD_NATIVE_OBJECT_TOKEN_FILE': '/etc/qorpera-native25-phql-a1/object-runtime.token', 'QORPERA_LXD_COMPANY_NETWORK': 'qorpera0', 'QORPERA_LXD_RECOVERY_VOLUME_PREFIX': 'phql-a1-recovery-', 'QORPERA_LXD_RECOVERY_VOLUME_SIZE': '4GiB', 'QORPERA_LXD_OFFICE_ROUTES_FILE': '/etc/qorpera-native25-phql-a1/office-routes-a1.json', 'QORPERA_CLOUD_SECRET_BROKER_URL': 'https://node.example.test:10000', 'QORPERA_LXD_CLOUD_SECRET_RUNTIME_TOKEN_FILE': '/etc/qorpera-native25-phql-a1/secret-runtime.token', 'QORPERA_LXD_CLOUD_SECRET_CA_FILE': '/etc/qorpera-native25-phql-a1/recovery-authority-ca.pem'}
MISSING=['QORPERA_RUNNER_PROVIDER_TOKEN', 'QORPERA_SUPABASE_SERVICE_KEY', 'QORPERA_SUPABASE_PUBLISHABLE_KEY', 'QORPERA_LXD_IMAGE_FINGERPRINT', 'QORPERA_LXD_CLOUD_SECRET_CA_SHA256']
BASE=Path('/etc/qorpera-native25-phql-a1')
BUNDLE=Path('/opt/qorpera-native25-phql-a1/qorpera-lxd-provider-v82p2-a1.mjs')
def need(ok):
 if not ok:raise RuntimeError('admission refused')
def read(path,mode,limit):
 need(path.is_absolute() and path.resolve()==path)
 for parent in path.parents:
  s=parent.lstat();need(stat.S_ISDIR(s.st_mode) and s.st_uid==0 and not s.st_mode&0o6022)
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 with os.fdopen(fd,'rb') as f:
  s=os.fstat(f.fileno());need(stat.S_ISREG(s.st_mode) and s.st_uid==0 and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==mode and s.st_size<=limit)
  if mode==0o440:need(s.st_gid==os.getgid())
  return f.read()
def main():
 need(sys.platform=='linux' and os.geteuid()!=0 and os.geteuid()==os.getuid() and os.getegid()==os.getgid())
 status=Path('/proc/self/status').read_text()
 for k in ['CapInh','CapPrm','CapEff','CapBnd','CapAmb']:need(re.search('^'+k+r':\s+0+$',status,re.M))
 need(re.search(r'^NoNewPrivs:\s+1$',status,re.M))
 v=json.loads(read(BASE/'provider-env-v54.json',0o440,32768));need(set(v)=={'schema','projectRef','env'} and v['schema']=='qorpera.native36-provider-env/v1' and v['projectRef']=='fixtureprojectref0001')
 env=v['env'];need(set(env)==set(FIXED)|set(MISSING) and all(env[k]==v for k,v in FIXED.items()) and all(isinstance(v,str) and v and '\0' not in v and '\n' not in v for v in env.values()))
 need(re.fullmatch('[A-Za-z0-9_-]{43}',env['QORPERA_RUNNER_PROVIDER_TOKEN']))
 for k in ['QORPERA_LXD_IMAGE_FINGERPRINT','QORPERA_LXD_CLOUD_SECRET_CA_SHA256']:need(re.fullmatch('[0-9a-f]{64}',env[k]))
 need(env['QORPERA_LXD_IMAGE_FINGERPRINT']!='6666666666666666666666666666666666666666666666666666666666666666')
 need(env['QORPERA_LXD_IMAGE_FINGERPRINT']=='7777777777777777777777777777777777777777777777777777777777777777')
 # Require the ordinary project-bound legacy JWT keys, never a copied opaque key.
 for key,role in [('QORPERA_SUPABASE_SERVICE_KEY','service_role'),('QORPERA_SUPABASE_PUBLISHABLE_KEY','anon')]:
  value=env[key];parts=value.split('.');need(len(parts)==3)
  claims=json.loads(base64.urlsafe_b64decode(parts[1]+'='*((4-len(parts[1])%4)%4)));need(claims.get('ref')==v['projectRef'] and claims.get('role')==role)
 need(hashlib.sha256(read(BUNDLE,0o444,1024*1024)).hexdigest()=='8888888888888888888888888888888888888888888888888888888888888888')
 for n in ['provider-runs-v36','provider-logins-v26']:
  path=Path('/var/lib/qorpera-native25-phql-a1')/n;s=path.lstat();need(path.resolve()==path and stat.S_ISDIR(s.st_mode) and s.st_uid==os.getuid() and s.st_gid==os.getgid() and stat.S_IMODE(s.st_mode)==0o700)
 # The normal CLI is argv[1], so its public main entrypoint really runs.
 clean={'PATH':'/usr/bin:/bin','HOME':'/var/lib/qorpera-native25-phql-a1/provider-runs-v36','LANG':'C','LC_ALL':'C',**env}
 os.execve('/usr/bin/node',['/usr/bin/node','--jitless',str(BUNDLE)],clean)
try:main()
except Exception:
 sys.stderr.write('NATIVE26_PROVIDER_START_REFUSED\n');sys.exit(1)
