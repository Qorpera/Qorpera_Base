import { createHash, randomUUID } from "node:crypto";
import {
	type BankSyncAuthority,
	bankAccountKey,
	bankTransactionKeys,
	CloudBankSyncs,
	type KeptBankTransaction,
} from "@qorpera/runtime/cloud-bank-sync";
import {
	type EnableBankingBalance,
	EnableBankingSessionEnded,
	type EnableBankingTransaction,
} from "@qorpera/runtime/cloud-connector-enable-banking";
import { ConnectorRequestError } from "@qorpera/runtime/cloud-connector-http";
import { expect, it, vi } from "vitest";

/** The vault's bank sync (cloud-bank-sync.ts): claim, open the sealed session, fetch, keep, reduce, record. */

const NOW = new Date("2026-10-21T12:00:00.000Z");
const signal = new AbortController().signal;
const envelope = Buffer.from("sealed envelope bytes");

const account = {
	uid: "uid-1",
	identificationHash: "hash-1",
	name: "Erhvervskonto",
	currency: "DKK",
	iban: "DK5000400440116243",
	otherIdentification: null,
};

function claim(overrides: Record<string, unknown> = {}) {
	return {
		schema: "qorpera.bank-sync-claim/v1",
		companyId: randomUUID(),
		environmentId: randomUUID(),
		secretId: randomUUID(),
		secretVersion: 1,
		keyId: "k1",
		encryptedEnvelopeBase64: envelope.toString("base64"),
		envelopeSha256: createHash("sha256").update(envelope).digest("hex"),
		deep: true,
		since: null,
		...overrides,
	};
}

const booked = (date: string, amount: number, counterparty: string, reference: string | null = null) =>
	({ reference, amount, currency: "DKK", status: "BOOK", date, counterparty, text: null }) as EnableBankingTransaction;

function fixture(options: {
	claim?: unknown;
	balances?: EnableBankingBalance[];
	transactions?: EnableBankingTransaction[];
	bankError?: Error;
	fields?: Record<string, string>;
	kept?: (sent: readonly KeptBankTransaction[]) => unknown[];
}) {
	const finished: Parameters<BankSyncAuthority["finishBankSync"]>[0][] = [];
	const recorded: Parameters<BankSyncAuthority["recordBankTransactions"]>[0][] = [];
	const authority: BankSyncAuthority = {
		claimBankSync: vi.fn(async () => (options.claim === undefined ? claim() : options.claim)),
		recordBankTransactions: vi.fn(async (input: Parameters<BankSyncAuthority["recordBankTransactions"]>[0]) => {
			recorded.push(input);
			const kept = options.kept
				? options.kept(input.transactions)
				: input.transactions.map(({ key: _key, ...rest }) => rest);
			return { schema: "qorpera.bank-transactions-kept/v1", transactions: kept };
		}),
		finishBankSync: vi.fn(async (input) => {
			finished.push(input);
			return { schema: "qorpera.bank-sync-result/v1" };
		}),
	};
	const opened: unknown[] = [];
	const keyring = {
		use: vi.fn(
			async (
				bytes: Uint8Array,
				identity: unknown,
				callback: (fields: Record<string, string>) => Promise<unknown>,
			) => {
				opened.push({ bytes: Buffer.from(bytes).toString(), identity });
				return callback(
					options.fields ?? {
						session_id: "session-7f3e",
						accounts: JSON.stringify([account]),
						bank: "Danske Bank",
						valid_until: "2027-01-19T11:59:00.000000+00:00",
					},
				);
			},
		),
	};
	const bank = {
		balances: vi.fn(async () => {
			if (options.bankError) throw options.bankError;
			return options.balances ?? [{ type: "CLBD", amount: 1000, currency: "DKK", referenceDate: "2026-10-20" }];
		}),
		transactions: vi.fn(async () => ({
			transactions: options.transactions ?? [
				booked("2026-10-01", 500, "Wolt"),
				booked("2026-10-05", -99, "Figma", "ref-figma"),
				{ ...booked("2026-10-21", -20, "Café"), status: "PDNG" },
			],
			complete: true,
		})),
	};
	const syncs = new CloudBankSyncs({
		authority,
		keyring: keyring as never,
		bank,
		now: () => NOW,
	});
	return { syncs, authority, keyring, bank, finished, recorded, opened };
}

it("does nothing when no sync is due", async () => {
	const f = fixture({ claim: null });
	expect(await f.syncs.pass(signal)).toBe("idle");
	expect(f.keyring.use).not.toHaveBeenCalled();
	expect(f.finished).toEqual([]);
});

it("fetches each shared account deep after a connect, keeps the booked transactions and records the summary", async () => {
	const f = fixture({});
	expect(await f.syncs.pass(signal)).toBe("current");
	// The deep fetch asks for the longest history (no start day).
	expect(f.bank.balances).toHaveBeenCalledWith("uid-1", expect.anything());
	expect(f.bank.transactions).toHaveBeenCalledWith("uid-1", null, expect.anything());
	// Only booked transactions are kept, each under the account's hash and its own key.
	const accountKey = bankAccountKey(account);
	expect(f.recorded[0]?.accountKeys).toEqual([accountKey]);
	expect(f.recorded[0]?.transactions.map((transaction) => transaction.amount)).toEqual([500, -99]);
	expect(f.recorded[0]?.transactions.every((transaction) => /^[0-9a-f]{64}$/.test(transaction.key))).toBe(true);
	expect(JSON.stringify(f.recorded)).not.toContain("DK5000400440116243");
	expect(JSON.stringify(f.recorded)).not.toContain("session-7f3e");
	const done = f.finished[0];
	expect(done).toMatchObject({
		outcome: "current",
		deep: true,
		consentUntil: "2027-01-19T11:59:00.000000+00:00",
		error: null,
	});
	expect(done?.summary?.schema).toBe("qorpera.bank-summary/v1");
	expect(done?.summary?.bank).toBe("Danske Bank");
	expect(done?.summary?.saldo).toBe(1000);
	expect(done?.summary?.payTo).toEqual({ reg: "0040", account: "0440116243" });
	expect(done?.summary?.pausedSince).toBeNull();
});

it("after the deep fetch, fetches from the day the database names and summarizes what it kept before", async () => {
	const older = {
		accountKey: bankAccountKey(account),
		date: "2026-06-01",
		amount: 12_000,
		currency: "DKK",
		counterparty: "Kunde A/S",
		text: null,
	};
	const f = fixture({
		claim: claim({ deep: false, since: "2026-10-07" }),
		kept: (sent) => [older, ...sent.map(({ key: _key, ...rest }) => rest)],
	});
	expect(await f.syncs.pass(signal)).toBe("current");
	expect(f.bank.transactions).toHaveBeenCalledWith("uid-1", "2026-10-07", expect.anything());
	const summary = f.finished[0]?.summary;
	expect(f.finished[0]?.deep).toBe(false);
	// June's payment, kept from an earlier fetch, is in the year's months.
	expect(summary?.months.find((month) => month.month === "2026-06")?.in).toBe(12_000);
});

it("reports an ended consent so the member is asked to connect again", async () => {
	const f = fixture({ bankError: new EnableBankingSessionEnded("EXPIRED_SESSION") });
	expect(await f.syncs.pass(signal)).toBe("ended");
	expect(f.finished[0]).toMatchObject({ outcome: "ended", summary: null, error: null });
	expect(f.recorded).toEqual([]);
});

it("records a failed fetch by a fixed phrase, never the provider's words", async () => {
	const f = fixture({ bankError: new ConnectorRequestError("rate_limited", "Enable Banking: secret detail 4821") });
	expect(await f.syncs.pass(signal)).toBe("failed");
	expect(f.finished[0]).toMatchObject({ outcome: "failed", summary: null, error: "the bank asked us to wait" });
	const unreadable = fixture({ fields: { session_id: "s" } });
	expect(await unreadable.syncs.pass(signal)).toBe("failed");
	expect(unreadable.finished[0]?.error).toBe("the sealed bank session is unreadable");
	expect(unreadable.bank.balances).not.toHaveBeenCalled();
});

it("refuses an envelope whose digest differs, before opening it", async () => {
	const f = fixture({ claim: claim({ envelopeSha256: "0".repeat(64) }) });
	expect(await f.syncs.pass(signal)).toBe("failed");
	expect(f.keyring.use).not.toHaveBeenCalled();
	expect(f.finished[0]?.error).toBe("the envelope digest differs");
});

it("refuses a malformed claim without fetching or finishing", async () => {
	const f = fixture({ claim: { ...claim(), extra: 1 } });
	await expect(f.syncs.pass(signal)).rejects.toThrow("claim is invalid");
	expect(f.finished).toEqual([]);
});

it("keys an account by the bank's own identity, the same in every session, and two equal payments as two", () => {
	expect(bankAccountKey(account)).toBe(bankAccountKey({ ...account, uid: "uid-from-a-new-session" }));
	expect(bankAccountKey(account)).not.toBe(bankAccountKey({ ...account, identificationHash: "hash-2" }));
	const coffee = booked("2026-10-10", -35, "Café");
	const keys = bankTransactionKeys("a".repeat(64), [coffee, coffee, booked("2026-10-10", -35, "Café", "ref-1")]);
	expect(new Set(keys).size).toBe(3);
	// The same fetch again gives the same keys: nothing is kept twice.
	expect(bankTransactionKeys("a".repeat(64), [coffee, coffee])).toEqual(keys.slice(0, 2));
});
