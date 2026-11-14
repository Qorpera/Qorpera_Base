// The data gateway (deploy/first-node/RUNTIME-COMPANY-DATABASES.md §3): the one service that connects to the company
// data store. A member's call is begun as the member: the gateway reads the folder entries it needs with the member's
// own token, which proves the member may read them and gives each file's hash. An agent's run is begun from a data
// pass (SLICE5): the platform kept, as the run, each file the run may read under the database's folder, and the gateway
// redeems the pass once for that list. It uses a file's text only when its hash is the folder's. It holds no service key
// and no login to the platform's database.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import https from "node:https";
import pg from "pg";
import { leadingWords, readStatement, VIEWER } from "./sql-text.mjs";

export const DATABASE_NAME = /^[a-z][a-z0-9_]{0,39}$/;
export const FILE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const STEP_NAME = /^[0-9]{3}-[a-z0-9]+(-[a-z0-9]+)*$/;
const ENVIRONMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
/** A data pass: 32 random bytes, base64url without padding. */
const PASS = /^[A-Za-z0-9_-]{43}$/;
/** A file a data pass keeps: a database's database.toml, or a file directly in its tables/, queries/ or actions/. */
const KEPT_PATH = /^data\/[a-z][a-z0-9_]{0,39}\/(database\.toml|(tables|queries|actions)\/[^/]{1,255})$/;
const TOML_PATH = /^data\/([a-z][a-z0-9_]{0,39})\/database\.toml$/;
/** A database folder's own login: the company's database, then o (owner), w (write) or r (read) and the folder's number. */
const FOLDER_LOGIN = /^c_[0-9a-f]{32}_([owr])[0-9]+$/;
/** Connections each login may hold: a folder's role holds as many as its CONNECTION LIMIT allows. */
const POOL_SIZE = { o: 1, w: 2, r: 3, qorpera_data_keeper: 2, qorpera_data_admin: 1, qorpera_data_watch: 1 };
/** Connections a company's database takes, all logins together. */
const COMPANY_CONNECTIONS = 24;

/** What a company's database sets so that no session in it writes the company's values into the server's log:
 * errors, the statements behind them and their context carry them. The caller hears its errors through the gateway,
 * and the watcher sees slow statements. Each is a superuser's setting, which a company's login cannot lift.
 * - log_min_messages panic: no ERROR, LOG or FATAL line of the session (a watcher's termination is FATAL, and its
 *   CONTEXT quotes the statement that ran). Also silences what debug_print_* and the *_stats settings would log.
 * - log_error_verbosity terse: should a line ever be logged, it carries no DETAIL, HINT, QUERY or CONTEXT.
 * - log_min_error_statement panic, log_statement none, log_min_duration_statement -1, log_min_duration_sample -1,
 *   log_transaction_sample_rate 0: no statement text.
 * - log_lock_waits off: a lock wait's lines name the statements' processes and context.
 * - log_temp_files -1: a temporary file's line is followed by its statement.
 * Not set here, and why they carry no value: log_connections and log_disconnections (role and database names, which
 * say nothing of whose they are), log_autovacuum_min_duration (autovacuum's own sessions: table names only),
 * deadlock_timeout (a timer; the lines it leads to are a session's own, silenced above), auto_explain (never loaded:
 * a company's login cannot LOAD it, and the store's server does not preload it), and a PANIC (the server's own words
 * about itself, not a statement's). */
const LOG_SETTINGS = [
	["log_min_messages", "panic"],
	["log_error_verbosity", "terse"],
	["log_min_error_statement", "panic"],
	["log_statement", "none"],
	["log_min_duration_statement", "-1"],
	["log_min_duration_sample", "-1"],
	["log_transaction_sample_rate", "0"],
	["log_lock_waits", "off"],
	["log_temp_files", "-1"],
];

/** The password of a database folder's login: derived from the gateway's folder key and never stored. */
export function folderPassword(folderKey, role) {
	return createHmac("sha256", Buffer.from(folderKey, "hex")).update(role).digest("base64url");
}

export const LIMITS = Object.freeze({
	/** A question from an interface. */
	questionMs: 2_000,
	questionRows: 2_000,
	questionBytes: 256 * 1024,
	/** An agent's question or read of its own (data_query): its time, and the rows and bytes of one answer. */
	agentMs: 15_000,
	agentRows: 200,
	agentBytes: 24 * 1024,
	/** A named change. */
	changeMs: 5_000,
	/** A step: its own time, and its wait for a lock. */
	stepMs: 60_000,
	stepLockMs: 5_000,
	/** An apply call starts no step once this has passed since it began: it answers `more: true` with the steps still
	 * waiting, so a call lasts at most this and one step's time. */
	applyMs: 45_000,
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
	/** Counting the rows of the tables one describe call shows: all its counts together. */
	countMs: 1_500,
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
	/** What a run's data pass kept (`qorpera_data_pass_redeem`, with the publishable key alone), once: `{ environmentId,
	 * runId, requesterUserId, database, files: Map<path, { sha256, bytes }> }`, or null for a pass that answers nothing. */
	async redeemPass(pass) {
		const headers = { apikey: this.#key, "content-type": "application/json" };
		// A legacy anon key is a JWT and goes as the bearer too; a publishable key goes alone.
		if (this.#key.startsWith("eyJ") && this.#key.split(".").length === 3) headers.authorization = `Bearer ${this.#key}`;
		let response;
		try {
			response = await this.#fetch(`${this.#url}/rest/v1/rpc/qorpera_data_pass_redeem`, {
				method: "POST",
				headers,
				body: JSON.stringify({ p_pass: pass }),
				signal: AbortSignal.timeout(8_000),
			});
		} catch {
			refuse(503, "The platform did not answer");
		}
		if (!response.ok) refuse(503, "The platform refused the pass");
		const answer = await response.json().catch(() => refuse(503, "The platform's answer is not a pass"));
		if (answer === null) return null;
		const files = Array.isArray(answer?.files) ? answer.files : null;
		if (
			answer?.schema !== "qorpera.data-pass-redeemed/v1" ||
			answer.kind !== "run" ||
			!ENVIRONMENT.test(answer.environmentId ?? "") ||
			!ENVIRONMENT.test(answer.runId ?? "") ||
			!ENVIRONMENT.test(answer.requesterUserId ?? "") ||
			(answer.database !== null && !DATABASE_NAME.test(answer.database ?? "")) ||
			!files ||
			files.length > 1000 ||
			!files.every(
				(file) => KEPT_PATH.test(file?.path ?? "") && SHA.test(file.sha256 ?? "") && Number.isSafeInteger(file.bytes) && file.bytes >= 0,
			)
		)
			refuse(503, "The platform's answer is not a pass");
		return {
			environmentId: answer.environmentId,
			runId: answer.runId,
			requesterUserId: answer.requesterUserId,
			database: answer.database,
			files: new Map(files.map((file) => [file.path, { sha256: file.sha256, bytes: file.bytes }])),
		};
	}
}

/** Whether a request's bearer is the token, compared in constant time. */
function bearerIs(header, token) {
	return (
		typeof header === "string" &&
		header.startsWith("Bearer ") &&
		timingSafeEqual(createHash("sha256").update(header.slice(7)).digest(), createHash("sha256").update(token).digest())
	);
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

/** `connecting`'s connection when it comes before `until`. Else a refusal, and the connection is given back, unused,
 * when it does come. */
function inTime(connecting, until) {
	return new Promise((resolve, reject) => {
		let late = false;
		const timer = setTimeout(
			() => {
				late = true;
				reject(new Refusal(408, "No connection to the data store was free in time"));
			},
			Math.max(0, until - Date.now()),
		);
		connecting.then(
			(client) => {
				clearTimeout(timer);
				if (late) client.release();
				else resolve(client);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
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
	/** The node's private token the run door takes ("a host of ours"); without it the run door answers nothing. */
	#runToken;
	/** Backends running an agent's read now, by pid, with how many: the watcher gives them an agent's limit. */
	#agentReads = new Map();
	/** Company databases this gateway has seen exist. */
	#exists = new Set();
	/** What questions have taken from the store so far: rows, and the characters of their values. */
	taken = { rows: 0, bytes: 0 };

	/** `store`: { host, port, logins: { admin, keeper, watch, folderKey } }: the three logins' passwords, and the key
	 * each database folder's own logins' passwords are derived from (32 random bytes as hex). `runs`: { token }, the
	 * node's private token an agent's tool brings to the run door. */
	constructor({ store, platform, limits = LIMITS, runs = null, onProvision = () => undefined, beforeCancel = async () => undefined }) {
		this.#store = store;
		this.#platform = platform;
		this.#limits = limits;
		this.#runToken = typeof runs?.token === "string" && runs.token.length >= 32 ? runs.token : null;
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

	/** The files the caller may read now, each `{ sha256, bytes }` or null: a member's kept for a few seconds per member
	 * and path, a run's from its redeemed pass. */
	async #proven(caller, environmentId, paths) {
		if (caller.files) return new Map(paths.map((path) => [path, caller.files.get(path) ?? null]));
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

	/** A text by the hash the folder gave: from what the gateway holds, from the company's database, or from the caller.
	 * `database` null: the company has no database yet, so only what the gateway holds and what the caller gives. */
	async #text(database, hash, supplied, maximum) {
		const kept = this.#texts.get(hash);
		if (kept !== undefined) return kept;
		let text = null;
		const given = supplied?.[hash];
		if (typeof given === "string" && Buffer.byteLength(given) <= maximum && sha256(given) === hash) text = given;
		if (database !== null) {
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
		}
		// Kept in memory also before the company has a database, so a describe whose texts come in several rounds ends.
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

	/** The files directly in a folder that the caller may list: a member's from the platform, a run's from its pass. */
	async #listed(caller, environmentId, parent, limit) {
		if (!caller.files) return this.#platform.memberList(caller.token, environmentId, parent, limit);
		const prefix = `${parent}/`;
		return [...caller.files]
			.filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
			.sort(([a], [b]) => (a < b ? -1 : 1))
			.slice(0, limit)
			.map(([path, file]) => ({ name: path.slice(prefix.length), sha256: file.sha256, bytes: file.bytes }));
	}

	/** A statement's values in its parameters' order. `:viewer` is the member looking; a run, which may read everything in
	 * the database anyway, may name the member it asks for, else it is the member who asked the run. */
	#values(caller, statement, params) {
		if (!params || typeof params !== "object" || Array.isArray(params)) refuse(400, "Parameters are named values");
		let viewer = caller.userId;
		if (Object.hasOwn(params, VIEWER)) {
			if (!caller.run) refuse(400, ":viewer is filled by Qorpera");
			viewer = params[VIEWER];
			if (typeof viewer !== "string" || !ENVIRONMENT.test(viewer)) refuse(400, ":viewer is a member's id");
		}
		const values = statement.parameters.map((parameter) => {
			if (parameter === VIEWER) return viewer;
			if (!Object.hasOwn(params, parameter)) refuse(400, `The question takes :${parameter}`);
			const value = params[parameter];
			if (value === null || typeof value === "string") return value;
			if (typeof value === "number" && Number.isFinite(value)) return String(value);
			if (typeof value === "boolean") return value ? "true" : "false";
			return refuse(400, `:${parameter} is text, a number, true, false or null`);
		});
		for (const given of Object.keys(params)) if (!statement.parameters.includes(given)) refuse(400, `The question takes no :${given}`);
		return values;
	}

	/** One question, ready to ask: the caller may read its file, the gateway holds its text, its parameters are filled. */
	async #question(caller, environmentId, asked, texts, proofs = null) {
		if (!asked || typeof asked !== "object") refuse(400, "Name a question");
		const { database: name, question, params = {} } = asked;
		if (typeof name !== "string" || !DATABASE_NAME.test(name) || typeof question !== "string" || !FILE_NAME.test(question) || question.length > 60)
			refuse(400, "Name a question as <database>/<question>");
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
		return { database, name, n, sql: statement.sql, values: this.#values(caller, statement, params) };
	}

	/** An agent's read of its own, ready to ask as a question is: one statement, run as the database folder's read role
	 * in a read-only transaction. The run must be able to read the database's database.toml. */
	async #ownRead(caller, environmentId, asked) {
		const { database: name, sql, params = {} } = asked;
		if (typeof name !== "string" || !DATABASE_NAME.test(name)) refuse(400, "Name a database");
		if (typeof sql !== "string" || sql.trim() === "") refuse(400, "Give one read statement");
		if (Buffer.byteLength(sql) > this.#limits.questionTextBytes) refuse(400, `A read is at most ${this.#limits.questionTextBytes / 1024} KiB`);
		const path = `data/${name}/database.toml`;
		if (!(await this.#proven(caller, environmentId, [path])).get(path)) refuse(404, `No database ${name} that you may read`);
		const statement = readStatement(sql);
		if (!statement.ok) refuse(400, statement.problem);
		const database = companyDatabase(environmentId);
		const n = await this.#folder(database, name);
		if (n === null) refuse(409, `The database ${name} has no applied step yet`);
		return { database, name, n, sql: statement.sql, values: this.#values(caller, statement, params) };
	}

	/** Asks a ready question as the database folder's read role, in one read-only transaction. `ms`: the most it may
	 * take, at most a question's limit. `gone`: when it aborts, the statement is cancelled. `agent`: an agent's read,
	 * with an agent's time, rows and bytes; the watcher knows its backend while it runs. `until`: the time by which it
	 * must be over, its wait for a connection included: with none free by then it is refused (the read role's
	 * connections are few, and a call would else wait for one as long as the pool lets it), and the statement gets
	 * what is left of the time. */
	async #ask(ready, { ms = Number.POSITIVE_INFINITY, gone = null, agent = false, until = null } = {}) {
		const cap = agent ? this.#limits.agentMs : this.#limits.questionMs;
		const maxRows = agent ? this.#limits.agentRows : this.#limits.questionRows;
		const maxBytes = agent ? this.#limits.agentBytes : this.#limits.questionBytes;
		const connecting = this.#pool(ready.database, `${ready.database}_r${ready.n}`).connect();
		const client = await (until === null ? connecting : inTime(connecting, until)).catch((error) => {
			throw storeProblem(error);
		});
		const pid = client.processID;
		if (agent) this.#agentReads.set(pid, (this.#agentReads.get(pid) ?? 0) + 1);
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
			if (until !== null) {
				ms = Math.min(ms, until - Date.now());
				if (ms < 1) refuse(408, "No time was left for the statement");
			}
			const limit = Math.max(1, Math.floor(Math.min(cap, ms)));
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
					`with ${asked} as (select * from (\n${ready.sql}\n) ${inner} limit ${maxRows + 1}), ` +
					`${sized} as (select ${asked}.*, row_number() over () as ${at}, ` +
					`sum(octet_length(row(${asked}.*)::text)) over (rows between unbounded preceding and current row) as ${bytesSoFar} ` +
					`from ${asked}) ` +
					`select ${sized}.*, ${madeAs}.${rowsMade} from (select count(*) as ${rowsMade} from ${asked}) ${madeAs} ` +
					`left join ${sized} on ${sized}.${bytesSoFar} <= ${maxBytes} order by ${sized}.${at}`,
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
			let more = made > maxRows || given.length < Math.min(made, maxRows);
			await client.query("rollback");
			const columns = fields.map((field) => field.name);
			const rows = [];
			let bytes = 0;
			for (const row of given.slice(0, maxRows)) {
				const shapedRow = row.slice(0, width).map((value, index) => shaped(value, fields[index].dataTypeID));
				bytes += Buffer.byteLength(JSON.stringify(shapedRow)) + 1;
				if (bytes > maxBytes) {
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
			if (agent) {
				const left = (this.#agentReads.get(pid) ?? 1) - 1;
				if (left > 0) this.#agentReads.set(pid, left);
				else this.#agentReads.delete(pid);
			}
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
						`alter database ${quoted(database)} set max_parallel_workers_per_gather = 0; ` +
						// No session in it writes the company's values into the server's log (LOG_SETTINGS).
						LOG_SETTINGS.map(([name, value]) => `alter database ${quoted(database)} set ${name} = '${value}'`).join("; "),
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
		const began = Date.now();
		const name = body.database;
		if (typeof name !== "string" || !DATABASE_NAME.test(name) || name === "qorpera" || /^(pg_|qorpera_)/.test(name))
			refuse(400, "A database's name is a letter, then up to 39 of a-z, 0-9 and _");
		const root = `data/${name}`;
		const proof = (await this.#proven(caller, environmentId, [`${root}/database.toml`])).get(`${root}/database.toml`);
		if (!proof) refuse(404, `No database ${name} that you may read: it needs ${root}/database.toml`);
		if (this.#full.has(companyDatabase(environmentId)))
			refuse(507, `This company's database is at its size limit of ${amount(this.#limits.companyBytes)}: delete rows or ask for more room`);
		const listed = await this.#listed(caller, environmentId, `${root}/tables`, this.#limits.steps + 1);
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
		for (const [index, step] of waiting.entries()) {
			if (Date.now() - began >= this.#limits.applyMs) {
				for (const left of waiting.slice(index)) results.push({ name: left.name, state: "waiting" });
				return { applied: false, more: true, results };
			}
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
		const stored = await this.#stored(database, name, n, Date.now() + this.#limits.countMs);
		return {
			database: name,
			applied: stored.applied.map((step) => ({ name: step.name, at: step.at })),
			tables: stored.tables,
			companyBytes: stored.companyBytes,
		};
	}

	/** A database folder's applied steps (with their hashes), tables and columns, and the company database's size.
	 * A table's `rows` are counted now, as the folder's read role `n`, while the time until `until` lasts (`#count`):
	 * `rows` is never a guess. One that was not counted carries PostgreSQL's own estimate as `rowsAbout` when it has
	 * one, under a name of its own so that nothing that passes `rows` on can pass a guess for a count (an agent's
	 * shorter describe keeps a table's name, `rows` and columns). It carries neither when PostgreSQL has none: the
	 * estimate is unset until a table is first analysed, and autovacuum leaves a table of a few rows alone, so on its
	 * own it said 0 for a small table that held rows. */
	async #stored(database, name, n, until) {
		const pool = this.#pool(database, "qorpera_data_keeper");
		const [steps, columns, size] = await Promise.all([
			pool.query("select name, sha256, applied_at from qorpera_data.steps where database = $1 order by name", [name]),
			pool.query(
				`select c.relname as table, a.attname as column, pg_catalog.format_type(a.atttypid, a.atttypmod) as type,
					c.relkind as kind, c.relpages as pages, c.reltuples::bigint as estimate
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
			if (!tables.has(row.table))
				tables.set(row.table, { name: row.table, kind: row.kind, pages: Number(row.pages), estimate: Number(row.estimate), counted: null, columns: [] });
			tables.get(row.table).columns.push({ name: row.column, type: row.type });
		}
		await this.#count(database, name, n, [...tables.values()], until);
		return {
			applied: steps.rows.map((row) => ({ name: row.name, sha256: row.sha256, at: row.applied_at.toISOString() })),
			tables: [...tables.values()].map((table) => ({
				name: table.name,
				// A view holds no rows of its own, so PostgreSQL's number for it says nothing.
				...(table.counted !== null
					? { rows: table.counted }
					: table.estimate >= 0 && table.kind !== "v"
						? { rowsAbout: table.estimate }
						: {}),
				columns: table.columns,
			})),
			companyBytes: Number(size.rows[0].bytes),
		};
	}

	/** Counts the rows of a database folder's `tables` (`counted`), each as a question of its own: the folder's read
	 * role, a read-only transaction, a question's time at most. Tables and materialized views go first, the ones
	 * PostgreSQL holds as smallest before the others, then partitioned tables, then views, whose count runs their own
	 * statement. Every count is over by `until`, its wait for one of the read role's connections included, and
	 * nothing is started after it. A count that ran out of time, found no connection free or was refused leaves its
	 * table uncounted: a describe is never refused over a count. The table is named with its schema: a name alone
	 * would find a catalog relation of the same name first (`pg_tables`), whatever the search path. */
	async #count(database, name, n, tables, until) {
		const rank = (table) => (table.kind === "v" ? 2 : table.kind === "p" ? 1 : 0);
		const order = [...tables].sort((a, b) => rank(a) - rank(b) || a.pages - b.pages || (a.name < b.name ? -1 : 1));
		for (const table of order) {
			if (until - Date.now() < 1) return;
			const sql = `select count(*) from ${quoted(name)}.${quoted(table.name)}`;
			const answer = await this.#ask({ database, name, n, sql, values: [] }, { until }).catch((error) => {
				if (error instanceof Refusal) return null;
				throw error;
			});
			const rows = Number(answer?.rows[0]?.[0]);
			if (answer && Number.isSafeInteger(rows) && rows >= 0) table.counted = rows;
		}
	}

	/** Whether the company's database exists yet: a company that never applied a step has none. */
	async #companyExists(database) {
		if (this.#exists.has(database) || this.#provisioned.has(database)) return true;
		const found = await this.#pool("postgres", "qorpera_data_watch")
			.query("select 1 from pg_catalog.pg_database where datname = $1", [database])
			.catch((error) => {
				throw storeProblem(error);
			});
		if (found.rowCount === 0) return false;
		this.#exists.add(database);
		return true;
	}

	/** data_describe (§6): the databases the run may read, or the one it names, as the folder and the store hold them:
	 * each one's name and words from its database.toml, its steps (applied, waiting, changed after they were applied,
	 * gone), its tables and columns, its questions with their words; and the company database's size against its
	 * limit. The texts it does not hold come from the caller, as for a question. */
	async runDescribe(caller, environmentId, body) {
		const asked = body.database ?? null;
		if (asked !== null && (typeof asked !== "string" || !DATABASE_NAME.test(asked))) refuse(400, "Name a database");
		const names = [...caller.files.keys()].map((path) => TOML_PATH.exec(path)?.[1]).filter((name) => name !== undefined);
		if (asked !== null && !names.includes(asked)) refuse(404, `No database ${asked} that you may read`);
		const wanted = (asked === null ? names : [asked]).sort();
		const database = companyDatabase(environmentId);
		const exists = await this.#companyExists(database);
		const texts = new Map();
		const need = [];
		for (const name of wanted) {
			for (const [path, file] of caller.files) {
				if (path !== `data/${name}/database.toml` && !(path.startsWith(`data/${name}/queries/`) && path.endsWith(".sql"))) continue;
				if (file.bytes > this.#limits.questionTextBytes) continue;
				const text = await this.#text(exists ? database : null, file.sha256, body.texts, this.#limits.questionTextBytes);
				if (text === null) need.push({ path, sha256: file.sha256 });
				else texts.set(path, text);
			}
		}
		if (need.length > 0) return { need };
		const databases = [];
		let companyBytes = 0;
		if (exists)
			companyBytes = Number(
				(
					await this.#pool(database, "qorpera_data_keeper")
						.query("select pg_database_size(current_database()) as bytes")
						.catch((error) => {
							throw storeProblem(error);
						})
				).rows[0].bytes,
			);
		// One call's counts share one time, however many databases it shows.
		const countUntil = Date.now() + this.#limits.countMs;
		for (const name of wanted) {
			const n = exists ? await this.#folder(database, name) : null;
			const stored = n === null ? { applied: [], tables: [] } : await this.#stored(database, name, n, countUntil);
			const root = `data/${name}`;
			const steps = [...caller.files]
				.filter(([path]) => path.startsWith(`${root}/tables/`) && path.endsWith(".sql"))
				.map(([path, file]) => ({ name: path.slice(`${root}/tables/`.length, -4), sha256: file.sha256 }))
				.sort((a, b) => (a.name < b.name ? -1 : 1));
			const live = new Map(steps.map((step) => [step.name, step.sha256]));
			const applied = new Map(stored.applied.map((step) => [step.name, step]));
			const toml = texts.get(`${root}/database.toml`) ?? "";
			const word = (key) => {
				const found = new RegExp(`^${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")\\s*(#.*)?$`, "m").exec(toml)?.[1];
				try {
					return found === undefined ? null : JSON.parse(found);
				} catch {
					return null;
				}
			};
			databases.push({
				database: name,
				name: word("name"),
				about: word("about"),
				steps: {
					applied: stored.applied.filter((step) => live.get(step.name) === step.sha256).map((step) => ({ name: step.name, at: step.at })),
					waiting: steps.filter((step) => !applied.has(step.name)).map((step) => step.name),
					changed: stored.applied.filter((step) => live.has(step.name) && live.get(step.name) !== step.sha256).map((step) => step.name),
					missing: stored.applied.filter((step) => !live.has(step.name)).map((step) => step.name),
				},
				tables: stored.tables,
				// A question's words, and its parameters when it reads as one statement; a file larger than a question may
				// be has neither.
				questions: [...caller.files]
					.filter(([path]) => path.startsWith(`${root}/queries/`) && path.endsWith(".sql"))
					.map(([path]) => {
						const text = texts.get(path);
						const statement = text === undefined ? null : readStatement(text);
						return {
							name: path.slice(`${root}/queries/`.length, -4),
							words: text === undefined ? null : leadingWords(text).join(" "),
							parameters: statement?.ok ? statement.parameters : null,
							...(statement && !statement.ok ? { problem: statement.problem } : {}),
						};
					})
					.sort((a, b) => (a.name < b.name ? -1 : 1)),
			});
		}
		return { databases, companyBytes, limitBytes: this.#limits.companyBytes };
	}

	/** data_query (§6): a question by name or a read of the run's own, with an agent's limits. */
	async runQuery(caller, environmentId, body) {
		if (body.sql !== undefined && body.question !== undefined) refuse(400, "Ask a question or give a read, not both");
		const ready =
			body.sql !== undefined ? await this.#ownRead(caller, environmentId, body) : await this.#question(caller, environmentId, body, body.texts);
		if (ready.need) return { need: [ready.need] };
		const { columns, rows, more } = await this.#ask(ready, { agent: true });
		return { columns, rows, more, asOf: new Date().toISOString() };
	}

	/** The watcher (§3), one look with `qorpera_data_watch`. It cancels any statement of a database folder's login that
	 * has run longer than its door's limit and a margin: a limit a login could lift for itself is backed here. A read
	 * login's backend that runs an agent's read now has an agent's limit; the gateway knows it by its pid, which no
	 * statement can change. A
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
					when 'r' then case when a.pid = any($6::int[]) then $7::float8 else $1::float8 end
					when 'w' then $2::float8 when 'o' then $3::float8
				end + $4::float8) / 1000)`,
				[this.#limits.questionMs, this.#limits.changeMs, this.#limits.stepMs, OVERRUN_MS, this.#cancelled, [...this.#agentReads.keys()], this.#limits.agentMs],
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

	/** An agent's request on the run door (SLICE5): the node's private token as the bearer and a data pass in the body.
	 * A wrong token, no pass and a pass that redeems to nothing get one answer, 401, with no detail. The pass names the
	 * company, the run's requester and the files the run may read; nothing else in the request does. */
	async handleRun(method, path, headers, read) {
		const route = /^\/v1\/run-data\/(describe|apply|query)$/.exec(path);
		if (!this.#runToken) refuse(404, "Not a call the data gateway answers");
		if (!bearerIs(headers.authorization, this.#runToken)) refuse(401, "Not allowed");
		if (!route) refuse(404, "Not a call the data gateway answers");
		if (method !== "POST") refuse(405, "Use POST");
		let body;
		try {
			body = JSON.parse(await read(this.#limits.bodyBytes));
		} catch (error) {
			if (error instanceof Refusal) throw error;
			refuse(400, "The body is not JSON");
		}
		if (!body || typeof body !== "object" || Array.isArray(body)) refuse(400, "The body is not an object");
		if (typeof body.pass !== "string" || !PASS.test(body.pass)) refuse(401, "Not allowed");
		if (body.texts !== undefined && (typeof body.texts !== "object" || body.texts === null || Array.isArray(body.texts)))
			refuse(400, "Texts are given by their hash");
		const kept = await this.#platform.redeemPass(body.pass);
		if (!kept) refuse(401, "Not allowed");
		const caller = { run: true, userId: kept.requesterUserId, key: `run:${sha256(body.pass)}`, files: kept.files };
		switch (route[1]) {
			case "query":
				return this.runQuery(caller, kept.environmentId, body);
			case "apply":
				return this.apply(caller, kept.environmentId, body);
			default:
				return this.runDescribe(caller, kept.environmentId, body);
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

/** One request to `handle(method, path, headers, read, gone)`: JSON in, JSON out. */
function answering(handle) {
	return async (request, response) => {
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
			value = await handle(request.method, new URL(request.url, "http://gateway").pathname, request.headers, read, gone.signal);
		} catch (error) {
			const refusal = error instanceof Refusal ? error : new Refusal(500, "The data gateway failed");
			status = refusal.status;
			value = { error: refusal.message, ...refusal.extra };
		}
		if (gone.signal.aborted) return;
		const text = JSON.stringify(value);
		response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
		response.end(text);
	};
}

/** The gateway's HTTP side for members: JSON in, JSON out, loopback. */
export function serve(gateway, { host = "127.0.0.1", port = 0 } = {}) {
	const server = http.createServer(answering((method, path, headers, read, gone) => gateway.handle(method, path, headers, read, gone)));
	return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

/** The run door (SLICE5; nodework/road.md part (c)): its own listener, on its own host and port, for agents' tools on
 * the nodes. TLS when a certificate and key are given (PEM text); plain only for a test on loopback. It answers only
 * `POST /v1/run-data/(describe|apply|query)`, and only when the gateway holds the node's private token. */
export function serveRuns(gateway, { host = "127.0.0.1", port = 0, cert = null, key = null } = {}) {
	if ((cert === null) !== (key === null)) throw new Error("The run door needs both a certificate and its key, or neither");
	if (cert === null && !["127.0.0.1", "::1", "localhost"].includes(host)) throw new Error("The run door off loopback needs TLS");
	const handler = answering((method, path, headers, read) => gateway.handleRun(method, path, headers, read));
	const server = cert === null ? http.createServer(handler) : https.createServer({ cert, key, minVersion: "TLSv1.2" }, handler);
	return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}
