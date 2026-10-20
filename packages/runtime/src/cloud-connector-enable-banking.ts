import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import {
	ConnectorRequestError,
	connectorRequest,
	encodeBase64Url,
	jsonArray,
	jsonRecord,
	jsonString,
	parseJsonResponse,
} from "./cloud-connector-http.ts";

/**
 * The Enable Banking client the company secret broker uses for a company's bank connection (PSD2 account information:
 * balances and transactions, read only). Enable Banking is the licensed provider between Qorpera and the bank; the
 * member authorizes access at the bank itself (MitID), and nothing here can move money.
 *
 * Every request carries a short JWT signed with Qorpera's application key (RS256, `kid` the application id), which
 * names the application, never a member. The key lives only in the broker's systemd credential; a company's session
 * id, which grants read access to its accounts until the consent ends, is sealed like any other company credential.
 * Provider answers are reduced here to the few fields the broker needs; nothing else leaves this module.
 *
 * API: https://enablebanking.com/docs/api/reference/
 */

export const ENABLE_BANKING_ORIGIN = "https://api.enablebanking.com";
/** A token lives an hour; Enable Banking refuses more than a day. */
const TOKEN_SECONDS = 3600;
/** At most this many transaction pages per account and fetch; a bank that pages further is cut off there. */
const TRANSACTION_PAGES = 40;
const AMOUNT = /^-?\d+(\.\d+)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface EnableBankingApp {
	readonly applicationId: string;
	readonly privateKeyPem: string;
}

/** A bank Enable Banking reaches, as the member picks it. */
export interface EnableBankingBank {
	readonly name: string;
	readonly country: string;
	/** Seconds a consent may last at this bank (180 days at most banks). */
	readonly maximumConsentSeconds: number | null;
}

export interface EnableBankingAccount {
	/** The id data calls use, valid while the session is authorized. */
	readonly uid: string;
	/** The same account across sessions. */
	readonly identificationHash: string | null;
	readonly name: string | null;
	readonly currency: string | null;
	readonly iban: string | null;
	/** The bank's own account number (a Danish registration and account number), when it gives one. */
	readonly otherIdentification: string | null;
}

export interface EnableBankingSession {
	readonly sessionId: string;
	readonly accounts: readonly EnableBankingAccount[];
	/** When the consent ends, as the session says. */
	readonly validUntil: string | null;
	readonly bank: string | null;
}

export type EnableBankingSessionStatus =
	| "PENDING_AUTHORIZATION"
	| "RETURNED_FROM_BANK"
	| "AUTHORIZED"
	| "CANCELLED"
	| "CLOSED"
	| "EXPIRED"
	| "INVALID"
	| "REVOKED";

export interface EnableBankingBalance {
	/** ISO 20022 type: CLBD and ITBD booked, CLAV and ITAV available, XPCD instant, and others. */
	readonly type: string;
	readonly amount: number;
	readonly currency: string;
	readonly referenceDate: string | null;
}

export interface EnableBankingTransaction {
	readonly reference: string | null;
	/** Positive for money in, negative for money out. */
	readonly amount: number;
	readonly currency: string;
	readonly status: string;
	/** The day it was booked, else its value or transaction day. */
	readonly date: string;
	/** Who paid (money in) or who was paid (money out), when the bank names them. */
	readonly counterparty: string | null;
	/** The transfer's text, its lines joined. */
	readonly text: string | null;
}

/** The consent behind a session ended (expired, revoked or closed): the member must authorize again. */
export class EnableBankingSessionEnded extends Error {
	readonly code: string;
	constructor(code: string) {
		super(`The bank connection ended (${code}).`);
		this.name = "EnableBankingSessionEnded";
		this.code = code;
	}
}

/** RS256 JWT for the application, valid `TOKEN_SECONDS` from `now`. */
export function enableBankingToken(app: EnableBankingApp, key: KeyObject, now: Date): string {
	const issued = Math.floor(now.getTime() / 1000);
	const header = encodeBase64Url(JSON.stringify({ typ: "JWT", alg: "RS256", kid: app.applicationId }));
	const claims = encodeBase64Url(
		JSON.stringify({
			iss: "enablebanking.com",
			aud: "api.enablebanking.com",
			iat: issued,
			exp: issued + TOKEN_SECONDS,
		}),
	);
	const signer = createSign("RSA-SHA256");
	signer.update(`${header}.${claims}`);
	return `${header}.${claims}.${encodeBase64Url(signer.sign(key))}`;
}

/** An amount as Enable Banking writes it ("1234.50"), in kroner, or null. */
function amount(value: unknown): number | null {
	const record = jsonRecord(value);
	const text = typeof record.amount === "string" ? record.amount : null;
	if (text === null || !AMOUNT.test(text)) return null;
	const parsed = Number(text);
	return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : null;
}

function day(value: unknown): string | null {
	return typeof value === "string" && DATE.test(value.slice(0, 10)) ? value.slice(0, 10) : null;
}

const SESSION_ENDED = new Set(["EXPIRED_SESSION", "REVOKED_SESSION", "CLOSED_SESSION", "SESSION_DOES_NOT_EXIST"]);

export class EnableBankingClient {
	readonly #app: EnableBankingApp;
	readonly #key: KeyObject;
	readonly #fetch: typeof fetch;
	readonly #now: () => Date;

	constructor(app: EnableBankingApp, fetchImpl: typeof fetch, now: () => Date = () => new Date()) {
		this.#app = app;
		this.#key = createPrivateKey(app.privateKeyPem);
		if (this.#key.asymmetricKeyType !== "rsa") throw new Error("The Enable Banking key must be an RSA key");
		this.#fetch = fetchImpl;
		this.#now = now;
	}

	async #call(
		method: "GET" | "POST" | "DELETE",
		path: string,
		signal: AbortSignal,
		options: { query?: Record<string, string | undefined>; body?: unknown } = {},
	): Promise<Record<string, unknown>> {
		const response = await connectorRequest({
			fetch: this.#fetch,
			origin: ENABLE_BANKING_ORIGIN,
			path,
			method,
			signal,
			...(options.query ? { query: options.query } : {}),
			headers: {
				authorization: `Bearer ${enableBankingToken(this.#app, this.#key, this.#now())}`,
				...(options.body === undefined ? {} : { "content-type": "application/json" }),
			},
			...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
		});
		if (response.status >= 200 && response.status < 300) return jsonRecord(parseJsonResponse(response));
		let code = "";
		let message = "";
		try {
			const body = jsonRecord(parseJsonResponse(response));
			code = jsonString(body.error, 64) ?? jsonString(body.code, 64) ?? "";
			message = jsonString(body.message, 200) ?? jsonString(body.detail, 200) ?? "";
		} catch {
			// A body that isn't JSON says nothing more than its status.
		}
		if (SESSION_ENDED.has(code)) throw new EnableBankingSessionEnded(code);
		const detail = `Enable Banking: ${message || code || `answered ${response.status}`}`;
		if (response.status === 429 || code === "ASPSP_RATE_LIMIT_EXCEEDED")
			throw new ConnectorRequestError("rate_limited", detail);
		if (response.status === 401 || response.status === 403) throw new ConnectorRequestError("forbidden", detail);
		if (response.status === 404) throw new ConnectorRequestError("not_found", detail);
		if (response.status === 400 || response.status === 409 || response.status === 422)
			throw new ConnectorRequestError("invalid_request", detail);
		throw new ConnectorRequestError("provider_error", detail);
	}

	/** The banks of a country for a kind of customer. */
	async banks(country: string, psuType: "business" | "personal", signal: AbortSignal): Promise<EnableBankingBank[]> {
		const body = await this.#call("GET", "/aspsps", signal, { query: { country, psu_type: psuType } });
		return jsonArray(body.aspsps).flatMap((entry) => {
			const bank = jsonRecord(entry);
			const name = jsonString(bank.name, 200);
			const bankCountry = jsonString(bank.country, 2);
			if (!name || !bankCountry) return [];
			const seconds = bank.maximum_consent_validity;
			return [
				{
					name,
					country: bankCountry,
					maximumConsentSeconds: typeof seconds === "number" && Number.isSafeInteger(seconds) ? seconds : null,
				},
			];
		});
	}

	/** Starts a member's authorization at their bank: the URL to send their browser to. */
	async authorize(
		input: {
			readonly bank: { readonly name: string; readonly country: string };
			readonly validUntil: Date;
			readonly state: string;
			readonly redirectUrl: string;
			readonly psuType: "business" | "personal";
			readonly language?: string;
		},
		signal: AbortSignal,
	): Promise<{ url: string; authorizationId: string | null }> {
		const body = await this.#call("POST", "/auth", signal, {
			body: {
				access: { valid_until: input.validUntil.toISOString(), balances: true, transactions: true },
				aspsp: { name: input.bank.name, country: input.bank.country },
				state: input.state,
				redirect_url: input.redirectUrl,
				psu_type: input.psuType,
				...(input.language ? { language: input.language } : {}),
			},
		});
		const url = jsonString(body.url, 4096);
		if (!url || !URL.canParse(url) || new URL(url).protocol !== "https:")
			throw new ConnectorRequestError("provider_error", "Enable Banking gave no bank address to go to.");
		return { url, authorizationId: jsonString(body.authorization_id, 200) };
	}

	/** Turns the code the bank sent back into a session with the accounts the member shared. */
	async createSession(code: string, signal: AbortSignal): Promise<EnableBankingSession> {
		const body = await this.#call("POST", "/sessions", signal, { body: { code } });
		const sessionId = jsonString(body.session_id, 200);
		if (!sessionId) throw new ConnectorRequestError("provider_error", "Enable Banking made no session.");
		return {
			sessionId,
			accounts: jsonArray(body.accounts).flatMap((entry) => {
				const account = jsonRecord(entry);
				const uid = jsonString(account.uid, 200);
				if (!uid) return [];
				const ids = jsonRecord(account.account_id);
				const other = jsonRecord(ids.other);
				return [
					{
						uid,
						identificationHash: jsonString(account.identification_hash, 200),
						name: jsonString(account.name, 120),
						currency: jsonString(account.currency, 3),
						iban: jsonString(ids.iban, 34),
						otherIdentification: jsonString(other.identification, 34),
					},
				];
			}),
			validUntil: jsonString(jsonRecord(body.access).valid_until, 40),
			bank: jsonString(jsonRecord(body.aspsp).name, 200),
		};
	}

	async sessionStatus(sessionId: string, signal: AbortSignal): Promise<EnableBankingSessionStatus | null> {
		const body = await this.#call("GET", `/sessions/${encodeURIComponent(sessionId)}`, signal);
		const status = jsonString(body.status, 40);
		const known: readonly string[] = [
			"PENDING_AUTHORIZATION",
			"RETURNED_FROM_BANK",
			"AUTHORIZED",
			"CANCELLED",
			"CLOSED",
			"EXPIRED",
			"INVALID",
			"REVOKED",
		];
		return status && known.includes(status) ? (status as EnableBankingSessionStatus) : null;
	}

	/** Ends a session at Enable Banking: the member disconnected the bank. */
	async closeSession(sessionId: string, signal: AbortSignal): Promise<void> {
		try {
			await this.#call("DELETE", `/sessions/${encodeURIComponent(sessionId)}`, signal);
		} catch (error) {
			if (!(error instanceof EnableBankingSessionEnded)) throw error;
		}
	}

	async balances(uid: string, signal: AbortSignal): Promise<EnableBankingBalance[]> {
		const body = await this.#call("GET", `/accounts/${encodeURIComponent(uid)}/balances`, signal);
		return jsonArray(body.balances).flatMap((entry) => {
			const balance = jsonRecord(entry);
			const value = amount(balance.balance_amount);
			const currency = jsonString(jsonRecord(balance.balance_amount).currency, 3);
			const type = jsonString(balance.balance_type, 8);
			if (value === null || !currency || !type) return [];
			return [{ type, amount: value, currency, referenceDate: day(balance.reference_date) }];
		});
	}

	/** Every transaction from `from` on (or as far back as the bank allows, `longest`), page by page. */
	async transactions(
		uid: string,
		from: string | null,
		signal: AbortSignal,
	): Promise<{ transactions: EnableBankingTransaction[]; complete: boolean }> {
		const transactions: EnableBankingTransaction[] = [];
		let continuation: string | undefined;
		for (let page = 0; page < TRANSACTION_PAGES; page++) {
			const body = await this.#call("GET", `/accounts/${encodeURIComponent(uid)}/transactions`, signal, {
				query: {
					...(from ? { date_from: from } : { strategy: "longest" }),
					...(continuation ? { continuation_key: continuation } : {}),
				},
			});
			for (const entry of jsonArray(body.transactions)) {
				const item = jsonRecord(entry);
				const value = amount(item.transaction_amount);
				const currency = jsonString(jsonRecord(item.transaction_amount).currency, 3);
				const date = day(item.booking_date) ?? day(item.value_date) ?? day(item.transaction_date);
				const indicator = item.credit_debit_indicator;
				if (value === null || !currency || !date || (indicator !== "CRDT" && indicator !== "DBIT")) continue;
				const incoming = indicator === "CRDT";
				const party = jsonRecord(incoming ? item.debtor : item.creditor);
				const text = jsonArray(item.remittance_information)
					.flatMap((line) => (typeof line === "string" && line.trim() ? [line.trim()] : []))
					.join(" ");
				transactions.push({
					reference: jsonString(item.entry_reference, 200),
					amount: incoming ? Math.abs(value) : -Math.abs(value),
					currency,
					status: jsonString(item.status, 8) ?? "BOOK",
					date,
					counterparty: jsonString(party.name, 140),
					text: text ? (jsonString(text, 280) ?? null) : null,
				});
			}
			const next = jsonString(body.continuation_key, 2000);
			if (!next) return { transactions, complete: true };
			continuation = next;
		}
		return { transactions, complete: false };
	}
}
