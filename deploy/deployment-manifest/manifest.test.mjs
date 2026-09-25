import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	applyChanges,
	CHANGES_SCHEMA,
	canonicalJson,
	checkHistory,
	checkManifest,
	drift,
	identityDigest,
	laneChanges,
	main,
	OBSERVED_SCHEMA,
	renderMarkdown,
	sha256,
	webChanges,
} from "./manifest.mjs";

const fp = (character) => character.repeat(64);
const NOW = "2026-09-25T03:00:00.000Z";

function workspace() {
	const root = mkdtempSync(join(tmpdir(), "manifest-"));
	mkdirSync(join(root, "outputs"));
	writeFileSync(
		join(root, "outputs/REGISTRY.md"),
		"# log\n- 21:01Z **v106 CUT LIVE** from master\n- 21:15Z **v106 ACCEPTED live**\n",
	);
	writeFileSync(join(root, "receipt.json"), '{"ok":true}\n');
	return root;
}

const changes = (operations, reason = "test") => ({ schema: CHANGES_SCHEMA, reason, writtenBy: "test", operations });
const setBundle = (version, sha) => ({
	op: "set",
	id: "runtime-bundle",
	title: "Runtime bundle",
	scope: "global",
	identity: { version, sha256: sha },
	live: { since: "2026-09-24T20:59:55.665Z", cut: `v${version}`, records: [{ path: "receipt.json" }] },
});
const accept = (ids) => ({
	op: "accept",
	ids,
	at: "2026-09-24T21:15:00Z",
	summary: "run 8f94f0c1 completed",
	records: [{ path: "outputs/REGISTRY.md", line: 3, quote: "v106 ACCEPTED live" }],
});

test("canonical JSON sorts keys at every level and keeps array order", () => {
	assert.equal(canonicalJson({ b: 1, a: { d: [2, 1], c: null } }), '{"a":{"c":null,"d":[2,1]},"b":1}');
	assert.equal(identityDigest({ a: 1, b: 2 }), identityDigest({ b: 2, a: 1 }));
});

test("acceptance binds to the identity it was run against", () => {
	const root = workspace();
	const one = applyChanges(null, changes([setBundle(106, fp("a")), accept(["runtime-bundle"])]), { root, now: NOW });
	assert.equal(one.sequence, 1);
	assert.equal(one.previous, null);
	assert.equal(one.components[0].acceptance.state, "accepted");
	assert.equal(one.components[0].live.records[0].sha256, sha256(readFileSync(join(root, "receipt.json"))));
	assert.deepEqual(checkManifest(one, { root }), []);

	// Same identity again (a new live record only): the evidence still counts.
	const same = applyChanges(one, changes([setBundle(106, fp("a"))]), { root, now: NOW, previousSha256: fp("1") });
	assert.equal(same.components[0].acceptance.state, "accepted");

	// A new identity: the old evidence no longer counts and is kept only as superseded.
	const two = applyChanges(one, changes([setBundle(107, fp("b"))]), { root, now: NOW, previousSha256: fp("1") });
	const bundle = two.components[0];
	assert.equal(bundle.acceptance.state, "not-accepted-at-this-identity");
	assert.deepEqual(bundle.acceptance.evidence, []);
	assert.equal(bundle.acceptance.superseded[0].lastAcceptedAt, "2026-09-24T21:15:00Z");
	assert.equal(two.previous.sequence, 1);
	assert.match(
		renderMarkdown(two),
		/runtime-bundle\*\* \(Runtime bundle\): last accepted 2026-09-24T21:15:00Z at an earlier identity/,
	);
});

test("an identity with an unrecorded fact cannot be accepted", () => {
	const root = workspace();
	const set = { ...setBundle(106, fp("a")), identity: { version: 106, sha256: null } };
	const manifest = applyChanges(null, changes([set]), { root, now: NOW });
	assert.equal(manifest.components[0].acceptance.state, "identity-unknown");
	assert.throws(
		() => applyChanges(null, changes([set, accept(["runtime-bundle"])]), { root, now: NOW }),
		/identity not fully recorded \(sha256\)/,
	);
	assert.match(renderMarkdown(manifest), /not recorded: sha256/);
});

test("records must exist, match their bytes, and quote the registry line they cite", () => {
	const root = workspace();
	const missing = { ...setBundle(106, fp("a")), live: { records: [{ path: "nope.json" }] } };
	assert.throws(() => applyChanges(null, changes([missing]), { root, now: NOW }), /record file missing: nope.json/);
	const outside = { ...setBundle(106, fp("a")), live: { records: [{ path: "../etc/passwd" }] } };
	assert.throws(() => applyChanges(null, changes([outside]), { root, now: NOW }), /relative to the workspace root/);
	const wrongLine = {
		...accept(["runtime-bundle"]),
		records: [{ path: "outputs/REGISTRY.md", line: 2, quote: "ACCEPTED" }],
	};
	assert.throws(
		() => applyChanges(null, changes([setBundle(106, fp("a")), wrongLine]), { root, now: NOW }),
		/quote not on outputs\/REGISTRY.md:2/,
	);
	const manifest = applyChanges(null, changes([setBundle(106, fp("a"))]), { root, now: NOW });
	writeFileSync(join(root, "receipt.json"), '{"ok":false}\n');
	assert.match(checkManifest(manifest, { root }).join("\n"), /record receipt.json changed/);
});

test("check catches hand edits", () => {
	const root = workspace();
	const manifest = applyChanges(null, changes([setBundle(106, fp("a")), accept(["runtime-bundle"])]), {
		root,
		now: NOW,
	});
	const edited = structuredClone(manifest);
	edited.components[0].identity.version = 107;
	const problems = checkManifest(edited).join("\n");
	assert.match(problems, /identityDigest is stale/);
	const forged = structuredClone(manifest);
	forged.components[0].acceptance.evidence = [];
	assert.match(checkManifest(forged).join("\n"), /acceptance state does not follow/);
});

test("retire removes a component and keeps its last identity", () => {
	const root = workspace();
	const one = applyChanges(null, changes([setBundle(106, fp("a"))]), { root, now: NOW });
	const two = applyChanges(one, changes([{ op: "retire", id: "runtime-bundle", at: NOW, reason: "replaced" }]), {
		root,
		now: NOW,
		previousSha256: fp("1"),
	});
	assert.deepEqual(two.components, []);
	assert.equal(two.retired[0].identity.version, 106);
});

test("an unchanged identity keeps when it went live; a cut re-reporting it only adds records", () => {
	const root = workspace();
	writeFileSync(join(root, "later.json"), "{}\n");
	const one = applyChanges(null, changes([setBundle(106, fp("a"))]), { root, now: NOW });
	const again = {
		...setBundle(106, fp("a")),
		live: { since: "2026-09-26T10:00:00Z", cut: "v107", records: [{ path: "receipt.json" }, { path: "later.json" }] },
	};
	const two = applyChanges(one, changes([again]), { root, now: NOW, previousSha256: fp("1") });
	const live = two.components[0].live;
	assert.equal(live.since, "2026-09-24T20:59:55.665Z");
	assert.equal(live.cut, "v106");
	assert.deepEqual(
		live.records.map((record) => record.path),
		["receipt.json", "later.json"],
	);
	const fixed = applyChanges(one, changes([{ ...again, replaceLive: true }]), {
		root,
		now: NOW,
		previousSha256: fp("1"),
	});
	assert.equal(fixed.components[0].live.since, "2026-09-26T10:00:00Z");
});

test("evidence from before the identity went live does not count", () => {
	const root = workspace();
	const early = { ...accept(["runtime-bundle"]), at: "2026-09-24T20:00:00Z" };
	assert.throws(
		() => applyChanges(null, changes([setBundle(106, fp("a")), early]), { root, now: NOW }),
		/predates the live identity/,
	);
	const manifest = applyChanges(null, changes([setBundle(106, fp("a")), accept(["runtime-bundle"])]), {
		root,
		now: NOW,
	});
	manifest.components[0].acceptance.evidence[0].at = "2026-09-24T20:00:00Z";
	assert.match(checkManifest(manifest).join("\n"), /predates live since/);
});

test("the web client is recorded only for master's head with a successful Pages deploy", () => {
	const commit = "40b8e9746dd54949c4c0db3a8438c7eec41a4116";
	const checkRuns = {
		check_runs: [
			{
				name: "Cloudflare Pages",
				head_sha: commit,
				status: "completed",
				conclusion: "success",
				completed_at: "2026-09-25T02:24:52Z",
				html_url: "https://github.com/Qorpera/Qorpera_Base/runs/107918389380",
				details_url:
					"https://dash.cloudflare.com/?to=/x/pages/view/qorpera-web/2a4bdc72-8b98-466f-988a-5dff2996ee56",
			},
		],
	};
	const op = webChanges(commit, checkRuns, { status: "identical" }).operations[0];
	assert.deepEqual(op.identity, { commit, pagesDeployment: "2a4bdc72-8b98-466f-988a-5dff2996ee56" });
	assert.equal(op.live.since, "2026-09-25T02:24:52Z");
	// A pull request head gets a preview deploy with the same check name: not on master.
	assert.throws(() => webChanges(commit, checkRuns, { status: "ahead" }), /not master's head/);
	assert.throws(() => webChanges(commit, checkRuns, { status: "behind" }), /not master's head/);
	assert.equal(webChanges(commit, checkRuns, { status: "behind" }, { allowBehind: true }).operations.length, 1);
	const failed = structuredClone(checkRuns);
	failed.check_runs[0].conclusion = "failure";
	assert.throws(() => webChanges(commit, failed, { status: "identical" }), /did not succeed/);
});

test("drift checks the enrolled policy and the policy of the newest machine since going live", () => {
	const root = workspace();
	const manifest = applyChanges(
		null,
		changes([
			setBundle(106, fp("a")),
			{
				op: "set",
				id: "node-01-release",
				title: "Node 1 release",
				scope: "node-01",
				identity: { release: 11, enrollment: { providerId: "native25", policies: { native: fp("c") } } },
				live: { since: "2026-09-25T03:00:00Z", records: [{ path: "receipt.json" }] },
			},
			{
				op: "set",
				id: "node-01-login",
				title: "Node 1 sign-in",
				scope: "node-01",
				identity: { enrollment: { providerId: "native25", policies: { login: fp("d") } } },
				live: { since: "2026-09-25T03:00:00Z", records: [{ path: "receipt.json" }] },
			},
			{ op: "set", id: "web-client", title: "Web", scope: "global", identity: { commit: "40b8e97" }, live: {} },
		]),
		{ root, now: NOW },
	);
	const observed = {
		schema: OBSERVED_SCHEMA,
		activeBundle: { version: 106, sha256: fp("a") },
		lastMigration: { version: "20260924234000" },
		enrolledProviders: [
			{ kind: "native", providerId: "native25", policySha256: fp("c") },
			{ kind: "login", providerId: "native25", policySha256: fp("d") },
			// Enrolled later but re-enrolled as a rollback target: its row is older than the one in use.
			{ kind: "login", providerId: "native25", policySha256: fp("e") },
		],
		providerUse: [
			{ kind: "native", providerId: "native25", policySha256: fp("c"), requestedAt: "2026-09-25T03:10:00Z" },
			{ kind: "login", providerId: "native25", policySha256: fp("e"), requestedAt: "2026-09-25T03:20:00Z" },
		],
		inventoryPolicies: [],
		codingVmPolicies: [],
		officeActivations: [],
		secretBrokerAuthorities: [],
		runsSinceActivation: [
			{ runtimeBundleSha256: fp("a"), runs: 3 },
			{ runtimeBundleSha256: fp("9"), runs: 1 },
		],
	};
	const find = (results, id, field) => results.find((r) => r.id === id && r.field.startsWith(field));
	const results = drift(manifest, observed);
	assert.equal(find(results, "runtime-bundle", "sha256").result, "match");
	assert.equal(find(results, "runtime-bundle", "3 runs").result, "match");
	// Runs whose inputs were recorded before the activation carry the older bundle by design.
	assert.match(find(results, "runtime-bundle", "1 runs").result, /^note/);
	assert.equal(find(results, "node-01-release", "native policy enrolled").result, "match");
	assert.equal(find(results, "node-01-release", "native policy of the newest machine").result, "match");
	assert.equal(find(results, "node-01-login", "login policy enrolled").result, "match");
	assert.equal(find(results, "node-01-login", "login policy of the newest machine").result, "DRIFT");
	assert.equal(find(results, "web-client", "-").result, "not observable from the backend");
	observed.providerUse[0].requestedAt = "2026-09-24T00:00:00Z";
	assert.equal(
		find(drift(manifest, observed), "node-01-release", "native policy in use").result,
		"no machine requested since live",
	);
});

function laneWorkspace() {
	const root = workspace();
	const lane = join(root, "work/cut-v106-a1");
	const put = (path, value) => {
		mkdirSync(join(lane, path, ".."), { recursive: true });
		writeFileSync(join(lane, path), typeof value === "string" ? value : JSON.stringify(value));
	};
	put("sql/receipts/activate-commit-1-result.json", {
		ok: true,
		result: [{ activation: { sha256: fp("a"), version: 106, activated_at: "2026-09-24T20:59:55.665153+00:00" } }],
	});
	put("sql/receipts/apply-20260924232000-commit-1-result.json", { ok: true, result: [{ e: { total: 343 } }] });
	put("sql/generated/packet.json", {
		activation: ["20260924234000", "runtime_bundle_activation_v106"],
		migrations: [["20260924232000", "runtime_answer_card_outside_agent_thread"]],
	});
	const release = (revision, provider) => ({
		revision,
		sourceCommit: "82b34214d",
		files: [
			{ name: "qorpera-lxd-provider.mjs", sha256: provider },
			{ name: "qorpera-runner-orchestrator.mjs", sha256: fp("4") },
		],
		roles: {
			provider: { component: "qorpera-lxd-provider.mjs", env: { A: String(revision) } },
			orchestrator: { component: "qorpera-runner-orchestrator.mjs", env: {} },
		},
	});
	// Release 9 is still staged in the lane; release 11 is newer although "release-9" sorts after it as text.
	put("agent/release-9/release.json", release(9, fp("5")));
	put("agent/release-11/release.json", release(11, fp("6")));
	put("agent/receipts/build-release-11.json", {
		changes: { provider: { against: 10, program: "same" }, orchestrator: { against: 0, program: "same" } },
	});
	const applied = (roles) => ({
		at: "2026-09-24T21:00:09.364966+00:00",
		exitCode: 0,
		stdout: `{"current":10,"roles":{}}\n{"applied":11}\n${JSON.stringify({ current: 11, roles })}\nenabled\n`,
	});
	put("agent/receipts/node01-apply.json", applied({ provider: { release: 11 }, orchestrator: { release: 0 } }));
	put("agent/receipts/node02-apply.json", applied({ provider: { release: 11 } }));
	put("enroll/receipts/node01-enroll-native-result.json", {
		stdout: JSON.stringify({ passed: true, enroll: { providerId: "native25-phql-a1", policySha256: fp("c") } }),
	});
	put("enroll/receipts/node01-enroll-login-result.json", {
		stdout: JSON.stringify({ passed: true, enroll: { providerId: "native25-phql-a1", policySha256: fp("d") } }),
	});
	return { root, lane, put };
}

test("lane reads the newest release by number and splits sign-in machines from agent machines", () => {
	const { root, lane, put } = laneWorkspace();
	const lanes = laneChanges(lane, root, "v106");
	assert.deepEqual(
		lanes.operations.map((op) => op.id),
		["runtime-bundle", "database-migrations", "node-01-release", "node-01-login", "node-02-release"],
	);
	const node1 = lanes.operations.find((op) => op.id === "node-01-release").identity;
	assert.equal(node1.release, 11);
	assert.equal(node1.releaseJsonSha256, sha256(readFileSync(join(lane, "agent/release-11/release.json"))));
	assert.deepEqual(node1.roles, {
		provider: { release: 11, program: fp("6") },
		orchestrator: { release: 0, program: fp("4") },
	});
	assert.deepEqual(node1.enrollment, { providerId: "native25-phql-a1", policies: { native: fp("c") } });
	assert.deepEqual(lanes.operations.find((op) => op.id === "node-01-login").identity, {
		providerProgram: fp("6"),
		enrollment: { providerId: "native25-phql-a1", policies: { login: fp("d") } },
	});
	assert.equal(lanes.operations.find((op) => op.id === "node-02-release").identity.enrollment, undefined);
	// A node that did not end on the lane's newest release is refused, not recorded as that release.
	put("agent/receipts/node02-apply.json", {
		at: "2026-09-24T21:00:04Z",
		exitCode: 0,
		stdout: '{"current":10,"roles":{"provider":{"release":10}}}\n',
	});
	assert.throws(() => laneChanges(lane, root, "v106"), /node is on release 10, the lane's newest release is 11/);
});

test("apply writes current, history and the page; check follows the history chain", () => {
	const { root, lane } = laneWorkspace();
	const dir = join(root, "outputs/deployment-manifest");
	writeFileSync(join(root, "changes.json"), JSON.stringify(laneChanges(lane, root, "v106")));
	writeFileSync(join(root, "accept.json"), JSON.stringify(changes([accept(["runtime-bundle"])], "v106 accepted")));
	const quiet = [console.log, console.error];
	console.log = () => {};
	console.error = () => {};
	try {
		for (const file of ["changes.json", "accept.json"])
			assert.equal(main(["apply", "--dir", dir, "--changes", join(root, file), "--root", root, "--now", NOW]), 0);
		assert.equal(main(["check", "--manifest", join(dir, "current.json"), "--root", root]), 0);
		assert.deepEqual(readdirSync(join(dir, "history")), ["0001-cut-v106.json", "0002-v106-accepted.json"]);
		const current = JSON.parse(readFileSync(join(dir, "current.json"), "utf8"));
		assert.equal(current.previous.sha256, sha256(readFileSync(join(dir, "history/0001-cut-v106.json"))));
		assert.match(readFileSync(join(dir, "CURRENT.md"), "utf8"), /\*\*node-02-release\*\* \(Node 02 release/);
		// A hand edit that keeps digests and states consistent (here: notes) still fails the history check.
		current.components[0].notes = "edited by hand";
		writeFileSync(join(dir, "current.json"), `${JSON.stringify(current, null, "\t")}\n`);
		assert.deepEqual(checkHistory(dir, readFileSync(join(dir, "current.json"))), [
			"current.json differs from the newest history file",
		]);
		assert.equal(main(["check", "--manifest", join(dir, "current.json"), "--root", root]), 1);
	} finally {
		[console.log, console.error] = quiet;
	}
});
