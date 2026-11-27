import { createHash, randomBytes, randomUUID } from "node:crypto";
import { CloudConnectorOAuthFlows } from "@qorpera/runtime/cloud-connector-oauth";
import {
	CloudGmailMailboxes,
	GMAIL_MESSAGE_MAX_BYTES,
	GMAIL_SIGN_IN_AGAIN,
	type GmailMailboxAuthority,
	GmailMailboxClient,
	gmailEmailId,
	gmailMailMessage,
} from "@qorpera/runtime/cloud-gmail-mailbox";
import {
	CloudSecretBroker,
	type CloudSecretBrokerAuthority,
	type CloudSecretCaptureDescription,
} from "@qorpera/runtime/cloud-secret-broker";
import { HttpCloudSecretBrokerService } from "@qorpera/runtime/cloud-secret-broker-http";
import { CloudSecretKeyring } from "@qorpera/runtime/cloud-secret-crypto";
import { afterEach, expect, it, vi } from "vitest";

const signal = new AbortController().signal;
const google = { clientId: "g.apps.googleusercontent.com", clientSecret: "GOCSPX-test-secret-value" };
const COMPANY = "11111111-1111-4111-8111-111111111111";
const ADDRESS = "owner@gmail.com";
const envelope = Buffer.from("sealed envelope bytes");

interface FakeMessage {
	readonly id: string;
	readonly threadId: string;
	readonly internalDate: number;
	readonly labels?: readonly string[];
	readonly subject: string;
}

function base64url(text: string): string {
	return Buffer.from(text, "utf8").toString("base64url");
}

class FakeGmail {
	messages: FakeMessage[] = [];
	historyId = "1000";
	history: { id: string; message: FakeMessage }[] = [];
	historyGone = false;
	tokenRefused = false;
	listEstimate: number | null = null;
	draftSendStatus: number | null = null;
	readonly sent: { raw: string; threadId: string | null; id: string }[] = [];
	readonly drafts = new Map<string, { raw: string; threadId: string | null; messageId: string }>();
	#made = 0;
	readonly fetched: string[] = [];
	readonly calls: string[] = [];

	constructor(count = 0) {
		for (let index = 0; index < count; index += 1)
			this.messages.push({
				id: `m${String(count - index).padStart(4, "0")}`,
				threadId: `t${count - index}`,
				internalDate: Date.UTC(2026, 0, 1) + (count - index) * 60_000,
				subject: `Message ${count - index}`,
			});
	}

	readonly fetch = vi.fn<typeof fetch>(async (target, init) => {
		const url = new URL(String(target));
		this.calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
		if (url.href === "https://oauth2.googleapis.com/token")
			return this.tokenRefused
				? Response.json({ error: "invalid_grant" }, { status: 400 })
				: Response.json({ access_token: "ya29.access-token-value-1234567890" });
		if (url.origin !== "https://gmail.googleapis.com") throw new Error(`unexpected ${url.href}`);
		const path = url.pathname.replace("/gmail/v1/users/me", "");
		if (path === "/profile")
			return Response.json({
				emailAddress: "Owner@Gmail.com",
				historyId: this.historyId,
				messagesTotal: this.messages.length,
			});
		if ((path === "/messages" || path === "/drafts") && url.searchParams.get("q")?.startsWith("rfc822msgid:")) {
			const query = url.searchParams.get("q") ?? "";
			const wanted = `Message-ID: <${query.slice("rfc822msgid:".length).split(" ")[0]}>\r\n`;
			const drafts = [...this.drafts].filter(([, draft]) => draft.raw.includes(wanted));
			if (path === "/drafts")
				return Response.json({
					drafts: drafts.map(([id, draft]) => ({
						id,
						message: { id: draft.messageId, threadId: draft.threadId },
					})),
				});
			const sent = this.sent
				.filter((item) => item.raw.includes(wanted))
				.map((item) => ({ id: item.id, threadId: item.threadId ?? "new-thread" }));
			const found = query.includes(" in:sent")
				? sent
				: [...drafts.map(([, draft]) => ({ id: draft.messageId, threadId: draft.threadId })), ...sent];
			return Response.json(found.length ? { messages: found.slice(0, 1) } : { resultSizeEstimate: 0 });
		}
		if (path === "/messages") {
			const offset = Number(url.searchParams.get("pageToken") ?? "0");
			const size = Number(url.searchParams.get("maxResults"));
			const page = this.messages.slice(offset, offset + size);
			return Response.json({
				messages: page.map((message) => ({ id: message.id, threadId: message.threadId })),
				...(offset + size < this.messages.length ? { nextPageToken: String(offset + size) } : {}),
				resultSizeEstimate: this.listEstimate ?? this.messages.length,
			});
		}
		if (path === "/history") {
			if (this.historyGone) return Response.json({ error: { code: 404, message: "Not found" } }, { status: 404 });
			const start = Number(url.searchParams.get("startHistoryId"));
			const records = this.history.filter((record) => Number(record.id) > start);
			return Response.json({
				history: records.map((record) => ({
					id: record.id,
					messagesAdded: [
						{
							message: {
								id: record.message.id,
								threadId: record.message.threadId,
								labelIds: record.message.labels ?? ["INBOX"],
							},
						},
					],
				})),
				historyId: this.historyId,
			});
		}
		if (path === "/drafts" && init?.method === "POST") {
			const body = JSON.parse(String(init?.body)) as { message: { raw: string; threadId?: string } };
			this.#made += 1;
			const draft = {
				raw: Buffer.from(body.message.raw, "base64url").toString("utf8"),
				threadId: body.message.threadId ?? null,
				messageId: `sent${this.#made}`,
			};
			this.drafts.set(`draft${this.#made}`, draft);
			return Response.json({ id: `draft${this.#made}`, message: { id: draft.messageId, threadId: draft.threadId } });
		}
		if (path === "/drafts/send") {
			const { id } = JSON.parse(String(init?.body)) as { id: string };
			const draft = this.drafts.get(id);
			if (!draft) return Response.json({ error: { code: 404 } }, { status: 404 });
			if (this.draftSendStatus !== null)
				return Response.json({ error: { code: this.draftSendStatus } }, { status: this.draftSendStatus });
			this.drafts.delete(id);
			this.sent.push({ raw: draft.raw, threadId: draft.threadId, id: draft.messageId });
			return Response.json({ id: draft.messageId, threadId: draft.threadId ?? "new-thread" });
		}
		const draft = /^\/drafts\/([A-Za-z0-9_-]+)$/.exec(path);
		if (draft && init?.method === "DELETE") {
			this.drafts.delete(draft[1] as string);
			return new Response(null, { status: 204 });
		}
		if (draft)
			return this.drafts.has(draft[1] as string)
				? Response.json({ id: draft[1] })
				: Response.json({ error: { code: 404 } }, { status: 404 });
		const one = /^\/messages\/([A-Za-z0-9_-]+)$/.exec(path);
		if (one) {
			const sentMessage = this.sent.find((sent) => sent.id === one[1]);
			const draftMessage = [...this.drafts.values()].find((item) => item.messageId === one[1]);
			if (url.searchParams.get("format") === "minimal")
				return sentMessage
					? Response.json({ id: sentMessage.id, threadId: sentMessage.threadId, labelIds: ["SENT"] })
					: draftMessage
						? Response.json({ id: draftMessage.messageId, threadId: draftMessage.threadId, labelIds: ["DRAFT"] })
						: Response.json({ error: { code: 404 } }, { status: 404 });
			if (url.searchParams.get("format") === "metadata")
				return Response.json({
					id: one[1],
					payload: { headers: [{ name: "Message-ID", value: `<${one[1]}@mail.gmail.com>` }] },
				});
			this.fetched.push(one[1] as string);
			const message = [...this.messages, ...this.history.map((record) => record.message)].find(
				(item) => item.id === one[1],
			);
			if (!message) return Response.json({ error: { code: 404 } }, { status: 404 });
			return Response.json({
				id: message.id,
				threadId: message.threadId,
				internalDate: String(message.internalDate),
				labelIds: message.labels ?? ["INBOX"],
				payload: {
					mimeType: "text/plain",
					headers: [
						{ name: "From", value: "Customer <customer@example.org>" },
						{ name: "To", value: ADDRESS },
						{ name: "Subject", value: message.subject },
						{ name: "Message-ID", value: `<${message.id}@example.org>` },
					],
					body: { data: base64url(`Text of ${message.subject}`) },
				},
			});
		}
		throw new Error(`unexpected ${url.href}`);
	});
}

function claim(overrides: Record<string, unknown> = {}) {
	return {
		schema: "qorpera.google-mailbox-claim/v1",
		companyId: COMPANY,
		environmentId: "22222222-2222-4222-8222-222222222222",
		mailboxId: "33333333-3333-4333-8333-333333333333",
		address: ADDRESS,
		state: "bringing_in",
		lease: "44444444-4444-4444-8444-444444444444",
		secretId: "55555555-5555-4555-8555-555555555555",
		secretVersion: 1,
		keyId: "k1",
		encryptedEnvelopeBase64: envelope.toString("base64"),
		envelopeSha256: createHash("sha256").update(envelope).digest("hex"),
		historyId: null,
		pageToken: null,
		broughtIn: 0,
		total: null,
		importCount: 0,
		gap: false,
		...overrides,
	};
}

function fixture(options: {
	claims: Record<string, unknown>[];
	gmail: FakeGmail;
	known?: readonly string[];
	bound?: number;
	sends?: Record<string, unknown>[];
	messagesPerPass?: number;
	completionFailures?: number;
	recordFailures?: number;
	notRecorded?: boolean;
}) {
	const claims = [...options.claims];
	const stored = new Map<
		string,
		{ imported: boolean; message: Record<string, unknown>; receivedAt: string; gap?: boolean }
	>();
	for (const id of options.known ?? []) stored.set(id, { imported: true, message: {}, receivedAt: "" });
	const order: string[] = [];
	const finished: Record<string, unknown>[] = [];
	const completed: Record<string, unknown>[] = [];
	const failed: Record<string, unknown>[] = [];
	const drafts: Record<string, unknown>[] = [];
	let imported = 0;
	let failedCompletions = 0;
	let failedRecords = 0;
	const authority: GmailMailboxAuthority = {
		claimGoogleMailbox: vi.fn(async () => claims.shift() ?? null),
		googleMailKnownAmong: vi.fn(async ({ gmailIds }) => ({
			schema: "qorpera.google-mail-known/v1",
			known: gmailIds.filter((id: string) => stored.has(id)),
			stops: gmailIds.filter((id: string) => stored.has(id) && !stored.get(id)?.gap),
		})),
		bringInGoogleMail: vi.fn(async (input) => {
			if (stored.has(input.gmailId)) return { schema: "qorpera.google-mail-brought-in/v1", outcome: "duplicate" };
			if (input.imported && options.bound !== undefined && imported >= options.bound)
				return { schema: "qorpera.google-mail-brought-in/v1", outcome: "bounded" };
			if (input.imported) imported += 1;
			stored.set(input.gmailId, {
				imported: input.imported,
				message: JSON.parse(input.message) as Record<string, unknown>,
				receivedAt: input.receivedAt,
			});
			order.push(input.gmailId);
			return { schema: "qorpera.google-mail-brought-in/v1", outcome: "accepted", deliveryId: randomUUID() };
		}),
		finishGoogleMailboxPass: vi.fn(async (input) => {
			finished.push({ ...input });
			return { schema: "qorpera.google-mailbox-pass/v1" };
		}),
		claimGoogleMailSends: vi.fn(async () => ({ schema: "qorpera.google-mail-sends/v1", sends: options.sends ?? [] })),
		recordGoogleMailDraft: vi.fn(async (input) => {
			if ((options.recordFailures ?? 0) > failedRecords) {
				failedRecords += 1;
				throw new Error("database answer lost");
			}
			drafts.push({ ...input });
			return { schema: "qorpera.google-mail-draft/v1", recorded: options.notRecorded !== true };
		}),
		completeGoogleMailSend: vi.fn(async (input) => {
			if ((options.completionFailures ?? 0) > failedCompletions) {
				failedCompletions += 1;
				throw new Error("database answer lost");
			}
			completed.push({ ...input });
			return { schema: "qorpera.google-mail-send/v1", completed: true };
		}),
		failGoogleMailSend: vi.fn(async (input) => {
			failed.push({ ...input });
			return { schema: "qorpera.google-mail-send/v1", completed: true };
		}),
	};
	const keyring = {
		use: vi.fn(
			async (
				_envelope: Uint8Array,
				identity: { companyId: string },
				callback: (fields: Record<string, string>) => unknown,
			) => {
				expect(identity.companyId).toBe(COMPANY);
				return callback({ refresh_token: "1//refresh-token-value-1234567890" });
			},
		),
	};
	const mailboxes = new CloudGmailMailboxes({
		authority,
		keyring: keyring as never,
		gmail: new GmailMailboxClient({ client: google, fetch: options.gmail.fetch }),
		messagesPerPass: options.messagesPerPass ?? 100_000,
		budgetMs: 60_000,
	});
	return { mailboxes, authority, stored, order, finished, completed, failed, drafts };
}

it("brings in the first import newest first, a page at a time, through the mail door, skipping what is here", async () => {
	const gmail = new FakeGmail(250);
	gmail.listEstimate = 201;
	const f = fixture({ claims: [claim()], gmail, known: ["m0249", "m0248"] });
	const outcome = await f.mailboxes.pass(signal);
	expect(outcome).toEqual({ mailboxes: 1, messages: 248, sent: 0, refused: 0, failed: 0 });
	expect(f.order[0]).toBe("m0250");
	expect(f.order[1]).toBe("m0247");
	expect(f.order.at(-1)).toBe("m0001");
	expect(gmail.fetched).not.toContain("m0249");
	expect(f.finished).toEqual([
		expect.objectContaining({
			outcome: "imported",
			historyId: "1000",
			pageToken: null,
			total: 250,
			capped: false,
			error: null,
		}),
	]);
	const stored = f.stored.get("m0250");
	expect(stored?.imported).toBe(true);
	expect(stored?.receivedAt).toBe(new Date(Date.UTC(2026, 0, 1) + 250 * 60_000).toISOString());
	expect(stored?.message.emailId).toBe(gmailEmailId(COMPANY, ADDRESS, "m0250"));
	expect(stored?.message.subject).toBe("Message 250");
	expect(stored?.message.text).toBe("Text of Message 250");
});

it("stops a pass within its bound and goes on from the page it was on", async () => {
	const gmail = new FakeGmail(250);
	const f = fixture({ claims: [claim()], gmail, messagesPerPass: 150 });
	await f.mailboxes.pass(signal);
	expect(f.order).toHaveLength(150);
	expect(f.finished).toEqual([
		expect.objectContaining({ outcome: "importing", historyId: "1000", pageToken: "100", total: 250 }),
	]);
	const next = fixture({
		claims: [claim({ historyId: "1000", pageToken: "100", broughtIn: 150, total: 250 })],
		gmail,
		known: f.order,
	});
	await next.mailboxes.pass(signal);
	expect(next.order).toHaveLength(100);
	expect(next.order[0]).toBe("m0100");
	expect(next.finished).toEqual([expect.objectContaining({ outcome: "imported", historyId: "1000", total: 250 })]);
});

it("ends the first import at 50,000 messages", async () => {
	const gmail = new FakeGmail(5);
	const counted = fixture({ claims: [claim({ broughtIn: 60_000, importCount: 49_999, historyId: "1000" })], gmail });
	await counted.mailboxes.pass(signal);
	expect(counted.order).toEqual(["m0005"]);
	expect(counted.finished).toEqual([expect.objectContaining({ outcome: "imported", pageToken: null, capped: true })]);
	const bounded = fixture({ claims: [claim({ historyId: "1000" })], gmail, bound: 2 });
	await bounded.mailboxes.pass(signal);
	expect(bounded.order).toEqual(["m0005", "m0004"]);
	expect(bounded.finished).toEqual([expect.objectContaining({ outcome: "imported", capped: true })]);
});

it("after a reconnect brings in the gap newest first until it reaches known mail, whatever came in before", async () => {
	const gmail = new FakeGmail(6);
	gmail.historyId = "3000";
	const f = fixture({
		claims: [claim({ gap: true, broughtIn: 50_000, importCount: 0, total: 50_000 })],
		gmail,
		known: ["m0004", "m0002"],
	});
	await f.mailboxes.pass(signal);
	expect(f.order).toEqual(["m0006", "m0005"]);
	expect(f.stored.get("m0006")?.imported).toBe(true);
	expect(f.finished).toEqual([
		expect.objectContaining({ outcome: "imported", historyId: "3000", pageToken: null, total: 6 }),
	]);
});

it("after a reconnect mid-import walks the gap, then the older walk, and stores every message quietly", async () => {
	const gmail = new FakeGmail(250);
	gmail.historyId = "4000";
	for (let index = 251; index <= 255; index += 1)
		gmail.messages.unshift({
			id: `m${String(index).padStart(4, "0")}`,
			threadId: `t${index}`,
			internalDate: Date.UTC(2026, 0, 1) + index * 60_000,
			subject: `Message ${index}`,
		});
	const before = gmail.messages.slice(5, 105).map((message) => message.id);
	const gap = fixture({ claims: [claim({ gap: true, broughtIn: 100, total: 250 })], gmail, known: before });
	await gap.mailboxes.pass(signal);
	expect(gap.order).toEqual(["m0255", "m0254", "m0253", "m0252", "m0251"]);
	expect(gap.finished).toEqual([
		expect.objectContaining({ outcome: "imported", historyId: "4000", total: 255, capped: false }),
	]);
	const older = fixture({
		claims: [claim({ historyId: "4000", pageToken: "100", importCount: 100, broughtIn: 105, total: 255 })],
		gmail,
		known: [...before, ...gap.order],
	});
	await older.mailboxes.pass(signal);
	expect(older.order).toHaveLength(150);
	expect(older.order[0]).toBe("m0150");
	expect(older.order.at(-1)).toBe("m0001");
	expect(older.finished).toEqual([
		expect.objectContaining({ outcome: "imported", historyId: "4000", pageToken: null, capped: false }),
	]);
	for (const id of [...gap.order, ...older.order])
		expect(gap.stored.get(id)?.imported ?? older.stored.get(id)?.imported).toBe(true);
	expect(gmail.calls.filter((call) => call.endsWith("/history"))).toEqual([]);
});

it("reads Gmail's change list since the mark as new mail, skipping sent and spam", async () => {
	const gmail = new FakeGmail(0);
	gmail.historyId = "1010";
	gmail.history = [
		{ id: "999", message: { id: "old1", threadId: "t", internalDate: Date.UTC(2026, 0, 1), subject: "Old" } },
		{ id: "1003", message: { id: "new1", threadId: "t9", internalDate: Date.UTC(2026, 0, 2), subject: "New" } },
		{
			id: "1004",
			message: { id: "sent1", threadId: "t9", internalDate: Date.UTC(2026, 0, 2), subject: "Re", labels: ["SENT"] },
		},
		{
			id: "1005",
			message: { id: "spam1", threadId: "t8", internalDate: Date.UTC(2026, 0, 2), subject: "Win", labels: ["SPAM"] },
		},
	];
	const f = fixture({ claims: [claim({ state: "live", historyId: "1000" })], gmail });
	await f.mailboxes.pass(signal);
	expect(f.order).toEqual(["new1"]);
	expect(f.stored.get("new1")?.imported).toBe(false);
	expect(f.finished).toEqual([expect.objectContaining({ outcome: "current", historyId: "1010" })]);
});

it("starts a fresh list from the newest message when Gmail no longer has the mark, without storing twice", async () => {
	const gmail = new FakeGmail(3);
	gmail.historyGone = true;
	gmail.historyId = "2000";
	const f = fixture({ claims: [claim({ state: "live", historyId: "10" })], gmail, known: ["m0002"] });
	await f.mailboxes.pass(signal);
	expect(f.order).toEqual(["m0003", "m0001"]);
	expect(f.stored.get("m0003")?.imported).toBe(true);
	expect(f.finished).toEqual([expect.objectContaining({ outcome: "current", historyId: "2000" })]);
});

it("asks for a new sign-in when Google refuses the token, and reads nothing", async () => {
	const gmail = new FakeGmail(3);
	gmail.tokenRefused = true;
	const f = fixture({ claims: [claim()], gmail });
	const outcome = await f.mailboxes.pass(signal);
	expect(outcome.refused).toBe(1);
	expect(f.finished).toEqual([expect.objectContaining({ outcome: "refused", error: GMAIL_SIGN_IN_AGAIN })]);
	expect(gmail.calls).toEqual(["POST /token"]);
	expect(f.order).toEqual([]);
});

function send(overrides: Record<string, unknown> = {}) {
	return {
		mailId: "66666666-6666-4666-8666-666666666666",
		leaseId: "77777777-7777-4777-8777-777777777777",
		attemptCount: 1,
		mailboxId: "33333333-3333-4333-8333-333333333333",
		address: ADDRESS,
		fromName: "Olivia Owner at Nordlys",
		to: ["customer@example.org"],
		cc: [],
		subject: "Re: Your order",
		text: "On its way",
		headers: { "In-Reply-To": "<q1@example.org>", References: "<root@example.org> <q1@example.org>" },
		gmailThreadId: "thread1",
		draftId: null,
		draftMessageId: null,
		companyId: COMPANY,
		environmentId: "22222222-2222-4222-8222-222222222222",
		secretId: "55555555-5555-4555-8555-555555555555",
		secretVersion: 1,
		keyId: "k1",
		encryptedEnvelopeBase64: envelope.toString("base64"),
		envelopeSha256: createHash("sha256").update(envelope).digest("hex"),
		...overrides,
	};
}

it("sends a reply through Gmail in the thread it answers and records how it left", async () => {
	const gmail = new FakeGmail(0);
	const f = fixture({ claims: [], gmail, sends: [send()] });
	const outcome = await f.mailboxes.pass(signal);
	expect(outcome.sent).toBe(1);
	expect(gmail.sent).toHaveLength(1);
	expect(gmail.sent[0]?.threadId).toBe("thread1");
	const raw = gmail.sent[0]?.raw ?? "";
	expect(raw).toContain('From: "Olivia Owner at Nordlys" <owner@gmail.com>\r\n');
	expect(raw).toContain("To: customer@example.org\r\n");
	expect(raw).toContain("Subject: Re: Your order\r\n");
	expect(raw).toContain("In-Reply-To: <q1@example.org>\r\n");
	expect(raw).toContain("References: <root@example.org> <q1@example.org>\r\n");
	expect(raw).toContain("Message-ID: <66666666-6666-4666-8666-666666666666.gmail@qorpera.com>\r\n");
	expect(Buffer.from(raw.split("\r\n\r\n")[1] ?? "", "base64").toString("utf8")).toBe("On its way");
	expect(f.completed).toEqual([
		{
			mailId: "66666666-6666-4666-8666-666666666666",
			lease: "77777777-7777-4777-8777-777777777777",
			gmailId: "sent1",
			gmailThreadId: "thread1",
			messageId: "<sent1@mail.gmail.com>",
		},
	]);
});

it("never queues again a send Gmail confirmed, and finds it again instead of sending twice", async () => {
	const gmail = new FakeGmail(0);
	const lost = fixture({ claims: [], gmail, sends: [send()], completionFailures: 3 });
	const outcome = await lost.mailboxes.pass(signal);
	expect(gmail.sent).toHaveLength(1);
	expect(lost.failed).toEqual([]);
	expect(lost.completed).toEqual([]);
	expect(outcome.failed).toBe(1);
	const retried = fixture({ claims: [], gmail, sends: [send()], completionFailures: 2 });
	expect((await retried.mailboxes.pass(signal)).sent).toBe(1);
	expect(retried.completed).toHaveLength(1);
	expect(gmail.sent).toHaveLength(2);
	const again = fixture({ claims: [], gmail, sends: [send({ attemptCount: 2 })] });
	expect((await again.mailboxes.pass(signal)).sent).toBe(1);
	expect(gmail.sent).toHaveLength(2);
	expect(again.completed).toEqual([expect.objectContaining({ gmailId: "sent1", gmailThreadId: "thread1" })]);
	const fresh = fixture({ claims: [], gmail: new FakeGmail(0), sends: [send({ attemptCount: 2 })] });
	await fresh.mailboxes.pass(signal);
	expect(fresh.completed).toHaveLength(1);
});

it("sends through a Gmail draft it records first, and a reclaim never sends that draft twice", async () => {
	const gmail = new FakeGmail(0);
	const lost = fixture({ claims: [], gmail, sends: [send()], completionFailures: 3 });
	await lost.mailboxes.pass(signal);
	expect(lost.drafts).toEqual([
		{
			mailId: "66666666-6666-4666-8666-666666666666",
			lease: "77777777-7777-4777-8777-777777777777",
			draftId: "draft1",
			draftMessageId: "sent1",
		},
	]);
	expect(gmail.sent).toHaveLength(1);
	expect(gmail.drafts.size).toBe(0);
	const reclaimed = fixture({
		claims: [],
		gmail,
		sends: [send({ attemptCount: 2, draftId: "draft1", draftMessageId: "sent1" })],
	});
	expect((await reclaimed.mailboxes.pass(signal)).sent).toBe(1);
	expect(gmail.sent).toHaveLength(1);
	expect(reclaimed.drafts).toEqual([]);
	expect(reclaimed.completed).toEqual([expect.objectContaining({ gmailId: "sent1", gmailThreadId: "thread1" })]);
	gmail.drafts.set("draft7", { raw: "From: x\r\n\r\nWaiting", threadId: "thread1", messageId: "sent7" });
	const waiting = fixture({
		claims: [],
		gmail,
		sends: [send({ attemptCount: 2, draftId: "draft7", draftMessageId: "sent7" })],
	});
	expect((await waiting.mailboxes.pass(signal)).sent).toBe(1);
	expect(gmail.sent).toHaveLength(2);
	expect(waiting.completed).toEqual([expect.objectContaining({ gmailId: "sent7" })]);
	const gone = fixture({
		claims: [],
		gmail: new FakeGmail(0),
		sends: [send({ attemptCount: 2, draftId: "draft9", draftMessageId: "sent9" })],
	});
	await gone.mailboxes.pass(signal);
	expect(gone.completed).toEqual([]);
	expect(gone.failed).toEqual([expect.objectContaining({ retryable: false, refused: false })]);
});

it("finds the draft a lost record left behind and sends it, so one email leaves and no draft stays", async () => {
	const gmail = new FakeGmail(0);
	const first = fixture({ claims: [], gmail, sends: [send()], recordFailures: 1 });
	await first.mailboxes.pass(signal);
	expect(gmail.sent).toHaveLength(0);
	expect(gmail.drafts.size).toBe(1);
	expect(first.completed).toEqual([]);
	expect(first.failed).toEqual([expect.objectContaining({ retryable: true, refused: false })]);
	const again = fixture({ claims: [], gmail, sends: [send({ attemptCount: 2 })] });
	expect((await again.mailboxes.pass(signal)).sent).toBe(1);
	expect(again.drafts).toEqual([expect.objectContaining({ draftId: "draft1", draftMessageId: "sent1" })]);
	expect(gmail.sent).toHaveLength(1);
	expect(gmail.drafts.size).toBe(0);
	expect(again.completed).toEqual([expect.objectContaining({ gmailId: "sent1" })]);
});

it("deletes the draft it made when the database says another vault holds the email, never one it found", async () => {
	const gmail = new FakeGmail(0);
	const made = fixture({ claims: [], gmail, sends: [send()], notRecorded: true });
	await made.mailboxes.pass(signal);
	expect(made.drafts).toHaveLength(1);
	expect(gmail.drafts.size).toBe(0);
	expect(gmail.sent).toHaveLength(0);
	expect(made.completed).toEqual([]);
	const lost = fixture({ claims: [], gmail, sends: [send()], recordFailures: 1 });
	await lost.mailboxes.pass(signal);
	expect(gmail.drafts.size).toBe(1);
	const found = fixture({ claims: [], gmail, sends: [send({ attemptCount: 2 })], notRecorded: true });
	await found.mailboxes.pass(signal);
	expect(found.drafts).toEqual([expect.objectContaining({ draftId: "draft2" })]);
	expect(gmail.drafts.size).toBe(1);
	expect(gmail.sent).toHaveLength(0);
});

it("never marks an unsent draft as sent, and deletes a draft Gmail refuses for good", async () => {
	const gmail = new FakeGmail(0);
	const lost = fixture({ claims: [], gmail, sends: [send()], recordFailures: 1 });
	await lost.mailboxes.pass(signal);
	gmail.draftSendStatus = 500;
	const unsent = fixture({ claims: [], gmail, sends: [send({ attemptCount: 2 })] });
	await unsent.mailboxes.pass(signal);
	expect(unsent.completed).toEqual([]);
	expect(unsent.failed).toEqual([expect.objectContaining({ retryable: true })]);
	expect(gmail.sent).toHaveLength(0);
	expect(gmail.drafts.size).toBe(1);
	gmail.draftSendStatus = 400;
	const refused = fixture({
		claims: [],
		gmail,
		sends: [send({ attemptCount: 3, draftId: "draft1", draftMessageId: "sent1" })],
	});
	await refused.mailboxes.pass(signal);
	expect(refused.completed).toEqual([]);
	expect(refused.failed).toEqual([expect.objectContaining({ retryable: false, refused: false })]);
	expect(gmail.sent).toHaveLength(0);
	expect(gmail.drafts.size).toBe(0);
});

it("holds a send for a new sign-in when Google refuses the token", async () => {
	const gmail = new FakeGmail(0);
	gmail.tokenRefused = true;
	const f = fixture({ claims: [], gmail, sends: [send()] });
	await f.mailboxes.pass(signal);
	expect(gmail.sent).toHaveLength(0);
	expect(f.failed).toEqual([expect.objectContaining({ error: GMAIL_SIGN_IN_AGAIN, retryable: true, refused: true })]);
});

it("writes a Gmail message as the mail door stores company mail, within 256 KiB", () => {
	const html = `<p>${"x".repeat(400_000)}</p>`;
	const mail = gmailMailMessage("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", {
		id: "m1",
		threadId: "t1",
		internalDate: String(Date.UTC(2026, 1, 3, 4, 5, 6)),
		payload: {
			mimeType: "multipart/mixed",
			headers: [
				{ name: "From", value: '"Shop, Inc" <Orders@Shop.example>' },
				{ name: "To", value: 'owner@gmail.com, "B, C" <b@example.org>' },
				{ name: "Subject", value: "Your order" },
				{ name: "Message-ID", value: "<m1@shop.example>" },
				{ name: "References", value: "<a@x> <b@x>" },
				{ name: "In-Reply-To", value: "<b@x>" },
				{ name: "List-Id", value: "<news.shop.example>" },
				{
					name: "Authentication-Results",
					value: "mx.google.com; dkim=pass header.i=@shop.example; spf=pass; dmarc=fail",
				},
			],
			parts: [
				{ mimeType: "text/plain", body: { data: base64url("Hello") } },
				{ mimeType: "text/html", body: { data: base64url(html) } },
				{
					mimeType: "application/pdf",
					filename: "invoice.pdf",
					headers: [{ name: "Content-Disposition", value: "attachment; filename=invoice.pdf" }],
					body: { attachmentId: "att-1", size: 1234 },
				},
			],
		},
	});
	expect(Buffer.byteLength(mail.text, "utf8")).toBeLessThanOrEqual(GMAIL_MESSAGE_MAX_BYTES);
	expect(mail.threadId).toBe("t1");
	expect(mail.receivedAt.toISOString()).toBe("2026-02-03T04:05:06.000Z");
	const stored = JSON.parse(mail.text) as Record<string, unknown>;
	expect(Object.keys(stored).slice(0, 4)).toEqual(["schema", "emailId", "subject", "from"]);
	expect(stored).toMatchObject({
		schema: "qorpera.mail/v1",
		subject: "Your order",
		from: '"Shop, Inc" <Orders@Shop.example>',
		to: ["owner@gmail.com", "b@example.org"],
		messageId: "<m1@shop.example>",
		inReplyTo: "<b@x>",
		references: "<a@x> <b@x>",
		automated: true,
		authentication: { spf: "pass", dkim: "pass", dmarc: "fail" },
		attachments: [
			{
				id: "att-1",
				filename: "invoice.pdf",
				contentType: "application/pdf",
				size: 1234,
				disposition: "attachment",
				contentId: null,
			},
		],
		truncated: true,
		text: "Hello",
	});
	expect(typeof stored.html).toBe("string");
});

const WEB = "https://app.qorpera.test";
const services: HttpCloudSecretBrokerService[] = [];
afterEach(async () => {
	for (const service of services.splice(0)) await service.close();
});

function signIn(answer: Record<string, unknown>) {
	const identity = {
		companyId: COMPANY,
		environmentId: randomUUID(),
		secretId: randomUUID(),
		version: 1,
		keyId: "k1",
	};
	const ticketId = randomUUID();
	const capability = randomBytes(32).toString("base64url");
	const keyring = new CloudSecretKeyring({ k1: randomBytes(32) });
	const description: CloudSecretCaptureDescription = {
		schema: "qorpera.cloud-secret-capture-description/v1",
		ticketId,
		...identity,
		ownerKind: "company",
		ownerUserId: null,
		connectorId: "gmail",
		secretName: "mailbox-0a1b2c3d4e",
		purpose: "Google mail in the Mailbox",
		expiresAt: "2099-01-01T00:00:00.000Z",
	};
	const sealed: { envelope: Uint8Array; address: string }[] = [];
	const authority: CloudSecretBrokerAuthority = {
		describeCapture: vi.fn(async () => description),
		completeCapture: vi.fn(async () => {
			throw new Error("a Mailbox ticket is never sealed as a plain connection");
		}),
		authorizeOperation: vi.fn(async () => {
			throw new Error("not used");
		}),
		authorizeRepositoryCredential: vi.fn(async () => {
			throw new Error("not used");
		}),
		describeGoogleMailboxTicket: vi.fn(async (ticket) =>
			ticket === ticketId ? { schema: "qorpera.google-mailbox-ticket/v1", mailboxId: null, address: null } : null,
		),
		completeGoogleMailboxCapture: vi.fn(async (_ticket, _capability, sealedEnvelope, _digest, address) => {
			sealed.push({ envelope: Uint8Array.from(sealedEnvelope), address });
			return answer;
		}),
	};
	const gmail = new FakeGmail(0);
	const oauth = new CloudConnectorOAuthFlows({
		clients: { google },
		callbackUrl: "https://secrets.qorpera.test/v1/oauth/callback",
		returnOrigins: [WEB],
		fetch: vi.fn<typeof fetch>(async (target) => {
			const url = new URL(String(target));
			if (url.href === "https://oauth2.googleapis.com/token")
				return Response.json({
					access_token: "ya29.access-token-value-1234567890",
					refresh_token: "1//refresh-token-value-1234567890",
				});
			if (url.href === "https://openidconnect.googleapis.com/v1/userinfo") return Response.json({ email: ADDRESS });
			throw new Error(`unexpected ${url.href}`);
		}),
	});
	const broker = new CloudSecretBroker({ authority, keyring, adapters: [] });
	const service = new HttpCloudSecretBrokerService(broker, randomBytes(32).toString("base64url"), {
		oauth,
		memberOrigins: [WEB],
		gmailMailbox: new GmailMailboxClient({ client: google, fetch: gmail.fetch }),
	});
	services.push(service);
	const proof = randomBytes(32).toString("base64url");
	return { ticketId, capability, service, sealed, authority, proof, keyring, identity };
}

async function connect(f: ReturnType<typeof signIn>) {
	const port = await f.service.start();
	const started = (await (
		await fetch(`http://127.0.0.1:${port}/v1/oauth/${f.ticketId}/start?company=${COMPANY}`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: WEB },
			body: JSON.stringify({
				schema: "qorpera.cloud-connector-oauth-start/v2",
				captureCapability: f.capability,
				browserProofSha256: createHash("sha256").update(f.proof).digest("hex"),
				returnTo: `${WEB}/`,
			}),
		})
	).json()) as Record<string, string>;
	const state = new URL(started.authorizationUrl ?? "").searchParams.get("state");
	const callback = await fetch(`http://127.0.0.1:${port}/v1/oauth/callback?state=${state}&code=4%2Fcode-value`, {
		redirect: "manual",
	});
	const confirmation = /confirmation=([A-Za-z0-9_-]{43})/.exec(callback.headers.get("location") ?? "")?.[1] ?? "";
	return fetch(`http://127.0.0.1:${port}/v1/oauth/${f.ticketId}/confirm?company=${COMPANY}`, {
		method: "POST",
		headers: { "content-type": "application/json", origin: WEB },
		body: JSON.stringify({ schema: "qorpera.cloud-connector-oauth-confirm/v1", confirmation, browserProof: f.proof }),
	});
}

it("creates the Google mailbox from the sign-in, with the address Google names, sealed in the vault", async () => {
	const mailboxId = randomUUID();
	const f = signIn({ schema: "qorpera.google-mailbox-connected/v1", outcome: "created", mailboxId, address: ADDRESS });
	const confirmed = await connect(f);
	expect(confirmed.status).toBe(200);
	expect(await confirmed.json()).toEqual({
		schema: "qorpera.cloud-connector-oauth-confirmed/v1",
		connectorId: "gmail",
		accountLabel: ADDRESS,
		mailbox: { mailboxId, address: ADDRESS, outcome: "created" },
	});
	expect(f.authority.completeCapture).not.toHaveBeenCalled();
	expect(f.sealed).toHaveLength(1);
	expect(f.sealed[0]?.address).toBe(ADDRESS);
	expect(Buffer.from(f.sealed[0]?.envelope ?? []).toString("latin1")).not.toContain("refresh-token-value");
	const opened = await f.keyring.use(f.sealed[0]?.envelope ?? new Uint8Array(), f.identity, async (fields) => ({
		...fields,
	}));
	expect(opened).toEqual({ refresh_token: "1//refresh-token-value-1234567890" });
	f.keyring.close();
});

it("re-links the mailbox when the same account signs in again", async () => {
	const mailboxId = randomUUID();
	const f = signIn({
		schema: "qorpera.google-mailbox-connected/v1",
		outcome: "relinked",
		mailboxId,
		address: ADDRESS,
	});
	expect(((await (await connect(f)).json()) as { mailbox: { outcome: string } }).mailbox.outcome).toBe("relinked");
	f.keyring.close();
});

it("refuses a different account on sign-in again, and an address another company brought in", async () => {
	const wrong = signIn({
		schema: "qorpera.google-mailbox-refused/v1",
		reason: "wrong_account",
		address: "first@gmail.com",
		message: "Sign in with first@gmail.com.",
	});
	const refused = await connect(wrong);
	expect(refused.status).toBe(403);
	expect(await refused.json()).toEqual({
		schema: "qorpera.cloud-connector-oauth-failed/v1",
		reason: "wrong_account",
		address: "first@gmail.com",
		message: "Sign in with first@gmail.com.",
	});
	wrong.keyring.close();
	const taken = signIn({
		schema: "qorpera.google-mailbox-refused/v1",
		reason: "address_taken",
		message: "This address is already brought in by another company.",
	});
	expect(await (await connect(taken)).json()).toEqual({
		schema: "qorpera.cloud-connector-oauth-failed/v1",
		reason: "address_taken",
		message: "This address is already brought in by another company.",
	});
	taken.keyring.close();
});
