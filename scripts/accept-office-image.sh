#!/usr/bin/env bash
# F3 4e: the cold-boot acceptance of an office image, A1's verifier (guest-proof-v3) ported. On a node's host the image
# is copied into a throwaway project and booted once as a fresh VM with no profile and no network card. From inside it
# proves KVM and Secure Boot, the office account (the physical policy's workbench uid/gid), the installation receipt and
# package manifest the image's labels name, the office service disabled and never started, empty credentials, no JWT-
# or Supabase-secret-shaped string on its disk, the unconfigured services refused, and Chromium's sandbox. Only the VM,
# the image copy and the throwaway project are deleted. sign-office-image-provenance.mjs signs the evidence with the
# build's. See deploy/first-node/OFFICE-IMAGE-PRODUCTION.md.
#
# As root on node01's host:
#   bash scripts/accept-office-image.sh --hostname <node01's hostname> --policy <the physical policy> \
#     --evidence <new file> [--pool qorpera-vm] [--root-size 80GiB] <image fingerprint> <its project> </dev/null
set -euo pipefail

fail() { echo "FAIL: $*" >&2; exit 1; }
usage="usage: accept-office-image.sh --hostname <host> --policy <file> --evidence <new file> [--pool <name>] \
[--root-size <N>GiB] <fingerprint> <project>"
host=''
policy=''
evidence=''
pool=qorpera-vm
root_size=80GiB
positional=()
while (($#)); do
	case $1 in
	--hostname | --policy | --evidence | --pool | --root-size)
		(($# >= 2)) && [[ -n $2 ]] || fail "$usage"
		case $1 in
		--hostname) host=$2 ;;
		--policy) policy=$2 ;;
		--evidence) evidence=$2 ;;
		--pool) pool=$2 ;;
		--root-size) root_size=$2 ;;
		esac
		shift 2
		;;
	-*) fail "$usage" ;;
	*)
		positional+=("$1")
		shift
		;;
	esac
done
((${#positional[@]} == 2)) && [[ -n $host && -n $policy && -n $evidence ]] || fail "$usage"
fingerprint=${positional[0]}
project=${positional[1]}
[[ $fingerprint =~ ^[0-9a-f]{64}$ ]] || fail "the image is named by its full fingerprint"
[[ $project =~ ^[a-z][a-z0-9-]{0,62}$ && $pool =~ ^[a-z][a-z0-9-]{0,62}$ ]] || fail "invalid project or pool name"
# The image's root is the build's: the VM's may not be smaller, nor larger than a guest's (1 TiB).
[[ $root_size =~ ^[1-9][0-9]{1,3}GiB$ ]] && ((${root_size%GiB} >= 24 && ${root_size%GiB} <= 1024)) ||
	fail "the root size is 24GiB to 1024GiB"
evidence=$(realpath -m -- "$evidence")
for file in "$evidence" "$evidence.png"; do
	[[ ! -e $file && ! -L $file ]] || fail "$file exists"
done
[[ -d $(dirname "$evidence") ]] || fail "$evidence has no directory"
# The office account must be the policy's workbench account, as build-office-image-production.sh takes it.
[[ -f $policy && ! -L $policy ]] || fail "no policy at $policy"
office_id=$(jq -er 'select(.schema == "qorpera.lxd-office-physical-policy/v2") | .workbench
	| select(.uid == .gid and (.uid | type == "number" and . == floor and . >= 1 and . <= 2147483647)) | .uid' \
	"$policy" 2>/dev/null) || fail "$policy is not a physical policy whose workbench uid and gid are one id"

[[ $(id -u) == 0 ]] || fail "run as root on node01's host"
[[ $(hostname) == "$host" ]] || fail "this machine is $(hostname), not $host"
[[ ! -e /etc/qorpera-test-machine-versions && -c /dev/kvm ]] || fail "a node host with KVM required"
# A VM needs KVM and the vsock its LXD agent talks over; this run never loads a module on the host.
[[ -d /sys/module/kvm && -d /sys/module/vhost_vsock ]] || fail "kvm or vhost_vsock is not loaded"
[[ $(lxc remote get-default) == local ]] || fail "LXD must target its local Unix socket"
[[ $(lxc remote list --format json | jq -r '.local.Addr') == unix:// ]] || fail "local LXD is not its Unix socket"
lxc --force-local storage show "$pool" </dev/null >/dev/null || fail "no storage pool $pool"

suffix=$(cut -c 1-8 /proc/sys/kernel/random/uuid)
throwaway="qoa-${suffix}"
vm="qorpera-image-accept-${suffix}"
work=$(mktemp -d /tmp/qorpera-office-acceptance.XXXXXXXX)
made_project=0
made_copy=0
made_vm=0
lq() { lxc --force-local query "$@" </dev/null; }
la() { lxc --force-local --project "$throwaway" "$@" </dev/null; }

machine_state() {
	# Guests start and stop meanwhile, so their links are not compared; the acceptance changes no nft table or sysctl.
	nft list tables | sort
	sysctl net.ipv4.ip_forward net.ipv4.conf.all.rp_filter net.netfilter.nf_conntrack_max
	if [[ -f /proc/sys/net/bridge/bridge-nf-call-iptables ]]; then
		cat /proc/sys/net/bridge/bridge-nf-call-iptables
	else
		echo 'no br_netfilter'
	fi
}

cleanup() {
	local status=$?
	trap - EXIT
	set +e
	if ((made_vm)); then la delete --force "$vm" || status=1; fi
	# The copy only: LXD keeps the image in its own project.
	if ((made_copy)); then la image delete "$fingerprint" || status=1; fi
	if ((made_project)); then lxc --force-local project delete "$throwaway" </dev/null || status=1; fi
	machine_state >"$work/after"
	diff -u "$work/before" "$work/after" || status=1
	awk '{print $1}' /proc/modules | sort >"$work/modules-after"
	if ! diff -u "$work/modules-before" "$work/modules-after"; then
		echo 'FAIL: a host kernel module appeared or disappeared' >&2
		status=1
	fi
	if [[ $status == 0 ]]; then
		(set -o noclobber; cat "$work/evidence.json" >"$evidence" && cat "$work/screenshot.png" >"$evidence.png") &&
			chmod 0444 "$evidence" "$evidence.png" || status=1
	fi
	if [[ -f "$work/evidence.json" ]]; then
		echo 'OFFICE_IMAGE_ACCEPTANCE_EVIDENCE_BEGIN'
		cat "$work/evidence.json"
		echo 'OFFICE_IMAGE_ACCEPTANCE_EVIDENCE_END'
	fi
	rm -rf -- "$work"
	exit "$status"
}
machine_state >"$work/before"
awk '{print $1}' /proc/modules | sort >"$work/modules-before"
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# As the orchestrator inspects an office image (lxd-client.ts inspectOfficeImage). The receipt and manifest the proof
# checks are the image's own labels; the signer holds them against the build's evidence.
lq "/1.0/images/$fingerprint?project=$project" >"$work/image.json" || fail "$project has no image $fingerprint"
jq -e --arg image "$fingerprint" \
	'.fingerprint == $image and .type == "virtual-machine" and .public == false and .auto_update == false
	and .architecture == "x86_64" and (.size | type == "number" and . == floor and . >= 1 and . <= pow(1024; 4))
	and .profiles == [] and ([.properties["qorpera.installationReceiptSha256"], .properties["qorpera.packageManifestSha256"]]
	| all(type == "string" and test("^[0-9a-f]{64}$")))' \
	"$work/image.json" >/dev/null || fail "image $fingerprint is not an office image: $(cat "$work/image.json")"
receipt=$(jq -r '.properties["qorpera.installationReceiptSha256"]' "$work/image.json")
manifest=$(jq -r '.properties["qorpera.packageManifestSha256"]' "$work/image.json")

# A fresh project of this run's, so nothing in the image's own project changes.
lxc --force-local project create "$throwaway" -c features.images=true -c features.profiles=false \
	-c features.storage.volumes=true </dev/null
made_project=1
lxc --force-local image copy "$fingerprint" local: --project "$project" --target-project "$throwaway" </dev/null
made_copy=1
[[ $(la image list --format json | jq -r 'if length == 1 then .[0].fingerprint else empty end') == "$fingerprint" ]] ||
	fail "$throwaway does not hold exactly the image"
# Admission stays on: the 4 GiB VM starts only with 16 GiB available, so it never takes an office's memory.
available=$(awk '$1 == "MemAvailable:" {print $2}' /proc/meminfo)
((available >= 16 * 1024 * 1024)) || fail "MemAvailable is $((available / 1024)) MiB, under 16 GiB"
# No profile, so no NIC; the root disk is its only device.
la init "$fingerprint" "$vm" --vm --no-profiles --storage "$pool" \
	-c boot.mode=uefi-secureboot -c boot.autostart=false -c limits.cpu=2 -c limits.memory=4GiB -d root,size="$root_size" \
	-c user.qorpera.purpose=office-image-acceptance
made_vm=1
lq "/1.0/instances/$vm?project=$throwaway" >"$work/instance.json"
jq -e --arg pool "$pool" --arg size "$root_size" \
	'.expanded_devices == {root: {type: "disk", path: "/", pool: $pool, size: $size}} and .profiles == []' \
	"$work/instance.json" >/dev/null || fail "the VM has other devices: $(jq -c .expanded_devices "$work/instance.json")"
uuid=$(la config get "$vm" volatile.uuid)
[[ $uuid =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || fail "the VM has no UUID"

if ! la start "$vm"; then
	la info --show-log "$vm" || true
	fail "the VM did not start"
fi
for _attempt in $(seq 1 150); do
	if la exec "$vm" -- true >/dev/null 2>&1; then break; fi
	sleep 2
done
la exec "$vm" -- true
[[ -z $(la exec "$vm" -- ip -br link | awk '$1 != "lo" {print $1}') ]] || fail "the VM unexpectedly has a NIC"
cloud_init=$(la exec "$vm" -- cloud-init status --wait 2>&1 | tail -1) || true

# A1's guest-proof-v3: arguments, not stdin; Secure Boot by its exact variable; the office units never started; the
# credentials; and a scan of the whole disk for secret-shaped strings, which reports paths, never values.
IFS= read -r -d '' guest_proof <<'EOF' || true
import grp
import hashlib
import json
import os
import pathlib
import pwd
import re
import signal
import stat
import subprocess
import sys
import time
import uuid

P = pathlib.Path
ENV = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': '/nonexistent', 'LANG': 'C', 'LC_ALL': 'C'}
# The policy's workbench account, the fourth argument; main refuses without it.
UID = GID = int(sys.argv[4]) if len(sys.argv) == 5 and re.fullmatch(r'[1-9][0-9]{0,9}', sys.argv[4]) else -1
OFFICE = 'qorpera-company-computer.service'
SERVICES = [OFFICE, 'qorpera-company-computer-preparation.service']
PRIVATE = 'run-qorpera\\x2doffice-private.mount'
FOLDER = ['qorpera-office-folder-helper.socket', 'qorpera-office-folder-helper.service']
MASKS = ['apt-daily.timer', 'apt-daily-upgrade.timer', 'apt-daily.service', 'apt-daily-upgrade.service',
         'unattended-upgrades.service']
SECURE_BOOT = P('/sys/firmware/efi/efivars/SecureBoot-8be4df61-93ca-11d2-aa0d-00e098032b8c')
SHA = re.compile(r'[0-9a-f]{64}')
UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
SECRETS = {'jwt': re.compile(rb'eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+'),
           'supabase-secret': re.compile(rb'sb_secret_[A-Za-z0-9_-]{16,}')}
CHROME = '/usr/lib/qorpera-chromium/chrome'


def need(ok, message):
    if not ok:
        raise RuntimeError(message)


def run(argv, timeout=30, allow=False, env=None):
    r = subprocess.run(argv, env=env or ENV, stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout)
    need(len(r.stdout) + len(r.stderr) <= 8 * 1024 ** 2, 'command output bound')
    if not allow:
        need(r.returncode == 0, 'command failed: ' + argv[0] + ' stderrSha256=' + hashlib.sha256(r.stderr).hexdigest())
    return r


def safe_bytes(path, limit=64 * 1024 ** 2):
    p = P(path)
    s = p.lstat()
    for parent in p.parents:
        ps = parent.lstat()
        need(stat.S_ISDIR(ps.st_mode) and ps.st_uid == 0 and not ps.st_mode & 0o022, 'unprotected parent ' + str(parent))
    need(p.resolve() == p and stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_uid == 0 and s.st_gid == 0
         and not s.st_mode & 0o6022 and s.st_size <= limit, 'unprotected file ' + path)
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as f:
        b = f.read(limit + 1)
        after = os.fstat(f.fileno())
    need((s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
         == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns), 'file changed ' + path)
    need(len(b) == s.st_size, 'file size ' + path)
    return b, s


def props(unit, keys='LoadState,ActiveState,SubState,UnitFileState,Job,DropInPaths,MainPID'):
    r = run(['/usr/bin/systemctl', 'show', unit, '--property=' + keys])
    return dict(line.split('=', 1) for line in r.stdout.decode().splitlines() if '=' in line)


def identity(product_uuid):
    need(sys.platform == 'linux' and os.geteuid() == 0, 'Linux guest root required')
    need(run(['/usr/bin/systemd-detect-virt', '--vm']).stdout.strip() == b'kvm', 'real KVM required')
    need(P('/sys/firmware/efi').is_dir(), 'UEFI boot required')
    variables = sorted(p.name for p in P('/sys/firmware/efi/efivars').glob('SecureBoot-*'))
    value = SECURE_BOOT.read_bytes() if SECURE_BOOT.exists() else b''
    # Four attribute bytes, then the value.
    need(variables == [SECURE_BOOT.name] and len(value) == 5 and value[4] == 1, 'Secure Boot unconfirmed')
    product = P('/sys/class/dmi/id/product_uuid').read_text().strip().lower()
    need(product == product_uuid, 'wrong VM')
    return {'bootId': P('/proc/sys/kernel/random/boot_id').read_text().strip(),
            'machineIdSha256': hashlib.sha256(P('/etc/machine-id').read_bytes()).hexdigest(),
            'productUuid': product, 'virtualization': 'kvm', 'firmware': 'uefi', 'secureBootVariable': SECURE_BOOT.name,
            'secureBoot': True}


def account():
    p = pwd.getpwnam('qorpera-office')
    g = grp.getgrnam('qorpera-office')
    need((p.pw_uid, p.pw_gid, p.pw_dir, p.pw_shell) == (UID, GID, '/nonexistent', '/usr/sbin/nologin'), 'account differs')
    need(g.gr_gid == GID and not g.gr_mem, 'group differs/shared')
    need([x.pw_name for x in pwd.getpwall() if x.pw_uid == UID or x.pw_gid == GID] == ['qorpera-office'], 'UID/GID shared')
    need(run(['/usr/bin/id', '-G', 'qorpera-office']).stdout.strip() == str(GID).encode(), 'supplementary groups')
    need(run(['/usr/bin/passwd', '--status', 'qorpera-office']).stdout.decode().split()[1] == 'L', 'unlocked account')
    need(not any(x == str(UID) for x in run(['/usr/bin/ps', '-eo', 'uid=']).stdout.decode().split()),
         'UID processes already present')


def never_started():
    # Before anything here starts a unit: the cold boot left the office's units as the image installed them.
    keys = 'LoadState,ActiveState,UnitFileState,Job,DropInPaths,InactiveExitTimestampMonotonic,ExecMainStartTimestampMonotonic'
    units = {}
    for unit in SERVICES + [PRIVATE] + FOLDER:
        s = props(unit, keys)
        need(s['LoadState'] == 'loaded' and s['ActiveState'] == 'inactive' and not s['Job'] and not s['DropInPaths']
             and s['InactiveExitTimestampMonotonic'] == '0', 'unit started or modified ' + unit)
        units[unit] = s
    office = {k: units[OFFICE][k] for k in ['ActiveState', 'ExecMainStartTimestampMonotonic',
                                           'InactiveExitTimestampMonotonic', 'LoadState', 'UnitFileState']}
    need(office == {'ActiveState': 'inactive', 'ExecMainStartTimestampMonotonic': '0',
                    'InactiveExitTimestampMonotonic': '0', 'LoadState': 'loaded', 'UnitFileState': 'disabled'},
         'the office service is enabled or has started')
    mounts = run(['/usr/bin/systemctl', 'list-units', '--all', '--plain', '--no-legend', '--full',
                  'qorpera-office-folder-mount@*']).stdout
    need(not mounts.strip(), 'a folder mount is loaded')
    return units


def closure(receipt_sha, manifest_sha):
    b, _ = safe_bytes('/opt/qorpera-office/installation.json', 2 * 1024 ** 2)
    need(hashlib.sha256(b).hexdigest() == receipt_sha, 'receipt differs')
    r = json.loads(b)
    need(r['schema'] == 'qorpera.office-image-installation-receipt/v1' and r['uid'] == UID and r['gid'] == GID
         and r['architecture'] == 'x64' and r['packageManifestSha256'] == manifest_sha
         and SHA.fullmatch(r['specSha256']), 'installation identity')
    paths = set()
    for f in r['files']:
        need(f['path'] not in paths, 'duplicate receipt path')
        paths.add(f['path'])
        b, s = safe_bytes(f['path'], max(f['bytes'], 1))
        need(len(b) == f['bytes'] and hashlib.sha256(b).hexdigest() == f['sha256']
             and stat.S_IMODE(s.st_mode) == f['mode'], 'closure differs ' + f['path'])
    need('/opt/qorpera-office/qorpera-office-image-install.cjs' in paths, 'installer absent from receipt')
    measured = json.loads(run(['/usr/bin/node', '/opt/qorpera-office/qorpera-office-image-install.cjs',
                               '--measure-dependencies'], timeout=180).stdout)
    need(measured == r['dependencies'], 'dependencies changed')
    return {'receiptSha256': receipt_sha, 'filesVerified': len(paths), 'packageManifestSha256': r['packageManifestSha256'],
            'specSha256': r['specSha256'], 'uid': r['uid'], 'gid': r['gid'],
            'dependenciesSha256': hashlib.sha256(json.dumps(measured, sort_keys=True, separators=(',', ':')).encode()).hexdigest()}


def custody():
    for name in ['/var/lib/qorpera', '/var/lib/qorpera-native-provider', '/qorpera/company-live', '/etc/qorpera',
                 '/root/.codex', '/root/.pi']:
        need(not os.path.lexists(name), 'identity path exists ' + name)
    allowed = {'/var/lib/qorpera-office': set(), '/etc/qorpera-office': {'credentials', 'boots'},
               '/etc/qorpera-office/credentials': set(), '/etc/qorpera-office/boots': set(),
               '/run/qorpera-office-preparation': {'control.lock'},
               '/run/qorpera-office': {'private', 'display', 'browser', 'captures'}}
    for name, names in allowed.items():
        p = P(name)
        s = p.lstat()
        need(p.resolve() == p and stat.S_ISDIR(s.st_mode) and s.st_uid == 0 and not s.st_mode & 0o6022,
             'custody ownership ' + name)
        need(set(x.name for x in p.iterdir()) <= names, 'nonempty custody ' + name)
    # tmpfiles makes the lock at every boot and the preparation wrapper never repairs a missing one: it must be there.
    lock = P('/run/qorpera-office-preparation/control.lock')
    need(os.path.lexists(str(lock)), 'control lock missing')
    b, s = safe_bytes(str(lock), 1)
    need(not b and stat.S_IMODE(s.st_mode) == 0o600, 'control lock')
    for leaf in ['private', 'display', 'browser', 'captures']:
        p = P('/run/qorpera-office') / leaf
        s = p.lstat()
        need(p.resolve() == p and stat.S_ISDIR(s.st_mode)
             and (s.st_uid, s.st_gid, stat.S_IMODE(s.st_mode)) == (UID, GID, 0o700) and not list(p.iterdir()),
             'runtime custody ' + leaf)
    # Boot credentials come only from the node's preparation, for one boot.
    credentials = P('/etc/qorpera-office/credentials')
    s = credentials.lstat()
    need((s.st_uid, s.st_gid, stat.S_IMODE(s.st_mode)) == (0, 0, 0o700), 'credentials directory')
    mountinfo = P('/proc/self/mountinfo').read_text()
    for line in mountinfo.splitlines():
        left, right = line.split(' - ', 1)
        target = left.split()[4]
        fstype = right.split()[0]
        need(fstype not in ['nfs', 'nfs4', 'cifs', 'smb3'], 'remote canonical mount present')
        need(not any(target == p or target.startswith(p + '/') for p in
                     ['/var/lib/qorpera-office', '/etc/qorpera-office', '/run/qorpera-office',
                      '/run/qorpera-office-preparation']), 'office mount exists')
    return {'empty': True, 'credentials': {'path': str(credentials), 'mode': '0700',
                                           'entries': len(list(credentials.iterdir()))},
            'mountinfoSha256': hashlib.sha256(mountinfo.encode()).hexdigest()}


def apt_masks():
    out = {}
    for name in MASKS:
        p = P('/etc/systemd/system') / name
        need(p.is_symlink() and os.readlink(p) == '/dev/null', 'persistent apt mask absent ' + name)
        u = props(name)
        need(u['UnitFileState'] == 'masked' and u['ActiveState'] == 'inactive' and not u['Job'],
             'apt unit not masked/inactive ' + name)
        out[name] = u
    comm = run(['/usr/bin/ps', '-eo', 'comm=']).stdout.decode().splitlines()
    need(not any(x.strip() in ['apt', 'apt-get', 'dpkg', 'unattended-upgr'] for x in comm), 'package process active')
    return out


def walk_error(error):
    if not isinstance(error, FileNotFoundError):
        raise error


def secret_scan():
    # Every regular file outside /proc, /sys and /dev, in overlapping chunks. A hit names its path and kind only.
    chunk, overlap = 8 * 1024 ** 2, 8 * 1024
    files = size = 0
    hits = []
    for top, dirs, names in os.walk('/', onerror=walk_error):
        if top == '/':
            dirs[:] = [d for d in dirs if d not in ('proc', 'sys', 'dev')]
        dirs.sort()
        for name in sorted(names):
            path = os.path.join(top, name)
            try:
                if not stat.S_ISREG(os.lstat(path).st_mode):
                    continue
                fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            except FileNotFoundError:
                continue
            kinds = set()
            with os.fdopen(fd, 'rb') as f:
                tail = b''
                while True:
                    block = f.read(chunk)
                    if not block:
                        break
                    data = tail + block
                    kinds.update(kind for kind, shape in SECRETS.items() if shape.search(data))
                    tail = data[-overlap:]
                    size += len(block)
            files += 1
            if kinds:
                hits.append({'path': path, 'kinds': sorted(kinds)})
    need(files > 0, 'nothing scanned')
    need(not hits, 'secret-shaped strings on disk: ' + json.dumps(hits))
    return {'roots': ['/'], 'skipped': ['/dev', '/proc', '/sys'], 'kinds': sorted(SECRETS), 'filesScanned': files,
            'bytesScanned': size, 'hits': hits}


def private_mount_and_refusal():
    for unit in SERVICES + [PRIVATE]:
        s = props(unit)
        need(s['LoadState'] == 'loaded' and s['ActiveState'] in ['inactive', 'failed'] and not s['Job']
             and not s['DropInPaths'], 'unit modified/active ' + unit)
    need(props(OFFICE)['UnitFileState'] == 'disabled', 'service enabled')
    result = {}
    # These starts are expected to fail. Never supply configuration/credentials. The office service also waits for
    # the computers' network, whose device this VM lacks.
    for unit in SERVICES:
        r = run(['/usr/bin/systemctl', 'start', unit], timeout=240, allow=True)
        s = props(unit)
        need(r.returncode != 0 and s['ActiveState'] in ['inactive', 'failed'] and s['MainPID'] == '0' and not s['Job'],
             'unconfigured service admitted ' + unit)
        result[unit] = {'exitCode': r.returncode, **s}
    try:
        run(['/usr/bin/systemctl', 'start', PRIVATE])
        rows = json.loads(run(['/usr/bin/findmnt', '--json', '--mountpoint', '/run/qorpera-office/private', '-o',
                               'TARGET,FSTYPE,OPTIONS']).stdout)['filesystems']
        need(len(rows) == 1 and rows[0]['fstype'] == 'tmpfs', 'private mount type')
        opts = set(rows[0]['options'].split(','))
        p = P('/run/qorpera-office/private')
        s = p.stat()
        sv = os.statvfs(p)
        need({'nodev', 'nosuid', 'noexec'} <= opts and (s.st_uid, s.st_gid, stat.S_IMODE(s.st_mode)) == (UID, GID, 0o700),
             'private mount permissions')
        need(sv.f_blocks * sv.f_frsize == 64 * 1024 ** 2, 'private tmpfs size differs')
        result['privateMount'] = {'bytes': sv.f_blocks * sv.f_frsize, 'uid': s.st_uid, 'gid': s.st_gid,
                                  'mode': stat.S_IMODE(s.st_mode), 'options': sorted(opts)}
    finally:
        run(['/usr/bin/systemctl', 'stop', PRIVATE])
    need(run(['/usr/bin/findmnt', '--mountpoint', '/run/qorpera-office/private'], allow=True).returncode == 1,
         'private mount remains')
    return result


def user(argv, env=None):
    return ['/usr/bin/setpriv', '--reuid=' + str(UID), '--regid=' + str(GID), '--clear-groups', '--no-new-privs',
            '--reset-env', '/usr/bin/env', *[k + '=' + v for k, v in (env or {}).items()], *argv]


def chrome_role(executable, cmdline):
    # Only the exact Chrome executable. Children may rewrite argv into one space-delimited title; the kernel sandbox
    # checks below stay mandatory.
    if executable != CHROME or not isinstance(cmdline, bytes) or not 0 < len(cmdline) <= 65536:
        return None
    parts = [p for p in cmdline.split(b'\0') if p]
    if not parts:
        return None
    tokens = parts[0].split() if len(parts) == 1 else parts
    if not tokens or tokens[0] != CHROME.encode() or b'--user-data-dir=/profile/chrome' not in tokens:
        return None
    kind_tokens = [x for x in tokens[1:] if x.startswith(b'--type=')]
    if len(kind_tokens) > 1:
        return None
    if kind_tokens:
        match = re.fullmatch(rb'--type=([a-z][a-z0-9-]*)', kind_tokens[0])
        return match.group(1).decode('ascii') if match else None
    return 'browser'


def wait_for_proof_uid_exit(timeout=10):
    # The UID was idle before; only the captured process groups were signalled, so wait for PID 1 to reap them.
    deadline = time.monotonic() + timeout
    while True:
        if not [x for x in run(['/usr/bin/ps', '-eo', 'uid=']).stdout.decode().split() if x == str(UID)]:
            return
        need(time.monotonic() < deadline, 'proof processes remain after bounded reaping wait')
        time.sleep(.1)


def browser_proof(root):
    need('qorpera-office-browser-bwrap (enforce)' in P('/sys/kernel/security/apparmor/profiles').read_text().splitlines(),
         'AppArmor not enforcing')
    display = ':77'
    socket = P('/tmp/.X11-unix/X77')
    need(not socket.exists() and not P('/tmp/.X77-lock').exists(), 'proof display occupied')
    env = {'HOME': str(root), 'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'DISPLAY': display}
    processes = []
    files = []
    try:
        def spawn(argv, name):
            out = (root / name).open('xb')
            files.append(out)
            p = subprocess.Popen(argv, env=ENV, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT,
                                 start_new_session=True)
            processes.append(p)
            return p

        xv = spawn(user(['/usr/bin/Xtigervnc', display, '-SecurityTypes', 'None', '-localhost', '-geometry', '1280x800',
                         '-depth', '24', '-rfbport', '5977'], env), 'x.log')
        for _ in range(40):
            if socket.exists() and run(user(['/usr/bin/xset', 'q'], env), allow=True).returncode == 0:
                break
            need(xv.poll() is None, 'X server exited')
            time.sleep(.25)
        else:
            raise RuntimeError('X display not ready')
        bw = ['/usr/local/lib/qorpera/qorpera-browser-bwrap', '--as-pid-1', '--unshare-user', '--unshare-pid',
              '--unshare-net', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup', '--die-with-parent', '--new-session',
              '--cap-drop', 'ALL', '--clearenv', '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink',
              'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev', '--size',
              '67108864', '--tmpfs', '/tmp', '--bind', str(root / 'profile'), '/profile', '--ro-bind', str(socket),
              str(socket), '--ro-bind', '/etc/fonts', '/etc/fonts', '--ro-bind', '/etc/ssl/certs', '/etc/ssl/certs',
              '--ro-bind', '/etc/passwd', '/etc/passwd', '--ro-bind', '/etc/group', '/etc/group', '--ro-bind',
              '/etc/nsswitch.conf', '/etc/nsswitch.conf', '--setenv', 'HOME', '/profile', '--setenv', 'PATH',
              '/usr/bin:/bin', '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'DISPLAY', display, '--chdir', '/profile',
              '--remount-ro', '/']
        label = run(user(bw + ['--', '/usr/bin/cat', '/proc/self/attr/current'], env)).stdout.decode().strip()
        need(label == 'qorpera-office-browser-bwrap (enforce)', 'browser launcher profile')
        title = 'Qorpera image proof ' + root.name
        url = ('data:text/html,<title>' + title + '</title><body style="background:rgb(30,90,160);color:white"><h1>'
               + title + '</h1><canvas id=c width=100 height=100></canvas>'
               + '<script>c.getContext("2d").fillRect(0,0,90,90)</script>')
        chrome = bw + ['--', '/usr/bin/tini', '-p', 'SIGKILL', '--', CHROME, '--no-first-run', '--no-default-browser-check',
                       '--disable-gpu', '--user-data-dir=/profile/chrome', '--window-size=1024,700',
                       '--window-position=0,0', url]
        need(not any(x in ['--no-sandbox', '--disable-setuid-sandbox', '--disable-seccomp-filter-sandbox',
                           '--disable-namespace-sandbox', '--single-process', '--no-zygote'] for x in chrome),
             'sandbox weakening forbidden')
        cp = spawn(user(chrome, env), 'chrome.log')
        window = None
        renderers = []
        browser_namespace = None
        for _ in range(100):
            need(cp.poll() is None, 'Chromium exited')
            found = run(user(['/usr/bin/xdotool', 'search', '--name', title], env), allow=True)
            if found.returncode == 0 and found.stdout.strip():
                window = found.stdout.decode().split()[0]
            # Root reads only public process security metadata, not browser or profile contents.
            candidates = []
            for proc in P('/proc').iterdir():
                if not proc.name.isdigit():
                    continue
                try:
                    st = dict(line.split(':', 1) for line in (proc / 'status').read_text().splitlines() if ':' in line)
                    if [int(v) for v in st.get('Uid', '').split()] != [UID] * 4:
                        continue
                    role = chrome_role(os.readlink(proc / 'exe'), (proc / 'cmdline').read_bytes())
                    if role == 'browser':
                        pid = int(proc.name)
                        need(browser_namespace is None or browser_namespace['processId'] == pid,
                             'multiple outer Chrome processes')
                        browser_namespace = {'processId': pid, 'user': os.readlink(proc / 'ns/user'),
                                             'pid': os.readlink(proc / 'ns/pid')}
                    if role != 'renderer':
                        continue
                    candidates.append({'pid': int(proc.name), 'seccomp': st['Seccomp'].strip(),
                                       'noNewPrivs': st['NoNewPrivs'].strip(), 'capEff': st['CapEff'].strip(),
                                       'userNamespace': os.readlink(proc / 'ns/user'),
                                       'pidNamespace': os.readlink(proc / 'ns/pid')})
                except (FileNotFoundError, ProcessLookupError):
                    continue
            if window and candidates and browser_namespace:
                renderers = candidates
                break
            time.sleep(.25)
        need(window and renderers and browser_namespace, 'no real rendered browser window')
        # Every renderer runs as the image's dedicated UID, which was idle before.
        need(all(r['seccomp'] == '2' and r['noNewPrivs'] == '1' and int(r['capEff'], 16) == 0 for r in renderers),
             'renderer seccomp/privilege sandbox')
        need(all(r['userNamespace'] != os.readlink('/proc/self/ns/user')
                 and r['pidNamespace'] != os.readlink('/proc/self/ns/pid') for r in renderers),
             'renderer namespace isolation')
        need(all(r['userNamespace'] != browser_namespace['user'] and r['pidNamespace'] != browser_namespace['pid']
                 for r in renderers), 'Chromium nested namespace sandbox unconfirmed')
        # Let X paint after the window appears; the host keeps the PNG for a person to look at.
        time.sleep(15)
        shot = root / 'screenshot.png'
        run(user(['/usr/bin/scrot', str(shot)], env))
        b = shot.read_bytes()
        need(b.startswith(b'\x89PNG\r\n\x1a\n') and len(b) > 1024, 'screenshot absent')
        return {'display': display, 'windowId': window, 'appArmor': label, 'browserNamespace': browser_namespace,
                'renderers': renderers, 'screenshotSha256': hashlib.sha256(b).hexdigest(), 'screenshotBytes': len(b),
                'screenshotPath': str(shot)}
    finally:
        for p in reversed(processes):
            if p.poll() is None:
                os.killpg(p.pid, signal.SIGTERM)
                try:
                    p.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(p.pid, signal.SIGKILL)
                    p.wait(timeout=10)
        for f in files:
            f.close()
        wait_for_proof_uid_exit(timeout=10)


def main():
    need(len(sys.argv) == 5 and SHA.fullmatch(sys.argv[1]) and SHA.fullmatch(sys.argv[2]) and UUID.fullmatch(sys.argv[3])
         and UID > 0, 'arguments: receipt sha256, package manifest sha256, VM UUID, office uid')
    receipt, manifest, product_uuid = sys.argv[1:4]
    result = {'schema': 'qorpera.office-image-cold-boot-proof/v1', 'passed': False, 'guest': identity(product_uuid)}
    account()
    result['unitsBefore'] = never_started()
    result['closureBefore'] = closure(receipt, manifest)
    result['custodyBefore'] = custody()
    result['aptMasks'] = apt_masks()
    result['secretScan'] = secret_scan()
    result['serviceAndMount'] = private_mount_and_refusal()
    root = P('/run') / ('qorpera-image-proof-' + str(uuid.uuid4()))
    root.mkdir(mode=0o700)
    os.chown(root, UID, GID)
    (root / 'profile').mkdir(mode=0o700)
    os.chown(root / 'profile', UID, GID)
    result['proofDirectory'] = str(root)
    result['browser'] = browser_proof(root)
    result['closureAfter'] = closure(receipt, manifest)
    result['custodyAfter'] = custody()
    apt_masks()
    account()
    need(result['closureBefore'] == result['closureAfter'], 'closure changed')
    result['passed'] = True
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except BaseException as e:
        print(json.dumps({'schema': 'qorpera.office-image-cold-boot-proof/v1', 'passed': False, 'error': str(e)}))
        sys.exit(1)
EOF
proof_status=0
la exec "$vm" -- /usr/bin/python3 -I -c "$guest_proof" "$receipt" "$manifest" "$uuid" "$office_id" >"$work/guest.json" ||
	proof_status=$?
jq -e --arg receipt "$receipt" --arg manifest "$manifest" --arg uuid "$uuid" --argjson id "$office_id" \
	'.passed == true and .guest.productUuid == $uuid and .closureBefore.receiptSha256 == $receipt
	and .closureBefore.packageManifestSha256 == $manifest and .closureBefore.uid == $id and .closureBefore.gid == $id
	and .secretScan.hits == []' \
	"$work/guest.json" >/dev/null || fail "the guest proof failed (exit $proof_status): $(head -c 8192 "$work/guest.json")"
tested=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
la file pull "$vm$(jq -r .browser.screenshotPath "$work/guest.json")" "$work/screenshot.png"
[[ $(sha256sum "$work/screenshot.png" | awk '{print $1}') == $(jq -r .browser.screenshotSha256 "$work/guest.json") ]] ||
	fail "the pulled screenshot differs from the VM's"

jq -n --slurpfile image "$work/image.json" --slurpfile instance "$work/instance.json" --slurpfile guest "$work/guest.json" \
	--arg tested "$tested" --arg host "$host" --arg project "$project" --arg pool "$pool" --arg rootSize "$root_size" \
	--arg uuid "$uuid" --arg cloudInit "$cloud_init" \
	'{schema: "qorpera.office-image-acceptance/v1", testedAt: $tested, host: $host, pool: $pool, rootSize: $rootSize,
	rootDiskBytes: (($rootSize | rtrimstr("GiB") | tonumber) * pow(1024; 3)), bootMode: "uefi-secureboot", network: "none",
	virtualMachine: {uuid: $uuid, devices: $instance[0].expanded_devices, profiles: $instance[0].profiles},
	image: {fingerprint: $image[0].fingerprint, project: $project, type: $image[0].type, public: $image[0].public,
		autoUpdate: $image[0].auto_update, architecture: $image[0].architecture, bytes: $image[0].size,
		profiles: $image[0].profiles, aliases: $image[0].aliases, properties: $image[0].properties},
	cloudInit: $cloudInit, guest: $guest[0]}' >"$work/evidence.json"
echo "Office image $fingerprint accepted in a cold boot"
