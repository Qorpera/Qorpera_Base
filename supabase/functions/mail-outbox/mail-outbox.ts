/* Mail outbox (build step M2b; contract section 19, 2026-09-29 amendment "events wake agents", item 9; design
 * deploy/first-node/RUNTIME-EVENT-INTAKE.md, "Mail (M2)").
 *
 * POST /mail-outbox, called each minute by pg_cron + pg_net with a Supabase secret key, which the function checks
 * itself. It claims a batch of the email agents queued (qorpera_claim_company_mail, under a five-minute lease) and
 * sends each through the mail provider (Resend) with the platform's key, which no node or agent holds: from the
 * agent at the mailbox's address, plain text with the AI line the database added, and a reply's thread headers and
 * Auto-Submitted: auto-replied. An email with attachments (M2c-1) carries the company files as they were when queued,
 * read from the company's objects in Storage (each a manifest and its chunks, checked against their digests) and sent
 * as the email's attachments; a file whose bytes are not in Storage yet is tried again later.
 * Each email's provider idempotency key is its id, so a send repeated after a lost answer or an expired lease is
 * the same email. A sent email is completed; a failure the provider may get past (a timeout, a rate limit, a server
 * error) is retried after 1, 2, 4 ... minutes, and any other fails the email. Sends are paced, since the provider
 * limits requests a second for the whole platform. Answers: 200 with counts, 401 for a missing or wrong key, 405,
 * and 503 when the claim fails. */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

export const BATCH = 10;
/** Between two sends: the provider allows a few requests a second across the platform's email. */
export const PACE_MS = 600;
const SEND_TIMEOUT_MS = 10_000;
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
	attachments?: { filename: string; content: string }[];
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
}

/** Sends one email; resolves to the provider's message id or throws MailSendError. */
export interface MailSender {
	send(email: ProviderEmail, idempotencyKey: string): Promise<string>;
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

/** One attached file's bytes from the company's objects: its manifest, then its chunks, each checked against its
 * digest, and the whole against the file's. Not in Storage yet is worth another try; anything else is not. */
export async function attachmentBytes(companyId: string, file: MailAttachment, objects: ObjectReader): Promise<Uint8Array> {
	const object = async (sha256: string): Promise<Uint8Array> => {
		const bytes = await objects.get(companyId, sha256);
		if (!bytes) throw new MailSendError(`The attachment ${file.filename} is not in storage yet`, true);
		if (createHash("sha256").update(bytes).digest("hex") !== sha256)
			throw new MailSendError(`The attachment ${file.filename} failed its integrity check`, false);
		return bytes;
	};
	let manifest: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await object(file.manifestSha256)));
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
	const output = new Uint8Array(file.bytes);
	let offset = 0;
	for (const chunk of chunks as { sha256: string; bytes: number }[]) {
		const bytes = await object(chunk.sha256);
		if (bytes.length !== chunk.bytes) throw new MailSendError(`The attachment ${file.filename} failed its integrity check`, false);
		output.set(bytes, offset);
		offset += bytes.length;
	}
	if (createHash("sha256").update(output).digest("hex") !== file.fileSha256)
		throw new MailSendError(`The attachment ${file.filename} failed its integrity check`, false);
	return output;
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
		let response: Response;
		try {
			response = await this.#fetch(
				`${this.#projectUrl}/storage/v1/object/authenticated/${OBJECT_BUCKET}/${companyId}/${sha256}`,
				{ headers: storageHeaders(this.#secretKey), signal: AbortSignal.timeout(30_000) },
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
				code = ((await response.json()) as { statusCode?: unknown }).statusCode;
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
		return new Uint8Array(await response.arrayBuffer());
	}
}

/** What the provider is asked to send: no empty cc, no empty headers, each file's bytes in base64. */
export function providerEmail(job: MailJob, contents: readonly string[] = []): ProviderEmail {
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
export async function providerFailure(response: Response): Promise<MailSendError> {
	let code = "";
	let message = `Resend returned HTTP ${response.status}`;
	try {
		const body: unknown = await response.json();
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

/** Resend's send API with the platform's key. */
export class ResendSender implements MailSender {
	readonly #apiKey: string;
	readonly #fetch: typeof fetch;
	constructor(apiKey: string, fetcher: typeof fetch = fetch) {
		this.#apiKey = apiKey;
		this.#fetch = fetcher;
	}

	async send(email: ProviderEmail, idempotencyKey: string): Promise<string> {
		const request = JSON.stringify(email);
		let response: Response;
		try {
			response = await this.#fetch("https://api.resend.com/emails", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.#apiKey}`,
					"Content-Type": "application/json",
					"Idempotency-Key": idempotencyKey,
				},
				body: request,
				// A second more for each MiB an email with attachments carries.
				signal: AbortSignal.timeout(SEND_TIMEOUT_MS + Math.floor(request.length / (1024 * 1024)) * 1000),
			});
		} catch (error) {
			throw new MailSendError(error instanceof Error ? error.message : "Resend request failed", true);
		}
		if (!response.ok) throw await providerFailure(response);
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			throw new MailSendError("Resend returned an invalid response", true);
		}
		const id = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).id : undefined;
		if (typeof id !== "string" || !id.trim() || id.length > 256)
			throw new MailSendError("Resend returned an invalid message id", true);
		return id;
	}
}

/** The Edge Function. */
export async function handleMailOutbox(request: Request, outbox: MailOutbox): Promise<Response> {
	if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
	const apiKey = request.headers.get("apikey")?.trim();
	const authorization = request.headers.get("authorization")?.trim();
	const presented = apiKey || (authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "");
	if (!presented || !outbox.keys.includes(presented)) return json({ error: "Unauthorized" }, 401);
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
	const counts = { claimed: claim.jobs.length + claim.rejected.length, sent: 0, retrying: 0, failed: 0, rejected };
	const objects = outbox.objects?.(presented);
	for (const [index, job] of claim.jobs.entries()) {
		if (index > 0 && pace > 0) await sleep(pace);
		let providerMessageId: string;
		try {
			// Each file in base64 as soon as it is read, without a copy: its bytes are dropped before the next one.
			const contents: string[] = [];
			for (const file of job.attachments) {
				if (!objects || !job.companyId) throw new MailSendError("Attachments cannot be read here", true);
				const bytes = await attachmentBytes(job.companyId, file, objects);
				contents.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64"));
			}
			providerMessageId = await outbox.sender.send(providerEmail(job, contents), `company-mail/${job.mailId}`);
		} catch (error) {
			const failure =
				error instanceof MailSendError ? error : new MailSendError("The email could not be sent", true);
			try {
				await store.fail(job.mailId, job.leaseId, failure.message, failure.retryable);
				counts[failure.retryable ? "retrying" : "failed"] += 1;
			} catch {}
			continue;
		}
		// A completion that is lost leaves the lease to expire: the send is repeated with the same idempotency key.
		try {
			await store.complete(job, providerMessageId);
			counts.sent += 1;
		} catch {}
	}
	return json(counts);
}
