import type { CompanyAccountFill } from "@qorpera/runtime/cloud-company-account-fill-box";
import {
	COMPANY_ACCOUNT_FILLED_ATTRIBUTE,
	CompanyAccountFillRefusedError,
	CompanyComputerFilledValues,
	companyAccountFillHost,
	fillCompanyAccountBox,
} from "@qorpera/runtime/cloud-company-computer-account-fill";
import type { Locator, Page } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";

const hosts = ["vercel.com", "accounts.vercel.com"];

describe("company account fill host", () => {
	it("allows only the account's own hosts over https", () => {
		expect(companyAccountFillHost("https://vercel.com/login", hosts)).toBe("vercel.com");
		expect(companyAccountFillHost("https://accounts.vercel.com/a?b#c", hosts)).toBe("accounts.vercel.com");
		for (const url of [
			"http://vercel.com/login",
			"https://evil.vercel.com/login",
			"https://vercel.com.evil.example/login",
			"https://vercel.com:8443/login",
			"https://user:pw@vercel.com/login",
			"https://VERCEL.com.evil.example/",
			"about:blank",
			"not a url",
		])
			expect(companyAccountFillHost(url, hosts), url).toBeNull();
		// The URL parser lower-cases a host, so a capitalised address is the same website.
		expect(companyAccountFillHost("https://Vercel.COM/login", hosts)).toBe("vercel.com");
	});
});

/** A box of a page, as the in-page code sees it. */
interface FakeBox {
	tagName: string;
	type: string;
	disabled: boolean;
	readOnly: boolean;
	value: string;
	attributes: Map<string, string>;
	setAttribute(name: string, value: string): void;
}

function fakeBox(overrides: Partial<FakeBox> = {}): FakeBox {
	const attributes = new Map<string, string>();
	return {
		tagName: "INPUT",
		type: "password",
		disabled: false,
		readOnly: false,
		value: "",
		attributes,
		setAttribute: (name, value) => attributes.set(name, value),
		...overrides,
	};
}

const realDocument = (globalThis as { document?: unknown }).document;
afterEach(() => {
	(globalThis as { document?: unknown }).document = realDocument;
});

/**
 * A page whose in-page code is the fill's own: every evaluate runs the real function against the fake box and a
 * fake document, so the checks inside the page are the ones tested.
 */
function fixture(options: {
	url?: string | string[];
	box?: Partial<FakeBox>;
	inFrame?: boolean;
	/** A page script takes the focus between the fill's check and its typing (into a shadow root's box). */
	stealFocus?: boolean | "shadow";
	/** The page moves the focus on once the box holds the whole value (a code box that advances). */
	advance?: boolean;
	/** A page script takes the focus into something with no value to empty (an editable area, a closed shadow root). */
	stealInto?: "editable";
	/** The website keeps only this many characters (it reshapes input). */
	keeps?: number;
}) {
	const urls = Array.isArray(options.url) ? [...options.url] : [options.url ?? "https://vercel.com/login"];
	const target = fakeBox(options.box);
	const other = fakeBox({ type: "text" });
	const host = { ...fakeBox({ tagName: "SIGN-IN" }), shadowRoot: { activeElement: other } };
	const editable = { tagName: "DIV", setAttribute: () => undefined };
	const document = { activeElement: null as FakeBox | null };
	const calls: string[] = [];
	const mainFrame = {};
	const send = vi.fn(async (method: string, params: { text: string }) => {
		calls.push(method);
		if (options.stealInto === "editable") {
			document.activeElement = editable as unknown as FakeBox;
			return;
		}
		if (options.stealFocus === "shadow") document.activeElement = host;
		else if (options.stealFocus) document.activeElement = other;
		const into = options.stealFocus === "shadow" ? other : document.activeElement;
		if (into) into.value += options.keeps === undefined ? params.text : params.text.slice(0, options.keeps);
		if (options.advance) document.activeElement = other;
	});
	const handle = {
		ownerFrame: async () => (options.inFrame ? {} : mainFrame),
		evaluate: vi.fn(async (fn: (node: unknown, arg?: unknown) => unknown, arg?: unknown) => {
			(globalThis as { document?: unknown }).document = document;
			return fn(target, arg);
		}),
		dispose: vi.fn(async () => undefined),
	};
	const box = {
		elementHandle: vi.fn(async () => handle),
		fill: vi.fn(async (text: string) => {
			calls.push(`fill:${text}`);
			target.value = text;
		}),
		focus: vi.fn(async () => {
			calls.push("focus");
			document.activeElement = target;
		}),
	};
	const page = {
		url: () => (urls.length > 1 ? urls.shift()! : urls[0]!),
		mainFrame: () => mainFrame,
		waitForLoadState: vi.fn(async () => {
			calls.push("load");
		}),
		context: () => ({ newCDPSession: async () => ({ send, detach: vi.fn(async () => undefined) }) }),
	};
	return {
		page: page as unknown as Page,
		box: box as unknown as Locator,
		taken: box.elementHandle,
		calls,
		target,
		other,
		send,
		handle,
	};
}

const password: CompanyAccountFill = {
	field: "password",
	value: "Pw-1234567890abcdEFGH",
	hosts,
	notAfterMs: Number.MAX_SAFE_INTEGER,
};

describe("company account fill", () => {
	it("marks the box private, waits for the page, empties and focuses the box, then inserts the value once", async () => {
		const f = fixture({});
		await fillCompanyAccountBox(f.page, f.box, password);
		expect(f.calls).toEqual(["load", "fill:", "focus", "Input.insertText"]);
		expect(f.target.value).toBe(password.value);
		expect(f.target.attributes.has(COMPANY_ACCOUNT_FILLED_ATTRIBUTE)).toBe(true);
		expect(f.handle.dispose).toHaveBeenCalled();
	});

	it("leaves a login box readable", async () => {
		const f = fixture({ box: { type: "email" } });
		await fillCompanyAccountBox(f.page, f.box, { ...password, field: "login", value: "agents@nordlys.example" });
		expect(f.target.value).toBe("agents@nordlys.example");
		expect(f.target.attributes.size).toBe(0);
	});

	it("types nothing into another website, a frame or the wrong kind of box", async () => {
		const code = { ...password, field: "code" as const, value: "123456" };
		const cases: Array<[Parameters<typeof fixture>[0], CompanyAccountFill, string]> = [
			[{ url: "https://evil.example/login" }, password, "ACCOUNT_FILL_WRONG_SITE"],
			[{ inFrame: true }, password, "ACCOUNT_FILL_IN_FRAME"],
			[{ box: { type: "text" } }, password, "ACCOUNT_FILL_WRONG_BOX"],
			[
				{ box: { type: "password" } },
				{ ...password, field: "login", value: "a@b.example" },
				"ACCOUNT_FILL_WRONG_BOX",
			],
			[{ box: { tagName: "TEXTAREA", type: "text" } }, code, "ACCOUNT_FILL_WRONG_BOX"],
			[{ box: { disabled: true } }, password, "ACCOUNT_FILL_WRONG_BOX"],
			[{ box: { readOnly: true } }, password, "ACCOUNT_FILL_WRONG_BOX"],
			[{ box: { type: "checkbox" } }, code, "ACCOUNT_FILL_WRONG_BOX"],
			// The page moved to another website after the box was checked.
			[{ url: ["https://vercel.com/login", "https://evil.example/"] }, password, "ACCOUNT_FILL_WRONG_SITE"],
		];
		for (const [options, fill, reason] of cases) {
			const f = fixture(options);
			const error = await fillCompanyAccountBox(f.page, f.box, fill).catch((caught: unknown) => caught);
			expect(error, JSON.stringify(options)).toBeInstanceOf(CompanyAccountFillRefusedError);
			expect((error as CompanyAccountFillRefusedError).reason, JSON.stringify(options)).toBe(reason);
			expect(f.send, JSON.stringify(options)).not.toHaveBeenCalled();
			// A box that was looked at is always let go.
			expect(f.handle.dispose.mock.calls.length).toBe(f.taken.mock.calls.length);
		}
	});

	it("empties and hides the value where it landed when a page script took the focus meanwhile", async () => {
		const f = fixture({ stealFocus: true });
		await expect(fillCompanyAccountBox(f.page, f.box, password)).rejects.toThrow("ACCOUNT_FILL_UNCONFIRMED");
		expect(f.other.value).toBe("");
		expect(f.other.attributes.has(COMPANY_ACCOUNT_FILLED_ATTRIBUTE)).toBe(true);
		expect(f.target.value).toBe("");
	});

	it("follows the focus into a shadow root to empty the value there", async () => {
		const f = fixture({ stealFocus: "shadow" });
		await expect(fillCompanyAccountBox(f.page, f.box, password)).rejects.toThrow("ACCOUNT_FILL_UNCONFIRMED");
		expect(f.other.value).toBe("");
		expect(f.other.attributes.has(COMPANY_ACCOUNT_FILLED_ATTRIBUTE)).toBe(true);
	});

	it("counts a box that holds the whole value as filled, even after the page moved the focus on", async () => {
		const f = fixture({ advance: true, box: { type: "text" } });
		f.other.value = "Office laptop";
		await fillCompanyAccountBox(f.page, f.box, { ...password, field: "code", value: "123456" });
		expect(f.target.value).toBe("123456");
		expect(f.other.value).toBe("Office laptop");
		expect(f.other.attributes.size).toBe(0);
	});

	it("tells the caller the value is lost when it went where nothing can empty it", async () => {
		const f = fixture({ stealInto: "editable" });
		await expect(fillCompanyAccountBox(f.page, f.box, password)).rejects.toThrow("ACCOUNT_FILL_LOST");
	});

	it("says so when the box does not hold what was typed", async () => {
		const f = fixture({ keeps: 1 });
		await expect(fillCompanyAccountBox(f.page, f.box, password)).rejects.toThrow("ACCOUNT_FILL_UNCONFIRMED");
		expect(f.send).toHaveBeenCalledTimes(1);
	});
});

describe("filled values on one screen", () => {
	it("hides a password in each spelling a page address uses, and a code only as a number of its own", () => {
		const filled = new CompanyComputerFilledValues();
		filled.add("Pw-1234567890@abcd#EF+GH", "password");
		filled.add("123456", "code");
		expect(filled.hide("https://x.example/?pw=Pw-1234567890%40abcd%23EF%2BGH")).toBe(
			"https://x.example/?pw=[hidden]",
		);
		expect(filled.shows("https://x.example/?pw=Pw-1234567890%40abcd%23EF%2BGH")).toBe(true);
		expect(filled.hide("Order 4012345678, code 123456")).toBe("Order 4012345678, code [hidden]");
		expect(filled.shows("Order 4012345678")).toBe(false);
	});

	it("sees a value through up to three layers of encoding, in either letter case, and hides the whole query", () => {
		const filled = new CompanyComputerFilledValues();
		const value = "Pw-1234567890@abcd#EF+GH";
		filled.add(value, "password");
		filled.add("123456", "code");
		const once = encodeURIComponent(value);
		const twice = encodeURIComponent(`https://vercel.com/login?pw=${once}`);
		for (const text of [
			`https://x.example/next?return_to=${twice}`,
			`https://x.example/?pw=${once.replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase())}`,
			`https://x.example/?pw=${encodeURIComponent(twice)}`,
			"https://x.example/?q=%22123456%22",
		])
			expect(filled.showsDecoded(text), text).toBe(true);
		expect(filled.showsDecoded("https://x.example/?q=4012345678")).toBe(false);
		expect(filled.hideAddress(`https://x.example/next?return_to=${twice}#top`)).toBe(
			"https://x.example/next?[hidden]#[hidden]",
		);
		expect(filled.hideAddress(`https://x.example/u/${once}/edit`)).toBe("https://x.example/[hidden]");
		expect(filled.hideAddress("https://x.example/plain?q=1")).toBe("https://x.example/plain?q=1");
		expect(filled.hideText(`Moved to ${twice}`)).toBe("[hidden]");
		expect(filled.hideText("Sign in")).toBe("Sign in");
	});

	it("drops spent codes before it drops a password", () => {
		let now = 0;
		const filled = new CompanyComputerFilledValues(() => now);
		filled.add("Pw-keep-this-one-please", "password");
		for (let i = 0; i < 63; i++) filled.add(String(100000 + i), "code");
		now += 5 * 60_000;
		filled.add("234567", "code");
		expect(filled.current()).toContain("Pw-keep-this-one-please");
	});

	it("hides passwords for good and codes for five minutes, never a login, and keeps the newest 64", () => {
		let now = 1_000;
		const filled = new CompanyComputerFilledValues(() => now);
		filled.add("Pw-1234567890abcdEFGH", "password");
		filled.add("493817", "code");
		filled.add("agents@nordlys.example", "login");
		expect(filled.current()).toEqual(["Pw-1234567890abcdEFGH", "493817"]);
		expect(filled.hide("https://x.example/?q=493817&p=Pw-1234567890abcdEFGH")).toBe(
			"https://x.example/?q=[hidden]&p=[hidden]",
		);
		expect(filled.shows("Results for 493817")).toBe(true);
		expect(filled.shows("agents@nordlys.example")).toBe(false);
		now += 5 * 60_000;
		expect(filled.current()).toEqual(["Pw-1234567890abcdEFGH"]);
		for (let i = 0; i < 70; i++) filled.add(`Pw-${String(i).padStart(20, "0")}`, "password");
		expect(filled.current()).toHaveLength(64);
		expect(filled.current()).not.toContain("Pw-1234567890abcdEFGH");
	});
});
