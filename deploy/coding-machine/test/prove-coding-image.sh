#!/usr/bin/env bash
# Proof of the coding machine image (5f), run as root on a test machine:
#
#   node scripts/run-on-node.mjs --machine node02 --sudo --no-install --no-status -- \
#     bash deploy/coding-machine/test/prove-coding-image.sh </dev/null
#
# It builds the image with build-coding-image.sh in a throwaway build project, makes a throwaway coding machine from
# it as 5g will (no profiles, no /dev/lxd), and runs test/prove-in-coding-machine.sh inside. The builder and the
# machine each have one plain card on the test machine's existing bridge (no filters, so LXD adds no nft rule for
# them); everything else they do happens in their own kernels. The bridge forwards nothing (Docker's FORWARD policy on
# the test machine drops it), so their downloads go through test/proof-proxy.py, run here as nobody on the bridge's
# address for the run's length. The test machine's modules, sysctls, nft ruleset, links and LXD state are listed
# before, while the machine runs and after everything is gone: anything that differs between before and after fails
# the run. Other runs on the test machine come and go meanwhile, so Docker's tables, chains, rules, links and
# addresses are left out, and so are the sysctls of links that come and go, the sysctls that changed on their own in
# the 15 seconds before, and LXD projects that come and go (this run's own are checked gone). Both projects and
# everything in them are removed at the end, also on failure. Prints PASS lines (the inner proof's among them), then
# ALL PASSED.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
BUILD=qorpera-proof-build
CODING=qorpera-proof-coding
VM=proof
POOL=default
NETWORK=lxdbr0

fail() {
	echo "FAIL: $*" >&2
	exit 1
}
pass() { echo "PASS: $*"; }
lx() { lxc --project "$CODING" "$@" </dev/null; }

[[ $(id -u) -eq 0 ]] || fail "run as root (run-on-node.mjs --sudo)"
[[ $(hostname) == qorpera-testvm-* ]] || fail "this runs on a test machine only"
export PATH=$PATH:/snap/bin
for tool in lxc jq nft python3 sysctl setpriv; do command -v "$tool" >/dev/null || fail "no $tool here"; done
SOURCE=$(lxc storage get "$POOL" source </dev/null) || fail "no storage pool $POOL"
lxc network show "$NETWORK" </dev/null >/dev/null || fail "no network $NETWORK"
FREE=$(df --output=avail -B1G "$SOURCE" | tail -1 | tr -d ' ')
((FREE >= 50)) || fail "$FREE GiB free in $SOURCE: the builder, the image and the machine need 50"

WORK=$(mktemp -d)
CLAIMED=()
PROXY_PID=
stop_proxy() {
	if [[ -n $PROXY_PID ]]; then
		kill "$PROXY_PID" 2>/dev/null || true
		wait "$PROXY_PID" 2>/dev/null || true
		PROXY_PID=
	fi
}
# Everything in the claimed projects, then the projects. Safe to run twice.
teardown() {
	local project name
	for project in "${CLAIMED[@]}"; do
		for name in $(lxc list --project "$project" -c n -f csv </dev/null 2>/dev/null); do
			lxc delete --project "$project" --force "$name" </dev/null >/dev/null 2>&1 || true
		done
		for name in $(lxc image list --project "$project" -c F -f csv </dev/null 2>/dev/null); do
			lxc image delete --project "$project" "$name" </dev/null >/dev/null 2>&1 || true
		done
		if lxc project show "$project" </dev/null >/dev/null 2>&1; then
			lxc project delete "$project" </dev/null >/dev/null 2>&1 || echo "could not delete LXD project $project" >&2
		fi
	done
}
cleanup() {
	set +e
	stop_proxy
	teardown
	rm -rf "$WORK"
}
trap cleanup EXIT

# LXD's state, one line per thing, each led by its project ("-" for storage pools, which have none).
lxd_state() {
	local kind
	lxc query '/1.0/projects?recursion=1' | jq -r '.[] | [.name, "project", (.config | tojson)] | @tsv' || return
	lxc query '/1.0/networks?recursion=1' |
		jq -r '.[] | select(.managed) | ["default", "network", .name, .type, (.config | tojson)] | @tsv' || return
	lxc query '/1.0/storage-pools?recursion=1' | jq -r '.[] | ["-", "pool", .name, .driver, (.config | tojson)] | @tsv' || return
	lxc query '/1.0/profiles?recursion=1' |
		jq -r '.[] | ["default", "profile", .name, ({config, devices} | tojson)] | @tsv' || return
	for kind in instances images "storage-pools/$POOL/volumes"; do
		lxc query "/1.0/$kind?all-projects=true" |
			jq -r '.[] | [((capture("[?&]project=(?<p>[^&]+)") | .p) // "default"), "listed", .] | @tsv' || return
	done
}
# What the test machine looks like. Each listing is sorted, so order alone never counts as a change.
snapshot() {
	awk '{print $1}' /proc/modules | sort >"$WORK/$1.modules"
	{ sysctl -a 2>/dev/null || true; } | sort >"$WORK/$1.sysctls"
	# Without the warnings for tables iptables-nft manages.
	nft -s list ruleset 2>/dev/null >"$WORK/$1.nft"
	ip -o link | awk -F': ' '{print $2}' | sed 's/@.*//' | sort >"$WORK/$1.links"
	lxd_state </dev/null >"$WORK/$1.lxd.unsorted" || fail "listing LXD's state failed"
	sort "$WORK/$1.lxd.unsorted" >"$WORK/$1.lxd"
}
cat >"$WORK/compare.py" <<'PY'
import collections, re, sys

work, a, b = sys.argv[1:4]
def lines(name, kind):
    with open(f"{work}/{name}.{kind}") as f:
        return f.read().splitlines()
problems = []
def report(kind, removed, added):
    if removed or added:
        problems.append(f"{kind}: {len(removed)} gone, {len(added)} new")
        for line in sorted(removed)[:40]: problems.append(f"  - {line}")
        for line in sorted(added)[:40]: problems.append(f"  + {line}")

# Modules: the same set.
ma, mb = set(lines(a, "modules")), set(lines(b, "modules"))
report("modules", ma - mb, mb - ma)

# Sysctls: the same keys and values, but for counters, keys that changed on their own between "calibrate" and
# "before", and the keys of links that are not there in both.
VOLATILE = re.compile(r"^(kernel\.random\.|fs\.(dentry-state|file-nr|inode-nr|inode-state|aio-nr|quota\.)|"
                      r"kernel\.(ns_last_pid|pty\.nr|perf_event_max_sample_rate|hung_task_detect_count)|"
                      r"net\.netfilter\.nf_conntrack_count)")
LINK = re.compile(r"^net\.ipv[46]\.(conf|neigh)\.([^.]+)\.")
def sysctls(name):
    out = {}
    for line in lines(name, "sysctls"):
        key, _, value = line.partition(" = ")
        out[key] = value
    return out
calibrate, before = sysctls("calibrate"), sysctls("before")
moving = {key for key in calibrate.keys() | before.keys() if calibrate.get(key) != before.get(key)}
sa, sb = sysctls(a), sysctls(b)
def links(values):
    return {m.group(2) for key in values if (m := LINK.match(key))}
shared = (links(sa) & links(sb)) | {"all", "default"}
def kept(key):
    m = LINK.match(key)
    return not VOLATILE.match(key) and key not in moving and (not m or m.group(2) in shared)
ka = {f"{k} = {v}" for k, v in sa.items() if kept(k)}
kb = {f"{k} = {v}" for k, v in sb.items() if kept(k)}
report("sysctls", ka - kb, kb - ka)
if moving:
    print(f"(sysctls left out as moving on their own: {', '.join(sorted(moving))})")

# nft: the same rules in the same tables and chains, but Docker's (among them the raw rules that keep other hosts
# off a port published on localhost).
DOCKERISH = re.compile(r"docker|br-[0-9a-f]{12}|veth|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|"
                       r'^ip6? raw chain PREROUTING ip6? daddr (127\.0\.0\.1|::1) iifname != "lo" '
                       r"(tcp|udp|sctp) dport \d+ counter drop$", re.I)
def nft(name):
    out = collections.Counter()
    table = block = None
    depth = 0
    for line in lines(name, "nft"):
        s = line.strip()
        if depth == 0 and (m := re.match(r"table (\S+ \S+) \{$", s)):
            table = m.group(1)
        elif depth == 1 and s.endswith("{"):
            block = s[:-1].strip()
        skip = DOCKERISH.search(f"{table or ''} {block or ''} {s}")
        if not skip and s:
            out[f"[{table}] [{block}] {s}"] += 1
        depth += s.count("{") - s.count("}")
        if depth <= 1:
            block = None
        if depth == 0:
            table = None
    return out
na, nb = nft(a), nft(b)
report("nft rules", list((na - nb).elements()), list((nb - na).elements()))

# Links: the same, but Docker's and the veths of containers.
OTHERS = re.compile(r"^(veth|br-|docker)")
la = {l for l in lines(a, "links") if not OTHERS.match(l)}
lb = {l for l in lines(b, "links") if not OTHERS.match(l)}
report("links", la - lb, lb - la)

# LXD: the same projects, managed networks, pools, profiles, instances, images and volumes, but in projects that are
# not there in both (other runs', and this run's, which the run checks are gone).
xa, xb = set(lines(a, "lxd")), set(lines(b, "lxd"))
def projects(entries):
    return {e.split("\t")[0] for e in entries if e.split("\t")[1:2] == ["project"]}
steady = (projects(xa) & projects(xb)) | {"-"}
report("LXD state", {e for e in xa - xb if e.split("\t")[0] in steady}, {e for e in xb - xa if e.split("\t")[0] in steady})
if passing := projects(xa) ^ projects(xb):
    print(f"(LXD projects in only one of {a} and {b}, left out: {', '.join(sorted(passing))})")

if problems:
    print("\n".join(problems))
    sys.exit(1)
print(f"{a} and {b}: modules, sysctls, nft rules, links and LXD state are the same")
PY
compare() { python3 "$WORK/compare.py" "$WORK" "$@"; }

snapshot calibrate
sleep 15
snapshot before
echo "the test machine before: $(wc -l <"$WORK/before.modules") modules, $(wc -l <"$WORK/before.sysctls") sysctls," \
	"$(wc -l <"$WORK/before.nft") nft lines, $(wc -l <"$WORK/before.links") links"
compare calibrate before >/dev/null || echo "(changes in the 15 seconds before, left out where they are sysctls)"

# The projects are this run's claim on the names (a second run stops here and removes nothing of this one). Each has
# its own image store, so the test machine's own store is never touched.
for project in "$BUILD" "$CODING"; do
	claim=$(lxc project create "$project" -c features.images=true -c features.profiles=false </dev/null 2>&1) ||
		fail "cannot claim LXD project $project (another coding image proof may run here): $claim"
	CLAIMED+=("$project")
done
# The way out for the builder and the machine: the proxy, as nobody, on the bridge's own address.
BRIDGE=$(lxc network get "$NETWORK" ipv4.address </dev/null)
[[ $BRIDGE =~ ^[0-9.]+/[0-9]+$ ]] || fail "$NETWORK has no IPv4 address ($BRIDGE)"
setpriv --reuid=65534 --regid=65534 --clear-groups python3 -I - "${BRIDGE%/*}" "$BRIDGE" <"$HERE/test/proof-proxy.py" \
	>"$WORK/proxy.port" 2>"$WORK/proxy.log" &
PROXY_PID=$!
for _ in $(seq 1 50); do [[ -s $WORK/proxy.port ]] && break; sleep 0.2; done
PORT=$(head -n 1 "$WORK/proxy.port")
[[ $PORT =~ ^[0-9]+$ ]] || fail "the proxy did not start: $(cat "$WORK/proxy.log")"
PROXY=http://${BRIDGE%/*}:$PORT
echo "the proxy listens at $PROXY"

# --- The build, the machine and the proof inside it (a subshell: its failure still reaches the comparison) -----------
set +e
(
	set -e
	echo "--- the image build"
	start=$SECONDS
	# /tmp is small on a test machine; the export between the two stores goes to /var/tmp.
	TMPDIR=/var/tmp QORPERA_BUILDER_NIC=plain QORPERA_BUILD_PROXY=$PROXY timeout 5400 bash "$HERE/build-coding-image.sh" \
		"$BUILD" "$NETWORK" "$POOL" "$CODING" >"$WORK/image-build.json" 2>"$WORK/build.log" </dev/null ||
		{ tail -n 150 "$WORK/build.log"; fail "the image build failed"; }
	tail -n 60 "$WORK/build.log"
	jq . "$WORK/image-build.json"
	FINGERPRINT=$(jq -er .imageFingerprint "$WORK/image-build.json")
	lx image info "$FINGERPRINT" | grep -E '^(Fingerprint|Size|Architecture|Type):'
	pass "the image built in $(((SECONDS - start) / 60)) min and is in $CODING's store"

	start=$SECONDS
	lx init "$FINGERPRINT" "$VM" --vm --no-profiles --storage "$POOL" -d root,size=20GiB -n "$NETWORK" \
		-c limits.cpu=4 -c limits.memory=4GiB -c boot.mode=uefi-secureboot -c boot.autostart=false \
		-c security.devlxd=false >/dev/null
	lx start "$VM"
	for _ in $(seq 1 120); do lx exec "$VM" -- true >/dev/null 2>&1 && break; sleep 2; done
	lx exec "$VM" -- true ||
		{ lx console "$VM" --show-log | tail -n 80 || true; fail "the machine's LXD agent did not answer"; }
	STATE=$(lx exec "$VM" -- timeout 300 systemctl is-system-running --wait || true)
	[[ $STATE == running ]] ||
		{ lx exec "$VM" -- systemctl --failed --no-pager || true; fail "the machine is $STATE after boot"; }
	pass "a coding machine from the image booted to running in $((SECONDS - start)) s, its LXD agent answering without cloud-init"

	lx file push "$HERE/test/prove-in-coding-machine.sh" "$VM/root/prove-in-coding-machine.sh" >/dev/null
	timeout 1800 lxc --project "$CODING" exec "$VM" -- env QORPERA_PROOF_GIT="$(jq -r .git "$WORK/image-build.json")" \
		QORPERA_PROOF_NODE="$(jq -r .node "$WORK/image-build.json")" \
		QORPERA_PROOF_CHROMIUM="$(jq -r .chromium "$WORK/image-build.json")" \
		QORPERA_PROOF_TYPESCRIPT="$(jq -r .typescript "$WORK/image-build.json")" \
		QORPERA_PROOF_TSX="$(jq -r .tsx "$WORK/image-build.json")" QORPERA_PROOF_UV="$(jq -r .uv "$WORK/image-build.json")" \
		QORPERA_PROOF_MISE="$(jq -r .mise "$WORK/image-build.json")" QORPERA_PROOF_PROXY="$PROXY" \
		bash /root/prove-in-coding-machine.sh </dev/null | tee "$WORK/inner.out"
	grep -qx "ALL PASSED" "$WORK/inner.out" || fail "the proof inside the machine did not finish"

	snapshot during
	echo "--- the test machine while the machine runs (for information)"
	compare before during || true
)
PROOF=$?
set -e
stop_proxy
if [[ -s $WORK/proxy.log ]]; then
	echo "--- what the proxy refused or could not reach"
	tail -n 40 "$WORK/proxy.log"
fi

# --- The test machine is as it was ------------------------------------------------------------------------------------
teardown
for project in "${CLAIMED[@]}"; do
	! lxc project show "$project" </dev/null >/dev/null 2>&1 || fail "LXD project $project is still there"
done
CLAIMED=()
snapshot after
echo "--- the test machine after"
compare before after || fail "the run changed the test machine (above)"
pass "the test machine's modules, sysctls, nft rules, links and LXD state are as before"
((PROOF == 0)) || fail "the proof failed (above)"
echo "ALL PASSED"
