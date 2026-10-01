import type { Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import {
	COMPANY_COMPUTER_PRIVATE_FIELD_SELECTOR,
	companyComputerPrivateFieldMasks,
	companyComputerPrivateValuesInDocument,
	readCompanyComputerPrivateValues,
	redactCompanyComputerSnapshot,
} from "../src/cloud-company-computer-private-fields.ts";

// Every snapshot below was recorded from Playwright 1.62.1 with Chromium 1234
// (`page.locator("body").ariaSnapshot()`) after filling the form: the aria
// snapshot copies every box's value, password boxes included.
const lines = (...all: string[]) => all.join("\n");

describe("company computer snapshot redaction", () => {
	it("leaves a page without a private value as it is", () => {
		const snapshot = lines('- textbox "Email": agents@nordlys.example', '- button "Sign in"');
		expect(redactCompanyComputerSnapshot(snapshot, [])).toBe(snapshot);
	});

	it("hides every typed value, a value under a placeholder, and the private values the page repeats", () => {
		const recorded = lines(
			"- text: Email",
			'- textbox "Email": agents@nordlys.example',
			"- text: Password",
			'- textbox "Password":',
			"  - /placeholder: Your password",
			"  - text: hunter2-secret",
			"- text: Code",
			'- textbox "Code": "123456"',
			"- text: Search",
			'- searchbox "Search": pricing',
			"- text: Inner",
			'- textbox "Inner": shadow-pass-9',
			'- paragraph: "Echo: hunter2-secret"',
			'- button "Sign in"',
		);
		expect(redactCompanyComputerSnapshot(recorded, ["hunter2-secret", "123456", "shadow-pass-9"])).toBe(
			lines(
				"- text: Email",
				'- textbox "Email": [hidden]',
				"- text: Password",
				'- textbox "Password":',
				"  - /placeholder: Your password",
				"  - text: [hidden]",
				"- text: Code",
				'- textbox "Code": [hidden]',
				"- text: Search",
				'- searchbox "Search": [hidden]',
				"- text: Inner",
				'- textbox "Inner": [hidden]',
				'- paragraph: "Echo: [hidden]"',
				'- button "Sign in"',
			),
		);
	});

	it("reads boxes whose key Playwright wraps in single quotes, and /regex/ names", () => {
		// Names with ": ", " #" or quotes make the whole key a single-quoted YAML scalar.
		const recorded = lines(
			'- text: "CVC: 3 digits"',
			'- \'textbox "CVC: 3 digits"\': "123"',
			'- text: "Card #"',
			'- \'textbox "Card #"\': "987"',
			'- text: "Security code: back of card"',
			"- 'textbox \"Security code: back of card\"':",
			"  - /placeholder: 3 digits",
			'  - text: "321"',
			"- text: /pw/",
			"- textbox /pw/: s3cret-pass",
			'- text: "Say \\"hi\\": now"',
			'- \'textbox "Say \\"hi\\": now"\': hello there',
			"- text: Root",
			'- textbox "Root": /srv',
			"- iframe",
		);
		expect(redactCompanyComputerSnapshot(recorded, ["123", "987", "321", "s3cret-pass"])).toBe(
			lines(
				'- text: "CVC: 3 digits"',
				"- 'textbox \"CVC: 3 digits\"': [hidden]",
				'- text: "Card #"',
				"- 'textbox \"Card #\"': [hidden]",
				'- text: "Security code: back of card"',
				"- 'textbox \"Security code: back of card\"':",
				"  - /placeholder: 3 digits",
				"  - text: [hidden]",
				"- text: /pw/",
				"- textbox /pw/: [hidden]",
				'- text: "Say \\"hi\\": now"',
				'- \'textbox "Say \\"hi\\": now"\': [hidden]',
				"- text: Root",
				'- textbox "Root": [hidden]',
				"- iframe",
			),
		);
	});

	it("hides a private value the page repeats inside a name, a quoted key, escaped or with its spaces collapsed", () => {
		const recorded = lines(
			'- textbox "Password": it\'s-secret',
			'- textbox "Repeat password": a\\b c"d',
			'- textbox "Old password": hunter2xyz',
			"- 'heading \"Your password: it''s-secret\" [level=2]'",
			'- paragraph: "You typed: a\\\\b c\\"d and hunter2xyz"',
			'- \'button "Use a\\\\b c\\"d: now"\'',
		);
		// The page wrote "hun&shy;ter2xyz" and the box held 'a\b   c"d'.
		expect(redactCompanyComputerSnapshot(recorded, ["it's-secret", 'a\\b   c"d', "hunter2xyz"])).toBe(
			lines(
				'- textbox "Password": [hidden]',
				'- textbox "Repeat password": [hidden]',
				'- textbox "Old password": [hidden]',
				"- 'heading \"Your password: [hidden]\" [level=2]'",
				'- paragraph: "You typed: [hidden] and [hidden]"',
				"- 'button \"Use [hidden]: now\"'",
			),
		);
	});

	it("hides a short value in its box but not in the page's own text", () => {
		const snapshot = lines('- textbox "PIN":', "  - /placeholder: PIN", "  - text: 042", '- paragraph: "Room 042"');
		expect(redactCompanyComputerSnapshot(snapshot, ["042"])).toBe(
			lines('- textbox "PIN":', "  - /placeholder: PIN", "  - text: [hidden]", '- paragraph: "Room 042"'),
		);
	});

	it("stops hiding child lines where the box's block ends", () => {
		const snapshot = lines(
			"- group:",
			'  - textbox "Password":',
			"    - /placeholder: Password",
			"    - text: s3cr3t-value",
			"  - text: Shown after the box",
			"- text: Not a box value",
		);
		expect(redactCompanyComputerSnapshot(snapshot, ["s3cr3t-value"])).toBe(
			lines(
				"- group:",
				'  - textbox "Password":',
				"    - /placeholder: Password",
				"    - text: [hidden]",
				"  - text: Shown after the box",
				"- text: Not a box value",
			),
		);
	});

	it("never matches a value across or inside the marker", () => {
		expect(redactCompanyComputerSnapshot('- textbox "Code": hidden', ["hidden"])).toBe('- textbox "Code": [hidden]');
		expect(redactCompanyComputerSnapshot("- paragraph: [hidden]x", ["[hidden]x"])).toBe("- paragraph: [hidden]");
	});

	it("refuses a snapshot that still shows a private value in a form it does not know", () => {
		// U+2010 hyphens: the same letters and digits, written differently.
		expect(() => redactCompanyComputerSnapshot("- paragraph: secret‐value‐1", ["secret-value-1"])).toThrow(
			"PRIVATE_FIELD_VISIBLE",
		);
		// A value with fewer than six letters and digits is not checked this way.
		expect(redactCompanyComputerSnapshot("- paragraph: ab‐cd", ["ab-cd"])).toBe("- paragraph: ab‐cd");
	});
});

/** A small document the in-page reader walks; an element is private only for the real selector. */
function fakeDocument(
	elements: Array<{ value?: unknown; private?: boolean; shadow?: Array<{ value?: unknown; private?: boolean }> }>,
	visibilityState = "visible",
) {
	const element = (spec: { value?: unknown; private?: boolean }) => ({
		value: spec.value,
		matches: (selector: string) => selector === COMPANY_COMPUTER_PRIVATE_FIELD_SELECTOR && spec.private === true,
	});
	return {
		visibilityState,
		querySelectorAll: () =>
			elements.map((spec) => ({
				...element(spec),
				shadowRoot: spec.shadow ? { querySelectorAll: () => spec.shadow!.map(element) } : null,
			})),
	};
}

describe("company computer private values", () => {
	const query = { selector: COMPANY_COMPUTER_PRIVATE_FIELD_SELECTOR, maxValues: 64, maxValue: 4096, shownOnly: false };
	const inDocument = (document: unknown, override: Partial<typeof query> = {}) => {
		vi.stubGlobal("document", document);
		try {
			return companyComputerPrivateValuesInDocument({ ...query, ...override });
		} finally {
			vi.unstubAllGlobals();
		}
	};

	it("reads the distinct values of private boxes, in open shadow roots too, and nothing else", () => {
		const document = fakeDocument([
			{ value: "agents@nordlys.example" },
			{ value: "hunter2", private: true },
			{ value: "", private: true },
			{ value: "hunter2", private: true },
			{ value: undefined, private: true, shadow: [{ value: "inner-9", private: true }, { value: "public" }] },
		]);
		expect(inDocument(document)).toEqual(["hunter2", "inner-9"]);
	});

	it("cuts long values, stops one past the limit, and reads nothing from a tab not shown", () => {
		expect(inDocument(fakeDocument([{ value: "x".repeat(5000), private: true }]))).toEqual(["x".repeat(4096)]);
		const many = fakeDocument(Array.from({ length: 80 }, (_, index) => ({ value: `v${index}`, private: true })));
		expect(inDocument(many, { maxValues: 3 })).toEqual(["v0", "v1", "v2", "v3"]);
		const hidden = fakeDocument([{ value: "hunter2", private: true }], "hidden");
		expect(inDocument(hidden, { shownOnly: true })).toEqual([]);
		expect(inDocument(hidden)).toEqual(["hunter2"]);
	});

	it("asks the top document, or every frame, and joins their answers", async () => {
		const evaluate = vi.fn(async () => ["hunter2", "123456"]);
		const frame = { evaluate: vi.fn(async () => ["123456", "4242424242424242"]) };
		const page = { evaluate, frames: () => [{ evaluate }, frame] } as unknown as Page;
		await expect(readCompanyComputerPrivateValues(page)).resolves.toEqual(["hunter2", "123456"]);
		expect(evaluate).toHaveBeenCalledWith(companyComputerPrivateValuesInDocument, {
			selector: COMPANY_COMPUTER_PRIVATE_FIELD_SELECTOR,
			maxValues: 64,
			maxValue: 4096,
			shownOnly: false,
		});
		await expect(readCompanyComputerPrivateValues(page, { allFrames: true, shownOnly: true })).resolves.toEqual([
			"hunter2",
			"123456",
			"4242424242424242",
		]);
		expect(frame.evaluate).toHaveBeenCalledWith(
			companyComputerPrivateValuesInDocument,
			expect.objectContaining({ shownOnly: true }),
		);
	});

	it("refuses an answer it cannot trust", async () => {
		for (const answer of [
			null,
			"hunter2",
			[1],
			["x".repeat(4097)],
			Array.from({ length: 65 }, (_, index) => `v${index}`),
		]) {
			const page = { evaluate: vi.fn(async () => answer) } as unknown as Page;
			await expect(readCompanyComputerPrivateValues(page)).rejects.toThrow("PRIVATE_FIELD_UNREADABLE");
		}
	});

	it("masks the private boxes of every frame", () => {
		const locators = [{ name: "top" }, { name: "card iframe" }];
		const frames = locators.map((locator) => ({ locator: vi.fn(() => locator) }));
		expect(companyComputerPrivateFieldMasks({ frames: () => frames } as unknown as Page)).toEqual(locators);
		for (const frame of frames) expect(frame.locator).toHaveBeenCalledWith(COMPANY_COMPUTER_PRIVATE_FIELD_SELECTOR);
	});

	it("covers password, code and card boxes, never hidden inputs or words that only contain otp", () => {
		const parts = COMPANY_COMPUTER_PRIVATE_FIELD_SELECTOR.split(",");
		for (const part of [
			'input[type="password" i]',
			'input:not([type="hidden" i])[autocomplete~="current-password" i]',
			'input:not([type="hidden" i])[autocomplete~="one-time-code" i]',
			'input:not([type="hidden" i])[autocomplete*="cc-" i]',
			'input:not([type="hidden" i])[name*="adgangskode" i]',
			'input:not([type="hidden" i])[id^="otp" i]',
			'input:not([type="hidden" i])[aria-label*="verif" i][aria-label*="code" i]',
		])
			expect(parts).toContain(part);
		expect(parts).not.toContain('input:not([type="hidden" i])[id*="otp" i]');
		for (const part of parts)
			expect(part === 'input[type="password" i]' || part.startsWith('input:not([type="hidden" i])[')).toBe(true);
	});
});
