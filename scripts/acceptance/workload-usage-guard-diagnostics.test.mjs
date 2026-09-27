import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { collectWorkloadGuardDiagnostics, workloadGuardDiagnosticsPlugin } from "./workload-usage-guard-diagnostics.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const record = (n = 1, confirmed = true) => ({ schema: "qorpera.acceptance-guard-capture/v1",
	captureId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, allocationId: null, physicalId: null,
	startedAt: "2026-09-27T03:00:00.000Z", durationMs: 120, confirmed, aborted: false,
	code: confirmed ? "CONFIRMED" : "GUEST_CLOCK_FAILED", hostBracketMs: confirmed ? 100 : null, steps: [] });

test("real capture wrapper preserves success, rejection, clocks and authority on all diagnostic paths", async () => {
	const root = await mkdtemp(join(tmpdir(), "qorpera-guard-diag-"));
	try {
		const outfile = join(root, "fixture.mjs");
		await build({ absWorkingDir: repository, entryPoints: ["scripts/acceptance/workload-usage-guard-diagnostics.fixture.ts"], outfile,
			bundle: true, platform: "node", format: "esm", target: "node24", logLevel: "silent",
			banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } });
		const result = spawnSync(process.execPath, [outfile], { encoding: "utf8", timeout: 30000 });
		assert.equal(result.status, 0, result.stdout + result.stderr); assert.match(result.stdout, /pass 10/); assert.match(result.stdout, /fail 0/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("constructor substitution only intercepts service import and still bundles the real capture", async () => {
	const result = await build({ absWorkingDir: repository, entryPoints: ["deploy/runtime-computers/paid-computer-guard.ts"],
		bundle: true, platform: "node", format: "esm", target: "node24", logLevel: "silent", write: false, metafile: true,
		plugins: [workloadGuardDiagnosticsPlugin(repository)] });
	const inputs = result.metafile.inputs;
	assert(inputs["scripts/acceptance/workload-usage-guard-diagnostics.ts"]);
	assert(inputs["packages/runner-orchestrator/src/computer-paid-usage-lxd.ts"]);
	const service = inputs["packages/runner-orchestrator/src/computer-paid-guard-service.ts"];
	assert(service.imports.some(value => value.path === "scripts/acceptance/workload-usage-guard-diagnostics.ts"));
	assert(inputs["scripts/acceptance/workload-usage-guard-diagnostics.ts"].imports.some(value => value.path === "packages/runner-orchestrator/src/computer-paid-usage-lxd.ts"));
});

test("collector retains earlier failures and recent captures in a bounded ring", () => {
	const records = Array.from({ length: 100 }, (_, n) => record(n + 1, n !== 10));
	const result = collectWorkloadGuardDiagnostics(records.map(value => JSON.stringify(value)).join("\n"));
	assert.equal(result.observedCaptures, 100); assert.equal(result.retainedCaptures.length, 33);
	assert.equal(result.retainedCaptures[0].captureId, records[10].captureId); assert.equal(result.omittedCaptures, 67);
	const failures = collectWorkloadGuardDiagnostics(records.map(value => JSON.stringify({ ...value, confirmed: false, code: "GUEST_CLOCK_FAILED" })).join("\n"));
	assert.equal(failures.retainedCaptures.length, 32);
});

test("collector rejects raw secrets, extra fields, invalid identities and unbounded logs", () => {
	const values = [{ ...record(), secret: "PRIVATE" }, { ...record(), code: "PRIVATE" }, { ...record(), physicalId: "PRIVATE" },
		{ ...record(), startedAt: "PRIVATE" }, { ...record(), steps: [{ phase: "guest-clock", error: "PRIVATE" }] }];
	const result = collectWorkloadGuardDiagnostics(["PRIVATE RAW LOG", ...values.map(value => JSON.stringify(value)), JSON.stringify(record(7))].join("\n"));
	assert.equal(result.discarded, values.length); assert.equal(result.retainedCaptures.length, 1);
	assert.doesNotMatch(JSON.stringify(result), /PRIVATE|secret|error/);
	assert.throws(() => collectWorkloadGuardDiagnostics("x".repeat(4 * 1024 ** 2 + 1)), /GUARD_DIAGNOSTIC_LIMIT/);
});
