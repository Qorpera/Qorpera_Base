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
	/** The page keeps its box a text box: setting the box's type does nothing. */
	typeStays?: boolean;
	/** A page script makes the box show its text again when it takes the focus, or while the value goes in. */
	showAgain?: "focus" | "typing";
}) {
	const urls = Array.isArray(options.url) ? [...options.url] : [options.url ?? "https://vercel.com/login"];
	const target = fakeBox(options.box);
	if (options.typeStays) Object.defineProperty(target, "type", { get: () => "text", set: () => undefined });
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
		if (options.showAgain === "typing") target.type = "text";
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
			if (options.showAgain === "focus") target.type = "text";
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

/** An HMAC hook's secret, for the sender's settings page on the hook's site (E3b-3). */
const hookSecret: CompanyAccountFill = {
	field: "signing_secret",
	value: `whsec_${Buffer.alloc(32, 7).toString("base64")}`,
	hosts: ["app.example.com"],
	notAfterMs: Number.MAX_SAFE_INTEGER,
};
const hookPage = "https://app.example.com/settings/webhooks";

describe("a signed hook's secret", () => {
	it("makes the site's box a password box before the secret goes in, and marks it private", async () => {
		for (const type of ["text", "password"]) {
			const f = fixture({ url: hookPage, box: { type } });
			await fillCompanyAccountBox(f.page, f.box, hookSecret);
			expect(f.calls, type).toEqual(["load", "fill:", "focus", "Input.insertText"]);
			expect(f.target.type, type).toBe("password");
			expect(f.target.value, type).toBe(hookSecret.value);
			expect(f.target.attributes.has(COMPANY_ACCOUNT_FILLED_ATTRIBUTE), type).toBe(true);
		}
		// An account's code goes into its text box as the box is.
		const code = fixture({ box: { type: "text" } });
		await fillCompanyAccountBox(code.page, code.box, { ...password, field: "code", value: "123456" });
		expect(code.target.type).toBe("text");
	});

	it("types nothing into a box the page keeps from being a password box, or shows again before the typing", async () => {
		for (const options of [{ typeStays: true }, { showAgain: "focus" }] as const) {
			const f = fixture({ url: hookPage, box: { type: "text" }, ...options });
			await expect(fillCompanyAccountBox(f.page, f.box, hookSecret), JSON.stringify(options)).rejects.toThrow(
				"ACCOUNT_FILL_NOT_HIDDEN",
			);
			expect(f.send, JSON.stringify(options)).not.toHaveBeenCalled();
			expect(f.target.value).toBe("");
			expect(f.handle.dispose).toHaveBeenCalled();
		}
	});

	it("empties a box that shows the secret again while it goes in", async () => {
		const f = fixture({ url: hookPage, box: { type: "text" }, showAgain: "typing" });
		const error = await fillCompanyAccountBox(f.page, f.box, hookSecret).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(CompanyAccountFillRefusedError);
		expect((error as CompanyAccountFillRefusedError).reason).toBe("ACCOUNT_FILL_NOT_HIDDEN");
		expect(f.send).toHaveBeenCalledTimes(1);
		expect(f.target.value).toBe("");
	});

	it("types it only into a text or password box on the hook's own site", async () => {
		const cases: Array<[Parameters<typeof fixture>[0], string]> = [
			[{ url: "https://vercel.com/login" }, "ACCOUNT_FILL_WRONG_SITE"],
			[{ url: "http://app.example.com/settings/webhooks" }, "ACCOUNT_FILL_WRONG_SITE"],
			[{ url: hookPage, box: { type: "email" } }, "ACCOUNT_FILL_WRONG_BOX"],
			[{ url: hookPage, box: { type: "tel" } }, "ACCOUNT_FILL_WRONG_BOX"],
			[{ url: hookPage, box: { tagName: "TEXTAREA", type: "text" } }, "ACCOUNT_FILL_WRONG_BOX"],
			[{ url: hookPage, box: { type: "text", readOnly: true } }, "ACCOUNT_FILL_WRONG_BOX"],
			[{ url: hookPage, box: { type: "text", disabled: true } }, "ACCOUNT_FILL_WRONG_BOX"],
		];
		for (const [options, reason] of cases) {
			const f = fixture(options);
			const error = await fillCompanyAccountBox(f.page, f.box, hookSecret).catch((caught: unknown) => caught);
			expect((error as CompanyAccountFillRefusedError).reason, JSON.stringify(options)).toBe(reason);
			expect(f.send, JSON.stringify(options)).not.toHaveBeenCalled();
			// A box that is refused stays as the page made it.
			expect(f.target.type, JSON.stringify(options)).toBe(options.box?.type ?? "password");
		}
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
			// Four encodings deep: three decodes reach the spelling an address uses.
			`https://x.example/?pw=${encodeURIComponent(encodeURIComponent(twice))}`,
			"https://x.example/?q=%22123456%22",
		])
			expect(filled.showsDecoded(text), text).toBe(true);
		expect(filled.showsDecoded("https://x.example/?q=4012345678")).toBe(false);
		// Five deep is past what the check reads (an address would not fit a page's limits anyway).
		expect(filled.showsDecoded(encodeURIComponent(encodeURIComponent(encodeURIComponent(twice))))).toBe(false);
		// A value in the host itself: none of the address is kept.
		expect(filled.hideAddress("https://123456.example.com/next")).toBe("[hidden]");
		expect(filled.hideAddress(`https://x.example/next?return_to=${twice}#top`)).toBe(
			"https://x.example/next?[hidden]#[hidden]",
		);
		expect(filled.hideAddress(`https://x.example/u/${once}/edit`)).toBe("https://x.example/[hidden]");
		expect(filled.hideAddress("https://x.example/plain?q=1")).toBe("https://x.example/plain?q=1");
		expect(filled.hideText(`Moved to ${twice}`)).toBe("[hidden]");
		expect(filled.hideText("Sign in")).toBe("Sign in");
	});

	it("reads escapes of a value that is not ASCII as UTF-8 in either letter case, or byte by byte", () => {
		const filled = new CompanyComputerFilledValues();
		const value = "Æblegrød-1234567890!x";
		filled.add(value, "password");
		const lower = encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase());
		expect(filled.shows(lower)).toBe(false);
		for (const text of [lower, encodeURIComponent(lower), escape(value)])
			expect(filled.showsDecoded(`https://x.example/?pw=${text}`), text).toBe(true);
	});

	it("reads a page full of escapes that are not UTF-8 without failing, in time", () => {
		const filled = new CompanyComputerFilledValues();
		filled.add("Pw-1234567890@abcd#EF+GH", "password");
		const started = performance.now();
		expect(filled.showsDecoded(`${"%FF".repeat(130_000)} ${"%FFa ".repeat(50_000)}`)).toBe(false);
		expect(performance.now() - started).toBeLessThan(5_000);
	});

	it("sees a password with spaces as a script writes it in a query, a space as +", () => {
		const filled = new CompanyComputerFilledValues();
		filled.add("Pw 1234567890!abcd", "password");
		expect(filled.shows("https://x.example/?q=Pw+1234567890!abcd")).toBe(true);
		expect(filled.hide("https://x.example/?q=Pw+1234567890!abcd")).toBe("https://x.example/?q=[hidden]");
	});

	it("hides a hook's secret for good, as a password", () => {
		let now = 1_000;
		const filled = new CompanyComputerFilledValues(() => now);
		filled.add(hookSecret.value, "signing_secret");
		now += 24 * 60 * 60_000;
		expect(filled.current()).toEqual([hookSecret.value]);
		expect(filled.hide(`https://x.example/?s=${encodeURIComponent(hookSecret.value)}`)).toBe(
			"https://x.example/?s=[hidden]",
		);
	});

	it("hides text shaped like a hook's signing secret with nothing typed, and not a masked one (E3c-3)", () => {
		const filled = new CompanyComputerFilledValues();
		const secret = "whsec_AbCdEfGhIjKlMnOpQrStUvWx0123+/=";
		expect(filled.current()).toEqual([]);
		expect(filled.hide(`Signing secret ${secret} Copy`)).toBe("Signing secret [hidden] Copy");
		expect(filled.hide(`https://x.example/?s=${encodeURIComponent(secret)}&a=1`)).toBe(
			"https://x.example/?s=[hidden]&a=1",
		);
		expect(filled.hideAddress(`https://x.example/hooks?s=${encodeURIComponent(secret).toLowerCase()}`)).toBe(
			"https://x.example/hooks?[hidden]",
		);
		expect(filled.showsDecoded(encodeURIComponent(`https://x.example/?s=${encodeURIComponent(secret)}`))).toBe(true);
		// Encoded twice or more, the whole secret is hidden, never down to its first escape (whose rest decodes back).
		const twice = encodeURIComponent(encodeURIComponent(secret));
		expect(filled.hide(`https://x.example/?s=${twice}&a=1`)).toBe("https://x.example/?s=[hidden]&a=1");
		expect(filled.hideText(`Moved to https://x.example/?s=${twice}`)).toBe("Moved to https://x.example/?s=[hidden]");
		expect(filled.hide("whsec_A%252BBCDEFGHIJKLMNOP and whsec_Q%25252FRSTUVWXYZ012345")).toBe(
			"[hidden] and [hidden]",
		);
		// A part of a secret recorded as a value (a refused read keeps what it saw) cuts no secret: the whole one goes first.
		const partial = new CompanyComputerFilledValues();
		partial.add("whsec_A", "signing_secret");
		expect(partial.hideText("whsec_A%252BBCDEFGHIJKLMNOP")).toBe("[hidden]");
		expect(partial.hide(`Signing secret ${secret} Copy`)).toBe("Signing secret [hidden] Copy");
		expect(partial.hideText(`Moved to https://x.example/?s=${twice}`)).toBe("Moved to https://x.example/?s=[hidden]");
		for (const text of ["Signing secret whsec_•••••••• Reveal", "Starts with whsec_", "whsec_... (hidden)"])
			expect(filled.shows(text), text).toBe(false);
	});

	it("hides the keys an agent takes as coding values with nothing typed, and not a listing's cut ones (20260930695000)", () => {
		const filled = new CompanyComputerFilledValues();
		const keys = [
			`npm_${"Ab12Cd34Ef".repeat(3)}Gh12Kl`,
			`ghp_${"a1".repeat(18)}`,
			`github_pat_${"A_1".repeat(27)}x`,
			`sk_live_${"Ab1".repeat(10)}`,
			`rk_test_${"Ab1".repeat(10)}`,
			"re_c1tpEyD8_NKFusih9vKVQknRAQfmFcWCv",
		];
		for (const key of keys) {
			expect(filled.hide(`Your new key ${key} Copy`), key).toBe("Your new key [hidden] Copy");
			expect(filled.hideText(`Moved to https://x.example/?k=${encodeURIComponent(key)}`), key).toBe(
				"Moved to https://x.example/?k=[hidden]",
			);
			expect(filled.hideAddress(`https://x.example/keys?k%3D${key}`), key).toBe("https://x.example/keys?[hidden]");
		}
		for (const text of [
			"Access tokens npm_AbCd… sk_live_…4xYz re_c1tp••••",
			"Restricted key rk_live_51H…",
			"const store_resource_name_for_the_page = 1",
			"re_render_the_page_again_after_update()",
			`pk_live_${"Ab1".repeat(10)}`,
		])
			expect(filled.shows(text), text).toBe(false);
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
