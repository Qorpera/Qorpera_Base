import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

	it("drops a single database folder cleanly (schema, roles, metadata) while preserving sibling databases, then drops the whole company database", async () => {
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

		const droppedCompany = await post(`/v1/admin/company-data/${envId}/drop-company`, {}, `Bearer ${adminToken}`);
		assert.equal(droppedCompany.status, 200, JSON.stringify(droppedCompany.value));
		assert.equal(droppedCompany.value.dropped, true);
		assert.equal(droppedCompany.value.rolesDropped.length, 3);

		const dbs = await asSuperuser("postgres", "select datname from pg_database where datname = $1", [database]);
		assert.equal(dbs.length, 0);
		const companyRoles = await asSuperuser("postgres", "select rolname from pg_roles where rolname ~ $1", [`^${database}_`]);
		assert.equal(companyRoles.length, 0);
	});
});
