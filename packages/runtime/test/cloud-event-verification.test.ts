import { createHash, createHmac, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CloudEventVerifications,
	CloudEventVerificationUpkeep,
	checkEventSignature,
	type EventVerificationAuthority,
	logEventVerificationPass,
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

	it("verifies GitHub's documented example", () => {
		// docs.github.com, "Validating webhook deliveries": the secret, the body and the signature it gives.
		expect(
			checkEventSignature({
				proof: "github",
				headers: {
					"x-hub-signature-256": "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
				},
				body: Buffer.from("Hello, World!", "utf8"),
				secret: "It's a Secret to Everybody",
				receivedAt: NOW,
			}),
		).toEqual({ ok: true, key: "sig:757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17", type: null });
	});

	it("keys a delivery by its signature, since GitHub signs neither its delivery id nor its event name", () => {
		const signed = (delivery: string, event: string) =>
			checkEventSignature({
				proof: "github",
				headers: {
					"x-hub-signature-256": `sha256=${mac(pr)}`,
					"x-github-event": event,
					"x-github-delivery": delivery,
				},
				body: pr,
				secret: SECRET,
				receivedAt: NOW,
			});
		expect(signed("72d3162e-cc78-11e3-81ab-4c9367dc0958", "pull_request")).toEqual({
			ok: true,
			key: `sig:${mac(pr)}`,
			type: "pull_request.opened",
		});
		// A replay under another delivery id and event name has the same key, so it is a duplicate.
		expect((signed("forged-2", "issues") as { key: string }).key).toBe(`sig:${mac(pr)}`);
	});

	it("types an event without an action by its name", () => {
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

describe("Standard Webhooks signatures (hmac-sha256)", () => {
	// The specification's own example (standardwebhooks.com): secret, id, timestamp, body and signature.
	const SPEC_SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
	const SPEC_BODY = Buffer.from('{"test": 2432232314}', "utf8");
	const SPEC_SIGNATURE = "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=";
	const key = Buffer.from("MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", "base64");
	const sign = (id: string, t: number, payload: Uint8Array) =>
		`v1,${createHmac("sha256", key).update(`${id}.${t}.`).update(payload).digest("base64")}`;
	const payload = body({ type: "order.paid", data: { order: 1042 } });
	const headers = (id: string, t: number, extra: Record<string, string> = {}) => ({
		"webhook-id": id,
		"webhook-timestamp": String(t),
		"webhook-signature": sign(id, t, payload),
		...extra,
	});
	const check = (h: Record<string, string>, secret = SPEC_SECRET, receivedAt = NOW, data: Uint8Array = payload) =>
		checkEventSignature({ proof: "hmac-sha256", headers: h, body: data, secret, receivedAt });

	it("verifies the specification's example, keyed by its signed id", () => {
		expect(
			check(
				{
					"webhook-id": "msg_p5jXN8AQM9LWM0D4loKWxJek",
					"webhook-timestamp": "1614265330",
					"webhook-signature": SPEC_SIGNATURE,
				},
				SPEC_SECRET,
				1614265330,
				SPEC_BODY,
			),
		).toEqual({ ok: true, key: "msg_p5jXN8AQM9LWM0D4loKWxJek", type: null });
	});

	it("takes the type from the signed body, Svix's header names, and any one of several signatures", () => {
		expect(check(headers("msg_1", NOW))).toEqual({ ok: true, key: "msg_1", type: "order.paid" });
		expect(
			check({
				"svix-id": "msg_2",
				"svix-timestamp": String(NOW),
				"svix-signature": `v1,${"A".repeat(43)}= ${sign("msg_2", NOW, payload)}`,
			}),
		).toEqual({ ok: true, key: "msg_2", type: "order.paid" });
		// The secret without its whsec_ prefix is the same key.
		expect(check(headers("msg_3", NOW), "MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw").ok).toBe(true);
	});

	it("refuses a replay under another id, and keys an id the database cannot keep by the signature", () => {
		const replay = { ...headers("msg_1", NOW), "webhook-id": "msg_2" };
		expect(check(replay)).toEqual({ ok: false, reason: "The signature does not match" });
		for (const odd of ["has space", "body:abc", "x".repeat(257)])
			expect(check(headers(odd, NOW))).toEqual({
				ok: true,
				key: `sig:${Buffer.from(sign(odd, NOW, payload).slice(3), "base64").toString("hex")}`,
				type: "order.paid",
			});
	});

	it("refuses a stale, wrong, unsigned or malformed delivery, and a secret that is not a Standard Webhooks one", () => {
		for (const t of [NOW - 301, NOW + 301])
			expect(check(headers("msg_1", t))).toEqual({
				ok: false,
				reason: "The signature is outside the five minutes allowed",
			});
		expect(check(headers("msg_1", NOW), "whsec_c2Vjb25kLWtleS1vZi10aGUtaG9vaw==")).toEqual({
			ok: false,
			reason: "The signature does not match",
		});
		expect(check({ "webhook-id": "msg_1", "webhook-timestamp": String(NOW) })).toEqual({
			ok: false,
			reason: "The webhook-id, webhook-timestamp or webhook-signature header is missing",
		});
		expect(check({ ...headers("msg_1", NOW), "webhook-signature": "v1a,abc" })).toEqual({
			ok: false,
			reason: "The webhook-signature header is malformed",
		});
		expect(check(headers("msg_1", NOW), "not a whsec secret!")).toEqual({
			ok: false,
			reason: "The hook's signing secret is not a Standard Webhooks secret",
		});
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
	const batch = (deliveries: unknown[], refused = 0) => ({
		schema: "qorpera.event-verification-claim/v1",
		deliveries,
		refused,
	});
	function authority(claims: unknown[], finish?: (answer: { deliveryId: string; verdict: string }) => unknown) {
		const finished: Array<Parameters<EventVerificationAuthority["finishEventVerification"]>[0]> = [];
		const value: EventVerificationAuthority = {
			claimEventVerifications: vi.fn(async () => claims.shift() ?? batch([])),
			finishEventVerification: vi.fn(async (answer) => {
				finished.push(answer);
				return finish ? finish(answer) : { outcome: answer.verdict };
			}),
		};
		return { value, finished };
	}
	const none = { verified: 0, duplicate: 0, refused: 0, retried: 0, stale: 0, failed: 0 };

	it("opens the secret, checks each signature and answers each claim once", async () => {
		const a = authority([
			batch([claim(1, mac(pr)), claim(2, "c".repeat(64)), claim(3, mac(pr), { envelopeSha256: "0".repeat(64) })]),
			batch([]),
		]);
		const counts = await new CloudEventVerifications({ authority: a.value, keyring }).pass(
			new AbortController().signal,
		);
		expect(counts).toEqual({ ...none, verified: 1, refused: 1, retried: 1 });
		expect(a.finished).toEqual([
			{
				deliveryId: "78400000-0000-4000-8000-000000000001",
				claim: "78400000-0000-4000-8000-0000000000c1",
				verdict: "verified",
				key: `sig:${mac(pr)}`,
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
		// The secret is in no answer.
		expect(JSON.stringify(a.finished)).not.toContain(SECRET);
	});

	it("counts what the database recorded, not what it was asked", async () => {
		const outcomes = ["duplicate", "stale", "surprise"];
		const a = authority([batch([claim(1, mac(pr)), claim(2, mac(pr)), claim(3, mac(pr))])], () => ({
			outcome: outcomes.shift(),
		}));
		const counts = await new CloudEventVerifications({ authority: a.value, keyring }).pass(
			new AbortController().signal,
		);
		expect(counts).toEqual({ ...none, duplicate: 1, stale: 1, failed: 1 });
	});

	it("offers a delivery again when this vault cannot open its secret", async () => {
		const a = authority([batch([claim(4, mac(pr), { keyId: "other-kek" })])]);
		await new CloudEventVerifications({ authority: a.value, keyring }).pass(new AbortController().signal);
		expect(a.finished.map((answer) => answer.verdict)).toEqual(["retry"]);
	});

	it("answers an item it cannot read with retry, and still checks the rest of the claim", async () => {
		const bad = [
			{ schema: "other" },
			{ proof: "address" },
			{ secretVersion: 0 },
			{ headers: { a: 1 } },
			{ unexpected: true },
		].map((extra, i) => claim(i + 1, mac(pr), extra));
		// An item without its own ids cannot be answered; its claim ends by itself.
		const a = authority([batch([...bad, { deliveryId: "nope" }, claim(9, mac(pr))])]);
		const counts = await new CloudEventVerifications({ authority: a.value, keyring }).pass(
			new AbortController().signal,
		);
		expect(a.finished.map((answer) => [answer.deliveryId.slice(-1), answer.verdict])).toEqual([
			["1", "retry"],
			["2", "retry"],
			["3", "retry"],
			["4", "retry"],
			["5", "retry"],
			["9", "verified"],
		]);
		expect(counts).toEqual({ ...none, verified: 1, retried: 5 });
	});

	it("refuses a claim it cannot read as a whole, or of more deliveries than it asked for", async () => {
		for (const answer of [
			batch(Array.from({ length: 17 }, () => claim(6, mac(pr)))),
			{ ...batch([claim(6, mac(pr))]), schema: "other" },
			{ ...batch([claim(6, mac(pr))]), refused: -1 },
			{ ...batch([claim(6, mac(pr))]), more: true },
			[claim(6, mac(pr))],
		]) {
			const a = authority([answer]);
			await expect(
				new CloudEventVerifications({ authority: a.value, keyring }).pass(new AbortController().signal),
			).rejects.toThrow("Event verification claim is invalid");
			expect(a.finished).toEqual([]);
		}
	});

	it("carries on past a verdict it could not record, and stops the pass after three", async () => {
		let calls = 0;
		const a = authority([batch([1, 2, 3, 4, 5].map((n) => claim(n, mac(pr))))], () => {
			calls += 1;
			if (calls === 1 || calls >= 3) throw new Error("connection reset");
			return { outcome: "verified" };
		});
		const counts = await new CloudEventVerifications({ authority: a.value, keyring }).pass(
			new AbortController().signal,
		);
		expect(counts).toEqual({ ...none, verified: 1, failed: 3 });
		expect(a.finished).toHaveLength(4);
		expect(a.value.claimEventVerifications).toHaveBeenCalledOnce();
	});

	it("claims again while a claim refused deliveries itself, up to four claims", async () => {
		const a = authority([batch([], 16), batch([], 16), batch([claim(1, mac(pr))], 3), batch([], 2), batch([], 9)]);
		const counts = await new CloudEventVerifications({ authority: a.value, keyring }).pass(
			new AbortController().signal,
		);
		expect(counts).toEqual({ ...none, verified: 1, refused: 37 });
		expect(a.value.claimEventVerifications).toHaveBeenCalledTimes(4);
	});

	it("logs a pass by its counts only, and an error by a fixed line", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const a = authority([batch([claim(1, mac(pr)), claim(2, "c".repeat(64))])]);
		await logEventVerificationPass(
			new CloudEventVerifications({ authority: a.value, keyring }),
			new AbortController().signal,
		);
		await logEventVerificationPass({ pass: async () => ({ ...none, verified: 4 }) }, new AbortController().signal);
		await logEventVerificationPass({ pass: async () => ({ ...none, stale: 1 }) }, new AbortController().signal);
		await logEventVerificationPass({ pass: async () => ({ ...none, failed: 2 }) }, new AbortController().signal);
		await logEventVerificationPass(
			{
				pass: async () => {
					throw new Error(`database said ${SECRET}`);
				},
			},
			new AbortController().signal,
		);
		expect(errors.mock.calls).toEqual([
			["Event verification: 1 verified, 0 duplicate, 1 refused, 0 offered again, 0 stale, 0 not recorded."],
			["Event verification: 0 verified, 0 duplicate, 0 refused, 0 offered again, 1 stale, 0 not recorded."],
			["Event verification: 0 verified, 0 duplicate, 0 refused, 0 offered again, 0 stale, 2 not recorded."],
			["Event verification: a pass stopped on an error; the next pass tries again."],
		]);
		expect(JSON.stringify(errors.mock.calls)).not.toContain(SECRET);
	});

	it("runs a pass on its timer and stops cleanly", async () => {
		vi.useFakeTimers();
		try {
			const pass = vi.fn(async () => none);
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
