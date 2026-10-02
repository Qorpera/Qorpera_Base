import type { CompanyAccountFill } from "@qorpera/runtime/cloud-company-account-fill-box";
import {
	COMPANY_ACCOUNT_FILLED_ATTRIBUTE,
	CompanyAccountFillRefusedError,
	companyAccountFillHost,
	fillCompanyAccountBox,
} from "@qorpera/runtime/cloud-company-computer-account-fill";
import type { Locator, Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";

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

/** A page with one box, as Playwright hands it to the fill: every call recorded. */
function fixture(options: {
	url?: string | string[];
	element?: { input?: boolean; type?: string; disabled?: boolean; readOnly?: boolean };
	inFrame?: boolean;
	focused?: boolean;
	length?: number;
}) {
	const urls = Array.isArray(options.url) ? [...options.url] : [options.url ?? "https://vercel.com/login"];
	const calls: string[] = [];
	const attributes = new Map<string, string>();
	const mainFrame = {};
	const element = {
		input: true,
		type: "password",
		disabled: false,
		readOnly: false,
		...options.element,
	};
	const send = vi.fn(async (method: string, params: { text: string }) => {
		calls.push(`${method}:${params.text}`);
	});
	const handle = {
		ownerFrame: async () => (options.inFrame ? {} : mainFrame),
		// The page side of each evaluate, by what it is asked: mark, focus check, or length.
		evaluate: vi.fn(async (_fn: unknown, arg?: { types: string[]; attribute: string | null }) => {
			if (arg) {
				calls.push("check");
				if (!element.input || element.disabled || element.readOnly || !arg.types.includes(element.type))
					return false;
				if (arg.attribute) attributes.set(arg.attribute, "");
				return true;
			}
			const kind = calls.some((call) => call.startsWith("Input.insertText")) ? "length" : "focus";
			calls.push(kind);
			return kind === "focus" ? (options.focused ?? true) : (options.length ?? 21);
		}),
		dispose: vi.fn(async () => undefined),
	};
	const box = {
		elementHandle: vi.fn(async () => handle),
		fill: vi.fn(async (text: string) => {
			calls.push(`fill:${text}`);
		}),
		focus: vi.fn(async () => {
			calls.push("focus-box");
		}),
	};
	const page = {
		url: () => (urls.length > 1 ? urls.shift()! : urls[0]!),
		mainFrame: () => mainFrame,
		context: () => ({
			newCDPSession: async () => ({ send, detach: vi.fn(async () => undefined) }),
		}),
	} as unknown as Page;
	return { page, box: box as unknown as Locator, taken: box.elementHandle, calls, attributes, send, handle };
}

const password: CompanyAccountFill = {
	field: "password",
	value: "Pw-1234567890abcdEFGH",
	hosts,
	notAfterMs: Number.MAX_SAFE_INTEGER,
};

describe("company account fill", () => {
	it("marks the box private, empties and focuses it, then inserts the value once", async () => {
		const f = fixture({});
		await fillCompanyAccountBox(f.page, f.box, password);
		expect(f.calls).toEqual(["check", "fill:", "focus-box", "focus", `Input.insertText:${password.value}`, "length"]);
		expect(f.attributes.has(COMPANY_ACCOUNT_FILLED_ATTRIBUTE)).toBe(true);
		expect(f.handle.dispose).toHaveBeenCalled();
	});

	it("leaves a login box readable", async () => {
		const f = fixture({ element: { type: "email" }, length: 22 });
		await fillCompanyAccountBox(f.page, f.box, { ...password, field: "login", value: "agents@nordlys.example" });
		expect(f.attributes.size).toBe(0);
	});

	it("types nothing into another website, a frame or the wrong kind of box", async () => {
		const cases: Array<[Parameters<typeof fixture>[0], CompanyAccountFill, string]> = [
			[{ url: "https://evil.example/login" }, password, "ACCOUNT_FILL_WRONG_SITE"],
			[{ inFrame: true }, password, "ACCOUNT_FILL_IN_FRAME"],
			[{ element: { type: "text" } }, password, "ACCOUNT_FILL_WRONG_BOX"],
			[
				{ element: { type: "password" } },
				{ ...password, field: "login", value: "a@b.example" },
				"ACCOUNT_FILL_WRONG_BOX",
			],
			[{ element: { input: false } }, password, "ACCOUNT_FILL_WRONG_BOX"],
			[{ element: { disabled: true } }, password, "ACCOUNT_FILL_WRONG_BOX"],
			[{ element: { readOnly: true } }, password, "ACCOUNT_FILL_WRONG_BOX"],
			[{ element: { type: "checkbox" } }, { ...password, field: "code", value: "123456" }, "ACCOUNT_FILL_WRONG_BOX"],
			// The page moved to another website after the box was checked.
			[{ url: ["https://vercel.com/login", "https://evil.example/"] }, password, "ACCOUNT_FILL_WRONG_SITE"],
			// Something else took the focus.
			[{ focused: false }, password, "ACCOUNT_FILL_WRONG_BOX"],
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

	it("says so when the box does not hold what was typed", async () => {
		const f = fixture({ length: 1 });
		await expect(fillCompanyAccountBox(f.page, f.box, password)).rejects.toThrow("ACCOUNT_FILL_UNCONFIRMED");
		expect(f.send).toHaveBeenCalledTimes(1);
	});
});
