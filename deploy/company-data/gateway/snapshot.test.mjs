import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { POSTGRES_IMAGE, POSTGRES_LOCALE } from "../../../scripts/test-hosted-db.mjs";
import { companyDatabase, Gateway, serve } from "./gateway.mjs";
import { diffSnapshotFiles, exportDatabaseSnapshot, restoreDatabaseSnapshot } from "./snapshot.mjs";

const dockerUsable = process.platform === "linux" && spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const storeFile = (name) => readFileSync(new URL(`../store/${name}`, import.meta.url), "utf8");

describe("company-data snapshots and lifecycle cleanup", { skip: !dockerUsable }, () => {
	let container = "";
	let port = 0;
	let gwServer = null;
	let gwPort = 0;
	let gateway = null;
	const workDir = mkdtempSync(join(tmpdir(), "qorpera-snap-test-"));
	const logins = {
		admin: randomBytes(16).toString("hex"),
		keeper: randomBytes(16).toString("hex"),
		watch: randomBytes(16).toString("hex"),
		folderKey: randomBytes(32).toString("hex"),
	};
	const adminToken = randomBytes(32).toString("base64url");
	const envId = randomUUID();
	const userId = randomUUID();
	const token = `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub: userId })).toString("base64url")}.sig`;
	const files = new Map();

	const platform = {
		async memberReads(_tok, _env, paths) {
			return paths.map((p) => (files.has(p) ? { sha256: sha256(files.get(p)), bytes: Buffer.byteLength(files.get(p)) } : null));
		},
		async memberListPage(_tok, _env, parent, limit) {
			const prefix = `${parent}/`;
			const list = [...files.entries()]
				.filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
				.map(([p, text]) => ({ name: p.slice(prefix.length), sha256: sha256(text), bytes: Buffer.byteLength(text) }))
				.sort((a, b) => (a.name < b.name ? -1 : 1));
			return { files: list.slice(0, limit), more: list.length > limit };
		},
		async memberList(tok, env, parent, limit) {
			return (await this.memberListPage(tok, env, parent, limit)).files;
		},
		async memberMayWrite() {
			return true;
		},
		async memberFolders() {
			return ["shop", "crm"];
		},
	};

	const textsOf = () => Object.fromEntries([...files.values()].map((t) => [sha256(t), t]));

	const post = (path, body, auth = `Bearer ${token}`) =>
		new Promise((resolve, reject) => {
			const encoded = JSON.stringify(body);
			const req = http.request(
				{
					host: "127.0.0.1",
					port: gwPort,
					method: "POST",
					path,
					headers: { authorization: auth, "content-type": "application/json", "content-length": Buffer.byteLength(encoded) },
				},
				(res) => {
					const chunks = [];
					res.on("data", (c) => chunks.push(c));
					res.on("end", () => resolve({ status: res.statusCode, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
				},
			);
			req.on("error", reject);
			req.end(encoded);
		});

	const asSuperuser = async (database, sql, values = []) => {
		const client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", password: "test-password", database });
		await client.connect();
		try {
			return (await client.query(sql, values)).rows;
		} finally {
			await client.end();
		}
	};

	const dockerDumpSchema = ({ database, schema, snapshotId, lockWaitMs }) => {
		const res = spawnSync(
			"docker",
			[
				"exec",
				container,
				"pg_dump",
				"-h",
				"127.0.0.1",
				"-U",
				"postgres",
				"-d",
				database,
				"--schema-only",
				`--schema=${schema}`,
				"--no-owner",
				"--no-privileges",
				`--lock-wait-timeout=${lockWaitMs}`,
				`--snapshot=${snapshotId}`,
			],
			{ encoding: "utf8" },
		);
		if (res.status !== 0) throw new Error(res.stderr || `pg_dump failed ${res.status}`);
		return res.stdout;
	};

	before(async () => {
		container = `qsnap-${process.pid}-${randomBytes(3).toString("hex")}`;
		const started = spawnSync(
			"docker",
			["run", "-d", "--rm", "--name", container, "-e", "POSTGRES_PASSWORD=test-password", ...POSTGRES_LOCALE, "-p", "127.0.0.1::5432", POSTGRES_IMAGE],
			{ encoding: "utf8" },
		);
		if (started.status !== 0) throw new Error(started.stderr);
		const mapped = spawnSync("docker", ["port", container, "5432/tcp"], { encoding: "utf8" }).stdout.trim();
		port = Number(mapped.split(":").at(-1));
		for (let i = 0; i < 100; i++) {
			const ready = spawnSync("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]);
			if (ready.status === 0) break;
			await new Promise((r) => setTimeout(r, 100));
		}
		const clusterSql = storeFile("cluster.sql")
			.replaceAll(":'admin_password'", `'${logins.admin}'`)
			.replaceAll(":'keeper_password'", `'${logins.keeper}'`)
			.replaceAll(":'watch_password'", `'${logins.watch}'`);
		const initCluster = spawnSync("docker", ["exec", "-i", container, "psql", "-h", "127.0.0.1", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"], {
			input: clusterSql,
			encoding: "utf8",
		});
		assert.equal(initCluster.status, 0, initCluster.stderr);
		const initTemplate = spawnSync(
			"docker",
			["exec", "-i", container, "psql", "-h", "127.0.0.1", "-U", "postgres", "-d", "qorpera_company_template", "-v", "ON_ERROR_STOP=1"],
			{ input: storeFile("template.sql"), encoding: "utf8" },
		);
		assert.equal(initTemplate.status, 0, initTemplate.stderr);

		gateway = new Gateway({
			store: { host: "127.0.0.1", port, logins },
			platform,
			admin: { token: adminToken },
		});
		gwServer = await serve(gateway, { host: "127.0.0.1", port: 0 });
		gwPort = gwServer.address().port;

		files.set("data/shop/database.toml", 'format = "qorpera.database/v1"\nname = "Shop"\n');
		files.set(
			"data/shop/tables/001-init.sql",
			`create table orders (id bigserial primary key, note text, amount numeric(10,2) not null);
			insert into orders (note, amount) select case when n % 7 = 0 then null else 'Order, "quote" ' || n end, (n * 1.5)::numeric(10,2) from generate_series(1, 2500) n;
			select setval('shop.orders_id_seq', 50000, false);
			create table clicks (at text not null, page text not null);
			insert into clicks select '2026-11-21', '/p/' || n from generate_series(1, 200) n;`,
		);
		files.set("data/crm/database.toml", 'format = "qorpera.database/v1"\nname = "CRM"\n');
		files.set("data/crm/tables/001-init.sql", "create table leads (id serial primary key, name text not null); insert into leads (name) values ('Ada');");

		const a1 = await post(`/v1/company-data/${envId}/apply`, { database: "shop", texts: textsOf() });
		assert.equal(a1.status, 200, JSON.stringify(a1.value));
		const a2 = await post(`/v1/company-data/${envId}/apply`, { database: "crm", texts: textsOf() });
		assert.equal(a2.status, 200, JSON.stringify(a2.value));
	});

	after(async () => {
		gwServer?.close();
		gwServer?.closeAllConnections?.();
		await gateway?.close();
		if (container) spawnSync("docker", ["rm", "-f", container]);
		rmSync(workDir, { recursive: true, force: true });
	});

	it("exports consistent partitioned snapshots, diffs consecutive nights incrementally, and restores with matching hashes and sequences", async () => {
		const database = companyDatabase(envId);
		const store = { host: "127.0.0.1", port, logins };
		const night1Dir = join(workDir, "night-1");
		const snap1 = await exportDatabaseSnapshot({
			store,
			database,
			schema: "shop",
			outDir: night1Dir,
			partBytes: 32 * 1024,
			dumpSchema: dockerDumpSchema,
		});
		assert.equal(snap1.manifest.tables.length, 2);
		const ordersMeta = snap1.manifest.tables.find((t) => t.name === "orders");
		assert.equal(ordersMeta.rows, 2500);
		assert.ok(ordersMeta.parts.length >= 2, `expected multi-part cut, got ${ordersMeta.parts.length}`);

		await asSuperuser(database, "insert into shop.orders (note, amount) values ('Late row', 99.95)");
		const night2Dir = join(workDir, "night-2");
		const snap2 = await exportDatabaseSnapshot({
			store,
			database,
			schema: "shop",
			outDir: night2Dir,
			cuts: snap1.manifest.cuts,
			partBytes: 32 * 1024,
			dumpSchema: dockerDumpSchema,
		});
		const diff = diffSnapshotFiles(snap1.manifest.files, snap2.manifest.files);
		assert.ok(diff.unchanged.length >= 2, `expected unchanged parts across nights, got ${JSON.stringify(diff)}`);
		assert.equal(diff.removed.length, 0);

		const restoreDb = "qsnap_restore_target";
		await asSuperuser("postgres", `create database ${restoreDb} template qorpera_company_template`);
		const restored = await restoreDatabaseSnapshot({
			store: { host: "127.0.0.1", port, logins: { admin: "test-password" } },
			user: "postgres",
			password: "test-password",
			database: restoreDb,
			schema: "shop",
			snapshotDir: night2Dir,
		});
		assert.equal(restored.allMatched, true, JSON.stringify(restored));
		const nextRow = await asSuperuser(restoreDb, "insert into shop.orders (note, amount) values ('After restore', 1.00) returning id");
		assert.equal(Number(nextRow[0].id), 50001);
		await asSuperuser("postgres", `drop database if exists ${restoreDb} with (force)`);
	});

	it("round-trips empty strings vs NULL, char(N)/bit(N), reverse-alphabetical and self-referencing FKs, user triggers, partitioned tables, composite PKs, reserved table names, and rejects tampered files", async () => {
		const database = companyDatabase(envId);
		const store = { host: "127.0.0.1", port, logins };
		files.set("data/edge/database.toml", 'format = "qorpera.database/v1"\nname = "Edge"\n');
		files.set(
			"data/edge/tables/001-edge.sql",
			`
			create table users (
				id int primary key,
				bio text not null default '',
				opt text,
				code char(6) not null,
				flags bit(4) not null
			);
			create table assignments (
				id int primary key,
				user_id int not null references users(id),
				note text not null default ''
			);
			create table employees (
				id int primary key,
				manager_id int references employees(id),
				updated_at text not null
			);
			create function stamp_employee() returns trigger language plpgsql as $$
			begin
				new.updated_at := 'mutated-by-trigger';
				return new;
			end $$;
			create trigger trg_stamp before insert on employees for each row execute function stamp_employee();
			create table events (
				day int not null,
				seq int not null,
				label text not null,
				primary key (day, seq)
			) partition by range (day);
			create table events_p1 partition of events for values from (1) to (10);
			create table events_p2 partition of events for values from (10) to (20);
			create table "order" (
				id serial primary key,
				label text not null
			);
			create table "User Items/2026" (
				id int primary key,
				v text not null
			);
			insert into users values
				(1, '', null, 'ABCDEF', B'1010'),
				(2, 'hi', '', '123456', B'0101');
			insert into assignments values (10, 1, ''), (11, 2, 'ok');
			insert into employees values (2, null, 'orig-2');
			insert into employees values (1, 2, 'orig-1');
			update employees set updated_at = 'kept-1' where id = 1;
			update employees set updated_at = 'kept-2' where id = 2;
			insert into events values (2, 1, 'oct-a'), (5, 2, 'oct-b'), (12, 1, 'nov-a');
			insert into "order" (label) values ('reserved-1'), ('reserved-2');
			insert into "User Items/2026" values (1, 'slash-safe');
			`,
		);
		const applied = await post(`/v1/company-data/${envId}/apply`, { database: "edge", texts: textsOf() });
		assert.equal(applied.status, 200, JSON.stringify(applied.value));

		const edgeDir = join(workDir, "edge-snap");
		const exported = await exportDatabaseSnapshot({
			store,
			database,
			schema: "edge",
			outDir: edgeDir,
			partBytes: 64 * 1024,
			dumpSchema: dockerDumpSchema,
		});
		const tableNames = exported.manifest.tables.map((t) => t.name).sort();
		assert.ok(tableNames.includes("events_p1") && tableNames.includes("events_p2"), JSON.stringify(tableNames));
		assert.ok(tableNames.includes("User Items/2026"));

		const restoreDb = "qsnap_restore_edge";
		await asSuperuser("postgres", `create database ${restoreDb} template qorpera_company_template`);
		try {
			const restored = await restoreDatabaseSnapshot({
				store: { host: "127.0.0.1", port, logins: { admin: "test-password" } },
				user: "postgres",
				password: "test-password",
				database: restoreDb,
				schema: "edge",
				snapshotDir: edgeDir,
			});
			assert.equal(restored.allMatched, true, JSON.stringify(restored));

			const users = await asSuperuser(restoreDb, "select id, bio, opt, code, flags::text from edge.users order by id");
			assert.deepEqual(users, [
				{ id: 1, bio: "", opt: null, code: "ABCDEF", flags: "1010" },
				{ id: 2, bio: "hi", opt: "", code: "123456", flags: "0101" },
			]);
			const emps = await asSuperuser(restoreDb, "select id, manager_id, updated_at from edge.employees order by id");
			assert.deepEqual(emps, [
				{ id: 1, manager_id: 2, updated_at: "kept-1" },
				{ id: 2, manager_id: null, updated_at: "kept-2" },
			]);
			const evs = await asSuperuser(restoreDb, "select day, seq, label from edge.events order by day, seq");
			assert.deepEqual(evs, [
				{ day: 2, seq: 1, label: "oct-a" },
				{ day: 5, seq: 2, label: "oct-b" },
				{ day: 12, seq: 1, label: "nov-a" },
			]);
			const nextOrder = await asSuperuser(restoreDb, 'insert into edge."order" (label) values (\'reserved-3\') returning id');
			assert.equal(Number(nextOrder[0].id), 3);
			const rowChangesCount = await asSuperuser(restoreDb, "select count(*)::int as n from qorpera_data.row_changes where schema = 'edge'");
			assert.equal(rowChangesCount[0].n, 1, "only post-restore insert was audited; restore itself did not flood row_changes");

			const anyCsv = exported.manifest.tables[0].parts[0];
			writeFileSync(join(edgeDir, anyCsv), "tampered\n", "utf8");
			await assert.rejects(
				() =>
					restoreDatabaseSnapshot({
						store: { host: "127.0.0.1", port, logins: { admin: "test-password" } },
						user: "postgres",
						password: "test-password",
						database: restoreDb,
						schema: "edge",
						snapshotDir: edgeDir,
						applySchema: false,
					}),
				/integrity check failed/,
			);
		} finally {
			await asSuperuser("postgres", `drop database if exists ${restoreDb} with (force)`);
		}
	});

	it("restores wide multi-megabyte rows in byte-bounded batches, retries stale cuts cleanly, and preserves existing outDir on export failure", async () => {
		const database = companyDatabase(envId);
		const wideDir = join(workDir, "wide-snap");
		const restoreDb = `qorpera_snap_wide_${randomBytes(4).toString("hex")}`;
		await asSuperuser(database, "create schema if not exists wide");
		await asSuperuser(database, "create table wide.blobs (id integer primary key, payload text not null)");
		const oneMiB = "w".repeat(1024 * 1024);
		for (let id = 1; id <= 6; id += 1) {
			await asSuperuser(database, "insert into wide.blobs (id, payload) values ($1, $2)", [id, `${id}:${oneMiB}`]);
		}
		const exported = await exportDatabaseSnapshot({
			store: { host: "127.0.0.1", port, logins: { admin: "test-password" } },
			user: "postgres",
			password: "test-password",
			database,
			schema: "wide",
			outDir: wideDir,
			cuts: { blobs: ["not-an-integer"] },
			dumpSchema: async () =>
				"CREATE SCHEMA wide;\nCREATE TABLE wide.blobs (id integer NOT NULL, payload text NOT NULL);\nALTER TABLE ONLY wide.blobs ADD CONSTRAINT blobs_pkey PRIMARY KEY (id);\n",
		});
		assert.equal(exported.manifest.tables[0].rows, 6);

		const sentinelPath = join(wideDir, "sentinel.txt");
		writeFileSync(sentinelPath, "keep-me", "utf8");
		await assert.rejects(
			() =>
				exportDatabaseSnapshot({
					store: { host: "127.0.0.1", port, logins: { admin: "test-password" } },
					user: "postgres",
					password: "test-password",
					database,
					schema: "wide",
					outDir: wideDir,
					dumpSchema: async () => {
						throw new Error("simulated pg_dump outage");
					},
				}),
			/simulated pg_dump outage/,
		);
		assert.equal(readFileSync(sentinelPath, "utf8"), "keep-me");

		await asSuperuser("postgres", `create database ${restoreDb}`);
		try {
			const origQuery = pg.Client.prototype.query;
			let insertQueries = 0;
			pg.Client.prototype.query = function wrappedQuery(...args) {
				const text = typeof args[0] === "string" ? args[0] : args[0]?.text;
				if (typeof text === "string" && text.startsWith('insert into "wide"."blobs"')) insertQueries += 1;
				return origQuery.apply(this, args);
			};
			try {
				const restored = await restoreDatabaseSnapshot({
					store: { host: "127.0.0.1", port, logins: { admin: "test-password" } },
					user: "postgres",
					password: "test-password",
					database: restoreDb,
					schema: "wide",
					snapshotDir: wideDir,
				});
				assert.equal(restored.restoredRows.blobs, 6);
			} finally {
				pg.Client.prototype.query = origQuery;
			}
			assert.ok(insertQueries >= 2, `expected multiple byte-bounded INSERT batches, saw ${insertQueries}`);
			const rows = await asSuperuser(restoreDb, "select id, length(payload)::int as n from wide.blobs order by id");
			assert.deepEqual(
				rows,
				[1, 2, 3, 4, 5, 6].map((id) => ({ id, n: 2 + 1024 * 1024 })),
			);
		} finally {
			await asSuperuser("postgres", `drop database if exists ${restoreDb} with (force)`);
		}
	});

	it("drops a single database folder cleanly (schema, roles, metadata) while preserving sibling databases, allows clean re-creation, then drops the whole company database", async () => {
		const database = companyDatabase(envId);
		const denied = await post(`/v1/admin/company-data/${envId}/drop-database`, { database: "crm" }, "Bearer wrong");
		assert.equal(denied.status, 401);

		const droppedCrm = await post(`/v1/admin/company-data/${envId}/drop-database`, { database: "crm" }, `Bearer ${adminToken}`);
		assert.equal(droppedCrm.status, 200, JSON.stringify(droppedCrm.value));
		assert.equal(droppedCrm.value.dropped, true);
		assert.equal(droppedCrm.value.rolesDropped.length, 3);

		const schemas = await asSuperuser(database, "select nspname from pg_namespace where nspname in ('shop', 'crm') order by 1");
		assert.deepEqual(schemas.map((r) => r.nspname), ["shop"]);

		const remainingRoles = await asSuperuser("postgres", "select rolname from pg_roles where rolname = any($1::text[])", [droppedCrm.value.rolesDropped]);
		assert.equal(remainingRoles.length, 0);

		const recreatedCrm = await post(`/v1/company-data/${envId}/apply`, { database: "crm", texts: textsOf() });
		assert.equal(recreatedCrm.status, 200, JSON.stringify(recreatedCrm.value));
		assert.equal(recreatedCrm.value.applied, true);
		const droppedCrmAgain = await post(`/v1/admin/company-data/${envId}/drop-database`, { database: "crm" }, `Bearer ${adminToken}`);
		assert.equal(droppedCrmAgain.status, 200, JSON.stringify(droppedCrmAgain.value));
		assert.equal(droppedCrmAgain.value.dropped, true);

		const droppedCompany = await post(`/v1/admin/company-data/${envId}/drop-company`, {}, `Bearer ${adminToken}`);
		assert.equal(droppedCompany.status, 200, JSON.stringify(droppedCompany.value));
		assert.equal(droppedCompany.value.dropped, true);
		assert.ok(droppedCompany.value.rolesDropped.length >= 3);

		const dbs = await asSuperuser("postgres", "select datname from pg_database where datname = $1", [database]);
		assert.equal(dbs.length, 0);
		const companyRoles = await asSuperuser("postgres", "select rolname from pg_roles where rolname ~ $1", [`^${database}_`]);
		assert.equal(companyRoles.length, 0);
	});
});
