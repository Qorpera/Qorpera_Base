import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { classifyReleaseDiff } from "./release-prep-plan.mjs";
import { buildRuntimeRollPacketArgs, readPrStateViaGh } from "./release-engine/adapters.mjs";
import { parseSubcommandFlags, runCli } from "./release-engine/cli.mjs";
import {
	keptHoldText,
	NON_RETRYABLE_CODES,
	releaseHoldLabel,
	runReleaseDriver,
	stepsForManifest,
} from "./release-engine/driver.mjs";
import {
	exportExtensionForCompression,
	lxcExportArgs,
	lxcPublishArgs,
	readOrCreateReceipt,
} from "./release-engine/image-build.mjs";
import { createReleaseManifest, RELEASE_MANIFEST_SCHEMA, validateReleaseManifest } from "./release-engine/manifest.mjs";
import {
	buildAnchorCheckSql,
	dollarQuote,
	evaluateAnchorResults,
	evaluatePostChecks,
	evaluateWatchTick,
} from "./release-engine/sql-checks.mjs";
import { SQL_ONLY_PACKET_SCHEMA, sqlOnlyPackets, writeSqlOnlyPackets } from "./release-engine/sql-only-packets.mjs";

const SHA_40 = "a".repeat(40);
const SHA_40_B = "b".repeat(40);
const SHA_40_C = "d".repeat(40);
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

function makeFullImageManifest(overrides = {}) {
	return {
		...createReleaseManifest({
			previousVersion: 270,
			previousBundleSha256: SHA_64,
			baseCommit: SHA_40,
			releaseCommit: SHA_40_B,
			releasePrNumber: 2021,
			previousNodeReleaseRevision: 157,
			classification: classifyReleaseDiff(["deploy/lxd-runner-guest/qorpera-native-provider-host.service"]),
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
				"supabase/tests/1312_thread_run_wakes_extra.test.sql",
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
	assert.equal(sqlOnly.nodeRelease.revision, 157);
	assert.equal(sqlOnly.image.rebuildRequired, false);
	assert.equal(sqlOnly.armed, false);
	assert.deepEqual(sqlOnly.sqlTests, ["1311", "1312"]);
	assert.deepEqual(stepsForManifest(sqlOnly), ["target", "packets", "rehearse", "migrate", "models-read", "after-read"]);

	const thin = makeThinManifest();
	assert.equal(thin.mode, "thin-runtime");
	assert.equal(thin.version, 271);
	assert.equal(thin.nodeRelease.required, true);
	assert.equal(thin.nodeRelease.revision, 158);
	assert.equal(thin.image.rebuildRequired, false);
	assert.equal(thin.image.compression, "zstd");
	assert.ok(stepsForManifest(thin).includes("smoke-watch"));
	assert.ok(!stepsForManifest(thin).includes("home-watch"));
	assert.ok(!stepsForManifest(thin).includes("claude-watch"));

	const fullImage = makeFullImageManifest();
	assert.equal(fullImage.mode, "full-image");
	assert.equal(fullImage.version, 271);
	assert.equal(fullImage.nodeRelease.required, true);
	assert.equal(fullImage.nodeRelease.revision, 158);
	assert.equal(fullImage.image.rebuildRequired, true);
	assert.ok(stepsForManifest(fullImage).includes("claude-watch"));

	assert.throws(() => validateReleaseManifest({ ...sqlOnly, version: 271 }), /sql-only mode must keep previousVersion/);
	assert.throws(() => validateReleaseManifest({ ...sqlOnly, releasePrNumber: 2020 }), /sql-only mode must have releasePrNumber = null/);
	assert.throws(() => validateReleaseManifest({ ...sqlOnly, releaseCommit: SHA_40_B }), /sql-only mode must have releaseCommit = null/);
	assert.throws(
		() => validateReleaseManifest({ ...sqlOnly, nodeRelease: { revision: 158, previousRevision: 157, required: false } }),
		/sql-only mode must keep nodeRelease\.revision equal to previousRevision/,
	);
	assert.throws(
		() => validateReleaseManifest({ ...thin, armed: true, releasePrNumber: null }),
		/thin-runtime requires releasePrNumber when armed/,
	);
	assert.throws(
		() => validateReleaseManifest({ ...thin, nodeRelease: { revision: 158, previousRevision: 157, required: false } }),
		/thin-runtime must require a node release/,
	);
	assert.throws(
		() => validateReleaseManifest({ ...thin, image: { compression: "zstd", rebuildRequired: true } }),
		/thin-runtime must have image\.rebuildRequired = false/,
	);
	assert.throws(
		() => validateReleaseManifest({ ...fullImage, image: { compression: "zstd", rebuildRequired: false } }),
		/full-image must have image\.rebuildRequired = true/,
	);
	assert.throws(() => validateReleaseManifest({ ...thin, armed: "yes" }), /armed must be a boolean/);
	assert.throws(
		() => validateReleaseManifest({ ...thin, nodes: { ...thin.nodes, nodeA: false } }),
		/invalid nodes\.nodeA/,
	);
	assert.throws(
		() =>
			validateReleaseManifest({
				...sqlOnly,
				migrations: [
					{
						id: "20260930822000",
						file: "supabase/migrations/20260930999999_mismatched.sql",
						anchors: [],
						postChecks: [],
					},
				],
			}),
		/does not match migration id/,
	);
	assert.throws(
		() =>
			validateReleaseManifest({
				...sqlOnly,
				migrations: [
					{
						id: 20260930822000,
						file: "supabase/migrations/20260930822000_thread_run_wakes.sql",
						anchors: [],
						postChecks: [],
					},
				],
			}),
		/invalid migration id/,
	);
	assert.throws(
		() =>
			validateReleaseManifest({
				...sqlOnly,
				migrations: [
					{
						id: "20260930822000",
						file: "supabase/migrations/20260930822000_thread_run_wakes.sql",
						anchors: [],
						postChecks: [{ name: null, sql: "select 1", expected: 1 }],
					},
				],
			}),
		/invalid postCheck name/,
	);
	assert.throws(() => validateReleaseManifest({ ...thin, extraField: 1 }), /keys must be exactly/);
});

test("dollarQuote, buildAnchorCheckSql, and evaluatePostChecks handle tricky strings, collisions, and jsonb key order", () => {
	const tricky = `set search_path=""\n\t'staff_version',speaker.staff_version,$tag$,\\n`;
	const quoted = dollarQuote(tricky);
	assert.ok(quoted.includes(tricky));
	assert.match(quoted, /^\$q_[0-9a-f]{12}(?:_\d+)?\$[\s\S]+\$q_[0-9a-f]{12}(?:_\d+)?\$$/);

	assert.throws(() => dollarQuote("bad\0nul"), /NUL bytes/);

	const boundaryInput = "value ending in $q_fixed and also $q_fixed_1";
	const boundaryQuoted = dollarQuote(boundaryInput, "q_fixed");
	assert.equal(boundaryQuoted, `$q_fixed_2$${boundaryInput}$q_fixed_2$`);
	assert.throws(() => dollarQuote("ok", "bad-tag"), /Invalid dollarQuote tagBase/);

	const anchors = [
		{ functionSignature: "public.qorpera_read_session_events(uuid,bigint,integer)", snippet: tricky, expectedCount: 1 },
	];
	const sql = buildAnchorCheckSql(anchors);
	assert.ok(sql.includes(tricky));
	assert.ok(sql.includes("pg_get_functiondef"));
	assert.throws(() => buildAnchorCheckSql([{ functionSignature: "public.f()", snippet: "", expectedCount: 1 }]), /snippet/);
	assert.throws(
		() => buildAnchorCheckSql([{ functionSignature: "public.f()", snippet: "x", expectedCount: "1; drop table x" }]),
		/expectedCount/,
	);

	assert.equal(evaluateAnchorResults(anchors, [{ index: 0, actualCount: 1 }]).ok, true);
	const mismatch = evaluateAnchorResults(anchors, [{ index: 0, actualCount: 2 }]);
	assert.equal(mismatch.ok, false);
	assert.equal(mismatch.exitCode, 88);
	assert.equal(mismatch.mismatches[0].actualCount, 2);

	const postChecks = [
		{ name: "proconfig", sql: "select 1", expected: ['search_path=""'] },
		{ name: "hasRunWake", sql: "select true", expected: true },
		{ name: "configJsonb", sql: "select '{}'::jsonb", expected: { enabled: true, mode: "live" } },
	];
	assert.equal(
		evaluatePostChecks(postChecks, {
			proconfig: ['search_path=""'],
			hasRunWake: true,
			configJsonb: { mode: "live", enabled: true },
		}).ok,
		true,
	);
	const badPost = evaluatePostChecks(postChecks, {
		proconfig: ["search_path="],
		hasRunWake: true,
		configJsonb: { mode: "live", enabled: true },
	});
	assert.equal(badPost.ok, false);
	assert.equal(badPost.exitCode, 87);
});

test("evaluateWatchTick validates kind and catches failures across every watch kind", () => {
	assert.throws(() => evaluateWatchTick({ kind: "home_watch", windowMinutes: 5, earlyExitOnCompletedRuns: 1 }, {}), /Invalid watch kind/);
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
			{ kind: "home-watch", windowMinutes: 15, earlyExitOnCompletedRuns: 1 },
			{ elapsedSeconds: 30, completedRuns: 2, claudeWorkerFailures: 1 },
		).exitCode,
		85,
	);
	assert.equal(
		evaluateWatchTick(
			{ kind: "claude-watch", windowMinutes: 15, earlyExitOnCompletedRuns: 1 },
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

test("runReleaseDriver enforces dryRun hold isolation, fail-closed PR checks, retries, ONCE_PHASES, and exception-safe MERGE-HOLD", async () => {
	const dir = mkdtempSync(join(tmpdir(), "qorpera-release-engine-"));
	const openPr = async () => ({ state: "OPEN", mergeable: "MERGEABLE" });
	try {
		const held = makeThinManifest({ armed: false });
		const refusedHeld = await runReleaseDriver(
			held,
			{ dryRun: false, stateDir: dir, env: {} },
			{ runPhase: async () => ({ exitCode: 0 }), readPrState: openPr },
		);
		assert.equal(refusedHeld.ok, false);
		assert.equal(refusedHeld.exitCode, 2);

		const armed = makeThinManifest({ armed: true });
		const refusedTest = await runReleaseDriver(
			armed,
			{ dryRun: false, env: { QORPERA_ROLL_TEST: "1" }, stateDir: dir },
			{ runPhase: async () => ({ exitCode: 0 }), readPrState: openPr },
		);
		assert.equal(refusedTest.ok, false);
		assert.equal(refusedTest.exitCode, 2);

		const refusedNoPrReader = await runReleaseDriver(
			armed,
			{ dryRun: false, stateDir: dir, env: {} },
			{ runPhase: async () => ({ exitCode: 0 }) },
		);
		assert.equal(refusedNoPrReader.ok, false);
		assert.equal(refusedNoPrReader.exitCode, 2);

		const refusedBadMaxTries = await runReleaseDriver(
			armed,
			{ dryRun: false, stateDir: dir, maxTries: 0, env: {} },
			{ runPhase: async () => ({ exitCode: 0 }), readPrState: openPr },
		);
		assert.equal(refusedBadMaxTries.ok, false);
		assert.equal(refusedBadMaxTries.exitCode, 2);

		assert.equal(
			(
				await runReleaseDriver(
					armed,
					{ dryRun: false, stateDir: dir, env: {} },
					{ runPhase: async () => ({ exitCode: 0 }), readPrState: async () => { throw new Error("gh offline"); } },
				)
			).exitCode,
			77,
		);
		assert.equal(
			(
				await runReleaseDriver(
					armed,
					{ dryRun: false, stateDir: dir, env: {} },
					{ runPhase: async () => ({ exitCode: 0 }), readPrState: async () => ({ state: "OPEN", mergeable: "" }) },
				)
			).exitCode,
			77,
		);
		assert.equal(
			(
				await runReleaseDriver(
					armed,
					{ dryRun: false, stateDir: dir, env: {} },
					{ runPhase: async () => ({ exitCode: 0 }), readPrState: async () => ({ state: "CLOSED", mergeable: "CONFLICTING" }) },
				)
			).exitCode,
			4,
		);

		const holdFile = join(dir, "MERGE-HOLD");
		const prepHoldFile = join(dir, "prep-hold.txt");
		writeFileSync(prepHoldFile, "prep hold v271\n", "utf8");
		writeFileSync(holdFile, "prep hold v271\n", "utf8");

		const dryComplete = await runReleaseDriver(
			armed,
			{ dryRun: true, stateDir: dir, holdFile, prepHoldFile, env: {} },
			{ runPhase: async () => ({ exitCode: 0 }) },
		);
		assert.equal(dryComplete.ok, true);
		assert.equal(readFileSync(holdFile, "utf8"), "prep hold v271\n");

		const dryStop = await runReleaseDriver(
			armed,
			{ dryRun: true, stateDir: dir, holdFile, prepHoldFile, env: {} },
			{ runPhase: async (step) => (step === "models-read" ? { exitCode: 87, reason: "dry stop" } : { exitCode: 0 }) },
		);
		assert.equal(dryStop.ok, false);
		assert.equal(readFileSync(holdFile, "utf8"), "prep hold v271\n");

		let targetCalls = 0;
		const anchorStop = await runReleaseDriver(
			armed,
			{ dryRun: false, stateDir: dir, holdFile, prepHoldFile, env: {} },
			{
				nowIso: () => "2026-11-21T01:00:00Z",
				readPrState: openPr,
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

		let retryCalls = 0;
		let webCalls = 0;
		const webOnceStop = await runReleaseDriver(
			armed,
			{ dryRun: false, stateDir: dir, holdFile, prepHoldFile, maxTries: 3, retryDelayMs: 0, env: {} },
			{
				nowIso: () => "2026-11-21T01:03:00Z",
				readPrState: async () => ({ state: "MERGED", mergeable: "UNKNOWN" }),
				runPhase: async (step) => {
					if (step === "prep") {
						retryCalls += 1;
						return retryCalls === 1 ? { exitCode: 1, reason: "transient" } : { exitCode: 0 };
					}
					if (step === "web") {
						webCalls += 1;
						return { exitCode: 1, reason: "line one\nline two\r\nline three" };
					}
					return { exitCode: 0 };
				},
			},
		);
		assert.equal(webOnceStop.ok, false);
		assert.equal(retryCalls, 2);
		assert.equal(webCalls, 1);
		const kept = readFileSync(holdFile, "utf8");
		assert.equal(kept.trimEnd().split("\n").length, 4);
		assert.match(kept, /^MERGE-HOLD KEPT by the v271 roll/);
		assert.match(kept, /Stopped at: web \(line one line two line three\)/);

		const resumed = await runReleaseDriver(
			armed,
			{ dryRun: false, stateDir: dir, holdFile, from: "web", env: {} },
			{
				nowIso: () => "2026-11-21T01:10:00Z",
				readPrState: openPr,
				runPhase: async () => ({ exitCode: 0 }),
			},
		);
		assert.equal(resumed.ok, true);
		assert.equal(existsSync(holdFile), false);

		writeFileSync(holdFile, "prep hold v271\n", "utf8");
		const threwPreWrite = await runReleaseDriver(
			armed,
			{ dryRun: false, stateDir: dir, holdFile, prepHoldFile, env: {} },
			{
				nowIso: () => "2026-11-21T01:12:00Z",
				readPrState: openPr,
				runPhase: async (step) => {
					if (step === "prep") throw new Error("ssh dropped");
					return { exitCode: 0 };
				},
			},
		);
		assert.equal(threwPreWrite.ok, false);
		assert.equal(threwPreWrite.exitCode, 1);
		assert.equal(readFileSync(holdFile, "utf8"), "prep hold v271\n");

		const invalidExitStop = await runReleaseDriver(
			armed,
			{ dryRun: false, stateDir: dir, holdFile, prepHoldFile, env: {} },
			{
				nowIso: () => "2026-11-21T01:13:00Z",
				readPrState: openPr,
				runPhase: async () => ({}),
			},
		);
		assert.equal(invalidExitStop.ok, false);
		assert.equal(invalidExitStop.exitCode, 1);
		assert.equal(readFileSync(holdFile, "utf8"), "prep hold v271\n");

		const emptyFromRefused = await runReleaseDriver(
			armed,
			{ dryRun: true, stateDir: dir, from: "", env: {} },
			{ runPhase: async () => ({ exitCode: 0 }) },
		);
		assert.equal(emptyFromRefused.ok, false);
		assert.equal(emptyFromRefused.exitCode, 2);

		let syncReadCalls = 0;
		const syncPrReturnStop = await runReleaseDriver(
			armed,
			{ dryRun: false, stateDir: dir, holdFile, prepHoldFile, env: {} },
			{
				nowIso: () => "2026-11-21T01:13:30Z",
				readPrState: () => {
					syncReadCalls += 1;
					return { state: "OPEN", mergeable: "MERGEABLE" };
				},
				runPhase: async (step) => (step === "models-read" ? { exitCode: 87, reason: "sync check" } : { exitCode: 0 }),
			},
		);
		assert.equal(syncPrReturnStop.ok, false);
		assert.equal(syncReadCalls, 2);
		assert.match(readFileSync(holdFile, "utf8"), /Release PR #2020 state: OPEN\./);
		rmSync(holdFile, { force: true });

		let syncThrowCalls = 0;
		const syncPrThrowStop = await runReleaseDriver(
			armed,
			{ dryRun: false, stateDir: dir, holdFile, env: {} },
			{
				nowIso: () => "2026-11-21T01:13:45Z",
				readPrState: () => {
					syncThrowCalls += 1;
					if (syncThrowCalls === 1) return { state: "OPEN", mergeable: "MERGEABLE" };
					throw new Error("gh sync error");
				},
				runPhase: async (step) => (step === "models-read" ? { exitCode: 87, reason: "sync throw" } : { exitCode: 0 }),
			},
		);
		assert.equal(syncPrThrowStop.ok, false);
		assert.match(readFileSync(holdFile, "utf8"), /Release PR #2020 state unreadable\./);
		rmSync(holdFile, { force: true });

		writeFileSync(holdFile, "foreign lead hold\n", "utf8");
		const foreignRespected = await runReleaseDriver(
			armed,
			{ dryRun: false, stateDir: dir, holdFile, env: {} },
			{ readPrState: openPr, runPhase: async () => ({ exitCode: 0 }) },
		);
		assert.equal(foreignRespected.ok, true);
		assert.equal(readFileSync(holdFile, "utf8"), "foreign lead hold\n");
		rmSync(holdFile, { force: true });

		const sqlCutA = makeSqlOnlyManifest({ armed: true, baseCommit: SHA_40 });
		const sqlCutB = makeSqlOnlyManifest({ armed: true, baseCommit: SHA_40_C });
		assert.notEqual(releaseHoldLabel(sqlCutA), releaseHoldLabel(sqlCutB));
		const sqlKeptA = keptHoldText({
			manifest: sqlCutA,
			stoppedAt: "models-read",
			atIso: "2026-11-21T01:15:00Z",
			firstWritePhase: "migrate",
			stopWhy: "post-check failed",
			prStateSummary: "SQL-only release (no release PR).",
		});
		writeFileSync(holdFile, sqlKeptA, "utf8");
		const sqlBRun = await runReleaseDriver(
			sqlCutB,
			{ dryRun: false, stateDir: dir, holdFile, env: {} },
			{ runPhase: async () => ({ exitCode: 0 }) },
		);
		assert.equal(sqlBRun.ok, true);
		assert.equal(readFileSync(holdFile, "utf8"), sqlKeptA);

		const sqlAResume = await runReleaseDriver(
			sqlCutA,
			{ dryRun: false, stateDir: dir, holdFile, from: "models-read", env: {} },
			{ runPhase: async () => ({ exitCode: 0 }) },
		);
		assert.equal(sqlAResume.ok, true);
		assert.equal(existsSync(holdFile), false);

		for (const marker of ["WAY-BACK-STARTED", "WAY-BACK-TAKEN"]) {
			const markerPath = join(dir, marker);
			writeFileSync(markerPath, "marked\n", "utf8");
			const blocked = await runReleaseDriver(
				armed,
				{ dryRun: true, stateDir: dir, env: {} },
				{ runPhase: async () => ({ exitCode: 0 }) },
			);
			assert.equal(blocked.ok, false);
			assert.equal(blocked.exitCode, 2);
			rmSync(markerPath, { force: true });
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("NON_RETRYABLE_CODES covers safety refusals, image-build rejects injection/traversal, and cli validates subcommands", async () => {
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
	assert.throws(() => lxcPublishArgs({ builderName: undefined, project: "qorpera-build" }), /Invalid builderName/);
	assert.throws(() => lxcPublishArgs({ builderName: "b", project: null }), /Invalid project/);
	assert.throws(
		() => lxcPublishArgs({ builderName: "b", project: "p", properties: { "--public": "true" } }),
		/Invalid image property key/,
	);
	assert.equal(exportExtensionForCompression("zstd"), ".tar.zst");
	assert.equal(exportExtensionForCompression("gzip"), ".tar.gz");
	assert.equal(exportExtensionForCompression("none"), ".tar");
	assert.deepEqual(
		lxcExportArgs({ fingerprint: SHA_64, project: "qorpera-build", targetBasePath: "/var/tmp/out" }),
		["image", "export", SHA_64, "/var/tmp/out", "--project", "qorpera-build"],
	);
	assert.throws(
		() => lxcExportArgs({ fingerprint: SHA_64, project: "qorpera-build", targetBasePath: "--help" }),
		/Invalid targetBasePath/,
	);

	const dir = mkdtempSync(join(tmpdir(), "qorpera-img-cli-"));
	try {
		mkdirSync(dir, { recursive: true });
		assert.throws(() => readOrCreateReceipt(dir, "../escape", { passed: true }), /Invalid receipt phase/);
		const first = readOrCreateReceipt(dir, "publish", { passed: true, fingerprint: SHA_64 });
		assert.equal(first.reused, false);
		const second = readOrCreateReceipt(dir, "publish", { passed: true, fingerprint: "0".repeat(64) });
		assert.equal(second.reused, true);
		assert.equal(second.receipt.fingerprint, SHA_64);

		assert.throws(() => parseSubcommandFlags("constructor", ["--manifest", "a.json"]), /Usage:/);
		assert.throws(() => parseSubcommandFlags("init", ["--unknown", "1"]), /Unknown flag/);
		assert.throws(() => parseSubcommandFlags("init", ["--prev-version", "--pr", "10"]), /requires a value/);
		assert.throws(() => parseSubcommandFlags("init", ["--out", ""]), /requires a value/);
		assert.throws(() => parseSubcommandFlags("dry-run", ["--manifest", "a.json", "--from"]), /requires a value/);
		assert.throws(() => parseSubcommandFlags("dry-run", ["--manifest", "a.json", "--from", ""]), /requires a value/);

		const manifestPath = join(dir, "manifest.json");
		const manifest = makeSqlOnlyManifest({
			migrations: [
				{
					id: "20260930822000",
					file: "supabase/migrations/20260930822000_thread_run_wakes.sql",
					anchors: [
						{
							functionSignature: "public.qorpera_test(uuid)",
							snippet: "select 1",
							expectedCount: 1,
						},
					],
					postChecks: [],
				},
			],
		});
		writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

		const capture = async (argv, cwd = dir) => {
			let out = "";
			const code = await runCli(argv, { cwd, stdout: { write: (chunk) => { out += chunk; } } });
			return { code, out };
		};

		const repoDir = join(dir, "repo");
		mkdirSync(join(repoDir, "supabase/migrations"), { recursive: true });
		mkdirSync(join(repoDir, "supabase/tests"), { recursive: true });
		const gitInRepo = (args) =>
			execFileSync("git", args, {
				cwd: repoDir,
				encoding: "utf8",
				env: {
					...process.env,
					GIT_AUTHOR_NAME: "tester",
					GIT_AUTHOR_EMAIL: "tester@invalid",
					GIT_COMMITTER_NAME: "tester",
					GIT_COMMITTER_EMAIL: "tester@invalid",
				},
			}).trim();
		gitInRepo(["init", "-q"]);
		writeFileSync(join(repoDir, "supabase/tests/1200_old.test.sql"), "select 1;\n", "utf8");
		gitInRepo(["add", "-A"]);
		gitInRepo(["commit", "-qm", "base"]);
		const baseSha = gitInRepo(["rev-parse", "HEAD"]);
		rmSync(join(repoDir, "supabase/tests/1200_old.test.sql"));
		writeFileSync(join(repoDir, "supabase/migrations/20260930822000_thread_run_wakes.sql"), "select 1;\n", "utf8");
		writeFileSync(join(repoDir, "supabase/tests/1311_thread_run_wakes.test.sql"), "select 1;\n", "utf8");
		gitInRepo(["add", "-A"]);
		gitInRepo(["commit", "-qm", "sql change"]);
		const outManifest = join(dir, "init-manifest.json");
		const initRes = await capture(
			[
				"init",
				"--from",
				baseSha,
				"--to",
				"HEAD",
				"--prev-version",
				"270",
				"--prev-bundle",
				SHA_64,
				"--prev-node-release",
				"157",
				"--out",
				outManifest,
			],
			repoDir,
		);
		assert.equal(initRes.code, 0);
		const initManifest = JSON.parse(readFileSync(outManifest, "utf8"));
		assert.equal(initManifest.mode, "sql-only");
		assert.deepEqual(initManifest.sqlTests, ["1311"]);

		const validated = await capture(["validate", "--manifest", manifestPath]);
		assert.equal(validated.code, 0);
		assert.match(validated.out, /^valid v270 mode=sql-only armed=false\n$/);

		const planned = await capture(["plan", "--manifest", manifestPath]);
		assert.equal(planned.code, 0);
		assert.deepEqual(JSON.parse(planned.out).steps, ["target", "packets", "rehearse", "migrate", "models-read", "after-read"]);

		const anchorSql = await capture(["anchor-sql", "--manifest", manifestPath]);
		assert.equal(anchorSql.code, 0);
		assert.ok(anchorSql.out.includes("public.qorpera_test(uuid)"));

		const dryRun = await capture(["dry-run", "--manifest", manifestPath, "--from", "migrate"]);
		assert.equal(dryRun.code, 0);
		assert.deepEqual(JSON.parse(dryRun.out).executed, ["migrate", "models-read", "after-read"]);

		await assert.rejects(() => capture(["validate"]), /Missing required flag: --manifest/);

		const packetsOut = join(dir, "sql-only-packets");
		const packetsRes = await capture(
			["packets", "--manifest", outManifest, "--out", packetsOut, "--repo", repoDir],
			dir,
		);
		assert.equal(packetsRes.code, 0);
		const packetsSummary = JSON.parse(packetsRes.out);
		assert.deepEqual(packetsSummary.order, [
			"00-check.sql",
			"05-rehearse-migrations.sql",
			"10-migration-20260930822000_thread_run_wakes.sql",
			"20-post-check.sql",
		]);
		assert.deepEqual(packetsSummary.dryRunOnly, [
			"00-check.sql",
			"05-rehearse-migrations.sql",
			"20-post-check.sql",
		]);
		const writtenManifest = JSON.parse(readFileSync(join(packetsOut, "packet.json"), "utf8"));
		assert.equal(writtenManifest.schema, SQL_ONLY_PACKET_SCHEMA);
		assert.equal(Object.keys(writtenManifest.files).length, 4);
		await assert.rejects(
			() => capture(["packets", "--manifest", outManifest, "--out", packetsOut, "--repo", repoDir], dir),
			/packets are written once/,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("sqlOnlyPackets enforces single-transaction safety, pg_temp cleanup, read-only postChecks, and adapters validate gh/runtime-roll args", () => {
	const manifest = makeSqlOnlyManifest({
		migrations: [
			{
				id: "20260930822000",
				file: "supabase/migrations/20260930822000_thread_run_wakes.sql",
				anchors: [
					{
						functionSignature: "public.qorpera_test(uuid)",
						snippet: `set search_path=""`,
						expectedCount: 1,
					},
				],
				postChecks: [
					{ name: "hasFlag", sql: "select true;", expected: true },
				],
			},
			{
				id: "20260930822100",
				file: "supabase/migrations/20260930822100_thread_run_wakes_followup.sql",
				anchors: [],
				postChecks: [],
			},
		],
	});
	const migMap = {
		"supabase/migrations/20260930822000_thread_run_wakes.sql":
			"begin;\ncreate function pg_temp.helper() returns int language sql as $$ select 1 $$; select pg_temp.helper();\ncommit;\n",
		"supabase/migrations/20260930822100_thread_run_wakes_followup.sql":
			"create function pg_temp.helper() returns int language sql as $$ select 2 $$; select pg_temp.helper();\n",
	};
	const packets = sqlOnlyPackets(manifest, migMap);
	assert.deepEqual(Object.keys(packets), [
		"00-check.sql",
		"05-rehearse-migrations.sql",
		"10-migration-20260930822000_thread_run_wakes.sql",
		"10-migration-20260930822100_thread_run_wakes_followup.sql",
		"20-post-check.sql",
	]);
	assert.ok(packets["00-check.sql"].includes(`set search_path=""`));
	assert.ok(packets["05-rehearse-migrations.sql"].includes("drop function"));
	assert.equal(packets["05-rehearse-migrations.sql"].split("set local lock_timeout = '5s';").length - 1, 3);
	assert.ok(packets["05-rehearse-migrations.sql"].includes("as sql_only_rehearsal;"));
	assert.ok(packets["10-migration-20260930822000_thread_run_wakes.sql"].includes("as sql_only_migration;"));
	assert.doesNotMatch(
		packets["10-migration-20260930822000_thread_run_wakes.sql"],
		/array\[\$q_[0-9a-f]{12}(?:_\d+)?\$\s*begin;/i,
	);
	assert.ok(packets["10-migration-20260930822100_thread_run_wakes_followup.sql"].includes("20260930822000"));
	assert.ok(packets["20-post-check.sql"].includes("'hasFlag', to_jsonb((select true))"));

	assert.throws(
		() =>
			validateReleaseManifest({
				...manifest,
				migrations: [manifest.migrations[1], manifest.migrations[0]],
			}),
		/migrations must be sorted by ascending id/,
	);

	assert.throws(
		() =>
			sqlOnlyPackets(manifest, {
				...migMap,
				"supabase/migrations/20260930822000_thread_run_wakes.sql": "create index concurrently idx_x on t(a);",
			}),
		/cannot run in a transaction/,
	);
	assert.throws(
		() =>
			sqlOnlyPackets(
				makeSqlOnlyManifest({
					migrations: [
						{
							id: "20260930822000",
							file: "supabase/migrations/20260930822000_thread_run_wakes.sql",
							anchors: [],
							postChecks: [{ name: "mutating", sql: "with d as (delete from t returning 1) select count(*) from d", expected: 0 }],
						},
					],
				}),
				{ "supabase/migrations/20260930822000_thread_run_wakes.sql": "select 1;" },
			),
		/mutating SQL keywords/,
	);
	assert.throws(() => writeSqlOnlyPackets("", manifest, migMap), /non-empty path/);

	const ghState = readPrStateViaGh(2014, {
		exec: (bin, args) => {
			assert.equal(bin, "gh");
			assert.deepEqual(args, ["pr", "view", "2014", "--repo", "Qorpera/Qorpera_Base", "--json", "state,mergeable"]);
			return JSON.stringify({ state: "OPEN", mergeable: "MERGEABLE" });
		},
	});
	assert.deepEqual(ghState, { state: "OPEN", mergeable: "MERGEABLE" });
	assert.throws(() => readPrStateViaGh(0), /Invalid PR number/);
	assert.throws(() => readPrStateViaGh(2014, { repo: "bad repo" }), /Invalid GitHub repository slug/);

	const thin = makeThinManifest({ armed: true });
	const rollArgs = buildRuntimeRollPacketArgs(thin, {
		activation: "supabase/migrations/20260929027199_runtime_bundle_activation_v271.sql",
		toSha: "e".repeat(64),
		nodeAId: "11111111-1111-1111-1111-111111111111",
		nodeBId: "22222222-2222-2222-2222-222222222222",
		reason: "v271 thin runtime cut",
		outDir: "/tmp/roll-packets",
		repo: "/tmp/repo",
	});
	assert.equal(rollArgs[0], "packets");
	assert.ok(rollArgs.includes("--activation"));
	assert.ok(rollArgs.includes("20260929027199_runtime_bundle_activation_v271.sql"));
	assert.throws(
		() =>
			buildRuntimeRollPacketArgs(manifest, {
				activation: "20260929027199_runtime_bundle_activation_v271.sql",
				toSha: "e".repeat(64),
				nodeAId: "11111111-1111-1111-1111-111111111111",
				nodeBId: "22222222-2222-2222-2222-222222222222",
				reason: "bad",
				outDir: "/tmp/x",
			}),
		/sql-only manifests use writeSqlOnlyPackets/,
	);
});
