import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { DATABASE_NAME } from "./gateway.mjs";

const PIECE_BYTES = 4 * 1024 * 1024;
const DEFAULT_PART_BYTES = 16 * 1024 * 1024;
const BLOCK_BYTES = 8192;
const DEFAULT_LOCK_WAIT_MS = 2_000;
const DEFAULT_MAX_TRIES = 8;
const CURSOR_BATCH = 2_000;

const quoted = (name) => `"${String(name).replace(/"/g, '""')}"`;
const literal = (value) => `'${String(value).replace(/'/g, "''")}'`;
const TEXT_TYPES = { getTypeParser: () => (value) => value };

function hashBytes(buffer) {
	const whole = createHash("sha256").update(buffer).digest("hex");
	const pieces = [];
	for (let offset = 0; offset < buffer.length; offset += PIECE_BYTES) {
		pieces.push(createHash("sha256").update(buffer.subarray(offset, offset + PIECE_BYTES)).digest("hex"));
	}
	return { bytes: buffer.length, sha256: whole, pieces };
}

function csvCell(value) {
	if (value === null || value === undefined) return "";
	const text = String(value);
	if (!/[",\r\n]/.test(text)) return text;
	return `"${text.replace(/"/g, '""')}"`;
}

function parseCsv(text) {
	const rows = [];
	let row = [];
	let field = "";
	let inQuotes = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inQuotes) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				field += ch;
			}
		} else if (ch === '"') {
			inQuotes = true;
		} else if (ch === ",") {
			row.push(field);
			field = "";
		} else if (ch === "\r") {
			if (text[i + 1] === "\n") i++;
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
		} else if (ch === "\n") {
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
		} else {
			field += ch;
		}
	}
	if (field.length > 0 || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	return rows;
}

function runPgDump({ host, port, user, password, database, schema, snapshotId, lockWaitMs }) {
	return new Promise((resolve, reject) => {
		const child = spawn(
			"pg_dump",
			[
				"-h",
				host,
				"-p",
				String(port),
				"-U",
				user,
				"-d",
				database,
				"--schema-only",
				`--schema=${schema}`,
				"--no-owner",
				"--no-privileges",
				`--lock-wait-timeout=${lockWaitMs}`,
				`--snapshot=${snapshotId}`,
			],
			{ env: { ...process.env, PGPASSWORD: password } },
		);
		let out = "";
		let err = "";
		child.stdout.on("data", (chunk) => {
			out += chunk;
		});
		child.stderr.on("data", (chunk) => {
			err += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve(out);
			else reject(new Error(err.trim() || `pg_dump exited ${code}`));
		});
	});
}

async function listSchemaTables(client, schema) {
	const res = await client.query(
		`select c.relname as name,
			(select array_agg(a.attname::text order by k.n)
				from pg_catalog.pg_index i
				join lateral unnest(i.indkey::int2[]) with ordinality k(attnum, n) on true
				join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
				where i.indrelid = c.oid and i.indisprimary) as pk_cols,
			(select array_agg(pg_catalog.format_type(a.atttypid, -1) order by k.n)
				from pg_catalog.pg_index i
				join lateral unnest(i.indkey::int2[]) with ordinality k(attnum, n) on true
				join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
				where i.indrelid = c.oid and i.indisprimary) as pk_types,
			pg_catalog.pg_relation_size(c.oid) as heap_bytes
		from pg_catalog.pg_class c
		join pg_catalog.pg_namespace n on n.oid = c.relnamespace and n.nspname = $1
		where c.relkind = 'r' and c.relpersistence = 'p' and not c.relispartition
		order by c.relname`,
		[schema],
	);
	return res.rows.map((row) => ({
		name: row.name,
		pkCols: Array.isArray(row.pk_cols) ? row.pk_cols : null,
		pkTypes: Array.isArray(row.pk_types) ? row.pk_types : null,
		heapBytes: Number(row.heap_bytes ?? 0),
	}));
}

async function computeTableCuts(client, schema, table, partBytes) {
	if (!table.pkCols || table.pkCols.length !== 1) return [];
	if (table.heapBytes <= partBytes) return [];
	const rel = `${quoted(schema)}.${quoted(table.name)}`;
	const keyCol = quoted(table.pkCols[0]);
	const countRes = await client.query(`select count(*)::bigint as n from ${rel}`);
	const totalRows = Number(countRes.rows[0]?.n ?? 0);
	if (totalRows <= 0) return [];
	const rowsPerPart = Math.max(1_000, Math.round(partBytes / Math.max(1, table.heapBytes / totalRows)));
	if (totalRows <= rowsPerPart) return [];
	const cutRes = await client.query(
		`select ${keyCol}::text as k from (select ${keyCol}, row_number() over (order by ${keyCol}) as rn from ${rel}) s
		where rn % ${rowsPerPart} = 0 order by ${keyCol}`,
	);
	return cutRes.rows.map((r) => r.k);
}

function buildPartQueries(schema, table, cuts, partBytes) {
	const rel = `${quoted(schema)}.${quoted(table.name)}`;
	if (table.pkCols && table.pkCols.length === 1) {
		const keyCol = quoted(table.pkCols[0]);
		const keyType = table.pkTypes[0];
		const list = cuts ?? [];
		return Array.from({ length: list.length + 1 }, (_, index) => {
			const low = index === 0 ? null : list[index - 1];
			const high = index === list.length ? null : list[index];
			const clauses = [];
			if (low !== null) clauses.push(`${keyCol} > ${literal(low)}::${keyType}`);
			if (high !== null) clauses.push(`${keyCol} <= ${literal(high)}::${keyType}`);
			return `select * from ${rel}${clauses.length ? ` where ${clauses.join(" and ")}` : ""} order by ${keyCol}`;
		});
	}
	if (table.pkCols && table.pkCols.length > 1) {
		const orderBy = table.pkCols.map(quoted).join(", ");
		return [`select * from ${rel} order by ${orderBy}`];
	}
	const blocksPerPart = Math.max(1, Math.floor((partBytes * 0.85) / BLOCK_BYTES));
	const blocks = Math.ceil(table.heapBytes / BLOCK_BYTES);
	const count = Math.max(1, Math.ceil(blocks / blocksPerPart));
	return Array.from({ length: count }, (_, index) => {
		const low = `ctid >= '(${index * blocksPerPart},0)'::tid`;
		const high = index === count - 1 ? "" : ` and ctid < '(${(index + 1) * blocksPerPart},0)'::tid`;
		return `select * from ${rel} where ${low}${high}`;
	});
}

async function queryToCsv(client, sql) {
	const cursorName = `qsnap_${Math.random().toString(16).slice(2, 10)}`;
	await client.query(`declare ${cursorName} no scroll cursor for ${sql}`);
	try {
		const lines = [];
		let headerWritten = false;
		for (;;) {
			const batch = await client.query({ text: `fetch ${CURSOR_BATCH} from ${cursorName}`, rowMode: "array", types: TEXT_TYPES });
			if (!headerWritten) {
				lines.push(batch.fields.map((field) => csvCell(field.name)).join(","));
				headerWritten = true;
			}
			for (const row of batch.rows) {
				lines.push(row.map(csvCell).join(","));
			}
			if (batch.rows.length < CURSOR_BATCH) break;
		}
		return `${lines.join("\n")}\n`;
	} finally {
		await client.query(`close ${cursorName}`).catch(() => undefined);
	}
}

export function diffSnapshotFiles(previousFiles, currentFiles) {
	const prev = new Map(Object.entries(previousFiles ?? {}));
	const changed = [];
	const unchanged = [];
	const removed = [];
	const seenPieces = new Set();
	for (const entry of prev.values()) for (const piece of entry.pieces ?? []) seenPieces.add(piece);
	let newPieceBytes = 0;
	for (const [path, entry] of Object.entries(currentFiles)) {
		if (prev.get(path)?.sha256 === entry.sha256) {
			unchanged.push(path);
		} else {
			changed.push(path);
			entry.pieces.forEach((piece, index) => {
				if (!seenPieces.has(piece)) {
					newPieceBytes += Math.min(PIECE_BYTES, entry.bytes - index * PIECE_BYTES);
					seenPieces.add(piece);
				}
			});
		}
	}
	for (const path of prev.keys()) if (!Object.hasOwn(currentFiles, path)) removed.push(path);
	return { changed, unchanged, removed, newPieceBytes };
}

export async function exportDatabaseSnapshot({
	store,
	database,
	schema,
	outDir,
	cuts = {},
	dumpSchema = runPgDump,
	partBytes = DEFAULT_PART_BYTES,
	lockWaitMs = DEFAULT_LOCK_WAIT_MS,
	maxTries = DEFAULT_MAX_TRIES,
	user = "qorpera_data_admin",
	password = store.logins.admin,
}) {
	if (!DATABASE_NAME.test(schema)) throw new Error(`Invalid database schema name: ${schema}`);
	const client = new pg.Client({
		host: store.host,
		port: store.port,
		user,
		password,
		database,
		application_name: "qorpera-data-snapshot",
	});
	await client.connect();
	const startedAt = Date.now();
	const restarts = [];
	let tries = 0;
	let tables = [];
	let schemaSql = "";
	try {
		for (;;) {
			tries++;
			if (tries > maxTries) {
				throw new Error(`Snapshot could not lock ${schema} in ${maxTries} tries: ${restarts.join("; ")}`);
			}
			tables = await listSchemaTables(client, schema);
			await client.query("begin isolation level repeatable read, read only");
			await client.query("set local timezone = 'UTC'; set local datestyle = 'ISO'; set local bytea_output = 'hex'");
			if (tables.length > 0) {
				try {
					const lockList = tables.map((t) => `${quoted(schema)}.${quoted(t.name)}`).join(", ");
					await client.query(`lock table ${lockList} in access share mode`);
				} catch (error) {
					await client.query("rollback");
					restarts.push(`table disappeared before lock: ${error.message}`);
					continue;
				}
			}
			const snapRes = await client.query("select pg_catalog.pg_export_snapshot() as id");
			const snapshotId = snapRes.rows[0].id;
			const recheck = await listSchemaTables(client, schema);
			if (JSON.stringify(recheck.map((t) => t.name)) !== JSON.stringify(tables.map((t) => t.name))) {
				await client.query("rollback");
				restarts.push("tables changed between discovery and lock");
				continue;
			}
			try {
				schemaSql = await dumpSchema({
					host: store.host,
					port: store.port,
					user,
					password,
					database,
					schema,
					snapshotId,
					lockWaitMs,
				});
				break;
			} catch (error) {
				await client.query("rollback");
				restarts.push(`schema dump lock wait: ${error.message}`);
			}
		}

		mkdirSync(outDir, { recursive: true });
		const files = {};
		const writeTracked = (relPath, content) => {
			const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
			const full = join(outDir, relPath);
			mkdirSync(join(full, ".."), { recursive: true });
			writeFileSync(full, buf);
			files[relPath] = hashBytes(buf);
		};

		writeTracked("schema.sql", schemaSql);

		const seqRows = (
			await client.query(
				"select sequencename as name from pg_catalog.pg_sequences where schemaname = $1 order by sequencename",
				[schema],
			)
		).rows;
		const seqLines = [];
		for (const { name } of seqRows) {
			const fq = `${quoted(schema)}.${quoted(name)}`;
			const state = (await client.query(`select last_value::text as v, is_called from ${fq}`)).rows[0];
			if (state?.v !== null && state?.v !== undefined) {
				seqLines.push(`select pg_catalog.setval(${literal(`${schema}.${name}`)}, ${state.v}, ${state.is_called ? "true" : "false"});`);
			}
		}
		writeTracked("sequences.sql", `${seqLines.join("\n")}${seqLines.length ? "\n" : ""}`);

		const nextCuts = { ...cuts };
		const fingerprints = {};
		const tableParts = {};
		for (const table of tables) {
			if (!Array.isArray(nextCuts[table.name])) {
				nextCuts[table.name] = await computeTableCuts(client, schema, table, partBytes);
			}
			const queries = buildPartQueries(schema, table, nextCuts[table.name], partBytes);
			tableParts[table.name] = [];
			for (let index = 0; index < queries.length; index++) {
				const csv = await queryToCsv(client, queries[index]);
				const relPath = `tables/${table.name}/${String(index + 1).padStart(4, "0")}.csv`;
				writeTracked(relPath, csv);
				tableParts[table.name].push(relPath);
			}
			const fp = (
				await client.query(
					`select count(*)::text as n, coalesce(sum(pg_catalog.hashtextextended(t::text, 0)), 0)::text as h from ${quoted(schema)}.${quoted(table.name)} t`,
				)
			).rows[0];
			fingerprints[table.name] = { rows: Number(fp.n), hash: fp.h };
		}

		await client.query("commit");

		const manifest = {
			format: "qorpera.database-snapshot/v1",
			database: schema,
			takenAt: new Date().toISOString(),
			tries,
			tables: tables.map((t) => ({ name: t.name, pk: t.pkCols ?? [], parts: tableParts[t.name], ...fingerprints[t.name] })),
			cuts: nextCuts,
			files,
		};
		const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
		writeFileSync(join(outDir, "snapshot.json"), manifestJson, "utf8");
		return {
			manifest,
			ms: Date.now() - startedAt,
			restarts,
			totalBytes: Object.values(files).reduce((sum, f) => sum + f.bytes, 0),
		};
	} finally {
		await client.end().catch(() => undefined);
	}
}

export async function restoreDatabaseSnapshot({
	store,
	database,
	schema,
	snapshotDir,
	user = "qorpera_data_admin",
	password = store.logins.admin,
	applySchema = true,
}) {
	if (!DATABASE_NAME.test(schema)) throw new Error(`Invalid database schema name: ${schema}`);
	const manifest = JSON.parse(readFileSync(join(snapshotDir, "snapshot.json"), "utf8"));
	const client = new pg.Client({
		host: store.host,
		port: store.port,
		user,
		password,
		database,
		application_name: "qorpera-data-restore",
	});
	await client.connect();
	try {
		await client.query("begin");
		await client.query("set local timezone = 'UTC'; set local datestyle = 'ISO'; set local bytea_output = 'hex'");
		if (applySchema) {
			const rawSchema = readFileSync(join(snapshotDir, "schema.sql"), "utf8");
			const schemaSql = rawSchema
				.split("\n")
				.filter((line) => !/^\\(?:restrict|unrestrict)\b/.test(line) && !/^CREATE TRIGGER qorpera_/.test(line))
				.join("\n");
			if (schemaSql.trim().length > 0) await client.query(schemaSql);
		}
		const restoredRows = {};
		for (const table of manifest.tables) {
			let inserted = 0;
			const rel = `${quoted(schema)}.${quoted(table.name)}`;
			const partDir = join(snapshotDir, "tables", table.name);
			const parts = table.parts ?? readdirSync(partDir).sort().map((f) => `tables/${table.name}/${f}`);
			const colTypes = new Map(
				(
					await client.query(
						`select a.attname as name, pg_catalog.format_type(a.atttypid, -1) as type, a.attgenerated <> '' as gen
						from pg_catalog.pg_attribute a
						join pg_catalog.pg_class c on c.oid = a.attrelid
						join pg_catalog.pg_namespace n on n.oid = c.relnamespace and n.nspname = $1
						where c.relname = $2 and a.attnum > 0 and not a.attisdropped`,
						[schema, table.name],
					)
				).rows.map((r) => [r.name, { type: r.type, gen: r.gen }]),
			);
			for (const relPath of parts) {
				const raw = readFileSync(join(snapshotDir, relPath), "utf8");
				const parsed = parseCsv(raw);
				if (parsed.length <= 1) continue;
				const header = parsed[0];
				const keepIndexes = [];
				const keepCols = [];
				for (let c = 0; c < header.length; c++) {
					const info = colTypes.get(header[c]);
					if (info && !info.gen) {
						keepIndexes.push(c);
						keepCols.push({ name: header[c], type: info.type });
					}
				}
				const batchSize = Math.max(1, Math.floor(10_000 / Math.max(1, keepCols.length)));
				for (let start = 1; start < parsed.length; start += batchSize) {
					const slice = parsed.slice(start, start + batchSize);
					const values = [];
					const tuples = [];
					for (const row of slice) {
						const placeholders = [];
						for (let k = 0; k < keepIndexes.length; k++) {
							const cell = row[keepIndexes[k]] ?? "";
							values.push(cell === "" ? null : cell);
							placeholders.push(`$${values.length}::${keepCols[k].type}`);
						}
						tuples.push(`(${placeholders.join(", ")})`);
					}
					await client.query(
						`insert into ${rel} (${keepCols.map((c) => quoted(c.name)).join(", ")}) overriding system value values ${tuples.join(", ")}`,
						values,
					);
					inserted += slice.length;
				}
			}
			restoredRows[table.name] = inserted;
		}
		const sequencesSql = readFileSync(join(snapshotDir, "sequences.sql"), "utf8");
		if (sequencesSql.trim().length > 0) await client.query(sequencesSql);

		const verified = {};
		for (const table of manifest.tables) {
			const fp = (
				await client.query(
					`select count(*)::text as n, coalesce(sum(pg_catalog.hashtextextended(t::text, 0)), 0)::text as h from ${quoted(schema)}.${quoted(table.name)} t`,
				)
			).rows[0];
			verified[table.name] = { rows: Number(fp.n), hash: fp.h, matched: Number(fp.n) === table.rows && fp.h === table.hash };
		}
		await client.query("commit");
		return { restoredRows, verified, allMatched: Object.values(verified).every((v) => v.matched) };
	} catch (error) {
		await client.query("rollback").catch(() => undefined);
		throw error;
	} finally {
		await client.end().catch(() => undefined);
	}
}
