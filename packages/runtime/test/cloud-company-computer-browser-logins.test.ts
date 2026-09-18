import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
async function store(now = () => 1_000_000) {
	const root = await mkdtemp(join(tmpdir(), "qorpera-logins-"));
	roots.push(root);
	const path = join(root, "company-logins.json");
	return { path, logins: () => new CompanyComputerBrowserLogins({ path, intervalMs: 3_600_000, now }) };
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
		const before = await readFile(f.path, "utf8");
		await logins.sync();
		expect(await readFile(f.path, "utf8")).toBe(before);
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
		expect((await stat(f.path)).mode & 0o077).toBe(0);
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
});
