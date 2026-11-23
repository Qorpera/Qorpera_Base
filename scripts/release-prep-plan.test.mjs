import assert from "node:assert/strict";
import test from "node:test";
import {
	buildReleasePrepPlan,
	classifyReleaseDiff,
	isReleaseDerivedOnly,
	isReleaseDerivedPath,
	parseCliArgs,
} from "./release-prep-plan.mjs";

test("isReleaseDerivedOnly accepts strictly derived bundle files and docs", () => {
	assert.equal(
		isReleaseDerivedOnly([
			"scripts/generate-cloud-runtime-bundle.mjs",
			"packages/runtime/src/cloud-runtime-bundle.generated.ts",
			"deploy/first-node/native-codex/runtime-bundle-manifest.json",
			"deploy/first-node/native-codex/guest-package-manifest.json",
			"supabase/migrations/20260929027099_runtime_bundle_activation_v270.sql",
			"packages/runtime/CHANGELOG.md",
		]),
		true,
	);
	assert.equal(isReleaseDerivedPath("supabase/migrations/20260930822000_thread_run_wakes.sql"), false);
	assert.equal(isReleaseDerivedOnly(["packages/runtime/src/cloud-native-company-context.ts"]), false);
	assert.equal(isReleaseDerivedOnly([]), false);
});

test("SQL-only plus web-only diff produces sql-only mode with zero image rebuild, C4c, or idle watches", () => {
	const classification = classifyReleaseDiff(
		[
			"supabase/migrations/20260930822000_thread_run_wakes.sql",
			"supabase/tests/1311_thread_run_wakes.test.sql",
			"supabase/tests/1248_removed_legacy.test.sql",
			"packages/web/src/app/views/thread.ts",
			"packages/web/src/cloud/parse.ts",
			"packages/runtime/CHANGELOG.md",
		],
		{
			existingFiles: [
				"supabase/migrations/20260930822000_thread_run_wakes.sql",
				"supabase/tests/1311_thread_run_wakes.test.sql",
				"packages/web/src/app/views/thread.ts",
				"packages/web/src/cloud/parse.ts",
				"packages/runtime/CHANGELOG.md",
			],
		},
	);
	assert.equal(classification.sqlOnly, true);
	assert.equal(classification.noRelease, false);
	assert.deepEqual(classification.migrations, ["supabase/migrations/20260930822000_thread_run_wakes.sql"]);
	assert.deepEqual(classification.sqlTests, ["1311"]);

	const plan = buildReleasePrepPlan(classification, { thinRuntimeEnabled: true });
	assert.equal(plan.mode, "sql-only");
	assert.equal(plan.needsBundleBump, false);
	assert.equal(plan.needsNodeRelease, false);
	assert.equal(plan.needsBaseImageRebuild, false);
	assert.equal(plan.runC4c, false);
	assert.deepEqual(plan.provers, []);
	assert.deepEqual(plan.watchPolicy, {
		homeWatchMinutes: 0,
		claudeWatchMinutes: 0,
		smokeMinutes: 0,
		pollSeconds: 30,
		earlyExitOnCompletedRuns: 1,
	});
});

test("web-only, docs-only, test-only, and empty diffs classify as no-release instead of full-image", () => {
	for (const files of [
		[],
		["packages/web/src/app/views/thread.ts", "packages/member-web/ui/card.ts"],
		["README.md", "docs-audit/notes.md"],
		["packages/runtime/test/cloud-native-company-context.test.ts", "scripts/prove-first-requests.mjs"],
	]) {
		const classification = classifyReleaseDiff(files);
		assert.equal(classification.sqlOnly, false);
		assert.equal(classification.noRelease, true);
		const plan = buildReleasePrepPlan(classification, { thinRuntimeEnabled: false });
		assert.equal(plan.mode, "no-release");
		assert.equal(plan.needsBundleBump, false);
		assert.equal(plan.needsNodeRelease, false);
		assert.equal(plan.needsBaseImageRebuild, false);
		assert.equal(plan.runC4c, false);
		assert.deepEqual(plan.provers, []);
		assert.equal(plan.watchPolicy.smokeMinutes, 0);
	}
});

test("runtime prompt-only diff skips C4c and 15-minute watches, and uses thin-runtime when enabled", () => {
	const classification = classifyReleaseDiff([
		"packages/runtime/src/cloud-native-company-context.ts",
		"packages/runtime/src/cloud-runtime-constitution.ts",
		"packages/cloud-client/src/company-state-files.ts",
		"packages/runtime/test/cloud-native-company-context.test.ts",
		"scripts/prove-first-requests.mjs",
	]);
	assert.equal(classification.sqlOnly, false);
	assert.equal(classification.noRelease, false);
	assert.equal(classification.runtimeJsChanged, true);
	assert.equal(classification.baseImageChanged, false);
	assert.equal(classification.claudeBoxChanged, false);
	assert.equal(classification.codexHomeChanged, false);

	const thin = buildReleasePrepPlan(classification, { thinRuntimeEnabled: true });
	assert.equal(thin.mode, "thin-runtime");
	assert.equal(thin.needsBundleBump, true);
	assert.equal(thin.needsNodeRelease, true);
	assert.equal(thin.needsBaseImageRebuild, false);
	assert.equal(thin.runC4c, false);
	assert.equal(thin.imageCompression, "zstd");
	assert.deepEqual(thin.provers, ["scripts/prove-home-channel.mjs", "scripts/prove-hire-team.mjs"]);
	assert.equal(thin.watchPolicy.homeWatchMinutes, 0);
	assert.equal(thin.watchPolicy.claudeWatchMinutes, 0);
	assert.equal(thin.watchPolicy.smokeMinutes, 2);

	const legacy = buildReleasePrepPlan(classification, { thinRuntimeEnabled: false });
	assert.equal(legacy.mode, "full-image");
	assert.equal(legacy.needsBaseImageRebuild, true);
	assert.equal(legacy.runC4c, false);
});

test("deleted operational files still trigger operational classification even when excluded from existingFiles", () => {
	const classification = classifyReleaseDiff(
		["packages/runtime/src/deleted-module.ts", "supabase/tests/1249_deleted.test.sql"],
		{ existingFiles: [] },
	);
	assert.equal(classification.runtimeJsChanged, true);
	assert.equal(classification.noRelease, false);
	assert.deepEqual(classification.sqlTests, []);
});

test("claude-box, claude-worker, or codex-home diffs re-enable C4c and targeted 15-minute watches", () => {
	for (const file of [
		"packages/runtime/src/cloud-claude-box.ts",
		"packages/runtime/src/cloud-claude-worker.ts",
		"packages/runtime/src/cloud-claude-picture-command.ts",
	]) {
		const boxClass = classifyReleaseDiff([file]);
		const boxPlan = buildReleasePrepPlan(boxClass, { thinRuntimeEnabled: true });
		assert.equal(boxPlan.runC4c, true, file);
		assert.equal(boxPlan.watchPolicy.claudeWatchMinutes, 15, file);
		assert.equal(boxPlan.watchPolicy.homeWatchMinutes, 0, file);
	}

	for (const file of [
		"packages/runtime/src/cloud-codex-home.ts",
		"deploy/coding-worker/home-session-authority.ts",
	]) {
		const homeClass = classifyReleaseDiff([file]);
		const homePlan = buildReleasePrepPlan(homeClass, { thinRuntimeEnabled: true });
		assert.equal(homePlan.runC4c, false, file);
		assert.equal(homePlan.watchPolicy.homeWatchMinutes, 15, file);
		assert.equal(homePlan.watchPolicy.claudeWatchMinutes, 0, file);
	}

	const guestClass = classifyReleaseDiff(["deploy/lxd-runner-guest/qorpera-native-provider-host.service"]);
	const guestPlan = buildReleasePrepPlan(guestClass, { thinRuntimeEnabled: true });
	assert.equal(guestPlan.mode, "full-image");
	assert.equal(guestPlan.needsBaseImageRebuild, true);
	assert.equal(guestPlan.runC4c, true);
});

test("folder-service and runner-orchestrator code/surface changes trigger node release instead of no-release", () => {
	for (const file of [
		"packages/object-gateway/src/folder-service/mounts.ts",
		"packages/runner-orchestrator/src/surface-code-host-worker.ts",
		"packages/runner-orchestrator/src/code-host-views.ts",
		"packages/runner-orchestrator/src/coding-executor.ts",
	]) {
		const classification = classifyReleaseDiff([file]);
		assert.equal(classification.noRelease, false, file);
		assert.equal(classification.sqlOnly, false, file);
		const plan = buildReleasePrepPlan(classification, { thinRuntimeEnabled: true });
		assert.equal(plan.needsNodeRelease, true, file);
	}
});

test("parseCliArgs rejects missing values, flag-like values, and unknown flags", () => {
	assert.deepEqual(parseCliArgs(["--from", "abc123", "--to", "HEAD", "--thin-runtime", "--json"]), {
		from: "abc123",
		to: "HEAD",
		thinRuntimeEnabled: true,
		json: true,
	});
	assert.throws(() => parseCliArgs([]), /Missing --from/);
	assert.throws(() => parseCliArgs(["--from", "--json"]), /requires a non-flag value/);
	assert.throws(() => parseCliArgs(["--from", "abc123", "--to", "-q"]), /requires a non-flag value/);
	assert.throws(() => parseCliArgs(["--from", "abc123", "--bogus"]), /Usage:/);
});
