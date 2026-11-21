import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { classifyReleaseDiff } from "./release-prep-plan.mjs";
import { NON_RETRYABLE_CODES, runReleaseDriver, stepsForManifest } from "./release-engine/driver.mjs";
import { exportExtensionForCompression, lxcExportArgs, lxcPublishArgs, readOrCreateReceipt } from "./release-engine/image-build.mjs";
import { createReleaseManifest, RELEASE_MANIFEST_SCHEMA, validateReleaseManifest } from "./release-engine/manifest.mjs";
import {
	buildAnchorCheckSql,
	dollarQuote,
	evaluateAnchorResults,
	evaluatePostChecks,
	evaluateWatchTick,
} from "./release-engine/sql-checks.mjs";

const SHA_40 = "a".repeat(40);
const SHA_40_B = "b".repeat(40);
const SHA_64 = "c".repeat(64);

function makeThinManifest(overrides = {}) {
	return {
		...createReleaseManifest({
			previousVersion: 270,
			previousBundleSha256: SHA_64,
			baseCommit: SHA_40,
			releaseCommit: SHA_40_B,
			releasePrNumber: 2020,
			previousNodeReleaseRevision: 157,
			classification: classifyReleaseDiff(["packages/runtime/src/cloud-native-company-context.ts"]),
			thinRuntimeEnabled: true,
		}),
		...overrides,
	};
}

function makeSqlOnlyManifest(overrides = {}) {
	return {
		...createReleaseManifest({
			previousVersion: 270,
			previousBundleSha256: SHA_64,
			baseCommit: SHA_40,
			previousNodeReleaseRevision: 157,
			classification: classifyReleaseDiff([
				"supabase/migrations/20260930822000_thread_run_wakes.sql",
				"supabase/tests/1311_thread_run_wakes.test.sql",
			]),
			thinRuntimeEnabled: true,
		}),
		...overrides,
	};
}

test("manifest creation and validation enforce schema invariants across sql-only, thin-runtime, and full-image", () => {
	const sqlOnly = makeSqlOnlyManifest();
	assert.equal(sqlOnly.schema, RELEASE_MANIFEST_SCHEMA);
	assert.equal(sqlOnly.mode, "sql-only");
	assert.equal(sqlOnly.version, 270);
	assert.equal(sqlOnly.nodeRelease.required, false);
	assert.equal(sqlOnly.image.rebuildRequired, false);
	assert.equal(sqlOnly.armed, false);
	assert.deepEqual(stepsForManifest(sqlOnly), ["target", "packets", "rehearse", "migrate", "models-read", "after-read"]);

	const thin = makeThinManifest();
	assert.equal(thin.mode, "thin-runtime");
	assert.equal(thin.version, 271);
	assert.equal(thin.nodeRelease.revision, 158);
	assert.equal(thin.image.rebuildRequired, false);
	assert.equal(thin.image.compression, "zstd");
	assert.ok(stepsForManifest(thin).includes("smoke-watch"));
	assert.ok(!stepsForManifest(thin).includes("home-watch"));
	assert.ok(!stepsForManifest(thin).includes("claude-watch"));

	assert.throws(() => validateReleaseManifest({ ...sqlOnly, version: 271 }), /sql-only mode must keep previousVersion/);
	assert.throws(
		() => validateReleaseManifest({ ...thin, armed: true, releasePrNumber: null }),
		/thin-runtime requires releasePrNumber when armed/,
	);
	assert.throws(
		() => validateReleaseManifest({ ...thin, image: { compression: "zstd", rebuildRequired: true } }),
		/thin-runtime must have image\.rebuildRequired = false/,
	);
	assert.throws(() => validateReleaseManifest({ ...thin, extraField: 1 }), /keys must be exactly/);
});

test("dollarQuote and buildAnchorCheckSql safely preserve double quotes, backslashes, tabs, newlines, and dollar signs", () => {
	const tricky = `set search_path=""\n\t'staff_version',speaker.staff_version,$tag$,\\n`;
	const quoted = dollarQuote(tricky);
	assert.ok(quoted.includes(tricky));
	assert.match(quoted, /^\$q_[0-9a-f]{12}(?:_\d+)?\$[\s\S]+\$q_[0-9a-f]{12}(?:_\d+)?\$$/);

	const anchors = [
		{ functionSignature: "public.qorpera_read_session_events(uuid,bigint,integer)", snippet: tricky, expectedCount: 1 },
	];
	const sql = buildAnchorCheckSql(anchors);
	assert.ok(sql.includes(tricky));
	assert.ok(sql.includes("pg_get_functiondef"));

	assert.equal(evaluateAnchorResults(anchors, [{ index: 0, actualCount: 1 }]).ok, true);
	const mismatch = evaluateAnchorResults(anchors, [{ index: 0, actualCount: 2 }]);
	assert.equal(mismatch.ok, false);
	assert.equal(mismatch.exitCode, 88);
	assert.equal(mismatch.mismatches[0].actualCount, 2);

	const postChecks = [
		{ name: "proconfig", sql: "select 1", expected: ['search_path=""'] },
		{ name: "hasRunWake", sql: "select true", expected: true },
	];
	assert.equal(evaluatePostChecks(postChecks, { proconfig: ['search_path=""'], hasRunWake: true }).ok, true);
	const badPost = evaluatePostChecks(postChecks, { proconfig: ["search_path="], hasRunWake: true });
	assert.equal(badPost.ok, false);
	assert.equal(badPost.exitCode, 87);
});

test("evaluateWatchTick supports zero-window skip, early exit on completed run, and failure exit codes 83/85", () => {
	assert.deepEqual(
		evaluateWatchTick({ kind: "home-watch", windowMinutes: 0, earlyExitOnCompletedRuns: 1 }, { elapsedSeconds: 0 }),
		{ done: true, ok: true, exitCode: 0, reason: "skipped-zero-window" },
	);
	assert.deepEqual(
		evaluateWatchTick(
			{ kind: "smoke-watch", windowMinutes: 2, earlyExitOnCompletedRuns: 1 },
			{ elapsedSeconds: 15, completedRuns: 1, codexHomeFailures: 0, claudeWorkerFailures: 0 },
		),
		{ done: true, ok: true, exitCode: 0, reason: "early-exit-proven" },
	);
	assert.equal(
		evaluateWatchTick(
			{ kind: "home-watch", windowMinutes: 15, earlyExitOnCompletedRuns: 1 },
			{ elapsedSeconds: 30, codexHomeFailures: 1 },
		).exitCode,
		83,
	);
	assert.equal(
		evaluateWatchTick(
			{ kind: "claude-watch", windowMinutes: 15, earlyExitOnCompletedRuns: 1 },
			{ elapsedSeconds: 30, claudeWorkerFailures: 1 },
		).exitCode,
		85,
	);
});

test("runReleaseDriver enforces held manifest, QORPERA_ROLL_TEST, way-back markers, non-retryable codes, and atomic MERGE-HOLD", async () => {
	const dir = mkdtempSync(join(tmpdir(), "qorpera-release-engine-"));
	try {
		const held = makeThinManifest({ armed: false });
		const refusedHeld = await runReleaseDriver(held, { dryRun: false, stateDir: dir }, { runPhase: async () => ({ exitCode: 0 }) });
		assert.equal(refusedHeld.ok, false);
		assert.equal(refusedHeld.exitCode, 2);

		const armed = makeThinManifest({ armed: true });
		const refusedTest = await runReleaseDriver(
			armed,
			{ dryRun: false, env: { QORPERA_ROLL_TEST: "1" }, stateDir: dir },
			{ runPhase: async () => ({ exitCode: 0 }) },
		);
		assert.equal(refusedTest.ok, false);
		assert.equal(refusedTest.exitCode, 2);

		const holdFile = join(dir, "MERGE-HOLD");
		const prepHoldFile = join(dir, "prep-hold.txt");
		writeFileSync(prepHoldFile, "prep hold v271\n", "utf8");
		writeFileSync(holdFile, "prep hold v271\n", "utf8");

		let targetCalls = 0;
		const anchorStop = await runReleaseDriver(
			armed,
			{ dryRun: false, stateDir: dir, holdFile, prepHoldFile, env: {} },
			{
				nowIso: () => "2026-11-21T01:00:00Z",
				runPhase: async (step) => {
					if (step === "target") {
						targetCalls += 1;
						return { exitCode: 88, reason: "anchor mismatch" };
					}
					return { exitCode: 0 };
				},
			},
		);
		assert.equal(anchorStop.ok, false);
		assert.equal(anchorStop.exitCode, 88);
		assert.equal(targetCalls, 1);
		assert.equal(readFileSync(holdFile, "utf8"), "prep hold v271\n");

		const postWriteStop = await runReleaseDriver(
			armed,
			{ dryRun: false, stateDir: dir, holdFile, prepHoldFile, env: {} },
			{
				nowIso: () => "2026-11-21T01:05:00Z",
				runPhase: async (step) => (step === "models-read" ? { exitCode: 87, reason: "post-check failed" } : { exitCode: 0 }),
			},
		);
		assert.equal(postWriteStop.ok, false);
		assert.equal(postWriteStop.exitCode, 87);
		const kept = readFileSync(holdFile, "utf8");
		assert.equal(kept.trimEnd().split("\n").length, 4);
		assert.match(kept, /^MERGE-HOLD KEPT by the v271 roll/);
		assert.match(kept, /Stopped at: models-read \(post-check failed\)/);

		const resumed = await runReleaseDriver(
			armed,
			{ dryRun: false, stateDir: dir, holdFile, from: "models-read", env: {} },
			{
				nowIso: () => "2026-11-21T01:10:00Z",
				runPhase: async () => ({ exitCode: 0 }),
			},
		);
		assert.equal(resumed.ok, true);
		assert.equal(existsSync(holdFile), false);

		const sqlArmed = makeSqlOnlyManifest({ armed: true });
		const sqlRun = await runReleaseDriver(
			sqlArmed,
			{ dryRun: false, stateDir: dir, holdFile, env: {} },
			{ runPhase: async () => ({ exitCode: 0 }) },
		);
		assert.equal(sqlRun.ok, true);
		assert.deepEqual(sqlRun.executed, ["target", "packets", "rehearse", "migrate", "models-read", "after-read"]);
		assert.equal(existsSync(holdFile), false);

		writeFileSync(join(dir, "WAY-BACK-TAKEN"), "taken\n", "utf8");
		const blockedWayBack = await runReleaseDriver(
			armed,
			{ dryRun: true, stateDir: dir, env: {} },
			{ runPhase: async () => ({ exitCode: 0 }) },
		);
		assert.equal(blockedWayBack.ok, false);
		assert.equal(blockedWayBack.exitCode, 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("NON_RETRYABLE_CODES covers all safety refusal codes and image-build uses zstd by default", () => {
	for (const code of [77, 78, 79, 81, 82, 83, 84, 85, 87, 88]) {
		assert.equal(NON_RETRYABLE_CODES.has(code), true);
	}
	const publishArgs = lxcPublishArgs({
		builderName: "qorpera-native271-build",
		project: "qorpera-build",
		properties: { description: "v271" },
	});
	assert.deepEqual(publishArgs, [
		"publish",
		"qorpera-native271-build",
		"--project",
		"qorpera-build",
		"--compression",
		"zstd",
		"description=v271",
	]);
	assert.equal(exportExtensionForCompression("zstd"), ".tar.zst");
	assert.equal(exportExtensionForCompression("gzip"), ".tar.gz");
	assert.equal(exportExtensionForCompression("none"), ".tar");
	assert.deepEqual(
		lxcExportArgs({ fingerprint: SHA_64, project: "qorpera-build", targetBasePath: "/var/tmp/out" }),
		["image", "export", SHA_64, "/var/tmp/out", "--project", "qorpera-build"],
	);

	const receiptDir = mkdtempSync(join(tmpdir(), "qorpera-img-receipt-"));
	try {
		mkdirSync(receiptDir, { recursive: true });
		const first = readOrCreateReceipt(receiptDir, "publish", { passed: true, fingerprint: SHA_64 });
		assert.equal(first.reused, false);
		const second = readOrCreateReceipt(receiptDir, "publish", { passed: true, fingerprint: "0".repeat(64) });
		assert.equal(second.reused, true);
		assert.equal(second.receipt.fingerprint, SHA_64);
	} finally {
		rmSync(receiptDir, { recursive: true, force: true });
	}
});
