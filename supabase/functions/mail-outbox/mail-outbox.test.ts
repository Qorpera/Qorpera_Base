import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	BATCH,
	handleMailOutbox,
	type MailJob,
	type MailOutboxStore,
	MailSendError,
	type MailSender,
	PACE_MS,
	type ProviderEmail,
	parseMailClaim,
	providerEmail,
	ResendSender,
} from "./mail-outbox.ts";

const KEY = "sb_secret_0123456789abcdefghij";
const LEASE = "73300000-0000-4000-8000-0000000000f1";
const URL = "https://project.example.test/functions/v1/mail-outbox";

function job(n: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		mailId: `73300000-0000-4000-8000-${String(n).padStart(12, "0")}`,
		leaseId: LEASE,
		attemptCount: 1,
		from: '"Ada at Northwind" <support@mail.example.test>',
		to: ["bob@acme.test"],
		cc: [],
		subject: `Email ${n}`,
		text: "Hello\n\n-- \nWritten and sent by Ada, an AI agent working for Northwind.",
		headers: {},
		...extra,
	};
}

function outbox(claimed: unknown, sender: MailSender) {
	const calls: { claim: [number, string][]; complete: [string, string][]; fail: [string, string, string, boolean][] } = {
		claim: [],
		complete: [],
		fail: [],
	};
	const keys: string[] = [];
	const sleeps: number[] = [];
	const store: MailOutboxStore = {
		async claim(limit, leaseId) {
			calls.claim.push([limit, leaseId]);
			if (claimed instanceof Error) throw claimed;
			return claimed;
		},
		async complete(mail: MailJob, providerMessageId) {
			calls.complete.push([mail.mailId, providerMessageId]);
			if (mail.subject === "Lost completion") throw new Error("lost");
		},
		async fail(mailId, leaseId, message, retryable) {
			calls.fail.push([mailId, leaseId, message, retryable]);
		},
	};
	return {
		calls,
		keys,
		sleeps,
		handle: (request: Request) =>
			handleMailOutbox(request, {
				keys: [KEY, "legacy-service-role-key-0123456789"],
				store: (key) => {
					keys.push(key);
					return store;
				},
				sender,
				leaseId: () => LEASE,
				sleep: async (ms) => {
					sleeps.push(ms);
				},
			}),
	};
}

function recording(fail?: (email: ProviderEmail) => Error | undefined) {
	const sent: [ProviderEmail, string][] = [];
	const sender: MailSender = {
		async send(email, key) {
			sent.push([email, key]);
			const error = fail?.(email);
			if (error) throw error;
			return `provider-${sent.length}`;
		},
	};
	return { sent, sender };
}

const post = (headers: Record<string, string> = { apikey: KEY }) => new Request(URL, { method: "POST", headers });

describe("mail outbox", () => {
	it("answers only a POST with a secret key it knows", async () => {
		const { sender } = recording();
		const f = outbox([], sender);
		assert.equal((await f.handle(new Request(URL))).status, 405);
		assert.equal((await f.handle(post({}))).status, 401);
		assert.equal((await f.handle(post({ apikey: "sb_secret_someone_else_000000" }))).status, 401);
		assert.equal((await f.handle(post({ authorization: `Bearer ${KEY}` }))).status, 200);
		assert.equal((await f.handle(post({ apikey: "legacy-service-role-key-0123456789" }))).status, 200);
		assert.deepEqual(f.keys, [KEY, "legacy-service-role-key-0123456789"]);
		assert.deepEqual(f.calls.claim, [
			[BATCH, LEASE],
			[BATCH, LEASE],
		]);
	});

	it("sends each claimed email with its id as the idempotency key, paced, and completes it", async () => {
		const { sent, sender } = recording();
		const reply = job(2, {
			cc: ["boss@acme.test"],
			headers: { "In-Reply-To": "<m30@example.org>", References: "<m1@example.org> <m30@example.org>" },
		});
		const f = outbox([job(1), reply, job(3)], sender);
		const response = await f.handle(post());
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("cache-control"), "no-store");
		assert.deepEqual(await response.json(), { claimed: 3, sent: 3, retrying: 0, failed: 0, rejected: 0 });
		assert.deepEqual(sent[0], [
			{
				from: '"Ada at Northwind" <support@mail.example.test>',
				to: ["bob@acme.test"],
				subject: "Email 1",
				text: "Hello\n\n-- \nWritten and sent by Ada, an AI agent working for Northwind.",
			},
			"company-mail/73300000-0000-4000-8000-000000000001",
		]);
		assert.deepEqual(sent[1][0].cc, ["boss@acme.test"]);
		assert.deepEqual(sent[1][0].headers, {
			"In-Reply-To": "<m30@example.org>",
			References: "<m1@example.org> <m30@example.org>",
		});
		assert.deepEqual(f.sleeps, [PACE_MS, PACE_MS]);
		assert.deepEqual(f.calls.complete, [
			["73300000-0000-4000-8000-000000000001", "provider-1"],
			["73300000-0000-4000-8000-000000000002", "provider-2"],
			["73300000-0000-4000-8000-000000000003", "provider-3"],
		]);
	});

	it("retries what the provider may get past and fails the rest", async () => {
		const { sender } = recording((email) =>
			email.subject === "Email 1"
				? new MailSendError("Too many requests (429/rate_limit_exceeded)", true)
				: email.subject === "Email 2"
					? new MailSendError("Invalid `to` field (422/validation_error)", false)
					: email.subject === "Email 3"
						? new Error("unexpected")
						: undefined,
		);
		const f = outbox([job(1), job(2), job(3), job(4, { subject: "Lost completion" })], sender);
		assert.deepEqual(await (await f.handle(post())).json(), {
			claimed: 4,
			sent: 0,
			retrying: 2,
			failed: 1,
			rejected: 0,
		});
		assert.deepEqual(f.calls.fail, [
			["73300000-0000-4000-8000-000000000001", LEASE, "Too many requests (429/rate_limit_exceeded)", true],
			["73300000-0000-4000-8000-000000000002", LEASE, "Invalid `to` field (422/validation_error)", false],
			["73300000-0000-4000-8000-000000000003", LEASE, "The email could not be sent", true],
		]);
		// A lost completion is left to the lease: the send is repeated with the same idempotency key.
		assert.deepEqual(f.calls.complete, [["73300000-0000-4000-8000-000000000004", "provider-4"]]);
	});

	it("fails an email it cannot read without sending it, and answers 503 for a failed or invalid claim", async () => {
		const { sent, sender } = recording();
		const f = outbox([job(1, { to: [] }), job(2, { headers: { Bcc: "all@acme.test" } }), job(3)], sender);
		assert.deepEqual(await (await f.handle(post())).json(), {
			claimed: 3,
			sent: 1,
			retrying: 0,
			failed: 0,
			rejected: 2,
		});
		assert.deepEqual(
			f.calls.fail.map(([mailId, , , retryable]) => [mailId, retryable]),
			[
				["73300000-0000-4000-8000-000000000001", false],
				["73300000-0000-4000-8000-000000000002", false],
			],
		);
		assert.equal(sent.length, 1);
		assert.equal((await outbox(new Error("down"), sender).handle(post())).status, 503);
		assert.equal((await outbox({ jobs: [] }, sender).handle(post())).status, 503);
		assert.equal((await outbox([job(1, { mailId: "x" })], sender).handle(post())).status, 503);
	});

	it("leaves out an empty cc and empty headers", () => {
		const { jobs } = parseMailClaim([job(1)]);
		assert.deepEqual(Object.keys(providerEmail(jobs[0])), ["from", "to", "subject", "text"]);
	});
});

describe("Resend sender", () => {
	const email: ProviderEmail = { from: '"Ada" <a@mail.example.test>', to: ["bob@acme.test"], subject: "Hi", text: "Hi" };
	const respond = (status: number, body: unknown) =>
		(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

	it("posts the email with the platform key and the idempotency key", async () => {
		let request: { url: string; init: RequestInit } | undefined;
		const sender = new ResendSender("re_platform_key", (async (url: string, init: RequestInit) => {
			request = { url, init };
			return new Response(JSON.stringify({ id: "resend-1" }), { status: 200 });
		}) as unknown as typeof fetch);
		assert.equal(await sender.send(email, "company-mail/1"), "resend-1");
		assert.equal(request?.url, "https://api.resend.com/emails");
		assert.equal(request?.init.method, "POST");
		assert.deepEqual(request?.init.headers, {
			Authorization: "Bearer re_platform_key",
			"Content-Type": "application/json",
			"Idempotency-Key": "company-mail/1",
		});
		assert.deepEqual(JSON.parse(String(request?.init.body)), email);
	});

	it("says which refusals are worth another try", async () => {
		for (const [status, body, retryable] of [
			[429, { name: "rate_limit_exceeded", message: "Too many requests" }, true],
			[500, { name: "internal_server_error" }, true],
			[408, {}, true],
			[409, { name: "concurrent_idempotent_requests" }, true],
			[409, { name: "invalid_idempotent_request" }, false],
			[422, { name: "validation_error", message: "Invalid `to` field" }, false],
			[403, { name: "validation_error", message: "The domain is not verified" }, false],
			[200, { id: "" }, true],
			[200, [], true],
		] as const) {
			await assert.rejects(new ResendSender("k", respond(status, body)).send(email, "k1"), (error: unknown) => {
				assert.ok(error instanceof MailSendError);
				assert.equal(error.retryable, retryable, `${status} ${JSON.stringify(body)}`);
				return true;
			});
		}
		const unreachable = new ResendSender("k", (async () => {
			throw new TypeError("network down");
		}) as unknown as typeof fetch);
		await assert.rejects(unreachable.send(email, "k1"), (error: unknown) => error instanceof MailSendError && error.retryable);
	});
});
