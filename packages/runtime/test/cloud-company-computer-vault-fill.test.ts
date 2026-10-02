import { createHash } from "node:crypto";
import { CompanyComputerFillKey, sealCompanyAccountFill } from "@qorpera/runtime/cloud-company-account-fill-box";
import {
	COMPANY_ACCOUNT_FILLED_ATTRIBUTE,
	CompanyComputerFilledValues,
} from "@qorpera/runtime/cloud-company-computer-account-fill";
import {
	type CompanyComputerBrowserSession,
	CompanyComputerGuestAutomation,
} from "@qorpera/runtime/cloud-company-computer-guest";
import type { CompanyComputerAction } from "@qorpera/runtime/cloud-company-computer-tools";
import type { BrowserContext, Page } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	computerBinding,
	computerEffect,
	computerId,
	computerLease,
	computerOperation,
} from "./fixtures/company-computer.ts";

const account = computerId(60);
/** With the generator's symbols, which a page address percent-encodes. */
const password = "Pw-1234567890@ab!cd#EF+GH";

/** A synthetic PNG header the size of a page, as the guest checks it (not a real picture). */
function pngHeader(width = 1920, height = 1200): Uint8Array {
	const bytes = Buffer.alloc(33);
	Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
	bytes.writeUInt32BE(13, 8);
	bytes.write("IHDR", 12);
	bytes.writeUInt32BE(width, 16);
	bytes.writeUInt32BE(height, 20);
	return bytes;
}

const realGlobals = {
	document: (globalThis as { document?: unknown }).document,
	location: (globalThis as { location?: unknown }).location,
};
afterEach(() => {
	Object.assign(globalThis, realGlobals);
});

/** A node as the page's own code sees it. */
interface FakeNode {
	value?: string;
	shadowRoot?: { querySelectorAll(selector: string): FakeNode[]; textContent: string } | null;
	matches?(selector: string): boolean;
}

/**
 * One sign-in page with one password box. Every evaluate of the screen check runs the real in-page function
 * against this fake document: its title and address, its text, its boxes and an open shadow root.
 */
function office(
	options: {
		url?: string;
		key?: CompanyComputerFillKey | null;
		filled?: CompanyComputerFilledValues;
		/** A page script moves the focus somewhere with no value (an editable area) before the typing. */
		lose?: boolean;
	} = {},
) {
	const shown = {
		url: options.url ?? "https://vercel.com/login",
		title: "Sign in",
		text: "Sign in to Vercel",
		/** Another box on the page, not marked private (a "show password" that made a new one). */
		other: { value: "" },
		shadowText: "",
		/** A box inside the open shadow root. */
		shadowBox: { value: "" },
		/** Extra boxes and shadow roots on the page, to reach the check's limits. */
		extraBoxes: 0,
		extraRoots: 0,
		/** A link's address, as the snapshot lists it. */
		link: "https://vercel.com/",
	};
	const element = { tagName: "INPUT", type: "password", disabled: false, readOnly: false, value: "" };
	const attributes = new Map<string, string>();
	const typed: string[] = [];
	const mainFrame = {};
	const node = (box: { value: string }, marked: () => boolean): FakeNode => ({
		get value() {
			return box.value;
		},
		matches: (selector) =>
			selector === "input, textarea" ? true : selector === `[${COMPANY_ACCOUNT_FILLED_ATTRIBUTE}]` && marked(),
	});
	const shadowHost: FakeNode = {
		get shadowRoot() {
			return { querySelectorAll: () => [node(shown.shadowBox, () => false)], textContent: shown.shadowText };
		},
	};
	const runScreenCheck = (fn: (arg: unknown) => unknown, arg: unknown) => {
		Object.assign(globalThis, {
			document: {
				title: shown.title,
				documentElement: { innerText: shown.text },
				querySelectorAll: () => [
					node(element, () => attributes.has(COMPANY_ACCOUNT_FILLED_ATTRIBUTE)),
					node(shown.other, () => false),
					shadowHost,
					...Array.from({ length: shown.extraBoxes }, () => node({ value: "x" }, () => false)),
					...Array.from({ length: shown.extraRoots }, () => ({
						shadowRoot: { querySelectorAll: () => [], textContent: "" },
					})),
				],
			},
			location: { href: shown.url },
		});
		return fn(arg);
	};
	const handle = {
		ownerFrame: async () => mainFrame,
		// The page side of the fill: the focus check before typing, then where the value landed.
		evaluate: vi.fn(async (fn: (node: unknown, arg?: unknown) => unknown, arg?: unknown) =>
			String(fn).includes("activeElement") && !String(fn).includes("shadowRoot")
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
		close: vi.fn(async () => undefined),
		url: () => shown.url,
		title: async () => shown.title,
		waitForLoadState: async () => undefined,
		mainFrame: () => mainFrame,
		getByRole: vi.fn(() => box),
		// The screen check's own function runs against the fake document; the private-box reader finds none.
		evaluate: vi.fn(
			async (fn: (arg: unknown) => unknown, arg?: unknown): Promise<unknown> =>
				arg === COMPANY_ACCOUNT_FILLED_ATTRIBUTE ? runScreenCheck(fn, arg) : [],
		),
		screenshot: vi.fn(async () => pngHeader()),
		frames: () => [page],
		isDetached: () => false,
		locator: vi.fn(() => ({
			ariaSnapshot: async () =>
				`- textbox "Subject": Quarterly invoice\n- paragraph: ${shown.text}\n- textbox "Password": ${element.value}\n- link "Back":\n  - /url: ${shown.link}`,
		})),
		context: () => ({
			newCDPSession: async () => ({
				send: async (method: string, params: { text: string }) => {
					expect(method).toBe("Input.insertText");
					typed.push(params.text);
					if (options.lose) {
						// The focus went to an editable area: the value is in the page, not in the box.
						Object.assign(globalThis, { document: { activeElement: { tagName: "DIV", setAttribute() {} } } });
						return;
					}
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
	const commands = {
		run: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
		capturePng: vi.fn(async () => pngHeader()),
	};
	const automationScreenshots = {
		publish: vi.fn(async (bytes: Uint8Array) => ({
			assetId: computerId(50),
			sha256: createHash("sha256").update(bytes).digest("hex"),
			bytes: bytes.length,
			mediaType: "image/png" as const,
		})),
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
		commands,
		screenshots: automationScreenshots,
		...(key ? { fillKey: key } : {}),
		...(options.filled ? { filled: options.filled } : {}),
	});
	return { automation, key, element, attributes, typed, page, shown, commands, screenshots: automationScreenshots };
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
function sealed(
	key: CompanyComputerFillKey,
	receiptId = computerEffect().receiptId,
	field = "password",
	at = Date.now(),
) {
	const binding = computerBinding();
	return sealCompanyAccountFill(
		{ value: password, hosts: ["vercel.com"] },
		key.publicKey,
		{
			companyId: binding.companyId,
			companyComputerId: binding.companyComputerId,
			computerGeneration: binding.computerGeneration,
			receiptId,
			accountId: account,
			field: field as "password",
		},
		at,
	);
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

const screenshot = (f: ReturnType<typeof office>, surface: "browser" | "desktop") =>
	f.automation.perform({ kind: "screenshot", surface }, computerLease(), computerEffect(), {
		...computerOperation(),
		tool: "computer_screenshot",
		arguments: { kind: "screenshot", surface },
	});

describe("vault_fill on the Company Computer", () => {
	it("opens the box with this boot's key, types the value once and hides it from later snapshots", async () => {
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
		f.shown.text = `Your password is ${password}`;
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

	it("hides the value in titles and addresses, also percent-encoded, in this run and a later one", async () => {
		const filled = new CompanyComputerFilledValues();
		const f = office({ filled });
		await perform(f, action(), sealed(f.key!));
		// A form without a method puts the password in the address, as a browser encodes it.
		f.shown.url = `https://vercel.com/login?pw=${encodeURIComponent(password)}`;
		f.shown.title = `Results for ${password}`;
		const snapshot = JSON.stringify(await perform(f, { kind: "browser", action: "snapshot" }));
		const tabs = JSON.stringify(await perform(f, { kind: "browser", action: "list_tabs" }));
		for (const value of [password, encodeURIComponent(password)]) {
			expect(snapshot).not.toContain(value);
			expect(tabs).not.toContain(value);
		}
		// A later run's automation on the same screen shares the store, and other typed text stays readable.
		const later = office({ filled });
		later.shown.url = f.shown.url;
		const again = JSON.stringify(await perform(later, { kind: "browser", action: "snapshot" }));
		expect(again).not.toContain(encodeURIComponent(password));
		expect(again).toContain("Quarterly invoice");
	});

	it("takes no picture while the page shows the value as text, in an address, an unmarked box or a shadow root", async () => {
		const shows: Array<[string, (f: ReturnType<typeof office>) => void]> = [
			[
				"text",
				(f) => {
					f.shown.text = `Your password is ${password}`;
				},
			],
			[
				"address",
				(f) => {
					f.shown.url = `https://vercel.com/?pw=${encodeURIComponent(password)}`;
				},
			],
			[
				"unmarked box",
				(f) => {
					f.shown.other.value = password;
				},
			],
			[
				"shadow root",
				(f) => {
					f.shown.shadowText = `Copied ${password}`;
				},
			],
		];
		for (const [where, show] of shows) {
			for (const surface of ["browser", "desktop"] as const) {
				const f = office();
				await perform(f, action(), sealed(f.key!));
				show(f);
				await expect(screenshot(f, surface), `${where} ${surface}`).rejects.toThrow("PRIVATE_FIELD_ON_SCREEN");
				expect(f.page.screenshot).not.toHaveBeenCalled();
				expect(f.commands.capturePng).not.toHaveBeenCalled();
			}
		}
		// Only in its own box, marked private and masked in a browser picture: the picture is taken.
		const f = office();
		await perform(f, action(), sealed(f.key!));
		await expect(screenshot(f, "browser")).resolves.toMatchObject({ kind: "json" });
		expect(f.page.screenshot).toHaveBeenCalledOnce();
	});

	it("hides the value two encodings deep and in lower-case hex, and refuses a snapshot where it survives", async () => {
		const f = office();
		await perform(f, action(), sealed(f.key!));
		const once = encodeURIComponent(password);
		const twice = encodeURIComponent(`https://vercel.com/login?pw=${once}`);
		// A redirect that wraps the address, and a site that writes lower-case escapes.
		f.shown.url = `https://vercel.com/next?return_to=${twice}`;
		f.shown.link = `https://vercel.com/?pw=${once.replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase())}`;
		const snapshot = JSON.stringify(await perform(f, { kind: "browser", action: "snapshot" }));
		const tabs = JSON.stringify(await perform(f, { kind: "browser", action: "list_tabs" }));
		for (const shown of [snapshot, tabs]) {
			expect(shown).toContain("[hidden]");
			expect(shown).not.toMatch(/Pw-1234567890|%2540|%40ab/i);
		}
		// A page whose text carries the value in a spelling no hiding rule covers: no snapshot at all.
		f.shown.text = `Continue: ${twice}`;
		await expect(perform(f, { kind: "browser", action: "snapshot" })).rejects.toThrow("PRIVATE_FIELD_VISIBLE");
	});

	it("takes no picture when the page holds more than the check reads, or shows the value only after the capture", async () => {
		for (const set of [
			(f: ReturnType<typeof office>) => {
				f.shown.shadowBox.value = password;
			},
			(f: ReturnType<typeof office>) => {
				f.shown.extraBoxes = 600;
			},
			(f: ReturnType<typeof office>) => {
				f.shown.extraRoots = 300;
			},
		]) {
			const f = office();
			await perform(f, action(), sealed(f.key!));
			set(f);
			await expect(screenshot(f, "browser")).rejects.toThrow(/PRIVATE_FIELD_(ON_SCREEN|TAB_UNREADABLE)/);
			expect(f.page.screenshot).not.toHaveBeenCalled();
		}
		// The page shows the value only once the picture is taken: it is never published.
		const f = office();
		await perform(f, action(), sealed(f.key!));
		f.page.screenshot.mockImplementationOnce(async () => {
			f.shown.text = `Your password is ${password}`;
			return pngHeader();
		});
		await expect(screenshot(f, "browser")).rejects.toThrow("PRIVATE_FIELD_ON_SCREEN");
		expect(f.screenshots.publish).not.toHaveBeenCalled();
	});

	it("gives up on a page that does not answer within five seconds, taking no picture", async () => {
		vi.useFakeTimers();
		try {
			const f = office();
			await perform(f, action(), sealed(f.key!));
			f.page.evaluate.mockImplementation(() => new Promise(() => undefined));
			const refused = expect(screenshot(f, "browser")).rejects.toThrow("PRIVATE_FIELD_TAB_UNREADABLE");
			await vi.advanceTimersByTimeAsync(5_000);
			await refused;
			expect(f.page.screenshot).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("closes the tab when the value went where nothing can empty it", async () => {
		const f = office({ lose: true });
		await expect(perform(f, action(), sealed(f.key!))).rejects.toThrow("ACCOUNT_FILL_LOST");
		expect(f.page.close).toHaveBeenCalledOnce();
	});

	it("tells a spent box apart from one that is not for this call", async () => {
		const f = office();
		const old = sealed(f.key!, computerEffect().receiptId, "password", Date.now() - 10 * 60_000);
		await expect(perform(f, action(), old)).rejects.toThrow("ACCOUNT_FILL_EXPIRED");
		expect(f.typed).toEqual([]);
	});

	it("types nothing into another website", async () => {
		const f = office({ url: "https://evil.example/login" });
		await expect(perform(f, action(), sealed(f.key!))).rejects.toThrow("ACCOUNT_FILL_WRONG_SITE");
		expect(f.typed).toEqual([]);
	});
});
