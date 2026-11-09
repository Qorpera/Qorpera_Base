/* How far the company is with its bank (`finance/bank-setup.json` in the company folder, app/bank-page.ts): what the
 * Bank page shows while no bank is connected. The company's finance agent keeps it, by hand, as it registers the
 * company (CVR) and opens the business account; the founder only signs with MitID when it is their turn. The file is
 * the company's own work, so it lives under `finance/`, never under the platform's `bank/`.
 *
 *   { "schema": "qorpera.bank-setup/v1",
 *     "company": { "status": "done", "cvr": "45123456" },
 *     "account": { "status": "your_turn", "bank": "Danske Bank" },
 *     "yourTurn": "Sign the account application in the Danske Bank app." }
 *
 * A status is todo, working, your_turn or done. An agent writes this file, so the reader forgives: a part or a status
 * it doesn't know is todo, a CVR that isn't eight digits is left out, and a text is cut to a line. A file that isn't
 * this schema, or isn't JSON, reads as no file, and the page falls back to what it knows without it. */

/** Where the company folder keeps how far the bank setup is. */
export const BANK_SETUP_PATH = "finance/bank-setup.json";
export const BANK_SETUP_SCHEMA = "qorpera.bank-setup/v1";

export const BANK_SETUP_STATUSES = ["todo", "working", "your_turn", "done"] as const;
export type BankSetupStatus = (typeof BANK_SETUP_STATUSES)[number];

export interface BankSetup {
	readonly company: { readonly status: BankSetupStatus; readonly cvr?: string };
	readonly account: { readonly status: BankSetupStatus; readonly bank?: string };
	/** What the founder is asked to do now, in the agent's words. */
	readonly yourTurn?: string;
}

const TEXT_MAX = 200;

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function status(value: unknown): BankSetupStatus {
	return (BANK_SETUP_STATUSES as readonly unknown[]).includes(value) ? (value as BankSetupStatus) : "todo";
}

/** One line of text, or nothing. */
function line(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.replace(/\s+/g, " ").trim();
	if (!text) return undefined;
	const chars = [...text];
	return chars.length > TEXT_MAX ? `${chars.slice(0, TEXT_MAX - 1).join("")}…` : text;
}

export function parseBankSetup(text: string | undefined): BankSetup | null {
	if (text === undefined) return null;
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	const file = record(value);
	if (file.schema !== BANK_SETUP_SCHEMA) return null;
	const company = record(file.company);
	const account = record(file.account);
	const cvr = typeof company.cvr === "string" ? company.cvr.replace(/\s/g, "") : undefined;
	const bank = line(account.bank);
	const yourTurn = line(file.yourTurn);
	return {
		company: { status: status(company.status), ...(cvr && /^\d{8}$/.test(cvr) ? { cvr } : {}) },
		account: { status: status(account.status), ...(bank ? { bank } : {}) },
		...(yourTurn ? { yourTurn } : {}),
	};
}
