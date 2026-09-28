/* Computer hour notices (build step 5; contract section 19, 2026-09-28 amendment "computer hours",
 * item 10). The database queues them (migration 20260929160000_runtime_computer_hour_notices) and
 * the computer-hour-notices Edge Function sends each one through Resend, like invitations
 * (supabase/INVITATION-EMAIL.md). Only founders receive them. */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_SECONDS = 1_000_000_000_000;
/** A company name is at most 120 characters in the database; in UTF-16 units that can be 240. */
const COMPANY_NAME_UNITS = 240;

export type ComputerHourNoticeKind = "running_low" | "out_of_hours" | "monthly_summary";

export interface CompanyNoticeDetails {
	companyName: string;
	/** Standard seconds left; zero or less when out. */
	leftSeconds: number;
}

export interface SummaryNoticeDetails {
	periodStart: string;
	periodEnd: string;
	grantedSeconds: number;
	companies: { companyName: string; seconds: number }[];
}

interface NoticeJobBase {
	noticeId: string;
	recipientEmail: string;
	attemptCount: number;
	leaseId: string;
}

export interface CompanyNoticeJob extends NoticeJobBase {
	kind: "running_low" | "out_of_hours";
	details: CompanyNoticeDetails;
}

export interface SummaryNoticeJob extends NoticeJobBase {
	kind: "monthly_summary";
	details: SummaryNoticeDetails;
}

export type ComputerHourNoticeJob = CompanyNoticeJob | SummaryNoticeJob;

export interface ComputerHourEmail {
	subject: string;
	text: string;
	html: string;
}

export interface ComputerHourEmailProvider {
	send(job: ComputerHourNoticeJob, email: ComputerHourEmail, idempotencyKey: string): Promise<{ messageId: string }>;
}

export interface ComputerHourNoticeStore {
	complete(job: ComputerHourNoticeJob, providerMessageId: string): Promise<void>;
	fail(job: ComputerHourNoticeJob, message: string, retryable: boolean): Promise<void>;
}

export interface ComputerHourNoticeBatchResult {
	claimed: number;
	delivered: number;
	retrying: number;
	failed: number;
	completionPending: number;
}

export class ComputerHourEmailSendError extends Error {
	readonly retryable: boolean;

	constructor(message: string, retryable: boolean) {
		super(message);
		this.name = "ComputerHourEmailSendError";
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

function seconds(value: unknown, label: string, minimum = 0): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > MAX_SECONDS) {
		throw new Error(`Invalid ${label}`);
	}
	return value as number;
}

function companyDetails(value: unknown): CompanyNoticeDetails {
	const input = record(value, "notice details");
	return {
		companyName: text(input.companyName, "company name", COMPANY_NAME_UNITS),
		leftSeconds: seconds(input.leftSeconds, "hours left", -MAX_SECONDS),
	};
}

function summaryDetails(value: unknown): SummaryNoticeDetails {
	const input = record(value, "summary details");
	if (!Array.isArray(input.companies) || input.companies.length === 0 || input.companies.length > 200) {
		throw new Error("Invalid summary companies");
	}
	return {
		periodStart: timestamp(input.periodStart, "period start"),
		periodEnd: timestamp(input.periodEnd, "period end"),
		grantedSeconds: seconds(input.grantedSeconds, "plan hours"),
		companies: input.companies.map((entry) => {
			const company = record(entry, "summary company");
			return {
				companyName: text(company.companyName, "company name", COMPANY_NAME_UNITS),
				seconds: seconds(company.seconds, "company hours"),
			};
		}),
	};
}

function parseJob(entry: unknown): ComputerHourNoticeJob {
	const input = record(entry, "notice job");
	const recipientEmail = text(input.recipientEmail, "recipient email", 320).toLowerCase();
	if (!EMAIL_PATTERN.test(recipientEmail)) throw new Error("Invalid recipient email");
	const base = {
		noticeId: uuid(input.noticeId, "notice id"),
		recipientEmail,
		attemptCount: seconds(input.attemptCount, "attempt count", 1),
		leaseId: uuid(input.leaseId, "lease id"),
	};
	if (input.kind === "running_low" || input.kind === "out_of_hours")
		return { ...base, kind: input.kind, details: companyDetails(input.details) };
	if (input.kind === "monthly_summary") return { ...base, kind: input.kind, details: summaryDetails(input.details) };
	throw new Error("Invalid notice kind");
}

/** A claimed notice that cannot be sent as it is: failed for good, so it holds up nothing. */
export interface RejectedNotice {
	noticeId: string;
	leaseId: string;
	message: string;
}

/** The claim, one notice at a time: a notice that cannot be read is set aside (to be failed), and one
 * without a readable id or lease is left to its lease running out and the eight-attempt limit. */
export function parseComputerHourNoticeClaim(value: unknown): { jobs: ComputerHourNoticeJob[]; rejected: RejectedNotice[] } {
	if (!Array.isArray(value) || value.length > 50) throw new Error("Invalid notice job list");
	const jobs: ComputerHourNoticeJob[] = [];
	const rejected: RejectedNotice[] = [];
	for (const entry of value) {
		try {
			jobs.push(parseJob(entry));
		} catch (error) {
			const input = entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>) : {};
			const noticeId = typeof input.noticeId === "string" && UUID_PATTERN.test(input.noticeId) ? input.noticeId : undefined;
			const leaseId = typeof input.leaseId === "string" && UUID_PATTERN.test(input.leaseId) ? input.leaseId : undefined;
			if (noticeId && leaseId)
				rejected.push({ noticeId, leaseId, message: error instanceof Error ? error.message : "Invalid notice" });
		}
	}
	return { jobs, rejected };
}

export function computerHourNoticeIdempotencyKey(noticeId: string): string {
	if (!UUID_PATTERN.test(noticeId)) throw new Error("Invalid notice id");
	return `qorpera-computer-hour-notice/${noticeId}`;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

/** "12.5 hours", "1 hour", "0 hours": one decimal at most. */
export function hoursText(standardSeconds: number): string {
	const hours = Math.max(0, Math.round((standardSeconds / 3600) * 10) / 10);
	if (hours === 0 && standardSeconds > 0) return "less than 0.1 hours";
	return `${hours.toLocaleString("en-GB", { maximumFractionDigits: 1 })} ${hours === 1 ? "hour" : "hours"}`;
}

/** A day in Danish time, as the meter and the months are counted. */
function dayText(iso: string): string {
	return new Date(iso).toLocaleDateString("en-GB", {
		day: "numeric",
		month: "long",
		year: "numeric",
		timeZone: "Europe/Copenhagen",
	});
}

function page(title: string, paragraphs: string[], appUrl: string, footer: string, extraHtml = ""): string {
	const body = paragraphs
		.map((paragraph) => `<p style="font-size:16px;line-height:1.6;margin:0 0 14px">${escapeHtml(paragraph)}</p>`)
		.join("");
	return `<!doctype html><html><body style="margin:0;background:#f4f4f2;color:#171716;font-family:Inter,Arial,sans-serif"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:40px 16px"><table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;background:#fff;border-radius:18px"><tr><td style="padding:36px"><p style="margin:0 0 28px;font-weight:700">Qorpera</p><h1 style="font-size:25px;line-height:1.25;margin:0 0 18px">${escapeHtml(title)}</h1>${body}${extraHtml}<p style="margin:12px 0 26px"><a href="${escapeHtml(appUrl)}" style="display:inline-block;background:#171716;color:#fff;text-decoration:none;border-radius:10px;padding:13px 18px;font-weight:600">Open Plan &amp; usage</a></p><p style="font-size:13px;line-height:1.5;color:#686864;margin:0">${escapeHtml(footer)}</p></td></tr></table></td></tr></table></body></html>`;
}

/** The email for one notice. The link opens the web app's account page, where Plan & usage is. */
export function buildComputerHourEmail(job: ComputerHourNoticeJob, appUrlBase: string): ComputerHourEmail {
	const appUrl = new URL("#/account", appUrlBase);
	if (appUrl.protocol !== "https:") throw new Error("The app URL must use HTTPS");
	const link = appUrl.href;
	let title: string;
	let paragraphs: string[];
	let listText = "";
	let listHtml = "";
	let footer: string;
	if (job.kind === "monthly_summary") {
		footer = "You get this email because your plan paid for these companies' computer hours.";
		const { periodStart, periodEnd, grantedSeconds, companies } = job.details;
		const used = companies.reduce((sum, company) => sum + company.seconds, 0);
		title = `Your plan used ${hoursText(used)} of ${hoursText(grantedSeconds)}`;
		paragraphs = [`Your plan's computer hours from ${dayText(periodStart)} to ${dayText(periodEnd)}, by company:`];
		listText = companies.map((company) => `- ${company.companyName}: ${hoursText(company.seconds)}`).join("\n");
		listHtml = `<ul style="font-size:16px;line-height:1.6;margin:0 0 14px;padding-left:20px">${companies
			.map((company) => `<li>${escapeHtml(company.companyName)}: ${escapeHtml(hoursText(company.seconds))}</li>`)
			.join("")}</ul>`;
	} else if (job.kind === "running_low") {
		const { companyName, leftSeconds } = job.details;
		footer = `You get this email as a founder of ${companyName}. Admins, contributors and viewers are never charged.`;
		title = `${companyName} is running low on computer hours`;
		paragraphs = [
			`${companyName} has ${hoursText(leftSeconds)} of computer time left.`,
			"When it runs out, machines stop starting and new work waits until more hours arrive. A plan or a pack of hours adds them.",
		];
	} else {
		const { companyName } = job.details;
		footer = `You get this email as a founder of ${companyName}. Admins, contributors and viewers are never charged.`;
		title = `${companyName} is out of computer hours`;
		paragraphs = [
			`${companyName} has used all its computer hours.`,
			"Machines do not start and new work waits until hours arrive. Work already running may finish within the hour. A plan or a pack of hours adds hours, and what was used past zero is paid from them first.",
		];
	}
	const subject = title.replace(/[\r\n]/g, " ").slice(0, 240);
	const textBody = [title, "", ...paragraphs, ...(listText ? [listText] : []), "", `Plan & usage: ${link}`, "", footer].join(
		"\n",
	);
	return { subject, text: textBody, html: page(title, paragraphs, link, footer, listHtml) };
}

function deliveryError(error: unknown): { message: string; retryable: boolean } {
	if (error instanceof ComputerHourEmailSendError) {
		return { message: error.message.slice(0, 1000), retryable: error.retryable };
	}
	const message = error instanceof Error ? error.message : String(error);
	return { message: message.slice(0, 1000), retryable: true };
}

export async function deliverComputerHourNoticeBatch(
	jobs: readonly ComputerHourNoticeJob[],
	appUrlBase: string,
	provider: ComputerHourEmailProvider,
	store: ComputerHourNoticeStore,
): Promise<ComputerHourNoticeBatchResult> {
	const result: ComputerHourNoticeBatchResult = {
		claimed: jobs.length,
		delivered: 0,
		retrying: 0,
		failed: 0,
		completionPending: 0,
	};
	for (const job of jobs) {
		let providerMessageId: string;
		try {
			const email = buildComputerHourEmail(job, appUrlBase);
			const sent = await provider.send(job, email, computerHourNoticeIdempotencyKey(job.noticeId));
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
			// Keep the lease unresolved: after it expires the same idempotency key reconciles a send
			// whose completion was lost.
			result.completionPending += 1;
		}
	}
	return result;
}
