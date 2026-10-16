import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
