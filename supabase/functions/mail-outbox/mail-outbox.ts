/* Mail outbox (build step M2b; contract section 19, 2026-09-29 amendment "events wake agents", item 9; design
 * deploy/first-node/RUNTIME-EVENT-INTAKE.md, "Mail (M2)").
 *
 * POST /mail-outbox, called each minute by pg_cron + pg_net with a Supabase secret key, which the function checks
 * itself. It claims a batch of the email agents queued (qorpera_claim_company_mail, under a five-minute lease) and
 * sends each through the mail provider (Resend) with the platform's key, which no node or agent holds: from the
 * agent at the mailbox's address, plain text with the AI line the database added, and a reply's thread headers and
 * Auto-Submitted: auto-replied. An email a member sent themself (M2e, 20260930716000) waits in the same outbox and is
 * claimed and sent the same way: from the member, its text as written, with no AI line. An email with attachments (M2c-1) carries the company files as they were when queued,
 * read from the company's objects in Storage (each a manifest and its chunks, checked against their digests) and sent
 * as the email's attachments; a file whose bytes are not in Storage yet is tried again later. After the sends it reads
 * back the provider's Message-ID of a few sent emails (I5a), so an answer to an email an agent started joins its
 * thread; best effort, asked again after five minutes for a day.
 * Each email's provider idempotency key is its id, so a send repeated after a lost answer or an expired lease is
 * the same email. A sent email is completed; a failure the provider may get past (a timeout, a rate limit, a server
 * error) is retried after 1, 2, 4 ... minutes, and any other fails the email. Sends are paced, since the provider
 * limits requests a second for the whole platform. Answers: 200 with counts, 401 for a missing or wrong key, 405,
 * and 503 when the claim fails. */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { withTimeoutScope } from "../_shared/abort-timeout.ts";
import {
	BodyTooLargeError,
	constantTimeIncludes,
	readBoundedBytes as readHttpBoundedBytes,
	readBoundedJson,
} from "../_shared/http-guards.ts";

export const BATCH = 10;
/** Sent emails whose Message-ID is read back in one call, paced like the sends. */
export const MESSAGE_ID_BATCH = 5;
/** Between two sends: the provider allows a few requests a second across the platform's email. */
export const PACE_MS = 600;
const SEND_TIMEOUT_MS = 10_000;
const RESEND_RESPONSE_MAX_BYTES = 64 * 1024;
const CHUNK_PREFETCH_WINDOW = 3;
const TRUSTED_BASE64_SEGMENTS = new WeakSet<readonly string[]>();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
/** The attachments an email may carry, as the database checks them: 28 MiB, which is 40 MB once encoded. */
export const MAX_ATTACHMENT_BYTES = 28 * 1024 * 1024;
const CHUNK_BYTES = 4 * 1024 * 1024;
const OBJECT_BUCKET = "qorpera-profile-objects";
const FILE_SCHEMA = "qorpera.cloud-file-manifest/v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;

/** A company file on a queued email, as it was when queued. */
export interface MailAttachment {
	filename: string;
	manifestSha256: string;
	fileSha256: string;
	bytes: number;
}

/** One claimed email, as the database hands it over. */
export interface MailJob {
	mailId: string;
	leaseId: string;
	attemptCount: number;
	from: string;
	to: string[];
	cc: string[];
	subject: string;
	text: string;
	headers: Record<string, string>;
	/** The company whose files are attached; null when nothing is. */
	companyId: string | null;
	attachments: MailAttachment[];
}

/** The provider's send request (Resend's POST /emails). */
export interface ProviderEmail {
	from: string;
	to: string[];
	cc?: string[];
	subject: string;
	text: string;
	headers?: Record<string, string>;
	/** Each file's name and its bytes in base64. */
	attachments?: { filename: string; content: string | readonly string[] }[];
}

export class MailSendError extends Error {
	readonly retryable: boolean;
	constructor(message: string, retryable: boolean) {
		super(message);
		this.name = "MailSendError";
		this.retryable = retryable;
	}
}

/** The database's side of the outbox. */
export interface MailOutboxStore {
	claim(limit: number, leaseId: string): Promise<unknown>;
	complete(job: MailJob, providerMessageId: string): Promise<void>;
	fail(mailId: string, leaseId: string, message: string, retryable: boolean): Promise<void>;
	/** Sent emails whose Message-ID is still unknown: `[{mailId, providerMessageId}]`. */
	messageIdsDue(limit: number): Promise<unknown>;
	recordMessageId(mailId: string, providerMessageId: string, messageId: string): Promise<void>;
}

/** Sends one email; resolves to the provider's message id or throws MailSendError. */
export interface MailSender {
	send(email: ProviderEmail, idempotencyKey: string): Promise<string>;
	/** The Message-ID header the provider gave a sent email, or null when it has none (yet). */
	messageId(providerMessageId: string): Promise<string | null>;
}

/** The company's objects: one object's bytes by its sha256, or null when Storage has none. */
export interface ObjectReader {
	get(companyId: string, sha256: string): Promise<Uint8Array | null>;
}

export interface MailOutbox {
	/** The Supabase secret keys the caller may present. */
	keys: readonly string[];
	/** The database's outbox, reached with the key the caller presented. */
	store(secretKey: string): MailOutboxStore;
	/** The company's objects, reached with the key the caller presented, for attachments. */
	objects?(secretKey: string): ObjectReader;
	sender: MailSender;
	leaseId?: () => string;
	pace?: number;
	sleep?: (ms: number) => Promise<void>;
	budgetMs?: number;
	now?: () => number;
}

function json(value: unknown, status = 200): Response {
	return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function strings(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** The attachments of a claimed email, or null when they cannot be read. */
function attachments(job: Record<string, unknown>): { companyId: string | null; attachments: MailAttachment[] } | null {
	if (job.attachments === undefined && job.companyId === undefined) return { companyId: null, attachments: [] };
	if (typeof job.companyId !== "string" || !UUID.test(job.companyId) || !Array.isArray(job.attachments)) return null;
	if (job.attachments.length < 1 || job.attachments.length > 10) return null;
	const files: MailAttachment[] = [];
	for (const item of job.attachments) {
		const file = item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : {};
		if (
			typeof file.filename !== "string" ||
			!file.filename ||
			// Characters, as the database counts them.
			[...file.filename].length > 255 ||
			/[\u0000-\u001f\u007f/\\]/.test(file.filename) ||
			typeof file.manifestSha256 !== "string" ||
			!SHA.test(file.manifestSha256) ||
			typeof file.fileSha256 !== "string" ||
			!SHA.test(file.fileSha256) ||
			!Number.isSafeInteger(file.bytes) ||
			(file.bytes as number) < 0
		)
			return null;
		files.push({
			filename: file.filename,
			manifestSha256: file.manifestSha256,
			fileSha256: file.fileSha256,
			bytes: file.bytes as number,
		});
	}
	if (files.reduce((sum, file) => sum + file.bytes, 0) > MAX_ATTACHMENT_BYTES) return null;
	return { companyId: job.companyId, attachments: files };
}

/** The claimed jobs, and the ones that cannot be read (failed for good, so they hold up no other). */
export function parseMailClaim(value: unknown): {
	jobs: MailJob[];
	rejected: { mailId: string; leaseId: string; message: string }[];
} {
	if (!Array.isArray(value) || value.length > 50) throw new Error("The mail claim is invalid");
	const jobs: MailJob[] = [];
	const rejected: { mailId: string; leaseId: string; message: string }[] = [];
	for (const item of value) {
		const job = item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : {};
		if (typeof job.mailId !== "string" || !UUID.test(job.mailId) || typeof job.leaseId !== "string" || !UUID.test(job.leaseId))
			throw new Error("The mail claim is invalid");
		const headers = job.headers;
		const files = attachments(job);
		if (
			!files ||
			typeof job.from !== "string" ||
			!job.from ||
			!strings(job.to) ||
			job.to.length === 0 ||
			!strings(job.cc) ||
			typeof job.subject !== "string" ||
			typeof job.text !== "string" ||
			!Number.isSafeInteger(job.attemptCount) ||
			!headers ||
			typeof headers !== "object" ||
			Array.isArray(headers) ||
			Object.entries(headers).some(
				([name, content]) =>
					!["In-Reply-To", "References", "Auto-Submitted"].includes(name) || typeof content !== "string",
			)
		) {
			rejected.push({ mailId: job.mailId, leaseId: job.leaseId, message: "The queued email could not be read" });
			continue;
		}
		jobs.push({
			mailId: job.mailId,
			leaseId: job.leaseId,
			attemptCount: job.attemptCount as number,
			from: job.from,
			to: job.to,
			cc: job.cc,
			subject: job.subject,
			text: job.text,
			headers: headers as Record<string, string>,
			...files,
		});
	}
	return { jobs, rejected };
}

async function verifiedManifestChunks(
	companyId: string,
	file: MailAttachment,
	objects: ObjectReader,
): Promise<{
	readonly object: (sha256: string) => Promise<Uint8Array>;
	readonly chunks: readonly { readonly sha256: string; readonly bytes: number }[];
}> {
	const object = async (sha256: string): Promise<Uint8Array> => {
		const bytes = await objects.get(companyId, sha256);
		if (!bytes) throw new MailSendError(`The attachment ${file.filename} is not in storage yet`, true);
		if (createHash("sha256").update(bytes).digest("hex") !== sha256)
			throw new MailSendError(`The attachment ${file.filename} failed its integrity check`, false);
		return bytes;
	};
	let manifest: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(UTF8_DECODER.decode(await object(file.manifestSha256)));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
		manifest = parsed as Record<string, unknown>;
	} catch (error) {
		if (error instanceof MailSendError) throw error;
		throw new MailSendError(`The attachment ${file.filename} has an unreadable manifest`, false);
	}
	const chunks = manifest.chunks;
	if (
		manifest.schema !== FILE_SCHEMA ||
		manifest.fileSha256 !== file.fileSha256 ||
		manifest.bytes !== file.bytes ||
		!Array.isArray(chunks) ||
		chunks.length > 64 ||
		chunks.some(
			(chunk, index) =>
				!chunk ||
				typeof chunk !== "object" ||
				typeof (chunk as Record<string, unknown>).sha256 !== "string" ||
				!SHA.test((chunk as Record<string, unknown>).sha256 as string) ||
				!Number.isSafeInteger((chunk as Record<string, unknown>).bytes) ||
				((chunk as Record<string, unknown>).bytes as number) < 1 ||
				((chunk as Record<string, unknown>).bytes as number) > CHUNK_BYTES ||
				(index < chunks.length - 1 && (chunk as Record<string, unknown>).bytes !== CHUNK_BYTES),
		) ||
		chunks.reduce((sum, chunk) => sum + ((chunk as Record<string, unknown>).bytes as number), 0) !== file.bytes
	)
		throw new MailSendError(`The attachment ${file.filename} has an invalid manifest`, false);
	return { object, chunks: chunks as { sha256: string; bytes: number }[] };
}

export async function attachmentBase64(companyId: string, file: MailAttachment, objects: ObjectReader): Promise<string[]> {
	const { object, chunks } = await verifiedManifestChunks(companyId, file, objects);
	const hash = createHash("sha256");
	const parts: string[] = [];
	const carry = new Uint8Array(3);
	let carryLen = 0;
	// WHY: Prefetch a bounded window of 3 chunks concurrently while encoding and hashing strictly in order to cut multi-chunk latency without inflating peak RAM.
	const inflight = new Map<number, Promise<Uint8Array>>();
	let nextToFetch = 0;
	const fillWindow = (): void => {
		while (inflight.size < CHUNK_PREFETCH_WINDOW && nextToFetch < chunks.length) {
			const idx = nextToFetch;
			nextToFetch += 1;
			const pending = object(chunks[idx]!.sha256);
			void pending.catch(() => undefined);
			inflight.set(idx, pending);
		}
	};
	fillWindow();
	for (let index = 0; index < chunks.length; index += 1) {
		const chunk = chunks[index]!;
		const pending = inflight.get(index)!;
		inflight.delete(index);
		const bytes = await pending;
		fillWindow();
		if (bytes.length !== chunk.bytes) throw new MailSendError(`The attachment ${file.filename} failed its integrity check`, false);
		hash.update(bytes);
		let start = 0;
		if (carryLen > 0) {
			const need = 3 - carryLen;
			if (bytes.length < need) {
				carry.set(bytes, carryLen);
				carryLen += bytes.length;
				continue;
			}
			carry.set(bytes.subarray(0, need), carryLen);
			parts.push(Buffer.from(carry.buffer, 0, 3).toString("base64"));
			carryLen = 0;
			start = need;
		}
		const remaining = bytes.length - start;
		const aligned = remaining - (remaining % 3);
		if (aligned > 0) {
			parts.push(Buffer.from(bytes.buffer, bytes.byteOffset + start, aligned).toString("base64"));
		}
		const tailStart = start + aligned;
		carryLen = bytes.length - tailStart;
		if (carryLen > 0) carry.set(bytes.subarray(tailStart), 0);
	}
	if (carryLen > 0) parts.push(Buffer.from(carry.buffer, 0, carryLen).toString("base64"));
	if (hash.digest("hex") !== file.fileSha256)
		throw new MailSendError(`The attachment ${file.filename} failed its integrity check`, false);
	TRUSTED_BASE64_SEGMENTS.add(parts);
	return parts;
}

/** Supabase Storage's headers for a secret key: a legacy JWT key goes as the bearer too. */
export function storageHeaders(secretKey: string): Record<string, string> {
	return /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(secretKey)
		? { apikey: secretKey, authorization: `Bearer ${secretKey}` }
		: { apikey: secretKey };
}

/** The company's objects in Storage, where every object is copied. */
export class StorageObjectReader implements ObjectReader {
	readonly #projectUrl: string;
	readonly #secretKey: string;
	readonly #fetch: typeof fetch;
	constructor(projectUrl: string, secretKey: string, fetcher: typeof fetch = fetch) {
		this.#projectUrl = projectUrl.replace(/\/+$/, "");
		this.#secretKey = secretKey;
		this.#fetch = fetcher;
	}

	async get(companyId: string, sha256: string): Promise<Uint8Array | null> {
		return withTimeoutScope(30_000, async (signal) => {
			let response: Response;
			try {
				response = await this.#fetch(
					`${this.#projectUrl}/storage/v1/object/authenticated/${OBJECT_BUCKET}/${companyId}/${sha256}`,
					{ headers: storageHeaders(this.#secretKey), redirect: "error", signal },
				);
			} catch (error) {
				throw new MailSendError(error instanceof Error ? error.message : "Storage request failed", true);
			}
			// Storage answers a missing object with 404, or 400 and its own 404 code; any other 400 is a refusal.
			if (response.status === 404) {
				void response.body?.cancel().catch(() => undefined);
				return null;
			}
			if (response.status === 400) {
				let code: unknown;
				try {
					const parsed = await readBoundedJson(response, 16 * 1024, { signal });
					if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
						code = (parsed as { statusCode?: unknown }).statusCode;
					}
				} catch {
					// Not JSON.
				}
				if (code === "404") return null;
				throw new MailSendError("Storage refused the attachment's read (400)", true);
			}
			if (!response.ok) {
				void response.body?.cancel().catch(() => undefined);
				throw new MailSendError(`Storage returned HTTP ${response.status}`, true);
			}
			try {
				return await readObjectBytes(response, MAX_GATEWAY_OBJECT_BYTES, signal);
			} catch (error) {
				if (error instanceof MailSendError) throw error;
				throw new MailSendError(error instanceof Error ? error.message : "Storage response read failed", true);
			}
		});
	}
}

const MAX_GATEWAY_OBJECT_BYTES = 8 * 1024 * 1024;
const INTERNAL_GATEWAY_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

async function readObjectBytes(response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
	try {
		return await readHttpBoundedBytes(response, maxBytes, {
			signal,
			sizeErrorMessage: "Object gateway response exceeded size limit",
		});
	} catch (error) {
		if (error instanceof BodyTooLargeError) {
			throw new MailSendError("Object gateway response exceeded size limit", true);
		}
		if (error instanceof MailSendError) throw error;
		throw new MailSendError(error instanceof Error ? error.message : "Object gateway body read failed", true);
	}
}

export class ObjectGatewayReader implements ObjectReader {
	readonly #gatewayUrl: string;
	readonly #internalToken: string;
	readonly #fetch: typeof fetch;

	constructor(gatewayUrl: string, internalToken: string, fetcher: typeof fetch = fetch) {
		const parsed = new URL(gatewayUrl);
		const isLoopback = LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
		if (
			(parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) ||
			parsed.username ||
			parsed.password ||
			(parsed.pathname !== "" && parsed.pathname !== "/") ||
			parsed.search ||
			parsed.hash
		) {
			throw new Error("QORPERA_OBJECT_GATEWAY_URL must be a clean https origin (or loopback http)");
		}
		const trimmedToken = internalToken.trim();
		if (!INTERNAL_GATEWAY_TOKEN.test(trimmedToken)) {
			throw new Error("QORPERA_OBJECT_GATEWAY_INTERNAL_TOKEN must be a 43-character base64url token");
		}
		this.#gatewayUrl = parsed.origin;
		this.#internalToken = trimmedToken;
		this.#fetch = fetcher;
	}

	async get(companyId: string, sha256: string): Promise<Uint8Array | null> {
		if (!UUID.test(companyId) || !SHA.test(sha256)) return null;
		return withTimeoutScope(10_000, async (signal) => {
			let response: Response;
			try {
				response = await this.#fetch(`${this.#gatewayUrl}/v1/internal-objects/${companyId}/${sha256}`, {
					headers: { authorization: `Bearer ${this.#internalToken}` },
					redirect: "error",
					signal,
				});
			} catch (error) {
				throw new MailSendError(error instanceof Error ? error.message : "Object gateway request failed", true);
			}
			if (response.status === 404) {
				void response.body?.cancel().catch(() => undefined);
				return null;
			}
			if (response.status !== 200) {
				void response.body?.cancel().catch(() => undefined);
				throw new MailSendError(`Object gateway returned HTTP ${response.status}`, true);
			}
			const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
			const etag = response.headers.get("etag");
			if (!contentType.startsWith("application/octet-stream") || etag !== `"sha256-${sha256}"`) {
				void response.body?.cancel().catch(() => undefined);
				throw new MailSendError("Object gateway returned an unexpected object response", true);
			}
			return readObjectBytes(response, MAX_GATEWAY_OBJECT_BYTES, signal);
		});
	}
}

export function createMailObjectReader(options: {
	objectGatewayUrl?: string;
	objectGatewayInternalToken?: string;
	supabaseUrl: string;
	secretKey: string;
	fetcher?: typeof fetch;
}): ObjectReader {
	const gatewayUrl = options.objectGatewayUrl?.trim();
	const internalToken = options.objectGatewayInternalToken?.trim();
	if (Boolean(gatewayUrl) !== Boolean(internalToken)) {
		throw new Error("QORPERA_OBJECT_GATEWAY_URL and QORPERA_OBJECT_GATEWAY_INTERNAL_TOKEN must be set together");
	}
	if (gatewayUrl && internalToken) {
		return new ObjectGatewayReader(gatewayUrl, internalToken, options.fetcher);
	}
	return new StorageObjectReader(options.supabaseUrl, options.secretKey, options.fetcher);
}

/** The sent emails due for their Message-ID; an answer that cannot be read is none. */
export function parseMessageIdsDue(value: unknown): { mailId: string; providerMessageId: string }[] {
	if (!Array.isArray(value) || value.length > 10) return [];
	return value.flatMap((item) => {
		const due = item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : {};
		return typeof due.mailId === "string" &&
			UUID.test(due.mailId) &&
			typeof due.providerMessageId === "string" &&
			due.providerMessageId.length >= 1 &&
			due.providerMessageId.length <= 256
			? [{ mailId: due.mailId, providerMessageId: due.providerMessageId }]
			: [];
	});
}

/** What the provider is asked to send: no empty cc, no empty headers, each file's bytes in base64. */
export function providerEmail(job: MailJob, contents: readonly (string | readonly string[])[] = []): ProviderEmail {
	if (contents.length !== job.attachments.length) throw new Error("The email's attachments are not all read");
	return {
		from: job.from,
		to: job.to,
		...(job.cc.length ? { cc: job.cc } : {}),
		subject: job.subject,
		text: job.text,
		...(Object.keys(job.headers).length ? { headers: job.headers } : {}),
		...(contents.length
			? { attachments: job.attachments.map((file, index) => ({ filename: file.filename, content: contents[index]! })) }
			: {}),
	};
}

/** A provider refusal: worth another try only for a timeout, a rate limit, a server error or a concurrent send. */
export async function providerFailure(response: Response, signal?: AbortSignal): Promise<MailSendError> {
	let code = "";
	let message = `Resend returned HTTP ${response.status}`;
	try {
		const body = await readBoundedJson(response, RESEND_RESPONSE_MAX_BYTES, { signal });
		if (body && typeof body === "object" && !Array.isArray(body)) {
			const input = body as Record<string, unknown>;
			if (typeof input.name === "string") code = input.name;
			if (typeof input.message === "string" && input.message.trim()) message = input.message.trim();
		}
	} catch {}
	const retryable =
		response.status === 408 ||
		response.status === 429 ||
		response.status >= 500 ||
		(response.status === 409 && code === "concurrent_idempotent_requests");
	return new MailSendError(`${message} (${response.status}${code ? `/${code}` : ""})`.slice(0, 1000), retryable);
}

const SAFE_BASE64 = /^[A-Za-z0-9+/=]*$/;

function encodeResendPayload(email: ProviderEmail): { readonly body: string | Blob; readonly byteLength: number } {
	if (!email.attachments?.length) {
		const request = JSON.stringify(email);
		return { body: request, byteLength: Buffer.byteLength(request, "utf8") };
	}
	const { attachments, ...head } = email;
	const prefix = JSON.stringify(head);
	const parts: BlobPart[] = [prefix.slice(0, -1), ',"attachments":['];
	for (let index = 0; index < attachments.length; index += 1) {
		const item = attachments[index]!;
		if (index > 0) parts.push(",");
		// WHY: Skip re-scanning up to 37 MB of base64 produced by attachmentBase64 while still checking external callers.
		const trusted = Array.isArray(item.content) && TRUSTED_BASE64_SEGMENTS.has(item.content);
		const segments = typeof item.content === "string" ? [item.content] : item.content;
		if (trusted || segments.every((segment) => SAFE_BASE64.test(segment))) {
			parts.push('{"filename":', JSON.stringify(item.filename), ',"content":"', ...segments, '"}');
		} else {
			parts.push('{"filename":', JSON.stringify(item.filename), ',"content":', JSON.stringify(segments.join("")), "}");
		}
	}
	parts.push("]}");
	const body = new Blob(parts, { type: "application/json" });
	return { body, byteLength: body.size };
}

/** Resend's send API with the platform's key. */
export class ResendSender implements MailSender {
	readonly #apiKey: string;
	readonly #fetch: typeof fetch;
	constructor(apiKey: string, fetcher: typeof fetch = fetch) {
		this.#apiKey = apiKey;
		this.#fetch = fetcher;
	}

	async send(email: ProviderEmail, idempotencyKey: string): Promise<string> {
		const { body: payload, byteLength } = encodeResendPayload(email);
		// WHY: allow one extra second per MiB an email with attachments carries.
		const timeoutMs = SEND_TIMEOUT_MS + Math.floor(byteLength / (1024 * 1024)) * 1000;
		return withTimeoutScope(timeoutMs, async (signal) => {
			let response: Response;
			try {
				response = await this.#fetch("https://api.resend.com/emails", {
					method: "POST",
					headers: {
						Authorization: `Bearer ${this.#apiKey}`,
						"Content-Type": "application/json",
						"Idempotency-Key": idempotencyKey,
					},
					body: payload,
					redirect: "error",
					signal,
				});
			} catch (error) {
				throw new MailSendError(error instanceof Error ? error.message : "Resend request failed", true);
			}
			if (!response.ok) throw await providerFailure(response, signal);
			let body: unknown;
			try {
				body = await readBoundedJson(response, RESEND_RESPONSE_MAX_BYTES, { signal });
			} catch {
				throw new MailSendError("Resend returned an invalid response", true);
			}
			const id = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).id : undefined;
			if (typeof id !== "string" || !id.trim() || id.length > 256)
				throw new MailSendError("Resend returned an invalid message id", true);
			return id;
		});
	}

	async messageId(providerMessageId: string): Promise<string | null> {
		return withTimeoutScope(SEND_TIMEOUT_MS, async (signal) => {
			const response = await this.#fetch(`https://api.resend.com/emails/${encodeURIComponent(providerMessageId)}`, {
				headers: { Authorization: `Bearer ${this.#apiKey}` },
				redirect: "error",
				signal,
			});
			if (response.status === 404) {
				void response.body?.cancel().catch(() => undefined);
				return null;
			}
			if (!response.ok) {
				void response.body?.cancel().catch(() => undefined);
				throw new Error(`Resend returned HTTP ${response.status}`);
			}
			const body = await readBoundedJson(response, RESEND_RESPONSE_MAX_BYTES, { signal });
			const id =
				body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).message_id : null;
			return typeof id === "string" && id.length <= 998 ? id : null;
		});
	}
}

/** The Edge Function. */
export async function handleMailOutbox(request: Request, outbox: MailOutbox): Promise<Response> {
	if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
	const apiKey = request.headers.get("apikey")?.trim();
	const authorization = request.headers.get("authorization")?.trim();
	const presented = apiKey || (authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "");
	if (!presented || !constantTimeIncludes(outbox.keys, presented)) return json({ error: "Unauthorized" }, 401);
	const store = outbox.store(presented);
	const leaseId = (outbox.leaseId ?? (() => crypto.randomUUID()))();
	let claim: ReturnType<typeof parseMailClaim>;
	try {
		claim = parseMailClaim(await store.claim(BATCH, leaseId));
	} catch {
		return json({ error: "The mail claim failed" }, 503);
	}
	let rejected = 0;
	for (const job of claim.rejected) {
		try {
			await store.fail(job.mailId, job.leaseId, job.message, false);
			rejected += 1;
		} catch {}
	}
	const pace = outbox.pace ?? PACE_MS;
	const sleep = outbox.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const now = outbox.now ?? Date.now;
	const deadline = now() + (outbox.budgetMs ?? 45_000);
	const counts = {
		claimed: claim.jobs.length + claim.rejected.length,
		sent: 0,
		retrying: 0,
		failed: 0,
		rejected,
		deferred: 0,
		messageIds: 0,
	};
	let objects: ObjectReader | undefined;
	for (const [index, job] of claim.jobs.entries()) {
		if (now() >= deadline) {
			counts.deferred = claim.jobs.length - index;
			break;
		}
		if (index > 0 && pace > 0) await sleep(pace);
		if (now() >= deadline) {
			counts.deferred = claim.jobs.length - index;
			break;
		}
		let providerMessageId: string;
		try {
			// Each file in base64 as soon as it is read, without a copy: its bytes are dropped before the next one.
			const contents: string[][] = [];
			if (job.attachments.length > 0) {
				objects ??= outbox.objects?.(presented);
				for (const file of job.attachments) {
					if (!objects || !job.companyId) throw new MailSendError("Attachments cannot be read here", true);
					contents.push(await attachmentBase64(job.companyId, file, objects));
				}
			}
			// WHY: Recheck budget after reading attachments so slow object fetches do not start an upload past the worker deadline.
			if (now() >= deadline) {
				counts.deferred = claim.jobs.length - index;
				break;
			}
			providerMessageId = await outbox.sender.send(providerEmail(job, contents), `company-mail/${job.mailId}`);
		} catch (error) {
			const failure =
				error instanceof MailSendError ? error : new MailSendError("The email could not be sent", true);
			try {
				await store.fail(job.mailId, job.leaseId, failure.message, failure.retryable);
				counts[failure.retryable ? "retrying" : "failed"] += 1;
			} catch {
				console.error("mail-outbox: failed recording delivery failure", { mailId: job.mailId });
			}
			continue;
		}
		// A completion that is lost leaves the lease to expire: the send is repeated with the same idempotency key.
		try {
			await store.complete(job, providerMessageId);
			counts.sent += 1;
		} catch {
			console.error("mail-outbox: failed recording delivery completion", { mailId: job.mailId });
		}
	}
	// The provider's Message-ID of what was sent (I5a): best effort, the database asks again in five minutes.
	let due: { mailId: string; providerMessageId: string }[] = [];
	if (now() < deadline) {
		try {
			due = parseMessageIdsDue(await store.messageIdsDue(MESSAGE_ID_BATCH));
		} catch {}
	}
	for (const [index, item] of due.entries()) {
		if (now() >= deadline) break;
		if ((claim.jobs.length > 0 || index > 0) && pace > 0) await sleep(pace);
		if (now() >= deadline) break;
		try {
			const messageId = await outbox.sender.messageId(item.providerMessageId);
			if (messageId) {
				await store.recordMessageId(item.mailId, item.providerMessageId, messageId);
				counts.messageIds += 1;
			}
		} catch {}
	}
	return json(counts);
}
