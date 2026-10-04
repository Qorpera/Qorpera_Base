import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { hostedDatabase } from "./test-hosted-db-cluster.mjs";

// The folder core's acceptance (deploy/first-node/RUNTIME-COMPANY-FOLDER-CORE.md, "Core acceptance (C5)"): one line
// per C5 item, PASS, FAIL or NOT RUN with the reason. Exits 1 when any line fails.
//
// * With no arguments (the hosted-db step): a migrated hosted database, a folder-v2 company founded the real way (the
//   creation worker as built, the founder's own model login), and every item the database and the node's folder
//   service can prove, written through change sets as the member route writes them.
// * With `--company <profileId>`: an existing company through the database URL in QORPERA_ACCEPTANCE_DATABASE_URL
//   (psql). Read-only checks only; with `--write` it also writes under `acceptance/<stamp>/` (folders and copies of an
//   existing file, so no bytes are staged) and deletes that folder again. The folder service's search reads bytes from
//   QORPERA_ACCEPTANCE_OBJECT_ROOT (the storage server's object share), when set. Nothing here prints the URL.

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const databaseName = "qorpera_folder_acceptance";
const SERVICE = { role: "service_role" };

/** A SQL literal for one value. */
const literal = (value) =>
	value === null || value === undefined
		? "null"
		: typeof value === "number" || typeof value === "boolean"
			? String(value)
			: `'${(typeof value === "object" ? JSON.stringify(value) : String(value)).replaceAll("'", "''")}'${typeof value === "object" ? "::jsonb" : ""}`;

/** One database, through psql. `claims` set the JWT the functions read (auth.role(), auth.uid()) for that call. */
class Database {
	constructor(run, spawnSession) {
		this.run = run;
		this.spawnSession = spawnSession;
	}

	query(sql) {
		return this.run(sql).trim();
	}

	json(sql) {
		const out = this.query(sql);
		return out ? JSON.parse(out) : null;
	}

	/** `select to_jsonb(public.<method>(p_a => …))` with the given claims, in one transaction. */
	rpc(method, args, claims = SERVICE) {
		const parameters = Object.entries(args).map(([name, value]) => {
			assert(/^p_[a-z][a-z0-9_]*$/.test(name));
			return `${name}=>${literal(value)}`;
		});
		return this.json(`begin;
			select set_config('request.jwt.claims', ${literal(JSON.stringify(claims))}, true) \\g /dev/null
			select to_jsonb(public.${method}(${parameters.join(",")}));
			commit;`);
	}

	/** Several `rpc` calls at once, each in its own session; resolves with their answers in order. */
	async concurrently(calls) {
		const sessions = calls.map(({ method, args, claims = SERVICE }) => {
			const parameters = Object.entries(args).map(([name, value]) => `${name}=>${literal(value)}`);
			const child = this.spawnSession();
			let out = "";
			let err = "";
			child.stdout.on("data", (d) => {
				out += d;
			});
			child.stderr.on("data", (d) => {
				err += d;
			});
			child.stdin.end(`begin;
				select set_config('request.jwt.claims', ${literal(JSON.stringify(claims))}, true) \\g /dev/null
				select to_jsonb(public.${method}(${parameters.join(",")}));
				commit;\n`);
			return new Promise((done, fail) =>
				child.on("close", (code) => (code === 0 ? done(JSON.parse(out.trim())) : fail(new Error(err.trim())))),
			);
		});
		return Promise.all(sessions);
	}
}

/** The code the checks drive, as built: the creation worker, the member route's staging and structured entries, and
 * the node folder service's tree, object reads and search. */
async function bundle(scratch) {
	const modulePath = join(scratch, "acceptance.mjs");
	await build({
		absWorkingDir: repositoryRoot,
		stdin: {
			resolveDir: repositoryRoot,
			contents: [
				'export {CompanyFolderCreator} from "./packages/object-gateway/src/company-folder-creation.ts";',
				'export {FileSystemObjectStore} from "./packages/object-gateway/src/object-store.ts";',
				'export {PlatformFolderWriter} from "./packages/object-gateway/src/platform-folder-writer.ts";',
				'export {followUpMemberCommit, memberFolderStructured} from "./packages/object-gateway/src/member-folder-commits.ts";',
				'export {NasObjects} from "./packages/object-gateway/src/folder-service/objects.ts";',
				'export {ViewTree} from "./packages/object-gateway/src/folder-service/view-tree.ts";',
				'export {searchView} from "./packages/object-gateway/src/folder-service/search.ts";',
				'export {parseListPage, parseFeedPage} from "./packages/object-gateway/src/folder-service/core.ts";',
				'export {companyStateSeedTree} from "./packages/cloud-client/src/company-state-files.ts";',
			].join("\n"),
		},
		platform: "node",
		format: "esm",
		target: "node22",
		bundle: true,
		outfile: modulePath,
		logLevel: "silent",
	});
	return import(pathToFileURL(modulePath).href);
}

/** The folder service's view of the core, answered by the database as the service role. */
function sqlFolderCore(db, code) {
	return {
		list: async (environmentId, actor, after) =>
			code.parseListPage(
				db.rpc("qorpera_folder_list", {
					p_environment_id: environmentId,
					p_actor: actor,
					p_parent: "",
					p_after: after,
					p_limit: 1000,
					p_recursive: true,
				}),
			),
		feed: async (environmentId, actor, afterSeq, cursor) =>
			code.parseFeedPage(
				db.rpc("qorpera_folder_feed", {
					p_environment_id: environmentId,
					p_actor: actor,
					p_after_seq: afterSeq,
					p_limit: 1000,
					p_cursor: cursor,
				}),
			),
		clocks: async (environmentIds) => {
			const rows = db.json(`select coalesce(jsonb_agg(jsonb_build_array(environment_id, last_seq)), '[]')
				from public.qorpera_folder_clocks where environment_id = any(${literal(`{${environmentIds.join(",")}}`)}::uuid[])`);
			return new Map(rows.map(([id, seq]) => [id, Number(seq)]));
		},
		objectProfile: async (environmentId, actor, sha) =>
			db.rpc("qorpera_folder_authorize_object_download", {
				p_environment_id: environmentId,
				p_actor: actor,
				p_sha256: sha,
			}).profileId,
		renewView: async () => {
			throw new Error("An operator mount has no core view to renew");
		},
	};
}

/** Searches the company folder with the node folder service's search (search.ts, what `company_search` runs) over the
 * actor's whole listing from the core, reading bytes from the object share as the service does. The service serves
 * search only to a run's own view, which needs a leased run (C4); here the listing is the actor's. */
async function searchFolder(db, code, objectRoot, environmentId, actor, query) {
	const core = sqlFolderCore(db, code);
	const tree = new code.ViewTree();
	let after = null;
	do {
		const page = await core.list(environmentId, actor, after);
		for (const entry of page.entries) tree.put(entry);
		after = page.next;
	} while (after !== null);
	const objects = new code.NasObjects({ root: objectRoot, cacheBytes: 64 * 1024 * 1024 });
	let profileId;
	const hits = [];
	let searched = 0;
	let next = null;
	do {
		const page = await code.searchView(
			{
				tree,
				now: Date.now,
				read: async (entry, offset, length) => {
					profileId ??= await core.objectProfile(environmentId, actor, entry.manifestSha256);
					return objects.read(profileId, entry, offset, length);
				},
			},
			{ query, path: "", glob: null, namesOnly: false, caseSensitive: false, after: next },
		);
		hits.push(...page.hits);
		searched += page.searched;
		next = page.next;
	} while (next);
	return { hits, searched };
}

/** The C5 lines, in the core document's order. */
const LINES = [
	"the seeded tree exists, and creation wrote exactly one kickoff and its turn request; the first-run wake once P28 materializes it",
	"read, list, search and write through change sets, and disjoint writes never conflict",
	"a same-path conflict keeps a conflict copy",
	"a move and a subtree delete work, and a subtree delete refuses a change it did not see",
	"hiring, archiving, a routine file, a group chat and sections each update their index, and pass or skip review as 5.6 says",
	"a coding session cannot write agents/, and is never reviewed",
	"a file change wakes a listener exactly once",
	"the web file page and history show the change",
	"revocation of one agent's grant stops that agent's send and no other",
	"stop takes effect under load",
	"GC races lose nothing",
	"erasure removes a deleted agent's history",
	"the launch items of the layout amendment that do not need the mount pass: 3, 4, 5, 11, 15, 17, 19 and 21",
];

class Report {
	results = new Map();
	/** What the company mode's cleanup left in place, and why. */
	cleanup = [];

	async check(n, fn) {
		try {
			const detail = await fn();
			if (!this.results.has(n)) this.results.set(n, { state: "PASS", detail: detail ?? "" });
		} catch (error) {
			this.results.set(n, { state: "FAIL", detail: (error?.message ?? String(error)).split("\n")[0].slice(0, 400) });
		}
	}

	notRun(n, reason) {
		this.results.set(n, { state: "NOT RUN", detail: reason });
	}

	print() {
		let failed = 0;
		LINES.forEach((text, index) => {
			const result = this.results.get(index + 1) ?? { state: "NOT RUN", detail: "not reached" };
			if (result.state === "FAIL") failed++;
			process.stdout.write(`C5-${String(index + 1).padStart(2, "0")} ${result.state.padEnd(7)} ${text}${result.detail ? ` — ${result.detail}` : ""}\n`);
		});
		for (const line of this.cleanup) process.stdout.write(`Cleanup: ${line}\n`);
		return failed;
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// The hosted database: a company founded the real way, and every item written through change sets.

const OWNER = "90300000-0000-4000-8000-000000000001";
const CREATION = "90300000-0000-4000-8000-000000000100";

/** The founder's own model login (Settings), as test 856 connects it, so creation writes the kickoff's turn request and
 * a member's routine has its payer. */
function connectLogin(db, profileId) {
	db.query(`begin;
		create function pg_temp.as_user(p_user uuid) returns void language sql as $f$
			select set_config('request.jwt.claims', jsonb_build_object('role','authenticated','sub',p_user,
				'email',(select email from auth.users where id = p_user))::text, true)::text::void $f$;
		create function pg_temp.as_service() returns void language sql as $f$
			select set_config('request.jwt.claims','{"role":"service_role"}', true)::text::void $f$;
		select pg_temp.as_service();
		select public.qorpera_set_provider_execution_policy('openai','native_subscription','codex-cli',
			'supported','enabled',32,null,'folder-core-acceptance') \\g /dev/null
		do $d$
		declare v_identity jsonb; v_login jsonb; v_connection jsonb;
			c_profile constant uuid := ${literal(profileId)}; c_user constant uuid := ${literal(OWNER)};
		begin
			perform pg_temp.as_user(c_user);
			set local role authenticated;
			v_identity := public.qorpera_upsert_member_compute_identity(c_profile, '90300000-0000-4000-8000-000000000701',
				'My model account', 'qorpera-member-linux', 'v1', '["agent_turn","company_substrate"]',
				'{"network":"provider-native-only","credentialExport":false}');
			v_login := public.qorpera_begin_native_provider_login(c_profile, '90300000-0000-4000-8000-000000000801',
				'90300000-0000-4000-8000-000000000901', (v_identity ->> 'compute_identity_id')::uuid, 'openai', 'codex-cli',
				repeat('01', 32), 900);
			reset role;
			perform pg_temp.as_service();
			set local role service_role;
			v_connection := public.qorpera_complete_native_provider_login((v_login ->> 'login_id')::uuid, repeat('01', 32),
				'90300000-0000-4000-8000-000000000a01', 'object://native-capsules/90300000-0000-4000-8000-000000000a01',
				repeat('d', 64), 'openai-01', 'personal-subscription', 'qorpera-native-provider-consent/v1',
				'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}');
			reset role;
			insert into public.qorpera_provider_connection_versions
			select (jsonb_populate_record(null::public.qorpera_provider_connection_versions,
				to_jsonb(v) || '{"version":2,"allow_autonomous":true}'::jsonb)).*
			from public.qorpera_provider_connection_versions v
			where connection_id = (v_connection ->> 'connection_id')::uuid and version = 1;
			perform pg_temp.as_user(c_user);
			set local role authenticated;
			perform public.qorpera_create_member_execution_sponsor(c_profile, '90300000-0000-4000-8000-000000000b01',
				(v_connection ->> 'connection_id')::uuid, 2, true);
			reset role;
		end $d$;
		commit;`);
}

async function hosted(report) {
	const database = await hostedDatabase(databaseName);
	let scratch;
	try {
		scratch = await mkdtemp(join(tmpdir(), "qorpera-folder-acceptance-"));
		const db = new Database(
			(sql) => database.cluster.psql(databaseName, sql, ["-qAt"]),
			() => database.cluster.spawnPsql(databaseName, ["-qAt", "-v", "ON_ERROR_STOP=1"]),
		);
		const code = await bundle(scratch);
		const objectRoot = join(scratch, "objects");
		const store = new code.FileSystemObjectStore(objectRoot);
		const replication = {
			async uploadWithAuthority(profile, hash, bytes, callbacks) {
				await callbacks.authorize();
				const result = await store.put(profile, hash, bytes);
				await callbacks.confirm();
				return result;
			},
		};
		const publisher = { publisher: async (method, args) => db.rpc(method, args) };
		const member = { kind: "member", userId: OWNER };
		const writer = new code.PlatformFolderWriter({ authority: publisher, actor: member, store, replication });
		const signal = AbortSignal.timeout(600_000);
		let keys = 0;
		const key = (label) => `member:${OWNER}:acceptance-${label}-${String(++keys).padStart(3, "0")}`;
		const text = (value) => new TextEncoder().encode(value);
		const stage = (env, value) => writer.stage(env, text(value), { mediaType: "text/markdown", executable: false }, signal);
		const structured = (path, value) => {
			const entry = code.memberFolderStructured(path, value);
			return entry ? [entry] : undefined;
		};
		// As the object gateway's member commit route: the commit, then its follow-ups at once (P15: a hire's grant and
		// first run, an archive's routine pause), one subject a call while the core answers `more`.
		const commit = async (env, label, units) => {
			const answer = db.rpc("qorpera_folder_commit", {
				p_environment_id: env, p_actor: member, p_operation_key: key(label), p_units: units,
			});
			if (Number.isSafeInteger(answer?.seq) && typeof answer.commitId === "string")
				await code.followUpMemberCommit(publisher, env, answer.commitId, signal);
			return answer;
		};
		const saved = (answer, what) => {
			const bad = (answer?.units ?? []).filter((u) => u.outcome !== "saved");
			if (!answer?.units?.length || bad.length) throw new Error(`${what} did not save: ${JSON.stringify(answer?.units ?? answer)}`);
			return answer;
		};
		const writeUnit = async (env, path, value, expectedVersion) => {
			const unit = { op: "write", path, file: await stage(env, value) };
			if (expectedVersion) unit.expectedVersion = expectedVersion;
			const parse = structured(path, value);
			if (parse) unit.structured = parse;
			return unit;
		};
		const entry = (env, path) =>
			db.json(`select to_jsonb(e) from public.qorpera_folder_entries e where e.environment_id = ${literal(env)}
				and e.key_text = public.qorpera_folder_key(${literal(path)}) and e.kind <> 'claim'`);
		const lastSeq = (env) => Number(db.query(`select last_seq from public.qorpera_folder_clocks where environment_id = ${literal(env)}`));

		// The company: opened and seeded as the founding path does, the founder's own login, the worker as built.
		db.query(`insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data)
			values (${literal(OWNER)}, 'founder@acceptance.test', clock_timestamp(), '{"display_name":"Ada"}')`);
		const opened = db.json(`select public.qorpera_folder_company_open(${literal(OWNER)}, ${literal(CREATION)}, 'Acceptance Works')`);
		const profileId = opened.profile_id;
		const env = opened.environment_id;
		connectLogin(db, profileId);
		db.query(`select public.qorpera_folder_company_seed(${literal(profileId)}, ${literal({
			schema: "qorpera.company-seed-input/v1",
			companyName: "Acceptance Works",
			vision: "Prove the company folder end to end.",
			kickoffRequestedBy: OWNER,
			founders: [{ userId: OWNER, displayName: "Ada", role: "Everything at first." }],
		})})`);
		const creator = new code.CompanyFolderCreator({
			workerId: "90300000-0000-4000-8000-00000000000a",
			authority: publisher,
			store,
			replication,
		});

		await report.check(1, async () => {
			assert.equal(await creator.createDue(5), 1, "one creation is due");
			const made = db.json(`select to_jsonb(c) from public.qorpera_folder_company_creations c where c.profile_id = ${literal(profileId)}`);
			assert.equal(made.state, "completed", JSON.stringify(made));
			const tree = code.companyStateSeedTree({
				companyName: "Acceptance Works",
				cofounderId: made.cofounder_id,
				vision: "Prove the company folder end to end.",
				founders: [{ userId: OWNER, displayName: "Ada", role: "Everything at first." }],
				firstTodo: { id: made.first_todo_id, requestedBy: OWNER },
			});
			for (const seeded of tree) assert.equal(entry(env, seeded.path)?.kind, seeded.kind, `${seeded.path} is seeded`);
			const kickoffs = db.query(`select count(*) from public.qorpera_agent_first_runs f
				join public.qorpera_session_inputs i on i.id = f.input_id where f.profile_id = ${literal(profileId)} and i.kind = 'kickoff'`);
			assert.equal(kickoffs, "1", "exactly one kickoff");
			const turns = db.json(`select coalesce(jsonb_agg(jsonb_build_object('status', status,
				'reason', initial_execution_selection ->> 'reason')), '[]') from public.qorpera_session_turn_requests
				where profile_id = ${literal(profileId)}`);
			assert.deepEqual(turns, [{ status: "queued", reason: "agent_first_run" }], "exactly one turn request, the kickoff's");
			assert.equal(db.query(`select count(*) from public.qorpera_wake_occurrences where profile_id = ${literal(profileId)}`), "0");
			const materialized = db.rpc("qorpera_folder_materialize_company", { p_profile_id: profileId, p_limit: 16 });
			assert.equal(materialized?.state, "done", `materialize: ${JSON.stringify(materialized)}`);
			const wakes = db.json(`select coalesce(jsonb_agg(jsonb_build_object('kind', wake_kind, 'status', status)), '[]')
				from public.qorpera_wake_occurrences where profile_id = ${literal(profileId)}`);
			assert.equal(wakes.length, 1, `one first-run wake: ${JSON.stringify(wakes)}`);
			assert.equal(db.query(`select public.qorpera_folder_company_first_run_state(${literal(profileId)})`), "started");
			return `${tree.length} seeded paths, 1 kickoff, 1 turn request, 1 first-run wake (${wakes[0].kind}, ${wakes[0].status})`;
		});

		const cofounderId = db.query(`select cofounder_id from public.qorpera_folder_company_creations where profile_id = ${literal(profileId)}`);

		await report.check(2, async () => {
			saved(await commit(env, "folders", [{ op: "mkdir", path: "docs" }, { op: "mkdir", path: "notes" }]), "the folders");
			// Two writers at once, on different paths, each from its own session: both save, one after the other.
			const alpha = await writeUnit(env, "notes/alpha.md", "# Alpha\n\nThe zebra-lantern plan.\n");
			const beta = await writeUnit(env, "notes/beta.md", "# Beta\n\nAnother note.\n");
			const [a, b] = await db.concurrently([
				{ method: "qorpera_folder_commit", args: { p_environment_id: env, p_actor: member, p_operation_key: key("disjoint-a"), p_units: [alpha] } },
				{ method: "qorpera_folder_commit", args: { p_environment_id: env, p_actor: member, p_operation_key: key("disjoint-b"), p_units: [beta] } },
			]);
			saved(a, "writer a");
			saved(b, "writer b");
			assert.notEqual(a.seq, b.seq, "two commits");
			const read = db.rpc("qorpera_folder_read", { p_environment_id: env, p_actor: member, p_path: "notes/alpha.md" });
			assert.equal(read?.found, true);
			assert.equal(read.entry.version, a.units[0].version);
			const list = db.rpc("qorpera_folder_list", {
				p_environment_id: env, p_actor: member, p_parent: "notes", p_after: null, p_limit: 100, p_recursive: false,
			});
			assert.deepEqual(list.entries.map((e) => e.path).sort(), ["notes/alpha.md", "notes/beta.md"]);
			const found = await searchFolder(db, code, objectRoot, env, member, "zebra-lantern");
			assert.deepEqual(found.hits.map((h) => h.path), ["notes/alpha.md"], `search: ${JSON.stringify(found.hits)}`);
			return `two concurrent writers saved at seq ${a.seq} and ${b.seq}; read, list, and the folder service's search engine over the member's listing (${found.searched} files) agree; search in a run's own view needs a leased run (C4)`;
		});

		await report.check(3, async () => {
			if (db.query("select to_regclass('public.qorpera_folder_conflict_copies') is null") === "t") {
				report.notRun(3, "conflict copies (P17, #783) are not on this database yet");
				return;
			}
			const first = saved(await commit(env, "plan-1", [await writeUnit(env, "notes/plan.md", "Plan one.\n")]), "plan one");
			const stale = first.units[0].version;
			saved(await commit(env, "plan-2", [await writeUnit(env, "notes/plan.md", "Plan two.\n", stale)]), "plan two");
			const mine = await writeUnit(env, "notes/plan.md", "My plan, written from the first.\n", stale);
			const lost = await commit(env, "plan-3", [mine]);
			assert.equal(lost.units[0].outcome, "conflict", JSON.stringify(lost.units));
			const copies = db.json(`select coalesce(jsonb_agg(to_jsonb(k)), '[]') from public.qorpera_folder_conflict_copies k
				where k.commit_id = ${literal(lost.commitId)}`);
			assert.equal(copies.length, 1, "one copy on the receipt");
			assert.equal(copies[0].manifest_sha256, mine.file.manifestSha256);
			assert.equal(db.query(`select public.qorpera_folder_object_rooted(${literal(profileId)}, ${literal(mine.file.manifestSha256)})`), "t");
			assert.notEqual(entry(env, "notes/plan.md").manifest_sha256, mine.file.manifestSha256, "the live file is the other writer's");
			return `the losing version is kept on commit ${lost.commitId} and rooted; the live file is the other writer's`;
		});

		await report.check(4, async () => {
			saved(await commit(env, "work", [{ op: "mkdir", path: "work" }, { op: "mkdir", path: "work/a" }]), "work/a");
			saved(await commit(env, "work-x", [await writeUnit(env, "work/a/x.md", "x\n")]), "work/a/x.md");
			const moved = await commit(env, "move", [{ op: "move", from: "work/a", to: "work/b",
				expectedVersion: entry(env, "work/a").version, asOfSeq: lastSeq(env) }]);
			saved(moved, "the move");
			assert.equal(entry(env, "work/b/x.md")?.kind, "file");
			assert.equal(entry(env, "work/a"), null);
			const seen = lastSeq(env);
			saved(await commit(env, "work-y", [await writeUnit(env, "work/b/y.md", "y\n")]), "work/b/y.md");
			const unseen = await commit(env, "delete-stale", [{ op: "delete", path: "work/b",
				expectedVersion: entry(env, "work/b").version, asOfSeq: seen }]);
			assert.equal(unseen.units[0].reason, "unseen_change", JSON.stringify(unseen.units));
			assert.equal(entry(env, "work/b/y.md")?.kind, "file", "nothing was deleted");
			saved(await commit(env, "delete", [{ op: "delete", path: "work/b", expectedVersion: entry(env, "work/b").version,
				asOfSeq: lastSeq(env) }]), "the delete");
			assert.equal(db.query(`select count(*) from public.qorpera_folder_entries where environment_id = ${literal(env)}
				and kind <> 'claim' and key_text like 'work/b%'`), "0");
			return "move saved; a delete that did not see work/b/y.md refused (unseen_change); then it deleted the subtree";
		});

		// Hiring, a routine that watches docs/, a group chat and sections, as a member; archiving follows the listener.
		const nora = "90300000-0000-4000-8000-0000000000d1";
		const routine = "90300000-0000-4000-8000-0000000000d2";
		const group = "90300000-0000-4000-8000-0000000000d3";
		const agentText = (id, name, status) => `---\nid: ${id}\nname: ${name}\nrole: Sales\nkind: agent\nstatus: ${status}\n---\nSell.\n`;
		let routineSeq = 0;
		await report.check(5, async () => {
			const agentMd = agentText(nora, "Nora", "active");
			const hire = await commit(env, "hire", [{ op: "new_folder", path: "agents/nora", contents: [
				{ path: "agent.md", kind: "file", file: await stage(env, agentMd) },
				{ path: "memory", kind: "folder" }, { path: "skills", kind: "folder" },
				{ path: "routines", kind: "folder" }, { path: "todos", kind: "folder" }],
				structured: structured("agents/nora/agent.md", agentMd) }]);
			saved(hire, "the hire");
			const staff = db.json(`select to_jsonb(s) from public.qorpera_profile_staff s where s.profile_id = ${literal(profileId)}
				and s.staff_agent_id = ${literal(nora)}`);
			assert.equal(staff?.folder_path, "agents/nora/agent.md", "the agent's index row");
			assert.equal(staff.folder_path_version, entry(env, "agents/nora/agent.md").version);
			assert.equal(staff.employment_status, "active");
			// The hire's follow-up: Nora's default grant and her kickoff.
			const followUps = db.rpc("qorpera_folder_follow_up_status", { p_environment_id: env });
			assert.deepEqual(followUps.dirty, [], `the hire's follow-up converged: ${JSON.stringify(followUps)}`);
			assert.equal(db.query(`select count(*) from public.qorpera_agent_first_runs f
				join public.qorpera_session_inputs i on i.id = f.input_id
				where f.profile_id = ${literal(profileId)} and f.staff_agent_id = ${literal(nora)} and i.kind = 'kickoff'`), "1",
				"the hire's kickoff");

			const routineMd = `---\nid: ${routine}\ntitle: Watch docs\nstatus: active\nwhen: file-change\nwatch: docs\nmatch: subtree\ntimezone: Europe/Copenhagen\neffort: medium\nreply: optional\n---\nRead what changed.\n`;
			const routineSave = saved(await commit(env, "routine", [await writeUnit(env, "agents/nora/routines/watch-docs.md", routineMd)]), "the routine");
			routineSeq = routineSave.seq;
			const routineRow = db.json(`select to_jsonb(r) from public.qorpera_cloud_routines r where r.id = ${literal(routine)}`);
			assert.equal(routineRow?.folder_path_version, entry(env, "agents/nora/routines/watch-docs.md").version, "the routine's index row");

			const groupMd = `---\nid: ${group}\nname: Launch\nagents:\n  - ${cofounderId}\n  - ${nora}\npeople:\n  - ${OWNER}\n---\nPlan the launch.\n`;
			saved(await commit(env, "group", [{ op: "new_folder", path: "agents/groups/launch", contents: [
				{ path: "group.md", kind: "file", file: await stage(env, groupMd) }],
				structured: structured("agents/groups/launch/group.md", groupMd) }]), "the group chat");
			const room = db.json(`select to_jsonb(r) from public.qorpera_company_rooms r where r.id = ${literal(group)}`);
			assert.equal(room?.folder_path, "agents/groups/launch/group.md", "the group's index row");

			const sectionsMd = `# Sections\n\nEach line is an id. The words after it are only for reading.\n\n## Sales\n- ${nora} Nora\n- ${group} Launch\n`;
			saved(await commit(env, "sections", [await writeUnit(env, "agents/sections.md", sectionsMd, entry(env, "agents/sections.md").version)]), "sections");
			const placed = db.query(`select count(*) from public.qorpera_company_sidebar_sections s
				join public.qorpera_company_sidebar_placements p on p.section_id = s.id
				where s.profile_id = ${literal(profileId)} and s.name = 'Sales' and p.staff_agent_id = ${literal(nora)}`);
			assert.equal(placed, "1", "the section's index rows");
			return "hire, routine, group chat and sections each updated their index; a member's units skip review (5.6), archiving below";
		});

		report.notRun(6, "needs a real coding session on a machine (C1c-3h/3i); SQL tests 639 and 644 pin that coding cannot write agents/ and is never reviewed");

		await report.check(7, async () => {
			if (!routineSeq) throw new Error("the routine was not saved (C5-05)");
			const change = saved(await commit(env, "docs-plan", [await writeUnit(env, "docs/plan.md", "The plan.\n")]), "docs/plan.md");
			const listen = db.rpc("qorpera_folder_listen_company", { p_environment_id: env, p_limit: 32 });
			const wakes = () => db.query(`select count(*) from public.qorpera_wake_occurrences where routine_id = ${literal(routine)}
				and source_kind = 'company-file' and source_id = ${literal(change.commitId)}`);
			assert.equal(wakes(), "1", `one wake for the change: ${JSON.stringify(listen)}`);
			const again = db.rpc("qorpera_folder_listen_company", { p_environment_id: env, p_limit: 32 });
			assert.equal(again?.state, "idle", JSON.stringify(again));
			assert.equal(wakes(), "1", "still one");
			return `the change at seq ${change.seq} woke the routine once; the listener then answered idle`;
		});

		await report.check(5, async () => {
			if (report.results.get(5)?.state !== "PASS") return;
			const archived = agentText(nora, "Nora", "archived");
			saved(await commit(env, "archive", [await writeUnit(env, "agents/nora/agent.md", archived,
				entry(env, "agents/nora/agent.md").version)]), "the archive");
			const status = db.query(`select employment_status from public.qorpera_profile_staff where profile_id = ${literal(profileId)}
				and staff_agent_id = ${literal(nora)}`);
			assert.equal(status, "archived");
			const paused = db.json(`select to_jsonb(r) from public.qorpera_cloud_routines r where r.id = ${literal(routine)}`);
			assert.deepEqual([paused?.status, paused?.pause_reason], ["paused", "agent_archived"], "the archive's follow-up paused the routine");
			report.results.set(5, { state: "PASS", detail: "hire (with its follow-up: grant and kickoff), archive (its routine paused), " +
				"routine, group chat and sections each updated their index; a member's units skip review (5.6)" });
		});

		await report.check(12, async () => {
			const erin = "90300000-0000-4000-8000-0000000000e1";
			const erinMd = agentText(erin, "Erin", "active");
			saved(await commit(env, "hire-erin", [{ op: "new_folder", path: "agents/erin", contents: [
				{ path: "agent.md", kind: "file", file: await stage(env, erinMd) }],
				structured: structured("agents/erin/agent.md", erinMd) }]), "Erin's hire");
			saved(await commit(env, "delete-erin", [{ op: "delete", path: "agents/erin", expectedVersion: entry(env, "agents/erin").version,
				asOfSeq: lastSeq(env) }]), "Erin's folder deleted");
			const erased = db.rpc("qorpera_folder_erase", { p_environment_id: env, p_actor: member, p_paths: ["agents/erin"],
				p_operation_key: "acceptance-erase-erin" });
			assert.equal(erased?.schema, "qorpera.folder-erasure/v1", JSON.stringify(erased));
			for (let step = 0; step < 50; step++) {
				const state = db.query(`select state from public.qorpera_folder_erasures where id = ${literal(erased.erasureId)}`);
				if (state !== "working") break;
				db.query("select public.qorpera_folder_erasure_step()");
			}
			assert.equal(db.query(`select state from public.qorpera_folder_erasures where id = ${literal(erased.erasureId)}`), "done");
			assert.equal(db.query(`select count(*) from public.qorpera_folder_path_versions where environment_id = ${literal(env)}
				and public.qorpera_folder_key(path) >= 'agents/erin' and public.qorpera_folder_key(path) < 'agents/erin0'`), "0");
			assert.equal(db.query(`select count(*) from public.qorpera_folder_commits where environment_id = ${literal(env)}
				and units::text like '%agents/erin%'`), "0", "no change set still names the path");
			const staff = db.json(`select to_jsonb(s) from public.qorpera_profile_staff s where s.staff_agent_id = ${literal(erin)}`);
			assert.equal(staff?.display_name, "Erased agent");
			assert(staff.folder_erased_at, "the agent's row is erased");
			return "the deleted agent's versions, path names and name are gone; its row keeps only the placeholder";
		});

		await report.check(8, async () => {
			const asOwner = { role: "authenticated", sub: OWNER };
			assert.equal(db.rpc("qorpera_member_company_file_mode", { p_profile_id: profileId }, asOwner)?.mode, "folder");
			const history = db.rpc("qorpera_member_folder_history", { p_environment_id: env, p_before: null, p_limit: 50 }, asOwner);
			assert(history.items.some((item) => item.paths.some((p) => p.path === "docs/plan.md")), "the change is in the history");
			const versions = db.rpc("qorpera_member_folder_path_history", { p_environment_id: env, p_path: "docs/plan.md",
				p_before: null, p_limit: 10 }, asOwner);
			assert.equal(versions.items[0]?.version, entry(env, "docs/plan.md").version);
			return "the member's file mode is folder, and the history and the path's versions show the change (the web page reads these)";
		});

		report.notRun(9, "needs two live runs of different agents on real model logins (C4); SQL tests 635 and 652/653 pin it");
		report.notRun(10, "the C1e load test (P24) proves it under load");

		await report.check(11, async () => {
			// Every intent's time runs out; the sweep and the claim then run as the GC worker does.
			db.query(`update public.qorpera_folder_upload_intents set expires_at = clock_timestamp() - interval '2 days'
				where environment_id = ${literal(env)}`);
			for (let round = 0; round < 20 && db.rpc("qorpera_folder_sweep_upload_intents", { p_limit: 100 }) > 0; round++);
			const live = db.json(`with manifests as (
					select manifest_sha256 as sha from public.qorpera_folder_entries where environment_id = ${literal(env)} and kind = 'file'
					union select manifest_sha256 from public.qorpera_folder_path_versions where environment_id = ${literal(env)}
						and manifest_sha256 is not null)
				select coalesce(jsonb_agg(distinct h), '[]') from (select sha as h from manifests
					union select c.chunk_sha256 from manifests m join public.qorpera_folder_file_chunks c
						on c.profile_id = ${literal(profileId)} and c.manifest_sha256 = m.sha) x`);
			const lease = "90300000-0000-4000-8000-0000000000f1";
			const claimed = db.rpc("qorpera_folder_claim_object_gc", { p_limit: 100, p_lease: lease }).objects.map((o) => o.sha256);
			const lost = claimed.filter((sha) => live.includes(sha));
			for (const sha of claimed)
				db.rpc("qorpera_folder_gc_unlink_abandon", { p_profile_id: profileId, p_sha256: sha, p_lease: lease });
			assert.deepEqual(lost, [], "the claim marked a live object");
			const missing = db.json(`select coalesce(jsonb_agg(h), '[]') from unnest(${literal(`{${live.join(",")}}`)}::text[]) h
				where not exists (select 1 from public.qorpera_profile_objects o where o.profile_id = ${literal(profileId)} and o.sha256 = h)
					or not public.qorpera_folder_object_rooted(${literal(profileId)}, h)`);
			assert.deepEqual(missing, [], "every live object is catalogued and rooted");
			const files = db.json(`select coalesce(jsonb_agg(jsonb_build_object('path', path, 'manifestSha256', manifest_sha256,
				'fileSha256', file_sha256, 'bytes', bytes)), '[]') from public.qorpera_folder_entries
				where environment_id = ${literal(env)} and kind = 'file'`);
			const platform = new code.PlatformFolderWriter({ authority: publisher, store, replication });
			for (const file of files) await platform.read(env, file, 8 * 1024 * 1024, signal);
			// The races themselves (a reference against the claim, the sweep, the finish) are SQL test 767's (dblink R1–R10):
			// this script runs the worker's steps one after another, so it proves the outcome, not the races.
			report.notRun(11, `the races are proven by SQL test 767 (dblink R1–R10); run here one after another: ${live.length} live ` +
				`objects, the claim took ${claimed.length} unrooted ones and none live, ${files.length} live files read back`);
		});

		report.notRun(13, "the launch items are proven on the proof company (P38); run this script with --company there");

		// The --company mode's own checks, on the company founded here (with --write), so they run on every suite.
		const second = new Report();
		await existing(second, db, code, profileId, true, objectRoot);
		report.companyReport = second;
	} finally {
		if (scratch) await rm(scratch, { recursive: true, force: true });
		database.close();
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// An existing company (P38's proof company, a founder's first company): read-only, or with --write under a scratch
// folder it removes again.

/** The checks for an existing company. `objectRoot` is the object share to read bytes from, when there is one. */
async function existing(report, db, code, profileId, write, objectRoot) {
	const env = db.query(`select environment_id from public.qorpera_company_files where profile_id = ${literal(profileId)}
		and core = 'folder-v2'`);
	if (!env) throw new Error("That company has no folder-v2 environment");
	const platform = { kind: "platform" };
	const entry = (path) =>
		db.json(`select to_jsonb(e) from public.qorpera_folder_entries e where e.environment_id = ${literal(env)}
			and e.key_text = public.qorpera_folder_key(${literal(path)}) and e.kind <> 'claim'`);
	const lastSeq = () => Number(db.query(`select last_seq from public.qorpera_folder_clocks where environment_id = ${literal(env)}`));
	const owner = db.query(`select user_id from public.qorpera_profile_members where profile_id = ${literal(profileId)}
		and role = 'owner' order by joined_at nulls last limit 1`);

	await report.check(1, () => {
		for (const path of ["vision/vision.md", "agents/sections.md", "agents/co-founder/agent.md", "skills/human-task/skill.md"])
			assert.equal(entry(path)?.kind, "file", `${path} is in the folder`);
		// The founding's kickoff is the first run of the creation's Co-Founder; agents hired since have first runs of their own.
		const kickoffs = db.json(`select coalesce(jsonb_agg(f.session_id), '[]') from public.qorpera_agent_first_runs f
			join public.qorpera_folder_company_creations c on c.profile_id = f.profile_id and c.cofounder_id = f.staff_agent_id
			join public.qorpera_session_inputs i on i.id = f.input_id
			where f.profile_id = ${literal(profileId)} and i.kind = 'kickoff'`);
		assert.equal(kickoffs.length, 1, "exactly one kickoff, the Co-Founder's");
		const turns = db.query(`select count(*) from public.qorpera_session_turn_requests where profile_id = ${literal(profileId)}
			and session_id = ${literal(kickoffs[0])} and initial_execution_selection ->> 'reason' = 'agent_first_run'`);
		const others = db.query(`select count(*) - 1 from public.qorpera_agent_first_runs where profile_id = ${literal(profileId)}`);
		const state = db.query(`select public.qorpera_folder_company_first_run_state(${literal(profileId)})`);
		return `seeded paths present, the Co-Founder's kickoff with ${turns} first-run turn request(s), ${others} hired agents' ` +
			`first runs beside it, first run ${state || "unknown"}`;
	});

	const scratchRoot = `acceptance/${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}-${randomBytes(4).toString("hex")}`;
	let createdParent = false;
	/** The sequence number of this run's last change under the scratch folder: deletes are made as of it, so a change
	 * someone else made under it meanwhile refuses them (unseen_change) instead of going with them. */
	let scratchSeq = 0;
	let keys = 0;
	const key = (label) => `acceptance-${scratchRoot.slice(11)}-${label}-${++keys}`;
	const commit = (units) => {
		const answer = db.rpc("qorpera_folder_commit", { p_environment_id: env, p_actor: platform, p_operation_key: key("c"),
			p_units: units });
		if (answer?.seq) scratchSeq = Math.max(scratchSeq, Number(answer.seq));
		return answer;
	};
	const saved = (answer, what) => {
		const bad = (answer?.units ?? []).filter((u) => u.outcome !== "saved");
		if (!answer?.units?.length || bad.length) throw new Error(`${what} did not save: ${JSON.stringify(answer?.units ?? answer)}`);
		return answer;
	};

	await report.check(2, async () => {
		const read = db.rpc("qorpera_folder_read", { p_environment_id: env, p_actor: platform, p_path: "vision/vision.md" });
		assert.equal(read?.found, true, "vision/vision.md reads");
		const list = db.rpc("qorpera_folder_list", { p_environment_id: env, p_actor: platform, p_parent: "", p_after: null,
			p_limit: 1000, p_recursive: false });
		assert(list.entries.some((e) => e.path === "agents"), "the root lists agents/");
		const details = [`read and list as the platform (${list.entries.length} top-level entries)`];
		if (objectRoot) {
			const found = await searchFolder(db, code, objectRoot, env, platform, "Co-Founder");
			assert(found.hits.length > 0 || found.next, "the folder service's search finds the Co-Founder");
			details.push(`search found ${found.hits.length} hit(s) in ${found.searched} file(s)`);
		} else details.push("search not run (no QORPERA_ACCEPTANCE_OBJECT_ROOT)");
		if (write) {
			createdParent = !entry("acceptance");
			saved(commit([{ op: "mkdir", path: "acceptance" }].filter(() => createdParent).concat([{ op: "mkdir", path: scratchRoot }])),
				"the scratch folder");
			// Folders only: nothing is staged in an existing company, and no structured file moves.
			const [a, b] = await db.concurrently(["a", "b"].map((name) => ({
				method: "qorpera_folder_commit",
				args: { p_environment_id: env, p_actor: platform, p_operation_key: key(`disjoint-${name}`),
					p_units: [{ op: "mkdir", path: `${scratchRoot}/${name}` }] },
			})));
			saved(a, "writer a");
			saved(b, "writer b");
			scratchSeq = Math.max(scratchSeq, Number(a.seq), Number(b.seq));
			details.push(`two concurrent writers under ${scratchRoot} saved`);
		} else details.push("writes not run (read-only; pass --write)");
		return details.join("; ");
	});

	report.notRun(3, write ? "needs staged bytes; run it on the hosted database (no argument)" : "read-only");

	await report.check(4, async () => {
		if (!write) return report.notRun(4, "read-only; pass --write");
		saved(commit([{ op: "mkdir", path: `${scratchRoot}/m` }, { op: "mkdir", path: `${scratchRoot}/m/x` }]), "scratch m");
		saved(commit([{ op: "move", from: `${scratchRoot}/m`, to: `${scratchRoot}/n`, expectedVersion: entry(`${scratchRoot}/m`).version,
			asOfSeq: scratchSeq }]), "the move");
		assert.equal(entry(`${scratchRoot}/n/x`)?.kind, "folder");
		const seen = scratchSeq;
		saved(commit([{ op: "mkdir", path: `${scratchRoot}/n/y` }]), "n/y");
		const unseen = commit([{ op: "delete", path: `${scratchRoot}/n`, expectedVersion: entry(`${scratchRoot}/n`).version, asOfSeq: seen }]);
		assert.equal(unseen.units[0].reason, "unseen_change", JSON.stringify(unseen.units));
		saved(commit([{ op: "delete", path: `${scratchRoot}/n`, expectedVersion: entry(`${scratchRoot}/n`).version,
			asOfSeq: scratchSeq }]), "the subtree delete");
		return "move, a refused stale subtree delete, then the subtree deleted";
	});

	await report.check(5, () => {
		const stale = db.json(`select coalesce(jsonb_agg(e.path), '[]') from public.qorpera_folder_entries e
			where e.environment_id = ${literal(env)} and e.kind = 'file' and e.path ~ '^agents/[^/]+/agent\\.md$'
				and not exists (select 1 from public.qorpera_profile_staff s where s.profile_id = ${literal(profileId)}
					and s.folder_path = e.path and s.folder_path_version = e.version)`);
		assert.deepEqual(stale, [], "every agent file has its index row at its version");
		const routines = db.json(`select coalesce(jsonb_agg(e.path), '[]') from public.qorpera_folder_entries e
			where e.environment_id = ${literal(env)} and e.kind = 'file' and e.path ~ '^agents/[^/]+/routines/[^/]+\\.md$'
				and not exists (select 1 from public.qorpera_cloud_routines r where r.folder_path = e.path
					and r.folder_path_version = e.version)`);
		assert.deepEqual(routines, [], "every routine file has its index row at its version");
		return "read-only: every agent and routine file matches its index row (hiring and archiving write nothing here)";
	});

	report.notRun(6, "needs a real coding session on a machine (C1c-3h/3i)");
	report.notRun(7, "read-only: needs a routine of its own; run it on the hosted database (no argument)");

	await report.check(8, () => {
		if (!owner) throw new Error("the company has no owner");
		const asOwner = { role: "authenticated", sub: owner };
		const history = db.rpc("qorpera_member_folder_history", { p_environment_id: env, p_before: null, p_limit: 10 }, asOwner);
		assert(history.items.length > 0, "the history has change sets");
		const versions = db.rpc("qorpera_member_folder_path_history", { p_environment_id: env, p_path: "vision/vision.md",
			p_before: null, p_limit: 10 }, asOwner);
		assert.equal(versions.items[0]?.version, entry("vision/vision.md").version);
		return "the owner's history and vision.md's versions read as the web page reads them";
	});

	report.notRun(9, "needs two live runs of different agents (C4)");
	report.notRun(10, "the C1e load test (P24) proves it under load");

	await report.check(11, () => {
		const leased = db.query(`select count(*) from public.qorpera_folder_entries e
			join public.qorpera_folder_object_gc g on g.profile_id = ${literal(profileId)} and g.sha256 = e.manifest_sha256
			where e.environment_id = ${literal(env)} and e.kind = 'file' and g.lease_expires_at > clock_timestamp()`);
		assert.equal(leased, "0", "no live file's manifest is held for deletion");
		const missing = db.query(`select count(*) from public.qorpera_folder_entries e where e.environment_id = ${literal(env)}
			and e.kind = 'file' and not exists (select 1 from public.qorpera_profile_objects o
				where o.profile_id = ${literal(profileId)} and o.sha256 = e.manifest_sha256)`);
		assert.equal(missing, "0", "every live file's manifest is catalogued");
		report.notRun(11, "the races are proven by SQL test 767; read-only here: every live file's manifest is catalogued, and none is held for deletion");
	});

	// The scratch folder goes again, as of this run's last change under it: anything someone else wrote there since refuses
	// the delete (unseen_change) instead of going with it. Then acceptance/, only when this run made it and it holds nothing
	// else, as of the same sequence number, so a change someone makes there meanwhile refuses it too. Their history stays.
	// A refused delete (a change it did not see, or a version moved on) leaves the folder for whoever changed it.
	const tidy = (path) => {
		const answer = commit([{ op: "delete", path, expectedVersion: entry(path).version, asOfSeq: scratchSeq }]);
		const unit = answer?.units?.[0];
		if (!unit) throw new Error(`${path}'s delete: ${JSON.stringify(answer)}`);
		if (unit.outcome === "saved") return true;
		report.cleanup.push(`${path} left in place: its delete was ${unit.outcome} (${unit.reason ?? "no reason"})`);
		return false;
	};
	if (write && entry(scratchRoot) && tidy(scratchRoot) && createdParent && entry("acceptance")) {
		const others = db.query(`select count(*) from public.qorpera_folder_entries where environment_id = ${literal(env)}
			and kind <> 'claim' and key_text like 'acceptance/%'`);
		if (others === "0") tidy("acceptance");
		else report.cleanup.push(`acceptance/ left in place: it holds ${others} other entries`);
	}

	report.notRun(12, "erasure is not run on an existing company; run it on the hosted database (no argument)");
	report.notRun(13, "the launch items are walked by hand on the proof company (P38)");
}

/** An existing company through the database URL in QORPERA_ACCEPTANCE_DATABASE_URL. */
async function company(report, profileId, write) {
	const url = process.env.QORPERA_ACCEPTANCE_DATABASE_URL;
	if (!url) throw new Error("Set QORPERA_ACCEPTANCE_DATABASE_URL to the database to check (psql connection string)");
	const psqlArgs = [url, "-X", "-qAt", "-v", "ON_ERROR_STOP=1"];
	const db = new Database(
		(sql) => {
			const run = spawnSync("psql", psqlArgs, { input: sql, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
			if (run.status !== 0) throw new Error((run.stderr || "psql failed").trim().split("\n")[0]);
			return run.stdout;
		},
		() => spawn("psql", psqlArgs, { stdio: ["pipe", "pipe", "pipe"] }),
	);
	const scratch = await mkdtemp(join(tmpdir(), "qorpera-folder-acceptance-"));
	try {
		await existing(report, db, await bundle(scratch), profileId, write, process.env.QORPERA_ACCEPTANCE_OBJECT_ROOT);
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

async function main() {
	const args = process.argv.slice(2);
	const report = new Report();
	const at = args.indexOf("--company");
	if (at >= 0) {
		const profileId = args[at + 1];
		if (!/^[0-9a-f-]{36}$/.test(profileId ?? "")) throw new Error("Usage: --company <profileId> [--write]");
		await company(report, profileId, args.includes("--write"));
	} else {
		await hosted(report);
	}
	let failed = report.print();
	if (report.companyReport) {
		process.stdout.write("The --company --write checks, on the company founded above:\n");
		failed += report.companyReport.print();
	}
	if (failed > 0) {
		process.stdout.write(`Folder core acceptance: ${failed} line(s) failed\n`);
		process.exitCode = 1;
	} else process.stdout.write("Folder core acceptance checks passed (every line PASS or NOT RUN with its reason)\n");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	await main();
}
