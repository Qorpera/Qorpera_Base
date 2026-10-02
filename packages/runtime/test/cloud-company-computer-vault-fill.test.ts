import { CompanyComputerFillKey, sealCompanyAccountFill } from "@qorpera/runtime/cloud-company-account-fill-box";
import { COMPANY_ACCOUNT_FILLED_ATTRIBUTE } from "@qorpera/runtime/cloud-company-computer-account-fill";
import {
	type CompanyComputerBrowserSession,
	CompanyComputerGuestAutomation,
} from "@qorpera/runtime/cloud-company-computer-guest";
import type { CompanyComputerAction } from "@qorpera/runtime/cloud-company-computer-tools";
import type { BrowserContext, Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import {
	computerBinding,
	computerEffect,
	computerId,
	computerLease,
	computerOperation,
} from "./fixtures/company-computer.ts";

const account = computerId(60);
const password = "Pw-1234567890abcdEFGH";

/** One sign-in page with one password box, as far as the fill and a snapshot use it. */
function office(options: { url?: string; key?: CompanyComputerFillKey | null } = {}) {
	const element = { tagName: "INPUT", type: "password", disabled: false, readOnly: false, value: "" };
	const attributes = new Map<string, string>();
	const typed: string[] = [];
	const mainFrame = {};
	const handle = {
		ownerFrame: async () => mainFrame,
		// The page side of each evaluate: the focus check answers yes, every other one sees the box.
		evaluate: vi.fn(async (fn: (node: unknown, arg?: unknown) => unknown, arg?: unknown) =>
			String(fn).includes("activeElement")
				? true
				: fn(
						{
							tagName: element.tagName,
							type: element.type,
							disabled: element.disabled,
							readOnly: element.readOnly,
							get value() {
								return element.value;
							},
							setAttribute: (name: string, value: string) => attributes.set(name, value),
						},
						arg,
					),
		),
		dispose: async () => undefined,
	};
	const box = {
		count: vi.fn(async () => 1),
		elementHandle: async () => handle,
		fill: vi.fn(async (text: string) => {
			element.value = text;
		}),
		focus: vi.fn(async () => undefined),
	};
	const page = {
		isClosed: () => false,
		url: () => options.url ?? "https://vercel.com/login",
		title: async () => "Sign in",
		mainFrame: () => mainFrame,
		getByRole: vi.fn(() => box),
		// The private boxes' values (none read here) and the page's text for a snapshot.
		evaluate: vi.fn(async (): Promise<string[]> => []),
		frames: () => [page],
		isDetached: () => false,
		locator: vi.fn(() => ({ ariaSnapshot: async () => `- paragraph: Your password is ${element.value}` })),
		context: () => ({
			newCDPSession: async () => ({
				send: async (method: string, params: { text: string }) => {
					expect(method).toBe("Input.insertText");
					typed.push(params.text);
					element.value += params.text;
				},
				detach: async () => undefined,
			}),
		}),
	};
	const context = { pages: () => [page as unknown as Page], newPage: vi.fn() };
	const browser: CompanyComputerBrowserSession = {
		binding: computerBinding(),
		grant: { profileId: computerId(40), grantId: computerId(41), version: 1 },
		context: context as unknown as BrowserContext,
		assertActive: vi.fn(async () => undefined),
		close: vi.fn(async () => undefined),
	};
	const key = options.key === null ? undefined : (options.key ?? new CompanyComputerFillKey());
	const automation = new CompanyComputerGuestAutomation({
		binding: computerBinding(),
		layout: {
			workbenchRoot: "/srv/workbench",
			desktopHome: "/srv/desktop",
			screenStateRoot: "/srv/screens",
			browserProfilesRoot: "/srv/profiles",
		},
		boundary: { assertReady: vi.fn(async () => undefined) },
		browser,
		screenshots: { publish: vi.fn() },
		...(key ? { fillKey: key } : {}),
	});
	return { automation, key, element, attributes, typed, page };
}

const action = (field: "password" | "code" = "password"): CompanyComputerAction => ({
	kind: "browser",
	action: "vault_fill",
	role: "textbox",
	name: "Password",
	account,
	field,
});

/** What the vault sends for this call: the value sealed to the office's key. */
function sealed(key: CompanyComputerFillKey, receiptId = computerEffect().receiptId, field = "password") {
	const binding = computerBinding();
	return sealCompanyAccountFill({ value: password, hosts: ["vercel.com"] }, key.publicKey, {
		companyId: binding.companyId,
		companyComputerId: binding.companyComputerId,
		computerGeneration: binding.computerGeneration,
		receiptId,
		accountId: account,
		field: field as "password",
	});
}

function perform(f: ReturnType<typeof office>, value: CompanyComputerAction, fill?: Record<string, string>) {
	return f.automation.perform(
		value,
		computerLease(),
		{ ...computerEffect(), ...(fill ? { fill } : {}) },
		{
			...computerOperation(),
			arguments: value as never,
		},
	);
}

describe("vault_fill on the Company Computer", () => {
	it("opens the box with this boot's key, types the value once and hides it from every later snapshot", async () => {
		const f = office();
		expect(await perform(f, action(), sealed(f.key!))).toMatchObject({
			kind: "json",
			value: { action: "vault_fill", completed: true },
		});
		expect(f.typed).toEqual([password]);
		expect(f.element.value).toBe(password);
		expect(f.attributes.has(COMPANY_ACCOUNT_FILLED_ATTRIBUTE)).toBe(true);
		expect(f.page.getByRole).toHaveBeenCalledWith("textbox", { name: "Password", exact: true });
		// The page shows the value as text; the agent's snapshot does not.
		const snapshot = await perform(f, { kind: "browser", action: "snapshot" });
		expect(JSON.stringify(snapshot)).not.toContain(password);
	});

	it("types nothing without this boot's key, a box, or a box for this very call", async () => {
		const other = new CompanyComputerFillKey();
		for (const [f, fill, reason] of [
			[office({ key: null }), sealed(other), "ACCOUNT_FILL_UNAVAILABLE"],
			[office(), undefined, "ACCOUNT_FILL_UNAVAILABLE"],
			[office(), sealed(other), "ACCOUNT_FILL_UNOPENED"],
		] as const) {
			await expect(perform(f, action(), fill)).rejects.toThrow(reason);
			expect(f.typed).toEqual([]);
		}
		const f = office();
		await expect(perform(f, action(), sealed(f.key!, computerId(11)))).rejects.toThrow("ACCOUNT_FILL_UNOPENED");
		await expect(perform(f, action("code"), sealed(f.key!))).rejects.toThrow("ACCOUNT_FILL_UNOPENED");
		expect(f.typed).toEqual([]);
	});

	it("types nothing into another website", async () => {
		const f = office({ url: "https://evil.example/login" });
		await expect(perform(f, action(), sealed(f.key!))).rejects.toThrow("ACCOUNT_FILL_WRONG_SITE");
		expect(f.typed).toEqual([]);
	});
});
