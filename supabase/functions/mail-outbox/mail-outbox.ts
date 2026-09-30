/* Mail outbox (build step M2b; contract section 19, 2026-09-29 amendment "events wake agents", item 9; design
 * deploy/first-node/RUNTIME-EVENT-INTAKE.md, "Mail (M2)").
 *
 * POST /mail-outbox, called each minute by pg_cron + pg_net with a Supabase secret key, which the function checks
 * itself. It claims a batch of the email agents queued (qorpera_claim_company_mail, under a five-minute lease) and
 * sends each through the mail provider (Resend) with the platform's key, which no node or agent holds: from the
 * agent at the mailbox's address, plain text with the AI line the database added, and a reply's thread headers.
 * Each email's provider idempotency key is its id, so a send repeated after a lost answer or an expired lease is
 * the same email. A sent email is completed; a failure the provider may get past (a timeout, a rate limit, a server
 * error) is retried after 1, 2, 4 ... minutes, and any other fails the email. Sends are paced, since the provider
 * limits requests a second for the whole platform. Answers: 200 with counts, 401 for a missing or wrong key, 405,
 * and 503 when the claim fails. */

export const BATCH = 10;
/** Between two sends: the provider allows a few requests a second across the platform's email. */
export const PACE_MS = 600;
const SEND_TIMEOUT_MS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
}

/** The provider's send request (Resend's POST /emails). */
export interface ProviderEmail {
	from: string;
	to: string[];
	cc?: string[];
	subject: string;
	text: string;
	headers?: Record<string, string>;
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

export interface MailOutbox {
	/** The Supabase secret keys the caller may present. */
	keys: readonly string[];
	/** The database's outbox, reached with the key the caller presented. */
	store(secretKey: string): MailOutboxStore;
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
		if (
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
				([name, content]) => !["In-Reply-To", "References"].includes(name) || typeof content !== "string",
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
		});
	}
	return { jobs, rejected };
}

/** What the provider is asked to send: no empty cc, no empty headers. */
export function providerEmail(job: MailJob): ProviderEmail {
	return {
		from: job.from,
		to: job.to,
		...(job.cc.length ? { cc: job.cc } : {}),
		subject: job.subject,
		text: job.text,
		...(Object.keys(job.headers).length ? { headers: job.headers } : {}),
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
		let response: Response;
		try {
			response = await this.#fetch("https://api.resend.com/emails", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.#apiKey}`,
					"Content-Type": "application/json",
					"Idempotency-Key": idempotencyKey,
				},
				body: JSON.stringify(email),
				signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
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
	for (const [index, job] of claim.jobs.entries()) {
		if (index > 0 && pace > 0) await sleep(pace);
		let providerMessageId: string;
		try {
			providerMessageId = await outbox.sender.send(providerEmail(job), `company-mail/${job.mailId}`);
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
