import { createHash } from "node:crypto";
import { UUID_PATTERN } from "@qorpera/contracts";
import { type BankSummaryFile, danishAccount, reduceBankSummary } from "./bank-summary-reduce.ts";
import {
	type EnableBankingAccount,
	type EnableBankingBalance,
	type EnableBankingClient,
	EnableBankingSessionEnded,
	type EnableBankingTransaction,
} from "./cloud-connector-enable-banking.ts";
import { ConnectorRequestError } from "./cloud-connector-http.ts";
import type { CloudSecretKeyring } from "./cloud-secret-crypto.ts";

/**
 * The company bank sync (Bank interface, part 2; migration 20260930523000). A company's vault claims its
 * bank sync when it is due (right after a connect, then every six hours), opens the sealed session, fetches
 * each shared account's balances and transactions from Enable Banking, keeps the booked transactions in the
 * database (a bank hands out its full history only shortly after the member signs in), reduces everything
 * to the bank summary the Bank page draws, and records it. Writing the summary to the company folder is the
 * object gateway's.
 *
 * Nothing here logs or records a session id, an account number or a transaction: errors are fixed phrases,
 * accounts are known to the database by a hash of their bank identity, transactions by a hash of their own.
 */

export interface BankSyncAuthority {
	claimBankSync(signal: AbortSignal): Promise<unknown>;
	recordBankTransactions(
		input: {
			secretId: string;
			version: number;
			accountKeys: readonly string[];
			transactions: readonly KeptBankTransaction[];
		},
		signal: AbortSignal,
	): Promise<unknown>;
	finishBankSync(
		input: {
			secretId: string;
			version: number;
			outcome: "current" | "ended" | "failed";
			summary: BankSummaryFile | null;
			consentUntil: string | null;
			deep: boolean;
			error: string | null;
		},
		signal: AbortSignal,
	): Promise<unknown>;
}

/** A booked transaction as the database keeps it. */
export interface KeptBankTransaction {
	readonly accountKey: string;
	readonly key: string;
	readonly date: string;
	readonly amount: number;
	readonly currency: string;
	readonly counterparty: string | null;
	readonly text: string | null;
}

export type BankSyncOutcome = "idle" | "current" | "ended" | "failed";

const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA = /^[0-9a-f]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;
/** When the consent ends, as Enable Banking writes it (microseconds and an offset); the database parses it. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const DATABASE_DEADLINE_MS = 10_000;
/** The whole fetch: every account's balances and transaction pages. */
const FETCH_DEADLINE_MS = 4 * 60_000;
const PASS_EVERY_MS = 60_000;

interface Claim {
	readonly companyId: string;
	readonly environmentId: string;
	readonly secretId: string;
	readonly version: number;
	readonly keyId: string;
	readonly encryptedEnvelopeBase64: string;
	readonly envelopeSha256: string;
	readonly deep: boolean;
	readonly since: string | null;
}

function parseClaim(value: unknown): Claim | null {
	if (value === null) return null;
	const input = value as Record<string, unknown>;
	const base64 =
		typeof input?.encryptedEnvelopeBase64 === "string" ? input.encryptedEnvelopeBase64.replace(/\r?\n/g, "") : "";
	if (
		!input ||
		typeof input !== "object" ||
		Object.keys(input).sort().join() !==
			"companyId,deep,encryptedEnvelopeBase64,envelopeSha256,environmentId,keyId,schema,secretId,secretVersion,since" ||
		input.schema !== "qorpera.bank-sync-claim/v1" ||
		![input.companyId, input.environmentId, input.secretId].every(
			(id) => typeof id === "string" && UUID_PATTERN.test(id),
		) ||
		!Number.isSafeInteger(input.secretVersion) ||
		(input.secretVersion as number) < 1 ||
		typeof input.keyId !== "string" ||
		!KEY_ID.test(input.keyId) ||
		base64.length > 180_000 ||
		!BASE64.test(base64) ||
		typeof input.envelopeSha256 !== "string" ||
		!SHA.test(input.envelopeSha256) ||
		typeof input.deep !== "boolean" ||
		(input.since !== null && (typeof input.since !== "string" || !DATE.test(input.since)))
	)
		throw new Error("Bank sync claim is invalid");
	return {
		companyId: input.companyId as string,
		environmentId: input.environmentId as string,
		secretId: input.secretId as string,
		version: input.secretVersion as number,
		keyId: input.keyId,
		encryptedEnvelopeBase64: base64,
		envelopeSha256: input.envelopeSha256,
		deep: input.deep,
		since: input.since as string | null,
	};
}

function parseKept(value: unknown): Omit<KeptBankTransaction, "key">[] {
	const input = value as Record<string, unknown>;
	if (
		!input ||
		typeof input !== "object" ||
		input.schema !== "qorpera.bank-transactions-kept/v1" ||
		!Array.isArray(input.transactions)
	)
		throw new Error("Kept bank transactions are invalid");
	return input.transactions.map((item) => {
		const row = item as Record<string, unknown>;
		if (
			!row ||
			typeof row !== "object" ||
			typeof row.accountKey !== "string" ||
			!SHA.test(row.accountKey) ||
			typeof row.date !== "string" ||
			!DATE.test(row.date) ||
			typeof row.amount !== "number" ||
			!Number.isFinite(row.amount) ||
			typeof row.currency !== "string" ||
			!CURRENCY.test(row.currency) ||
			(row.counterparty !== null && typeof row.counterparty !== "string") ||
			(row.text !== null && typeof row.text !== "string")
		)
			throw new Error("Kept bank transactions are invalid");
		return {
			accountKey: row.accountKey,
			date: row.date,
			amount: row.amount,
			currency: row.currency,
			counterparty: row.counterparty as string | null,
			text: row.text as string | null,
		};
	});
}

/** The sealed session: its id, the accounts the member shared, the bank's name and when the consent ends. */
function parseSession(fields: Readonly<Record<string, string>>): {
	sessionId: string;
	accounts: EnableBankingAccount[];
	bank: string;
	validUntil: string | null;
} {
	const sessionId = fields.session_id;
	let accounts: unknown;
	try {
		accounts = JSON.parse(fields.accounts ?? "");
	} catch {
		accounts = undefined;
	}
	if (!sessionId || !Array.isArray(accounts) || accounts.length < 1 || accounts.length > 32)
		throw new BankSyncError("the sealed bank session is unreadable");
	return {
		sessionId,
		accounts: accounts.map((item) => {
			const account = item as Record<string, unknown>;
			const text = (key: string) => (typeof account?.[key] === "string" ? (account[key] as string) : null);
			const uid = text("uid");
			if (!uid) throw new BankSyncError("the sealed bank session is unreadable");
			return {
				uid,
				identificationHash: text("identificationHash"),
				name: text("name"),
				currency: text("currency"),
				iban: text("iban"),
				otherIdentification: text("otherIdentification"),
			};
		}),
		bank: fields.bank || "Bank",
		validUntil: fields.valid_until ?? null,
	};
}

/** A failure whose message is a fixed phrase, safe to record. */
class BankSyncError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BankSyncError";
	}
}

/** The account as the database knows it: a hash of the bank's own identity for it, the same in every session. */
export function bankAccountKey(account: EnableBankingAccount): string {
	const identity = account.identificationHash ?? account.iban ?? account.otherIdentification ?? account.uid;
	return createHash("sha256").update(`qorpera.bank-account/v1\n${identity}`).digest("hex");
}

/** A booked transaction's key: the bank's own reference when it gives one, else its content and how many
 * identical ones came before it in the same fetch (two equal payments on one day stay two). */
export function bankTransactionKeys(accountKey: string, transactions: readonly EnableBankingTransaction[]): string[] {
	const seen = new Map<string, number>();
	return transactions.map((transaction) => {
		const content = transaction.reference
			? `ref\n${transaction.reference}`
			: `content\n${transaction.date}\n${transaction.amount.toFixed(2)}\n${transaction.currency}\n${transaction.counterparty ?? ""}\n${transaction.text ?? ""}`;
		const index = seen.get(content) ?? 0;
		seen.set(content, index + 1);
		return createHash("sha256")
			.update(`qorpera.bank-transaction/v1\n${accountKey}\n${content}\n${index}`)
			.digest("hex");
	});
}

interface Fetched {
	readonly bank: string;
	readonly validUntil: string | null;
	readonly accounts: readonly {
		readonly key: string;
		readonly account: EnableBankingAccount;
		readonly balances: readonly EnableBankingBalance[];
		readonly transactions: readonly EnableBankingTransaction[];
	}[];
}

/** One company authority's bank sync. */
export class CloudBankSyncs {
	readonly #authority: BankSyncAuthority;
	readonly #keyring: Pick<CloudSecretKeyring, "use">;
	readonly #bank: Pick<EnableBankingClient, "balances" | "transactions">;
	readonly #now: () => Date;

	constructor(options: {
		authority: BankSyncAuthority;
		keyring: Pick<CloudSecretKeyring, "use">;
		bank: Pick<EnableBankingClient, "balances" | "transactions">;
		now?: () => Date;
	}) {
		this.#authority = options.authority;
		this.#keyring = options.keyring;
		this.#bank = options.bank;
		this.#now = options.now ?? (() => new Date());
	}

	/** Claims the company's sync if it is due, fetches, keeps, reduces and records. A sync claimed but not
	 * finished (the vault stopped) is offered again when its lease ends. */
	async pass(signal: AbortSignal): Promise<BankSyncOutcome> {
		const claim = parseClaim(
			await this.#authority.claimBankSync(AbortSignal.any([signal, AbortSignal.timeout(DATABASE_DEADLINE_MS)])),
		);
		if (!claim) return "idle";
		const finish = (
			outcome: "current" | "ended" | "failed",
			summary: BankSummaryFile | null,
			consentUntil: string | null,
			error: string | null,
		) =>
			// Recorded even when the pass is closing: the bank has been asked.
			this.#authority.finishBankSync(
				{
					secretId: claim.secretId,
					version: claim.version,
					outcome,
					summary,
					consentUntil,
					deep: claim.deep,
					error,
				},
				AbortSignal.timeout(DATABASE_DEADLINE_MS),
			);
		let fetched: Fetched;
		try {
			fetched = await this.#fetch(claim, AbortSignal.any([signal, AbortSignal.timeout(FETCH_DEADLINE_MS)]));
		} catch (error) {
			if (error instanceof EnableBankingSessionEnded) {
				await finish("ended", null, null, null);
				return "ended";
			}
			await finish("failed", null, null, failurePhrase(error));
			return "failed";
		}
		const consentUntil = fetched.validUntil && TIMESTAMP.test(fetched.validUntil) ? fetched.validUntil : null;
		try {
			const kept = parseKept(
				await this.#authority.recordBankTransactions(
					{
						secretId: claim.secretId,
						version: claim.version,
						accountKeys: fetched.accounts.map((account) => account.key),
						transactions: fetched.accounts.flatMap((account) => {
							const booked = account.transactions.filter((transaction) => transaction.status === "BOOK");
							const keys = bankTransactionKeys(account.key, booked);
							return booked.map((transaction, index) => ({
								accountKey: account.key,
								key: keys[index] as string,
								date: transaction.date,
								amount: transaction.amount,
								currency: transaction.currency,
								counterparty: transaction.counterparty,
								text: transaction.text,
							}));
						}),
					},
					AbortSignal.timeout(DATABASE_DEADLINE_MS),
				),
			);
			const payTo =
				fetched.accounts
					.filter((account) => (account.account.currency ?? "DKK") === "DKK")
					.map((account) => danishAccount(account.account.iban))
					.find((account) => account !== null) ?? null;
			const summary = reduceBankSummary({
				bank: fetched.bank,
				now: this.#now(),
				pausedSince: null,
				payTo,
				accounts: fetched.accounts.map((account) => ({
					balances: account.balances,
					// What the database keeps (booked, from every fetch so far) and what is still pending now.
					transactions: [
						...kept
							.filter((transaction) => transaction.accountKey === account.key)
							.map((transaction) => ({
								reference: null,
								amount: transaction.amount,
								currency: transaction.currency,
								status: "BOOK",
								date: transaction.date,
								counterparty: transaction.counterparty,
								text: transaction.text,
							})),
						...account.transactions.filter((transaction) => transaction.status !== "BOOK"),
					],
				})),
			});
			await finish("current", summary, consentUntil, null);
			return "current";
		} catch {
			await finish("failed", null, consentUntil, "the bank data could not be kept or summarized");
			return "failed";
		}
	}

	/** Opens the session only for the fetch; what comes back holds no secret. */
	async #fetch(claim: Claim, signal: AbortSignal): Promise<Fetched> {
		const envelope = Buffer.from(claim.encryptedEnvelopeBase64, "base64");
		try {
			if (createHash("sha256").update(envelope).digest("hex") !== claim.envelopeSha256)
				throw new BankSyncError("the envelope digest differs");
			// The keyring hides an error thrown inside it, so the outcome comes back as a value and is thrown here.
			const outcome = await this.#keyring.use(
				envelope,
				{
					companyId: claim.companyId,
					environmentId: claim.environmentId,
					secretId: claim.secretId,
					version: claim.version,
					keyId: claim.keyId,
				},
				async (fields): Promise<{ fetched: Fetched } | { error: unknown }> => {
					try {
						const session = parseSession(fields);
						const accounts = [];
						for (const account of session.accounts) {
							const balances = await this.#bank.balances(account.uid, signal);
							const { transactions } = await this.#bank.transactions(
								account.uid,
								claim.deep ? null : claim.since,
								signal,
							);
							accounts.push({ key: bankAccountKey(account), account, balances, transactions });
						}
						return { fetched: { bank: session.bank, validUntil: session.validUntil, accounts } };
					} catch (error) {
						return { error };
					}
				},
			);
			if ("error" in outcome) throw outcome.error;
			return outcome.fetched;
		} catch (error) {
			if (error instanceof BankSyncError || error instanceof EnableBankingSessionEnded) throw error;
			if (error instanceof ConnectorRequestError) throw error;
			throw new BankSyncError(signal.aborted ? "the bank fetch took too long" : "the envelope could not be opened");
		} finally {
			envelope.fill(0);
		}
	}
}

function failurePhrase(error: unknown): string {
	if (error instanceof BankSyncError) return error.message;
	if (error instanceof ConnectorRequestError) {
		if (error.reason === "rate_limited") return "the bank asked us to wait";
		if (error.reason === "forbidden" || error.reason === "authorization_required")
			return "Enable Banking refused the request";
		return "the bank or Enable Banking did not answer as expected";
	}
	return "the bank fetch failed";
}

/** A single-company vault's loop: one pass a minute (a single cheap claim); a sync is due only right after a connect and
 * then every six hours, so most passes find nothing. */
export class CloudBankSyncUpkeep {
	readonly #syncs: Pick<CloudBankSyncs, "pass">;
	readonly #passEveryMs: number;
	readonly #firstPassMs: number;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#running: Promise<void> | undefined;
	readonly #closing = new AbortController();
	#started = false;

	constructor(options: { syncs: Pick<CloudBankSyncs, "pass">; passEveryMs?: number; firstPassMs?: number }) {
		this.#syncs = options.syncs;
		this.#passEveryMs = options.passEveryMs ?? PASS_EVERY_MS;
		this.#firstPassMs = options.firstPassMs ?? 20_000 + Math.floor(Math.random() * 60_000);
	}

	start(): void {
		if (this.#started || this.#closing.signal.aborted) return;
		this.#started = true;
		const loop = (): void => {
			if (this.#closing.signal.aborted) return;
			this.#running = this.pass().finally(() => {
				this.#running = undefined;
				if (!this.#closing.signal.aborted) this.#timer = setTimeout(loop, this.#passEveryMs);
			});
		};
		this.#timer = setTimeout(loop, this.#firstPassMs);
	}

	async close(): Promise<void> {
		this.#closing.abort();
		clearTimeout(this.#timer);
		await this.#running;
	}

	async pass(): Promise<void> {
		await logBankSyncPass(this.#syncs, this.#closing.signal);
	}
}

/** Runs one pass and logs its outcome, never a bank, account or amount. */
export async function logBankSyncPass(syncs: Pick<CloudBankSyncs, "pass">, signal: AbortSignal): Promise<void> {
	try {
		const outcome = await syncs.pass(signal);
		if (outcome === "ended") console.error("Bank sync: a company's bank consent ended; it must connect again.");
		if (outcome === "failed") console.error("Bank sync: a fetch failed; it is tried again later.");
	} catch {
		console.error("Bank sync: a pass stopped on an error; the next pass tries again.");
	}
}
