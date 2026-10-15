import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ElementHandle, Locator, Page } from "playwright-core";
import { COMPANY_ACCOUNT_FILLED_ATTRIBUTE, companyAccountFillHost } from "./cloud-company-computer-account-fill.ts";
import { EVENT_HOOK_CAPTURE_LIFETIME_MS, EVENT_HOOK_CAPTURE_SECRET } from "./cloud-event-hook-capture-box.ts";

/* The office's read of a Stripe hook's signing secret off Stripe's own page (E3c-3,
 * deploy/first-node/RUNTIME-COMPANY-FOLDER-EVENTS.md §5.8 point 2). The call carries no value: the office reads it
 * after its own click on the control the agent named, so the agent can neither supply one nor see the one read. The
 * page must be the hook's site over https and show the hook's address (this endpoint's page, not another's), and show
 * no secret before the click. A cover goes over the whole page first, so the live view and any screen capture show
 * the cover, never the value. The value must then show alone, twice the same 300 ms apart, and whole. After the read,
 * whether it was taken or refused, the clipboard is cleared and the page reloaded, so Stripe masks the value again;
 * only a page that no longer shows it is uncovered. A human check the click brought up is read before that reload and
 * stops the read. The value is sealed to the vault by the caller. */

export type CompanyHookCaptureRefusal =
	| "VAULT_CAPTURE_WRONG_SITE"
	| "VAULT_CAPTURE_IN_FRAME"
	| "VAULT_CAPTURE_WRONG_HOOK"
	/** A secret on the page before the click (and after a reload), or two after it. */
	| "VAULT_CAPTURE_AMBIGUOUS"
	| "VAULT_CAPTURE_NOT_SHOWN"
	| "VAULT_CAPTURE_UNSTABLE"
	/** Cut off: an ellipsis or masking characters after it, or not a whole secret's length. */
	| "VAULT_CAPTURE_PARTIAL"
	/** The page still shows the value after the reload (or could not be reloaded): the tab must go, cover and all. */
	| "VAULT_CAPTURE_NOT_HIDDEN"
	/** The click brought up a human check, which the caller recorded before the reload: its answer is the stop. */
	| "VAULT_CAPTURE_STOPPED";

export class CompanyHookCaptureRefusedError extends Error {
	readonly reason: CompanyHookCaptureRefusal;
	constructor(reason: CompanyHookCaptureRefusal) {
		super(reason);
		this.name = "CompanyHookCaptureRefusedError";
		this.reason = reason;
	}
}

/** How long the read waits: for the value after the click, between its two reads, and between looks. */
export interface CompanyHookCaptureTiming {
	readonly revealMs: number;
	readonly settleMs: number;
	readonly pollMs: number;
}

const TIMING: CompanyHookCaptureTiming = { revealMs: 5_000, settleMs: 300, pollMs: 100 };

/** After a secret's letters, what shows it is cut off: an ellipsis, or a masking character. */
const CUT = /^(?:…|\.\.|[•●○◦∙·⋅*▪■█])/u;

/**
 * Reads the one signing secret Stripe shows on `page` after a click on `control`, the hook's page (`hook.site`,
 * showing `hook.address`). Every value read after the click goes to `seen` before anything else happens, so the
 * screen's private values hide it from then on, also when the read is refused. Refuses (no value) a page that is
 * not the hook's, a control in a frame, and a value that is not shown alone, steadily and whole; refuses with
 * VAULT_CAPTURE_NOT_HIDDEN when the page cannot be made to mask it again (the caller closes the tab). After the click,
 * read or not, `stopShown` says (and the caller records) whether the page shows a human check, before the reload can
 * take it away; one that does refuses with VAULT_CAPTURE_STOPPED, never a value.
 */
export async function captureCompanyHookSecret(
	page: Page,
	control: Locator,
	hook: { readonly address: string; readonly site: string },
	seen: (value: string) => void,
	timing: CompanyHookCaptureTiming = TIMING,
	stopShown: () => Promise<boolean> = async () => false,
): Promise<string> {
	if (companyAccountFillHost(page.url(), [hook.site]) === null)
		throw new CompanyHookCaptureRefusedError("VAULT_CAPTURE_WRONG_SITE");
	// Nothing shown yet: a secret already on the page is masked again by a reload, or it is not Stripe's reveal.
	if (shownSecrets(await hookPage(page, hook)).length > 0) {
		await page.reload({ waitUntil: "domcontentloaded", timeout: 5_000 });
		if (shownSecrets(await hookPage(page, hook)).length > 0)
			throw new CompanyHookCaptureRefusedError("VAULT_CAPTURE_AMBIGUOUS");
	}
	const handle = await control.elementHandle({ timeout: 2_000 });
	if (!handle) throw new Error("BROWSER_TARGET_CLOSED");
	try {
		// Only the page's own document: a frame could be another website inside Stripe's.
		if ((await handle.ownerFrame()) !== page.mainFrame())
			throw new CompanyHookCaptureRefusedError("VAULT_CAPTURE_IN_FRAME");
		return await covered(page, handle, hook, seen, timing, stopShown);
	} finally {
		await handle.dispose().catch(() => undefined);
	}
}

/** The click and the read under the cover, then the page masked again and uncovered. */
async function covered(
	page: Page,
	handle: ElementHandle,
	hook: { readonly address: string; readonly site: string },
	seen: (value: string) => void,
	timing: CompanyHookCaptureTiming,
	stopShown: () => Promise<boolean>,
): Promise<string> {
	const session = await page.context().newCDPSession(page);
	const key = `__qorperaCover${randomUUID().replaceAll("-", "")}`;
	let script: string | undefined;
	let clicked = false;
	let outcome: { value: string } | { error: unknown };
	try {
		// The reload that masks the value again starts covered too.
		await session.send("Page.enable");
		script = (await session.send("Page.addScriptToEvaluateOnNewDocument", { source: coverSource(key) })).identifier;
		await page.evaluate(coverSource(key));
		// A click that throws may still have happened: the page is masked again either way.
		clicked = true;
		// Every wait is short: the whole capture, masked again, fits the native host's 25 s for one action.
		await handle.click({ timeout: 3_000 });
		outcome = { value: await revealed(page, hook, seen, timing) };
	} catch (error) {
		outcome = { error };
	}
	// A check the click brought up (a CAPTCHA instead of the value, or over it) stops the read, taken or not. It is
	// read now: the reload that masks the value again may take it away.
	const stopped = clicked && (await stopShown().catch(() => false));
	const hidden = !clicked || (await maskedAgain(page, session, seen, timing));
	if (script !== undefined)
		await session.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: script }).catch(() => undefined);
	// A page that still shows the value keeps its cover until the caller closes it.
	if (hidden) await page.evaluate(`globalThis[${JSON.stringify(key)}]?.()`).catch(() => undefined);
	await session.detach().catch(() => undefined);
	// It outranks the read's own answer: the tab must go.
	if (!hidden) throw new CompanyHookCaptureRefusedError("VAULT_CAPTURE_NOT_HIDDEN");
	if (stopped) throw new CompanyHookCaptureRefusedError("VAULT_CAPTURE_STOPPED");
	if ("error" in outcome) throw outcome.error;
	return outcome.value;
}

/** The one value the click made the page show: alone, the same 300 ms later, and whole. */
async function revealed(
	page: Page,
	hook: { readonly address: string; readonly site: string },
	seen: (value: string) => void,
	timing: CompanyHookCaptureTiming,
): Promise<string> {
	const deadline = Date.now() + timing.revealMs;
	let shown = secretShown(await hookPage(page, hook), seen);
	while (shown === "none" && Date.now() < deadline) {
		await delay(timing.pollMs);
		shown = secretShown(await hookPage(page, hook), seen);
	}
	if (shown === "none") throw new CompanyHookCaptureRefusedError("VAULT_CAPTURE_NOT_SHOWN");
	if (shown === "many") throw new CompanyHookCaptureRefusedError("VAULT_CAPTURE_AMBIGUOUS");
	await delay(timing.settleMs);
	const again = secretShown(await hookPage(page, hook), seen);
	if (typeof again !== "object" || again.value !== shown.value || again.whole !== shown.whole)
		throw new CompanyHookCaptureRefusedError("VAULT_CAPTURE_UNSTABLE");
	if (!shown.whole) throw new CompanyHookCaptureRefusedError("VAULT_CAPTURE_PARTIAL");
	return shown.value;
}

/**
 * The clipboard emptied (a page may copy the value on its reveal) and the page reloaded, so Stripe masks the value
 * again; whether the reloaded page shows no secret. A page that cannot be reloaded counts as one that still shows it.
 */
async function maskedAgain(
	page: Page,
	session: Awaited<ReturnType<ReturnType<Page["context"]>["newCDPSession"]>>,
	seen: (value: string) => void,
	timing: CompanyHookCaptureTiming,
): Promise<boolean> {
	// Best effort: a copy the page cannot make leaves nothing the agent could paste and read, as every page hides
	// text shaped like a secret (the shape guard).
	await session
		.send("Runtime.evaluate", { expression: CLEAR_CLIPBOARD, userGesture: true, returnByValue: true })
		.catch(() => undefined);
	try {
		await page.reload({ waitUntil: "domcontentloaded", timeout: 6_000 });
		await page.waitForLoadState("load", { timeout: 1_500 }).catch(() => undefined);
		await delay(timing.settleMs);
		const shown = shownSecrets((await readTopDocument(page)).text);
		for (const { value } of shown) seen(value);
		return shown.length === 0;
	} catch {
		return false;
	}
}

/** The page's text, once it is still the hook's site and shows the hook's address. */
async function hookPage(page: Page, hook: { readonly address: string; readonly site: string }): Promise<string> {
	const { url, text } = await readTopDocument(page);
	if (companyAccountFillHost(url, [hook.site]) === null)
		throw new CompanyHookCaptureRefusedError("VAULT_CAPTURE_WRONG_SITE");
	if (!addressShown(text, hook.address)) throw new CompanyHookCaptureRefusedError("VAULT_CAPTURE_WRONG_HOOK");
	return text;
}

/** The parts of a page the read touches (the runtime has no DOM types). */
interface PageNode {
	readonly tagName: string;
	readonly type?: string;
	readonly value?: unknown;
	readonly shadowRoot: PageRoot | null;
	hasAttribute(name: string): boolean;
	checkVisibility?(): boolean;
}
interface PageRoot {
	querySelectorAll(selector: string): Iterable<PageNode>;
	/** A shadow root's own children: elements (1) and text (3). */
	readonly childNodes?: Iterable<{
		readonly nodeType: number;
		readonly textContent: string | null;
		readonly innerText?: string;
		checkVisibility?(): boolean;
	}>;
}

/**
 * What a person sees on the page's own document: its rendered text and the values its boxes show, in open shadow
 * roots too (a host's text leaves its shadow root out, so each root's rendered children are read). A password box
 * shows dots, and a box the vault filled holds a value of the vault's own, so neither is read.
 */
async function readTopDocument(page: Page): Promise<{ url: string; text: string }> {
	const text: unknown = await page.evaluate((attribute) => {
		const document = (globalThis as unknown as { document: PageRoot & { body: { innerText: string } | null } })
			.document;
		const parts = [document.body?.innerText ?? ""];
		const walk = (root: PageRoot): void => {
			for (const node of root.querySelectorAll("*")) {
				if (
					(node.tagName === "INPUT" || node.tagName === "TEXTAREA") &&
					typeof node.value === "string" &&
					node.type !== "password" &&
					node.type !== "hidden" &&
					!node.hasAttribute(attribute)
				)
					parts.push(node.value);
				if (!node.shadowRoot) continue;
				// Read unless the browser says it is not rendered: text there is the host's to show.
				for (const child of node.shadowRoot.childNodes ?? [])
					if (child.nodeType === 1 && child.checkVisibility?.() !== false) parts.push(child.innerText ?? "");
					else if (child.nodeType === 3 && node.checkVisibility?.() !== false) parts.push(child.textContent ?? "");
				walk(node.shadowRoot);
			}
		};
		walk(document);
		return parts.join("\n");
	}, COMPANY_ACCOUNT_FILLED_ATTRIBUTE);
	return { url: page.url(), text: typeof text === "string" ? text : "" };
}

/** Whether `text` shows the hook's address as a word of its own (the path's last part of its URL). */
function addressShown(text: string, address: string): boolean {
	for (let at = text.indexOf(address); at !== -1; at = text.indexOf(address, at + 1))
		if (!/[A-Za-z0-9_-]/.test(text[at - 1] ?? "") && !/[A-Za-z0-9_-]/.test(text[at + address.length] ?? ""))
			return true;
	return false;
}

/**
 * Each value shaped like a signing secret that `text` shows (`whsec_` and letters, digits, `+`, `/` or `=`), and
 * whether it is whole: of a secret's length and not cut off. A bare `whsec_` (the rest masked) shows no value.
 */
function shownSecrets(text: string): { value: string; whole: boolean }[] {
	const shown: { value: string; whole: boolean }[] = [];
	const pattern = /whsec_[A-Za-z0-9+/=]*/g;
	for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
		if (match[0].length === "whsec_".length) continue;
		const end = match.index + match[0].length;
		shown.push({
			value: match[0],
			whole: EVENT_HOOK_CAPTURE_SECRET.test(match[0]) && !CUT.test(text.slice(end, end + 2)),
		});
	}
	return shown;
}

/** One read: no value, the one value shown (wherever it shows, whole everywhere or not), or more than one. */
function secretShown(text: string, seen: (value: string) => void): { value: string; whole: boolean } | "none" | "many" {
	const shown = shownSecrets(text);
	const values = new Set(shown.map(({ value }) => value));
	for (const value of values) seen(value);
	if (values.size === 0) return "none";
	if (values.size > 1) return "many";
	return { value: shown[0]!.value, whole: shown.every(({ whole }) => whole) };
}

/**
 * The cover: an empty element over the whole page, above everything (in the top layer, put back on top every
 * frame, since a dialog the reveal opens joins the top layer above it). It takes no clicks, so the click reaches the
 * control under it. Run in the page now and in every document the tab loads until it is removed; `key` removes it.
 */
function coverSource(key: string): string {
	return `(() => {
	const key = ${JSON.stringify(key)};
	if (globalThis !== globalThis.top || globalThis[key]) return;
	const cover = document.createElement("div");
	cover.setAttribute("popover", "manual");
	cover.style.cssText = "all:initial;display:block;position:fixed;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;margin:0;padding:0;border:0;background:#1f1f1f;opacity:1;visibility:visible;pointer-events:none;z-index:2147483647";
	let on = true;
	const place = () => {
		if (!on) return;
		const root = document.documentElement;
		if (root && root.lastElementChild !== cover) root.appendChild(cover);
		try {
			if (cover.matches(":popover-open")) cover.hidePopover();
			cover.showPopover();
		} catch {}
		requestAnimationFrame(place);
	};
	globalThis[key] = () => {
		on = false;
		cover.remove();
		delete globalThis[key];
	};
	place();
})()`;
}

/** A copy of nothing: the page's own copy handlers never run, and the clipboard is left empty. */
const CLEAR_CLIPBOARD = `(() => {
	const clear = (event) => {
		event.stopImmediatePropagation();
		event.preventDefault();
		event.clipboardData.setData("text/plain", "");
	};
	globalThis.addEventListener("copy", clear, true);
	try {
		return document.execCommand("copy");
	} finally {
		globalThis.removeEventListener("copy", clear, true);
	}
})()`;

// Sealed captures waiting for their perform answer, at most this many: each is handed on right after its operation.
const HELD_CAPTURES = 4;

/** The office service's sealed captures (E3c-3), each kept until its native gateway's answer takes it, once, and
 * never past the box's own lifetime. */
export class CompanyComputerHookCaptureBoxes {
	readonly #held = new Map<string, { box: Readonly<Record<string, string>>; timer: ReturnType<typeof setTimeout> }>();

	hold(receiptId: string, box: Readonly<Record<string, string>>): void {
		this.#drop(receiptId);
		const timer = setTimeout(() => this.#drop(receiptId), EVENT_HOOK_CAPTURE_LIFETIME_MS);
		timer.unref?.();
		this.#held.set(receiptId, { box: Object.freeze({ ...box }), timer });
		while (this.#held.size > HELD_CAPTURES) this.#drop(this.#held.keys().next().value as string);
	}

	take(receiptId: string): Readonly<Record<string, string>> | undefined {
		const held = this.#held.get(receiptId);
		this.#drop(receiptId);
		return held?.box;
	}

	clear(): void {
		for (const receiptId of [...this.#held.keys()]) this.#drop(receiptId);
	}

	#drop(receiptId: string): void {
		const held = this.#held.get(receiptId);
		if (!held) return;
		clearTimeout(held.timer);
		this.#held.delete(receiptId);
	}
}
