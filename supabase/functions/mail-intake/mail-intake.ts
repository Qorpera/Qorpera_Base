/* Mail intake (build step M2a; contract section 19, 2026-09-29 amendment "events wake agents", item 9; design
 * deploy/first-node/RUNTIME-EVENT-INTAKE.md, "Mail (M2)").
 *
 * POST /mail-intake: the mail provider's (Resend's) webhook for a received message. The function checks the
 * webhook's signature (Standard Webhooks, as Svix sends it) with the platform's signing secret, fetches the whole
 * message from the provider's API with the platform's key, writes it as at most 256 KiB of JSON text (the subject,
 * the thread, whether it was sent automatically and the trust results before the bodies) and hands it with all its recipients (To, Cc, Bcc and the envelope) to the
 * database's mail door, qorpera_receive_mail, which stores it once in each live mailbox among them and drops the
 * rest. Answers: 200 when every recipient is settled (stored, a duplicate, unknown or paused; mail to a paused
 * mailbox and mail the provider no longer has are dropped; other event types are ignored), 401 for a bad or stale
 * signature, 400 for a payload that is not JSON or a received-mail event without a valid message id, 405, 413,
 * 429 with Retry-After when a mailbox is over its limits, and 503 when
 * mail is switched off or the provider or database cannot be reached, so the provider retries. A message the
 * database calls malformed is logged and settled: a retry would not change it. */

export const MAX_WEBHOOK_BYTES = 64 * 1024;
export const MAX_MESSAGE_BYTES = 256 * 1024;
const TOLERANCE_SECONDS = 5 * 60;
const MAX_RECIPIENTS = 200;
const MAX_LIST = 50;
const EMAIL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ADDRESS = /^[^\s@<>]{1,64}@[^\s@<>]{1,255}$/;

type Json = Record<string, unknown>;

/** The database's mail door: the message's recipients and its JSON text, stored as those exact bytes. */
export interface MailStore {
	receive(emailId: string, recipients: string[], message: string): Promise<Json>;
}

/** The provider's received-message API: the message, or null when the provider has no such message. */
export interface MailProvider {
	fetch(emailId: string): Promise<Json | null>;
}

export class MailStoreError extends Error {
	readonly code: string | undefined;
	constructor(code: string | undefined, message: string) {
		super(message);
		this.name = "MailStoreError";
		this.code = code;
	}
}

export interface MailIntake {
	/** The webhook signing secret, `whsec_<base64>`. */
	secret: string;
	store: MailStore;
	provider: MailProvider;
	/** Seconds since the epoch; a parameter for tests. */
	now?: () => number;
}

function json(body: Json, status: number, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
	});
}

/** The body, or null when it is over the limit, declared or not. */
async function readBody(request: Request, limit: number): Promise<Uint8Array | null> {
	const declared = request.headers.get("content-length");
	if (declared !== null && /^\d+$/.test(declared) && Number(declared) > limit) return null;
	if (!request.body) return new Uint8Array(0);
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > limit) {
			await reader.cancel().catch(() => undefined);
			return null;
		}
		chunks.push(value);
	}
	const body = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

function fromBase64(value: string): Uint8Array | null {
	try {
		const binary = atob(value);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
		return bytes;
	} catch {
		return null;
	}
}

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	return btoa(binary);
}

function equalStrings(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let difference = 0;
	for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
	return difference === 0;
}

/** Standard Webhooks: HMAC-SHA256 over `<id>.<timestamp>.<body>` with the secret's bytes; the header lists
 * space-separated `v1,<base64>` signatures, any of which may match. */
export async function verifySignature(
	secret: string,
	headers: Headers,
	body: Uint8Array,
	nowSeconds: number,
): Promise<boolean> {
	const id = headers.get("svix-id") ?? headers.get("webhook-id");
	const timestamp = headers.get("svix-timestamp") ?? headers.get("webhook-timestamp");
	const signatures = headers.get("svix-signature") ?? headers.get("webhook-signature");
	if (!id || !timestamp || !signatures || !/^\d{1,12}$/.test(timestamp) || id.length > 256) return false;
	if (Math.abs(nowSeconds - Number(timestamp)) > TOLERANCE_SECONDS) return false;
	const key = fromBase64(secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret);
	if (!key || key.length < 16) return false;
	const signingKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const prefix = new TextEncoder().encode(`${id}.${timestamp}.`);
	const signed = new Uint8Array(prefix.length + body.length);
	signed.set(prefix);
	signed.set(body, prefix.length);
	const expected = toBase64(new Uint8Array(await crypto.subtle.sign("HMAC", signingKey, signed)));
	return signatures
		.split(" ")
		.some((entry) => entry.startsWith("v1,") && equalStrings(entry.slice(3), expected));
}

/** A bare address from `name <address>` or `address`, lowercased; null when it is none, or holds control
 * characters or half a surrogate pair (the database could not take it). */
export function bareAddress(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const angle = /<([^<>]*)>\s*$/.exec(value);
	const address = (angle ? angle[1] : value).trim().toLowerCase();
	return ADDRESS.test(address) && !/[\u0000-\u001f\u007f]/.test(address) && clean(address) === address
		? address
		: null;
}

function addresses(value: unknown, limit = MAX_RECIPIENTS): string[] {
	return Array.isArray(value)
		? value
				.map(bareAddress)
				.filter((address): address is string => address !== null)
				.slice(0, limit)
		: [];
}

/** Text the database can hold: no NUL, and no half of a surrogate pair. */
export function clean(value: string): string {
	return value
		.replace(/\u0000/g, "")
		.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd");
}

/** The first `limit` UTF-16 units, never ending inside a surrogate pair. */
function cut(value: string, limit: number): string {
	const end = limit > 0 && limit < value.length && /[\ud800-\udbff]/.test(value[limit - 1]) ? limit - 1 : limit;
	return value.slice(0, Math.max(0, end));
}

function text(value: unknown, limit: number): string | null {
	return typeof value === "string" ? cut(clean(value), limit) : null;
}

/** The HTML body as text: the provider may send it as a data URI. */
function htmlBody(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const data = /^data:[^,]*?(;base64)?,(.*)$/s.exec(value);
	if (!data) return value;
	if (!data[1]) {
		try {
			return decodeURIComponent(data[2]);
		} catch {
			return null;
		}
	}
	const bytes = fromBase64(data[2]);
	return bytes ? new TextDecoder("utf-8", { fatal: false }).decode(bytes) : null;
}

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/** Sent automatically: an Auto-Submitted other than "no" (RFC 3834), a bulk, list, junk or auto-reply Precedence, or
 * a mailing list. Agents never answer it: answering an auto-reply is how mail loops start. */
function automated(header: (name: string) => string | null): boolean {
	const submitted = header("auto-submitted")?.split(";")[0].trim().toLowerCase();
	const precedence = header("precedence")?.trim().toLowerCase() ?? "";
	return (
		(!!submitted && submitted !== "no") ||
		["bulk", "junk", "list", "auto_reply"].includes(precedence) ||
		!!header("list-id")?.trim()
	);
}

/** The message the mail door stores: headers that matter for replies and threads, the text and HTML bodies cut to
 * fit 256 KiB of JSON (HTML goes first), and the attachments' descriptions. */
export function normalizeMessage(emailId: string, received: Json): Json {
	const headers =
		received.headers && typeof received.headers === "object" && !Array.isArray(received.headers)
			? (received.headers as Json)
			: {};
	// Header names in any case.
	const named = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
	const header = (name: string) => text(named.get(name), 2048);
	const authentication =
		received.authentication && typeof received.authentication === "object" && !Array.isArray(received.authentication)
			? (received.authentication as Json)
			: {};
	const attachments = Array.isArray(received.attachments)
		? received.attachments.slice(0, 50).flatMap((item) => {
				if (!item || typeof item !== "object" || Array.isArray(item)) return [];
				const attachment = item as Json;
				return [
					{
						id: text(attachment.id, 128),
						filename: text(attachment.filename, 256),
						contentType: text(attachment.content_type, 256),
						size: typeof attachment.size === "number" && Number.isSafeInteger(attachment.size) ? attachment.size : null,
						disposition: text(attachment.content_disposition, 32),
						contentId: text(attachment.content_id, 256),
					},
				];
			})
		: [];
	const html = htmlBody(received.html);
	// Key order is kept (the text is stored as written): what a reader needs first, the bodies last.
	const message: Json = {
		schema: "qorpera.mail/v1",
		emailId,
		subject: text(received.subject, 998),
		from: text(received.from, 998),
		to: addresses(received.to, MAX_LIST),
		cc: addresses(received.cc, MAX_LIST),
		replyTo: addresses(received.reply_to, MAX_LIST),
		receivedAt: text(received.created_at, 64),
		messageId: text(received.message_id, 998),
		inReplyTo: header("in-reply-to"),
		references: header("references"),
		autoSubmitted: header("auto-submitted"),
		precedence: header("precedence"),
		listId: header("list-id"),
		automated: automated(header),
		authentication: {
			spf: text(authentication.spf, 32),
			dkim: text(authentication.dkim, 32),
			dmarc: text(authentication.dmarc, 32),
		},
		attachments,
		truncated: false,
		text: typeof received.text === "string" ? clean(received.text) : null,
		html: html === null ? null : clean(html),
	};
	// Fit the JSON text: HTML is cut before the text, each to the bytes left once the rest is counted.
	for (const field of ["html", "text"] as const) {
		if (bytes(message) <= MAX_MESSAGE_BYTES) break;
		const value = message[field];
		if (typeof value !== "string") continue;
		message.truncated = true;
		const room = MAX_MESSAGE_BYTES - bytes({ ...message, [field]: "" }) + 2;
		let keep = value.length;
		let size = bytes(value);
		while (keep > 0 && size > room) {
			keep = Math.min(keep - 1, Math.floor((keep * room) / size));
			size = bytes(cut(value, keep));
		}
		message[field] = keep > 0 ? cut(value, keep) : null;
	}
	return message;
}

/** The Edge Function. */
export async function handleMailIntake(request: Request, intake: MailIntake): Promise<Response> {
	if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, { allow: "POST" });
	const body = await readBody(request, MAX_WEBHOOK_BYTES);
	if (!body) return json({ error: "The webhook is too large" }, 413);
	const now = intake.now ?? (() => Math.floor(Date.now() / 1000));
	if (!(await verifySignature(intake.secret, request.headers, body, now())))
		return json({ error: "The signature does not match" }, 401);
	let event: Json;
	try {
		const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
		event = parsed as Json;
	} catch {
		return json({ error: "The webhook is malformed" }, 400);
	}
	// Other event types (sending, bounces) are not mail to a mailbox.
	if (event.type !== "email.received") return json({ ignored: true }, 200);
	const data = event.data && typeof event.data === "object" && !Array.isArray(event.data) ? (event.data as Json) : null;
	const emailId = data?.email_id;
	if (!data || typeof emailId !== "string" || !EMAIL_ID.test(emailId))
		return json({ error: "The webhook is malformed" }, 400);
	// All of them, the envelope first (it is where the message was delivered): the database knows which are
	// mailboxes.
	const recipients = [
		...new Set([
			...addresses(data.received_for),
			...addresses(data.bcc),
			...addresses(data.to),
			...addresses(data.cc),
		]),
	].slice(0, MAX_RECIPIENTS);
	if (recipients.length === 0) return json({ stored: 0 }, 200);

	let received: Json | null;
	try {
		received = await intake.provider.fetch(emailId);
	} catch (error) {
		console.error(`mail-intake: fetch ${emailId}: ${error instanceof Error ? error.message : String(error)}`);
		return json({ error: "Mail is unavailable right now" }, 503);
	}
	if (!received) return json({ stored: 0, missing: true }, 200);
	const message = JSON.stringify(normalizeMessage(emailId, received));

	let result: Json;
	try {
		result = await intake.store.receive(emailId, recipients, message);
	} catch (error) {
		if (error instanceof MailStoreError && error.code === "22023") {
			// A retry would send the same message: log it and settle.
			console.error(`mail-intake: ${emailId} refused as malformed: ${error.message}`);
			return json({ stored: 0, refused: true }, 200);
		}
		console.error(`mail-intake: ${error instanceof Error ? error.message : String(error)}`);
		return json({ error: "Mail is unavailable right now" }, 503);
	}
	if (result.outcome === "unavailable")
		return json({ error: "Mail is unavailable right now" }, 503, { "retry-after": "300" });
	if (result.outcome !== "settled" || !Array.isArray(result.results)) {
		console.error(`mail-intake: unexpected answer ${JSON.stringify(result.outcome)}`);
		return json({ error: "Mail is unavailable right now" }, 503);
	}
	let stored = 0;
	let retryAfter = 0;
	for (const item of result.results as Json[]) {
		if (item?.outcome === "accepted") stored += 1;
		else if (item?.outcome === "limited")
			retryAfter = Math.max(
				retryAfter,
				typeof item.retryAfterSeconds === "number" && Number.isInteger(item.retryAfterSeconds)
					? item.retryAfterSeconds
					: 60,
			);
	}
	// A retry stores the limited mailboxes; the others answer duplicate.
	if (retryAfter > 0)
		return json({ error: "A mailbox is over its limits" }, 429, { "retry-after": String(retryAfter) });
	return json({ stored }, 200);
}
