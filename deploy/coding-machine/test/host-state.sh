# What a test machine looks like, for the image proofs (test/prove-coding-image.sh, and
# ../code-host/test/prove-code-host-image.sh), sourced after they set WORK (a private directory), POOL (the storage
# pool their machines use) and fail. `snapshot <name>` lists the test machine's modules, sysctls, nft ruleset, links
# and LXD state into $WORK; `compare <a> <b>` fails when anything differs between two of them, leaving out what
# other runs on the test machine change meanwhile: Docker's tables, chains, rules, links and addresses, the sysctls
# of links that come and go, the sysctls that changed on their own between the snapshots "calibrate" and "before",
# LXD projects that come and go (a proof checks its own are gone), and storage pools other than POOL that come and go
# (a proof makes none).

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

work, a, b, pool = sys.argv[1:5]
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
# not there in both (other runs', and this run's, which the run checks are gone), and pools other runs make or
# remove meanwhile (the run's own pool stays as it was).
xa, xb = set(lines(a, "lxd")), set(lines(b, "lxd"))
def named(entries, kind, field):
    return {f[field] for e in entries if (f := e.split("\t"))[1:2] == [kind]}
steady = (named(xa, "project", 0) & named(xb, "project", 0)) | {"-"}
coming = (named(xa, "pool", 2) ^ named(xb, "pool", 2)) - {pool}
def kept(entry):
    f = entry.split("\t")
    return f[0] in steady and not (f[1] == "pool" and f[2] in coming)
report("LXD state", {e for e in xa - xb if kept(e)}, {e for e in xb - xa if kept(e)})
if passing := named(xa, "project", 0) ^ named(xb, "project", 0):
    print(f"(LXD projects in only one of {a} and {b}, left out: {', '.join(sorted(passing))})")
if coming:
    print(f"(storage pools in only one of {a} and {b}, left out: {', '.join(sorted(coming))})")

if problems:
    print("\n".join(problems))
    sys.exit(1)
print(f"{a} and {b}: modules, sysctls, nft rules, links and LXD state are the same")
PY
compare() { python3 "$WORK/compare.py" "$WORK" "$1" "$2" "$POOL"; }
