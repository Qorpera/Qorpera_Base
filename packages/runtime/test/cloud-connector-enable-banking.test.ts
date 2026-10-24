import { createVerify, generateKeyPairSync } from "node:crypto";
import {
	ENABLE_BANKING_ORIGIN,
	EnableBankingClient,
	EnableBankingSessionEnded,
} from "@qorpera/runtime/cloud-connector-enable-banking";
import { ConnectorRequestError } from "@qorpera/runtime/cloud-connector-http";
import { describe, expect, it, vi } from "vitest";

/* The Enable Banking client (cloud-connector-enable-banking.ts): every call signed as the application, answers reduced
 * to the fields the broker needs, a consent that ended told apart from every other refusal. */

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const app = {
	applicationId: "8b1c7a52-1f3e-4f4a-9a0e-2d6b5c4e3f21",
	privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};
const now = new Date("2026-10-20T20:00:00Z");
const signal = new AbortController().signal;
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fake Enable Banking: each request must carry a valid application token. */
function enableBanking(route: (url: URL, init?: RequestInit) => Response) {
	return vi.fn<typeof fetch>(async (target, init) => {
		const url = new URL(String(target));
		expect(url.origin).toBe(ENABLE_BANKING_ORIGIN);
		expect(init?.redirect).toBe("error");
		const authorization = new Headers(init?.headers).get("authorization") ?? "";
		const [header, claims, signature] = authorization.replace(/^Bearer /, "").split(".");
		const verify = createVerify("RSA-SHA256");
		verify.update(`${header}.${claims}`);
		expect(verify.verify(publicKey, Buffer.from(signature ?? "", "base64url"))).toBe(true);
		expect(JSON.parse(Buffer.from(header ?? "", "base64url").toString())).toEqual({
			typ: "JWT",
			alg: "RS256",
			kid: app.applicationId,
		});
		const payload = JSON.parse(Buffer.from(claims ?? "", "base64url").toString());
		expect(payload).toMatchObject({ iss: "enablebanking.com", aud: "api.enablebanking.com" });
		expect(payload.exp - payload.iat).toBeLessThanOrEqual(86_400);
		expect(payload.iat).toBe(Math.floor(now.getTime() / 1000));
		return route(url, init);
	});
}

describe("the Enable Banking client", () => {
	it("refuses a key that isn't RSA", () => {
		const { privateKey: ec } = generateKeyPairSync("ec", { namedCurve: "P-256" });
		expect(
			() =>
				new EnableBankingClient(
					{ ...app, privateKeyPem: ec.export({ type: "pkcs8", format: "pem" }).toString() },
					fetch,
				),
		).toThrow("RSA");
	});

	it("lists the banks for business customers in a country", async () => {
		const fetchImpl = enableBanking((url) => {
			expect(url.pathname).toBe("/aspsps");
			expect(Object.fromEntries(url.searchParams)).toEqual({ country: "DK", psu_type: "business" });
			return json({
				aspsps: [
					{ name: "Danske Bank", country: "DK", maximum_consent_validity: 15_552_000, psu_types: ["business"] },
					{ name: "", country: "DK" },
				],
			});
		});
		const banks = await new EnableBankingClient(app, fetchImpl, () => now).banks("DK", "business", signal);
		expect(banks).toEqual([{ name: "Danske Bank", country: "DK", maximumConsentSeconds: 15_552_000 }]);
	});

	it("starts an authorization for balances and transactions, and gives the bank's address", async () => {
		const fetchImpl = enableBanking((url, init) => {
			expect(url.pathname).toBe("/auth");
			expect(init?.method).toBe("POST");
			expect(JSON.parse(String(init?.body))).toEqual({
				access: { valid_until: "2027-04-18T20:00:00.000Z", balances: true, transactions: true },
				aspsp: { name: "Danske Bank", country: "DK" },
				state: "company.state",
				redirect_url: "https://vault.example/v1/oauth/callback",
				psu_type: "business",
				language: "da",
			});
			return json({ url: "https://bank.example/consent?x=1", authorization_id: "a-1" });
		});
		const started = await new EnableBankingClient(app, fetchImpl, () => now).authorize(
			{
				bank: { name: "Danske Bank", country: "DK" },
				validUntil: new Date("2027-04-18T20:00:00Z"),
				state: "company.state",
				redirectUrl: "https://vault.example/v1/oauth/callback",
				psuType: "business",
				language: "da",
			},
			signal,
		);
		expect(started).toEqual({ url: "https://bank.example/consent?x=1", authorizationId: "a-1" });
		const plain = enableBanking(() => json({ url: "http://bank.example/consent" }));
		await expect(
			new EnableBankingClient(app, plain, () => now).authorize(
				{
					bank: { name: "Danske Bank", country: "DK" },
					validUntil: now,
					state: "s",
					redirectUrl: "https://vault.example/cb",
					psuType: "business",
				},
				signal,
			),
		).rejects.toBeInstanceOf(ConnectorRequestError);
	});

	it("makes a session from the bank's code, with the accounts the member shared", async () => {
		const fetchImpl = enableBanking((url, init) => {
			expect(url.pathname).toBe("/sessions");
			expect(JSON.parse(String(init?.body))).toEqual({ code: "code-1" });
			return json({
				session_id: "s-1",
				accounts: [
					{
						uid: "u-1",
						identification_hash: "h-1",
						name: "Erhvervskonto",
						currency: "DKK",
						account_id: { iban: "DK5000400440116243" },
					},
					{ name: "no uid" },
				],
				access: { valid_until: "2027-04-18T20:00:00+00:00" },
				aspsp: { name: "Danske Bank", country: "DK" },
			});
		});
		const session = await new EnableBankingClient(app, fetchImpl, () => now).createSession("code-1", signal);
		expect(session).toEqual({
			sessionId: "s-1",
			accounts: [
				{
					uid: "u-1",
					identificationHash: "h-1",
					name: "Erhvervskonto",
					currency: "DKK",
					iban: "DK5000400440116243",
					otherIdentification: null,
				},
			],
			validUntil: "2027-04-18T20:00:00+00:00",
			bank: "Danske Bank",
		});
	});

	it("reads balances and every page of transactions, money out negative", async () => {
		const pages: string[] = [];
		const fetchImpl = enableBanking((url) => {
			if (url.pathname.endsWith("/balances"))
				return json({
					balances: [
						{
							balance_type: "CLBD",
							balance_amount: { amount: "282730.50", currency: "DKK" },
							reference_date: "2026-10-20",
						},
						{ balance_type: "ITAV", balance_amount: { amount: "bad", currency: "DKK" } },
					],
				});
			pages.push(url.search);
			const key = url.searchParams.get("continuation_key");
			if (!key)
				return json({
					transactions: [
						{
							entry_reference: "r-1",
							transaction_amount: { amount: "8420.00", currency: "DKK" },
							credit_debit_indicator: "CRDT",
							status: "BOOK",
							booking_date: "2026-10-20",
							debtor: { name: "MobilePay" },
						},
					],
					continuation_key: "k-2",
				});
			return json({
				transactions: [
					{
						transaction_amount: { amount: "12300.00", currency: "DKK" },
						credit_debit_indicator: "DBIT",
						status: "BOOK",
						value_date: "2026-10-19",
						creditor: { name: "Bean supplier" },
						remittance_information: ["Invoice 1042", " "],
					},
					{ transaction_amount: { amount: "1.00", currency: "DKK" }, credit_debit_indicator: "XXXX" },
				],
				continuation_key: null,
			});
		});
		const client = new EnableBankingClient(app, fetchImpl, () => now);
		expect(await client.balances("u-1", signal)).toEqual([
			{ type: "CLBD", amount: 282730.5, currency: "DKK", referenceDate: "2026-10-20" },
		]);
		const fetched = await client.transactions("u-1", null, signal);
		expect(pages).toEqual(["?strategy=longest", "?strategy=longest&continuation_key=k-2"]);
		expect(fetched.complete).toBe(true);
		expect(fetched.transactions).toEqual([
			{
				reference: "r-1",
				amount: 8420,
				currency: "DKK",
				status: "BOOK",
				date: "2026-10-20",
				counterparty: "MobilePay",
				text: null,
			},
			{
				reference: null,
				amount: -12300,
				currency: "DKK",
				status: "BOOK",
				date: "2026-10-19",
				counterparty: "Bean supplier",
				text: "Invoice 1042",
			},
		]);
		await client.transactions("u-1", "2026-10-01", signal);
		expect(pages.slice(-2)).toEqual(["?date_from=2026-10-01", "?date_from=2026-10-01&continuation_key=k-2"]);
	});

	it("pages on to the bank's last page past any small count, and says when a page limit cut it short", async () => {
		// 300 pages of one transaction each.
		const pagedFetch = enableBanking((url) => {
			const page = Number(url.searchParams.get("continuation_key") ?? "0");
			return json({
				transactions: [
					{
						entry_reference: `r-${page}`,
						transaction_amount: { amount: "1.00", currency: "DKK" },
						credit_debit_indicator: "CRDT",
						status: "BOOK",
						booking_date: "2026-10-20",
					},
				],
				continuation_key: page < 299 ? String(page + 1) : null,
			});
		});
		const client = new EnableBankingClient(app, pagedFetch, () => now);
		const whole = await client.transactions("u-1", null, signal, 1000);
		expect(whole.complete).toBe(true);
		expect(whole.transactions).toHaveLength(300);
		const cut = await client.transactions("u-1", null, signal, 250);
		expect(cut.complete).toBe(false);
		expect(cut.transactions).toHaveLength(250);
	});

	it("tells a consent that ended from a rate limit and other refusals", async () => {
		const answer = (body: unknown, status: number) =>
			new EnableBankingClient(
				app,
				enableBanking(() => json(body, status)),
				() => now,
			).balances("u-1", signal);
		await expect(answer({ error: "EXPIRED_SESSION", message: "Session expired" }, 401)).rejects.toBeInstanceOf(
			EnableBankingSessionEnded,
		);
		await expect(answer({ error: "REVOKED_SESSION" }, 401)).rejects.toMatchObject({ code: "REVOKED_SESSION" });
		await expect(answer({ error: "ASPSP_RATE_LIMIT_EXCEEDED" }, 429)).rejects.toMatchObject({
			reason: "rate_limited",
		});
		await expect(answer({ error: "WRONG_REQUEST_PARAMETERS" }, 422)).rejects.toMatchObject({
			reason: "invalid_request",
		});
		await expect(answer("oops", 500)).rejects.toMatchObject({ reason: "provider_error" });
	});

	it("closes a session, and a session already gone counts as closed", async () => {
		const closed = enableBanking((url, init) => {
			expect(init?.method).toBe("DELETE");
			expect(url.pathname).toBe("/sessions/s-1");
			return json({}, 200);
		});
		await new EnableBankingClient(app, closed, () => now).closeSession("s-1", signal);
		const gone = enableBanking(() => json({ error: "CLOSED_SESSION" }, 400));
		await expect(new EnableBankingClient(app, gone, () => now).closeSession("s-1", signal)).resolves.toBeUndefined();
	});
});
