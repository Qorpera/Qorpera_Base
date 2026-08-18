import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import {
	deliverProfileInvitationBatch,
	InvitationEmailSendError,
	parseProfileInvitationDeliveryJobs,
	type InvitationDeliveryStore,
	type InvitationEmailProvider,
	type ProfileInvitationDeliveryJob,
	type ProfileInvitationEmail,
} from "../_shared/profile-invitation-email.ts";

interface FunctionConfiguration {
	supabaseUrl: string;
	secretKey: string;
	resendApiKey: string;
	from: string;
	invitationUrl: string;
}

function jsonResponse(value: unknown, status = 200): Response {
	return Response.json(value, {
		status,
		headers: { "cache-control": "no-store" },
	});
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
	const secretKeys = configuredSecretKeys();
	const apiKey = request.headers.get("apikey")?.trim();
	const authorization = request.headers.get("authorization")?.trim();
	const presentedKey =
		apiKey || (authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "");
	if (!presentedKey || !secretKeys.includes(presentedKey)) return jsonResponse({ error: "Unauthorized" }, 401);
	const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
	const resendApiKey = Deno.env.get("RESEND_API_KEY") ?? "";
	const from = Deno.env.get("QORPERA_INVITE_FROM") ?? "";
	const invitationUrl = Deno.env.get("QORPERA_INVITE_URL") ?? "";
	if (!supabaseUrl || !resendApiKey || !from || !invitationUrl) {
		return jsonResponse({ error: "Invitation email delivery is not configured" }, 503);
	}
	try {
		const parsedUrl = new URL(invitationUrl);
		if (parsedUrl.protocol !== "https:") throw new Error("Invitation URL must use HTTPS");
	} catch {
		return jsonResponse({ error: "Invitation URL is invalid" }, 503);
	}
	return { supabaseUrl, secretKey: presentedKey, resendApiKey, from, invitationUrl };
}

async function resendFailure(response: Response): Promise<InvitationEmailSendError> {
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
	return new InvitationEmailSendError(`${message} (${response.status}${code ? `/${code}` : ""})`, retryable);
}

class ResendInvitationEmailProvider implements InvitationEmailProvider {
	private readonly apiKey: string;
	private readonly from: string;

	constructor(apiKey: string, from: string) {
		this.apiKey = apiKey;
		this.from = from;
	}

	async send(
		job: ProfileInvitationDeliveryJob,
		email: ProfileInvitationEmail,
		idempotencyKey: string,
	): Promise<{ messageId: string }> {
		let response: Response;
		try {
			response = await fetch("https://api.resend.com/emails", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
					"Content-Type": "application/json",
					"Idempotency-Key": idempotencyKey,
				},
				body: JSON.stringify({
					from: this.from,
					to: [job.recipientEmail],
					subject: email.subject,
					text: email.text,
					html: email.html,
				}),
			});
		} catch (error) {
			throw new InvitationEmailSendError(
				error instanceof Error ? error.message : "Resend request failed",
				true,
			);
		}
		if (!response.ok) throw await resendFailure(response);
		const body: unknown = await response.json();
		if (!body || typeof body !== "object" || Array.isArray(body)) {
			throw new InvitationEmailSendError("Resend returned an invalid response", true);
		}
		const messageId = (body as Record<string, unknown>).id;
		if (typeof messageId !== "string" || !messageId.trim() || messageId.length > 256) {
			throw new InvitationEmailSendError("Resend returned an invalid message id", true);
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
	const { data: claimed, error: claimError } = await client.rpc("qorpera_claim_profile_invitation_deliveries", {
		p_limit: 25,
		p_lease_id: leaseId,
	});
	if (claimError) return jsonResponse({ error: "Invitation delivery claim failed" }, 503);

	let jobs: ProfileInvitationDeliveryJob[];
	try {
		jobs = parseProfileInvitationDeliveryJobs(claimed);
	} catch {
		return jsonResponse({ error: "Invitation delivery claim was invalid" }, 503);
	}
	const store: InvitationDeliveryStore = {
		complete: async (job, providerMessageId) => {
			const { error } = await client.rpc("qorpera_complete_profile_invitation_delivery", {
				p_invitation_id: job.invitationId,
				p_lease_id: job.leaseId,
				p_provider_message_id: providerMessageId,
			});
			if (error) throw new Error("Invitation delivery completion failed");
		},
		fail: async (job, message, retryable) => {
			const { error } = await client.rpc("qorpera_fail_profile_invitation_delivery", {
				p_invitation_id: job.invitationId,
				p_lease_id: job.leaseId,
				p_error: message,
				p_retryable: retryable,
			});
			if (error) throw new Error("Invitation delivery failure could not be recorded");
		},
	};
	const result = await deliverProfileInvitationBatch(
		jobs,
		config.invitationUrl,
		new ResendInvitationEmailProvider(config.resendApiKey, config.from),
		store,
	);
	return jsonResponse(result);
});
