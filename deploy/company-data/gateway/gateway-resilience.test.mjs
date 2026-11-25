import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { after, before, describe, it } from "node:test";
import { companyDatabase, Gateway, Platform, POOL_SIZE, serve } from "./gateway.mjs";
import {
	createGatewayHarness,
	dockerUsable,
	ENV_A,
	LIMITS_HERE,
	OWNER,
	VIEWER,
	sha256,
	sleep,
} from "./gateway-test-harness.mjs";

describe("the data gateway extensions, watches and resilience against a real PostgreSQL", { skip: dockerUsable ? false : "needs Linux with Docker" }, () => {
	const h = createGatewayHarness();
	const {
		logins,
		FOLDERS,
		owner,
		contributor,
		viewer,
		put,
		remove,
		platformFetch,
		connect,
		asAdmin,
		listening,
		until,
		call,
		ask,
		describeOne,
		states,
		withGateway,
	} = h;

	before(() => h.start());
	after(() => h.stop());

	it("provides standard PostgreSQL 17 extensions in qorpera_ext and blocks folder writes to qorpera_ext", async () => {
		put(ENV_A, {
			"data/extdemo/database.toml": 'format = "qorpera.database/v1"\nname = "Extensions"\n',
			"data/extdemo/tables/001-base.sql": `
				create table contacts (
					id uuid primary key default uuid_generate_v4(),
					email citext not null unique,
					name text not null,
					path ltree not null,
					tags text[] not null default '{}'
				);
				create index contacts_name_trgm on contacts using gin (name gin_trgm_ops);
				create table bookings (
					id bigint generated always as identity primary key,
					room text not null,
					during tstzrange not null,
					exclude using gist (room with =, during with &&)
				);
				insert into contacts (email, name, path, tags) values
					('Ada@Example.com', 'Søren Kierkegaard', 'org.eng.backend', array['vip', 'dk']),
					('bo@example.com', 'Ada Lovelace', 'org.eng.data', array['eng']);
				insert into bookings (room, during) values
					('A', '[2026-11-21 09:00+00, 2026-11-21 10:00+00)');
			`,
			"data/extdemo/queries/features.sql": `
				select
					(select email::text from contacts where email = 'ada@example.com') as ci_email,
					(select name from contacts where unaccent(lower(name)) like 'soren%') as unaccented,
					(select count(*)::int from contacts where path <@ 'org.eng'::ltree) as in_eng,
					similarity('Kierkegaard', 'Kierkegard') > 0.5 as fuzzy_ok,
					levenshtein('qorpera', 'qorera') as edit_dist,
					encode(digest('hello', 'sha256'), 'hex') as hash,
					encode(hmac('msg', 'key', 'sha256'), 'hex') is not null as hmac_ok;
			`,
			"data/extdemo/actions/book.sql": "insert into bookings (room, during) values (:room, tstzrange(:from::timestamptz, :to::timestamptz)) returning id;\n",
			"data/extdemo/tables/002-escape-ext.sql": "create table qorpera_ext.sneak (id int);\n",
		});
		const applied = await ask(owner, "apply", { database: "extdemo" });
		assert.equal(applied.status, 200, JSON.stringify(applied.value));
		assert.deepEqual(states(applied), ["001-base applied", "002-escape-ext failed"]);
		remove(ENV_A, "data/extdemo/tables/002-escape-ext.sql");
		const features = await ask(viewer, "query", { database: "extdemo", question: "features" });
		assert.equal(features.status, 200, JSON.stringify(features.value));
		assert.deepEqual(features.value.rows[0], [
			"Ada@Example.com",
			"Søren Kierkegaard",
			2,
			true,
			1,
			sha256("hello"),
			true,
		]);
		const overlap = await ask(owner, "change", {
			database: "extdemo",
			change: "book",
			params: { room: "A", from: "2026-11-21T09:30:00Z", to: "2026-11-21T10:30:00Z" },
		});
		assert.equal(overlap.status, 400, JSON.stringify(overlap.value));
		const okBook = await ask(owner, "change", {
			database: "extdemo",
			change: "book",
			params: { room: "A", from: "2026-11-21T10:00:00Z", to: "2026-11-21T11:00:00Z" },
		});
		assert.equal(okBook.status, 200, JSON.stringify(okBook.value));
		const added = await ask(contributor, "edit", {
			database: "extdemo",
			table: "contacts",
			op: "add",
			values: { email: "cy@example.com", name: "Cy", path: "org.ops", tags: ["ops", "on-call"] },
		});
		assert.equal(added.status, 200, JSON.stringify(added.value));
		assert.equal(added.value.row.values[4], "{ops,on-call}");
	});

	it("supports row-level security via qorpera_data.viewer() across query, rows, edit, change and watch", async () => {
		put(ENV_A, {
			"data/rlsdemo/database.toml": 'format = "qorpera.database/v1"\nname = "Private notes"\n[list]\nmembers = "readers"\n',
			"data/rlsdemo/tables/001-notes.sql": `
				create table notes (
					id bigint generated always as identity primary key,
					owner_id uuid not null default qorpera_data.viewer(),
					body text not null
				);
				alter table notes enable row level security;
				create policy own_rows on notes
					using (owner_id = qorpera_data.viewer())
					with check (owner_id = qorpera_data.viewer());
				insert into notes (owner_id, body) values
					('${OWNER}', 'owner secret'),
					('${VIEWER}', 'viewer secret');
			`,
			"data/rlsdemo/queries/all-notes.sql": "select body from notes order by id;\n",
			"data/rlsdemo/actions/add-note.sql": "insert into notes (body) values (:body) returning owner_id, body;\n",
		});
		assert.equal((await ask(owner, "apply", { database: "rlsdemo" })).value.applied, true);
		const ownerQuery = await ask(owner, "query", { database: "rlsdemo", question: "all-notes" });
		const viewerQuery = await ask(viewer, "query", { database: "rlsdemo", question: "all-notes" });
		assert.deepEqual(ownerQuery.value.rows, [["owner secret"]]);
		assert.deepEqual(viewerQuery.value.rows, [["viewer secret"]]);
		const ownerRows = await ask(owner, "rows", { database: "rlsdemo", table: "notes" });
		const viewerRows = await ask(viewer, "rows", { database: "rlsdemo", table: "notes" });
		assert.deepEqual(ownerRows.value.rows.map((r) => r.values[2]), ["owner secret"]);
		assert.deepEqual(viewerRows.value.rows.map((r) => r.values[2]), ["viewer secret"]);
		const [watchOwner, watchViewer] = await Promise.all([
			ask(owner, "watch", { watches: [{ database: "rlsdemo", question: "all-notes", params: {}, etag: "stale" }], wait: 1 }),
			ask(viewer, "watch", { watches: [{ database: "rlsdemo", question: "all-notes", params: {}, etag: "stale" }], wait: 1 }),
		]);
		assert.deepEqual(watchOwner.value.changed[0].answer.rows, [["owner secret"]]);
		assert.deepEqual(watchViewer.value.changed[0].answer.rows, [["viewer secret"]]);
		const added = await ask(viewer, "change", { database: "rlsdemo", change: "add-note", params: { body: "new viewer note" } });
		assert.equal(added.status, 200, JSON.stringify(added.value));
		assert.deepEqual(added.value.rows, [[VIEWER, "new viewer note"]]);
		assert.deepEqual((await ask(owner, "query", { database: "rlsdemo", question: "all-notes" })).value.rows, [["owner secret"]]);
		const forgedEdit = await ask(contributor, "edit", {
			database: "rlsdemo",
			table: "notes",
			op: "add",
			values: { owner_id: OWNER, body: "spoofed" },
		});
		assert.equal(forgedEdit.status, 400, JSON.stringify(forgedEdit.value));
	});

	it("supports array parameters, JSONB object/array parameters, preview formatting and more than 16 parameters", async () => {
		const twentyCols = Array.from({ length: 20 }, (_, i) => `:p${i}::int`).join(" + ");
		put(ENV_A, {
			"data/richparams/database.toml": 'format = "qorpera.database/v1"\nname = "Rich params"\n',
			"data/richparams/tables/001-items.sql": `
				create table items (
					id bigint generated always as identity primary key,
					tag text not null,
					meta jsonb not null default '{}'::jsonb
				);
				insert into items (tag, meta) values
					('alpha', '{"tier": 1}'::jsonb),
					('beta', '{"tier": 2}'::jsonb),
					('gamma', '{"tier": 3}'::jsonb);
			`,
			"data/richparams/queries/by-tags.sql": "select id, tag from items where tag = any(:tags::text[]) order by id;\n",
			"data/richparams/queries/sum-twenty.sql": `select (${twentyCols}) as total;\n`,
			"data/richparams/actions/bulk-add.sql": `
				-- Add :meta and items :items.
				insert into items (tag, meta)
				select x.tag, :meta::jsonb || coalesce(x.meta, '{}'::jsonb)
				from jsonb_to_recordset(:items::jsonb) as x(tag text, meta jsonb)
				returning tag, meta;
			`,
		});
		assert.equal((await ask(owner, "apply", { database: "richparams" })).value.applied, true);
		const filtered = await ask(viewer, "query", { database: "richparams", question: "by-tags", params: { tags: ["alpha", "gamma"] } });
		assert.equal(filtered.status, 200, JSON.stringify(filtered.value));
		assert.deepEqual(filtered.value.rows, [[1, "alpha"], [3, "gamma"]]);
		const twenty = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`p${i}`, i + 1]));
		const summed = await ask(viewer, "query", { database: "richparams", question: "sum-twenty", params: twenty });
		assert.equal(summed.status, 200, JSON.stringify(summed.value));
		assert.deepEqual(summed.value.rows, [[210]]);
		const preview = await ask(viewer, "change", {
			database: "richparams",
			change: "bulk-add",
			preview: true,
			params: { meta: { source: "api" }, items: [{ tag: "delta", meta: { n: 4 } }, { tag: "eps" }] },
		});
		assert.equal(preview.status, 200, JSON.stringify(preview.value));
		assert.equal(preview.value.values.length, 2);
		const inserted = await ask(viewer, "change", {
			database: "richparams",
			change: "bulk-add",
			sha256: preview.value.sha256,
			params: { meta: { source: "api" }, items: [{ tag: "delta", meta: { n: 4 } }, { tag: "eps" }] },
		});
		assert.equal(inserted.status, 200, JSON.stringify(inserted.value));
		assert.deepEqual(inserted.value.rows, [
			["delta", { source: "api", n: 4 }],
			["eps", { source: "api" }],
		]);
	});

	it("filters watch notifications by schema and table, coalesces concurrent multiplayer watches, and reuses cached base-table pages while listening", async () => {
		put(ENV_A, {
			"data/multi/database.toml": 'format = "qorpera.database/v1"\nname = "Multi"\n',
			"data/multi/tables/001-base.sql": `
				create table alpha (id bigint generated always as identity primary key, label text not null);
				create table beta (id bigint generated always as identity primary key, label text not null);
				insert into alpha (label) select 'a' || g from generate_series(1, 5) g;
				insert into beta (label) select 'b' || g from generate_series(1, 5) g;
			`,
			"data/multi/queries/slow-alpha.sql": "select pg_sleep(0.15) is not null as ok, count(*)::int as n from alpha;\n",
			"data/multi/actions/add-beta.sql": "insert into beta (label) values (:label) returning id;\n",
		});
		assert.equal((await ask(owner, "apply", { database: "multi" })).value.applied, true);
		const firstAlpha = await ask(viewer, "rows", { database: "multi", table: "alpha" });
		assert.equal(firstAlpha.status, 200);
		const beforeUnrelated = h.gateway.taken.rows;
		const held = ask(viewer, "watch", {
			watches: [{ database: "multi", table: "alpha", etag: firstAlpha.value.etag }],
			wait: 0.8,
		});
		try {
			for (let i = 0; i < 60 && h.gateway.taken.rows - beforeUnrelated < 5; i++) await sleep(25);
			assert.equal((await ask(owner, "change", { database: "multi", change: "add-beta", params: { label: "b6" } })).status, 200);
			const watched = await held;
			assert.deepEqual(watched, { status: 200, value: { same: true } });
		} finally {
			await held.catch(() => {});
		}
		assert.equal(h.gateway.taken.rows - beforeUnrelated, 5, "initial scan read 5 rows and unrelated beta write caused zero re-queries");
		const beforeCoalesce = h.gateway.taken.rows;
		const [w1, w2, w3, w4] = await Promise.all([
			ask(owner, "watch", { watches: [{ database: "multi", question: "slow-alpha", params: {}, etag: "old" }], wait: 1 }),
			ask(contributor, "watch", { watches: [{ database: "multi", question: "slow-alpha", params: {}, etag: "old" }], wait: 1 }),
			ask(viewer, "watch", { watches: [{ database: "multi", question: "slow-alpha", params: {}, etag: "old" }], wait: 1 }),
			ask(owner, "watch", { watches: [{ database: "multi", question: "slow-alpha", params: {}, etag: "old" }], wait: 1 }),
		]);
		for (const res of [w1, w2, w3, w4]) {
			assert.equal(res.status, 200);
			assert.deepEqual(res.value.changed[0].answer.rows, [[true, 5]]);
		}
		assert.equal(h.gateway.taken.rows - beforeCoalesce, 1, "four concurrent watchers coalesced into one Postgres execution");
		const beforeKeeper = h.gateway.taken.rows;
		const keeperWatch = ask(owner, "watch", {
			watches: [{ database: "multi", table: "alpha", etag: firstAlpha.value.etag }],
			wait: 1.5,
		});
		try {
			for (let i = 0; i < 60 && h.gateway.taken.rows - beforeKeeper < 5; i++) await sleep(25);
			const beforeCached = h.gateway.taken.rows;
			const cachedReconnect = await ask(viewer, "watch", {
				watches: [{ database: "multi", table: "alpha", etag: firstAlpha.value.etag }],
				wait: 0.1,
			});
			assert.deepEqual(cachedReconnect, { status: 200, value: { same: true } });
			assert.equal(h.gateway.taken.rows - beforeCached, 0, "staggered reconnect reused cached base-table page while listener stayed open");
		} finally {
			await keeperWatch.catch(() => {});
		}
	});

	it("invalidates sibling gateway watches across processes on DDL, rejects EADDRINUSE cleanly, and survives aborted HTTP bodies", async () => {
		const initial = await ask(viewer, "rows", { database: "multi", table: "alpha" });
		assert.equal(initial.status, 200);
		const before = h.gateway.taken.rows;
		const watching = ask(viewer, "watch", {
			watches: [{ database: "multi", table: "alpha", etag: initial.value.etag }],
			wait: 2.5,
		});
		try {
			for (let i = 0; i < 60 && h.gateway.taken.rows - before < 5; i++) await sleep(25);
			put(ENV_A, {
				"data/multi/tables/002-add-note.sql": "alter table alpha add column note text not null default 'ok';\n",
			});
			await withGateway({}, async () => {
				const applied = await ask(owner, "apply", { database: "multi" });
				assert.equal(applied.status, 200, JSON.stringify(applied.value));
				assert.equal(applied.value.applied, true);
			});
			const woke = await watching;
			assert.equal(woke.status, 200, JSON.stringify(woke.value));
			assert.equal(woke.value.changed?.length, 1);
			assert.ok(woke.value.changed[0].answer.columns.includes("note"), JSON.stringify(woke.value.changed[0].answer.columns));
		} finally {
			await watching.catch(() => {});
		}
		await assert.rejects(() => serve(h.gateway, { host: "127.0.0.1", port: h.port }), { code: "EADDRINUSE" });
		await new Promise((resolve) => {
			const sock = net.connect(h.port, "127.0.0.1", () => {
				sock.write(
					`POST /v1/company-data/${ENV_A}/query HTTP/1.1\r\n` +
						`Host: 127.0.0.1:${h.port}\r\n` +
						`Authorization: Bearer ${viewer}\r\n` +
						"Content-Type: application/json\r\n" +
						"Content-Length: 200\r\n\r\n{\"dat",
				);
				setTimeout(() => {
					sock.destroy();
					resolve();
				}, 20);
			});
			sock.on("error", () => resolve());
		});
		const healthy = await ask(viewer, "rows", { database: "multi", table: "alpha" });
		assert.equal(healthy.status, 200, JSON.stringify(healthy.value));
	});

	it("recovers pipelined reads and writes cleanly across statement_timeout, constraint errors, 0A000 schema type changes, and cluster IPC hooks", async () => {
		put(ENV_A, {
			"data/pipechaos/database.toml": 'format = "qorpera.database/v1"\nname = "Pipe chaos"\n',
			"data/pipechaos/tables/001-init.sql": `
				create table entries (
					id bigint generated always as identity primary key,
					code text not null unique,
					amount int not null
				);
				insert into entries (code, amount) values ('k1', 10), ('k2', 20);
			`,
			"data/pipechaos/queries/all.sql": "select id, code, amount from entries order by id;\n",
			"data/pipechaos/queries/slow.sql": "select pg_sleep(1.5), count(*) from entries;\n",
			"data/pipechaos/queries/missing.sql": "select * from does_not_exist;\n",
			"data/pipechaos/actions/add.sql": "insert into entries (code, amount) values (:code, :amount) returning id;\n",
		});
		assert.equal((await ask(owner, "apply", { database: "pipechaos" })).value.applied, true);
		for (let i = 0; i < 4; i++) {
			const warmed = await ask(viewer, "query", { database: "pipechaos", question: "all" });
			assert.equal(warmed.status, 200);
			assert.deepEqual(warmed.value.rows, [[1, "k1", 10], [2, "k2", 20]]);
		}
		const timedOut = await ask(viewer, "query", { database: "pipechaos", question: "slow" });
		assert.equal(timedOut.status, 408, JSON.stringify(timedOut.value));
		const missingTbl = await ask(viewer, "query", { database: "pipechaos", question: "missing" });
		assert.equal(missingTbl.status, 400, JSON.stringify(missingTbl.value));
		const dupWrite = await ask(owner, "change", { database: "pipechaos", change: "add", params: { code: "k1", amount: 99 } });
		assert.equal(dupWrite.status, 400, JSON.stringify(dupWrite.value));
		const goodWrite = await ask(owner, "change", { database: "pipechaos", change: "add", params: { code: "k3", amount: 30 } });
		assert.equal(goodWrite.status, 200, JSON.stringify(goodWrite.value));
		put(ENV_A, {
			"data/pipechaos/tables/002-widen.sql": "alter table entries alter column amount type numeric(12, 2);\n",
		});
		assert.equal((await ask(owner, "apply", { database: "pipechaos" })).value.applied, true);
		for (let i = 0; i < 6; i++) {
			const afterAlter = await ask(viewer, "query", { database: "pipechaos", question: "all" });
			assert.equal(afterAlter.status, 200, JSON.stringify(afterAlter.value));
			assert.equal(afterAlter.value.rows.length, 3);
		}
		const events = [];
		await withGateway(
			{
				onAgentRead: (event) => events.push(event),
			},
			async (gw) => {
				const db = companyDatabase(ENV_A);
				gw.setFullDatabases([db]);
				const blocked = await ask(owner, "change", { database: "pipechaos", change: "add", params: { code: "k4", amount: 40 } });
				assert.equal(blocked.status, 507, JSON.stringify(blocked.value));
				gw.setFullDatabases([]);
				const allowed = await ask(owner, "change", { database: "pipechaos", change: "add", params: { code: "k4", amount: 40 } });
				assert.equal(allowed.status, 200, JSON.stringify(allowed.value));
			},
		);
		assert.ok(Array.isArray(events));
	});

	it("batches small-table counts, isolates slow views, and describes multiple databases concurrently", async () => {
		const multiSql =
			Array.from({ length: 12 }, (_, i) => `create table t_${String(i).padStart(2, "0")} (id int primary key);\ninsert into t_${String(i).padStart(2, "0")} select n from generate_series(1, ${i + 1}) n;\n`).join("") +
			"create view v_ok as select * from t_02;\n" +
			"create view v_slow as select * from t_09 where pg_sleep(0.2) is not null;\n";
		const files = {};
		for (const dbName of ["alpha", "beta", "gamma"]) {
			files[`data/${dbName}/database.toml`] = `format = "qorpera.database/v1"\nname = "${dbName}"\nabout = "Batch ${dbName}"\n`;
			files[`data/${dbName}/tables/001-init.sql`] = multiSql;
			for (let q = 0; q < 6; q++) {
				files[`data/${dbName}/queries/q-${q}.sql`] = `-- Query ${q} in ${dbName}.\nselect count(*) as n from t_0${q};\n`;
			}
		}
		put(ENV_A, files);
		for (const dbName of ["alpha", "beta", "gamma"]) {
			const applied = await ask(contributor, "apply", { database: dbName });
			assert.equal(applied.value.applied, true, JSON.stringify(applied.value));
		}
		await withGateway({ limits: { ...LIMITS_HERE, questionMs: 300, countMs: 1_500 } }, async () => {
			const described = await ask(viewer, "describe", {});
			assert.equal(described.status, 200, JSON.stringify(described.value));
			for (const dbName of ["alpha", "beta", "gamma"]) {
				const db = described.value.databases.find((entry) => entry.database === dbName);
				assert.ok(db, dbName);
				assert.equal(db.questions.length, 6);
				const byName = Object.fromEntries(db.tables.map((t) => [t.name, [t.rows, t.rowsAbout]]));
				for (let i = 0; i < 12; i++) {
					assert.deepEqual(byName[`t_${String(i).padStart(2, "0")}`], [i + 1, undefined]);
				}
				assert.deepEqual(byName.v_ok, [3, undefined]);
				assert.deepEqual(byName.v_slow, [undefined, undefined]);
			}
		});
		const companyDb = companyDatabase(ENV_A);
		await asAdmin(companyDb, Array.from({ length: 12 }, (_, i) => `analyze alpha.t_${String(i).padStart(2, "0")}`).join("; "));
		await withGateway({ limits: { ...LIMITS_HERE, questionMs: 2_000, countMs: 1_500 } }, async () => {
			const locker = connect(companyDb);
			await locker.connect();
			try {
				await locker.query("begin");
				await locker.query("lock table alpha.t_06 in access exclusive mode");
				const described = await ask(viewer, "describe", {});
				assert.equal(described.status, 200, JSON.stringify(described.value));
				const alpha = described.value.databases.find((entry) => entry.database === "alpha");
				const alphaRows = Object.fromEntries(alpha.tables.map((t) => [t.name, t.rows]));
				for (let i = 0; i < 12; i++) {
					if (i === 6) assert.equal(alphaRows.t_06, undefined);
					else assert.equal(alphaRows[`t_${String(i).padStart(2, "0")}`], i + 1);
				}
				for (const dbName of ["beta", "gamma"]) {
					const db = described.value.databases.find((entry) => entry.database === dbName);
					const byName = Object.fromEntries(db.tables.map((t) => [t.name, t.rows]));
					for (let i = 0; i < 12; i++) assert.equal(byName[`t_${String(i).padStart(2, "0")}`], i + 1);
				}
				const describes = Array.from({ length: 4 }, () => ask(viewer, "describe", { database: "alpha" }));
				await sleep(100);
				const qStart = Date.now();
				const unlockedQuery = await ask(viewer, "query", { database: "alpha", question: "q-0" });
				const qElapsed = Date.now() - qStart;
				assert.equal(unlockedQuery.status, 200, JSON.stringify(unlockedQuery.value));
				assert.deepEqual(unlockedQuery.value.rows, [[1]]);
				assert.ok(qElapsed < 600, `unlocked query waited ${qElapsed} ms behind describe counts`);
				for (const res of await Promise.all(describes)) {
					assert.equal(res.status, 200, JSON.stringify(res.value));
					const db = res.value.databases.find((entry) => entry.database === "alpha");
					const rows = Object.fromEntries(db.tables.map((t) => [t.name, t.rows]));
					for (let i = 0; i < 12; i++) {
						if (i === 6) assert.equal(rows.t_06, undefined);
						else assert.equal(rows[`t_${String(i).padStart(2, "0")}`], i + 1);
					}
				}
			} finally {
				await locker.query("rollback").catch(() => undefined);
				await locker.end().catch(() => undefined);
			}
			const [{ n }] = await asAdmin(companyDb, "select n from qorpera_data.databases where name = 'alpha'");
			const reader = `${companyDb}_r${n}`;
			await asAdmin(companyDb, `revoke select on alpha.t_00 from ${reader}`);
			try {
				const described = await ask(viewer, "describe", {});
				assert.equal(described.status, 200, JSON.stringify(described.value));
				const alpha = described.value.databases.find((entry) => entry.database === "alpha");
				const alphaRows = Object.fromEntries(alpha.tables.map((t) => [t.name, t.rows]));
				assert.equal(alphaRows.t_00, undefined);
				for (let i = 1; i < 12; i++) {
					assert.equal(alphaRows[`t_${String(i).padStart(2, "0")}`], i + 1);
				}
			} finally {
				await asAdmin(companyDb, `grant select on alpha.t_00 to ${reader}`);
			}
		});
	});

	it("evicts idle pools on 53300 without stale-pool 503s and handles multi-database bursts", async () => {
		const companyDb = companyDatabase(ENV_A);
		const fillToLimit = async () => {
			const fillers = [];
			let hitLimit = false;
			for (let i = 0; i < 48; i++) {
				const client = connect(companyDb, "qorpera_data_keeper", logins.keeper);
				client.on("error", () => undefined);
				try {
					await client.connect();
					fillers.push(client);
				} catch (error) {
					await client.end().catch(() => undefined);
					if (error?.code === "53300") {
						hitLimit = true;
						break;
					}
					throw error;
				}
			}
			return { fillers, hitLimit };
		};
		const manyNames = Array.from({ length: 14 }, (_, i) => `m${String(i).padStart(2, "0")}`);
		const manyFiles = {};
		for (const dbName of manyNames) {
			manyFiles[`data/${dbName}/database.toml`] = `format = "qorpera.database/v1"\nname = "${dbName}"\nabout = "Pool ${dbName}"\n[list]\nmembers = "readers"\n`;
			manyFiles[`data/${dbName}/tables/001-init.sql`] = "create table items (id int primary key);\ninsert into items select n from generate_series(1, 5) n;\n";
			manyFiles[`data/${dbName}/queries/count.sql`] = "-- Count items.\nselect count(*) as n from items;\n";
		}
		put(ENV_A, manyFiles);
		for (const dbName of manyNames) {
			const applied = await ask(contributor, "apply", { database: dbName });
			assert.equal(applied.value.applied, true, JSON.stringify(applied.value));
		}
		await withGateway({ limits: { ...LIMITS_HERE, questionMs: 2_000, countMs: 1_500, watchMs: 1_500 } }, async () => {
			const seed = await ask(viewer, "query", { database: "m00", question: "count" });
			assert.equal(seed.status, 200);
			for (const dbName of ["m01", "m02", "m04"]) {
				assert.equal((await ask(viewer, "query", { database: dbName, question: "count" })).status, 200);
			}
			const idleReaders = (
				await asAdmin("postgres", "select count(*)::int as n from pg_stat_activity where datname = $1 and application_name = 'qorpera-data-gateway r'", [companyDb])
			)[0].n;
			assert.ok(idleReaders >= 4, `expected at least 4 idle reader pools, got ${idleReaders}`);
			const { fillers, hitLimit } = await fillToLimit();
			try {
				assert.equal(hitLimit, true, "expected company database to reach its connection limit");
				const evicted = await Promise.all([
					ask(viewer, "query", { database: "m03", question: "count" }),
					ask(viewer, "query", { database: "m00", question: "count" }),
					ask(viewer, "watch", { watches: [{ database: "m00", question: "count", etag: seed.value.etag }], wait: 0.1 }),
				]);
				for (const res of evicted) assert.equal(res.status, 200, JSON.stringify(res.value));
			} finally {
				await Promise.all(fillers.map((client) => client.end().catch(() => undefined)));
			}
			assert.equal(await until(listening, 0), 0);
			assert.equal((await ask(viewer, "describe", {})).status, 200);
			const results = await Promise.all([
				...Array.from({ length: 12 }, () => ask(viewer, "describe", {})),
				...Array.from({ length: 28 }, (_, i) => ask(viewer, "query", { database: manyNames[i % manyNames.length], question: "count" })),
				...Array.from({ length: 14 }, (_, i) => ask(viewer, "rows", { database: manyNames[i], table: "items", limit: 5 })),
				...Array.from({ length: 3 }, () =>
					ask(viewer, "watch", { watches: [{ database: "m00", question: "count", etag: seed.value.etag }], wait: 1 }),
				),
			]);
			for (const res of results) assert.equal(res.status, 200, JSON.stringify(res.value));
		});
	});

	it("retries listen on 53300 and ends listen clients that finish connecting after stop or close", async () => {
		const companyDb = companyDatabase(ENV_A);
		const gatewayBackends = async () =>
			(await asAdmin("postgres", "select count(*)::int as n from pg_stat_activity where datname = $1 and application_name like 'qorpera-data-gateway %'", [companyDb]))[0].n;
		const dropGatewayBackends = async () => {
			await asAdmin("postgres", "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and application_name like 'qorpera-data-gateway %'", [companyDb]);
			assert.equal(await until(gatewayBackends, 0, 3_000), 0);
		};
		const fillAll = async () => {
			const fillers = [];
			let hitLimit = false;
			for (let i = 0; i < 48; i++) {
				const client = connect(companyDb, "qorpera_data_keeper", logins.keeper);
				client.on("error", () => undefined);
				try {
					await client.connect();
					fillers.push(client);
				} catch (error) {
					await client.end().catch(() => undefined);
					if (error?.code === "53300") {
						hitLimit = true;
						break;
					}
					throw error;
				}
			}
			assert.equal(hitLimit, true, "expected company database to reach its connection limit");
			return fillers;
		};
		const createHoldProxy = async () => {
			let holdNext = false;
			let held = null;
			const sockets = new Set();
			const proxy = net.createServer((clientSocket) => {
				sockets.add(clientSocket);
				clientSocket.on("error", () => undefined);
				clientSocket.once("close", () => sockets.delete(clientSocket));
				const closed = new Promise((resolve) => clientSocket.once("close", resolve));
				const connectUpstream = () => {
					if (clientSocket.destroyed) return;
					const upstream = net.connect(h.storePort, "127.0.0.1");
					sockets.add(upstream);
					upstream.on("error", () => clientSocket.destroy());
					clientSocket.on("error", () => upstream.destroy());
					upstream.once("close", () => {
						sockets.delete(upstream);
						clientSocket.destroy();
					});
					clientSocket.once("close", () => upstream.destroy());
					clientSocket.pipe(upstream);
					upstream.pipe(clientSocket);
				};
				if (holdNext) {
					holdNext = false;
					clientSocket.pause();
					held?.resolve({
						release: () => {
							connectUpstream();
							clientSocket.resume();
						},
						closed,
					});
					return;
				}
				connectUpstream();
			});
			await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
			return {
				port: proxy.address().port,
				armHold: () =>
					new Promise((resolve) => {
						holdNext = true;
						held = { resolve };
					}),
				close: async () => {
					for (const sock of sockets) sock.destroy();
					await new Promise((resolve) => proxy.close(resolve));
				},
			};
		};
		const startRawWatch = (etag) => {
			const text = JSON.stringify({ watches: [{ database: "m00", question: "count", etag }], wait: 2 });
			let responded = false;
			const req = http.request(
				{
					host: "127.0.0.1",
					port: h.port,
					path: `/v1/company-data/${ENV_A}/watch`,
					method: "POST",
					headers: { authorization: `Bearer ${viewer}`, "content-type": "application/json", "content-length": Buffer.byteLength(text) },
				},
				(res) => {
					responded = true;
					res.resume();
				},
			);
			req.on("error", () => undefined);
			req.end(text);
			return { req, hasResponded: () => responded };
		};
		await withGateway({ limits: { ...LIMITS_HERE, watchMs: 2_000 } }, async () => {
			const seed = await ask(viewer, "query", { database: "m00", question: "count" });
			assert.equal(seed.status, 200);
			await dropGatewayBackends();
			const fillers = await fillAll();
			try {
				let settled = false;
				const watchDone = ask(viewer, "watch", {
					watches: [{ database: "m00", question: "count", etag: seed.value.etag }],
					wait: 0.1,
				}).finally(() => {
					settled = true;
				});
				await sleep(150);
				assert.equal(settled, false, "watch returned early instead of retrying 53300 while connecting");
				await Promise.all(fillers.splice(0, 2).map((client) => client.end().catch(() => undefined)));
				const res = await watchDone;
				assert.equal(res.status, 200, JSON.stringify(res.value));
			} finally {
				await Promise.all(fillers.map((client) => client.end().catch(() => undefined)));
			}
			assert.equal(await until(listening, 0), 0);
		});
		const waitClosed = async (closed) => {
			let timer;
			try {
				return await Promise.race([
					closed.then(() => true),
					new Promise((resolve) => {
						timer = setTimeout(resolve, 2_000, false);
					}),
				]);
			} finally {
				clearTimeout(timer);
			}
		};
		const proxy = await createHoldProxy();
		try {
			await withGateway(
				{ store: { host: "127.0.0.1", port: proxy.port, logins }, limits: { ...LIMITS_HERE, watchMs: 2_000 } },
				async () => {
					const seed = await ask(viewer, "query", { database: "m00", question: "count" });
					assert.equal(seed.status, 200);
					const held = proxy.armHold();
					const watchReq = startRawWatch(seed.value.etag);
					const conn = await held;
					assert.equal(watchReq.hasResponded(), false);
					watchReq.req.destroy();
					await sleep(50);
					conn.release();
					assert.equal(await waitClosed(conn.closed), true, "listen client that connected after stop() was not ended");
					assert.equal(await until(listening, 0), 0);
				},
			);
			let closeConn = null;
			await withGateway(
				{ store: { host: "127.0.0.1", port: proxy.port, logins }, limits: { ...LIMITS_HERE, watchMs: 2_000 } },
				async () => {
					const seed = await ask(viewer, "query", { database: "m00", question: "count" });
					assert.equal(seed.status, 200);
					const held = proxy.armHold();
					const watchReq = startRawWatch(seed.value.etag);
					closeConn = await held;
					assert.equal(watchReq.hasResponded(), false);
				},
			);
			closeConn.release();
			assert.equal(await waitClosed(closeConn.closed), true, "listen client that connected after h.gateway.close() was not ended");
			assert.equal(await until(listening, 0), 0);
		} finally {
			await proxy.close();
		}
	});

	it("cancels Platform error bodies and refuses unreadable JSON answers", async () => {
		let canceled = 0;
		const makeResponse = (status, body) => ({
			status,
			ok: status >= 200 && status < 300,
			body: {
				cancel: async () => {
					canceled += 1;
				},
			},
			json: async () => {
				if (body instanceof Error) throw body;
				return body;
			},
		});
		const responses = [
			makeResponse(401, { message: "bad jwt" }),
			makeResponse(403, { message: "denied" }),
			makeResponse(500, { message: "boom" }),
			makeResponse(200, new SyntaxError("unexpected token")),
			makeResponse(503, { message: "down" }),
		];
		const platform = new Platform({
			url: "http://platform/",
			publishableKey: "publishable",
			fetch: async () => responses.shift(),
		});
		await assert.rejects(platform.memberFolders(viewer, ENV_A, "data", 10), (err) => err?.status === 401);
		assert.equal(await platform.memberMayWrite(viewer, ENV_A, "data/desk"), false);
		await assert.rejects(platform.memberFolders(viewer, ENV_A, "data", 10), (err) => err?.status === 503);
		await assert.rejects(
			platform.memberFolders(viewer, ENV_A, "data", 10),
			(err) => err?.status === 503 && /unreadable answer/.test(err?.message ?? ""),
		);
		await assert.rejects(platform.redeemPass("pass-1"), (err) => err?.status === 503);
		assert.equal(canceled, 4);
	});

	it("keeps an idle LISTEN client and stored DDL cache warm across watch gaps within listenIdleMs, then closes it", async () => {
		const companyDb = companyDatabase(ENV_A);
		const watchPids = async () =>
			(
				await asAdmin(
					"postgres",
					"select pid::int as pid from pg_stat_activity where datname = $1 and application_name = 'qorpera-data-gateway listen' order by pid",
					[companyDb],
				)
			).map((row) => row.pid);
		await withGateway({ limits: { ...LIMITS_HERE, watchMs: 2_000, listenIdleMs: 500 } }, async () => {
			const seed = await ask(viewer, "query", { database: "m00", question: "count" });
			assert.equal(seed.status, 200);
			const first = await ask(viewer, "watch", {
				watches: [{ database: "m00", question: "count", etag: seed.value.etag }],
				wait: 0.1,
			});
			assert.equal(first.status, 200);
			const pidsAfterFirst = await watchPids();
			assert.equal(pidsAfterFirst.length, 1);
			const describedWarm = await ask(viewer, "describe", { database: "m00" });
			assert.equal(describedWarm.status, 200);
			await sleep(100);
			const second = await ask(viewer, "watch", {
				watches: [{ database: "m00", question: "count", etag: seed.value.etag }],
				wait: 0.1,
			});
			assert.equal(second.status, 200);
			const pidsAfterSecond = await watchPids();
			assert.deepEqual(pidsAfterSecond, pidsAfterFirst);
			assert.equal(await until(listening, 0, 2_000), 0);
		});
	});

	it("breaks watch out promptly when the LISTEN backend is terminated", async () => {
		const companyDb = companyDatabase(ENV_A);
		await withGateway({ limits: { ...LIMITS_HERE, watchMs: 10_000 } }, async () => {
			const seed = await ask(viewer, "query", { database: "m00", question: "count" });
			assert.equal(seed.status, 200);
			const began = Date.now();
			const waiting = ask(viewer, "watch", {
				watches: [{ database: "m00", question: "count", etag: seed.value.etag }],
				wait: 10,
			});
			assert.equal(await until(listening, 1, 3_000), 1);
			await asAdmin(
				"postgres",
				"select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and application_name = 'qorpera-data-gateway listen'",
				[companyDb],
			);
			const answer = await waiting;
			const elapsed = Date.now() - began;
			assert.equal(answer.status, 200, JSON.stringify(answer.value));
			assert.ok(elapsed < 3_000, `expected watch to return promptly after LISTEN drop, took ${elapsed} ms`);
			assert.equal(await until(listening, 0, 3_000), 0);
		});
	});

	it("drops a database promptly while a slow query holds a reader connection", async () => {
		const companyDb = companyDatabase(ENV_A);
		put(ENV_A, {
			"data/dropbusy/database.toml": 'title = "Drop Busy"\n',
			"data/dropbusy/tables/001-t.sql": "create table t (id int primary key);\n",
			"data/dropbusy/queries/slow.sql": "select pg_sleep(5)::text as waited;\n",
		});
		try {
			await withGateway({ limits: { ...LIMITS_HERE, questionMs: 8_000 } }, async (other) => {
				const applied = await ask(owner, "apply", { database: "dropbusy" });
				assert.equal(applied.status, 200, JSON.stringify(applied.value));
				const slow = ask(viewer, "query", { database: "dropbusy", question: "slow" });
				const activeSlow = async () =>
					(
						await asAdmin(
							"postgres",
							"select count(*)::int as n from pg_stat_activity where datname = $1 and state = 'active' and query ilike '%pg_sleep(5)%'",
							[companyDb],
						)
					)[0].n;
				assert.equal(await until(activeSlow, 1, 3_000), 1);
				const began = Date.now();
				const dropped = await other.dropDatabase(ENV_A, "dropbusy");
				const elapsed = Date.now() - began;
				assert.equal(dropped.dropped, true);
				assert.ok(elapsed < 2_500, `expected dropDatabase to terminate active query promptly, took ${elapsed} ms`);
				const slowRes = await slow;
				assert.ok(slowRes.status >= 400, JSON.stringify(slowRes.value));
			});
		} finally {
			remove(ENV_A, "data/dropbusy/database.toml");
			remove(ENV_A, "data/dropbusy/tables/001-t.sql");
			remove(ENV_A, "data/dropbusy/queries/slow.sql");
		}
	});

	it("forwards unsettled transactions via onUnsettledTx and sweeps cleanly after overflow", async () => {
		const companyDb = companyDatabase(ENV_A);
		put(ENV_A, {
			"data/unsettled/database.toml": 'format = "qorpera.database/v1"\nname = "Unsettled"\n',
			"data/unsettled/tables/001-t.sql": "create table t (id int primary key);\n",
			"data/unsettled/actions/slow.sql": "select pg_sleep(3) as waited;\n",
		});
		assert.equal((await ask(owner, "apply", { database: "unsettled" })).value.applied, true);
		const forwarded = [];
		await withGateway(
			{
				limits: { ...LIMITS_HERE, changeMs: 250 },
				onUnsettledTx: (db, txid) => forwarded.push([db, txid]),
			},
			async (other) => {
				await other.watchOnce();
				const slow = await ask(owner, "change", { database: "unsettled", change: "slow", params: {} });
				assert.equal(slow.status, 408, JSON.stringify(slow.value));
				assert.ok(forwarded.length >= 1, "expected slow change timeout to forward an unsettled txid");
				assert.equal(forwarded[0][0], companyDb);
				const abortedTxid = forwarded[0][1];
				const countTx = async () =>
					(await asAdmin(companyDb, "select count(*)::int as n from qorpera_data.change_log where txid = $1::bigint", [abortedTxid]))[0].n;
				assert.equal(await countTx(), 1);
				await other.watchOnce();
				assert.equal(await countTx(), 1);
				for (let i = 0; i < 10_005; i += 1) other.noteUnsettledTx(companyDb, String(9_000_000 + i));
				await other.watchOnce();
				assert.equal(await countTx(), 0);
			},
		);
	});

	it("discards session state between consecutive apply steps, honors noteSignalled PIDs, and isolates watch coalescing after caller abort", async () => {
		put(ENV_A, {
			"data/stepiso/database.toml": 'title = "Step Isolation"\n',
			"data/stepiso/tables/001-tz.sql":
				"set timezone = 'America/New_York'; create table t (id int primary key, tz text not null);\n",
			"data/stepiso/tables/002-check.sql": "insert into t values (1, current_setting('TimeZone'));\n",
			"data/stepiso/queries/read-tz.sql": "select tz from t where id = 1;\n",
			"data/stepiso/queries/pid.sql": "select pg_backend_pid()::int as pid;\n",
			"data/stepiso/queries/slow-watch.sql": "select pg_sleep(0.35)::text as waited;\n",
		});
		try {
			await withGateway({ limits: { ...LIMITS_HERE, questionMs: 2_000, watchMs: 5_000 } }, async (other) => {
				const applied = await ask(owner, "apply", { database: "stepiso" });
				assert.equal(applied.status, 200, JSON.stringify(applied.value));
				assert.equal(applied.value.applied, true);
				const readTz = await ask(viewer, "query", { database: "stepiso", question: "read-tz" });
				assert.equal(readTz.status, 200, JSON.stringify(readTz.value));
				assert.notEqual(readTz.value.rows[0][0], "America/New_York");

				const firstPid = await ask(viewer, "query", { database: "stepiso", question: "pid" });
				assert.equal(firstPid.status, 200, JSON.stringify(firstPid.value));
				const signalledPid = firstPid.value.rows[0][0];
				other.noteSignalled([signalledPid]);
				const secondPid = await ask(viewer, "query", { database: "stepiso", question: "pid" });
				assert.equal(secondPid.status, 200, JSON.stringify(secondPid.value));
				assert.notEqual(secondPid.value.rows[0][0], signalledPid);

				const warm = await ask(viewer, "query", { database: "stepiso", question: "slow-watch" });
				assert.equal(warm.status, 200, JSON.stringify(warm.value));
				const watchCaller = { userId: VIEWER, key: `u:${VIEWER}`, token: viewer };
				const goneA = new AbortController();
				const watchA = other
					.watch(
						watchCaller,
						ENV_A,
						{ watches: [{ database: "stepiso", question: "slow-watch", params: {}, etag: "stale" }], wait: 1 },
						goneA.signal,
					)
					.catch((err) => err);
				await new Promise((resolve) => setTimeout(resolve, 60));
				goneA.abort();
				const watchB = await other.watch(
					watchCaller,
					ENV_A,
					{
						watches: [{ database: "stepiso", question: "slow-watch", params: {}, etag: "stale" }],
						wait: 1,
					},
					new AbortController().signal,
				);
				assert.equal(watchB.changed.length, 1);
				await watchA;
			});
		} finally {
			remove(ENV_A, "data/stepiso/database.toml");
			remove(ENV_A, "data/stepiso/tables/001-tz.sql");
			remove(ENV_A, "data/stepiso/tables/002-check.sql");
			remove(ENV_A, "data/stepiso/queries/read-tz.sql");
			remove(ENV_A, "data/stepiso/queries/pid.sql");
			remove(ENV_A, "data/stepiso/queries/slow-watch.sql");
		}
	});

	it("recovers from stale relation cache after peer ALTER TABLE, serializes concurrent live apply calls, and drops store-persisted test schemas on dropDatabase", async () => {
		const companyDb = companyDatabase(ENV_A);
		put(ENV_A, {
			"data/clusterrace/database.toml": 'title = "Cluster Race"\n',
			"data/clusterrace/tables/001-init.sql":
				"create table items (id int primary key, title text not null);\ninsert into items values (1, 'alpha');\n",
		});
		const peerEvents = [];
		const gwA = new Gateway({
			store: { host: "127.0.0.1", port: h.storePort, logins },
			platform: new Platform({ url: "http://platform", publishableKey: "publishable", fetch: platformFetch }),
			limits: LIMITS_HERE,
		});
		const gwB = new Gateway({
			store: { host: "127.0.0.1", port: h.storePort, logins },
			platform: new Platform({ url: "http://platform", publishableKey: "publishable", fetch: platformFetch }),
			limits: LIMITS_HERE,
			onSchemaChange: (event) => peerEvents.push(event),
		});
		const ownerCaller = { userId: OWNER, key: `u:${OWNER}`, token: owner };
		const viewerCaller = { userId: VIEWER, key: `u:${VIEWER}`, token: viewer };
		const clusterTexts = () => Object.fromEntries([...FOLDERS[ENV_A].values()].map((t) => [sha256(t), t]));
		try {
			const [applyA, applyB] = await Promise.all([
				gwA.apply(ownerCaller, ENV_A, { database: "clusterrace", texts: clusterTexts() }),
				gwB.apply(ownerCaller, ENV_A, { database: "clusterrace", texts: clusterTexts() }),
			]);
			assert.equal(applyA.applied, true, JSON.stringify(applyA));
			assert.equal(applyB.applied, true, JSON.stringify(applyB));
			const states = [applyA.results[0].state, applyB.results[0].state].sort();
			assert.deepEqual(states, ["already", "applied"]);

			const beforePage = await gwA.rows(viewerCaller, ENV_A, {
				database: "clusterrace",
				table: "items",
				texts: clusterTexts(),
			});
			assert.deepEqual(beforePage.columns, ["id", "title"]);
			assert.equal(beforePage.rows.length, 1);

			put(ENV_A, {
				"data/clusterrace/tables/002-add-note.sql": "alter table items add column note text not null default 'fresh';\n",
			});
			const added = await gwB.apply(ownerCaller, ENV_A, { database: "clusterrace", texts: clusterTexts() });
			assert.equal(added.applied, true, JSON.stringify(added));
			assert.ok(peerEvents.some((ev) => ev.database === companyDb && ev.schema === "clusterrace"));

			const afterPage = await gwA.rows(viewerCaller, ENV_A, {
				database: "clusterrace",
				table: "items",
				texts: clusterTexts(),
			});
			assert.deepEqual(afterPage.columns, ["id", "title", "note"]);
			assert.deepEqual(afterPage.rows[0].values, [1, "alpha", "fresh"]);

			const createdTest = await gwB.createTestSchema(ownerCaller, ENV_A, {
				database: "clusterrace",
				texts: clusterTexts(),
				ttlSeconds: 60,
			});
			assert.match(createdTest.schema, /^qorpera_test_[0-9a-f]{16}$/);
			const dropped = await gwA.dropDatabase(ENV_A, "clusterrace");
			assert.equal(dropped.dropped, true);
			const remaining = await asAdmin(companyDb, "select nspname from pg_namespace where nspname = $1", [createdTest.schema]);
			assert.equal(remaining.length, 0);
		} finally {
			await gwA.close();
			await gwB.close();
			remove(ENV_A, "data/clusterrace/database.toml");
			remove(ENV_A, "data/clusterrace/tables/001-init.sql");
			remove(ENV_A, "data/clusterrace/tables/002-add-note.sql");
		}
	});

	it("waits past stepLockMs on concurrent live apply, scopes peer pool reclamation, prunes idle pools on remove, and enforces connect and stopped-listener cache guards", async () => {
		const companyDb = companyDatabase(ENV_A);
		put(ENV_A, {
			"data/slowapply/database.toml": 'title = "Slow Apply"\n',
			"data/slowapply/tables/001-slow.sql": "select pg_sleep(0.5);\ncreate table slow_items (id int primary key, title text not null);\n",
			"data/slowapply/queries/slow-watch.sql": "select pg_sleep(0.25), count(*) from slow_items;\n",
			"data/slowapply/actions/add-slow.sql": "insert into slow_items (id, title) values (:id, :title);\n",
		});
		const gwSlowA = new Gateway({
			store: { host: "127.0.0.1", port: h.storePort, logins },
			platform: new Platform({ url: "http://platform", publishableKey: "publishable", fetch: platformFetch }),
			limits: { ...LIMITS_HERE, stepLockMs: 250, stepMs: 10_000 },
			workers: 2,
		});
		const gwSlowB = new Gateway({
			store: { host: "127.0.0.1", port: h.storePort, logins },
			platform: new Platform({ url: "http://platform", publishableKey: "publishable", fetch: platformFetch }),
			limits: { ...LIMITS_HERE, stepLockMs: 250, stepMs: 10_000 },
			workers: 2,
		});
		const gwExpired = new Gateway({
			store: { host: "127.0.0.1", port: h.storePort, logins },
			platform: new Platform({ url: "http://platform", publishableKey: "publishable", fetch: platformFetch }),
			limits: { ...LIMITS_HERE, changeMs: 0 },
		});
		const ownerCaller = { userId: OWNER, key: `u:${OWNER}`, token: owner };
		const viewerCaller = { userId: VIEWER, key: `u:${VIEWER}`, token: viewer };
		const slowTexts = () => Object.fromEntries([...FOLDERS[ENV_A].values()].map((t) => [sha256(t), t]));
		try {
			const [applyA, applyB] = await Promise.all([
				gwSlowA.apply(ownerCaller, ENV_A, { database: "slowapply", texts: slowTexts() }),
				gwSlowB.apply(ownerCaller, ENV_A, { database: "slowapply", texts: slowTexts() }),
			]);
			assert.equal(applyA.applied, true, JSON.stringify(applyA));
			assert.equal(applyB.applied, true, JSON.stringify(applyB));
			assert.deepEqual([applyA.results[0].state, applyB.results[0].state].sort(), ["already", "applied"]);

			const countBeforeReclaim = gwSlowA.poolCount;
			assert.ok(countBeforeReclaim >= 2, `expected active pools after apply, got ${countBeforeReclaim}`);
			await gwSlowA.reclaimIdlePools("other_company_db");
			assert.equal(gwSlowA.poolCount, countBeforeReclaim, "peer reclaimIdlePools must not evict unrelated database pools");
			await gwSlowA.reclaimIdlePools(companyDb);
			assert.ok(
				gwSlowA.poolCount < countBeforeReclaim && gwSlowA.poolCount <= 1,
				`peer reclaimIdlePools must close only target database pools, expected <= 1 remaining (@postgres), got ${gwSlowA.poolCount}`,
			);
			await gwSlowA.reclaimIdlePools("postgres");
			assert.equal(gwSlowA.poolCount, 0, "reclaiming postgres pool must leave zero idle pools");

			put(ENV_A, {
				"data/slowapply/tables/002-owner.sql": "create table owner_ping (id int primary key);\n",
			});
			const ownerStep = await gwSlowA.apply(ownerCaller, ENV_A, { database: "slowapply", texts: slowTexts() });
			assert.equal(ownerStep.applied, true, JSON.stringify(ownerStep));
			const countAfterOwner = gwSlowA.poolCount;
			assert.ok(countAfterOwner >= 2, `expected keeper + owner pools, got ${countAfterOwner}`);
			let shrunk = false;
			for (let i = 0; i < 40; i++) {
				if (gwSlowA.poolCount < countAfterOwner) {
					shrunk = true;
					break;
				}
				await new Promise((r) => setTimeout(r, 100));
			}
			assert.equal(shrunk, true, `expected idle owner pool remove handler to shrink poolCount below ${countAfterOwner}, got ${gwSlowA.poolCount}`);

			await gwSlowB.close();
			await assert.rejects(
				() => gwSlowB.rows(viewerCaller, ENV_A, { database: "slowapply", table: "slow_items", texts: slowTexts() }),
				(err) => err?.status === 503,
				"closed gateway connect() must refuse with 503",
			);

			await assert.rejects(
				() =>
					gwExpired.change(ownerCaller, ENV_A, {
						database: "slowapply",
						change: "add-slow",
						params: { id: 1, title: "late" },
						texts: slowTexts(),
					}),
				(err) => err?.status === 408,
				"expired connect(deadline) must refuse with 408",
			);

			const watchController = new AbortController();
			const pendingWatch = gwSlowA
				.watch(
					viewerCaller,
					ENV_A,
					{
						watches: [{ database: "slowapply", question: "slow-watch", params: {}, etag: "stale" }],
						wait: 1,
						texts: slowTexts(),
					},
					watchController.signal,
				)
				.catch((err) => err);
			await new Promise((r) => setTimeout(r, 60));
			await gwSlowA.evictCompany(companyDb);
			await pendingWatch;
			assert.equal(gwSlowA.watchCacheCount, 0, "stopped listener must not repopulate watch cache after eviction");
		} finally {
			await gwSlowA.close();
			await gwSlowB.close();
			await gwExpired.close();
			remove(ENV_A, "data/slowapply/database.toml");
			remove(ENV_A, "data/slowapply/tables/001-slow.sql");
			remove(ENV_A, "data/slowapply/tables/002-owner.sql");
			remove(ENV_A, "data/slowapply/queries/slow-watch.sql");
			remove(ENV_A, "data/slowapply/actions/add-slow.sql");
		}
	});
});
