#!/usr/bin/env bash
set -euo pipefail
[[ ${EUID} -eq 0 && $(hostname) == company41-node-01 ]]
[[ $(systemctl is-active qorpera-lxd-company-provider.service || true) == active ]]
[[ $(systemctl is-active qorpera-lxd-provider.service || true) == inactive ]]
[[ $(lxc list company41-orchestrator-01 --project qorpera-runners --format csv -c s) == RUNNING ]]
printf '%s  %s\n' \
 '15f8cdb8812bde6192bc7d6dd40463dec76ccbf58fb08a439d2d1390375a3ad0' /opt/qorpera/company-provider/qorpera-lxd-provider.mjs \
 'bdcf4fa5a737b23343227559ea2ff415bd76bda267c55645637b0cd55ae091c4' /etc/qorpera/lxd-company-image-provenance.json \
 'b62d24b8335468ef39cd7e16a50beb9d5ddab7343c4e5695273cd0a8d8bb1039' /etc/qorpera/lxd-image-provenance.pub \
 '316006ebe6d263cb716ebf0fbed0917d170f47e777d25838b5720706f787dcec' /opt/qorpera/company-provider/qorpera-lxd-image-provenance.mjs | sha256sum --check --status
grep -Fxq 'QORPERA_LXD_IMAGE_FINGERPRINT=1026b6a5185d047e713b447f1e2d1965069902b291eef55d1a5edf3cfcbf0ee7' /etc/qorpera/lxd-company-provider.env
grep -Fxq 'QORPERA_LXD_GUEST_PACKAGE_MANIFEST_SHA256=ed4a263159da74c661d21324e1f43df2518f60d73a71dcec6c65a36389a0c49f' /etc/qorpera/lxd-company-provider.env
grep -Fxq 'QORPERA_EPHEMERAL_RUNNER_VERSION=0ed9e490f-production' /etc/qorpera/lxd-company-provider.env
/usr/bin/node /opt/qorpera/company-provider/qorpera-lxd-image-provenance.mjs verify \
 --provenance /etc/qorpera/lxd-company-image-provenance.json --public-key /etc/qorpera/lxd-image-provenance.pub \
 --image-server local --image-fingerprint 1026b6a5185d047e713b447f1e2d1965069902b291eef55d1a5edf3cfcbf0ee7 \
 --guest-package-manifest-sha256 ed4a263159da74c661d21324e1f43df2518f60d73a71dcec6c65a36389a0c49f \
 --runner-image localhost/qorpera/sandbox-probe:135b4fc7b40f70a0fd6859fb9400fbb42d820ebc@sha256:adda31f15d111ed8a06d4d773bac9d8d309047e09862642a292068d62b9b60e1 \
 --runner-image-archive-sha256 c9370c825bdbd589bf0c1391e567b8f5ea8ba36161cc554b32fcfb235f046239 \
 --runner-image-cosign-bundle-sha256 98a00fefd625c9aceeadd746ee610682a8787e5ce85ec0a6ac513a354a7491ce
[[ $(curl --silent --cacert /etc/qorpera/runner-provider.crt --connect-timeout 2 --max-time 3 -o /dev/null -w "%{http_code}" https://10.41.0.1:8081/healthz) == 403 ]]
lxc exec company41-orchestrator-01 --project qorpera-runners -- /bin/sh -c 'printf "%s  %s\n" 25fc38add4f8b236154c87338e3427eb61ce7a15f712adb914f52cad864fa54c /opt/qorpera/runner-orchestrator/qorpera-runner-orchestrator.mjs | sha256sum --check --status'
lxc exec company41-orchestrator-01 --project qorpera-runners -- systemctl is-active --quiet qorpera-runner-orchestrator.service
lxc exec company41-orchestrator-01 --project qorpera-runners -- curl --fail --silent --cacert /etc/qorpera/runner-provider-ca.crt --connect-timeout 2 --max-time 5 https://10.41.0.1:8081/healthz >/dev/null
systemctl is-active --quiet qorpera-lxd-company-provider.service
[[ $(systemctl is-active qorpera-lxd-provider.service || true) == inactive ]]
python3 - <<'PY'
import datetime,json,subprocess
guests=json.loads(subprocess.check_output(['/usr/sbin/lxc','list','--project','qorpera-runners','--format','json'],text=True))
assert not any(g['config'].get('user.qorpera.acquisition_id') or (g['name'].startswith('qorpera-') and len(g['name']) == 40 and all(c in '0123456789abcdef' for c in g['name'][8:])) for g in guests)
print(json.dumps({'schema':'qorpera.runtime-final-node-readback/v1','passed':True,'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'sourceCommit':'0ed9e490feebd6d602ffb5f4b7c83471cec15657','companyProvider':'active','legacyProvider':'inactive','orchestrator':'active',
 'providerHealthSource':'company41-orchestrator-01','nodeSourceDeniedWith403':True,'providerHealthHttpsPassed':True,'signatureVerified':True,'imageFingerprint':'1026b6a5185d047e713b447f1e2d1965069902b291eef55d1a5edf3cfcbf0ee7',
 'guestPackageManifestSha256':'ed4a263159da74c661d21324e1f43df2518f60d73a71dcec6c65a36389a0c49f',
 'providerSha256':'15f8cdb8812bde6192bc7d6dd40463dec76ccbf58fb08a439d2d1390375a3ad0',
 'orchestratorSha256':'25fc38add4f8b236154c87338e3427eb61ce7a15f712adb914f52cad864fa54c','jobGuests':0,'databaseAdmissionChanged':False}))
PY

#!/usr/bin/env bash
set -euo pipefail
[[ ${EUID} -eq 0 && $(hostname) == company41-node-01 ]]
python3 - <<'PY'
import datetime,hashlib,json,pathlib,re,subprocess
run='5971ddfd-a4d7-405c-95bd-714b606d9270'
root=pathlib.Path('/var/lib/qorpera-company-provider/runs-runtime-0ed9e490f')
records=[]
for p in root.glob('*/journal.json'):
 assert p.is_file() and not p.is_symlink()
 b=p.read_bytes();j=json.loads(b)
 if j.get('runId',j['acquisitionId'])!=run: continue
 records.append({'journalSha256':hashlib.sha256(b).hexdigest(),**{k:j[k] for k in ['acquisitionId','runId','attempt','workSha256','instanceName','physicalState','createdAt','updatedAt']},'assignmentId':j.get('assignmentId'),'imageFingerprint':j['lxd']['imageFingerprint'],'recoveryVolume':j['lxd']['companyRuntime']['recoveryVolume'],'credentialHashes':j['credentials']})
records.sort(key=lambda j:j['attempt'])
assert len(records)==2 and [j['attempt'] for j in records]==[1,2]
assert records[0]['acquisitionId']==run and records[1]['acquisitionId']!=run
for key in ['acquisitionId','workSha256','instanceName','recoveryVolume']:
 assert len({j[key] for j in records})==2,key
for key in ['activationSha256','assignmentSha256','nativeBridgeSha256']:
 assert len({j['credentialHashes'][key] for j in records})==2,key
assert all(j['physicalState']=='stopped' for j in records)
assert datetime.datetime.fromisoformat(records[0]['updatedAt'].replace('Z','+00:00')) < datetime.datetime.fromisoformat(records[1]['createdAt'].replace('Z','+00:00'))
assert all(j['imageFingerprint']=='1026b6a5185d047e713b447f1e2d1965069902b291eef55d1a5edf3cfcbf0ee7' for j in records)
inventory=json.loads(subprocess.check_output(['/usr/sbin/lxc','list','--project','qorpera-runners','--format','json'],text=True))
assert not any(i['name'] in {j['instanceName'] for j in records} for i in inventory)
jobs=[i for i in inventory if i.get('config',{}).get('user.qorpera.acquisition_id') or re.fullmatch(r'qorpera-[a-f0-9]{32}',i['name'])]
assert len(jobs)==0
login=next(i for i in inventory if i['name']=='qorpera-login-6cb7e55940d74ee6848a2ad2b65c20be')
assert login['status']=='Stopped'
provider=pathlib.Path('/opt/qorpera/company-provider/qorpera-lxd-provider.mjs')
assert provider.is_file() and not provider.is_symlink()
provider_sha=hashlib.sha256(provider.read_bytes()).hexdigest()
assert provider_sha=='15f8cdb8812bde6192bc7d6dd40463dec76ccbf58fb08a439d2d1390375a3ad0'
units={'companyProvider':subprocess.check_output(['systemctl','is-active','qorpera-lxd-company-provider.service'],text=True).strip(),'orchestrator':subprocess.check_output(['/usr/sbin/lxc','exec','company41-orchestrator-01','--project','qorpera-runners','--','systemctl','is-active','qorpera-runner-orchestrator.service'],text=True).strip()}
assert all(v=='active' for v in units.values())
print(json.dumps({'schema':'qorpera.live-handoff-attempt-isolation/v1','passed':True,'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'runId':run,'attempts':records,'distinctGuestsCredentialsAndRecoveryVolumes':True,'bothGuestsRemoved':True,'jobGuests':len(jobs),'loginGuestStopped':True,'providerSha256':provider_sha,'units':units,'credentialValuesReturned':False,'mutationsPerformed':False}))
PY
