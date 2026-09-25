import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	applyChanges,
	CHANGES_SCHEMA,
	canonicalJson,
	checkManifest,
	drift,
	identityDigest,
	laneChanges,
	main,
	OBSERVED_SCHEMA,
	renderMarkdown,
	sha256,
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

test("drift compares what the backend reports and says what it cannot see", () => {
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
				identity: {
					release: 11,
					enrollment: { providerId: "native25", policies: { native: fp("c"), login: fp("d") } },
				},
				live: { since: NOW, records: [{ path: "receipt.json" }] },
			},
			{ op: "set", id: "web-client", title: "Web", scope: "global", identity: { commit: "40b8e97" }, live: {} },
		]),
		{ root, now: NOW },
	);
	const observed = {
		schema: OBSERVED_SCHEMA,
		activeBundle: { version: 106, sha256: fp("a") },
		lastMigration: { version: "20260924234000" },
		nodeProviders: [
			{ kind: "native", providerId: "native25", policySha256: fp("c") },
			{ kind: "login", providerId: "native25", policySha256: fp("e") },
		],
		inventoryPolicies: [],
		codingVmPolicies: [],
		officeActivations: [],
		secretBrokerAuthorities: [],
		runsSinceActivation: [{ runtimeBundleSha256: fp("a"), runs: 3 }],
	};
	const results = drift(manifest, observed);
	const find = (id, field) => results.find((r) => r.id === id && r.field.startsWith(field));
	assert.equal(find("runtime-bundle", "sha256").result, "match");
	assert.equal(find("runtime-bundle", "runs since").result, "match");
	assert.equal(find("node-01-release", "enrolled native").result, "match");
	assert.equal(find("node-01-release", "enrolled login").result, "DRIFT");
	assert.equal(find("web-client", "-").result, "not observable from the backend");
});

test("lane reads the cut receipts and apply writes current, history and the page", () => {
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
	put("agent/release-11/release.json", {
		revision: 11,
		sourceCommit: "82b34214d",
		files: [
			{ name: "qorpera-lxd-provider.mjs", sha256: fp("6") },
			{ name: "qorpera-runner-orchestrator.mjs", sha256: fp("4") },
		],
		roles: {
			provider: { component: "qorpera-lxd-provider.mjs", env: { A: "1" } },
			orchestrator: { component: "qorpera-runner-orchestrator.mjs", env: {} },
		},
	});
	put("agent/receipts/build-release-11.json", {
		changes: { provider: { against: 10, program: "same" }, orchestrator: { against: 0, program: "same" } },
	});
	const applied = (roles) => ({
		at: "2026-09-24T21:00:09.364966+00:00",
		exitCode: 0,
		stdout: `{"applied":11}\n${JSON.stringify({ current: 11, roles })}\nenabled\n`,
	});
	put("agent/receipts/node01-apply.json", applied({ provider: { release: 11 }, orchestrator: { release: 0 } }));
	put("agent/receipts/node02-apply.json", applied({ provider: { release: 11 } }));
	put("enroll/receipts/node01-enroll-native-result.json", {
		stdout: JSON.stringify({ passed: true, enroll: { providerId: "native25-phql-a1", policySha256: fp("c") } }),
	});
	const lanes = laneChanges(lane, root, "v106");
	const ids = lanes.operations.map((op) => op.id);
	assert.deepEqual(ids, ["runtime-bundle", "database-migrations", "node-01-release", "node-02-release"]);
	const node1 = lanes.operations.find((op) => op.id === "node-01-release").identity;
	assert.deepEqual(node1.roles, {
		provider: { release: 11, program: fp("6") },
		orchestrator: { release: 0, program: fp("4") },
	});
	assert.deepEqual(node1.enrollment, { providerId: "native25-phql-a1", policies: { native: fp("c") } });
	assert.equal(lanes.operations.find((op) => op.id === "node-02-release").identity.enrollment, undefined);

	const dir = join(root, "outputs/deployment-manifest");
	writeFileSync(join(root, "changes.json"), JSON.stringify(lanes));
	const quiet = console.log;
	console.log = () => {};
	try {
		assert.equal(
			main(["apply", "--dir", dir, "--changes", join(root, "changes.json"), "--root", root, "--now", NOW]),
			0,
		);
		writeFileSync(join(root, "accept.json"), JSON.stringify(changes([accept(["runtime-bundle"])], "v106 accepted")));
		assert.equal(
			main(["apply", "--dir", dir, "--changes", join(root, "accept.json"), "--root", root, "--now", NOW]),
			0,
		);
		assert.equal(main(["check", "--manifest", join(dir, "current.json"), "--root", root]), 0);
	} finally {
		console.log = quiet;
	}
	assert.deepEqual(readdirSync(join(dir, "history")), ["0001-cut-v106.json", "0002-v106-accepted.json"]);
	const current = JSON.parse(readFileSync(join(dir, "current.json"), "utf8"));
	assert.equal(current.previous.sha256, sha256(readFileSync(join(dir, "history/0001-cut-v106.json"))));
	assert.match(readFileSync(join(dir, "CURRENT.md"), "utf8"), /\*\*node-02-release\*\* \(Node 02 release/);
});
