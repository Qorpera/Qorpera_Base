// Proof 4: the nightly snapshot of a large database, as files the company folder can hold.
// The folder keeps every version of every file for good, and stores a file as 4 MiB pieces named by their bytes. So a
// snapshot must change few bytes from one night to the next. Compared here: one file per table, against parts of a
// table cut at fixed key values. Measured: how long the export takes, how many bytes are new the second night, and
// that the files alone bring the rows back.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { check, finish, note, now, withAdmin } from "./lib.mjs";

const CONTAINER = process.env.CDPROOF_CONTAINER;
const EVENTS = Number(process.env.CDPROOF_EVENTS ?? 4_000_000);
const CUSTOMERS = 200_000;
const PART_BYTES = 16 * 1024 * 1024;
const PIECE = 4 * 1024 * 1024;
const MIB = 1048576;

/** Streams one COPY out of the server; gives the bytes, their sha256 and the sha256 of each 4 MiB piece. */
function copyOut(database, sql) {
	return new Promise((resolve, reject) => {
		const child = spawn("docker", ["exec", "-i", CONTAINER, "psql", "-h", "127.0.0.1", "-U", "postgres", "-d", database,
			"-v", "ON_ERROR_STOP=1", "-Atc", `copy (${sql}) to stdout (format csv, header)`]);
		const whole = createHash("sha256");
		const pieces = [];
		let piece = createHash("sha256");
		let inPiece = 0;
		let bytes = 0;
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			whole.update(chunk);
			bytes += chunk.length;
			let offset = 0;
			while (offset < chunk.length) {
				const take = Math.min(PIECE - inPiece, chunk.length - offset);
				piece.update(chunk.subarray(offset, offset + take));
				inPiece += take;
				offset += take;
				if (inPiece === PIECE) {
					pieces.push(piece.digest("hex"));
					piece = createHash("sha256");
					inPiece = 0;
				}
			}
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("close", (code) => {
			if (code !== 0) return reject(new Error(stderr.trim() || `psql ended ${code}`));
			if (inPiece > 0) pieces.push(piece.digest("hex"));
			resolve({ bytes, sha: whole.digest("hex"), pieces });
		});
	});
}

function run(args, input) {
	return new Promise((resolve, reject) => {
		const child = spawn("docker", ["exec", "-i", CONTAINER, ...args]);
		let out = "";
		let err = "";
		child.stdout.on("data", (chunk) => {
			out += chunk;
		});
		child.stderr.on("data", (chunk) => {
			err += chunk;
		});
		child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `ended ${code}`))));
		if (input !== undefined) child.stdin.end(input);
		else child.stdin.end();
	});
}

const quote = (value) => (typeof value === "number" || typeof value === "bigint" ? String(value) : `'${String(value).replace(/'/g, "''")}'`);

/** Where a table is cut: every Nth key in key order, read once in one pass over its key index. */
async function boundaries(db, table, key, rowsPerPart) {
	const found = await db.query(
		`select ${key}::text as k from (select ${key}, row_number() over (order by ${key}) as rn from ${table}) s
			where rn % ${rowsPerPart} = 0 order by ${key}`,
	);
	return found.rows.map((row) => row.k);
}

/** One night's snapshot of a table as parts between fixed cuts. */
async function snapshotParts(database, table, key, cuts, cast) {
	const parts = [];
	for (let index = 0; index <= cuts.length; index++) {
		const low = index === 0 ? null : cuts[index - 1];
		const high = index === cuts.length ? null : cuts[index];
		const where = [low === null ? null : `${key} > ${quote(low)}::${cast}`, high === null ? null : `${key} <= ${quote(high)}::${cast}`]
			.filter(Boolean)
			.join(" and ");
		parts.push(await copyOut(database, `select * from ${table}${where ? ` where ${where}` : ""} order by ${key}`));
	}
	return parts;
}

const sum = (parts) => parts.reduce((total, part) => total + part.bytes, 0);
function newBytes(before, after) {
	// A piece is stored once whatever file it is in: count the bytes of pieces the store has not seen.
	const seen = new Set(before.flatMap((part) => part.pieces));
	let bytes = 0;
	let changedFiles = 0;
	after.forEach((part, index) => {
		if (before[index]?.sha !== part.sha) changedFiles++;
		part.pieces.forEach((piece, at) => {
			if (!seen.has(piece)) bytes += Math.min(PIECE, part.bytes - at * PIECE);
		});
	});
	return { bytes, changedFiles };
}

await withAdmin("postgres", (db) => db.query("create database cds"));
const made = now();
await withAdmin("cds", async (db) => {
	await db.query(`
		create schema shop;
		create table shop.events (id bigserial primary key, at timestamptz not null, kind text not null, customer uuid not null,
			amount numeric(12,2), detail text not null);
		insert into shop.events (at, kind, customer, amount, detail)
			select now() - ((${EVENTS} - n) || ' seconds')::interval, (array['view','cart','order','refund'])[1 + n % 4],
				md5((n % ${CUSTOMERS})::text)::uuid, (n % 9000) / 7.0, md5(n::text) || md5((n * 7)::text) || md5((n * 13)::text) || md5((n * 17)::text)
			from generate_series(1, ${EVENTS}) n;
		create table shop.customers (id uuid primary key, name text not null, city text not null, spent numeric(12,2) not null default 0);
		insert into shop.customers select md5(n::text)::uuid, 'Customer ' || n, 'City ' || (n % 300), 0 from generate_series(0, ${CUSTOMERS - 1}) n;
		analyze;
	`);
});
const size = await withAdmin("cds", (db) => db.query("select pg_database_size('cds') as bytes, pg_relation_size('shop.events') as events, pg_relation_size('shop.customers') as customers"));
note(`database of ${EVENTS.toLocaleString("en")} events and ${CUSTOMERS.toLocaleString("en")} customers made in ${Math.round((now() - made) / 1000)} s: ${Math.round(size.rows[0].bytes / MIB)} MiB on disk`);

// ---- night 1
const tables = [
	{ table: "shop.events", key: "id", cast: "bigint", heap: Number(size.rows[0].events), rows: EVENTS },
	{ table: "shop.customers", key: "id", cast: "uuid", heap: Number(size.rows[0].customers), rows: CUSTOMERS },
];
const night1 = {};
let started = now();
await withAdmin("cds", async (db) => {
	for (const entry of tables) {
		// Cut so a part is about 16 MiB of CSV: the heap's bytes per row is close to a CSV row's.
		entry.rowsPerPart = Math.max(1000, Math.round(PART_BYTES / (entry.heap / entry.rows)));
		entry.cuts = entry.heap <= PART_BYTES ? [] : await boundaries(db, entry.table, entry.key, entry.rowsPerPart);
	}
});
const cutsMs = now() - started;
started = now();
for (const entry of tables) night1[entry.table] = await snapshotParts("cds", entry.table, entry.key, entry.cuts, entry.cast);
const partsMs = now() - started;
started = now();
const whole1 = {};
for (const entry of tables) whole1[entry.table] = [await copyOut("cds", `select * from ${entry.table} order by ${entry.key}`)];
const wholeMs = now() - started;
const total1 = tables.reduce((total, entry) => total + sum(night1[entry.table]), 0);
note(`night 1: cuts found in ${Math.round(cutsMs)} ms; ${tables.map((entry) => `${entry.table} ${night1[entry.table].length} parts`).join(", ")}; ${Math.round(total1 / MIB)} MiB of CSV written in ${(partsMs / 1000).toFixed(1)} s (${Math.round(total1 / MIB / (partsMs / 1000))} MiB/s)`);
note(`night 1 as one file per table: ${(wholeMs / 1000).toFixed(1)} s; largest file ${Math.round(Math.max(...tables.map((entry) => whole1[entry.table][0].bytes)) / MIB)} MiB (the folder's cap for one file is 256 MiB)`);
check("no part is larger than 64 MiB", tables.every((entry) => night1[entry.table].every((part) => part.bytes <= 64 * MIB)),
	`largest ${Math.round(Math.max(...tables.flatMap((entry) => night1[entry.table].map((part) => part.bytes))) / MIB)} MiB`);

// The same night again, nothing changed: every byte must be the same, or nothing can be told apart.
const again = await snapshotParts("cds", "shop.customers", "id", tables[1].cuts, "uuid");
check("the same rows give the same bytes", again.every((part, index) => part.sha === night1["shop.customers"][index].sha));

// ---- day 2, the usual kind of day: 1 % new events, 500 recent events corrected and 100 recent ones deleted (all among
// the newest 2 %); 1 % new customers, 2,000 customers changed
const recent = `(${EVENTS} - (random() * ${Math.round(EVENTS / 50)})::bigint)`;
await withAdmin("cds", async (db) => {
	await db.query(`insert into shop.events (at, kind, customer, amount, detail)
		select now(), 'order', md5((n % ${CUSTOMERS})::text)::uuid, 10, md5(n::text) || md5((n * 3)::text) || md5((n * 5)::text) || md5((n * 9)::text)
		from generate_series(1, ${Math.round(EVENTS / 100)}) n`);
	await db.query(`update shop.events set amount = amount + 1 where id in (select ${recent} from generate_series(1, 500))`);
	await db.query(`delete from shop.events where id in (select ${recent} from generate_series(1, 100))`);
	await db.query(`insert into shop.customers select md5('new' || n)::uuid, 'New ' || n, 'City 1', 0 from generate_series(1, ${Math.round(CUSTOMERS / 100)}) n`);
	await db.query(`update shop.customers set spent = spent + 5 where id in (select md5((random() * ${CUSTOMERS})::int::text)::uuid from generate_series(1, 2000))`);
});

async function night(label, before, wholeBefore) {
	const parts = {};
	const whole = {};
	const begun = now();
	for (const entry of tables) parts[entry.table] = await snapshotParts("cds", entry.table, entry.key, entry.cuts, entry.cast);
	const ms = now() - begun;
	for (const entry of tables) whole[entry.table] = [await copyOut("cds", `select * from ${entry.table} order by ${entry.key}`)];
	const shares = {};
	for (const entry of tables) {
		const inParts = newBytes(before[entry.table], parts[entry.table]);
		const asOne = newBytes(wholeBefore[entry.table], whole[entry.table]);
		const all = sum(parts[entry.table]);
		note(`${label}, ${entry.table} (${Math.round(all / MIB)} MiB): in parts, ${inParts.changedFiles} of ${parts[entry.table].length} files changed and ${Math.round(inParts.bytes / MIB)} MiB is new to the store (${Math.round((100 * inParts.bytes) / all)} %); as one file, ${Math.round(asOne.bytes / MIB)} MiB is new (${Math.round((100 * asOne.bytes) / all)} %)`);
		shares[entry.table] = inParts.bytes / all;
	}
	note(`${label} written in ${(ms / 1000).toFixed(1)} s`);
	return { parts, whole, shares };
}
const night2 = await night("night 2 (a usual day)", night1, whole1);
check("after a usual day an append-mostly table in parts stores under a tenth of itself", night2.shares["shop.events"] < 0.1,
	`${Math.round(100 * night2.shares["shop.events"])} %`);

// ---- day 3, the worst kind: 500 corrections and 100 deletions spread evenly over the whole history
await withAdmin("cds", async (db) => {
	await db.query(`update shop.events set amount = amount + 1 where id in (select (random() * ${EVENTS})::bigint from generate_series(1, 500))`);
	await db.query(`delete from shop.events where id in (select (random() * ${EVENTS})::bigint from generate_series(1, 100))`);
});
const night3 = await night("night 3 (edits all over the history)", night2.parts, night2.whole);
note(`so the worst case is a whole copy a night: the folder must not keep every night for good (${Math.round(100 * night3.shares["shop.events"])} % new)`);

// ---- the files alone bring the rows back
started = now();
const schema = await run(["pg_dump", "-h", "127.0.0.1", "-U", "postgres", "-d", "cds", "--schema-only", "--schema=shop", "--no-owner", "--no-privileges"]);
note(`the shape as SQL: ${schema.length} bytes`);
await withAdmin("postgres", (db) => db.query("create database cds_back"));
await run(["psql", "-h", "127.0.0.1", "-U", "postgres", "-d", "cds_back", "-v", "ON_ERROR_STOP=1", "-q"], schema);
for (const entry of tables) {
	for (let index = 0; index <= entry.cuts.length; index++) {
		const low = index === 0 ? null : entry.cuts[index - 1];
		const high = index === entry.cuts.length ? null : entry.cuts[index];
		const where = [low === null ? null : `${entry.key} > ${quote(low)}::${entry.cast}`, high === null ? null : `${entry.key} <= ${quote(high)}::${entry.cast}`].filter(Boolean).join(" and ");
		// Server to server here, standing in for "read the part file from the folder and COPY it in".
		await run(["sh", "-c", `psql -h 127.0.0.1 -U postgres -d cds -v ON_ERROR_STOP=1 -Atc "copy (select * from ${entry.table}${where ? ` where ${where.replace(/"/g, '\\"')}` : ""} order by ${entry.key}) to stdout (format csv, header)" | psql -h 127.0.0.1 -U postgres -d cds_back -v ON_ERROR_STOP=1 -q -c "copy ${entry.table} from stdin (format csv, header)"`]);
	}
}
const restoreMs = now() - started;
const fingerprint = (database) =>
	withAdmin(database, async (db) => {
		const events = await db.query("select count(*)::text as n, sum(hashtextextended(e::text, 0))::text as h from shop.events e");
		const customers = await db.query("select count(*)::text as n, sum(hashtextextended(c::text, 0))::text as h from shop.customers c");
		return `${events.rows[0].n}/${events.rows[0].h} ${customers.rows[0].n}/${customers.rows[0].h}`;
	});
const [source, back] = [await fingerprint("cds"), await fingerprint("cds_back")];
check("a database made from the shape and the parts holds the same rows", source === back, back);
note(`brought back in ${(restoreMs / 1000).toFixed(1)} s`);

// ---- for scale: PostgreSQL's own dump of the same database
started = now();
const dump = await run(["sh", "-c", "pg_dump -h 127.0.0.1 -U postgres -d cds -Fc --schema=shop | wc -c"]);
note(`pg_dump (one compressed file): ${Math.round(Number(dump.trim()) / MIB)} MiB in ${((now() - started) / 1000).toFixed(1)} s; every night all of it is new to the store`);
finish();
