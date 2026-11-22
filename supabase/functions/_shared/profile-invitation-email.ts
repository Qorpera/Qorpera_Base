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

export type InvitationDeliveryLease = Pick<ProfileInvitationDeliveryJob, "invitationId" | "leaseId">;

export interface UnusableInvitationDeliveryJob extends InvitationDeliveryLease {
	message: string;
}

export interface ClaimedInvitationDeliveries {
	jobs: ProfileInvitationDeliveryJob[];
	unusable: UnusableInvitationDeliveryJob[];
	unreadable: number;
}

export interface InvitationDeliveryStore {
	complete(job: ProfileInvitationDeliveryJob, providerMessageId: string): Promise<void>;
	fail(lease: InvitationDeliveryLease, message: string, retryable: boolean): Promise<void>;
}

export interface InvitationDeliveryBatchResult {
	claimed: number;
	delivered: number;
	retrying: number;
	failed: number;
	completionPending: number;
	unreadable: number;
	deferred: number;
}

export const SHOWN_NAME_LENGTH = 80;
export const SUBJECT_LENGTH = 200;
const CLAIMED_NAME_LIMIT = 4096;

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

export function shownName(value: string, maximum = SHOWN_NAME_LENGTH): string {
	const segments = Array.from(
		new Intl.Segmenter("en", { granularity: "grapheme" }).segment(value.replace(/\s+/g, " ").trim()),
		(part) => part.segment,
	);
	if (segments.length <= maximum) return segments.join("");
	const cut = segments.slice(0, maximum - 1).join("");
	const lastSpace = cut.lastIndexOf(" ");
	const wordEnd = lastSpace >= cut.length / 2 ? cut.slice(0, lastSpace) : cut;
	return `${wordEnd.replace(/[\s\p{P}]+$/u, "") || cut}…`;
}

function name(value: unknown, label: string): string {
	return shownName(text(value, label, CLAIMED_NAME_LIMIT));
}

function deliveryJob(entry: unknown): ProfileInvitationDeliveryJob {
	const input = record(entry, "invitation delivery job");
	const recipientEmail = text(input.recipient_email, "recipient email", 320).toLowerCase();
	if (!EMAIL_PATTERN.test(recipientEmail)) throw new Error("Invalid recipient email");
	return {
		invitationId: uuid(input.invitation_id, "invitation id"),
		profileId: uuid(input.profile_id, "profile id"),
		profileName: name(input.profile_name, "profile name"),
		recipientEmail,
		role: role(input.role),
		invitedByDisplayName: name(input.invited_by_display_name, "inviter display name"),
		expiresAt: timestamp(input.expires_at, "invitation expiry"),
		attemptCount: integer(input.attempt_count, "attempt count"),
		leaseId: uuid(input.lease_id, "lease id"),
	};
}

function deliveryLease(entry: unknown): InvitationDeliveryLease | undefined {
	try {
		const input = record(entry, "invitation delivery job");
		return { invitationId: uuid(input.invitation_id, "invitation id"), leaseId: uuid(input.lease_id, "lease id") };
	} catch {
		return undefined;
	}
}

export function parseProfileInvitationDeliveryJobs(value: unknown): ClaimedInvitationDeliveries {
	if (!Array.isArray(value) || value.length > 50) throw new Error("Invalid invitation delivery job list");
	const claimed: ClaimedInvitationDeliveries = { jobs: [], unusable: [], unreadable: 0 };
	for (const entry of value) {
		try {
			claimed.jobs.push(deliveryJob(entry));
		} catch (error) {
			const lease = deliveryLease(entry);
			if (!lease) claimed.unreadable += 1;
			else claimed.unusable.push({ ...lease, message: error instanceof Error ? error.message : String(error) });
		}
	}
	return claimed;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function roleLine(roleValue: InvitationDeliveryRole): string {
	if (roleValue === "admin") return "You can work with its agents, approve what they do and manage its members.";
	if (roleValue === "contributor") return "You can work with its agents; its admins approve what they do.";
	return "You can see the company, its agents and what they're doing.";
}

const BRAND_ASSETS = "https://app.qorpera.com/assets/brand";
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

function invitationHtml(inviter: string, profile: string, recipient: string, role: string, expiry: string, href: string): string {
	const text = (size: number, color: string, margin: string) =>
		`margin:${margin};font-family:${FONT};font-size:${size}px;line-height:1.55;color:${color}`;
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head><body style="margin:0;padding:0;background:#f5f3ee"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f3ee"><tr><td align="center" style="padding:40px 16px 48px"><table role="presentation" width="520" cellspacing="0" cellpadding="0" style="max-width:520px;width:100%"><tr><td style="padding:0 6px 22px"><img src="${BRAND_ASSETS}/qorpera-lockup-light-800.png" alt="Qorpera" width="128" height="32" style="display:block;border:0"></td></tr><tr><td style="background:#ffffff;border-radius:18px;padding:0;border:1px solid rgba(11,11,11,0.06)"><div style="background:#fafaf9;border-bottom:1px solid rgba(11,11,11,0.06);border-radius:18px 18px 0 0;text-align:center;padding:22px 0 14px"><img src="${BRAND_ASSETS}/crown-glance.gif" alt="" width="150" height="126" style="display:inline-block;border:0"></div><div style="padding:30px 40px 36px"><h1 style="margin:0 0 12px;font-family:${FONT};font-size:26px;line-height:1.2;font-weight:700;letter-spacing:-0.02em;color:#161615">${inviter} invited you to ${profile}</h1><p style="${text(16, "#5f6168", "0 0 22px")}">${role}</p><table role="presentation" cellspacing="0" cellpadding="0" style="margin:4px 0 26px"><tr><td style="background:#161615;border-radius:10px"><a href="${href}" style="display:inline-block;padding:14px 22px;font-family:${FONT};font-size:16px;font-weight:600;color:#ffffff;text-decoration:none">See the invitation</a></td></tr></table><p style="${text(13.5, "#8b8b86", "0")}">Sign in or create your account with ${recipient} to accept. The invitation runs out on ${expiry}.</p></div></td></tr><tr><td style="padding:22px 6px 0"><p style="${text(13.5, "#8b8b86", "0")}">You got this email because ${inviter} invited ${recipient}. Not expecting it? Ignore it.</p><p style="${text(13.5, "#8b8b86", "10px 0 0")}">Qorpera · <a href="https://qorpera.com" style="color:#8b8b86">qorpera.com</a></p></td></tr></table></td></tr></table></body></html>`;
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
	const role = roleLine(job.role);
	const expiry = new Intl.DateTimeFormat("en", {
		dateStyle: "long",
		timeZone: "UTC",
	}).format(new Date(job.expiresAt));
	const unnamed = job.profileName === "No name yet";
	const company = unnamed ? "their new company" : job.profileName;
	const subject = shownName(`${job.invitedByDisplayName} invited you to ${company} on Qorpera`, SUBJECT_LENGTH);
	const textBody = [
		`${job.invitedByDisplayName} invited you to ${company} on Qorpera.`,
		role,
		`Sign in or create your account as ${job.recipientEmail}. Qorpera shows the invitation before you choose whether to accept it.`,
		`See the invitation: ${invitationUrl.href}`,
		`The invitation runs out on ${expiry}. Not expecting it? Ignore this email.`,
	].join("\n\n");
	const html = invitationHtml(
		escapeHtml(job.invitedByDisplayName),
		escapeHtml(company),
		escapeHtml(job.recipientEmail),
		escapeHtml(role),
		escapeHtml(expiry),
		escapeHtml(invitationUrl.href),
	);
	return { subject, text: textBody, html, invitationUrl: invitationUrl.href };
}

function deliveryError(error: unknown): { message: string; retryable: boolean } {
	if (error instanceof InvitationEmailSendError) {
		return { message: error.message.slice(0, 1000), retryable: error.retryable };
	}
	const message = error instanceof Error ? error.message : String(error);
	return { message: message.slice(0, 1000), retryable: true };
}

export interface InvitationDeliveryBatchOptions {
	paceMs?: number;
	budgetMs?: number;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

export async function deliverProfileInvitationBatch(
	{ jobs, unusable, unreadable }: ClaimedInvitationDeliveries,
	invitationUrlBase: string,
	provider: InvitationEmailProvider,
	store: InvitationDeliveryStore,
	options: InvitationDeliveryBatchOptions = {},
): Promise<InvitationDeliveryBatchResult> {
	const paceMs = options.paceMs ?? 0;
	const budgetMs = options.budgetMs;
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const deadline = budgetMs !== undefined ? now() + budgetMs : undefined;
	const result: InvitationDeliveryBatchResult = {
		claimed: jobs.length + unusable.length + unreadable,
		delivered: 0,
		retrying: 0,
		failed: 0,
		completionPending: 0,
		unreadable,
		deferred: 0,
	};
	for (const lease of unusable) {
		try {
			await store.fail(lease, lease.message.slice(0, 1000), false);
			result.failed += 1;
		} catch {
			result.completionPending += 1;
		}
	}
	for (const [index, job] of jobs.entries()) {
		if (deadline !== undefined && now() >= deadline) {
			result.deferred = jobs.length - index;
			break;
		}
		if (index > 0 && paceMs > 0) await sleep(paceMs);
		if (deadline !== undefined && now() >= deadline) {
			result.deferred = jobs.length - index;
			break;
		}
		let providerMessageId: string;
		try {
			const email = buildProfileInvitationEmail(job, invitationUrlBase);
			const sent = await provider.send(job, email, invitationIdempotencyKey(job.invitationId));
			providerMessageId = text(sent.messageId, "provider message id", 256);
		} catch (error) {
			const failure = deliveryError(error);
			try {
				await store.fail(job, failure.message, failure.retryable);
			} catch {
				result.completionPending += 1;
				continue;
			}
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
