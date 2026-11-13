// The data gateway (deploy/first-node/RUNTIME-COMPANY-DATABASES.md §3): the one service that connects to the company
// data store. A member's call is begun as the member: the gateway reads the folder entries it needs with the member's
// own token, which proves the member may read them and gives each file's hash. It uses a file's text only when its
// hash is the folder's. It holds no service key and no login to the platform's database.

import { createHash, createHmac, randomBytes } from "node:crypto";
import http from "node:http";
import pg from "pg";
import { readStatement, VIEWER } from "./sql-text.mjs";

export const DATABASE_NAME = /^[a-z][a-z0-9_]{0,39}$/;
export const FILE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const STEP_NAME = /^[0-9]{3}-[a-z0-9]+(-[a-z0-9]+)*$/;
const ENVIRONMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
/** A database folder's own login: the company's database, then o (owner), w (write) or r (read) and the folder's number. */
const FOLDER_LOGIN = /^c_[0-9a-f]{32}_([owr])[0-9]+$/;
/** Connections each login may hold: a folder's role holds as many as its CONNECTION LIMIT allows. */
const POOL_SIZE = { o: 1, w: 2, r: 3, qorpera_data_keeper: 2, qorpera_data_admin: 1, qorpera_data_watch: 1 };
/** Connections a company's database takes, all logins together. */
const COMPANY_CONNECTIONS = 24;

/** The password of a database folder's login: derived from the gateway's folder key and never stored. */
export function folderPassword(folderKey, role) {
	return createHmac("sha256", Buffer.from(folderKey, "hex")).update(role).digest("base64url");
}

export const LIMITS = Object.freeze({
	/** A question from an interface. */
	questionMs: 2_000,
	questionRows: 2_000,
	questionBytes: 256 * 1024,
	/** A named change. */
	changeMs: 5_000,
	/** A step: its own time, and its wait for a lock. */
	stepMs: 60_000,
	stepLockMs: 5_000,
	/** A file's text. */
	questionTextBytes: 16 * 1024,
	stepTextBytes: 64 * 1024,
	/** Steps a database folder holds, and questions one watch call holds. */
	steps: 500,
	watches: 24,
	/** A watch call: how long it is held, and how often its questions are asked again. */
	watchMs: 20_000,
	watchAgainMs: 500,
	/** How long a member's folder read is kept. */
	proofMs: 10_000,
	/** A request's body. */
	bodyBytes: 1024 * 1024,
	/** A company's database, all its rows: at this size its steps stop applying, and its questions still answer. */
	companyBytes: 1024 ** 3,
});

/** How long past its door's limit the watcher lets a statement run before it ends it. */
const OVERRUN_MS = 2_000;

class Refusal extends Error {
	constructor(status, message, extra = {}) {
		super(message);
		this.status = status;
		this.extra = extra;
	}
}
const refuse = (status, message, extra) => {
	throw new Refusal(status, message, extra);
};

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const amount = (bytes) =>
	bytes % 1024 ** 3 === 0 ? `${bytes / 1024 ** 3} GiB` : bytes % 1024 ** 2 === 0 ? `${bytes / 1024 ** 2} MiB` : `${bytes} bytes`;
const quoted = (name) => `"${name.replace(/"/g, '""')}"`;

/** A company's database in the store: `c_` and the 32 hex digits of its folder's id. */
export function companyDatabase(environmentId) {
	if (!ENVIRONMENT.test(environmentId)) refuse(404, "No such company");
	return `c_${environmentId.replace(/-/g, "")}`;
}

/** The platform, asked as the caller: a member's own folder reads through PostgREST. */
export class Platform {
	#url;
	#key;
	#fetch;
	constructor({ url, publishableKey, fetch = globalThis.fetch }) {
		this.#url = url.replace(/\/+$/, "");
		this.#key = publishableKey;
		this.#fetch = fetch;
	}
	async #rpc(token, name, args) {
		let response;
		try {
			response = await this.#fetch(`${this.#url}/rest/v1/rpc/${name}`, {
				method: "POST",
				headers: { apikey: this.#key, authorization: `Bearer ${token}`, "content-type": "application/json" },
				body: JSON.stringify(args),
				signal: AbortSignal.timeout(8_000),
			});
		} catch {
			refuse(503, "The company folder did not answer");
		}
		if (response.status === 401) refuse(401, "Sign in again");
		if (!response.ok) refuse(response.status === 403 || response.status === 404 ? 403 : 503, "The company folder refused the read");
		return response.json();
	}
	/** Each path's live file as the member may read it: `{ sha256, bytes }`, or null when it is not there for them. */
	async memberReads(token, environmentId, paths) {
		const answer = await this.#rpc(token, "qorpera_member_folder_read_many", { p_environment_id: environmentId, p_paths: paths });
		const reads = Array.isArray(answer?.reads) ? answer.reads : [];
		return paths.map((_, index) => {
			const entry = reads[index]?.found === true ? reads[index].entry : null;
			return entry && entry.kind === "file" && SHA.test(entry.fileSha256 ?? "") ? { sha256: entry.fileSha256, bytes: entry.bytes } : null;
		});
	}
	/** The files directly in a folder, as the member may list it. */
	async memberList(token, environmentId, parent, limit) {
		const answer = await this.#rpc(token, "qorpera_member_folder_list", {
			p_environment_id: environmentId,
			p_parent: parent,
			p_after: null,
			p_limit: limit,
		});
		return (Array.isArray(answer?.entries) ? answer.entries : [])
			.filter((entry) => entry.kind === "file" && SHA.test(entry.fileSha256 ?? ""))
			.map((entry) => ({ name: entry.path.slice(entry.path.lastIndexOf("/") + 1), sha256: entry.fileSha256, bytes: entry.bytes }));
	}
}

/** Every value arrives as PostgreSQL's text, and is given a JSON shape here. */
const TEXT_TYPES = { getTypeParser: () => (value) => value };
function shaped(value, type) {
	if (value === null) return null;
	switch (type) {
		case 16:
			return value === "t";
		case 21:
		case 23:
		case 700:
		case 701: {
			const number = Number(value);
			return Number.isFinite(number) ? number : value;
		}
		case 20: {
			const number = Number(value);
			return Number.isSafeInteger(number) ? number : value;
		}
		case 1700: {
			// A decimal a double holds exactly is a number; any other stays text, so no digit is lost.
			const number = Number(value);
			const plain = value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
			return Number.isFinite(number) && String(number) === plain ? number : value;
		}
		case 114:
		case 3802:
			try {
				return JSON.parse(value);
			} catch {
				return value;
			}
		case 1184:
			return value.replace(" ", "T").replace(/\+00(:00)?$/, "Z");
		case 1114:
			return value.replace(" ", "T");
		default:
			return value;
	}
}

/** What PostgreSQL said, in words for the file's writer. Never a connection detail. */
function storeProblem(error) {
	if (error instanceof Refusal) return error;
	switch (error?.code) {
		case "57014":
			return new Refusal(408, "The statement ran past its time limit");
		case "57P01":
			return new Refusal(408, "The statement ran far past its time limit and its connection was ended");
		case "25006":
			return new Refusal(400, "A question only reads: this one tried to write");
		case "53300":
			return new Refusal(429, "This company's database is at its connection limit: try again in a moment");
		case "53400":
			return new Refusal(400, "The statement used more temporary space than a company may");
		case "3D000":
			return new Refusal(404, "This company has no database yet");
		default:
			if (typeof error?.code === "string" && /^[0-9A-Z]{5}$/.test(error.code))
				return new Refusal(400, String(error.message), { code: error.code, ...(error.position ? { position: Number(error.position) } : {}) });
			return new Refusal(503, "The data store did not answer");
	}
}

export class Gateway {
	#store;
	#platform;
	#limits;
	#pools = new Map();
	#proofs = new Map();
	#texts = new Map();
	#folders = new Map();
	#listeners = new Map();
	/** Company databases the watcher last found at their size limit. */
	#full = new Set();
	#closed = false;
	/** Company databases this gateway has made complete: created, set, revoked and granted. */
	#provisioned = new Set();
	/** Statements the watcher has cancelled (`pid@query_start`): still running at its next look, their backend is ended. */
	#cancelled = [];
	/** For tests only: called at each stage of making a company's database. */
	#onProvision;
	/** For tests only: awaited before the gateway sends a cancel for a caller that went away. */
	#beforeCancel;
	/** Backends that were sent a cancel, by pid, with when: such a backend's connection is never used again, since a
	 * cancel that arrives late would stop whatever runs on it then. */
	#signalled = new Map();
	/** Where a watch call that ran out of time stopped, so the next one goes on from there: by member, company and the
	 * questions asked. Only a help: nothing breaks when it is lost. */
	#resume = new Map();
	/** What questions have taken from the store so far: rows, and the characters of their values. */
	taken = { rows: 0, bytes: 0 };

	/** `store`: { host, port, logins: { admin, keeper, watch, folderKey } }: the three logins' passwords, and the key
	 * each database folder's own logins' passwords are derived from (32 random bytes as hex). */
	constructor({ store, platform, limits = LIMITS, onProvision = () => undefined, beforeCancel = async () => undefined }) {
		this.#store = store;
		this.#platform = platform;
		this.#limits = limits;
		this.#onProvision = onProvision;
		this.#beforeCancel = beforeCancel;
	}

	/** Where a login's password comes from: the gateway's three logins have their own, a folder's login has a derived one. */
	#password(user) {
		if (FOLDER_LOGIN.test(user)) return folderPassword(this.#store.logins.folderKey, user);
		return this.#store.logins[user.slice("qorpera_data_".length)];
	}

	/** Connections as one login to one database. A question or a step runs on its database folder's own login, so the
	 * session is a member of nothing and can switch to no other role. Each folder's logins have their own connections,
	 * so a company with many folders can reach its database's connection limit with connections that only wait: then
	 * the idle ones of its other logins are given back and the call tries again. */
	#pool(database, user) {
		const key = `${user}@${database}`;
		let door = this.#pools.get(key);
		if (!door) {
			const kind = FOLDER_LOGIN.exec(user)?.[1];
			const pool = new pg.Pool({
				host: this.#store.host,
				port: this.#store.port,
				user,
				password: this.#password(user),
				database,
				max: POOL_SIZE[kind ?? user],
				// A step's login holds one connection, and steps are rare: it is given back soon.
				idleTimeoutMillis: kind === "o" ? 1_000 : 5_000,
				connectionTimeoutMillis: 5_000,
				application_name: `qorpera-data-gateway ${kind ?? user.slice("qorpera_data_".length)}`,
			});
			pool.on("error", () => undefined);
			const roomy = async (work) => {
				for (let attempt = 0; ; attempt++) {
					try {
						return await work();
					} catch (error) {
						if (error?.code !== "53300" || attempt === 3) throw error;
						await this.#makeRoom(database, key);
						await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
					}
				}
			};
			// A connection whose backend was sent a cancel is let go, never handed out.
			const connect = async () => {
				for (;;) {
					const client = await roomy(() => pool.connect());
					if (!this.#signalled.has(client.processID)) return client;
					this.#letGo(client);
				}
			};
			door = { pool, query: (...args) => roomy(() => pool.query(...args)), connect };
			this.#pools.set(key, door);
		}
		return door;
	}

	/** Marks a backend as sent a cancel. `sending`: the cancel on its way, if the gateway sends it. */
	#signal(pid, sending = Promise.resolve()) {
		const now = Date.now();
		if (this.#signalled.size > 1_000) for (const [old, mark] of this.#signalled) if (now - mark.at > 600_000) this.#signalled.delete(old);
		this.#signalled.set(pid, { at: now, sending });
	}

	/** Gives a connection back: one whose backend was sent a cancel, or that broke, is closed instead. */
	#release(client, broken) {
		if (broken || this.#signalled.has(client.processID)) this.#letGo(client, broken);
		else client.release();
	}

	/** Closes a connection; its pid is forgotten once a cancel on its way to it has arrived. */
	#letGo(client, broken) {
		const pid = client.processID;
		client.release(broken ?? true);
		const mark = this.#signalled.get(pid);
		if (mark) mark.sending.finally(() => this.#signalled.get(pid) === mark && this.#signalled.delete(pid));
	}

	/** Gives back every connection of a database that only waits, but the asking login's own. */
	async #makeRoom(database, asking) {
		const ending = [];
		for (const [key, { pool }] of this.#pools) {
			if (key === asking || !key.endsWith(`@${database}`) || pool.totalCount === 0 || pool.idleCount < pool.totalCount || pool.waitingCount > 0)
				continue;
			this.#pools.delete(key);
			ending.push(pool.end().catch(() => undefined));
		}
		await Promise.all(ending);
	}

	/** The files the member may read now, each `{ sha256, bytes }` or null; kept for a few seconds per member and path. */
	async #proven(caller, environmentId, paths) {
		const now = Date.now();
		const found = new Map();
		const ask = [];
		for (const path of paths) {
			const kept = this.#proofs.get(`${caller.key}|${environmentId}|${path}`);
			if (kept && now - kept.at < this.#limits.proofMs) found.set(path, kept.value);
			else ask.push(path);
		}
		for (let from = 0; from < ask.length; from += 64) {
			const part = ask.slice(from, from + 64);
			const values = await this.#platform.memberReads(caller.token, environmentId, part);
			part.forEach((path, index) => {
				found.set(path, values[index]);
				this.#proofs.set(`${caller.key}|${environmentId}|${path}`, { at: now, value: values[index] });
			});
		}
		if (this.#proofs.size > 20_000) for (const [key, kept] of this.#proofs) if (now - kept.at >= this.#limits.proofMs) this.#proofs.delete(key);
		return found;
	}

	/** A text by the hash the folder gave: from what the gateway holds, from the company's database, or from the caller. */
	async #text(database, hash, supplied, maximum) {
		const kept = this.#texts.get(hash);
		if (kept !== undefined) return kept;
		let text = null;
		const given = supplied?.[hash];
		if (typeof given === "string" && Buffer.byteLength(given) <= maximum && sha256(given) === hash) text = given;
		const pool = this.#pool(database, "qorpera_data_keeper");
		if (text === null) {
			const row = await pool.query("select text from qorpera_data.texts where sha256 = $1", [hash]).catch((error) => {
				throw storeProblem(error);
			});
			// A kept text is trusted only by its hash, read again here.
			if (row.rows[0] && sha256(row.rows[0].text) === hash) text = row.rows[0].text;
		} else {
			await pool
				.query("insert into qorpera_data.texts (sha256, text) values ($1, $2) on conflict (sha256) do nothing", [hash, text])
				.catch(() => undefined);
		}
		if (text !== null) {
			if (this.#texts.size >= 5_000) this.#texts.delete(this.#texts.keys().next().value);
			this.#texts.set(hash, text);
		}
		return text;
	}

	/** A database folder's number in the company's database (its roles carry it), or null when it was never applied. */
	async #folder(database, name) {
		const key = `${database}/${name}`;
		const kept = this.#folders.get(key);
		if (kept !== undefined) return kept;
		const row = await this.#pool(database, "qorpera_data_keeper")
			.query("select n from qorpera_data.databases where name = $1", [name])
			.catch((error) => {
				throw storeProblem(error);
			});
		if (!row.rows[0]) return null;
		this.#folders.set(key, row.rows[0].n);
		return row.rows[0].n;
	}

	/** One question, ready to ask: the caller may read its file, the gateway holds its text, its parameters are filled. */
	async #question(caller, environmentId, asked, texts, proofs = null) {
		if (!asked || typeof asked !== "object") refuse(400, "Name a question");
		const { database: name, question, params = {} } = asked;
		if (typeof name !== "string" || !DATABASE_NAME.test(name) || typeof question !== "string" || !FILE_NAME.test(question) || question.length > 60)
			refuse(400, "Name a question as <database>/<question>");
		if (!params || typeof params !== "object" || Array.isArray(params)) refuse(400, "Parameters are named values");
		const path = `data/${name}/queries/${question}.sql`;
		const proof = (proofs ?? (await this.#proven(caller, environmentId, [path]))).get(path);
		// The same answer for a question that is not there and one this member may not read.
		if (!proof) refuse(404, `No question ${name}/${question} that you may read`);
		if (proof.bytes > this.#limits.questionTextBytes) refuse(400, `The question's file is larger than ${this.#limits.questionTextBytes / 1024} KiB`);
		const database = companyDatabase(environmentId);
		const text = await this.#text(database, proof.sha256, texts, this.#limits.questionTextBytes);
		if (text === null) return { need: { path, sha256: proof.sha256 } };
		const statement = readStatement(text);
		if (!statement.ok) refuse(400, `${path}: ${statement.problem}`);
		const n = await this.#folder(database, name);
		if (n === null) refuse(409, `The database ${name} has no applied step yet`);
		const values = statement.parameters.map((parameter) => {
			if (parameter === VIEWER) return caller.userId;
			if (!Object.hasOwn(params, parameter)) refuse(400, `The question takes :${parameter}`);
			const value = params[parameter];
			if (value === null || typeof value === "string") return value;
			if (typeof value === "number" && Number.isFinite(value)) return String(value);
			if (typeof value === "boolean") return value ? "true" : "false";
			return refuse(400, `:${parameter} is text, a number, true, false or null`);
		});
		for (const given of Object.keys(params)) {
			if (given === VIEWER) refuse(400, ":viewer is filled by Qorpera");
			if (!statement.parameters.includes(given)) refuse(400, `The question takes no :${given}`);
		}
		return { database, name, n, sql: statement.sql, values };
	}

	/** Asks a ready question as the database folder's read role, in one read-only transaction. `ms`: the most it may
	 * take, at most a question's limit. `gone`: when it aborts, the statement is cancelled. */
	async #ask(ready, { ms = this.#limits.questionMs, gone = null } = {}) {
		const client = await this.#pool(ready.database, `${ready.database}_r${ready.n}`)
			.connect()
			.catch((error) => {
				throw storeProblem(error);
			});
		// A connection its backend left (the watcher ended it) is not given back to the pool.
		let lost;
		const cancel = () => {
			const pid = client.processID;
			const sending = this.#beforeCancel()
				.then(() => this.#pool("postgres", "qorpera_data_watch").query("select pg_catalog.pg_cancel_backend($1)", [pid]))
				.catch(() => undefined);
			this.#signal(pid, sending);
		};
		gone?.addEventListener("abort", cancel, { once: true });
		try {
			if (gone?.aborted) refuse(499, "The caller went away");
			const limit = Math.max(1, Math.floor(Math.min(this.#limits.questionMs, ms)));
			await client.query(
				`begin transaction read only; set local statement_timeout = ${limit}; set local timezone = 'UTC'; ` +
					`set local datestyle = 'ISO'; set local search_path = ${quoted(ready.name)}`,
			);
			// As a subquery, so only something that gives rows runs, and once: one statement whatever the answer. No more
			// rows than the answer may hold are made, and the store itself stops handing rows over once they pass the
			// answer's size: a question whose rows are huge cannot fill the gateway's memory. There is always one row at
			// least, carrying how many rows the question made: with no answer row in it (all its answer columns null)
			// when the question made none, or when its first row alone is past the answer's size.
			// A question's own columns may carry any name, so every name the gateway adds ends in a tag made for this
			// call, which no question can know, and the whole row is `row(alias.*)`, which no column can stand for. The
			// gateway's three added columns are taken off by their place, last.
			const tag = randomBytes(8).toString("hex");
			const [asked, inner, sized, madeAs, at, bytesSoFar, rowsMade] = ["asked", "inner", "sized", "made", "at", "bytes", "rows"].map(
				(name) => `qorpera_${name}_${tag}`,
			);
			const result = await client.query({
				text:
					`with ${asked} as (select * from (\n${ready.sql}\n) ${inner} limit ${this.#limits.questionRows + 1}), ` +
					`${sized} as (select ${asked}.*, row_number() over () as ${at}, ` +
					`sum(octet_length(row(${asked}.*)::text)) over (rows between unbounded preceding and current row) as ${bytesSoFar} ` +
					`from ${asked}) ` +
					`select ${sized}.*, ${madeAs}.${rowsMade} from (select count(*) as ${rowsMade} from ${asked}) ${madeAs} ` +
					`left join ${sized} on ${sized}.${bytesSoFar} <= ${this.#limits.questionBytes} order by ${sized}.${at}`,
				values: ready.values,
				rowMode: "array",
				queryMode: "extended",
				types: TEXT_TYPES,
			});
			const width = result.fields.length - 3;
			const fields = result.fields.slice(0, width);
			const made = Number(result.rows[0][width + 2]);
			// The row with no answer in it has no running size.
			const given = result.rows[0][width + 1] === null ? [] : result.rows;
			for (const row of given) for (let index = 0; index < width; index++) this.taken.bytes += row[index]?.length ?? 0;
			this.taken.rows += given.length;
			let more = made > this.#limits.questionRows || given.length < Math.min(made, this.#limits.questionRows);
			await client.query("rollback");
			const columns = fields.map((field) => field.name);
			const rows = [];
			let bytes = 0;
			for (const row of given.slice(0, this.#limits.questionRows)) {
				const shapedRow = row.slice(0, width).map((value, index) => shaped(value, fields[index].dataTypeID));
				bytes += Buffer.byteLength(JSON.stringify(shapedRow)) + 1;
				if (bytes > this.#limits.questionBytes) {
					more = true;
					break;
				}
				rows.push(shapedRow);
			}
			const answer = { columns, rows, more };
			return { ...answer, etag: sha256(JSON.stringify(answer)).slice(0, 32) };
		} catch (error) {
			if (!(error instanceof Refusal) && !/^(57P0[123]|08...)$/.test(error?.code ?? "") && error?.code) {
				await client.query("rollback").catch(() => undefined);
			} else if (!(error instanceof Refusal)) lost = error;
			throw storeProblem(error);
		} finally {
			gone?.removeEventListener("abort", cancel);
			this.#release(client, lost);
		}
	}

	async query(caller, environmentId, body) {
		const ready = await this.#question(caller, environmentId, body, body.texts);
		if (ready.need) return { need: [ready.need] };
		const answer = await this.#ask(ready);
		if (typeof body.etag === "string" && body.etag === answer.etag) return { same: true, etag: answer.etag };
		return { ...answer, asOf: new Date().toISOString() };
	}

	/** One connection that listens on a company's database, shared by every watch call on it, open only while one is. */
	#listen(database, heard) {
		let listener = this.#listeners.get(database);
		if (!listener) {
			const client = new pg.Client({
				host: this.#store.host,
				port: this.#store.port,
				user: "qorpera_data_keeper",
				password: this.#store.logins.keeper,
				database,
				connectionTimeoutMillis: 5_000,
				application_name: "qorpera-data-gateway listen",
			});
			listener = { client, heard: new Set(), ready: null, failed: false };
			client.on("notification", () => {
				for (const tell of [...listener.heard]) tell();
			});
			const lost = () => {
				listener.failed = true;
				if (this.#listeners.get(database) === listener) this.#listeners.delete(database);
				// A lost connection may have missed a notice: everyone asks again.
				for (const tell of [...listener.heard]) tell();
			};
			client.on("error", lost);
			client.on("end", lost);
			listener.ready = client.connect().then(() => client.query("listen qorpera_data"));
			listener.ready.catch(lost);
			this.#listeners.set(database, listener);
		}
		listener.heard.add(heard);
		return {
			ready: listener.ready,
			stop: () => {
				listener.heard.delete(heard);
				if (listener.heard.size === 0 && this.#listeners.get(database) === listener) {
					this.#listeners.delete(database);
					listener.client.end().catch(() => undefined);
				}
			},
		};
	}

	/** Held until a watched answer differs from the etag the page holds, or the wait ends. One deadline covers the
	 * whole call from when it arrives: reading the folder, asking the questions and waiting all fit inside `watchMs`.
	 * When it passes, the call answers with what it has and starts no other question; a question running then is
	 * bounded by the time left. Questions are asked a few at a time, and stop when the caller goes away. A call that
	 * could not ask every question says `partial: true`, and the next call for the same questions goes on from the
	 * first one it did not reach. Every way out of the call stops all of its work. */
	async watch(caller, environmentId, body, gone) {
		const deadline = Date.now() + this.#limits.watchMs;
		const watches = body.watches;
		if (!Array.isArray(watches) || watches.length === 0 || watches.length > this.#limits.watches)
			refuse(400, `A watch holds 1 to ${this.#limits.watches} questions`);
		const holdUntil = Math.min(deadline, Date.now() + (Number.isFinite(body.wait) && body.wait >= 0 ? body.wait * 1000 : this.#limits.watchMs));
		const stop = new AbortController();
		const stopped = () => stop.abort();
		gone.addEventListener("abort", stopped, { once: true });
		const timer = setTimeout(stopped, Math.max(0, deadline - Date.now()));
		let best = { changed: [] };
		const work = this.#watching(caller, environmentId, body, stop.signal, deadline, holdUntil, (found) => {
			best = found;
		});
		try {
			return await Promise.race([
				work,
				// The answer never waits past the deadline: what was found by then, and that not every question was asked.
				new Promise((resolve) =>
					stop.signal.addEventListener(
						"abort",
						() => setTimeout(() => resolve(best.changed.length > 0 ? { changed: best.changed, partial: true } : { same: true, partial: true }), 50),
						{ once: true },
					),
				),
			]);
		} finally {
			clearTimeout(timer);
			gone.removeEventListener("abort", stopped);
			stop.abort();
			work.catch(() => undefined);
		}
	}

	async #watching(caller, environmentId, body, stop, deadline, holdUntil, found) {
		const watches = body.watches;
		const paths = watches
			.filter((watched) => watched && typeof watched === "object" && typeof watched.database === "string" && typeof watched.question === "string")
			.map((watched) => `data/${watched.database}/queries/${watched.question}.sql`)
			.filter((path) => /^data\/[a-z][a-z0-9_]{0,39}\/queries\/[a-z0-9-]{1,60}\.sql$/.test(path));
		const proofs = await this.#proven(caller, environmentId, [...new Set(paths)]);
		const ready = [];
		const need = [];
		for (const watched of watches) {
			if (stop.aborted) return { same: true, partial: true };
			const one = await this.#question(caller, environmentId, watched, body.texts, proofs);
			if (one.need) need.push(one.need);
			ready.push(one);
		}
		if (need.length > 0) return { need };
		// Where the last call for these questions stopped, if it ran out of time.
		const place = sha256(JSON.stringify([caller.userId, environmentId, watches.map((watched) => [watched.database, watched.question, watched.params ?? {}])]));
		const now = Date.now();
		for (const [key, kept] of this.#resume) if (now - kept.at > 300_000) this.#resume.delete(key);
		let start = this.#resume.get(place)?.start ?? 0;
		if (start >= ready.length) start = 0;
		// A few at a time, as many as a folder's read login holds, from where the last call stopped; none started once
		// the deadline has passed or the call has ended.
		const differing = async () => {
			const order = ready.map((_, step) => (start + step) % ready.length);
			const asked = new Set();
			const changed = [];
			let next = 0;
			const worker = async () => {
				while (next < order.length && !stop.aborted) {
					const index = order[next++];
					const left = deadline - Date.now();
					if (left <= 0) return;
					try {
						const answer = await this.#ask(ready[index], { ms: left, gone: stop });
						asked.add(index);
						if (answer.etag !== watches[index].etag) {
							changed.push({ index, answer: { ...answer, asOf: new Date().toISOString() } });
							found({ changed: [...changed].sort((a, b) => a.index - b.index) });
						}
					} catch (error) {
						// A question cut short by the deadline or a call that ended is not an answer.
						if (stop.aborted || Date.now() >= deadline || (error.status === 408 && left < this.#limits.questionMs)) return;
						throw error;
					}
				}
			};
			await Promise.all(Array.from({ length: Math.min(POOL_SIZE.r, ready.length) }, worker));
			const missed = order.find((index) => !asked.has(index));
			if (missed === undefined) this.#resume.delete(place);
			else {
				if (this.#resume.size > 10_000) this.#resume.clear();
				this.#resume.set(place, { start: missed, at: Date.now() });
				start = missed;
			}
			return { changed: changed.sort((a, b) => a.index - b.index), partial: missed !== undefined };
		};
		const database = companyDatabase(environmentId);
		let wake = () => undefined;
		let dirty = false;
		const listening = this.#listen(database, () => {
			dirty = true;
			wake();
		});
		try {
			await listening.ready.catch((error) => {
				throw storeProblem(error);
			});
			// Asked after the listening began, so no change between the two is missed.
			let scan = await differing();
			while (scan.changed.length === 0 && !scan.partial && Date.now() < holdUntil && !stop.aborted && !this.#closed) {
				if (!dirty)
					await new Promise((resolve) => {
						const timer = setTimeout(resolve, holdUntil - Date.now());
						const done = () => {
							clearTimeout(timer);
							stop.removeEventListener("abort", done);
							resolve();
						};
						wake = done;
						stop.addEventListener("abort", done, { once: true });
					});
				wake = () => undefined;
				if (!dirty || stop.aborted) break;
				dirty = false;
				scan = await differing();
				// A database that changes all the time is asked at most twice a second for one page.
				if (scan.changed.length === 0 && !scan.partial) await new Promise((resolve) => setTimeout(resolve, this.#limits.watchAgainMs));
			}
			const partial = scan.partial ? { partial: true } : {};
			return scan.changed.length > 0 ? { changed: scan.changed, ...partial } : { same: true, ...partial };
		} finally {
			listening.stop();
		}
	}

	/** Makes the company's database as a copy of the template. Each stage is safe to run again, and all of them run
	 * until this gateway has seen the database complete: a database that exists may still lack its settings or its
	 * grants, when an earlier attempt failed between them. One gateway at a time makes a company's database. */
	async #ensureCompany(database) {
		if (this.#provisioned.has(database)) return;
		const admin = await this.#pool("postgres", "qorpera_data_admin").connect().catch((error) => {
			throw storeProblem(error);
		});
		try {
			await admin.query("select pg_advisory_lock(hashtext('qorpera_data.company'), hashtext($1))", [database]);
			try {
				const exists = await admin.query("select 1 from pg_database where datname = $1", [database]);
				if (exists.rowCount === 0) {
					try {
						await admin.query(`create database ${quoted(database)} template qorpera_company_template connection limit ${COMPANY_CONNECTIONS}`);
					} catch (error) {
						if (error.code !== "42P04") throw error;
					}
				}
				await this.#onProvision(database, "created");
				// What a statement may use, whichever folder's login runs it. A login cannot lift its temp file limit.
				await admin.query(
					`alter database ${quoted(database)} connection limit ${COMPANY_CONNECTIONS}; ` +
						`alter database ${quoted(database)} set temp_file_limit = '256MB'; alter database ${quoted(database)} set work_mem = '16MB'; ` +
						`alter database ${quoted(database)} set max_parallel_workers_per_gather = 0`,
				);
				await admin.query(`revoke all on database ${quoted(database)} from public`);
				await this.#onProvision(database, "revoked");
				await admin.query(`grant connect on database ${quoted(database)} to qorpera_data_keeper, qorpera_data_watch`);
				// Complete when the keeper connects and finds the template's schema.
				const ready = await this.#pool(database, "qorpera_data_keeper").query(
					"select 1 from pg_catalog.pg_namespace where nspname = 'qorpera_data'",
				);
				if (ready.rowCount !== 1) refuse(503, "The company's database is not ready");
				this.#provisioned.add(database);
			} finally {
				await admin.query("select pg_advisory_unlock(hashtext('qorpera_data.company'), hashtext($1))", [database]).catch(() => undefined);
			}
		} catch (error) {
			throw storeProblem(error);
		} finally {
			admin.release();
		}
	}

	/** Makes a database folder's schema and its three roles, once. */
	async #ensureFolder(database, name) {
		const known = await this.#folder(database, name).catch(() => null);
		if (known !== null) return known;
		const client = await this.#pool(database, "qorpera_data_admin").connect();
		try {
			await client.query("begin");
			await client.query("select pg_advisory_xact_lock(hashtext('qorpera_data.databases'))");
			await client.query("insert into qorpera_data.databases (name) values ($1) on conflict (name) do nothing", [name]);
			const n = (await client.query("select n from qorpera_data.databases where name = $1", [name])).rows[0].n;
			const [owner, write, read] = ["o", "w", "r"].map((kind) => quoted(`${database}_${kind}${n}`));
			// Each logs in on its own, with a password derived from the folder key, and is a member of nothing: no other
			// login is a member of it either, but the admin, which made it and hands it its schema.
			for (const [role, limit] of [[owner, POOL_SIZE.o], [write, POOL_SIZE.w], [read, POOL_SIZE.r]]) {
				const name = role.slice(1, -1);
				const has = await client.query("select 1 from pg_roles where rolname = $1", [name]);
				const options = `login noinherit connection limit ${limit} password '${this.#password(name)}'`;
				await client.query(has.rowCount === 0 ? `create role ${role} ${options}` : `alter role ${role} ${options}`);
			}
			await client.query(`grant connect on database ${quoted(database)} to ${owner}, ${write}, ${read}`);
			const schema = quoted(name);
			await client.query(`create schema if not exists ${schema} authorization ${owner}`);
			await client.query(`grant usage on schema ${schema} to ${write}, ${read}`);
			await client.query(
				`alter default privileges for role ${owner} in schema ${schema} grant select on tables to ${write}, ${read}; ` +
					`alter default privileges for role ${owner} in schema ${schema} grant insert, update, delete on tables to ${write}; ` +
					`alter default privileges for role ${owner} in schema ${schema} grant usage, select on sequences to ${write}`,
			);
			await client.query("commit");
			this.#folders.set(`${database}/${name}`, n);
			return n;
		} catch (error) {
			await client.query("rollback").catch(() => undefined);
			throw storeProblem(error);
		} finally {
			client.release();
		}
	}

	/** Applies a database folder's waiting steps, in order. Anyone who may read the steps may ask for it: a step that is
	 * live in the folder was put there by someone the folder let write it. */
	async apply(caller, environmentId, body) {
		const name = body.database;
		if (typeof name !== "string" || !DATABASE_NAME.test(name) || name === "qorpera" || /^(pg_|qorpera_)/.test(name))
			refuse(400, "A database's name is a letter, then up to 39 of a-z, 0-9 and _");
		const root = `data/${name}`;
		const proof = (await this.#proven(caller, environmentId, [`${root}/database.toml`])).get(`${root}/database.toml`);
		if (!proof) refuse(404, `No database ${name} that you may read: it needs ${root}/database.toml`);
		if (this.#full.has(companyDatabase(environmentId)))
			refuse(507, `This company's database is at its size limit of ${amount(this.#limits.companyBytes)}: delete rows or ask for more room`);
		const listed = await this.#platform.memberList(caller.token, environmentId, `${root}/tables`, this.#limits.steps + 1);
		if (listed.length > this.#limits.steps) refuse(400, `A database holds at most ${this.#limits.steps} steps`);
		const files = listed.filter((file) => file.name.endsWith(".sql"));
		for (const file of files) {
			if (!STEP_NAME.test(file.name.slice(0, -4))) refuse(400, `${root}/tables/${file.name}: a step is named NNN-name.sql`);
			if (file.bytes > this.#limits.stepTextBytes) refuse(400, `${root}/tables/${file.name} is larger than ${this.#limits.stepTextBytes / 1024} KiB`);
		}
		const steps = files.map((file) => ({ name: file.name.slice(0, -4), sha256: file.sha256 })).sort((a, b) => (a.name < b.name ? -1 : 1));
		const numbers = new Set();
		for (const step of steps) {
			if (numbers.has(step.name.slice(0, 3))) refuse(400, `Two steps carry the number ${step.name.slice(0, 3)}`);
			numbers.add(step.name.slice(0, 3));
		}
		const database = companyDatabase(environmentId);
		await this.#ensureCompany(database);
		await this.#ensureFolder(database, name);
		const n = await this.#folder(database, name);
		const keeper = this.#pool(database, "qorpera_data_keeper");
		const applied = new Map(
			(await keeper.query("select name, sha256 from qorpera_data.steps where database = $1", [name])).rows.map((row) => [row.name, row.sha256]),
		);
		const results = [];
		const live = new Map(steps.map((step) => [step.name, step.sha256]));
		// A step that was applied stays as it was applied.
		for (const [stepName, hash] of [...applied].sort()) {
			if (!live.has(stepName)) results.push({ name: stepName, state: "missing", detail: "It was applied and its file is gone: put the file back from the folder's history" });
			else if (live.get(stepName) !== hash)
				results.push({ name: stepName, state: "changed", detail: "It was changed after it was applied: put its applied text back from the folder's history and write a new step" });
		}
		if (results.length > 0) return { applied: false, results };
		const waiting = steps.filter((step) => !applied.has(step.name));
		const newest = [...applied.keys()].sort().at(-1);
		for (const step of waiting)
			if (newest !== undefined && step.name.slice(0, 3) <= newest.slice(0, 3))
				refuse(400, `Step ${step.name} is numbered at or below ${newest}, which is applied: give it a higher number`);
		const need = [];
		const texts = new Map();
		for (const step of waiting) {
			const text = await this.#text(database, step.sha256, body.texts, this.#limits.stepTextBytes);
			if (text === null) need.push({ path: `${root}/tables/${step.name}.sql`, sha256: step.sha256 });
			else texts.set(step.name, text);
		}
		if (need.length > 0) return { need };
		for (const step of steps) if (applied.has(step.name)) results.push({ name: step.name, state: "already" });
		for (const step of waiting) {
			const outcome = await this.#step(database, name, n, step, texts.get(step.name));
			results.push(outcome);
			if (outcome.state !== "applied") break;
		}
		return { applied: results.every((result) => result.state === "applied" || result.state === "already"), results };
	}

	/** One step in one transaction, as the database folder's owner role: kept only if it destroyed nothing. */
	async #step(database, name, n, step, text) {
		const client = await this.#pool(database, `${database}_o${n}`).connect();
		try {
			await client.query(
				`begin; set local lock_timeout = ${this.#limits.stepLockMs}; set local statement_timeout = ${this.#limits.stepMs}; ` +
					`set local search_path = ${quoted(name)}`,
			);
			try {
				await client.query({ text: "select qorpera_data.apply_step($1)", values: [text], queryMode: "extended" });
			} catch (error) {
				await client.query("rollback").catch(() => undefined);
				const told = storeProblem(error);
				return {
					name: step.name,
					state: "failed",
					detail: error.code === "2D000" || error.code === "0A000" ? `${told.message} (a step runs inside one transaction and cannot end it)` : told.message,
					...told.extra,
				};
			}
			// Deferred triggers and constraints would run at commit, after what the step destroyed was read: they run now,
			// and an error there fails the step as any other. One of them may defer more work again, so then the
			// transaction is sealed, one way, in the same call that reads what it destroyed: from there on anything that
			// destroys data, also at commit, aborts the transaction. Nothing else in PostgreSQL runs a company's code at
			// commit (a temporary table's ON COMMIT action needs TEMP, which no folder's login has).
			try {
				await client.query("set constraints all immediate");
			} catch (error) {
				await client.query("rollback").catch(() => undefined);
				return { name: step.name, state: "failed", detail: storeProblem(error).message, ...storeProblem(error).extra };
			}
			const effects = (await client.query("select kind, object, rows from qorpera_data.seal()")).rows;
			const unwatched = (await client.query("select table_name, problem from qorpera_data.unwatched($1)", [name])).rows;
			if (unwatched.length > 0) {
				await client.query("rollback");
				return {
					name: step.name,
					state: "failed",
					detail: `A step may not remove or switch off Qorpera's triggers: ${unwatched.map((row) => `${row.table_name} ${row.problem}`).join("; ")}`,
				};
			}
			if (effects.length > 0) {
				await client.query("rollback");
				return {
					name: step.name,
					state: "held",
					detail: "It would destroy data, which waits for a member",
					destroys: effects.map((effect) => ({ what: effect.kind, object: effect.object, ...(effect.rows === null ? {} : { rows: Number(effect.rows) }) })),
				};
			}
			await client.query("select qorpera_data.record_step($1, $2, $3)", [name, step.name, step.sha256]);
			try {
				await client.query("commit");
			} catch (error) {
				// The seal stopped something that destroys at commit (or commit failed otherwise): the step and its record
				// are rolled back, and the data is as it was.
				await client.query("rollback").catch(() => undefined);
				const told = storeProblem(error);
				return { name: step.name, state: "failed", detail: told.message, ...told.extra };
			}
			return { name: step.name, state: "applied" };
		} catch (error) {
			await client.query("rollback").catch(() => undefined);
			throw storeProblem(error);
		} finally {
			this.#release(client);
		}
	}

	/** A database folder as it stands in the store: its tables and columns, its applied steps, its size. */
	async describe(caller, environmentId, body) {
		const name = body.database;
		if (typeof name !== "string" || !DATABASE_NAME.test(name)) refuse(400, "Name a database");
		const path = `data/${name}/database.toml`;
		if (!(await this.#proven(caller, environmentId, [path])).get(path)) refuse(404, `No database ${name} that you may read`);
		const database = companyDatabase(environmentId);
		const n = await this.#folder(database, name);
		if (n === null) return { database: name, applied: [], tables: [] };
		const pool = this.#pool(database, "qorpera_data_keeper");
		const [steps, columns, size] = await Promise.all([
			pool.query("select name, applied_at from qorpera_data.steps where database = $1 order by name", [name]),
			pool.query(
				`select c.relname as table, a.attname as column, pg_catalog.format_type(a.atttypid, a.atttypmod) as type, c.reltuples::bigint as rows
				from pg_catalog.pg_class c join pg_catalog.pg_namespace s on s.oid = c.relnamespace and s.nspname = $1
				join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
				where c.relkind in ('r', 'p', 'v', 'm') order by c.relname, a.attnum`,
				[name],
			),
			pool.query("select pg_database_size(current_database()) as bytes"),
		]).catch((error) => {
			throw storeProblem(error);
		});
		const tables = new Map();
		for (const row of columns.rows) {
			if (!tables.has(row.table)) tables.set(row.table, { name: row.table, rows: Math.max(0, Number(row.rows)), columns: [] });
			tables.get(row.table).columns.push({ name: row.column, type: row.type });
		}
		return {
			database: name,
			applied: steps.rows.map((row) => ({ name: row.name, at: row.applied_at.toISOString() })),
			tables: [...tables.values()],
			companyBytes: Number(size.rows[0].bytes),
		};
	}

	/** The watcher (§3), one look with `qorpera_data_watch`. It cancels any statement of a database folder's login that
	 * has run longer than its door's limit and a margin: a limit a login could lift for itself is backed here. A
	 * statement still running at the next look (its code caught the cancel) has its backend ended. It reads every company database's size, and a company at its limit gets no more steps until it
	 * makes room; its questions still answer. */
	async watchOnce() {
		const watch = this.#pool("postgres", "qorpera_data_watch");
		try {
			const ended = await watch.query(
				`select a.pid, a.usename::text as login, a.datname::text as database, s.statement, s.statement = any($5::text[]) as terminated,
					case when s.statement = any($5::text[]) then pg_catalog.pg_terminate_backend(a.pid) else pg_catalog.pg_cancel_backend(a.pid) end as ended
				from pg_catalog.pg_stat_activity a
				cross join lateral (select a.pid::text || '@' || a.query_start::text as statement) s
				where a.datname ~ '^c_[0-9a-f]{32}$' and a.state = 'active' and a.usename ~ '^c_[0-9a-f]{32}_[owr][0-9]+$'
				and clock_timestamp() - a.query_start > make_interval(secs => (case substring(a.usename from '_([owr])[0-9]+$')
					when 'r' then $1::float8 when 'w' then $2::float8 when 'o' then $3::float8
				end + $4::float8) / 1000)`,
				[this.#limits.questionMs, this.#limits.changeMs, this.#limits.stepMs, OVERRUN_MS, this.#cancelled],
			);
			this.#cancelled = ended.rows.filter((row) => row.ended && !row.terminated).map((row) => row.statement);
			for (const row of ended.rows) if (row.ended) this.#signal(row.pid);
			const sizes = await watch.query(
				"select datname::text as database, pg_catalog.pg_database_size(oid) as bytes from pg_catalog.pg_database where datname ~ '^c_[0-9a-f]{32}$'",
			);
			this.#full = new Set(sizes.rows.filter((row) => Number(row.bytes) >= this.#limits.companyBytes).map((row) => row.database));
			return {
				ended: ended.rows
					.filter((row) => row.ended)
					.map((row) => ({ pid: row.pid, login: row.login, database: row.database, how: row.terminated ? "terminated" : "cancelled" })),
				full: [...this.#full],
			};
		} catch (error) {
			throw storeProblem(error);
		}
	}

	/** A member's request, begun as that member. */
	async handle(method, path, headers, read, gone) {
		const route = /^\/v1\/company-data\/([^/]+)\/(query|watch|apply|describe)$/.exec(path);
		if (!route) refuse(404, "Not a call the data gateway answers");
		if (method !== "POST") refuse(405, "Use POST");
		const token = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(headers.authorization ?? "")?.[1];
		if (!token) refuse(401, "Sign in");
		const environmentId = route[1];
		companyDatabase(environmentId);
		let userId = null;
		try {
			userId = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")).sub ?? null;
		} catch {
			refuse(401, "Sign in");
		}
		if (typeof userId !== "string" || !ENVIRONMENT.test(userId)) refuse(401, "Sign in");
		// The token's own words are used only after the platform took the token for a read: a forged one proves nothing.
		const caller = { token, userId, key: sha256(token) };
		let body;
		try {
			body = JSON.parse(await read(this.#limits.bodyBytes));
		} catch (error) {
			if (error instanceof Refusal) throw error;
			refuse(400, "The body is not JSON");
		}
		if (!body || typeof body !== "object" || Array.isArray(body)) refuse(400, "The body is not an object");
		if (body.texts !== undefined && (typeof body.texts !== "object" || body.texts === null || Array.isArray(body.texts)))
			refuse(400, "Texts are given by their hash");
		switch (route[2]) {
			case "query":
				return this.query(caller, environmentId, body);
			case "watch":
				return this.watch(caller, environmentId, body, gone);
			case "apply":
				return this.apply(caller, environmentId, body);
			default:
				return this.describe(caller, environmentId, body);
		}
	}

	async close() {
		this.#closed = true;
		for (const listener of this.#listeners.values()) {
			for (const tell of [...listener.heard]) tell();
			await listener.client.end().catch(() => undefined);
		}
		this.#listeners.clear();
		await Promise.all([...this.#pools.values()].map(({ pool }) => pool.end().catch(() => undefined)));
		this.#pools.clear();
	}
}

/** The watcher's timer: one look every `everyMs`, never two at once. Gives the function that stops it. */
export function startWatcher(gateway, { everyMs = 10_000, failed = () => undefined } = {}) {
	let looking = false;
	const timer = setInterval(async () => {
		if (looking) return;
		looking = true;
		try {
			await gateway.watchOnce();
		} catch (error) {
			failed(error);
		} finally {
			looking = false;
		}
	}, everyMs);
	timer.unref();
	return () => clearInterval(timer);
}

/** The gateway's HTTP side: JSON in, JSON out, loopback. */
export function serve(gateway, { host = "127.0.0.1", port = 0 } = {}) {
	const server = http.createServer(async (request, response) => {
		const gone = new AbortController();
		response.on("close", () => {
			if (!response.writableEnded) gone.abort();
		});
		const read = (maximum) =>
			new Promise((resolve, reject) => {
				const declared = Number(request.headers["content-length"]);
				if (!Number.isSafeInteger(declared) || declared < 0) return reject(new Refusal(411, "Say the body's length"));
				if (declared > maximum) return reject(new Refusal(413, "The body is too large"));
				const parts = [];
				let bytes = 0;
				request.on("data", (part) => {
					bytes += part.length;
					if (bytes > maximum) {
						reject(new Refusal(413, "The body is too large"));
						request.destroy();
					} else parts.push(part);
				});
				request.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
				request.on("error", () => reject(new Refusal(400, "The body did not arrive")));
			});
		let status = 200;
		let value;
		try {
			value = await gateway.handle(request.method, new URL(request.url, "http://gateway").pathname, request.headers, read, gone.signal);
		} catch (error) {
			const refusal = error instanceof Refusal ? error : new Refusal(500, "The data gateway failed");
			status = refusal.status;
			value = { error: refusal.message, ...refusal.extra };
		}
		if (gone.signal.aborted) return;
		const text = JSON.stringify(value);
		response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
		response.end(text);
	});
	return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}
