import { constants } from "node:fs";
import { type FileHandle, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isNetworkRulesName, NETWORK_RULES_MAX_NAMES } from "@qorpera/cloud-client/network-rules";

/**
 * The agent exit's rules reader (RUNTIME-AGENT-EXIT.md §10, E8b). Every 2 seconds it reads the companies of the
 * node's client map (clients/<address>.json, every machine plugged into the agents' bridge), asks the database for
 * their network rules with the exit's own login (`qorpera_agent_exit`, which may call one function), and keeps them in
 * one file for the exit's resolvers:
 *
 * ```json
 * {"schema":"qorpera.agent-exit-rules/v1","companies":{"<company>":null,"<company>":{"version":"…","mode":"open","block":[…],"allow":[…]}}}
 * ```
 *
 * Every company asked about is listed: null is open (no rules file), an object its rules. A company not listed is not
 * known yet, and the exit gives its machines no answers until it is. The file changes only when the rules do. A read
 * that fails keeps the last file as it is; a row that fails the name rule keeps that company's last rules (or leaves it
 * unknown) and is a problem. The status file says every pass when the rules were last read and what is wrong, as codes
 * only: nothing the database or a client entry says reaches a log.
 */

export const AGENT_EXIT_RULES_SCHEMA = "qorpera.agent-exit-rules/v1";
export const AGENT_EXIT_RULES_STATUS_SCHEMA = "qorpera.agent-exit-rules-status/v1";
const PASS_EVERY_MS = 2000;
/** The most companies one call may ask about (the function refuses more). */
const COMPANIES_PER_CALL = 10_000;
const MAX_ENTRY_BYTES = 64 * 1024;
/** A uuid as the database writes it: a company (its profile id), or a rules version. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE = /^[A-Z0-9_]{1,32}$/;
const MODES = new Set(["open", "only-listed"]);
const SQL =
	"select company_id::text as company, version::text as version, mode, block, allow from public.qorpera_agent_exit_network_rules($1::uuid[])";

export interface AgentExitCompanyRules {
	readonly version: string;
	readonly mode: "open" | "only-listed";
	readonly block: readonly string[];
	readonly allow: readonly string[];
}

export interface AgentExitRulesDatabase {
	query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[]): Promise<{ rows: Row[] }>;
}

export interface AgentExitRulesStatus {
	readonly schema: typeof AGENT_EXIT_RULES_STATUS_SCHEMA;
	/** This pass. */
	readonly checkedAt: string;
	/** The last pass that read the database, or null when none has since the reader started. */
	readonly readAt: string | null;
	/** This pass read the database and every row was usable. */
	readonly ok: boolean;
	/** What is wrong, as a code: a SQLSTATE or system error code, TIMEOUT, DATABASE, CLIENTS, WRITE or BAD_ROWS. */
	readonly problem: string | null;
	/** Companies in the rules file, with rules, and rows refused by this pass. */
	readonly companies: number;
	readonly withRules: number;
	readonly badRows: number;
	/** Client entries this pass could not use (unreadable, or a company that is no profile id); their machines wait. */
	readonly skipped: number;
}

/** A failure at one step, with the code it is reported by. */
class PassError extends Error {
	constructor(readonly code: string) {
		super(code);
	}
}

export class AgentExitRulesReader {
	readonly #database: AgentExitRulesDatabase;
	readonly #clientsDir: string;
	readonly #rulesFile: string;
	readonly #statusFile: string;
	readonly #now: () => number;
	readonly #passEveryMs: number;
	/** The rules in the file, once read at the first pass. */
	#rules: Map<string, AgentExitCompanyRules | null> | undefined;
	#text: string | undefined;
	#readAt: number | null = null;
	/** The state last logged: "ok", or a problem code. */
	#logged: string | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#running: Promise<void> | undefined;
	#started = false;
	#closed = false;

	constructor(options: {
		database: AgentExitRulesDatabase;
		clientsDir: string;
		rulesFile: string;
		statusFile: string;
		now?: () => number;
		passEveryMs?: number;
	}) {
		this.#database = options.database;
		this.#clientsDir = options.clientsDir;
		this.#rulesFile = options.rulesFile;
		this.#statusFile = options.statusFile;
		this.#now = options.now ?? Date.now;
		this.#passEveryMs = options.passEveryMs ?? PASS_EVERY_MS;
	}

	start(): void {
		if (this.#started || this.#closed) return;
		this.#started = true;
		const loop = (): void => {
			if (this.#closed) return;
			this.#running = this.pass().finally(() => {
				this.#running = undefined;
				if (!this.#closed) this.#timer = setTimeout(loop, this.#passEveryMs);
			});
		};
		loop();
	}

	async close(): Promise<void> {
		this.#closed = true;
		clearTimeout(this.#timer);
		await this.#running;
	}

	/** One pass: the companies, their rules, the rules file when they changed, and the status file. Never throws. */
	async pass(): Promise<AgentExitRulesStatus> {
		const checkedAt = this.#now();
		let problem: string | null = null;
		let badRows = 0;
		let skipped = 0;
		try {
			this.#rules ??= await this.#load();
			const clients = await this.#companies();
			skipped = clients.skipped;
			const read = await this.#read(clients.companies, this.#rules);
			badRows = read.badRows;
			await this.#write(read.rules);
			this.#rules = read.rules;
			this.#readAt = checkedAt;
			if (badRows > 0) problem = "BAD_ROWS";
		} catch (error) {
			problem = error instanceof PassError ? error.code : "INTERNAL";
		}
		const rules = this.#rules ?? new Map();
		const status: AgentExitRulesStatus = {
			schema: AGENT_EXIT_RULES_STATUS_SCHEMA,
			checkedAt: new Date(checkedAt).toISOString(),
			readAt: this.#readAt === null ? null : new Date(this.#readAt).toISOString(),
			ok: problem === null,
			problem,
			companies: rules.size,
			withRules: [...rules.values()].filter((value) => value !== null).length,
			badRows,
			skipped,
		};
		try {
			await writeAtomically(this.#statusFile, `${JSON.stringify(status)}\n`, 0o644);
		} catch {
			// The status is the observers' alone; the next pass writes it again.
		}
		this.#log(problem, badRows);
		return status;
	}

	/** The rules file as the last run left it: the companies stay known across a restart while the database cannot be
	 * read. A file that is missing or not as written starts empty. */
	async #load(): Promise<Map<string, AgentExitCompanyRules | null>> {
		let text: string;
		try {
			text = await readFile(this.#rulesFile, { encoding: "utf8", flag: constants.O_RDONLY | constants.O_NOFOLLOW });
		} catch {
			return new Map();
		}
		try {
			const value: unknown = JSON.parse(text);
			if (!isRecord(value) || value.schema !== AGENT_EXIT_RULES_SCHEMA || !isRecord(value.companies))
				return new Map();
			const rules = new Map<string, AgentExitCompanyRules | null>();
			for (const [company, entry] of Object.entries(value.companies)) {
				if (!UUID.test(company)) return new Map();
				if (entry === null) rules.set(company, null);
				else {
					const parsed = companyRules(entry);
					if (!parsed) return new Map();
					rules.set(company, parsed);
				}
			}
			this.#text = text;
			return rules;
		} catch {
			return new Map();
		}
	}

	/** The companies of the client map's entries, sorted, and how many entries could not be used. An entry is a
	 * creator's claim until the plug's reconciler matches it with LXD; reading a claimed company's rules is harmless,
	 * and the exit routes only matched machines. */
	async #companies(): Promise<{ companies: string[]; skipped: number }> {
		let names: string[];
		try {
			names = await readdir(this.#clientsDir);
		} catch {
			throw new PassError("CLIENTS");
		}
		const companies = new Set<string>();
		let skipped = 0;
		for (const name of names) {
			if (name.startsWith(".") || !name.endsWith(".json")) continue;
			let company: unknown;
			try {
				const entry: unknown = JSON.parse(await readEntry(join(this.#clientsDir, name)));
				company = isRecord(entry) ? entry.company : undefined;
			} catch (error) {
				// Unplugged between the listing and the read.
				if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") continue;
				company = undefined;
			}
			if (typeof company === "string" && UUID.test(company)) companies.add(company);
			else skipped += 1;
		}
		return { companies: [...companies].sort(), skipped };
	}

	/** Every company's rules from the database, in calls of at most 10000 companies. Even with no company it calls
	 * once, so a pass proves the login. */
	async #read(
		companies: readonly string[],
		previous: ReadonlyMap<string, AgentExitCompanyRules | null>,
	): Promise<{ rules: Map<string, AgentExitCompanyRules | null>; badRows: number }> {
		const asked = new Set(companies);
		const found = new Map<string, AgentExitCompanyRules>();
		const refused = new Set<string>();
		let badRows = 0;
		for (let start = 0; start === 0 || start < companies.length; start += COMPANIES_PER_CALL) {
			let rows: Record<string, unknown>[];
			try {
				({ rows } = await this.#database.query(SQL, [companies.slice(start, start + COMPANIES_PER_CALL)]));
			} catch (error) {
				throw new PassError(databaseCode(error));
			}
			for (const row of rows) {
				const company = row.company;
				const rules = companyRules({ version: row.version, mode: row.mode, block: row.block, allow: row.allow });
				const known = typeof company === "string" && asked.has(company);
				if (!known || !rules || found.has(company) || refused.has(company)) {
					badRows += 1;
					if (known) {
						found.delete(company);
						refused.add(company);
					}
					continue;
				}
				found.set(company, rules);
			}
		}
		const rules = new Map<string, AgentExitCompanyRules | null>();
		for (const company of companies) {
			if (refused.has(company)) {
				// The last rules stay; a company without any stays unknown, so its machines wait.
				const kept = previous.get(company);
				if (kept !== undefined) rules.set(company, kept);
			} else rules.set(company, found.get(company) ?? null);
		}
		return { rules, badRows };
	}

	async #write(rules: ReadonlyMap<string, AgentExitCompanyRules | null>): Promise<void> {
		const companies: Record<string, AgentExitCompanyRules | null> = {};
		for (const company of [...rules.keys()].sort()) companies[company] = rules.get(company) ?? null;
		const text = `${JSON.stringify({ schema: AGENT_EXIT_RULES_SCHEMA, companies })}\n`;
		if (text === this.#text) return;
		try {
			await writeAtomically(this.#rulesFile, text, 0o600);
		} catch {
			throw new PassError("WRITE");
		}
		this.#text = text;
	}

	/** Changes of state only, as codes. */
	#log(problem: string | null, badRows: number): void {
		const state = problem ?? "ok";
		if (state === this.#logged) return;
		this.#logged = state;
		if (problem === null) console.error("Agent exit rules: reading the rules.");
		else if (problem === "BAD_ROWS")
			console.error(`Agent exit rules: ${badRows} rows refused (BAD_ROWS); those companies keep their last rules.`);
		else console.error(`Agent exit rules: cannot read the rules (${problem}); the last rules stay.`);
	}
}

/** One company's rules as the exit uses them, or null when anything in them is not as the database writes it: the
 * name rule of §10, at most 1000 distinct names a list, no name in both. */
export function companyRules(value: unknown): AgentExitCompanyRules | null {
	if (!isRecord(value) || Object.keys(value).sort().join() !== "allow,block,mode,version") return null;
	const { version, mode, block, allow } = value;
	if (typeof version !== "string" || !UUID.test(version)) return null;
	if (typeof mode !== "string" || !MODES.has(mode)) return null;
	const names = (list: unknown): string[] | null =>
		Array.isArray(list) &&
		list.length <= NETWORK_RULES_MAX_NAMES &&
		list.every((name) => typeof name === "string" && isNetworkRulesName(name)) &&
		new Set(list).size === list.length
			? [...(list as string[])]
			: null;
	const blocked = names(block);
	const allowed = names(allow);
	if (!blocked || !allowed) return null;
	const set = new Set(blocked);
	if (allowed.some((name) => set.has(name))) return null;
	return { version, mode: mode as AgentExitCompanyRules["mode"], block: blocked, allow: allowed };
}

/** A database failure's code: its SQLSTATE or system error code, TIMEOUT, or DATABASE. Never its message. */
function databaseCode(error: unknown): string {
	const code = (error as { code?: unknown } | undefined)?.code;
	if (typeof code === "string" && CODE.test(code)) return code;
	if (error instanceof Error && /timeout/i.test(error.message)) return "TIMEOUT";
	return "DATABASE";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** A client map entry's text: a regular file, never through a link and never blocking (creators write the folder). */
async function readEntry(path: string): Promise<string> {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const metadata = await handle.stat();
		if (!metadata.isFile() || metadata.size > MAX_ENTRY_BYTES) throw new Error("unusable entry");
		const bytes = Buffer.alloc(MAX_ENTRY_BYTES + 1);
		const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, 0);
		if (bytesRead > MAX_ENTRY_BYTES) throw new Error("unusable entry");
		return new TextDecoder("utf8", { fatal: true }).decode(bytes.subarray(0, bytesRead));
	} finally {
		await handle.close();
	}
}

/** Replaces `path` all at once: a reader sees the old file or the new one, never half of one. */
async function writeAtomically(path: string, text: string, mode: number): Promise<void> {
	const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Math.random().toString(36).slice(2)}`);
	let handle: FileHandle | undefined;
	try {
		handle = await open(
			temporary,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			mode,
		);
		await handle.chmod(mode);
		await handle.writeFile(text, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		await rename(temporary, path);
	} catch (error) {
		await handle?.close().catch(() => undefined);
		await rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
}
