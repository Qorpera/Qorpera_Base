import type { Locator, Page } from "playwright-core";
import type { CompanyAccountFill } from "./cloud-company-account-fill-box.ts";
import {
	COMPANY_COMPUTER_PRIVATE_VALUE,
	COMPANY_COMPUTER_SECRET_SHAPE,
	companyComputerUrlForms,
} from "./cloud-company-computer-private-fields.ts";

/* The office's last step of a company account fill (A1-3): the value the vault sealed to this computer,
 * already opened, goes into one box of one page and nowhere else. The page must be the account's website
 * or one of its sign-in hosts, over https, and the box must be the kind the field names. The value is
 * typed with CDP Input.insertText, so it never passes the X server (no keystrokes another program on the
 * screen could read), and a box for a secret is marked private first, so every snapshot, screenshot mask
 * and whole-screen check treats it as a password box from then on.
 *
 * A signed hook's secret (E3b-3) goes the same way onto the hook's site. A website's box for it is often a
 * text box: the fill makes it a password box, so the secret is never drawn on the screen, and types only
 * while the box still reads back as one. */

/** Set on a box the vault filled; the private-field selector covers it. */
export const COMPANY_ACCOUNT_FILLED_ATTRIBUTE = "data-qorpera-private";

export type CompanyAccountFillRefusal =
	| "ACCOUNT_FILL_WRONG_SITE"
	| "ACCOUNT_FILL_WRONG_BOX"
	| "ACCOUNT_FILL_IN_FRAME"
	| "ACCOUNT_FILL_UNCONFIRMED"
	/** The value went where it cannot be emptied (a closed shadow root, an editable area): the tab must go. */
	| "ACCOUNT_FILL_LOST"
	/** A hook's secret: the page kept its box from being a password box (or made it show again, and it was emptied). */
	| "ACCOUNT_FILL_NOT_HIDDEN";

export class CompanyAccountFillRefusedError extends Error {
	readonly reason: CompanyAccountFillRefusal;
	constructor(reason: CompanyAccountFillRefusal) {
		super(reason);
		this.name = "CompanyAccountFillRefusedError";
		this.reason = reason;
	}
}

/** The page's host when it is https and one of the account's hosts; otherwise null. */
export function companyAccountFillHost(url: string, hosts: readonly string[]): string | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return null;
	return hosts.includes(parsed.hostname) ? parsed.hostname : null;
}

/** The parts of a page's box the fill reads (the runtime has no DOM types). */
interface PageBox {
	readonly tagName: string;
	type: string;
	readonly disabled: boolean;
	readonly readOnly: boolean;
	value: string;
	setAttribute(name: string, value: string): void;
}

/** What the box must be for each field: a password box for a password, a text-like box otherwise. A hook's
 * secret takes a text box too, which becomes a password box before anything is typed. */
const BOX_TYPES: Readonly<Record<CompanyAccountFill["field"], readonly string[]>> = {
	login: ["text", "email", "tel"],
	password: ["password"],
	new_password: ["password"],
	code: ["text", "tel", "number", "password"],
	signing_secret: ["text", "password"],
};

/**
 * Types the opened value into the one box `box` names on `page`. Refuses (nothing typed) a page that is not
 * the account's, a box inside a frame, or a box of the wrong kind (for a hook's secret, also one that does not stay
 * a password box); refuses after typing when the value did not land whole in that box (a website that reshapes
 * input, or moved the focus meanwhile), so the agent looks again. A value that landed in another box is marked
 * private and emptied there.
 */
export async function fillCompanyAccountBox(page: Page, box: Locator, fill: CompanyAccountFill): Promise<void> {
	if (companyAccountFillHost(page.url(), fill.hosts) === null)
		throw new CompanyAccountFillRefusedError("ACCOUNT_FILL_WRONG_SITE");
	const handle = await box.elementHandle({ timeout: 5_000 });
	if (!handle) throw new CompanyAccountFillRefusedError("ACCOUNT_FILL_WRONG_BOX");
	try {
		// Only the page's own document: a frame could be another website inside an allowed one.
		if ((await handle.ownerFrame()) !== page.mainFrame())
			throw new CompanyAccountFillRefusedError("ACCOUNT_FILL_IN_FRAME");
		const types = BOX_TYPES[fill.field];
		// A hook's secret is never drawn on the screen, whatever box the website gave it.
		const hide = fill.field === "signing_secret";
		// Marks the box before any value reaches it; answers whether it is a usable box of the right kind.
		// A login is no secret: its box stays readable to the agent. A hook's box becomes a password box.
		const usable = await handle.evaluate(
			(node, { types, attribute, hide }) => {
				const element = node as unknown as PageBox;
				// An input only: the type of anything else is not a box's.
				if (element.tagName !== "INPUT") return false;
				if (element.disabled || element.readOnly || !types.includes(element.type)) return false;
				if (attribute) element.setAttribute(attribute, "");
				if (hide) element.type = "password";
				return true;
			},
			{ types: [...types], attribute: fill.field === "login" ? null : COMPANY_ACCOUNT_FILLED_ATTRIBUTE, hide },
		);
		if (!usable) throw new CompanyAccountFillRefusedError("ACCOUNT_FILL_WRONG_BOX");
		// The box's type read back in a call of its own, after the page's scripts had their turn: a page that undid
		// the change (or never let it happen) never shows the secret.
		if (hide && (await handle.evaluate((element) => (element as unknown as PageBox).type)) !== "password")
			throw new CompanyAccountFillRefusedError("ACCOUNT_FILL_NOT_HIDDEN");
		// A page that moves the focus when it finishes loading has done so before the value goes in.
		await page.waitForLoadState("load", { timeout: 5_000 }).catch(() => undefined);
		// Empty the box and give it the focus, then insert the value where the focus is.
		await box.fill("", { timeout: 5_000 });
		await box.focus({ timeout: 5_000 });
		// The page may have moved on (a redirect) between the checks and the typing.
		if (companyAccountFillHost(page.url(), fill.hosts) === null)
			throw new CompanyAccountFillRefusedError("ACCOUNT_FILL_WRONG_SITE");
		const session = await page.context().newCDPSession(page);
		try {
			// The box has the focus, and a hook's box is still a password box, just before the value goes in.
			const ready = await handle.evaluate(
				(element, hide) =>
					element !== (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement
						? "moved"
						: hide && (element as unknown as PageBox).type !== "password"
							? "shown"
							: "ready",
				hide,
			);
			if (ready === "shown") throw new CompanyAccountFillRefusedError("ACCOUNT_FILL_NOT_HIDDEN");
			if (ready !== "ready") throw new CompanyAccountFillRefusedError("ACCOUNT_FILL_WRONG_BOX");
			await session.send("Input.insertText", { text: fill.value });
		} finally {
			await session.detach().catch(() => undefined);
		}
		// Where the value went. A hook's box that shows its text again is emptied first. Whole in the box: done, even
		// if the page has moved the focus on since (a code box that advances). Otherwise a page script moved the focus
		// between the check and the typing: the value is in the box that has the focus now, inside open shadow roots
		// too, which is marked private and emptied; where it cannot be emptied, the value is lost to the page and the
		// caller closes the tab.
		const landed = await handle.evaluate(
			(element, { attribute, length, hide }) => {
				const filled = element as unknown as PageBox;
				const shown = hide && filled.type !== "password";
				const whole = filled.value.length === length;
				if (shown) filled.value = "";
				if (whole) return shown ? "shown" : "filled";
				interface Focus extends PageBox {
					shadowRoot?: { activeElement: Focus | null } | null;
				}
				let active = (globalThis as unknown as { document: { activeElement: Focus | null } }).document
					.activeElement;
				while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
				if (!active || active === (element as unknown)) return shown ? "shown" : "short";
				if (typeof active.value !== "string") return "lost";
				active.setAttribute(attribute, "");
				active.value = "";
				return shown ? "shown" : "emptied";
			},
			{ attribute: COMPANY_ACCOUNT_FILLED_ATTRIBUTE, length: fill.value.length, hide },
		);
		if (landed === "shown") throw new CompanyAccountFillRefusedError("ACCOUNT_FILL_NOT_HIDDEN");
		if (landed === "lost") throw new CompanyAccountFillRefusedError("ACCOUNT_FILL_LOST");
		if (landed !== "filled") throw new CompanyAccountFillRefusedError("ACCOUNT_FILL_UNCONFIRMED");
	} finally {
		await handle.dispose().catch(() => undefined);
	}
}

/** An authenticator code is hidden for this long after it was typed; a password for the service's lifetime. */
const CODE_HIDDEN_MS = 5 * 60_000;
const MAX_FILLED = 64;

/**
 * The secrets the vault typed on one screen, kept by the office service for as long as it runs (a screen's tabs
 * outlive the runs that drive them). Every snapshot, title, address and tab name the agent gets hides them, and
 * no screenshot is taken while a page shows one. The values never leave this process: pages are read, never told.
 * Text shaped like a hook's signing secret is hidden the same way, whoever put it on the page (E3c-3).
 */
export class CompanyComputerFilledValues {
	readonly #values = new Map<string, number>();
	readonly #now: () => number;

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	/** A login is no secret; a code is hidden for a while; anything else (a password, a hook's or a coding value's secret
	 * read off a page) for the service's lifetime. */
	add(value: string, field: CompanyAccountFill["field"] | "coding_value"): void {
		if (field === "login") return;
		this.current();
		this.#values.delete(value);
		this.#values.set(value, field === "code" ? this.#now() + CODE_HIDDEN_MS : Number.POSITIVE_INFINITY);
		while (this.#values.size > MAX_FILLED) this.#values.delete(this.#values.keys().next().value!);
	}

	/** The values still hidden now. */
	current(): string[] {
		const now = this.#now();
		for (const [value, until] of this.#values) if (until <= now) this.#values.delete(value);
		return [...this.#values.keys()];
	}

	/** `text` (a title or an address) with every value still hidden replaced, in each spelling an address uses. */
	hide(text: string): string {
		let out = text;
		for (const form of this.#forms()) out = out.replace(form, COMPANY_COMPUTER_PRIVATE_VALUE);
		return out;
	}

	/** Whether `text` shows a value still hidden, in any of those spellings. */
	shows(text: string): boolean {
		return this.#forms().some((form) => form.test(text));
	}

	/**
	 * Whether `text` shows a value still hidden, also after up to three decodes of percent escapes (either letter
	 * case): a redirect that wraps an address encodes it again. A value's spellings already match one encoding.
	 */
	showsDecoded(text: string): boolean {
		let layer = text;
		for (let depth = 0; ; depth++) {
			if (this.shows(layer)) return true;
			const next = percentDecoded(layer);
			if (depth === 3 || next === layer) return false;
			layer = next;
		}
	}

	/** A page address the agent may read: its query and fragment (or all of it) hidden when they show a value. */
	hideAddress(address: string): string {
		if (!this.showsDecoded(address)) return address;
		try {
			const url = new URL(address);
			const path = this.showsDecoded(url.pathname) ? `/${COMPANY_COMPUTER_PRIVATE_VALUE}` : url.pathname;
			const out = `${url.origin}${path}${url.search ? `?${COMPANY_COMPUTER_PRIVATE_VALUE}` : ""}${url.hash ? `#${COMPANY_COMPUTER_PRIVATE_VALUE}` : ""}`;
			// A value in the host itself (a code as a subdomain): none of the address is kept.
			return this.showsDecoded(out) ? COMPANY_COMPUTER_PRIVATE_VALUE : out;
		} catch {
			return COMPANY_COMPUTER_PRIVATE_VALUE;
		}
	}

	/** A title or other text the agent may read: wholly hidden when a value survives in any decoded layer. */
	hideText(text: string): string {
		const hidden = this.hide(text);
		return this.showsDecoded(hidden) ? COMPANY_COMPUTER_PRIVATE_VALUE : hidden;
	}

	/**
	 * Any text shaped like a hook's signing secret (E3c-3), typed by the vault or not, first: hidden whole, so a part of
	 * one recorded as a value cannot cut it and leave the rest. Then each value's spellings as patterns; an
	 * authenticator code only as a number of its own.
	 */
	#forms(): RegExp[] {
		return [
			new RegExp(COMPANY_COMPUTER_SECRET_SHAPE.source, "g"),
			...this.current().flatMap((value) => {
				const code = /^\d+$/.test(value);
				return [...new Set([value, ...companyComputerUrlForms(value)])].map(
					(form) => new RegExp(code ? `(?<!\\d)${form}(?!\\d)` : form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
				);
			}),
		];
	}
}

const utf8 = new TextDecoder("utf-8");

/**
 * `text` with each run of %XX escapes decoded: as UTF-8 when the run is UTF-8, else each byte as a character (as
 * `escape` writes one). Lenient and linear: it never throws, whatever the page holds.
 */
function percentDecoded(text: string): string {
	return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
		const bytes = Uint8Array.from(run.slice(1).split("%"), (hex) => Number.parseInt(hex, 16));
		const decoded = utf8.decode(bytes);
		if (!decoded.includes("\uFFFD")) return decoded;
		let latin1 = "";
		for (const byte of bytes) latin1 += String.fromCharCode(byte);
		return latin1;
	});
}
