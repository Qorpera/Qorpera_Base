import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { hostedDatabase } from "./test-hosted-db-cluster.mjs";

// Company creation's worker (P14b) against a real database: every migration, a folder-v2 company opened and started
// as the operator's path does (P14a's open and seed), the object gateway's worker and file store as built, and its
// RPCs answered by the database as the service role. The worker's seeded tree is the one the creation commit takes:
// every unit saves, the Co-Founder and its kickoff are written, the company is ready, and every structured file reads
// back through the shared parser.

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const databaseName = "qorpera_company_creation";
const owner = "87700000-0000-4000-8000-000000000001";
const clientCreationId = "87700000-0000-4000-8000-000000000100";

const literal = (value) =>
	value === null || value === undefined
		? "null"
		: typeof value === "number"
			? String(value)
			: `'${(typeof value === "object" ? JSON.stringify(value) : String(value)).replaceAll("'", "''")}'${typeof value === "object" ? "::jsonb" : ""}`;

async function main() {
	const database = await hostedDatabase(databaseName);
	let scratch;
	try {
		scratch = await mkdtemp(join(tmpdir(), "qorpera-company-creation-"));
		const query = (sql) => database.cluster.psql(databaseName, sql, ["-qAt"]).trim();
		const rpc = (method, args) => {
			const parameters = Object.entries(args).map(([name, value]) => {
				assert(/^p_[a-z][a-z0-9_]*$/.test(name));
				return `${name}=>${literal(value)}`;
			});
			const out = query(`set request.jwt.claims = '{"role":"service_role"}';
				select to_jsonb(public.${method}(${parameters.join(",")}));`);
			return out ? JSON.parse(out) : null;
		};

		// The company, opened and started as the operator's path does (no login: the kickoff stays pending).
		query(`insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data)
			values ('${owner}', 'founder@nordlys.test', clock_timestamp(), '{"display_name":"Ida"}')`);
		const opened = JSON.parse(
			query(`select public.qorpera_folder_company_open('${owner}', '${clientCreationId}', 'Nordlys Bryggeri')::text`),
		);
		const profileId = opened.profile_id;
		const environmentId = opened.environment_id;
		query(`select public.qorpera_folder_company_seed('${profileId}', ${literal({
			schema: "qorpera.company-seed-input/v1",
			companyName: "Nordlys Bryggeri",
			vision: "Small-batch beer for the cafés of Aarhus.",
			kickoffRequestedBy: owner,
			founders: [{ userId: owner, displayName: "Ida", role: "Brewing and the cafés." }],
		})})`);
		assert.equal(query(`select state from public.qorpera_folder_company_creations where profile_id = '${profileId}'`), "queued");

		const modulePath = join(scratch, "creator.mjs");
		await build({
			absWorkingDir: repositoryRoot,
			stdin: {
				resolveDir: repositoryRoot,
				contents: [
					'export {CompanyFolderCreator} from "./packages/object-gateway/src/company-folder-creation.ts";',
					'export {FileSystemObjectStore} from "./packages/object-gateway/src/object-store.ts";',
					'export {parseCompanyStateFile, companyStateSeedTree} from "./packages/cloud-client/src/company-state-files.ts";',
				].join("\n"),
			},
			platform: "node",
			format: "esm",
			target: "node22",
			bundle: true,
			outfile: modulePath,
			logLevel: "silent",
		});
		const code = await import(pathToFileURL(modulePath).href);
		const store = new code.FileSystemObjectStore(join(scratch, "objects"));
		const replication = {
			async uploadWithAuthority(profile, hash, bytes, callbacks) {
				await callbacks.authorize();
				const result = await store.put(profile, hash, bytes);
				await callbacks.confirm();
				return result;
			},
		};
		const creator = new code.CompanyFolderCreator({
			workerId: "87700000-0000-4000-8000-00000000000a",
			authority: { publisher: async (method, args) => rpc(method, args) },
			store,
			replication,
		});

		const creation = () => JSON.parse(query(`select to_jsonb(c) from public.qorpera_folder_company_creations c
			where c.profile_id = '${profileId}'`));
		const due = () => query(`update public.qorpera_folder_company_creations set not_before = null where profile_id = '${profileId}'`);
		const nothingMade = () =>
			assert.equal(query(`select count(*) from public.qorpera_folder_entries where environment_id = '${environmentId}'`), "0");

		// 0a. A paused company: the create refuses (55000), the worker releases the claim with a back-off, nothing is made.
		query(`insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id, reason)
			values ('${profileId}', '${owner}', 'Creation script pause')`);
		assert.equal(await creator.createDue(5), 1);
		assert.equal(creation().state, "queued");
		assert(creation().not_before, "a paused creation backs off");
		nothingMade();
		query(`delete from public.qorpera_company_execution_pauses where profile_id = '${profileId}'`);
		due();

		// 0b. A crash between staging and the create: the files are staged, the create never arrives. The claim is released
		// and, once due again, the next attempt stages the same files again and makes the company (below).
		let crashed = false;
		const crashing = new code.CompanyFolderCreator({
			workerId: "87700000-0000-4000-8000-00000000000b",
			authority: {
				publisher: async (method, args) => {
					if (method === "qorpera_folder_company_create" && !crashed) {
						crashed = true;
						throw new Error("the gateway stopped");
					}
					return rpc(method, args);
				},
			},
			store,
			replication,
		});
		assert.equal(await crashing.createDue(5), 1);
		assert(crashed);
		assert.equal(creation().state, "queued");
		assert.equal(creation().last_problem, "writer_failed");
		assert(Number(query(`select count(*) from public.qorpera_folder_upload_intents where environment_id = '${environmentId}'
			and state = 'sealed'`)) >= 5, "the files were staged before the crash");
		nothingMade();
		due();

		// 1. One creation is due, and the worker makes the company.
		assert.equal(await creator.createDue(5), 1);
		const made = creation();
		assert.equal(made.attempts, 3, "the third attempt made it");
		assert.equal(made.state, "completed", JSON.stringify(made));
		assert.equal(made.input, null);
		assert.equal(query(`select public.qorpera_folder_company_ready('${profileId}')`), "t");
		assert.equal(await creator.createDue(5), 0);

		// 2. Every seeded path is in the folder; every structured file reads back through the parser as written.
		const entries = JSON.parse(query(`select jsonb_object_agg(e.key_text, jsonb_build_object('kind', e.kind,
				'sha', e.file_sha256, 'bytes', e.bytes))
			from public.qorpera_folder_entries e where e.environment_id = '${environmentId}' and e.kind <> 'claim'`));
		for (const path of ["vision", "agents", "agents/co-founder", "agents/co-founder/memory", "agents/co-founder/skills",
			"agents/co-founder/routines", "agents/co-founder/todos", "agents/groups", "connections", "human-tasks", "contacts",
			"skills", "skills/human-task", "rules"])
			assert.equal(entries[path]?.kind, "folder", `${path} is a folder`);
		for (const path of ["vision/vision.md", "agents/sections.md", "agents/co-founder/agent.md",
			"agents/co-founder/todos/start-with-the-founders.md", "skills/human-task/skill.md"])
			assert.equal(entries[path]?.kind, "file", `${path} is a file`);
		const text = async (key) =>
			new TextDecoder().decode(await store.get(profileId, entries[key].sha, Number(entries[key].bytes)));
		// Every file of the seed tree (built as the worker builds it, from the creation's input and ids) is stored as written,
		// and every structured one reads back through the parser.
		const tree = code.companyStateSeedTree({
			companyName: "Nordlys Bryggeri",
			cofounderId: made.cofounder_id,
			vision: "Small-batch beer for the cafés of Aarhus.",
			founders: [{ userId: owner, displayName: "Ida", role: "Brewing and the cafés." }],
			firstTodo: { id: made.first_todo_id, requestedBy: owner },
		});
		for (const entry of tree) {
			const key = entry.path.toLowerCase();
			assert.equal(entries[key]?.kind, entry.kind, `${entry.path} is a ${entry.kind}`);
			if (entry.kind !== "file") continue;
			assert.equal(await text(key), entry.text, `${entry.path} holds the seed tree's text`);
			const parsed = code.parseCompanyStateFile(entry.path, entry.text);
			assert(parsed === null || parsed.ok, `${entry.path} parses`);
		}
		const vision = code.parseCompanyStateFile("vision/vision.md", await text("vision/vision.md"));
		assert(vision?.ok && vision.file.name === "Nordlys Bryggeri", "the vision names the company");
		const agent = code.parseCompanyStateFile("agents/co-founder/agent.md", await text("agents/co-founder/agent.md"));
		assert(agent?.ok && agent.file.id === made.cofounder_id && agent.file.agentKind === "co-founder");
		const todo = code.parseCompanyStateFile("agents/co-founder/todos/start-with-the-founders.md",
			await text("agents/co-founder/todos/start-with-the-founders.md"));
		assert(todo?.ok && todo.file.id === made.first_todo_id && todo.file.requestedBy === owner);

		// 3. The Co-Founder, its thread and its silent first run; no turn request (no login) and no wake.
		assert.equal(query(`select count(*) from public.qorpera_profile_staff where profile_id = '${profileId}'
			and staff_agent_id = '${made.cofounder_id}' and template_id = 'co-founder'`), "1");
		const kickoff = JSON.parse(query(`select to_jsonb(i) from public.qorpera_agent_first_runs f
			join public.qorpera_session_inputs i on i.id = f.input_id where f.profile_id = '${profileId}'`));
		assert.equal(kickoff.kind, "kickoff");
		assert.equal(kickoff.author_user_id, owner);
		assert.deepEqual(kickoff.body, {
			schema: "qorpera.company-first-run/v1",
			assignment: {
				kind: "company_founding",
				companyId: profileId,
				creationId: made.id,
				cofounderStaffAgentId: made.cofounder_id,
				firstTodo: "agents/co-founder/todos/start-with-the-founders.md",
			},
		});
		assert.equal(query(`select count(*) from public.qorpera_session_turn_requests where profile_id = '${profileId}'`), "0");
		assert.equal(query(`select count(*) from public.qorpera_wake_occurrences where profile_id = '${profileId}'`), "0");
		process.stdout.write("Company creation worker checks passed (seeded tree saved, Co-Founder, kickoff, ready)\n");
	} finally {
		if (scratch) await rm(scratch, { recursive: true, force: true });
		database.close();
	}
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	await main();
}
