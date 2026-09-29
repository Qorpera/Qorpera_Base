import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import {
	type ComputerHourEmail,
	type ComputerHourEmailProvider,
	ComputerHourEmailSendError,
	type ComputerHourNoticeJob,
	type ComputerHourNoticeStore,
	deliverComputerHourNoticeBatch,
	parseComputerHourNoticeClaim,
} from "../_shared/computer-hour-notices.ts";

/* Sends the computer hour notices the database queued (build step 5). Called every minute by
 * pg_cron + pg_net with a Supabase secret key, like profile-invitation-email; see
 * deploy/first-node/RUNTIME-COMPUTER-HOURS.md ("Email"). A batch of ten at ten seconds a send at most
 * fits well inside the five-minute lease. */
const BATCH = 10;
const SEND_TIMEOUT_MS = 10_000;

interface FunctionConfiguration {
	supabaseUrl: string;
	secretKey: string;
	resendApiKey: string;
	from: string;
	appUrl: string;
}

function jsonResponse(value: unknown, status = 200): Response {
	return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function configuredSecretKeys(): string[] {
	const legacyServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
	try {
		const parsed: unknown = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return legacyServiceRoleKey ? [legacyServiceRoleKey] : [];
		}
		const keys = Object.values(parsed).filter(
			(value): value is string => typeof value === "string" && value.length > 20,
		);
		if (legacyServiceRoleKey) keys.push(legacyServiceRoleKey);
		return [...new Set(keys)];
	} catch {
		return legacyServiceRoleKey ? [legacyServiceRoleKey] : [];
	}
}

function configuration(request: Request): FunctionConfiguration | Response {
	const apiKey = request.headers.get("apikey")?.trim();
	const authorization = request.headers.get("authorization")?.trim();
	const presentedKey =
		apiKey || (authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "");
	if (!presentedKey || !configuredSecretKeys().includes(presentedKey)) return jsonResponse({ error: "Unauthorized" }, 401);
	const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
	const resendApiKey = Deno.env.get("RESEND_API_KEY") ?? "";
	const from = Deno.env.get("QORPERA_HOURS_FROM") ?? "";
	const appUrl = Deno.env.get("QORPERA_APP_URL") ?? "";
	if (!supabaseUrl || !resendApiKey || !from || !appUrl) {
		return jsonResponse({ error: "Computer hour notices are not configured" }, 503);
	}
	try {
		if (new URL(appUrl).protocol !== "https:") throw new Error("The app URL must use HTTPS");
	} catch {
		return jsonResponse({ error: "The app URL is invalid" }, 503);
	}
	return { supabaseUrl, secretKey: presentedKey, resendApiKey, from, appUrl };
}

async function resendFailure(response: Response): Promise<ComputerHourEmailSendError> {
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
	return new ComputerHourEmailSendError(`${message} (${response.status}${code ? `/${code}` : ""})`, retryable);
}

class ResendProvider implements ComputerHourEmailProvider {
	private readonly apiKey: string;
	private readonly from: string;

	constructor(apiKey: string, from: string) {
		this.apiKey = apiKey;
		this.from = from;
	}

	async send(job: ComputerHourNoticeJob, email: ComputerHourEmail, idempotencyKey: string): Promise<{ messageId: string }> {
		let response: Response;
		try {
			response = await fetch("https://api.resend.com/emails", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
					"Content-Type": "application/json",
					"Idempotency-Key": idempotencyKey,
				},
				body: JSON.stringify({ from: this.from, to: [job.recipientEmail], subject: email.subject, text: email.text, html: email.html }),
				signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
			});
		} catch (error) {
			throw new ComputerHourEmailSendError(error instanceof Error ? error.message : "Resend request failed", true);
		}
		if (!response.ok) throw await resendFailure(response);
		const body: unknown = await response.json();
		if (!body || typeof body !== "object" || Array.isArray(body)) {
			throw new ComputerHourEmailSendError("Resend returned an invalid response", true);
		}
		const messageId = (body as Record<string, unknown>).id;
		if (typeof messageId !== "string" || !messageId.trim() || messageId.length > 256) {
			throw new ComputerHourEmailSendError("Resend returned an invalid message id", true);
		}
		return { messageId };
	}
}

Deno.serve(async (request) => {
	if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
	const config = configuration(request);
	if (config instanceof Response) return config;
	const client = createClient(config.supabaseUrl, config.secretKey, {
		auth: { autoRefreshToken: false, persistSession: false },
	});
	const leaseId = crypto.randomUUID();
	const { data: claimed, error: claimError } = await client.rpc("qorpera_claim_computer_hour_notices", {
		p_limit: BATCH,
		p_lease_id: leaseId,
	});
	if (claimError) return jsonResponse({ error: "Notice claim failed" }, 503);
	let claim: ReturnType<typeof parseComputerHourNoticeClaim>;
	try {
		claim = parseComputerHourNoticeClaim(claimed);
	} catch {
		return jsonResponse({ error: "Notice claim was invalid" }, 503);
	}
	const fail = async (noticeId: string, lease: string, message: string, retryable: boolean) => {
		const { data, error } = await client.rpc("qorpera_fail_computer_hour_notice", {
			p_notice_id: noticeId,
			p_lease_id: lease,
			p_error: message,
			p_retryable: retryable,
		});
		if (error || data !== true) throw new Error("Notice failure could not be recorded");
	};
	// A notice that cannot be read is failed for good, so it holds up no other.
	let rejected = 0;
	for (const notice of claim.rejected) {
		try {
			await fail(notice.noticeId, notice.leaseId, notice.message, false);
			rejected += 1;
		} catch {}
	}
	const store: ComputerHourNoticeStore = {
		complete: async (job, providerMessageId) => {
			const { data, error } = await client.rpc("qorpera_complete_computer_hour_notice", {
				p_notice_id: job.noticeId,
				p_lease_id: job.leaseId,
				p_provider_message_id: providerMessageId,
			});
			if (error || data !== true) throw new Error("Notice completion failed");
		},
		fail: (job, message, retryable) => fail(job.noticeId, job.leaseId, message, retryable),
	};
	const result = await deliverComputerHourNoticeBatch(
		claim.jobs,
		config.appUrl,
		new ResendProvider(config.resendApiKey, config.from),
		store,
	);
	return jsonResponse({ ...result, rejected });
});
