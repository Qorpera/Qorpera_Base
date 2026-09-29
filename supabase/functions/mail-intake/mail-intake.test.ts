import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import {
	bareAddress,
	handleMailIntake,
	MAX_MESSAGE_BYTES,
	type MailProvider,
	type MailStore,
	MailStoreError,
	normalizeMessage,
	verifySignature,
} from "./mail-intake.ts";

type Json = Record<string, unknown>;
const SECRET_BYTES = Buffer.from("0123456789abcdef0123456789abcdef");
const SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;
const NOW = 1_790_000_000;
const URL = "https://project.example.test/functions/v1/mail-intake";

function sign(id: string, timestamp: number, body: string, key = SECRET_BYTES): string {
	return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

function webhook(event: Json, options: { id?: string; timestamp?: number; signature?: string } = {}): Request {
	const body = JSON.stringify(event);
	const id = options.id ?? "msg_1";
	const timestamp = options.timestamp ?? NOW;
	return new Request(URL, {
		method: "POST",
		body,
		headers: {
			"content-type": "application/json",
			"svix-id": id,
			"svix-timestamp": String(timestamp),
			"svix-signature": options.signature ?? sign(id, timestamp, body),
		},
	});
}

const received = (data: Json = {}): Json => ({
	type: "email.received",
	created_at: "2026-09-29T20:00:00.000Z",
	data: {
		email_id: "56761188-7520-42d8-8898-ff6fc54ce618",
		from: "Customer <customer@example.org>",
		to: ["Support <Support@Mail.Example.Test>"],
		cc: ["sales@mail.example.test"],
		received_for: ["support@mail.example.test"],
		subject: "Order 1042",
		attachments: [],
		...data,
	},
});

const message: Json = {
	id: "56761188-7520-42d8-8898-ff6fc54ce618",
	from: "Customer <customer@example.org>",
	to: ["support@mail.example.test"],
	cc: [],
	reply_to: ["customer@example.org"],
	subject: "Order 1042",
	created_at: "2026-09-29T20:00:00.000Z",
	text: "Where is my order?",
	html: "<p>Where is my order?</p>",
	message_id: "<abc@example.org>",
	headers: { "in-reply-to": "<earlier@example.org>", references: "<earlier@example.org>", "x-other": "dropped" },
	authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
	attachments: [
		{ id: "a1", filename: "receipt.pdf", content_type: "application/pdf", content_disposition: "attachment", size: 4096 },
	],
};

function fixture(outcomes: Json[] | Error = [{ outcome: "accepted", deliveryId: "d1" }], fetched: Json | null | Error = message) {
	const calls: { emailId: string; recipient: string; message: Json }[] = [];
	const fetches: string[] = [];
	let index = 0;
	const store: MailStore = {
		async receive(emailId, recipient, body) {
			calls.push({ emailId, recipient, message: body });
			if (outcomes instanceof Error) throw outcomes;
			return outcomes[Math.min(index++, outcomes.length - 1)];
		},
	};
	const provider: MailProvider = {
		async fetch(emailId) {
			fetches.push(emailId);
			if (fetched instanceof Error) throw fetched;
			return fetched;
		},
	};
	return { calls, fetches, intake: { secret: SECRET, store, provider, now: () => NOW } };
}

describe("mail intake signatures", () => {
	it("accepts a Standard Webhooks signature and refuses a changed, stale or unsigned one", async () => {
		const body = new TextEncoder().encode('{"a":1}');
		const headers = (signature: string, timestamp = NOW) =>
			new Headers({ "svix-id": "msg_1", "svix-timestamp": String(timestamp), "svix-signature": signature });
		assert.equal(await verifySignature(SECRET, headers(sign("msg_1", NOW, '{"a":1}')), body, NOW), true);
		// Any of several signatures may match (secret rotation).
		assert.equal(
			await verifySignature(SECRET, headers(`v1,AAAA ${sign("msg_1", NOW, '{"a":1}')}`), body, NOW),
			true,
		);
		assert.equal(await verifySignature(SECRET, headers(sign("msg_1", NOW, '{"a":2}')), body, NOW), false);
		assert.equal(
			await verifySignature(SECRET, headers(sign("msg_1", NOW, '{"a":1}', Buffer.from("x".repeat(32)))), body, NOW),
			false,
		);
		assert.equal(
			await verifySignature(SECRET, headers(sign("msg_1", NOW - 301, '{"a":1}'), NOW - 301), body, NOW),
			false,
		);
		assert.equal(await verifySignature(SECRET, new Headers(), body, NOW), false);
		assert.equal(
			await verifySignature(SECRET, headers(sign("msg_1", NOW, '{"a":1}').replace("v1,", "v2,")), body, NOW),
			false,
		);
	});

	it("matches the Standard Webhooks example", async () => {
		const body = new TextEncoder().encode('{"test": 2432232314}');
		const headers = new Headers({
			"webhook-id": "msg_p5jXN8AQM9LWM0D4loKWxJek",
			"webhook-timestamp": "1614265330",
			"webhook-signature": "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
		});
		assert.equal(await verifySignature("whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", headers, body, 1614265330), true);
	});
});

describe("mail intake", () => {
	it("stores a received message once for each recipient, fetched whole and bounded", async () => {
		const f = fixture([
			{ outcome: "accepted", deliveryId: "d1" },
			{ outcome: "unknown" },
		]);
		const response = await handleMailIntake(webhook(received()), f.intake);
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { stored: 1 });
		assert.deepEqual(f.fetches, ["56761188-7520-42d8-8898-ff6fc54ce618"]);
		assert.deepEqual(
			f.calls.map((call) => call.recipient),
			["support@mail.example.test", "sales@mail.example.test"],
		);
		const stored = f.calls[0].message;
		assert.equal(stored.schema, "qorpera.mail/v1");
		assert.equal(stored.subject, "Order 1042");
		assert.equal(stored.text, "Where is my order?");
		assert.equal(stored.inReplyTo, "<earlier@example.org>");
		assert.deepEqual(stored.replyTo, ["customer@example.org"]);
		assert.deepEqual(stored.attachments, [
			{
				id: "a1",
				filename: "receipt.pdf",
				contentType: "application/pdf",
				size: 4096,
				disposition: "attachment",
				contentId: null,
			},
		]);
		assert.equal(JSON.stringify(stored).includes("x-other"), false);
	});

	it("maps outcomes: limited asks for a retry, switched off and failures answer 503", async () => {
		const limited = await handleMailIntake(
			webhook(received()),
			fixture([{ outcome: "accepted" }, { outcome: "limited", retryAfterSeconds: 600 }]).intake,
		);
		assert.equal(limited.status, 429);
		assert.equal(limited.headers.get("retry-after"), "600");
		const off = await handleMailIntake(webhook(received()), fixture([{ outcome: "unavailable" }]).intake);
		assert.equal(off.status, 503);
		assert.equal(off.headers.get("retry-after"), "300");
		const broken = await handleMailIntake(webhook(received()), fixture(new MailStoreError("XX000", "down")).intake);
		assert.equal(broken.status, 503);
		const unreachable = await handleMailIntake(webhook(received()), fixture(undefined, new Error("timeout")).intake);
		assert.equal(unreachable.status, 503);
		const settled = await handleMailIntake(
			webhook(received()),
			fixture([{ outcome: "duplicate" }, { outcome: "paused" }]).intake,
		);
		assert.equal(settled.status, 200);
		const odd = await handleMailIntake(webhook(received()), fixture([{ outcome: "surprise" }]).intake);
		assert.equal(odd.status, 503);
	});

	it("refuses bad signatures, other methods and oversized webhooks before fetching anything", async () => {
		const f = fixture();
		const forged = await handleMailIntake(webhook(received(), { signature: "v1,AAAA" }), f.intake);
		assert.equal(forged.status, 401);
		const stale = await handleMailIntake(webhook(received(), { timestamp: NOW - 600 }), f.intake);
		assert.equal(stale.status, 401);
		const get = await handleMailIntake(new Request(URL), f.intake);
		assert.equal(get.status, 405);
		const big = await handleMailIntake(webhook(received({ subject: "x".repeat(70 * 1024) })), f.intake);
		assert.equal(big.status, 413);
		assert.equal(f.fetches.length, 0);
		assert.equal(f.calls.length, 0);
	});

	it("ignores other events, and settles a message without recipients or that the provider no longer has", async () => {
		const f = fixture();
		const other = await handleMailIntake(webhook({ type: "email.sent", data: {} }), f.intake);
		assert.deepEqual([other.status, await other.json()], [200, { ignored: true }]);
		const none = await handleMailIntake(
			webhook(received({ to: ["not an address"], cc: [], received_for: [] })),
			f.intake,
		);
		assert.deepEqual([none.status, await none.json()], [200, { stored: 0 }]);
		assert.equal(f.fetches.length, 0);
		const gone = await handleMailIntake(webhook(received()), fixture(undefined, null).intake);
		assert.deepEqual([gone.status, await gone.json()], [200, { stored: 0, missing: true }]);
		const malformed = await handleMailIntake(webhook(received({ email_id: "not an id" })), f.intake);
		assert.equal(malformed.status, 400);
	});
});

describe("mail message", () => {
	it("reads bare addresses", () => {
		assert.equal(bareAddress("Support <Support@Mail.Example.Test>"), "support@mail.example.test");
		assert.equal(bareAddress(" sales@mail.example.test "), "sales@mail.example.test");
		assert.equal(bareAddress("nobody"), null);
		assert.equal(bareAddress(42), null);
	});

	it("decodes an HTML data URI and cuts HTML before text to fit 256 KiB", () => {
		const decoded = normalizeMessage("e1", {
			...message,
			html: `data:text/html;base64,${Buffer.from("<b>Hej</b>").toString("base64")}`,
		});
		assert.equal(decoded.html, "<b>Hej</b>");
		const big = normalizeMessage("e1", { ...message, text: "t".repeat(200_000), html: "h".repeat(200_000) });
		assert.ok(Buffer.byteLength(JSON.stringify(big)) <= MAX_MESSAGE_BYTES);
		assert.equal(big.truncated, true);
		assert.equal(big.text, "t".repeat(200_000));
		assert.ok(typeof big.html === "string" && big.html.length < 200_000);
		const huge = normalizeMessage("e1", { ...message, text: "é".repeat(300_000), html: null });
		assert.ok(Buffer.byteLength(JSON.stringify(huge)) <= MAX_MESSAGE_BYTES);
		assert.ok(typeof huge.text === "string" && huge.text.length > 100_000);
	});
});
