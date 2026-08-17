const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const INVITATION_DELIVERY_ROLES = ["admin", "contributor", "viewer"] as const;
export type InvitationDeliveryRole = (typeof INVITATION_DELIVERY_ROLES)[number];

export interface ProfileInvitationDeliveryJob {
	invitationId: string;
	profileId: string;
	profileName: string;
	recipientEmail: string;
	role: InvitationDeliveryRole;
	invitedByDisplayName: string;
	expiresAt: string;
	attemptCount: number;
	leaseId: string;
}

export interface ProfileInvitationEmail {
	subject: string;
	text: string;
	html: string;
	invitationUrl: string;
}

export interface InvitationEmailProvider {
	send(
		job: ProfileInvitationDeliveryJob,
		email: ProfileInvitationEmail,
		idempotencyKey: string,
	): Promise<{ messageId: string }>;
}

export interface InvitationDeliveryStore {
	complete(job: ProfileInvitationDeliveryJob, providerMessageId: string): Promise<void>;
	fail(job: ProfileInvitationDeliveryJob, message: string, retryable: boolean): Promise<void>;
}

export interface InvitationDeliveryBatchResult {
	claimed: number;
	delivered: number;
	retrying: number;
	failed: number;
	completionPending: number;
}

export class InvitationEmailSendError extends Error {
	readonly retryable: boolean;

	constructor(message: string, retryable: boolean) {
		super(message);
		this.name = "InvitationEmailSendError";
		this.retryable = retryable;
	}
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
	return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maximum: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > maximum || /\0/.test(value)) {
		throw new Error(`Invalid ${label}`);
	}
	return value.trim();
}

function uuid(value: unknown, label: string): string {
	const checked = text(value, label, 128);
	if (!UUID_PATTERN.test(checked)) throw new Error(`Invalid ${label}`);
	return checked;
}

function timestamp(value: unknown, label: string): string {
	const checked = text(value, label, 64);
	if (!Number.isFinite(Date.parse(checked))) throw new Error(`Invalid ${label}`);
	return new Date(checked).toISOString();
}

function integer(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`Invalid ${label}`);
	return value as number;
}

function role(value: unknown): InvitationDeliveryRole {
	if (!INVITATION_DELIVERY_ROLES.some((candidate) => candidate === value)) {
		throw new Error("Invalid invitation role");
	}
	return value as InvitationDeliveryRole;
}

export function parseProfileInvitationDeliveryJobs(value: unknown): ProfileInvitationDeliveryJob[] {
	if (!Array.isArray(value) || value.length > 50) throw new Error("Invalid invitation delivery job list");
	return value.map((entry) => {
		const input = record(entry, "invitation delivery job");
		const recipientEmail = text(input.recipient_email, "recipient email", 320).toLowerCase();
		if (!EMAIL_PATTERN.test(recipientEmail)) throw new Error("Invalid recipient email");
		return {
			invitationId: uuid(input.invitation_id, "invitation id"),
			profileId: uuid(input.profile_id, "profile id"),
			profileName: text(input.profile_name, "profile name", 120),
			recipientEmail,
			role: role(input.role),
			invitedByDisplayName: text(input.invited_by_display_name, "inviter display name", 256),
			expiresAt: timestamp(input.expires_at, "invitation expiry"),
			attemptCount: integer(input.attempt_count, "attempt count"),
			leaseId: uuid(input.lease_id, "lease id"),
		};
	});
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function roleDescription(roleValue: InvitationDeliveryRole): string {
	if (roleValue === "admin") return "full access to contribute, authorize actions, and manage members";
	if (roleValue === "contributor") return "partial access to contribute and communicate without authorizing actions";
	return "read-only access";
}

export function invitationIdempotencyKey(invitationId: string): string {
	if (!UUID_PATTERN.test(invitationId)) throw new Error("Invalid invitation id");
	return `qorpera-profile-invitation/${invitationId}`;
}

export function buildProfileInvitationEmail(
	job: ProfileInvitationDeliveryJob,
	invitationUrlBase: string,
): ProfileInvitationEmail {
	const invitationUrl = new URL(invitationUrlBase);
	if (invitationUrl.protocol !== "https:") throw new Error("Invitation URL must use HTTPS");
	invitationUrl.hash = new URLSearchParams({ invitation: job.invitationId }).toString();
	const permission = roleDescription(job.role);
	const expiry = new Intl.DateTimeFormat("en", {
		dateStyle: "long",
		timeZone: "UTC",
	}).format(new Date(job.expiresAt));
	const subject = `${job.invitedByDisplayName} invited you to ${job.profileName} on Qorpera`.replace(/[\r\n]/g, " ");
	const textBody = [
		`${job.invitedByDisplayName} invited you to join ${job.profileName} on Qorpera.`,
		`You will have ${permission}.`,
		`Open Qorpera and sign in as ${job.recipientEmail}. Qorpera will show the invitation before you choose whether to accept it.`,
		`Open Qorpera: ${invitationUrl.href}`,
		`This invitation expires on ${expiry}.`,
	].join("\n\n");
	const html = `<!doctype html><html><body style="margin:0;background:#f4f4f2;color:#171716;font-family:Inter,Arial,sans-serif"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:40px 16px"><table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;background:#fff;border-radius:18px"><tr><td style="padding:36px"><p style="margin:0 0 28px;font-weight:700">Qorpera</p><h1 style="font-size:25px;line-height:1.25;margin:0 0 18px">Join ${escapeHtml(job.profileName)}</h1><p style="font-size:16px;line-height:1.6;margin:0 0 14px">${escapeHtml(job.invitedByDisplayName)} invited you to join their company profile with ${escapeHtml(permission)}.</p><p style="font-size:16px;line-height:1.6;margin:0 0 26px">Sign in as <strong>${escapeHtml(job.recipientEmail)}</strong> to accept.</p><p style="margin:0 0 26px"><a href="${escapeHtml(invitationUrl.href)}" style="display:inline-block;background:#171716;color:#fff;text-decoration:none;border-radius:10px;padding:13px 18px;font-weight:600">Open Qorpera</a></p><p style="font-size:13px;line-height:1.5;color:#686864;margin:0">This invitation expires on ${escapeHtml(expiry)}. If you were not expecting it, you can ignore this email.</p></td></tr></table></td></tr></table></body></html>`;
	return { subject: subject.slice(0, 240), text: textBody, html, invitationUrl: invitationUrl.href };
}

function deliveryError(error: unknown): { message: string; retryable: boolean } {
	if (error instanceof InvitationEmailSendError) {
		return { message: error.message.slice(0, 1000), retryable: error.retryable };
	}
	const message = error instanceof Error ? error.message : String(error);
	return { message: message.slice(0, 1000), retryable: true };
}

export async function deliverProfileInvitationBatch(
	jobs: readonly ProfileInvitationDeliveryJob[],
	invitationUrlBase: string,
	provider: InvitationEmailProvider,
	store: InvitationDeliveryStore,
): Promise<InvitationDeliveryBatchResult> {
	const result: InvitationDeliveryBatchResult = {
		claimed: jobs.length,
		delivered: 0,
		retrying: 0,
		failed: 0,
		completionPending: 0,
	};
	for (const job of jobs) {
		let providerMessageId: string;
		try {
			const email = buildProfileInvitationEmail(job, invitationUrlBase);
			const sent = await provider.send(job, email, invitationIdempotencyKey(job.invitationId));
			providerMessageId = text(sent.messageId, "provider message id", 256);
		} catch (error) {
			const failure = deliveryError(error);
			await store.fail(job, failure.message, failure.retryable);
			if (failure.retryable) result.retrying += 1;
			else result.failed += 1;
			continue;
		}
		try {
			await store.complete(job, providerMessageId);
			result.delivered += 1;
		} catch {
			// Keep the lease unresolved. After it expires, the same provider
			// idempotency key safely reconciles an ambiguous remote commit.
			result.completionPending += 1;
		}
	}
	return result;
}
