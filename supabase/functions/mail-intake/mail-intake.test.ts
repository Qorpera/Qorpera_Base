import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import {
	bareAddress,
	clean,
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
const EMAIL_ID = "56761188-7520-42d8-8898-ff6fc54ce618";

function sign(id: string, timestamp: number, body: string, key = SECRET_BYTES): string {
	return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

function webhook(event: Json | string, options: { id?: string; timestamp?: number; signature?: string } = {}): Request {
	const body = typeof event === "string" ? event : JSON.stringify(event);
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
		email_id: EMAIL_ID,
		from: "Customer <customer@example.org>",
		to: ["Support <Support@Mail.Example.Test>"],
		cc: ["sales@mail.example.test"],
		bcc: ["hidden@mail.example.test"],
		received_for: ["support@mail.example.test", "forwarded@mail.example.test"],
		subject: "Order 1042",
		attachments: [],
		...data,
	},
});

const message: Json = {
	id: EMAIL_ID,
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

const settled = (...results: Json[]): Json => ({ outcome: "settled", results });

function fixture(answer: Json | Error = settled({ outcome: "accepted", deliveryId: "d1" }), fetched: Json | null | Error = message) {
	const calls: { emailId: string; recipients: string[]; message: string }[] = [];
	const fetches: string[] = [];
	const store: MailStore = {
		async receive(emailId, recipients, body) {
			calls.push({ emailId, recipients, message: body });
			if (answer instanceof Error) throw answer;
			return answer;
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
	it("accepts a Standard Webhooks signature and refuses a changed, stale, future or unsigned one", async () => {
		const body = new TextEncoder().encode('{"a":1}');
		const headers = (signature: string, timestamp = NOW) =>
			new Headers({ "svix-id": "msg_1", "svix-timestamp": String(timestamp), "svix-signature": signature });
		assert.equal(await verifySignature(SECRET, headers(sign("msg_1", NOW, '{"a":1}')), body, NOW), true);
		// Any of several signatures may match (secret rotation).
		assert.equal(await verifySignature(SECRET, headers(`v1,AAAA ${sign("msg_1", NOW, '{"a":1}')}`), body, NOW), true);
		assert.equal(await verifySignature(SECRET, headers(sign("msg_1", NOW, '{"a":2}')), body, NOW), false);
		assert.equal(
			await verifySignature(SECRET, headers(sign("msg_1", NOW, '{"a":1}', Buffer.from("x".repeat(32)))), body, NOW),
			false,
		);
		for (const when of [NOW - 301, NOW + 301])
			assert.equal(await verifySignature(SECRET, headers(sign("msg_1", when, '{"a":1}'), when), body, NOW), false);
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
	it("hands the whole message and every recipient to the mail door once", async () => {
		const f = fixture(settled({ outcome: "accepted", deliveryId: "d1" }, { outcome: "unknown" }));
		const response = await handleMailIntake(webhook(received()), f.intake);
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { stored: 1 });
		assert.deepEqual(f.fetches, [EMAIL_ID]);
		assert.equal(f.calls.length, 1);
		// The envelope first, then Bcc, To and Cc.
		assert.deepEqual(f.calls[0].recipients, [
			"support@mail.example.test",
			"forwarded@mail.example.test",
			"hidden@mail.example.test",
			"sales@mail.example.test",
		]);
		const stored = JSON.parse(f.calls[0].message) as Json;
		// The subject and the trust results come before the bodies, as the text is stored as written.
		assert.deepEqual(Object.keys(stored).slice(0, 4), ["schema", "emailId", "subject", "from"]);
		assert.deepEqual(Object.keys(stored).slice(-2), ["text", "html"]);
		assert.equal(stored.subject, "Order 1042");
		assert.equal(stored.text, "Where is my order?");
		assert.equal(stored.inReplyTo, "<earlier@example.org>");
		assert.deepEqual(stored.replyTo, ["customer@example.org"]);
		assert.deepEqual(stored.authentication, { spf: "pass", dkim: "pass", dmarc: "pass" });
		assert.deepEqual(stored.attachments, [
			{ id: "a1", filename: "receipt.pdf", contentType: "application/pdf", size: 4096, disposition: "attachment", contentId: null },
		]);
		assert.equal(f.calls[0].message.includes("x-other"), false);
	});

	it("passes a mailbox on however many other recipients come first, and the envelope before 200 visible ones", async () => {
		const others = Array.from({ length: 30 }, (_, index) => `person${index}@example.org`);
		const f = fixture();
		await handleMailIntake(webhook(received({ to: others, cc: ["support@mail.example.test"], bcc: [], received_for: [] })), f.intake);
		assert.equal(f.calls[0].recipients.length, 31);
		assert.equal(f.calls[0].recipients.at(-1), "support@mail.example.test");
		const crowd = Array.from({ length: 250 }, (_, index) => `person${index}@example.org`);
		await handleMailIntake(
			webhook(received({ to: crowd, cc: [], bcc: [], received_for: ["hidden@mail.example.test"] })),
			f.intake,
		);
		assert.equal(f.calls[1].recipients.length, 200);
		assert.equal(f.calls[1].recipients[0], "hidden@mail.example.test");
	});

	it("maps the answer: the longest wait for limits, 503 when off or failing, and settles a malformed message", async () => {
		const limited = await handleMailIntake(
			webhook(received()),
			fixture(
				settled(
					{ outcome: "limited", retryAfterSeconds: 600 },
					{ outcome: "accepted" },
					{ outcome: "limited", retryAfterSeconds: 60 },
				),
			).intake,
		);
		assert.equal(limited.status, 429);
		assert.equal(limited.headers.get("retry-after"), "600");
		const off = await handleMailIntake(webhook(received()), fixture({ outcome: "unavailable" }).intake);
		assert.equal(off.status, 503);
		assert.equal(off.headers.get("retry-after"), "300");
		const broken = await handleMailIntake(webhook(received()), fixture(new MailStoreError("XX000", "down")).intake);
		assert.equal(broken.status, 503);
		const malformed = await handleMailIntake(webhook(received()), fixture(new MailStoreError("22023", "bad")).intake);
		assert.deepEqual([malformed.status, await malformed.json()], [200, { stored: 0, refused: true }]);
		const unreachable = await handleMailIntake(webhook(received()), fixture(undefined, new Error("timeout")).intake);
		assert.equal(unreachable.status, 503);
		const quiet = await handleMailIntake(
			webhook(received()),
			fixture(settled({ outcome: "duplicate" }, { outcome: "paused" })).intake,
		);
		assert.deepEqual([quiet.status, await quiet.json()], [200, { stored: 0 }]);
		const odd = await handleMailIntake(webhook(received()), fixture({ outcome: "surprise" }).intake);
		assert.equal(odd.status, 503);
	});

	it("refuses bad signatures, other methods, invalid payloads and oversized webhooks before fetching anything", async () => {
		const f = fixture();
		assert.equal((await handleMailIntake(webhook(received(), { signature: "v1,AAAA" }), f.intake)).status, 401);
		assert.equal((await handleMailIntake(webhook(received(), { timestamp: NOW - 600 }), f.intake)).status, 401);
		assert.equal((await handleMailIntake(new Request(URL), f.intake)).status, 405);
		assert.equal((await handleMailIntake(webhook("{not json"), f.intake)).status, 400);
		for (const id of ["not an id", ".", "..", "56761188-7520-42D8-8898-FF6FC54CE618"])
			assert.equal((await handleMailIntake(webhook(received({ email_id: id })), f.intake)).status, 400, id);
		assert.equal(
			(await handleMailIntake(webhook(received({ subject: "x".repeat(70 * 1024) })), f.intake)).status,
			413,
		);
		// A body with no declared length is capped while it is read.
		const chunk = new Uint8Array(16 * 1024).fill(97);
		const stream = new ReadableStream({
			start(controller) {
				for (let index = 0; index < 5; index++) controller.enqueue(chunk);
				controller.close();
			},
		});
		const streamed = new Request(URL, { method: "POST", body: stream, duplex: "half" } as RequestInit);
		assert.equal((await handleMailIntake(streamed, f.intake)).status, 413);
		assert.equal(f.fetches.length, 0);
		assert.equal(f.calls.length, 0);
	});

	it("ignores other events, and settles a message without recipients or that the provider no longer has", async () => {
		const f = fixture();
		const other = await handleMailIntake(webhook({ type: "email.sent", data: {} }), f.intake);
		assert.deepEqual([other.status, await other.json()], [200, { ignored: true }]);
		const none = await handleMailIntake(
			webhook(received({ to: ["not an address"], cc: [], bcc: [], received_for: [] })),
			f.intake,
		);
		assert.deepEqual([none.status, await none.json()], [200, { stored: 0 }]);
		assert.equal(f.fetches.length, 0);
		const gone = await handleMailIntake(webhook(received()), fixture(undefined, null).intake);
		assert.deepEqual([gone.status, await gone.json()], [200, { stored: 0, missing: true }]);
	});
});

describe("mail message", () => {
	it("reads bare addresses, and none the database could not hold", () => {
		assert.equal(bareAddress("Support <Support@Mail.Example.Test>"), "support@mail.example.test");
		assert.equal(bareAddress(" sales@mail.example.test "), "sales@mail.example.test");
		assert.equal(bareAddress("nobody"), null);
		assert.equal(bareAddress(42), null);
		assert.equal(bareAddress("sup\u0000port@mail.example.test"), null);
		assert.equal(bareAddress("sup\ud83dport@mail.example.test"), null);
	});

	it("marks mail sent automatically, whatever the case of its header names", () => {
		const plain = normalizeMessage(EMAIL_ID, message);
		assert.equal(plain.automated, false);
		assert.equal(plain.autoSubmitted, null);
		for (const [headers, expected] of [
			[{ "Auto-Submitted": "auto-replied; owner-email=\"x@example.org\"" }, true],
			[{ "auto-submitted": "auto-generated" }, true],
			[{ "auto-submitted": "No" }, false],
			[{ Precedence: "bulk" }, true],
			[{ precedence: "list" }, true],
			[{ precedence: "first-class" }, false],
			[{ "List-Id": "<announce.example.org>" }, true],
			[{ "X-Autoreply": "yes" }, true],
			[{ "x-autorespond": "Out of office" }, true],
			[{ "X-Precedence": "auto_reply" }, true],
		] as const) {
			const normalized = normalizeMessage(EMAIL_ID, { ...message, headers });
			assert.equal(normalized.automated, expected, JSON.stringify(headers));
		}
		const replied = normalizeMessage(EMAIL_ID, { ...message, headers: { "Auto-Submitted": "auto-replied" } });
		assert.equal(replied.autoSubmitted, "auto-replied");
		assert.deepEqual(Object.keys(replied).slice(8, 15), [
			"messageId",
			"inReplyTo",
			"references",
			"autoSubmitted",
			"precedence",
			"listId",
			"automated",
		]);
	});

	it("keeps only text the database can hold", () => {
		assert.equal(clean("a\u0000b"), "ab");
		assert.equal(clean("x\ud83dy"), "x�y");
		assert.equal(clean("x\ude00y"), "x�y");
		assert.equal(clean("ok 😀"), "ok 😀");
		const normalized = normalizeMessage(EMAIL_ID, { ...message, text: "a\u0000b\ud83d", subject: "\ud83d" });
		assert.equal(normalized.text, "ab�");
		assert.equal(normalized.subject, "�");
	});

	it("decodes an HTML data URI and cuts HTML before text to fit 256 KiB of the text it stores", () => {
		const decoded = normalizeMessage(EMAIL_ID, {
			...message,
			html: `data:text/html;base64,${Buffer.from("<b>Hej</b>").toString("base64")}`,
		});
		assert.equal(decoded.html, "<b>Hej</b>");
		const big = normalizeMessage(EMAIL_ID, { ...message, text: "t".repeat(200_000), html: "h".repeat(200_000) });
		assert.ok(Buffer.byteLength(JSON.stringify(big)) <= MAX_MESSAGE_BYTES);
		assert.equal(big.truncated, true);
		assert.equal(big.text, "t".repeat(200_000));
		assert.ok(typeof big.html === "string" && big.html.length < 200_000);
		// Multibyte text, escapes and emoji: the cut is by bytes and never splits a surrogate pair.
		const emoji = normalizeMessage(EMAIL_ID, { ...message, text: `"${"é😀\n".repeat(80_000)}`, html: null });
		const written = JSON.stringify(emoji);
		assert.ok(Buffer.byteLength(written) <= MAX_MESSAGE_BYTES);
		assert.ok(typeof emoji.text === "string" && emoji.text.length > 50_000);
		assert.equal(clean(emoji.text as string), emoji.text);
		// A cut that would fall inside an emoji keeps the whole pair out, for fields and bodies alike.
		for (const lead of ["", "x"]) {
			const cut = normalizeMessage(EMAIL_ID, {
				...message,
				subject: `${lead}${"\ud83d\ude00".repeat(600)}`,
				text: `${lead}${"\ud83d\ude00".repeat(100_000)}`,
				html: null,
			});
			assert.equal(clean(cut.subject as string), cut.subject, `subject ${lead}`);
			assert.equal(clean(cut.text as string), cut.text, `text ${lead}`);
			assert.ok(Buffer.byteLength(JSON.stringify(cut)) <= MAX_MESSAGE_BYTES);
		}
	});
});
