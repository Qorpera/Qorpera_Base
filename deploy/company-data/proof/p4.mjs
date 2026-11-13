// Proof 4: the nightly snapshot of a large database, as files the company folder can hold.
// The folder keeps every version of every file for good, and stores a file as 4 MiB pieces named by their bytes. So a
// snapshot must change few bytes from one night to the next. Compared here: one file per table, against parts of a
// table cut at fixed key values. A table without a primary key is cut by its rows' place on disk.
// Every snapshot is written to files that are kept: schema.sql, sequences.sql and the parts. Everything is read in one
// transaction that sees one moment, while another connection keeps writing. The files alone bring the rows back, and
// the restored database takes new rows.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, createReadStream, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { admin, check, finish, note, now, sleep, withAdmin } from "./lib.mjs";

const CONTAINER = process.env.CDPROOF_CONTAINER;
const SNAP_HOST = process.env.CDPROOF_SNAP_HOST;
const SNAP = "/snap";
const EVENTS = Number(process.env.CDPROOF_EVENTS ?? 4_000_000);
const CUSTOMERS = 200_000;
const CLICKS = Number(process.env.CDPROOF_CLICKS ?? 560_000);
const PART_BYTES = 16 * 1024 * 1024;
const PIECE = 4 * 1024 * 1024;
const MIB = 1048576;
const BLOCK = 8192;
// A CSV row of the keyless table is a little smaller than its row on disk: 0.85 of 16 MiB of pages keeps a part under 16 MiB.
const BLOCKS_PER_PART = Math.floor((PART_BYTES * 0.85) / BLOCK);
if (!CONTAINER || !SNAP_HOST) throw new Error("run through run.sh: it makes the container and the snapshot folder");

/** The sha256 of a file and of each of its 4 MiB pieces. */
function pieces(source) {
	return new Promise((resolve, reject) => {
		const whole = createHash("sha256");
		const found = [];
		let piece = createHash("sha256");
		let inPiece = 0;
		let bytes = 0;
		const take = (chunk) => {
			whole.update(chunk);
			bytes += chunk.length;
			let offset = 0;
			while (offset < chunk.length) {
				const size = Math.min(PIECE - inPiece, chunk.length - offset);
				piece.update(chunk.subarray(offset, offset + size));
				inPiece += size;
				offset += size;
				if (inPiece === PIECE) {
					found.push(piece.digest("hex"));
					piece = createHash("sha256");
					inPiece = 0;
				}
			}
		};
		const done = () => {
			if (inPiece > 0) found.push(piece.digest("hex"));
			resolve({ bytes, sha: whole.digest("hex"), pieces: found });
		};
		source(take, done, reject);
	});
}
const hashFile = (path) =>
	pieces((take, done, reject) => createReadStream(path, { highWaterMark: 1024 * 1024 }).on("data", take).on("end", done).on("error", reject));

/** Streams one COPY out of the server without keeping it: for the one-file-per-table comparison only. */
const copyOut = (database, sql) =>
	pieces((take, done, reject) => {
		const child = spawn("docker", ["exec", "-i", CONTAINER, "psql", "-h", "127.0.0.1", "-U", "postgres", "-d", database,
			"-v", "ON_ERROR_STOP=1", "-Atc", `copy (${sql}) to stdout (format csv, header)`]);
		let stderr = "";
		child.stdout.on("data", take);
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("close", (code) => (code === 0 ? done() : reject(new Error(stderr.trim() || `psql ended ${code}`))));
	});

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

const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;

/** Row count and a hash of every row, per table. */
async function fingerprint(db) {
	const found = [];
	for (const entry of TABLES) {
		const result = await db.query(`select count(*)::text as n, coalesce(sum(hashtextextended(t::text, 0)), 0)::text as h from ${entry.table} t`);
		found.push(`${entry.table} ${result.rows[0].n}/${result.rows[0].h}`);
	}
	return found.join(", ");
}

const TABLES = [
	{ table: "shop.events", key: "id", cast: "bigint" },
	{ table: "shop.customers", key: "id", cast: "uuid" },
	{ table: "shop.clicks", key: null },
];

/** Where a keyed table is cut: every Nth key in key order, found once and kept from night to night. */
async function boundaries(db, entry) {
	const size = await db.query(`select pg_relation_size('${entry.table}') as heap, (select count(*) from ${entry.table}) as rows`);
	const heap = Number(size.rows[0].heap);
	// Cut so a part is about 16 MiB of CSV: the heap's bytes per row is close to a CSV row's.
	const rowsPerPart = Math.max(1000, Math.round(PART_BYTES / (heap / Number(size.rows[0].rows))));
	if (heap <= PART_BYTES) return [];
	const found = await db.query(
		`select ${entry.key}::text as k from (select ${entry.key}, row_number() over (order by ${entry.key}) as rn from ${entry.table}) s
			where rn % ${rowsPerPart} = 0 order by ${entry.key}`,
	);
	return found.rows.map((row) => row.k);
}

/** What each part of a table holds: a key range, or a range of the table's pages. */
async function partQueries(db, entry, cuts) {
	if (entry.key) {
		const list = cuts[entry.table];
		return Array.from({ length: list.length + 1 }, (_, index) => {
			const low = index === 0 ? null : list[index - 1];
			const high = index === list.length ? null : list[index];
			const where = [low === null ? null : `${entry.key} > ${quote(low)}::${entry.cast}`, high === null ? null : `${entry.key} <= ${quote(high)}::${entry.cast}`]
				.filter(Boolean)
				.join(" and ");
			return `select * from ${entry.table}${where ? ` where ${where}` : ""} order by ${entry.key}`;
		});
	}
	// No key: whole ranges of pages, read by a scan of a tid range. The last part has no end, so it takes every page.
	const blocks = Math.ceil(Number((await db.query(`select pg_relation_size('${entry.table}') as b`)).rows[0].b) / BLOCK);
	const count = Math.max(1, Math.ceil(blocks / BLOCKS_PER_PART));
	return Array.from({ length: count }, (_, index) => {
		const low = `ctid >= '(${index * BLOCKS_PER_PART},0)'::tid`;
		const high = index === count - 1 ? "" : ` and ctid < '(${(index + 1) * BLOCKS_PER_PART},0)'::tid`;
		return `select * from ${entry.table} where ${low}${high}`;
	});
}

/** One snapshot of the database cds into the folder `name`: the shape, the sequences and every part, all read in one
 * transaction that sees one moment. Gives the files' hashes and the fingerprint taken inside that same transaction. */
async function exportSnapshot(name, cuts, { only, afterMoment } = {}) {
	const host = join(SNAP_HOST, name);
	const tables = only ? TABLES.filter((entry) => only.includes(entry.table)) : TABLES;
	for (const path of [host, ...tables.map((entry) => join(host, entry.table))]) {
		mkdirSync(path, { recursive: true });
		chmodSync(path, 0o777);
	}
	const db = admin("cds");
	await db.connect();
	const begun = now();
	await db.query("begin isolation level repeatable read, read only");
	const moment = (await db.query("select pg_export_snapshot() as id, clock_timestamp() as at")).rows[0];
	const momentAt = now();
	if (afterMoment) await afterMoment();
	let schema = "";
	let sequences = [];
	if (!only) {
		// The shape: pg_dump on the export's own snapshot, so it sees the same moment as the rows.
		schema = await run(["pg_dump", "-h", "127.0.0.1", "-U", "postgres", "-d", "cds", "--schema-only", "--schema=shop",
			"--no-owner", "--no-privileges", `--snapshot=${moment.id}`]);
		writeFileSync(join(host, "schema.sql"), schema);
		// Every sequence, an identity column's too. A sequence is not part of a snapshot: read after the moment began,
		// it stands at or past every number the snapshot's rows hold.
		sequences = (
			await db.query(`select format('select pg_catalog.setval(%L, %s, %s);', format('%I.%I', schemaname, sequencename),
				coalesce(last_value, start_value), (last_value is not null)::text) as line from pg_sequences where schemaname = 'shop' order by 1`)
		).rows.map((row) => row.line);
		writeFileSync(join(host, "sequences.sql"), `${sequences.join("\n")}\n`);
	}
	const plan = {};
	for (const entry of tables) {
		plan[entry.table] = await partQueries(db, entry, cuts);
		for (const [index, sql] of plan[entry.table].entries()) {
			await db.query(`copy (${sql}) to '${SNAP}/${name}/${entry.table}/${String(index + 1).padStart(4, "0")}.csv' (format csv, header)`);
		}
	}
	const ms = now() - begun;
	const truth = only ? null : await fingerprint(db);
	await db.query("commit");
	await db.end();
	const endedAt = now();
	await run(["chmod", "-R", "a+rX", `${SNAP}/${name}`]);
	const parts = {};
	for (const entry of tables) {
		const files = readdirSync(join(host, entry.table)).sort();
		parts[entry.table] = [];
		for (const file of files) parts[entry.table].push({ file, ...(await hashFile(join(host, entry.table, file))) });
	}
	const bytes = Object.values(parts).flat().reduce((total, part) => total + part.bytes, 0);
	return { name, ms, truth, parts, bytes, schema, sequences, plan, momentAt, endedAt };
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
const remove = (name) => run(["rm", "-rf", `${SNAP}/${name}`]);

// ---- the database
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
		-- No primary key, and an identity column.
		create table shop.clicks (n bigint generated always as identity, at timestamptz not null, page text not null, detail text not null);
		insert into shop.clicks (at, page, detail)
			select now() - (n || ' seconds')::interval, '/page/' || (n % 500), md5(n::text) || md5((n * 3)::text) || md5((n * 5)::text) || md5((n * 11)::text)
			from generate_series(1, ${CLICKS}) n;
		-- Free keys in the first quarter, which the writer moves rows from the last parts into.
		delete from shop.events where id % 250 = 0 and id <= ${EVENTS / 4};
		analyze;
	`);
});
const size = await withAdmin("cds", (db) => db.query("select pg_database_size('cds') as bytes, pg_relation_size('shop.clicks') as clicks"));
const clicksHeap = Number(size.rows[0].clicks);
note(`database of ${EVENTS.toLocaleString("en")} events, ${CUSTOMERS.toLocaleString("en")} customers and ${CLICKS.toLocaleString("en")} clicks made in ${Math.round((now() - made) / 1000)} s: ${Math.round(size.rows[0].bytes / MIB)} MiB on disk, the keyless clicks ${Math.round(clicksHeap / MIB)} MiB`);
check("the table without a primary key is larger than 64 MiB", clicksHeap > 64 * MIB, `${Math.round(clicksHeap / MIB)} MiB`);
const cuts = {};
let started = now();
await withAdmin("cds", async (db) => {
	for (const entry of TABLES.filter((table) => table.key)) cuts[entry.table] = await boundaries(db, entry);
	const plan = await db.query(`explain ${(await partQueries(db, TABLES[2], cuts))[0]}`);
	check("a part of the keyless table is read by a scan of a tid range", plan.rows.some((row) => /Tid Range Scan/.test(row["QUERY PLAN"])),
		plan.rows.map((row) => row["QUERY PLAN"].trim()).join(" | "));
});
note(`cuts found in ${Math.round(now() - started)} ms`);

// ---- one moment: the export runs while another connection keeps writing
const gaps = Array.from({ length: EVENTS / 4 / 250 }, (_, index) => (index + 1) * 250);
const writes = { stop: false, rounds: 0, inserted: 0, moves: [], deleted: 0, clicksChanged: 0 };
const writer = (async () => {
	const db = admin("cds");
	await db.connect();
	while (!writes.stop) {
		const round = writes.rounds;
		const issued = now();
		await db.query("begin");
		writes.inserted += (await db.query(`insert into shop.events (at, kind, customer, amount, detail)
			select now(), 'order', md5(g::text)::uuid, 1, md5(g::text) from generate_series(1, 20) g`)).rowCount;
		// The review's case: a row's key moves from a late part into an early one.
		const from = EVENTS - round;
		const to = gaps[round];
		const moved = to === undefined ? 0 : (await db.query("update shop.events set id = $1 where id = $2", [to, from])).rowCount;
		writes.deleted += (await db.query("delete from shop.events where id = $1", [EVENTS / 2 + round * 7])).rowCount;
		writes.clicksChanged += (await db.query("update shop.clicks set page = page || '!' where n = $1", [1 + ((round * 997) % CLICKS)])).rowCount;
		writes.clicksChanged += (await db.query("insert into shop.clicks (at, page, detail) values (now(), '/late', 'x')")).rowCount;
		await db.query("commit");
		if (moved) writes.moves.push({ from, to, issued });
		writes.rounds++;
		await sleep(2);
	}
	await db.end();
})();
await sleep(500);
const late = admin("cds");
await late.connect();
const moment = await exportSnapshot("one-moment", cuts, {
	// A table made after the moment began must not be in the shape.
	afterMoment: () => late.query("create table shop.arrived_late (id int)"),
});
writes.stop = true;
await writer;
await late.query("drop table shop.arrived_late");
await late.end();
const movedDuring = writes.moves.filter((move) => move.issued > moment.momentAt);
note(`while the export ran the writer committed ${writes.rounds} transactions: ${writes.inserted} new events, ${writes.moves.length} keys moved from a late part into an early one (${movedDuring.length} after the moment began), ${writes.deleted} events deleted, ${writes.clicksChanged} click rows written`);
check("rows were written and keys moved while the export ran", movedDuring.length > 50 && writes.deleted > 0, `${movedDuring.length} moves after the moment`);
note(`one-moment export: ${Object.entries(moment.parts).map(([table, parts]) => `${table} ${parts.length} parts`).join(", ")}; ${Math.round(moment.bytes / MIB)} MiB in ${(moment.ms / 1000).toFixed(1)} s (${Math.round(moment.bytes / MIB / (moment.ms / 1000))} MiB/s)`);
check("the shape is read at the export's moment: a table made after it is not in schema.sql",
	moment.schema.includes("CREATE TABLE shop.events") && !moment.schema.includes("arrived_late"), `${moment.schema.length} bytes`);
check("sequences.sql puts every sequence back, the identity column's too",
	moment.sequences.length === 2 && moment.sequences.some((line) => line.includes("clicks_n_seq")) && moment.sequences.some((line) => line.includes("events_id_seq")),
	moment.sequences.join(" "));
const keyedLargest = Math.max(...TABLES.filter((entry) => entry.key).flatMap((entry) => moment.parts[entry.table].map((part) => part.bytes)));
check("no part of a keyed table is larger than 32 MiB", keyedLargest <= 32 * MIB, `largest ${(keyedLargest / MIB).toFixed(1)} MiB`);
const keyless = moment.parts["shop.clicks"];
check("the keyless table is written whole in parts of at most 16 MiB", keyless.length > 4 && keyless.every((part) => part.bytes <= PART_BYTES),
	`${keyless.length} parts, ${keyless.map((part) => (part.bytes / MIB).toFixed(1)).join(", ")} MiB`);

// ---- the kept files alone bring the rows back, as of the moment
started = now();
await withAdmin("postgres", (db) => db.query("create database cds_back"));
await run(["psql", "-h", "127.0.0.1", "-U", "postgres", "-d", "cds_back", "-v", "ON_ERROR_STOP=1", "-q", "-f", `${SNAP}/one-moment/schema.sql`]);
const live = await withAdmin("cds", (db) => fingerprint(db));
const restored = await withAdmin("cds_back", async (db) => {
	for (const entry of TABLES) {
		for (const part of moment.parts[entry.table]) {
			await db.query(`copy ${entry.table} from '${SNAP}/one-moment/${entry.table}/${part.file}' (format csv, header)`);
		}
	}
	await db.query(readFileSync(join(SNAP_HOST, "one-moment", "sequences.sql"), "utf8"));
	const restoreMs = now() - started;
	const truth = await fingerprint(db);
	const moved = await db.query("select (select count(*) from shop.events where id = any($1::bigint[]))::int as at_old, (select count(*) from shop.events where id = any($2::bigint[]))::int as at_new",
		[movedDuring.map((move) => move.from), movedDuring.map((move) => move.to)]);
	const highest = await db.query("select (select max(id) from shop.events)::bigint as events, (select max(n) from shop.clicks)::bigint as clicks");
	const event = await db.query("insert into shop.events (at, kind, customer, amount, detail) values (now(), 'order', gen_random_uuid(), 1, 'after') returning id");
	const click = await db.query("insert into shop.clicks (at, page, detail) values (now(), '/after', 'x') returning n");
	return { restoreMs, truth, moved: moved.rows[0], highest: highest.rows[0], event: event.rows[0].id, click: click.rows[0].n };
});
note(`brought back from the files in ${(restored.restoreMs / 1000).toFixed(1)} s`);
note(`the export's own fingerprint: ${moment.truth}`);
check("a database made from the kept files holds exactly the rows of the export's moment", restored.truth === moment.truth, restored.truth);
check("the live database has moved on since, so the check can tell the two apart", live !== moment.truth, live);
check("the keyless table came back with the same rows", restored.truth.split(", ")[2] === moment.truth.split(", ")[2], restored.truth.split(", ")[2]);
check("a row moved into an earlier part during the export is in the snapshot once, at its old key",
	restored.moved.at_old === movedDuring.length && restored.moved.at_new === 0,
	`${restored.moved.at_old} of ${movedDuring.length} at their old key, ${restored.moved.at_new} at the new one`);
check("after loading, a new row takes its id from the sequence, above every loaded one",
	BigInt(restored.event) > BigInt(restored.highest.events), `new id ${restored.event}, highest loaded ${restored.highest.events}`);
check("after loading, a new row takes its number from the identity column, above every loaded one",
	BigInt(restored.click) > BigInt(restored.highest.clicks), `new number ${restored.click}, highest loaded ${restored.highest.clicks}`);
await remove("one-moment");

// ---- night 1, a quiet night: the base the next nights are compared with
const wholeNight = async () => {
	const whole = {};
	const begun = now();
	for (const entry of TABLES) whole[entry.table] = [await copyOut("cds", `select * from ${entry.table}${entry.key ? ` order by ${entry.key}` : ""}`)];
	return { whole, ms: now() - begun };
};
const night1 = await exportSnapshot("night-1", cuts);
const whole1 = await wholeNight();
note(`night 1: ${Object.entries(night1.parts).map(([table, parts]) => `${table} ${parts.length} parts`).join(", ")}; ${Math.round(night1.bytes / MIB)} MiB of CSV written to files in ${(night1.ms / 1000).toFixed(1)} s (${Math.round(night1.bytes / MIB / (night1.ms / 1000))} MiB/s)`);
note(`night 1 as one file per table: ${(whole1.ms / 1000).toFixed(1)} s; largest file ${Math.round(Math.max(...TABLES.map((entry) => whole1.whole[entry.table][0].bytes)) / MIB)} MiB (the folder's cap for one file is 256 MiB)`);

// The same night again, nothing changed: every byte must be the same, or nothing can be told apart.
const again = await exportSnapshot("night-1-again", cuts, { only: ["shop.customers"] });
check("the same rows give the same bytes", again.parts["shop.customers"].every((part, index) => part.sha === night1.parts["shop.customers"][index].sha));
await remove("night-1-again");

// ---- day 2, the usual kind of day: 1 % new events, 500 recent events corrected and 100 recent ones deleted (all among
// the newest 2 %); 1 % new customers, 2,000 customers changed; 1 % new clicks
const recent = `(${EVENTS} - (random() * ${Math.round(EVENTS / 50)})::bigint)`;
await withAdmin("cds", async (db) => {
	await db.query(`insert into shop.events (at, kind, customer, amount, detail)
		select now(), 'order', md5((n % ${CUSTOMERS})::text)::uuid, 10, md5(n::text) || md5((n * 3)::text) || md5((n * 5)::text) || md5((n * 9)::text)
		from generate_series(1, ${Math.round(EVENTS / 100)}) n`);
	await db.query(`update shop.events set amount = amount + 1 where id in (select ${recent} from generate_series(1, 500))`);
	await db.query(`delete from shop.events where id in (select ${recent} from generate_series(1, 100))`);
	await db.query(`insert into shop.customers select md5('new' || n)::uuid, 'New ' || n, 'City 1', 0 from generate_series(1, ${Math.round(CUSTOMERS / 100)}) n`);
	await db.query(`update shop.customers set spent = spent + 5 where id in (select md5((random() * ${CUSTOMERS})::int::text)::uuid from generate_series(1, 2000))`);
	await db.query(`insert into shop.clicks (at, page, detail) select now(), '/new', md5(n::text) from generate_series(1, ${Math.round(CLICKS / 100)}) n`);
});

async function night(label, name, before, wholeBefore) {
	const snapshot = await exportSnapshot(name, cuts);
	const whole = await wholeNight();
	const shares = {};
	for (const entry of TABLES) {
		const inParts = newBytes(before.parts[entry.table], snapshot.parts[entry.table]);
		const asOne = newBytes(wholeBefore.whole[entry.table], whole.whole[entry.table]);
		const all = sum(snapshot.parts[entry.table]);
		note(`${label}, ${entry.table} (${Math.round(all / MIB)} MiB): in parts, ${inParts.changedFiles} of ${snapshot.parts[entry.table].length} files changed and ${Math.round(inParts.bytes / MIB)} MiB is new to the store (${Math.round((100 * inParts.bytes) / all)} %); as one file, ${Math.round(asOne.bytes / MIB)} MiB is new (${Math.round((100 * asOne.bytes) / all)} %)`);
		shares[entry.table] = { share: inParts.bytes / all, changed: inParts.changedFiles, of: snapshot.parts[entry.table].length };
	}
	note(`${label} written in ${(snapshot.ms / 1000).toFixed(1)} s`);
	return { snapshot, whole, shares };
}
const night2 = await night("night 2 (a usual day)", "night-2", night1, whole1);
await remove("night-1");
check("after a usual day an append-mostly table in parts stores under a tenth of itself", night2.shares["shop.events"].share < 0.1,
	`${Math.round(100 * night2.shares["shop.events"].share)} %`);

// ---- day 3, the worst kind: 500 corrections and 100 deletions spread evenly over the whole history
await withAdmin("cds", async (db) => {
	await db.query(`update shop.events set amount = amount + 1 where id in (select (random() * ${EVENTS})::bigint from generate_series(1, 500))`);
	await db.query(`delete from shop.events where id in (select (random() * ${EVENTS})::bigint from generate_series(1, 100))`);
	await db.query(`update shop.clicks set page = page || '!' where n in (select (random() * ${CLICKS})::bigint from generate_series(1, 500))`);
});
const night3 = await night("night 3 (edits all over the history)", "night-3", night2.snapshot, night2.whole);
await remove("night-2");
await remove("night-3");
note(`so the worst case is a whole copy a night: the folder must not keep every night for good (${Math.round(100 * night3.shares["shop.events"].share)} % new)`);

// ---- for scale: PostgreSQL's own dump of the same database
started = now();
const dump = await run(["sh", "-c", "pg_dump -h 127.0.0.1 -U postgres -d cds -Fc --schema=shop | wc -c"]);
note(`pg_dump (one compressed file): ${Math.round(Number(dump.trim()) / MIB)} MiB in ${((now() - started) / 1000).toFixed(1)} s; every night all of it is new to the store`);
finish();
