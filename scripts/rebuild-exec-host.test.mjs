// deploy/shared-execution/rebuild-exec-host.sh against stand-in `lxc` and `curl`: which units it stops, when
// it refuses, and when it starts the orchestrator (rolling updates, step 3). Nothing reaches LXD or a database.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(root, "deploy/shared-execution/rebuild-exec-host.sh");
const fingerprint = "f".repeat(64);

// The stand-in LXD: units, journals and the orchestrator's state live in files; every call is logged.
const LXC = `#!/usr/bin/env bash
set -euo pipefail
S="$STUB_STATE"
echo "lxc $*" >> "$S/log"
case "$1" in
	image) exit 0;;
	query) echo '{"status":"Running","config":{},"devices":{"identity-1":{}}}'; exit 0;;
	stop|rebuild|start) exit 0;;
	file)
		# The host's own credential: kept, to check that only its hash went to the database.
		args=("$@")
		if [[ \${args[$#-1]} == */qorpera-execution-host ]]; then
			cp "\${args[$#-2]}" "$S/pushed-host-credential"
			echo "\${args[$#-2]}" > "$S/pushed-host-credential-source"
		fi
		exit 0;;
	exec)
		while [[ $1 != "--" ]]; do shift; done; shift
		cmd="$*"
		case "$cmd" in
			true) exit 0;;
			"systemctl disable --now qorpera-runner-orchestrator.service") echo stopped > "$S/orchestrator"; exit 0;;
			"systemctl enable --now qorpera-runner-orchestrator.service") echo "\${STUB_ORCHESTRATOR_STARTS_AS:-active}" > "$S/orchestrator"; exit 0;;
			"systemctl is-active qorpera-runner-orchestrator.service") cat "$S/orchestrator"; exit 0;;
			"systemctl is-active qorpera-shared-execution.service") echo active; exit 0;;
			*"list-units"*"qorpera-shared-run-host@*"*"qorpera-shared-runner@*"*) cat "$S/hosts" "$S/runners"; exit 0;;
			*"list-units"*"qorpera-shared-runner@*"*) cat "$S/runners"; exit 0;;
			*"list-units"*"qorpera-shared-run-host@*"*) cat "$S/hosts"; exit 0;;
			"systemctl stop qorpera-shared-run-host@"*) : > "$S/hosts"; exit 0;;
			"sh -c ls /var/lib/qorpera-shared-execution/journals/*.json 2>/dev/null || true") cat "$S/journals"; exit 0;;
			"sha256sum /opt/qorpera-harnesses/native-company/codex") echo "${"e".repeat(64)}  codex"; exit 0;;
			curl*) echo 200; exit 0;;
			env*) echo installed; exit 0;;
			*) exit 0;;
		esac;;
	*) exit 0;;
esac
`;
const CURL = `#!/usr/bin/env bash
body=$(cat)
printf '%s\n' "$@" >> "$STUB_STATE/curl-args"
for arg in "$@"; do
	case "$arg" in */rpc/*) echo "curl \${arg##*/rpc/}" >> "$STUB_STATE/log";; esac
done
for arg in "$@"; do
	case "$arg" in
		*qorpera_register_runner_orchestrator) echo '{"status":"active"}'; exit 0;;
		*qorpera_bind_execution_host_credential)
			printf '%s' "$body" > "$STUB_STATE/bind-body"
			if [[ -n \${STUB_BIND_REFUSED:-} ]]; then echo '{"code":"42501"}'; else echo '{"hostId":"qorpera-exec-node02","providerAdapter":"native-b","orchestratorId":"o"}'; fi
			exit 0;;
		*qorpera_declare_runner_orchestrator_bundle) echo '{"runtimeBundleSha256":"'"\${STUB_BUNDLE}"'"}'; exit 0;;
	esac
done
exit 1
`;

function setup({ runners = "", hosts = "", journals = "" } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "rebuild-exec-host-"));
	const bin = join(dir, "bin");
	const state = join(dir, "state");
	const pkg = join(dir, "package");
	const staging = join(dir, "staging");
	for (const path of [bin, state, pkg, join(staging, "credentials")]) mkdirSync(path, { recursive: true });
	writeFileSync(join(bin, "lxc"), LXC);
	writeFileSync(join(bin, "curl"), CURL);
	chmodSync(join(bin, "lxc"), 0o755);
	chmodSync(join(bin, "curl"), 0o755);
	writeFileSync(join(state, "runners"), runners);
	writeFileSync(join(state, "hosts"), hosts);
	writeFileSync(join(state, "journals"), journals);
	writeFileSync(join(state, "orchestrator"), "active\n");
	writeFileSync(join(state, "log"), "");
	for (const file of ["qorpera-shared-execution-service.mjs", "install-shared-execution-guest.sh", "manifest.json"]) writeFileSync(join(pkg, file), "");
	writeFileSync(
		join(staging, "shared-execution.env"),
		"QORPERA_SHARED_EXECUTION_SLOTS=2\nQORPERA_SHARED_EXECUTION_HOST_ID=qorpera-exec-node02\nQORPERA_SUPABASE_URL=https://db.example\nQORPERA_RUNNER_PROVIDER_ADAPTER=native-b\nQORPERA_NATIVE_CODEX_FENCE_SHA256=0\n",
	);
	writeFileSync(join(staging, "runner-orchestrator.env"), "QORPERA_RUNNER_ORCHESTRATOR_ID=o\nQORPERA_RUNNER_ORCHESTRATOR_CONTROL_TOKEN=t\n");
	for (const file of ["qorpera-runner-provider", "qorpera-supabase-service-key"]) writeFileSync(join(staging, "credentials", file), "x");
	return { dir, bin, state, pkg, staging };
}

// The script insists on root, which the stand-ins make irrelevant: the test runs a copy without that check.
const ROOT_CHECK = /if \[\[ \$\{EUID\} -ne 0 \]\]; then\n[^\n]*\n[^\n]*\nfi\n/;
function rebuild(fixture, env = {}) {
	const text = readFileSync(script, "utf8");
	assert.equal(text.match(new RegExp(ROOT_CHECK.source, "g"))?.length, 1, "the root check is where the test expects it");
	const copy = join(fixture.dir, "rebuild-exec-host.sh");
	writeFileSync(copy, text.replace(ROOT_CHECK, ""));
	const result = spawnSync("bash", [copy, fingerprint], {
		encoding: "utf8",
		env: {
			PATH: `${fixture.bin}:${process.env.PATH}`,
			STUB_STATE: fixture.state,
			STUB_BUNDLE: "b".repeat(64),
			EXEC_VM: "qorpera-exec-node02",
			EXEC_PROJECT: "qn25b2",
			EXEC_PACKAGE: fixture.pkg,
			EXEC_STAGING: fixture.staging,
			EXEC_SLOTS: "2",
			...env,
		},
	});
	return { ...result, log: readFileSync(join(fixture.state, "log"), "utf8"), orchestrator: readFileSync(join(fixture.state, "orchestrator"), "utf8").trim() };
}

// GNU sed -i, sha256sum and comm: the node's tools (the test machine runs Linux).
const linux = process.platform === "linux" || "needs the Linux tools the node has";

test("parked hosts end with EXEC_CLEAR_PARKED=1 and the orchestrator starts with EXEC_START_ORCHESTRATOR=1", { skip: linux === true ? false : linux }, () => {
	const fixture = setup({ hosts: "qorpera-shared-run-host@0.service loaded active running\n" });
	try {
		const result = rebuild(fixture, { EXEC_CLEAR_PARKED: "1", EXEC_START_ORCHESTRATOR: "1" });
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /Ended 1 parked hosts/);
		assert.match(result.log, /systemctl stop qorpera-shared-run-host@0\.service$/m);
		assert.match(result.log, /lxc rebuild/);
		assert.equal(result.orchestrator, "active");
		assert.match(result.stdout, /orchestrator=active/);
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

test("a run in flight refuses the rebuild and stops nothing", { skip: linux === true ? false : linux }, () => {
	for (const busy of [{ runners: "qorpera-shared-runner@1.service loaded active running\n" }, { journals: "/var/lib/qorpera-shared-execution/journals/x.json\n" }]) {
		const fixture = setup({ hosts: "qorpera-shared-run-host@1.service loaded active running\n", ...busy });
		try {
			const result = rebuild(fixture, { EXEC_CLEAR_PARKED: "1", EXEC_START_ORCHESTRATOR: "1" });
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /live on qorpera-exec-node02/);
			assert.doesNotMatch(result.log, /systemctl stop/);
			assert.doesNotMatch(result.log, /lxc rebuild/);
			assert.equal(result.orchestrator, "stopped", "the orchestrator stays stopped");
		} finally {
			rmSync(fixture.dir, { recursive: true, force: true });
		}
	}
});

test("without EXEC_CLEAR_PARKED a parked host still refuses, and the orchestrator is left stopped", { skip: linux === true ? false : linux }, () => {
	const fixture = setup({ hosts: "qorpera-shared-run-host@0.service loaded active running\n" });
	try {
		const refused = rebuild(fixture);
		assert.notEqual(refused.status, 0);
		assert.match(refused.stderr, /Parked hosts alone end with EXEC_CLEAR_PARKED=1/);
		writeFileSync(join(fixture.state, "hosts"), "");
		const result = rebuild(fixture);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.orchestrator, "stopped");
		assert.match(result.stdout, /Start the orchestrator when the cut is live/);
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

test("the bundle is declared before the orchestrator starts; a refused declaration starts nothing", { skip: linux === true ? false : linux }, () => {
	const declared = "d".repeat(64);
	let fixture = setup();
	try {
		const result = rebuild(fixture, { EXEC_START_ORCHESTRATOR: "1", EXEC_RUNTIME_BUNDLE_SHA256: declared, STUB_BUNDLE: declared });
		assert.equal(result.status, 0, result.stderr);
		const order = ["curl qorpera_register_runner_orchestrator", "curl qorpera_declare_runner_orchestrator_bundle", "systemctl enable --now qorpera-runner-orchestrator.service"].map(
			(line) => result.log.indexOf(line),
		);
		assert.ok(order.every((at) => at >= 0) && order[0] < order[1] && order[1] < order[2], result.log);
		assert.equal(result.orchestrator, "active");
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
	fixture = setup();
	try {
		const result = rebuild(fixture, { EXEC_START_ORCHESTRATOR: "1", EXEC_RUNTIME_BUNDLE_SHA256: declared, STUB_BUNDLE: "e".repeat(64) });
		assert.equal(result.status, 1);
		assert.match(result.stderr, /declaration failed/);
		assert.doesNotMatch(result.log, /systemctl enable --now qorpera-runner-orchestrator/);
		assert.equal(result.orchestrator, "stopped");
		assert.doesNotMatch(result.stdout, /Start the orchestrator when the cut is live/);
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

test("an orchestrator that does not stay running fails the rebuild", { skip: linux === true ? false : linux }, () => {
	const fixture = setup();
	try {
		const result = rebuild(fixture, { EXEC_START_ORCHESTRATOR: "1", STUB_ORCHESTRATOR_STARTS_AS: "activating" });
		assert.equal(result.status, 1);
		assert.match(result.stderr, /the orchestrator is activating/);
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

test("the flags take 1 or nothing, and a new host never starts its orchestrator", { skip: linux === true ? false : linux }, () => {
	const fixture = setup();
	try {
		for (const env of [{ EXEC_CLEAR_PARKED: "0" }, { EXEC_START_ORCHESTRATOR: "yes" }]) {
			const result = rebuild(fixture, env);
			assert.equal(result.status, 1);
			assert.match(result.stderr, /must be 1 or unset/);
		}
		const fresh = rebuild(fixture, { EXEC_FRESH: "1", EXEC_START_ORCHESTRATOR: "1" });
		assert.equal(fresh.status, 1);
		assert.match(fresh.stderr, /never for a new host/);
		assert.doesNotMatch(fresh.log, /lxc (stop|rebuild|start)/);
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
	const create = readFileSync(join(root, "deploy/shared-execution/create-exec-host.sh"), "utf8");
	assert.match(create, /^unset .*\bEXEC_CLEAR_PARKED\b.*\bEXEC_START_ORCHESTRATOR\b/m, "create-exec-host.sh never passes the flags on");
});

test("every rebuild mints the host's own credential, binds only its hash, and pushes it into the host (G2-3e)", { skip: linux === true ? false : linux }, () => {
	let fixture = setup();
	try {
		const result = rebuild(fixture);
		assert.equal(result.status, 0, result.stderr);
		const credential = readFileSync(join(fixture.state, "pushed-host-credential"), "utf8");
		assert.match(credential, /^[A-Za-z0-9_-]{43}$/);
		const sha256 = createHash("sha256").update(credential).digest("hex");
		assert.deepEqual(JSON.parse(readFileSync(join(fixture.state, "bind-body"), "utf8")), {
			p_host_id: "qorpera-exec-node02",
			p_provider_adapter: "native-b",
			p_orchestrator_id: "o",
			p_credential_sha256: sha256,
		});
		// The plaintext reaches the host's file only: never the database, a command line or the output.
		for (const text of [
			result.stdout,
			result.stderr,
			result.log,
			readFileSync(join(fixture.state, "bind-body"), "utf8"),
			readFileSync(join(fixture.state, "curl-args"), "utf8"),
		])
			assert.ok(!text.includes(credential));
		// Its private temporary directory is gone, and the host has its credential before the service starts.
		assert.ok(!existsSync(readFileSync(join(fixture.state, "pushed-host-credential-source"), "utf8").trim()));
		assert.match(result.stdout, new RegExp(`The host credential is bound \\(sha256 ${sha256}\\)`));
		const order = [
			"curl qorpera_register_runner_orchestrator",
			"curl qorpera_bind_execution_host_credential",
			"qorpera-execution-host",
			"systemctl enable --now qorpera-shared-execution.service",
		].map(
			(line) => result.log.indexOf(line),
		);
		assert.ok(order.every((at, index) => at >= 0 && (index === 0 || order[index - 1] < at)), result.log);
		assert.ok(!existsSync(join(fixture.staging, "credentials", "qorpera-execution-host")), "never staged");
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
	fixture = setup();
	try {
		const result = rebuild(fixture, { STUB_BIND_REFUSED: "1" });
		assert.equal(result.status, 1);
		assert.match(result.stderr, /Binding the host credential failed/);
		assert.ok(!existsSync(join(fixture.state, "pushed-host-credential")), "nothing pushed");
		assert.doesNotMatch(result.log, /systemctl enable --now qorpera-shared-execution.service/);
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

test("the script still parses", () => {
	assert.equal(spawnSync("bash", ["-n", script]).status, 0);
	assert.ok(existsSync(script));
});
