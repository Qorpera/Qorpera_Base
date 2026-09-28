import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** The part of a Playwright browser context the login store uses. */
export interface CompanyComputerLoginContext {
	cookies(): Promise<CompanyComputerLoginCookie[]>;
	addCookies(cookies: CompanyComputerLoginCookie[]): Promise<void>;
	clearCookies(filter: { name: string; domain: string; path: string }): Promise<void>;
}
export interface CompanyComputerLoginCookie {
	name: string;
	value: string;
	domain: string;
	path: string;
	expires: number;
	httpOnly: boolean;
	secure: boolean;
	sameSite: "Strict" | "Lax" | "None";
}

const SCHEMA = "qorpera.company-browser-logins/v1";
const COMPUTER_SCHEMA = "qorpera.company-browser-logins/v2";
const MAX_COOKIES = 4000;
const MAX_COOKIE_BYTES = 8192;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_COMPUTERS = 64;
/** A sign-out is remembered this long, so a computer that was off for a while cannot bring it back. */
const SIGN_OUT_KEPT_MS = 30 * 24 * 60 * 60 * 1000;
const COMPUTER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const key = (cookie: Pick<CompanyComputerLoginCookie, "name" | "domain" | "path">): string =>
	`${cookie.domain}\n${cookie.path}\n${cookie.name}`;
const same = (a: CompanyComputerLoginCookie, b: CompanyComputerLoginCookie): boolean =>
	a.value === b.value &&
	Math.trunc(a.expires) === Math.trunc(b.expires) &&
	a.httpOnly === b.httpOnly &&
	a.secure === b.secure &&
	a.sameSite === b.sameSite;
function valid(value: unknown): value is CompanyComputerLoginCookie {
	if (!value || typeof value !== "object") return false;
	const c = value as Record<string, unknown>;
	return (
		typeof c.name === "string" &&
		c.name.length > 0 &&
		typeof c.value === "string" &&
		typeof c.domain === "string" &&
		c.domain.length > 0 &&
		typeof c.path === "string" &&
		c.path.startsWith("/") &&
		typeof c.expires === "number" &&
		Number.isFinite(c.expires) &&
		typeof c.httpOnly === "boolean" &&
		typeof c.secure === "boolean" &&
		(c.sameSite === "Strict" || c.sameSite === "Lax" || c.sameSite === "None") &&
		c.name.length + c.value.length + c.domain.length + c.path.length <= MAX_COOKIE_BYTES
	);
}
const plain = (c: CompanyComputerLoginCookie): CompanyComputerLoginCookie => ({
	name: c.name,
	value: c.value,
	domain: c.domain,
	path: c.path,
	expires: c.expires,
	httpOnly: c.httpOnly,
	secure: c.secure,
	sameSite: c.sameSite,
});
const expired = (c: CompanyComputerLoginCookie, now: number): boolean => c.expires > 0 && c.expires * 1000 <= now;

/** The latest thing one computer saw happen to one sign-in: set to a value, or signed out (null). */
interface LoginEvent {
	cookie: CompanyComputerLoginCookie | null;
	/** Milliseconds, on the clock of the computer that saw it. */
	at: number;
	/** The file it came from; breaks a tie between two computers the same way everywhere. */
	source: string;
}
interface Source {
	identity: string;
	events: Map<string, LoginEvent>;
	/** The single-file store of an office service that predates several computers: what it held last time. */
	snapshot?: Map<string, CompanyComputerLoginCookie>;
}
interface Attached {
	context: CompanyComputerLoginContext;
	seen: Map<string, CompanyComputerLoginCookie>;
}
const newer = (a: LoginEvent, b: LoginEvent | undefined): boolean =>
	!b || a.at > b.at || (a.at === b.at && a.source > b.source);

/** The company's one set of website sign-ins.
 *
 * Chrome locks a profile to one running browser and every agent has its own
 * desktop, so agents cannot literally share a profile. They share its sign-ins
 * instead: this store holds the company's cookies, gives them to each agent's
 * browser when it opens, and carries a sign-in (or sign-out) made in one
 * browser to the store and to the other browsers that are open. Session
 * cookies are kept, so a sign-in survives a browser restart.
 *
 * A company can run several Company Computers, all mounting the same company
 * directory. Each computer writes only its own file there
 * (`browser-logins.<computer id>.json`) and reads the others' on every pass:
 * for each sign-in the newest change wins, sign-outs included, so two
 * computers never overwrite each other and a sign-in on one reaches the open
 * browsers on the others within a pass. The single file of an office service
 * that predates this (`path`) is read, never written: what it held when first
 * read is the starting point, and a later change to it counts as that change.
 *
 * The files sit in the company directory on the workbench with the same
 * protection; they never enter a browser's namespace, a log, a transcript or
 * a viewer. Sites that bind a session to one browser or rotate its token on
 * every use can still sign other agents out; that is the site's rule, not
 * something a cookie store can change. */
export class CompanyComputerBrowserLogins {
	readonly #path: string;
	readonly #directory: string;
	readonly #own: string;
	readonly #intervalMs: number;
	readonly #now: () => number;
	readonly #attached = new Map<string, Attached>();
	/** What this computer saw happen, keyed by sign-in: its own file. */
	readonly #events = new Map<string, LoginEvent>();
	/** The other files, by name, with what each last held. */
	readonly #sources = new Map<string, Source>();
	#loaded = false;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#work: Promise<void> = Promise.resolve();
	#closed = false;

	constructor(options: { path: string; computerId: string; intervalMs?: number; now?: () => number }) {
		if (!options.path.startsWith("/") || /[\x00-\x1f\x7f\\]/.test(options.path))
			throw new Error("INVALID_BROWSER_LOGIN_STORE");
		if (!COMPUTER_ID.test(options.computerId)) throw new Error("INVALID_BROWSER_LOGIN_STORE");
		this.#path = options.path;
		this.#directory = dirname(options.path);
		this.#own = `browser-logins.${options.computerId}.json`;
		this.#intervalMs = options.intervalMs ?? 5000;
		this.#now = options.now ?? Date.now;
	}

	/** Gives a newly opened browser the company's sign-ins and starts following it.
	 * The returned function takes a last look and stops following. */
	attach(id: string, context: CompanyComputerLoginContext): Promise<() => Promise<void>> {
		return this.#serial(async () => {
			if (this.#closed) throw new Error("BROWSER_LOGIN_STORE_CLOSED");
			await this.#refresh();
			const jar = this.#jar();
			if (jar.size) await context.addCookies([...jar.values()].map(plain));
			// What this browser already holds beyond the company's set (a sign-in made
			// before it was followed) counts as new on the first pass.
			const seen = await this.#read(context);
			for (const [k, cookie] of seen) {
				const held = jar.get(k);
				if (!held || !same(held, cookie)) seen.delete(k);
			}
			const entry: Attached = { context, seen };
			this.#attached.set(id, entry);
			this.#schedule();
			return () =>
				this.#serial(async () => {
					if (this.#attached.get(id) !== entry) return;
					await this.#sync().catch(() => undefined);
					this.#attached.delete(id);
				});
		});
	}

	/** One pass now: what changed in any open browser, or on another computer,
	 * reaches the store and the other browsers. */
	sync(): Promise<void> {
		return this.#serial(() => this.#sync());
	}

	async close(): Promise<void> {
		this.#closed = true;
		clearTimeout(this.#timer);
		await this.#serial(async () => {
			await this.#sync().catch(() => undefined);
			this.#attached.clear();
		});
	}

	#serial<T>(work: () => Promise<T>): Promise<T> {
		const next = this.#work.then(work, work);
		this.#work = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	#schedule(): void {
		if (this.#timer || this.#closed || !this.#attached.size) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.sync()
				.catch(() => undefined)
				.finally(() => this.#schedule());
		}, this.#intervalMs);
		this.#timer.unref?.();
	}

	async #read(context: CompanyComputerLoginContext): Promise<Map<string, CompanyComputerLoginCookie>> {
		const result = new Map<string, CompanyComputerLoginCookie>();
		for (const cookie of await context.cookies()) if (valid(cookie)) result.set(key(cookie), plain(cookie));
		return result;
	}

	/** The company's live sign-ins: for each one the newest change across every computer. */
	#jar(): Map<string, CompanyComputerLoginCookie> {
		const now = this.#now();
		const winners = new Map<string, LoginEvent>();
		for (const events of [this.#events, ...[...this.#sources.values()].map((source) => source.events)])
			for (const [k, event] of events) if (newer(event, winners.get(k))) winners.set(k, event);
		const jar = new Map<string, CompanyComputerLoginCookie>();
		for (const [k, event] of winners) if (event.cookie && !expired(event.cookie, now)) jar.set(k, event.cookie);
		return jar;
	}

	async #sync(): Promise<void> {
		await this.#refresh();
		const now = this.#now();
		let changed = false;
		// What changed in this computer's open browsers since the last pass becomes
		// this computer's change, unless the company already holds exactly that.
		for (const entry of this.#attached.values()) {
			let current: Map<string, CompanyComputerLoginCookie>;
			try {
				current = await this.#read(entry.context);
			} catch {
				continue; // A browser that is closing is read again, or detached, next time.
			}
			const jar = this.#jar();
			for (const [k, cookie] of current) {
				const before = entry.seen.get(k);
				if (before && same(before, cookie)) continue;
				const held = jar.get(k);
				if (!held || !same(held, cookie)) {
					this.#events.set(k, { cookie, at: now, source: this.#own });
					changed = true;
				}
			}
			for (const [k, before] of entry.seen) {
				if (current.has(k) || expired(before, now)) continue;
				const held = jar.get(k);
				// Removed here while the company still held the same value: a sign-out.
				if (held && same(held, before)) {
					this.#events.set(k, { cookie: null, at: now, source: this.#own });
					changed = true;
				}
			}
			entry.seen = current;
		}
		for (const [k, event] of this.#events)
			if ((event.cookie && expired(event.cookie, now)) || (!event.cookie && event.at <= now - SIGN_OUT_KEPT_MS)) {
				this.#events.delete(k);
				changed = true;
			}
		// Every open browser follows the company's sign-ins: this computer's and the others'.
		const jar = this.#jar();
		for (const entry of this.#attached.values()) {
			const add = [...jar.entries()].filter(([k, cookie]) => {
				const held = entry.seen.get(k);
				return !held || !same(held, cookie);
			});
			if (add.length) {
				try {
					await entry.context.addCookies(add.map(([, cookie]) => plain(cookie)));
					for (const [k, cookie] of add) entry.seen.set(k, cookie);
				} catch {
					/* The next pass offers them again. */
				}
			}
			for (const [k, held] of [...entry.seen]) {
				if (jar.has(k) || expired(held, now)) continue;
				try {
					await entry.context.clearCookies({ name: held.name, domain: held.domain, path: held.path });
					entry.seen.delete(k);
				} catch {
					/* Left signed in here until its own session ends. */
				}
			}
		}
		if (changed) await this.#save();
	}

	/** Reads this computer's own file once, and every other computer's file (and
	 * the old single file) whenever it changed. */
	async #refresh(): Promise<void> {
		if (!this.#loaded) {
			const own = await this.#file(join(this.#directory, this.#own));
			if (own) for (const [k, event] of this.#computerEvents(own.value, this.#own)) this.#events.set(k, event);
			this.#loaded = true;
		}
		let names: string[];
		try {
			names = await readdir(this.#directory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		const others = names
			.filter((name) => name !== this.#own && /^browser-logins\.[0-9a-f-]{36}\.json$/.test(name))
			.sort()
			.slice(0, MAX_COMPUTERS);
		for (const name of [basename(this.#path), ...others]) {
			const file = await this.#file(join(this.#directory, name), this.#sources.get(name)?.identity);
			if (file === undefined) continue; // unchanged since the last pass
			if (file === null) {
				// Gone: what it said still happened. Keep its last word.
				continue;
			}
			if (name === basename(this.#path)) this.#legacy(name, file.value, file.identity, file.at);
			else this.#sources.set(name, { identity: file.identity, events: this.#computerEvents(file.value, name) });
		}
	}

	/** The old single file. The first read is the starting point (older than
	 * anything a computer saw); a later change counts as a change at its write. */
	#legacy(name: string, value: unknown, identity: string, at: number): void {
		const cookies = new Map<string, CompanyComputerLoginCookie>();
		const list =
			value && typeof value === "object" && (value as { schema?: unknown }).schema === SCHEMA
				? (value as { cookies?: unknown }).cookies
				: undefined;
		if (!Array.isArray(list)) throw new Error("INVALID_BROWSER_LOGIN_STORE");
		for (const cookie of list.slice(0, MAX_COOKIES)) if (valid(cookie)) cookies.set(key(cookie), plain(cookie));
		const previous = this.#sources.get(name);
		const events = previous?.events ?? new Map<string, LoginEvent>();
		if (!previous?.snapshot) {
			for (const [k, cookie] of cookies) events.set(k, { cookie, at: 0, source: name });
		} else {
			for (const [k, cookie] of cookies) {
				const held = previous.snapshot.get(k);
				if (!held || !same(held, cookie)) events.set(k, { cookie, at, source: name });
			}
			for (const [k] of previous.snapshot) if (!cookies.has(k)) events.set(k, { cookie: null, at, source: name });
		}
		this.#sources.set(name, { identity, events, snapshot: cookies });
	}

	#computerEvents(value: unknown, source: string): Map<string, LoginEvent> {
		const record = value as { schema?: unknown; events?: unknown } | null;
		if (!record || typeof record !== "object" || record.schema !== COMPUTER_SCHEMA || !Array.isArray(record.events))
			throw new Error("INVALID_BROWSER_LOGIN_STORE");
		const events = new Map<string, LoginEvent>();
		for (const item of record.events.slice(0, MAX_COOKIES * 2)) {
			const entry = item as { at?: unknown; cookie?: unknown; signedOut?: unknown } | null;
			if (!entry || typeof entry !== "object" || typeof entry.at !== "number" || !Number.isFinite(entry.at))
				continue;
			if (valid(entry.cookie)) events.set(key(entry.cookie), { cookie: plain(entry.cookie), at: entry.at, source });
			else if (valid(entry.signedOut)) events.set(key(entry.signedOut), { cookie: null, at: entry.at, source });
		}
		return events;
	}

	/** A protected store file: undefined when unchanged since `identity`, null when absent. */
	async #file(
		path: string,
		identity?: string,
	): Promise<{ value: unknown; identity: string; at: number } | null | undefined> {
		let info: Stats;
		try {
			info = await lstat(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
		if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.size > MAX_FILE_BYTES)
			throw new Error("UNSAFE_BROWSER_LOGIN_STORE");
		const current = `${info.ino}:${info.size}:${info.mtimeMs}`;
		if (current === identity) return undefined;
		const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			return { value: JSON.parse(await file.readFile("utf8")), identity: current, at: Math.trunc(info.mtimeMs) };
		} finally {
			await file.close();
		}
	}

	async #save(): Promise<void> {
		// Newest sign-ins win the space when a company collects more than the store holds.
		const events = [...this.#events.entries()].sort(([, a], [, b]) => a.at - b.at).slice(-MAX_COOKIES);
		const bytes = Buffer.from(
			JSON.stringify({
				schema: COMPUTER_SCHEMA,
				events: events.map(([k, event]) => {
					if (event.cookie) return { at: event.at, cookie: plain(event.cookie) };
					// A sign-out keeps the cookie's name, domain and path only.
					const [domain, path, name] = k.split("\n");
					return {
						at: event.at,
						signedOut: {
							name,
							value: "",
							domain,
							path,
							expires: -1,
							httpOnly: false,
							secure: false,
							sameSite: "Lax",
						},
					};
				}),
			}),
		);
		if (bytes.length > MAX_FILE_BYTES) throw new Error("BROWSER_LOGIN_STORE_TOO_LARGE");
		const temporary = join(this.#directory, `.company-logins.${process.pid}.${this.#now()}.tmp`);
		const file = await open(
			temporary,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		);
		try {
			await file.writeFile(bytes);
			await file.sync();
		} catch (error) {
			await file.close();
			await rm(temporary, { force: true });
			throw error;
		}
		await file.close();
		await rename(temporary, join(this.#directory, this.#own));
	}
}
