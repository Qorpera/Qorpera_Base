import { createHash, createHmac, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CloudEventVerifications,
	CloudEventVerificationUpkeep,
	checkEventSignature,
	type EventVerificationAuthority,
} from "../src/cloud-event-verification.ts";
import { CloudSecretKeyring, sealCloudSecretFields } from "../src/cloud-secret-crypto.ts";

const SECRET = "whsec_test-signing-secret-canary";
const NOW = 1_790_000_000;
const mac = (...parts: Array<string | Uint8Array>) => {
	const h = createHmac("sha256", Buffer.from(SECRET, "utf8"));
	for (const part of parts) h.update(part);
	return h.digest("hex");
};
const body = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8");

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Stripe signatures", () => {
	const event = body({ id: "evt_1Q2w3E4r5T", type: "invoice.paid", data: { object: { amount_paid: 4900 } } });
	const header = (t: number, ...signatures: string[]) =>
		[`t=${t}`, ...signatures.map((signature) => `v1=${signature}`), "v0=ignored"].join(",");

	it("verifies the event and keys it by its id and type", () => {
		const signed = header(NOW - 20, mac(`${NOW - 20}.`, event));
		expect(
			checkEventSignature({
				proof: "stripe",
				headers: { "stripe-signature": signed },
				body: event,
				secret: SECRET,
				receivedAt: NOW,
			}),
		).toEqual({ ok: true, key: "evt_1Q2w3E4r5T", type: "invoice.paid" });
	});

	it("accepts any one of several v1 signatures, as after a secret roll", () => {
		const signed = header(NOW, "0".repeat(64), mac(`${NOW}.`, event));
		expect(
			checkEventSignature({
				proof: "stripe",
				headers: { "stripe-signature": signed },
				body: event,
				secret: SECRET,
				receivedAt: NOW,
			}).ok,
		).toBe(true);
	});

	it("measures the five minutes against the arrival, not the check", () => {
		const t = NOW - 299;
		const signed = header(t, mac(`${t}.`, event));
		// Checked an hour later, it is still fresh against its arrival.
		expect(
			checkEventSignature({
				proof: "stripe",
				headers: { "stripe-signature": signed },
				body: event,
				secret: SECRET,
				receivedAt: NOW,
			}).ok,
		).toBe(true);
		for (const t of [NOW - 301, NOW + 301])
			expect(
				checkEventSignature({
					proof: "stripe",
					headers: { "stripe-signature": header(t, mac(`${t}.`, event)) },
					body: event,
					secret: SECRET,
					receivedAt: NOW,
				}),
			).toEqual({
				ok: false,
				reason: "The Stripe signature is outside the five minutes allowed",
			});
	});

	it("refuses a wrong signature, a changed body, a malformed header and an event without an id", () => {
		const cases: Array<[Record<string, string>, Uint8Array, string]> = [
			[
				{ "stripe-signature": header(NOW, mac(`${NOW}.`, event)) },
				body({ id: "evt_other" }),
				"The Stripe signature does not match",
			],
			[{ "stripe-signature": header(NOW, "f".repeat(64)) }, event, "The Stripe signature does not match"],
			[{ "stripe-signature": `v1=${mac(`${NOW}.`, event)}` }, event, "The Stripe-Signature header is malformed"],
			[{ "stripe-signature": `t=${NOW}` }, event, "The Stripe-Signature header is malformed"],
			[
				{ "stripe-signature": `t=soon,v1=${mac(`${NOW}.`, event)}` },
				event,
				"The Stripe-Signature header is malformed",
			],
			[{}, event, "The Stripe-Signature header is missing"],
		];
		for (const [headers, payload, reason] of cases)
			expect(
				checkEventSignature({ proof: "stripe", headers, body: payload, secret: SECRET, receivedAt: NOW }),
			).toEqual({ ok: false, reason });
		const noId = body({ type: "invoice.paid" });
		expect(
			checkEventSignature({
				proof: "stripe",
				headers: { "stripe-signature": header(NOW, mac(`${NOW}.`, noId)) },
				body: noId,
				secret: SECRET,
				receivedAt: NOW,
			}),
		).toEqual({ ok: false, reason: "The Stripe event has no id" });
	});

	it("refuses with an empty or another secret", () => {
		const signed = { "stripe-signature": header(NOW, mac(`${NOW}.`, event)) };
		expect(
			checkEventSignature({ proof: "stripe", headers: signed, body: event, secret: "", receivedAt: NOW }),
		).toEqual({
			ok: false,
			reason: "The hook's signing secret is empty",
		});
		expect(
			checkEventSignature({ proof: "stripe", headers: signed, body: event, secret: "whsec_other", receivedAt: NOW })
				.ok,
		).toBe(false);
	});
});

describe("GitHub signatures", () => {
	const pr = body({ action: "opened", number: 612 });

	it("verifies the body and types the event with its action", () => {
		expect(
			checkEventSignature({
				proof: "github",
				headers: {
					"x-hub-signature-256": `sha256=${mac(pr)}`,
					"x-github-event": "pull_request",
					"x-github-delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
				},
				body: pr,
				secret: SECRET,
				receivedAt: NOW,
			}),
		).toEqual({ ok: true, key: "72d3162e-cc78-11e3-81ab-4c9367dc0958", type: "pull_request.opened" });
	});

	it("types an event without an action by its name, and keys a delivery without an id by its signature", () => {
		const push = body({ ref: "refs/heads/master" });
		const signature = mac(push);
		expect(
			checkEventSignature({
				proof: "github",
				headers: { "x-hub-signature-256": `sha256=${signature}`, "x-github-event": "push" },
				body: push,
				secret: SECRET,
				receivedAt: NOW,
			}),
		).toEqual({ ok: true, key: `sig:${signature}`, type: "push" });
	});

	it("refuses a wrong or missing signature", () => {
		expect(
			checkEventSignature({
				proof: "github",
				headers: { "x-hub-signature-256": `sha256=${"a".repeat(64)}` },
				body: pr,
				secret: SECRET,
				receivedAt: NOW,
			}),
		).toEqual({
			ok: false,
			reason: "The GitHub signature does not match",
		});
		expect(
			checkEventSignature({
				proof: "github",
				headers: { "x-hub-signature-256": mac(pr) },
				body: pr,
				secret: SECRET,
				receivedAt: NOW,
			}),
		).toEqual({
			ok: false,
			reason: "The X-Hub-Signature-256 header is malformed",
		});
		expect(checkEventSignature({ proof: "github", headers: {}, body: pr, secret: SECRET, receivedAt: NOW }).ok).toBe(
			false,
		);
	});
});

describe("HMAC-SHA256 signatures", () => {
	const payload = body({ order: 1042 });
	const signed = (t: number, extra: Record<string, string> = {}) => ({
		"x-qorpera-timestamp": String(t),
		"x-qorpera-signature": `v1=${mac(`${t}.`, payload)}`,
		...extra,
	});

	it("keys a delivery by its delivery id, then its idempotency key, then its signature", () => {
		expect(
			checkEventSignature({
				proof: "hmac-sha256",
				headers: signed(NOW, { "x-qorpera-delivery": "order-1042", "x-qorpera-event": "order.paid" }),
				body: payload,
				secret: SECRET,
				receivedAt: NOW,
			}),
		).toEqual({ ok: true, key: "order-1042", type: "order.paid" });
		expect(
			checkEventSignature({
				proof: "hmac-sha256",
				headers: signed(NOW, { "idempotency-key": "idem-7" }),
				body: payload,
				secret: SECRET,
				receivedAt: NOW,
			}),
		).toEqual({ ok: true, key: "idem-7", type: null });
		expect(
			checkEventSignature({
				proof: "hmac-sha256",
				headers: signed(NOW),
				body: payload,
				secret: SECRET,
				receivedAt: NOW,
			}),
		).toEqual({
			ok: true,
			key: `sig:${mac(`${NOW}.`, payload)}`,
			type: null,
		});
	});

	it("never takes a sender id the database reserves or cannot keep", () => {
		for (const id of ["body:abc", "has space", "x".repeat(257)])
			expect(
				(
					checkEventSignature({
						proof: "hmac-sha256",
						headers: signed(NOW, { "x-qorpera-delivery": id }),
						body: payload,
						secret: SECRET,
						receivedAt: NOW,
					}) as { key: string }
				).key,
			).toBe(`sig:${mac(`${NOW}.`, payload)}`);
	});

	it("refuses a stale, wrong or unsigned delivery", () => {
		expect(
			checkEventSignature({
				proof: "hmac-sha256",
				headers: signed(NOW - 600),
				body: payload,
				secret: SECRET,
				receivedAt: NOW,
			}),
		).toEqual({
			ok: false,
			reason: "The signature is outside the five minutes allowed",
		});
		expect(
			checkEventSignature({
				proof: "hmac-sha256",
				headers: { ...signed(NOW), "x-qorpera-signature": `v1=${"b".repeat(64)}` },
				body: payload,
				secret: SECRET,
				receivedAt: NOW,
			}),
		).toEqual({ ok: false, reason: "The signature does not match" });
		expect(
			checkEventSignature({
				proof: "hmac-sha256",
				headers: { "x-qorpera-signature": "v1=00" },
				body: payload,
				secret: SECRET,
				receivedAt: NOW,
			}).ok,
		).toBe(false);
	});
});

describe("the broker's pass", () => {
	const wrappingKey = randomBytes(32);
	const keyring = new CloudSecretKeyring({ "company-kek-1": wrappingKey });
	const identity = {
		companyId: "78400000-0000-4000-8000-000000000010",
		environmentId: "78400000-0000-4000-8000-000000000020",
		secretId: "78400000-0000-4000-8000-0000000000a1",
		version: 2,
		keyId: "company-kek-1",
	};
	const envelope = Buffer.from(sealCloudSecretFields({ signing_secret: SECRET }, wrappingKey, identity));
	const pr = body({ action: "opened" });
	const claim = (n: number, signature: string, extra: Record<string, unknown> = {}) => ({
		schema: "qorpera.event-verification/v1",
		deliveryId: `78400000-0000-4000-8000-00000000000${n}`,
		claim: "78400000-0000-4000-8000-0000000000c1",
		companyId: identity.companyId,
		environmentId: identity.environmentId,
		hookId: "78400000-0000-4000-8000-0000000000b1",
		proof: "github",
		receivedAt: NOW,
		headers: {
			"x-hub-signature-256": `sha256=${signature}`,
			"x-github-event": "pull_request",
			"x-github-delivery": `delivery-${n}`,
		},
		bodyBase64: pr.toString("base64"),
		secretId: identity.secretId,
		secretVersion: identity.version,
		keyId: identity.keyId,
		encryptedEnvelopeBase64: envelope.toString("base64"),
		envelopeSha256: createHash("sha256").update(envelope).digest("hex"),
		...extra,
	});
	function authority(claims: unknown[][]) {
		const finished: Array<Parameters<EventVerificationAuthority["finishEventVerification"]>[0]> = [];
		const value: EventVerificationAuthority = {
			claimEventVerifications: vi.fn(async () => claims.shift() ?? []),
			finishEventVerification: vi.fn(async (answer) => {
				finished.push(answer);
				return { outcome: answer.verdict };
			}),
		};
		return { value, finished };
	}

	it("opens the secret, checks each signature and answers each claim once", async () => {
		const a = authority([
			[claim(1, mac(pr)), claim(2, "c".repeat(64)), claim(3, mac(pr), { envelopeSha256: "0".repeat(64) })],
			[],
		]);
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const counts = await new CloudEventVerifications({ authority: a.value, keyring }).pass(
			new AbortController().signal,
		);
		expect(counts).toEqual({ verified: 1, refused: 1, retried: 1 });
		expect(a.finished).toEqual([
			{
				deliveryId: "78400000-0000-4000-8000-000000000001",
				claim: "78400000-0000-4000-8000-0000000000c1",
				verdict: "verified",
				key: "delivery-1",
				type: "pull_request.opened",
				reason: null,
			},
			{
				deliveryId: "78400000-0000-4000-8000-000000000002",
				claim: "78400000-0000-4000-8000-0000000000c1",
				verdict: "refused",
				key: null,
				type: null,
				reason: "The GitHub signature does not match",
			},
			{
				deliveryId: "78400000-0000-4000-8000-000000000003",
				claim: "78400000-0000-4000-8000-0000000000c1",
				verdict: "retry",
				key: null,
				type: null,
				reason: null,
			},
		]);
		// Two claims: the second came back empty.
		expect(a.value.claimEventVerifications).toHaveBeenCalledTimes(2);
		// The secret is in no answer and no log.
		expect(JSON.stringify(a.finished)).not.toContain(SECRET);
		expect(JSON.stringify(errors.mock.calls)).not.toContain(SECRET);
	});

	it("offers a delivery again when this vault cannot open its secret", async () => {
		const a = authority([[claim(4, mac(pr), { keyId: "other-kek" })]]);
		await new CloudEventVerifications({ authority: a.value, keyring }).pass(new AbortController().signal);
		expect(a.finished.map((answer) => answer.verdict)).toEqual(["retry"]);
	});

	it("refuses a claim of more deliveries than it asked for", async () => {
		const a = authority([Array.from({ length: 17 }, () => claim(6, mac(pr)))]);
		await expect(
			new CloudEventVerifications({ authority: a.value, keyring }).pass(new AbortController().signal),
		).rejects.toThrow("Event verification claim is invalid");
		expect(a.finished).toEqual([]);
	});

	it("refuses a claim it cannot read without answering any of it", async () => {
		for (const bad of [
			{ schema: "other" },
			{ proof: "address" },
			{ secretVersion: 0 },
			{ headers: { a: 1 } },
			{ unexpected: true },
		]) {
			const a = authority([[claim(5, mac(pr), bad)]]);
			await expect(
				new CloudEventVerifications({ authority: a.value, keyring }).pass(new AbortController().signal),
			).rejects.toThrow("Event verification claim is invalid");
			expect(a.finished).toEqual([]);
		}
	});

	it("runs a pass on its timer and stops cleanly", async () => {
		vi.useFakeTimers();
		try {
			const pass = vi.fn(async () => ({ verified: 0, refused: 0, retried: 0 }));
			const upkeep = new CloudEventVerificationUpkeep({
				verifications: { pass },
				passEveryMs: 5000,
				firstPassMs: 10,
			});
			upkeep.start();
			await vi.advanceTimersByTimeAsync(10);
			await vi.advanceTimersByTimeAsync(5000);
			expect(pass).toHaveBeenCalledTimes(2);
			await upkeep.close();
			await vi.advanceTimersByTimeAsync(20_000);
			expect(pass).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});
});
