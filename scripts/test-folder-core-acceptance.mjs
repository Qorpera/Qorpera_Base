import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { expandTestFixture } from "./test-hosted-db.mjs";
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
//
// The hosted run also proves F3 step 3 (deploy/first-node/RUNTIME-FOLDER-WRITES.md), one line per item: the node
// folder service, as built, takes a machine's writes through its view, stages them through the object gateway's
// folder service route, and publishes each boundary with the real commit, all through a PostgREST stand-in.
//
// And F3 step 4c (RUNTIME-FOLDER-SERVICE.md, "Step 4c: read releases"; RUNTIME-FOLDER-COMPANY-MACHINES.md, "Reads"), on
// a database of its own with SQL test 639's company: a company machine's reads, taken through its desktop view as the
// program logs them, are released to the core with the real release before each boundary's commit, and a read that is
// no longer readable refuses the boundaries after it.

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const databaseName = "qorpera_folder_acceptance";
/** Step 4c's database: a copy of the one above, taken before anything is written to it. */
const readsDatabase = "qorpera_folder_reads";
const SERVICE = { role: "service_role" };

/** A SQL literal for one value. */
const literal = (value) =>
	value === null || value === undefined
		? "null"
		: typeof value === "number" || typeof value === "boolean"
			? String(value)
			: `'${(typeof value === "object" ? JSON.stringify(value) : String(value)).replaceAll("'", "''")}'${typeof value === "object" ? "::jsonb" : ""}`;

const sha256hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

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

	/** `select to_jsonb(public.<method>(p_a => …))` with the given claims, in one transaction. An error names its
	 * SQLSTATE (`ERROR:  42501: …`), as PostgREST's `code` does. */
	rpc(method, args, claims = SERVICE) {
		const parameters = Object.entries(args).map(([name, value]) => {
			assert(/^p_[a-z][a-z0-9_]*$/.test(name));
			return `${name}=>${literal(value)}`;
		});
		return this.json(`\\set VERBOSITY verbose
			begin;
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

/** The code the checks drive, as built: the creation worker, the member route's staging and structured entries, the
 * node folder service (its tree, object reads, search, and writes with their staging) and the object gateway. */
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
				'export {parseListPage, parseFeedPage, SupabaseFolderCore} from "./packages/object-gateway/src/folder-service/core.ts";',
				'export {FolderService} from "./packages/object-gateway/src/folder-service/service.ts";',
				'export {FolderStaging, GatewayUploads} from "./packages/object-gateway/src/folder-service/staging.ts";',
				'export {MountGrants, parseOperatorMounts} from "./packages/object-gateway/src/folder-service/mounts.ts";',
				'export {createObjectGatewayHandler} from "./packages/object-gateway/src/service.ts";',
				'export {SupabaseObjectAuthority} from "./packages/object-gateway/src/supabase-authority.ts";',
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
		serviceStopped: async () => {
			throw new Error("An operator mount serves no view");
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

/** PostgREST's HTTP status for an error's SQLSTATE (its error table). */
function postgrestStatus(code) {
	if (code === "42501") return 403;
	if (code === "23503" || code === "23505") return 409;
	if (code === "P0001") return 400;
	if (code === "42883" || code === "42P01") return 404;
	const group = code.slice(0, 2);
	if (group === "08" || group === "53") return 503;
	if (["0L", "0P", "28"].includes(group)) return 403;
	if (["09", "25", "2D", "38", "39", "3B", "40", "54", "55", "57", "58", "F0", "HV", "P0", "XX"].includes(group)) return 500;
	return 400;
}

/** PostgREST in front of the database, for the clients the folder service and the object gateway run as built
 * (SupabaseFolderCore's transport, SupabaseObjectAuthority's fetch): a function as the service role, and the folder
 * clocks' read. An error answers PostgREST's status with its SQLSTATE as the `code`, which the clients read. */
function postgrest(db) {
	const answer = (method, url, body) => {
		try {
			const rpc = /^\/rest\/v1\/rpc\/(qorpera_[a-z0-9_]+)$/.exec(url.pathname);
			if (method === "POST" && rpc) return { status: 200, value: db.rpc(rpc[1], JSON.parse(body ?? "{}")) };
			if (method === "GET" && url.pathname === "/rest/v1/qorpera_folder_clocks") {
				assert.equal(url.searchParams.get("select"), "environment_id,last_seq");
				const ids = /^in\.\(([0-9a-f,-]+)\)$/.exec(url.searchParams.get("environment_id") ?? "");
				assert(ids, "the clocks are read by environment");
				return {
					status: 200,
					value: db.json(`select coalesce(jsonb_agg(jsonb_build_object('environment_id', environment_id,
						'last_seq', last_seq)), '[]') from public.qorpera_folder_clocks
						where environment_id = any(${literal(`{${ids[1]}}`)}::uuid[])`),
				};
			}
			return { status: 404, value: { code: "PGRST202", details: null, hint: null, message: `No ${method} ${url.pathname}` } };
		} catch (error) {
			const failed = /ERROR:\s+([0-9A-Z]{5}):\s*(.*)/.exec(error?.message ?? "");
			if (!failed) throw error;
			return { status: postgrestStatus(failed[1]), value: { code: failed[1], details: null, hint: null, message: failed[2] } };
		}
	};
	return {
		transport: async (url, request) => {
			const { status, value } = answer(request.method, url, request.body);
			return { status, body: Buffer.from(JSON.stringify(value)) };
		},
		fetch: async (input, init = {}) => {
			const { status, value } = answer(init.method ?? "GET", new URL(String(input)), init.body);
			return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
		},
	};
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

/** F3 step 3's lines: the folder service's writes through a machine's view (RUNTIME-FOLDER-WRITES.md). */
const SERVICE_LINES = [
	"new files written through a machine's view are staged through the object gateway, published as one change set, catalogued and read back",
	"an edit in place, based on the version the machine read, saves",
	"a stale save is kept as a conflict copy on its receipt, and the live file stays the other writer's",
	"a boundary whose answer was lost is asked again under the same key, and saves once",
	"a new folder, a move and deletes publish as the core's units",
];

/** F3 step 4c's lines: a company machine's reads, released through its desktop view (RUNTIME-FOLDER-SERVICE.md). */
const READ_LINES = [
	"a read a company machine logged is released through its desktop view into the view's read set " +
		"(and its holder run's) before the boundary's change set, which saves; asked again under the same id, the core " +
		"replays it",
	"once the read's folder narrows, the view's boundaries are refused (denied: a read is no longer readable) " +
		"and save nothing",
	"a read logged but not released when its folder narrowed refuses the boundary that would release it (unreadable) " +
		"before any commit, and every later one, under the same release id",
];

class Report {
	results = new Map();
	/** What the company mode's cleanup left in place, and why; and, on the hosted run, whether it kept a member's write. */
	cleanup = [];
	cleanupFailure = null;
	/** Lines printed after the results (the folder service's log, when a line failed). */
	notes = [];

	constructor(prefix = "C5", lines = LINES) {
		this.prefix = prefix;
		this.lines = lines;
	}

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
		this.lines.forEach((text, index) => {
			const result = this.results.get(index + 1) ?? { state: "NOT RUN", detail: "not reached" };
			if (result.state === "FAIL") failed++;
			process.stdout.write(`${this.prefix}-${String(index + 1).padStart(2, "0")} ${result.state.padEnd(7)} ${text}${result.detail ? ` — ${result.detail}` : ""}\n`);
		});
		for (const line of this.notes) process.stdout.write(`${line}\n`);
		for (const line of this.cleanup) process.stdout.write(`Cleanup: ${line}\n`);
		if (this.cleanupFailure) {
			failed++;
			process.stdout.write(`Cleanup FAIL ${this.cleanupFailure}\n`);
		}
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
		// A copy, not a database made like the first: on a cluster of this script's own that replays the test bootstrap,
		// whose cluster-wide roles exist by then.
		database.cluster.drop(readsDatabase);
		database.cluster.admin(`create database ${readsDatabase} template ${databaseName};`);
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

		// F3 step 3: a machine's writes through the folder service, on the same company.
		const service = new Report("F3-3c", SERVICE_LINES);
		report.serviceReport = service;
		try {
			await serviceWrites(service, { db, code, objectRoot, store, replication, env, profileId, member, commit, writeUnit, entry, saved });
		} catch (error) {
			const detail = `the folder service did not start: ${(error?.message ?? String(error)).split("\n")[0].slice(0, 300)}`;
			SERVICE_LINES.forEach((_, index) => {
				if (!service.results.has(index + 1)) service.results.set(index + 1, { state: "FAIL", detail });
			});
		}

		// F3 step 4c: a company machine's reads through its desktop view, on SQL test 639's company.
		const reads = new Report("F3-4c", READ_LINES);
		report.readsReport = reads;
		try {
			await machineReads(reads, { cluster: database.cluster, code, objectRoot });
		} catch (error) {
			// The first line, and psql's error where it gave one.
			const lines = (error?.message ?? String(error)).split("\n");
			const why = lines.find((line) => /\bERROR:/.test(line))?.trim();
			const detail = `the read releases did not start: ${[lines[0], why].filter(Boolean).join(" ").slice(0, 500)}`;
			READ_LINES.forEach((_, index) => {
				if (!reads.results.has(index + 1)) reads.results.set(index + 1, { state: "FAIL", detail });
			});
		}

		// The --company mode's own checks, on the company founded here (with --write), so they run on every suite.
		// While it runs, a member writes a note under its scratch folder before the script's next commits: the cleanup
		// must leave the folder, and the note, in place.
		const second = new Report();
		let note = null;
		await existing(second, db, code, profileId, true, objectRoot, {
			afterScratch: async (scratchRoot) => {
				note = `${scratchRoot}/a/note.md`;
				saved(await commit(env, "foreign-note", [await writeUnit(env, note, "A member's note.\n")]), "the member's note");
			},
		});
		if (!note) second.cleanupFailure = "the scratch folder was never made, so the cleanup was not tried against a member's write";
		else if (entry(env, note)?.kind !== "file") second.cleanupFailure = `the cleanup deleted a member's write (${note})`;
		else if (!second.cleanup.some((line) => line.startsWith(note.slice(0, note.length - "/a/note.md".length))))
			second.cleanupFailure = "the cleanup did not say it left the scratch folder in place";
		report.companyReport = second;
	} finally {
		if (scratch) await rm(scratch, { recursive: true, force: true });
		database.cluster.drop(readsDatabase);
		database.close();
	}
}

/** F3 step 3 on the company founded above (RUNTIME-FOLDER-WRITES.md): the node folder service as built, with a writable
 * operator mount, takes a machine's writes through its view (the calls the protocol's frames make), stages their bytes
 * through the object gateway's folder service route (served here, over HTTP), and publishes each boundary with the real
 * commit. Both reach the database through `postgrest(db)`, as their clients call PostgREST. */
async function serviceWrites(report, context) {
	const { db, code, objectRoot, store, replication, env, profileId, member, commit, writeUnit, entry, saved } = context;
	const CHUNK = 4 * 1024 * 1024;
	const PART = 1024 * 1024;
	const origin = "https://postgrest.acceptance.invalid";
	const standIn = "acceptance-stand-in";
	const stand = postgrest(db);
	const authority = new code.SupabaseObjectAuthority({
		projectUrl: origin,
		publishableKey: standIn,
		secretKey: standIn,
		fetch: stand.fetch,
	});
	const token = () => randomBytes(32).toString("base64url");
	const serviceToken = token();
	const gateway = code.createObjectGatewayHandler({
		store,
		authority,
		controlToken: token(),
		replication,
		folderServiceObjects: { token: serviceToken, authority },
	});
	let puts = 0;
	const server = createServer((request, response) => {
		response.once("finish", () => {
			if (request.url?.startsWith("/v1/folder-service-objects/") && [200, 201].includes(response.statusCode)) puts++;
		});
		gateway(request, response);
	});
	await new Promise((listening, failed) => {
		server.once("error", failed);
		server.listen(0, "127.0.0.1", listening);
	});
	const logs = [];
	let service;
	let view;
	let finished = false;
	try {
		// The core as built, but an answer can be lost on its way back (line 4): the commit has run when one is.
		const core = new (class extends code.SupabaseFolderCore {
			lose = 0;
			commits = [];
			async commit(environmentId, actor, operationKey, units, signal) {
				const answer = await super.commit(environmentId, actor, operationKey, units, signal);
				this.commits.push({ key: operationKey, commitId: answer.commitId, ops: units.map((unit) => unit.op) });
				if (this.lose > 0) {
					this.lose--;
					throw new Error("the answer was lost on its way back");
				}
				return answer;
			}
		})({ projectUrl: origin, secretKey: standIn, transport: stand.transport });
		const objects = new code.NasObjects({ root: objectRoot, cacheBytes: 64 * 1024 * 1024 });
		const uploads = new code.GatewayUploads({ url: `http://127.0.0.1:${server.address().port}/`, token: serviceToken });
		const machine = { project: "acceptance", name: "acceptance-machine", physicalId: "90300000-0000-4000-8000-0000000000c1" };
		const pass = token();
		const grants = new code.MountGrants(
			code.parseOperatorMounts([
				{ id: "acceptance", environmentId: env, actor: member, machine, passSha256: sha256hex(pass), write: true },
			]),
		);
		service = new code.FolderService({
			core,
			objects,
			grants,
			staging: new code.FolderStaging(core, uploads, objects),
			log: (line) => logs.push(line),
		});
		view = await service.open(
			{ protocol: 2, environmentId: env, viewId: "acceptance", pass, role: "io" },
			{ cid: 3, lookup: "found", machine },
		);
		assert(view.writable, "the operator mount's view takes writes");

		// As the machine's program writes a file: open, each 4 MiB chunk in parts of at most 1 MiB, close.
		const save = async (path, bytes, base) => {
			const { handle } = await view.open({ path, ...(base ? { base } : {}), create: true, exclusive: false, truncate: true });
			for (let index = 0; index * CHUNK < bytes.length; index++) {
				const chunk = bytes.subarray(index * CHUNK, (index + 1) * CHUNK);
				const sha256 = sha256hex(chunk);
				for (let offset = 0; offset < chunk.length; offset += PART)
					await view.chunk({ handle, index, sha256, bytes: chunk.length, offset, data: chunk.subarray(offset, offset + PART) });
			}
			return view.close(handle, bytes.length);
		};
		const listed = async (folder) => new Map((await view.list(folder, undefined)).entries.map((e) => [e.name, e]));
		const readBack = async (folder, name) => {
			const file = (await listed(folder)).get(name);
			assert(file, `${folder}/${name} is not listed`);
			const parts = [];
			for (let offset = 0; offset < file.size; offset += PART)
				parts.push(await view.read({ path: `${folder}/${name}`, version: file.version, offset, length: Math.min(PART, file.size - offset) }));
			return Buffer.concat(parts);
		};
		const published = async (what) => {
			const answer = await view.publish();
			if (!answer.paths.length || answer.paths.some((p) => p.outcome !== "saved"))
				throw new Error(`${what} did not save: ${JSON.stringify(answer)}`);
			return answer;
		};
		/** The units of the boundary's own commit. */
		const ops = (answer) => {
			const last = core.commits.at(-1);
			assert.equal(last?.commitId, answer.commitId, "the boundary's own commit");
			return last.ops;
		};
		const live = (path) => entry(env, path);
		const chunksOf = (manifest) =>
			db.json(`select coalesce(jsonb_agg(chunk_sha256 order by chunk_sha256), '[]') from public.qorpera_folder_file_chunks
				where profile_id = ${literal(profileId)} and manifest_sha256 = ${literal(manifest)}`);

		const small = Buffer.from("# Machine notes\n\nWritten on the machine.\n");
		const data = randomBytes(CHUNK + 100 * 1024);
		await report.check(1, async () => {
			await view.mkdir("machine");
			await save("machine/small.md", small);
			await save("machine/data.bin", data);
			const answer = await published("the machine's new folder");
			assert.deepEqual(ops(answer), ["new_folder"], "a new folder with new content is one unit");
			assert.equal(live("machine/small.md")?.file_sha256, sha256hex(small), "small.md's bytes");
			const stored = live("machine/data.bin");
			assert.equal(stored?.file_sha256, sha256hex(data), "data.bin's bytes");
			assert.deepEqual(
				chunksOf(stored.manifest_sha256),
				[sha256hex(data.subarray(0, CHUNK)), sha256hex(data.subarray(CHUNK))].sort(),
				"data.bin's two chunks",
			);
			const uncatalogued = db.json(`select coalesce(jsonb_agg(h), '[]') from (
					select e.manifest_sha256 h from public.qorpera_folder_entries e
					where e.environment_id = ${literal(env)} and e.kind = 'file' and e.path like 'machine/%'
					union
					select c.chunk_sha256 from public.qorpera_folder_entries e
					join public.qorpera_folder_file_chunks c on c.profile_id = ${literal(profileId)} and c.manifest_sha256 = e.manifest_sha256
					where e.environment_id = ${literal(env)} and e.kind = 'file' and e.path like 'machine/%'
				) objects
				where not exists (select 1 from public.qorpera_profile_objects o where o.profile_id = ${literal(profileId)} and o.sha256 = h)`);
			assert.deepEqual(uncatalogued, [], "every manifest and chunk is catalogued");
			assert(puts > 0, "nothing was put through the gateway's folder service route");
			assert(small.equals(await readBack("machine", "small.md")), "small.md reads back");
			assert(data.equals(await readBack("machine", "data.bin")), "data.bin reads back");
			return `${puts} objects put through the gateway's folder service route, change set ${answer.seq}`;
		});

		const edited = Buffer.from("# Machine notes\n\nEdited on the machine.\n");
		await report.check(2, async () => {
			const base = (await listed("machine")).get("small.md")?.version;
			assert.equal(base, live("machine/small.md")?.version, "the view lists the live version");
			await save("machine/small.md", edited, base);
			const answer = await published("the edit");
			assert.deepEqual(ops(answer), ["write"]);
			assert.equal(live("machine/small.md")?.file_sha256, sha256hex(edited), "the edit's bytes");
			assert(edited.equals(await readBack("machine", "small.md")), "the edit reads back");
		});

		await report.check(3, async () => {
			saved(await commit(env, "machine-stale-1", [await writeUnit(env, "machine/stale.md", "One.\n")]), "stale.md");
			await service.poll();
			await service.settled();
			const read = (await listed("machine")).get("stale.md")?.version;
			assert.equal(read, live("machine/stale.md")?.version, "the view caught up with the feed");
			saved(await commit(env, "machine-stale-2", [await writeUnit(env, "machine/stale.md", "Two.\n", read)]), "the other save");
			const mine = Buffer.from("Mine, written from One.\n");
			await save("machine/stale.md", mine, read);
			const answer = await view.publish();
			assert.equal(answer.paths.length, 1, JSON.stringify(answer));
			const [conflict] = answer.paths;
			assert.equal(conflict.outcome, "conflict", JSON.stringify(answer));
			assert.equal(conflict.reason, "version_changed");
			assert(answer.commitId && conflict.receipt === answer.commitId, `no receipt: ${JSON.stringify(answer)}`);
			assert(!conflict.kept, "the copy keeps the bytes, so the view does not");
			const copies = db.json(`select coalesce(jsonb_agg(c.file_sha256), '[]') from public.qorpera_folder_conflict_copies c
				where c.commit_id = ${literal(answer.commitId)}`);
			assert.deepEqual(copies, [sha256hex(mine)], "one conflict copy on the receipt, of the machine's bytes");
			assert.equal(live("machine/stale.md")?.file_sha256, sha256hex(Buffer.from("Two.\n")), "the live file is the other save");
			await service.poll();
			await service.settled();
			assert.equal((await listed("machine")).get("stale.md")?.version, live("machine/stale.md")?.version, "the view shows it");
			return `receipt ${answer.commitId}`;
		});

		await report.check(4, async () => {
			core.lose = 3;
			const lost = Buffer.from("Saved once.\n");
			await save("machine/lost.md", lost);
			const first = await view.publish();
			assert(
				first.paths.length > 0 &&
					first.paths.every((p) => p.outcome === "not_applied" && p.reason === "the save did not get through yet" && p.kept),
				`not kept for later: ${JSON.stringify(first)}`,
			);
			assert.equal(live("machine/lost.md")?.file_sha256, sha256hex(lost), "the commit ran, though its answer was lost");
			const key = core.commits.at(-1).key;
			await published("the boundary asked again");
			const asked = core.commits.filter((c) => c.key === key);
			assert.equal(asked.length, 4, "three lost answers, then one that came back");
			assert.equal(new Set(asked.map((c) => c.commitId)).size, 1, "every ask answered the one change set");
			assert.equal(
				db.query(`select count(*) from public.qorpera_folder_commits where environment_id = ${literal(env)}
					and operation_key = ${literal(key)}`),
				"1",
			);
			assert(logs.some((line) => line.includes("commit not answered")), "the lost answers were logged");
			assert(lost.equals(await readBack("machine", "lost.md")), "lost.md reads back");
		});

		await report.check(5, async () => {
			await view.mkdir("machine/fresh");
			await save("machine/fresh/inside.md", Buffer.from("Inside a new folder.\n"));
			assert.deepEqual(ops(await published("the new folder")), ["new_folder"]);
			const before = await listed("machine");
			await view.rename({ from: "machine/small.md", fromBase: before.get("small.md")?.version, to: "machine/fresh/moved.md", noReplace: true });
			await view.unlink("machine/data.bin", before.get("data.bin")?.version);
			assert.deepEqual([...ops(await published("the move and the delete"))].sort(), ["delete", "move"]);
			assert.equal(live("machine/small.md"), null, "small.md moved away");
			assert.equal(live("machine/data.bin"), null, "data.bin is deleted");
			assert.equal(live("machine/fresh/moved.md")?.file_sha256, sha256hex(edited), "the moved file keeps its bytes");
			const fresh = await listed("machine/fresh");
			await view.unlink("machine/fresh/inside.md", fresh.get("inside.md")?.version);
			await view.unlink("machine/fresh/moved.md", fresh.get("moved.md")?.version);
			await view.rmdir("machine/fresh", (await listed("machine")).get("fresh")?.version);
			assert.deepEqual(ops(await published("the folder's removal")), ["delete"], "one delete for the removed folder");
			assert.equal(
				db.query(`select count(*) from public.qorpera_folder_entries where environment_id = ${literal(env)} and kind <> 'claim'
					and (path = 'machine/fresh' or path like 'machine/fresh/%')`),
				"0",
				"the folder and its files are gone",
			);
		});
		finished = true;
	} finally {
		view?.release();
		service?.stop();
		server.closeAllConnections();
		await new Promise((closed) => server.close(closed));
		if (!finished || [...report.results.values()].some((r) => r.state === "FAIL"))
			report.notes.push(...logs.map((line) => `Folder service: ${line}`));
	}
}

/** F3 step 4c (RUNTIME-FOLDER-SERVICE.md, "Step 4c: read releases") on a database of its own (`readsDatabase`)
 * with SQL test 639's company, its fixture committed: a run holds agent A's screen, and the company machine on its
 * allocation presents the desktop view the core opened for it. The node folder service as built takes the reads the
 * machine's program logs (the calls the protocol's `I` frame makes) and releases them to the core, as the view, before
 * each boundary's commit, through `postgrest(db)`. The boundaries make folders only, so nothing is staged. */
async function machineReads(report, { cluster, code, objectRoot }) {
	const name = readsDatabase;
	const ENV = "63200000-0000-4000-8000-000000000020";
	const OWNER_639 = "63200000-0000-4000-8000-000000000001";
	const ALLOCATION = "63900000-0000-4000-8000-0000000000e1";
	const LOG = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d";
	const logs = [];
	let core;
	let service;
	let view;
	let finished = false;
	try {
		const db = new Database(
			(sql) => cluster.psql(name, sql, ["-qAt"]),
			() => cluster.spawnPsql(name, ["-qAt", "-v", "ON_ERROR_STOP=1"]),
		);
		const views = expandTestFixture("639_folder_core_views.test.sql", (file) =>
			readFileSync(join(repositoryRoot, "supabase/tests", file), "utf8"),
		);
		const end = views.indexOf("-- A run box: opened by its run");
		if (end < 0) throw new Error("SQL test 639's run box section moved: update this script");
		// Two folders the machine reads, and a run holding agent A's screen, with the desktop view the core opened for
		// it.
		const out = db.query(`${views.slice(0, end)}
			create temp table reads_opened(what text primary key, value jsonb not null);
			do $reads$
			declare v jsonb; r jsonb := pg_temp.commit('{"kind":"platform"}', 'reads-setup', jsonb_build_array(
				jsonb_build_object('op','mkdir','path','reads'),
				jsonb_build_object('op','write','path','reads/r.txt','file',pg_temp.stage('read')),
				jsonb_build_object('op','mkdir','path','later'),
				jsonb_build_object('op','write','path','later/l.txt','file',pg_temp.stage('later'))));
			begin
				for n in 1..4 loop perform pg_temp.expect(r, n, 'saved'); end loop;
				v := pg_temp.run('human', '63200000-0000-4000-8000-000000000002');
				perform pg_temp.hold(v);
				insert into reads_opened values ('run', v), ('view', pg_temp.open('computer_desktop',
					jsonb_build_object('screenId', '63900000-0000-4000-8000-0000000000e4', 'holderRunId', v ->> 'runId')));
			end $reads$;
			-- 639 rolls back, so its office never needed the logical computer it names; this commits, and the office's
			-- deferred foreign key is checked then.
			set local session_replication_role = replica;
			insert into public.qorpera_logical_computers(id, profile_id, client_computer_id, display_name, template_key,
				template_version, capabilities, created_by_user_id, computer_class)
			select logical_computer_id, profile_id, client_computer_id, 'Reads', 'qorpera-office', 'v1', '["company_substrate"]',
				created_by_user_id, 'company_computer'
			from public.qorpera_runtime_offices where id = '63900000-0000-4000-8000-0000000000e0';
			set local session_replication_role = origin;
			select '@@reads-' || what || ' ' || value::text from reads_opened;
			commit;`);
		const opened = Object.fromEntries(
			[...out.matchAll(/^@@reads-([a-z]+) (.*)$/gm)].map(([, what, value]) => [what, JSON.parse(value)]),
		);
		const { run, view: desktop } = opened;
		assert(run?.runId && desktop?.viewId && desktop?.pass, `the desktop view was not opened: ${out.slice(-300)}`);

		// The core as built, noting each release and commit the service asks, and what the database said to it.
		core = new (class extends code.SupabaseFolderCore {
			calls = [];
			async noted(call, ask) {
				this.calls.push(call);
				try {
					return await ask();
				} catch (error) {
					call.said = error?.said ?? error?.message ?? String(error);
					throw error;
				} finally {
					call.done = true;
				}
			}
			releaseReads(environmentId, actor, releaseId, reads, signal) {
				return this.noted({ call: "release", releaseId, reads, said: null, done: false }, () =>
					super.releaseReads(environmentId, actor, releaseId, reads, signal),
				);
			}
			commit(environmentId, actor, operationKey, units, signal) {
				return this.noted({ call: "commit", key: operationKey, said: null, done: false }, () =>
					super.commit(environmentId, actor, operationKey, units, signal),
				);
			}
		})({
			projectUrl: "https://postgrest.acceptance.invalid",
			secretKey: "acceptance-stand-in",
			transport: postgrest(db).transport,
		});
		const objects = new code.NasObjects({ root: objectRoot, cacheBytes: 64 * 1024 * 1024 });
		const uploads = {
			start() {
				throw new Error("Nothing is staged here: these boundaries make folders only");
			},
		};
		service = new code.FolderService({
			core,
			objects,
			grants: new code.MountGrants([], [], ["acceptance-office"]),
			staging: new code.FolderStaging(core, uploads, objects),
			log: (line) => logs.push(line),
		});
		// The company machine named after the view's allocation, in a company machine project.
		const machine = {
			project: "acceptance-office",
			name: `qorpera-office-${ALLOCATION.replaceAll("-", "")}`,
			physicalId: "63900000-0000-4000-8000-0000000000c3",
		};
		view = await service.open(
			{ protocol: 3, environmentId: ENV, viewId: desktop.viewId, pass: desktop.pass, role: "io" },
			{ cid: 3, lookup: "found", machine },
		);
		assert(view.writable && view.core, "the desktop view takes writes, as a core view");

		const listed = async (folder) => new Map((await view.list(folder, undefined)).entries.map((e) => [e.name, e]));
		const live = (path) =>
			db.json(`select to_jsonb(e) from public.qorpera_folder_entries e where e.environment_id = ${literal(ENV)}
				and e.key_text = public.qorpera_folder_key(${literal(path)}) and e.kind <> 'claim'`);
		/** The reads filed for the view (`view`) or its holder run (`run`), as [path, version] pairs. */
		const recorded = (owner) =>
			db.json(`select coalesce(jsonb_agg(jsonb_build_array(x ->> 'path', x ->> 'version') order by x ->> 'path'),
				'[]') from public.qorpera_folder_${owner}_read_records rec, jsonb_array_elements(rec.reads) x
				where rec.${owner}_id = ${literal(owner === "view" ? desktop.viewId : run.runId)}`);
		/** A read log entry, as the machine's program logs a read of a listed entry. */
		const logged = (seq, path, entry) => ({
			seq,
			path,
			version: entry.version,
			...(entry.authority ? { authority: entry.authority } : {}),
		});
		const since = (mark, call) => core.calls.slice(mark).filter((c) => c.call === call);
		const narrow = (path) =>
			db.rpc("qorpera_folder_set_resource", {
				p_environment_id: ENV,
				p_actor: { kind: "member", userId: OWNER_639 },
				p_path: path,
				p_match: "subtree",
				p_scope: "company_shared",
				p_policy: "normal",
			});

		await report.check(1, async () => {
			const listing = (await listed("reads")).get("r.txt");
			assert.equal(listing?.version, live("reads/r.txt")?.version, "the view lists the live version");
			const mark = core.calls.length;
			assert.deepEqual(
				await view.reads({ log: LOG, reads: [logged(1, "reads/r.txt", listing)], lost: false }),
				{ log: LOG, taken: 1, released: 0 },
				"the read is taken, not released yet",
			);
			assert.deepEqual(recorded("view"), [], "nothing is released before a boundary");
			await view.mkdir("shared/by-reads");
			const answer = await view.publish();
			assert(answer.commitId, `the boundary did not save: ${JSON.stringify(answer)}`);
			assert.deepEqual(answer.paths, [{ path: "shared/by-reads", outcome: "saved" }]);
			const asked = core.calls.slice(mark);
			const first = asked.findIndex((c) => c.call === "release");
			const committed = asked.findIndex((c) => c.call === "commit");
			assert(first >= 0 && first < committed, "the read is released before the commit");
			const release = asked[first];
			const read = [["reads/r.txt", live("reads/r.txt").version]];
			assert.deepEqual(release.reads.map((r) => [r.path, r.version]), read, "the release carries the logged read");
			assert.deepEqual(recorded("view"), read, "the view's read set");
			assert.deepEqual(recorded("run"), read, "its holder run's read set");
			assert.deepEqual(await view.reads({ log: LOG, reads: [], lost: false }), { log: LOG, taken: 1, released: 1 });
			const actor = { kind: "view", viewId: desktop.viewId, pass: desktop.pass };
			const again = await core.releaseReads(ENV, actor, release.releaseId, release.reads);
			assert.equal(again.replay, true, "asked again under its id, the release is replayed");
			const receipt = listing.authority ? "the listing's receipt" : "no receipt";
			return `release ${release.releaseId} (${receipt}) before change set ${answer.seq}`;
		});

		await report.check(2, async () => {
			narrow("reads");
			for (const n of [1, 2]) {
				const path = `shared/refused-${n}`;
				const mark = core.calls.length;
				await view.mkdir(path);
				assert.deepEqual(await view.publish(), {
					commitId: null,
					seq: null,
					refused: "denied",
					paths: [{ path, outcome: "refused", reason: "denied" }],
				});
				assert.deepEqual(since(mark, "release"), [], "nothing was left to release");
				const commits = since(mark, "commit").filter((c) => c.done);
				assert(
					commits.length > 0 && commits.every((c) => c.said === "A read is no longer readable"),
					`the commits said: ${JSON.stringify(commits.map((c) => c.said))}`,
				);
				assert.equal(live(path), null, `${path} is not saved`);
			}
		});

		await report.check(3, async () => {
			const read = (await listed("later")).get("l.txt");
			assert.equal(read?.version, live("later/l.txt")?.version, "the view lists the live version");
			narrow("later");
			const mark = core.calls.length;
			assert.deepEqual(await view.reads({ log: LOG, reads: [logged(2, "later/l.txt", read)], lost: false }), {
				log: LOG,
				taken: 2,
				released: 1,
			});
			await view.mkdir("shared/refused-3");
			const refused = {
				commitId: null,
				seq: null,
				refused: "unreadable",
				paths: [{ path: "shared/refused-3", outcome: "refused", reason: "unreadable", kept: true }],
			};
			assert.deepEqual(await view.publish(), refused, "the boundary that would release the read");
			assert.deepEqual(await view.publish(), refused, "a later boundary");
			assert.deepEqual(since(mark, "commit"), [], "no commit was asked");
			const releases = since(mark, "release").filter((c) => c.done);
			assert(
				releases.length >= 2 && releases.every((c) => c.said === "A released read is no longer readable"),
				`the releases said: ${JSON.stringify(releases.map((c) => c.said))}`,
			);
			assert.equal(new Set(releases.map((c) => c.releaseId)).size, 1, "asked again under the same release id");
			assert.deepEqual(await view.reads({ log: LOG, reads: [], lost: false }), { log: LOG, taken: 2, released: 1 });
			const sets = [...recorded("view"), ...recorded("run")];
			assert(!sets.some(([path]) => path === "later/l.txt"), "no read set holds the refused read");
			assert.equal(live("shared/refused-3"), null, "shared/refused-3 is not saved");
			return `release ${releases[0].releaseId}, asked ${releases.length} times`;
		});
		finished = true;
	} finally {
		// Let go, the view publishes once more what it still holds (line 3's refused read): that finishes before the
		// database goes.
		view?.release();
		for (let seen = -1, round = 0; core && round < 100; round++) {
			if (seen === core.calls.length && core.calls.every((c) => c.done)) break;
			seen = core.calls.length;
			await new Promise((turn) => setTimeout(turn, 100));
		}
		service?.stop();
		if (!finished || [...report.results.values()].some((r) => r.state === "FAIL"))
			report.notes.push(...logs.map((line) => `Folder service: ${line}`));
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// An existing company (P38's proof company, a founder's first company): read-only, or with --write under a scratch
// folder it removes again.

/** The checks for an existing company. `objectRoot` is the object share to read bytes from, when there is one. */
async function existing(report, db, code, profileId, write, objectRoot, hooks = {}) {
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
	/** The sequence number of this run's last change under the scratch folder, which the move and the stale delete below
	 * are made as of. */
	let scratchSeq = 0;
	/** This run's own commits. A delete goes only through a subtree whose every entry one of them wrote. */
	const ours = new Set();
	let keys = 0;
	const key = (label) => `acceptance-${scratchRoot.slice(11)}-${label}-${++keys}`;
	const commit = (units) => {
		const answer = db.rpc("qorpera_folder_commit", { p_environment_id: env, p_actor: platform, p_operation_key: key("c"),
			p_units: units });
		if (answer?.seq) scratchSeq = Math.max(scratchSeq, Number(answer.seq));
		if (answer?.commitId) ours.add(answer.commitId);
		return answer;
	};
	/** Deletes a folder this run made, only if every entry in it is still as one of this run's commits left it. The check
	 * and the clock are one snapshot, and the delete is made as of that clock: anything written there before the snapshot
	 * shows as another commit's entry, and anything after it refuses the delete (unseen_change). */
	const guardedDelete = (path) => {
		const seen = db.json(`select jsonb_build_object('seq', c.last_seq,
				'version', (select e.version from public.qorpera_folder_entries e where e.environment_id = c.environment_id
					and e.key_text = public.qorpera_folder_key(${literal(path)}) and e.kind <> 'claim'),
				'others', (select coalesce(jsonb_agg(e.path order by e.path), '[]') from public.qorpera_folder_entries e
					where e.environment_id = c.environment_id and e.kind <> 'claim'
						and (e.key_text = public.qorpera_folder_key(${literal(path)})
							or e.key_text like public.qorpera_folder_under(public.qorpera_folder_key(${literal(path)})))
						and not e.commit_id = any (${literal(`{${[...ours].join(",")}}`)}::uuid[])))
			from public.qorpera_folder_clocks c where c.environment_id = ${literal(env)}`);
		if (!seen?.version) return { left: "it is gone" };
		if (seen.others.length) return { left: `others wrote ${seen.others.slice(0, 3).join(", ")}${seen.others.length > 3 ? ", …" : ""}` };
		const answer = commit([{ op: "delete", path, expectedVersion: seen.version, asOfSeq: Number(seen.seq) }]);
		const unit = answer?.units?.[0];
		if (!unit) throw new Error(`${path}'s delete: ${JSON.stringify(answer)}`);
		return unit.outcome === "saved" ? { saved: true } : { left: `its delete was ${unit.outcome} (${unit.reason ?? "no reason"})` };
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
			ours.add(a.commitId);
			ours.add(b.commitId);
			await hooks.afterScratch?.(scratchRoot);
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
		const deleted = guardedDelete(`${scratchRoot}/n`);
		if (!deleted.saved) throw new Error(`the subtree delete: ${scratchRoot}/n left in place, ${deleted.left}`);
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

	// The scratch folder goes again, then acceptance/ when this run made it, each only while everything in it is still this
	// run's own (guardedDelete); otherwise it stays for whoever wrote there. Their history stays, as any change's does.
	const tidy = (path) => {
		const done = guardedDelete(path);
		if (!done.saved) report.cleanup.push(`${path} left in place: ${done.left}`);
		return done.saved === true;
	};
	if (write && entry(scratchRoot) && tidy(scratchRoot) && createdParent && entry("acceptance")) tidy("acceptance");

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
	if (report.serviceReport) {
		process.stdout.write("The folder service's writes through a machine's view (F3 step 3), on the company founded above:\n");
		failed += report.serviceReport.print();
	}
	if (report.readsReport) {
		process.stdout.write("The folder service's read releases (F3 step 4c), on the views test's company (639):\n");
		failed += report.readsReport.print();
	}
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
