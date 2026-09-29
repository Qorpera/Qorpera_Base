import assert from "node:assert/strict";
import test from "node:test";
import { repoSlug, statusContext, statusDecision, statusDescription, statusState } from "./run-on-node-status.mjs";

test("the repository comes from any GitHub remote form", () => {
	for (const url of [
		"https://github.com/Qorpera/Qorpera_Base.git",
		"https://github.com/Qorpera/Qorpera_Base",
		"git@github.com:Qorpera/Qorpera_Base.git",
		"ssh://git@github.com/Qorpera/Qorpera_Base.git\n",
	])
		assert.equal(repoSlug(url), "Qorpera/Qorpera_Base", url);
	assert.equal(repoSlug("/Users/me/bundle.git"), null);
	assert.equal(repoSlug("https://gitlab.com/a/b.git"), null);
});

test("named suites get a context; ad-hoc commands, dirty trees and --no-status post nothing", () => {
	assert.equal(statusContext("changed"), "qorpera-ci/changed");
	assert.equal(statusContext("scripts/test-office-preparation-linux.mjs"), "qorpera-ci/scripts/test-office-preparation-linux.mjs");
	assert.equal(statusContext(null), null);
	const slug = "Qorpera/Qorpera_Base";
	assert.deepEqual(statusDecision({ suite: "changed", dirty: false, disabled: false, slug }), { post: true, reason: null });
	assert.match(statusDecision({ suite: "changed", dirty: true, disabled: false, slug }).reason, /uncommitted/);
	assert.match(statusDecision({ suite: null, dirty: false, disabled: false, slug }).reason, /ad-hoc/);
	assert.match(statusDecision({ suite: "test", dirty: false, disabled: true, slug }).reason, /--no-status/);
	assert.match(statusDecision({ suite: "test", dirty: false, disabled: false, slug: null }).reason, /not a GitHub/);
});

test("results map to GitHub states and short descriptions", () => {
	assert.deepEqual(["passed", "failed", "setup-failed", "unknown"].map(statusState), ["success", "failure", "error", "error"]);
	assert.equal(
		statusDescription({ result: "passed", elapsedSeconds: 552.4, runner: "ci02", changed: { steps: ["lint", "web"] } }),
		"passed on node 2 in 9m12s: 2 steps (ci02)",
	);
	assert.equal(
		statusDescription({ result: "failed", elapsedSeconds: 41, runner: "ci01", failedSteps: ["runtime", "scripts"] }),
		"failed on node 2 in 41s: runtime, scripts (ci01)",
	);
	assert.equal(
		statusDescription({ result: "setup-failed", elapsedSeconds: 3, runner: null }),
		"setup-failed on node 2 in 3s: the harness, not the suite",
	);
	const long = statusDescription({ result: "failed", elapsedSeconds: 1, runner: "ci01", failedSteps: Array(40).fill("runner-orchestrator") });
	assert.ok(long.length <= 140, String(long.length));
});
