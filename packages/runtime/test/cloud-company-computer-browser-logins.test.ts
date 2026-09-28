import { chmod, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CompanyComputerBrowserLogins,
	type CompanyComputerLoginContext,
	type CompanyComputerLoginCookie,
} from "@qorpera/runtime/cloud-company-computer-browser-logins";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const COMPUTER_1 = "00000000-0000-4000-8000-000000000001";
const COMPUTER_2 = "00000000-0000-4000-8000-000000000002";
async function store(now = () => 1_000_000) {
	const root = await mkdtemp(join(tmpdir(), "qorpera-logins-"));
	roots.push(root);
	const path = join(root, "company-logins.json");
	return {
		root,
		path,
		/** The file this computer writes. */
		own: (computerId = COMPUTER_1) => join(root, `browser-logins.${computerId}.json`),
		logins: (computerId = COMPUTER_1, clock = now) =>
			new CompanyComputerBrowserLogins({ path, computerId, intervalMs: 3_600_000, now: clock }),
	};
}
const cookie = (
	name: string,
	value: string,
	update: Partial<CompanyComputerLoginCookie> = {},
): CompanyComputerLoginCookie => ({
	name,
	value,
	domain: ".example.com",
	path: "/",
	expires: -1,
	httpOnly: true,
	secure: true,
	sameSite: "Lax",
	...update,
});
/** A browser's cookie jar, as Playwright presents it. */
function browser(initial: CompanyComputerLoginCookie[] = []) {
	const held = new Map(initial.map((item) => [`${item.domain}|${item.path}|${item.name}`, item]));
	const context: CompanyComputerLoginContext = {
		cookies: async () => [...held.values()].map((item) => ({ ...item })),
		addCookies: async (items) => {
			for (const item of items) held.set(`${item.domain}|${item.path}|${item.name}`, { ...item });
		},
		clearCookies: async (filter) => {
			held.delete(`${filter.domain}|${filter.path}|${filter.name}`);
		},
	};
	return {
		context,
		value: (name: string) => [...held.values()].find((item) => item.name === name)?.value,
		set: (item: CompanyComputerLoginCookie) => held.set(`${item.domain}|${item.path}|${item.name}`, item),
		remove: (name: string) => {
			for (const [k, item] of held) if (item.name === name) held.delete(k);
		},
	};
}

describe("the company's one set of browser sign-ins", () => {
	it("carries a sign-in made in one agent's browser to the other open browsers and to the next one opened", async () => {
		const f = await store(),
			logins = f.logins(),
			a = browser(),
			b = browser();
		await logins.attach("agent-a", a.context);
		await logins.attach("agent-b", b.context);
		a.set(cookie("session", "signed-in"));
		await logins.sync();
		expect(b.value("session")).toBe("signed-in");
		const c = browser();
		await logins.attach("agent-c", c.context);
		expect(c.value("session")).toBe("signed-in");
		// Nothing echoes: a second pass changes nothing and rewrites nothing.
		const before = await readFile(f.own(), "utf8");
		await logins.sync();
		expect(await readFile(f.own(), "utf8")).toBe(before);
		await logins.close();
	});
	it("keeps session cookies across a restart of the office service and protects the file", async () => {
		const f = await store(),
			first = f.logins(),
			a = browser();
		const detach = await first.attach("agent-a", a.context);
		a.set(cookie("session", "kept"));
		await detach();
		await first.close();
		expect((await stat(f.own())).mode & 0o077).toBe(0);
		const b = browser();
		const second = f.logins();
		await second.attach("agent-b", b.context);
		expect(b.value("session")).toBe("kept");
		await second.close();
	});
	it("treats a sign-out as company-wide, and a newer value as the winner", async () => {
		const f = await store(),
			logins = f.logins(),
			a = browser(),
			b = browser();
		await logins.attach("agent-a", a.context);
		await logins.attach("agent-b", b.context);
		a.set(cookie("session", "one"));
		await logins.sync();
		b.set(cookie("session", "two"));
		await logins.sync();
		expect(a.value("session")).toBe("two");
		a.remove("session");
		await logins.sync();
		expect(b.value("session")).toBeUndefined();
		const c = browser();
		await logins.attach("agent-c", c.context);
		expect(c.value("session")).toBeUndefined();
		await logins.close();
	});
	it("adopts what a browser already held, lets the company's value win a conflict, and drops expired cookies", async () => {
		let time = 1_000_000;
		const f = await store(() => time),
			logins = f.logins(),
			a = browser([cookie("legacy", "from-a"), cookie("short", "x", { expires: 2000 })]);
		await logins.attach("agent-a", a.context);
		await logins.sync();
		const b = browser([cookie("legacy", "stale-b")]);
		await logins.attach("agent-b", b.context);
		expect(b.value("legacy")).toBe("from-a");
		expect(b.value("short")).toBe("x");
		time = 3_000_000; // past `short`'s expiry (2000 s)
		await logins.sync();
		const c = browser();
		await logins.attach("agent-c", c.context);
		expect(c.value("short")).toBeUndefined();
		expect(c.value("legacy")).toBe("from-a");
		await logins.close();
	});
	it("refuses a store file others can read and ignores malformed entries", async () => {
		const f = await store();
		await writeFile(
			f.path,
			JSON.stringify({ schema: "qorpera.company-browser-logins/v1", cookies: [cookie("ok", "1"), { name: 5 }] }),
			{ mode: 0o600 },
		);
		const b = browser();
		const logins = f.logins();
		await logins.attach("agent-b", b.context);
		expect(b.value("ok")).toBe("1");
		await logins.close();
		await chmod(f.path, 0o644);
		await expect(f.logins().attach("agent-c", browser().context)).rejects.toThrow("UNSAFE_BROWSER_LOGIN_STORE");
	});
	it("refuses a store without a computer", async () => {
		const f = await store();
		expect(() => new CompanyComputerBrowserLogins({ path: f.path, computerId: "computer-1" })).toThrow(
			"INVALID_BROWSER_LOGIN_STORE",
		);
	});
});

describe("sign-ins across the company's computers", () => {
	it("carries a sign-in and a sign-out between two computers without either overwriting the other", async () => {
		const f = await store(),
			one = f.logins(COMPUTER_1),
			two = f.logins(COMPUTER_2),
			a = browser(),
			b = browser();
		await one.attach("agent-a", a.context);
		await two.attach("agent-b", b.context);
		a.set(cookie("session", "signed-in"));
		b.set(cookie("mail", "inbox"));
		await one.sync();
		await two.sync();
		expect(b.value("session")).toBe("signed-in");
		await one.sync();
		expect(a.value("mail")).toBe("inbox");
		// Each computer writes only its own file.
		expect(JSON.parse(await readFile(f.own(COMPUTER_1), "utf8")).events).toHaveLength(1);
		expect(JSON.parse(await readFile(f.own(COMPUTER_2), "utf8")).events).toHaveLength(1);
		b.remove("session");
		await two.sync();
		await one.sync();
		expect(a.value("session")).toBeUndefined();
		// A browser opened later on either computer starts with what the company holds.
		const c = browser();
		await one.attach("agent-c", c.context);
		expect(c.value("mail")).toBe("inbox");
		expect(c.value("session")).toBeUndefined();
		await one.close();
		await two.close();
	});
	it("lets the newest change win, whichever computer made it", async () => {
		let time = 1_000_000;
		const f = await store(() => time),
			one = f.logins(COMPUTER_1),
			two = f.logins(COMPUTER_2),
			a = browser(),
			b = browser();
		await one.attach("agent-a", a.context);
		await two.attach("agent-b", b.context);
		a.set(cookie("session", "older"));
		await one.sync();
		time += 1000;
		b.set(cookie("session", "newer"));
		await two.sync();
		await one.sync();
		expect(a.value("session")).toBe("newer");
		// A computer restarting reads both files and agrees.
		await one.close();
		const again = f.logins(COMPUTER_1),
			c = browser();
		await again.attach("agent-c", c.context);
		expect(c.value("session")).toBe("newer");
		await again.close();
		await two.close();
	});
	it("reads the single file of an older office service, and follows its later changes", async () => {
		const f = await store(),
			legacy = (cookies: CompanyComputerLoginCookie[]) =>
				writeFile(f.path, JSON.stringify({ schema: "qorpera.company-browser-logins/v1", cookies }), {
					mode: 0o600,
				});
		await legacy([cookie("session", "old-service"), cookie("mail", "kept")]);
		const two = f.logins(COMPUTER_2),
			b = browser();
		await two.attach("agent-b", b.context);
		expect(b.value("session")).toBe("old-service");
		// The older service signs out of mail and changes the session.
		await legacy([cookie("session", "rotated")]);
		await utimes(f.path, new Date(), new Date(Date.now() + 5000));
		await two.sync();
		expect(b.value("session")).toBe("rotated");
		expect(b.value("mail")).toBeUndefined();
		await two.close();
		// It is only read: the older file is never rewritten.
		expect(JSON.parse(await readFile(f.path, "utf8")).cookies).toHaveLength(1);
	});
	it("refuses another computer's file that others can read", async () => {
		const f = await store(),
			two = f.logins(COMPUTER_2),
			b = browser();
		await two.attach("agent-b", b.context);
		b.set(cookie("session", "x"));
		await two.close();
		await chmod(f.own(COMPUTER_2), 0o644);
		await expect(f.logins(COMPUTER_1).attach("agent-a", browser().context)).rejects.toThrow(
			"UNSAFE_BROWSER_LOGIN_STORE",
		);
	});
});
