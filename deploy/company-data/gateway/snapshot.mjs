import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	cpSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import pg from "pg";
import { DATABASE_NAME } from "./gateway.mjs";

const PIECE_BYTES = 4 * 1024 * 1024;
const DEFAULT_PART_BYTES = 16 * 1024 * 1024;
const BLOCK_BYTES = 8192;
const DEFAULT_LOCK_WAIT_MS = 2_000;
const DEFAULT_MAX_TRIES = 8;
const CURSOR_BATCH = 2_000;
const CSV_READ_CHUNK = 256 * 1024;

const quoted = (name) => `"${String(name).replace(/"/g, '""')}"`;
const literal = (value) => `'${String(value).replace(/'/g, "''")}'`;
const TEXT_TYPES = { getTypeParser: () => (value) => value };

function safeTableDir(name) {
	if (/^[a-z0-9_]{1,63}$/.test(name)) return name;
	return `t_${createHash("sha256").update(name).digest("hex").slice(0, 24)}`;
}

function safeChildPath(baseDir, relPath) {
	if (typeof relPath !== "string" || relPath.length === 0 || relPath.includes("\0") || relPath.startsWith("/")) {
		throw new Error(`Invalid snapshot relative path: ${String(relPath)}`);
	}
	const root = resolve(baseDir);
	const target = resolve(root, relPath);
	if (!target.startsWith(`${root}${sep}`)) {
		throw new Error(`Snapshot path escapes directory: ${relPath}`);
	}
	return target;
}

function hashBytes(buffer) {
	const whole = createHash("sha256").update(buffer).digest("hex");
	const pieces = [];
	for (let offset = 0; offset < buffer.length; offset += PIECE_BYTES) {
		pieces.push(createHash("sha256").update(buffer.subarray(offset, offset + PIECE_BYTES)).digest("hex"));
	}
	return { bytes: buffer.length, sha256: whole, pieces };
}

function hashFileStreamed(filePath) {
	const whole = createHash("sha256");
	const pieces = [];
	let pieceHash = createHash("sha256");
	let pieceFill = 0;
	let total = 0;
	const fd = openSync(filePath, "r");
	const buf = Buffer.allocUnsafe(CSV_READ_CHUNK);
	try {
		for (;;) {
			const n = readSync(fd, buf, 0, buf.length, null);
			if (n <= 0) break;
			const slice = buf.subarray(0, n);
			whole.update(slice);
			total += n;
			let pos = 0;
			while (pos < n) {
				const take = Math.min(n - pos, PIECE_BYTES - pieceFill);
				pieceHash.update(slice.subarray(pos, pos + take));
				pieceFill += take;
				pos += take;
				if (pieceFill === PIECE_BYTES) {
					pieces.push(pieceHash.digest("hex"));
					pieceHash = createHash("sha256");
					pieceFill = 0;
				}
			}
		}
		if (pieceFill > 0) pieces.push(pieceHash.digest("hex"));
	} finally {
		closeSync(fd);
	}
	return { bytes: total, sha256: whole.digest("hex"), pieces };
}

function csvCell(value) {
	if (value === null || value === undefined) return "";
	const text = String(value);
	if (text === "") return '""';
	if (!/[",\r\n]/.test(text)) return text;
	return `"${text.replace(/"/g, '""')}"`;
}

async function forEachCsvRow(filePath, onRow) {
	const fd = openSync(filePath, "r");
	const buf = Buffer.allocUnsafe(CSV_READ_CHUNK);
	const decoder = new StringDecoder("utf8");
	let row = [];
	let field = "";
	let inQuotes = false;
	let fieldQuoted = false;
	let pendingQuote = false;
	let pendingCr = false;
	let rowIndex = 0;

	const emitRow = async () => {
		row.push(fieldQuoted ? field : field === "" ? null : field);
		const finished = row;
		row = [];
		field = "";
		fieldQuoted = false;
		await onRow(finished, rowIndex++);
	};

	const processText = async (text) => {
		for (let i = 0; i < text.length; i++) {
			const ch = text[i];
			if (pendingCr) {
				pendingCr = false;
				if (ch === "\n") continue;
			}
			if (pendingQuote) {
				pendingQuote = false;
				if (ch === '"') {
					field += '"';
					continue;
				}
				inQuotes = false;
			}
			if (inQuotes) {
				if (ch === '"') {
					pendingQuote = true;
				} else {
					field += ch;
				}
			} else if (ch === '"' && field.length === 0 && !fieldQuoted) {
				inQuotes = true;
				fieldQuoted = true;
			} else if (ch === ",") {
				row.push(fieldQuoted ? field : field === "" ? null : field);
				field = "";
				fieldQuoted = false;
			} else if (ch === "\r") {
				pendingCr = true;
				await emitRow();
			} else if (ch === "\n") {
				await emitRow();
			} else {
				field += ch;
			}
		}
	};

	try {
		for (;;) {
			const n = readSync(fd, buf, 0, buf.length, null);
			if (n <= 0) break;
			await processText(decoder.write(buf.subarray(0, n)));
		}
		const tail = decoder.end();
		if (tail.length > 0) await processText(tail);
		if (pendingQuote) {
			pendingQuote = false;
			inQuotes = false;
		}
		if (field.length > 0 || fieldQuoted || row.length > 0) {
			await emitRow();
		}
	} finally {
		closeSync(fd);
	}
}

function splitSqlStatements(sql) {
	const statements = [];
	let start = 0;
	let i = 0;
	let inSingle = false;
	let inDouble = false;
	let dollarTag = null;
	let inLineComment = false;
	let blockCommentDepth = 0;
	let lineStart = true;

	while (i < sql.length) {
		const ch = sql[i];
		const next = sql[i + 1] ?? "";
		if (inLineComment) {
			if (ch === "\n") {
				inLineComment = false;
				lineStart = true;
			}
			i++;
			continue;
		}
		if (blockCommentDepth > 0) {
			if (ch === "/" && next === "*") {
				blockCommentDepth++;
				i += 2;
				continue;
			}
			if (ch === "*" && next === "/") {
				blockCommentDepth--;
				i += 2;
				continue;
			}
			i++;
			continue;
		}
		if (dollarTag !== null) {
			if (sql.startsWith(dollarTag, i)) {
				i += dollarTag.length;
				dollarTag = null;
				continue;
			}
			i++;
			continue;
		}
		if (inSingle) {
			if (ch === "'" && next === "'") {
				i += 2;
				continue;
			}
			if (ch === "'") inSingle = false;
			i++;
			continue;
		}
		if (inDouble) {
			if (ch === '"' && next === '"') {
				i += 2;
				continue;
			}
			if (ch === '"') inDouble = false;
			i++;
			continue;
		}
		if (lineStart && ch === "\\") {
			const before = sql.slice(start, i).trim();
			if (before.length > 0) statements.push(before);
			const nl = sql.indexOf("\n", i);
			i = nl === -1 ? sql.length : nl + 1;
			start = i;
			lineStart = true;
			continue;
		}
		if (ch === "-" && next === "-") {
			inLineComment = true;
			i += 2;
			continue;
		}
		if (ch === "/" && next === "*") {
			blockCommentDepth = 1;
			i += 2;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			lineStart = false;
			i++;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			lineStart = false;
			i++;
			continue;
		}
		if (ch === "$") {
			const tagMatch = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
			if (tagMatch) {
				dollarTag = tagMatch[0];
				lineStart = false;
				i += dollarTag.length;
				continue;
			}
		}
		if (ch === ";") {
			const stmt = sql.slice(start, i + 1).trim();
			if (stmt.length > 0) statements.push(stmt);
			i++;
			start = i;
			lineStart = false;
			continue;
		}
		if (ch === "\n") {
			lineStart = true;
		} else if (ch !== " " && ch !== "\t" && ch !== "\r") {
			lineStart = false;
		}
		i++;
	}
	const tail = sql.slice(start).trim();
	if (tail.length > 0) statements.push(tail);
	return statements;
}

function stripLeadingSqlComments(stmt) {
	let s = stmt.trimStart();
	for (;;) {
		if (s.startsWith("--")) {
			const nl = s.indexOf("\n");
			s = nl === -1 ? "" : s.slice(nl + 1).trimStart();
		} else if (s.startsWith("/*")) {
			const end = s.indexOf("*/");
			s = end === -1 ? "" : s.slice(end + 2).trimStart();
		} else {
			return s;
		}
	}
}

function classifySchemaSql(rawSchema) {
	const preData = [];
	const postData = [];
	const materializedViews = [];
	for (const rawStmt of splitSqlStatements(rawSchema)) {
		const core = stripLeadingSqlComments(rawStmt);
		if (!core || core === ";") continue;
		if (/^CREATE\s+(?:CONSTRAINT\s+)?TRIGGER\s+"?qorpera_/i.test(core)) continue;
		if (/^CREATE\s+SCHEMA\s+(?!IF\s+NOT\s+EXISTS\b)/i.test(core)) {
			preData.push(core.replace(/^CREATE\s+SCHEMA\s+/i, "CREATE SCHEMA IF NOT EXISTS "));
			continue;
		}
		const matView = /^CREATE\s+MATERIALIZED\s+VIEW\s+((?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)(?:\.(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*))?)/i.exec(core);
		if (matView) {
			preData.push(core);
			materializedViews.push(matView[1]);
			continue;
		}
		const isPostData =
			/^ALTER\s+TABLE\s+(?:ONLY\s+)?[\s\S]+\bADD\s+CONSTRAINT\b[\s\S]+\bFOREIGN\s+KEY\b/i.test(core) ||
			/^CREATE\s+(?:CONSTRAINT\s+)?TRIGGER\b/i.test(core) ||
			/^CREATE\s+POLICY\b/i.test(core) ||
			/^ALTER\s+TABLE\s+(?:ONLY\s+)?[\s\S]+\b(?:ENABLE|FORCE)\s+ROW\s+LEVEL\s+SECURITY\b/i.test(core);
		if (isPostData) postData.push(core);
		else preData.push(core);
	}
	for (const mv of materializedViews) {
		postData.push(`REFRESH MATERIALIZED VIEW ${mv};`);
	}
	return { preData, postData };
}

function runPgDump({ host, port, user, password, database, schema, snapshotId, lockWaitMs }) {
	return new Promise((resolvePromise, reject) => {
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
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, Math.max(30_000, lockWaitMs * 5));
		timer.unref?.();
		child.stdout.on("data", (chunk) => {
			out += chunk;
		});
		child.stderr.on("data", (chunk) => {
			err += chunk;
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			error.nonRetryable = true;
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0 && !timedOut) resolvePromise(out);
			else {
				const message = timedOut ? "pg_dump timed out" : err.trim() || `pg_dump exited ${code}`;
				const error = new Error(message);
				if (!timedOut && /authentication failed|role .* does not exist|database .* does not exist/i.test(message)) {
					error.nonRetryable = true;
				}
				reject(error);
			}
		});
	});
}

async function listSchemaTables(client, schema) {
	const res = await client.query(
		`select c.oid::text as oid, c.relname as name,
			(select array_agg(a.attname::text order by k.n)
				from pg_catalog.pg_index i
				join lateral unnest(i.indkey::int2[]) with ordinality k(attnum, n) on true
				join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
				where i.indrelid = c.oid and i.indisprimary) as pk_cols,
			(select array_agg(pg_catalog.format_type(a.atttypid, a.atttypmod) order by k.n)
				from pg_catalog.pg_index i
				join lateral unnest(i.indkey::int2[]) with ordinality k(attnum, n) on true
				join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
				where i.indrelid = c.oid and i.indisprimary) as pk_types,
			pg_catalog.pg_table_size(c.oid) as heap_bytes
		from pg_catalog.pg_class c
		join pg_catalog.pg_namespace n on n.oid = c.relnamespace and n.nspname = $1
		where c.relkind = 'r' and c.relpersistence = 'p'
		order by c.relname`,
		[schema],
	);
	return res.rows.map((row) => ({
		oid: row.oid,
		name: row.name,
		pkCols: Array.isArray(row.pk_cols) ? row.pk_cols : null,
		pkTypes: Array.isArray(row.pk_types) ? row.pk_types : null,
		heapBytes: Number(row.heap_bytes ?? 0),
	}));
}

function tableSignature(tables) {
	return JSON.stringify(tables.map((t) => [t.oid, t.name, t.pkCols, t.pkTypes]));
}

async function computeTableCuts(client, schema, table, partBytes) {
	if (!table.pkCols || table.pkCols.length === 0) return [];
	if (table.heapBytes <= partBytes) return [];
	const rel = `${quoted(schema)}.${quoted(table.name)}`;
	const countRes = await client.query(`select count(*)::bigint as n from ${rel}`);
	const totalRows = Number(countRes.rows[0]?.n ?? 0);
	if (totalRows <= 0) return [];
	const rowsPerPart = Math.max(1_000, Math.round(partBytes / Math.max(1, table.heapBytes / totalRows)));
	if (totalRows <= rowsPerPart) return [];
	const keyExprs = table.pkCols.map(quoted);
	const orderBy = keyExprs.join(", ");
	if (table.pkCols.length === 1) {
		const keyCol = keyExprs[0];
		const cutRes = await client.query(
			`select ${keyCol}::text as k from (select ${keyCol}, row_number() over (order by ${keyCol}) as rn from ${rel}) s
			where rn % ${rowsPerPart} = 0 order by ${keyCol}`,
		);
		return cutRes.rows.map((r) => r.k);
	}
	const selectCols = keyExprs.map((col, idx) => `${col}::text as k${idx}`).join(", ");
	const innerCols = keyExprs.join(", ");
	const cutRes = await client.query(
		`select ${selectCols} from (select ${innerCols}, row_number() over (order by ${orderBy}) as rn from ${rel}) s
		where rn % ${rowsPerPart} = 0 order by ${orderBy}`,
	);
	return cutRes.rows.map((row) => table.pkCols.map((_, idx) => row[`k${idx}`]));
}

function tupleExpr(cols) {
	return `(${cols.map(quoted).join(", ")})`;
}

function tupleLiteral(values, types) {
	return `(${values.map((v, idx) => `${literal(v)}::${types[idx]}`).join(", ")})`;
}

function buildPartQueries(schema, table, cuts, partBytes) {
	const rel = `${quoted(schema)}.${quoted(table.name)}`;
	if (table.pkCols && table.pkCols.length === 1) {
		const keyCol = quoted(table.pkCols[0]);
		const keyType = table.pkTypes[0];
		const list = (cuts ?? []).filter((c) => typeof c === "string");
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
		const list = (cuts ?? []).filter((c) => Array.isArray(c) && c.length === table.pkCols.length && c.every((v) => typeof v === "string"));
		const lhs = tupleExpr(table.pkCols);
		return Array.from({ length: list.length + 1 }, (_, index) => {
			const low = index === 0 ? null : list[index - 1];
			const high = index === list.length ? null : list[index];
			const clauses = [];
			if (low !== null) clauses.push(`${lhs} > ${tupleLiteral(low, table.pkTypes)}`);
			if (high !== null) clauses.push(`${lhs} <= ${tupleLiteral(high, table.pkTypes)}`);
			return `select * from ${rel}${clauses.length ? ` where ${clauses.join(" and ")}` : ""} order by ${orderBy}`;
		});
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

async function writeQueryToCsvFile(client, sql, fullPath) {
	const cursorName = `qsnap_${randomBytes(6).toString("hex")}`;
	mkdirSync(dirname(fullPath), { recursive: true });
	const fd = openSync(fullPath, "w");
	const whole = createHash("sha256");
	const pieces = [];
	let pieceHash = createHash("sha256");
	let pieceFill = 0;
	let totalBytes = 0;

	const writeChunk = (text) => {
		const buf = Buffer.from(text, "utf8");
		writeSync(fd, buf, 0, buf.length);
		whole.update(buf);
		totalBytes += buf.length;
		let pos = 0;
		while (pos < buf.length) {
			const take = Math.min(buf.length - pos, PIECE_BYTES - pieceFill);
			pieceHash.update(buf.subarray(pos, pos + take));
			pieceFill += take;
			pos += take;
			if (pieceFill === PIECE_BYTES) {
				pieces.push(pieceHash.digest("hex"));
				pieceHash = createHash("sha256");
				pieceFill = 0;
			}
		}
	};

	await client.query(`declare ${cursorName} no scroll cursor for ${sql}`);
	try {
		let headerWritten = false;
		for (;;) {
			const batch = await client.query({ text: `fetch ${CURSOR_BATCH} from ${cursorName}`, rowMode: "array", types: TEXT_TYPES });
			const lines = [];
			if (!headerWritten) {
				lines.push(batch.fields.map((field) => csvCell(field.name)).join(","));
				headerWritten = true;
			}
			for (const row of batch.rows) {
				lines.push(row.map(csvCell).join(","));
			}
			if (lines.length > 0) writeChunk(`${lines.join("\n")}\n`);
			if (batch.rows.length < CURSOR_BATCH) break;
		}
		if (pieceFill > 0) pieces.push(pieceHash.digest("hex"));
		return { bytes: totalBytes, sha256: whole.digest("hex"), pieces };
	} finally {
		closeSync(fd);
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
	const resolvedOut = resolve(outDir);
	const stageDir = `${resolvedOut}.stage-${randomBytes(6).toString("hex")}`;
	try {
		for (;;) {
			tries++;
			if (tries > maxTries) {
				throw new Error(`Snapshot could not lock ${schema} in ${maxTries} tries: ${restarts.join("; ")}`);
			}
			tables = await listSchemaTables(client, schema);
			await client.query("begin isolation level repeatable read, read only");
			await client.query(
				`set local timezone = 'UTC'; set local datestyle = 'ISO'; set local intervalstyle = 'postgres'; ` +
					`set local lc_monetary = 'C'; set local bytea_output = 'hex'; set local lock_timeout = '${lockWaitMs}ms'`,
			);
			if (tables.length > 0) {
				try {
					const lockList = tables.map((t) => `${quoted(schema)}.${quoted(t.name)}`).join(", ");
					await client.query(`lock table ${lockList} in access share mode`);
				} catch (error) {
					await client.query("rollback");
					restarts.push(`table lock failed: ${error.message}`);
					continue;
				}
			}
			const snapRes = await client.query("select pg_catalog.pg_export_snapshot() as id");
			const snapshotId = snapRes.rows[0].id;
			const recheck = await listSchemaTables(client, schema);
			if (tableSignature(recheck) !== tableSignature(tables)) {
				await client.query("rollback");
				restarts.push("tables changed between discovery and lock");
				continue;
			}
			tables = recheck;
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
				if (error?.nonRetryable) throw error;
				restarts.push(`schema dump lock wait: ${error.message}`);
			}
		}

		mkdirSync(stageDir, { recursive: true });
		const files = {};
		const writeTracked = (relPath, content) => {
			const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
			const full = safeChildPath(stageDir, relPath);
			mkdirSync(dirname(full), { recursive: true });
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
			await client.query("savepoint sp_seq");
			try {
				const state = (await client.query(`select last_value::text as v, is_called from ${fq}`)).rows[0];
				await client.query("release savepoint sp_seq");
				if (state?.v !== null && state?.v !== undefined) {
					seqLines.push(`select pg_catalog.setval(${literal(fq)}, ${state.v}, ${state.is_called ? "true" : "false"});`);
				}
			} catch (error) {
				await client.query("rollback to savepoint sp_seq");
				if (error?.code !== "42P01") throw error;
			}
		}
		writeTracked("sequences.sql", `${seqLines.join("\n")}${seqLines.length ? "\n" : ""}`);

		const nextCuts = { ...cuts };
		const fingerprints = {};
		const tableParts = {};
		for (const table of tables) {
			const existingCuts = nextCuts[table.name];
			if (!Array.isArray(existingCuts) || (existingCuts.length === 0 && table.heapBytes > partBytes)) {
				nextCuts[table.name] = await computeTableCuts(client, schema, table, partBytes);
			}
			const dirSlug = safeTableDir(table.name);
			const exportParts = async (cutsForTable) => {
				const queries = buildPartQueries(schema, table, cutsForTable, partBytes);
				const relPaths = [];
				const metas = [];
				for (let index = 0; index < queries.length; index++) {
					const relPath = `tables/${dirSlug}/${String(index + 1).padStart(4, "0")}.csv`;
					const fullPath = safeChildPath(stageDir, relPath);
					await client.query("savepoint sp_part");
					try {
						const meta = await writeQueryToCsvFile(client, queries[index], fullPath);
						await client.query("release savepoint sp_part");
						relPaths.push(relPath);
						metas.push([relPath, meta]);
					} catch (error) {
						await client.query("rollback to savepoint sp_part");
						rmSync(fullPath, { force: true });
						throw error;
					}
				}
				return { relPaths, metas };
			};

			let exported;
			try {
				exported = await exportParts(nextCuts[table.name]);
			} catch (error) {
				if (Array.isArray(existingCuts) && existingCuts.length > 0 && /^(22P02|42883|42601)$/.test(error?.code ?? "")) {
					rmSync(safeChildPath(stageDir, `tables/${dirSlug}`), { recursive: true, force: true });
					nextCuts[table.name] = await computeTableCuts(client, schema, table, partBytes);
					exported = await exportParts(nextCuts[table.name]);
				} else {
					throw error;
				}
			}
			tableParts[table.name] = exported.relPaths;
			for (const [relPath, meta] of exported.metas) files[relPath] = meta;

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
		writeFileSync(join(stageDir, "snapshot.json"), manifestJson, "utf8");

		mkdirSync(dirname(resolvedOut), { recursive: true });
		rmSync(resolvedOut, { recursive: true, force: true });
		try {
			renameSync(stageDir, resolvedOut);
		} catch {
			cpSync(stageDir, resolvedOut, { recursive: true });
			rmSync(stageDir, { recursive: true, force: true });
		}
		return {
			manifest,
			ms: Date.now() - startedAt,
			restarts,
			totalBytes: Object.values(files).reduce((sum, f) => sum + f.bytes, 0),
		};
	} catch (error) {
		rmSync(stageDir, { recursive: true, force: true });
		throw error;
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
	verifyHashes = true,
}) {
	if (!DATABASE_NAME.test(schema)) throw new Error(`Invalid database schema name: ${schema}`);
	const manifest = JSON.parse(readFileSync(safeChildPath(snapshotDir, "snapshot.json"), "utf8"));
	if (!manifest || manifest.format !== "qorpera.database-snapshot/v1" || !Array.isArray(manifest.tables)) {
		throw new Error("Invalid snapshot manifest");
	}
	if (verifyHashes && manifest.files && typeof manifest.files === "object") {
		for (const [relPath, expected] of Object.entries(manifest.files)) {
			const full = safeChildPath(snapshotDir, relPath);
			const actual = hashFileStreamed(full);
			if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
				throw new Error(`Snapshot integrity check failed for ${relPath}`);
			}
		}
	}

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
		await client.query(
			"set local timezone = 'UTC'; set local datestyle = 'ISO'; set local intervalstyle = 'postgres'; " +
				"set local lc_monetary = 'C'; set local bytea_output = 'hex'",
		);
		let postData = [];
		if (applySchema) {
			const rawSchema = readFileSync(safeChildPath(snapshotDir, "schema.sql"), "utf8");
			const split = classifySchemaSql(rawSchema);
			postData = split.postData;
			for (const stmt of split.preData) {
				await client.query(stmt);
			}
		}

		let replicaMode = false;
		await client.query("savepoint sp_rep");
		try {
			await client.query("set local session_replication_role = 'replica'");
			await client.query("release savepoint sp_rep");
			replicaMode = true;
		} catch {
			await client.query("rollback to savepoint sp_rep");
		}

		const restoredRows = {};
		for (const table of manifest.tables) {
			let inserted = 0;
			const rel = `${quoted(schema)}.${quoted(table.name)}`;
			const parts = Array.isArray(table.parts)
				? table.parts
				: readdirSync(safeChildPath(snapshotDir, `tables/${safeTableDir(table.name)}`))
						.sort()
						.map((f) => `tables/${safeTableDir(table.name)}/${f}`);
			const colTypes = new Map(
				(
					await client.query(
						`select a.attname as name, pg_catalog.format_type(a.atttypid, a.atttypmod) as type, a.attgenerated <> '' as gen
						from pg_catalog.pg_attribute a
						join pg_catalog.pg_class c on c.oid = a.attrelid
						join pg_catalog.pg_namespace n on n.oid = c.relnamespace and n.nspname = $1
						where c.relname = $2 and a.attnum > 0 and not a.attisdropped`,
						[schema, table.name],
					)
				).rows.map((r) => [r.name, { type: r.type, gen: r.gen }]),
			);
			for (const relPath of parts) {
				const fullPath = safeChildPath(snapshotDir, relPath);
				let keepIndexes = null;
				let keepCols = null;
				let pendingRows = [];
				let maxBatch = 2_000;

				const flushBatch = async () => {
					if (pendingRows.length === 0) return;
					const slice = pendingRows;
					pendingRows = [];
					if (keepCols.length === 0) {
						for (let i = 0; i < slice.length; i++) {
							await client.query(`insert into ${rel} default values`);
						}
						inserted += slice.length;
						return;
					}
					const values = [];
					const tuples = [];
					for (const row of slice) {
						const placeholders = [];
						for (let k = 0; k < keepIndexes.length; k++) {
							const cell = row[keepIndexes[k]] ?? null;
							values.push(cell);
							placeholders.push(`$${values.length}::${keepCols[k].type}`);
						}
						tuples.push(`(${placeholders.join(", ")})`);
					}
					await client.query(
						`insert into ${rel} (${keepCols.map((c) => quoted(c.name)).join(", ")}) overriding system value values ${tuples.join(", ")}`,
						values,
					);
					inserted += slice.length;
				};

				await forEachCsvRow(fullPath, async (row, rowIndex) => {
					if (rowIndex === 0) {
						keepIndexes = [];
						keepCols = [];
						for (let c = 0; c < row.length; c++) {
							const colName = row[c] ?? "";
							const info = colTypes.get(colName);
							if (info && !info.gen) {
								keepIndexes.push(c);
								keepCols.push({ name: colName, type: info.type });
							}
						}
						maxBatch = Math.max(1, Math.min(2_000, Math.floor(60_000 / Math.max(1, keepCols.length))));
						return;
					}
					pendingRows.push(row);
					if (pendingRows.length >= maxBatch) await flushBatch();
				});
				await flushBatch();
			}
			restoredRows[table.name] = inserted;
		}

		if (replicaMode) {
			await client.query("set local session_replication_role = 'origin'");
		}

		const sequencesSql = readFileSync(safeChildPath(snapshotDir, "sequences.sql"), "utf8");
		if (sequencesSql.trim().length > 0) await client.query(sequencesSql);

		for (const stmt of postData) {
			await client.query(stmt);
		}

		const verified = {};
		for (const table of manifest.tables) {
			const fp = (
				await client.query(
					`select count(*)::text as n, coalesce(sum(pg_catalog.hashtextextended(t::text, 0)), 0)::text as h from ${quoted(schema)}.${quoted(table.name)} t`,
				)
			).rows[0];
			verified[table.name] = { rows: Number(fp.n), hash: fp.h, matched: Number(fp.n) === table.rows && fp.h === table.hash };
		}
		const allMatched = Object.values(verified).every((v) => v.matched);
		if (!allMatched) {
			throw new Error(`Snapshot restore verification mismatch: ${JSON.stringify(verified)}`);
		}
		await client.query("commit");
		return { restoredRows, verified, allMatched };
	} catch (error) {
		await client.query("rollback").catch(() => undefined);
		throw error;
	} finally {
		await client.end().catch(() => undefined);
	}
}
