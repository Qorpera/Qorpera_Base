import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { assertOneTransaction, DRY_RUN_ONLY, migrationBody, newPendingInputs, rollPackets, statements, writeRoll } from "./runtime-roll.mjs";

const from = { version: 164, sha: "a".repeat(64) };
const to = { version: 165, sha: "b".repeat(64) };
const nodeA = "11111111-1111-4111-8111-111111111111";
const nodeB = "22222222-2222-4222-8222-222222222222";
const activation = {
	name: "20260928409990_runtime_bundle_activation_v165.sql",
	text: `do $$ begin
	perform 1 from public.qorpera_active_runtime_bundle where singleton for update;
	if not exists (select 1 from public.qorpera_runtime_bundles b where b.version=164 and b.sha256='${from.sha}') then raise exception 'x'; end if;
insert into public.qorpera_runtime_bundles(bundle_key,version,manifest,sha256)
values ('qorpera.cloud-runtime',165,'{"a": "b; c"}','${to.sha}');
end $$;
`,
};
const migration = { name: "20260928400000_probe.sql", text: "begin;\ncreate table public.probe(id integer); -- begin; commit;\ncommit;\n" };
const options = (change = {}) => ({ activation, migrations: [migration], from, to, nodeA, nodeB, reason: "roll v165", ...change });

test("statements ignore semicolons and keywords inside literals, comments and dollar bodies", () => {
	const parts = statements("select 'a; begin'; /* commit; */ select $x$ rollback; $x$; select e'it''s\\'; ok';");
	assert.equal(parts.length, 3);
	assert.throws(() => statements("select 'open"), /Unterminated SQL literal/);
	assert.throws(() => statements("select $q$ open"), /Unterminated SQL dollar body/);
	assert.throws(() => statements("select 1"), /Unterminated top-level/);
});

test("a migration body loses one outer begin/commit and refuses other transaction control", () => {
	// As the coordinator's runner: the text between the outer begin and commit statements (a trailing comment goes with commit).
	assert.equal(migrationBody(migration.text).trim(), "create table public.probe(id integer);");
	assert.equal(migrationBody("create table t(i int);\n"), "create table t(i int);\n");
	assert.throws(() => migrationBody("begin;\nsavepoint s;\ncommit;\n"), /Unsafe transaction control/);
	assert.throws(() => migrationBody("create table t(i int);\ncommit;\n"), /Unsafe transaction control/);
	assert.throws(() => migrationBody("create index concurrently i on t(i);\n"), /cannot run in a transaction/);
	assert.throws(() => migrationBody("create unique index concurrently i on t(i);\n"), /cannot run in a transaction/);
});

test("every packet is exactly one outer transaction, in the procedure's order", () => {
	const packets = rollPackets(options());
	assert.deepEqual(Object.keys(packets), [
		"00-check.sql",
		`10-migration-${migration.name}`,
		"20-declare-b.sql",
		"30-runs-off-a.sql",
		"31-drain-a.sql",
		"40-switch.sql",
		"50-check-n.sql",
		"60-runs-off-b.sql",
		"61-drain-b.sql",
		"70-return-b.sql",
		"80-finish.sql",
		"90-pause-now.sql",
		"91-reverse.sql",
		"92-resume.sql",
	]);
	for (const [name, text] of Object.entries(packets)) assertOneTransaction(name, text);
	assert.throws(() => assertOneTransaction("x", "begin;\nselect 1;\ncommit;\ncommit;\n"), /exactly one outer transaction/);
	for (const name of DRY_RUN_ONLY) assert.ok(packets[name], name);
});

test("the switch runs the activation verbatim between its gates, then declares and returns node A", () => {
	const switchText = rollPackets(options())["40-switch.sql"];
	const at = (needle) => {
		const index = switchText.indexOf(needle);
		assert.ok(index >= 0, needle);
		return index;
	};
	const steps = [
		at("Node B is not declared for the running bundle"),
		at("Node A must have runs off"),
		at(activation.text),
		at("insert into supabase_migrations.schema_migrations"),
		at(`qorpera_declare_runtime_node_bundle('${nodeA}'::uuid, '${to.sha}')`),
		at("An orchestrator is undeclared"),
		at(`qorpera_set_runtime_node_runs('${nodeA}'::uuid, true`),
	];
	assert.deepEqual([...steps].sort((a, b) => a - b), steps);
	assert.ok(!switchText.includes("qorpera_set_company_execution_pause"), "the switch pauses nobody");
	assert.ok(!switchText.includes("Runtime is not quiet"), "the switch needs no quiet runtime");
});

test("the preflight refuses a node A that is a node-disk login's home, and checks every guard marker", () => {
	const check = rollPackets(options())["00-check.sql"];
	assert.ok(check.includes("Node A is the home of a node-disk login"));
	assert.ok(check.includes(`'${nodeA}'::uuid = any(public.qorpera_runtime_login_identity_homes(c.compute_identity_id))`));
	for (const marker of ["node.enabled and node.runs_enabled", "or n.runs_enabled)", "p_provider_kind in (''native'',''login'')))", "qorpera_runtime_adapter_takes_bundle", "v_run.runtime_bundle_sha256);"])
		assert.ok(check.includes(marker), marker);
});

test("--empty full switches a node off fully and returns it with both switches", () => {
	const runsOnly = rollPackets(options());
	assert.ok(!runsOnly["30-runs-off-a.sql"].includes("qorpera_set_runtime_node_serving"));
	assert.ok(runsOnly["70-return-b.sql"].includes("'readyForNodeRelease'"));
	const full = rollPackets(options({ empty: "full" }));
	assert.ok(full["30-runs-off-a.sql"].includes(`qorpera_set_runtime_node_serving('${nodeA}'::uuid, false`));
	assert.ok(full["60-runs-off-b.sql"].includes(`qorpera_set_runtime_node_serving('${nodeB}'::uuid, false`));
	assert.ok(full["70-return-b.sql"].includes("'readyForUpdate'"));
	for (const [name, node] of [["40-switch.sql", nodeA], ["70-return-b.sql", nodeB]])
		for (const packets of [runsOnly, full]) {
			assert.ok(packets[name].includes(`qorpera_set_runtime_node_serving('${node}'::uuid, true`), name);
			assert.ok(packets[name].includes(`qorpera_set_runtime_node_runs('${node}'::uuid, true`), name);
		}
	assert.throws(() => rollPackets(options({ empty: "half" })), /runs or full/);
});

test("each release migration is gated on N and recorded with its own text", () => {
	const text = rollPackets(options())[`10-migration-${migration.name}`];
	assert.ok(text.includes("Runtime 164 is not the active bundle"));
	assert.ok(text.includes("20260928400000_probe.sql is already recorded"));
	assert.ok(text.includes("create table public.probe(id integer);"));
	assert.match(text, /values \('20260928400000','probe',array\[\$roll_[0-9a-f]{12}\$/);
	assert.ok(!text.includes("begin;\ncreate table"), "the migration's own begin is removed");
});

test("bad inputs are refused", () => {
	assert.throws(() => rollPackets(options({ nodeB: nodeA })), /Two different node ids/);
	assert.throws(() => rollPackets(options({ to: { version: 166, sha: to.sha } })), /next version/);
	assert.throws(() => rollPackets(options({ to: { version: 165, sha: from.sha } })), /Two different bundle digests/);
	assert.throws(() => rollPackets(options({ reason: "two\nlines" })), /one-line reason/);
	assert.throws(
		() => rollPackets(options({ activation: { ...activation, text: activation.text.replace("b.version=164", "b.version=163") } })),
		/does not move 164 to 165/,
	);
	assert.throws(
		() => rollPackets(options({ activation: { ...activation, text: `${activation.text}update public.qorpera_execution_runs set x = 1;` } })),
		/historical provenance/,
	);
	assert.throws(() => rollPackets(options({ migrations: [{ name: "20260928500000_late.sql", text: "select 1;" }] })), /sorts before the activation/);
	assert.throws(
		() => rollPackets(options({ migrations: [{ name: "20260928400000_runtime_bundle_activation_v1.sql", text: "select 1;" }] })),
		/Only one activation/,
	);
});

test("the packet directory carries every file's digest, the order and the dry-run-only files", () => {
	const dir = mkdtempSync(join(tmpdir(), "roll-"));
	try {
		const out = join(dir, "packets");
		const manifest = writeRoll(out, options());
		const written = JSON.parse(readFileSync(join(out, "packet.json"), "utf8"));
		assert.deepEqual(written, manifest);
		for (const [name, digest] of Object.entries(written.files))
			assert.equal(createHash("sha256").update(readFileSync(join(out, name))).digest("hex"), digest, name);
		assert.deepEqual(written.dryRunOnly, DRY_RUN_ONLY);
		assert.throws(() => writeRoll(out, options()), /written once/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("only inputs that became pending after the check are new N work", () => {
	assert.deepEqual(newPendingInputs([{ id: "a" }, { id: "b" }], [{ id: "b" }, { id: "c" }]), [{ id: "c" }]);
});
