#!/usr/bin/env bash
# Inside the throwaway node of test/prove-coding-session-vm.sh (run as root there, never on a real node):
#
#   prove-coding-session-node.sh <push directory> <coding image fingerprint>
#
# The node gets what a coding node has: LXD with a storage pool and the coding image, the agent exit's qagent0 bridge
# (bare here: the node has no network to give), the NFS export and mount its executor's custody lives on, the
# executor's user with the Git broker's sandbox, and KVM for coding machines one level further down. github.com is a
# stand-in on the node itself (test/p3-github.mjs) with one throwaway repository. The proof's driver, outside, then
# runs the executor here. Prints PASS lines, then NODE READY.
set -euo pipefail

PUSH=$1
FINGERPRINT=$2
EXECUTOR=qorpera-coding-executor
NAS=/mnt/qorpera-nas
GITHUB=/srv/p3-github
fail() {
	echo "FAIL: $*" >&2
	exit 1
}
pass() { echo "PASS: $*"; }

[[ -f /etc/qorpera-throwaway-vm ]] || fail "this runs inside the proof's throwaway node only"
[[ -c /dev/kvm ]] || fail "no /dev/kvm in the node: the test machine does not pass nested virtualization through"
pass "the node has KVM ($(nproc) CPUs, $(awk '/MemTotal/ {print int($2 / 1048576)}' /proc/meminfo) GiB)"

lxd init --auto --storage-backend=dir >/dev/null
# A split image is a metadata tarball and a root disk.
meta=$(ls "$PUSH/coding-image" | grep -E "\.tar(\.(xz|gz|zst))?$" | head -1)
root=$(ls "$PUSH/coding-image" | grep -vxF "$meta" | head -1 || true)
lxc image import "$PUSH/coding-image/$meta" ${root:+"$PUSH/coding-image/$root"} --alias p3-coding </dev/null >/dev/null
[[ $(lxc image info p3-coding </dev/null | awk '/^Fingerprint:/ {print $2}') == "$FINGERPRINT" ]] ||
	fail "the coding image changed its fingerprint on the way in"
# The agent exit's bridge, without the exit: machines' cards go on it, nothing routes.
ip link add qagent0 type bridge
ip link set qagent0 up
# A machine's card filters what the machine sends (security.ipv6_filtering), which needs bridge netfilter, as on a real
# node (deploy/first-node/bootstrap-lxd-host.sh). This is the throwaway node's own kernel, not the test machine's.
modprobe br_netfilter
grep -q '^br_netfilter ' /proc/modules || fail "the node has no br_netfilter: a machine's card cannot start"
pass "the node's LXD has a pool and the coding image; qagent0 is up, with bridge netfilter"

# The executor, as the service unit makes it: its own user in group lxd (LXD's socket is root:lxd).
useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin --groups lxd "$EXECUTOR"
[[ $(stat -c %G /var/snap/lxd/common/lxd/unix.socket) == lxd ]] || fail "LXD's socket is not in group lxd"
install -d -m 0700 -o root -g root /etc/qorpera
# The Git broker's sandbox needs unprivileged user namespaces, which Ubuntu's AppArmor restricts (as on the nodes,
# whose installer clears the restriction): cleared here inside the throwaway node only.
if ! runuser -u "$EXECUTOR" -- bwrap --unshare-all --ro-bind / / true 2>/dev/null; then
	if [[ $(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null) == 1 ]]; then
		sysctl -q kernel.apparmor_restrict_unprivileged_userns=0
		echo "note: cleared kernel.apparmor_restrict_unprivileged_userns inside the throwaway node"
	fi
	runuser -u "$EXECUTOR" -- bwrap --unshare-all --ro-bind / / true || fail "bubblewrap cannot sandbox as $EXECUTOR"
fi
pass "the executor's user reaches LXD and its Git sandbox works"

# The custody NAS: the node exports a folder to itself over NFSv4.2 and mounts it the way a node mounts its NAS.
install -d -m 0755 /srv/nas
echo "/srv/nas 127.0.0.1(rw,sync,no_subtree_check,no_root_squash)" >/etc/exports
systemctl restart nfs-server
exportfs -ra
install -d -m 0755 "$NAS"
mount -t nfs4 -o vers=4.2,proto=tcp,hard,nosuid,nodev 127.0.0.1:/srv/nas "$NAS"
install -d -m 0700 -o "$EXECUTOR" -g "$EXECUTOR" "$NAS/coding"
findmnt -n -o FSTYPE,OPTIONS "$NAS" | grep -q "^nfs4 .*vers=4.2" || fail "the NAS is not an NFSv4.2 mount"
pass "the NAS is mounted at $NAS over NFSv4.2 with the executor's root $NAS/coding"

# The stand-in GitHub: a CA of the node's own, github.com and api.github.com on 127.0.0.1, and one repository.
install -d -m 0700 /etc/p3-github
(
	cd /etc/p3-github
	openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=P3 proof CA" -keyout ca.key -out ca.crt \
		-addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign 2>/dev/null
	openssl req -newkey rsa:2048 -nodes -subj "/CN=github.com" -keyout server.key -out server.csr 2>/dev/null
	printf "subjectAltName=DNS:github.com,DNS:api.github.com\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n" >ext
	openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 2 -out server.crt -extfile ext 2>/dev/null
)
install -m 0644 /etc/p3-github/ca.crt /usr/local/share/ca-certificates/p3-proof-ca.crt
update-ca-certificates >/dev/null 2>&1
echo "127.0.0.1 github.com api.github.com" >>/etc/hosts
# The repository token: a fixed, non-secret proof value (the executor's static proof credential).
TOKEN=p3_proof_repository_token_not_a_secret
install -m 0600 /dev/null /etc/qorpera/coding-repository-p3.key
printf %s "$TOKEN" >/etc/qorpera/coding-repository-p3.key
install -d -m 0755 "$GITHUB/qorpera-p3"
git init -q --bare -b main "$GITHUB/qorpera-p3/proof.git"
git -C "$GITHUB/qorpera-p3/proof.git" config http.receivepack true
seed=$(mktemp -d)
git -C "$seed" init -q -b main
printf "# P3 proof\n\nA throwaway repository inside the proof's node.\n" >"$seed/README.md"
git -C "$seed" add README.md
git -C "$seed" -c user.name="P3 proof" -c user.email=p3@qorpera.invalid commit -q -m "P3 proof base"
git -C "$seed" push -q "$GITHUB/qorpera-p3/proof.git" main
rm -rf "$seed"
systemd-run --quiet --unit=p3-github --property=Restart=on-failure /usr/local/bin/node \
	"$PUSH/coding-worker/test/p3-github.mjs" "$GITHUB" /etc/p3-github/server.crt /etc/p3-github/server.key "$TOKEN" \
	/var/log/p3-github.log
for _ in $(seq 1 50); do grep -q listening /var/log/p3-github.log 2>/dev/null && break; sleep 0.2; done
header="Authorization: Basic $(printf %s "x-access-token:$TOKEN" | base64 -w0)"
base=$(git -c "http.https://github.com/.extraHeader=$header" ls-remote https://github.com/qorpera-p3/proof.git refs/heads/main |
	awk '{print $1}')
[[ $base =~ ^[0-9a-f]{40}$ ]] || { tail -n 20 /var/log/p3-github.log; fail "the stand-in GitHub does not serve the repository"; }
pass "the stand-in github.com serves qorpera-p3/proof at $base over HTTPS"
# api.github.com as the executor's draft pull request reaches it: Node's fetch, the node's CA, the token as a Bearer.
ref=$(NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/p3-proof-ca.crt TOKEN="$TOKEN" /usr/local/bin/node --input-type=module -e '
	const response = await fetch("https://api.github.com/repos/qorpera-p3/proof/git/ref/heads/main",
		{ headers: { authorization: `Bearer ${process.env.TOKEN}`, accept: "application/vnd.github+json" } });
	console.log(response.status === 200 ? (await response.json()).object.sha : `HTTP ${response.status}`);')
[[ $ref == "$base" ]] || { tail -n 20 /var/log/p3-github.log; fail "the stand-in api.github.com answers $ref for main"; }
pass "the stand-in api.github.com answers the executor's calls (main at $ref)"

# The executor's composition, where the driver starts it.
install -d -m 0755 /opt/p3
install -m 0444 "$PUSH/package/p3/p3-executor.mjs" /opt/p3/p3-executor.mjs
printf 'P3-NODE {"machineId":"%s","baseSha":"%s"}\n' "$(cat /etc/machine-id)" "$base"
echo "NODE READY"
