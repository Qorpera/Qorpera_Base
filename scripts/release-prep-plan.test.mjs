import assert from "node:assert/strict";
import test from "node:test";
import {
	buildReleasePrepPlan,
	classifyReleaseDiff,
	isReleaseDerivedOnly,
	isReleaseDerivedPath,
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
	const classification = classifyReleaseDiff([
		"supabase/migrations/20260930822000_thread_run_wakes.sql",
		"supabase/tests/1311_thread_run_wakes.test.sql",
		"packages/web/src/app/views/thread.ts",
		"packages/web/src/cloud/parse.ts",
		"packages/runtime/CHANGELOG.md",
	]);
	assert.equal(classification.sqlOnly, true);
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

test("runtime prompt-only diff skips C4c and 15-minute watches, and uses thin-runtime when enabled", () => {
	const classification = classifyReleaseDiff([
		"packages/runtime/src/cloud-native-company-context.ts",
		"packages/runtime/src/cloud-runtime-constitution.ts",
		"packages/cloud-client/src/company-state-files.ts",
		"packages/runtime/test/cloud-native-company-context.test.ts",
		"scripts/prove-first-requests.mjs",
	]);
	assert.equal(classification.sqlOnly, false);
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

test("claude-box or codex-home diffs re-enable C4c and targeted 15-minute watches", () => {
	const boxClass = classifyReleaseDiff(["packages/runtime/src/cloud-claude-box.ts"]);
	const boxPlan = buildReleasePrepPlan(boxClass, { thinRuntimeEnabled: true });
	assert.equal(boxPlan.runC4c, true);
	assert.equal(boxPlan.watchPolicy.claudeWatchMinutes, 15);
	assert.equal(boxPlan.watchPolicy.homeWatchMinutes, 0);

	const homeClass = classifyReleaseDiff(["packages/runtime/src/cloud-codex-home.ts"]);
	const homePlan = buildReleasePrepPlan(homeClass, { thinRuntimeEnabled: true });
	assert.equal(homePlan.runC4c, false);
	assert.equal(homePlan.watchPolicy.homeWatchMinutes, 15);
	assert.equal(homePlan.watchPolicy.claudeWatchMinutes, 0);

	const guestClass = classifyReleaseDiff(["deploy/lxd-runner-guest/qorpera-native-provider-host.service"]);
	const guestPlan = buildReleasePrepPlan(guestClass, { thinRuntimeEnabled: true });
	assert.equal(guestPlan.mode, "full-image");
	assert.equal(guestPlan.needsBaseImageRebuild, true);
	assert.equal(guestPlan.runC4c, true);
});
