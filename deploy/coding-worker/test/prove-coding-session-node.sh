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
# Phase B: the company's code host image, in the default project's store as a node keeps it; its files, imported in
# the export record's order, make the same fingerprint.
code_host_facts=
if [[ -d $PUSH/code-host ]]; then
	record=$PUSH/code-host/code-host-image-export.json
	code_host=$(node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
		if (!/^[0-9a-f]{64}$/.test(r.imageFingerprint)) process.exit(1); console.log(r.imageFingerprint)' "$record") ||
		fail "the code host image's record has no fingerprint"
	mapfile -t parts < <(node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
		for (const file of r.files) console.log(`${process.argv[2]}/${file.name}`)' "$record" "$PUSH/code-host")
	((${#parts[@]})) || fail "the code host image's record lists no files"
	lxc image import "${parts[@]}" </dev/null >/dev/null
	[[ $(lxc image info "$code_host" </dev/null | awk '/^Fingerprint:/ {print $2}') == "$code_host" ]] ||
		fail "the code host image changed its fingerprint on the way in"
	code_host_facts=$(printf ',"codeHost":{"imageFingerprint":"%s"}' "$code_host")
	pass "the node's default image store has the code host image $code_host"
fi
# The agent exit's bridge, without the exit: machines' cards go on it, nothing routes.
ip link add qagent0 type bridge
ip link set qagent0 up
# A machine's card filters what the machine sends (security.ipv6_filtering), which needs bridge netfilter, as on a real
# node (deploy/first-node/bootstrap-lxd-host.sh). This is the throwaway node's own kernel, not the test machine's.
modprobe br_netfilter
grep -q '^br_netfilter ' /proc/modules || fail "the node has no br_netfilter: a machine's card cannot start"
pass "the node's LXD has a pool and the coding image; qagent0 is up, with bridge netfilter"

# LXD's loopback listener and its pin, as the node step sets them: a service reaches LXD only there, with a client
# certificate of its own, never through the socket's group (V2-A1, V2-A2). The pin is the server certificate's SHA-256.
lxc config set core.https_address 127.0.0.1:8443 </dev/null
install -d -m 0755 -o root -g root /etc/qorpera-lxd-ids
pin=$(openssl x509 -in /var/snap/lxd/common/lxd/server.crt -outform DER | sha256sum | awk '{print $1}')
printf '{"schema":"qorpera.lxd-listener/v1","origin":"https://127.0.0.1:8443","certificateSha256":"%s"}\n' "$pin" \
	>/etc/qorpera-lxd-ids/listener.json
chmod 0644 /etc/qorpera-lxd-ids/listener.json
# The server certificate's public key, for curl's pin (curl pins a key, not a certificate).
key_pin=sha256//$(openssl x509 -in /var/snap/lxd/common/lxd/server.crt -pubkey -noout | openssl pkey -pubin -outform DER |
	openssl dgst -sha256 -binary | base64)
# An account's identity: its own key (root's, readable by the account's group alone) and certificate, which LXD
# knows as a fine-grained identity in a group of its own, never as a legacy trusted certificate (V2-E3). The group's
# server-wide grant is the proof's alone: the executor's is admin, since the code hosts' projects it makes at run time
# get no grant of their own yet (a v2 item of its own), and the bridge's only reads. On a node, the node step's
# enrollment grants each identity its rows of the access contract.
enroll() {
	local account=$1 grant=$2 folder=/etc/qorpera-lxd-ids/$1
	install -d -m 0750 -o root -g "$account" "$folder"
	openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 2 -subj "/CN=$account" \
		-keyout "$folder/client.key" -out "$folder/client.crt" 2>/dev/null
	chown root:"$account" "$folder/client.key"
	chmod 0440 "$folder/client.key"
	chmod 0444 "$folder/client.crt"
	lxc auth group create "p3-$account" </dev/null >/dev/null
	lxc auth group permission add "p3-$account" server "$grant" </dev/null >/dev/null
	lxc auth identity create "tls/$account" "$folder/client.crt" --group "p3-$account" </dev/null >/dev/null
}
# What LXD answers an account on the listener, with that account's identity: "trusted" when it knows the account.
lxd_auth() {
	runuser -u "$1" -- curl -sS --max-time 5 --tlsv1.3 -k --pinnedpubkey "$key_pin" --cert "/etc/qorpera-lxd-ids/$1/client.crt" \
		--key "/etc/qorpera-lxd-ids/$1/client.key" https://127.0.0.1:8443/1.0 | grep -oE '"auth":"[a-z]+"' || true
}

# The executor, as the service unit makes it: its own user, in no LXD group, with its own identity on the listener.
useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$EXECUTOR"
enroll "$EXECUTOR" admin
[[ $(lxd_auth "$EXECUTOR") == '"auth":"trusted"' ]] || fail "LXD does not know the executor by its certificate"
if runuser -u "$EXECUTOR" -- curl -sS --max-time 5 --unix-socket /var/snap/lxd/common/lxd/unix.socket http://lxd/1.0 >/dev/null 2>&1; then
	fail "the executor's user reaches LXD's socket"
fi
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
pass "the executor's user reaches LXD by its own certificate on the loopback listener, not the socket, and its Git sandbox works"

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

# The folder model (phase A, when the push has it): the folder service with its vsock bridge and the executor's control
# socket, as install-folder-service.sh installs them on a node, and the object gateway its views write through. Their
# core is the test database's PostgREST, which the driver serves through test/p3-postgrest.mjs on 127.0.0.2
# (p3-supabase.test, a certificate from the node's CA).
folder_facts=""
if [[ -d $PUSH/folder ]]; then
	# The service, the bridge and the guest agent run /usr/bin/node.
	[[ -x /usr/bin/node ]] || install -m 0755 /usr/local/bin/node /usr/bin/node
	bash "$PUSH/folder/service/install-folder-service.sh" >/dev/null || fail "install-folder-service.sh failed"
	# The bridge asks LXD which machine has a CID with its own identity on the listener (the installer made its account).
	enroll qorpera-folder-bridge viewer
	[[ $(lxd_auth qorpera-folder-bridge) == '"auth":"trusted"' ]] || fail "LXD does not know the folder bridge by its certificate"
	(
		cd /etc/p3-github
		openssl req -newkey rsa:2048 -nodes -subj "/CN=p3-supabase.test" -keyout supabase.key -out supabase.csr 2>/dev/null
		printf "subjectAltName=DNS:p3-supabase.test\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n" >supabase.ext
		openssl x509 -req -in supabase.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 2 -out supabase.crt \
			-extfile supabase.ext 2>/dev/null
	)
	echo "127.0.0.2 p3-supabase.test" >>/etc/hosts
	# The object gateway's store, laid out <profile>/<sha256> and written 0600 by its account, qorpera-objects; the folder
	# service reads it as that account, through the bind deploy/folder-service/README.md's read-objects.conf makes.
	useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin qorpera-objects
	install -d -m 0700 -o qorpera-objects -g qorpera-objects /srv/p3-objects /srv/p3-objects/store /srv/p3-objects/state
	install -d -m 0755 /srv/qorpera /srv/qorpera/canonical
	# The gateway with the folder service's route alone (test/p3-objects.ts), its database the stand-in PostgREST. Its
	# tokens are this run's own; the keys are fixed, non-secret proof values (the stand-in takes any key).
	gateway_token=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')
	install -d -m 0700 /etc/p3-objects
	install -m 0600 /dev/null /etc/p3-objects/env
	printf '%s\n' "QORPERA_SUPABASE_URL=https://p3-supabase.test" "QORPERA_SUPABASE_PUBLISHABLE_KEY=p3_proof_publishable_key_not_a_secret" \
		"QORPERA_SUPABASE_SECRET_KEY=p3_proof_service_key_not_a_secret" "QORPERA_OBJECT_GATEWAY_STORAGE_ROOT=/srv/p3-objects/store" \
		"QORPERA_OBJECT_GATEWAY_STATE_ROOT=/srv/p3-objects/state" \
		"QORPERA_OBJECT_GATEWAY_CONTROL_TOKEN=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')" \
		"QORPERA_OBJECT_GATEWAY_FOLDER_SERVICE_TOKEN=$gateway_token" \
		"NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/p3-proof-ca.crt" >/etc/p3-objects/env
	install -d -m 0755 /opt/p3
	install -m 0444 "$PUSH/package/p3/p3-objects.mjs" /opt/p3/p3-objects.mjs
	systemd-run --quiet --unit=p3-objects --property=User=qorpera-objects --property=Group=qorpera-objects \
		--property=EnvironmentFile=/etc/p3-objects/env --property=Restart=on-failure /usr/local/bin/node /opt/p3/p3-objects.mjs
	for _ in $(seq 1 50); do journalctl -u p3-objects -o cat --no-pager | grep -q "P3 objects listening" && break; sleep 0.2; done
	journalctl -u p3-objects -o cat --no-pager | grep -q "P3 objects listening" ||
		{ journalctl -u p3-objects -n 20 --no-pager; fail "the node's object gateway does not start"; }
	printf '{"supabaseUrl":"https://p3-supabase.test","storageRoot":"/srv/qorpera/objects","cacheMiB":256,"mounts":[],%s}\n' \
		"\"codingMachineProjects\":[\"default\"],\"codingExecutorUid\":$(id -u "$EXECUTOR"),\"gatewayUrl\":\"http://127.0.0.1:8090\"" \
		>/etc/qorpera-folder-service/config.json
	printf %s p3_proof_service_key_not_a_secret >/etc/qorpera-folder-service/supabase-key
	printf %s "$gateway_token" >/etc/qorpera-folder-service/gateway-token
	chmod 0400 /etc/qorpera-folder-service/config.json /etc/qorpera-folder-service/supabase-key /etc/qorpera-folder-service/gateway-token
	install -d -m 0755 /etc/systemd/system/qorpera-folder-service.service.d
	# README.md's read-objects.conf (the gateway's account, its store bound read-only, a process namespace of its own),
	# its writes drop-in (the gateway token), and the node's CA for the stand-in PostgREST.
	printf '%s\n' "[Service]" "User=qorpera-objects" "Group=qorpera-objects" "PrivatePIDs=yes" "TemporaryFileSystem=/srv/qorpera:ro" \
		"BindReadOnlyPaths=/srv/p3-objects/store:/srv/qorpera/objects" "InaccessiblePaths=/srv/p3-objects/state /etc/p3-objects" \
		>/etc/systemd/system/qorpera-folder-service.service.d/read-objects.conf
	printf '%s\n' "[Service]" "LoadCredential=qorpera-folder-gateway-token:/etc/qorpera-folder-service/gateway-token" \
		>/etc/systemd/system/qorpera-folder-service.service.d/writes.conf
	printf '%s\n' "[Service]" "Environment=NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/p3-proof-ca.crt" \
		>/etc/systemd/system/qorpera-folder-service.service.d/p3.conf
	systemctl daemon-reload
	# The bridge listens on vsock; the host side's transport (LXD loads it with its first VM) is loaded here first.
	modprobe vhost_vsock
	enabled=$(systemctl enable --now qorpera-folder-service.socket qorpera-folder-bridge.service qorpera-folder-control.socket 2>&1) ||
		{ printf '%s\n' "$enabled"; fail "the folder service's units do not start"; }
	sleep 2
	for unit in qorpera-folder-service.socket qorpera-folder-bridge.service qorpera-folder-control.socket; do
		systemctl is-active --quiet "$unit" || { journalctl -u "$unit" -n 20 --no-pager; fail "$unit is not active"; }
	done
	[[ $(stat -c %U /run/qorpera-folder-control/control.sock) == "$EXECUTOR" ]] ||
		fail "the folder control socket is not the executor's"
	# The executor's pins: the guest agent and the folder program it pushes into each machine, root's and read-only.
	install -d -m 0755 /opt/p3/folder
	install -m 0444 "$PUSH/folder/agent.mjs" /opt/p3/folder/agent.mjs
	install -m 0555 "$PUSH/folder/qorpera-folder" /opt/p3/folder/qorpera-folder
	agent_sha=$(sha256sum /opt/p3/folder/agent.mjs | awk '{print $1}')
	program_sha=$(sha256sum /opt/p3/folder/qorpera-folder | awk '{print $1}')
	folder_facts=$(printf ',"folder":{"agent":{"path":"/opt/p3/folder/agent.mjs","sha256":"%s"},"program":{"path":"/opt/p3/folder/qorpera-folder","sha256":"%s"}}' \
		"$agent_sha" "$program_sha")
	pass "the folder service, its bridge on vsock 5250, the executor's control socket and the object gateway run (agent $agent_sha, program $program_sha)"
fi

# The executor's composition, where the driver starts it.
install -d -m 0755 /opt/p3
install -m 0444 "$PUSH/package/p3/p3-executor.mjs" /opt/p3/p3-executor.mjs
printf 'P3-NODE {"machineId":"%s","baseSha":"%s"%s%s}\n' "$(cat /etc/machine-id)" "$base" "$folder_facts" "$code_host_facts"
echo "NODE READY"
