import {
	CompanyComputerHookCaptureBoxes,
	CompanyHookCaptureRefusedError,
	captureCompanyHookSecret,
} from "@qorpera/runtime/cloud-company-computer-hook-capture";
import type { Locator, Page } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";

const realDocument = (globalThis as { document?: unknown }).document;
afterEach(() => {
	(globalThis as { document?: unknown }).document = realDocument;
	vi.useRealTimers();
});

const address = `${"a".repeat(20)}B_-${"c".repeat(20)}`;
const hook = { address, site: "dashboard.stripe.com" };
const secret = "whsec_AbCdEfGhIjKlMnOpQrStUvWxYz012345+/=";
const endpoint = `Webhook endpoint https://x.supabase.co/functions/v1/event-intake/${address} Signing secret Reveal`;
const timing = { revealMs: 40, settleMs: 1, pollMs: 5 };

interface FakeBox {
	tagName: string;
	type: string;
	value: string;
	private?: boolean;
}

/** Stripe's endpoint page: `before` until the click, then each of `shown` in turn (the last stays) and the box
 * `revealedBox` until a reload, which shows `reloaded`. Its `boxes` are always there. */
function fakeStripe(
	options: {
		url?: string;
		before?: string;
		shown?: string[];
		reloaded?: string;
		boxes?: FakeBox[];
		revealedBox?: FakeBox;
		inFrame?: boolean;
		reloadFails?: boolean;
		clickFails?: boolean;
	} = {},
) {
	const calls: string[] = [];
	let text = options.before ?? endpoint;
	let reads: string[] = [];
	let revealed = false;
	const mainFrame = {};
	const send = vi.fn(async (method: string, _params?: unknown) => {
		calls.push(method);
		return method === "Page.addScriptToEvaluateOnNewDocument" ? { identifier: "cover-1" } : {};
	});
	const handle = {
		ownerFrame: async () => (options.inFrame ? {} : mainFrame),
		click: vi.fn(async () => {
			calls.push("click");
			reads = [...(options.shown ?? [`${endpoint} ${secret} Hide`])];
			revealed = true;
			if (options.clickFails)
				throw new Error("Timeout 3000ms exceeded: <span>whsec_x</span> intercepts pointer events");
		}),
		dispose: vi.fn(async () => undefined),
	};
	const control = { elementHandle: vi.fn(async () => handle) };
	const current = () => (reads.length > 1 ? reads.shift()! : (reads[0] ?? text));
	const page = {
		url: () => options.url ?? "https://dashboard.stripe.com/test/webhooks/we_1",
		mainFrame: () => mainFrame,
		reload: vi.fn(async () => {
			calls.push("reload");
			if (options.reloadFails) throw new Error("Timeout 6000ms exceeded");
			reads = [];
			revealed = false;
			text = options.reloaded ?? endpoint;
		}),
		waitForLoadState: vi.fn(async () => undefined),
		evaluate: vi.fn(async (script: unknown, arg?: unknown) => {
			if (typeof script === "string") {
				calls.push(script.includes("showPopover") ? "cover" : "uncover");
				return undefined;
			}
			const shownBoxes = [
				...(options.boxes ?? []),
				...(revealed && options.revealedBox ? [options.revealedBox] : []),
			];
			const boxes = shownBoxes.map((box) => ({
				...box,
				shadowRoot: null,
				hasAttribute: (name: string) => box.private === true && name === "data-qorpera-private",
			}));
			(globalThis as { document?: unknown }).document = {
				body: { innerText: current() },
				querySelectorAll: () => boxes,
			};
			return (script as (arg: unknown) => unknown)(arg);
		}),
		context: () => ({
			newCDPSession: async () => ({
				send,
				detach: vi.fn(async () => {
					calls.push("detach");
				}),
			}),
		}),
	};
	return { page: page as unknown as Page, control: control as unknown as Locator, calls, send, handle };
}

async function refusal(work: Promise<unknown>): Promise<string> {
	const error = await work.then(
		() => undefined,
		(caught: unknown) => caught,
	);
	expect(error).toBeInstanceOf(CompanyHookCaptureRefusedError);
	return (error as CompanyHookCaptureRefusedError).reason;
}

describe("a Stripe hook's signing secret read off its page (E3c-3)", () => {
	it("reads the one value the click shows, under a cover, then masks the page again and uncovers it", async () => {
		const stripe = fakeStripe();
		const seen: string[] = [];
		await expect(
			captureCompanyHookSecret(stripe.page, stripe.control, hook, (value) => seen.push(value), timing),
		).resolves.toBe(secret);
		expect(stripe.calls).toEqual([
			"Page.enable",
			"Page.addScriptToEvaluateOnNewDocument",
			"cover",
			"click",
			"Runtime.evaluate",
			"reload",
			"Page.removeScriptToEvaluateOnNewDocument",
			"uncover",
			"detach",
		]);
		// Every value read is private before the page is uncovered; the clipboard is emptied with a user's gesture.
		expect(new Set(seen)).toEqual(new Set([secret]));
		expect(stripe.send).toHaveBeenCalledWith(
			"Runtime.evaluate",
			expect.objectContaining({ userGesture: true, expression: expect.stringContaining('execCommand("copy")') }),
		);
		expect(stripe.send).toHaveBeenCalledWith("Page.removeScriptToEvaluateOnNewDocument", { identifier: "cover-1" });
		expect(stripe.handle.dispose).toHaveBeenCalled();
	});

	it("reads a value shown in a box, never one the vault filled or a password box", async () => {
		// Neither box counts before the click (no reload) or after it (no second value).
		const stripe = fakeStripe({
			boxes: [
				{ tagName: "INPUT", type: "password", value: `${secret}0` },
				{ tagName: "INPUT", type: "text", value: `${secret}1`, private: true },
			],
			shown: [endpoint],
			revealedBox: { tagName: "INPUT", type: "text", value: secret },
		});
		await expect(captureCompanyHookSecret(stripe.page, stripe.control, hook, () => undefined, timing)).resolves.toBe(
			secret,
		);
		expect(stripe.calls.filter((call) => call === "reload")).toHaveLength(1);
	});

	it("refuses a page that is not the hook's site, before anything is clicked or covered", async () => {
		for (const url of [
			"http://dashboard.stripe.com/test/webhooks/we_1",
			"https://dashboard.stripe.com:8443/test/webhooks/we_1",
			"https://stripe.com.evil.example/test/webhooks/we_1",
			"https://user@dashboard.stripe.com/test/webhooks/we_1",
		]) {
			const stripe = fakeStripe({ url });
			expect(
				await refusal(captureCompanyHookSecret(stripe.page, stripe.control, hook, () => undefined, timing)),
			).toBe("VAULT_CAPTURE_WRONG_SITE");
			expect(stripe.calls).toEqual([]);
		}
	});

	it("refuses a page that does not show this hook's address as a word of its own", async () => {
		for (const before of [
			"Webhook endpoint https://x.supabase.co/functions/v1/event-intake/other Signing secret Reveal",
			`Webhook endpoint https://x.supabase.co/functions/v1/event-intake/${address}x Reveal`,
			`Webhook endpoint https://x.supabase.co/functions/v1/event-intake/-${address} Reveal`,
		]) {
			const stripe = fakeStripe({ before });
			expect(
				await refusal(captureCompanyHookSecret(stripe.page, stripe.control, hook, () => undefined, timing)),
			).toBe("VAULT_CAPTURE_WRONG_HOOK");
			expect(stripe.calls).toEqual([]);
		}
	});

	it("reloads a page that already shows a secret, and refuses one that still does after the reload", async () => {
		const masked = fakeStripe({ before: `${endpoint} ${secret}` });
		await expect(captureCompanyHookSecret(masked.page, masked.control, hook, () => undefined, timing)).resolves.toBe(
			secret,
		);
		expect(masked.calls.slice(0, 2)).toEqual(["reload", "Page.enable"]);

		const planted = fakeStripe({ before: `${endpoint} ${secret}`, reloaded: `${endpoint} whsec_planted` });
		expect(
			await refusal(captureCompanyHookSecret(planted.page, planted.control, hook, () => undefined, timing)),
		).toBe("VAULT_CAPTURE_AMBIGUOUS");
		expect(planted.calls).toEqual(["reload"]);
		expect(planted.handle.click).not.toHaveBeenCalled();
	});

	it("refuses a control inside a frame, before the page is covered", async () => {
		const stripe = fakeStripe({ inFrame: true });
		expect(await refusal(captureCompanyHookSecret(stripe.page, stripe.control, hook, () => undefined, timing))).toBe(
			"VAULT_CAPTURE_IN_FRAME",
		);
		expect(stripe.calls).toEqual([]);
		expect(stripe.handle.dispose).toHaveBeenCalled();
	});

	it("refuses a value not shown in time, two values, a changing one or a cut-off one, and masks the page again", async () => {
		const cases: [string[], string][] = [
			[[`${endpoint} whsec_ •••••••• Hide`], "VAULT_CAPTURE_NOT_SHOWN"],
			[[`${endpoint} ${secret} whsec_ZyXwVuTsRqPoNmLkJiHg`], "VAULT_CAPTURE_AMBIGUOUS"],
			[[`${endpoint} ${secret}`, `${endpoint} ${secret}9`], "VAULT_CAPTURE_UNSTABLE"],
			[[`${endpoint} ${secret}`, endpoint], "VAULT_CAPTURE_UNSTABLE"],
			[[`${endpoint} ${secret.slice(0, 24)}… Hide`], "VAULT_CAPTURE_PARTIAL"],
			[[`${endpoint} ${secret.slice(0, 24)}... Hide`], "VAULT_CAPTURE_PARTIAL"],
			[[`${endpoint} whsec_AbCd•••••••••••••••••••• Hide`], "VAULT_CAPTURE_PARTIAL"],
			[[`${endpoint} whsec_AbCdEf Hide`], "VAULT_CAPTURE_PARTIAL"],
			// Whole in one place and cut off in another: not whole everywhere.
			[[`${endpoint} ${secret} ${secret}… Hide`], "VAULT_CAPTURE_PARTIAL"],
		];
		for (const [shown, reason] of cases) {
			const stripe = fakeStripe({ shown });
			const seen: string[] = [];
			expect(
				await refusal(
					captureCompanyHookSecret(stripe.page, stripe.control, hook, (value) => seen.push(value), timing),
				),
				shown[0],
			).toBe(reason);
			expect(stripe.calls.slice(-5)).toEqual([
				"Runtime.evaluate",
				"reload",
				"Page.removeScriptToEvaluateOnNewDocument",
				"uncover",
				"detach",
			]);
			// Whatever was read is private from then on, refused or not.
			for (const value of shown.flatMap((text) => text.match(/whsec_[A-Za-z0-9+/=]+/g) ?? []))
				expect(seen).toContain(value);
		}
	});

	it("masks the page again after a click that failed, and fails with the click's error", async () => {
		const stripe = fakeStripe({ clickFails: true });
		const error = await captureCompanyHookSecret(stripe.page, stripe.control, hook, () => undefined, timing).catch(
			(caught: unknown) => caught,
		);
		expect(error).not.toBeInstanceOf(CompanyHookCaptureRefusedError);
		expect((error as Error).message).toMatch(/^Timeout 3000ms/);
		expect(stripe.calls.slice(-4)).toEqual([
			"reload",
			"Page.removeScriptToEvaluateOnNewDocument",
			"uncover",
			"detach",
		]);
	});

	it("keeps the cover on a page that still shows the value after the reload, or cannot reload: the tab must go", async () => {
		for (const options of [{ reloaded: `${endpoint} ${secret}` }, { reloadFails: true }]) {
			const stripe = fakeStripe(options);
			const seen: string[] = [];
			expect(
				await refusal(
					captureCompanyHookSecret(stripe.page, stripe.control, hook, (value) => seen.push(value), timing),
				),
			).toBe("VAULT_CAPTURE_NOT_HIDDEN");
			expect(stripe.calls).not.toContain("uncover");
			expect(stripe.calls.slice(-2)).toEqual(["Page.removeScriptToEvaluateOnNewDocument", "detach"]);
			expect(seen).toContain(secret);
		}
		// It outranks the read's own refusal.
		const both = fakeStripe({ shown: [`${endpoint} ${secret}…`], reloaded: `${endpoint} ${secret}` });
		expect(await refusal(captureCompanyHookSecret(both.page, both.control, hook, () => undefined, timing))).toBe(
			"VAULT_CAPTURE_NOT_HIDDEN",
		);
	});
});

describe("sealed hook captures waiting for their answer (E3c-3)", () => {
	it("hands each box on once, keeps at most four, and drops one past the box's lifetime", () => {
		vi.useFakeTimers();
		const boxes = new CompanyComputerHookCaptureBoxes();
		const box = (n: number) => ({ schema: "qorpera.event-hook-capture-box/v1", ciphertext: `c${n}` });
		boxes.hold("r1", box(1));
		expect(boxes.take("r1")).toEqual(box(1));
		expect(boxes.take("r1")).toBeUndefined();
		for (const n of [1, 2, 3, 4, 5]) boxes.hold(`r${n}`, box(n));
		expect(boxes.take("r1")).toBeUndefined();
		expect(boxes.take("r2")).toEqual(box(2));
		vi.advanceTimersByTime(90_000);
		expect(boxes.take("r5")).toBeUndefined();
		boxes.hold("r6", box(6));
		boxes.clear();
		expect(boxes.take("r6")).toBeUndefined();
	});
});
