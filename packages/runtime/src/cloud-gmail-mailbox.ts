import { createHash } from "node:crypto";
import { POSTGRES_UUID_PATTERN as UUID } from "@qorpera/contracts";
import { createGoogleAccessTokenExchange, type GoogleOAuthClient, headerValue } from "./cloud-connector-google.ts";
import {
	ConnectorRequestError,
	connectorRequest,
	decodeBase64Url,
	decodeUtf8,
	encodeBase64Url,
	jsonArray,
	jsonRecord,
	jsonString,
	parseJsonResponse,
	providerRefusal,
} from "./cloud-connector-http.ts";
import type { CloudSecretKeyring } from "./cloud-secret-crypto.ts";

export const GMAIL_ORIGIN = "https://gmail.googleapis.com";
export const GMAIL_IMPORT_BOUND = 50_000;
export const GMAIL_MESSAGE_MAX_BYTES = 256 * 1024;
export const GMAIL_LIST_PAGE = 100;
export const GMAIL_PASS_MESSAGES = 200;
export const GMAIL_PASS_BUDGET_MS = 20_000;
export const GMAIL_SENDS_PER_PASS = 10;
export const GMAIL_SIGN_IN_AGAIN = "Google asked you to sign in again.";
const GMAIL_FULL_MAX_BYTES = 16 * 1024 * 1024;
const GMAIL_IMPORT_QUERY = "-in:sent -in:draft -in:chats";
const SKIPPED_LABELS = new Set(["SENT", "DRAFT", "SPAM", "TRASH", "CHAT"]);
const DATABASE_DEADLINE_MS = 10_000;
const PASS_EVERY_MS = 60_000;
const GOOGLE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const HISTORY_ID = /^[0-9]{1,20}$/;
const PAGE_TOKEN = /^[\x21-\x7e]{1,512}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA = /^[0-9a-f]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MAILBOX_ADDRESS = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const ADDRESS = /^[^\s@<>]{1,64}@[^\s@<>]{1,255}$/;
const MAX_LIST = 50;

export class GmailSignInRefused extends Error {
	constructor() {
		super(GMAIL_SIGN_IN_AGAIN);
		this.name = "GmailSignInRefused";
	}
}

export class GmailHistoryGone extends Error {
	constructor() {
		super("Gmail no longer has the change list from that mark");
		this.name = "GmailHistoryGone";
	}
}

class GmailMailboxError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GmailMailboxError";
	}
}

type Json = Record<string, unknown>;

export interface GmailListedMessage {
	readonly id: string;
	readonly threadId: string | null;
}

export interface GmailProfile {
	readonly address: string;
	readonly historyId: string;
	readonly messagesTotal: number | null;
}

export interface GmailHistoryPage {
	readonly added: readonly GmailListedMessage[];
	readonly historyId: string;
	readonly next: string | null;
}

function refusalOf(error: unknown): unknown {
	if (error instanceof ConnectorRequestError && error.reason === "authorization_required") return new GmailSignInRefused();
	return error;
}

export class GmailMailboxApi {
	readonly #fetch: typeof fetch;
	readonly #bearer: string;

	constructor(options: { fetch: typeof fetch; bearer: string }) {
		this.#fetch = options.fetch;
		this.#bearer = options.bearer;
	}

	async #call(
		path: string,
		signal: AbortSignal,
		options: {
			query?: Record<string, string | readonly string[] | undefined>;
			method?: "GET" | "POST";
			body?: string;
			maximumBytes?: number;
		} = {},
	): Promise<Json> {
		const response = await connectorRequest({
			fetch: this.#fetch,
			origin: GMAIL_ORIGIN,
			path,
			query: options.query,
			method: options.method ?? "GET",
			headers: {
				authorization: `Bearer ${this.#bearer}`,
				...(options.body === undefined ? {} : { "content-type": "application/json" }),
			},
			...(options.body === undefined ? {} : { body: options.body }),
			signal,
			maximumBytes: options.maximumBytes,
			keepHeaders: ["x-ratelimit-remaining"],
		});
		if (response.status === 403) {
			const error = jsonRecord(jsonRecord(parseJsonResponse(response)).error);
			const reasons = jsonArray(error.errors).map((item) => jsonRecord(item).reason);
			if (reasons.some((reason) => reason === "rateLimitExceeded" || reason === "userRateLimitExceeded"))
				throw new ConnectorRequestError("rate_limited", "Gmail asked us to wait.");
			if (reasons.includes("insufficientPermissions")) throw new GmailSignInRefused();
		}
		if (response.status < 200 || response.status >= 300) throw refusalOf(providerRefusal(response, "Gmail"));
		return jsonRecord(parseJsonResponse(response));
	}

	async profile(signal: AbortSignal): Promise<GmailProfile> {
		const profile = await this.#call("/gmail/v1/users/me/profile", signal);
		const address = typeof profile.emailAddress === "string" ? profile.emailAddress.trim().toLowerCase() : "";
		const historyId = typeof profile.historyId === "string" ? profile.historyId : "";
		if (address.length > 254 || !MAILBOX_ADDRESS.test(address) || !HISTORY_ID.test(historyId))
			throw new GmailMailboxError("Gmail did not name the mailbox");
		const total = profile.messagesTotal;
		return {
			address,
			historyId,
			messagesTotal: typeof total === "number" && Number.isSafeInteger(total) && total >= 0 ? total : null,
		};
	}

	async list(
		pageToken: string | null,
		signal: AbortSignal,
	): Promise<{ messages: GmailListedMessage[]; next: string | null; estimate: number | null }> {
		const page = await this.#call("/gmail/v1/users/me/messages", signal, {
			query: {
				q: GMAIL_IMPORT_QUERY,
				maxResults: String(GMAIL_LIST_PAGE),
				includeSpamTrash: "false",
				...(pageToken === null ? {} : { pageToken }),
			},
		});
		const estimate = page.resultSizeEstimate;
		const next = typeof page.nextPageToken === "string" && PAGE_TOKEN.test(page.nextPageToken) ? page.nextPageToken : null;
		return {
			messages: listed(page.messages),
			next,
			estimate: typeof estimate === "number" && Number.isSafeInteger(estimate) && estimate >= 0 ? estimate : null,
		};
	}

	async history(startHistoryId: string, pageToken: string | null, signal: AbortSignal): Promise<GmailHistoryPage> {
		let page: Json;
		try {
			page = await this.#call("/gmail/v1/users/me/history", signal, {
				query: {
					startHistoryId,
					historyTypes: "messageAdded",
					maxResults: String(GMAIL_LIST_PAGE),
					...(pageToken === null ? {} : { pageToken }),
				},
			});
		} catch (error) {
			if (error instanceof ConnectorRequestError && error.reason === "not_found") throw new GmailHistoryGone();
			throw error;
		}
		const historyId = typeof page.historyId === "string" && HISTORY_ID.test(page.historyId) ? page.historyId : "";
		if (!historyId) throw new GmailMailboxError("Gmail's change list has no mark");
		const added: GmailListedMessage[] = [];
		for (const record of jsonArray(page.history))
			for (const item of jsonArray(jsonRecord(record).messagesAdded)) {
				const message = jsonRecord(jsonRecord(item).message);
				const labels = jsonArray(message.labelIds);
				if (labels.some((label) => typeof label === "string" && SKIPPED_LABELS.has(label))) continue;
				added.push(...listed([message]));
			}
		const next = typeof page.nextPageToken === "string" && PAGE_TOKEN.test(page.nextPageToken) ? page.nextPageToken : null;
		return { added, historyId, next };
	}

	async message(id: string, signal: AbortSignal): Promise<Json | null> {
		const path = `/gmail/v1/users/me/messages/${id}`;
		try {
			return await this.#call(path, signal, { query: { format: "full" }, maximumBytes: GMAIL_FULL_MAX_BYTES });
		} catch (error) {
			if (error instanceof ConnectorRequestError && error.reason === "not_found") return null;
			if (!(error instanceof Error) || error.message !== "Cloud response exceeds its byte limit") throw error;
		}
		try {
			return { ...(await this.#call(path, signal, { query: { format: "metadata" } })), truncated: true };
		} catch (error) {
			if (error instanceof ConnectorRequestError && error.reason === "not_found") return null;
			throw error;
		}
	}

	async send(raw: string, threadId: string | null, signal: AbortSignal): Promise<{ id: string; threadId: string | null }> {
		const sent = await this.#call("/gmail/v1/users/me/messages/send", signal, {
			method: "POST",
			body: JSON.stringify({ raw: encodeBase64Url(raw), ...(threadId ? { threadId } : {}) }),
		});
		if (typeof sent.id !== "string" || !GOOGLE_ID.test(sent.id))
			throw new GmailMailboxError("Gmail did not confirm the send");
		return { id: sent.id, threadId: typeof sent.threadId === "string" && GOOGLE_ID.test(sent.threadId) ? sent.threadId : null };
	}

	async messageId(id: string, signal: AbortSignal): Promise<string | null> {
		const message = await this.#call(`/gmail/v1/users/me/messages/${id}`, signal, {
			query: { format: "metadata", metadataHeaders: ["Message-ID"] },
		});
		const value = headers(jsonRecord(message.payload)).get("message-id");
		return value && /^<[^<>\s]{1,996}>$/.test(value.trim()) ? value.trim() : null;
	}
}

function listed(value: unknown): GmailListedMessage[] {
	const messages: GmailListedMessage[] = [];
	for (const item of jsonArray(value)) {
		const message = jsonRecord(item);
		if (typeof message.id !== "string" || !GOOGLE_ID.test(message.id)) continue;
		messages.push({
			id: message.id,
			threadId: typeof message.threadId === "string" && GOOGLE_ID.test(message.threadId) ? message.threadId : null,
		});
	}
	return messages;
}

export class GmailMailboxClient {
	readonly fetch: typeof fetch;
	readonly #exchange: ReturnType<typeof createGoogleAccessTokenExchange>;

	constructor(options: { client: GoogleOAuthClient; fetch?: typeof fetch }) {
		this.fetch = options.fetch ?? fetch;
		this.#exchange = createGoogleAccessTokenExchange(options.client);
	}

	async api(refreshToken: string, signal: AbortSignal): Promise<GmailMailboxApi> {
		let bearer: string;
		try {
			bearer = await this.#exchange(refreshToken, this.fetch, signal);
		} catch (error) {
			throw refusalOf(error);
		}
		return new GmailMailboxApi({ fetch: this.fetch, bearer });
	}

	async address(refreshToken: string, signal: AbortSignal): Promise<string> {
		return (await (await this.api(refreshToken, signal)).profile(signal)).address;
	}
}

function clean(value: string): string {
	return value
		.replace(/\u0000/g, "")
		.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd");
}

function cut(value: string, limit: number): string {
	const end = limit > 0 && limit < value.length && /[\ud800-\udbff]/.test(value[limit - 1] ?? "") ? limit - 1 : limit;
	return value.slice(0, Math.max(0, end));
}

function text(value: string | null | undefined, limit: number): string | null {
	return typeof value === "string" ? cut(clean(value), limit) : null;
}

function headers(payload: Json): Map<string, string> {
	const named = new Map<string, string>();
	for (const item of jsonArray(payload.headers)) {
		const entry = jsonRecord(item);
		if (typeof entry.name !== "string" || typeof entry.value !== "string") continue;
		const name = entry.name.toLowerCase();
		if (!named.has(name)) named.set(name, entry.value);
	}
	return named;
}

function bareAddress(value: string): string | null {
	const angle = /<([^<>]*)>\s*$/.exec(value);
	const address = (angle ? angle[1] : value).trim().toLowerCase();
	return address && ADDRESS.test(address) && clean(address) === address && !/[\u0000-\u001f\u007f]/.test(address)
		? address
		: null;
}

function addressList(value: string | undefined): string[] {
	if (!value) return [];
	const parts: string[] = [];
	let current = "";
	let quoted = false;
	let angled = false;
	for (const character of value) {
		if (character === '"') quoted = !quoted;
		else if (character === "<" && !quoted) angled = true;
		else if (character === ">" && !quoted) angled = false;
		if (character === "," && !quoted && !angled) {
			parts.push(current);
			current = "";
		} else current += character;
	}
	parts.push(current);
	return parts
		.map(bareAddress)
		.filter((address): address is string => address !== null)
		.slice(0, MAX_LIST);
}

function messageIds(value: string | undefined): string | null {
	if (!value) return null;
	const ids = (value.match(/<[^<>\s]+>/g) ?? []).filter((id) => id.length <= 998);
	if (ids.length === 0) return text(value, 2048);
	const newest: string[] = [];
	let length = ids[0]?.length ?? 0;
	for (let index = ids.length - 1; index > 0 && length + 1 + (ids[index]?.length ?? 0) <= 2048; index -= 1) {
		newest.unshift(ids[index] as string);
		length += 1 + (ids[index]?.length ?? 0);
	}
	return text([ids[0], ...newest].join(" "), 2048);
}

function automated(header: (name: string) => string | null): boolean {
	const submitted = header("auto-submitted")?.split(";")[0]?.trim().toLowerCase();
	const precedence = (header("precedence") ?? header("x-precedence"))?.trim().toLowerCase() ?? "";
	return (
		(!!submitted && submitted !== "no") ||
		["bulk", "junk", "list", "auto_reply"].includes(precedence) ||
		!!header("x-autoreply")?.trim() ||
		!!header("x-autorespond")?.trim() ||
		!!header("list-id")?.trim()
	);
}

function authenticationResult(results: string | null, method: string): string | null {
	if (!results) return null;
	const match = new RegExp(`(?:^|[;\\s])${method}=([A-Za-z]+)`, "i").exec(results);
	return match ? text(match[1]?.toLowerCase(), 32) : null;
}

function partBody(part: Json): string | null {
	const data = jsonRecord(part.body).data;
	if (typeof data !== "string") return null;
	try {
		return decodeUtf8(decodeBase64Url(data));
	} catch {
		return null;
	}
}

interface MessageParts {
	readonly plain: string[];
	readonly html: string[];
	readonly attachments: Json[];
}

function walk(part: Json, depth: number, into: MessageParts): void {
	if (depth > 12) return;
	const mimeType = (jsonString(part.mimeType, 128) ?? "").toLowerCase();
	const body = jsonRecord(part.body);
	const filename = jsonString(part.filename, 256);
	if (filename || typeof body.attachmentId === "string") {
		if (into.attachments.length < MAX_LIST) {
			const named = headers(part);
			const size = body.size;
			into.attachments.push({
				id: text(typeof body.attachmentId === "string" ? body.attachmentId : null, 128),
				filename: text(filename, 256),
				contentType: text(mimeType || null, 256),
				size: typeof size === "number" && Number.isSafeInteger(size) ? size : null,
				disposition: text(named.get("content-disposition")?.split(";")[0]?.trim().toLowerCase(), 32),
				contentId: text(named.get("content-id"), 256),
			});
		}
	} else if (mimeType === "text/plain" || mimeType === "text/html") {
		const value = partBody(part);
		if (value !== null) (mimeType === "text/plain" ? into.plain : into.html).push(value);
	}
	for (const child of jsonArray(part.parts)) walk(jsonRecord(child), depth + 1, into);
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

export function gmailEmailId(companyId: string, address: string, gmailId: string): string {
	const digest = createHash("sha256")
		.update(`qorpera.gmail-message/v1\n${companyId}\n${address}\n${gmailId}`, "utf8")
		.digest("hex");
	return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

export function gmailMailMessage(
	emailId: string,
	message: Json,
): { readonly text: string; readonly receivedAt: Date; readonly threadId: string | null } {
	const payload = jsonRecord(message.payload);
	const named = headers(payload);
	const header = (name: string) => text(named.get(name), 2048);
	const parts: MessageParts = { plain: [], html: [], attachments: [] };
	walk(payload, 0, parts);
	const internal = typeof message.internalDate === "string" ? Number(message.internalDate) : Number.NaN;
	const receivedAt = new Date(Number.isSafeInteger(internal) && internal > 0 ? internal : Date.now());
	const results = header("authentication-results");
	const snippet = typeof message.snippet === "string" ? message.snippet : null;
	const plain = parts.plain.length > 0 ? parts.plain.join("\n") : message.truncated === true ? snippet : null;
	const mail: Json = {
		schema: "qorpera.mail/v1",
		emailId,
		subject: text(named.get("subject"), 998),
		from: text(named.get("from"), 998),
		to: addressList(named.get("to")),
		cc: addressList(named.get("cc")),
		replyTo: addressList(named.get("reply-to")),
		receivedAt: receivedAt.toISOString(),
		messageId: text(named.get("message-id"), 998),
		inReplyTo: messageIds(named.get("in-reply-to")),
		references: messageIds(named.get("references")),
		autoSubmitted: header("auto-submitted"),
		precedence: header("precedence"),
		listId: header("list-id"),
		automated: automated(header),
		authentication: {
			spf: authenticationResult(results, "spf"),
			dkim: authenticationResult(results, "dkim"),
			dmarc: authenticationResult(results, "dmarc"),
		},
		attachments: parts.attachments,
		truncated: message.truncated === true,
		text: plain === null ? null : clean(plain),
		html: parts.html.length > 0 ? clean(parts.html.join("\n")) : null,
	};
	for (const field of ["html", "text"] as const) {
		if (bytes(mail) <= GMAIL_MESSAGE_MAX_BYTES) break;
		const value = mail[field];
		if (typeof value !== "string") continue;
		mail.truncated = true;
		const room = GMAIL_MESSAGE_MAX_BYTES - bytes({ ...mail, [field]: "" }) + 2;
		let keep = value.length;
		let size = bytes(value);
		while (keep > 0 && size > room) {
			keep = Math.min(keep - 1, Math.floor((keep * room) / size));
			size = bytes(cut(value, keep));
		}
		mail[field] = keep > 0 ? cut(value, keep) : null;
	}
	if (bytes(mail) > GMAIL_MESSAGE_MAX_BYTES) {
		mail.attachments = [];
		mail.truncated = true;
	}
	const threadId = typeof message.threadId === "string" && GOOGLE_ID.test(message.threadId) ? message.threadId : null;
	return { text: JSON.stringify(mail), receivedAt, threadId };
}

export function gmailRawMessage(send: {
	readonly fromName: string;
	readonly address: string;
	readonly to: readonly string[];
	readonly cc: readonly string[];
	readonly subject: string;
	readonly text: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly date: Date;
}): string {
	const name = send.fromName.replace(/["\\]/g, "");
	const from = /^[\x20-\x7e]*$/.test(name) ? `"${name}" <${send.address}>` : `${headerValue(name)} <${send.address}>`;
	const lines = [
		`From: ${from}`,
		`To: ${send.to.join(", ")}`,
		...(send.cc.length > 0 ? [`Cc: ${send.cc.join(", ")}`] : []),
		`Subject: ${headerValue(send.subject)}`,
		`Date: ${send.date.toUTCString().replace("GMT", "+0000")}`,
		...Object.entries(send.headers).map(([key, value]) => `${key}: ${headerValue(value)}`),
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=UTF-8",
		"Content-Transfer-Encoding: base64",
	];
	const body =
		Buffer.from(send.text, "utf8")
			.toString("base64")
			.match(/.{1,76}/g)
			?.join("\r\n") ?? "";
	return `${lines.join("\r\n")}\r\n\r\n${body}`;
}

export interface GmailMailboxLease {
	readonly mailboxId: string;
	readonly lease: string;
}

export interface GmailMailboxAuthority {
	claimGoogleMailbox(signal: AbortSignal): Promise<unknown>;
	googleMailKnownAmong(input: GmailMailboxLease & { gmailIds: readonly string[] }, signal: AbortSignal): Promise<unknown>;
	bringInGoogleMail(
		input: GmailMailboxLease & {
			gmailId: string;
			gmailThreadId: string | null;
			imported: boolean;
			receivedAt: string;
			message: string;
		},
		signal: AbortSignal,
	): Promise<unknown>;
	finishGoogleMailboxPass(
		input: GmailMailboxLease & {
			outcome: "importing" | "imported" | "current" | "limited" | "failed" | "refused";
			historyId: string | null;
			pageToken: string | null;
			total: number | null;
			error: string | null;
		},
		signal: AbortSignal,
	): Promise<unknown>;
	claimGoogleMailSends(limit: number, signal: AbortSignal): Promise<unknown>;
	completeGoogleMailSend(
		input: { mailId: string; lease: string; gmailId: string; gmailThreadId: string | null; messageId: string | null },
		signal: AbortSignal,
	): Promise<unknown>;
	failGoogleMailSend(
		input: { mailId: string; lease: string; error: string; retryable: boolean; refused: boolean },
		signal: AbortSignal,
	): Promise<unknown>;
}

interface SealedSignIn {
	readonly companyId: string;
	readonly environmentId: string;
	readonly secretId: string;
	readonly version: number;
	readonly keyId: string;
	readonly encryptedEnvelopeBase64: string;
	readonly envelopeSha256: string;
}

interface MailboxClaim extends SealedSignIn, GmailMailboxLease {
	readonly address: string;
	readonly state: "bringing_in" | "live";
	readonly historyId: string | null;
	readonly pageToken: string | null;
	readonly broughtIn: number;
	readonly total: number | null;
}

interface SendClaim extends SealedSignIn {
	readonly mailId: string;
	readonly lease: string;
	readonly address: string;
	readonly fromName: string;
	readonly to: readonly string[];
	readonly cc: readonly string[];
	readonly subject: string;
	readonly text: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly gmailThreadId: string | null;
}

function sealed(input: Json, companyId: unknown, environmentId: unknown): SealedSignIn {
	const base64 =
		typeof input.encryptedEnvelopeBase64 === "string" ? input.encryptedEnvelopeBase64.replace(/\r?\n/g, "") : "";
	if (
		![companyId, environmentId, input.secretId].every((id) => typeof id === "string" && UUID.test(id)) ||
		!Number.isSafeInteger(input.secretVersion) ||
		(input.secretVersion as number) < 1 ||
		typeof input.keyId !== "string" ||
		!KEY_ID.test(input.keyId) ||
		base64.length > 180_000 ||
		!BASE64.test(base64) ||
		typeof input.envelopeSha256 !== "string" ||
		!SHA.test(input.envelopeSha256)
	)
		throw new GmailMailboxError("the sealed Google sign-in is not readable");
	return {
		companyId: companyId as string,
		environmentId: environmentId as string,
		secretId: input.secretId as string,
		version: input.secretVersion as number,
		keyId: input.keyId as string,
		encryptedEnvelopeBase64: base64,
		envelopeSha256: input.envelopeSha256 as string,
	};
}

function parseMailboxClaim(value: unknown): MailboxClaim | null {
	if (value === null) return null;
	const input = jsonRecord(value);
	if (
		Object.keys(input).sort().join() !==
			"address,broughtIn,companyId,encryptedEnvelopeBase64,envelopeSha256,environmentId,historyId,keyId,lease,mailboxId,pageToken,schema,secretId,secretVersion,state,total" ||
		input.schema !== "qorpera.google-mailbox-claim/v1" ||
		![input.mailboxId, input.lease].every((id) => typeof id === "string" && UUID.test(id)) ||
		typeof input.address !== "string" ||
		!MAILBOX_ADDRESS.test(input.address) ||
		(input.state !== "bringing_in" && input.state !== "live") ||
		(input.historyId !== null && (typeof input.historyId !== "string" || !HISTORY_ID.test(input.historyId))) ||
		(input.pageToken !== null && (typeof input.pageToken !== "string" || !PAGE_TOKEN.test(input.pageToken))) ||
		!Number.isSafeInteger(input.broughtIn) ||
		(input.broughtIn as number) < 0 ||
		(input.total !== null && (!Number.isSafeInteger(input.total) || (input.total as number) < 0))
	)
		throw new GmailMailboxError("the Google mailbox claim is not readable");
	return {
		...sealed(input, input.companyId, input.environmentId),
		mailboxId: input.mailboxId as string,
		lease: input.lease as string,
		address: input.address as string,
		state: input.state as "bringing_in" | "live",
		historyId: input.historyId as string | null,
		pageToken: input.pageToken as string | null,
		broughtIn: input.broughtIn as number,
		total: input.total as number | null,
	};
}

function strings(value: unknown, limit: number): string[] | null {
	if (!Array.isArray(value) || value.length > limit || value.some((item) => typeof item !== "string" || !ADDRESS.test(item)))
		return null;
	return value as string[];
}

function parseSends(value: unknown): SendClaim[] {
	const input = jsonRecord(value);
	if (input.schema !== "qorpera.google-mail-sends/v1" || !Array.isArray(input.sends) || input.sends.length > GMAIL_SENDS_PER_PASS)
		throw new GmailMailboxError("the Google mail sends are not readable");
	return input.sends.map((item) => {
		const send = jsonRecord(item);
		const to = strings(send.to, 10);
		const cc = strings(send.cc, 9);
		const headers = jsonRecord(send.headers);
		if (
			![send.mailId, send.leaseId, send.mailboxId].every((id) => typeof id === "string" && UUID.test(id)) ||
			typeof send.address !== "string" ||
			!MAILBOX_ADDRESS.test(send.address) ||
			typeof send.fromName !== "string" ||
			!send.fromName ||
			!to ||
			to.length === 0 ||
			!cc ||
			typeof send.subject !== "string" ||
			typeof send.text !== "string" ||
			Object.entries(headers).some(
				([name, content]) =>
					!["In-Reply-To", "References", "Auto-Submitted"].includes(name) ||
					typeof content !== "string" ||
					/[\r\n]/.test(content),
			) ||
			(send.gmailThreadId !== null && (typeof send.gmailThreadId !== "string" || !GOOGLE_ID.test(send.gmailThreadId)))
		)
			throw new GmailMailboxError("a Google mail send is not readable");
		return {
			...sealed(send, send.companyId, send.environmentId),
			mailId: send.mailId as string,
			lease: send.leaseId as string,
			address: send.address as string,
			fromName: send.fromName as string,
			to,
			cc,
			subject: send.subject as string,
			text: send.text as string,
			headers: headers as Record<string, string>,
			gmailThreadId: send.gmailThreadId as string | null,
		};
	});
}

function broughtIn(value: unknown): { outcome: string } {
	const input = jsonRecord(value);
	if (input.schema !== "qorpera.google-mail-brought-in/v1" || typeof input.outcome !== "string")
		throw new GmailMailboxError("the database did not keep the message");
	return { outcome: input.outcome };
}

function known(value: unknown, asked: readonly string[]): ReadonlySet<string> {
	const input = jsonRecord(value);
	if (
		input.schema !== "qorpera.google-mail-known/v1" ||
		!Array.isArray(input.known) ||
		input.known.some((id) => typeof id !== "string" || !asked.includes(id))
	)
		throw new GmailMailboxError("the database did not say which messages it has");
	return new Set(input.known as string[]);
}

function failurePhrase(error: unknown, signal: AbortSignal): string {
	if (error instanceof GmailMailboxError) return error.message;
	if (error instanceof ConnectorRequestError)
		return error.reason === "rate_limited" ? "Gmail asked us to wait" : "Gmail did not answer as expected";
	if (signal.aborted) return "the Gmail pass took too long";
	return "the Gmail pass failed";
}

export type GmailMailboxPassOutcome = {
	readonly mailboxes: number;
	readonly messages: number;
	readonly sent: number;
	readonly refused: number;
	readonly failed: number;
};

type PassEnd = {
	readonly outcome: "importing" | "imported" | "current" | "limited";
	readonly historyId: string | null;
	readonly pageToken: string | null;
	readonly total: number | null;
};

const database = (): AbortSignal => AbortSignal.timeout(DATABASE_DEADLINE_MS);

export class CloudGmailMailboxes {
	readonly #authority: GmailMailboxAuthority;
	readonly #keyring: Pick<CloudSecretKeyring, "use">;
	readonly #gmail: Pick<GmailMailboxClient, "api">;
	readonly #now: () => number;
	readonly #budgetMs: number;
	readonly #messagesPerPass: number;

	constructor(options: {
		authority: GmailMailboxAuthority;
		keyring: Pick<CloudSecretKeyring, "use">;
		gmail: Pick<GmailMailboxClient, "api">;
		now?: () => number;
		budgetMs?: number;
		messagesPerPass?: number;
	}) {
		this.#authority = options.authority;
		this.#keyring = options.keyring;
		this.#gmail = options.gmail;
		this.#now = options.now ?? Date.now;
		this.#budgetMs = options.budgetMs ?? GMAIL_PASS_BUDGET_MS;
		this.#messagesPerPass = options.messagesPerPass ?? GMAIL_PASS_MESSAGES;
	}

	async pass(signal: AbortSignal): Promise<GmailMailboxPassOutcome> {
		const started = this.#now();
		const tally = { mailboxes: 0, messages: 0, sent: 0, refused: 0, failed: 0 };
		const spent = () => this.#now() - started >= this.#budgetMs || tally.messages >= this.#messagesPerPass;
		while (!spent()) {
			signal.throwIfAborted();
			const claim = parseMailboxClaim(await this.#authority.claimGoogleMailbox(AbortSignal.any([signal, database()])));
			if (!claim) break;
			tally.mailboxes += 1;
			await this.#read(claim, signal, spent, tally);
		}
		await this.#send(signal, tally);
		return tally;
	}

	async #withApi<T>(signIn: SealedSignIn, signal: AbortSignal, work: (api: GmailMailboxApi) => Promise<T>): Promise<T> {
		const envelope = Buffer.from(signIn.encryptedEnvelopeBase64, "base64");
		try {
			if (createHash("sha256").update(envelope).digest("hex") !== signIn.envelopeSha256)
				throw new GmailMailboxError("the sealed Google sign-in's digest differs");
			const outcome = await this.#keyring.use(
				envelope,
				{
					companyId: signIn.companyId,
					environmentId: signIn.environmentId,
					secretId: signIn.secretId,
					version: signIn.version,
					keyId: signIn.keyId,
				},
				async (fields): Promise<{ value: T } | { error: unknown }> => {
					try {
						return { value: await work(await this.#gmail.api(fields.refresh_token ?? "", signal)) };
					} catch (error) {
						return { error };
					}
				},
			);
			if ("error" in outcome) throw outcome.error;
			return outcome.value;
		} catch (error) {
			if (
				error instanceof GmailMailboxError ||
				error instanceof GmailSignInRefused ||
				error instanceof GmailHistoryGone ||
				error instanceof ConnectorRequestError
			)
				throw error;
			throw new GmailMailboxError(
				error instanceof Error && error.name === "AbortError"
					? "the Gmail pass took too long"
					: "the Google sign-in could not be opened",
			);
		} finally {
			envelope.fill(0);
		}
	}

	async #read(
		claim: MailboxClaim,
		signal: AbortSignal,
		spent: () => boolean,
		tally: { messages: number; refused: number; failed: number },
	): Promise<void> {
		const lease = { mailboxId: claim.mailboxId, lease: claim.lease };
		const finish = (end: PassEnd | { outcome: "failed" | "refused"; error: string }) =>
			this.#authority.finishGoogleMailboxPass(
				"error" in end
					? { ...lease, outcome: end.outcome, historyId: null, pageToken: null, total: null, error: end.error }
					: { ...lease, ...end, error: null },
				database(),
			);
		let end: PassEnd;
		try {
			end = await this.#withApi(claim, signal, (api) =>
				claim.state === "bringing_in"
					? this.#import(api, claim, signal, spent, tally)
					: this.#follow(api, claim, signal, spent, tally),
			);
		} catch (error) {
			if (error instanceof GmailSignInRefused) {
				tally.refused += 1;
				await finish({ outcome: "refused", error: GMAIL_SIGN_IN_AGAIN });
				return;
			}
			tally.failed += 1;
			await finish({ outcome: "failed", error: failurePhrase(error, signal) });
			return;
		}
		await finish(end);
	}

	async #bring(
		api: GmailMailboxApi,
		claim: MailboxClaim,
		gmailId: string,
		imported: boolean,
		signal: AbortSignal,
	): Promise<string> {
		const message = await api.message(gmailId, signal);
		if (message === null) return "gone";
		const mail = gmailMailMessage(gmailEmailId(claim.companyId, claim.address, gmailId), message);
		return broughtIn(
			await this.#authority.bringInGoogleMail(
				{
					mailboxId: claim.mailboxId,
					lease: claim.lease,
					gmailId,
					gmailThreadId: mail.threadId,
					imported,
					receivedAt: mail.receivedAt.toISOString(),
					message: mail.text,
				},
				database(),
			),
		).outcome;
	}

	async #unknown(claim: MailboxClaim, ids: readonly string[]): Promise<string[]> {
		if (ids.length === 0) return [];
		const have = known(
			await this.#authority.googleMailKnownAmong(
				{ mailboxId: claim.mailboxId, lease: claim.lease, gmailIds: ids },
				database(),
			),
			ids,
		);
		return ids.filter((id) => !have.has(id));
	}

	async #import(
		api: GmailMailboxApi,
		claim: MailboxClaim,
		signal: AbortSignal,
		spent: () => boolean,
		tally: { messages: number },
	): Promise<PassEnd> {
		const historyId = claim.historyId ?? (await api.profile(signal)).historyId;
		let total = claim.total;
		let pageToken = claim.pageToken;
		let count = claim.broughtIn;
		for (;;) {
			if (spent()) return { outcome: "importing", historyId, pageToken, total };
			const page = await api.list(pageToken, signal);
			if (total === null) total = page.estimate;
			for (const id of await this.#unknown(
				claim,
				[...new Set(page.messages.map((message) => message.id))],
			)) {
				if (count >= GMAIL_IMPORT_BOUND) return { outcome: "imported", historyId, pageToken: null, total };
				if (spent()) return { outcome: "importing", historyId, pageToken, total };
				const outcome = await this.#bring(api, claim, id, true, signal);
				tally.messages += 1;
				if (outcome === "accepted") count += 1;
				else if (outcome === "bounded") return { outcome: "imported", historyId, pageToken: null, total };
				else if (outcome !== "duplicate" && outcome !== "gone")
					throw new GmailMailboxError("the mail door did not take the message");
			}
			if (page.next === null) return { outcome: "imported", historyId, pageToken: null, total };
			pageToken = page.next;
		}
	}

	async #follow(
		api: GmailMailboxApi,
		claim: MailboxClaim,
		signal: AbortSignal,
		spent: () => boolean,
		tally: { messages: number },
	): Promise<PassEnd> {
		const mark = claim.historyId as string;
		let pageToken: string | null = null;
		let page: GmailHistoryPage;
		for (;;) {
			try {
				page = await api.history(mark, pageToken, signal);
			} catch (error) {
				if (error instanceof GmailHistoryGone) return this.#restart(api, claim, signal, tally);
				throw error;
			}
			for (const id of await this.#unknown(claim, [...new Set(page.added.map((message) => message.id))])) {
				if (spent()) return { outcome: "current", historyId: mark, pageToken: null, total: null };
				const outcome = await this.#bring(api, claim, id, false, signal);
				tally.messages += 1;
				if (outcome === "limited") return { outcome: "limited", historyId: mark, pageToken: null, total: null };
				if (outcome !== "accepted" && outcome !== "duplicate" && outcome !== "gone")
					throw new GmailMailboxError("the mail door did not take the message");
			}
			if (page.next === null) return { outcome: "current", historyId: page.historyId, pageToken: null, total: null };
			pageToken = page.next;
		}
	}

	async #restart(
		api: GmailMailboxApi,
		claim: MailboxClaim,
		signal: AbortSignal,
		tally: { messages: number },
	): Promise<PassEnd> {
		const { historyId } = await api.profile(signal);
		const page = await api.list(null, signal);
		for (const id of await this.#unknown(claim, [...new Set(page.messages.map((message) => message.id))])) {
			const outcome = await this.#bring(api, claim, id, true, signal);
			tally.messages += 1;
			if (outcome !== "accepted" && outcome !== "duplicate" && outcome !== "gone")
				throw new GmailMailboxError("the mail door did not take the message");
		}
		return { outcome: "current", historyId, pageToken: null, total: null };
	}

	async #send(signal: AbortSignal, tally: { sent: number; refused: number; failed: number }): Promise<void> {
		const sends = parseSends(
			await this.#authority.claimGoogleMailSends(GMAIL_SENDS_PER_PASS, AbortSignal.any([signal, database()])),
		);
		for (const claimed of sends) {
			const fail = (error: string, retryable: boolean, refused: boolean) =>
				this.#authority.failGoogleMailSend({ mailId: claimed.mailId, lease: claimed.lease, error, retryable, refused }, database());
			try {
				const sent = await this.#sendOne(claimed, signal);
				await this.#authority.completeGoogleMailSend(
					{
						mailId: claimed.mailId,
						lease: claimed.lease,
						gmailId: sent.id,
						gmailThreadId: sent.threadId,
						messageId: sent.messageId,
					},
					database(),
				);
				tally.sent += 1;
			} catch (error) {
				if (error instanceof GmailSignInRefused) {
					tally.refused += 1;
					await fail(GMAIL_SIGN_IN_AGAIN, true, true);
				} else if (error instanceof ConnectorRequestError && error.reason === "invalid_request") {
					tally.failed += 1;
					await fail("Gmail refused the email", false, false);
				} else {
					tally.failed += 1;
					await fail(failurePhrase(error, signal), true, false);
				}
			}
		}
	}

	async #sendOne(
		claimed: SendClaim,
		signal: AbortSignal,
	): Promise<{ id: string; threadId: string | null; messageId: string | null }> {
		return this.#withApi(claimed, signal, async (api) => {
			const raw = gmailRawMessage({ ...claimed, date: new Date(this.#now()) });
			const sent = await api.send(raw, claimed.gmailThreadId, signal);
			let messageId: string | null = null;
			try {
				messageId = await api.messageId(sent.id, signal);
			} catch {
				messageId = null;
			}
			return { ...sent, messageId };
		});
	}
}

export class CloudGmailMailboxUpkeep {
	readonly #mailboxes: Pick<CloudGmailMailboxes, "pass">;
	readonly #passEveryMs: number;
	readonly #firstPassMs: number;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#running: Promise<void> | undefined;
	readonly #closing = new AbortController();
	#started = false;

	constructor(options: { mailboxes: Pick<CloudGmailMailboxes, "pass">; passEveryMs?: number; firstPassMs?: number }) {
		this.#mailboxes = options.mailboxes;
		this.#passEveryMs = options.passEveryMs ?? PASS_EVERY_MS;
		this.#firstPassMs = options.firstPassMs ?? 15_000 + Math.floor(Math.random() * 30_000);
	}

	start(): void {
		if (this.#started || this.#closing.signal.aborted) return;
		this.#started = true;
		const loop = (): void => {
			if (this.#closing.signal.aborted) return;
			this.#running = this.pass().finally(() => {
				this.#running = undefined;
				if (!this.#closing.signal.aborted) this.#timer = setTimeout(loop, this.#passEveryMs);
			});
		};
		this.#timer = setTimeout(loop, this.#firstPassMs);
	}

	async close(): Promise<void> {
		this.#closing.abort();
		clearTimeout(this.#timer);
		await this.#running;
	}

	async pass(): Promise<void> {
		await logGmailMailboxPass(this.#mailboxes, this.#closing.signal);
	}
}

export async function logGmailMailboxPass(
	mailboxes: Pick<CloudGmailMailboxes, "pass">,
	signal: AbortSignal,
): Promise<void> {
	try {
		const outcome = await mailboxes.pass(signal);
		if (outcome.refused > 0)
			console.error(`Google mail: Google refused ${outcome.refused} sign-in(s); the member signs in again.`);
		if (outcome.failed > 0) console.error(`Google mail: ${outcome.failed} step(s) failed; they are tried again later.`);
	} catch {
		console.error("Google mail: a pass stopped on an error; the next pass tries again.");
	}
}
