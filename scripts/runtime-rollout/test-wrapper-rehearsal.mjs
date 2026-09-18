// Full local integration test of the recovered packet tooling. A temporary
// detached git fixture contains the current candidate bytes; the working
// repository is never committed or modified and the fixture is not a release.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPacket } from "./create-packet.mjs";
import baseline from "./templates/rehearsal-baseline.json" with { type: "json" };

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const schemaPath = process.argv[2], reportPath = process.argv[3];
assert(schemaPath && reportPath, "Usage: node scripts/runtime-rollout/test-wrapper-rehearsal.mjs PINNED_SCHEMA NEW_REPORT_PATH");
const directory = realpathSync(mkdtempSync(join(tmpdir(), "qorpera-wrapper-integration-")));
chmodSync(directory, 0o700);
const source = join(directory, "source"), packet = join(directory, "packet");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const write = (name, value) => writeFileSync(name, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
const git = (cwd, ...args) => execFileSync("/usr/bin/git", args, { cwd, timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
	env: { PATH: "/usr/bin:/bin", LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
let result;
try {
	const statusBefore = git(root, "status", "--porcelain", "--untracked-files=all");
	git(directory, "clone", "--quiet", "--no-hardlinks", root, source);
	git(source, "checkout", "--quiet", "--detach");
	const changed = [...new Set([...git(root, "diff", "HEAD", "--name-only").split("\n"), ...git(root, "ls-files", "--others", "--exclude-standard").split("\n")])].filter(Boolean);
	assert(changed.every((name) => /^[A-Za-z0-9_./-]+$/.test(name) && !name.includes("..")), "Unsafe fixture path");
	for (const name of changed) {
		if (!existsSync(join(root, name))) {
			rmSync(join(source, name));
			continue;
		}
		assert(lstatSync(join(root, name)).isFile(), "The integration fixture supports file edits and additions only");
		mkdirSync(dirname(join(source, name)), { recursive: true });
		copyFileSync(join(root, name), join(source, name));
	}
	if (changed.length) {
		git(source, "add", "--", ...changed);
		git(source, "-c", "user.name=Disposable test fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false",
			"commit", "--quiet", "-m", "Disposable wrapper rehearsal fixture");
	}
	const manifestFile = join(source, "deploy/first-node/native-codex/runtime-bundle-manifest.json");
	const bundle = readFileSync(join(source, "packages/runtime/src/cloud-runtime-bundle.generated.ts"), "utf8").match(/CLOUD_RUNTIME_BUNDLE_SHA256 = "([a-f0-9]{64})"/)[1];
	const names = readdirSync(join(source, "supabase/migrations")).filter((name) => /^\d{14}_.*\.sql$/.test(name)).sort();
	const shipped = names.filter((name) => name.slice(0, 14) <= "20260907000500").map((name) => name.slice(0, 14));
	const baselineEvidence = join(directory, "baseline.json"), preflightEvidence = join(directory, "preflight.json");
	const previousBundle = "4d988b5f47e6219b2f44bae3cbc0b7363c411738ddfc32774a5d487025d483bb";
	const bundleActivations = names.filter((name) => !shipped.includes(name.slice(0, 14)) && /_runtime_bundle_activation_v\d+\.sql$/.test(name)).map((name) => {
		const sql = readFileSync(join(source, "supabase/migrations", name), "utf8");
		const match = sql.match(/values \('qorpera\.cloud-runtime',(\d+),[\s\S]*::jsonb,'([a-f0-9]{64})'\);/);
		assert(match, "Generated activation source differs");
		return { migrationVersion: name.slice(0, 14), version: Number(match[1]), sha256: match[2] };
	});
	assert.equal(bundleActivations.at(-1).sha256, bundle);
	const versions = [...shipped, ...baseline.productionOnly].sort();
	write(baselineEvidence, [{ r: { count: versions.length, versions, activeBundle: previousBundle } }]);
	write(preflightEvidence, { syntheticTargetMetadata: true, productionWrites: false });
	const specification = { project: "wovsmjvghnbcbfazdtvr", company: "88227549-9724-43c2-8966-9fafb3e855d6", environment: "0d2053f0-c1a8-444d-99a8-68c8214e5414",
		owner: randomUUID(), identity: randomUUID(), clientIdentity: randomUUID(), registry: randomUUID(), logical: randomUUID(), head: randomUUID(),
		tree: hash("synthetic fixture tree"), fileCount: 1, totalBytes: 10, source, commit: git(source, "rev-parse", "HEAD"), bundle, previousBundle,
		lifecycleDefinition: "da8587ccb0c03ad76344c69f228de6214800229d2138c131dd9cc18029b20741",
		baselineEvidence, baselineSha256: hash(readFileSync(baselineEvidence)), preflightEvidence, preflightSha256: hash(readFileSync(preflightEvidence)),
		predecessorPacketSha256: hash("synthetic fixture predecessor"), pauseReason: "Disposable wrapper rehearsal only", initialReason: "Synthetic paused baseline",
		policyVersionBefore: 27, policyVersionPaused: 28, concurrency: 64, initialEnablement: "disabled", activationVersion: bundleActivations.at(-1).migrationVersion,
		bundleVersion: bundleActivations.at(-1).version, previousBundleVersion: 13, bundleActivations, manifestSha256: hash(readFileSync(manifestFile)), cliPath: "/nonexistent/supabase-wrapper-fixture" };
	const spec = join(directory, "spec.json"); write(spec, specification);
	createPacket(spec, packet);
	const run = (name, ...args) => execFileSync(process.execPath, [join(packet, name), ...args], { cwd: packet, timeout: 60_000,
		maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).toString();
	run("verify-offline.mjs");
	console.log("PASS: generated controller and transport tests");
	console.log(run("rehearse-wrapper.mjs", resolve(schemaPath)));
	const frozen = JSON.parse(run("freeze-packet.mjs", "freeze"));
	assert(frozen.passed && frozen.executionEnabled === false);
	assert.deepEqual(JSON.parse(run("freeze-packet.mjs", "verify")), frozen);
	const rehearsal = JSON.parse(readFileSync(join(packet, "WRAPPER-REHEARSAL.json")));
	const offline = JSON.parse(readFileSync(join(packet, "OFFLINE-TESTS.json")));
	assert.equal(git(root, "status", "--porcelain", "--untracked-files=all"), statusBefore, "Working source changed during the fixture");
	result = { schema: "qorpera.rollout-tooling-integration-test/v1", passed: true, sourceWorkingTreeChanged: false,
		temporaryFixtureCommit: specification.commit, runtimeBundleSha256: bundle, packetSha256: frozen.packetSha256,
		offlineTests: offline.tests, wrapperRehearsal: rehearsal, frozenManifest: frozen.manifest,
		productionCandidate: false, executionEnabled: false, productionWrites: false, modelCalls: false };
} finally {
	rmSync(directory, { recursive: true, force: true });
}
assert(result?.passed);
write(resolve(reportPath), result);
console.log(`PASS: actual wrappers, replay rejection, cleanup and frozen verification; ${result.offlineTests} offline tests`);
