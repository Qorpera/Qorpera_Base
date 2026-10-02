/* Mail attachments (build step M2c-1; design deploy/first-node/RUNTIME-EVENT-INTAKE.md, "Attachments (M2c-1)").
 *
 * POST /mail-attachments, called by the database (pg_net) when an agent first asks to save a received attachment, and
 * each minute by pg_cron, with a Supabase secret key, which the function checks itself. It claims a few fetches
 * (qorpera_claim_mail_attachment_fetches, under a five-minute lease) and, for each, asks the mail provider (Resend)
 * with the platform's key where the attachment is, streams it from there and stores it as the company's objects: 4 MiB
 * chunks, each named by its sha256 in the Storage bucket qorpera-profile-objects, which the catalog records and the
 * company's storage allowance counts. It completes the fetch with the file's digest, size and chunks. A failure the
 * provider or Storage may get past (a timeout, a rate limit, a server error) is tried again after 1, 2, 4 ... minutes;
 * an attachment the provider no longer has, one over 40 MiB, or an allowance used up fails for good. Answers: 200
 * with counts, 401 for a missing or wrong key, 405, and 503 when the claim fails. */

import { createHash } from "node:crypto";

export const BATCH = 3;
export const MAX_ATTACHMENT_BYTES = 40 * 1024 * 1024;
export const CHUNK_BYTES = 4 * 1024 * 1024;
export const OBJECT_BUCKET = "qorpera-profile-objects";
const LOCATE_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ATTACHMENT_ID = /^[A-Za-z0-9_.-]{1,128}$/;

/** One claimed fetch, as the database hands it over. */
export interface AttachmentFetchJob {
	fetchId: string;
	leaseId: string;
	attemptCount: number;
	companyId: string;
	emailId: string;
	attachmentId: string;
}

export interface AttachmentChunk {
	sha256: string;
	bytes: number;
}

export interface StoredAttachment {
	fileSha256: string;
	bytes: number;
	chunks: AttachmentChunk[];
}

/** The database's side of the fetches. */
export interface AttachmentFetchStore {
	claim(limit: number, leaseId: string): Promise<unknown>;
	complete(job: AttachmentFetchJob, stored: StoredAttachment): Promise<void>;
	fail(job: AttachmentFetchJob, message: string, retryable: boolean): Promise<void>;
}

/** Where the provider serves a received attachment: a URL valid for a while, and its size when it says. */
export interface AttachmentLocation {
	url: string;
	size: number | null;
}

/** The provider's received-attachment API. */
export interface AttachmentProvider {
	/** The attachment's location, or null when the provider no longer has it. */
	locate(emailId: string, attachmentId: string): Promise<AttachmentLocation | null>;
	/** The attachment's bytes. */
	download(location: AttachmentLocation, signal: AbortSignal): Promise<Response>;
}

/** The company's objects: one chunk stored under its sha256; an object already there is stored. */
export interface ObjectSink {
	put(companyId: string, sha256: string, bytes: Uint8Array): Promise<void>;
}

export class AttachmentFetchError extends Error {
	readonly retryable: boolean;
	constructor(message: string, retryable: boolean) {
		super(message);
		this.name = "AttachmentFetchError";
		this.retryable = retryable;
	}
}

export interface MailAttachments {
	/** The Supabase secret keys the caller may present. */
	keys: readonly string[];
	/** The database's fetches and the company's objects, reached with the key the caller presented. */
	store(secretKey: string): AttachmentFetchStore;
	sink(secretKey: string): ObjectSink;
	provider: AttachmentProvider;
	leaseId?: () => string;
}

function json(value: unknown, status = 200): Response {
	return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

/** The claimed fetches; a claim that cannot be read is refused whole. */
export function parseFetchClaim(value: unknown): AttachmentFetchJob[] {
	if (!Array.isArray(value) || value.length > 10) throw new Error("The attachment claim is invalid");
	return value.map((item) => {
		const job = item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : {};
		if (
			typeof job.fetchId !== "string" ||
			!UUID.test(job.fetchId) ||
			typeof job.leaseId !== "string" ||
			!UUID.test(job.leaseId) ||
			typeof job.companyId !== "string" ||
			!UUID.test(job.companyId) ||
			typeof job.emailId !== "string" ||
			!UUID.test(job.emailId) ||
			typeof job.attachmentId !== "string" ||
			!ATTACHMENT_ID.test(job.attachmentId) ||
			!Number.isSafeInteger(job.attemptCount)
		)
			throw new Error("The attachment claim is invalid");
		return {
			fetchId: job.fetchId,
			leaseId: job.leaseId,
			attemptCount: job.attemptCount as number,
			companyId: job.companyId,
			emailId: job.emailId,
			attachmentId: job.attachmentId,
		};
	});
}

/** A provider or Storage refusal: worth another try only for a timeout, a rate limit or a server error. */
function retryableStatus(status: number): boolean {
	return status === 408 || status === 429 || status >= 500;
}

/** Streams one attachment into the company's objects, chunk by chunk, and returns what was stored. */
export async function storeAttachment(
	job: AttachmentFetchJob,
	provider: AttachmentProvider,
	sink: ObjectSink,
): Promise<StoredAttachment> {
	const location = await provider.locate(job.emailId, job.attachmentId);
	if (!location)
		throw new AttachmentFetchError(
			"The mail provider no longer has this attachment (it keeps received mail 30 days)",
			false,
		);
	if (location.size !== null && location.size > MAX_ATTACHMENT_BYTES)
		throw new AttachmentFetchError("The attachment is larger than 40 MiB, the most an attachment saved may be", false);
	const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
	let response: Response;
	try {
		response = await provider.download(location, signal);
	} catch (error) {
		throw new AttachmentFetchError(error instanceof Error ? error.message : "The download failed", true);
	}
	if (!response.ok) {
		void response.body?.cancel().catch(() => undefined);
		throw new AttachmentFetchError(`The mail provider returned HTTP ${response.status} for the attachment`, true);
	}
	const reader = response.body?.getReader();
	if (!reader) throw new AttachmentFetchError("The mail provider returned no attachment", true);
	const file = createHash("sha256");
	const chunks: AttachmentChunk[] = [];
	const buffer = new Uint8Array(CHUNK_BYTES);
	let filled = 0;
	let total = 0;
	const flush = async () => {
		const bytes = buffer.slice(0, filled);
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		await sink.put(job.companyId, sha256, bytes);
		chunks.push({ sha256, bytes: bytes.length });
		filled = 0;
	};
	try {
		for (;;) {
			let next: ReadableStreamReadResult<Uint8Array>;
			try {
				next = await reader.read();
			} catch (error) {
				throw new AttachmentFetchError(error instanceof Error ? error.message : "The download failed", true);
			}
			if (next.done) break;
			total += next.value.byteLength;
			if (total > MAX_ATTACHMENT_BYTES)
				throw new AttachmentFetchError(
					"The attachment is larger than 40 MiB, the most an attachment saved may be",
					false,
				);
			file.update(next.value);
			let offset = 0;
			while (offset < next.value.byteLength) {
				const take = Math.min(CHUNK_BYTES - filled, next.value.byteLength - offset);
				buffer.set(next.value.subarray(offset, offset + take), filled);
				filled += take;
				offset += take;
				if (filled === CHUNK_BYTES) await flush();
			}
		}
		if (filled > 0) await flush();
	} finally {
		void reader.cancel().catch(() => undefined);
	}
	if (location.size !== null && location.size !== total)
		throw new AttachmentFetchError("The attachment's size differs from what the mail provider announced", true);
	return { fileSha256: file.digest("hex"), bytes: total, chunks };
}

/** Resend's received-attachment API with the platform's key. */
export class ResendAttachments implements AttachmentProvider {
	readonly #apiKey: string;
	readonly #fetch: typeof fetch;
	constructor(apiKey: string, fetcher: typeof fetch = fetch) {
		this.#apiKey = apiKey;
		this.#fetch = fetcher;
	}

	async locate(emailId: string, attachmentId: string): Promise<AttachmentLocation | null> {
		let response: Response;
		try {
			response = await this.#fetch(
				`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}/attachments?limit=100`,
				{ headers: { authorization: `Bearer ${this.#apiKey}` }, signal: AbortSignal.timeout(LOCATE_TIMEOUT_MS) },
			);
		} catch (error) {
			throw new AttachmentFetchError(error instanceof Error ? error.message : "Resend request failed", true);
		}
		if (response.status === 404) {
			void response.body?.cancel().catch(() => undefined);
			return null;
		}
		if (!response.ok) {
			void response.body?.cancel().catch(() => undefined);
			throw new AttachmentFetchError(`Resend returned HTTP ${response.status}`, retryableStatus(response.status));
		}
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			throw new AttachmentFetchError("Resend returned an invalid attachment list", true);
		}
		const list = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).data : null;
		if (!Array.isArray(list)) throw new AttachmentFetchError("Resend returned an invalid attachment list", true);
		const item = list.find(
			(entry): entry is Record<string, unknown> =>
				!!entry && typeof entry === "object" && (entry as Record<string, unknown>).id === attachmentId,
		);
		if (!item) return null;
		const url = item.download_url;
		let host = "";
		try {
			const parsed = typeof url === "string" ? new URL(url) : null;
			if (parsed?.protocol === "https:" && !parsed.username && !parsed.password) host = parsed.hostname;
		} catch {
			// Not an address.
		}
		// Only the provider's own download hosts: the address is followed without the key, but never elsewhere.
		if (typeof url !== "string" || !(host === "resend.com" || host.endsWith(".resend.com")))
			throw new AttachmentFetchError("Resend returned a download address outside resend.com", false);
		const size = item.size;
		return { url, size: typeof size === "number" && Number.isSafeInteger(size) && size >= 0 ? size : null };
	}

	download(location: AttachmentLocation, signal: AbortSignal): Promise<Response> {
		// A signed address: no key goes with it.
		return this.#fetch(location.url, { redirect: "follow", signal });
	}
}

/** Supabase Storage's headers for a secret key: a legacy JWT key goes as the bearer too. */
export function storageHeaders(secretKey: string): Record<string, string> {
	return /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(secretKey)
		? { apikey: secretKey, authorization: `Bearer ${secretKey}` }
		: { apikey: secretKey };
}

/** The company's objects in Storage, named `<company>/<sha256>`, never overwritten. */
export class StorageObjectSink implements ObjectSink {
	readonly #projectUrl: string;
	readonly #secretKey: string;
	readonly #fetch: typeof fetch;
	constructor(projectUrl: string, secretKey: string, fetcher: typeof fetch = fetch) {
		this.#projectUrl = projectUrl.replace(/\/+$/, "");
		this.#secretKey = secretKey;
		this.#fetch = fetcher;
	}

	async put(companyId: string, sha256: string, bytes: Uint8Array): Promise<void> {
		let response: Response;
		try {
			response = await this.#fetch(`${this.#projectUrl}/storage/v1/object/${OBJECT_BUCKET}/${companyId}/${sha256}`, {
				method: "POST",
				headers: {
					...storageHeaders(this.#secretKey),
					"content-type": "application/octet-stream",
					"x-upsert": "false",
				},
				body: bytes,
				signal: AbortSignal.timeout(60_000),
			});
		} catch (error) {
			throw new AttachmentFetchError(error instanceof Error ? error.message : "Storage request failed", true);
		}
		if (response.ok) {
			void response.body?.cancel().catch(() => undefined);
			return;
		}
		const text = await response.text().catch(() => "");
		// The same bytes are already there: Storage answers 409, or 400 with its own 409 code.
		let duplicate = response.status === 409;
		let message = "";
		try {
			const body = JSON.parse(text) as { statusCode?: unknown; message?: unknown; error?: unknown };
			duplicate ||= body.statusCode === "409";
			message = [body.message, body.error].filter((part) => typeof part === "string").join(" ");
		} catch {
			// Not JSON.
		}
		if (duplicate) return;
		if (/allowance/i.test(message))
			throw new AttachmentFetchError("The company's storage allowance is used up", false);
		throw new AttachmentFetchError(`Storage returned HTTP ${response.status}`, retryableStatus(response.status));
	}
}

/** The Edge Function. */
export async function handleMailAttachments(request: Request, options: MailAttachments): Promise<Response> {
	if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
	const apiKey = request.headers.get("apikey")?.trim();
	const authorization = request.headers.get("authorization")?.trim();
	const presented = apiKey || (authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "");
	if (!presented || !options.keys.includes(presented)) return json({ error: "Unauthorized" }, 401);
	const store = options.store(presented);
	const sink = options.sink(presented);
	const leaseId = (options.leaseId ?? (() => crypto.randomUUID()))();
	let jobs: AttachmentFetchJob[];
	try {
		jobs = parseFetchClaim(await store.claim(BATCH, leaseId));
	} catch {
		return json({ error: "The attachment claim failed" }, 503);
	}
	const counts = { claimed: jobs.length, stored: 0, retrying: 0, failed: 0 };
	for (const job of jobs) {
		let stored: StoredAttachment;
		try {
			stored = await storeAttachment(job, options.provider, sink);
		} catch (error) {
			const failure =
				error instanceof AttachmentFetchError ? error : new AttachmentFetchError("The attachment could not be fetched", true);
			try {
				await store.fail(job, failure.message.slice(0, 1000), failure.retryable);
				counts[failure.retryable ? "retrying" : "failed"] += 1;
			} catch {}
			continue;
		}
		// A completion that is lost leaves the lease to expire: the next fetch stores the same objects again.
		try {
			await store.complete(job, stored);
			counts.stored += 1;
		} catch {}
	}
	return json(counts);
}
