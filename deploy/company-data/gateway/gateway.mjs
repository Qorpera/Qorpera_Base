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
import { leadingWords, readStatement, VIEWER, wordsWith } from "./sql-text.mjs";

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
export const POOL_SIZE = Object.freeze({ o: 1, w: 8, r: 12, qorpera_data_keeper: 4, qorpera_data_admin: 1, qorpera_data_watch: 1, record: 1 });
const WATCH_WORKERS = 3;
/** Connections a company's database takes, all logins together. */
const COMPANY_CONNECTIONS = 36;
const RAW_JSON = Symbol("rawJson");
const VOLATILE_SQL =
	/\b(?:now|clock_timestamp|statement_timestamp|transaction_timestamp|timeofday|current_timestamp|current_date|current_time|localtime|localtimestamp|random|setseed|gen_random_uuid|uuid_generate_v[14]|pg_sleep|txid_current|pg_current_xact_id|nextval|setval|currval|lastval)\b/i;
/** What a member's yes to a held step is for (§3): the step, the hash of its text, and the hash of what it would
 * destroy, as `<step>.<sha256>.<sha256>`. A held step's answer carries it as `allow`; a run's pass carries the one a
 * member said yes to. A step is applied on a yes only when all three are still what the member was shown. */
const TICKET = /^([0-9]{3}-[a-z0-9]+(?:-[a-z0-9]+)*)\.([0-9a-f]{64})\.([0-9a-f]{64})$/;
/** How long a call waits for a connection of a login's own before the pool gives up. */
const CONNECT_MS = 5_000;
/** A file of a database's API: a question is a named read in queries/, a change a named write in actions/. */
const NAMED = { question: { folder: "queries", may: "read" }, change: { folder: "actions", may: "run" } };
/** The rows this session added or changed, in every table (a catalog's and a large object's too) but Qorpera's own
 * records beside a company's rows, as PostgreSQL counts them itself: no login of a company's can switch the counts
 * off. They hold the current transaction's writes and those of the session's earlier transactions that it has not
 * reported yet (it reports between transactions, at most once a second), so what one transaction wrote is the
 * difference of two reads inside it. */
const WRITTEN =
	"select coalesce(sum(n_tup_ins + n_tup_upd), 0) as rows from pg_catalog.pg_stat_xact_all_tables where schemaname <> 'qorpera_data'";
/** What a change's one statement may be, by the word PostgreSQL ends it with: a write to rows, or a select (which
 * may call a function a step made). */
const CHANGE_COMMANDS = ["INSERT", "UPDATE", "DELETE", "MERGE", "SELECT"];

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
	/** A named change: its time, and the most its statement may send back before it is stopped and rolled back. */
	changeMs: 5_000,
	changeBytes: 1024 * 1024,
	/** A step: its own time, and its wait for a lock. */
	stepMs: 60_000,
	stepLockMs: 5_000,
	/** An apply call starts no step once this has passed since it began: it answers `more: true` with the steps still
	 * waiting, so a call lasts at most this and one step's time. */
	applyMs: 45_000,
	/** A file's text: a question's or a change's, and a step's. */
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
	parameterBytes: 64 * 1024,
	/** A company's database, all its rows: at this size its steps stop applying, and its questions still answer. */
	companyBytes: 1024 ** 3,
	/** Counting the rows of the tables one describe call shows: all its counts together. */
	countMs: 1_500,
	sweepMs: 3_600_000,
	pageRows: 200,
	pageRowsUsual: 100,
	recordDays: 30,
	changesWrites: 25,
	changesWindow: 5_000,
	changesDays: 14,
});

const NEAR_SHARE = 0.8;
const COUNT_SMALL_PAGES = 64;
const COUNT_BATCH_SIZE = 32;
const COUNT_BATCH_MAX_MS = 250;
const COUNT_LOCK_MAX_MS = 250;
const COUNT_COMPANY_CONCURRENCY = 8;
const DESCRIBE_CONCURRENCY = 4;
const ROOMY_RETRY_MS = 1_500;
const ROW_TEXT =
	"; set local intervalstyle = 'postgres'; set local extra_float_digits = 1; set local bytea_output = 'hex'; set local lc_monetary = 'C'";
const SEEN = (row) => `pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(${row}::text, 'UTF8')), 'hex')`;
const EDITS = ["add", "change", "remove"];
const SETTLE =
	"with looked as (select c.txid, pg_catalog.txid_status(c.txid) as status from qorpera_data.change_log c " +
	"where $1::bigint[] is null or c.txid = any ($1::bigint[])), " +
	"gone as (delete from qorpera_data.change_log c using looked l where c.txid = l.txid and l.status = 'aborted' returning c.txid) " +
	"select l.txid::text as txid from looked l where l.status = 'in progress'";
const UNROWED =
	"delete from qorpera_data.change_log c where pg_catalog.txid_visible_in_snapshot(c.txid, pg_catalog.txid_current_snapshot()) " +
	"and not exists (select 1 from qorpera_data.row_changes r where r.txid <= c.txid)";
const FORGET = "select qorpera_data.forget_record(pg_catalog.now() - pg_catalog.make_interval(days => $1::int)) as lines";
const ZONE = /^[A-Za-z][A-Za-z0-9_+-]{0,30}(?:\/[A-Za-z0-9_+-]{1,30}){0,2}$/;
const CHANGES_LINES = 3;
const CHANGES_VALUE_BYTES = 2_048;
const CHANGES_COUNTED = 10_000;
const CHANGES_TABLES = 50;
const CHANGES_COLUMNS = 100;
const CHANGES_PAGE =
	"with seen as (select r.txid, r.seq from qorpera_data.row_changes r where r.schema = $1 and ($2::bigint is null or r.seq < $2) " +
	"order by r.seq desc limit $3), " +
	"writes as (select g.txid, g.newest from (select s.txid, max(s.seq) as newest from seen s group by s.txid) g " +
	"where $2::bigint is null or (select max(x.seq) from qorpera_data.row_changes x where x.txid = g.txid and x.schema = $1) < $2 " +
	"order by g.newest desc limit $4) " +
	"select w.txid::text as txid, w.newest::text as newest, pg_catalog.to_char(c.at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as at, " +
	"c.by_kind, c.by_id, c.via, " +
	"(select pg_catalog.jsonb_build_object('tables', pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('table', t.relation, 'op', t.op, 'rows', t.rows) " +
	"order by t.first) filter (where t.place <= $8), 'cut', count(*) > $8) from " +
	"(select x.relation, x.op, sum(x.rows)::bigint as rows, min(x.seq) as first, pg_catalog.row_number() over (order by min(x.seq)) as place from " +
	"(select y.relation, y.op, y.rows, y.seq from qorpera_data.row_changes y where y.txid = w.txid and y.schema = $1 order by y.seq limit $7) x " +
	"group by x.relation, x.op) t) as counted, " +
	"(select count(*) > $7 from (select 1 from qorpera_data.row_changes y where y.txid = w.txid and y.schema = $1 order by y.seq limit $7 + 1) m) as uncounted, " +
	"(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('table', l.relation, 'op', l.op, 'rows', l.rows, " +
	"'key', case when pg_catalog.octet_length(l.key::text) <= $6 then l.key end, " +
	"'before', case when pg_catalog.octet_length(l.before::text) <= $6 then l.before end, " +
	"'after', case when pg_catalog.octet_length(l.after::text) <= $6 then l.after end, " +
	"'columns', (select pg_catalog.jsonb_agg(n.name order by n.name) from (select o.name from pg_catalog.jsonb_object_keys(coalesce(l.after, l.before)) o(name) " +
	"order by o.name limit $9) n)) order by l.seq) from " +
	"(select x.* from qorpera_data.row_changes x where x.txid = w.txid and x.schema = $1 order by x.seq limit $5) l) as lines, " +
	"(select count(*) > $5 from (select 1 from qorpera_data.row_changes x where x.txid = w.txid and x.schema = $1 order by x.seq limit $5 + 1) m) as cut, " +
	"z.looked, z.lowest from (select count(*) as looked, min(s.seq)::text as lowest from seen s) z " +
	"left join writes w on true left join qorpera_data.change_log c on c.txid = w.txid order by w.newest desc nulls last";
const CHANGES_DAYS =
	"select pg_catalog.to_char(c.at at time zone $2, 'YYYY-MM-DD') as day, c.by_kind, c.by_id, sum(r.rows)::bigint as rows " +
	"from qorpera_data.change_log c join qorpera_data.row_changes r on r.txid = c.txid and r.schema = $1 " +
	"where c.at >= (pg_catalog.date_trunc('day', pg_catalog.now() at time zone $2) - pg_catalog.make_interval(days => $3::int - 1)) at time zone $2 " +
	"group by 1, 2, 3 order by 1, 2, 3";
const RECORD_SIZE = ["row_changes", "change_log", "record_bytes"]
	.map((table) => `coalesce(pg_catalog.pg_total_relation_size(pg_catalog.to_regclass('qorpera_data.${table}')), 0)`)
	.join(" + ");
const OWN_SIZE = `select pg_catalog.pg_database_size(pg_catalog.current_database()) - (${RECORD_SIZE}) as bytes`;
const RELATION =
	"select a.attname as name, pg_catalog.format_type(a.atttypid, a.atttypmod) as type, c.relkind as kind, c.relrowsecurity as rls, " +
	"(select k.n from unnest(i.indkey::int2[]) with ordinality k(attnum, n) where k.attnum = a.attnum) as key, " +
	"pg_catalog.format_type(a.atttypid, -1) as base, c.relkind in ('r', 'p') and a.attgenerated = '' and a.attidentity <> 'a' as settable, " +
	"(with recursive d(oid) as (select a.atttypid union all select t.typbasetype from d join pg_catalog.pg_type t on t.oid = d.oid and t.typtype = 'd') " +
	"select bool_or(d.oid in ('pg_catalog.json'::pg_catalog.regtype, 'pg_catalog.jsonb'::pg_catalog.regtype)) from d) as json " +
	"from pg_catalog.pg_class c join pg_catalog.pg_namespace s on s.oid = c.relnamespace and s.nspname = $1 " +
	"join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped " +
	"left join pg_catalog.pg_index i on i.indrelid = c.oid and i.indisprimary " +
	"where c.relname = $2 and c.relkind in ('r', 'p', 'v', 'm') order by a.attnum";
const SCHEMA_VIEWER_OBJECTS =
	"select c.relname as name from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace and n.nspname = $1 " +
	"where c.relrowsecurity or c.relkind in ('v', 'm') " +
	"union " +
	"select p.proname as name from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace and n.nspname = $1";

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const TOML_KEY = `(?:[A-Za-z0-9_-]+|"[^"\\\\\\n]*"|'[^'\\n]*')`;
const TOML_KEYS = `${TOML_KEY}(?:\\s*\\.\\s*${TOML_KEY})*`;
const TOML_STRING = /"(?:[^"\\\n]|\\.)*"|'[^'\n]*'/g;
const TOML_HEADER = new RegExp(`^\\s*\\[\\s*(${TOML_KEYS})\\s*\\]\\s*(?:#.*)?$`);
const TOML_PAIR = new RegExp(`^\\s*(${TOML_KEYS})\\s*=(.*)$`);
const TOML_HEAD = /^(?:[^"'#]|"(?:[^"\\\n]|\\.)*"|'[^'\n]*')*/;
const TOML_SCALAR = /^(?:"(?:[^"\\]|\\.)*"|'[^']*'|[-+0-9A-Za-z_.:]+)$/;
const LIST_VALUE = /^(?:"(readers|writers)"|'(readers|writers)')$/;
const LIST_INLINE = /^\{\s*(?:members|"members"|'members')\s*=\s*("[^"\\]*"|'[^']*')\s*\}$/;

function tomlParts(text) {
	return [...text.matchAll(new RegExp(TOML_KEY, "g"))].map((part) => (/^["']/.test(part[0]) ? part[0].slice(1, -1) : part[0]));
}

function tomlValue(text) {
	if (/"""|'''/.test(text)) return null;
	const head = TOML_HEAD.exec(text)[0];
	const rest = text.slice(head.length);
	if (rest !== "" && !rest.startsWith("#")) return null;
	const value = head.trim();
	if (TOML_SCALAR.test(value)) return value;
	const plain = value.replace(TOML_STRING, '""');
	const balanced = (open, close) => plain.split(open).length === plain.split(close).length;
	return /^[[{].*[\]}]$/.test(plain) && balanced("[", "]") && balanced("{", "}") ? value : null;
}

function listLine(toml) {
	let table = [];
	let found = null;
	for (const line of toml.split(/\r?\n/)) {
		if (/^\s*(?:#.*)?$/.test(line)) continue;
		const header = TOML_HEADER.exec(line);
		if (header) {
			table = tomlParts(header[1]);
			if (table[0] === "list" && table.length > 1) return "writers";
			continue;
		}
		const pair = TOML_PAIR.exec(line);
		const value = pair ? tomlValue(pair[2]) : null;
		if (value === null) return "writers";
		const key = [...table, ...tomlParts(pair[1])];
		if (key[0] !== "list") continue;
		const said =
			key.length === 2 && key[1] === "members"
				? LIST_VALUE.exec(value)
				: key.length === 1 && LIST_INLINE.test(value)
					? LIST_VALUE.exec(LIST_INLINE.exec(value)[1])
					: null;
		if (found !== null || !said) return "writers";
		found = (said[1] ?? said[2]) === "readers" ? "readers" : "writers";
	}
	return found;
}

function namesViewer(text) {
	if (text === null) return true;
	const statement = readStatement(text);
	return statement.ok ? statement.parameters.includes(VIEWER) : new RegExp(`(?<![:A-Za-z0-9_]):${VIEWER}(?![A-Za-z0-9_])`).test(text);
}

export function listMembers(toml, questions, cut = false) {
	if (toml === null) return "writers";
	const declared = listLine(toml);
	if (declared !== null) return declared;
	if (cut) return "writers";
	return questions.some(namesViewer) ? "writers" : "readers";
}

function tomlWord(toml, key) {
	const found = new RegExp(`^${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")\\s*(#.*)?$`, "m").exec(toml ?? "")?.[1];
	try {
		return found === undefined ? null : JSON.parse(found);
	} catch {
		return null;
	}
}

function namedFiles(files) {
	return files.map(({ name, text }) => {
		const statement = text === null ? null : readStatement(text);
		return {
			name,
			words: text === null ? null : leadingWords(text).join(" "),
			parameters: statement?.ok ? statement.parameters : null,
			...(statement && !statement.ok ? { problem: statement.problem } : {}),
		};
	});
}

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
let cachedIsoMs = -1;
let cachedIsoText = "";
const isoNow = () => {
	const ms = Date.now();
	if (ms !== cachedIsoMs) {
		cachedIsoMs = ms;
		cachedIsoText = new Date(ms).toISOString();
	}
	return cachedIsoText;
};
const EMPTY_VALUES = Object.freeze([]);

async function mapBounded(items, concurrency, work) {
	if (items.length === 0) return [];
	if (items.length === 1 || concurrency <= 1) {
		const out = [];
		for (let i = 0; i < items.length; i++) out.push(await work(items[i], i));
		return out;
	}
	const results = new Array(items.length);
	let cursor = 0;
	const worker = async () => {
		while (cursor < items.length) {
			const index = cursor++;
			results[index] = await work(items[index], index);
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
	return results;
}

function acquirePermit(gates, key, limit, until) {
	const left = until - Date.now();
	if (left < 1) return Promise.resolve(null);
	let gate = gates.get(key);
	if (!gate) {
		gate = { active: 0, waiters: [] };
		gates.set(key, gate);
	}
	const makeRelease = () => {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const next = gate.waiters.shift();
			if (next) {
				clearTimeout(next.timer);
				next.resolve(makeRelease());
				return;
			}
			gate.active--;
			if (gate.active === 0 && gate.waiters.length === 0 && gates.get(key) === gate) gates.delete(key);
		};
	};
	if (gate.active < limit) {
		gate.active++;
		return Promise.resolve(makeRelease());
	}
	return new Promise((resolve) => {
		const waiter = {
			resolve,
			timer: setTimeout(() => {
				const idx = gate.waiters.indexOf(waiter);
				if (idx >= 0) gate.waiters.splice(idx, 1);
				if (gate.active === 0 && gate.waiters.length === 0 && gates.get(key) === gate) gates.delete(key);
				resolve(null);
			}, left),
		};
		waiter.timer.unref?.();
		gate.waiters.push(waiter);
	});
}
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
	async #rpc(token, name, args, refusedAs = undefined) {
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
		if (refusedAs !== undefined && (response.status === 403 || response.status === 404)) return refusedAs;
		if (!response.ok) refuse(response.status === 403 || response.status === 404 ? 403 : 503, "The company folder refused the read");
		return response.json();
	}
	async memberFolders(token, environmentId, parent, limit) {
		const answer = await this.#rpc(token, "qorpera_member_folder_list", {
			p_environment_id: environmentId,
			p_parent: parent,
			p_after: null,
			p_limit: limit,
		});
		return (Array.isArray(answer?.entries) ? answer.entries : [])
			.filter((entry) => entry.kind === "folder" && typeof entry.path === "string")
			.map((entry) => entry.path.slice(entry.path.lastIndexOf("/") + 1));
	}
	async memberMayWrite(token, environmentId, path) {
		const answer = await this.#rpc(token, "qorpera_member_folder_may_write", { p_environment_id: environmentId, p_path: path }, null);
		return answer?.write === true;
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
		return (await this.memberListPage(token, environmentId, parent, limit)).files;
	}
	async memberListPage(token, environmentId, parent, limit) {
		const answer = await this.#rpc(token, "qorpera_member_folder_list", {
			p_environment_id: environmentId,
			p_parent: parent,
			p_after: null,
			p_limit: limit,
		});
		const files = (Array.isArray(answer?.entries) ? answer.entries : [])
			.filter((entry) => entry.kind === "file" && SHA.test(entry.fileSha256 ?? ""))
			.map((entry) => ({ name: entry.path.slice(entry.path.lastIndexOf("/") + 1), sha256: entry.fileSha256, bytes: entry.bytes }));
		if (typeof answer?.next !== "string") return { files, more: false };
		const after = await this.#rpc(token, "qorpera_member_folder_list", {
			p_environment_id: environmentId,
			p_parent: parent,
			p_after: answer.next,
			p_limit: 1,
		});
		return { files, more: !Array.isArray(after?.entries) || after.entries.length > 0 };
	}
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
		const machine = answer?.kind === "machine";
		if (
			answer?.schema !== "qorpera.data-pass-redeemed/v1" ||
			(answer.kind !== "run" && !machine) ||
			!ENVIRONMENT.test(answer.environmentId ?? "") ||
			(machine
				? !ENVIRONMENT.test(answer.viewId ?? "") || !ENVIRONMENT.test(answer.machineId ?? "") || (answer.allow ?? null) !== null
				: !ENVIRONMENT.test(answer.runId ?? "")) ||
			!ENVIRONMENT.test(answer.requesterUserId ?? "") ||
			!ENVIRONMENT.test(answer.staffAgentId ?? "") ||
			(answer.database !== null && !DATABASE_NAME.test(answer.database ?? "")) ||
			!files ||
			(answer.allow !== undefined && answer.allow !== null && !(typeof answer.allow === "string" && TICKET.test(answer.allow))) ||
			files.length > 1000 ||
			!files.every(
				(file) => KEPT_PATH.test(file?.path ?? "") && SHA.test(file.sha256 ?? "") && Number.isSafeInteger(file.bytes) && file.bytes >= 0,
			)
		)
			refuse(503, "The platform's answer is not a pass");
		return {
			environmentId: answer.environmentId,
			machineId: machine ? answer.machineId : null,
			requesterUserId: answer.requesterUserId,
			agentId: answer.staffAgentId,
			database: answer.database,
			files: new Map(files.map((file) => [file.path, { sha256: file.sha256, bytes: file.bytes }])),
			allow: answer.allow ?? null,
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
	#workers;
	#pools = new Map();
	#proofs = new Map();
	#texts = new Map();
	#statements = new Map();
	#folders = new Map();
	#listeners = new Map();
	#listenEpoch = 0;
	#watchInFlight = new Map();
	#tagSalt = randomBytes(16);
	#schemaEpoch = new Map();
	#relations = new Map();
	#prepared = new WeakMap();
	#askPlans = new Map();
	#tokens = new Map();
	#provenInFlight = new Map();
	#mayWriteInFlight = new Map();
	#folderInFlight = new Map();
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
	#onAgentRead;
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
	#unsettled = new Map();
	#swept = new Map();
	#inFlightCounts = new Map();
	#companyCountGates = new Map();
	/** What questions have taken from the store so far: rows, and the characters of their values. */
	taken = { rows: 0, bytes: 0 };

	/** `store`: { host, port, logins: { admin, keeper, watch, folderKey } }: the three logins' passwords, and the key
	 * each database folder's own logins' passwords are derived from (32 random bytes as hex). `runs`: { token }, the
	 * node's private token an agent's tool brings to the run door. */
	constructor({
		store,
		platform,
		limits = LIMITS,
		runs = null,
		workers = 1,
		onProvision = () => undefined,
		beforeCancel = async () => undefined,
		onAgentRead = () => undefined,
	}) {
		this.#store = store;
		this.#platform = platform;
		this.#limits = limits;
		this.#workers = Math.max(1, Number.isInteger(workers) ? workers : 1);
		this.#runToken = typeof runs?.token === "string" && runs.token.length >= 32 ? runs.token : null;
		this.#onProvision = onProvision;
		this.#beforeCancel = beforeCancel;
		this.#onAgentRead = onAgentRead;
	}

	setAgentRead(pid, delta) {
		if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(delta) || delta === 0) return;
		const next = (this.#agentReads.get(pid) ?? 0) + delta;
		if (next > 0) this.#agentReads.set(pid, next);
		else this.#agentReads.delete(pid);
	}

	setFullDatabases(databases) {
		this.#full = new Set(Array.isArray(databases) ? databases.filter((one) => typeof one === "string") : []);
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
	#pool(database, user, door = user) {
		const key = `${door}@${database}`;
		const currentPool = () => {
			if (this.#closed) throw new Refusal(503, "The data store did not answer");
			let entry = this.#pools.get(key);
			if (!entry) {
				const kind = FOLDER_LOGIN.exec(user)?.[1];
				const baseMax = POOL_SIZE[kind ?? door];
				const max = this.#workers > 1 && (kind === "r" || kind === "w" || door === "qorpera_data_keeper")
					? Math.max(1, Math.floor(baseMax / this.#workers))
					: baseMax;
				const pool = new pg.Pool({
					host: this.#store.host,
					port: this.#store.port,
					user,
					password: this.#password(user),
					database,
					max,
					pipeline: kind === "r" || kind === "w",
					idleTimeoutMillis: kind === "o" ? 1_000 : 5_000,
					connectionTimeoutMillis: CONNECT_MS,
					application_name: `qorpera-data-gateway ${kind ?? user.slice("qorpera_data_".length)}`,
				});
				pool.on("error", () => undefined);
				entry = { pool, active: 0 };
				this.#pools.set(key, entry);
			}
			return entry;
		};
		const roomy = async (work, deadline) => {
			const retryUntil =
				deadline === undefined ? Date.now() + ROOMY_RETRY_MS : Math.min(deadline, Date.now() + ROOMY_RETRY_MS);
			for (let attempt = 0; ; attempt++) {
				// WHY: Look up a live pool per attempt and guard with entry.active so #makeRoom never ends a pool mid-call.
				const entry = currentPool();
				entry.active++;
				let error;
				try {
					return await work(entry.pool);
				} catch (caught) {
					error = caught;
				} finally {
					entry.active--;
				}
				const remaining = retryUntil - Date.now();
				if (this.#closed || error?.code !== "53300" || remaining <= 0) throw error;
				await this.#makeRoom(database, key);
				const delay = Math.min(remaining, Math.min(200, 50 * (attempt + 1)));
				await new Promise((resolve) => setTimeout(resolve, delay));
				if (this.#closed) throw error;
			}
		};
		// A connection whose backend was sent a cancel is let go, never handed out.
		const connect = async (deadline) => {
			for (;;) {
				const client = await roomy((pool) => pool.connect(), deadline);
				if (!this.#signalled.has(client.processID)) return client;
				this.#letGo(client);
			}
		};
		return { query: (...args) => roomy((pool) => pool.query(...args)), connect };
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

	async #makeRoom(database, asking) {
		const reclaim = (filter) => {
			const ending = [];
			for (const [key, entry] of this.#pools) {
				const { pool } = entry;
				if (
					key === asking ||
					!filter(key) ||
					entry.active > 0 ||
					pool.totalCount === 0 ||
					pool.idleCount < pool.totalCount ||
					pool.waitingCount > 0
				)
					continue;
				this.#pools.delete(key);
				ending.push(pool.end().catch(() => undefined));
			}
			return ending;
		};
		let ending = reclaim((key) => key.endsWith(`@${database}`));
		if (ending.length === 0) ending = reclaim(() => true);
		await Promise.all(ending);
	}

	#tag(key) {
		return createHmac("sha256", this.#tagSalt).update(key).digest("hex").slice(0, 16);
	}

	#bumpSchemaEpoch(database, schema) {
		const key = `${database}/${schema}`;
		this.#schemaEpoch.set(key, (this.#schemaEpoch.get(key) ?? 0) + 1);
		const prefix = `${key}/`;
		for (const relKey of this.#relations.keys()) if (relKey.startsWith(prefix)) this.#relations.delete(relKey);
	}

	#preparedState(client, database, schema) {
		const epoch = this.#schemaEpoch.get(`${database}/${schema}`) ?? 0;
		let state = this.#prepared.get(client);
		if (!state) {
			state = { epoch, names: new Set() };
			this.#prepared.set(client, state);
			return { state, needsDeallocate: false };
		}
		if (state.epoch !== epoch) {
			const hadAny = state.names.size > 0;
			state.epoch = epoch;
			state.names.clear();
			return { state, needsDeallocate: hadAny };
		}
		return { state, needsDeallocate: false };
	}

	#preparedName(client, database, schema, key) {
		const { state } = this.#preparedState(client, database, schema);
		const suffix = key.length <= 40 && /^[A-Za-z0-9_]+$/.test(key) ? key : sha256(key).slice(0, 20);
		const name = `qp_${state.epoch}_${suffix}`;
		if (state.names.has(name)) return name;
		if (state.names.size >= 64) return undefined;
		state.names.add(name);
		return name;
	}

	#askPlan(ready, maxRows, maxBytes) {
		const cacheKey = ready.sha256 ? `${ready.sha256}|${maxRows}|${maxBytes}` : null;
		if (cacheKey) {
			const kept = this.#askPlans.get(cacheKey);
			if (kept) return kept;
		}
		const tag = this.#tag(ready.sha256 ?? ready.sql);
		const [asked, inner, sized, madeAs, bytesSoFar, rowsMade] = ["asked", "inner", "sized", "made", "bytes", "rows"].map(
			(name) => `qorpera_${name}_${tag}`,
		);
		const text =
			`with ${asked} as materialized (select * from (\n${ready.sql}\n) ${inner} limit ${maxRows + 1}), ` +
			`${sized} as (select ${asked}.*, ` +
			`sum(octet_length(row(${asked}.*)::text)) over (rows between unbounded preceding and current row) as ${bytesSoFar} ` +
			`from ${asked}) ` +
			`select ${sized}.*, ${madeAs}.${rowsMade} from (select count(*) as ${rowsMade} from ${asked}) ${madeAs} ` +
			`left join ${sized} on ${sized}.${bytesSoFar} <= ${maxBytes}`;
		const plan = { text, key: ready.sha256 ? `${ready.sha256.slice(0, 16)}_${maxRows}_${maxBytes}` : null };
		if (cacheKey) {
			if (this.#askPlans.size >= 5_000) this.#askPlans.delete(this.#askPlans.keys().next().value);
			this.#askPlans.set(cacheKey, plan);
		}
		return plan;
	}

	#cacheRelation(database, schema, table, rows) {
		const key = `${database}/${schema}/${table}`;
		if (this.#relations.size >= 2_000) this.#relations.delete(this.#relations.keys().next().value);
		this.#relations.set(key, rows);
	}

	async #proven(caller, environmentId, paths) {
		if (caller.files) return new Map(paths.map((path) => [path, caller.files.get(path) ?? null]));
		const now = Date.now();
		const found = new Map();
		const waiting = [];
		const ask = [];
		for (const path of paths) {
			const cacheKey = `${caller.key}|${environmentId}|${path}`;
			const kept = this.#proofs.get(cacheKey);
			if (kept && now - kept.at < this.#limits.proofMs) {
				found.set(path, kept.value);
				continue;
			}
			const pending = this.#provenInFlight.get(cacheKey);
			if (pending) {
				waiting.push([path, pending]);
				continue;
			}
			ask.push(path);
		}
		if (ask.length > 0) {
			for (let from = 0; from < ask.length; from += 64) {
				const part = ask.slice(from, from + 64);
				const batch = this.#platform.memberReads(caller.token, environmentId, part);
				part.forEach((path, index) => {
					const cacheKey = `${caller.key}|${environmentId}|${path}`;
					const entry = batch.then((values) => {
						const value = values[index];
						this.#proofs.set(cacheKey, { at: Date.now(), value });
						return value;
					});
					entry.catch(() => undefined);
					this.#provenInFlight.set(cacheKey, entry);
					waiting.push([
						path,
						entry.finally(() => {
							if (this.#provenInFlight.get(cacheKey) === entry) this.#provenInFlight.delete(cacheKey);
						}),
					]);
				});
			}
		}
		if (waiting.length > 0) {
			const resolved = await Promise.all(waiting.map(([, pending]) => pending));
			waiting.forEach(([path], index) => {
				found.set(path, resolved[index]);
			});
		}
		if (this.#proofs.size > 20_000) {
			for (const [key, kept] of this.#proofs) if (now - kept.at >= this.#limits.proofMs) this.#proofs.delete(key);
			for (const key of this.#proofs.keys()) {
				if (this.#proofs.size <= 20_000) break;
				this.#proofs.delete(key);
			}
		}
		return found;
	}

	#cacheText(hash, text) {
		if (this.#texts.size >= 5_000) this.#texts.delete(this.#texts.keys().next().value);
		this.#texts.set(hash, text);
	}

	async #textsFor(database, hashes, supplied, maximum) {
		const found = new Map();
		const toSelect = [];
		const toInsertHashes = [];
		const toInsertTexts = [];
		const seen = new Set();
		for (const hash of hashes) {
			if (seen.has(hash)) continue;
			seen.add(hash);
			const kept = this.#texts.get(hash);
			if (kept !== undefined) {
				found.set(hash, kept);
				continue;
			}
			const given = supplied?.[hash];
			if (typeof given === "string" && Buffer.byteLength(given) <= maximum && sha256(given) === hash) {
				found.set(hash, given);
				this.#cacheText(hash, given);
				if (database !== null) {
					toInsertHashes.push(hash);
					toInsertTexts.push(given);
				}
			} else if (database !== null) {
				toSelect.push(hash);
			}
		}
		if (database !== null && (toSelect.length > 0 || toInsertHashes.length > 0)) {
			const pool = this.#pool(database, "qorpera_data_keeper");
			const tasks = [];
			if (toSelect.length > 0) {
				tasks.push(
					pool
						.query("select sha256, text from qorpera_data.texts where sha256 = any($1::text[])", [toSelect])
						.then((result) => {
							for (const row of result.rows) {
								if (typeof row.text === "string" && sha256(row.text) === row.sha256) {
									found.set(row.sha256, row.text);
									this.#cacheText(row.sha256, row.text);
								}
							}
						})
						.catch((error) => {
							throw storeProblem(error);
						}),
				);
			}
			if (toInsertHashes.length > 0) {
				tasks.push(
					pool
						.query(
							"insert into qorpera_data.texts (sha256, text) select * from unnest($1::text[], $2::text[]) on conflict (sha256) do nothing",
							[toInsertHashes, toInsertTexts],
						)
						.catch(() => undefined),
				);
			}
			await Promise.all(tasks);
		}
		return found;
	}

	/** A text by the hash the folder gave: from what the gateway holds, from the company's database, or from the caller.
	 * `database` null: the company has no database yet, so only what the gateway holds and what the caller gives. */
	async #text(database, hash, supplied, maximum) {
		return (await this.#textsFor(database, [hash], supplied, maximum)).get(hash) ?? null;
	}

	async #folder(database, name) {
		const key = `${database}/${name}`;
		const kept = this.#folders.get(key);
		if (kept !== undefined) return kept;
		let pending = this.#folderInFlight.get(key);
		if (!pending) {
			pending = this.#pool(database, "qorpera_data_keeper")
				.query("select n from qorpera_data.databases where name = $1", [name])
				.then((row) => {
					if (!row.rows[0]) return null;
					this.#folders.set(key, row.rows[0].n);
					return row.rows[0].n;
				})
				.catch((error) => {
					throw storeProblem(error);
				})
				.finally(() => {
					if (this.#folderInFlight.get(key) === pending) this.#folderInFlight.delete(key);
				});
			pending.catch(() => undefined);
			this.#folderInFlight.set(key, pending);
		}
		return pending;
	}

	/** The files directly in a folder that the caller may list: a member's from the platform, a run's from its pass. */
	async #listed(caller, environmentId, parent, limit) {
		return (await this.#listedPage(caller, environmentId, parent, limit)).files;
	}

	async #listedPage(caller, environmentId, parent, limit) {
		if (!caller.files) return this.#platform.memberListPage(caller.token, environmentId, parent, limit);
		const prefix = `${parent}/`;
		const files = [...caller.files]
			.filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
			.sort(([a], [b]) => (a < b ? -1 : 1))
			.map(([path, file]) => ({ name: path.slice(prefix.length), sha256: file.sha256, bytes: file.bytes }));
		return { files: files.slice(0, limit), more: files.length > limit };
	}

	#statement(hash, text) {
		const kept = this.#statements.get(hash);
		if (kept !== undefined) return kept;
		const parsed = readStatement(text);
		if (this.#statements.size >= 5_000) this.#statements.delete(this.#statements.keys().next().value);
		this.#statements.set(hash, parsed);
		return parsed;
	}

	#checkJsonParam(value, depth = 0) {
		if (depth > 16) return false;
		if (value === null || typeof value === "string" || typeof value === "boolean") return true;
		if (typeof value === "number") return Number.isFinite(value);
		if (Array.isArray(value)) return value.every((item) => this.#checkJsonParam(item, depth + 1));
		if (typeof value === "object") {
			const proto = Object.getPrototypeOf(value);
			if (proto !== Object.prototype && proto !== null) return false;
			return Object.values(value).every((item) => this.#checkJsonParam(item, depth + 1));
		}
		return false;
	}

	#values(caller, statement, params, kind = "question") {
		if (!params || typeof params !== "object" || Array.isArray(params)) refuse(400, "Parameters are named values");
		const givenKeys = Object.keys(params);
		if (statement.parameters.length === 0 && givenKeys.length === 0)
			return { values: EMPTY_VALUES, viewer: caller.userId, previewValues: EMPTY_VALUES };
		let viewer = caller.userId;
		if (Object.hasOwn(params, VIEWER)) {
			if (!caller.run) refuse(400, ":viewer is filled by Qorpera");
			viewer = params[VIEWER];
			if (typeof viewer !== "string" || !ENVIRONMENT.test(viewer)) refuse(400, ":viewer is a member's id");
		}
		const maxParamBytes = this.#limits.parameterBytes;
		let roughBytes = 2;
		let needsExactSize = false;
		const previewValues = new Array(statement.parameters.length);
		const values = new Array(statement.parameters.length);
		for (let index = 0; index < statement.parameters.length; index++) {
			const parameter = statement.parameters[index];
			if (parameter === VIEWER) {
				previewValues[index] = viewer;
				values[index] = viewer;
				roughBytes += 50;
				continue;
			}
			if (!Object.hasOwn(params, parameter)) refuse(400, `The ${kind} takes :${parameter}`);
			const value = params[parameter];
			if (value === null) {
				previewValues[index] = null;
				values[index] = null;
				roughBytes += parameter.length + 10;
			} else if (typeof value === "string") {
				previewValues[index] = value;
				values[index] = value;
				roughBytes += parameter.length + value.length * 6 + 8;
			} else if (typeof value === "number" && Number.isFinite(value)) {
				const text = String(value);
				previewValues[index] = text;
				values[index] = text;
				roughBytes += parameter.length + text.length + 8;
			} else if (typeof value === "boolean") {
				const text = value ? "true" : "false";
				previewValues[index] = text;
				values[index] = text;
				roughBytes += parameter.length + 12;
			} else if (typeof value === "object" && this.#checkJsonParam(value)) {
				needsExactSize = true;
				const json = JSON.stringify(value);
				previewValues[index] = json;
				if (!Array.isArray(value)) {
					values[index] = json;
				} else {
					const scalar = value.every((item) => item === null || typeof item === "string" || typeof item === "boolean" || typeof item === "number");
					const n = index + 1;
					const asJson =
						!scalar ||
						new RegExp(`\\$${n}(?![0-9])\\s*::\\s*jsonb?\\b`, "i").test(statement.sql) ||
						new RegExp(`jsonb?_(?:array_elements|array_elements_text|array_length|to_recordset|populate_recordset)\\s*\\(\\s*\\$${n}(?![0-9])`, "i").test(statement.sql);
					values[index] = asJson
						? json
						: value.map((item) => (item === null ? null : typeof item === "boolean" ? (item ? "true" : "false") : String(item)));
				}
			} else {
				return refuse(400, `:${parameter} must be a JSON value`);
			}
		}
		if (needsExactSize || roughBytes > maxParamBytes || givenKeys.length > statement.parameters.length) {
			if (Buffer.byteLength(JSON.stringify(params)) > maxParamBytes)
				refuse(400, `Parameters take at most ${amount(maxParamBytes)} together`);
		}
		if (givenKeys.length > statement.parameters.length || (givenKeys.length > 0 && !givenKeys.every((given) => statement.parameters.includes(given)))) {
			for (const given of givenKeys) if (!statement.parameters.includes(given)) refuse(400, `The ${kind} takes no :${given}`);
		}
		return { values, viewer, previewValues };
	}

	async #named(kind, caller, environmentId, asked, texts, proofs = null) {
		const { folder, may } = NAMED[kind];
		if (!asked || typeof asked !== "object") refuse(400, `Name a ${kind}`);
		const { database: name, [kind]: file, params = {} } = asked;
		if (typeof name !== "string" || !DATABASE_NAME.test(name) || typeof file !== "string" || !FILE_NAME.test(file) || file.length > 60)
			refuse(400, `Name a ${kind} as <database>/<${kind}>`);
		const path = `data/${name}/${folder}/${file}.sql`;
		const proof = (proofs ?? (await this.#proven(caller, environmentId, [path]))).get(path);
		if (!proof) refuse(404, `No ${kind} ${name}/${file} that you may ${may}`);
		if (proof.bytes > this.#limits.questionTextBytes) refuse(400, `The ${kind}'s file is larger than ${this.#limits.questionTextBytes / 1024} KiB`);
		const database = companyDatabase(environmentId);
		const text = await this.#text(database, proof.sha256, texts, this.#limits.questionTextBytes);
		if (text === null) return { need: { path, sha256: proof.sha256 } };
		const statement = this.#statement(proof.sha256, text);
		if (!statement.ok) refuse(400, `${path}: ${statement.problem}`);
		const n = await this.#folder(database, name);
		if (n === null) refuse(409, `The database ${name} has no applied step yet`);
		const bound = this.#values(caller, statement, params, kind);
		return { database, name, n, sql: statement.sql, values: bound.values, viewer: bound.viewer, previewValues: bound.previewValues, sha256: proof.sha256, statement };
	}

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
		const bound = this.#values(caller, statement, params);
		return { database, name, n, sql: statement.sql, values: bound.values, viewer: bound.viewer };
	}

	/** Asks a ready question as the database folder's read role, in one read-only transaction. `ms`: the most it may
	 * take, at most a question's limit. `gone`: when it aborts, the statement is cancelled. `agent`: an agent's read,
	 * with an agent's time, rows and bytes; the watcher knows its backend while it runs. `until`: the time by which it
	 * must be over, its wait for a connection included: with none free by then it is refused (the read role's
	 * connections are few, and a call would else wait for one as long as the pool lets it), and the statement gets
	 * what is left of the time. */
	async #reading(ready, { ms = Number.POSITIVE_INFINITY, gone = null, agent = false, until = null, settings = "" }, work) {
		const cap = agent ? this.#limits.agentMs : this.#limits.questionMs;
		const maxRows = agent ? this.#limits.agentRows : this.#limits.questionRows;
		const maxBytes = agent ? this.#limits.agentBytes : this.#limits.questionBytes;
		const connecting = this.#pool(ready.database, `${ready.database}_r${ready.n}`).connect(until ?? undefined);
		const client = await (until === null ? connecting : inTime(connecting, until)).catch((error) => {
			throw storeProblem(error);
		});
		const pid = client.processID;
		if (agent) {
			this.setAgentRead(pid, 1);
			this.#onAgentRead({ pid, delta: 1 });
		}
		let lost;
		const onClientError = (error) => {
			lost ??= error;
		};
		client.on("error", onClientError);
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
			const viewerSetting =
				ready.viewer && ENVIRONMENT.test(ready.viewer) ? `; set local "qorpera.viewer" = '${ready.viewer}'` : `; set local "qorpera.viewer" = ''`;
			await client.query(
				`begin transaction read only; set local statement_timeout = ${limit}; set local timezone = 'UTC'; ` +
					`set local datestyle = 'ISO'; set local search_path = ${quoted(ready.name)}, qorpera_ext${viewerSetting}${settings}`,
			);
			const answer = await work(client, { maxRows, maxBytes });
			await client.query("rollback");
			return answer;
		} catch (error) {
			if (error instanceof Refusal || (error?.code && !/^(57P0[123]|08...)$/.test(error.code)))
				await client.query("rollback").catch((rbError) => {
					lost ??= rbError;
				});
			else lost = error;
			throw storeProblem(error);
		} finally {
			gone?.removeEventListener("abort", cancel);
			client.removeListener("error", onClientError);
			if (agent) {
				this.setAgentRead(pid, -1);
				this.#onAgentRead({ pid, delta: -1 });
			}
			this.#release(client, lost);
		}
	}

	async #readingPipelined(ready, { ms = Number.POSITIVE_INFINITY, gone = null, agent = false, until = null, settings = "" }, buildQuery) {
		const cap = agent ? this.#limits.agentMs : this.#limits.questionMs;
		const maxRows = agent ? this.#limits.agentRows : this.#limits.questionRows;
		const maxBytes = agent ? this.#limits.agentBytes : this.#limits.questionBytes;
		const connecting = this.#pool(ready.database, `${ready.database}_r${ready.n}`).connect();
		const client = await (until === null ? connecting : inTime(connecting, until)).catch((error) => {
			throw storeProblem(error);
		});
		const pid = client.processID;
		if (agent) {
			this.setAgentRead(pid, 1);
			this.#onAgentRead({ pid, delta: 1 });
		}
		let lost;
		const onClientError = (error) => {
			lost ??= error;
		};
		client.on("error", onClientError);
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
			const viewerSetting =
				ready.viewer && ENVIRONMENT.test(ready.viewer) ? `; set local "qorpera.viewer" = '${ready.viewer}'` : `; set local "qorpera.viewer" = ''`;
			const { state: prepState, needsDeallocate } = this.#preparedState(client, ready.database, ready.name);
			const existedBefore = new Set(prepState.names);
			const deallocatePrefix = needsDeallocate ? "deallocate all; " : "";
			const beginSql =
				`${deallocatePrefix}begin transaction read only; set local statement_timeout = ${limit}; set local timezone = 'UTC'; ` +
				`set local datestyle = 'ISO'; set local search_path = ${quoted(ready.name)}, qorpera_ext${viewerSetting}${settings}`;
			const spec = buildQuery(client, { maxRows, maxBytes });
			const stream = client.connection?.stream;
			let beginP;
			let queryP;
			let endP;
			stream?.cork?.();
			try {
				beginP = client.query(beginSql);
				queryP = client.query({
					...(spec.name ? { name: spec.name } : {}),
					text: spec.text,
					values: spec.values,
					rowMode: "array",
					queryMode: "extended",
					types: TEXT_TYPES,
				});
				endP = client.query("rollback");
			} finally {
				stream?.uncork?.();
			}
			const [beginRes, queryRes, endRes] = await Promise.allSettled([beginP, queryP, endP]);
			if (endRes.status === "rejected") lost = endRes.reason;
			if (beginRes.status === "rejected") {
				if (spec.name && !existedBefore.has(spec.name)) prepState.names.delete(spec.name);
				if (!lost && !(beginRes.reason instanceof Refusal) && !(beginRes.reason?.code && !/^(57P0[123]|08...)$/.test(beginRes.reason.code)))
					lost = beginRes.reason;
				throw beginRes.reason;
			}
			if (queryRes.status === "rejected") {
				const error = queryRes.reason;
				if (spec.name && (!existedBefore.has(spec.name) || error?.code === "0A000" || error?.code === "42P01" || error?.code === "42703"))
					prepState.names.delete(spec.name);
				if (!lost && !(error instanceof Refusal) && (!error?.code || /^(57P0[123]|08...)$/.test(error.code))) lost = error;
				throw error;
			}
			return { result: queryRes.value, maxRows, maxBytes };
		} finally {
			gone?.removeEventListener("abort", cancel);
			client.removeListener("error", onClientError);
			if (agent) {
				this.setAgentRead(pid, -1);
				this.#onAgentRead({ pid, delta: -1 });
			}
			this.#release(client, lost);
		}
	}

	async #ask(ready, options = {}) {
		const run = () =>
			this.#readingPipelined(ready, options, (client, { maxRows, maxBytes }) => {
				const plan = this.#askPlan(ready, maxRows, maxBytes);
				return {
					name: plan.key ? this.#preparedName(client, ready.database, ready.name, plan.key) : undefined,
					text: plan.text,
					values: ready.values,
				};
			});
		let ran;
		try {
			ran = await run();
		} catch (error) {
			if (ready.sha256 && error?.code === "0A000") {
				this.#bumpSchemaEpoch(ready.database, ready.name);
				try {
					ran = await run();
				} catch (retryError) {
					throw storeProblem(retryError);
				}
			} else {
				throw storeProblem(error);
			}
		}
		const { result, maxRows, maxBytes } = ran;
		const fields = result.fields;
		const width = fields.length - 2;
		const made = Number(result.rows[0][width + 1]);
		const given = result.rows[0][width] === null ? [] : result.rows;
		let takenBytes = 0;
		for (let r = 0; r < given.length; r++) {
			const row = given[r];
			for (let index = 0; index < width; index++) takenBytes += row[index]?.length ?? 0;
		}
		this.taken.bytes += takenBytes;
		this.taken.rows += given.length;
		let more = made > maxRows || given.length < Math.min(made, maxRows);
		const columns = new Array(width);
		const typeIds = new Array(width);
		for (let index = 0; index < width; index++) {
			columns[index] = fields[index].name;
			typeIds[index] = fields[index].dataTypeID;
		}
		const rowLimit = Math.min(given.length, maxRows);
		const rows = [];
		const rowJsons = [];
		let roughBytes = 0;
		let exactBytes = -1;
		for (let r = 0; r < rowLimit; r++) {
			const row = given[r];
			const shapedRow = new Array(width);
			for (let index = 0; index < width; index++) shapedRow[index] = shaped(row[index], typeIds[index]);
			const encoded = JSON.stringify(shapedRow);
			roughBytes += encoded.length * 3 + 1;
			if (exactBytes >= 0 || roughBytes > maxBytes) {
				if (exactBytes < 0) {
					exactBytes = 0;
					for (let j = 0; j < rowJsons.length; j++) exactBytes += Buffer.byteLength(rowJsons[j]) + 1;
				}
				exactBytes += Buffer.byteLength(encoded) + 1;
				if (exactBytes > maxBytes) {
					more = true;
					break;
				}
			}
			rows.push(shapedRow);
			rowJsons.push(encoded);
		}
		const rawBase = `{"columns":${JSON.stringify(columns)},"rows":[${rowJsons.join(",")}],"more":${more}}`;
		const etag = sha256(rawBase).slice(0, 32);
		const answer = { columns, rows, more, etag };
		answer[RAW_JSON] = rawBase;
		return answer;
	}

	#buildPageQuery(ready, shapeRows, maxBytes) {
		const columns = shapeRows.map((row, index) => ({ ...row, index }));
		const key = columns.filter((column) => column.key !== null).sort((a, b) => Number(a.key) - Number(b.key));
		const by = ready.order === null ? null : columns.find((column) => column.name === ready.order);
		if (ready.order !== null && !by) refuse(400, `No column ${ready.order} in ${ready.table}`);
		if (key.length === 0 && ready.after !== null) refuse(400, `${ready.table} has no key: it gives its first page alone`);
		const tag = this.#tag(`${ready.database}|${ready.name}|${ready.table}`);
		const [row, asked, sized, madeAs, seen, size, bytesSoFar, rowsMade] = ["row", "asked", "sized", "made", "seen", "size", "bytes", "rows"].map(
			(name) => `qorpera_${name}_${tag}`,
		);
		const ref = (column) => `${row}.${quoted(column.name)}`;
		const placed = by ? [by, ...key] : key;
		const values = [];
		const value = (column, text) => {
			values.push(text);
			return `$${values.length}::${column.type}`;
		};
		let where = "";
		if (ready.after !== null) {
			const after = ready.after;
			if (after.length !== placed.length || !after.every((one, index) => (index === 0 && by ? one === null : false) || typeof one === "string"))
				refuse(400, "after is the next a page gave, for the same order");
			const keyAfter = key.length === 0 ? "" : `(${key.map(ref).join(", ")}) ${by || !ready.desc ? ">" : "<"} (${key.map((column, index) => value(column, after[placed.length - key.length + index])).join(", ")})`;
			if (!by) where = `where ${keyAfter}`;
			else if (after[0] === null) where = `where ${ref(by)} is null and ${keyAfter}`;
			else {
				const from = value(by, after[0]);
				where = `where (${ref(by)} ${ready.desc ? "<" : ">"} ${from} or (${ref(by)} = ${from} and ${keyAfter}) or ${ref(by)} is null)`;
			}
		}
		const order = [
			...(by ? [`${ref(by)} ${ready.desc ? "desc" : "asc"} nulls last`] : []),
			...key.map((column) => `${ref(column)} ${!by && ready.desc ? "desc" : "asc"}`),
		];
		const text =
			`with ${asked} as materialized (select ${row}.*, ${SEEN(row)} as ${seen}, ` +
			`pg_catalog.octet_length(${row}::text) as ${size} from ${quoted(ready.name)}.${quoted(ready.table)} ${row} ${where} ` +
			`${order.length > 0 ? `order by ${order.join(", ")}` : ""} limit ${ready.limit + 1}), ` +
			`${sized} as (select ${asked}.*, ` +
			`sum(${asked}.${size}) over (rows between unbounded preceding and current row) as ${bytesSoFar} from ${asked}) ` +
			`select ${sized}.*, ${madeAs}.* from (select count(*) as ${rowsMade}${placed
				.map((column, index) => `, (select ${asked}.${quoted(column.name)} from ${asked} limit 1) as qorpera_first_${index}_${tag}`)
				.join("")} from ${asked}) ${madeAs} ` +
			`left join ${sized} on ${sized}.${bytesSoFar} <= ${maxBytes}`;
		return { columns, key, placed, text, values };
	}

	#formatPageResult(ready, built, result, maxBytes) {
		const { columns, key, placed } = built;
		const width = columns.length;
		const fields = result.fields.slice(0, width);
		const made = Number(result.rows[0][width + 3]);
		const given = result.rows[0][width + 2] === null ? [] : result.rows;
		for (const one of given) for (let index = 0; index < width; index++) this.taken.bytes += one[index]?.length ?? 0;
		this.taken.rows += given.length;
		let more = made > ready.limit || given.length < Math.min(made, ready.limit);
		const rows = [];
		const rowJsons = [];
		let last = null;
		let bytes = 0;
		for (const one of given.slice(0, ready.limit)) {
			const shapedRow = { values: one.slice(0, width).map((text, index) => shaped(text, fields[index].dataTypeID)), seen: one[width] };
			const encoded = JSON.stringify(shapedRow);
			bytes += Buffer.byteLength(encoded) + 1;
			if (bytes > maxBytes) {
				more = true;
				break;
			}
			rows.push(shapedRow);
			rowJsons.push(encoded);
			last = one;
		}
		const tooLarge = rows.length === 0 && made > 0;
		const next =
			!more || key.length === 0
				? null
				: last !== null
					? placed.map((column) => last[column.index])
					: placed.map((_, index) => result.rows[0][width + 4 + index]);
		const colNames = columns.map((column) => column.name);
		const keyNames = key.map((column) => column.name);
		const answer = {
			columns: colNames,
			key: keyNames,
			rows,
			more,
			...(next === null ? {} : { next }),
			...(tooLarge ? { tooLarge: true } : {}),
		};
		const tail = `${next === null ? "" : `,"next":${JSON.stringify(next)}`}${tooLarge ? ',"tooLarge":true' : ""}`;
		const rawBase = `{"columns":${JSON.stringify(colNames)},"key":${JSON.stringify(keyNames)},"rows":[${rowJsons.join(",")}],"more":${more}${tail}}`;
		const etag = sha256(rawBase).slice(0, 32);
		const out = { ...answer, etag };
		out[RAW_JSON] = rawBase;
		return out;
	}

	async #page(ready, options = {}) {
		const relKey = `${ready.database}/${ready.name}/${ready.table}`;
		const cachedShape = this.#relations.get(relKey);
		if (cachedShape) {
			let built;
			try {
				const ran = await this.#readingPipelined(ready, { ...options, settings: ROW_TEXT }, (client, { maxBytes }) => {
					built = this.#buildPageQuery(ready, cachedShape, maxBytes);
					return {
						name: this.#preparedName(client, ready.database, ready.name, built.text),
						text: built.text,
						values: built.values,
					};
				});
				options.onShape?.({ kind: cachedShape[0].kind, rls: cachedShape[0].rls === "t" });
				return this.#formatPageResult(ready, built, ran.result, ran.maxBytes);
			} catch (error) {
				if (error instanceof Refusal) throw error;
				if (error?.code === "42P01" || error?.code === "42703" || error?.code === "0A000") {
					this.#relations.delete(relKey);
					this.#bumpSchemaEpoch(ready.database, ready.name);
				} else {
					throw storeProblem(error);
				}
			}
		}
		return this.#reading(ready, { ...options, settings: ROW_TEXT }, async (client, { maxBytes }) => {
			const shape = await client.query({ text: RELATION, values: [ready.name, ready.table], types: TEXT_TYPES });
			if (shape.rows.length === 0) refuse(404, `No table ${ready.table} in ${ready.name}`);
			this.#cacheRelation(ready.database, ready.name, ready.table, shape.rows);
			options.onShape?.({ kind: shape.rows[0].kind, rls: shape.rows[0].rls === "t" });
			const built = this.#buildPageQuery(ready, shape.rows, maxBytes);
			const prepName = this.#preparedName(client, ready.database, ready.name, built.text);
			const result = await client.query({
				...(prepName ? { name: prepName } : {}),
				text: built.text,
				values: built.values,
				rowMode: "array",
				queryMode: "extended",
				types: TEXT_TYPES,
			});
			return this.#formatPageResult(ready, built, result, maxBytes);
		});
	}

	async #mayWrite(caller, environmentId, name) {
		const key = `${caller.key}|${environmentId}|write:data/${name}`;
		const kept = this.#proofs.get(key);
		if (kept && Date.now() - kept.at < this.#limits.proofMs) return kept.value;
		let pending = this.#mayWriteInFlight.get(key);
		if (!pending) {
			pending = this.#platform
				.memberMayWrite(caller.token, environmentId, `data/${name}`)
				.then((value) => {
					this.#proofs.set(key, { at: Date.now(), value });
					return value;
				})
				.finally(() => {
					if (this.#mayWriteInFlight.get(key) === pending) this.#mayWriteInFlight.delete(key);
				});
			pending.catch(() => undefined);
			this.#mayWriteInFlight.set(key, pending);
		}
		return pending;
	}

	async #folderFiles(caller, environmentId, name, texts, database, toml, { changes = true } = {}) {
		const root = `data/${name}`;
		const [questions, actions] = await Promise.all([
			this.#listedPage(caller, environmentId, `${root}/queries`, 1000),
			changes ? this.#listed(caller, environmentId, `${root}/actions`, 1000) : [],
		]);
		const queryFiles = questions.files.filter((file) => file.name.endsWith(".sql"));
		const actionFiles = actions.filter((file) => file.name.endsWith(".sql"));
		const hashes = [];
		const maxBytes = this.#limits.questionTextBytes;
		if (toml.bytes <= maxBytes) hashes.push(toml.sha256);
		for (const file of queryFiles) if (file.bytes <= maxBytes) hashes.push(file.sha256);
		for (const file of actionFiles) if (file.bytes <= maxBytes) hashes.push(file.sha256);
		const resolved = await this.#textsFor(database, hashes, texts, maxBytes);
		const need = [];
		const read = (path, file) => {
			if (file.bytes > maxBytes) return null;
			const text = resolved.get(file.sha256) ?? null;
			if (text === null) need.push({ path, sha256: file.sha256 });
			return text;
		};
		const found = {
			toml: read(`${root}/database.toml`, toml),
			questions: queryFiles.map((file) => ({ name: file.name.slice(0, -4), text: read(`${root}/queries/${file.name}`, file) })),
			changes: actionFiles.map((file) => ({ name: file.name.slice(0, -4), text: read(`${root}/actions/${file.name}`, file) })),
			cut: questions.more,
		};
		return need.length > 0 ? { need } : found;
	}

	async #mayList(caller, environmentId, name, texts) {
		const key = `${caller.key}|${environmentId}|list:${name}`;
		const kept = this.#proofs.get(key);
		if (kept && Date.now() - kept.at < this.#limits.proofMs) return kept.value;
		const path = `data/${name}/database.toml`;
		const toml = (await this.#proven(caller, environmentId, [path])).get(path);
		if (!toml) refuse(404, `No database ${name} that you may read`);
		const found = await this.#folderFiles(caller, environmentId, name, texts, companyDatabase(environmentId), toml, { changes: false });
		if (found.need) return found;
		const members = listMembers(
			found.toml,
			found.questions.map((question) => question.text),
			found.cut,
		);
		const value = { list: members === "readers" || (await this.#mayWrite(caller, environmentId, name)) };
		this.#proofs.set(key, { at: Date.now(), value });
		return value;
	}

	async #table(caller, environmentId, asked, texts, { first = false } = {}) {
		if (!asked || typeof asked !== "object" || Array.isArray(asked)) refuse(400, "Name a table");
		const { database: name, table, order = null, desc = false, limit = this.#limits.pageRowsUsual, after = null } = asked;
		if (typeof name !== "string" || !DATABASE_NAME.test(name)) refuse(400, "Name a database");
		if (typeof table !== "string" || table === "" || Buffer.byteLength(table) > 63 || table.includes("\0")) refuse(400, "Name a table");
		if (order !== null && (typeof order !== "string" || order === "" || Buffer.byteLength(order) > 63 || order.includes("\0")))
			refuse(400, "order names a column");
		if (typeof desc !== "boolean") refuse(400, "desc is true or false");
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.#limits.pageRows) refuse(400, `A page holds 1 to ${this.#limits.pageRows} rows`);
		if (after !== null && (first || !Array.isArray(after) || after.length > 33)) refuse(400, first ? "A watched table is its first page" : "after is the next a page gave");
		const right = await this.#mayList(caller, environmentId, name, texts);
		if (right.need) return right;
		if (!right.list) refuse(403, `The tables of ${name} are shown to those who may change it`);
		const database = companyDatabase(environmentId);
		const n = await this.#folder(database, name);
		if (n === null) refuse(409, `The database ${name} has no applied step yet`);
		return { database, name, n, table, order, desc, limit, after, viewer: caller.userId };
	}

	async rows(caller, environmentId, body, { gone = null } = {}) {
		const ready = await this.#table(caller, environmentId, body, body.texts);
		if (ready.need) return { need: ready.need };
		const page = await this.#page(ready, { gone });
		const asOf = isoNow();
		const out = { ...page, asOf };
		if (typeof page[RAW_JSON] === "string") out[RAW_JSON] = `${page[RAW_JSON].slice(0, -1)},"etag":"${page.etag}","asOf":"${asOf}"}`;
		return out;
	}

	async changes(caller, environmentId, body) {
		const { database: name, after = null, zone = null } = body;
		if (typeof name !== "string" || !DATABASE_NAME.test(name)) refuse(400, "Name a database");
		if (after !== null && (typeof after !== "string" || !/^[1-9][0-9]{0,18}$/.test(after))) refuse(400, "after is the next a page gave");
		if (zone !== null && (typeof zone !== "string" || !ZONE.test(zone))) refuse(400, "zone is a time zone's name");
		const right = await this.#mayList(caller, environmentId, name, body.texts);
		if (right.need) return { need: right.need };
		if (!right.list) refuse(403, `The tables of ${name} are shown to those who may change it`);
		const database = companyDatabase(environmentId);
		if ((await this.#folder(database, name)) === null) refuse(409, `The database ${name} has no applied step yet`);
		return { ...(await this.#record(database, name, after, after === null ? zone : null)), asOf: new Date().toISOString() };
	}

	async #record(database, name, after, zone) {
		const connectUntil = Date.now() + CONNECT_MS - 1_000;
		const client = await inTime(this.#pool(database, "qorpera_data_keeper", "record").connect(connectUntil), connectUntil).catch((error) => {
			throw storeProblem(error);
		});
		let lost;
		const onClientError = (error) => {
			lost ??= error;
		};
		client.on("error", onClientError);
		const until = Date.now() + this.#limits.questionMs;
		try {
			await client.query(
				`begin transaction read only; set local statement_timeout = ${Math.max(1, Math.floor(this.#limits.questionMs))}; ` +
					"set local timezone = 'UTC'; set local datestyle = 'ISO'",
			);
			const found = await client.query({
				text: CHANGES_PAGE,
				values: [
					name,
					after,
					this.#limits.changesWindow,
					this.#limits.changesWrites + 1,
					CHANGES_LINES,
					CHANGES_VALUE_BYTES,
					CHANGES_COUNTED,
					CHANGES_TABLES,
					CHANGES_COLUMNS,
				],
				types: TEXT_TYPES,
			});
			const picked = found.rows.filter((row) => row.txid !== null);
			const writes = [];
			let bytes = 0;
			let full = false;
			for (const row of picked.slice(0, this.#limits.changesWrites)) {
				const counted = JSON.parse(row.counted);
				const write = {
					at: row.at,
					by: row.by_kind,
					id: row.by_id,
					via: row.via,
					tables: (counted.tables ?? []).map((one) => ({ table: one.table, op: one.op, rows: Number(one.rows) })),
					lines: JSON.parse(row.lines ?? "[]").map((one) => ({
						table: one.table,
						op: one.op,
						rows: Number(one.rows),
						key: one.key ?? null,
						before: one.before ?? null,
						after: one.after ?? null,
						columns: one.columns ?? null,
					})),
					...(row.cut === "t" ? { more: true } : {}),
					...(row.uncounted === "t" || counted.cut ? { many: true } : {}),
				};
				bytes += Buffer.byteLength(JSON.stringify(write)) + 1;
				if (bytes > this.#limits.questionBytes && writes.length > 0) {
					full = true;
					break;
				}
				writes.push({ write, newest: row.newest });
			}
			const [stats] = found.rows;
			const next =
				full || picked.length > this.#limits.changesWrites
					? writes.at(-1).newest
					: Number(stats.looked) >= this.#limits.changesWindow
						? stats.lowest
						: null;
			let days;
			if (zone !== null) {
				await client.query(`savepoint days; set local statement_timeout = ${Math.max(1, Math.floor(until - Date.now()))}`);
				try {
					const counted = await client.query({ text: CHANGES_DAYS, values: [name, zone, this.#limits.changesDays], types: TEXT_TYPES });
					days = counted.rows.map((row) => ({ day: row.day, by: row.by_kind, id: row.by_id, rows: Number(row.rows) }));
				} catch (error) {
					if (error?.code === "22023") refuse(400, `No time zone ${zone}`);
					if (error?.code !== "57014") throw error;
					await client.query("rollback to savepoint days");
					days = null;
				}
			}
			await client.query("rollback");
			return {
				writes: writes.map((one) => one.write),
				more: next !== null,
				...(next === null ? {} : { next }),
				...(days === undefined ? {} : { days }),
			};
		} catch (error) {
			if (error instanceof Refusal || (error?.code && !/^(57P0[123]|08...)$/.test(error.code)))
				await client.query("rollback").catch((rbError) => {
					lost ??= rbError;
				});
			else lost = error;
			throw storeProblem(error);
		} finally {
			client.removeListener("error", onClientError);
			this.#release(client, lost);
		}
	}

	async query(caller, environmentId, body, { gone = null } = {}) {
		const ready = await this.#named("question", caller, environmentId, body, body.texts);
		if (ready.need) return { need: [ready.need] };
		const answer = await this.#ask(ready, { gone });
		if (typeof body.etag === "string" && body.etag === answer.etag) return { same: true, etag: answer.etag };
		const asOf = isoNow();
		const out = { ...answer, asOf };
		if (typeof answer[RAW_JSON] === "string") out[RAW_JSON] = `${answer[RAW_JSON].slice(0, -1)},"etag":"${answer.etag}","asOf":"${asOf}"}`;
		return out;
	}

	async #actorLine(database, txid, actor, { asyncCommit = false } = {}) {
		// WHY: When called from #writing, the main write tx commits with synchronous_commit = on after actorP resolves, so WAL flush covers both records in one fsync.
		const sql = asyncCommit
			? "with _ as (select pg_catalog.set_config('synchronous_commit', 'off', true)) insert into qorpera_data.change_log (txid, by_kind, by_id, via) select $1::bigint, $2, $3, $4 from _"
			: "insert into qorpera_data.change_log (txid, by_kind, by_id, via) values ($1::bigint, $2, $3, $4)";
		await this.#pool(database, "qorpera_data_keeper")
			.query(sql, [txid, actor.kind, actor.id, actor.via])
			.catch((error) => {
				throw storeProblem(error);
			});
		if (!this.#unsettled.has(database)) this.#unsettled.set(database, new Set());
		this.#unsettled.get(database).add(txid);
	}

	async #writing(ready, actor, { gone = null, settings = "", room }, work) {
		const ms = this.#limits.changeMs;
		const connectUntil = Date.now() + Math.min(ms, CONNECT_MS - 1_000);
		const client = await inTime(this.#pool(ready.database, `${ready.database}_w${ready.n}`).connect(connectUntil), connectUntil).catch((error) => {
			throw storeProblem(error);
		});
		const held = { cut: false };
		let lost;
		let discarded = false;
		const onClientError = (error) => {
			lost ??= error;
		};
		client.on("error", onClientError);
		const undone = async (status, message, extra) => {
			await client.query("rollback");
			refuse(status, message, extra);
		};
		try {
			if (gone?.aborted) refuse(499, "The caller went away");
			const full = this.#full.has(ready.database);
			const viewerSetting =
				ready.viewer && ENVIRONMENT.test(ready.viewer) ? `; set local "qorpera.viewer" = '${ready.viewer}'` : `; set local "qorpera.viewer" = ''`;
			const started = await client.query(
				`begin; set local statement_timeout = ${ms}; set local lock_timeout = ${ms}; set local timezone = 'UTC'; ` +
					`set local datestyle = 'ISO'; set local search_path = ${quoted(ready.name)}, qorpera_ext${viewerSetting}${settings}; ` +
					`select pg_catalog.txid_current()::text as txid${full ? `; ${WRITTEN}` : ""}`,
			);
			const txid = (full ? started[started.length - 2] : started[started.length - 1]).rows[0].txid;
			const before = full ? Number(started[started.length - 1].rows[0].rows) : 0;
			const actorP = this.#actorLine(ready.database, txid, actor, { asyncCommit: true });
			actorP.catch(() => undefined);
			const answer = await work(client, undone, held);
			const [checked] = await Promise.all([
				client.query(
					`set constraints all immediate; select kind, object, rows from qorpera_data.effects(); ` +
						`select table_name, problem from qorpera_data.unwatched('${ready.name}')${full ? `; ${WRITTEN}` : ""}`,
				),
				actorP,
			]);
			const effects = checked[1].rows;
			const beyond = effects.filter((effect) => effect.kind !== "deleted rows");
			if (beyond.length > 0)
				await undone(
					400,
					`A change adds, changes and deletes rows. This one also ${beyond.map((effect) => `${effect.kind} ${effect.object}`).join(", ")}, which is a step's work: nothing was changed`,
				);
			const unwatched = checked[2].rows;
			if (unwatched.length > 0)
				await undone(
					400,
					`A change may not remove or switch off Qorpera's triggers (${unwatched.map((row) => `${row.table_name} ${row.problem}`).join("; ")}): nothing was changed`,
				);
			if (full && Number(checked[3].rows[0].rows) > before)
				await undone(507, `This company's database is at its size limit of ${amount(this.#limits.companyBytes)}: ${room}`);
			const stream = client.connection?.stream;
			let commitP;
			let discardP;
			stream?.cork?.();
			try {
				commitP = client.query("commit");
				discardP = client.query("discard all");
			} finally {
				stream?.uncork?.();
			}
			const [commitRes, discardRes] = await Promise.allSettled([commitP, discardP]);
			discarded = discardRes.status === "fulfilled";
			if (discardRes.status === "rejected") lost = discardRes.reason;
			if (commitRes.status === "rejected") throw commitRes.reason;
			return answer;
		} catch (error) {
			if (held.cut)
				throw new Refusal(
					400,
					`The change gives back more than ${amount(this.#limits.changeBytes)}, so it was stopped and nothing was changed: give back less, such as only an id`,
				);
			if (error instanceof Refusal || (error?.code && !/^(57P0[123]|08...)$/.test(error.code)))
				await client.query("rollback").catch((rbError) => {
					lost ??= rbError;
				});
			else lost = error;
			throw storeProblem(error);
		} finally {
			client.removeListener("error", onClientError);
			if (!held.cut) {
				if (!lost && !discarded)
					await client.query("discard all").catch((error) => {
						lost = error;
					});
				this.#release(client, lost);
			}
		}
	}

	async #writingPipelined(ready, actor, { gone = null, room }) {
		const ms = this.#limits.changeMs;
		const client = await inTime(
			this.#pool(ready.database, `${ready.database}_w${ready.n}`).connect(),
			Date.now() + Math.min(ms, CONNECT_MS - 1_000),
		).catch((error) => {
			throw storeProblem(error);
		});
		const held = { cut: false };
		let lost;
		let discarded = false;
		const onClientError = (error) => {
			lost ??= error;
		};
		client.on("error", onClientError);
		const undone = async (status, message, extra) => {
			await client.query("rollback");
			refuse(status, message, extra);
		};
		const stream = client.connection.stream;
		let taken = 0;
		const counting = (piece) => {
			taken += piece.length;
			if (taken <= this.#limits.changeBytes || held.cut) return;
			held.cut = true;
			this.#letGo(client, true);
		};
		try {
			if (gone?.aborted) refuse(499, "The caller went away");
			const full = this.#full.has(ready.database);
			const viewerSetting =
				ready.viewer && ENVIRONMENT.test(ready.viewer) ? `; set local "qorpera.viewer" = '${ready.viewer}'` : `; set local "qorpera.viewer" = ''`;
			const beginSql =
				`begin; set local statement_timeout = ${ms}; set local lock_timeout = ${ms}; set local timezone = 'UTC'; ` +
				`set local datestyle = 'ISO'; set local search_path = ${quoted(ready.name)}, qorpera_ext${viewerSetting}; ` +
				`select pg_catalog.txid_current()::text as txid${full ? `; ${WRITTEN}` : ""}`;
			const checkSql =
				`set constraints all immediate; select kind, object, rows from qorpera_data.effects(); ` +
				`select table_name, problem from qorpera_data.unwatched('${ready.name}')${full ? `; ${WRITTEN}` : ""}`;
			// WHY: discard all runs after every write on _wN, which deallocates prepared statements on that connection.
			let beginP;
			let queryP;
			let checkP;
			let actorP = null;
			stream.on("data", counting);
			stream.cork?.();
			try {
				beginP = client.query(beginSql);
				beginP
					.then((started) => {
						const txid = (full ? started[started.length - 2] : started[started.length - 1]).rows[0].txid;
						actorP = this.#actorLine(ready.database, txid, actor, { asyncCommit: true });
						actorP.catch(() => undefined);
					})
					.catch(() => undefined);
				queryP = client.query({
					text: ready.sql,
					values: ready.values,
					rowMode: "array",
					queryMode: "extended",
					types: TEXT_TYPES,
				});
				checkP = client.query(checkSql);
			} finally {
				stream.uncork?.();
			}
			const [beginRes, queryRes, checkRes] = await Promise.allSettled([beginP, queryP, checkP]);
			stream.off("data", counting);
			if (held.cut) throw new Error("The change gave back too much");
			if (beginRes.status === "rejected") throw beginRes.reason;
			if (queryRes.status === "rejected") throw queryRes.reason;
			const result = queryRes.value;
			if (!CHANGE_COMMANDS.includes(result.command))
				await undone(400, "A change is one insert, update, delete or merge, or a select that calls a function: nothing was changed");
			if (checkRes.status === "rejected") throw checkRes.reason;
			const started = beginRes.value;
			const txid = (full ? started[started.length - 2] : started[started.length - 1]).rows[0].txid;
			const before = full ? Number(started[started.length - 1].rows[0].rows) : 0;
			const checked = checkRes.value;
			const effects = checked[1].rows;
			const beyond = effects.filter((effect) => effect.kind !== "deleted rows");
			if (beyond.length > 0)
				await undone(
					400,
					`A change adds, changes and deletes rows. This one also ${beyond.map((effect) => `${effect.kind} ${effect.object}`).join(", ")}, which is a step's work: nothing was changed`,
				);
			const unwatched = checked[2].rows;
			if (unwatched.length > 0)
				await undone(
					400,
					`A change may not remove or switch off Qorpera's triggers (${unwatched.map((row) => `${row.table_name} ${row.problem}`).join("; ")}): nothing was changed`,
				);
			if (full && Number(checked[3].rows[0].rows) > before)
				await undone(507, `This company's database is at its size limit of ${amount(this.#limits.companyBytes)}: ${room}`);
			await (actorP ?? this.#actorLine(ready.database, txid, actor, { asyncCommit: true }));
			let commitP;
			let discardP;
			stream.cork?.();
			try {
				commitP = client.query("commit");
				discardP = client.query("discard all");
			} finally {
				stream.uncork?.();
			}
			const [commitRes, discardRes] = await Promise.allSettled([commitP, discardP]);
			discarded = discardRes.status === "fulfilled";
			if (discardRes.status === "rejected") lost = discardRes.reason;
			if (commitRes.status === "rejected") throw commitRes.reason;
			return result;
		} catch (error) {
			stream.off("data", counting);
			if (held.cut)
				throw new Refusal(
					400,
					`The change gives back more than ${amount(this.#limits.changeBytes)}, so it was stopped and nothing was changed: give back less, such as only an id`,
				);
			if (error instanceof Refusal || (error?.code && !/^(57P0[123]|08...)$/.test(error.code)))
				await client.query("rollback").catch((rbError) => {
					lost ??= rbError;
				});
			else lost = error;
			throw error;
		} finally {
			client.removeListener("error", onClientError);
			if (!held.cut) {
				if (!lost && !discarded)
					await client.query("discard all").catch((error) => {
						lost = error;
					});
				this.#release(client, lost);
			}
		}
	}

	#actor(caller, via) {
		if (caller.machineId) return { kind: "machine", id: caller.agentId, via };
		if (caller.run) return { kind: "agent", id: caller.agentId, via };
		return { kind: "member", id: caller.userId, via };
	}

	async #act(ready, actor, { agent = false, gone = null } = {}) {
		const maxRows = agent ? this.#limits.agentRows : this.#limits.questionRows;
		const maxBytes = agent ? this.#limits.agentBytes : this.#limits.questionBytes;
		const opts = { gone, room: "only a change that deletes rows and writes none runs until there is room" };
		let result;
		try {
			result = await this.#writingPipelined(ready, actor, opts);
		} catch (error) {
			if (ready.sha256 && error?.code === "0A000") {
				this.#bumpSchemaEpoch(ready.database, ready.name);
				try {
					result = await this.#writingPipelined(ready, actor, opts);
				} catch (retryError) {
					throw storeProblem(retryError);
				}
			} else {
				throw storeProblem(error);
			}
		}
		const answer = result.command === "SELECT" ? {} : { changed: result.rowCount ?? 0 };
		if (result.fields.length === 0) return answer;
		const rows = [];
		let bytes = 0;
		let more = result.rows.length > maxRows;
		for (const row of result.rows.slice(0, maxRows)) {
			const shapedRow = row.map((value, index) => shaped(value, result.fields[index].dataTypeID));
			bytes += Buffer.byteLength(JSON.stringify(shapedRow)) + 1;
			if (bytes > maxBytes) {
				more = true;
				break;
			}
			rows.push(shapedRow);
		}
		return { ...answer, columns: result.fields.map((field) => field.name), rows, more };
	}

	/** A named change (§8): its file read as the caller, one statement run as the database folder's write role.
	 * `preview: true` runs nothing: it answers the file's words with the call's values in place, every value the
	 * statement takes, and the file's hash, which is what a member is shown before they say yes. `sha256`: the hash
	 * the member was shown; a file that changed since is not run. `agent`: an agent's rows and bytes for what the
	 * change gives back. */
	async change(caller, environmentId, body, { agent = false, gone = null } = {}) {
		if (body.sha256 !== undefined && (typeof body.sha256 !== "string" || !SHA.test(body.sha256))) refuse(400, "sha256 is the hash a preview gave");
		const ready = await this.#named("change", caller, environmentId, body, body.texts);
		if (ready.need) return { need: [ready.need] };
		if (body.preview === true) {
			const values = new Map(
				ready.statement.parameters.map((name, index) => [name, name === VIEWER && !caller.run ? "you" : ready.previewValues[index]]),
			);
			return {
				words: wordsWith(ready.statement.words, values),
				values: [...values].filter(([name]) => name !== VIEWER).map(([name, value]) => ({ name, value })),
				sha256: ready.sha256,
			};
		}
		if (body.sha256 !== undefined && body.sha256 !== ready.sha256) refuse(409, "The change's file was changed since it was shown: ask again");
		return { ...(await this.#act(ready, this.#actor(caller, body.change), { agent, gone })), asOf: new Date().toISOString() };
	}

	async edit(caller, environmentId, body, { gone = null } = {}) {
		const { database: name, table, op, key, values = {}, seen } = body;
		const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
		if (typeof name !== "string" || !DATABASE_NAME.test(name)) refuse(400, "Name a database");
		if (typeof table !== "string" || table === "" || Buffer.byteLength(table) > 63 || table.includes("\0")) refuse(400, "Name a table");
		if (!EDITS.includes(op)) refuse(400, "op is add, change or remove");
		if (!plain(values)) refuse(400, "values are the columns to set, by name");
		if (op === "add" && (key !== undefined || seen !== undefined)) refuse(400, "An add names no key and no seen");
		if (op !== "add" && (!plain(key) || typeof seen !== "string" || !SHA.test(seen)))
			refuse(400, `A ${op} names the row's whole key and the seen it was read with`);
		if (op === "remove" && Object.keys(values).length > 0) refuse(400, "A remove sets no values");
		if (op === "change" && Object.keys(values).length === 0) refuse(400, "A change sets at least one column");
		const right = await this.#mayList(caller, environmentId, name, body.texts);
		if (right.need) return { need: right.need };
		if (!right.list || !(await this.#mayWrite(caller, environmentId, name)))
			refuse(403, `The rows of ${name} are changed by those who may change its folder`);
		const database = companyDatabase(environmentId);
		const n = await this.#folder(database, name);
		if (n === null) refuse(409, `The database ${name} has no applied step yet`);
		const answer = await this.#writing(
			{ database, name, n, viewer: caller.userId },
			{ kind: "member", id: caller.userId, via: "list" },
			{ gone, settings: ROW_TEXT, room: "only removing a row runs until there is room" },
			(client, undone) => this.#edited(client, undone, { database, name, table, op, key, values, seen }),
		);
		return { ...answer, asOf: new Date().toISOString() };
	}

	async #edited(client, undone, { database, name, table, op, key, values, seen }) {
		const relKey = `${database}/${name}/${table}`;
		let columns = this.#relations.get(relKey);
		if (!columns) {
			columns = (await client.query({ text: RELATION, values: [name, table], types: TEXT_TYPES })).rows;
			if (columns.length > 0) this.#cacheRelation(database, name, table, columns);
		}
		if (columns.length === 0) await undone(404, `No table ${table} in ${name}`);
		if (columns[0].kind !== "r" && columns[0].kind !== "p") await undone(400, `${table} is a view: the list changes no rows of it`);
		const keyed = columns.filter((column) => column.key !== null).sort((a, b) => Number(a.key) - Number(b.key));
		if (op !== "add" && keyed.length === 0) await undone(400, `${table} has no key: its rows are added here, never changed or removed`);
		const named = new Map(columns.map((column) => [column.name, column]));
		const setting = Object.entries(values);
		for (const [column] of setting) {
			if (!named.has(column)) await undone(400, `No column ${column} in ${table}`);
			if (named.get(column).settable !== "t") await undone(400, `${column} is kept by the store: an edit does not set it`);
		}
		if (op !== "add" && (Object.keys(key).length !== keyed.length || !keyed.every((column) => Object.hasOwn(key, column.name) && key[column.name] !== null)))
			await undone(400, `A ${op} names the whole key of ${table}: ${keyed.map((column) => column.name).join(", ")}`);
		const tag = this.#tag(`${database}|${name}|${table}|edit`);
		const [row, written, seenAs, size] = ["row", "written", "seen", "size"].map((part) => `qorpera_${part}_${tag}`);
		const relation = `${quoted(name)}.${quoted(table)}`;
		const maxBytes = this.#limits.questionBytes;
		const kept = `${row}.*, ${SEEN(row)} as ${seenAs}, pg_catalog.octet_length(${row}::text) as ${size}`;
		const asked = (statement) => {
			const params = [];
			const param = (column, value) => {
				params.push(
					value === null
						? null
						: column?.json === "t"
							? JSON.stringify(value)
							: Array.isArray(value)
								? value
								: typeof value === "object"
									? JSON.stringify(value)
									: typeof value === "string"
										? value
										: String(value),
				);
				return column ? `$${params.length}::${column.base}` : `$${params.length}`;
			};
			const atKey = () =>
				`(${keyed.map((column) => `${row}.${quoted(column.name)}`).join(", ")}) = (${keyed.map((column) => param(column, key[column.name])).join(", ")})`;
			const text =
				`with ${written} as (${statement(param, atKey)}) ` +
				`select ${columns.map((column) => `case when ${written}.${size} <= ${maxBytes} then ${written}.${quoted(column.name)} end`).join(", ")}, ` +
				`${written}.${seenAs}, ${written}.${size} from ${written}`;
			return client.query({ text, values: params, rowMode: "array", queryMode: "extended", types: TEXT_TYPES });
		};
		const asRow = (result) => {
			const one = result.rows[0];
			const width = columns.length;
			if (Number(one[width + 1]) > maxBytes) return { values: null, seen: one[width], tooLarge: true };
			return { values: one.slice(0, width).map((value, index) => shaped(value, result.fields[index].dataTypeID)), seen: one[width] };
		};
		const result = await asked((param, atKey) => {
			if (op === "add")
				return `insert into ${relation} as ${row} ${
					setting.length === 0
						? "default values"
						: `(${setting.map(([column]) => quoted(column)).join(", ")}) values (${setting.map(([column, value]) => param(named.get(column), value)).join(", ")})`
				} returning ${kept}`;
			const sets = setting.map(([column, value]) => `${quoted(column)} = ${param(named.get(column), value)}`).join(", ");
			const where = `${atKey()} and ${SEEN(row)} = ${param(null, seen)}`;
			return op === "change"
				? `update ${relation} as ${row} set ${sets} where ${where} returning ${kept}`
				: `delete from ${relation} as ${row} where ${where} returning ${kept}`;
		});
		if (result.rows.length === 0 && op === "add") await undone(400, "The table's own trigger kept the row out");
		if (result.rows.length === 0) {
			const now = await asked((_, atKey) => `select ${kept} from ${relation} ${row} where ${atKey()}`);
			if (now.rows.length === 0) await undone(409, "The row is gone: it was removed since it was read", { row: null });
			const current = asRow(now);
			await undone(
				409,
				current.seen === seen ? "The table's own trigger kept the row as it was" : "The row was changed since it was read: it is as it is now",
				{ row: current },
			);
		}
		return { columns: columns.map((column) => column.name), key: keyed.map((column) => column.name), row: op === "remove" ? null : asRow(result) };
	}

	#listen(database, heard) {
		let listener = this.#listeners.get(database);
		if (!listener) {
			listener = {
				client: null,
				heard: new Set(),
				ready: null,
				failed: false,
				stopped: false,
				epoch: ++this.#listenEpoch,
				gen: 0,
				wildcardGen: 0,
				schemaGen: new Map(),
				schemaDdlGen: new Map(),
				tableGen: new Map(),
				cache: new Map(),
				viewerScoped: new Map(),
			};
			let dropped = false;
			const lost = () => {
				if (dropped) return;
				dropped = true;
				if (this.#listeners.get(database) === listener) this.#listeners.delete(database);
				listener.cache.clear();
				listener.viewerScoped.clear();
				listener.gen++;
				listener.wildcardGen = listener.gen;
				for (const tell of [...listener.heard]) tell(null);
			};
			const connectListen = async () => {
				const retryUntil = Date.now() + ROOMY_RETRY_MS;
				for (let attempt = 0; ; attempt++) {
					if (this.#closed) throw new Refusal(503, "The data store did not answer");
					if (listener.stopped) return;
					const client = new pg.Client({
						host: this.#store.host,
						port: this.#store.port,
						user: "qorpera_data_keeper",
						password: this.#store.logins.keeper,
						database,
						connectionTimeoutMillis: 5_000,
						application_name: "qorpera-data-gateway listen",
					});
					client.on("error", () => undefined);
					try {
						await client.connect();
					} catch (error) {
						await client.end().catch(() => undefined);
						const remaining = retryUntil - Date.now();
						if (this.#closed || listener.stopped || error?.code !== "53300" || remaining <= 0) throw error;
						await this.#makeRoom(database, "");
						await new Promise((resolve) => setTimeout(resolve, Math.min(remaining, Math.min(200, 50 * (attempt + 1)))));
						continue;
					}
					if (this.#closed || listener.stopped) {
						await client.end().catch(() => undefined);
						if (this.#closed) throw new Refusal(503, "The data store did not answer");
						return;
					}
					listener.client = client;
					client.on("notification", (message) => {
						const payload = typeof message?.payload === "string" ? message.payload : "";
						const dot = payload.indexOf(".");
						listener.gen++;
						let notice = null;
						if (dot > 0 && dot < payload.length - 1) {
							const schema = payload.slice(0, dot);
							const table = payload.slice(dot + 1);
							listener.schemaGen.set(schema, listener.gen);
							if (table === "*" || table === "!drop") {
								listener.schemaDdlGen.set(schema, listener.gen);
								listener.viewerScoped.delete(schema);
								this.#bumpSchemaEpoch(database, schema);
								if (table === "!drop") this.#folders.delete(`${database}/${schema}`);
								notice = { schema, table: null, ddl: true };
							} else {
								listener.tableGen.set(payload, listener.gen);
								notice = { schema, table };
							}
						} else {
							listener.wildcardGen = listener.gen;
						}
						for (const tell of [...listener.heard]) tell(notice);
					});
					client.on("error", lost);
					client.on("end", lost);
					try {
						await client.query("listen qorpera_data");
					} catch (error) {
						await client.end().catch(() => undefined);
						throw error;
					}
					return;
				}
			};
			listener.ready = connectListen();
			listener.ready.catch(lost);
			this.#listeners.set(database, listener);
		}
		listener.heard.add(heard);
		return {
			listener,
			ready: listener.ready,
			stop: () => {
				listener.heard.delete(heard);
				if (listener.heard.size === 0 && this.#listeners.get(database) === listener) {
					listener.stopped = true;
					this.#listeners.delete(database);
					listener.cache.clear();
					listener.viewerScoped.clear();
					listener.client?.end().catch(() => undefined);
				}
			},
		};
	}

	#notifySchema(database, schema) {
		this.#bumpSchemaEpoch(database, schema);
		const listener = this.#listeners.get(database);
		if (!listener) return;
		listener.gen++;
		listener.schemaGen.set(schema, listener.gen);
		listener.schemaDdlGen.set(schema, listener.gen);
		listener.viewerScoped.delete(schema);
		for (const tell of [...listener.heard]) tell({ schema, table: null });
	}

	async #schemaViewerObjects(database, schema, listener) {
		if (listener.viewerScoped.has(schema)) return listener.viewerScoped.get(schema);
		const pending = this.#pool(database, "qorpera_data_keeper")
			.query(SCHEMA_VIEWER_OBJECTS, [schema])
			.then((result) => {
				const names = new Set(result.rows.map((row) => String(row.name).toLowerCase()));
				const regex =
					names.size > 0
						? new RegExp(`(?<![A-Za-z0-9_])(?:${[...names].map(escapeRegExp).join("|")})(?![A-Za-z0-9_])`, "i")
						: null;
				return { all: false, names, regex };
			})
			.catch(() => ({ all: true, names: new Set(), regex: null }));
		listener.viewerScoped.set(schema, pending);
		const found = await pending;
		if (listener.viewerScoped.get(schema) === pending) listener.viewerScoped.set(schema, found);
		return found;
	}

	#coalescedWatch(key, left, stop, run) {
		if (stop.aborted) return Promise.reject(new Refusal(499, "The caller went away"));
		if (left < this.#limits.questionMs) return run(stop);
		let entry = this.#watchInFlight.get(key);
		if (!entry) {
			const controller = new AbortController();
			const waiters = new Set();
			const promise = run(controller.signal).finally(() => {
				if (this.#watchInFlight.get(key) === entry) this.#watchInFlight.delete(key);
			});
			promise.catch(() => undefined);
			entry = { controller, waiters, promise };
			this.#watchInFlight.set(key, entry);
		}
		entry.waiters.add(stop);
		return new Promise((resolve, reject) => {
			const onAbort = () => {
				entry.waiters.delete(stop);
				if (entry.waiters.size === 0) entry.controller.abort();
				reject(new Refusal(499, "The caller went away"));
			};
			if (stop.aborted) {
				onAbort();
				return;
			}
			stop.addEventListener("abort", onAbort, { once: true });
			entry.promise.then(
				(value) => {
					stop.removeEventListener("abort", onAbort);
					entry.waiters.delete(stop);
					resolve(value);
				},
				(error) => {
					stop.removeEventListener("abort", onAbort);
					entry.waiters.delete(stop);
					reject(error);
				},
			);
		});
	}

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
		let abortTimer = null;
		const aborted = new Promise((resolve) => {
			stop.signal.addEventListener(
				"abort",
				() => {
					abortTimer = setTimeout(() => resolve(best.changed.length > 0 ? { changed: best.changed, partial: true } : { same: true, partial: true }), 50);
				},
				{ once: true },
			);
		});
		try {
			return await Promise.race([work, aborted]);
		} finally {
			clearTimeout(timer);
			gone.removeEventListener("abort", stopped);
			stop.abort();
			if (abortTimer) clearTimeout(abortTimer);
			work.catch(() => undefined);
		}
	}

	async #watching(caller, environmentId, body, stop, deadline, holdUntil, found) {
		const watches = body.watches;
		const paths = watches
			.filter((watched) => watched && typeof watched === "object" && typeof watched.database === "string" && typeof watched.question === "string" && watched.table === undefined)
			.map((watched) => `data/${watched.database}/queries/${watched.question}.sql`)
			.filter((path) => /^data\/[a-z][a-z0-9_]{0,39}\/queries\/[a-z0-9-]{1,60}\.sql$/.test(path));
		const proofs = await this.#proven(caller, environmentId, [...new Set(paths)]);
		const ready = [];
		const need = [];
		for (const watched of watches) {
			if (stop.aborted) return { same: true, partial: true };
			if (watched?.table !== undefined && watched.question !== undefined) refuse(400, "A watch names a question or a table");
			const one =
				watched?.table !== undefined
					? await this.#table(caller, environmentId, watched, body.texts, { first: true })
					: await this.#named("question", caller, environmentId, watched, body.texts, proofs);
			if (one.need) need.push(...[one.need].flat());
			ready.push(one);
		}
		if (need.length > 0) return { need };
		const place = sha256(JSON.stringify([caller.userId, environmentId, watches.map((watched) => [watched.database, watched.question ?? null, watched.table ?? null, watched.params ?? {}, watched.order ?? null, watched.desc ?? false, watched.limit ?? null])]));
		if (this.#resume.size > 1_000) {
			const now = Date.now();
			for (const [key, kept] of this.#resume) if (now - kept.at > 300_000) this.#resume.delete(key);
		}
		let start = this.#resume.get(place)?.start ?? 0;
		if (start >= ready.length) start = 0;
		const database = companyDatabase(environmentId);
		if (stop.aborted) return { same: true, partial: true };
		const tableMeta = new Map();
		const dirty = new Set();
		let wake = () => undefined;
		const listening = this.#listen(database, (notice) => {
			let matched = false;
			for (let index = 0; index < ready.length; index++) {
				if (notice === null) {
					dirty.add(index);
					matched = true;
					continue;
				}
				const item = ready[index];
				if (item.name !== notice.schema) continue;
				if (item.table !== undefined && notice.table !== null) {
					const meta = tableMeta.get(index);
					if (meta && (meta.kind === "r" || meta.kind === "p") && item.table !== notice.table) continue;
				}
				dirty.add(index);
				matched = true;
			}
			if (matched) wake();
		});
		const onStop = () => listening.stop();
		stop.addEventListener("abort", onStop, { once: true });
		const { listener } = listening;
		const differing = async (subset = null) => {
			const order = subset === null ? ready.map((_, step) => (start + step) % ready.length) : subset;
			const asked = new Set();
			const changed = [];
			let next = 0;
			const worker = async () => {
				while (next < order.length && !stop.aborted) {
					const index = order[next++];
					const left = deadline - Date.now();
					if (left <= 0) return;
					try {
						const item = ready[index];
						const isTable = item.table !== undefined;
						const schemaObjs = await this.#schemaViewerObjects(database, item.name, listener);
						if (stop.aborted) return;
						let knownMeta = isTable ? tableMeta.get(index) : null;
						if (isTable && !knownMeta) {
							const rel = this.#relations.get(`${database}/${item.name}/${item.table}`);
							if (rel?.length) {
								knownMeta = { kind: rel[0].kind, rls: rel[0].rls === "t" };
								tableMeta.set(index, knownMeta);
							}
						}
						const itemViewerScoped = schemaObjs.all
							? true
							: isTable
								? knownMeta && (knownMeta.kind === "r" || knownMeta.kind === "p")
									? knownMeta.rls
									: schemaObjs.names.has(item.table.toLowerCase())
								: item.statement.parameters.includes(VIEWER) ||
									/qorpera\.viewer|qorpera_data\.viewer|current_setting/i.test(item.sql) ||
									(schemaObjs.regex !== null && schemaObjs.regex.test(item.sql));
						const scope = itemViewerScoped ? caller.userId : "*";
						const baseKey = isTable
							? `t|${database}|${item.name}|${scope}|${item.table}|${item.order ?? ""}|${item.desc ? 1 : 0}|${item.limit}|${this.#limits.questionBytes}`
							: `q|${database}|${item.name}|${scope}|${item.sha256}|${JSON.stringify(item.values)}|${this.#limits.questionRows}|${this.#limits.questionBytes}`;
						const itemGen = isTable
							? Math.max(listener.wildcardGen, listener.schemaDdlGen.get(item.name) ?? 0, listener.tableGen.get(`${item.name}.${item.table}`) ?? 0)
							: Math.max(listener.wildcardGen, listener.schemaGen.get(item.name) ?? 0);
						const cacheable = !itemViewerScoped && (isTable || !VOLATILE_SQL.test(item.sql));
						let answer;
						const cached = cacheable ? listener.cache.get(baseKey) : undefined;
						if (cached && cached.epoch === listener.epoch && cached.gen >= itemGen) {
							if (isTable && cached.meta) tableMeta.set(index, cached.meta);
							answer = cached.answer;
						} else {
							const beforeGen = listener.gen;
							const runKey = `${baseKey}@e${listener.epoch}g${itemGen}`;
							let meta = null;
							const fetched = await this.#coalescedWatch(runKey, left, stop, async (gone) => {
								if (isTable) {
									let shape = null;
									const page = await this.#page(item, {
										ms: left,
										gone,
										onShape: (seen) => {
											shape = seen;
										},
									});
									return { answer: page, meta: shape };
								}
								return { answer: await this.#ask(item, { ms: left, gone }), meta: null };
							});
							answer = fetched.answer;
							meta = fetched.meta;
							if (isTable && meta) {
								tableMeta.set(index, meta);
								if ((meta.kind === "r" || meta.kind === "p") && !meta.rls && cacheable) {
									if (listener.cache.size >= 512) listener.cache.delete(listener.cache.keys().next().value);
									listener.cache.set(baseKey, { epoch: listener.epoch, gen: beforeGen, answer, meta });
								}
							} else if (!isTable && cacheable) {
								if (listener.cache.size >= 512) listener.cache.delete(listener.cache.keys().next().value);
								listener.cache.set(baseKey, { epoch: listener.epoch, gen: beforeGen, answer, meta: null });
							}
						}
						asked.add(index);
						if (answer.etag !== watches[index].etag) {
							changed.push({ index, answer: { ...answer, asOf: new Date().toISOString() } });
							found({ changed: [...changed].sort((a, b) => a.index - b.index) });
						}
					} catch (error) {
						if (stop.aborted || Date.now() >= deadline || (error.status === 408 && left < this.#limits.questionMs)) return;
						throw error;
					}
				}
			};
			await Promise.all(Array.from({ length: Math.min(WATCH_WORKERS, POOL_SIZE.r, order.length) }, worker));
			const missed = order.find((index) => !asked.has(index));
			if (missed === undefined) this.#resume.delete(place);
			else {
				if (this.#resume.size > 10_000) this.#resume.clear();
				this.#resume.set(place, { start: missed, at: Date.now() });
				start = missed;
			}
			return { changed: changed.sort((a, b) => a.index - b.index), partial: missed !== undefined };
		};
		try {
			const ready = listening.ready.catch((error) => {
				if (stop.aborted) return;
				throw storeProblem(error);
			});
			let wakeReady;
			try {
				await Promise.race([
					ready,
					new Promise((resolve) => {
						wakeReady = resolve;
						if (stop.aborted) resolve();
						else stop.addEventListener("abort", resolve, { once: true });
					}),
				]);
			} finally {
				stop.removeEventListener("abort", wakeReady);
			}
			if (stop.aborted) return { same: true, partial: true };
			const settleDirty = async (current) => {
				if (current.changed.length === 0 || current.partial || dirty.size === 0 || stop.aborted || Date.now() >= deadline) return current;
				const seen = new Set(current.changed.map((one) => one.index));
				const trailing = [...dirty].filter((index) => !seen.has(index)).sort((a, b) => a - b);
				dirty.clear();
				if (trailing.length === 0) return current;
				const more = await differing(trailing);
				if (more.changed.length === 0 && !more.partial) return current;
				const merged = new Map(current.changed.map((one) => [one.index, one]));
				for (const one of more.changed) merged.set(one.index, one);
				return {
					changed: [...merged.values()].sort((a, b) => a.index - b.index),
					partial: current.partial || more.partial,
				};
			};
			let scan = await settleDirty(await differing());
			while (scan.changed.length === 0 && !scan.partial && Date.now() < holdUntil && !stop.aborted && !this.#closed) {
				if (dirty.size === 0)
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
				if (dirty.size === 0 || stop.aborted) break;
				const batch = [...dirty].sort((a, b) => a - b);
				dirty.clear();
				scan = await settleDirty(await differing(batch));
				if (scan.changed.length === 0 && !scan.partial) await new Promise((resolve) => setTimeout(resolve, this.#limits.watchAgainMs));
			}
			const partial = scan.partial ? { partial: true } : {};
			return scan.changed.length > 0 ? { changed: scan.changed, ...partial } : { same: true, ...partial };
		} finally {
			stop.removeEventListener("abort", onStop);
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
	 * live in the folder was put there by someone the folder let write it. A step that would destroy data is held, and
	 * its answer carries `allow`, what a member's yes is for. It is applied only for a run whose pass carries that very
	 * `allow` (a member said yes on its card, and the platform kept it in the pass), and only while the step's text and
	 * what it destroys are still what the member was shown.
	 * `check: <allow>` applies nothing: it runs the held step named, which must be the next to apply, rolls it back
	 * and answers `{ step, destroys }` when both are still as `allow` says. That is what the card shows. */
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
		const check = body.check === undefined ? null : TICKET.exec(typeof body.check === "string" ? body.check : "");
		if (body.check !== undefined) {
			if (!check) refuse(400, "check is a held step's allow");
			const [, stepName, stepSha] = check;
			if (applied.has(stepName)) refuse(409, `Step ${stepName} is applied already`);
			const step = waiting.find((one) => one.name === stepName);
			if (!step) refuse(404, `No step ${stepName} in ${root}/tables`);
			if (waiting[0] !== step) refuse(409, `Step ${waiting[0].name} waits before ${stepName}: apply the steps before it first`);
			if (step.sha256 !== stepSha) refuse(409, `Step ${stepName} was changed since it was held: apply again to see what it would destroy now`);
			const text = await this.#text(database, step.sha256, body.texts, this.#limits.stepTextBytes);
			if (text === null) return { need: [{ path: `${root}/tables/${step.name}.sql`, sha256: step.sha256 }] };
			const outcome = await this.#step(database, name, n, step, text, { dry: true });
			if (outcome.state === "failed") refuse(400, `Step ${stepName} fails: ${outcome.detail}`);
			if (outcome.allow === undefined) refuse(409, `Step ${stepName} destroys nothing now: apply it without allow`);
			if (outcome.allow !== body.check) refuse(409, `What step ${stepName} would destroy changed since it was held: apply again to see it`);
			return { step: stepName, destroys: outcome.destroys };
		}
		const need = [];
		const texts = new Map();
		const resolved = await this.#textsFor(
			database,
			waiting.map((step) => step.sha256),
			body.texts,
			this.#limits.stepTextBytes,
		);
		for (const step of waiting) {
			const text = resolved.get(step.sha256) ?? null;
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
			const outcome = await this.#step(database, name, n, step, texts.get(step.name), {
				allow: caller.allow ?? null,
				actor: { kind: "step", id: caller.run ? caller.agentId : caller.userId, via: step.name },
			});
			results.push(outcome);
			if (outcome.state !== "applied") break;
		}
		return { applied: results.every((result) => result.state === "applied" || result.state === "already"), results };
	}

	/** One step in one transaction, as the database folder's owner role: kept only if it destroyed nothing, or if what
	 * it destroyed is exactly what `allow` says a member said yes to (the step, its text's hash, and the hash of what it
	 * destroys). `dry`: nothing is kept; the answer says what the step would destroy, with the `allow` for it. */
	async #step(database, name, n, step, text, { allow = null, dry = false, actor = null } = {}) {
		const client = await this.#pool(database, `${database}_o${n}`).connect();
		let lost;
		const onClientError = (error) => {
			lost ??= error;
		};
		client.on("error", onClientError);
		const rollback = () =>
			client.query("rollback").catch((rbError) => {
				lost ??= rbError;
			});
		try {
			await client.query(
				`begin; set local lock_timeout = ${this.#limits.stepLockMs}; set local statement_timeout = ${this.#limits.stepMs}; ` +
					`set local search_path = ${quoted(name)}, qorpera_ext`,
			);
			if (!dry) await this.#actorLine(database, (await client.query("select pg_catalog.txid_current()::text as txid")).rows[0].txid, actor);
			try {
				await client.query({ text: "select qorpera_data.apply_step($1)", values: [text], queryMode: "extended" });
			} catch (error) {
				await rollback();
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
				await rollback();
				return { name: step.name, state: "failed", detail: storeProblem(error).message, ...storeProblem(error).extra };
			}
			const effects = (await client.query("select kind, object, rows from qorpera_data.seal()")).rows;
			const unwatched = (await client.query("select table_name, problem from qorpera_data.unwatched($1)", [name])).rows;
			if (unwatched.length > 0) {
				await rollback();
				return {
					name: step.name,
					state: "failed",
					detail: `A step may not remove or switch off Qorpera's triggers: ${unwatched.map((row) => `${row.table_name} ${row.problem}`).join("; ")}`,
				};
			}
			const destroys = effects.map((effect) => ({ what: effect.kind, object: effect.object, ...(effect.rows === null ? {} : { rows: Number(effect.rows) }) }));
			// A yes is for the step by name, its text and all it destroys, counted rows included: the hash of each.
			const ticket =
				destroys.length === 0
					? null
					: `${step.name}.${step.sha256}.${sha256(JSON.stringify(destroys.map((one) => [one.what, one.object, one.rows ?? null])))}`;
			if (dry) {
				await rollback();
				return { name: step.name, state: ticket ? "held" : "harmless", ...(ticket ? { destroys, allow: ticket } : {}) };
			}
			if (ticket && allow !== ticket) {
				await rollback();
				return {
					name: step.name,
					state: "held",
					detail:
						allow && TICKET.exec(allow)?.[1] === step.name
							? "It would destroy data, and not what a member said yes to: it waits for a new yes"
							: "It would destroy data, which waits for a member",
					destroys,
					allow: ticket,
				};
			}
			await client.query("select qorpera_data.record_step($1, $2, $3)", [name, step.name, step.sha256]);
			await client.query("select pg_catalog.pg_notify('qorpera_data', $1)", [`${name}.*`]);
			try {
				await client.query("commit");
			} catch (error) {
				// The seal stopped something that destroys at commit (or commit failed otherwise): the step and its record
				// are rolled back, and the data is as it was.
				await rollback();
				const told = storeProblem(error);
				return { name: step.name, state: "failed", detail: told.message, ...told.extra };
			}
			this.#notifySchema(database, name);
			return { name: step.name, state: "applied", ...(ticket ? { destroyed: destroys } : {}) };
		} catch (error) {
			await rollback();
			throw storeProblem(error);
		} finally {
			client.removeListener("error", onClientError);
			this.#release(client, lost);
		}
	}

	/** A database folder as it stands in the store: its tables and columns, its applied steps, its size. */
	async describe(caller, environmentId, body) {
		const asked = body.database ?? null;
		if (asked !== null && (typeof asked !== "string" || !DATABASE_NAME.test(asked))) refuse(400, "Name a database");
		const names =
			asked !== null
				? [asked]
				: (await this.#platform.memberFolders(caller.token, environmentId, "data", 1000)).filter((name) => DATABASE_NAME.test(name)).sort();
		const tomls = await this.#proven(
			caller,
			environmentId,
			names.map((name) => `data/${name}/database.toml`),
		);
		const readable = names.filter((name) => tomls.get(`data/${name}/database.toml`));
		if (asked !== null && readable.length === 0) refuse(404, `No database ${asked} that you may read`);
		const database = companyDatabase(environmentId);
		const exists = await this.#companyExists(database);
		const folderResults = await mapBounded(readable, DESCRIBE_CONCURRENCY, (name) =>
			this.#folderFiles(caller, environmentId, name, body.texts, exists ? database : null, tomls.get(`data/${name}/database.toml`)),
		);
		const found = [];
		const need = [];
		for (let i = 0; i < readable.length; i++) {
			const files = folderResults[i];
			if (files.need) need.push(...files.need);
			else found.push([readable[i], files]);
		}
		if (need.length > 0) return { need };
		const countUntil = Date.now() + this.#limits.countMs;
		const [databases, companyBytes] = await Promise.all([
			mapBounded(found, DESCRIBE_CONCURRENCY, async ([name, files]) => {
				const write = await this.#mayWrite(caller, environmentId, name);
				const list = write || listMembers(files.toml, files.questions.map((question) => question.text), files.cut) === "readers";
				const n = list && exists ? await this.#folder(database, name) : null;
				const stored = n === null ? { applied: [], tables: [] } : await this.#stored(database, name, n, countUntil);
				return {
					database: name,
					name: tomlWord(files.toml, "name"),
					about: tomlWord(files.toml, "about"),
					write,
					list,
					...(list ? { applied: stored.applied.map((step) => ({ name: step.name, at: step.at })), tables: stored.tables } : {}),
					questions: namedFiles(files.questions),
					changes: namedFiles(files.changes),
				};
			}),
			exists ? this.#ownBytes(database) : 0,
		]);
		return { databases, companyBytes, limitBytes: this.#limits.companyBytes };
	}

	async #ownBytes(database) {
		const size = await this.#pool(database, "qorpera_data_keeper")
			.query(OWN_SIZE)
			.catch((error) => {
				throw storeProblem(error);
			});
		return Number(size.rows[0].bytes);
	}

	async #stored(database, name, n, until) {
		const pool = this.#pool(database, "qorpera_data_keeper");
		const [steps, columns] = await Promise.all([
			pool.query("select name, sha256, applied_at from qorpera_data.steps where database = $1 order by name", [name]),
			pool.query(
				`select c.relname as table, a.attname as column, pg_catalog.format_type(a.atttypid, a.atttypmod) as type,
					c.relkind as kind, c.relpages as pages, c.reltuples::bigint as estimate,
					a.attgenerated <> '' or a.attidentity = 'a' as fixed,
					(select k.n from unnest(i.indkey::int2[]) with ordinality k(attnum, n) where k.attnum = a.attnum) as key
				from pg_catalog.pg_class c join pg_catalog.pg_namespace s on s.oid = c.relnamespace and s.nspname = $1
				join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
				left join pg_catalog.pg_index i on i.indrelid = c.oid and i.indisprimary
				where c.relkind in ('r', 'p', 'v', 'm') order by c.relname, a.attnum`,
				[name],
			),
		]).catch((error) => {
			throw storeProblem(error);
		});
		const tables = new Map();
		for (const row of columns.rows) {
			if (!tables.has(row.table))
				tables.set(row.table, { name: row.table, kind: row.kind, pages: Number(row.pages), estimate: Number(row.estimate), counted: null, key: [], columns: [] });
			const table = tables.get(row.table);
			const settable = (table.kind === "r" || table.kind === "p") && !row.fixed;
			table.columns.push({ name: row.column, type: row.type, settable });
			if (row.key !== null) table.key[Number(row.key) - 1] = row.column;
		}
		await this.#count(database, name, n, [...tables.values()], until);
		return {
			applied: steps.rows.map((row) => ({ name: row.name, sha256: row.sha256, at: row.applied_at.toISOString() })),
			tables: [...tables.values()].map((table) => ({
				name: table.name,
				kind: table.kind === "r" || table.kind === "p" ? "table" : "view",
				key: table.key,
				...(table.counted !== null
					? { rows: table.counted }
					: table.estimate >= 0 && table.kind !== "v"
						? { rowsAbout: table.estimate }
						: {}),
				columns: table.columns,
			})),
		};
	}

	async #count(database, name, n, tables, until) {
		if (tables.length === 0 || until - Date.now() < 1 || this.#closed) return;
		const folderKey = `${database}:${name}:${n}`;
		let pending = tables;
		while (pending.length > 0 && until - Date.now() >= 1 && !this.#closed) {
			const existing = this.#inFlightCounts.get(folderKey);
			if (existing) {
				const left = until - Date.now();
				if (left < 1) return;
				let timer;
				await Promise.race([
					existing.done,
					new Promise((resolve) => {
						timer = setTimeout(resolve, left);
						timer.unref?.();
					}),
				]);
				clearTimeout(timer);
				for (const table of pending) {
					const rows = existing.counts.get(table.name);
					if (rows !== undefined) table.counted = rows;
				}
				if (until - Date.now() < 1 || this.#closed) return;
				pending = pending.filter((table) => !existing.attempted.has(table.name));
				if (pending.length === 0) return;
				const allCovered = pending.every((table) => existing.requested.has(table.name));
				if (allCovered && (existing.failed || existing.until >= until)) return;
				continue;
			}
			// WHY: Coalesce concurrent counts per schema and cap company-wide counts so describe bursts never starve live pools.
			const run = {
				until,
				requested: new Set(pending.map((table) => table.name)),
				attempted: new Set(),
				counts: new Map(),
				failed: false,
				done: null,
			};
			const work = this.#countOnce(database, name, n, pending, until, run).finally(() => {
				if (this.#inFlightCounts.get(folderKey) === run) this.#inFlightCounts.delete(folderKey);
			});
			run.done = work.catch(() => undefined);
			this.#inFlightCounts.set(folderKey, run);
			await work;
			return;
		}
	}

	async #countOnce(database, name, n, tables, until, run) {
		const releaseCompany = await acquirePermit(this.#companyCountGates, database, COUNT_COMPANY_CONCURRENCY, until);
		if (!releaseCompany) return;
		let client;
		let lost;
		try {
			const rank = (table) => (table.kind === "v" ? 2 : table.kind === "p" ? 1 : 0);
			const order = [...tables].sort((a, b) => rank(a) - rank(b) || a.pages - b.pages || (a.name < b.name ? -1 : 1));
			try {
				client = await inTime(this.#pool(database, `${database}_r${n}`).connect(until), until);
			} catch (error) {
				if (storeProblem(error) instanceof Refusal) {
					if (Date.now() < until) run.failed = true;
					return;
				}
				throw error;
			}
			if (until - Date.now() < 1) return;
			await client.query(
				`begin transaction read only; set local timezone = 'UTC'; set local datestyle = 'ISO'; set local search_path = ${quoted(name)}`,
			);
			const isFatal = (error) => !error?.code || /^(57P0[123]|08...)$/.test(error.code);
			const countOne = async (table) => {
				const left = until - Date.now();
				if (left < 1) return false;
				const limit = Math.max(1, Math.floor(Math.min(this.#limits.questionMs, left)));
				const lockLimit = Math.min(limit, COUNT_LOCK_MAX_MS);
				await client.query(
					`savepoint qorpera_count; set local statement_timeout = ${limit}; set local lock_timeout = ${lockLimit}`,
				);
				try {
					const answer = await client.query({
						text: `select count(*) from ${quoted(name)}.${quoted(table.name)}`,
						rowMode: "array",
						types: TEXT_TYPES,
					});
					await client.query("release savepoint qorpera_count");
					run.attempted.add(table.name);
					const rows = Number(answer.rows[0]?.[0]);
					if (Number.isSafeInteger(rows) && rows >= 0) {
						table.counted = rows;
						run.counts.set(table.name, rows);
					}
					return true;
				} catch (error) {
					if (isFatal(error)) {
						lost = error;
						run.failed = true;
						return false;
					}
					if (error?.code !== "57014" || limit >= this.#limits.questionMs) run.attempted.add(table.name);
					await client.query("rollback to savepoint qorpera_count; release savepoint qorpera_count");
					return true;
				}
			};
			let idx = 0;
			while (idx < order.length && until - Date.now() >= 1) {
				if (order[idx].kind === "r" && order[idx].pages <= COUNT_SMALL_PAGES) {
					const batch = [];
					while (
						idx < order.length &&
						batch.length < COUNT_BATCH_SIZE &&
						order[idx].kind === "r" &&
						order[idx].pages <= COUNT_SMALL_PAGES
					) {
						batch.push(order[idx++]);
					}
					if (batch.length === 1) {
						if (!(await countOne(batch[0]))) break;
						continue;
					}
					const left = until - Date.now();
					if (left < 1) break;
					const batchLimit = Math.max(1, Math.floor(Math.min(this.#limits.questionMs, left / 2, COUNT_BATCH_MAX_MS)));
					await client.query(
						`savepoint qorpera_count; set local statement_timeout = ${batchLimit}; set local lock_timeout = ${batchLimit}`,
					);
					try {
						const answer = await client.query({
							text: `select ${batch.map((table) => `(select count(*) from ${quoted(name)}.${quoted(table.name)})`).join(", ")}`,
							rowMode: "array",
							types: TEXT_TYPES,
						});
						await client.query("release savepoint qorpera_count");
						const row = answer.rows[0];
						for (let i = 0; i < batch.length; i++) {
							run.attempted.add(batch[i].name);
							const rows = Number(row?.[i]);
							if (Number.isSafeInteger(rows) && rows >= 0) {
								batch[i].counted = rows;
								run.counts.set(batch[i].name, rows);
							}
						}
					} catch (error) {
						if (isFatal(error)) {
							lost = error;
							run.failed = true;
							break;
						}
						await client.query("rollback to savepoint qorpera_count; release savepoint qorpera_count");
						let keepGoing = true;
						for (const table of batch) {
							if (!(await countOne(table))) {
								keepGoing = false;
								break;
							}
						}
						if (!keepGoing) break;
					}
				} else {
					if (!(await countOne(order[idx++]))) break;
				}
			}
			if (!lost) await client.query("rollback").catch(() => undefined);
		} catch (error) {
			run.failed = true;
			if (client) {
				if (error?.code && !/^(57P0[123]|08...)$/.test(error.code)) await client.query("rollback").catch(() => undefined);
				else lost = error;
			} else if (!(storeProblem(error) instanceof Refusal)) {
				throw error;
			}
		} finally {
			if (client) this.#release(client, lost);
			releaseCompany();
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
	 * gone), its tables and columns, its questions and its changes with their words; and the company database's size
	 * against its limit. The texts it does not hold come from the caller, as for a question. */
	async runDescribe(caller, environmentId, body) {
		const asked = body.database ?? null;
		if (asked !== null && (typeof asked !== "string" || !DATABASE_NAME.test(asked))) refuse(400, "Name a database");
		const names = [...caller.files.keys()].map((path) => TOML_PATH.exec(path)?.[1]).filter((name) => name !== undefined);
		if (asked !== null && !names.includes(asked)) refuse(404, `No database ${asked} that you may read`);
		const wanted = (asked === null ? names : [asked]).sort();
		const database = companyDatabase(environmentId);
		const exists = await this.#companyExists(database);
		const wantedFiles = [];
		for (const name of wanted) {
			for (const [path, file] of caller.files) {
				const within = path.startsWith(`data/${name}/`) ? path.slice(`data/${name}/`.length) : "";
				if (within !== "database.toml" && !/^(queries|actions)\/[^/]+\.sql$/.test(within)) continue;
				if (file.bytes > this.#limits.questionTextBytes) continue;
				wantedFiles.push({ path, sha256: file.sha256 });
			}
		}
		const resolvedTexts = await this.#textsFor(
			exists ? database : null,
			wantedFiles.map((item) => item.sha256),
			body.texts,
			this.#limits.questionTextBytes,
		);
		const texts = new Map();
		const need = [];
		for (const item of wantedFiles) {
			const text = resolvedTexts.get(item.sha256) ?? null;
			if (text === null) need.push(item);
			else texts.set(item.path, text);
		}
		if (need.length > 0) return { need };
		// One call's counts share one time, however many databases it shows.
		const countUntil = Date.now() + this.#limits.countMs;
		const [companyBytes, databases] = await Promise.all([
			exists ? this.#ownBytes(database) : 0,
			mapBounded(wanted, DESCRIBE_CONCURRENCY, async (name) => {
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
				// A question's or a change's words, and its parameters when it reads as one statement; a file larger than one
				// may be has neither.
				const named = (folder) =>
					[...caller.files]
						// The files directly in the folder, as their texts were asked for: one in a folder below is no question.
						.filter(([path]) => path.startsWith(`${root}/${folder}/`) && /^[^/]+\.sql$/.test(path.slice(`${root}/${folder}/`.length)))
						.map(([path]) => {
							const text = texts.get(path);
							const statement = text === undefined ? null : readStatement(text);
							return {
								name: path.slice(`${root}/${folder}/`.length, -4),
								words: text === undefined ? null : leadingWords(text).join(" "),
								parameters: statement?.ok ? statement.parameters : null,
								...(statement && !statement.ok ? { problem: statement.problem } : {}),
							};
						})
						.sort((a, b) => (a.name < b.name ? -1 : 1));
				return {
					database: name,
					name: tomlWord(toml, "name"),
					about: tomlWord(toml, "about"),
					steps: {
						applied: stored.applied.filter((step) => live.get(step.name) === step.sha256).map((step) => ({ name: step.name, at: step.at })),
						waiting: steps.filter((step) => !applied.has(step.name)).map((step) => step.name),
						changed: stored.applied.filter((step) => live.has(step.name) && live.get(step.name) !== step.sha256).map((step) => step.name),
						missing: stored.applied.filter((step) => !live.has(step.name)).map((step) => step.name),
					},
					tables: stored.tables,
					questions: named("queries"),
					changes: named("actions"),
				};
			}),
		]);
		return { databases, companyBytes, limitBytes: this.#limits.companyBytes };
	}

	/** data_query (§6): a question by name or a read of the run's own, with an agent's limits. */
	async runQuery(caller, environmentId, body, { gone = null } = {}) {
		if (body.sql !== undefined && body.question !== undefined) refuse(400, "Ask a question or give a read, not both");
		const ready =
			body.sql !== undefined ? await this.#ownRead(caller, environmentId, body) : await this.#named("question", caller, environmentId, body, body.texts);
		if (ready.need) return { need: [ready.need] };
		const { columns, rows, more } = await this.#ask(ready, { agent: true, gone });
		return { columns, rows, more, asOf: new Date().toISOString() };
	}

	/** data_change (§8): a named change, with an agent's rows and bytes for what it gives back. */
	runChange(caller, environmentId, body, { gone = null } = {}) {
		return this.change(caller, environmentId, body, { agent: true, gone });
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
			const near = [];
			const full = new Set();
			const candidates = sizes.rows.filter((row) => Number(row.bytes) >= NEAR_SHARE * this.#limits.companyBytes);
			const records = await mapBounded(candidates, DESCRIBE_CONCURRENCY, (row) =>
				this.#pool(row.database, "qorpera_data_keeper")
					.query(`select ${RECORD_SIZE} as bytes`)
					.then((answer) => Number(answer.rows[0].bytes))
					.catch(() => 0),
			);
			for (let i = 0; i < candidates.length; i++) {
				const row = candidates[i];
				const whole = Number(row.bytes);
				const record = records[i];
				if (whole - record >= NEAR_SHARE * this.#limits.companyBytes) near.push(row.database);
				if (whole - record >= this.#limits.companyBytes) full.add(row.database);
			}
			this.#full = full;
			const unforgotten = await this.#settle(sizes.rows.map((row) => row.database));
			return {
				ended: ended.rows
					.filter((row) => row.ended)
					.map((row) => ({ pid: row.pid, login: row.login, database: row.database, how: row.terminated ? "terminated" : "cancelled" })),
				full: [...this.#full],
				near,
				unforgotten,
			};
		} catch (error) {
			throw storeProblem(error);
		}
	}

	async #settle(databases) {
		const now = Date.now();
		const unforgotten = [];
		const active = databases
			.map((database) => ({
				database,
				sweep: now - (this.#swept.get(database) ?? Number.NEGATIVE_INFINITY) >= this.#limits.sweepMs,
				waiting: [...(this.#unsettled.get(database) ?? [])],
			}))
			.filter((entry) => entry.sweep || entry.waiting.length > 0);
		const results = await mapBounded(active, DESCRIBE_CONCURRENCY, async ({ database, sweep, waiting }) => {
			const keeper = this.#pool(database, "qorpera_data_keeper");
			let forgotFailed = false;
			const looked = await keeper
				.query(SETTLE, [sweep ? null : waiting])
				.then(async (answer) => {
					if (sweep) {
						await keeper.query(FORGET, [this.#limits.recordDays]).catch((error) => {
							if (error?.code !== "42883") forgotFailed = true;
						});
						await keeper.query(UNROWED);
					}
					return answer;
				})
				.catch(() => null);
			return { database, sweep, waiting, looked, forgotFailed };
		});
		for (const { database, sweep, waiting, looked, forgotFailed } of results) {
			if (forgotFailed) unforgotten.push(database);
			if (looked === null) continue;
			if (sweep) this.#swept.set(database, now);
			const running = new Set(looked.rows.map((line) => line.txid));
			const unsettled = this.#unsettled.get(database) ?? new Set();
			for (const txid of waiting) if (!running.has(txid)) unsettled.delete(txid);
			for (const txid of running) unsettled.add(txid);
			if (unsettled.size === 0) this.#unsettled.delete(database);
			else this.#unsettled.set(database, unsettled);
		}
		const live = new Set(databases);
		for (const known of [this.#unsettled, this.#swept]) for (const database of known.keys()) if (!live.has(database)) known.delete(database);
		return unforgotten;
	}

	#parseCaller(authorization) {
		if (typeof authorization !== "string") refuse(401, "Sign in");
		const kept = this.#tokens.get(authorization);
		if (kept) return kept;
		const token = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization)?.[1];
		if (!token) refuse(401, "Sign in");
		let userId = null;
		try {
			userId = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")).sub ?? null;
		} catch {
			refuse(401, "Sign in");
		}
		if (typeof userId !== "string" || !ENVIRONMENT.test(userId)) refuse(401, "Sign in");
		const caller = { token, userId, key: sha256(token) };
		if (this.#tokens.size >= 4_096) this.#tokens.delete(this.#tokens.keys().next().value);
		this.#tokens.set(authorization, caller);
		return caller;
	}

	/** A member's request, begun as that member. */
	async handle(method, path, headers, read, gone) {
		const route = /^\/v1\/company-data\/([^/]+)\/(query|watch|apply|describe|change|rows|edit|changes)$/.exec(path);
		if (!route) refuse(404, "Not a call the data gateway answers");
		if (method !== "POST") refuse(405, "Use POST");
		const caller = this.#parseCaller(headers.authorization);
		const environmentId = route[1];
		companyDatabase(environmentId);
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
				return this.query(caller, environmentId, body, { gone });
			case "watch":
				return this.watch(caller, environmentId, body, gone);
			case "apply":
				return this.apply(caller, environmentId, body);
			case "change":
				return this.change(caller, environmentId, body, { gone });
			case "rows":
				return this.rows(caller, environmentId, body, { gone });
			case "edit":
				return this.edit(caller, environmentId, body, { gone });
			case "changes":
				return this.changes(caller, environmentId, body);
			default:
				return this.describe(caller, environmentId, body);
		}
	}

	/** An agent's request on the run door (SLICE5): the node's private token as the bearer and a data pass in the body.
	 * A wrong token, no pass and a pass that redeems to nothing get one answer, 401, with no detail. The pass names the
	 * company, the run's requester and the files the run may read; nothing else in the request does. */
	async handleRun(method, path, headers, read, gone = null) {
		const route = /^\/v1\/run-data\/(describe|apply|query|change)$/.exec(path);
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
		const caller = {
			run: true,
			userId: kept.requesterUserId,
			machineId: kept.machineId,
			agentId: kept.agentId,
			key: `run:${sha256(body.pass)}`,
			files: kept.files,
			allow: kept.allow,
		};
		switch (route[1]) {
			case "query":
				return this.runQuery(caller, kept.environmentId, body, { gone });
			case "apply":
				return this.apply(caller, kept.environmentId, body);
			case "change":
				return this.runChange(caller, kept.environmentId, body, { gone });
			default:
				return this.runDescribe(caller, kept.environmentId, body);
		}
	}

	async close() {
		this.#closed = true;
		for (const entry of this.#watchInFlight.values()) entry.controller.abort();
		this.#watchInFlight.clear();
		for (const listener of this.#listeners.values()) {
			listener.stopped = true;
			listener.cache.clear();
			listener.viewerScoped.clear();
			for (const tell of [...listener.heard]) tell(null);
			await listener.client?.end().catch(() => undefined);
		}
		this.#listeners.clear();
		this.#relations.clear();
		this.#schemaEpoch.clear();
		this.#askPlans.clear();
		this.#tokens.clear();
		this.#provenInFlight.clear();
		this.#mayWriteInFlight.clear();
		this.#folderInFlight.clear();
		await Promise.all([...this.#pools.values()].map(({ pool }) => pool.end().catch(() => undefined)));
		this.#pools.clear();
	}
}

/** The watcher's timer: one look every `everyMs`, never two at once. Gives the function that stops it. */
export function startWatcher(gateway, { everyMs = 10_000, failed = () => undefined, onLook = () => undefined } = {}) {
	let looking = false;
	const timer = setInterval(async () => {
		if (looking) return;
		looking = true;
		try {
			const looked = await gateway.watchOnce();
			onLook(looked);
			if (looked.unforgotten.length > 0) failed(new Error(`the record kept lines past their days in ${looked.unforgotten.length} company databases`));
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
				let settled = false;
				const finish = (fn, value) => {
					if (settled) return;
					settled = true;
					fn(value);
				};
				request.on("data", (part) => {
					bytes += part.length;
					if (bytes > maximum) {
						finish(reject, new Refusal(413, "The body is too large"));
						request.destroy();
					} else parts.push(part);
				});
				request.on("end", () => finish(resolve, parts.length === 0 ? "" : parts.length === 1 ? parts[0].toString("utf8") : Buffer.concat(parts).toString("utf8")));
				request.on("error", () => finish(reject, new Refusal(400, "The body did not arrive")));
				request.on("aborted", () => finish(reject, new Refusal(400, "The body did not arrive")));
				request.on("close", () => finish(reject, new Refusal(400, "The body did not arrive")));
			});
		let status = 200;
		let value;
		try {
			const rawUrl = request.url ?? "/";
			const pathname =
				rawUrl.startsWith("/") && !rawUrl.includes("..") && !rawUrl.includes("#")
					? rawUrl.includes("?")
						? rawUrl.slice(0, rawUrl.indexOf("?"))
						: rawUrl
					: new URL(rawUrl, "http://gateway").pathname;
			value = await handle(request.method, pathname, request.headers, read, gone.signal);
		} catch (error) {
			const refusal = error instanceof Refusal ? error : new Refusal(500, "The data gateway failed");
			status = refusal.status;
			value = { error: refusal.message, ...refusal.extra };
		}
		if (gone.signal.aborted) return;
		const text = value && typeof value === "object" && typeof value[RAW_JSON] === "string" ? value[RAW_JSON] : JSON.stringify(value);
		const payload = Buffer.from(text, "utf8");
		response.writeHead(status, { "content-type": "application/json", "content-length": payload.length, "cache-control": "no-store" });
		response.end(payload);
	};
}

function listenServer(server, port, host) {
	return new Promise((resolve, reject) => {
		const onError = (error) => reject(error);
		server.once("error", onError);
		server.listen(port, host, () => {
			server.removeListener("error", onError);
			resolve(server);
		});
	});
}

export function serve(gateway, { host = "127.0.0.1", port = 0 } = {}) {
	const server = http.createServer(answering((method, path, headers, read, gone) => gateway.handle(method, path, headers, read, gone)));
	server.keepAliveTimeout = 65_000;
	server.headersTimeout = 70_000;
	return listenServer(server, port, host);
}

export function serveRuns(gateway, { host = "127.0.0.1", port = 0, cert = null, key = null } = {}) {
	if ((cert === null) !== (key === null)) throw new Error("The run door needs both a certificate and its key, or neither");
	if (cert === null && !["127.0.0.1", "::1", "localhost"].includes(host)) throw new Error("The run door off loopback needs TLS");
	const handler = answering((method, path, headers, read, gone) => gateway.handleRun(method, path, headers, read, gone));
	const server = cert === null ? http.createServer(handler) : https.createServer({ cert, key, minVersion: "TLSv1.2" }, handler);
	server.keepAliveTimeout = 65_000;
	server.headersTimeout = 70_000;
	return listenServer(server, port, host);
}
