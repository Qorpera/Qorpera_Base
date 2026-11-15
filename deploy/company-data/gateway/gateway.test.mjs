/* The data gateway (deploy/first-node/RUNTIME-COMPANY-DATABASES.md §3) against a real PostgreSQL 17: the store is set
 * up from store/cluster.sql and store/template.sql, as the proof does, in a throwaway container on a random loopback
 * port (2 CPUs, 4 GiB, removed at the end). The platform is a stand-in: an in-memory company folder per company with
 * read rights per member, answering the two folder reads the gateway makes in the shapes the platform gives. The
 * gateway is driven over its own HTTP side. Limits are small, so the file runs in well under a minute. The run door
 * (SLICE5) is driven over its own listener, with a stand-in for the platform's data passes.
 * Run on a test machine: node --test deploy/company-data/gateway/gateway.test.mjs */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { checkLocale, LOCALE_QUERY, POSTGRES_IMAGE, POSTGRES_LOCALE } from "../../../scripts/test-hosted-db.mjs";
import { companyDatabase, folderPassword, Gateway, LIMITS, listMembers, Platform, serve, serveRuns } from "./gateway.mjs";

const dockerUsable = process.platform === "linux" && spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const storeFile = (name) => readFileSync(new URL(`../store/${name}`, import.meta.url));

const LIMITS_HERE = {
	...LIMITS,
	questionMs: 300,
	questionRows: 50,
	questionBytes: 4096,
	stepMs: 5_000,
	stepLockMs: 1_000,
	watchMs: 4_000,
	watchAgainMs: 50,
	proofMs: 0,
	bodyBytes: 8192,
	agentMs: 4_000,
	agentRows: 20,
	agentBytes: 2048,
	changeBytes: 64 * 1024,
};
/** The node's private token the run door takes. */
const RUN_TOKEN = randomBytes(32).toString("base64url");

// ---- two companies and their members
const ENV_A = "64000000-0000-4000-8000-0000000000a0";
const ENV_B = "64000000-0000-4000-8000-0000000000b0";
const ENV_C = "64000000-0000-4000-8000-0000000000c0";
/** A company whose databases only agents' runs make and ask. */
const ENV_D = "64000000-0000-4000-8000-0000000000d0";
const ENV_E = "64000000-0000-4000-8000-0000000000e0";
const person = (n) => `64000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const OWNER = person(1);
const CONTRIBUTOR = person(2);
const VIEWER = person(3);
const STRANGER = person(9);
const B_MEMBER = person(11);
const MEMBERS = {
	[ENV_A]: new Set([OWNER, CONTRIBUTOR, VIEWER]),
	[ENV_B]: new Set([B_MEMBER]),
	[ENV_C]: new Set([OWNER]),
	[ENV_D]: new Set([OWNER, VIEWER]),
	[ENV_E]: new Set([OWNER, CONTRIBUTOR, VIEWER]),
};
const WRITERS = new Set([OWNER, CONTRIBUTOR]);
let writeCheckMissing = false;
/** Folders only one member may read, as a path resource of scope member_private makes them. */
const PRIVATE = { [ENV_A]: { "data/hr": CONTRIBUTOR }, [ENV_B]: {}, [ENV_C]: {}, [ENV_D]: { "data/diary": VIEWER }, [ENV_E]: {} };

// ---- the stand-in platform: the folders, the tokens it knows, and its two reads
const FOLDERS = { [ENV_A]: new Map(), [ENV_B]: new Map(), [ENV_C]: new Map(), [ENV_D]: new Map(), [ENV_E]: new Map() };
const TEXTS = new Map();
const put = (env, files) => {
	for (const [path, text] of Object.entries(files)) {
		FOLDERS[env].set(path, text);
		TEXTS.set(sha256(text), text);
	}
};
const remove = (env, path) => FOLDERS[env].delete(path);
const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const KNOWN = new Map();
/** A token the platform knows. Unsigned: the gateway only reads its `sub`, and the stand-in decides who is known. */
const tokenOf = (userId) => {
	const token = `${part({ alg: "none", typ: "JWT" })}.${part({ role: "authenticated", sub: userId })}.unsigned`;
	KNOWN.set(token, userId);
	return token;
};
const mayRead = (env, userId, path) =>
	MEMBERS[env]?.has(userId) === true &&
	Object.entries(PRIVATE[env] ?? {}).every(([folder, only]) => only === userId || !(path === folder || path.startsWith(`${folder}/`)));
/** Data passes the stand-in made, by pass: what it kept, whether it was redeemed, and until when it lasts. */
const PASSES = new Map();
/** A run's data pass, as qorpera_run_data_pass makes it: database.toml and the files directly in tables/, queries/ and
 * actions/ of the database named (or of every database) that the run's requester may read. `allow`: a held step a
 * member said yes to, which only the platform puts in a pass. */
const passFor = (env, userId, database = null, { ms = 60_000, allow = undefined, machine = false } = {}) => {
	const files = [...FOLDERS[env]]
		.filter(([path]) => {
			const at = /^data\/([a-z][a-z0-9_]{0,39})\/(database\.toml|(tables|queries|actions)\/[^/]+)$/.exec(path);
			return at && (database === null || at[1] === database) && FOLDERS[env].has(`data/${at[1]}/database.toml`) && mayRead(env, userId, `data/${at[1]}/database.toml`) && mayRead(env, userId, path);
		})
		.map(([path, text]) => ({ path, sha256: sha256(text), bytes: Buffer.byteLength(text) }));
	const pass = randomBytes(32).toString("base64url");
	PASSES.set(pass, {
		kept: {
			schema: "qorpera.data-pass-redeemed/v1",
			...(machine ? { kind: "machine", viewId: randomUUID(), machineId: randomUUID() } : { kind: "run", runId: randomUUID() }),
			environmentId: env,
			staffAgentId: randomUUID(),
			requesterUserId: userId,
			database,
			files,
			// The held step a member said yes to, as qorpera_run_data_pass_approved keeps it (20260930764000).
			...(allow === undefined ? {} : { allow }),
		},
		redeemed: false,
		until: Date.now() + ms,
	});
	return pass;
};
let platformCalls = 0;
async function platformFetch(url, init) {
	platformCalls++;
	const reply = (status, value) => ({ status, ok: status >= 200 && status < 300, json: async () => value });
	// The redeem goes with the publishable key alone.
	if (new URL(url).pathname === "/rest/v1/rpc/qorpera_data_pass_redeem") {
		if (init.method !== "POST" || init.headers.apikey !== "publishable" || init.headers.authorization !== undefined)
			return reply(400, { message: "bad request" });
		const held = PASSES.get(JSON.parse(init.body).p_pass);
		if (!held || held.redeemed || Date.now() >= held.until) return reply(200, null);
		held.redeemed = true;
		return reply(200, held.kept);
	}
	const token = /^Bearer (.+)$/.exec(init.headers.authorization ?? "")?.[1];
	if (init.method !== "POST" || init.headers.apikey !== "publishable") return reply(400, { message: "bad request" });
	if (!KNOWN.has(token)) return reply(401, { message: "JWT invalid" });
	const userId = KNOWN.get(token);
	const args = JSON.parse(init.body);
	const env = args.p_environment_id;
	const files = FOLDERS[env] ?? new Map();
	const entry = (path) => ({ path, kind: "file", fileSha256: sha256(files.get(path)), bytes: Buffer.byteLength(files.get(path)) });
	switch (new URL(url).pathname) {
		case "/rest/v1/rpc/qorpera_member_folder_read_many":
			return reply(200, {
				reads: args.p_paths.map((path) => (files.has(path) && mayRead(env, userId, path) ? { found: true, entry: entry(path) } : { found: false })),
			});
		case "/rest/v1/rpc/qorpera_member_folder_list": {
			if (!Number.isInteger(args.p_limit) || args.p_limit < 1 || args.p_limit > 1000) return reply(400, { code: "22023", message: "Listing is invalid" });
			const prefix = `${args.p_parent}/`;
			const folders = new Set(
				[...files.keys()]
					.filter((path) => path.startsWith(prefix) && path.slice(prefix.length).includes("/"))
					.map((path) => `${prefix}${path.slice(prefix.length).split("/")[0]}`)
					.filter((path) => mayRead(env, userId, path)),
			);
			const all = [
				...[...files.keys()].filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/") && mayRead(env, userId, path)).map(entry),
				...[...folders].map((path) => ({ path, kind: "folder" })),
			]
				.sort((a, b) => (a.path < b.path ? -1 : 1))
				.filter((one) => args.p_after === null || one.path > args.p_after);
			const entries = all.slice(0, args.p_limit);
			return reply(200, { entries, next: entries.length === args.p_limit ? entries.at(-1).path : null });
		}
		case "/rest/v1/rpc/qorpera_member_folder_may_write":
			if (writeCheckMissing) return reply(404, { code: "PGRST202", message: "Could not find the function" });
			return reply(200, {
				schema: "qorpera.member-folder-may-write/v1",
				path: args.p_path,
				write: MEMBERS[env]?.has(userId) === true && WRITERS.has(userId) && mayRead(env, userId, args.p_path),
			});
		default:
			return reply(404, { message: "no such function" });
	}
}

// ---- the files of company A's databases
const ORDERS = `create table orders (
	id bigint generated always as identity primary key,
	customer text not null,
	amount numeric(12,2) not null check (amount >= 0),
	status text not null default 'paid' check (status in ('paid', 'shipped', 'refunded')),
	placed_by uuid,
	placed_at timestamptz not null default now()
);
insert into orders (customer, amount, status, placed_at)
select 'Customer ' || n, 100 + (n % 7) * 25, case when n % 5 = 0 then 'shipped' else 'paid' end, now() - (n || ' hours')::interval
from generate_series(1, 240) n;
`;
const COUNT = "-- How many orders there are.\nselect count(*) as orders from orders;\n";
/** A value of the company's that must never reach the store's server log. */
const MARKER = `mark${randomBytes(6).toString("hex")}`;
/** Every name a question's statement in the gateway has used for its own: aliases, CTEs and added columns. */
const NAMES = [
	"qorpera_asked",
	"qorpera_inner",
	"qorpera_sized",
	"qorpera_made",
	"qorpera_answer",
	"qorpera_at",
	"qorpera_bytes_so_far",
	"qorpera_rows_made",
	"qorpera_bytes",
	"qorpera_rows",
];
put(ENV_A, {
	"data/shop/database.toml": 'format = "qorpera.database/v1"\nname = "Shop"\n',
	"data/shop/tables/001-orders.sql": ORDERS,
	"data/shop/tables/002-order-notes.sql":
		"alter table orders add column note text;\ncreate view order_totals as select status, count(*) as orders, sum(amount) as total from orders group by status;\n",
	"data/shop/queries/sales-since.sql":
		"-- What the shop sold since a day.\nselect count(*) as orders, coalesce(sum(amount), 0) as total from orders where placed_at >= :since::timestamptz;\n",
	"data/shop/queries/count.sql": COUNT,
	"data/shop/queries/by-status.sql": "select status, orders, total from order_totals order by status;\n",
	"data/shop/queries/mine.sql": "select count(*) as orders from orders where placed_by = :viewer::uuid;\n",
	"data/shop/queries/types.sql": `-- Every kind of value, as an answer gives it.
select 9007199254740993::bigint as big, 42::bigint as small, 7::int as whole, 1.5::float8 as double,
	12345678901234567890.123456789::numeric as precise, 12.50::numeric(10,2) as price, 0.1::numeric as tenth,
	true as yes, false as no, '{"a":[1,2]}'::jsonb as doc, '[1,"x"]'::json as list,
	'2026-11-13 10:00:00.5+01'::timestamptz as at, '2026-11-13 10:00:00'::timestamp as local,
	null::text as nothing, 'plain'::text as words;
`,
	"data/shop/queries/many.sql": "select n from generate_series(1, 100) n;\n",
	"data/shop/queries/wide.sql": "select repeat('x', 200) as text from generate_series(1, 40);\n",
	"data/shop/queries/wide-letters.sql": "select repeat('æ', 150) as text from generate_series(1, 20);\n",
	// Rows far past the answer's size: 8 rows of 1 MiB each, and one row of 1 MiB before a small one.
	"data/shop/queries/huge.sql": "select repeat('x', 1048576) as text from generate_series(1, 8);\n",
	"data/shop/queries/huge-first.sql": "select repeat('x', 1048576) as text union all select 'small';\n",
	"data/shop/queries/none.sql": "select n from generate_series(1, 0) n;\n",
	// Columns named like the names the gateway's statement uses, the old ones and the ones it has now.
	"data/shop/queries/shadow.sql": "select '' as qorpera_asked, repeat('x', 1048576) as payload;\n",
	"data/shop/queries/names.sql": `select ${NAMES.map((name, index) => `${index + 1} as ${name}`).join(", ")} from generate_series(1, 100);\n`,
	"data/shop/queries/names-wide.sql":
		"select repeat('x', 300) as qorpera_bytes_so_far, 1 as qorpera_rows_made, n - n + 1 as qorpera_at from generate_series(1, 40) n;\n",
	"data/shop/queries/slow.sql": "select pg_sleep(5) as waited;\n",
	"data/shop/queries/nap.sql": "select pg_sleep(0.2) as napped, :k::int as k;\n",
	"data/shop/queries/stubborn.sql": "select stubborn() as never;\n",
	"data/kinds/database.toml": 'format = "qorpera.database/v1"\n',
	"data/kinds/tables/001-items.sql": `create type mood as enum ('ok', 'bad');
create domain price as numeric(10,2) check (value >= 0);
create table items (id int primary key, mood mood not null, cost price not null);
insert into items select n, case when n % 2 = 0 then 'ok' else 'bad' end::mood, n from generate_series(1, 6) n;
`,
	"data/shop/queries/writes.sql": "insert into orders (customer, amount) values ('x', 1) returning id;\n",
	"data/shop/queries/two.sql": "select 1 as one; select 2 as two;\n",
	"data/shop/queries/escape.sql": "select set_config('role', 'none', true) as role, (select count(*) from qorpera_data.steps) as steps;\n",
	// Questions that try to reach the payroll folder from the shop's.
	"data/shop/queries/switch.sql": "select set_config('role', :role, true) as role;\n",
	"data/shop/queries/switch-then-peek.sql": "select set_config('role', :role, true) as role, peek() as salaries;\n",
	"data/shop/queries/peek.sql": "select peek() as salaries;\n",
	"data/shop/queries/peek-xml.sql": "select query_to_xml('select count(*) as n from payroll.salaries', false, false, '')::text as salaries;\n",
	"data/shop/queries/texts.sql": "select count(*) as texts from qorpera_data.texts;\n",
	"data/payroll/database.toml": 'format = "qorpera.database/v1"\nname = "Payroll"\n',
	"data/payroll/tables/001-salaries.sql": "create table salaries (name text primary key, monthly numeric(12,2) not null);\ninsert into salaries values ('Cy', 61000), ('Di', 58000);\n",
	"data/hr/database.toml": 'format = "qorpera.database/v1"\nname = "People"\n',
	"data/hr/tables/001-salaries.sql": "create table salaries (name text primary key, monthly numeric(12,2) not null);\ninsert into salaries values ('Ada', 52000), ('Bo', 47000);\n",
	"data/hr/queries/total.sql": "select sum(monthly) as monthly from salaries;\n",
	"data/risky/database.toml": 'format = "qorpera.database/v1"\n',
	"data/risky/tables/001-things.sql": "create table things (id int primary key, name text, weight int);\ninsert into things select n, 'thing ' || n, n from generate_series(1, 50) n;\n",
	"data/risky/tables/002-drop-weight.sql": "alter table things drop column weight;\ndelete from things where id <= 10;\n",
	"data/risky/queries/count.sql": "select count(*) as things, count(weight) as weights from things;\n",
	"data/broken/database.toml": 'format = "qorpera.database/v1"\n',
	"data/broken/tables/001-typo.sql": "create table a (id int primary key);\ncreate tabel b (id int);\n",
	"data/sneaky/database.toml": 'format = "qorpera.database/v1"\n',
	"data/sneaky/tables/001-base.sql": "create table ledger (id int primary key, amount int);\ninsert into ledger select n, n from generate_series(1, 20) n;\n",
	"data/sneaky/tables/002-commit.sql": "commit;\ndrop table ledger;\n",
	"data/guard/database.toml": 'format = "qorpera.database/v1"\n',
	"data/guard/tables/001-base.sql": `create table t (id int primary key, name text);
insert into t select n, 'row ' || n from generate_series(1, 10) n;
create table parent (id int primary key);
create table child (id int primary key, parent int not null references parent (id) on delete cascade);
insert into parent select n from generate_series(1, 3) n;
insert into child select n, 1 + n % 3 from generate_series(1, 9) n;
create function noop() returns trigger language plpgsql as $f$ begin return null; end $f$;
`,
	"data/qorpera/database.toml": 'format = "qorpera.database/v1"\n',
	"data/pg_things/database.toml": 'format = "qorpera.database/v1"\n',
	"data/qorpera_more/database.toml": 'format = "qorpera.database/v1"\n',
});
// A database whose rows members and agents change through named changes (§8).
put(ENV_A, {
	"data/desk/database.toml": 'format = "qorpera.database/v1"\nname = "Desk"\n',
	"data/desk/tables/001-tickets.sql": `create table tickets (
	id bigint generated always as identity primary key,
	title text not null check (title <> ''),
	state text not null default 'open' check (state in ('open', 'done')),
	opened_by uuid,
	note text
);
insert into tickets (title) select 'Ticket ' || n from generate_series(1, 30) n;
create table log (id bigint generated always as identity primary key, line text not null);
insert into log (line) values ('started');
create table scratch (id int primary key);
create function close_all() returns bigint language sql as $f$
	with done as (update tickets set state = 'done' where state = 'open' returning 1) select count(*) from done
$f$;
-- What the write login can do only through a function a step made, as that step's owner.
create function drop_scratch() returns void language plpgsql security definer as $f$ begin drop table scratch; end $f$;
create function empty_log() returns void language plpgsql security definer as $f$ begin truncate log; end $f$;
create function forget_note() returns void language plpgsql security definer as $f$ begin alter table tickets drop column note; end $f$;
-- A function that writes a row, for a delete that carries an insert.
create function logged(what text) returns boolean language sql as $f$ insert into log (line) values (what) returning true $f$;
`,
	"data/desk/queries/open.sql": "-- How many tickets are open.\nselect count(*) as open from tickets where state = 'open';\n",
	"data/desk/actions/open-ticket.sql": "-- Open a ticket called :title.\ninsert into tickets (title, opened_by) values (:title, :viewer::uuid) returning id, title;\n",
	"data/desk/actions/close-ticket.sql": "-- Mark ticket :id as done.\nupdate tickets set state = 'done' where id = :id::bigint;\n",
	"data/desk/actions/remove-ticket.sql": "-- Remove ticket :id for good.\ndelete from tickets where id = :id::bigint;\n",
	"data/desk/actions/claim.sql": "-- Give ticket :id to :viewer.\nupdate tickets set opened_by = :viewer::uuid where id = :id::bigint;\n",
	"data/desk/actions/move.sql":
		"with moved as (delete from tickets where id = :id::bigint returning title) insert into log (line) select 'removed ' || title from moved returning line;\n",
	"data/desk/actions/close-all.sql": "select close_all() as closed;\n",
	"data/desk/actions/open-many.sql": "insert into tickets (title) select 'Bulk ' || n from generate_series(1, :n::int) n returning id;\n",
	"data/desk/actions/note-all.sql": "update tickets set note = repeat('x', :size::int) returning note;\n",
	"data/desk/actions/two.sql": "insert into log (line) values ('a'); insert into log (line) values ('b');\n",
	"data/desk/actions/setting.sql": "set statement_timeout = 0;\n",
	"data/desk/actions/block.sql": "do $d$ begin insert into log (line) values ('from a block'); end $d$;\n",
	"data/desk/actions/truncate.sql": "truncate log;\n",
	"data/desk/actions/drop.sql": "drop table scratch;\n",
	"data/desk/actions/make.sql": "create table more (id int);\n",
	"data/desk/actions/drop-through.sql": "select drop_scratch();\n",
	"data/desk/actions/empty-through.sql": "select empty_log();\n",
	"data/desk/actions/column-through.sql": "select forget_note();\n",
	"data/desk/actions/slow.sql": "select pg_sleep(3) as waited;\n",
	// Deletes that also write: a `with` part, a function a step made, a large object. And a merge that only deletes.
	"data/desk/actions/sneak.sql": "with added as (insert into log (line) values ('sneaked') returning 1) delete from tickets where id = -1;\n",
	"data/desk/actions/remove-logged.sql": "delete from tickets where id = :id::bigint returning logged('removed ' || id) as logged;\n",
	"data/desk/actions/blob.sql": "delete from tickets where id = :id::bigint and lo_from_bytea(0, 'x'::bytea) > 0;\n",
	"data/desk/actions/merge-remove.sql": "merge into tickets t using (select :id::bigint as id) s on t.id = s.id when matched then delete;\n",
	// What a change could leave on its session for the next one: a setting and a session's advisory lock.
	"data/desk/actions/stick.sql":
		"select set_config('default_transaction_read_only', 'on', false) as read_only, set_config('search_path', 'pg_catalog', false) as path, pg_advisory_lock(42) is not null as locked;\n",
	"data/desk/actions/reach.sql": "insert into shop.orders (customer, amount) values ('x', 1);\n",
	"data/desk/actions/records.sql": "delete from qorpera_data.steps;\n",
	"data/hr/actions/raise.sql": "-- Raise :name by :by a month.\nupdate salaries set monthly = monthly + :by::numeric where name = :name returning monthly;\n",
	"data/unmade/database.toml": 'format = "qorpera.database/v1"\n',
	"data/unmade/actions/add.sql": "insert into things (id) values (1);\n",
});
// Company B has a database of the same name, with the same tables.
// Company C is made by a gateway that fails once while it makes the company's database.
put(ENV_C, {
	"data/shop/database.toml": 'format = "qorpera.database/v1"\nname = "Shop"\n',
	"data/shop/tables/001-orders.sql": ORDERS,
	"data/shop/queries/count.sql": COUNT,
});
put(ENV_B, {
	"data/shop/database.toml": 'format = "qorpera.database/v1"\nname = "Shop"\n',
	"data/shop/tables/001-orders.sql": ORDERS,
	"data/shop/queries/count.sql": COUNT,
});

it("reads who gets the list from database.toml's [list], and counts any spelling it cannot read as writers", () => {
	const viewer = "select 1 from t where owner = :viewer::uuid;\n";
	for (const [toml, questions, cut, members] of [
		['format = "x"\n', [], false, "readers"],
		['format = "x"\n', ["select 1;\n", viewer], false, "writers"],
		['format = "x"\n', ["select 1; select :viewer;\n"], false, "writers"],
		['format = "x"\n', [null], false, "writers"],
		['format = "x"\n', [], true, "writers"],
		[null, [], false, "writers"],
		['[list]\nmembers = "readers"\n', [viewer], true, "readers"],
		['[list]\nmembers = "writers" # w\n', [], false, "writers"],
		["[list]\nmembers = 'readers'\n", [], false, "readers"],
		['[list]\nmembers = "everyone"\n', [], false, "writers"],
		['[list]\n"members" = "readers"\n', [], false, "readers"],
		['["list"]\nmembers = "readers"\n', [], false, "readers"],
		['[ list ]\nmembers = "readers"\n', [], false, "readers"],
		['[list]\nmembers = """readers"""\n', [], false, "writers"],
		['list.members = "readers"\n', [viewer], false, "readers"],
		["'list'.\"members\" = \"writers\"\n", [], false, "writers"],
		['list = { members = "readers" }\n', [viewer], false, "readers"],
		['list = { "members" = "writers" }\n', [], false, "writers"],
		['list = { members = "readers", x = 1 }\n', [], false, "writers"],
		['[[list]]\nmembers = "readers"\n', [], false, "writers"],
		['[list.more]\nmembers = "readers"\n', [], false, "writers"],
		['[other]\nmembers = "readers"\n', [viewer], false, "writers"],
		['about = "A list of members"\n', [], false, "readers"],
		['tags = [\n  ["a"],\n]\nlist.members = "writers"\n', [], false, "writers"],
		['[other]\nx = [\n  [1],\n]\n[list]\nmembers = "writers"\n', [], false, "writers"],
		['["li\\u0073t"]\nmembers = "readers"\n', [], false, "writers"],
		['[list]\n"mem\\u0062ers" = "readers"\n', [], false, "writers"],
		['[list]\r\nmembers = "readers"\r\n', [viewer], false, "readers"],
		['[list]\nmembers = "readers"                  # "readers" (every member who may read the folder) or "writers"\n', [viewer], false, "readers"],
		['[list]\nmembers = "readers" # don\'t show, won\'t change\n', [viewer], false, "readers"],
		['about = "x" # "y"\n[list]\nmembers = "readers"\n', [viewer], false, "readers"],
		['x = [ #] "ab"\n', [], false, "writers"],
		['list = "readers"\n', [viewer], false, "writers"],
		['[list]\n"" = "readers"\n', [viewer], false, "writers"],
		['[""]\nlist.members = "readers"\n', [viewer], false, "writers"],
		['"list.members" = "readers"\n', [viewer], false, "writers"],
		['[list]\nmembers = "readers"\nmembers = "writers"\n', [], false, "writers"],
		['x = [\n  [1]\n]\nlist.members = "writers"\n', [], false, "writers"],
		['[list]\nlevels = [\n  [1]\n]\nmembers = "writers"\n', [], false, "writers"],
		['about = """\n[list]\nmembers = "readers"\n"""\nlist.members = "writers"\n', [], false, "writers"],
		["about = '''\n[x]\n'''\n[list]\nmembers = 'readers'\n", [viewer], false, "writers"],
		['# levels = [\n[list]\nmembers = "writers"\n', [], false, "writers"],
		["about = 'Use \"\"\" for notes'\n[list]\nmembers = \"writers\"\n", [], false, "writers"],
		['name = "Shop" # no \'\'\' here\n[list]\nmembers = "writers"\n', [], false, "writers"],
		['about = """\nnever ends\n[list]\nmembers = "writers"\n', [], false, "writers"],
		['name = "Shop" # [list] in a comment\nabout = "x"\n', [], false, "readers"],
		['format = "qorpera.database/v1"\nname = "Shop"\nabout = "What the shop holds" # one line\n\n[list]\nmembers = "readers" # all\n', [viewer], false, "readers"],
		['[list]\nmembers = [\n"readers"]\n', [], false, "writers"],
		['tags = ["a]", "b"]\nlist.members = "readers"\n', [viewer], false, "readers"],
	])
		assert.equal(listMembers(toml, questions, cut), members, `${JSON.stringify(toml)} ${JSON.stringify(questions)} ${cut}`);
});

describe("the data gateway against a real PostgreSQL", { skip: dockerUsable ? false : "needs Linux with Docker" }, () => {
	const container = `cdgateway-${process.pid}-${randomBytes(4).toString("hex")}`;
	const superPassword = randomBytes(16).toString("hex");
	const logins = {
		...Object.fromEntries(["admin", "keeper", "watch"].map((login) => [login, randomBytes(16).toString("hex")])),
		folderKey: randomBytes(32).toString("hex"),
	};
	let storePort = 0;
	let gateway = null;
	let server = null;
	let port = 0;
	let runServer = null;
	const owner = tokenOf(OWNER);
	const contributor = tokenOf(CONTRIBUTOR);
	const viewer = tokenOf(VIEWER);
	const stranger = tokenOf(STRANGER);
	const bMember = tokenOf(B_MEMBER);
	// The platform has not seen this one: a token it did not sign.
	const forged = `${owner.slice(0, owner.lastIndexOf("."))}.forged`;

	const connect = (database, user = "postgres", password = superPassword) =>
		new pg.Client({ host: "127.0.0.1", port: storePort, user, password, database });
	const asAdmin = async (database, text, values) => {
		const client = connect(database);
		await client.connect();
		try {
			return (await client.query(text, values)).rows;
		} finally {
			await client.end();
		}
	};
	const psql = (database, file, variables = {}, input = storeFile(file)) => {
		const made = spawnSync(
			"docker",
			["exec", "-i", container, "psql", "-X", "-q", "-h", "127.0.0.1", "-U", "postgres", "-d", database, "-v", "ON_ERROR_STOP=1",
				...Object.entries(variables).flatMap(([name, value]) => ["-v", `${name}=${value}`])],
			{ input, encoding: "utf8" },
		);
		if (made.status !== 0) throw new Error(`${file}: ${made.stderr}`);
	};
	const listening = async () =>
		(await asAdmin("postgres", "select count(*)::int as n from pg_stat_activity where application_name = 'qorpera-data-gateway listen'"))[0].n;
	const until = async (what, wanted, ms = 2_000) => {
		const end = Date.now() + ms;
		let value = await what();
		while (value !== wanted && Date.now() < end) {
			await sleep(25);
			value = await what();
		}
		return value;
	};

	/** One HTTP request to the gateway. */
	const send = ({ method = "POST", path, bearer, text = "", to = port }) =>
		new Promise((resolve, reject) => {
			const request = http.request(
				{
					host: "127.0.0.1",
					port: to,
					path,
					method,
					headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), "content-type": "application/json", "content-length": Buffer.byteLength(text) },
				},
				(response) => {
					let answer = "";
					response.setEncoding("utf8");
					response.on("data", (piece) => {
						answer += piece;
					});
					response.on("end", () => resolve({ status: response.statusCode, value: answer ? JSON.parse(answer) : null }));
				},
			);
			request.on("error", reject);
			request.end(text);
		});
	const call = (bearer, verb, body, env = ENV_A) => send({ path: `/v1/company-data/${env}/${verb}`, bearer, text: JSON.stringify(body) });
	/** A call as the web makes it: when the gateway asks for a file's text, the caller reads the file and sends it. */
	const ask = async (bearer, verb, body, env = ENV_A) => {
		let answer = await call(bearer, verb, body, env);
		for (let round = 0; round < 8 && answer.status === 200 && answer.value.need; round++) {
			const texts = {};
			let bytes = 0;
			for (const wanted of answer.value.need) {
				const text = TEXTS.get(wanted.sha256);
				if (Object.keys(texts).length > 0 && bytes + Buffer.byteLength(text) > LIMITS_HERE.bodyBytes / 2) break;
				texts[wanted.sha256] = text;
				bytes += Buffer.byteLength(text);
			}
			answer = await call(bearer, verb, { ...body, texts }, env);
		}
		return answer;
	};
	const describeOne = async (bearer, database, env = ENV_A) => {
		const answer = await ask(bearer, "describe", { database }, env);
		return { status: answer.status, value: answer.status === 200 ? answer.value.databases[0] : answer.value, whole: answer.value };
	};
	const states = (answer) => answer.value.results?.map((result) => `${result.name} ${result.state}`);

	before(async () => {
		try {
			const started = spawnSync(
				"docker",
				["run", "-d", "--name", container, "--cpus", "2", "--memory", "4g", "--shm-size", "256m", "-e", `POSTGRES_PASSWORD=${superPassword}`,
					...POSTGRES_LOCALE, "-p", "127.0.0.1::5432", POSTGRES_IMAGE, "-c", "max_connections=100",
					// The server logs every statement and error, so a test can show that a company's database writes none.
					"-c", "log_statement=all", "-c", "log_min_duration_statement=0", "-c", "log_min_messages=info", "-c", "log_error_verbosity=verbose",
					"-c", "log_lock_waits=on", "-c", "deadlock_timeout=100ms", "-c", "log_temp_files=0", "-c", "log_transaction_sample_rate=1"],
				{ encoding: "utf8" },
			);
			if (started.status !== 0) throw new Error(`PostgreSQL did not start: ${started.stderr}`);
			const published = spawnSync("docker", ["port", container, "5432/tcp"], { encoding: "utf8" }).stdout;
			storePort = Number(/^127\.0\.0\.1:(\d+)$/m.exec(published)?.[1]);
			assert.ok(storePort > 0, `no loopback port: ${published}`);
			let ready = false;
			for (let attempt = 0; attempt < 240 && !ready; attempt++) {
				ready = spawnSync("docker", ["exec", container, "psql", "-h", "127.0.0.1", "-U", "postgres", "-Atc", "select 1"], { stdio: "ignore" }).status === 0;
				if (!ready) await sleep(250);
			}
			assert.ok(ready, "PostgreSQL did not become ready");
			checkLocale(spawnSync("docker", ["exec", container, "psql", "-h", "127.0.0.1", "-U", "postgres", "-Atc", LOCALE_QUERY], { encoding: "utf8" }).stdout);
			psql("postgres", "cluster.sql", { admin_password: logins.admin, keeper_password: logins.keeper, watch_password: logins.watch });
			psql("qorpera_company_template", "template.sql");
			gateway = new Gateway({
				store: { host: "127.0.0.1", port: storePort, logins },
				platform: new Platform({ url: "http://platform/", publishableKey: "publishable", fetch: platformFetch }),
				limits: LIMITS_HERE,
				runs: { token: RUN_TOKEN },
			});
			server = await serve(gateway);
			port = server.address().port;
			runServer = await serveRuns(gateway);
		} catch (error) {
			spawnSync("docker", ["rm", "-f", "-v", container], { stdio: "ignore" });
			throw error;
		}
	});

	after(async () => {
		for (const open of [server, runServer]) {
			if (!open) continue;
			open.close();
			open.closeAllConnections();
		}
		if (gateway) await gateway.close();
		spawnSync("docker", ["rm", "-f", "-v", container], { stdio: "ignore" });
	});

	// ---- steps
	it("applies a database's steps from the folder's files, asking for each text it does not hold by its hash", async () => {
		const first = await call(contributor, "apply", { database: "shop" });
		assert.equal(first.status, 200);
		assert.deepEqual(first.value.need?.map((wanted) => wanted.path), ["data/shop/tables/001-orders.sql", "data/shop/tables/002-order-notes.sql"]);
		const wrong = await call(contributor, "apply", {
			database: "shop",
			texts: Object.fromEntries(first.value.need.map((wanted) => [wanted.sha256, "drop table everything;"])),
		});
		assert.equal(wrong.value.need?.length, 2, "a text whose hash is not the folder's is not used");
		const applied = await ask(contributor, "apply", { database: "shop" });
		assert.equal(applied.value.applied, true, JSON.stringify(applied.value));
		assert.deepEqual(states(applied), ["001-orders applied", "002-order-notes applied"]);
	});

	it("applies nothing twice", async () => {
		const again = await ask(viewer, "apply", { database: "shop" });
		assert.equal(again.value.applied, true);
		assert.deepEqual(states(again), ["001-orders already", "002-order-notes already"]);
	});

	it("describes a database as its files made it, and every new table carries Qorpera's three triggers", async () => {
		const described = await describeOne(contributor, "shop");
		assert.equal(described.status, 200);
		assert.deepEqual(described.value.tables.map((table) => table.name), ["order_totals", "orders"]);
		assert.deepEqual(described.value.applied.map((step) => step.name), ["001-orders", "002-order-notes"]);
		assert.ok(described.whole.companyBytes > 0);
		const orders = described.value.tables.find((table) => table.name === "orders");
		assert.deepEqual(orders.columns.map((column) => column.name), ["id", "customer", "amount", "status", "placed_by", "placed_at", "note"]);
		const [{ held }] = await asAdmin(companyDatabase(ENV_A), "select count(*)::int as held from shop.orders");
		assert.ok(held > 0);
		assert.deepEqual([orders.rows, orders.rowsAbout], [held, undefined], "the rows the table holds, counted");
		const triggers = await asAdmin(companyDatabase(ENV_A), "select tgname from pg_trigger where tgrelid = 'shop.orders'::regclass and not tgisinternal order by 1");
		assert.deepEqual(triggers.map((row) => row.tgname), [
			"qorpera_changed",
			"qorpera_emptied",
			"qorpera_record_add",
			"qorpera_record_change",
			"qorpera_record_remove",
			"qorpera_rows_gone",
		]);
	});

	it("counts a table's rows when it describes it, and never gives PostgreSQL's estimate as a count", async () => {
		put(ENV_A, {
			"data/tally/database.toml": 'format = "qorpera.database/v1"\nname = "Tally"\nabout = "Things counted"\n',
			"data/tally/tables/001-things.sql":
				"create table things (id int primary key, name text not null);\n" +
				"insert into things select n, 'thing ' || n from generate_series(1, 7) n;\n" +
				// A table named as a catalog relation is: PostgreSQL finds the catalog's first under a name alone (the
				// insert must say the schema), so a count that named it without its schema would count the catalog's.
				"create table pg_tables (id int primary key);\n" +
				"insert into tally.pg_tables values (1), (2);\n" +
				"create view some_things as select * from things where id <= 3;\n" +
				// 7 rows at 0.2 s each: its count runs past a question's time here (300 ms).
				"create view slow_things as select * from things where pg_sleep(0.2) is not null;\n",
			"data/tally/queries/count.sql": "-- How many things there are.\nselect count(*) as things from things;\n",
		});
		const applied = await ask(contributor, "apply", { database: "tally" });
		assert.equal(applied.value.applied, true, JSON.stringify(applied.value));
		const rowsOf = (answer) => Object.fromEntries(answer.value.tables.map((table) => [table.name, [table.rows, table.rowsAbout]]));
		const nothing = [undefined, undefined];
		// Autovacuum never analyses a table of 7 rows, so PostgreSQL has no estimate for it: the count is the truth.
		const estimates = await asAdmin(
			companyDatabase(ENV_A),
			"select relname, reltuples::int as estimate from pg_class where oid in ('tally.things'::regclass, 'tally.pg_tables'::regclass) order by 1",
		);
		assert.deepEqual(estimates, [{ relname: "pg_tables", estimate: -1 }, { relname: "things", estimate: -1 }]);
		const [{ catalog }] = await asAdmin(companyDatabase(ENV_A), "select count(*)::int as catalog from pg_catalog.pg_tables");
		assert.notEqual(catalog, 2);
		const counted = await describeOne(viewer, "tally");
		assert.equal(counted.status, 200, JSON.stringify(counted.value));
		// The slow view's count was ended at a question's time and left it without rows; the view after it was counted.
		assert.deepEqual(rowsOf(counted), { pg_tables: [2, undefined], slow_things: nothing, some_things: [3, undefined], things: [7, undefined] });
		assert.deepEqual(Object.keys(counted.value.tables.find((table) => table.name === "things")), ["name", "kind", "key", "rows", "columns"]);
		await withGateway({ limits: { ...LIMITS_HERE, countMs: 0 } }, async () => {
			// No time to count: nothing is said of a table PostgreSQL has no estimate for.
			const none = await describeOne(viewer, "tally");
			assert.deepEqual(rowsOf(none), { pg_tables: nothing, slow_things: nothing, some_things: nothing, things: nothing });
			await asAdmin(companyDatabase(ENV_A), "analyze tally.things");
			// With an estimate it is given under its own name, never as `rows`; a view never has one.
			const about = await describeOne(viewer, "tally");
			assert.deepEqual(rowsOf(about), { pg_tables: nothing, slow_things: nothing, some_things: nothing, things: [undefined, 7] });
			assert.deepEqual(Object.keys(about.value.tables.find((table) => table.name === "things")), ["name", "kind", "key", "rowsAbout", "columns"]);
		});
		// A question still answers after a count was ended.
		assert.deepEqual((await ask(viewer, "query", { database: "tally", question: "count" })).value.rows, [[7]]);
	});

	it("does not make a describe wait for a connection its counts cannot get in their time", async () => {
		// A database only this test's gateway reads, so that all three connections of its read role are this gateway's
		// to hold (the role may hold three in all, whichever gateway opens them).
		put(ENV_A, {
			"data/queue/database.toml": 'format = "qorpera.database/v1"\nname = "Queue"\nabout = "Things that wait"\n',
			"data/queue/tables/001-things.sql":
				"create table things (id int primary key);\n" +
				"insert into things select n from generate_series(1, 7) n;\n" +
				"create view slow_things as select * from things where pg_sleep(0.2) is not null;\n",
			"data/queue/queries/slow.sql": "-- Every thing, slowly.\nselect count(*) as things from slow_things;\n",
		});
		// The slow question takes 1.4 s (7 rows at 0.2 s). Three of them hold the read role's three connections; the
		// counts of a describe have 400 ms in all.
		await withGateway({ limits: { ...LIMITS_HERE, questionMs: 2_000, countMs: 400 } }, async () => {
			const applied = await ask(contributor, "apply", { database: "queue" });
			assert.equal(applied.value.applied, true, JSON.stringify(applied.value));
			const things = (answer) => answer.value.tables.find((table) => table.name === "things");
			const sevens = [[[7]], [[7]], [[7]]];
			assert.deepEqual((await ask(viewer, "query", { database: "queue", question: "slow" })).value.rows, [[7]], "the question's text is kept");
			const slow = [1, 2, 3].map(() => call(viewer, "query", { database: "queue", question: "slow" }));
			await sleep(150);
			const began = Date.now();
			const busy = await describeOne(viewer, "queue");
			const took = Date.now() - began;
			assert.equal(busy.status, 200, JSON.stringify(busy.value));
			// Not counted: a count that waited on for a connection would have got one when the questions ended, and counted.
			assert.deepEqual([things(busy).rows, things(busy).rowsAbout], [undefined, undefined]);
			assert.ok(took < 3_000, `the describe took ${took} ms: it did not wait as long as the pool lets a call wait (5 s)`);
			assert.deepEqual((await Promise.all(slow)).map((answer) => answer.value.rows), sevens);
			// With connections free again a describe counts.
			assert.equal(things(await describeOne(viewer, "queue")).rows, 7);
			// The connection that came too late for the count was given back: three slow questions still run side by
			// side (one after two others would take 2.8 s).
			const again = Date.now();
			const second = await Promise.all([1, 2, 3].map(() => call(viewer, "query", { database: "queue", question: "slow" })));
			assert.deepEqual(second.map((answer) => answer.value.rows), sevens);
			assert.ok(Date.now() - again < 2_500, `three slow questions took ${Date.now() - again} ms`);
		});
	});

	// ---- questions
	let since = null;
	let sales = null;

	it("answers a question with columns, rows as arrays, numbers as numbers, an etag and when", async () => {
		// After the step ran: of its rows placed 1 to 240 hours before it, 23 are within a day now.
		since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
		put(ENV_A, { "data/shop/queries/sales-since.sql": `${FOLDERS[ENV_A].get("data/shop/queries/sales-since.sql")}\n` });
		const needed = await call(viewer, "query", { database: "shop", question: "sales-since", params: { since } });
		assert.equal(needed.value.need?.[0]?.path, "data/shop/queries/sales-since.sql");
		sales = await ask(viewer, "query", { database: "shop", question: "sales-since", params: { since } });
		assert.equal(sales.status, 200, JSON.stringify(sales.value));
		assert.deepEqual(sales.value.columns, ["orders", "total"]);
		assert.equal(sales.value.rows.length, 1);
		assert.equal(sales.value.rows[0][0], 23);
		assert.equal(typeof sales.value.rows[0][1], "number");
		assert.equal(sales.value.more, false);
		assert.match(sales.value.etag, /^[0-9a-f]{32}$/);
		assert.ok(Math.abs(Date.parse(sales.value.asOf) - Date.now()) < 5_000);
		// Another member needs no text: the gateway holds it by its hash.
		const kept = await call(owner, "query", { database: "shop", question: "sales-since", params: { since } });
		assert.equal(kept.status, 200);
		assert.deepEqual(kept.value.rows, sales.value.rows);
	});

	it("says the same when the page already holds the answer", async () => {
		const same = await call(viewer, "query", { database: "shop", question: "sales-since", params: { since }, etag: sales.value.etag });
		assert.deepEqual(same.value, { same: true, etag: sales.value.etag });
		const other = await call(viewer, "query", { database: "shop", question: "sales-since", params: { since }, etag: "an-old-etag" });
		assert.ok(Array.isArray(other.value.rows));
	});

	it("gives each kind of value its JSON shape, and no digit is lost", async () => {
		const types = await ask(viewer, "query", { database: "shop", question: "types" });
		assert.equal(types.status, 200, JSON.stringify(types.value));
		const row = Object.fromEntries(types.value.columns.map((column, index) => [column, types.value.rows[0][index]]));
		assert.deepEqual(row, {
			big: "9007199254740993",
			small: 42,
			whole: 7,
			double: 1.5,
			precise: "12345678901234567890.123456789",
			price: 12.5,
			tenth: 0.1,
			yes: true,
			no: false,
			doc: { a: [1, 2] },
			list: [1, "x"],
			at: "2026-11-13T09:00:00.5Z",
			local: "2026-11-13T10:00:00",
			nothing: null,
			words: "plain",
		});
	});

	it("refuses someone who is not a member the same as a question that is not there, and a token the platform does not know", async () => {
		const noOne = await call(stranger, "query", { database: "shop", question: "sales-since", params: { since } });
		assert.equal(noOne.status, 404);
		assert.equal(noOne.value.error, "No question shop/sales-since that you may read");
		const missing = await call(viewer, "query", { database: "shop", question: "nothing-here" });
		assert.equal(missing.status, 404);
		const bad = await call(forged, "query", { database: "shop", question: "sales-since", params: { since } });
		assert.equal(bad.status, 401);
		const none = await send({ path: `/v1/company-data/${ENV_A}/query`, text: "{}" });
		assert.equal(none.status, 401);
	});

	it("lets only the members the folder lets read a private database's questions", async () => {
		const otherApply = await call(viewer, "apply", { database: "hr" });
		assert.equal(otherApply.status, 404);
		const applied = await ask(contributor, "apply", { database: "hr" });
		assert.equal(applied.value.applied, true, JSON.stringify(applied.value));
		const its = await ask(contributor, "query", { database: "hr", question: "total" });
		assert.deepEqual(its.value.rows, [[99000]]);
		for (const other of [viewer, owner]) {
			const refused = await ask(other, "query", { database: "hr", question: "total" });
			assert.equal(refused.status, 404);
			assert.equal(refused.value.error, "No question hr/total that you may read");
		}
		assert.equal((await describeOne(viewer, "hr")).status, 404);
	});

	it("fills :viewer with the member looking, and refuses a page that sends it", async () => {
		await asAdmin(companyDatabase(ENV_A), "update shop.orders set placed_by = $1 where id <= 7", [VIEWER]);
		const mine = await ask(viewer, "query", { database: "shop", question: "mine" });
		const theirs = await ask(owner, "query", { database: "shop", question: "mine" });
		assert.deepEqual([mine.value.rows, theirs.value.rows], [[[7]], [[0]]]);
		const pretend = await ask(owner, "query", { database: "shop", question: "mine", params: { viewer: VIEWER } });
		assert.equal(pretend.status, 400);
		assert.match(pretend.value.error, /:viewer is filled by Qorpera/);
		const unknown = await ask(owner, "query", { database: "shop", question: "count", params: { other: 1 } });
		assert.equal(unknown.status, 400);
		const lacking = await ask(owner, "query", { database: "shop", question: "sales-since" });
		assert.equal(lacking.status, 400);
		assert.match(lacking.value.error, /takes :since/);
	});

	// ---- what a question may not do
	it("stops a slow question at its limit", async () => {
		const began = Date.now();
		const slow = await ask(viewer, "query", { database: "shop", question: "slow" });
		assert.equal(slow.status, 408, JSON.stringify(slow.value));
		assert.ok(Date.now() - began < 2_000, `${Date.now() - began} ms`);
	});

	it("refuses a question that writes, one of two statements, and one that reads the gateway's records", async () => {
		const writes = await ask(viewer, "query", { database: "shop", question: "writes" });
		assert.equal(writes.status, 400, JSON.stringify(writes.value));
		const two = await ask(viewer, "query", { database: "shop", question: "two" });
		assert.equal(two.status, 400);
		const escape = await ask(viewer, "query", { database: "shop", question: "escape" });
		assert.equal(escape.status, 400, JSON.stringify(escape.value));
		const count = await asAdmin(companyDatabase(ENV_A), "select count(*)::int as n from shop.orders");
		assert.equal(count[0].n, 240);
	});

	it("gives at most the row limit, with more: true", async () => {
		const many = await ask(viewer, "query", { database: "shop", question: "many" });
		assert.equal(many.value.rows.length, LIMITS_HERE.questionRows);
		assert.equal(many.value.more, true);
	});

	it("gives at most the byte limit, counted in bytes, with more: true", async () => {
		for (const question of ["wide", "wide-letters"]) {
			const wide = await ask(viewer, "query", { database: "shop", question });
			assert.equal(wide.status, 200);
			assert.equal(wide.value.more, true, question);
			assert.ok(wide.value.rows.length > 0);
			assert.ok(Buffer.byteLength(JSON.stringify(wide.value.rows)) <= LIMITS_HERE.questionBytes, question);
		}
	});

	it("never takes rows past the answer's size from the store", async () => {
		const before = gateway.taken.bytes;
		for (const question of ["huge", "huge-first"]) {
			const huge = await ask(viewer, "query", { database: "shop", question });
			assert.equal(huge.status, 200, JSON.stringify(huge.value).slice(0, 200));
			assert.deepEqual(huge.value.rows, [], question);
			assert.equal(huge.value.more, true, question);
			assert.deepEqual(huge.value.columns, ["text"], question);
		}
		// 9 MiB of rows were made in the store; none of it came over.
		assert.equal(gateway.taken.bytes - before, 0);
		const none = await ask(viewer, "query", { database: "shop", question: "none" });
		assert.deepEqual([none.value.rows, none.value.more, none.value.columns], [[], false, ["n"]]);
	});

	it("counts a question's size by its whole row, whatever its columns are named", async () => {
		// A column named like the gateway's own words cannot stand for the whole row: 1 MiB still never comes over.
		const before = gateway.taken.bytes;
		const shadow = await ask(viewer, "query", { database: "shop", question: "shadow" });
		assert.equal(shadow.status, 200, JSON.stringify(shadow.value).slice(0, 200));
		assert.deepEqual([shadow.value.rows, shadow.value.more, shadow.value.columns], [[], true, ["qorpera_asked", "payload"]]);
		assert.equal(gateway.taken.bytes - before, 0);
		// Columns named like every name the gateway adds: the question answers its own values, and the limits hold.
		const names = await ask(viewer, "query", { database: "shop", question: "names" });
		assert.equal(names.status, 200, JSON.stringify(names.value).slice(0, 300));
		assert.deepEqual(names.value.columns, NAMES);
		assert.equal(names.value.rows.length, LIMITS_HERE.questionRows);
		assert.deepEqual(names.value.rows[0], NAMES.map((_, index) => index + 1));
		assert.equal(names.value.more, true);
		const wide = await ask(viewer, "query", { database: "shop", question: "names-wide" });
		assert.equal(wide.status, 200, JSON.stringify(wide.value).slice(0, 300));
		assert.deepEqual(wide.value.columns, ["qorpera_bytes_so_far", "qorpera_rows_made", "qorpera_at"]);
		assert.equal(wide.value.more, true);
		assert.ok(wide.value.rows.length > 0 && wide.value.rows.length < 40);
		assert.deepEqual(wide.value.rows[0].slice(1), [1, 1]);
		assert.ok(Buffer.byteLength(JSON.stringify(wide.value.rows)) <= LIMITS_HERE.questionBytes);
	});

	// ---- steps that must not land
	it("holds a step that destroys data, with what it would destroy, and changes nothing", async () => {
		const risky = await ask(contributor, "apply", { database: "risky" });
		assert.equal(risky.value.applied, false);
		const held = risky.value.results.find((result) => result.name === "002-drop-weight");
		assert.equal(held.state, "held");
		assert.ok(held.destroys.some((effect) => effect.what === "dropped table column" && effect.object === "risky.things.weight"), JSON.stringify(held));
		assert.ok(held.destroys.some((effect) => effect.what === "deleted rows" && effect.rows === 10), JSON.stringify(held));
		const count = await ask(viewer, "query", { database: "risky", question: "count" });
		assert.deepEqual(count.value.rows, [[50, 50]]);
	});

	it("fails a step with a mistake in PostgreSQL's words and keeps nothing of it", async () => {
		const broken = await ask(contributor, "apply", { database: "broken" });
		assert.equal(broken.value.results[0].state, "failed");
		assert.match(broken.value.results[0].detail, /tabel/);
		const described = await describeOne(viewer, "broken");
		assert.deepEqual([described.value.tables, described.value.applied], [[], []]);
	});

	it("fails a step that tries to end the transaction, and what follows it does not run", async () => {
		const sneaky = await ask(contributor, "apply", { database: "sneaky" });
		const commits = sneaky.value.results.find((result) => result.name === "002-commit");
		assert.equal(commits.state, "failed");
		assert.match(commits.detail, /cannot end it/);
		const ledger = await asAdmin(companyDatabase(ENV_A), "select count(*)::int as n from sneaky.ledger");
		assert.equal(ledger[0].n, 20);
	});

	it("refuses, the moment it happens, a step that switches off, replaces or drops Qorpera's triggers, or an unlogged table", async () => {
		const base = await ask(contributor, "apply", { database: "guard" });
		assert.deepEqual(states(base), ["001-base applied"]);
		const database = companyDatabase(ENV_A);
		const rows = async () =>
			(await asAdmin(database, "select (select count(*) from guard.t) || '/' || (select count(*) from guard.parent) || '/' || (select count(*) from guard.child) as n"))[0].n;
		const before = await rows();
		assert.equal(before, "10/3/9");
		const stay = (trigger) => new RegExp(`Qorpera's trigger ${trigger} on guard\\.t must stay as Qorpera made it`);
		const refused = [
			["alter table t disable trigger user;\ndelete from t;\nalter table t enable trigger user;\n", stay("qorpera_\\w+")],
			["alter table t disable trigger qorpera_rows_gone;\ndelete from t where id = 1;\n", stay("qorpera_rows_gone")],
			["alter table t enable replica trigger qorpera_changed;\n", stay("qorpera_changed")],
			["drop trigger qorpera_rows_gone on t;\n", /Qorpera's trigger qorpera_rows_gone on guard\.t cannot be dropped/],
			["create or replace trigger qorpera_rows_gone after delete on t for each statement execute function noop();\ndelete from t;\n", stay("qorpera_rows_gone")],
			["create or replace trigger qorpera_rows_gone after insert on t referencing new table as gone for each statement execute function qorpera_data.rows_gone();\n", stay("qorpera_rows_gone")],
			["create or replace trigger qorpera_rows_gone after delete on t referencing old table as gone for each statement when (false) execute function qorpera_data.rows_gone();\ndelete from t;\n", stay("qorpera_rows_gone")],
			["create trigger qorpera_x after insert on t for each statement execute function noop();\n", stay("qorpera_x")],
			["alter trigger qorpera_rows_gone on t rename to kept;\nalter table t disable trigger kept;\ndelete from t;\n", /Qorpera's triggers on guard\.t are missing/],
			["create unlogged table u (id int);\n", /Qorpera keeps every table logged: guard\.u is not/],
			["alter table t set unlogged;\n", /Qorpera keeps every table logged: guard\.t is not/],
			["set local session_replication_role = replica;\ndelete from t;\n", /permission denied/],
			["alter event trigger qorpera_guard disable;\nalter table t disable trigger user;\ndelete from t;\n", /must be owner|permission denied/],
			["delete from t where id = 1;\ndelete from qorpera_data.step_effects;\n", /permission denied/],
			// A deferred foreign key is checked before the step is judged: one that fails, fails the step.
			["create table d (id int primary key, p int references parent (id) deferrable initially deferred);\ninsert into d values (1, 999);\n", /violates foreign key constraint/],
			// Two stages: the first deferred trigger, run before the check, defers again and queues a second that would
			// delete at commit, after the check. The seal makes the commit fail.
			[
				"create table q (id int);\n" +
					"create function stage_two() returns trigger language plpgsql as $f$ begin delete from t where id <= 5; return null; end $f$;\n" +
					"create constraint trigger two after insert on q deferrable initially deferred for each row execute function stage_two();\n" +
					"create function stage_one() returns trigger language plpgsql as $f$ begin set constraints all deferred; insert into q values (1); return null; end $f$;\n" +
					"create constraint trigger one after insert on t deferrable initially deferred for each row execute function stage_one();\n" +
					"insert into t values (100, 'late');\n",
				/A step may not destroy data after it was checked: rows of guard\.t were deleted/,
			],
		];
		for (const [text, problem] of refused) {
			put(ENV_A, { "data/guard/tables/002-try.sql": text });
			const tried = await ask(contributor, "apply", { database: "guard" });
			assert.deepEqual(states(tried), ["001-base already", "002-try failed"], text);
			assert.match(tried.value.results[1].detail, problem, text);
		}
		const held = [
			// The child's rows go by the cascade of the parent's delete: they are counted too.
			["delete from parent where id = 1;\n", [["deleted rows", "guard.child", 3], ["deleted rows", "guard.parent", 1]]],
			["merge into t using (select 2 as id) s on t.id = s.id when matched then delete;\n", [["deleted rows", "guard.t", 1]]],
			// A deferred trigger would delete at commit, after the effects were read: it runs before they are.
			[
				"create function wipe() returns trigger language plpgsql as $f$ begin delete from t where id <= 5; return null; end $f$;\n" +
					"create constraint trigger later after insert on t deferrable initially deferred for each row execute function wipe();\n" +
					"insert into t values (100, 'late');\n",
				[["deleted rows", "guard.t", 5]],
			],
		];
		for (const [text, destroys] of held) {
			put(ENV_A, { "data/guard/tables/002-try.sql": text });
			const tried = await ask(contributor, "apply", { database: "guard" });
			assert.deepEqual(states(tried), ["001-base already", "002-try held"], text);
			assert.deepEqual(tried.value.results[1].destroys.map((effect) => [effect.what, effect.object, effect.rows]), destroys, text);
		}
		assert.equal(await rows(), before);
		const triggers = await asAdmin(database, "select tgrelid::regclass::text || ' ' || tgname || ' ' || tgenabled::text as t from pg_trigger where tgrelid in ('guard.t'::regclass, 'guard.child'::regclass) and not tgisinternal and tgname like 'qorpera%' order by 1");
		const model = ["qorpera_changed", "qorpera_emptied", "qorpera_record_add", "qorpera_record_change", "qorpera_record_remove", "qorpera_rows_gone"];
		assert.deepEqual(triggers.map((row) => row.t), ["guard.t", "guard.child"].flatMap((table) => model.map((name) => `${table} ${name} O`)).sort());
		const recorded = await asAdmin(database, "select name from qorpera_data.steps where database = 'guard' order by name");
		assert.deepEqual(recorded.map((row) => row.name), ["001-base"]);
		// Honest deferred work that only adds rows, also at commit, lands.
		put(ENV_A, {
			"data/guard/tables/002-try.sql":
				"create table e (id int primary key, p int references parent (id) deferrable initially deferred);\n" +
				"create table e_log (n int);\n" +
				"create function log_e() returns trigger language plpgsql as $f$ begin insert into e_log values (1); return null; end $f$;\n" +
				"create constraint trigger logged after insert on e deferrable initially deferred for each row execute function log_e();\n" +
				"insert into e values (1, 1), (2, 2);\n",
		});
		const honest = await ask(contributor, "apply", { database: "guard" });
		assert.deepEqual(states(honest), ["001-base already", "002-try applied"], JSON.stringify(honest.value));
		const logged = await asAdmin(database, "select (select count(*) from guard.e) || '/' || (select count(*) from guard.e_log) as n");
		assert.equal(logged[0].n, "2/2");
		assert.equal(await rows(), before);
	});

	it("stops applying when an applied step was changed or is gone, and refuses a new step numbered at or below an applied one", async () => {
		const original = FOLDERS[ENV_A].get("data/shop/tables/001-orders.sql");
		put(ENV_A, { "data/shop/tables/001-orders.sql": original.replace("amount >= 0", "amount >= -1") });
		const changed = await ask(owner, "apply", { database: "shop" });
		assert.equal(changed.value.applied, false);
		assert.deepEqual(states(changed), ["001-orders changed"]);
		put(ENV_A, { "data/shop/tables/001-orders.sql": original });
		const notes = FOLDERS[ENV_A].get("data/shop/tables/002-order-notes.sql");
		remove(ENV_A, "data/shop/tables/002-order-notes.sql");
		const missing = await ask(owner, "apply", { database: "shop" });
		assert.deepEqual(states(missing), ["002-order-notes missing"]);
		put(ENV_A, { "data/shop/tables/002-order-notes.sql": notes, "data/shop/tables/000-early.sql": "create table early (id int);\n" });
		const early = await ask(owner, "apply", { database: "shop" });
		assert.equal(early.status, 400);
		assert.match(early.value.error, /000-early is numbered at or below 002-order-notes/);
		remove(ENV_A, "data/shop/tables/000-early.sql");
		put(ENV_A, { "data/shop/tables/003-customers.sql": "create table customers (id bigint generated always as identity primary key, name text not null);\n" });
		const third = await ask(owner, "apply", { database: "shop" });
		assert.equal(third.value.applied, true);
		assert.deepEqual(states(third), ["001-orders already", "002-order-notes already", "003-customers applied"]);
	});

	it("asks the question the folder holds now: a changed file is live at the next call", async () => {
		put(ENV_A, { "data/shop/queries/by-status.sql": "select status, orders, total, round(total / orders, 2) as average from order_totals order by status;\n" });
		const changed = await ask(owner, "query", { database: "shop", question: "by-status" });
		assert.deepEqual(changed.value.columns, ["status", "orders", "total", "average"]);
	});

	// ---- one folder cannot reach another's
	it("keeps each database folder's SQL inside its own folder: no step or question reaches another's rows", async () => {
		const database = companyDatabase(ENV_A);
		const payroll = await ask(owner, "apply", { database: "payroll" });
		assert.deepEqual(states(payroll), ["001-salaries applied"]);
		put(ENV_A, {
			"data/shop/tables/004-peek.sql":
				"create function peek() returns bigint language plpgsql as $f$\ndeclare v_n bigint;\nbegin\n\texecute 'select count(*) from payroll.salaries' into v_n;\n\treturn v_n;\nend $f$;\n",
		});
		assert.deepEqual(states(await ask(owner, "apply", { database: "shop" })).at(-1), "004-peek applied");
		const numbers = Object.fromEntries((await asAdmin(database, "select name, n from qorpera_data.databases")).map((row) => [row.name, row.n]));
		const role = (folder, kind) => `${database}_${kind}${numbers[folder]}`;
		const salaries = async () => (await asAdmin(database, "select string_agg(name || ' ' || monthly, ', ' order by name) as s from payroll.salaries"))[0].s;
		const before = await salaries();
		assert.equal(before, "Cy 61000.00, Di 58000.00");

		// Steps of the shop, each refused, none recorded.
		const steps = [
			`set role "${role("payroll", "o")}";\ndelete from payroll.salaries;\n`,
			`set role "${role("payroll", "r")}";\n`,
			"reset role;\ndelete from payroll.salaries;\n",
			`set session authorization "${role("payroll", "o")}";\ndelete from payroll.salaries;\n`,
			"insert into payroll.salaries values ('Eve', 1);\n",
			"create table copied as select * from payroll.salaries;\n",
			"select peek();\n",
			`select qorpera_data.record_step('payroll', '009-forged', '${"0".repeat(64)}');\n`,
			"select count(*) from qorpera_data.texts;\n",
		];
		for (const text of steps) {
			put(ENV_A, { "data/shop/tables/005-try.sql": text });
			const tried = await ask(owner, "apply", { database: "shop" });
			assert.equal(states(tried).at(-1), "005-try failed", `${text}: ${JSON.stringify(tried.value)}`);
			assert.match(tried.value.results.at(-1).detail, /permission denied|Only the database folder's own owner/, text);
		}
		remove(ENV_A, "data/shop/tables/005-try.sql");
		const recorded = await asAdmin(database, "select database || '/' || name as step from qorpera_data.steps where database = 'payroll'");
		assert.deepEqual(recorded.map((row) => row.step), ["payroll/001-salaries"]);

		// Questions of the shop, each refused, none with a payroll row.
		for (const kind of ["o", "w", "r"]) {
			const switched = await ask(viewer, "query", { database: "shop", question: "switch", params: { role: role("payroll", kind) } });
			assert.equal(switched.status, 400, JSON.stringify(switched.value));
			assert.match(switched.value.error, /permission denied to set role/);
			const peeked = await ask(viewer, "query", { database: "shop", question: "switch-then-peek", params: { role: role("payroll", kind) } });
			assert.equal(peeked.status, 400, JSON.stringify(peeked.value));
		}
		for (const question of ["peek", "peek-xml", "texts"]) {
			const peeked = await ask(viewer, "query", { database: "shop", question });
			assert.equal(peeked.status, 400, `${question}: ${JSON.stringify(peeked.value)}`);
			assert.match(peeked.value.error, /permission denied/, question);
		}

		// A folder's read login cannot write, its write login cannot make tables, and neither lifts its temp file limit.
		const reader = connect(database, role("shop", "r"), folderPassword(logins.folderKey, role("shop", "r")));
		const writer = connect(database, role("shop", "w"), folderPassword(logins.folderKey, role("shop", "w")));
		await reader.connect();
		await writer.connect();
		try {
			const code = (work) => work.then(() => "done", (error) => error.code);
			assert.equal(await code(reader.query("insert into shop.orders (customer, amount) values ('x', 1)")), "42501");
			assert.equal(await code(writer.query("create table shop.made (id int)")), "42501");
			assert.equal(await code(writer.query("insert into shop.orders (customer, amount) values ('w', 1)")), "done");
			assert.equal(await code(writer.query("delete from shop.orders where customer = 'w'")), "done");
			assert.equal((await reader.query("show temp_file_limit")).rows[0].temp_file_limit, "256MB");
			assert.equal(await code(reader.query("set temp_file_limit = '1GB'")), "42501");
			for (const setting of [
				"log_min_messages = 'debug1'",
				"log_error_verbosity = 'verbose'",
				"log_min_error_statement = 'error'",
				"log_statement = 'all'",
				"log_min_duration_statement = 0",
				"log_min_duration_sample = 0",
				"log_transaction_sample_rate = 1",
				"log_lock_waits = on",
				"log_temp_files = 0",
			])
				assert.equal(await code(reader.query(`set ${setting}`)), "42501", setting);
			assert.equal(await code(reader.query(`set role "${role("payroll", "r")}"`)), "42501");
		} finally {
			await reader.end().catch(() => undefined);
			await writer.end().catch(() => undefined);
		}
		// No login is a member of a folder's role but the admin that made it.
		const members = await asAdmin(
			"postgres",
			"select count(*)::int as n from pg_auth_members m join pg_roles r on r.oid = m.roleid join pg_roles u on u.oid = m.member where r.rolname ~ '^c_[0-9a-f]{32}_[owr][0-9]+$' and u.rolname <> 'qorpera_data_admin'",
		);
		assert.equal(members[0].n, 0);
		assert.equal(await salaries(), before);
	});

	// ---- watch
	it("answers a watch with the same after its wait when nothing changed", async () => {
		const current = (await ask(viewer, "query", { database: "shop", question: "count" })).value;
		const began = Date.now();
		const nothing = await call(viewer, "watch", { watches: [{ database: "shop", question: "count", etag: current.etag }], wait: 1 });
		assert.deepEqual(nothing.value, { same: true });
		assert.ok(Date.now() - began >= 900, `${Date.now() - began} ms`);
	});

	it("answers a watch at once when the page holds an old answer", async () => {
		const began = Date.now();
		const stale = await call(viewer, "watch", { watches: [{ database: "shop", question: "count", etag: "an-old-etag" }], wait: 3 });
		assert.equal(stale.value.changed?.[0]?.index, 0);
		assert.equal(stale.value.changed[0].answer.rows[0][0], 240);
		assert.ok(Date.now() - began < 1_000, `${Date.now() - began} ms`);
	});

	it("answers a held watch when a row changes, and listens only while a watch is open", async () => {
		const current = (await ask(viewer, "query", { database: "shop", question: "count" })).value;
		const waiting = call(viewer, "watch", { watches: [{ database: "shop", question: "count", etag: current.etag }], wait: 3 });
		assert.equal(await until(listening, 1), 1);
		await asAdmin(companyDatabase(ENV_A), "insert into shop.orders (customer, amount) values ('Live', 150)");
		const answer = await waiting;
		assert.equal(answer.value.changed?.[0]?.answer.rows[0][0], current.rows[0][0] + 1, JSON.stringify(answer.value));
		assert.equal(await until(listening, 0), 0);
	});

	it("lets the listener go when the watching client goes away", async () => {
		const current = (await ask(viewer, "query", { database: "shop", question: "count" })).value;
		const text = JSON.stringify({ watches: [{ database: "shop", question: "count", etag: current.etag }], wait: 4 });
		const request = http.request({
			host: "127.0.0.1",
			port,
			path: `/v1/company-data/${ENV_A}/watch`,
			method: "POST",
			headers: { authorization: `Bearer ${viewer}`, "content-type": "application/json", "content-length": Buffer.byteLength(text) },
		});
		request.on("error", () => undefined);
		request.end(text);
		assert.equal(await until(listening, 1), 1);
		const gone = Date.now();
		request.destroy();
		assert.equal(await until(listening, 0, 3_000), 0);
		assert.ok(Date.now() - gone < 1_500, `${Date.now() - gone} ms`);
	});

	// ---- two companies
	it("keeps two companies with the same database apart", async () => {
		assert.notEqual(companyDatabase(ENV_A), companyDatabase(ENV_B));
		const applied = await ask(bMember, "apply", { database: "shop" }, ENV_B);
		assert.deepEqual(states(applied), ["001-orders applied"]);
		await asAdmin(companyDatabase(ENV_B), "insert into shop.orders (customer, amount) values ('Only B', 1), ('Only B', 2)");
		const a = await ask(viewer, "query", { database: "shop", question: "count" });
		const b = await ask(bMember, "query", { database: "shop", question: "count" }, ENV_B);
		assert.deepEqual([a.value.rows[0][0], b.value.rows[0][0]], [241, 242]);
		const across = await ask(viewer, "query", { database: "shop", question: "count" }, ENV_B);
		assert.equal(across.status, 404);
		const back = await ask(bMember, "query", { database: "shop", question: "count" });
		assert.equal(back.status, 404);
		assert.equal((await call(viewer, "apply", { database: "shop" }, ENV_B)).status, 404);
	});

	// ---- the HTTP side
	it("answers only POST on its calls, and refuses a body over its limit", async () => {
		assert.equal((await send({ method: "GET", path: `/v1/company-data/${ENV_A}/query`, bearer: viewer })).status, 405);
		assert.equal((await send({ path: `/v1/company-data/${ENV_A}/drop`, bearer: viewer, text: "{}" })).status, 404);
		assert.equal((await send({ path: "/elsewhere", bearer: viewer, text: "{}" })).status, 404);
		assert.equal((await send({ path: "/v1/company-data/not-a-company/query", bearer: viewer, text: "{}" })).status, 404);
		const large = JSON.stringify({ database: "shop", question: "count", note: "x".repeat(LIMITS_HERE.bodyBytes) });
		assert.equal((await send({ path: `/v1/company-data/${ENV_A}/query`, bearer: viewer, text: large })).status, 413);
		assert.equal((await send({ path: `/v1/company-data/${ENV_A}/query`, bearer: viewer, text: "not json" })).status, 400);
	});

	it("refuses a database named qorpera or starting with pg_ or qorpera_ at apply", async () => {
		for (const database of ["qorpera", "pg_things", "qorpera_more", "Shop", "1shop"]) {
			const refused = await call(owner, "apply", { database });
			assert.equal(refused.status, 400, database);
		}
	});

	// ---- the watcher
	it("ends a statement of a folder's login that runs past its door's limit, and only then", async () => {
		const database = companyDatabase(ENV_A);
		const [{ n }] = await asAdmin(database, "select n from qorpera_data.databases where name = 'shop'");
		const login = (kind) => `${database}_${kind}${n}`;
		// The shop's read login (a question's limit) and its write login (a change's limit, longer).
		const reader = connect(database, login("r"), folderPassword(logins.folderKey, login("r")));
		const stepper = connect(database, login("w"), folderPassword(logins.folderKey, login("w")));
		await reader.connect();
		await stepper.connect();
		try {
			// Direct logins with no time limit of their own: only the watcher stops them.
			const reading = reader.query("select pg_sleep(30)").then(() => "finished", (error) => error.code);
			const changing = stepper.query("select pg_sleep(30)").then(() => "finished", (error) => error.code);
			await sleep(200);
			assert.deepEqual((await gateway.watchOnce()).ended, []);
			await sleep(LIMITS_HERE.questionMs + 2_000);
			const looked = await gateway.watchOnce();
			assert.deepEqual(looked.ended.map((one) => `${one.login} ${one.database}`), [`${login("r")} ${database}`]);
			assert.equal(await reading, "57014");
			// A change's limit is longer: it runs on, until the test ends it.
			await asAdmin("postgres", "select pg_cancel_backend(pid) from pg_stat_activity where usename = $1 and query = 'select pg_sleep(30)'", [login("w")]);
			assert.equal(await changing, "57014");
		} finally {
			await reader.end().catch(() => undefined);
			await stepper.end().catch(() => undefined);
		}
	});

	it("closes a company's steps at its size limit, and its questions still answer", async () => {
		assert.deepEqual((await gateway.watchOnce()).full, []);
		const small = new Gateway({
			store: { host: "127.0.0.1", port: storePort, logins },
			platform: new Platform({ url: "http://platform", publishableKey: "publishable", fetch: platformFetch }),
			limits: { ...LIMITS_HERE, companyBytes: 1024 ** 2 },
		});
		const smallServer = await serve(small);
		const mainPort = port;
		port = smallServer.address().port;
		try {
			const refusedBefore = await ask(owner, "apply", { database: "shop" });
			assert.equal(refusedBefore.status, 200, "before the watcher looked, steps apply");
			const looked = await small.watchOnce();
			assert.deepEqual(new Set(looked.full), new Set([companyDatabase(ENV_A), companyDatabase(ENV_B)]));
			const refused = await ask(owner, "apply", { database: "shop" });
			assert.equal(refused.status, 507);
			assert.equal(refused.value.error, "This company's database is at its size limit of 1 MiB: delete rows or ask for more room");
			const question = await ask(viewer, "query", { database: "shop", question: "count" });
			assert.equal(question.status, 200);
			assert.equal(question.value.rows[0][0], 241);
		} finally {
			port = mainPort;
			smallServer.close();
			smallServer.closeAllConnections();
			await small.close();
		}
		assert.equal((await ask(owner, "apply", { database: "shop" })).status, 200, "the other gateway's limit is its own");
		assert.ok(platformCalls > 0);
	});

	it("holds a step that drops a column with its type, its domain or its schema, and keeps the values", async () => {
		const database = companyDatabase(ENV_A);
		assert.deepEqual(states(await ask(contributor, "apply", { database: "kinds" })), ["001-items applied"]);
		const values = async () => (await asAdmin(database, "select string_agg(id || ' ' || mood || ' ' || cost, ', ' order by id) as v from kinds.items"))[0].v;
		const before = await values();
		for (const [text, wanted] of [
			["drop type mood cascade;\n", ["dropped table column", "kinds.items.mood"]],
			["drop domain price cascade;\n", ["dropped table column", "kinds.items.cost"]],
			["drop schema kinds cascade;\n", ["dropped table", "kinds.items"]],
		]) {
			put(ENV_A, { "data/kinds/tables/002-try.sql": text });
			const tried = await ask(contributor, "apply", { database: "kinds" });
			assert.deepEqual(states(tried), ["001-items already", "002-try held"], `${text}: ${JSON.stringify(tried.value)}`);
			const destroys = tried.value.results[1].destroys.map((effect) => [effect.what, effect.object]);
			assert.ok(destroys.some(([what, object]) => what === wanted[0] && object === wanted[1]), `${text}: ${JSON.stringify(destroys)}`);
			if (text.startsWith("drop schema")) assert.ok(destroys.some(([what, object]) => what === "dropped schema" && object === "kinds"), JSON.stringify(destroys));
		}
		assert.equal(await values(), before);
	});

	/** Runs `work` against a second gateway on the same store, with its own limits, then puts the first one back. */
	const withGateway = async (options, work) => {
		const other = new Gateway({
			store: { host: "127.0.0.1", port: storePort, logins },
			platform: new Platform({ url: "http://platform", publishableKey: "publishable", fetch: platformFetch }),
			limits: LIMITS_HERE,
			...options,
		});
		const otherServer = await serve(other);
		const mainPort = port;
		port = otherServer.address().port;
		let failed = false;
		try {
			return await work(other);
		} catch (error) {
			failed = true;
			throw error;
		} finally {
			port = mainPort;
			otherServer.close();
			otherServer.closeAllConnections();
			// A pool ends only when every connection it lent is back: a gateway that kept one would never close, and the
			// run would wait on it for ever. Say so instead (the work's own failure, if it had one, is the one shown).
			let timer;
			const closed = await Promise.race([
				other.close().then(() => true),
				new Promise((resolve) => {
					timer = setTimeout(resolve, 10_000, false);
				}),
			]);
			clearTimeout(timer);
			if (!closed && !failed) assert.fail("the gateway did not close within 10 s: it never gave a connection back");
		}
	};

	it("ends the backend of a statement that catches the watcher's cancel, and the next question works", async () => {
		put(ENV_A, {
			"data/shop/tables/005-stubborn.sql":
				`create function stubborn() returns int language plpgsql as $f$\nbegin\n\tloop\n\t\tbegin\n\t\t\tperform pg_sleep(10), '${MARKER}-stubborn';\n\t\texception when query_canceled then\n\t\t\tnull;\n\t\tend;\n\tend loop;\nend $f$;\n`,
		});
		assert.equal(states(await ask(owner, "apply", { database: "shop" })).at(-1), "005-stubborn applied");
		const database = companyDatabase(ENV_A);
		const began = Date.now();
		const asking = ask(viewer, "query", { database: "shop", question: "stubborn" });
		// Its own time limit is caught, so it runs on until the watcher's margin has passed.
		await sleep(LIMITS_HERE.questionMs + 2_300);
		const first = await gateway.watchOnce();
		assert.deepEqual(first.ended.map((one) => one.how), ["cancelled"]);
		await sleep(200);
		const second = await gateway.watchOnce();
		assert.deepEqual(second.ended.map((one) => one.how), ["terminated"]);
		const answer = await asking;
		assert.equal(answer.status, 408, JSON.stringify(answer.value));
		assert.ok(Date.now() - began < 5_000);
		const left = await asAdmin("postgres", "select count(*)::int as n from pg_stat_activity where pid = $1", [second.ended[0].pid]);
		assert.equal(left[0].n, 0, "the backend is gone");
		const next = await ask(viewer, "query", { database: "shop", question: "count" });
		assert.equal(next.status, 200, JSON.stringify(next.value));
	});

	it("makes a company's database again when an earlier attempt failed between its creation and its grants", async () => {
		const database = companyDatabase(ENV_C);
		let fail = true;
		await withGateway(
			{
				onProvision: (_, stage) => {
					if (stage === "revoked" && fail) {
						fail = false;
						throw new Error("injected");
					}
				},
			},
			async () => {
				const broken = await ask(owner, "apply", { database: "shop" }, ENV_C);
				assert.equal(broken.status, 503, JSON.stringify(broken.value));
				const grants = await asAdmin("postgres", "select datacl::text as acl from pg_database where datname = $1", [database]);
				assert.doesNotMatch(grants[0].acl ?? "", /qorpera_data_keeper/, "the failure came before the grant");
				const retried = await ask(owner, "apply", { database: "shop" }, ENV_C);
				assert.deepEqual(states(retried), ["001-orders applied"]);
			},
		);
		const [{ acl }] = await asAdmin("postgres", "select datacl::text as acl from pg_database where datname = $1", [database]);
		assert.match(acl, /qorpera_data_keeper=c\//);
		assert.match(acl, /qorpera_data_watch=c\//);
		// Set on a database made whole again, as on one made at once.
		for (const made of [database, companyDatabase(ENV_A)]) {
			const settings = await asAdmin("postgres", "select array_to_string(setconfig, ',') as s from pg_db_role_setting r join pg_database d on d.oid = r.setdatabase where d.datname = $1 and r.setrole = 0", [made]);
			assert.equal(
				settings[0].s,
				"temp_file_limit=256MB,work_mem=16MB,max_parallel_workers_per_gather=0,log_min_messages=panic,log_error_verbosity=terse," +
					"log_min_error_statement=panic,log_statement=none,log_min_duration_statement=-1,log_min_duration_sample=-1," +
					"log_transaction_sample_rate=0,log_lock_waits=off,log_temp_files=-1",
				made,
			);
		}
		// The first gateway, which never made it, asks it as any other.
		const count = await ask(owner, "query", { database: "shop", question: "count" }, ENV_C);
		assert.deepEqual(count.value.rows, [[240]]);
	});

	const naps = (n) => Array.from({ length: n }, (_, index) => ({ database: "shop", question: "nap", params: { k: index + 1 }, etag: "old" }));

	it("asks a watch's 24 questions a few at a time, inside its deadline", async () => {
		const began = Date.now();
		const answer = await call(viewer, "watch", { watches: naps(24), wait: 3, texts: { [sha256(FOLDERS[ENV_A].get("data/shop/queries/nap.sql"))]: FOLDERS[ENV_A].get("data/shop/queries/nap.sql") } });
		const took = Date.now() - began;
		assert.equal(answer.status, 200, JSON.stringify(answer.value).slice(0, 300));
		assert.deepEqual(answer.value.changed.map((one) => one.answer.rows[0][1]), Array.from({ length: 24 }, (_, index) => index + 1));
		// One after another they take 4.8 s; three at a time 1.6 s.
		assert.ok(took < 3_000, `${took} ms`);
	});

	it("answers a watch at its deadline with what it has, and starts no question after it", async () => {
		// The shop's read login holds 3 connections, and the first gateway's are idle until they time out.
		const [{ n: shop }] = await asAdmin(companyDatabase(ENV_A), "select n from qorpera_data.databases where name = 'shop'");
		const held = async () =>
			(await asAdmin("postgres", "select count(*)::int as n from pg_stat_activity where usename = $1", [`${companyDatabase(ENV_A)}_r${shop}`]))[0].n;
		assert.equal(await until(held, 0, 7_000), 0);
		await withGateway({ limits: { ...LIMITS_HERE, watchMs: 1_000 } }, async () => {
			const began = Date.now();
			const answer = await call(viewer, "watch", { watches: naps(24), wait: 20 });
			const took = Date.now() - began;
			assert.equal(answer.status, 200, JSON.stringify(answer.value).slice(0, 300));
			assert.ok(took < 1_400, `${took} ms`);
			assert.ok(answer.value.changed.length > 0 && answer.value.changed.length < 24, `${answer.value.changed.length} answered`);
			assert.equal(answer.value.partial, true);
			// The page now holds every answer but the last: repeated calls never fit all 24, so each goes on from where
			// the last stopped, and the change in the last question comes back within a few calls.
			const etags = new Map(answer.value.changed.map((one) => [one.index, one.answer.etag]));
			const known = naps(24).map((watched, index) => ({ ...watched, etag: etags.get(index) ?? null }));
			for (let index = 0; index < 23; index += 3) {
				const some = await Promise.all(
					known.slice(index, Math.min(index + 3, 23)).map((watched) => call(viewer, "query", { database: "shop", question: "nap", params: watched.params })),
				);
				some.forEach((one, offset) => {
					known[index + offset].etag = one.value.etag;
				});
			}
			known[23].etag = "old";
			let calls = 0;
			let found = null;
			while (calls < 4 && !found) {
				calls++;
				const again = await call(viewer, "watch", { watches: known, wait: 20 });
				assert.equal(again.status, 200, JSON.stringify(again.value).slice(0, 300));
				const indexes = (again.value.changed ?? []).map((one) => one.index);
				if (indexes.includes(23)) found = again.value;
				// Never a plain "the same" while questions were left unasked.
				else assert.equal(again.value.partial, true, JSON.stringify(again.value).slice(0, 300));
				assert.deepEqual(indexes.filter((one) => one !== 23), [], "only the last answer changed");
			}
			assert.ok(found, `the last question's change came back within ${calls} calls`);
		});
		const [{ n }] = await asAdmin(companyDatabase(ENV_A), "select n from qorpera_data.databases where name = 'shop'");
		const active = await asAdmin("postgres", "select count(*)::int as n from pg_stat_activity where usename = $1 and state = 'active'", [`${companyDatabase(ENV_A)}_r${n}`]);
		assert.equal(active[0].n, 0);
	});

	it("stops a watch's questions when its caller goes away", async () => {
		const [{ n }] = await asAdmin(companyDatabase(ENV_A), "select n from qorpera_data.databases where name = 'shop'");
		const reader = `${companyDatabase(ENV_A)}_r${n}`;
		const active = async () => (await asAdmin("postgres", "select count(*)::int as n from pg_stat_activity where usename = $1 and state = 'active'", [reader]))[0].n;
		const text = JSON.stringify({ watches: naps(24), wait: 3 });
		const request = http.request({
			host: "127.0.0.1",
			port,
			path: `/v1/company-data/${ENV_A}/watch`,
			method: "POST",
			headers: { authorization: `Bearer ${viewer}`, "content-type": "application/json", "content-length": Buffer.byteLength(text) },
		});
		request.on("error", () => undefined);
		request.end(text);
		assert.equal(await until(active, 3), 3, "three questions at a time");
		const gone = Date.now();
		request.destroy();
		assert.equal(await until(active, 0, 2_000), 0);
		assert.ok(Date.now() - gone < 400, `${Date.now() - gone} ms: cancelled, not left to finish`);
		assert.equal(await until(listening, 0), 0);
	});

	it("never sends a late cancel to a connection another call has taken", async () => {
		const [{ n }] = await asAdmin(companyDatabase(ENV_A), "select n from qorpera_data.databases where name = 'shop'");
		const reader = `${companyDatabase(ENV_A)}_r${n}`;
		const connections = async () => (await asAdmin("postgres", "select count(*)::int as n from pg_stat_activity where usename = $1", [reader]))[0].n;
		const active = async () => (await asAdmin("postgres", "select count(*)::int as n from pg_stat_activity where usename = $1 and state = 'active'", [reader]))[0].n;
		assert.equal(await until(connections, 0, 7_000), 0);
		let letCancelGo = () => undefined;
		const held = new Promise((resolve) => {
			letCancelGo = resolve;
		});
		await withGateway({ beforeCancel: () => held }, async () => {
			// A watch whose caller goes away while its one question runs: its cancel waits.
			const text = JSON.stringify({ watches: naps(1), wait: 3 });
			const request = http.request({
				host: "127.0.0.1",
				port,
				path: `/v1/company-data/${ENV_A}/watch`,
				method: "POST",
				headers: { authorization: `Bearer ${viewer}`, "content-type": "application/json", "content-length": Buffer.byteLength(text) },
			});
			request.on("error", () => undefined);
			request.end(text);
			assert.equal(await until(active, 1), 1);
			request.destroy();
			// The question ends by itself and its connection is let go; the next call takes a connection.
			assert.equal(await until(active, 0), 0);
			const next = call(viewer, "query", { database: "shop", question: "nap", params: { k: 99 } });
			assert.equal(await until(active, 1), 1);
			letCancelGo();
			const answer = await next;
			assert.equal(answer.status, 200, JSON.stringify(answer.value));
			assert.deepEqual(answer.value.rows[0], ["", 99]);
		});
	});

	it("stops a watch's other questions when one of them fails", async () => {
		const [{ n }] = await asAdmin(companyDatabase(ENV_A), "select n from qorpera_data.databases where name = 'shop'");
		const reader = `${companyDatabase(ENV_A)}_r${n}`;
		const active = async () => (await asAdmin("postgres", "select count(*)::int as n from pg_stat_activity where usename = $1 and state = 'active'", [reader]))[0].n;
		const watches = [{ database: "shop", question: "writes", etag: "old" }, ...naps(12)];
		const began = Date.now();
		const failed = await call(viewer, "watch", { watches, wait: 3 });
		assert.equal(failed.status, 400, JSON.stringify(failed.value).slice(0, 300));
		assert.ok(Date.now() - began < 400, `${Date.now() - began} ms`);
		const ended = Date.now();
		assert.equal(await until(active, 0, 2_000), 0);
		// Left running, the other 12 would take 0.8 s three at a time.
		assert.ok(Date.now() - ended < 300, `${Date.now() - ended} ms`);
		assert.equal(await until(listening, 0), 0);
	});

	it("writes none of a company's values into the server's log", async () => {
		const marker = MARKER;
		put(ENV_A, {
			"data/shop/queries/cast.sql": "select :v::int as n;\n",
			"data/shop/queries/slow-mark.sql": `select pg_sleep(1) as waited, '${marker}-slow' as m;\n`,
			"data/shop/queries/fast-mark.sql": `select '${marker}-fast' as m;\n`,
			"data/shop/tables/006-try.sql": `insert into orders (customer, amount) values ('${marker}-row', -5);\n`,
			"data/shop/actions/note.sql": "update orders set note = :v where id = :id::bigint returning note;\n",
			"data/shop/actions/bad-row.sql": `insert into orders (customer, amount) values ('${marker}-change-row', :amount::numeric);\n`,
		});
		const cast = await ask(viewer, "query", { database: "shop", question: "cast", params: { v: `${marker}-cast` } });
		assert.equal(cast.status, 400);
		assert.match(cast.value.error, new RegExp(`${marker}-cast`), "the caller hears the error");
		const step = await ask(owner, "apply", { database: "shop" });
		assert.equal(states(step).at(-1), "006-try failed", JSON.stringify(step.value));
		remove(ENV_A, "data/shop/tables/006-try.sql");
		assert.equal((await ask(viewer, "query", { database: "shop", question: "slow-mark" })).status, 408);
		assert.equal((await ask(viewer, "query", { database: "shop", question: "fast-mark" })).status, 200);
		// A lock wait between two of the company's sessions, past the server's deadlock_timeout.
		const database = companyDatabase(ENV_A);
		const [{ n }] = await asAdmin(database, "select n from qorpera_data.databases where name = 'shop'");
		const login = `${database}_w${n}`;
		const first = connect(database, login, folderPassword(logins.folderKey, login));
		const second = connect(database, login, folderPassword(logins.folderKey, login));
		await first.connect();
		await second.connect();
		try {
			await first.query(`begin; update shop.orders set note = '${marker}-lock-1' where id = 1`);
			const waiting = second.query(`update shop.orders set note = '${marker}-lock-2' where id = 1`);
			await sleep(400);
			await first.query("rollback");
			await waiting;
			await second.query("update shop.orders set note = null where id = 1");
		} finally {
			await first.end().catch(() => undefined);
			await second.end().catch(() => undefined);
		}
		// A change's values, what it gives back, and its error with the row that failed. (After the two logins above:
		// the write login holds two connections, and the gateway keeps the ones a change used for a few seconds.)
		const noted = await ask(viewer, "change", { database: "shop", change: "note", params: { v: `${marker}-change`, id: 1 } });
		assert.deepEqual([noted.status, noted.value.rows], [200, [[`${marker}-change`]]], JSON.stringify(noted.value));
		assert.equal((await ask(viewer, "change", { database: "shop", change: "note", params: { v: null, id: 1 } })).status, 200);
		const badRow = await ask(viewer, "change", { database: "shop", change: "bad-row", params: { amount: -5 } });
		assert.equal(badRow.status, 400, JSON.stringify(badRow.value));
		assert.match(badRow.value.error, /orders_amount_check/, "the caller hears the error");
		const logs = spawnSync("docker", ["logs", container], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
		const all = `${logs.stdout}${logs.stderr}`;
		// The server does log: the test's own statements in another database are there. And the stubborn function's
		// marker, which the watcher's termination would have quoted as context, is not.
		assert.match(all, /statement: /);
		assert.equal(all.includes(marker), false, all.split("\n").filter((line) => line.includes(marker)).slice(0, 5).join("\n"));
	});

	// ---- named changes (§8): a member's change, run as the database folder's write login
	const desk = async (text) => (await asAdmin(companyDatabase(ENV_A), text))[0];
	const change = (bearer, name, params = {}, more = {}) => ask(bearer, "change", { database: "desk", change: name, params, ...more });
	/** A folder's write login holds two connections, and a gateway keeps the ones its changes used for a few seconds.
	 * Before a second gateway runs changes here, the first has given them back. (One gateway runs on a store.) */
	const writersGone = async () => {
		const writers = async () =>
			(await asAdmin("postgres", "select count(*)::int as n from pg_stat_activity where datname = $1 and usename ~ '_w[0-9]+$'", [companyDatabase(ENV_A)]))[0].n;
		assert.equal(await until(writers, 0, 10_000), 0, "the first gateway still holds the write login's connections");
	};

	it("runs a named change as the member who asks, and gives back what its statement returns", async () => {
		assert.equal((await ask(contributor, "apply", { database: "desk" })).value.applied, true);
		// The gateway asks for the change's text by its hash, as for a question.
		const first = await call(viewer, "change", { database: "desk", change: "open-ticket", params: { title: "Printer jam" } });
		assert.deepEqual(first.value.need?.map((wanted) => wanted.path), ["data/desk/actions/open-ticket.sql"]);
		assert.equal((await desk("select count(*)::int as n from desk.tickets")).n, 30, "nothing ran before the text came");
		// A member who may read the change's file may run it: the viewer.
		const opened = await change(viewer, "open-ticket", { title: "Printer jam" });
		assert.equal(opened.status, 200, JSON.stringify(opened.value));
		const { asOf, ...answer } = opened.value;
		assert.deepEqual(answer, { changed: 1, columns: ["id", "title"], rows: [[31, "Printer jam"]], more: false });
		assert.ok(Math.abs(Date.parse(asOf) - Date.now()) < 5_000);
		assert.deepEqual(await desk("select title, state, opened_by from desk.tickets where id = 31"), { title: "Printer jam", state: "open", opened_by: VIEWER });
		// A statement that gives nothing back says how many rows it changed, and no rows.
		const closed = await change(viewer, "close-ticket", { id: 1 });
		assert.deepEqual([closed.status, closed.value.changed, closed.value.columns, closed.value.rows], [200, 1, undefined, undefined]);
		assert.equal((await change(viewer, "close-ticket", { id: "2" })).value.changed, 1, "a value is text, a number, true, false or null");
		assert.equal((await change(viewer, "close-ticket", { id: 9999 })).value.changed, 0);
		// Deleting rows is the change's own defined act, and runs.
		const removed = await change(owner, "remove-ticket", { id: 3 });
		assert.deepEqual([removed.status, removed.value.changed], [200, 1], JSON.stringify(removed.value));
		assert.equal((await desk("select count(*)::int as n from desk.tickets where id = 3")).n, 0);
		// One statement may hold several writes as `with` parts.
		const moved = await change(owner, "move", { id: 4 });
		assert.deepEqual([moved.value.changed, moved.value.rows], [1, [["removed Ticket 4"]]], JSON.stringify(moved.value));
		assert.equal((await desk("select count(*)::int as n from desk.tickets where id = 4")).n, 0);
		// A change is committed, so a record of the rows it deleted would be kept for good: there is none. (A step's
		// deletes are recorded, which is how it is held; its record is rolled back with it.)
		assert.equal((await desk("select count(*)::int as n from qorpera_data.step_effects")).n, 0);
		assert.equal((await desk("select count(*)::int as n from qorpera_data.sealed")).n, (await desk("select count(*)::int as n from qorpera_data.steps")).n, "a seal for each applied step, none for a change");
		// A select that calls a function a step made: it says what the function gave, and no count of its own.
		const open = (await desk("select count(*)::int as n from desk.tickets where state = 'open'")).n;
		const all = await change(owner, "close-all");
		assert.deepEqual([all.status, all.value.changed, all.value.rows], [200, undefined, [[open]]], JSON.stringify(all.value));
		assert.equal((await desk("select count(*)::int as n from desk.tickets where state = 'open'")).n, 0);
	});

	it("fills :viewer itself in a change, and takes exactly the values the change names", async () => {
		const pretend = await change(owner, "open-ticket", { title: "x", viewer: VIEWER });
		assert.equal(pretend.status, 400);
		assert.match(pretend.value.error, /:viewer is filled by Qorpera/);
		const lacking = await change(owner, "open-ticket");
		assert.deepEqual([lacking.status, lacking.value.error], [400, "The change takes :title"]);
		const extra = await change(owner, "open-ticket", { title: "x", other: 1 });
		assert.deepEqual([extra.status, extra.value.error], [400, "The change takes no :other"]);
		assert.equal((await change(owner, "open-ticket", { title: ["x"] })).status, 400);
		assert.equal((await desk("select count(*)::int as n from desk.tickets where title = 'x'")).n, 0);
	});

	it("refuses a change that is not there the same as one a member may not read", async () => {
		const missing = await change(viewer, "nope");
		assert.deepEqual([missing.status, missing.value.error], [404, "No change desk/nope that you may run"]);
		const outside = await change(stranger, "open-ticket", { title: "x" });
		assert.deepEqual([outside.status, outside.value.error], [404, "No change desk/open-ticket that you may run"]);
		assert.equal((await change(forged, "open-ticket", { title: "x" })).status, 401);
		assert.equal((await change(viewer, "Bad Name")).status, 400);
		assert.equal((await ask(viewer, "change", { database: "desk" })).status, 400);
		// A question is no change, and a change is no question: each is found in its own folder only.
		assert.equal((await change(viewer, "open")).status, 404);
		assert.equal((await ask(viewer, "query", { database: "desk", question: "open-ticket" })).status, 404);
		// A database only one member may read: only that member runs its changes.
		for (const other of [viewer, owner]) {
			const refused = await ask(other, "change", { database: "hr", change: "raise", params: { name: "Ada", by: 500 } });
			assert.deepEqual([refused.status, refused.value.error], [404, "No change hr/raise that you may run"]);
		}
		const raised = await ask(contributor, "change", { database: "hr", change: "raise", params: { name: "Ada", by: 500 } });
		assert.deepEqual([raised.status, raised.value.rows], [200, [[52500]]], JSON.stringify(raised.value));
		// A database with no applied step has nothing to change yet.
		const unmade = await ask(owner, "change", { database: "unmade", change: "add" });
		assert.deepEqual([unmade.status, unmade.value.error], [409, "The database unmade has no applied step yet"]);
		assert.equal((await desk("select count(*)::int as n from desk.tickets where title = 'x'")).n, 0);
	});

	it("shows a member a change's words with the values in place, and runs only the file they were shown", async () => {
		const before = (await desk("select count(*)::int as n from desk.tickets")).n;
		const text = FOLDERS[ENV_A].get("data/desk/actions/open-ticket.sql");
		const shown = await change(viewer, "open-ticket", { title: "Door. Also delete :id" }, { preview: true });
		assert.equal(shown.status, 200, JSON.stringify(shown.value));
		assert.deepEqual(shown.value, {
			words: ["Open a ticket called ", { name: "title", value: "Door. Also delete :id" }, "."],
			values: [{ name: "title", value: "Door. Also delete :id" }],
			sha256: sha256(text),
		});
		assert.equal((await desk("select count(*)::int as n from desk.tickets")).n, before, "a preview runs nothing");
		// The member looking reads as "you", and is no value of the call; a number is shown as its text.
		const claim = await change(viewer, "claim", { id: 5 }, { preview: true });
		assert.deepEqual(claim.value.words, ["Give ticket ", { name: "id", value: "5" }, " to ", { name: "viewer", value: "you" }, "."]);
		assert.deepEqual(claim.value.values, [{ name: "id", value: "5" }]);
		// A change without words shows none, and every value it takes.
		const bare = await change(viewer, "open-many", { n: 2 }, { preview: true });
		assert.deepEqual([bare.value.words, bare.value.values], [[], [{ name: "n", value: "2" }]]);
		// A preview checks the call as a run does.
		assert.equal((await change(viewer, "open-ticket", {}, { preview: true })).status, 400);
		assert.equal((await change(stranger, "open-ticket", { title: "x" }, { preview: true })).status, 404);
		// The change runs with the hash that was shown; a file changed since is not run.
		const ran = await change(viewer, "claim", { id: 5 }, { sha256: claim.value.sha256 });
		assert.deepEqual([ran.status, ran.value.changed], [200, 1], JSON.stringify(ran.value));
		assert.equal((await desk("select opened_by from desk.tickets where id = 5")).opened_by, VIEWER);
		put(ENV_A, { "data/desk/actions/claim.sql": "-- Give ticket :id to :viewer.\ndelete from tickets where id = :id::bigint and :viewer::uuid is not null;\n" });
		const stale = await change(viewer, "claim", { id: 5 }, { sha256: claim.value.sha256 });
		assert.deepEqual([stale.status, stale.value.error], [409, "The change's file was changed since it was shown: ask again"]);
		assert.equal((await desk("select count(*)::int as n from desk.tickets where id = 5")).n, 1);
		assert.equal((await change(viewer, "claim", { id: 5 }, { sha256: "not-a-hash" })).status, 400);
		assert.equal((await change(viewer, "claim", { id: 5 }, { sha256: 7 })).status, 400);
		assert.equal((await desk("select count(*)::int as n from desk.tickets where id = 5")).n, 1);
	});

	it("rolls back a change that is not one write of rows, and one that does a step's work", async () => {
		const state = async () =>
			JSON.stringify(
				await desk(`select (select count(*) from desk.tickets) as tickets, (select count(*) from desk.log) as log,
					to_regclass('desk.scratch') is not null as scratch, to_regclass('desk.more') is not null as more,
					exists (select 1 from information_schema.columns where table_schema = 'desk' and table_name = 'tickets' and column_name = 'note') as note,
					(select count(*) from qorpera_data.steps) as steps, (select count(*) from shop.orders) as orders`),
			);
		const before = await state();
		for (const [name, status, words] of [
			["two", 400, /more than one statement/],
			["setting", 400, /A change is one insert, update, delete or merge/],
			["block", 400, /A change is one insert, update, delete or merge/],
			// What the write login may not do, in PostgreSQL's words.
			["truncate", 400, /permission denied for table log/],
			["drop", 400, /must be owner of table scratch/],
			["make", 400, /permission denied for schema desk/],
			["reach", 400, /permission denied for schema shop/],
			["records", 400, /permission denied for table steps/],
			// What it can do only through a function a step made: a step's work, which waits for a member.
			["drop-through", 400, /This one also dropped table desk\.scratch, which is a step's work: nothing was changed/],
			["empty-through", 400, /This one also emptied table desk\.log, which is a step's work: nothing was changed/],
			["column-through", 400, /This one also dropped table column desk\.tickets\.note, which is a step's work: nothing was changed/],
		]) {
			const tried = await change(owner, name);
			assert.equal(tried.status, status, `${name}: ${JSON.stringify(tried.value)}`);
			assert.match(tried.value.error, words, name);
			assert.equal(await state(), before, `${name} changed something`);
		}
		// The write login's two connections are whole after every refusal: the next changes run on them.
		for (let round = 0; round < 3; round++) assert.equal((await change(owner, "close-ticket", { id: 6 })).status, 200);
	});

	it("stops a change at its time, and one that sends back more than a change may, with nothing changed", async () => {
		await writersGone();
		await withGateway({ limits: { ...LIMITS_HERE, changeMs: 500 } }, async () => {
			const began = Date.now();
			const slow = await change(owner, "slow");
			assert.deepEqual([slow.status, slow.value.error], [408, "The statement ran past its time limit"]);
			assert.ok(Date.now() - began < 2_500, `${Date.now() - began} ms`);
		});
		// 5,000 bytes a row over every ticket is past the 64 KiB a change may send back here: it is stopped under the
		// statement, which was never committed.
		const tickets = (await desk("select count(*)::int as n from desk.tickets")).n;
		assert.ok(tickets * 5_000 > LIMITS_HERE.changeBytes);
		const flood = await change(owner, "note-all", { size: 5_000 });
		assert.equal(flood.status, 400, JSON.stringify(flood.value).slice(0, 300));
		assert.equal(flood.value.error, "The change gives back more than 65536 bytes, so it was stopped and nothing was changed: give back less, such as only an id");
		assert.equal((await desk("select count(*)::int as n from desk.tickets where note is not null")).n, 0);
		// The connection that was closed is not used again, and the next change runs.
		assert.equal((await change(owner, "close-ticket", { id: 7 })).status, 200);
		// What fits is run whole, and the rows it gives back are cut at an answer's rows and bytes, with more: true.
		const many = await change(owner, "open-many", { n: LIMITS_HERE.questionRows + 10 });
		assert.deepEqual([many.status, many.value.changed, many.value.rows.length, many.value.more], [200, LIMITS_HERE.questionRows + 10, LIMITS_HERE.questionRows, true]);
		assert.equal((await desk("select count(*)::int as n from desk.tickets")).n, tickets + LIMITS_HERE.questionRows + 10);
		const wide = await change(owner, "note-all", { size: 300 });
		assert.equal(wide.status, 200, JSON.stringify(wide.value).slice(0, 300));
		assert.equal(wide.value.changed, tickets + LIMITS_HERE.questionRows + 10);
		assert.ok(JSON.stringify(wide.value.rows).length <= LIMITS_HERE.questionBytes, `${JSON.stringify(wide.value.rows).length}`);
		assert.ok(wide.value.rows.length > 0);
		assert.equal(wide.value.more, true);
		assert.equal((await desk("select count(*)::int as n from desk.tickets where note = repeat('x', 300)")).n, tickets + LIMITS_HERE.questionRows + 10);
	});

	it("keeps nothing of a change on its connection for the next one", async () => {
		// Two at once, so each of the write login's two connections runs one: each sets its session read only, moves
		// its search path and takes a session's advisory lock, and is committed.
		const stuck = await Promise.all([change(owner, "stick"), change(owner, "stick")]);
		assert.deepEqual(stuck.map((answer) => [answer.status, answer.value.rows]), [
			[200, [["on", "pg_catalog", true]]],
			[200, [["on", "pg_catalog", true]]],
		]);
		// The next changes write, find their tables, and take the same lock, on both connections.
		const next = await Promise.all([
			change(owner, "close-ticket", { id: 10 }),
			change(owner, "close-ticket", { id: 11 }),
			change(owner, "stick"),
			change(owner, "open-ticket", { title: "After" }),
		]);
		assert.deepEqual(next.map((answer) => answer.status), [200, 200, 200, 200], JSON.stringify(next.map((answer) => answer.value)));
		const locks = await asAdmin(companyDatabase(ENV_A), "select count(*)::int as n from pg_locks where locktype = 'advisory'");
		assert.equal(locks[0].n, 0);
	});

	it("brings a store made before named changes to the template's delete record, with store/update.sql", async () => {
		const database = companyDatabase(ENV_A);
		const source = async (where) => (await asAdmin(where, "select prosrc from pg_proc where oid = 'qorpera_data.rows_gone()'::regprocedure"))[0].prosrc;
		const made = await source("qorpera_company_template");
		assert.equal(await source(database), made);
		// The function as stores made before 14 November 2026 have it: every session's deleted rows are recorded.
		await asAdmin(
			database,
			`create or replace function qorpera_data.rows_gone() returns trigger language plpgsql security definer set search_path = '' as $f$
			declare v_rows bigint;
			begin
				if tg_op = 'TRUNCATE' then
					if exists (select 1 from qorpera_data.sealed s where s.txid = txid_current()) then
						raise exception 'A step may not destroy data after it was checked: % was emptied', tg_table_schema || '.' || tg_table_name;
					end if;
					insert into qorpera_data.step_effects (kind, object) values ('emptied table', tg_table_schema || '.' || tg_table_name);
				else
					select count(*) into v_rows from gone;
					if v_rows > 0 and exists (select 1 from qorpera_data.sealed s where s.txid = txid_current()) then
						raise exception 'A step may not destroy data after it was checked: rows of % were deleted', tg_table_schema || '.' || tg_table_name;
					end if;
					if v_rows > 0 then
						insert into qorpera_data.step_effects (kind, object, rows)
						values ('deleted rows', tg_table_schema || '.' || tg_table_name, v_rows);
					end if;
				end if;
				return null;
			end $f$`,
		);
		assert.notEqual(await source(database), made);
		const records = async () => (await desk("select count(*)::int as n from qorpera_data.step_effects")).n;
		assert.equal((await change(owner, "remove-ticket", { id: 12 })).value.changed, 1);
		assert.equal(await records(), 1, "the earlier store kept a record of a change's deleted rows");
		// The update, twice: the function is the template's, and what was kept so far is gone.
		psql(database, "update.sql");
		psql(database, "update.sql");
		psql("qorpera_company_template", "update.sql");
		assert.equal(await source(database), made);
		assert.equal(await source("qorpera_company_template"), made);
		assert.equal(await records(), 0);
		assert.equal((await change(owner, "remove-ticket", { id: 13 })).value.changed, 1);
		assert.equal(await records(), 0);
		// A step that deletes rows is still held, with their count.
		put(ENV_A, { "data/desk/tables/002-trim.sql": "delete from log where id = 1;\n" });
		const held = await ask(owner, "apply", { database: "desk" });
		assert.deepEqual(states(held), ["001-tickets already", "002-trim held"], JSON.stringify(held.value));
		assert.deepEqual(held.value.results.at(-1).destroys, [{ what: "deleted rows", object: "desk.log", rows: 1 }]);
		remove(ENV_A, "data/desk/tables/002-trim.sql");
		assert.equal(await records(), 0);
	});

	it("tells an open page when a change ran", async () => {
		await asAdmin(companyDatabase(ENV_A), "update desk.tickets set state = 'open' where id = 8");
		const current = (await ask(viewer, "query", { database: "desk", question: "open" })).value;
		const waiting = call(viewer, "watch", { watches: [{ database: "desk", question: "open", etag: current.etag }], wait: 3 });
		assert.equal(await until(listening, 1), 1);
		const opened = await change(owner, "open-ticket", { title: "Live" });
		assert.equal(opened.status, 200, JSON.stringify(opened.value));
		const answer = await waiting;
		assert.equal(answer.value.changed?.[0]?.answer.rows[0][0], current.rows[0][0] + 1, JSON.stringify(answer.value));
		assert.equal(await until(listening, 0), 0);
	});

	it("runs only a change that deletes rows while a company's database is at its size limit", async () => {
		await writersGone();
		await withGateway({ limits: { ...LIMITS_HERE, companyBytes: 1024 ** 2 } }, async (other) => {
			assert.equal((await change(owner, "open-ticket", { title: "Before the watcher looked" })).status, 200);
			assert.ok((await other.watchOnce()).full.includes(companyDatabase(ENV_A)));
			const tickets = (await desk("select count(*)::int as n from desk.tickets")).n;
			const state = async () =>
				JSON.stringify(
					await desk(`select (select count(*) from desk.tickets) as tickets, (select count(*) from desk.log) as log,
						(select count(*) from pg_largeobject_metadata) as blobs`),
				);
			const before = await state();
			const full = "This company's database is at its size limit of 1 MiB: only a change that deletes rows and writes none runs until there is room";
			const refused = await change(owner, "open-ticket", { title: "No room" });
			assert.deepEqual([refused.status, refused.value.error], [507, full]);
			// It is what the transaction wrote that counts, not the statement's word: an update, an insert that carries a
			// delete, and a delete that carries an insert in a `with` part, in a function a step made, or in a large object.
			for (const [name, params] of [
				["close-ticket", { id: 9 }],
				["move", { id: 9 }],
				["sneak", {}],
				["remove-logged", { id: 9 }],
				["blob", { id: 9 }],
			]) {
				const tried = await change(owner, name, params);
				assert.deepEqual([tried.status, tried.value.error], [507, full], `${name}: ${JSON.stringify(tried.value)}`);
				assert.equal(await state(), before, `${name} wrote something`);
			}
			// What only deletes runs, whatever its word: a delete, and a merge that deletes.
			const removed = await change(owner, "remove-ticket", { id: 9 });
			assert.deepEqual([removed.status, removed.value.changed], [200, 1], JSON.stringify(removed.value));
			const merged = await change(owner, "merge-remove", { id: 14 });
			assert.deepEqual([merged.status, merged.value.changed], [200, 1], JSON.stringify(merged.value));
			assert.equal((await desk("select count(*)::int as n from desk.tickets")).n, tickets - 2);
		});
		// With room (the first gateway's limit is its own), a delete that carries an insert runs: both land.
		const logged = await change(owner, "remove-logged", { id: 15 });
		assert.deepEqual([logged.status, logged.value.changed, logged.value.rows], [200, 1, [[true]]], JSON.stringify(logged.value));
		assert.deepEqual(await desk("select count(*)::int as n from desk.log where line = 'removed 15'"), { n: 1 });
	});

	// ---- the run door (SLICE5): an agent's run, through the node's private token and a data pass
	const STOCK = "create table items (id int primary key, name text not null, owner uuid);\ninsert into items select n, 'item ' || n, null from generate_series(1, 100) n;\n";
	put(ENV_D, {
		"data/stock/database.toml": 'format = "qorpera.database/v1"\nname = "Stock"\nabout = "What the shop holds" # one line\n',
		"data/stock/tables/001-items.sql": STOCK,
		"data/stock/queries/count.sql": "-- How many items there are.\nselect count(*) as items from items;\n",
		"data/stock/queries/mine.sql": "-- The items a member owns.\nselect count(*) as items from items where owner = :viewer::uuid;\n",
		"data/stock/queries/named.sql": "-- One item by its id.\nselect name from items where id = :id::int;\n",
		"data/stock/notes.md": "Not a database's file",
		"data/diary/database.toml": 'format = "qorpera.database/v1"\n',
		"data/diary/tables/001-days.sql": "create table days (day date primary key);\n",
		"data/loose/tables/001-a.sql": "create table a ();\n",
	});
	const runSend = (verb, body, token = RUN_TOKEN) =>
		send({ to: runServer.address().port, path: `/v1/run-data/${verb}`, bearer: token, text: JSON.stringify(body) });
	/** A call as the tool makes it: a new pass for each call, and the texts the gateway asks for, read as the run. */
	const runAsk = async (verb, body, { env = ENV_D, user = OWNER, database = body.database ?? null } = {}) => {
		let answer = await runSend(verb, { ...body, pass: passFor(env, user, database) });
		for (let round = 0; round < 3 && answer.status === 200 && answer.value.need; round++) {
			const texts = Object.fromEntries(answer.value.need.map((wanted) => [wanted.sha256, TEXTS.get(wanted.sha256)]));
			answer = await runSend(verb, { ...body, texts, pass: passFor(env, user, database) });
		}
		return answer;
	};

	it("opens the run door only to the node's token with a pass that redeems once, the same 401 for everything else", async () => {
		const refused = { status: 401, value: { error: "Not allowed" } };
		const pass = passFor(ENV_D, OWNER, "stock");
		assert.deepEqual(await runSend("describe", { pass }, "wrong-token"), refused, "a wrong token");
		assert.deepEqual(await send({ to: runServer.address().port, path: "/v1/run-data/describe", text: JSON.stringify({ pass }) }), refused, "no token");
		assert.deepEqual(await runSend("describe", {}), refused, "no pass");
		assert.deepEqual(await runSend("describe", { pass: "short" }), refused, "not a pass");
		assert.deepEqual(await runSend("describe", { pass: randomBytes(32).toString("base64url") }), refused, "an unknown pass");
		const expired = passFor(ENV_D, OWNER, "stock", { ms: -1 });
		assert.deepEqual(await runSend("describe", { pass: expired }), refused, "an expired pass");
		assert.equal((await runSend("describe", { pass })).status, 200, "the pass, once");
		assert.deepEqual(await runSend("describe", { pass }), refused, "the same pass again");
		// The members' door has no run calls, and the run door no members' calls.
		assert.equal((await send({ path: "/v1/run-data/describe", bearer: owner, text: JSON.stringify({ pass: passFor(ENV_D, OWNER) }) })).status, 404);
		assert.equal((await send({ to: runServer.address().port, path: `/v1/company-data/${ENV_D}/describe`, bearer: RUN_TOKEN, text: "{}" })).status, 404);
		assert.equal((await send({ to: runServer.address().port, method: "GET", path: "/v1/run-data/describe", bearer: RUN_TOKEN })).status, 405);
		// A gateway without the token answers nothing on the run door.
		await withGateway({}, async (other) => {
			const closed = await serveRuns(other);
			try {
				const answer = await send({ to: closed.address().port, path: "/v1/run-data/describe", bearer: RUN_TOKEN, text: JSON.stringify({ pass: passFor(ENV_D, OWNER) }) });
				assert.equal(answer.status, 404);
			} finally {
				closed.close();
				closed.closeAllConnections();
			}
		});
		// Off loopback the run door listens only with TLS, and with both its certificate and its key.
		assert.throws(() => serveRuns(gateway, { host: "0.0.0.0" }), /needs TLS/);
		assert.throws(() => serveRuns(gateway, { cert: "x" }), /both a certificate and its key/);
	});

	it("describes a run's databases before the company has a database, from the texts it asks for", async () => {
		const asked = await runSend("describe", { pass: passFor(ENV_D, OWNER) });
		assert.deepEqual(asked.value.need?.map((wanted) => wanted.path).sort(), [
			"data/stock/database.toml",
			"data/stock/queries/count.sql",
			"data/stock/queries/mine.sql",
			"data/stock/queries/named.sql",
		]);
		// The texts may come in rounds, as the tool sends them when they are many: each round's are kept, so the next
		// round asks only for the rest, and the call ends.
		const [toml, ...questions] = asked.value.need.toSorted((a, b) => (a.path < b.path ? -1 : 1));
		const textsOf = (wanted) => Object.fromEntries(wanted.map((one) => [one.sha256, TEXTS.get(one.sha256)]));
		const half = await runSend("describe", { pass: passFor(ENV_D, OWNER), texts: textsOf([toml]) });
		assert.deepEqual(half.value.need?.map((wanted) => wanted.path).sort(), questions.map((one) => one.path));
		const rest = await runSend("describe", { pass: passFor(ENV_D, OWNER), texts: textsOf(questions) });
		assert.equal(rest.status, 200, JSON.stringify(rest.value));
		assert.equal(rest.value.need, undefined, "the first round's text was kept");
		assert.deepEqual(rest.value.databases.map((database) => database.database), ["stock"]);
		const described = await runAsk("describe", {});
		assert.equal(described.status, 200, JSON.stringify(described.value));
		assert.deepEqual(described.value, {
			databases: [
				{
					database: "stock",
					name: "Stock",
					about: "What the shop holds",
					steps: { applied: [], waiting: ["001-items"], changed: [], missing: [] },
					tables: [],
					questions: [
						{ name: "count", words: "How many items there are.", parameters: [] },
						{ name: "mine", words: "The items a member owns.", parameters: ["viewer"] },
						{ name: "named", words: "One item by its id.", parameters: ["id"] },
					],
					changes: [],
				},
			],
			companyBytes: 0,
			limitBytes: LIMITS_HERE.companyBytes,
		});
		// The private database is another member's, and loose/ has no database.toml.
		assert.equal((await runAsk("describe", { database: "diary" })).status, 404);
		assert.equal((await runAsk("describe", { database: "loose" })).status, 404);
		// The viewer, whose database diary is, sees it.
		const own = await runAsk("describe", { database: "diary" }, { user: VIEWER });
		assert.equal(own.status, 200, JSON.stringify(own.value));
		assert.deepEqual(own.value.databases.map((database) => database.database), ["diary"]);
	});

	it("applies a run's database from the files its pass kept, then describes it as the store holds it", async () => {
		const first = await runSend("apply", { database: "stock", pass: passFor(ENV_D, OWNER, "stock") });
		assert.deepEqual(first.value.need?.map((wanted) => wanted.path), ["data/stock/tables/001-items.sql"]);
		const applied = await runAsk("apply", { database: "stock" });
		assert.equal(applied.value.applied, true, JSON.stringify(applied.value));
		assert.deepEqual(states(applied), ["001-items applied"]);
		const described = await runAsk("describe", { database: "stock" });
		const [stock] = described.value.databases;
		assert.deepEqual(stock.steps.waiting, []);
		assert.deepEqual(stock.steps.applied.map((step) => step.name), ["001-items"]);
		assert.deepEqual(stock.tables.map((table) => [table.name, table.columns.map((column) => column.name)]), [["items", ["id", "name", "owner"]]]);
		const [{ items }] = await asAdmin(companyDatabase(ENV_D), "select count(*)::int as items from stock.items");
		assert.ok(items > 0);
		assert.deepEqual([stock.tables[0].rows, stock.tables[0].rowsAbout], [items, undefined], "an agent sees the rows the table holds");
		assert.ok(described.value.companyBytes > 0);
		// A step a member wrote that destroys rows is held, with what it would destroy, and nothing changes.
		put(ENV_D, { "data/stock/tables/002-clear.sql": "delete from items where id > 90;\n" });
		const held = await runAsk("apply", { database: "stock" });
		assert.deepEqual(states(held), ["001-items already", "002-clear held"]);
		assert.deepEqual(held.value.results.at(-1).destroys, [{ what: "deleted rows", object: "stock.items", rows: 10 }]);
		assert.deepEqual((await runAsk("query", { database: "stock", question: "count" })).value.rows, [[100]]);
		const waiting = await runAsk("describe", { database: "stock" });
		assert.deepEqual(waiting.value.databases[0].steps.waiting, ["002-clear"]);
		remove(ENV_D, "data/stock/tables/002-clear.sql");
		// A changed applied step is said so.
		put(ENV_D, { "data/stock/tables/001-items.sql": `${STOCK}-- changed\n` });
		const changed = await runAsk("describe", { database: "stock" });
		assert.deepEqual(changed.value.databases[0].steps.changed, ["001-items"]);
		put(ENV_D, { "data/stock/tables/001-items.sql": STOCK });
	});

	it("answers a run's question and its own read with an agent's rows and bytes, as the read role, one statement", async () => {
		const count = await runAsk("query", { database: "stock", question: "count" });
		assert.equal(count.status, 200, JSON.stringify(count.value));
		assert.deepEqual(count.value.columns, ["items"]);
		assert.deepEqual(count.value.rows, [[100]]);
		assert.equal(count.value.more, false);
		assert.ok(Math.abs(Date.parse(count.value.asOf) - Date.now()) < 5_000);
		// :viewer is the member who asked the run, unless the run names one.
		await asAdmin(companyDatabase(ENV_D), "update stock.items set owner = $1 where id <= 3", [OWNER]);
		await asAdmin(companyDatabase(ENV_D), "update stock.items set owner = $1 where id between 4 and 8", [VIEWER]);
		assert.deepEqual((await runAsk("query", { database: "stock", question: "mine" })).value.rows, [[3]]);
		assert.deepEqual((await runAsk("query", { database: "stock", question: "mine", params: { viewer: VIEWER } })).value.rows, [[5]]);
		assert.equal((await runAsk("query", { database: "stock", question: "mine", params: { viewer: "nobody" } })).status, 400);
		assert.equal((await runAsk("query", { database: "stock", question: "count", params: { viewer: VIEWER } })).status, 400);
		assert.deepEqual((await runAsk("query", { database: "stock", question: "named", params: { id: 7 } })).value.rows, [["item 7"]]);
		// Its own read: one statement, read only, rows and bytes cut at an agent's limits.
		const own = await runAsk("query", { database: "stock", sql: "select id, name from items where id <= :top order by id", params: { top: 5 } });
		assert.equal(own.status, 200, JSON.stringify(own.value));
		assert.deepEqual(own.value.rows.map((row) => row[0]), [1, 2, 3, 4, 5]);
		const many = await runAsk("query", { database: "stock", sql: "select id from items order by id" });
		assert.equal(many.value.rows.length, LIMITS_HERE.agentRows);
		assert.equal(many.value.more, true);
		const wide = await runAsk("query", { database: "stock", sql: "select repeat('x', 300) as text from items" });
		assert.ok(JSON.stringify(wide.value.rows).length <= LIMITS_HERE.agentBytes, `${JSON.stringify(wide.value.rows).length}`);
		assert.equal(wide.value.more, true);
		const writes = await runAsk("query", { database: "stock", sql: "delete from items returning id" });
		assert.equal(writes.status, 400, JSON.stringify(writes.value));
		const two = await runAsk("query", { database: "stock", sql: "select 1 as one; select 2 as two" });
		assert.equal(two.status, 400);
		assert.match(two.value.error, /more than one statement/);
		const escape = await runAsk("query", { database: "stock", sql: "select count(*) from qorpera_data.steps" });
		assert.equal(escape.status, 400, JSON.stringify(escape.value));
		assert.equal((await runAsk("query", { database: "stock", question: "count", sql: "select 1" })).status, 400);
		assert.deepEqual((await asAdmin(companyDatabase(ENV_D), "select count(*)::int as n from stock.items"))[0].n, 100);
	});

	it("keeps a run to the files its pass kept", async () => {
		// A pass for stock does not open diary, nor another company's shop, nor a database the requester may not read.
		assert.equal((await runSend("query", { database: "diary", sql: "select 1", pass: passFor(ENV_D, OWNER, "stock") })).status, 404);
		assert.equal((await runSend("apply", { database: "diary", pass: passFor(ENV_D, OWNER, "stock") })).status, 404);
		assert.equal((await runAsk("query", { database: "diary", sql: "select 1" })).status, 404);
		assert.equal((await runAsk("query", { database: "shop", question: "count" }, { env: ENV_D })).status, 404);
		// The run's company is the pass's: company A's shop through a pass of company D's is not there.
		assert.equal((await runSend("query", { database: "shop", question: "count", pass: passFor(ENV_D, OWNER) })).status, 404);
		// A file's text is used only when its hash is the one the pass kept.
		put(ENV_D, { "data/stock/queries/fresh.sql": "select 42 as answer;\n" });
		const pass = passFor(ENV_D, OWNER, "stock");
		const wrong = await runSend("query", {
			database: "stock",
			question: "fresh",
			pass,
			texts: { [sha256("select 42 as answer;\n")]: "select count(*) from items;\n" },
		});
		assert.deepEqual(wrong.value.need?.map((wanted) => wanted.path), ["data/stock/queries/fresh.sql"]);
		assert.deepEqual((await runAsk("query", { database: "stock", question: "fresh" })).value.rows, [[42]]);
	});

	it("gives an agent's read its own time limit, and the watcher leaves it until then", async () => {
		// Past a question's limit and the watcher's margin (300 + 2,000 ms), inside an agent's (4,000 ms).
		const running = runAsk("query", { database: "stock", sql: "select pg_sleep(2.8) as slept, count(*) as items from items" });
		await sleep(2_500);
		const looked = await gateway.watchOnce();
		assert.deepEqual(looked.ended, [], "the watcher ended an agent's read inside its limit");
		const answer = await running;
		assert.equal(answer.status, 200, JSON.stringify(answer.value));
		assert.deepEqual(answer.value.rows[0].slice(1), [100]);
		const slow = await runAsk("query", { database: "stock", sql: "select pg_sleep(5) as slept" });
		assert.equal(slow.status, 408);
	});

	it("starts no step once an apply call's time has passed, and says which steps still wait", async () => {
		put(ENV_D, {
			"data/slow/database.toml": 'format = "qorpera.database/v1"\n',
			"data/slow/tables/001-a.sql": "create table a (id int);\nselect pg_sleep(1.2);\n",
			"data/slow/tables/002-b.sql": "create table b (id int);\nselect pg_sleep(1.2);\n",
			"data/slow/tables/003-c.sql": "create table c (id int);\n",
		});
		// 001 starts at once, 002 inside the call's 2 s, and 003 would start after them: it waits for the next call.
		await withGateway({ limits: { ...LIMITS_HERE, applyMs: 2_000 } }, async () => {
			const first = await ask(owner, "apply", { database: "slow" }, ENV_D);
			assert.equal(first.status, 200, JSON.stringify(first.value));
			assert.deepEqual(states(first), ["001-a applied", "002-b applied", "003-c waiting"]);
			assert.equal(first.value.more, true);
			assert.equal(first.value.applied, false);
			const second = await ask(owner, "apply", { database: "slow" }, ENV_D);
			assert.deepEqual(states(second), ["001-a already", "002-b already", "003-c applied"]);
			assert.equal(second.value.more, undefined);
			assert.equal(second.value.applied, true);
		});
	});

	it("runs a run's named change with the pass's files, an agent's rows and bytes, and describes the changes a database has", async () => {
		put(ENV_D, {
			"data/stock/actions/add-item.sql": "-- Add item :id called :name.\ninsert into items (id, name, owner) values (:id::int, :name, :viewer::uuid) returning id, owner;\n",
			"data/stock/actions/shout.sql": "update items set name = upper(name) returning id, name;\n",
			"data/stock/actions/broken.sql": "update items set name = 'a'; update items set name = 'b';\n",
			"data/diary/actions/add-day.sql": "insert into days values (:day::date);\n",
		});
		// The pass kept the change's file: the gateway asks for its text by that hash.
		const first = await runSend("change", { database: "stock", change: "add-item", params: { id: 500, name: "Lamp" }, pass: passFor(ENV_D, OWNER, "stock") });
		assert.deepEqual(first.value.need?.map((wanted) => wanted.path), ["data/stock/actions/add-item.sql"]);
		// A describe asks for the texts of a database's changes with its questions', and lists them with their words.
		const asked = await runSend("describe", { database: "stock", pass: passFor(ENV_D, OWNER, "stock") });
		assert.deepEqual(asked.value.need?.map((wanted) => wanted.path).sort(), [
			"data/stock/actions/add-item.sql",
			"data/stock/actions/broken.sql",
			"data/stock/actions/shout.sql",
		]);
		const described = await runAsk("describe", { database: "stock" });
		assert.equal(described.status, 200, JSON.stringify(described.value));
		assert.deepEqual(described.value.databases[0].changes, [
			{ name: "add-item", words: "Add item :id called :name.", parameters: ["id", "name", "viewer"] },
			{ name: "broken", words: "", parameters: null, problem: "The file holds more than one statement: write one" },
			{ name: "shout", words: "", parameters: [] },
		]);
		assert.ok(described.value.databases[0].questions.some((question) => question.name === "count"));
		const added = await runAsk("change", { database: "stock", change: "add-item", params: { id: 500, name: "Lamp" } });
		assert.equal(added.status, 200, JSON.stringify(added.value));
		// :viewer is the member who asked the run, unless the run names one.
		assert.deepEqual([added.value.changed, added.value.rows], [1, [[500, OWNER]]]);
		const forOther = await runAsk("change", { database: "stock", change: "add-item", params: { id: 501, name: "Desk", viewer: VIEWER } });
		assert.deepEqual(forOther.value.rows, [[501, VIEWER]], JSON.stringify(forOther.value));
		assert.equal((await runAsk("change", { database: "stock", change: "add-item", params: { id: 502, name: "x", viewer: "nobody" } })).status, 400);
		assert.equal((await runAsk("change", { database: "stock", change: "add-item", params: { id: 500, name: "Twice" } })).status, 400, "PostgreSQL's own refusal: the id is taken");
		// What it gives back is cut at an agent's rows; the change ran whole.
		const items = (await asAdmin(companyDatabase(ENV_D), "select count(*)::int as n from stock.items"))[0].n;
		const shouted = await runAsk("change", { database: "stock", change: "shout" });
		assert.deepEqual([shouted.status, shouted.value.changed, shouted.value.rows.length, shouted.value.more], [200, items, LIMITS_HERE.agentRows, true], JSON.stringify(shouted.value).slice(0, 300));
		assert.equal((await asAdmin(companyDatabase(ENV_D), "select count(*)::int as n from stock.items where name = upper(name)"))[0].n, items);
		// A pass opens only what it kept: another database's change, one that is not there, another company's.
		assert.equal((await runSend("change", { database: "diary", change: "add-day", params: { day: "2026-11-14" }, pass: passFor(ENV_D, OWNER, "stock") })).status, 404);
		assert.equal((await runAsk("change", { database: "diary", change: "add-day", params: { day: "2026-11-14" } })).status, 404, "the diary is another member's");
		assert.equal((await runAsk("change", { database: "stock", change: "nope" })).status, 404);
		assert.equal((await runAsk("change", { database: "stock", change: "broken" })).status, 400);
		assert.equal((await runSend("change", { database: "desk", change: "open-ticket", params: { title: "x" }, pass: passFor(ENV_D, OWNER) })).status, 404);
		assert.deepEqual(await runSend("change", { database: "stock", change: "shout" }), { status: 401, value: { error: "Not allowed" } }, "no pass");
		// The viewer, whose database the diary is, runs its change.
		const day = await runAsk("change", { database: "diary", change: "add-day", params: { day: "2026-11-14" } }, { user: VIEWER });
		assert.equal(day.status, 409, "the diary has no applied step yet");
		assert.equal((await runAsk("apply", { database: "diary" }, { user: VIEWER })).value.applied, true);
		const made = await runAsk("change", { database: "diary", change: "add-day", params: { day: "2026-11-14" } }, { user: VIEWER });
		assert.deepEqual([made.status, made.value.changed], [200, 1], JSON.stringify(made.value));
	});

	it("applies a held step only for a run whose pass carries a member's yes to that step, its text and what it destroys", async () => {
		const stock = async (text) => (await asAdmin(companyDatabase(ENV_D), text))[0];
		const state = async () =>
			JSON.stringify(
				await stock(`select (select count(*) from stock.items) as items,
					exists (select 1 from information_schema.columns where table_schema = 'stock' and table_name = 'items' and column_name = 'owner') as owner`),
			);
		const text = "delete from items where id > 90;\nalter table items drop column owner;\n";
		put(ENV_D, { "data/stock/tables/002-clear.sql": text });
		const gone = (await stock("select count(*)::int as n from stock.items where id > 90")).n;
		assert.ok(gone > 0);
		const before = await state();
		const destroys = [
			{ what: "deleted rows", object: "stock.items", rows: gone },
			{ what: "dropped table column", object: "stock.items.owner" },
		];
		// Held, with what it would destroy and what a yes is for: the step, its text's hash, the hash of what it destroys.
		const held = await runAsk("apply", { database: "stock" });
		assert.deepEqual(states(held), ["001-items already", "002-clear held"]);
		const { allow, ...rest } = held.value.results.at(-1);
		assert.deepEqual(rest, { name: "002-clear", state: "held", detail: "It would destroy data, which waits for a member", destroys });
		assert.match(allow, new RegExp(`^002-clear\\.${sha256(text)}\\.[0-9a-f]{64}$`));
		const otherDestroys = allow.replace(/[0-9a-f]{64}$/, "0".repeat(64));
		const otherText = `002-clear.${"0".repeat(64)}.${allow.slice(-64)}`;
		// A check runs the step, keeps nothing, and says what the card shows.
		const checked = await runAsk("apply", { database: "stock", check: allow });
		assert.deepEqual([checked.status, checked.value], [200, { step: "002-clear", destroys }], JSON.stringify(checked.value));
		assert.equal(await state(), before, "a check keeps nothing");
		for (const [check, status, words] of [
			["002-clear", 400, /check is a held step's allow/],
			[7, 400, /check is a held step's allow/],
			[`003-nope.${sha256(text)}.${"0".repeat(64)}`, 404, /No step 003-nope/],
			[`001-items.${sha256(STOCK)}.${"0".repeat(64)}`, 409, /Step 001-items is applied already/],
			[otherText, 409, /Step 002-clear was changed since it was held/],
			[otherDestroys, 409, /What step 002-clear would destroy changed since it was held/],
		]) {
			const refused = await runAsk("apply", { database: "stock", check });
			assert.equal(refused.status, status, `${check}: ${JSON.stringify(refused.value)}`);
			assert.match(refused.value.error, words);
		}
		// No yes: a run's own word for it, a member's own apply, a pass that carries a yes to something else.
		const pass = (allowed) => passFor(ENV_D, OWNER, "stock", { allow: allowed });
		for (const [who, answer] of [
			["a run that names the allow itself", await runAsk("apply", { database: "stock", allow })],
			["a member on the members' door", await ask(owner, "apply", { database: "stock", allow }, ENV_D)],
			["a yes to other rows", await runSend("apply", { database: "stock", pass: pass(otherDestroys) })],
			["a yes to another text", await runSend("apply", { database: "stock", pass: pass(otherText) })],
			["a yes to another step", await runSend("apply", { database: "stock", pass: pass(`003-clear.${allow.slice(10)}`) })],
		]) {
			assert.deepEqual(states(answer), ["001-items already", "002-clear held"], `${who}: ${JSON.stringify(answer.value)}`);
			assert.equal(answer.value.results.at(-1).allow, allow, who);
			assert.equal(await state(), before, who);
		}
		assert.equal(
			(await runSend("apply", { database: "stock", pass: pass(otherDestroys) })).value.results.at(-1).detail,
			"It would destroy data, and not what a member said yes to: it waits for a new yes",
		);
		// A row more to delete than the member was shown: the yes is not for that.
		await asAdmin(companyDatabase(ENV_D), "insert into stock.items (id, name) values (600, 'late')");
		const moved = await runSend("apply", { database: "stock", pass: pass(allow) });
		assert.deepEqual(states(moved), ["001-items already", "002-clear held"]);
		assert.notEqual(moved.value.results.at(-1).allow, allow);
		assert.equal(moved.value.results.at(-1).destroys[0].rows, gone + 1);
		assert.equal((await runAsk("apply", { database: "stock", check: allow })).status, 409);
		await asAdmin(companyDatabase(ENV_D), "delete from stock.items where id = 600");
		assert.equal(await state(), before);
		// A pass that is not a pass: its allow is no held step's.
		assert.equal((await runSend("apply", { database: "stock", pass: pass("yes") })).status, 503);
		// The yes: the step is applied, and says what it destroyed.
		const applied = await runSend("apply", { database: "stock", pass: pass(allow) });
		assert.equal(applied.status, 200, JSON.stringify(applied.value));
		assert.deepEqual(states(applied), ["001-items already", "002-clear applied"]);
		assert.deepEqual(applied.value.results.at(-1), { name: "002-clear", state: "applied", destroyed: destroys });
		assert.equal(applied.value.applied, true);
		assert.deepEqual(await stock("select count(*)::int as n from stock.items where id > 90"), { n: 0 });
		assert.equal(JSON.parse(await state()).owner, false);
		const described = await runAsk("describe", { database: "stock" });
		assert.deepEqual(described.value.databases[0].steps.applied.map((step) => step.name), ["001-items", "002-clear"]);
		// The same yes again finds the step applied: nothing more is destroyed.
		const again = await runSend("apply", { database: "stock", pass: pass(allow) });
		assert.deepEqual(states(again), ["001-items already", "002-clear already"]);
		assert.equal((await runAsk("apply", { database: "stock", check: allow })).status, 409);
	});

	it("checks only the held step that is next to apply, and says when it fails or destroys nothing", async () => {
		const drop = "drop table b;\n";
		put(ENV_D, {
			"data/yard/database.toml": 'format = "qorpera.database/v1"\n',
			"data/yard/tables/001-make.sql": "create table a (id int primary key);\ninsert into a values (1), (2), (3);\ncreate table b (id int);\n",
			"data/yard/tables/002-more.sql": "insert into a values (4);\n",
			"data/yard/tables/003-drop.sql": drop,
		});
		const first = await runAsk("apply", { database: "yard" });
		assert.deepEqual(states(first), ["001-make applied", "002-more applied", "003-drop held"]);
		const allow = first.value.results.at(-1).allow;
		assert.deepEqual(first.value.results.at(-1).destroys, [{ what: "dropped table", object: "yard.b" }]);
		// A step after the held one waits behind it, whatever it does: its check is refused, and so is its apply.
		const later = "insert into a values (5);\n";
		put(ENV_D, { "data/yard/tables/004-later.sql": later });
		const behind = await runAsk("apply", { database: "yard", check: `004-later.${sha256(later)}.${"0".repeat(64)}` });
		assert.deepEqual([behind.status, behind.value.error], [409, "Step 003-drop waits before 004-later: apply the steps before it first"]);
		assert.deepEqual(states(await runAsk("apply", { database: "yard" })), ["001-make already", "002-more already", "003-drop held"]);
		// The held step's file changed to one that fails, and to one that destroys nothing.
		put(ENV_D, { "data/yard/tables/003-drop.sql": "drop table nope;\n" });
		const fails = await runAsk("apply", { database: "yard", check: `003-drop.${sha256("drop table nope;\n")}.${"0".repeat(64)}` });
		assert.equal(fails.status, 400, JSON.stringify(fails.value));
		assert.match(fails.value.error, /^Step 003-drop fails: table "nope" does not exist/);
		put(ENV_D, { "data/yard/tables/003-drop.sql": "insert into a values (6);\n" });
		const harmless = await runAsk("apply", { database: "yard", check: `003-drop.${sha256("insert into a values (6);\n")}.${"0".repeat(64)}` });
		assert.deepEqual([harmless.status, harmless.value.error], [409, "Step 003-drop destroys nothing now: apply it without allow"]);
		assert.deepEqual((await asAdmin(companyDatabase(ENV_D), "select count(*)::int as n from yard.a"))[0], { n: 4 }, "a check keeps nothing");
		// The yes that was given is for the text that dropped the table: the step as it is now needs none, and applies.
		put(ENV_D, { "data/yard/tables/003-drop.sql": drop });
		const yes = await runSend("apply", { database: "yard", pass: passFor(ENV_D, OWNER, "yard", { allow }) });
		assert.deepEqual(states(yes), ["001-make already", "002-more already", "003-drop applied", "004-later applied"], JSON.stringify(yes.value));
		assert.deepEqual(yes.value.results[2].destroyed, [{ what: "dropped table", object: "yard.b" }]);
		assert.equal(yes.value.results[3].destroyed, undefined);
		assert.deepEqual((await asAdmin(companyDatabase(ENV_D), "select to_regclass('yard.b') is null as gone, (select count(*)::int from yard.a) as a"))[0], { gone: true, a: 5 });
	});

	const NOTES = `create table notes (id int primary key, owner uuid, text text);\ninsert into notes select n, case when n % 2 = 0 then '${VIEWER}'::uuid end, 'note ' || n from generate_series(1, 6) n;\n`;
	const OWN = "-- My notes.\nselect id, text from notes where owner = :viewer::uuid order by id;\n";
	put(ENV_E, {
		"data/crm/database.toml": 'format = "qorpera.database/v1"\nname = "CRM"\nabout = "People and their scores"\n',
		"data/crm/tables/001-people.sql": `create table people (
	id bigint generated always as identity primary key,
	name text,
	score int not null default 0,
	double int generated always as (score * 2) stored,
	note text
);
insert into people (name, score)
select case when n % 10 = 0 then null else 'Person ' || lpad(((n * 37) % 250)::text, 3, '0') end, n % 17 from generate_series(1, 250) n;
create table pairs (a int, b text, v text, primary key (a, b));
insert into pairs select n % 5, 'b' || lpad((n / 5)::text, 2, '0'), 'v' || n from generate_series(0, 59) n;
create table loose (x int generated by default as identity, y text);
insert into loose (y) select 'y' || lpad(n::text, 2, '0') from generate_series(1, 30) n;
create table wide (id int primary key, text text);
insert into wide select n, repeat('w', 300) from generate_series(1, 40) n;
create view top_people as select id, name, score from people where score > 10;
create view slow as select id, pg_sleep(0.05) is null as napped from people;
`,
		"data/crm/queries/count.sql": "-- How many people there are.\nselect count(*) as people from people;\n",
		"data/crm/queries/peek-record.sql": "select count(*) as lines from qorpera_data.row_changes;\n",
		"data/crm/actions/rename.sql": "-- Rename person :id to :name.\nupdate people set name = :name where id = :id::bigint;\n",
		"data/crm/actions/add-person.sql": "-- Add :name.\ninsert into people (name) values (:name) returning id;\n",
		"data/crm/actions/forge.sql": "insert into qorpera_data.change_log (txid, by_kind, by_id) values (txid_current(), 'member', 'someone else');\n",
		"data/mine/database.toml": 'format = "qorpera.database/v1"\nname = "Mine"\n',
		"data/mine/tables/001-notes.sql": NOTES,
		"data/mine/queries/own.sql": OWN,
		"data/open/database.toml": 'format = "qorpera.database/v1"\n\n[list]\nmembers = "readers" # every reader sees every row\n',
		"data/open/tables/001-notes.sql": NOTES,
		"data/open/queries/own.sql": OWN,
		"data/closed/database.toml": "format = \"qorpera.database/v1\"\n\n[list]\nmembers = 'writers'\n",
		"data/closed/tables/001-items.sql": "create table items (id int primary key);\ninsert into items select generate_series(1, 3);\n",
		"data/inline/database.toml": 'format = "qorpera.database/v1"\nlist = { members = "writers" }\n',
		"data/inline/tables/001-items.sql": "create table items (id int primary key);\n",
	});
	const E = companyDatabase(ENV_E);
	const inE = (text, values) => asAdmin(E, text, values);
	const listed = (bearer, body) => ask(bearer, "rows", { database: "crm", ...body }, ENV_E);
	const everyPage = async (bearer, body, pick = (row) => row.values[0]) => {
		const seen = [];
		let after = null;
		for (let round = 0; round < 100; round++) {
			const one = await listed(bearer, { ...body, ...(after === null ? {} : { after }) });
			assert.equal(one.status, 200, JSON.stringify(one.value));
			seen.push(...one.value.rows.map(pick));
			if (!one.value.more) return seen;
			assert.ok(Array.isArray(one.value.next), JSON.stringify(one.value).slice(0, 300));
			after = one.value.next;
		}
		assert.fail("the pages never ended");
	};
	const ids = async (sql) => (await inE(sql)).map((row) => Number(row.id));
	const writersOfEGone = async () => {
		const writers = async () => (await asAdmin("postgres", "select count(*)::int as n from pg_stat_activity where datname = $1 and usename ~ '_w[0-9]+$'", [E]))[0].n;
		assert.equal(await until(writers, 0, 10_000), 0, "the first gateway still holds the write login's connections");
	};

	it("applies the list's databases", async () => {
		for (const name of ["crm", "mine", "open", "closed", "inline"]) {
			const applied = await ask(contributor, "apply", { database: name }, ENV_E);
			assert.equal(applied.value.applied, true, `${name}: ${JSON.stringify(applied.value)}`);
		}
	});

	it("describes every database a member may read: each table's kind, key and the columns an edit may set, its questions and changes, write and list", async () => {
		const read = await ask(viewer, "describe", {}, ENV_E);
		assert.equal(read.status, 200, JSON.stringify(read.value));
		assert.deepEqual(
			read.value.databases.map((one) => [one.database, one.write, one.list]),
			[["closed", false, false], ["crm", false, true], ["inline", false, false], ["mine", false, false], ["open", false, true]],
		);
		const crm = read.value.databases.find((one) => one.database === "crm");
		assert.deepEqual([crm.name, crm.about], ["CRM", "People and their scores"]);
		assert.deepEqual(crm.applied.map((step) => step.name), ["001-people"]);
		const table = (name) => crm.tables.find((one) => one.name === name);
		assert.deepEqual(crm.tables.map((one) => [one.name, one.kind, one.key]), [
			["loose", "table", []],
			["pairs", "table", ["a", "b"]],
			["people", "table", ["id"]],
			["slow", "view", []],
			["top_people", "view", []],
			["wide", "table", ["id"]],
		]);
		assert.deepEqual(table("people").columns.map((column) => [column.name, column.settable]), [["id", false], ["name", true], ["score", true], ["double", false], ["note", true]]);
		assert.deepEqual(table("loose").columns.map((column) => [column.name, column.settable]), [["x", true], ["y", true]]);
		assert.deepEqual(table("top_people").columns.map((column) => column.settable), [false, false, false]);
		assert.equal(table("people").rows, 250);
		assert.deepEqual(crm.questions.find((one) => one.name === "count"), { name: "count", words: "How many people there are.", parameters: [] });
		assert.deepEqual(crm.changes.find((one) => one.name === "rename"), { name: "rename", words: "Rename person :id to :name.", parameters: ["name", "id"] });
		const mine = read.value.databases.find((one) => one.database === "mine");
		assert.deepEqual(Object.keys(mine), ["database", "name", "about", "write", "list", "questions", "changes"], "no table and no step");
		assert.deepEqual(mine.questions, [{ name: "own", words: "My notes.", parameters: ["viewer"] }]);
		assert.ok(read.value.companyBytes > 0);
		assert.equal(read.value.limitBytes, LIMITS_HERE.companyBytes);
		const written = await ask(contributor, "describe", {}, ENV_E);
		assert.deepEqual(written.value.databases.map((one) => [one.database, one.write, one.list]), ["closed", "crm", "inline", "mine", "open"].map((name) => [name, true, true]));
		assert.ok(written.value.databases.find((one) => one.database === "mine").tables.some((one) => one.name === "notes"));
		const narrowed = await ask(viewer, "describe", { database: "open" }, ENV_E);
		assert.deepEqual(narrowed.value.databases.map((one) => [one.database, one.list]), [["open", true]]);
		assert.equal((await ask(viewer, "describe", { database: "nope" }, ENV_E)).status, 404);
		assert.deepEqual((await ask(stranger, "describe", {}, ENV_E)).value.databases, []);
	});

	it("gives whole tables to a database's readers, and to its writers alone when a question shows each member their own rows: by every road", async () => {
		const tableOf = { crm: "people", mine: "notes", open: "notes", closed: "items", inline: "items" };
		const roads = async (bearer, name) => {
			const rows = await ask(bearer, "rows", { database: name, table: tableOf[name] }, ENV_E);
			const watched = await ask(bearer, "watch", { watches: [{ database: name, table: tableOf[name], etag: "old" }], wait: 0 }, ENV_E);
			const described = (await ask(bearer, "describe", { database: name }, ENV_E)).value.databases[0];
			return [rows.status, watched.status, described.tables !== undefined];
		};
		const shown = [200, 200, true];
		const hidden = [403, 403, false];
		assert.deepEqual(await roads(viewer, "mine"), hidden, "a :viewer question keeps its database's tables with its writers");
		assert.deepEqual(await roads(viewer, "closed"), hidden);
		assert.deepEqual(await roads(viewer, "inline"), hidden, "[list] as an inline table");
		assert.deepEqual(await roads(viewer, "open"), shown, "[list] members = \"readers\" gives every reader whole tables");
		assert.deepEqual(await roads(viewer, "crm"), shown);
		for (const name of ["mine", "closed", "inline", "open", "crm"]) assert.deepEqual(await roads(contributor, name), shown, name);
		const refused = await ask(viewer, "rows", { database: "mine", table: "notes" }, ENV_E);
		assert.equal(refused.value.error, "The tables of mine are shown to those who may change it");
		assert.deepEqual((await ask(viewer, "query", { database: "mine", question: "own" }, ENV_E)).value.rows, [[2, "note 2"], [4, "note 4"], [6, "note 6"]], "its questions still answer");
		writeCheckMissing = true;
		try {
			for (const bearer of [contributor, owner]) {
				assert.deepEqual(await roads(bearer, "mine"), hidden);
				assert.deepEqual(await roads(bearer, "closed"), hidden);
				assert.deepEqual(await roads(bearer, "open"), shown);
			}
			const described = await ask(contributor, "describe", {}, ENV_E);
			assert.deepEqual(described.value.databases.map((one) => [one.database, one.write, one.list]), [
				["closed", false, false],
				["crm", false, true],
				["inline", false, false],
				["mine", false, false],
				["open", false, true],
			]);
		} finally {
			writeCheckMissing = false;
		}
		assert.equal((await ask(viewer, "rows", { database: "hr", table: "salaries" }, ENV_E)).status, 404);
	});

	it("keeps the tables with the writers when the member's listing of the questions is cut at the platform's page", async () => {
		put(ENV_B, {
			"data/many/database.toml": 'format = "qorpera.database/v1"\n',
			"data/many/tables/001-items.sql": "create table items (id int primary key);\n",
			...Object.fromEntries(Array.from({ length: 1001 }, (_, index) => [`data/many/queries/q${String(index).padStart(4, "0")}.sql`, "select 1 as one;\n"])),
		});
		assert.equal((await ask(bMember, "apply", { database: "many" }, ENV_B)).value.applied, true);
		const cut = await ask(bMember, "rows", { database: "many", table: "items" }, ENV_B);
		assert.deepEqual([cut.status, cut.value.error], [403, "The tables of many are shown to those who may change it"], JSON.stringify(cut.value).slice(0, 300));
		assert.equal((await ask(bMember, "describe", { database: "many" }, ENV_B)).value.databases[0].list, false);
		remove(ENV_B, "data/many/queries/q1000.sql");
		assert.equal((await ask(bMember, "rows", { database: "many", table: "items" }, ENV_B)).status, 200, "1,000 questions fit one page");
		assert.equal((await ask(bMember, "describe", { database: "many" }, ENV_B)).value.databases[0].list, true);
	});

	it("pages a table by its key, in the order asked, and never by offset", async () => {
		const first = await listed(viewer, { table: "people", limit: 20 });
		assert.equal(first.status, 200, JSON.stringify(first.value));
		assert.deepEqual([first.value.columns, first.value.key, first.value.rows.length, first.value.more], [["id", "name", "score", "double", "note"], ["id"], 20, true]);
		assert.deepEqual(first.value.next, ["20"]);
		assert.deepEqual(first.value.rows[0].values, [1, "Person 037", 1, 2, null]);
		const [{ seen }] = await inE("select encode(sha256(convert_to(p::text, 'UTF8')), 'hex') as seen from crm.people p where id = 1");
		assert.equal(first.value.rows[0].seen, seen, "a row's seen is the hash of the row as it was read");
		assert.equal(typeof first.value.etag, "string");
		assert.deepEqual(await everyPage(viewer, { table: "people", limit: 20 }), await ids("select id from crm.people order by id"));
		assert.deepEqual(await everyPage(viewer, { table: "people", limit: 20, desc: true }), await ids("select id from crm.people order by id desc"));
		assert.deepEqual(await everyPage(viewer, { table: "people", limit: 17, order: "name", desc: true }), await ids("select id from crm.people order by name desc nulls last, id"));
		assert.deepEqual(await everyPage(viewer, { table: "people", limit: 23, order: "score" }), await ids("select id from crm.people order by score, id"));
		assert.deepEqual(await everyPage(viewer, { table: "people", limit: 9, order: "note" }), await ids("select id from crm.people order by note nulls last, id"));
		const pair = (row) => `${row.values[0]}/${row.values[1]}`;
		const pairs = async (sql) => (await inE(sql)).map((row) => `${row.a}/${row.b}`);
		assert.deepEqual(await everyPage(viewer, { table: "pairs", limit: 7 }, pair), await pairs("select a, b from crm.pairs order by a, b"));
		assert.deepEqual(await everyPage(viewer, { table: "pairs", limit: 7, order: "b", desc: true }, pair), await pairs("select a, b from crm.pairs order by b desc, a, b"));
		const wide = await listed(viewer, { table: "wide", limit: 40 });
		assert.ok(wide.value.rows.length < 40 && wide.value.more, `${wide.value.rows.length} rows`);
		assert.deepEqual(await everyPage(viewer, { table: "wide", limit: 40 }), await ids("select id from crm.wide order by id"));
		for (const [body, problem] of [
			[{ table: "people", limit: 201 }, "A page holds 1 to 200 rows"],
			[{ table: "people", limit: 0 }, "A page holds 1 to 200 rows"],
			[{ table: "people", order: "nope" }, "No column nope in people"],
			[{ table: "people", after: ["1", "2"] }, "after is the next a page gave, for the same order"],
			[{ table: "people", order: "name", after: ["x"] }, "after is the next a page gave, for the same order"],
			[{ table: "people", desc: "yes" }, "desc is true or false"],
		]) {
			const refused = await listed(viewer, body);
			assert.deepEqual([refused.status, refused.value.error], [400, problem], JSON.stringify(body));
		}
		await withGateway({ limits: { ...LIMITS_HERE, questionBytes: 256 * 1024 } }, async () => {
			const usual = await listed(viewer, { table: "people" });
			assert.deepEqual([usual.value.rows.length, usual.value.more], [100, true]);
			const most = await listed(viewer, { table: "people", limit: 200 });
			assert.deepEqual([most.value.rows.length, most.value.more, most.value.next], [200, true, ["200"]]);
		});
	});

	it("steps past a row larger than a page, saying so", async () => {
		await inE("insert into crm.wide values (41, repeat('g', 6000)), (42, 'small')");
		try {
			const pages = [];
			let after = null;
			for (let round = 0; round < 30; round++) {
				const one = await listed(viewer, { table: "wide", limit: 40, ...(after === null ? {} : { after }) });
				assert.equal(one.status, 200, JSON.stringify(one.value).slice(0, 300));
				pages.push(one.value);
				if (!one.value.more) break;
				after = one.value.next;
			}
			const large = pages.filter((one) => one.tooLarge);
			assert.equal(large.length, 1);
			assert.deepEqual([large[0].rows, large[0].next], [[], ["41"]]);
			assert.deepEqual(
				pages.flatMap((one) => one.rows.map((row) => row.values[0])),
				(await ids("select id from crm.wide order by id")).filter((id) => id !== 41),
			);
		} finally {
			await inE("delete from crm.wide where id in (41, 42)");
		}
	});

	it("gives a relation with no key its first page alone, and reads only the folder's own relations, in a question's time", async () => {
		const loose = await listed(viewer, { table: "loose", limit: 10 });
		assert.deepEqual([loose.status, loose.value.key, loose.value.rows.length, loose.value.more, loose.value.next], [200, [], 10, true, undefined]);
		const ordered = await listed(viewer, { table: "loose", limit: 5, order: "y", desc: true });
		assert.deepEqual(ordered.value.rows.map((row) => row.values[1]), ["y30", "y29", "y28", "y27", "y26"]);
		const after = await listed(viewer, { table: "loose", after: ["1"] });
		assert.deepEqual([after.status, after.value.error], [400, "loose has no key: it gives its first page alone"]);
		const view = await listed(viewer, { table: "top_people", limit: 10 });
		assert.deepEqual([view.status, view.value.rows.length, view.value.more, view.value.next], [200, 10, true, undefined]);
		for (const table of ["notes", "pg_class", "row_changes", "orders", 'people" where false; --', "people "]) {
			const refused = await listed(viewer, { table });
			assert.deepEqual([refused.status, refused.value.error], [404, `No table ${table} in crm`], table);
		}
		assert.equal((await listed(viewer, { table: "x".repeat(64) })).status, 400);
		const slow = await listed(viewer, { table: "slow" });
		assert.equal(slow.status, 408, JSON.stringify(slow.value));
		assert.equal((await listed(viewer, { table: "people", limit: 1 })).status, 200, "the read login is free again");
	});

	it("answers a table's watch when its rows change", async () => {
		const top = { database: "crm", table: "people", desc: true, limit: 5 };
		const current = (await listed(viewer, top)).value;
		const stale = await ask(viewer, "watch", { watches: [{ ...top, etag: "old" }], wait: 2 }, ENV_E);
		assert.deepEqual(stale.value.changed?.[0]?.answer.rows.map((row) => row.values[0]), current.rows.map((row) => row.values[0]));
		const same = await ask(viewer, "watch", { watches: [{ ...top, etag: current.etag }], wait: 1 }, ENV_E);
		assert.deepEqual(same.value, { same: true });
		const count = (await ask(viewer, "query", { database: "crm", question: "count" }, ENV_E)).value;
		const waiting = ask(viewer, "watch", { watches: [{ database: "crm", question: "count", etag: count.etag }, { ...top, etag: current.etag }], wait: 3 }, ENV_E);
		assert.equal(await until(listening, 1), 1);
		await inE("insert into crm.people (name) values ('New')");
		const answer = await waiting;
		assert.deepEqual(answer.value.changed?.map((one) => one.index), [0, 1], JSON.stringify(answer.value));
		assert.equal(answer.value.changed[1].answer.rows[0].values[1], "New");
		assert.equal(answer.value.changed[1].answer.rows.length, 5);
		const both = await ask(viewer, "watch", { watches: [{ database: "crm", table: "people", question: "count", etag: "x" }] }, ENV_E);
		assert.deepEqual([both.status, both.value.error], [400, "A watch names a question or a table"]);
		const later = await ask(viewer, "watch", { watches: [{ ...top, after: ["9"], etag: "x" }] }, ENV_E);
		assert.deepEqual([later.status, later.value.error], [400, "A watched table is its first page"]);
	});

	it("records what each statement added, changed and removed, a line a row", async () => {
		const since = Number((await inE("select coalesce(max(seq), 0) as n from qorpera_data.row_changes"))[0].n);
		const lines = async () =>
			(await inE("select schema || '.' || relation as at, op, key, before, after, rows::int, bytes::int from qorpera_data.row_changes where seq > $1 order by seq", [since])).map(
				({ bytes, ...line }) => {
					assert.ok(bytes > 0);
					return line;
				},
			);
		assert.ok(Number((await inE("select count(*) as n from qorpera_data.row_changes where schema = 'crm' and relation = 'people' and op = 'add'"))[0].n) >= 250, "the step's seed rows");
		await inE("update crm.people set note = 'noted' where id = 3");
		await inE("update crm.people set score = 16 where id = 3");
		await inE("update crm.people set note = note where id = 3");
		await inE("delete from crm.people where id = 4");
		await inE("update crm.loose set y = 'changed' where x = 1");
		await inE("insert into crm.pairs select 100 + n, 'bulk', 'v' from generate_series(1, 1001) n");
		await inE("delete from crm.pairs where a >= 100");
		assert.deepEqual(await lines(), [
			{ at: "crm.people", op: "change", key: { id: 3 }, before: { note: null }, after: { note: "noted" }, rows: 1 },
			{ at: "crm.people", op: "change", key: { id: 3 }, before: { score: 3, double: 6 }, after: { score: 16, double: 32 }, rows: 1 },
			{ at: "crm.people", op: "remove", key: { id: 4 }, before: { id: 4, name: "Person 148", score: 4, double: 8, note: null }, after: null, rows: 1 },
			{ at: "crm.loose", op: "change", key: null, before: { x: 1, y: "y01" }, after: { x: 1, y: "changed" }, rows: 1 },
			{ at: "crm.pairs", op: "add", key: null, before: null, after: null, rows: 1001 },
			{ at: "crm.pairs", op: "remove", key: null, before: null, after: null, rows: 1001 },
		]);
		const renamed = await ask(contributor, "change", { database: "crm", change: "rename", params: { id: 5, name: "Renamed" } }, ENV_E);
		assert.deepEqual([renamed.status, renamed.value.changed], [200, 1], JSON.stringify(renamed.value));
		assert.deepEqual((await lines()).at(-1), { at: "crm.people", op: "change", key: { id: 5 }, before: { name: "Person 185" }, after: { name: "Renamed" }, rows: 1 });
	});

	it("lets no folder login read or write the record, in its own folder or another's", async () => {
		const peeked = await ask(viewer, "query", { database: "crm", question: "peek-record" }, ENV_E);
		assert.deepEqual([peeked.status, /permission denied/.test(peeked.value.error)], [400, true], JSON.stringify(peeked.value));
		const forged = await ask(contributor, "change", { database: "crm", change: "forge" }, ENV_E);
		assert.deepEqual([forged.status, /permission denied/.test(forged.value.error)], [400, true], JSON.stringify(forged.value));
		const tries = [
			"select count(*) from qorpera_data.row_changes",
			"select count(*) from qorpera_data.change_log",
			"select count(*) from qorpera_data.record_bytes",
			"insert into qorpera_data.change_log (txid, by_kind) values (txid_current(), 'member')",
			"delete from qorpera_data.row_changes",
			"update qorpera_data.record_limit set bytes = 1",
			"select qorpera_data.keep_record(1000000000)",
			"select qorpera_data.give_triggers('qorpera_data.model'::regclass)",
		];
		for (const text of tries) {
			put(ENV_E, { "data/crm/tables/002-try.sql": `${text};\n` });
			const tried = await ask(contributor, "apply", { database: "crm" }, ENV_E);
			assert.equal(states(tried).at(-1), "002-try failed", `${text}: ${JSON.stringify(tried.value)}`);
			assert.match(tried.value.results.at(-1).detail, /permission denied/, text);
		}
		remove(ENV_E, "data/crm/tables/002-try.sql");
		const numbers = Object.fromEntries((await inE("select name, n from qorpera_data.databases")).map((row) => [row.name, row.n]));
		for (const kind of ["w", "r"]) {
			const role = `${E}_${kind}${numbers.mine}`;
			const client = connect(E, role, folderPassword(logins.folderKey, role));
			await client.connect();
			try {
				for (const text of tries) assert.equal(await client.query(text).then(() => "done", (error) => error.code), "42501", `${role}: ${text}`);
			} finally {
				await client.end();
			}
		}
		const kept = await inE(
			"select grantee || ' ' || table_name || ' ' || string_agg(privilege_type, ',' order by privilege_type) as grant from information_schema.role_table_grants where table_schema = 'qorpera_data' and table_name in ('row_changes', 'change_log', 'record_bytes', 'record_limit') and grantee <> 'postgres' group by grantee, table_name order by 1",
		);
		assert.deepEqual(kept.map((row) => row.grant), [
			"qorpera_data_keeper change_log DELETE,INSERT,SELECT",
			"qorpera_data_keeper row_changes SELECT",
			"qorpera_data_recorder record_bytes DELETE,INSERT,SELECT,UPDATE",
			"qorpera_data_recorder record_limit SELECT",
			"qorpera_data_recorder row_changes DELETE,INSERT,SELECT,UPDATE",
		]);
		const [recorder] = await inE(`select r.rolsuper, r.rolcanlogin, (select count(*)::int from pg_proc p where p.proowner = r.oid) as functions,
			(select string_agg(p.proname, ',' order by p.proname) from pg_proc p where p.proowner = r.oid) as names,
			has_table_privilege(r.oid, 'qorpera_data.texts', 'select') as texts, has_table_privilege(r.oid, 'crm.people', 'select') as rows
			from pg_roles r where r.rolname = 'qorpera_data_recorder'`);
		assert.deepEqual(recorder, { rolsuper: false, rolcanlogin: false, functions: 2, names: "keep_record,recorded", texts: false, rows: false }, "the record's functions run with the record's rights alone");
		put(ENV_E, {
			"data/crm/tables/002-try.sql":
				"create type mood as enum ('ok');\ncreate function leak(mood) returns json language sql as $f$ select json_build_object('user', current_user) $f$;\ncreate cast (mood as json) with function leak(mood);\n",
		});
		const cast = await ask(contributor, "apply", { database: "crm" }, ENV_E);
		assert.equal(states(cast).at(-1), "002-try failed", JSON.stringify(cast.value));
		assert.match(cast.value.results.at(-1).detail, /Qorpera refuses a cast to json or jsonb/);
		remove(ENV_E, "data/crm/tables/002-try.sql");
		assert.deepEqual(await inE("select count(*)::int as n from pg_cast where casttarget in ('json'::regtype, 'jsonb'::regtype) and oid >= 16384"), [{ n: 0 }]);
	});

	it("keeps the record within its cap by the bytes of its lines, oldest first, and keeps the newest", async () => {
		await inE("update qorpera_data.record_limit set bytes = 20000");
		try {
			const [{ before }] = await inE("select max(seq)::int as before from qorpera_data.row_changes");
			for (const mark of ["1", "2", "3", "4", "5"]) await inE(`update crm.wide set text = repeat('${mark}', 300) where id <= 20`);
			const [state] = await inE(`select sum(bytes)::int as total, min(seq)::int as oldest,
				(select count(*)::int from qorpera_data.row_changes where after ->> 'text' = repeat('5', 300)) as newest,
				(select sum(bytes)::int from qorpera_data.record_bytes) as counted from qorpera_data.row_changes`);
			assert.ok(state.total <= 20000 && state.total > 10000, JSON.stringify(state));
			assert.ok(state.oldest > before, "every line from before is gone");
			assert.equal(state.newest, 20, "the last statement's lines are all kept");
			assert.equal(state.counted, state.total, "what the record counts is what its lines hold");
			await inE("update crm.wide set text = repeat('6', 30000) where id = 1");
			const [big] = await inE("select count(*)::int as lines, max(bytes)::int as bytes from qorpera_data.row_changes");
			assert.deepEqual(big.lines, 1, "a line past the cap alone is kept: the record never empties itself");
			assert.ok(big.bytes > 20000);
		} finally {
			await inE("update qorpera_data.record_limit set bytes = 104857600");
		}
	});

	it("counts a company's size without its record: a record past its free room closes nothing, and agents are told at 80 % of the company's own data", async () => {
		await inE("update qorpera_data.record_limit set bytes = 65536");
		try {
			const own = (await ask(owner, "describe", {}, ENV_E)).value.companyBytes;
			const whole = async () => Number((await inE("select pg_database_size(current_database()) as n"))[0].n);
			assert.ok((await whole()) - own < 1024 ** 2, `${(await whole()) - own}`);
			await inE(`insert into qorpera_data.row_changes (schema, relation, op, after, rows, bytes)
				select 'filler', 'filler', 'add', jsonb_build_object('x', (select string_agg(md5(n::text || '.' || i), '') from generate_series(1, 40) i)), 1, 0
				from generate_series(1, 6000) n`);
			const [record] = await inE("select pg_total_relation_size('qorpera_data.row_changes') as n, (select bytes from qorpera_data.record_limit) as cap");
			assert.ok(Number(record.n) > 6 * 1024 ** 2 && Number(record.n) > Number(record.cap), `the record's tables hold ${record.n} bytes`);
			await writersOfEGone();
			const roomy = Math.round(own / 0.7);
			assert.ok((await whole()) > roomy, "the whole database is past the limit");
			await withGateway({ limits: { ...LIMITS_HERE, companyBytes: roomy } }, async (other) => {
				const looked = await other.watchOnce();
				assert.deepEqual([looked.full.includes(E), looked.near.includes(E)], [false, false], JSON.stringify(looked));
				const added = await ask(owner, "change", { database: "crm", change: "add-person", params: { name: "Room" } }, ENV_E);
				assert.equal(added.status, 200, JSON.stringify(added.value));
				const described = await ask(owner, "describe", {}, ENV_E);
				assert.ok(described.value.companyBytes < 0.8 * roomy, `${described.value.companyBytes} of ${roomy}`);
				assert.equal(described.value.limitBytes, roomy);
			});
			await writersOfEGone();
			await withGateway({ limits: { ...LIMITS_HERE, companyBytes: Math.round(own / 0.85) } }, async (other) => {
				const looked = await other.watchOnce();
				assert.deepEqual([looked.full.includes(E), looked.near.includes(E)], [false, true], JSON.stringify(looked));
			});
			await withGateway({ limits: { ...LIMITS_HERE, companyBytes: Math.round(own * 0.9) } }, async (other) => {
				const looked = await other.watchOnce();
				assert.deepEqual([looked.full.includes(E), looked.near.includes(E)], [true, true], JSON.stringify(looked));
				const refused = await ask(owner, "change", { database: "crm", change: "add-person", params: { name: "No room" } }, ENV_E);
				assert.equal(refused.status, 507, JSON.stringify(refused.value));
			});
		} finally {
			await inE("delete from qorpera_data.row_changes where schema = 'filler'");
			await inE("update qorpera_data.record_limit set bytes = 104857600");
		}
	});

	it("brings a store made from the template before the list to today's with store/update.sql: the same objects, and the record works on its old tables", async () => {
		const stores = ["list_old", "list_new"];
		for (const name of stores) await asAdmin("postgres", `create database ${name}`);
		try {
			psql("list_old", "template-before-list.sql", {}, readFileSync(new URL("./template-before-list.sql", import.meta.url)));
			psql("list_new", "template.sql");
			for (const name of stores) await asAdmin(name, "create schema s; create table s.t (id int primary key, v text); create table s.k (v text)");
			assert.equal((await asAdmin("list_old", "select count(*)::int as n from pg_trigger where tgrelid = 's.t'::regclass"))[0].n, 3);
			psql("list_old", "update.sql");
			psql("list_old", "update.sql");
			const objects = async (name) =>
				(
					await asAdmin(
						name,
						`select 'function ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') ' || md5(p.prosrc) || ' ' || p.prosecdef || ' ' ||
							coalesce(array_to_string(p.proconfig, ','), '') || ' ' || coalesce(p.proacl::text, '') as line
						from pg_proc p where p.pronamespace = 'qorpera_data'::regnamespace
						union all select 'relation ' || c.relname || ' ' || c.relkind::text || ' ' || coalesce(c.relacl::text, '') from pg_class c where c.relnamespace = 'qorpera_data'::regnamespace
						union all select 'column ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' ' || a.attnotnull || ' ' || a.attidentity::text || ' ' ||
							coalesce(pg_get_expr(d.adbin, d.adrelid), '')
						from pg_attribute a join pg_class c on c.oid = a.attrelid left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
						where c.relnamespace = 'qorpera_data'::regnamespace and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
						union all select 'constraint ' || conrelid::regclass || ' ' || conname || ' ' || pg_get_constraintdef(oid) from pg_constraint where connamespace = 'qorpera_data'::regnamespace
						union all select 'index ' || pg_get_indexdef(indexrelid) from pg_index where indrelid in (select oid from pg_class where relnamespace = 'qorpera_data'::regnamespace)
						union all select 'trigger ' || pg_get_triggerdef(oid) || ' ' || tgenabled::text from pg_trigger where not tgisinternal
						union all select 'event trigger ' || evtname || ' ' || evtevent || ' ' || evtfoid::regproc || ' ' || coalesce(array_to_string(evttags, ','), '') || ' ' || evtenabled::text from pg_event_trigger
						union all select 'record limit ' || bytes from qorpera_data.record_limit
						order by 1`,
					)
				).map((row) => row.line);
			const made = await objects("list_new");
			assert.ok(made.some((line) => line.startsWith("trigger CREATE TRIGGER qorpera_record_add AFTER INSERT ON s.t ")), made.join("\n"));
			assert.deepEqual(await objects("list_old"), made);
			await asAdmin("list_old", "insert into s.t values (1, 'a'); update s.t set v = 'b'; delete from s.t; insert into s.k values ('k')");
			assert.deepEqual(
				(await asAdmin("list_old", "select relation || ' ' || op || ' ' || coalesce(key::text, '-') as line from qorpera_data.row_changes order by seq")).map((row) => row.line),
				['t add {"id": 1}', 't change {"id": 1}', 't remove {"id": 1}', "k add -"],
			);
		} finally {
			for (const name of stores) await asAdmin("postgres", `drop database if exists ${name}`);
		}
	});

	it("measures what the record's triggers cost a statement", async () => {
		await asAdmin("postgres", "create database cost_probe template qorpera_company_template");
		await asAdmin("cost_probe", `create schema if not exists cost;
			create table if not exists cost.six (id int primary key, v text);
			create table if not exists qorpera_data.cost_none (id int primary key, v text);
			create table if not exists qorpera_data.cost_before (id int primary key, v text);
			create or replace trigger qorpera_changed after insert or update or delete or truncate on qorpera_data.cost_before
				for each statement execute function qorpera_data.changed();
			create or replace trigger qorpera_rows_gone after delete on qorpera_data.cost_before referencing old table as gone
				for each statement execute function qorpera_data.rows_gone();
			create or replace function cost.measure(p_table regclass, p_verb text, p_rows int, p_n int) returns float8 language plpgsql as $f$
			declare began timestamptz; i int;
			begin
				began := clock_timestamp();
				for i in 1..p_n loop
					if p_verb = 'insert' then
						execute format('insert into %s (id, v) select g, ''v'' from generate_series($1, $2) g', p_table) using i * p_rows, i * p_rows + p_rows - 1;
					elsif p_verb = 'update' then
						execute format('update %s set v = v || ''x'' where id between $1 and $2', p_table) using i * p_rows, i * p_rows + p_rows - 1;
					else
						execute format('delete from %s where id between $1 and $2', p_table) using i * p_rows, i * p_rows + p_rows - 1;
					end if;
				end loop;
				return extract(epoch from clock_timestamp() - began) * 1e6 / p_n;
			end $f$;`);
		const client = connect("cost_probe");
		await client.connect();
		const costs = {};
		try {
			const measure = async (table, rows, n) => {
				const each = {};
				await client.query("begin");
				for (const verb of ["insert", "update", "delete"])
					each[verb] = Math.round(Number((await client.query("select cost.measure($1, $2, $3, $4) as us", [table, verb, rows, n])).rows[0].us));
				await client.query("rollback");
				return each;
			};
			for (const [rows, n] of [[1, 2000], [100, 100]]) {
				for (const table of ["qorpera_data.cost_none", "qorpera_data.cost_before", "cost.six"]) {
					await measure(table, rows, Math.ceil(n / 10));
					costs[`${rows} row${rows === 1 ? "" : "s"}, ${table.replace(/^.*\./, "")}`] = await measure(table, rows, n);
				}
			}
		} finally {
			await client.end();
			await asAdmin("postgres", "drop database cost_probe");
		}
		console.log(`the record's trigger cost, microseconds a statement: ${JSON.stringify(costs)}`);
		assert.ok(Object.values(costs).every((each) => Object.values(each).every((us) => Number.isFinite(us) && us > 0)));
	});

	it("takes a company machine's pass at the run door as a run's, with an agent's limits and never a yes", async () => {
		const pass = (options = {}) => passFor(ENV_D, OWNER, "stock", { machine: true, ...options });
		const count = await runSend("query", { database: "stock", question: "count", pass: pass() });
		assert.equal(count.status, 200, JSON.stringify(count.value));
		const items = count.value.rows[0][0];
		const many = await runSend("query", { database: "stock", sql: "select id from items order by id", pass: pass() });
		assert.deepEqual([many.status, many.value.rows.length, many.value.more], [200, LIMITS_HERE.agentRows, true]);
		const described = await runSend("describe", { database: "stock", pass: pass() });
		assert.deepEqual([described.status, described.value.databases?.[0]?.database], [200, "stock"], JSON.stringify(described.value).slice(0, 200));
		const shouted = await runSend("change", { database: "stock", change: "shout", pass: pass() });
		assert.deepEqual(
			[shouted.status, shouted.value.changed, shouted.value.rows?.length, shouted.value.more],
			[200, items, LIMITS_HERE.agentRows, true],
			JSON.stringify(shouted.value).slice(0, 300),
		);
		assert.deepEqual(states(await runSend("apply", { database: "stock", pass: pass() })), ["001-items already", "002-clear already"]);
		const once = pass();
		assert.equal((await runSend("describe", { database: "stock", pass: once })).status, 200);
		assert.deepEqual(await runSend("describe", { database: "stock", pass: once }), { status: 401, value: { error: "Not allowed" } });
		assert.equal((await runSend("query", { database: "yard", sql: "select 1", pass: pass() })).status, 404);
		assert.equal((await runSend("apply", { database: "stock", pass: pass({ allow: `003-x.${"0".repeat(64)}.${"0".repeat(64)}` }) })).status, 503);
		for (const broken of [{ viewId: undefined }, { machineId: "not-a-machine" }, { kind: "desktop" }]) {
			const made = pass();
			Object.assign(PASSES.get(made).kept, broken);
			assert.equal((await runSend("describe", { database: "stock", pass: made })).status, 503, JSON.stringify(broken));
		}
		const asRun = passFor(ENV_D, OWNER, "stock");
		delete PASSES.get(asRun).kept.runId;
		assert.equal((await runSend("describe", { database: "stock", pass: asRun })).status, 503, "a run's pass without its run");
	});

	const LEDGER = {
		"data/ledger/database.toml": 'format = "qorpera.database/v1"\nname = "Ledger"\n',
		"data/ledger/tables/001-items.sql": `create table items (
	id bigint generated by default as identity primary key,
	name text not null check (name <> ''),
	qty int not null default 0,
	price numeric(10,2),
	code varchar(4),
	at timestamptz,
	doc jsonb,
	total numeric generated always as (qty * coalesce(price, 0)) stored
);
insert into items (name, qty, price, at) select 'item ' || n, n, n * 1.5, '2026-11-15 10:00:00+00'::timestamptz + (n || ' minutes')::interval from generate_series(1, 9) n;
create table always (id int generated always as identity primary key, v text);
create table loose (v text);
create view cheap as select id, name from items where price < 5;
create table slowed (id int primary key, v text);
insert into slowed values (1, 'a');
create function nap() returns trigger language plpgsql as $f$ begin perform pg_sleep(1); return new; end $f$;
create trigger nap before update on slowed for each row execute function nap();
`,
		"data/ledger/actions/slow-write.sql": "update items set qty = qty + 1 where id = :id::bigint returning qty, pg_sleep(1.5) is null as napped;\n",
	};
	const edit = (bearer, body) => ask(bearer, "edit", { database: "ledger", table: "items", ...body }, ENV_E);
	const itemAt = async (id, table = "items") => {
		const page = await listed(contributor, { database: "ledger", table, after: [String(id - 1)], limit: 1 });
		assert.equal(page.status, 200, JSON.stringify(page.value));
		assert.equal(page.value.rows[0]?.values[0], id, JSON.stringify(page.value));
		return page.value.rows[0];
	};
	const item = async (id) => (await inE("select id::int, name, qty, price::text, code from ledger.items where id = $1", [id]))[0] ?? null;
	const actorLines = () =>
		inE("select txid::text as txid, by_kind, by_id, via, txid_status(txid) as status from qorpera_data.change_log order by at, txid");
	const oneLine = async (work) => {
		const before = new Set((await actorLines()).map((line) => line.txid));
		const answer = await work();
		const added = (await actorLines()).filter((line) => !before.has(line.txid) && line.status === "committed");
		assert.equal(added.length, 1, `${JSON.stringify(added)} ${JSON.stringify(answer?.value ?? answer).slice(0, 300)}`);
		const { txid, status, ...line } = added[0];
		const rows = (await inE("select schema || '.' || relation || ' ' || op as line from qorpera_data.row_changes where txid = $1::bigint order by seq", [txid])).map(
			(row) => row.line,
		);
		return { answer, line, rows };
	};
	const runAs = async (verb, body, options = {}) => {
		let pass = passFor(ENV_E, OWNER, body.database, options);
		let answer = await runSend(verb, { ...body, pass });
		for (let round = 0; round < 3 && answer.status === 200 && answer.value.need; round++) {
			const texts = Object.fromEntries(answer.value.need.map((wanted) => [wanted.sha256, TEXTS.get(wanted.sha256)]));
			pass = passFor(ENV_E, OWNER, body.database, options);
			answer = await runSend(verb, { ...body, texts, pass });
		}
		return { ...answer, kept: PASSES.get(pass).kept };
	};

	it("refuses an edit to a member who may read a database but not write it, and to a reader of a database whose list is its writers'", async () => {
		put(ENV_E, LEDGER);
		assert.equal((await ask(contributor, "apply", { database: "ledger" }, ENV_E)).value.applied, true);
		const refused = await edit(viewer, { op: "add", values: { name: "Viewer's" } });
		assert.deepEqual([refused.status, refused.value.error], [403, "The rows of ledger are changed by those who may change its folder"]);
		assert.equal((await listed(viewer, { database: "ledger", table: "items" })).status, 200, "the viewer gets the list");
		const own = await ask(viewer, "edit", { database: "mine", table: "notes", op: "add", values: { id: 70, text: "mine" } }, ENV_E);
		assert.equal(own.status, 403, JSON.stringify(own.value));
		assert.equal((await edit(stranger, { op: "add", values: { name: "Stranger's" } })).status, 404);
		writeCheckMissing = true;
		try {
			assert.equal((await edit(contributor, { op: "add", values: { name: "Unproven" } })).status, 403);
		} finally {
			writeCheckMissing = false;
		}
		assert.deepEqual(await inE("select count(*)::int as n from ledger.items where name in ('Viewer''s', 'Stranger''s', 'Unproven')"), [{ n: 0 }]);
		assert.deepEqual(await inE("select count(*)::int as n from mine.notes where id = 70"), [{ n: 0 }]);
		const mine = await ask(contributor, "edit", { database: "mine", table: "notes", op: "add", values: { id: 70, text: "a writer's" } }, ENV_E);
		assert.equal(mine.status, 200, JSON.stringify(mine.value));
	});

	it("adds, changes and removes one row, and answers the row as written with its new seen", async () => {
		const added = await edit(contributor, { op: "add", values: { name: "Lamp", qty: 2, price: "3.25", at: "2026-11-15T12:00:00Z", doc: { a: [1] } } });
		assert.equal(added.status, 200, JSON.stringify(added.value));
		assert.deepEqual([added.value.columns, added.value.key], [["id", "name", "qty", "price", "code", "at", "doc", "total"], ["id"]]);
		const id = added.value.row.values[0];
		assert.deepEqual(added.value.row.values, [id, "Lamp", 2, 3.25, null, "2026-11-15T12:00:00Z", { a: [1] }, 6.5]);
		assert.equal(added.value.row.seen, (await itemAt(id)).seen, "the seen a page gives for the row");
		assert.deepEqual(await item(id), { id, name: "Lamp", qty: 2, price: "3.25", code: null });
		assert.deepEqual(await inE("select count(*)::int as n from ledger.items where name = 'Lamp'"), [{ n: 1 }]);
		const changed = await edit(contributor, { op: "change", key: { id }, seen: added.value.row.seen, values: { qty: 3, code: "AB" } });
		assert.equal(changed.status, 200, JSON.stringify(changed.value));
		assert.deepEqual(changed.value.row.values, [id, "Lamp", 3, 3.25, "AB", "2026-11-15T12:00:00Z", { a: [1] }, 9.75]);
		assert.notEqual(changed.value.row.seen, added.value.row.seen);
		assert.equal(changed.value.row.seen, (await itemAt(id)).seen);
		assert.deepEqual(await inE("select count(*)::int as n from ledger.items where qty = 3 and name = 'Lamp'"), [{ n: 1 }], "one row changed");
		const removed = await edit(contributor, { op: "remove", key: { id: String(id) }, seen: changed.value.row.seen });
		assert.deepEqual([removed.status, removed.value.row, removed.value.key], [200, null, ["id"]], JSON.stringify(removed.value));
		assert.equal(await item(id), null);
		assert.deepEqual(await inE("select count(*)::int as n from ledger.items"), [{ n: 9 }], "the others stay");
		const bare = await edit(contributor, { table: "always", op: "add" });
		assert.deepEqual([bare.status, bare.value.row?.values], [200, [1, null]], JSON.stringify(bare.value));
		const loose = await edit(contributor, { table: "loose", op: "add", values: { v: "free" } });
		assert.deepEqual([loose.status, loose.value.key, loose.value.row?.values], [200, [], ["free"]], JSON.stringify(loose.value));
	});

	it("refuses a change or a removal of a row changed or gone since it was read, with the row as it is now", async () => {
		const first = await itemAt(1);
		await inE("update ledger.items set qty = 100 where id = 1");
		const now = await itemAt(1);
		for (const asked of [
			{ op: "change", key: { id: 1 }, seen: first.seen, values: { qty: 5 } },
			{ op: "remove", key: { id: 1 }, seen: first.seen },
		]) {
			const stale = await edit(contributor, asked);
			assert.deepEqual([stale.status, stale.value.error], [409, "The row was changed since it was read: it is as it is now"], JSON.stringify(stale.value));
			assert.deepEqual(stale.value.row, now);
		}
		assert.deepEqual(await item(1), { id: 1, name: "item 1", qty: 100, price: "1.50", code: null });
		const second = await itemAt(2);
		await inE("delete from ledger.items where id = 2");
		for (const asked of [
			{ op: "change", key: { id: 2 }, seen: second.seen, values: { qty: 5 } },
			{ op: "remove", key: { id: 2 }, seen: second.seen },
		]) {
			const gone = await edit(contributor, asked);
			assert.deepEqual([gone.status, gone.value], [409, { error: "The row is gone: it was removed since it was read", row: null }]);
		}
		assert.equal(await item(2), null);
		const third = await itemAt(3);
		const both = await Promise.all(
			[7, 8].map((qty) => edit(contributor, { op: "change", key: { id: 3 }, seen: third.seen, values: { qty } })),
		);
		assert.deepEqual(both.map((one) => one.status).sort(), [200, 409], JSON.stringify(both.map((one) => one.value)));
		const won = both.find((one) => one.status === 200).value.row;
		assert.deepEqual(both.find((one) => one.status === 409).value.row, won);
		assert.equal((await item(3)).qty, won.values[2]);
	});

	it("sets only the columns an edit may set, of a table with a key in the folder's own schema", async () => {
		const row = await itemAt(4);
		const at = { op: "change", key: { id: 4 }, seen: row.seen };
		for (const [body, status, error] of [
			[{ ...at, values: { total: 1 } }, 400, "total is kept by the store: an edit does not set it"],
			[{ table: "always", op: "add", values: { id: 5 } }, 400, "id is kept by the store: an edit does not set it"],
			[{ ...at, values: { nope: 1 } }, 400, "No column nope in items"],
			[{ ...at, values: { "qorpera_data.change_log": 1 } }, 400, "No column qorpera_data.change_log in items"],
			[{ ...at, values: JSON.parse('{"__proto__": 1, "qty": 1}') }, 400, "No column __proto__ in items"],
			[{ table: "notes", op: "add", values: { id: 71 } }, 404, "No table notes in ledger"],
			[{ table: "mine.notes", op: "add", values: { id: 71 } }, 404, "No table mine.notes in ledger"],
			[{ table: "people", op: "add", values: { name: "x" } }, 404, "No table people in ledger"],
			[{ table: "pg_class", op: "add", values: {} }, 404, "No table pg_class in ledger"],
			[{ table: "row_changes", op: "add", values: {} }, 404, "No table row_changes in ledger"],
			[{ table: "cheap", op: "add", values: { name: "x" } }, 400, "cheap is a view: the list changes no rows of it"],
			[{ table: "cheap", ...at, values: { name: "x" } }, 400, "cheap is a view: the list changes no rows of it"],
			[{ table: "loose", op: "remove", key: { v: "free" }, seen: row.seen }, 400, "loose has no key: its rows are added here, never changed or removed"],
			[{ ...at, key: {}, values: { qty: 1 } }, 400, "A change names the whole key of items: id"],
			[{ ...at, key: { id: 4, name: "x" }, values: { qty: 1 } }, 400, "A change names the whole key of items: id"],
			[{ ...at, key: { id: null }, values: { qty: 1 } }, 400, "A change names the whole key of items: id"],
			[{ ...at, key: { name: "item 4" }, values: { qty: 1 } }, 400, "A change names the whole key of items: id"],
			[{ ...at, values: {} }, 400, "A change sets at least one column"],
			[{ op: "remove", key: { id: 4 }, seen: row.seen, values: { qty: 1 } }, 400, "A remove sets no values"],
			[{ op: "add", key: { id: 4 }, values: { name: "x" } }, 400, "An add names no key and no seen"],
			[{ op: "drop", key: { id: 4 }, seen: row.seen }, 400, "op is add, change or remove"],
			[{ ...at, seen: "old", values: { qty: 1 } }, 400, "A change names the row's whole key and the seen it was read with"],
			[{ ...at, key: [4], values: { qty: 1 } }, 400, "A change names the row's whole key and the seen it was read with"],
			[{ ...at, values: [1] }, 400, "values are the columns to set, by name"],
			[{ table: "x".repeat(64), op: "add" }, 400, "Name a table"],
			[{ database: "nope", op: "add" }, 404, "No database nope that you may read"],
		]) {
			const refused = await edit(contributor, body);
			assert.deepEqual([refused.status, refused.value.error], [status, error], JSON.stringify(body));
		}
		assert.deepEqual(await itemAt(4), row, "nothing was changed");
		assert.deepEqual(await inE("select count(*)::int as n from ledger.always"), [{ n: 1 }]);
		assert.deepEqual(await inE("select count(*)::int as n from mine.notes where id = 71"), [{ n: 0 }]);
	});

	it("keeps SQL through a table, a column, a key or a value harmless", async () => {
		const row = await itemAt(5);
		const at = { op: "change", key: { id: 5 }, seen: row.seen };
		for (const table of ['items" where false; --', "items; drop table ledger.items", "ledger.items", 'items" as r set name = \'x\' --'])
			assert.equal((await edit(contributor, { table, op: "add", values: { name: "x" } })).status, 404, table);
		for (const column of ['name" = \'x\', "qty', "qty = 0 --", 'name"'])
			assert.equal((await edit(contributor, { ...at, values: { [column]: "x" } })).status, 400, column);
		for (const key of ["5 or true", "5); delete from ledger.items; --"]) {
			const tried = await edit(contributor, { ...at, key: { id: key }, values: { qty: 1 } });
			assert.deepEqual([tried.status, /invalid input syntax for type bigint/.test(tried.value.error)], [400, true], JSON.stringify(tried.value));
		}
		const tried = await edit(contributor, { ...at, values: { qty: "1); delete from ledger.items; --" } });
		assert.deepEqual([tried.status, /invalid input syntax for type integer/.test(tried.value.error)], [400, true], JSON.stringify(tried.value));
		const long = await edit(contributor, { ...at, values: { code: "toolong" } });
		assert.deepEqual([long.status, /value too long for type character varying\(4\)/.test(long.value.error)], [400, true], JSON.stringify(long.value));
		assert.deepEqual(await itemAt(5), row, "nothing was changed");
		const words = "x'); drop table ledger.items; --";
		const stored = await edit(contributor, { ...at, values: { name: words, doc: { "'": "\"; drop" } } });
		assert.equal(stored.status, 200, JSON.stringify(stored.value));
		assert.deepEqual((await item(5)).name, words);
		assert.deepEqual(await inE("select count(*)::int as n from ledger.items"), [{ n: 8 }]);
	});

	it("writes one actor's line for every write road, its row lines share its txid, and no statement writes or forges its own", async () => {
		const byEdit = await oneLine(() => edit(contributor, { op: "add", values: { name: "Edited" } }));
		assert.deepEqual(byEdit.line, { by_kind: "member", by_id: CONTRIBUTOR, via: "list" });
		assert.deepEqual(byEdit.rows, ["ledger.items add"]);
		const byMember = await oneLine(() => ask(contributor, "change", { database: "crm", change: "rename", params: { id: 6, name: "By a member" } }, ENV_E));
		assert.deepEqual(byMember.line, { by_kind: "member", by_id: CONTRIBUTOR, via: "rename" });
		assert.deepEqual(byMember.rows, ["crm.people change"]);
		const byAgent = await oneLine(() => runAs("change", { database: "crm", change: "rename", params: { id: 7, name: "By an agent" } }));
		assert.equal(byAgent.answer.status, 200, JSON.stringify(byAgent.answer.value));
		assert.deepEqual(byAgent.line, { by_kind: "agent", by_id: byAgent.answer.kept.runId, via: "rename" });
		assert.deepEqual(byAgent.rows, ["crm.people change"]);
		const byMachine = await oneLine(() => runAs("change", { database: "crm", change: "rename", params: { id: 8, name: "By a machine" } }, { machine: true }));
		assert.equal(byMachine.answer.status, 200, JSON.stringify(byMachine.answer.value));
		assert.deepEqual(byMachine.line, { by_kind: "machine", by_id: byMachine.answer.kept.machineId, via: "rename" });
		assert.deepEqual(byMachine.rows, ["crm.people change"]);
		put(ENV_E, { "data/ledger/tables/002-more.sql": "insert into items (name) values ('from a step');\nupdate items set qty = qty + 1 where name = 'from a step';\n" });
		const byStep = await oneLine(() => ask(contributor, "apply", { database: "ledger" }, ENV_E));
		assert.deepEqual(states(byStep.answer), ["001-items already", "002-more applied"]);
		assert.deepEqual(byStep.line, { by_kind: "step", by_id: CONTRIBUTOR, via: "002-more" });
		assert.deepEqual(byStep.rows, ["ledger.items add", "ledger.items change"]);
		put(ENV_E, { "data/ledger/tables/003-again.sql": "insert into items (name) values ('from a run''s step');\n" });
		const byRunStep = await oneLine(() => runAs("apply", { database: "ledger" }));
		assert.deepEqual(byRunStep.line, { by_kind: "step", by_id: byRunStep.answer.kept.runId, via: "003-again" });
		const before = await actorLines();
		const forged = await ask(contributor, "change", { database: "crm", change: "forge" }, ENV_E);
		assert.deepEqual([forged.status, /permission denied/.test(forged.value.error)], [400, true], JSON.stringify(forged.value));
		const after = await actorLines();
		const added = after.filter((line) => !before.some((old) => old.txid === line.txid));
		assert.deepEqual(
			added.map(({ txid, ...line }) => line),
			[{ by_kind: "member", by_id: CONTRIBUTOR, via: "forge", status: "aborted" }],
			"the gateway's own line, for a write that rolled back",
		);
		assert.ok(!after.some((line) => line.by_id === "someone else"));
	});

	it("removes a rolled-back write's line at the watcher's next look, and keeps a running write's", async () => {
		const running = ask(contributor, "change", { database: "ledger", change: "slow-write", params: { id: 6 } }, ENV_E);
		const inProgress = async () => (await actorLines()).filter((line) => line.via === "slow-write" && line.status === "in progress").length;
		assert.equal(await until(inProgress, 1, 5_000), 1);
		await gateway.watchOnce();
		assert.equal(await inProgress(), 1, "a running write keeps its actor");
		assert.equal((await running).status, 200);
		await gateway.watchOnce();
		assert.deepEqual(
			(await actorLines()).filter((line) => line.via === "slow-write").map((line) => line.status),
			["committed"],
		);
		const before = new Set((await actorLines()).map((line) => line.txid));
		const failed = await edit(contributor, { op: "add", values: { name: "" } });
		assert.deepEqual([failed.status, /violates check constraint/.test(failed.value.error)], [400, true], JSON.stringify(failed.value));
		const [rolledBack, ...others] = (await actorLines()).filter((line) => !before.has(line.txid));
		assert.deepEqual([rolledBack?.via, rolledBack?.status, others], ["list", "aborted", []]);
		const committed = (await actorLines()).filter((line) => line.status === "committed").map((line) => line.txid);
		await gateway.watchOnce();
		assert.ok(!(await actorLines()).some((line) => line.txid === rolledBack.txid), "the rolled-back write's line is gone");
		assert.deepEqual(
			(await actorLines()).filter((line) => line.status === "committed").map((line) => line.txid),
			committed,
			"no other line goes",
		);
		const open = connect(E);
		const closed = connect(E);
		await open.connect();
		await closed.connect();
		try {
			const line = async (client, via) => {
				const { txid } = (await client.query("select txid_current()::text as txid")).rows[0];
				await inE("insert into qorpera_data.change_log (txid, by_kind, via) values ($1::bigint, 'member', $2)", [txid, via]);
				return txid;
			};
			await open.query("begin");
			await line(open, "still running");
			await closed.query("begin");
			await line(closed, "rolled back");
			await closed.query("rollback");
			await line(closed, "committed");
			const vias = async () => (await inE("select via from qorpera_data.change_log where via in ('still running', 'rolled back', 'committed') order by via")).map((one) => one.via);
			assert.deepEqual(await vias(), ["committed", "rolled back", "still running"]);
			await gateway.watchOnce();
			assert.deepEqual(await vias(), ["committed", "rolled back", "still running"], "a gateway looks only at its own writes between its sweeps");
			await withGateway({}, async (other) => {
				await other.watchOnce();
				assert.deepEqual(await vias(), ["committed", "still running"], "its first look sweeps every line");
				await open.query("rollback");
				await other.watchOnce();
				assert.deepEqual(await vias(), ["committed"], "a line it found running is looked at again");
			});
		} finally {
			await open.end().catch(() => undefined);
			await closed.end().catch(() => undefined);
			await inE("delete from qorpera_data.change_log where via in ('still running', 'rolled back', 'committed')");
		}
	});

	it("keeps an edit to a change's limits: the company's size and a change's time", async () => {
		const row = await itemAt(9);
		await writersOfEGone();
		await withGateway({ limits: { ...LIMITS_HERE, companyBytes: 1024 ** 2 } }, async (other) => {
			assert.ok((await other.watchOnce()).full.includes(E));
			const full = "This company's database is at its size limit of 1 MiB: only removing a row runs until there is room";
			const added = await edit(contributor, { op: "add", values: { name: "No room" } });
			assert.deepEqual([added.status, added.value.error], [507, full]);
			const changed = await edit(contributor, { op: "change", key: { id: 9 }, seen: row.seen, values: { qty: 0 } });
			assert.deepEqual([changed.status, changed.value.error], [507, full]);
			assert.deepEqual(await itemAt(9), row);
			const removed = await edit(contributor, { op: "remove", key: { id: 9 }, seen: row.seen });
			assert.equal(removed.status, 200, JSON.stringify(removed.value));
		});
		assert.equal(await item(9), null);
		const slowed = await itemAt(1, "slowed");
		await writersOfEGone();
		await withGateway({ limits: { ...LIMITS_HERE, changeMs: 300 } }, async () => {
			const slow = await edit(contributor, { table: "slowed", op: "change", key: { id: 1 }, seen: slowed.seen, values: { v: "b" } });
			assert.deepEqual([slow.status, slow.value.error], [408, "The statement ran past its time limit"]);
		});
		assert.deepEqual(await inE("select v from ledger.slowed"), [{ v: "a" }]);
		const done = await edit(contributor, { table: "slowed", op: "change", key: { id: 1 }, seen: slowed.seen, values: { v: "b" } });
		assert.equal(done.status, 200, "a change's own 5 s holds the trigger's second");
	});

	it("writes a char, a bit and a JSON value as the column holds it, and finds a row by a char key", async () => {
		put(ENV_E, {
			"data/ledger/tables/004-codes.sql":
				"create table codes (code char(3) primary key, flags bit(4), label char(5));\ninsert into codes values ('abc', B'1010', 'x');\n",
		});
		assert.equal((await ask(contributor, "apply", { database: "ledger" }, ENV_E)).value.applied, true);
		const added = await edit(contributor, { table: "codes", op: "add", values: { code: "xyz", flags: "0110", label: "hi" } });
		assert.equal(added.status, 200, JSON.stringify(added.value));
		assert.deepEqual(added.value.row.values, ["xyz", "0110", "hi   "]);
		const long = await edit(contributor, { table: "codes", op: "add", values: { code: "abcd" } });
		assert.deepEqual([long.status, /value too long for type character\(3\)/.test(long.value.error)], [400, true], JSON.stringify(long.value));
		const short = await edit(contributor, { table: "codes", op: "add", values: { code: "def", flags: "01" } });
		assert.deepEqual([short.status, /bit string length 2 does not match type bit\(4\)/.test(short.value.error)], [400, true], JSON.stringify(short.value));
		const abc = (await listed(contributor, { database: "ledger", table: "codes" })).value.rows.find((one) => one.values[0] === "abc");
		const changed = await edit(contributor, { table: "codes", op: "change", key: { code: "abc" }, seen: abc.seen, values: { label: "new" } });
		assert.deepEqual([changed.status, changed.value.row?.values], [200, ["abc", "1010", "new  "]], JSON.stringify(changed.value));
		const removed = await edit(contributor, { table: "codes", op: "remove", key: { code: "xyz" }, seen: added.value.row.seen });
		assert.equal(removed.status, 200, JSON.stringify(removed.value));
		assert.deepEqual(await inE("select code, flags::text, label from ledger.codes order by code"), [{ code: "abc", flags: "1010", label: "new  " }]);
		const json = await edit(contributor, { op: "add", values: { name: "Json", doc: "hi" } });
		assert.equal(json.status, 200, JSON.stringify(json.value));
		const id = json.value.row.values[0];
		assert.equal(json.value.row.values[6], "hi");
		assert.deepEqual(await inE("select jsonb_typeof(doc) as kind from ledger.items where id = $1", [id]), [{ kind: "string" }]);
		const read = await itemAt(id);
		assert.equal(read.seen, json.value.row.seen);
		const same = await edit(contributor, { op: "change", key: { id }, seen: read.seen, values: { doc: read.values[6] } });
		assert.deepEqual([same.status, same.value.row?.seen], [200, read.seen], "a value written back as a page gave it leaves the row as it was");
		for (const [doc, kind] of [[5, "number"], [{ a: "b" }, "object"], ["{\"a\": 1}", "string"]]) {
			const now = await itemAt(id);
			assert.equal((await edit(contributor, { op: "change", key: { id }, seen: now.seen, values: { doc } })).status, 200);
			assert.deepEqual(await inE("select jsonb_typeof(doc) as kind from ledger.items where id = $1", [id]), [{ kind }], JSON.stringify(doc));
		}
		const now = await itemAt(id);
		assert.equal((await edit(contributor, { op: "change", key: { id }, seen: now.seen, values: { doc: null } })).status, 200);
		assert.deepEqual(await inE("select doc is null as empty from ledger.items where id = $1", [id]), [{ empty: true }]);
	});

	it("lets an actor's line go with its rows' lines at the watcher's sweep, and keeps a running write's", async () => {
		const scratch = companyDatabase("64000000-0000-4000-8000-0000000000f0");
		await asAdmin("postgres", `create database ${scratch} template qorpera_company_template`);
		const running = connect(scratch);
		try {
			await asAdmin("postgres", `grant connect on database ${scratch} to qorpera_data_keeper, qorpera_data_watch`);
			await asAdmin(scratch, "create schema s; create table s.t (id int primary key)");
			const line = (txid, via) => asAdmin(scratch, "insert into qorpera_data.change_log (txid, by_kind, via) values ($1::bigint, 'member', $2)", [txid, via]);
			await running.connect();
			await running.query("begin");
			await line((await running.query("select txid_current()::text as txid")).rows[0].txid, "running");
			const write = async (id) => {
				const client = connect(scratch);
				await client.connect();
				try {
					await client.query("begin");
					const { txid } = (await client.query("select txid_current()::text as txid")).rows[0];
					await client.query("insert into s.t values ($1)", [id]);
					await client.query("commit");
					await line(txid, `write ${id}`);
					return txid;
				} finally {
					await client.end();
				}
			};
			const first = await write(1);
			await write(2);
			await line((await asAdmin(scratch, "select txid_current()::text as txid"))[0].txid, "quiet");
			await asAdmin(scratch, "delete from qorpera_data.row_changes where txid = $1::bigint", [first]);
			const vias = async () => (await asAdmin(scratch, "select via from qorpera_data.change_log order by via")).map((one) => one.via);
			assert.deepEqual(await vias(), ["quiet", "running", "write 1", "write 2"]);
			await withGateway({}, async (other) => {
				await other.watchOnce();
				assert.deepEqual(await vias(), ["quiet", "running", "write 2"], "a line whose rows' lines are gone goes with them, a running write's stays");
				await running.query("rollback");
				await other.watchOnce();
				assert.deepEqual(await vias(), ["quiet", "write 2"]);
			});
		} finally {
			await running.end().catch(() => undefined);
			await asAdmin("postgres", `drop database ${scratch} with (force)`);
		}
	});
});
