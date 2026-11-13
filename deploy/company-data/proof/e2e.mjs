// The first live path, end to end, on a test machine (deploy/first-node/RUNTIME-COMPANY-DATABASES.md §12):
//   - the platform's database as the migrations build it, with a test company's folder (the SQL tests' own fixture),
//     and a real PostgREST in front of it, so a member's token is checked and their folder read runs as `authenticated`;
//   - the company data store (a throwaway PostgreSQL) with the template and the gateway's logins;
//   - the gateway, answering members over HTTP.
// Database folders are written into the company folder through the folder's own commit. Their steps are applied, a
// member asks named questions with their own rights, and a held watch call answers when a row changes.
import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostedDatabase } from "../../../scripts/test-hosted-db-cluster.mjs";
import { expandTestFixture } from "../../../scripts/test-hosted-db.mjs";
import { companyDatabase, Gateway, Platform, serve } from "../gateway/gateway.mjs";
import { readStatement } from "../gateway/sql-text.mjs";
import { admin, check, finish, note, now, percentiles, sleep, withAdmin } from "./lib.mjs";

const ENV = "63000000-0000-4000-8000-000000000020";
const member = (n) => `63000000-0000-4000-8000-00000000000${n}`;
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const here = new URL(".", import.meta.url).pathname;

// ---- the files of the test company's databases, as they are written into its folder
const FILES = {
	"data/shop/database.toml": 'format = "qorpera.database/v1"\nname = "Shop"\nabout = "Orders of the web shop"\n',
	"data/shop/tables/001-orders.sql": `create table orders (
	id bigint generated always as identity primary key,
	customer text not null,
	amount numeric(12,2) not null check (amount >= 0),
	status text not null default 'paid' check (status in ('paid', 'shipped', 'refunded')),
	placed_by uuid,
	placed_at timestamptz not null default now()
);
create index on orders (placed_at);
insert into orders (customer, amount, status, placed_at)
select 'Customer ' || n, 100 + (n % 7) * 25, case when n % 5 = 0 then 'shipped' else 'paid' end, now() - (n || ' hours')::interval
from generate_series(1, 240) n;
`,
	"data/shop/tables/002-order-notes.sql": `alter table orders add column note text;
create view order_totals as select status, count(*) as orders, sum(amount) as total from orders group by status;
`,
	"data/shop/queries/sales-since.sql": `-- What the shop sold since a day.
select count(*) as orders, coalesce(sum(amount), 0) as total, round(coalesce(avg(amount), 0), 2) as average
from orders
where placed_at >= :since::timestamptz;
`,
	"data/shop/queries/by-status.sql": "-- Orders and money by status.\nselect status, orders, total from order_totals order by status;\n",
	"data/shop/queries/mine.sql": "-- The orders the member looking placed.\nselect count(*) as orders from orders where placed_by = :viewer::uuid;\n",
	"data/shop/queries/slow.sql": "select pg_sleep(5) as waited;\n",
	"data/shop/queries/writes.sql": "insert into orders (customer, amount) values ('x', 1) returning id;\n",
	"data/shop/queries/two.sql": "select 1 as one; select 2 as two;\n",
	"data/shop/queries/escape.sql": "select set_config('role', 'none', true) as role, (select count(*) from qorpera_data.steps) as steps;\n",
	// A database only member 2 may read: its folder is private to them.
	"data/hr/database.toml": 'format = "qorpera.database/v1"\nname = "People"\nabout = "Salaries"\n',
	"data/hr/tables/001-salaries.sql": "create table salaries (name text primary key, monthly numeric(12,2) not null);\ninsert into salaries values ('Ada', 52000), ('Bo', 47000);\n",
	"data/hr/queries/total.sql": "select sum(monthly) as monthly from salaries;\n",
	// Steps that must not land.
	"data/risky/database.toml": 'format = "qorpera.database/v1"\nname = "Risky"\nabout = "A step that destroys"\n',
	"data/risky/tables/001-things.sql": "create table things (id int primary key, name text, weight int);\ninsert into things select n, 'thing ' || n, n from generate_series(1, 50) n;\n",
	"data/risky/tables/002-drop-weight.sql": "alter table things drop column weight;\ndelete from things where id <= 10;\n",
	"data/risky/queries/count.sql": "select count(*) as things, count(weight) as weights from things;\n",
	"data/broken/database.toml": 'format = "qorpera.database/v1"\nname = "Broken"\nabout = "A step with a mistake"\n',
	"data/broken/tables/001-typo.sql": "create table a (id int primary key);\ncreate tabel b (id int);\n",
	"data/sneaky/database.toml": 'format = "qorpera.database/v1"\nname = "Sneaky"\nabout = "Steps that try to slip past"\n',
	"data/sneaky/tables/001-base.sql": "create table ledger (id int primary key, amount int);\ninsert into ledger select n, n from generate_series(1, 20) n;\n",
	"data/sneaky/tables/002-commit.sql": "commit;\ndrop table ledger;\n",
};
const TEXT_BY_HASH = new Map(Object.values(FILES).map((text) => [sha256(text), text]));

// ---- the platform's database, with the folder fixture, and one psql session kept open for later folder commits
const platform = await hostedDatabase("company_data_e2e");
let rest = null;
let gateway = null;
let server = null;
let session = null;
try {
	const read = (name) => (name === "e2e.test.sql" ? '-- @fixture 636_folder_core_feed.test.sql until "-- A member sees only what it may read."\n' : readFileSync(join(here, "../../../supabase/tests", name), "utf8"));
	const fixture = expandTestFixture("e2e.test.sql", read);
	session = spawn("docker", platform.cluster.psqlArgs(platform.database, ["-qAt"]), { stdio: ["pipe", "pipe", "pipe"] });
	let out = "";
	let err = "";
	let ended = false;
	session.stdout.on("data", (chunk) => {
		out += chunk;
	});
	session.stderr.on("data", (chunk) => {
		err += chunk;
	});
	session.on("close", () => {
		ended = true;
	});
	let marks = 0;
	const sql = async (text) => {
		const mark = `--e2e-mark-${++marks}--`;
		const from = out.length;
		session.stdin.write(`${text}\n\\echo ${mark}\n`);
		while (!out.slice(from).includes(mark)) {
			if (ended) throw new Error(`The platform session ended:\n${err.slice(-3000)}`);
			await sleep(20);
		}
		return out.slice(from, out.indexOf(mark, from)).trim();
	};
	const put = (actor, key, files) =>
		sql(`select pg_temp.put(${actor}, 'company-data-${key}', '${JSON.stringify(files).replace(/'/g, "''")}'::jsonb) \\g /dev/null`);
	await sql(`${fixture}
create function pg_temp.put(p_actor jsonb, p_key text, p_files jsonb) returns jsonb language plpgsql as $f$
declare v_units jsonb := '[]'; v_path text; v_text text; v_dir text; v_parts text[]; v_seen text[] := '{}'; v_read jsonb; v_unit jsonb; v_result jsonb;
begin
	for v_path, v_text in select key, value from jsonb_each_text(p_files) order by key loop
		v_parts := string_to_array(v_path, '/');
		for v_i in 1 .. array_length(v_parts, 1) - 1 loop
			v_dir := array_to_string(v_parts[1:v_i], '/');
			if not v_dir = any(v_seen) then
				v_seen := v_seen || v_dir;
				if (pg_temp.read(v_dir) ->> 'found')::boolean is not true then
					v_units := v_units || jsonb_build_object('op', 'mkdir', 'path', v_dir);
				end if;
			end if;
		end loop;
		v_read := pg_temp.read(v_path);
		v_unit := jsonb_build_object('op', 'write', 'path', v_path, 'file', pg_temp.stage(v_text));
		if (v_read ->> 'found')::boolean then
			v_unit := v_unit || jsonb_build_object('expectedVersion', v_read -> 'entry' ->> 'version');
		end if;
		v_units := v_units || v_unit;
	end loop;
	v_result := pg_temp.commit(p_actor, p_key, v_units);
	if exists (select 1 from jsonb_array_elements(v_result -> 'units') u where u ->> 'outcome' <> 'saved') then
		raise exception 'put %: %', p_key, v_result;
	end if;
	return v_result;
end $f$;
insert into public.qorpera_company_path_resources(environment_id,path,path_match,scope,owner_user_id,policy,created_by_user_id)
values ('${ENV}','data/hr','subtree','member_private','${member(2)}','normal','${member(1)}');`);
	const group = (prefix) => Object.fromEntries(Object.entries(FILES).filter(([path]) => path.startsWith(prefix)));
	// The shop's files are written by a member (member 2, a contributor); the others by the platform, as the fixture does.
	await put("pg_temp.member(2)", "e2e-shop", group("data/shop/"));
	await put("pg_temp.member(2)", "e2e-hr", group("data/hr/"));
	await put("pg_temp.platform()", "e2e-risky", group("data/risky/"));
	await put("pg_temp.platform()", "e2e-broken", group("data/broken/"));
	await put("pg_temp.platform()", "e2e-sneaky", group("data/sneaky/"));
	const secret = randomBytes(32).toString("hex");
	const restPassword = randomBytes(16).toString("hex");
	await sql(`commit;
select set_config('request.jwt.claims', '{"role":"service_role"}', false) \\g /dev/null
create role authenticator login noinherit password '${restPassword}';
grant anon, authenticated, service_role to authenticator;`);
	const seq = await sql(`select last_seq from public.qorpera_folder_clocks where environment_id = '${ENV}';`);
	note(`the test company's folder holds ${Object.keys(FILES).length} files of 5 database folders (folder seq ${seq})`);

	// ---- a real PostgREST in front of the platform's database, reached over a socket
	const socketDirectory = mkdtempSync(join(tmpdir(), "cdrest-"));
	chmodSync(socketDirectory, 0o777);
	const image = spawnSync("docker", ["images", "--format", "{{.Repository}}:{{.Tag}}"], { encoding: "utf8" }).stdout
		.split("\n")
		.find((line) => /postgrest\/postgrest:v/.test(line));
	if (!image) throw new Error("No PostgREST image on this machine: run on the machine that holds one (node01)");
	rest = `cdrest-${process.env.CDPROOF_PID}-e2e`;
	const started = spawnSync(
		"docker",
		[
			"run", "-d", "--name", rest, "--network", `container:${platform.container}`, "--volume", `${socketDirectory}:/sock`,
			"-e", `PGRST_DB_URI=postgres://authenticator:${restPassword}@127.0.0.1:5432/${platform.database}`,
			"-e", "PGRST_DB_SCHEMAS=public", "-e", "PGRST_DB_ANON_ROLE=anon", "-e", `PGRST_JWT_SECRET=${secret}`,
			"-e", "PGRST_SERVER_UNIX_SOCKET=/sock/rest.sock", "-e", "PGRST_SERVER_UNIX_SOCKET_MODE=666", "-e", "PGRST_DB_POOL=4",
			image,
		],
		{ encoding: "utf8" },
	);
	if (started.status !== 0) throw new Error(`PostgREST did not start: ${started.stderr}`);
	const socketPath = join(socketDirectory, "rest.sock");
	const socketFetch = (url, init = {}) =>
		new Promise((resolve, reject) => {
			const request = http.request(
				{ socketPath, path: new URL(url).pathname.replace(/^\/rest\/v1/, ""), method: init.method ?? "GET", headers: init.headers },
				(response) => {
					const parts = [];
					response.on("data", (part) => parts.push(part));
					response.on("end", () => {
						const text = Buffer.concat(parts).toString("utf8");
						resolve({ status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300, json: async () => JSON.parse(text), text: async () => text });
					});
				},
			);
			request.on("error", reject);
			request.end(init.body);
		});
	const token = (userId, key = secret, extra = {}) => {
		const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
		const head = `${part({ alg: "HS256", typ: "JWT" })}.${part({ role: "authenticated", sub: userId, aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600, ...extra })}`;
		return `${head}.${createHmac("sha256", key).update(head).digest("base64url")}`;
	};
	let ready = false;
	for (let attempt = 0; attempt < 120 && !ready; attempt++) {
		await sleep(500);
		const probe = await socketFetch("http://rest/rest/v1/rpc/qorpera_member_folder_read", {
			method: "POST",
			headers: { authorization: `Bearer ${token(member(3))}`, "content-type": "application/json" },
			body: JSON.stringify({ p_environment_id: ENV, p_path: "data/shop/database.toml" }),
		}).catch(() => null);
		ready = probe?.status === 200;
		if (attempt === 119 && !ready) note(`PostgREST: ${probe ? `${probe.status} ${await probe.text()}` : "no answer"}; ${spawnSync("docker", ["logs", "--tail", "20", rest], { encoding: "utf8" }).stderr.slice(-1500)}`);
	}
	check("PostgREST answers a member's folder read with the member's own token", ready, image);
	if (!ready) throw new Error("No PostgREST");

	// ---- the store: the gateway's logins and the template, then the gateway
	const logins = Object.fromEntries(["admin", "owner", "write", "read", "watch"].map((door) => [door, randomBytes(16).toString("hex")]));
	const psql = (database, file, variables = {}) => {
		const made = spawnSync(
			"docker",
			["exec", "-i", process.env.CDPROOF_CONTAINER, "psql", "-X", "-q", "-h", "127.0.0.1", "-U", "postgres", "-d", database, "-v", "ON_ERROR_STOP=1",
				...Object.entries(variables).flatMap(([name, value]) => ["-v", `${name}=${value}`])],
			{ input: readFileSync(join(here, "../store", file)), encoding: "utf8" },
		);
		if (made.status !== 0) throw new Error(`${file}: ${made.stderr}`);
	};
	psql("postgres", "cluster.sql", Object.fromEntries(Object.entries(logins).map(([door, password]) => [`${door}_password`, password])));
	psql("qorpera_company_template", "template.sql");
	gateway = new Gateway({
		store: { host: process.env.PGHOST, port: Number(process.env.PGPORT), logins },
		platform: new Platform({ url: "http://rest", publishableKey: "publishable", fetch: socketFetch }),
	});
	server = await serve(gateway);
	const port = server.address().port;
	const agent = new http.Agent({ keepAlive: true });
	const call = (bearer, verb, body) =>
		new Promise((resolve, reject) => {
			const text = JSON.stringify(body);
			const request = http.request(
				{ host: "127.0.0.1", port, path: `/v1/company-data/${ENV}/${verb}`, method: "POST", agent,
					headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", "content-length": Buffer.byteLength(text) } },
				(response) => {
					let answer = "";
					response.on("data", (part) => {
						answer += part;
					});
					response.on("end", () => resolve({ status: response.statusCode, value: JSON.parse(answer) }));
				},
			);
			request.on("error", reject);
			request.end(text);
		});
	/** A call as the web makes it: when the gateway asks for a file's text, the caller reads the file and sends it. */
	const ask = async (bearer, verb, body) => {
		let answer = await call(bearer, verb, body);
		let rounds = 0;
		while (answer.status === 200 && answer.value.need && rounds++ < 3) {
			const texts = Object.fromEntries(answer.value.need.map((wanted) => [wanted.sha256, TEXT_BY_HASH.get(wanted.sha256)]));
			answer = await call(bearer, verb, { ...body, texts });
		}
		return answer;
	};
	const owner = token(member(1));
	const contributor = token(member(2));
	const viewer = token(member(3));
	const stranger = token("63000000-0000-4000-8000-0000000000ff");
	const forged = token(member(1), "another-secret-another-secret-another-secret");

	// ---- the reader of SQL files
	const read1 = readStatement(FILES["data/shop/queries/sales-since.sql"]);
	check("a question's words and parameters are read from its file", read1.ok && read1.parameters.join() === "since" && read1.words[0] === "What the shop sold since a day." && read1.sql.includes("$1::timestamptz"));
	const tricky = readStatement("select ':no' as a, \":no\" as b, $q$ :no $q$ as c, x::int /* :no */ from t where y = :yes -- :no\n and z = :yes;");
	check("parameters inside strings, names, dollar quotes and comments are left alone", tricky.ok && tricky.parameters.join() === "yes", JSON.stringify(tricky.parameters ?? tricky.problem));
	check("two statements in a file are refused by the reader", readStatement("select 1; select 2").ok === false);

	// ---- steps
	const first = await call(contributor, "apply", { database: "shop" });
	check("the gateway asks the caller for the step texts it does not hold, by hash", first.status === 200 && first.value.need?.length === 2, JSON.stringify(first.value).slice(0, 160));
	const wrong = await call(contributor, "apply", { database: "shop", texts: Object.fromEntries(first.value.need.map((wanted) => [wanted.sha256, "drop table everything;"])) });
	check("a text that does not match the folder's hash is not used", wrong.value.need?.length === 2);
	const applied = await ask(contributor, "apply", { database: "shop" });
	check("the shop's two steps are applied from the folder's files", applied.value.applied === true && applied.value.results.map((result) => result.state).join() === "applied,applied", JSON.stringify(applied.value).slice(0, 300));
	const again = await ask(viewer, "apply", { database: "shop" });
	check("applying again applies nothing twice", again.value.applied === true && again.value.results.every((result) => result.state === "already"));
	const described = await call(viewer, "describe", { database: "shop" });
	check("the database is there as its files say", described.value.tables?.map((table) => table.name).join() === "order_totals,orders" && described.value.applied?.length === 2, JSON.stringify(described.value).slice(0, 300));
	const store = companyDatabase(ENV);
	const triggers = await withAdmin(store, (db) => db.query("select count(*)::int as n from pg_trigger where tgname like 'qorpera_%' and not tgisinternal"));
	check("the new table carries Qorpera's three triggers", triggers.rows[0].n === 3, `${triggers.rows[0].n}`);

	// ---- questions, with the viewer's own rights
	const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
	const needText = await call(viewer, "query", { database: "shop", question: "sales-since", params: { since } });
	check("a question the gateway has not seen is asked for by its hash", needText.value.need?.[0]?.path === "data/shop/queries/sales-since.sql");
	const sales = await ask(viewer, "query", { database: "shop", question: "sales-since", params: { since } });
	check("a viewer member reads the named question", sales.status === 200 && sales.value.columns?.join() === "orders,total,average" && sales.value.rows?.[0]?.[0] === 23, JSON.stringify(sales.value).slice(0, 200));
	check("numbers arrive as numbers", typeof sales.value.rows?.[0]?.[1] === "number" && typeof sales.value.rows?.[0]?.[2] === "number");
	const kept = await call(owner, "query", { database: "shop", question: "sales-since", params: { since } });
	check("the next member needs no text: the gateway holds it by hash", kept.status === 200 && Array.isArray(kept.value.rows));
	const same = await call(viewer, "query", { database: "shop", question: "sales-since", params: { since }, etag: sales.value.etag });
	check("an answer the page already holds comes back as the same", same.value.same === true);
	const byStatus = await ask(viewer, "query", { database: "shop", question: "by-status" });
	check("a view made by a step answers too", byStatus.value.rows?.length === 2, JSON.stringify(byStatus.value.rows));
	const noOne = await call(stranger, "query", { database: "shop", question: "sales-since", params: { since } });
	check("someone who is not a member of the company is refused", noOne.status === 404 || noOne.status === 403, `${noOne.status} ${noOne.value.error}`);
	const bad = await call(forged, "query", { database: "shop", question: "sales-since", params: { since } });
	check("a token the platform did not sign is refused", bad.status === 401, `${bad.status}`);
	const missing = await call(viewer, "query", { database: "shop", question: "nothing-here" });
	check("a question that is not in the folder is refused", missing.status === 404);
	const hrApply = await ask(contributor, "apply", { database: "hr" });
	check("the owner of a private database folder applies it", hrApply.value.applied === true, JSON.stringify(hrApply.value).slice(0, 200));
	const hrOwner = await ask(contributor, "query", { database: "hr", question: "total" });
	const hrOther = await ask(viewer, "query", { database: "hr", question: "total" });
	const hrBoss = await ask(owner, "query", { database: "hr", question: "total" });
	check("a member reads a private database's question only when the folder lets them", hrOwner.value.rows?.[0]?.[0] === 99000 && hrOther.status === 404,
		`its owner ${JSON.stringify(hrOwner.value.rows)}, another member ${hrOther.status}, the company's owner ${hrBoss.status}`);
	check("the refusal is the same as for a question that is not there", hrOther.value.error === (await call(viewer, "query", { database: "hr", question: "nothing" })).value.error.replace("nothing", "total"));
	const applyOther = await call(viewer, "apply", { database: "hr" });
	check("another member cannot apply a private database either", applyOther.status === 404);
	await withAdmin(store, (db) => db.query("update shop.orders set placed_by = $1 where id <= 7", [member(3)]));
	const mine = await ask(viewer, "query", { database: "shop", question: "mine" });
	const theirs = await ask(owner, "query", { database: "shop", question: "mine" });
	check(":viewer is the member looking", mine.value.rows?.[0]?.[0] === 7 && theirs.value.rows?.[0]?.[0] === 0);
	const pretend = await ask(owner, "query", { database: "shop", question: "mine", params: { viewer: member(3) } });
	check("a page cannot say who is looking", pretend.status === 400, pretend.value.error);

	// ---- what a question may not do
	const began = now();
	const slow = await ask(viewer, "query", { database: "shop", question: "slow" });
	check("a slow question is stopped at 2 s", slow.status === 408 && now() - began < 3500, `${slow.status} after ${Math.round(now() - began)} ms`);
	const writes = await ask(viewer, "query", { database: "shop", question: "writes" });
	check("a question that writes is refused", writes.status === 400, writes.value.error);
	const two = await ask(viewer, "query", { database: "shop", question: "two" });
	check("a question of two statements is refused", two.status === 400, two.value.error);
	const escape = await ask(viewer, "query", { database: "shop", question: "escape" });
	check("a question cannot leave its read role", escape.status === 400, escape.value.error);
	const orders = await withAdmin(store, (db) => db.query("select count(*)::int as n from shop.orders"));
	check("nothing was written by the refused questions", orders.rows[0].n === 240);

	// ---- steps that must not land
	const risky = await ask(contributor, "apply", { database: "risky" });
	const held = risky.value.results?.find((result) => result.name === "002-drop-weight");
	check("a step that drops a column and deletes rows is held, with what it would destroy", held?.state === "held" && held.destroys?.some((effect) => effect.what === "dropped table column") && held.destroys?.some((effect) => effect.what === "deleted rows" && effect.rows === 10), JSON.stringify(held));
	const riskyCount = await ask(viewer, "query", { database: "risky", question: "count" });
	check("the held step left every row and the column as they were", riskyCount.value.rows?.[0]?.join() === "50,50", JSON.stringify(riskyCount.value.rows));
	const broken = await ask(contributor, "apply", { database: "broken" });
	check("a step with a mistake fails with PostgreSQL's words and changes nothing", broken.value.results?.[0]?.state === "failed" && /tabel/.test(broken.value.results[0].detail), JSON.stringify(broken.value.results?.[0]));
	const brokenTables = await call(viewer, "describe", { database: "broken" });
	check("nothing of the failed step is there", brokenTables.value.tables?.length === 0 && brokenTables.value.applied?.length === 0);
	const sneaky = await ask(contributor, "apply", { database: "sneaky" });
	const commits = sneaky.value.results?.find((result) => result.name === "002-commit");
	const ledger = await withAdmin(store, (db) => db.query("select count(*)::int as n from sneaky.ledger"));
	check("a step that tries to end the transaction fails, and what follows it does not run", commits?.state === "failed" && ledger.rows[0].n === 20, JSON.stringify(commits));

	// ---- the folder stays the truth: a changed file is used at the next call, a changed applied step stops applying
	const newQuestion = "-- Orders and money by status, with each order's average.\nselect status, orders, total, round(total / orders, 2) as average from order_totals order by status;\n";
	TEXT_BY_HASH.set(sha256(newQuestion), newQuestion);
	await put("pg_temp.member(2)", "e2e-question-2", { "data/shop/queries/by-status.sql": newQuestion });
	await sleep(50);
	// The gateway keeps a member's folder read for 10 s: another member's first read sees the new file at once.
	const changedQuestion = await ask(owner, "query", { database: "shop", question: "by-status" });
	check("a question changed in the folder is the one asked at the next read", changedQuestion.value.columns?.join() === "status,orders,total,average", JSON.stringify(changedQuestion.value.columns));
	const tampered = FILES["data/shop/tables/001-orders.sql"].replace("amount >= 0", "amount >= -1");
	TEXT_BY_HASH.set(sha256(tampered), tampered);
	await put("pg_temp.member(2)", "e2e-step-changed", { "data/shop/tables/001-orders.sql": tampered });
	const afterChange = await ask(owner, "apply", { database: "shop" });
	check("an applied step that was changed stops applying and is named", afterChange.value.applied === false && afterChange.value.results?.[0]?.state === "changed" && afterChange.value.results[0].name === "001-orders", JSON.stringify(afterChange.value).slice(0, 240));
	await put("pg_temp.member(2)", "e2e-step-back", { "data/shop/tables/001-orders.sql": FILES["data/shop/tables/001-orders.sql"] });
	const third = "create table customers (id bigint generated always as identity primary key, name text not null);\n";
	TEXT_BY_HASH.set(sha256(third), third);
	await put("pg_temp.member(2)", "e2e-step-3", { "data/shop/tables/003-customers.sql": third });
	const afterBack = await ask(token(member(4)), "apply", { database: "shop" });
	check("with the applied step put back, a new step is applied", afterBack.value.applied === true && afterBack.value.results?.at(-1)?.name === "003-customers" && afterBack.value.results.at(-1).state === "applied", JSON.stringify(afterBack.value).slice(0, 300));

	// ---- live: a held watch call answers when a row changes
	const watched = { database: "shop", question: "sales-since", params: { since } };
	const current = (await ask(viewer, "query", watched)).value;
	const quiet = now();
	const nothing = await call(viewer, "watch", { watches: [{ ...watched, etag: current.etag }], wait: 1 });
	check("a watch with nothing new waits, then says the same", nothing.value.same === true && now() - quiet >= 900, `${Math.round(now() - quiet)} ms`);
	const stale = await call(viewer, "watch", { watches: [{ ...watched, etag: "an-old-etag" }], wait: 5 });
	check("a watch whose page holds an old answer is answered at once", stale.value.changed?.[0]?.answer?.rows?.[0]?.[0] === current.rows[0][0]);
	const latencies = [];
	let etag = current.etag;
	let count = current.rows[0][0];
	let wrongAnswers = 0;
	const insert = async () => {
		const client = admin(store);
		await client.connect();
		return client;
	};
	const live = await insert();
	for (let trial = 0; trial < 50; trial++) {
		const waiting = call(viewer, "watch", { watches: [{ ...watched, etag }], wait: 10 });
		await sleep(40);
		await live.query("insert into shop.orders (customer, amount) values ($1, $2)", [`Live ${trial}`, 150]);
		const committed = now();
		const answer = await waiting;
		latencies.push(now() - committed);
		const fresh = answer.value.changed?.[0]?.answer;
		if (!fresh || fresh.rows[0][0] !== count + 1) wrongAnswers++;
		else {
			count = fresh.rows[0][0];
			etag = fresh.etag;
		}
	}
	const live50 = percentiles(latencies);
	note(`50 new rows, one at a time: from the commit to the new answer in the watching member's hands: ${JSON.stringify(live50)} ms`);
	check("every new row reached the watching member, with the right number", wrongAnswers === 0, `${wrongAnswers} wrong`);
	check("a new row is with the watching member well within a second (p99)", live50.p99 < 1000, `p99 ${live50.p99} ms`);
	const listeners = await withAdmin("postgres", (db) => db.query("select count(*)::int as n from pg_stat_activity where application_name = 'qorpera-data-gateway listen'"));
	check("the gateway listens on a company's database only while a watch is open", listeners.rows[0].n === 0, `${listeners.rows[0].n} listening`);
	const connections = await withAdmin("postgres", (db) => db.query("select count(*)::int as n from pg_stat_activity where usename like 'qorpera_data_%'"));
	note(`the gateway holds ${connections.rows[0].n} connections to the store now`);
	await live.end();

	// ---- kept running for a page to look at
	const demo = Number(process.env.CDPROOF_DEMO_SECONDS ?? 0);
	if (demo > 0) {
		const feeder = await insert();
		console.log(`DEMO port=${port} env=${ENV} token=${token(member(3), secret, { exp: Math.floor(Date.now() / 1000) + demo + 600 })}`);
		const until = Date.now() + demo * 1000;
		let n = 0;
		while (Date.now() < until) {
			await sleep(2500 + Math.random() * 3000);
			await feeder.query("insert into shop.orders (customer, amount) values ($1, $2)", [`Demo ${++n}`, 100 + Math.floor(Math.random() * 8) * 25]);
		}
		await feeder.end();
	}
} finally {
	if (session) session.kill();
	if (server) {
		server.close();
		server.closeAllConnections();
	}
	if (gateway) await gateway.close();
	if (rest) spawnSync("docker", ["rm", "-f", "-v", rest]);
	platform.close();
}
finish();
