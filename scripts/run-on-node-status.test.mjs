import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "./run-on-node.mjs";
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
	// A narrowed run cannot speak for the suite; changed only against origin/master (an empty plan is no proof).
	assert.match(statusDecision({ suite: "test", dirty: false, disabled: false, slug, plain: false }).reason, /narrow/);
	assert.match(statusDecision({ suite: "changed", dirty: false, disabled: false, slug, base: "HEAD" }).reason, /only a run against origin\/master/);
	assert.equal(statusDecision({ suite: "hosted-db", dirty: false, disabled: false, slug, base: "HEAD" }).post, true);
});

test("only the plain invocation of a suite is plain", () => {
	assert.equal(parseArgs(["changed"]).plain, true);
	assert.equal(parseArgs(["test"]).plain, true);
	assert.equal(parseArgs(["hosted-db"]).plain, true);
	for (const argv of [
		["test", "--", "-t", "one"],
		["--no-install", "hosted-db"],
		["--install", "hosted-db"],
		["--no-build", "test"],
		["--env", "A=1", "changed"],
		["--sudo", "scripts/x-linux.mjs"],
	])
		assert.equal(parseArgs(argv).plain, false, argv.join(" "));
	assert.equal(parseArgs(["--", "true"]).plain, false);
});

test("results map to GitHub states and short descriptions", () => {
	assert.deepEqual(["passed", "failed", "install-failed", "setup-failed", "unknown"].map(statusState), [
		"success",
		"failure",
		"failure",
		"error",
		"error",
	]);
	assert.equal(statusDescription({ result: "install-failed", elapsedSeconds: 30, runner: "ci03" }), "failed on node 2 in 30s: npm ci or the build (ci03)");
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
