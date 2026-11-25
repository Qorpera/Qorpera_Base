import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { companyDatabase, serveRuns } from "./gateway.mjs";
import {
	createGatewayHarness,
	dockerUsable,
	ENV_A,
	ENV_D,
	LIMITS_HERE,
	OWNER,
	VIEWER,
	sha256,
	sleep,
} from "./gateway-test-harness.mjs";

describe("the data gateway run door against a real PostgreSQL", { skip: dockerUsable ? false : "needs Linux with Docker" }, () => {
	const h = createGatewayHarness();
	const {
		RUN_TOKEN,
		PASSES,
		TEXTS,
		owner,
		viewer,
		put,
		remove,
		passFor,
		asAdmin,
		until,
		send,
		call,
		ask,
		states,
		withGateway,
	} = h;

	before(() => h.start());
	after(() => h.stop());

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
		send({ to: h.runServer.address().port, path: `/v1/run-data/${verb}`, bearer: token, text: JSON.stringify(body) });
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
		assert.deepEqual(await send({ to: h.runServer.address().port, path: "/v1/run-data/describe", text: JSON.stringify({ pass }) }), refused, "no token");
		assert.deepEqual(await runSend("describe", {}), refused, "no pass");
		assert.deepEqual(await runSend("describe", { pass: "short" }), refused, "not a pass");
		assert.deepEqual(await runSend("describe", { pass: randomBytes(32).toString("base64url") }), refused, "an unknown pass");
		const expired = passFor(ENV_D, OWNER, "stock", { ms: -1 });
		assert.deepEqual(await runSend("describe", { pass: expired }), refused, "an expired pass");
		assert.equal((await runSend("describe", { pass })).status, 200, "the pass, once");
		assert.deepEqual(await runSend("describe", { pass }), refused, "the same pass again");
		assert.equal((await send({ path: "/v1/run-data/describe", bearer: owner, text: JSON.stringify({ pass: passFor(ENV_D, OWNER) }) })).status, 404);
		assert.equal((await send({ to: h.runServer.address().port, path: `/v1/company-data/${ENV_D}/describe`, bearer: RUN_TOKEN, text: "{}" })).status, 404);
		assert.equal((await send({ to: h.runServer.address().port, method: "GET", path: "/v1/run-data/describe", bearer: RUN_TOKEN })).status, 405);
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
		assert.throws(() => serveRuns(h.gateway, { host: "0.0.0.0" }), /needs TLS/);
		assert.throws(() => serveRuns(h.gateway, { cert: "x" }), /both a certificate and its key/);
	});

	it("describes a run's databases before the company has a database, from the texts it asks for", async () => {
		const asked = await runSend("describe", { pass: passFor(ENV_D, OWNER) });
		assert.deepEqual(asked.value.need?.map((wanted) => wanted.path).sort(), [
			"data/stock/database.toml",
			"data/stock/queries/count.sql",
			"data/stock/queries/mine.sql",
			"data/stock/queries/named.sql",
		]);
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
		assert.equal((await runAsk("describe", { database: "diary" })).status, 404);
		assert.equal((await runAsk("describe", { database: "loose" })).status, 404);
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
		put(ENV_D, { "data/stock/tables/002-clear.sql": "delete from items where id > 90;\n" });
		const held = await runAsk("apply", { database: "stock" });
		assert.deepEqual(states(held), ["001-items already", "002-clear held"]);
		assert.deepEqual(held.value.results.at(-1).destroys, [{ what: "deleted rows", object: "stock.items", rows: 10 }]);
		assert.deepEqual((await runAsk("query", { database: "stock", question: "count" })).value.rows, [[100]]);
		const waiting = await runAsk("describe", { database: "stock" });
		assert.deepEqual(waiting.value.databases[0].steps.waiting, ["002-clear"]);
		remove(ENV_D, "data/stock/tables/002-clear.sql");
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
		await asAdmin(companyDatabase(ENV_D), "update stock.items set owner = $1 where id <= 3", [OWNER]);
		await asAdmin(companyDatabase(ENV_D), "update stock.items set owner = $1 where id between 4 and 8", [VIEWER]);
		assert.deepEqual((await runAsk("query", { database: "stock", question: "mine" })).value.rows, [[3]]);
		assert.deepEqual((await runAsk("query", { database: "stock", question: "mine", params: { viewer: VIEWER } })).value.rows, [[5]]);
		assert.equal((await runAsk("query", { database: "stock", question: "mine", params: { viewer: "nobody" } })).status, 400);
		assert.equal((await runAsk("query", { database: "stock", question: "count", params: { viewer: VIEWER } })).status, 400);
		assert.deepEqual((await runAsk("query", { database: "stock", question: "named", params: { id: 7 } })).value.rows, [["item 7"]]);
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
		assert.equal((await runSend("query", { database: "diary", sql: "select 1", pass: passFor(ENV_D, OWNER, "stock") })).status, 404);
		assert.equal((await runSend("apply", { database: "diary", pass: passFor(ENV_D, OWNER, "stock") })).status, 404);
		assert.equal((await runAsk("query", { database: "diary", sql: "select 1" })).status, 404);
		assert.equal((await runAsk("query", { database: "shop", question: "count" }, { env: ENV_D })).status, 404);
		assert.equal((await runSend("query", { database: "shop", question: "count", pass: passFor(ENV_D, OWNER) })).status, 404);
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
		const running = runAsk("query", { database: "stock", sql: "select pg_sleep(2.8) as slept, count(*) as items from items" });
		await sleep(2_500);
		const looked = await h.gateway.watchOnce();
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
		const first = await runSend("change", { database: "stock", change: "add-item", params: { id: 500, name: "Lamp" }, pass: passFor(ENV_D, OWNER, "stock") });
		assert.deepEqual(first.value.need?.map((wanted) => wanted.path), ["data/stock/actions/add-item.sql"]);
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
		assert.deepEqual([added.value.changed, added.value.rows], [1, [[500, OWNER]]]);
		const forOther = await runAsk("change", { database: "stock", change: "add-item", params: { id: 501, name: "Desk", viewer: VIEWER } });
		assert.deepEqual(forOther.value.rows, [[501, VIEWER]], JSON.stringify(forOther.value));
		assert.equal((await runAsk("change", { database: "stock", change: "add-item", params: { id: 502, name: "x", viewer: "nobody" } })).status, 400);
		assert.equal((await runAsk("change", { database: "stock", change: "add-item", params: { id: 500, name: "Twice" } })).status, 400, "PostgreSQL's own refusal: the id is taken");
		const items = (await asAdmin(companyDatabase(ENV_D), "select count(*)::int as n from stock.items"))[0].n;
		const shouted = await runAsk("change", { database: "stock", change: "shout" });
		assert.deepEqual([shouted.status, shouted.value.changed, shouted.value.rows.length, shouted.value.more], [200, items, LIMITS_HERE.agentRows, true], JSON.stringify(shouted.value).slice(0, 300));
		assert.equal((await asAdmin(companyDatabase(ENV_D), "select count(*)::int as n from stock.items where name = upper(name)"))[0].n, items);
		assert.equal((await runSend("change", { database: "diary", change: "add-day", params: { day: "2026-11-14" }, pass: passFor(ENV_D, OWNER, "stock") })).status, 404);
		assert.equal((await runAsk("change", { database: "diary", change: "add-day", params: { day: "2026-11-14" } })).status, 404, "the diary is another member's");
		assert.equal((await runAsk("change", { database: "stock", change: "nope" })).status, 404);
		assert.equal((await runAsk("change", { database: "stock", change: "broken" })).status, 400);
		assert.equal((await runSend("change", { database: "desk", change: "open-ticket", params: { title: "x" }, pass: passFor(ENV_D, OWNER) })).status, 404);
		assert.deepEqual(await runSend("change", { database: "stock", change: "shout" }), { status: 401, value: { error: "Not allowed" } }, "no pass");
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
		const held = await runAsk("apply", { database: "stock" });
		assert.deepEqual(states(held), ["001-items already", "002-clear held"]);
		const { allow, ...rest } = held.value.results.at(-1);
		assert.deepEqual(rest, { name: "002-clear", state: "held", detail: "It would destroy data, which waits for a member", destroys });
		assert.match(allow, new RegExp(`^002-clear\\.${sha256(text)}\\.[0-9a-f]{64}$`));
		const otherDestroys = allow.replace(/[0-9a-f]{64}$/, "0".repeat(64));
		const otherText = `002-clear.${"0".repeat(64)}.${allow.slice(-64)}`;
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
		await asAdmin(companyDatabase(ENV_D), "insert into stock.items (id, name) values (600, 'late')");
		const moved = await runSend("apply", { database: "stock", pass: pass(allow) });
		assert.deepEqual(states(moved), ["001-items already", "002-clear held"]);
		assert.notEqual(moved.value.results.at(-1).allow, allow);
		assert.equal(moved.value.results.at(-1).destroys[0].rows, gone + 1);
		assert.equal((await runAsk("apply", { database: "stock", check: allow })).status, 409);
		await asAdmin(companyDatabase(ENV_D), "delete from stock.items where id = 600");
		assert.equal(await state(), before);
		assert.equal((await runSend("apply", { database: "stock", pass: pass("yes") })).status, 503);
		const applied = await runSend("apply", { database: "stock", pass: pass(allow) });
		assert.equal(applied.status, 200, JSON.stringify(applied.value));
		assert.deepEqual(states(applied), ["001-items already", "002-clear applied"]);
		assert.deepEqual(applied.value.results.at(-1), { name: "002-clear", state: "applied", destroyed: destroys });
		assert.equal(applied.value.applied, true);
		assert.deepEqual(await stock("select count(*)::int as n from stock.items where id > 90"), { n: 0 });
		assert.equal(JSON.parse(await state()).owner, false);
		const described = await runAsk("describe", { database: "stock" });
		assert.deepEqual(described.value.databases[0].steps.applied.map((step) => step.name), ["001-items", "002-clear"]);
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
		const later = "insert into a values (5);\n";
		put(ENV_D, { "data/yard/tables/004-later.sql": later });
		const behind = await runAsk("apply", { database: "yard", check: `004-later.${sha256(later)}.${"0".repeat(64)}` });
		assert.deepEqual([behind.status, behind.value.error], [409, "Step 003-drop waits before 004-later: apply the steps before it first"]);
		assert.deepEqual(states(await runAsk("apply", { database: "yard" })), ["001-make already", "002-more already", "003-drop held"]);
		put(ENV_D, { "data/yard/tables/003-drop.sql": "drop table nope;\n" });
		const fails = await runAsk("apply", { database: "yard", check: `003-drop.${sha256("drop table nope;\n")}.${"0".repeat(64)}` });
		assert.equal(fails.status, 400, JSON.stringify(fails.value));
		assert.match(fails.value.error, /^Step 003-drop fails: table "nope" does not exist/);
		put(ENV_D, { "data/yard/tables/003-drop.sql": "insert into a values (6);\n" });
		const harmless = await runAsk("apply", { database: "yard", check: `003-drop.${sha256("insert into a values (6);\n")}.${"0".repeat(64)}` });
		assert.deepEqual([harmless.status, harmless.value.error], [409, "Step 003-drop destroys nothing now: apply it without allow"]);
		assert.deepEqual((await asAdmin(companyDatabase(ENV_D), "select count(*)::int as n from yard.a"))[0], { n: 4 }, "a check keeps nothing");
		put(ENV_D, { "data/yard/tables/003-drop.sql": drop });
		const yes = await runSend("apply", { database: "yard", pass: passFor(ENV_D, OWNER, "yard", { allow }) });
		assert.deepEqual(states(yes), ["001-make already", "002-more already", "003-drop applied", "004-later applied"], JSON.stringify(yes.value));
		assert.deepEqual(yes.value.results[2].destroyed, [{ what: "dropped table", object: "yard.b" }]);
		assert.equal(yes.value.results[3].destroyed, undefined);
		assert.deepEqual((await asAdmin(companyDatabase(ENV_D), "select to_regclass('yard.b') is null as gone, (select count(*)::int from yard.a) as a"))[0], { gone: true, a: 5 });
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
		for (const broken of [{ viewId: undefined }, { machineId: "not-a-machine" }, { kind: "desktop" }, { staffAgentId: undefined }, { staffAgentId: "an agent" }]) {
			const made = pass();
			Object.assign(PASSES.get(made).kept, broken);
			assert.equal((await runSend("describe", { database: "stock", pass: made })).status, 503, JSON.stringify(broken));
		}
		const asRun = passFor(ENV_D, OWNER, "stock");
		delete PASSES.get(asRun).kept.runId;
		assert.equal((await runSend("describe", { database: "stock", pass: asRun })).status, 503, "a run's pass without its run");
	});
});
