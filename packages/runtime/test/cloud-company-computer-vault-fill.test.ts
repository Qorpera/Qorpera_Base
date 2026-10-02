import { createHash } from "node:crypto";
import { CompanyComputerFillKey, sealCompanyAccountFill } from "@qorpera/runtime/cloud-company-account-fill-box";
import {
	COMPANY_ACCOUNT_FILLED_ATTRIBUTE,
	CompanyComputerFilledValues,
} from "@qorpera/runtime/cloud-company-computer-account-fill";
import {
	type CompanyComputerBrowserSession,
	CompanyComputerGuestAutomation,
	companyComputerSnapshotCut,
} from "@qorpera/runtime/cloud-company-computer-guest";
import {
	COMPANY_COMPUTER_SITE_SAMPLE,
	CompanyComputerSiteStops,
} from "@qorpera/runtime/cloud-company-computer-site-stops";
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
		/** The sites the computer stopped on, shared with another run's automation. */
		siteStops?: CompanyComputerSiteStops;
		/** A page script moves the focus somewhere with no value (an editable area) before the typing. */
		lose?: boolean;
		/** Meanwhile the page opens a second tab. */
		popup?: boolean;
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
		/** The whole aria snapshot, instead of the one built from the fields above. */
		aria: undefined as string | undefined,
		/** Frames inside the page, by address and whether shown (a CAPTCHA service's, A1-4c). */
		frames: [] as Array<string | { url: string; visible: boolean }>,
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
	let closed = false;
	/** Tabs the page or the guest opened. */
	const opened: Page[] = [];
	const tab = (url: string) =>
		({
			isClosed: () => false,
			url: () => url,
			title: async () => "",
			locator: vi.fn(),
			evaluate: vi.fn(),
		}) as unknown as Page;
	const page = {
		isClosed: () => closed,
		close: vi.fn(async () => {
			closed = true;
		}),
		url: () => shown.url,
		title: async () => shown.title,
		waitForLoadState: async () => undefined,
		mainFrame: () => mainFrame,
		getByRole: vi.fn(() => box),
		// The screen check's own function runs against the fake document; the private-box reader finds none.
		evaluate: vi.fn(
			async (fn: (arg: unknown) => unknown, arg?: unknown): Promise<unknown> =>
				arg === COMPANY_ACCOUNT_FILLED_ATTRIBUTE
					? runScreenCheck(fn, arg)
					: arg === COMPANY_COMPUTER_SITE_SAMPLE
						? { title: shown.title, text: shown.text, length: shown.text.length }
						: [],
		),
		goto: vi.fn(async (url: string) => {
			shown.url = url;
		}),
		screenshot: vi.fn(async () => pngHeader()),
		// The page is its own main frame here; check frames sit inside it.
		parentFrame: () => null,
		frames: () => [
			page,
			...shown.frames.map((frame) => {
				const { url, visible } = typeof frame === "string" ? { url: frame, visible: true } : frame;
				return {
					parentFrame: () => page,
					isDetached: () => false,
					url: () => url,
					evaluate: async () => "",
					frameElement: async () => ({ isVisible: async () => visible }),
				};
			}),
		],
		isDetached: () => false,
		locator: vi.fn(() => ({
			ariaSnapshot: async () =>
				shown.aria ??
				`- textbox "Subject": Quarterly invoice\n- paragraph: ${shown.text}\n- textbox "Password": ${element.value}\n- link "Back":\n  - /url: ${shown.link}`,
		})),
		context: () => ({
			newCDPSession: async () => ({
				send: async (method: string, params: { text: string }) => {
					expect(method).toBe("Input.insertText");
					typed.push(params.text);
					if (options.popup) opened.push(tab("https://vercel.com/help"));
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
	const context = {
		pages: () => [page as unknown as Page, ...opened].filter((candidate) => !candidate.isClosed()),
		newPage: vi.fn(async () => {
			const blank = tab("about:blank");
			opened.push(blank);
			return blank;
		}),
	};
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
		...(options.siteStops ? { siteStops: options.siteStops } : {}),
	});
	return {
		automation,
		key,
		element,
		attributes,
		typed,
		page,
		opened,
		context,
		shown,
		commands,
		screenshots: automationScreenshots,
	};
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
			[
				"text, encoded twice",
				(f) => {
					f.shown.text = `Continue: ${encodeURIComponent(`https://vercel.com/login?pw=${encodeURIComponent(password)}`)}`;
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
		f.shown.title = `Moved to ${twice}`;
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

	it("cuts a long one-line page by characters when nothing is hidden, and between words when something is", async () => {
		// Playwright gives a plain-text or JSON page as one line, here without a space.
		const plain = office();
		plain.shown.aria = `- text: {"data":"${"x".repeat(35_000)}"}`;
		const whole = (await perform(plain, { kind: "browser", action: "snapshot" })) as unknown as {
			value: { snapshot: string; truncated: boolean };
		};
		expect(whole.value.snapshot).toHaveLength(16_384);
		expect(whole.value.truncated).toBe(true);
		// After a fill, the line is cut at a space: the value across the cut is left out whole.
		const f = office();
		await perform(f, action(), sealed(f.key!));
		let line = `- text: ${`pw ${password} `.repeat(300)}`;
		while (line.length < 20_400) line += "lorem ipsum ";
		line += "x".repeat(20_470 - line.length - 1);
		line += ` ${password} and more ${"lorem ".repeat(200)}`;
		expect(line.indexOf(password, 20_000)).toBe(20_470);
		f.shown.aria = line;
		const cut = (await perform(f, { kind: "browser", action: "snapshot" })) as unknown as {
			value: { snapshot: string; truncated: boolean };
		};
		expect(cut.value.snapshot.length).toBeGreaterThan(10_000);
		expect(cut.value.snapshot.length).toBeLessThan(16_384);
		expect(cut.value.snapshot).not.toContain("Pw-12345");
		expect(cut.value.truncated).toBe(true);
	});

	it("cuts by words for what a member typed into a password box, and by lines when it holds a space", async () => {
		// What a member typed into a password box (no vault fill): the page's own private values count as hidden.
		const typed = (secret: string) => {
			const f = office();
			f.page.evaluate.mockImplementation(async (fn: (arg: unknown) => unknown, arg?: unknown) =>
				arg === COMPANY_ACCOUNT_FILLED_ATTRIBUTE ? fn(arg) : [secret],
			);
			return f;
		};
		const snapshotOf = async (f: ReturnType<typeof office>) =>
			((await perform(f, { kind: "browser", action: "snapshot" })) as unknown as { value: { snapshot: string } })
				.value.snapshot;
		// One long line, the value many times before (each hidden, so the text shrinks) and once across the cut.
		const word = "Member-Typed-Secret-77";
		const one = typed(word);
		let line = `- text: ${`note ${word} `.repeat(400)}`;
		while (line.length < 20_400) line += "lorem ipsum ";
		line += "x".repeat(20_470 - line.length - 1);
		one.shown.aria = `${line} ${word} and more ${"lorem ".repeat(200)}`;
		// The cut at 20,480 would leave "Member-Typ" (10 characters) without the word cut.
		expect(await snapshotOf(one)).not.toContain("Member-Ty");
		// A value with spaces: the cut falls at a line's end, never between its words.
		const phrase = "Zebra Quokka Mango 4417";
		const spaced = typed(phrase);
		let lines = `- text: note ${phrase}\n`.repeat(400);
		while (lines.length < 20_300) lines += "- text: lorem ipsum dolor\n";
		lines += `- paragraph: ${"y".repeat(20_470 - lines.length - 14)} ${phrase} after\n`;
		expect(lines.indexOf(phrase, 20_000)).toBeLessThan(20_480);
		expect(lines.indexOf(phrase, 20_000) + phrase.length).toBeGreaterThan(20_480);
		spaced.shown.aria = `${lines}${"- text: more\n".repeat(200)}`;
		// A cut between its words would leave "Zebra".
		expect(await snapshotOf(spaced)).not.toContain("Zebra");
	});

	it("hides a minified page whole after a fill rather than returning almost nothing", async () => {
		const f = office();
		await perform(f, action(), sealed(f.key!));
		f.shown.aria = `- text: {"data":"${"x".repeat(35_000)}"}`;
		const result = (await perform(f, { kind: "browser", action: "snapshot" })) as unknown as {
			value: { snapshot: string; truncated: boolean };
		};
		expect(result.value.snapshot).toHaveLength(16_384);
		expect(result.value.truncated).toBe(true);
	});

	it("finds the cut after the last whitespace, or the last line's end when a value holds whitespace", () => {
		expect(companyComputerSnapshotCut("one two\nthree four", 15, false)).toBe(13);
		expect(companyComputerSnapshotCut("one two\nthree four", 15, true)).toBe(7);
		expect(companyComputerSnapshotCut("one two\nthree four", 13, false)).toBe(13);
		expect(companyComputerSnapshotCut("abcdef", 3, false)).toBe(0);
	});

	it("hides a link address the snapshot leaves unquoted, spaces and all", async () => {
		const f = office();
		await perform(f, action(), sealed(f.key!));
		const lower = encodeURIComponent(password).replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase());
		f.shown.link = `/next?q=a b&pw=${lower}`;
		const result = (await perform(f, { kind: "browser", action: "snapshot" })) as unknown as {
			value: { snapshot: string };
		};
		expect(result.value.snapshot).toContain("- /url: [hidden]");
		expect(result.value.snapshot).not.toContain("1234567890");
	});

	it("hides a link address the snapshot quotes, spaces and all", async () => {
		const f = office();
		await perform(f, action(), sealed(f.key!));
		// Playwright quotes an address with a space or a leading "#" or "%"; lower-case escapes, which only the
		// address check reads.
		const lower = encodeURIComponent(password).replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase());
		f.shown.link = `"/next?q=a #b&pw=${lower}"`;
		const result = (await perform(f, { kind: "browser", action: "snapshot" })) as unknown as {
			value: { snapshot: string };
		};
		expect(result.value.snapshot).toContain("- /url: [hidden]");
		expect(result.value.snapshot).not.toContain("%40ab");
		expect(result.value.snapshot).not.toContain("1234567890");
	});

	it("pictures long and many boxes and shadow roots, but none past 4 MB or showing the value after the capture", async () => {
		for (const set of [
			(f: ReturnType<typeof office>) => {
				f.shown.other.value = "x".repeat(5_000);
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
			await expect(screenshot(f, "browser")).resolves.toMatchObject({ kind: "json" });
			expect(f.page.screenshot).toHaveBeenCalledOnce();
		}
		for (const [set, reason] of [
			[
				(f: ReturnType<typeof office>) => {
					f.shown.shadowBox.value = password;
				},
				"PRIVATE_FIELD_ON_SCREEN",
			],
			[
				(f: ReturnType<typeof office>) => {
					f.shown.other.value = "x".repeat(4_000_001);
				},
				"PRIVATE_FIELD_TAB_UNREADABLE",
			],
		] as const) {
			const f = office();
			await perform(f, action(), sealed(f.key!));
			set(f);
			await expect(screenshot(f, "browser")).rejects.toThrow(reason);
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

	it("cuts a long snapshot between words, so no part of a value slips past the checks", async () => {
		const f = office();
		await perform(f, action(), sealed(f.key!));
		// The value as text many times (each hidden, so the text shrinks), filler, the value across the 20 KB cut,
		// then the value in a spelling that would refuse the snapshot, past the cut.
		let aria = `- paragraph: ${password}\n`.repeat(300);
		while (aria.length < 20_300) aria += `- paragraph: ${"a".repeat(60)}\n`;
		const echo = "- paragraph: Your password: ";
		aria += `- paragraph: ${"b".repeat(20_470 - echo.length - aria.length - 14)}\n`;
		aria += `${echo}${password}\n`;
		expect(aria.indexOf(`${echo}${password}`) + echo.length).toBe(20_470);
		const twice = encodeURIComponent(`https://vercel.com/login?pw=${encodeURIComponent(password)}`);
		aria += `- paragraph: Continue: ${twice}\n${"- paragraph: more\n".repeat(100)}`;
		f.shown.aria = aria;
		const result = (await perform(f, { kind: "browser", action: "snapshot" })) as unknown as {
			value: { snapshot: string; truncated: boolean };
		};
		expect(result.value.snapshot).not.toContain("Pw-12345");
		// Cut at the space before it: the words before the value stay.
		expect(result.value.snapshot.endsWith("Your password:")).toBe(true);
		expect(result.value.snapshot.length).toBeLessThan(16_384);
		expect(result.value.truncated).toBe(true);
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

	it("closes the tab when the value went where nothing can empty it, and never moves the agent to another tab", async () => {
		// The page opened a second tab meanwhile: the agent's next action is told its tab closed.
		const f = office({ lose: true, popup: true });
		await expect(perform(f, action(), sealed(f.key!))).rejects.toThrow("ACCOUNT_FILL_LOST");
		expect(f.page.close).toHaveBeenCalledOnce();
		expect(f.context.newPage).not.toHaveBeenCalled();
		await expect(perform(f, { kind: "browser", action: "snapshot" })).rejects.toThrow("BROWSER_TARGET_CLOSED");
		expect(f.opened[0]!.locator).not.toHaveBeenCalled();
		// The only tab: a blank one opens first, so the window stays.
		const only = office({ lose: true });
		await expect(perform(only, action(), sealed(only.key!))).rejects.toThrow("ACCOUNT_FILL_LOST");
		expect(only.context.newPage.mock.invocationCallOrder[0]).toBeLessThan(
			only.page.close.mock.invocationCallOrder[0]!,
		);
		expect(only.context.pages().map((tab) => tab.url())).toEqual(["about:blank"]);
		// A tab that will not close stays the agent's, and the failure travels with the reason.
		const stuck = office({ lose: true });
		const failure = new Error("Target closed: protocol error");
		stuck.page.close.mockRejectedValueOnce(failure);
		const error = (await perform(stuck, action(), sealed(stuck.key!)).catch((caught: unknown) => caught)) as Error;
		expect(error.message).toBe("ACCOUNT_FILL_LOST");
		expect((error.cause as Error).cause).toBe(failure);
	});

	it("stops at a page that asks for a person, and never acts on that site again while the computer runs", async () => {
		const stops = new CompanyComputerSiteStops();
		const f = office({ siteStops: stops });
		const json = async (value: CompanyComputerAction, fill?: Record<string, string>) =>
			((await perform(f, value, fill)) as unknown as { value: Record<string, unknown> }).value;
		// The site answers a navigation with a human check: the action happened, and its answer says to stop.
		f.page.goto.mockImplementationOnce(async (url: string) => {
			f.shown.url = url;
			f.shown.title = "Just a moment\u2026";
		});
		expect(await json({ kind: "browser", action: "navigate", url: "https://vercel.com/signup" })).toMatchObject({
			action: "navigate",
			completed: true,
			stop: "SITE_STOP_HUMAN_CHECK",
			message: expect.stringContaining("never retry"),
		});
		// Back on an ordinary page of the same site, or another run on this computer: refused before acting, as the
		// call's answer, so the agent can go on to mark the account.
		f.shown.title = "Sign up";
		for (const run of [f, office({ siteStops: stops })]) {
			run.shown.url = "https://vercel.com/login";
			for (const value of [
				{ kind: "browser", action: "navigate", url: "https://www.vercel.com/" },
				{ kind: "browser", action: "navigate", url: "https://vercel.com./signup" },
				{ kind: "browser", action: "click", role: "button", name: "Continue" },
				{ kind: "browser", action: "fill", role: "textbox", name: "Email", text: "x" },
			] as CompanyComputerAction[])
				expect(
					((await perform(run, value)) as unknown as { value: Record<string, unknown> }).value,
					JSON.stringify(value),
				).toMatchObject({ completed: false, refused: { code: "SITE_STOPPED" } });
			expect(
				((await perform(run, action(), sealed(run.key!))) as unknown as { value: Record<string, unknown> }).value,
			).toMatchObject({ completed: false, refused: { code: "SITE_STOPPED" } });
			expect(run.typed).toEqual([]);
		}
		expect(f.page.goto).toHaveBeenCalledOnce();
		// Another site stays open; a link or redirect from it back to the stopped site reports the stop.
		expect(await json({ kind: "browser", action: "navigate", url: "https://netlify.com/" })).toMatchObject({
			completed: true,
		});
		f.page.goto.mockImplementationOnce(async () => {
			f.shown.url = "https://vercel.com/signup";
		});
		expect(await json({ kind: "browser", action: "navigate", url: "https://netlify.com/to-vercel" })).toMatchObject({
			completed: true,
			stop: "SITE_STOP_HUMAN_CHECK",
		});
	});

	it("types and clicks nothing on a page that already shows a check, whatever its address", async () => {
		const answer = async (
			f: ReturnType<typeof office>,
			value: CompanyComputerAction,
			fill?: Record<string, string>,
		) => ((await perform(f, value, fill)) as unknown as { value: Record<string, unknown> }).value;
		// A shown reCAPTCHA checkbox frame inside the page.
		const f = office();
		f.shown.frames = ["https://www.google.com/recaptcha/api2/anchor?k=x&size=normal"];
		expect(await answer(f, action(), sealed(f.key!))).toMatchObject({ refused: { code: "SITE_STOPPED" } });
		expect(f.typed).toEqual([]);
		// A tab with no web address showing a check: nothing is recorded, still nothing is clicked.
		const blank = office({ url: "about:blank" });
		blank.shown.frames = ["https://newassets.hcaptcha.com/captcha/v1/x#frame=challenge"];
		const click = vi.fn();
		blank.page.getByRole.mockImplementation(() => ({ count: async () => 1, click }) as never);
		expect(
			await answer(blank, { kind: "browser", action: "click", role: "checkbox", name: "I am human" }),
		).toMatchObject({ refused: { code: "SITE_STOPPED" } });
		expect(click).not.toHaveBeenCalled();
		// The invisible reCAPTCHA badge and a hidden challenge frame ask no one anything: the fill goes on.
		const badge = office();
		badge.shown.frames = [
			"https://www.google.com/recaptcha/api2/anchor?k=x&size=invisible",
			{ url: "https://www.google.com/recaptcha/api2/bframe?k=x", visible: false },
		];
		expect(await answer(badge, action(), sealed(badge.key!))).toMatchObject({ completed: true });
		// A check service's own website is the page itself, not a frame inside it: an ordinary page.
		const vendor = office({ url: "https://www.hcaptcha.com/pricing" });
		const vendorClick = vi.fn();
		vendor.page.getByRole.mockImplementation(() => ({ count: async () => 1, click: vendorClick }) as never);
		expect(await answer(vendor, { kind: "browser", action: "click", role: "link", name: "Pricing" })).toMatchObject({
			completed: true,
		});
		expect(vendorClick).toHaveBeenCalledOnce();
		// A page that does not answer still has its frames read.
		const hung = office();
		hung.shown.frames = ["https://challenges.cloudflare.com/cdn-cgi/challenge-platform/x"];
		hung.page.evaluate.mockImplementation(() => new Promise(() => undefined));
		vi.useFakeTimers();
		try {
			const pending = answer(hung, { kind: "browser", action: "press", key: "Enter" });
			await vi.advanceTimersByTimeAsync(5_000);
			expect(await pending).toMatchObject({ refused: { code: "SITE_STOPPED" } });
		} finally {
			vi.useRealTimers();
		}
	});

	it("says stop in a snapshot of such a page, and none on an ordinary one", async () => {
		const g = office();
		g.shown.text = "We have detected unusual activity from your account. Please try again later.";
		const result = (await perform(g, { kind: "browser", action: "snapshot" })) as unknown as {
			value: { stop?: string; message?: string };
		};
		expect(result.value).toMatchObject({
			stop: "SITE_STOP_UNUSUAL_ACTIVITY",
			message: expect.stringContaining("needs_person"),
		});
		expect(
			((await perform(g, { kind: "browser", action: "press", key: "Enter" })) as unknown as { value: object }).value,
		).toMatchObject({ refused: { code: "SITE_STOPPED" } });
		const h = office();
		const plain = (await perform(h, { kind: "browser", action: "snapshot" })) as unknown as {
			value: { stop?: string };
		};
		expect(plain.value.stop).toBeUndefined();
	});

	it("types and clicks nothing on the desktop while a shown tab is on a stopped site", async () => {
		const stops = new CompanyComputerSiteStops();
		const f = office({ siteStops: stops });
		const desktop = (value: CompanyComputerAction) =>
			f.automation.perform(value, computerLease(), computerEffect(), {
				...computerOperation(),
				tool: "computer_desktop",
				arguments: value as never,
			});
		await desktop({ kind: "desktop", action: "click", x: 500, y: 300, button: "left" });
		expect(f.commands.run).toHaveBeenCalledOnce();
		stops.add("https://vercel.com/", "captcha");
		for (const value of [
			{ kind: "desktop", action: "click", x: 500, y: 300, button: "left" },
			{ kind: "desktop", action: "type", text: "hello" },
			{ kind: "desktop", action: "press", key: "Enter" },
			{ kind: "desktop", action: "scroll", direction: "down", amount: 3 },
		] as CompanyComputerAction[])
			expect(((await desktop(value)) as unknown as { value: object }).value, JSON.stringify(value)).toMatchObject({
				completed: false,
				refused: { code: "SITE_STOPPED" },
			});
		// Moving the pointer only looks.
		await desktop({ kind: "desktop", action: "move", x: 10, y: 10 });
		expect(f.commands.run).toHaveBeenCalledTimes(2);
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
