import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const fixture = new URL("scripts/fixtures/office-command-namespaces.py", root).pathname;
const read = (path) => readFileSync(new URL(path, root), "utf8");

test("the logic fixture passes without privilege and claims no namespace proof", () => {
	const output = execFileSync("python3", [fixture, "selftest"], { encoding: "utf8" });
	assert.deepEqual(JSON.parse(output), { logicFixture: "passed", privilegedProof: "not-run" });
});

test("the fixture's shell and filter are the office's own", () => {
	const pins = JSON.parse(
		execFileSync(
			"python3",
			["-c", "import json, runpy, sys; g = runpy.run_path(sys.argv[1], run_name='pins'); print(json.dumps({'sandbox': g['sandbox_args'](424242), 'table': g['PLUMB_TABLE']}))", fixture],
			{ encoding: "utf8" },
		),
	);
	// The array companyComputerLinuxSandboxArgs returns, with its one computed token.
	const host = read("packages/runtime/src/cloud-company-computer-linux-host.ts");
	const body = host.slice(host.indexOf("export function companyComputerLinuxSandboxArgs"));
	const array = body.slice(body.indexOf("return [") + "return [".length, body.indexOf("];"));
	const sandbox = array
		.split(",")
		.map((token) => token.trim())
		.filter(Boolean)
		.map((token) => (token === "String(tmpBytes)" ? "424242" : JSON.parse(token)));
	assert.ok(sandbox.length > 20);
	assert.deepEqual(pins.sandbox, sandbox);
	// The table qorpera-computer-plumb loads into a computer's namespace.
	const plumb = read("deploy/lxd-company-computer-guest/qorpera-computer-plumb");
	const start = plumb.indexOf("nft -f - <<'EOF'\n") + "nft -f - <<'EOF'\n".length;
	assert.ok(start > "nft -f - <<'EOF'\n".length);
	assert.equal(pins.table, plumb.slice(start, plumb.indexOf("\nEOF\n", start) + 1));
});

test("the nested-VM driver parses", () => {
	execFileSync("bash", ["-n", new URL("scripts/prove-office-command-namespaces-vm.sh", root).pathname]);
});

test("qorpera-computer-plumb installs EXIT veth cleanup trap and batches inner sysctl and ip into one nsenter call", () => {
	const plumbPath = new URL("deploy/lxd-company-computer-guest/qorpera-computer-plumb", root).pathname;
	execFileSync("bash", ["-n", plumbPath]);
	const plumb = read("deploy/lxd-company-computer-guest/qorpera-computer-plumb");
	assert.match(plumb, /\btrap cleanup_plumb EXIT\b/);
	assert.match(plumb, /cleanup_plumb\n\trefuse namespace\nfi\nplumbing_host=\nprintf 'ok %s\\n'/);
	const nsenterCalls = plumb.match(/\bnsenter -t "\$\{pid\}" -n\b/g) ?? [];
	assert.equal(nsenterCalls.length, 3, `expected 3 nsenter calls (check, nft, batched sysctl+ip), got ${nsenterCalls.length}`);

	const cleanupStart = plumb.indexOf("cleanup_plumb() {\n");
	const cleanupEnd = plumb.indexOf("\n}\n", cleanupStart);
	assert.ok(cleanupStart >= 0 && cleanupEnd > cleanupStart);
	const cleanupFn = plumb.slice(cleanupStart, cleanupEnd + 2);

	const failedMidPlumb = spawnSync(
		"bash",
		[
			"-euo",
			"pipefail",
			"-c",
			`deleted=\nip() { deleted="$*"; }\nplumbing_host=qcmp1s\n${cleanupFn}\ntrap 'cleanup_plumb; printf "DELETED:%s\\n" "$deleted"' EXIT\nfalse`,
		],
		{ encoding: "utf8" },
	);
	assert.equal(failedMidPlumb.status, 1);
	assert.equal(failedMidPlumb.stdout.trim(), "DELETED:link del qcmp1s");

	const completedPlumb = spawnSync(
		"bash",
		[
			"-euo",
			"pipefail",
			"-c",
			`deleted=\nip() { deleted="$*"; }\nplumbing_host=qcmp1s\n${cleanupFn}\ntrap 'cleanup_plumb; printf "DELETED:%s\\n" "$deleted"' EXIT\nplumbing_host=`,
		],
		{ encoding: "utf8" },
	);
	assert.equal(completedPlumb.status, 0);
	assert.equal(completedPlumb.stdout.trim(), "DELETED:");

	const innerMatch = plumb.match(/nsenter -t "\$\{pid\}" -n \/bin\/bash -euo pipefail -c '([\s\S]*?)' _ "\$\{peer_ip\}" "\$\{host_ip\}"/);
	assert.ok(innerMatch?.[1], "expected batched nsenter inner bash command");
	const batched = spawnSync(
		"bash",
		[
			"-euo",
			"pipefail",
			"-c",
			`sysctl() { printf 'SYSCTL:%s\\n' "$*"; }\nip() { printf 'IP_ARGS:%s\\n' "$*"; cat; }\n${innerMatch[1]}`,
			"_",
			"10.253.1.2",
			"10.253.1.1",
		],
		{ encoding: "utf8" },
	);
	assert.equal(batched.status, 0, batched.stderr);
	assert.deepEqual(batched.stdout.trim().split("\n"), [
		"SYSCTL:-q -w net.ipv6.conf.eth0.disable_ipv6=1 net.ipv6.conf.default.disable_ipv6=1 net.ipv4.ping_group_range=0 2147483647",
		"IP_ARGS:-batch -",
		"addr add 10.253.1.2/30 dev eth0",
		"link set eth0 up",
		"route add default via 10.253.1.1",
	]);
});
