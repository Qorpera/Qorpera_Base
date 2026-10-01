import type { Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import {
	COMPANY_COMPUTER_PRIVATE_FIELD_SELECTOR,
	readCompanyComputerPrivateValues,
	redactCompanyComputerSnapshot,
} from "../src/cloud-company-computer-private-fields.ts";

// Recorded from Playwright 1.62.1 with Chromium 1234 (`page.locator("body").ariaSnapshot()`)
// after filling a sign-in form: the aria snapshot copies every box's value, password boxes included.
const SIGN_IN = [
	"- text: Email",
	'- textbox "Email": agents@nordlys.example',
	"- text: Password",
	'- textbox "Password":',
	"  - /placeholder: Your password",
	"  - text: hunter2-secret",
	"- text: Shown",
	'- textbox "Shown": "we\\"ird\\\\pa: ss"',
	"- text: Code",
	'- textbox "Code": "123456"',
	"- text: Search",
	'- searchbox "Search": pricing',
	"- text: Inner",
	'- textbox "Inner": shadow-pass-9',
	'- paragraph: "Echo: hunter2-secret"',
	'- button "Sign in"',
].join("\n");
const PRIVATE = ["hunter2-secret", 'we"ird\\pa: ss', "123456", "shadow-pass-9"];

describe("company computer private fields", () => {
	it("leaves a page without a private value as it is", () => {
		expect(redactCompanyComputerSnapshot(SIGN_IN, [])).toBe(SIGN_IN);
	});

	it("hides every typed value and every private value the page shows elsewhere", () => {
		const hidden = redactCompanyComputerSnapshot(SIGN_IN, PRIVATE);
		for (const value of [...PRIVATE, 'we\\"ird\\\\pa: ss', "agents@nordlys.example", "pricing"])
			expect(hidden).not.toContain(value);
		expect(hidden).toBe(
			[
				"- text: Email",
				'- textbox "Email": [hidden]',
				"- text: Password",
				'- textbox "Password":',
				"  - /placeholder: Your password",
				"  - text: [hidden]",
				"- text: Shown",
				'- textbox "Shown": [hidden]',
				"- text: Code",
				'- textbox "Code": [hidden]',
				"- text: Search",
				'- searchbox "Search": [hidden]',
				"- text: Inner",
				'- textbox "Inner": [hidden]',
				'- paragraph: "Echo: [hidden]"',
				'- button "Sign in"',
			].join("\n"),
		);
	});

	it("hides a short value in its box but not in the page's own text", () => {
		const snapshot = ['- textbox "PIN":', "  - /placeholder: PIN", "  - text: 042", '- paragraph: "Room 042"'].join(
			"\n",
		);
		expect(redactCompanyComputerSnapshot(snapshot, ["042"])).toBe(
			['- textbox "PIN":', "  - /placeholder: PIN", "  - text: [hidden]", '- paragraph: "Room 042"'].join("\n"),
		);
	});

	it("reads names with quotes and colons, attributes and every text-entry role", () => {
		const snapshot = [
			'- textbox "Say \\"hi\\": now" [disabled] [ref=e5]: hello there',
			'- spinbutton "Amount": "12"',
			'- combobox "Country" [expanded]: Denmark',
			"- textbox [ref=e9]: no name",
			'- checkbox "Remember me" [checked]',
			'- link "Forgot: password?":',
			"  - /url: /reset",
			"  - text: keep this",
		].join("\n");
		expect(redactCompanyComputerSnapshot(snapshot, ["xxxx"])).toBe(
			[
				'- textbox "Say \\"hi\\": now" [disabled] [ref=e5]: [hidden]',
				'- spinbutton "Amount": [hidden]',
				'- combobox "Country" [expanded]: [hidden]',
				"- textbox [ref=e9]: [hidden]",
				'- checkbox "Remember me" [checked]',
				'- link "Forgot: password?":',
				"  - /url: /reset",
				"  - text: keep this",
			].join("\n"),
		);
	});

	it("stops hiding child lines when the box's block ends", () => {
		const snapshot = [
			"- group:",
			'  - textbox "Password":',
			"    - /placeholder: Password",
			"    - text: s3cr3t-value",
			"  - text: Shown after the box",
		].join("\n");
		expect(redactCompanyComputerSnapshot(snapshot, ["s3cr3t-value"])).toBe(
			[
				"- group:",
				'  - textbox "Password":',
				"    - /placeholder: Password",
				"    - text: [hidden]",
				"  - text: Shown after the box",
			].join("\n"),
		);
	});

	it("hides a value whose spaces the page collapsed", () => {
		expect(redactCompanyComputerSnapshot('- paragraph: "You typed: pass  word  here"', ["pass  word  here"])).toBe(
			'- paragraph: "You typed: pass  word  here"'.replace("pass  word  here", "[hidden]"),
		);
		expect(redactCompanyComputerSnapshot("- paragraph: You typed pass word here", ["pass  word  here"])).toBe(
			"- paragraph: You typed [hidden]",
		);
	});

	it("never finds a value again across the marker", () => {
		expect(redactCompanyComputerSnapshot('- textbox "Code": hidden', ["hidden"])).toBe('- textbox "Code": [hidden]');
		expect(redactCompanyComputerSnapshot("- paragraph: [hidden]x", ["[hidden]x"])).toBe("- paragraph: [hidden]");
	});

	it("reads the private boxes of the top document through the page", async () => {
		const evaluate = vi.fn(async () => ["hunter2", "hunter2", "123456"]);
		await expect(readCompanyComputerPrivateValues({ evaluate } as unknown as Page)).resolves.toEqual([
			"hunter2",
			"123456",
		]);
		expect(evaluate).toHaveBeenCalledWith(expect.any(Function), {
			selector: COMPANY_COMPUTER_PRIVATE_FIELD_SELECTOR,
			maxFields: 64,
			maxValue: 4096,
		});
	});

	it("refuses an answer it cannot trust", async () => {
		for (const answer of [null, "hunter2", [1], Array.from({ length: 65 }, () => "x")]) {
			const page = { evaluate: vi.fn(async () => answer) } as unknown as Page;
			await expect(readCompanyComputerPrivateValues(page)).rejects.toThrow("PRIVATE_FIELD_UNREADABLE");
		}
	});

	it("covers password, code and card boxes, also when a page shows a password as text", () => {
		for (const part of [
			'input[type="password" i]',
			'input[autocomplete~="current-password" i]',
			'input[autocomplete~="new-password" i]',
			'input[autocomplete~="one-time-code" i]',
			'input[autocomplete*="cc-" i]',
			'input[name*="password" i]',
			'input[id*="otp" i]',
			'input[aria-label*="verif" i][aria-label*="code" i]',
		])
			expect(COMPANY_COMPUTER_PRIVATE_FIELD_SELECTOR.split(",")).toContain(part);
	});
});
