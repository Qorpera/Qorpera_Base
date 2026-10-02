import type { Locator, Page } from "playwright-core";
import type { CompanyAccountFill } from "./cloud-company-account-fill-box.ts";

/* The office's last step of a company account fill (A1-3): the value the vault sealed to this computer,
 * already opened, goes into one box of one page and nowhere else. The page must be the account's website
 * or one of its sign-in hosts, over https, and the box must be the kind the field names. The value is
 * typed with CDP Input.insertText, so it never passes the X server (no keystrokes another program on the
 * screen could read), and a box for a secret is marked private first, so every snapshot, screenshot mask
 * and whole-screen check treats it as a password box from then on. */

/** Set on a box the vault filled; the private-field selector covers it. */
export const COMPANY_ACCOUNT_FILLED_ATTRIBUTE = "data-qorpera-private";

export type CompanyAccountFillRefusal =
	| "ACCOUNT_FILL_WRONG_SITE"
	| "ACCOUNT_FILL_WRONG_BOX"
	| "ACCOUNT_FILL_IN_FRAME"
	| "ACCOUNT_FILL_UNCONFIRMED";

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
	readonly type: string;
	readonly disabled: boolean;
	readonly readOnly: boolean;
	readonly value: string;
	setAttribute(name: string, value: string): void;
}

/** What the box must be for each field: a password box for a password, a text-like box otherwise. */
const BOX_TYPES: Readonly<Record<CompanyAccountFill["field"], readonly string[]>> = {
	login: ["text", "email", "tel"],
	password: ["password"],
	new_password: ["password"],
	code: ["text", "tel", "number", "password"],
};

/**
 * Types the opened value into the one box `box` names on `page`. Refuses (nothing typed) a page that is not
 * the account's, a box inside a frame, or a box of the wrong kind; refuses after typing when the box does
 * not hold as many characters as were typed (a website that reshapes input), so the agent looks again.
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
		// Marks the box before any value reaches it; answers whether it is a usable box of the right kind.
		// A login is no secret: its box stays readable to the agent.
		const usable = await handle.evaluate(
			(node, { types, attribute }) => {
				const element = node as unknown as PageBox;
				// An input only: the type of anything else is not a box's.
				if (element.tagName !== "INPUT") return false;
				if (element.disabled || element.readOnly || !types.includes(element.type)) return false;
				if (attribute) element.setAttribute(attribute, "");
				return true;
			},
			{ types: [...types], attribute: fill.field === "login" ? null : COMPANY_ACCOUNT_FILLED_ATTRIBUTE },
		);
		if (!usable) throw new CompanyAccountFillRefusedError("ACCOUNT_FILL_WRONG_BOX");
		// Empty the box and give it the focus, then insert the value where the focus is.
		await box.fill("", { timeout: 5_000 });
		await box.focus({ timeout: 5_000 });
		// The page may have moved on (a redirect) between the checks and the typing.
		if (companyAccountFillHost(page.url(), fill.hosts) === null)
			throw new CompanyAccountFillRefusedError("ACCOUNT_FILL_WRONG_SITE");
		const session = await page.context().newCDPSession(page);
		try {
			const focused = await handle.evaluate(
				(element) =>
					element === (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement,
			);
			if (!focused) throw new CompanyAccountFillRefusedError("ACCOUNT_FILL_WRONG_BOX");
			await session.send("Input.insertText", { text: fill.value });
		} finally {
			await session.detach().catch(() => undefined);
		}
		const length = await handle.evaluate((element) => (element as unknown as PageBox).value.length);
		if (length !== fill.value.length) throw new CompanyAccountFillRefusedError("ACCOUNT_FILL_UNCONFIRMED");
	} finally {
		await handle.dispose().catch(() => undefined);
	}
}
