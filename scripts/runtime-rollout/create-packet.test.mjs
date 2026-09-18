import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPacket } from "./create-packet.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const write = (path, value) => writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value)}\n`, { mode: 0o600 });
function fixture() {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "qorpera-rollout-generator-")));
	chmodSync(directory, 0o700);
	const source = join(directory, "source"); mkdirSync(source, { mode: 0o700 });
	const git = (...args) => execFileSync("/usr/bin/git", args, { cwd: source, stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).toString().trim();
	mkdirSync(join(source, "supabase/migrations"), { recursive: true });
	mkdirSync(join(source, "deploy/first-node/native-codex"), { recursive: true });
	const implementation = {};
	for (let i = 0; i < 101; i++) { const name = `implementation-${i}.txt`, bytes = `Synthetic implementation ${i}\n`; write(join(source, name), bytes); implementation[name] = hash(bytes); }
	const manifest = { schema: "qorpera.runtime-bundle/v2", implementation };
	const manifestPath = join(source, "deploy/first-node/native-codex/runtime-bundle-manifest.json"); write(manifestPath, manifest);
	write(join(source, "supabase/migrations/20260101000000_baseline.sql"), "select 1;\n");
	write(join(source, "supabase/migrations/20260102000000_activation.sql"), `select 'qorpera.cloud-runtime',6,'${"b".repeat(64)}';\n`);
	git("init", "--quiet"); git("add", "supabase", "deploy", ...Object.keys(implementation));
	git("-c", "user.name=Synthetic fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Synthetic packet source");
	git("checkout", "--detach", "--quiet");
	const baselineEvidence = join(directory, "baseline.json"), preflightEvidence = join(directory, "preflight.json");
	write(baselineEvidence, [{ r: { count: 19, versions: ["20260101000000", ...Array.from({ length: 18 }, (_, i) => `20250101${String(i).padStart(6, "0")}`)].sort(), activeBundle: "a".repeat(64) } }]);
	write(preflightEvidence, { synthetic: true });
	const uuid = "10000000-0000-4000-8000-000000000001";
	const fixed = { project: "wovsmjvghnbcbfazdtvr", company: "88227549-9724-43c2-8966-9fafb3e855d6", environment: "0d2053f0-c1a8-444d-99a8-68c8214e5414",
		owner: uuid, identity: uuid, clientIdentity: uuid, registry: uuid, logical: uuid, head: uuid, tree: "d".repeat(64), fileCount: 1, totalBytes: 10,
		source, commit: git("rev-parse", "HEAD"), bundle: "b".repeat(64), previousBundle: "a".repeat(64), lifecycleDefinition: "c".repeat(64),
		baselineEvidence, baselineSha256: hash(readFileSync(baselineEvidence)), preflightEvidence, preflightSha256: hash(readFileSync(preflightEvidence)),
		predecessorPacketSha256: "f".repeat(64), pauseReason: "Synthetic reviewed rollout", policyVersionBefore: 11, policyVersionPaused: 12,
		concurrency: 64, initialEnablement: "disabled", initialReason: "Synthetic prior incident", activationVersion: "20260102000000",
		bundleVersion: 6, previousBundleVersion: 5, manifestSha256: hash(readFileSync(manifestPath)), cliPath: "/nonexistent/supabase-fixture" };
	const spec = join(directory, "spec.json"); write(spec, fixed);
	return { directory, source, git, fixed, spec, output: join(directory, "packet") };
}

test("generator reproduces a disabled packet from a detached source and runs the recovered adversarial suite", { timeout: 60_000 }, () => {
	const f = fixture();
	try {
		const result = createPacket(f.spec, f.output);
		assert.equal(result.executionEnabled, false); assert.equal(result.migrations, 1);
		const run = spawnSync(process.execPath, [join(f.output, "verify-offline.mjs")], { encoding: "utf8", timeout: 50_000 });
		assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
		const receipt = JSON.parse(readFileSync(join(f.output, "OFFLINE-TESTS.json")));
		assert(receipt.passed && receipt.tests > 40 && receipt.failed === 0);
		assert.equal(receipt.packetSha256, result.packetSha256);
		assert.throws(() => createPacket(f.spec, f.output), /EEXIST/);
		const freeze = spawnSync(process.execPath, [join(f.output, "freeze-packet.mjs"), "freeze"], { encoding: "utf8" });
		assert.notEqual(freeze.status, 0, "Missing SQL rehearsal cannot be sealed");
		write(join(f.output, "sql/pause.sql"), "select 1;\n");
		const changed = spawnSync(process.execPath, [join(f.output, "controller.mjs"), "check"], { encoding: "utf8" });
		assert.notEqual(changed.status, 0, "Edited generated SQL cannot pass verification");
	} finally { rmSync(f.directory, { recursive: true, force: true }); }
});

for (const kind of ["branch", "dirty", "baseline", "activation", "scope", "enabled-reason"]) test(`generator rejects ${kind} drift`, () => {
	const f = fixture();
	try {
		if (kind === "branch") f.git("checkout", "-b", "not-detached");
		if (kind === "dirty") write(join(f.source, "untracked.txt"), "changed");
		if (kind === "baseline") write(f.fixed.baselineEvidence, { changed: true });
		if (kind === "activation") f.fixed.activationVersion = "20260103000000";
		if (kind === "scope") f.fixed.project = "another-project";
		if (kind === "enabled-reason") f.fixed.initialEnablement = "enabled";
		write(f.spec, f.fixed);
		assert.throws(() => createPacket(f.spec, f.output));
	} finally { rmSync(f.directory, { recursive: true, force: true }); }
});

function activationChainFixture() {
	const f = fixture();
	const additions = {
		"20260103000000_runtime_office_registry.sql": "select 2;\n",
		"20260104000000_activation.sql": `select 'qorpera.cloud-runtime',7,'${"e".repeat(64)}';\n`,
		"20260105000000_after_activation.sql": "select 3;\n",
	};
	for (const [name, bytes] of Object.entries(additions)) write(join(f.source, "supabase/migrations", name), bytes);
	f.git("add", "--", ...Object.keys(additions).map((name) => `supabase/migrations/${name}`));
	f.git("-c", "user.name=Synthetic fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Synthetic activation chain");
	f.fixed.commit = f.git("rev-parse", "HEAD");
	f.fixed.bundleActivations = [
		{ migrationVersion: "20260102000000", version: 6, sha256: "b".repeat(64) },
		{ migrationVersion: "20260104000000", version: 7, sha256: "e".repeat(64) },
	];
	f.fixed.bundleVersion = 7;
	f.fixed.bundle = "e".repeat(64);
	f.fixed.activationVersion = "20260104000000";
	write(f.spec, f.fixed);
	return f;
}

test("explicit activation chain guards intermediate and trailing migrations and remains disabled", { timeout: 60_000 }, async () => {
	const f = activationChainFixture();
	try {
		const result = createPacket(f.spec, f.output);
		assert.equal(result.executionEnabled, false);
		assert.equal(result.migrations, 4);
		const contract = await import(`${new URL(`file://${f.output}/contract.mjs`)}`);
		assert.equal(contract.stateAt("20260103000000").activeBundle, "b".repeat(64));
		assert.equal(contract.stateAt("20260104000000", false).activeBundle, "b".repeat(64));
		assert.equal(contract.stateAt("20260104000000").activeBundle, "e".repeat(64));
		assert.equal(contract.stateAt("20260105000000", false).activeBundle, "e".repeat(64));
		assert.equal(contract.stateAt("final-readback").activeBundle, "e".repeat(64));
		assert.equal(JSON.parse(readFileSync(join(f.output, "packet.json"))).companyComputersIncluded, true);
		const run = spawnSync(process.execPath, [join(f.output, "verify-offline.mjs")], { encoding: "utf8", timeout: 50_000 });
		assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
		assert(readFileSync(join(f.output, "sql/20260103000000.sql"), "utf8").includes(`='${"b".repeat(64)}'`));
		assert(readFileSync(join(f.output, "sql/20260105000000.sql"), "utf8").includes(`='${"e".repeat(64)}'`));
	} finally { rmSync(f.directory, { recursive: true, force: true }); }
});

for (const kind of ["skip", "order", "digest", "pending", "final", "unknown-key", "reused-identity"]) test(`generator rejects activation-chain ${kind}`, () => {
	const f = activationChainFixture();
	try {
		if (kind === "skip") f.fixed.bundleActivations.shift();
		if (kind === "order") f.fixed.bundleActivations.reverse();
		if (kind === "digest") f.fixed.bundleActivations[0].sha256 = "f".repeat(64);
		if (kind === "pending") f.fixed.bundleActivations[0].migrationVersion = "20260101000000";
		if (kind === "final") f.fixed.activationVersion = "20260105000000";
		if (kind === "unknown-key") f.fixed.bundleActivations[0].accepted = true;
		if (kind === "reused-identity") f.fixed.bundleActivations[0].sha256 = f.fixed.previousBundle;
		write(f.spec, f.fixed);
		assert.throws(() => createPacket(f.spec, f.output));
	} finally { rmSync(f.directory, { recursive: true, force: true }); }
});
