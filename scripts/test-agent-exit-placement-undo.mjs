import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hostedDatabase, MIGRATIONS, migrationNames } from "./test-hosted-db-cluster.mjs";

// The undo of migration 20260930052100 (deploy/agent-exit/undo-20260930052100.sql, ROLLOUT.md step 5) on a database
// just before it: after the migration and the undo, the four placement functions' text, grants and owner are
// exactly what they were. A second undo is refused and changes nothing, and the migration applies again, to the same
// text as the first time.

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const databaseName = "agent_exit_undo";
const placement = "20260930052100_runtime_node_agent_exit_placement.sql";
const undoFile = "deploy/agent-exit/undo-20260930052100.sql";
const FUNCTIONS = [
	"public.qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)",
	"public.qorpera_company_machine_candidates(bigint,bigint,bigint,text,uuid)",
	"public.qorpera_coding_executor_pick(uuid)",
	"public.qorpera_runtime_node_placement_candidates(text)",
];

async function main() {
	if (!migrationNames().includes(placement)) throw new Error(`${placement} is not in the migration chain`);
	const migration = readFileSync(join(MIGRATIONS, placement), "utf8");
	const undo = readFileSync(join(repositoryRoot, undoFile), "utf8");
	const database = await hostedDatabase(databaseName, { before: placement });
	try {
		const run = (sql) => database.cluster.psql(databaseName, sql, ["-qAt"]);
		// As ROLLOUT.md runs it: psql -1, one transaction.
		const runUndo = () => run(`begin;\n${undo}\ncommit;\n`);
		// Each function's text, grants and owner.
		const definitions = () =>
			JSON.parse(
				run(`select jsonb_object_agg(f, jsonb_build_object('text', pg_get_functiondef(p.oid), 'acl', p.proacl::text,
						'owner', p.proowner::regrole::text))
					from unnest(array[${FUNCTIONS.map((name) => `'${name}'`).join(",")}]) f join pg_proc p on p.oid = f::regprocedure;`),
			);
		const before = definitions();
		run(migration);
		const patched = definitions();
		for (const name of FUNCTIONS) {
			assert.notEqual(patched[name].text, before[name].text, `The migration patches ${name}`);
			assert.match(patched[name].text, /qorpera_runtime_node_agent_exit_ready/, `${name} asks for the node's exit`);
			assert.equal(patched[name].acl, before[name].acl, `${name} keeps its grants`);
		}
		runUndo();
		assert.deepEqual(definitions(), before, "The undo restores the four functions' text exactly, with their grants and owner");
		assert.throws(runUndo, /not present exactly once/, "A second undo is refused");
		assert.deepEqual(definitions(), before, "A refused undo changes nothing");
		run(migration);
		assert.deepEqual(definitions(), patched, "The migration applies again after the undo, to the same text");
		process.stdout.write(
			`Agent exit placement undo checks passed (${FUNCTIONS.length} functions restored exactly, a second undo refused, the migration applied again)\n`,
		);
	} finally {
		database.close();
	}
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	await main();
}
