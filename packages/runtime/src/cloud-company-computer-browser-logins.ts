import { constants, type Stats } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

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
const MAX_COOKIES = 4000;
const MAX_COOKIE_BYTES = 8192;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

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

interface Attached {
	context: CompanyComputerLoginContext;
	seen: Map<string, CompanyComputerLoginCookie>;
}

/** The company's one set of website sign-ins.
 *
 * Chrome locks a profile to one running browser and every agent has its own
 * desktop, so agents cannot literally share a profile. They share its sign-ins
 * instead: this store holds the company's cookies, gives them to each agent's
 * browser when it opens, and carries a sign-in (or sign-out) made in one
 * browser to the store and to the other browsers that are open. Session
 * cookies are kept too, so a sign-in survives a browser restart.
 *
 * The file sits beside the profile directories on the company workbench with
 * the same protection; it never enters a browser's namespace, a log, a
 * transcript or a viewer. Sites that bind a session to one browser or rotate
 * its token on every use can still sign other agents out; that is the site's
 * rule, not something a cookie store can change. */
export class CompanyComputerBrowserLogins {
	readonly #path: string;
	readonly #intervalMs: number;
	readonly #now: () => number;
	readonly #attached = new Map<string, Attached>();
	#jar: Map<string, CompanyComputerLoginCookie> | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#work: Promise<void> = Promise.resolve();
	#closed = false;

	constructor(options: { path: string; intervalMs?: number; now?: () => number }) {
		if (!options.path.startsWith("/") || /[\x00-\x1f\x7f\\]/.test(options.path))
			throw new Error("INVALID_BROWSER_LOGIN_STORE");
		this.#path = options.path;
		this.#intervalMs = options.intervalMs ?? 5000;
		this.#now = options.now ?? Date.now;
	}

	/** Gives a newly opened browser the company's sign-ins and starts following it.
	 * The returned function takes a last look and stops following. */
	attach(id: string, context: CompanyComputerLoginContext): Promise<() => Promise<void>> {
		return this.#serial(async () => {
			if (this.#closed) throw new Error("BROWSER_LOGIN_STORE_CLOSED");
			const jar = await this.#load();
			const now = this.#now();
			const live = [...jar.values()].filter((cookie) => !expired(cookie, now));
			if (live.length) await context.addCookies(live.map(plain));
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

	/** One pass now: what changed in any open browser reaches the store and the others. */
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

	async #sync(): Promise<void> {
		const jar = await this.#load();
		const now = this.#now();
		const set = new Map<string, { cookie: CompanyComputerLoginCookie; from: string }>();
		const cleared = new Map<string, { cookie: CompanyComputerLoginCookie; from: string }>();
		let changed = false;
		for (const [id, entry] of this.#attached) {
			let current: Map<string, CompanyComputerLoginCookie>;
			try {
				current = await this.#read(entry.context);
			} catch {
				continue; // A browser that is closing is read again, or detached, next time.
			}
			for (const [k, cookie] of current) {
				const before = entry.seen.get(k);
				if (before && same(before, cookie)) continue;
				const held = jar.get(k);
				if (held && same(held, cookie)) continue;
				jar.set(k, cookie);
				set.set(k, { cookie, from: id });
				cleared.delete(k);
				changed = true;
			}
			for (const [k, before] of entry.seen) {
				if (current.has(k) || expired(before, now)) continue;
				const held = jar.get(k);
				// Removed here while the company still held the same value: a sign-out.
				if (held && same(held, before) && !set.has(k)) {
					jar.delete(k);
					cleared.set(k, { cookie: before, from: id });
					changed = true;
				}
			}
			entry.seen = current;
		}
		for (const [k, cookie] of jar)
			if (expired(cookie, now)) {
				jar.delete(k);
				changed = true;
			}
		for (const [id, entry] of this.#attached) {
			const add = [...set.entries()].filter(([, item]) => item.from !== id);
			if (add.length) {
				try {
					await entry.context.addCookies(add.map(([, item]) => plain(item.cookie)));
					for (const [k, item] of add) entry.seen.set(k, item.cookie);
				} catch {
					/* The next pass offers them again through the store on reopen. */
				}
			}
			for (const [k, item] of cleared) {
				if (item.from === id) continue;
				try {
					await entry.context.clearCookies({
						name: item.cookie.name,
						domain: item.cookie.domain,
						path: item.cookie.path,
					});
					entry.seen.delete(k);
				} catch {
					/* Left signed in here until its own session ends. */
				}
			}
		}
		if (changed) await this.#save(jar);
	}

	async #load(): Promise<Map<string, CompanyComputerLoginCookie>> {
		if (this.#jar) return this.#jar;
		const jar = new Map<string, CompanyComputerLoginCookie>();
		let info: Stats | undefined;
		try {
			info = await lstat(this.#path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (info) {
			if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.size > MAX_FILE_BYTES)
				throw new Error("UNSAFE_BROWSER_LOGIN_STORE");
			const file = await open(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				const value: unknown = JSON.parse(await file.readFile("utf8"));
				const cookies =
					value && typeof value === "object" && (value as { schema?: unknown }).schema === SCHEMA
						? (value as { cookies?: unknown }).cookies
						: undefined;
				if (!Array.isArray(cookies)) throw new Error("INVALID_BROWSER_LOGIN_STORE");
				for (const cookie of cookies.slice(0, MAX_COOKIES)) if (valid(cookie)) jar.set(key(cookie), plain(cookie));
			} finally {
				await file.close();
			}
		}
		this.#jar = jar;
		return jar;
	}

	async #save(jar: Map<string, CompanyComputerLoginCookie>): Promise<void> {
		// Newest sign-ins win the space when a company collects more than the store holds.
		const cookies = [...jar.values()].slice(-MAX_COOKIES);
		const bytes = Buffer.from(JSON.stringify({ schema: SCHEMA, cookies }));
		if (bytes.length > MAX_FILE_BYTES) throw new Error("BROWSER_LOGIN_STORE_TOO_LARGE");
		const temporary = join(dirname(this.#path), `.company-logins.${process.pid}.${this.#now()}.tmp`);
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
		await rename(temporary, this.#path);
	}
}
