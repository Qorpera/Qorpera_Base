import type { Cloud } from "./client.ts";
import { array, boundedInteger, CloudShapeError, nonEmptyString, oneOf, record, timestamp, uuid } from "./parse.ts";

/* Members read the company's mail (step I5a: migrations 20260928439980_runtime_company_mail_member_read and
 * 20260930002660, the `sessionId` of a waiting send; supabase/CLIENT-CONTRACT.md "Members read mail"). Five calls, each
 * with the member's own authority: the addresses, a page of threads, one thread, the sends that wait for a person, and
 * "I have read this thread". The answers are empty while the company's mail is off; a non-member gets 42501 and a
 * thread that is not the company's 22023.
 *
 * Identities are checked; what is only shown is read leniently. A waiting send's recipients, subject and text are the
 * agent's own send arguments as it gave them, so they are read for what they hold and nothing else. */

/** A thread id: 43 base64url characters. */
export const MAIL_THREAD_ID = /^[A-Za-z0-9_-]{43}$/;
export const MAIL_PAGE_SIZE = 50;
export const MAIL_DIRECTIONS = ["received", "sent"] as const;
export type MailThreadState = "new" | "handled" | "waiting";
const MAIL_THREAD_STATES = ["new", "handled", "waiting"] as const;

export interface MailAgent {
	readonly staffAgentId: string;
	readonly name?: string;
}

/** Mail that arrived for one of the company's accounts on a site (A1): who last used the account and when, never its
 * text. `unknown` while the account lookup fails. */
export type MailAccount =
	| { readonly unknown: true }
	| {
			readonly unknown: false;
			readonly site?: string;
			readonly lastUsedBy?: string;
			readonly lastUsedAt?: string;
	  };

export interface MailAddress {
	readonly address: string;
	readonly status?: string;
	readonly handledBy: readonly MailAgent[];
	readonly routines: readonly { readonly routineId: string; readonly title: string; readonly staffAgentId?: string }[];
	readonly last7Days: number;
}

export interface MailCursor {
	readonly lastAt: string;
	readonly thread: string;
}

export type MailDirection = "received" | "sent";

/** Where a thread's older messages start: the oldest message of the page that named it. */
export interface MailMessageCursor {
	readonly at: string;
	readonly kind: MailDirection;
	readonly id: string;
}

export interface MailThreadRequest {
	readonly address?: string;
	readonly state?: MailThreadState;
	/** Only the threads whose newest message went this way: the `direction` each one shows. */
	readonly direction?: MailDirection;
	readonly before?: MailCursor;
	readonly limit?: number;
}

export interface MailThreadSummary {
	readonly thread: string;
	readonly address: string;
	readonly fromName?: string;
	readonly fromAddress?: string;
	/** Absent for account mail. */
	readonly subject?: string;
	readonly lastAt: string;
	readonly state: MailThreadState;
	readonly handledBy?: MailAgent;
	readonly direction: MailDirection;
	readonly unread: boolean;
	readonly messages: number;
	readonly account?: MailAccount;
	/** The start of the newest message's text on one line (at most 200 characters), while its text is kept; never for
	 * account mail. Absent before migration 20260930522000. */
	readonly snippet?: string;
}

export interface MailThreadPage {
	readonly threads: readonly MailThreadSummary[];
	readonly nextBefore?: MailCursor;
}

export interface MailAttachment {
	readonly filename: string;
	readonly size?: number;
}

interface MailMessageBase {
	readonly id: string;
	readonly fromName?: string;
	readonly fromAddress?: string;
	readonly to: readonly string[];
	readonly cc: readonly string[];
	readonly subject?: string;
	/** Plain text, at most 16,000 characters. */
	readonly text?: string;
	/** Its text was cleared (the body is no longer kept). */
	readonly textCleared: boolean;
	readonly at: string;
	readonly attachments: readonly MailAttachment[];
}

export type MailMessage =
	| (MailMessageBase & {
			readonly kind: "received";
			readonly textTruncated: boolean;
			readonly automated: boolean;
			readonly handledBy?: MailAgent;
			readonly account?: MailAccount;
	  })
	| (MailMessageBase & {
			readonly kind: "sent";
			/** `queued`, or the outbox's status (`sent`, `failed`, ...). */
			readonly status: string;
			readonly staffAgent?: MailAgent;
	  });

/** A send an agent wants to make that waits for a person's answer. */
export interface MailWaitingSend {
	readonly reviewId: string;
	/** The conversation its card is answered in, when this member may answer it. */
	readonly sessionId?: string;
	readonly staffAgent?: MailAgent;
	readonly to: readonly string[];
	readonly cc: readonly string[];
	readonly subject?: string;
	readonly text?: string;
	readonly attachments: readonly MailAttachment[];
	readonly createdAt: string;
}

export interface MailThread {
	/** Absent while the company's mail is off. */
	readonly thread?: string;
	readonly address?: string;
	/** Oldest first: the newest 50, or the 50 before a cursor. */
	readonly messages: readonly MailMessage[];
	/** The thread has older messages than these. */
	readonly more: boolean;
	/** Where they start, while `more` is true. */
	readonly nextBefore?: MailMessageCursor;
	readonly waiting: readonly MailWaitingSend[];
}

/** A send that waits for a person, in the company's list of them (the `waiting` source's mail rows). */
export interface MailWaitingItem {
	readonly reviewId: string;
	readonly thread?: string;
	readonly sessionId?: string;
	readonly address?: string;
	readonly staffAgent?: MailAgent;
	readonly to: readonly string[];
	readonly subject?: string;
	/** The start of the text the agent wants to send, on one line. Absent before migration 20260930522000. */
	readonly snippet?: string;
	readonly createdAt: string;
}

const absent = (value: unknown) => value === null || value === undefined;

/** At most `maximum` characters as the cloud counts them: code points, so an emoji is one. */
function clip(value: string, maximum: number): string {
	return value.length <= maximum ? value : [...value].slice(0, maximum).join("");
}

/** Text that is only shown: any string, clipped, or nothing. It never fails a read. */
function shownText(value: unknown, maximum: number): string | undefined {
	return typeof value === "string" ? clip(value, maximum) : undefined;
}

function threadId(value: unknown, label: string): string {
	if (typeof value !== "string" || !MAIL_THREAD_ID.test(value)) throw new CloudShapeError(label);
	return value;
}

function flag(value: unknown, label: string): boolean {
	if (absent(value)) return false;
	if (typeof value !== "boolean") throw new CloudShapeError(label);
	return value;
}

function agent(value: unknown, label: string): MailAgent | undefined {
	if (absent(value)) return undefined;
	const item = record(value, label);
	const name = shownText(item.name, 512);
	return { staffAgentId: uuid(item.staffAgentId, label), ...(name ? { name } : {}) };
}

function account(value: unknown): MailAccount | undefined {
	if (absent(value)) return undefined;
	const item = record(value, "mail account");
	if (item.unknown === true) return { unknown: true };
	const site = shownText(item.site, 2048);
	return {
		unknown: false,
		...(site ? { site } : {}),
		...(absent(item.lastUsedBy) ? {} : { lastUsedBy: uuid(item.lastUsedBy, "mail account user") }),
		...(absent(item.lastUsedAt) ? {} : { lastUsedAt: timestamp(item.lastUsedAt, "mail account time") }),
	};
}

/** Recipients as given: a list of addresses, or one address. */
function recipients(value: unknown): string[] {
	const listed = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
	return listed.flatMap((item) => (typeof item === "string" && item.trim() ? [clip(item.trim(), 320)] : []));
}

/** Attachments by name: the cloud's own `{filename, size}`, or a send's argument as the agent gave it. */
function attachments(value: unknown): MailAttachment[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item): MailAttachment[] => {
		if (typeof item === "string" && item.trim()) return [{ filename: clip(item.split("/").pop() || item, 256) }];
		if (!item || typeof item !== "object") return [];
		const fields = item as Record<string, unknown>;
		const named = typeof fields.filename === "string" && fields.filename.trim() ? fields.filename : undefined;
		const path = typeof fields.path === "string" && fields.path.trim() ? fields.path : undefined;
		const filename = shownText(named ?? path?.split("/").pop(), 256) ?? "";
		if (!filename) return [];
		const size =
			Number.isSafeInteger(fields.size) && (fields.size as number) >= 0 ? (fields.size as number) : undefined;
		return [{ filename, ...(size === undefined ? {} : { size }) }];
	});
}

/** `{ key: value }`, or nothing for no value. */
function optional<K extends string, T>(key: K, value: T | undefined): { [P in K]?: T } {
	return value === undefined ? {} : ({ [key]: value } as { [P in K]?: T });
}

function parseAddress(value: unknown): MailAddress {
	const item = record(value, "mail address");
	return {
		address: nonEmptyString(item.address, "mail address", 320),
		...optional("status", shownText(item.status, 64)),
		handledBy: array(item.handledBy ?? [], "mail address agents").flatMap((entry) => {
			const found = agent(entry, "mail address agent");
			return found ? [found] : [];
		}),
		routines: array(item.routines ?? [], "mail address routines").map((entry) => {
			const routine = record(entry, "mail address routine");
			return {
				routineId: uuid(routine.routineId, "mail routine"),
				title: shownText(routine.title, 512) ?? "",
				...(absent(routine.staffAgentId) ? {} : { staffAgentId: uuid(routine.staffAgentId, "mail routine agent") }),
			};
		}),
		last7Days: absent(item.last7Days) ? 0 : boundedInteger(item.last7Days, "mail count", 0, Number.MAX_SAFE_INTEGER),
	};
}

function parseCursor(value: unknown): MailCursor {
	const item = record(value, "mail page");
	return { lastAt: timestamp(item.lastAt, "mail page time"), thread: threadId(item.thread, "mail page thread") };
}

function parseMessageCursor(value: unknown): MailMessageCursor {
	const item = record(value, "mail thread page");
	return {
		at: timestamp(item.at, "mail thread page time"),
		kind: oneOf(item.kind, MAIL_DIRECTIONS, "mail thread page kind"),
		id: uuid(item.id, "mail thread page message"),
	};
}

function parseSummary(value: unknown): MailThreadSummary {
	const item = record(value, "mail thread");
	const found = account(item.account);
	const handledBy = agent(item.handledBy, "mail thread agent");
	return {
		thread: threadId(item.thread, "mail thread"),
		address: nonEmptyString(item.address, "mail thread address", 320),
		...optional("fromName", shownText(item.fromName, 320)),
		...optional("fromAddress", shownText(item.fromAddress, 320)),
		// Account mail is drawn without its subject, whatever came.
		...(found ? {} : optional("subject", shownText(item.subject, 2048))),
		lastAt: timestamp(item.lastAt, "mail thread time"),
		state: oneOf(item.state, MAIL_THREAD_STATES, "mail thread state"),
		...(handledBy ? { handledBy } : {}),
		direction: oneOf(item.direction, MAIL_DIRECTIONS, "mail thread direction"),
		unread: flag(item.unread, "mail thread unread"),
		messages: absent(item.messages) ? 0 : boundedInteger(item.messages, "mail count", 0, Number.MAX_SAFE_INTEGER),
		...(found ? { account: found } : optional("snippet", shownText(item.snippet, 200))),
	};
}

function parseMessage(value: unknown): MailMessage {
	const item = record(value, "mail message");
	const kind = oneOf(item.kind, ["received", "sent"] as const, "mail message kind");
	const found = kind === "received" ? account(item.account) : undefined;
	const base = {
		...optional("fromName", shownText(item.fromName, 320)),
		...optional("fromAddress", shownText(item.fromAddress, 320)),
		// Account mail never shows its recipients, subject, text or attachments, whatever came.
		to: found ? [] : recipients(item.to),
		cc: found ? [] : recipients(item.cc),
		...(found ? {} : optional("subject", shownText(item.subject, 2048))),
		...(found ? {} : optional("text", shownText(item.text, 16_000))),
		textCleared: flag(item.textCleared, "mail text cleared"),
		attachments: found ? [] : attachments(item.attachments),
	};
	if (kind === "received") {
		const handledBy = agent(item.handledBy, "mail agent");
		return {
			kind,
			id: nonEmptyString(item.deliveryId, "mail message id", 128),
			...base,
			textTruncated: !found && flag(item.textTruncated, "mail text truncated"),
			automated: flag(item.automated, "mail automated"),
			at: timestamp(item.receivedAt, "mail message time"),
			...(handledBy ? { handledBy } : {}),
			...(found ? { account: found } : {}),
		};
	}
	const staffAgent = agent(item.staffAgent, "mail agent");
	return {
		kind,
		id: nonEmptyString(item.mailId, "mail message id", 128),
		...base,
		status: shownText(item.status, 64) ?? "queued",
		at: timestamp(item.at, "mail message time"),
		...(staffAgent ? { staffAgent } : {}),
	};
}

function parseWaitingSend(value: unknown): MailWaitingSend {
	const item = record(value, "mail waiting send");
	const staffAgent = agent(item.staffAgent, "mail agent");
	return {
		reviewId: uuid(item.reviewId, "mail waiting review"),
		...(absent(item.sessionId) ? {} : { sessionId: uuid(item.sessionId, "mail waiting conversation") }),
		...(staffAgent ? { staffAgent } : {}),
		to: recipients(item.to),
		cc: recipients(item.cc),
		...optional("subject", shownText(item.subject, 2048)),
		...optional("text", shownText(item.text, 64_000)),
		attachments: attachments(item.attachments),
		createdAt: timestamp(item.createdAt, "mail waiting time"),
	};
}

function parseWaitingItem(value: unknown): MailWaitingItem {
	const item = record(value, "mail waiting send");
	const staffAgent = agent(item.staffAgent, "mail agent");
	return {
		reviewId: uuid(item.reviewId, "mail waiting review"),
		...(absent(item.thread) ? {} : { thread: threadId(item.thread, "mail waiting thread") }),
		...(absent(item.sessionId) ? {} : { sessionId: uuid(item.sessionId, "mail waiting conversation") }),
		...optional("address", shownText(item.address, 320)),
		...(staffAgent ? { staffAgent } : {}),
		to: recipients(item.to),
		...optional("subject", shownText(item.subject, 2048)),
		...optional("snippet", shownText(item.snippet, 200)),
		createdAt: timestamp(item.createdAt, "mail waiting time"),
	};
}

/** The company's addresses, by local part; none while its mail is off. */
export async function readMailAddresses(cloud: Cloud, environmentId: string): Promise<MailAddress[]> {
	const answer = await cloud.rpc("qorpera_member_mail_addresses", { p_environment_id: environmentId });
	return array(answer, "mail addresses").map(parseAddress);
}

/** A page of threads, newest first. */
export async function readMailThreads(
	cloud: Cloud,
	environmentId: string,
	request: MailThreadRequest,
): Promise<MailThreadPage> {
	const answer = record(
		await cloud.rpc("qorpera_member_mail_threads", {
			p_environment_id: environmentId,
			p_request: {
				...(request.address === undefined ? {} : { address: request.address }),
				...(request.state === undefined ? {} : { state: request.state }),
				...(request.direction === undefined ? {} : { direction: request.direction }),
				...(request.before === undefined ? {} : { before: request.before }),
				limit: request.limit ?? MAIL_PAGE_SIZE,
			},
		}),
		"mail threads",
	);
	return {
		threads: array(answer.threads, "mail threads").map(parseSummary),
		...(absent(answer.nextBefore) ? {} : { nextBefore: parseCursor(answer.nextBefore) }),
	};
}

/** One thread: its newest 50 messages, or with `before` the 50 before that one, oldest first, and the sends in it that
 * wait for a person. */
export async function readMailThread(
	cloud: Cloud,
	environmentId: string,
	thread: string,
	before?: MailMessageCursor,
): Promise<MailThread> {
	const answer = record(
		await cloud.rpc("qorpera_member_mail_thread", {
			p_environment_id: environmentId,
			p_thread: thread,
			...(before === undefined ? {} : { p_before: before }),
		}),
		"mail thread",
	);
	const more = flag(answer.more, "mail thread more");
	return {
		...(absent(answer.thread) ? {} : { thread: threadId(answer.thread, "mail thread") }),
		...optional("address", shownText(answer.address, 320)),
		messages: array(answer.messages, "mail messages").map(parseMessage),
		more,
		...(more && !absent(answer.nextBefore) ? { nextBefore: parseMessageCursor(answer.nextBefore) } : {}),
		waiting: array(answer.waiting ?? [], "mail waiting sends").map(parseWaitingSend),
	};
}

/** The sends that wait for a person, newest first. */
export async function readMailWaiting(cloud: Cloud, environmentId: string): Promise<MailWaitingItem[]> {
	const answer = await cloud.rpc("qorpera_member_mail_waiting", { p_environment_id: environmentId });
	return array(answer, "mail waiting sends").map(parseWaitingItem);
}

/** This member has read the thread: its unread mark clears until a newer message arrives. */
export async function markMailThreadRead(cloud: Cloud, environmentId: string, thread: string): Promise<void> {
	const answer = await cloud.rpc("qorpera_mark_mail_thread_read", {
		p_environment_id: environmentId,
		p_thread: thread,
	});
	if (answer !== true) throw new CloudShapeError("mail read mark");
}
