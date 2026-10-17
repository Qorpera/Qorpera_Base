import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { hostedDatabase, MIGRATIONS, migrationNames } from "./test-hosted-db-cluster.mjs";

// Migration 20260930506000 (company machines without a repository disk, F3 6e-1) on a database just before it, with
// company machines the node release before it placed (v1 bindings). Every current v1 placement is retired, as a move
// retires one: a running machine's open command ends lost, the machines are kept (waiting to be placed again with a v2
// binding), and an already retired placement is left as it was. The rollout check (the PR's "Rollout": retired v1
// placements whose instance the v1 executor has not deleted yet) finds them until that executor's delete proof
// removes them. A second apply is refused.

const databaseName = "company_machine_v2_retire";
const migrationFile = "20260930506000_company_machine_repository_retired.sql";
const id = (n) => `50600000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ROLLOUT_CHECK = `select count(*) from public.qorpera_company_machine_placements p
	where p.binding ->> 'schema' = 'qorpera.lxd-company-machine/v1' and p.removed_at is null;`;

async function main() {
	if (!migrationNames().includes(migrationFile)) throw new Error(`${migrationFile} is not in the migration chain`);
	const migration = readFileSync(join(MIGRATIONS, migrationFile), "utf8");
	const database = await hostedDatabase(databaseName, { before: migrationFile });
	try {
		const run = (sql) => database.cluster.psql(databaseName, sql, ["-qAt"]).trim();
		const binding = (machine, placement) =>
			`jsonb_build_object('schema','qorpera.lxd-company-machine/v1','machineId','${machine}','placementId','${placement}',
				'repositoryWorkerId',null)`;
		// Three machines of one company: build (running, a command open on it), docs (asleep), repo (tied to a coding
		// session's repository, never placed). build also has a placement it moved away from.
		run(`begin; set local session_replication_role = replica;
			insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id,
				started_by_run_id, started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime,
				repository_worker_id, desired_state)
			values ('${id(1)}', '${id(90)}', '${id(91)}', 'build', 'Build it', '${id(92)}', '${id(93)}', '${id(11)}', '${id(94)}',
					2, 4294967296, 42949672960, 'standard', 'task', null, 'running'),
				('${id(2)}', '${id(90)}', '${id(91)}', 'docs', 'Write it', '${id(92)}', '${id(93)}', '${id(12)}', '${id(94)}',
					1, 1073741824, 10737418240, 'standard', 'task', null, 'stopped'),
				('${id(3)}', '${id(90)}', '${id(91)}', 'repo', 'Test the repository', '${id(92)}', '${id(93)}', '${id(13)}', '${id(94)}',
					1, 1073741824, 10737418240, 'standard', 'task', '${id(95)}', 'running');
			insert into public.qorpera_company_machine_placements(id, machine_id, profile_id, owner, machine_id_sha256, binding,
				instance_sha256, retired_at, running_at, boot_id)
			values ('${id(20)}', '${id(1)}', '${id(90)}', 'mx-a', repeat('c', 64), ${binding(id(1), id(20))}, repeat('d', 64),
					'2026-10-01T00:00:00Z', null, null),
				('${id(21)}', '${id(1)}', '${id(90)}', 'mx-a', repeat('c', 64), ${binding(id(1), id(21))}, repeat('d', 64),
					null, clock_timestamp(), '${id(30)}'),
				('${id(22)}', '${id(2)}', '${id(90)}', 'mx-a', repeat('c', 64), ${binding(id(2), id(22))}, repeat('d', 64),
					null, null, null);
			insert into public.qorpera_company_machine_commands(id, machine_id, run_id, staff_agent_id, placement_id, command_head,
				notify, requested_by_user_id)
			values ('${id(40)}', '${id(1)}', '${id(93)}', '${id(92)}', '${id(21)}', 'npm test', false, '${id(94)}');
			commit;`);
		assert.equal(run(ROLLOUT_CHECK), "3", "Before: every v1 placement not yet removed");
		run(`begin;\n${migration}\ncommit;\n`);
		assert.equal(
			run(`select string_agg(id::text || ':' || (retired_at is not null)::text || ':'
					|| (retired_at = '2026-10-01T00:00:00Z')::text, ',' order by id)
				from public.qorpera_company_machine_placements;`),
			`${id(20)}:true:true,${id(21)}:true:false,${id(22)}:true:false`,
			"Every v1 placement is retired; an already retired one is left as it was",
		);
		assert.equal(
			run(`select state || ':' || end_reason || ':' || (ended_at is not null)::text from public.qorpera_company_machine_commands
				where id = '${id(40)}';`),
			"lost:lost:true",
			"The running machine's open command ends lost",
		);
		assert.equal(
			run(`select string_agg(name || ':' || desired_state, ',' order by name) from public.qorpera_company_machines
				where removed_at is null;`),
			"build:running,docs:stopped,repo:running",
			"The machines are kept, wanting what they wanted",
		);
		assert.equal(
			run(`select count(*) from pg_catalog.pg_attribute where attrelid = 'public.qorpera_company_machines'::regclass
				and attname = 'repository_worker_id' and not attisdropped;`),
			"0",
			"No repository column",
		);
		// The rollout check: the v1 executor still has these to delete; its delete proof removes each one.
		assert.equal(run(ROLLOUT_CHECK), "3", "The retired v1 placements wait for the v1 executor");
		run(`update public.qorpera_company_machine_placements set removing_at = clock_timestamp(), removed_at = clock_timestamp()
			where retired_at is not null;`);
		assert.equal(run(ROLLOUT_CHECK), "0", "Once the v1 executor deleted them, the node may roll");
		assert.throws(() => run(`begin;\n${migration}\ncommit;\n`), /already applied/, "A second apply is refused");
		process.stdout.write(
			"Company machine v2 retirement checks passed (3 v1 placements retired or left retired, a command ended lost, 3 machines kept, the rollout check, a second apply refused)\n",
		);
	} finally {
		database.close();
	}
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	await main();
}
