/* Mail intake (build step M2a; contract section 19, 2026-09-29 amendment "events wake agents", item 9; design
 * deploy/first-node/RUNTIME-EVENT-INTAKE.md, "Mail (M2)").
 *
 * POST /mail-intake: the mail provider's (Resend's) webhook for a received message. The function checks the
 * webhook's signature (Standard Webhooks, as Svix sends it) with the platform's signing secret, fetches the whole
 * message from the provider's API with the platform's key, bounds it to 256 KiB of JSON, and hands it to the
 * database's mail door, qorpera_receive_mail, once for each recipient. The database decides which recipient is a
 * mailbox; any other is dropped. Answers: 200 when every recipient is settled (stored, a duplicate, unknown or
 * paused), 401 for a bad or stale signature, 400 for a payload that is not a received-mail event, 429 with
 * Retry-After when a mailbox is over its limits, 503 when mail is switched off or the provider or database cannot
 * be reached, so the provider retries. */

export const MAX_WEBHOOK_BYTES = 64 * 1024;
export const MAX_MESSAGE_BYTES = 256 * 1024;
const TOLERANCE_SECONDS = 5 * 60;
const MAX_RECIPIENTS = 20;
const ADDRESS = /^[^\s@<>]{1,64}@[^\s@<>]{1,255}$/;

type Json = Record<string, unknown>;

/** The database's mail door. */
export interface MailStore {
	receive(emailId: string, recipient: string, message: Json): Promise<Json>;
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

/** A bare address from `name <address>` or `address`, lowercased; null when it is none. */
export function bareAddress(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const angle = /<([^<>]*)>\s*$/.exec(value);
	const address = (angle ? angle[1] : value).trim().toLowerCase();
	return ADDRESS.test(address) ? address : null;
}

function addresses(value: unknown): string[] {
	return Array.isArray(value)
		? value.map(bareAddress).filter((address): address is string => address !== null)
		: [];
}

function text(value: unknown, limit: number): string | null {
	return typeof value === "string" ? value.slice(0, limit) : null;
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

/** The message the mail door stores: headers that matter for replies and threads, the text and HTML bodies cut to
 * fit 256 KiB of JSON (HTML goes first), and the attachments' descriptions. */
export function normalizeMessage(emailId: string, received: Json): Json {
	const headers =
		received.headers && typeof received.headers === "object" && !Array.isArray(received.headers)
			? (received.headers as Json)
			: {};
	const header = (name: string) => text(headers[name], 2048);
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
	const message: Json = {
		schema: "qorpera.mail/v1",
		emailId,
		messageId: text(received.message_id, 998),
		from: text(received.from, 998),
		to: addresses(received.to),
		cc: addresses(received.cc),
		replyTo: addresses(received.reply_to),
		subject: text(received.subject, 998),
		receivedAt: text(received.created_at, 64),
		inReplyTo: header("in-reply-to"),
		references: header("references"),
		authentication: {
			spf: text(authentication.spf, 32),
			dkim: text(authentication.dkim, 32),
			dmarc: text(authentication.dmarc, 32),
		},
		attachments,
		text: typeof received.text === "string" ? received.text : null,
		html: htmlBody(received.html),
		truncated: false,
	};
	// Fit the JSON: HTML is cut before the text, each to the bytes left once the rest is counted.
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
			size = bytes(value.slice(0, keep));
		}
		message[field] = keep > 0 ? value.slice(0, keep) : null;
	}
	return message;
}

/** The Edge Function. */
export async function handleMailIntake(request: Request, intake: MailIntake): Promise<Response> {
	if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, { allow: "POST" });
	const declared = request.headers.get("content-length");
	if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MAX_WEBHOOK_BYTES)
		return json({ error: "The webhook is too large" }, 413);
	const body = new Uint8Array(await request.arrayBuffer());
	if (body.length > MAX_WEBHOOK_BYTES) return json({ error: "The webhook is too large" }, 413);
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
	if (!data || typeof emailId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(emailId))
		return json({ error: "The webhook is malformed" }, 400);
	const recipients = [
		...new Set([...addresses(data.to), ...addresses(data.cc), ...addresses(data.received_for)]),
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
	const message = normalizeMessage(emailId, received);

	let stored = 0;
	let retryAfter = 0;
	for (const recipient of recipients) {
		let result: Json;
		try {
			result = await intake.store.receive(emailId, recipient, message);
		} catch (error) {
			console.error(`mail-intake: ${error instanceof Error ? error.message : String(error)}`);
			return json({ error: "Mail is unavailable right now" }, 503);
		}
		switch (result.outcome) {
			case "accepted":
				stored += 1;
				break;
			case "duplicate":
			case "unknown":
			case "paused":
			case "too_large":
				break;
			case "limited":
				retryAfter = Math.max(
					retryAfter,
					typeof result.retryAfterSeconds === "number" && Number.isInteger(result.retryAfterSeconds)
						? result.retryAfterSeconds
						: 60,
				);
				break;
			case "unavailable":
				return json({ error: "Mail is unavailable right now" }, 503, { "retry-after": "300" });
			default:
				console.error(`mail-intake: unexpected outcome ${JSON.stringify(result.outcome)}`);
				return json({ error: "Mail is unavailable right now" }, 503);
		}
	}
	// A retry stores the limited recipients; the others answer duplicate.
	if (retryAfter > 0)
		return json({ error: "A mailbox is over its limits" }, 429, { "retry-after": String(retryAfter) });
	return json({ stored }, 200);
}
