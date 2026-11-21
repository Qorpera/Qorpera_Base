import type { CloudMemberDataDescription } from "@qorpera/cloud-client/cloud-member-data";
import type { NativeExecutionConnections } from "@qorpera/cloud-client/cloud-native-subscription-control";
import type { CloudApi } from "../cloud/api.ts";
import type { AppTreeNode, MemberAppLayout, MemberAppLayoutRead } from "../cloud/app-groups.ts";
import { CloudRpcError, connectionLost, describeError } from "../cloud/client.ts";
import { createWebCodingEnvironment } from "../cloud/coding-environment.ts";
import {
	type CodingSession,
	type CodingSessionLogins,
	type CodingSessionRead,
	compareCodingSessions,
} from "../cloud/coding-session.ts";
import {
	rewriteStateFile,
	WebCompanyFolderRejectedError,
	type WebMemberFolder,
} from "../cloud/company-folder-writes.ts";
import {
	type EmailDraftAction,
	EmailDraftClient,
	type EmailDraftContent,
	type EmailDraftEditor,
	type EmailDraftState,
} from "../cloud/email-drafts.ts";
import { createWebEventHooks } from "../cloud/event-hooks.ts";
import { type GroupChatDetails, listGroupChatDetails, readGroupChatDetails } from "../cloud/group-details.ts";
import type { InteractionAnswer, InteractionOutcome, InteractionRequest } from "../cloud/interactions.ts";
import { type MemberChatSummary, memberChatCalls } from "../cloud/member-chats.ts";
import type { WebNativeSubscription } from "../cloud/native-subscription.ts";
import type { OpenDecision } from "../cloud/open-decisions.ts";
import type { OpenQuestion } from "../cloud/open-questions.ts";
import { buildCompanyHierarchy, type CompanyHierarchy, type HostedCompanyOrganization } from "../cloud/organization.ts";
import type { PageCursor } from "../cloud/pagination.ts";
import { UUID_PATTERN } from "../cloud/parse.ts";
import type { CloudPresenceHandle, PresenceMember } from "../cloud/presence.ts";
import type { FolderProposalPage } from "../cloud/proposals.ts";
import { type MessageQuote, QUOTES_MAX, sameQuotes } from "../cloud/quotes.ts";
import {
	type CompanyRealtimeSubscription,
	type RealtimePhase,
	type RealtimeResource,
	type RealtimeSubscription,
	subscribeCompanyRealtime,
} from "../cloud/realtime.ts";
import type { ActionReviewAnswer } from "../cloud/review-rules.ts";
import { sessionAttachmentProblem } from "../cloud/session-attachments.ts";
import {
	type RoomMessageTarget,
	type SessionExecutionSponsor,
	type SessionInputWriter,
	selectSessionExecutionSponsor,
} from "../cloud/session-input.ts";
import { applySidebarRequest, type CompanySidebar, containerOrder, type SidebarRequest } from "../cloud/sidebar.ts";
import {
	isSectionsRequest,
	rewriteSectionsFile,
	SECTIONS_PATH,
	SectionsChangeRefusal,
	sectionsChange,
} from "../cloud/sidebar-sections-file.ts";
import type { CompanySite } from "../cloud/sites.ts";
import { isErased, projectTranscript, type TranscriptProjection } from "../cloud/transcript.ts";
import type {
	HostedProfile,
	HostedProfileTeam,
	HostedRunRecovery,
	HostedSession,
	HostedSessionEvent,
	HostedStaffAgent,
	HostedStaffExecutionActivity,
	JsonValue,
	PendingSessionInput,
} from "../cloud/types.ts";
import type { WaitingKind, WaitingWork } from "../cloud/waiting-work.ts";
import { appNoteHeader, appNoteLead, splitAppNote, withReply } from "../cloud/wall-reply.ts";
import { type WorksForCalls, worksForCalls } from "../cloud/works-for.ts";
import { attachmentProblemText } from "../ui/attachments.ts";
import type { FigureChoice } from "../ui/figure-picker.ts";
import { isGroupChat } from "../ui/group-chat.ts";
import { type MailAddressCalls, mailboxRefusal } from "../ui/mail-address.ts";
import type { MentionTarget } from "../ui/mentions.ts";
import { t } from "../ui/preferences.ts";
import type { AgentNotesState } from "./agent-notes.ts";
import { type AgentAtComputer, type AgentsAtComputers, AtComputerWatch } from "./agents-at-computers.ts";
import type { MailState } from "./company-mail.ts";
import { memberTimeZone, rememberTimeZoneRefused, timeZoneRefused } from "./company-time-zone.ts";
import type { CompanyApp, CompanyAppIcon } from "./interface-apps.ts";
import type { InterfaceFolderState } from "./interface-folder.ts";
import type { InterfacePagesState } from "./interface-pages.ts";
import { MemberChats } from "./member-chats.ts";
import { parsePresenceValue, presenceValue, sessionPlace } from "./presence-place.ts";
import {
	appendQuoted,
	brokenQuotes,
	type FieldEdit,
	keepQuotesWhole,
	placeQuotes,
	type QuotedText,
	type QuoteRecord,
	takeQuoteRecords,
} from "./quotes.ts";
import { Reconnect } from "./reconnect.ts";
import { RoomDrafts } from "./room-drafts.ts";
import { debounce, Store, throttle } from "./state.ts";

/* One controller per open company. It holds the canonical projections the
 * views render (team, staff, sessions, organization, activity) and re-reads
 * them on Realtime hints. Nothing here executes work or owns a wake. */

export type Deployment = "loading" | "ready" | "not-deployed" | "not-seeded" | "error";

/** What a member sees of an agent's execution: see CompanyController.agentState. */
/** `computer`: working, and using its desktop computer now (20260930742000). */
export type AgentState = "idle" | "working" | "writing" | "computer" | "decision" | "failed";

/** The states in which an agent's run works: working, writing, or working at its computer. */
export function agentWorks(state: AgentState): boolean {
	return state === "working" || state === "writing" || state === "computer";
}

/** A run the server holds against the agent until someone dismisses it. */
export interface FailedRun {
	activity: HostedStaffExecutionActivity;
	/** Its details, once read. */
	recovery?: HostedRunRecovery;
	/** A failure from before the agent's newer work: listed apart, the agent's state no longer reads it. */
	earlier?: true;
}

const isFailedRun = (row: HostedStaffExecutionActivity) =>
	row.activity === "needs_attention" && (row.jobStatus === "failed" || row.jobStatus === "cancelled");

/** A queued run waiting at its login's usage limit until a time still ahead (20260930703000). */
const pausedNow = (row: HostedStaffExecutionActivity) =>
	row.jobStatus === "queued" && row.paused !== undefined && Date.parse(row.paused.until) > Date.now();

/** Keeps the details of runs the activity still reports as failed. */
function stillFailed(
	recoveries: Record<string, HostedRunRecovery>,
	activity: HostedStaffExecutionActivity[],
): Record<string, HostedRunRecovery> {
	const failed = new Set(activity.filter(isFailedRun).map((row) => row.runId));
	const kept = Object.entries(recoveries).filter(([runId]) => failed.has(runId));
	return kept.length === Object.keys(recoveries).length ? recoveries : Object.fromEntries(kept);
}

/* A failed run's details change only while it holds an open proposal or work of
 * unknown outcome, which are settled elsewhere. Those are read again a little
 * more often than the 30 s poll; any other failed run is read once. */
const RECOVERY_RECHECK_MS = 25_000;
const RECOVERY_RETRY_MS = 5_000;

/** Why the cloud refused a sidebar change, in the member's words. Only the sidebar
 * RPC's own refusals are shown as they are: they are written for members ("A section
 * called … already exists"). A network or server failure never shows its text. */
function sidebarRefusal(error: unknown, request: SidebarRequest): string {
	if (error instanceof SectionsChangeRefusal) return error.message;
	if (error instanceof WebCompanyFolderRejectedError) {
		if (error.outcome === "denied")
			return t("Only owners, admins and contributors can change the company's sections.");
		if (error.problems.some((problem) => /^the Co-Founder stands above the sections/.test(problem)))
			return t("The Co-Founder stays on top, above the sections.");
	}
	if (error instanceof CloudRpcError) {
		const shared = ["create_section", "rename_section", "delete_section", "move_agent", "move_room"].includes(
			request.action,
		);
		if (error.code === "42501" && shared)
			return t("Only owners, admins and contributors can change the company's sections.");
		const own = ["23505", "P0002", "54000", "22023"].includes(error.code ?? "");
		if (own && error.message.trim() && !/request is invalid/i.test(error.message)) return error.message.trim();
	}
	return t("The sidebar could not be changed. Try again.");
}

/** Why the cloud would not try a run again, in the member's words. */
function retryRefusal(error: unknown): string {
	const message = error instanceof Error ? error.message : "";
	if (/author of the post/i.test(message)) return t("Only the person who wrote the message can try it again.");
	if (/sponsor|model account/i.test(message)) return t("Select an active model account, then try again.");
	// Only an operator pauses a company, briefly, while the runtime is updated.
	if (/paused/i.test(message)) return t("Agents are paused for a moment while Qorpera updates. Try again shortly.");
	if (/already resolved/i.test(message)) return t("This run was already handled.");
	if (/already answered|durable operation|open proposal/i.test(message))
		return t("This run already did part of its work, so it cannot be repeated. Send the message again instead.");
	return t("It could not be tried again. Send the message again instead.");
}

/** Whether a card's answer was refused for want of the member's model account: in an agent's thread an answer runs
 * the agent on it. */
export function needsModelAccount(error: unknown): boolean {
	return /sponsor|model account/i.test(error instanceof Error ? error.message : "");
}

/** Why the cloud would not take a card's answer, in the member's words. */
function answerRefusal(error: unknown): string {
	const message = error instanceof Error ? error.message : "";
	if (needsModelAccount(error)) return t("Select an active model account, then try again.");
	if (/paused/i.test(message)) return t("Agents are paused for a moment while Qorpera updates. Try again shortly.");
	if (/Only a member of this thread can wake its agent/.test(message))
		return t(
			"Your answer did not go. It would start this agent's work, and only members of the agent's thread can do that. Ask someone in that thread to answer.",
		);
	return describeError(error);
}

export interface CompanyState {
	profile: HostedProfile;
	team?: HostedProfileTeam;
	staff: HostedStaffAgent[];
	sessions: HostedSession[];
	sessionsError?: string;
	connectionLost?: boolean;
	groups?: Record<string, GroupChatDetails>;
	/** Kept for diagnostics only; the rail does not show it (see shell.ts). */
	groupsError?: string;
	organization?: HostedCompanyOrganization;
	organizationState: Deployment;
	organizationError?: string;
	hierarchy: CompanyHierarchy;
	activity: HostedStaffExecutionActivity[];
	/** Details of the failed runs in `activity`, by run id. */
	recoveries: Record<string, HostedRunRecovery>;
	/** Try again in flight or refused, by run id. */
	runRetries?: Record<string, { pending: boolean; error?: string }>;
	/** The deployed cloud cannot retry a post into a room yet (no qorpera_retry_room_delivery). */
	roomRetryUnavailable?: boolean;
	/** Failed runs a member dismissed here, by run id. They stop standing in for the
	 * agent at once; the cloud records the same acknowledgment durably. */
	acknowledgedRuns?: Record<string, true>;
	/** A figure and colour picked on an agent's card and still being saved, by agent id. The
	 * rail draws them at once instead of after the save and the roster read (agent-edits.ts). */
	looks?: Readonly<Record<string, FigureChoice>>;
	/** The rail's sections (the company's) and pins and hidden agents (this member's). */
	sidebar?: CompanySidebar;
	/** The deployed cloud has no sidebar yet: the rail shows no sections, pins or hiding. */
	sidebarUnavailable?: boolean;
	/** A rail action (a sidebar change, a rename, a delete) that did not happen, in the member's words. */
	railError?: string;
	/** The member just reset their sidebar: the rail offers Undo until they dismiss it or change the sidebar again.
	 * `appsOrder` is the apps drawer's order this device kept before, put back by Undo; `undoing` while Undo is on its
	 * way, so it is sent once. */
	sidebarReset?: { appsOrder: readonly string[]; undoing?: boolean };
	realtime: RealtimePhase;
	realtimeError?: string;
	/** Mentions of this member not seen yet, by conversation (session id → count). */
	mentions?: Readonly<Record<string, number>>;
	openDecisions?: number;
	/** The cloud does not read mentions yet: no mention picker, no badges. */
	mentionsUnavailable?: boolean;
	/** The cloud answered a mentions read: it reads mentions, so names are offered. */
	mentionsReady?: boolean;
	/** Approval cards that wait for this member's answer, by agent (staff agent id → count). */
	approvals?: Readonly<Record<string, number>>;
	/** The cloud does not list waiting approval cards yet (before 20260930568000). */
	approvalsUnavailable?: boolean;
	/** What each agent's work waits on this member for (its cards for them and the approval cards they answer), by
	 * agent (staff agent id → the newest item and the count; 20260930723000). Unset until the first read lands. */
	waitingOnMe?: Readonly<Record<string, WaitingWork>>;
	/** The cloud does not list what waits on the member yet (before 20260930723000): the approval cards alone are read,
	 * as before. */
	waitingWorkUnavailable?: boolean;
	/** The other members' open browser tabs and the conversation each shows (presence). */
	here?: readonly PresenceMember[];
	/** This member's chats with the company's other members, by the other member (app/member-chats.ts). Unset until
	 * the first read lands, and in a company with nobody else. */
	memberChats?: Readonly<Record<string, MemberChatSummary>>;
	/** The cloud has no member chats yet (before 20260930715000): the rail shows no members. */
	memberChatsUnavailable?: boolean;
	/** The cloud keeps where each member puts their contacts in the rail (20260930717000): they drag, pin and hide.
	 * Without it they stand in the Members group, as the cloud lists them. */
	memberContactPlacing?: boolean;
	/** The company is out of computer hours: new work waits until hours are added (the zero rule). */
	waitingForHours?: boolean;
	/** The deployed cloud cannot say yet whether the company waits for computer hours. */
	hoursWaitUnavailable?: boolean;
	/** Which of the two pages, Mailbox and Members, the company shows (Interfaces C6a; app/interface-pages.ts). Unset
	 * until the first read lands, and on a cloud without the calls: no page shows then. */
	interfacePages?: InterfacePagesState;
	companyData?: CloudMemberDataDescription | null;
	/** The tables and files the shown pages read, as the company's folder holds them (Interfaces step I7;
	 * app/interface-folder.ts). Unset until the first read lands. */
	interfaceFolder?: InterfaceFolderState;
	/** The agents' interface apps in the company's folder (apps/, app/interface-apps.ts), as last read. Unset until the
	 * first read lands. */
	apps?: readonly CompanyApp[];
	/** The company's groups of apps, as its apps/groups.md says (cloud/app-groups.ts); unset until read, and while the
	 * company has none. */
	appGroups?: readonly AppTreeNode[];
	/** The member's own arrangement of the drawer over them (20260930728000), as last read or written. */
	appLayout?: MemberAppLayoutRead;
	/** The cloud keeps no apps layout per member yet: the drawer draws the company's groups and changes none. */
	appLayoutUnavailable?: boolean;
	/** Each app's own icons (`apps/<name>/icons/`, app/interface-apps.ts), by the app's name, for the apps whose icons
	 * were asked for: the member opened its Icon and colour panel, or picked one of them. Newest first. */
	appIcons?: Readonly<Record<string, readonly CompanyAppIcon[]>>;
	/** The apps whose agent was asked to draw new icons, by name: since when, and the icons it had then. The drawer shows
	 * the app drawing until a new one is read, or for ten minutes. */
	appIconsDrawing?: Readonly<Record<string, { readonly since: number; readonly known: readonly string[] }>>;
	/** How many websites the company's agents published, as last read: the apps drawer shows Sites while there are any.
	 * Unset until read, and on a cloud that can't say. */
	siteCount?: number;
	/** The company's sites as last read, with `siteCount`: each live website is an owed view, first in the apps drawer,
	 * opening the site with its numbers (company views step 4; views/shell.ts owedViews). */
	siteList?: readonly CompanySite[];
	/** The company's sites Qorpera's operators took down, by id, as the access read last said
	 * (`qorpera_company_site_access`): the owed row leaves them out. Unset until read, and on a cloud without it. */
	sitesTakenDown?: ReadonlySet<string>;
	/** What's new (app/views/whats-new.ts): set while one of the company's projects makes a website, with how many of its
	 * changes are ready to go live that this member did not answer Not yet to. The apps drawer shows What's new while it
	 * is set. Unset until read, and on a cloud without it. */
	whatsNew?: { readonly ready: number };
	/** The version What's new has live of each site made from a project's code, by the site's name in its link: the
	 * Sites page names it on the site's row. Read with What's new. */
	siteVersions?: Readonly<Record<string, number>>;
	/** What the rail says of each agent between runs: its next planned run (app/agent-notes.ts). Unset until the first
	 * read lands; an agent with nothing has no entry. */
	agentNotes?: AgentNotesState;
	/** The agents using their desktop computers now, by agent (20260930742000; app/agents-at-computers.ts). Unset until
	 * the first read lands. */
	atComputers?: AgentsAtComputers;
	/** The cloud does not say which agents use their computers (before 20260930742000): no agent shows at one. */
	atComputersUnavailable?: boolean;
	/** The company's mail as the member reads it (Interfaces step I5c; app/company-mail.ts). Unset until it is read. */
	mail?: MailState;
	loading: boolean;
	error?: string;
	accessLost?: boolean;
}

export interface ConversationState {
	sessionId: string;
	/** The line the draft answers, an app's note's (app/tell-agent.ts): the next message opens with it
	 * (cloud/wall-reply.ts). */
	answering?: string;
	events: HostedSessionEvent[];
	pending: PendingSessionInput[];
	projection: TranscriptProjection;
	/** The erasure generation (`memory_generation`) that `events` reflect. An erase rewrites an event's body in place,
	 * so a full read that finds another generation reads the loaded events again. Undefined until a full read found
	 * it, and again when a read that may predate an erase landed after the events were read again: a full read then
	 * reads them again once the generation is above 0. */
	memoryGeneration?: number;
	loading: boolean;
	complete: boolean;
	error?: string;
	sending: boolean;
	sendError?: string;
	draft?: string;
	/** The records of the quotes the draft holds, and of those it held since it was last sent: wherever their words
	 * stand in «» marks in the draft, that is the quote (app/quotes.ts; `draftQuotes`). */
	quoteRecords?: readonly QuoteRecord[];
	/** Counts each change to the draft or its records from outside the member's own edits in a composer: a teammate's
	 * words merged in, the cloud's draft, a send, a message button. A composer's undo history starts again at each
	 * (`draftReplaced`; app/views/composer-quotes.ts). */
	draftEpoch?: number;
	/** Local selected bytes, staged only after an explicit send. */
	attachments?: File[];
	executionSponsor?: SessionExecutionSponsor;
	retrySend?: {
		clientInputId: string;
		clientRequestId: string;
		text: string;
		/** The text's quotes: a retry sends exactly these. */
		quotes?: readonly MessageQuote[];
		files: File[];
		executionSponsor: SessionExecutionSponsor;
		roomTarget?: RoomMessageTarget;
	};
	/** The coding sessions the agent dispatched from this conversation (Order 9),
	 * oldest first; absent until the first listing, empty when the cloud has none
	 * or does not carry coding sessions yet. */
	codingSessions?: CodingSession[];
	/** The member's open proposals of the thread's agent (P40c): changes its runs saved that wait for review. Its first
	 * page, without those this browser discarded; absent until the first listing, and outside the agent's thread. */
	proposals?: FolderProposalPage;
	/** Proposals whose discard this browser is sending. */
	discardingProposals?: readonly string[];
	/** Inputs this browser appended that the cloud has not listed back yet. */
	optimistic: {
		clientInputId: string;
		inputId?: string;
		text: string;
		quotes?: readonly MessageQuote[];
		attachmentCount?: number;
		createdAt: string;
		authorUserId: string;
	}[];
	/** Card answers this browser sent that the cloud has not listed back yet, by interaction id. */
	interactionAnswers?: Record<string, InteractionAnswer>;
	/** What went wrong with the last card answer, in the member's words. */
	interactionError?: string;
	/** Older transcript events exist that this browser has not read: a thread opens at its newest
	 * events (migration 20260928279410) and "Show earlier" reads further back (loadEarlier). */
	hasEarlier?: boolean;
	/** "Show earlier" is reading, or why it could not. */
	earlierLoading?: boolean;
	earlierError?: string;
}

/** A change to a conversation's draft, or its records, from outside the member's own edits: it says so, and the
 * composer's undo history starts again there. */
export function draftReplaced(state: Pick<ConversationState, "draftEpoch">): Pick<ConversationState, "draftEpoch"> {
	return { draftEpoch: (state.draftEpoch ?? 0) + 1 };
}

/** Drop optimistic card answers once the projection carries them, or once their
 * input failed: that answer never reached the agent, so the card is open again. */
function reconcileInteractionAnswers(
	answers: Record<string, InteractionAnswer> | undefined,
	projection: TranscriptProjection,
	pending: readonly PendingSessionInput[],
): Record<string, InteractionAnswer> | undefined {
	if (!answers) return undefined;
	const settled = new Set(
		projection.items.flatMap((item) => (item.kind === "interaction" && item.answer ? [item.id.toLowerCase()] : [])),
	);
	const failed = new Set(pending.flatMap((input) => (input.status === "failed" ? [input.inputId] : [])));
	const kept = Object.fromEntries(
		Object.entries(answers).filter(
			([id, answer]) => !settled.has(id) && !(answer.inputId && failed.has(answer.inputId)),
		),
	);
	return Object.keys(kept).length ? kept : undefined;
}

function reconcileOptimistic(state: Pick<ConversationState, "optimistic" | "pending" | "events">) {
	return state.optimistic.filter((item) => {
		const id = item.inputId ?? item.clientInputId;
		return (
			!state.pending.some((input) => input.inputId === id) &&
			!state.events.some((event) => event.sessionInputId === id)
		);
	});
}

/** A fresh listing of a thread's coding sessions, keeping any session the thread
 * already knows in a newer state (an answer merged while an older read was on its way). */
function newerCodingSessions(
	listed: readonly CodingSession[],
	known: readonly CodingSession[] | undefined,
): CodingSession[] {
	const byWorker = new Map((known ?? []).map((session) => [session.workerId, session]));
	return listed.map((session) => {
		const current = byWorker.get(session.workerId);
		return current && compareCodingSessions(current, session) > 0
			? { ...current, isOwner: session.isOwner ?? current.isOwner }
			: session;
	});
}

const EVENT_PAGE = 500;
/** A sessions hint reads only the conversations changed since the newest one read, reaching this
 * far back for a change that committed after a later one; the whole list is read again at this
 * age (a heartbeat, or the next hint), which is also the recovery for anything a delta missed. */
const SESSIONS_OVERLAP_MS = 60_000;
const SESSIONS_FULL_MS = 5 * 60_000;
const NO_ID = "00000000-0000-0000-0000-000000000000";
/** A hint on the open conversation reads its new events at once, and its waiting inputs and coding
 * sessions again at most this often (a send, and the clock, read them anyway). */
const OPEN_FULL_MS = 10_000;
/** The work watch skips a read of the open conversation a hint made this recently. */
const WATCH_SKIP_MS = 1_500;
/** The company's clock: its heartbeat with live hints, its recovery path without them. */
const HEARTBEAT_MS = 30_000;

/** What a live hint reads: at once and then at most once an interval for someone looking, so a message shows as soon as
 * it is saved. A hidden tab keeps the wait, which also merges a burst of hints: nobody pays for reads nobody sees. */
function readOnHint(read: () => void, intervalMs: number): () => void {
	const atOnce = throttle(read, intervalMs);
	const afterTheWait = debounce(read, intervalMs);
	return () => (typeof document !== "undefined" && document.visibilityState === "hidden" ? afterTheWait() : atOnce());
}

/** The page cursor after the newest of these conversations (as the listing orders them). */
function newestSession(sessions: readonly HostedSession[], after?: PageCursor): PageCursor | undefined {
	let newest = after;
	for (const session of sessions)
		if (
			!newest ||
			session.updatedAt > newest.time ||
			(session.updatedAt === newest.time && session.sessionId > newest.id)
		)
			newest = { time: session.updatedAt, id: session.sessionId };
	return newest;
}

/** Conversations read again replace their older copies; the list keeps the listing's order. */
function mergeSessions(current: readonly HostedSession[], changed: readonly HostedSession[]): HostedSession[] {
	const byId = new Map(current.map((session) => [session.sessionId, session]));
	for (const session of changed) byId.set(session.sessionId, session);
	return [...byId.values()].sort((a, b) =>
		a.updatedAt === b.updatedAt ? a.sessionId.localeCompare(b.sessionId) : a.updatedAt < b.updatedAt ? -1 : 1,
	);
}

/** A thread opens with its newest events, read back a page at a time until it shows this many
 * items (receipts and other hidden events take no place) or reaches its start, at most
 * TAIL_PAGES pages; "Show earlier" reads the same way. */
const TAIL_PAGE = 200;
const TAIL_ITEMS = 150;
const TAIL_PAGES = 5;

/** A cloud without the newest-first read (before 20260928279410): the thread reads forward. */
function missingTailRead(error: unknown): boolean {
	return error instanceof CloudRpcError && (error.missing || error.code === "42883");
}

/** Whether `event` should replace `known`, a copy of the same event read before: only an erased copy of a copy that
 * is not. An event never changes but by an erase, and an erase is final, so a read from before it never puts the
 * erased words back. */
function erasedCopy(known: HostedSessionEvent | undefined, event: HostedSessionEvent): boolean {
	return known !== undefined && isErased(event.body) && !isErased(known.body);
}

/** Reads of one transcript as one list: each event once (its erased copy where a read has one), oldest first. */
function mergeEvents(...reads: readonly (readonly HostedSessionEvent[])[]): HostedSessionEvent[] {
	const bySequence = new Map<number, HostedSessionEvent>();
	for (const read of reads)
		for (const event of read) {
			const known = bySequence.get(event.sequence);
			if (!known || erasedCopy(known, event)) bySequence.set(event.sequence, event);
		}
	return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
}

/** Whether older events exist before two reads of one transcript taken together. Each read's
 * `hasEarlier` speaks for its own oldest event, so the read that reached further back decides (a
 * Show-earlier page and a read-back can land in either order); at the same start, one that saw
 * the start decides. */
function earlierOf(
	a: { events: readonly HostedSessionEvent[]; hasEarlier?: boolean },
	b: { events: readonly HostedSessionEvent[]; hasEarlier?: boolean },
): boolean {
	const start = (read: typeof a) => read.events[0]?.sequence ?? Number.POSITIVE_INFINITY;
	if (start(a) !== start(b)) return (start(a) < start(b) ? a.hasEarlier : b.hasEarlier) ?? false;
	return (a.hasEarlier ?? false) && (b.hasEarlier ?? false);
}

/** An input a run has taken already stands in the transcript (the run's start writes it) and is
 * listed until the run ends: one sent before the oldest event read may stand in the part not read
 * yet. (A queued input has no event yet; it shows as waiting wherever the history begins.) */
function waitingBefore(pending: readonly PendingSessionInput[], events: readonly HostedSessionEvent[]): boolean {
	return takenBefore(pending, events).length > 0;
}

/** The taken inputs whose event is not read and that were sent before the oldest event read. (A
 * taken input's event carries its send time and the sequence of when the run took it: it is often
 * already in the newest page.) */
function takenBefore(
	pending: readonly PendingSessionInput[],
	events: readonly HostedSessionEvent[],
): PendingSessionInput[] {
	const start = events[0] ? Date.parse(events[0].createdAt) : Number.NaN;
	const read = new Set(events.flatMap((event) => (event.sessionInputId ? [event.sessionInputId] : [])));
	return pending.filter(
		(input) => input.status === "processing" && !read.has(input.inputId) && Date.parse(input.createdAt) < start,
	);
}

/** Company-audience staff conversations, as the desktop arbiter selects them. */
/** The agent's one shared thread: the company-audience session the kernel
 * binds to the agent's room (execution scope `agentThread`). */
export function isAgentThreadSession(session: HostedSession): boolean {
	const scope = session.executionScope ?? {};
	return (
		!!session.staffAgentId &&
		session.status === "open" &&
		session.audience.kind === "company" &&
		"roomId" in scope &&
		scope.agentThread === true
	);
}
/** Who answers a card, as the kernel's qorpera_answer_interaction checks it: the
 * member a private conversation belongs to, the creator of a company one, and in
 * an agent's shared thread the member the card was raised for, whom the card's
 * event names as its actor. Nobody in a group chat: an answer there reaches no
 * single agent (bundle v105). */
export function answersInteraction(session: HostedSession, actorUserId: string, userId: string): boolean {
	if (session.status !== "open") return false;
	if (isAgentThreadSession(session)) return actorUserId === userId;
	if (session.executionScope && "roomId" in session.executionScope) return false;
	return session.audience.kind === "member_private"
		? session.audience.userId === userId
		: session.createdByUserId === userId;
}
/** The transcript of two agents' messages to each other (contract 14.6): a
 * company-audience session bound to the pair, view-only, opened from a chip. */
export function isAgentPairSession(session: HostedSession | undefined): boolean {
	const pair = session?.executionScope?.agentPair;
	return !session?.staffAgentId && Array.isArray(pair) && pair.length === 2;
}
export function isPrimaryStaffSession(session: HostedSession): boolean {
	if (!session.staffAgentId || session.status !== "open" || session.audience.kind !== "company") return false;
	if (isAgentThreadSession(session)) return true;
	const scope = session.executionScope ?? {};
	return !("autonomousLabel" in scope || "roomId" in scope || "group" in scope || "parentSession" in scope);
}

export class CompanyController {
	readonly store: Store<CompanyState>;
	readonly conversations = new Map<string, Store<ConversationState>>();
	readonly #api: CloudApi;
	#emailDraftClient: EmailDraftClient | undefined;
	#worksFor: WorksForCalls | undefined;
	readonly #emailDraftEditors = new Map<string, EmailDraftEditor>();
	readonly #userId: string;
	readonly #writeInput: SessionInputWriter;
	#realtime: CompanyRealtimeSubscription | undefined;
	#sidebarRealtime: RealtimeSubscription | undefined;
	/** Sidebar changes sent and not yet answered; each answer carries the whole sidebar. */
	#sidebarPending = 0;
	/** What a send's own read found about group chat images, before the sidebar had said. */
	#groupChatImagesRead: boolean | undefined;
	/** The group chats of the last sessions list, kept until the list is replaced. */
	#groupRooms: { sessions: HostedSession[]; rooms: Map<string, HostedSession> } | undefined;
	#sidebarWrites: Promise<unknown> = Promise.resolve();
	/** The member's client for the company's folder, where the sections are QorperaOS/agents/sections.md. */
	#sectionsFolder: ((signal: AbortSignal) => WebMemberFolder) | undefined;
	/** The member's apps layout: reads (a newer one wins), writes on their way, one after the other, and the time the
	 * last one answered, which the next one names. */
	#appLayoutReads = 0;
	#appLayoutPending = 0;
	/** Resets (or Undos) on their way: the drawer makes no move meanwhile, nor after one until the layout it left
	 * is read (`#appLayoutStale`). */
	#resetting = 0;
	#appLayoutStale = false;
	#appLayoutWrites: Promise<string | null | undefined> = Promise.resolve(undefined);
	#poll: ReturnType<typeof setInterval> | undefined;
	/** The clock came due while the tab was hidden: its first moment back reads (#restsWhileHidden). */
	#skippedWhileHidden = false;
	/** When the tab was hidden (Date.now()), while it is. */
	#hiddenAt: number | undefined;
	#openSessionId: string | undefined;
	#stopped = false;
	#connectionFailures = 0;
	readonly #abort = new AbortController();
	readonly #reconnect = new Reconnect(() => this.#tryAgain(), this.#abort.signal);
	readonly #versions = { team: 0, staff: 0, sessions: 0, groups: 0, organization: 0, activity: 0, sidebar: 0 };
	#polling = false;
	readonly #invalidations = new Set<(resource: RealtimeResource) => void>();
	readonly #conversationLoads = new Map<string, { promise: Promise<void>; repeat: boolean; full: boolean }>();
	/** The newest conversation read (updated_at, id): a sessions hint reads only what changed since. */
	#sessionsCursor: PageCursor | undefined;
	/** When the conversations were last read whole (Date.now()), and that read while on its way. */
	#sessionsReadAt = 0;
	#sessionsFullRead: Promise<void> | undefined;
	/** A read of the changed conversations is on its way; another is wanted once it lands. */
	#changedRead: Promise<void> | undefined;
	#changedAgain = false;
	/** When each conversation was last read (Date.now()), at all and in full. */
	readonly #conversationReadAt = new Map<string, { any: number; full: number }>();
	/** Whole reads of the conversations that landed: a delta that started before one drops its copies. */
	#sessionsWholeReads = 0;
	/** The open conversation's next full read, when a hint read only its events. */
	#openFullTimer: ReturnType<typeof setTimeout> | undefined;
	/** Realtime was connected once: a return to connected catches up on what it may have missed. */
	#connectedBefore = false;
	/** This member's time zone was handed in for the company, which had none (#offerTimeZone): once, whatever came of it. */
	#timeZoneOffered = false;
	#spectatorsInvited = false;
	/** The cloud has no newest-first transcript read (before 20260928279410): threads read forward. */
	#tailMissing = false;
	/** Taken inputs a thread has read back for once: never again (a run queued for hours stays taken
	 * without an event, and each load would read further back). */
	readonly #readBackFor = new Set<string>();
	/** Proposals this browser discarded: a listing read before the discard landed does not show them again. */
	readonly #discardedProposals = new Set<string>();
	/** Per failed run: when its details may be read next (performance.now()), and
	 * the latest request, so an older answer never replaces a newer one. */
	readonly #recoveryReads = new Map<string, { due: number; request: number }>();
	/** The details RPC is not deployed on this cloud. */
	#recoveriesMissing = false;
	/** Members' unsent messages in the conversations they share (20260928000500). */
	readonly roomDrafts: RoomDrafts;
	/** This member's chats with the company's other members (20260930715000). */
	readonly memberChats: MemberChats;
	/** Which agents use their desktop computers now (20260930742000). */
	readonly #atComputers: AtComputerWatch;
	#mentionReads = 0;
	#approvalReads = 0;
	#hoursWaitReads = 0;
	/** This tab on the company's presence channel, once another member could be here. */
	#presence: CloudPresenceHandle | undefined;
	/** What this tab says it shows (app/presence-place.ts): the open conversation and its place while the tab is visible. */
	#tracked: string | null = null;
	/** Where this tab is outside a conversation: an interface's page, an app, Concepts, Sites or an agent's card. */
	#openPlace: string | undefined;

	constructor(api: CloudApi, profile: HostedProfile, userId: string, writeInput?: SessionInputWriter) {
		this.#api = api;
		this.#userId = userId;
		// A note from an app that waits in a thread (app/tell-agent.ts) answers its app's line, which the composer shows
		// above the field and never in it (`answering`). Wherever the draft is saved and shared, the line is its text's
		// first line (cloud/wall-reply.ts `appNoteLead`), so a reload, another tab and another member's client have it
		// with the words: it is put in front of the draft for the room, and taken out of the room's text again here.
		const lead = (sessionId: string) => {
			const answering = this.conversation(sessionId, false).get().answering;
			return answering !== undefined && appNoteHeader(answering) ? appNoteLead(answering) : "";
		};
		const shift = (quotes: readonly MessageQuote[], by: number) =>
			quotes.map((quote) => ({ ...quote, start: quote.start + by, end: quote.end + by }));
		this.roomDrafts = new RoomDrafts(api, userId, this.#abort.signal, {
			sharedRoom: (sessionId) => this.#sharedDraftRoom(sessionId),
			draft: (sessionId) => lead(sessionId) + (this.conversation(sessionId).get().draft ?? ""),
			quotes: (sessionId) => shift(this.draftQuotes(sessionId), [...lead(sessionId)].length),
			broken: (sessionId) => this.draftBroken(sessionId),
			lead: (text) => splitAppNote(text)?.lead.length ?? 0,
			// The merged draft's quotes take their words over: a record kept here never outlives the email its
			// words now come from (another tab removed one quote and quoted the same words from another email).
			setDraft: (sessionId, text, quotes) =>
				this.conversation(sessionId).set((state) => {
					const note = splitAppNote(text);
					const draft = note ? note.rest : text;
					const by = note ? [...note.lead].length : 0;
					const own = shift(
						quotes.filter((quote) => quote.start >= by),
						-by,
					);
					// The room's text says what the draft answers now: an app's line it opens with, or none any more
					// (another tab sent the note, or left the app out). A line that names no app is this browser's alone.
					const answering = note
						? { answering: note.line }
						: state.answering !== undefined && appNoteHeader(state.answering)
							? { answering: undefined }
							: {};
					return {
						draft,
						quoteRecords: takeQuoteRecords(state.quoteRecords ?? [], draft, own),
						...answering,
						...draftReplaced(state),
					};
				}),
		});
		this.#writeInput =
			writeInput ??
			(async () => {
				throw new Error(t("Sponsored message transport is unavailable."));
			});
		this.store = new Store<CompanyState>({
			profile,
			staff: [],
			sessions: [],
			organizationState: "loading",
			hierarchy: { primary: [], inactive: [] },
			activity: [],
			recoveries: {},
			realtime: "connecting",
			loading: true,
		});
		const chatCalls = memberChatCalls(api.cloud, profile.profileId);
		this.memberChats = new MemberChats({
			userId,
			calls: () => chatCalls,
			available: () => {
				const state = this.store.get();
				return (
					!this.#stopped &&
					!state.accessLost &&
					!state.memberChatsUnavailable &&
					state.team?.capabilities.read === true &&
					state.team.members.some((member) => member.userId !== userId)
				);
			},
			visible: () => typeof document === "undefined" || document.visibilityState !== "hidden",
			summaries: () => this.store.get().memberChats,
			setSummaries: (memberChats, placing) =>
				this.store.set(placing === undefined ? { memberChats } : { memberChats, memberContactPlacing: placing }),
			setUnavailable: () => this.store.set({ memberChatsUnavailable: true, memberChats: undefined }),
			placeFailed: () => this.reportRailError(t("The sidebar could not be changed. Try again.")),
			// Reset sidebar counts placed contacts among the member's changes (20260930727000).
			placed: () => {
				if (!this.ownSidebar()) return;
				// A newer place is never undone by an older reset's Undo.
				this.store.set({ sidebarReset: undefined });
				void this.refreshSidebar();
			},
		});
		this.#atComputers = new AtComputerWatch({
			read: () => this.#api.listScreensInUse(this.profile.profileId),
			onChange: (atComputers) => {
				if (!this.#stopped) this.store.set({ atComputers });
			},
			onUnavailable: () => {
				if (!this.#stopped) this.store.set({ atComputers: undefined, atComputersUnavailable: true });
			},
			resting: () => this.#restsWhileHidden(),
		});
	}

	get profile(): HostedProfile {
		return this.store.get().profile;
	}

	get userId(): string {
		return this.#userId;
	}

	get signal(): AbortSignal {
		return this.#abort.signal;
	}

	async start(): Promise<void> {
		if (this.#stopped || this.#realtime) return;
		this.#realtime = subscribeCompanyRealtime(
			this.#api.cloud,
			this.profile.profileId,
			this.#userId,
			(resource) => this.#onHint(resource),
			(phase, error, recovered) => {
				if (this.#stopped) return;
				// Back after a failure, also one the badge never showed (a hidden tab's, inside the grace): read again
				// what the hints may have missed.
				const back =
					phase === "connected" &&
					this.#connectedBefore &&
					(this.store.get().realtime !== "connected" || recovered === true);
				if (phase === "connected") this.#connectedBefore = true;
				this.store.set({ realtime: phase, realtimeError: error });
				if (back) this.#catchUp();
			},
		);
		await this.refreshAll();
		if (!this.#stopped && this.store.get().team?.capabilities.read) this.#atComputers.read();
		if (!this.#stopped) this.#poll = setInterval(() => void this.#tick(), HEARTBEAT_MS);
		if (!this.#stopped && typeof document !== "undefined") {
			if (document.visibilityState === "hidden") this.#hiddenAt = Date.now();
			document.addEventListener(
				"visibilitychange",
				() => {
					this.#seeMentions();
					this.memberChats.seen();
					if (document.visibilityState === "hidden") {
						this.#hiddenAt ??= Date.now();
						return;
					}
					this.#atComputers.returned();
					// Away a whole clock period: a frozen tab's timers never fired, so no skip was noted.
					const away = this.#hiddenAt !== undefined && Date.now() - this.#hiddenAt >= HEARTBEAT_MS;
					this.#hiddenAt = undefined;
					if (!away && !this.#skippedWhileHidden) return;
					this.#skippedWhileHidden = false;
					void this.#tick();
				},
				{ signal: this.signal },
			);
		}
	}

	/** A hidden tab with live hints reads on no clock: nobody is looking, the hints still land and read what they name, and
	 * its first moment back reads. (A tab left open read 19 times a minute all night, 7 Nov 2026.) Without live hints the
	 * clock stays the recovery path. That asks the channel itself: a failure while hidden does not reach the store. */
	#restsWhileHidden(): boolean {
		if (
			typeof document === "undefined" ||
			document.visibilityState !== "hidden" ||
			this.store.get().realtime !== "connected" ||
			!this.#realtime?.live()
		)
			return false;
		this.#skippedWhileHidden = true;
		return true;
	}

	stop(): void {
		if (this.#stopped) return;
		this.#stopped = true;
		this.#abort.abort();
		this.#atComputers.dispose();
		this.#emailDraftEditors.clear();
		for (const store of this.conversations.values())
			store.set((state) => ({
				draft: "",
				quoteRecords: undefined,
				...draftReplaced(state),
				attachments: [],
				retrySend: undefined,
				executionSponsor: undefined,
			}));
		clearInterval(this.#iconWatch);
		this.#realtime?.stop();
		this.#sidebarRealtime?.stop();
		void this.#presence?.stop().catch(() => {});
		this.#presence = undefined;
		this.memberChats.stop();
		if (this.#poll) clearInterval(this.#poll);
		clearTimeout(this.#watching);
		clearTimeout(this.#openFullTimer);
		this.#invalidations.clear();
		// Deliver a final access-loss update before dropping observers.
		queueMicrotask(() => {
			this.store.dispose();
			for (const store of this.conversations.values()) store.dispose();
		});
	}

	onInvalidate(listener: (resource: RealtimeResource) => void): () => void {
		this.#invalidations.add(listener);
		return () => this.#invalidations.delete(listener);
	}

	async refreshAll(): Promise<void> {
		if (this.#stopped) return;
		this.store.set({ loading: true, error: undefined });
		await Promise.all([
			this.refreshTeam(),
			this.refreshStaff(),
			this.refreshSessions(),
			this.refreshOrganization(),
			this.refreshActivity(),
			this.refreshSidebar(),
		]);
		await this.refreshGroups();
		this.store.set({ loading: false });
		void this.refreshMentions();
		void this.refreshHoursWait();
		void this.memberChats.refresh();
	}

	/** Re-read whether the company waits for computer hours. */
	async refreshHoursWait(): Promise<void> {
		if (this.#stopped || this.store.get().hoursWaitUnavailable || !this.store.get().team?.capabilities.read) return;
		const version = ++this.#hoursWaitReads;
		try {
			const waiting = await this.#api.companyWaitingForHours(this.profile.profileId);
			if (this.#stopped || version !== this.#hoursWaitReads) return;
			if (waiting !== (this.store.get().waitingForHours === true)) this.store.set({ waitingForHours: waiting });
		} catch (error) {
			if (this.#stopped || version !== this.#hoursWaitReads) return;
			if (error instanceof CloudRpcError && error.missing)
				this.store.set({ hoursWaitUnavailable: true, waitingForHours: false });
		}
	}

	/** Re-read where this member was mentioned and has not looked yet. */
	async refreshMentions(): Promise<void> {
		// A card waiting for this member changes where a mention does (an agent's thread), so both are read together.
		void this.refreshApprovals();
		if (this.#stopped || this.store.get().mentionsUnavailable || !this.store.get().team?.capabilities.read) return;
		const version = ++this.#mentionReads;
		try {
			const sessions = await this.#api.listMemberMentions(this.profile.profileId);
			if (this.#stopped || version !== this.#mentionReads) return;
			this.store.set({
				mentions: Object.fromEntries(sessions.map((item) => [item.sessionId, item.count])),
				mentionsReady: true,
			});
			this.#seeMentions();
		} catch (error) {
			if (this.#stopped || version !== this.#mentionReads) return;
			if (error instanceof CloudRpcError && error.missing)
				this.store.set({ mentionsUnavailable: true, mentions: {} });
		}
	}

	/** Re-read what each agent's work waits on this member for: its open cards for them and the approval cards they
	 * answer (20260930723000), in one read. A cloud before that reads the approval cards alone, as before. */
	async refreshApprovals(): Promise<void> {
		if (this.#stopped || !this.store.get().team?.capabilities.read) return;
		if (!this.store.get().waitingWorkUnavailable) {
			const version = ++this.#approvalReads;
			try {
				const work = await this.#api.listWaitingWork(this.profile.profileId);
				if (this.#stopped || version !== this.#approvalReads) return;
				const waitingOnMe: Record<string, WaitingWork> = {};
				const approvals: Record<string, number> = {};
				for (const item of work) {
					waitingOnMe[item.staffAgentId] = item;
					if (item.approvals) approvals[item.staffAgentId] = item.approvals;
				}
				this.store.set({ waitingOnMe, approvals });
				return;
			} catch (error) {
				if (this.#stopped || version !== this.#approvalReads) return;
				if (!(error instanceof CloudRpcError && error.missing)) return;
				this.store.set({ waitingWorkUnavailable: true, waitingOnMe: undefined });
			}
		}
		if (this.store.get().approvalsUnavailable) return;
		const version = ++this.#approvalReads;
		try {
			const waiting = await this.#api.listWaitingApprovals(this.profile.profileId);
			if (this.#stopped || version !== this.#approvalReads) return;
			const approvals: Record<string, number> = {};
			for (const item of waiting) approvals[item.staffAgentId] = (approvals[item.staffAgentId] ?? 0) + item.count;
			this.store.set({ approvals });
		} catch (error) {
			if (this.#stopped || version !== this.#approvalReads) return;
			if (error instanceof CloudRpcError && error.missing)
				this.store.set({ approvalsUnavailable: true, approvals: {} });
		}
	}

	/** The question cards waiting for this member in the company's agent threads (migration 20260930706000), for the
	 * app page and the Concepts viewer (app/open-questions.ts). None for a member who answers nothing; a cloud before the
	 * migration says so (CloudRpcError.missing), and the caller stops asking. */
	async listOpenQuestions(): Promise<OpenQuestion[]> {
		const state = this.store.get();
		if (this.#stopped || state.accessLost || !state.team?.capabilities.write) return [];
		return this.#api.listOpenQuestions(this.profile.profileId);
	}

	setOpenDecisions(count: number): void {
		if (!this.#stopped && (this.store.get().openDecisions ?? 0) !== count) this.store.set({ openDecisions: count });
	}

	async listOpenDecisions(): Promise<OpenDecision[]> {
		const state = this.store.get();
		if (this.#stopped || state.accessLost || !state.team?.capabilities.write) return [];
		return this.#api.listOpenDecisions(this.profile.profileId);
	}

	async listCompanyOpenDecisions(): Promise<OpenDecision[]> {
		const state = this.store.get();
		if (this.#stopped || state.accessLost || !state.team?.capabilities.read) return [];
		return this.#api.listCompanyOpenDecisions(this.profile.profileId);
	}

	async castDecisionVote(itemId: string, choice: string | undefined, note: string | undefined): Promise<void> {
		this.signal.throwIfAborted();
		const state = this.store.get();
		if (state.accessLost || !state.team?.capabilities.write) throw new Error(t("Voting is not available here."));
		await this.#api.castDecisionVote(this.profile.profileId, itemId, choice, note);
	}

	/** Mentions in the conversation on screen are seen: the badge goes, for this member only. */
	#seeMentions(): void {
		const sessionId = this.#openSessionId;
		const visible = typeof document === "undefined" || document.visibilityState !== "hidden";
		if (!sessionId || !visible || this.#stopped || !this.store.get().mentions?.[sessionId]) return;
		this.store.set((state) => {
			const { [sessionId]: _seen, ...rest } = state.mentions ?? {};
			return { mentions: rest };
		});
		void this.#api.markMentionsSeen(sessionId).catch(() => void this.refreshMentions());
	}

	/** Whom a message in this conversation can mention: the room's other members and, in a
	 * group chat, its agents (only those named then answer). None where the cloud reads no mentions. */
	mentionTargets(sessionId: string): MentionTarget[] {
		const state = this.store.get();
		const session = state.sessions.find((item) => item.sessionId === sessionId);
		const roomId = session?.executionScope?.roomId;
		if (this.#stopped || !state.mentionsReady || !session || typeof roomId !== "string" || !state.team) return [];
		const name = (userId: string) => state.team?.members.find((member) => member.userId === userId)?.displayName;
		if (isAgentThreadSession(session))
			// An agent's thread: every writing member is in it; its one agent answers anyway.
			return state.team.members
				.filter((member) => member.userId !== this.#userId && member.role !== "viewer")
				.map((member) => ({ kind: "member", id: member.userId, name: member.displayName }));
		// A group chat: its own members and agents, once they are known.
		const group = state.groups?.[roomId];
		if (session.staffAgentId || !group) return [];
		return [
			...this.groupAgents(sessionId).map(
				(agent): MentionTarget => ({ kind: "agent", id: agent.id, name: agent.displayName }),
			),
			...group.members.flatMap((member): MentionTarget[] => {
				const display = member.kind === "member" && member.id !== this.#userId ? name(member.id) : undefined;
				return display ? [{ kind: "member", id: member.id, name: display }] : [];
			}),
		];
	}

	async refreshTeam(): Promise<void> {
		if (this.#stopped) return;
		const version = ++this.#versions.team;
		try {
			const team = await this.#api.getTeam(this.profile.profileId);
			if (this.#stopped || version !== this.#versions.team) return;
			const before = this.store
				.get()
				.team?.members.map((member) => member.userId)
				.join(" ");
			this.store.set({ team, accessLost: false });
			void this.#offerTimeZone(team);
			void this.#invitePendingSpectators(team);
			this.#joinPresence();
			// Someone joined or left: the member chats are theirs too. (The first read comes with refreshAll.)
			if (before !== undefined && before !== team.members.map((member) => member.userId).join(" "))
				void this.memberChats.refresh();
		} catch (error) {
			if (this.#stopped || version !== this.#versions.team) return;
			if (error instanceof CloudRpcError && error.denied) {
				this.store.set({
					accessLost: true,
					team: undefined,
					staff: [],
					sessions: [],
					groups: {},
					organization: undefined,
					hierarchy: { primary: [], inactive: [] },
					activity: [],
					recoveries: {},
				});
				for (const store of this.conversations.values())
					store.set((state) => ({
						events: [],
						pending: [],
						optimistic: [],
						draft: "",
						quoteRecords: undefined,
						...draftReplaced(state),
						attachments: [],
						projection: { items: [], hiddenCount: 0, lastSequence: 0 },
						hasEarlier: false,
						earlierLoading: false,
						earlierError: undefined,
					}));
				this.stop();
			} else if (!this.#lost(error)) this.store.set({ error: describeError(error) });
		}
	}

	async #invitePendingSpectators(team: HostedProfileTeam): Promise<void> {
		if (this.#spectatorsInvited || !team.capabilities.manageMembers) return;
		this.#spectatorsInvited = true;
		try {
			const invited = await this.#api.invitePendingSpectators(this.profile.profileId);
			if (!this.#stopped && invited.length) void this.refreshTeam();
		} catch (error) {
			if (this.#stopped || (error instanceof CloudRpcError && error.missing)) return;
			this.store.set({
				error: t(
					"The spectators picked for this company could not be invited yet. Opening it again tries once more.",
				),
			});
		}
	}

	/** A company without a time zone takes the one this member's app shows times in (company-time-zone.ts; migration
	 * 20260930739000): when the team read says the company has none (null; a cloud before the migration says nothing
	 * and is asked nothing) and this member may act for it (never a viewer). Once: the cloud takes it only while the
	 * company has none and answers the company's, which the team then says. Nothing shows, whatever comes of it: a call
	 * that failed is not made again by this company's open, and a zone the cloud refused is not handed in again by this
	 * browser. */
	async #offerTimeZone(team: HostedProfileTeam): Promise<void> {
		if (this.#timeZoneOffered || team.timeZone !== null || !team.capabilities.write) return;
		const profileId = this.profile.profileId;
		const zone = memberTimeZone();
		if (!zone || timeZoneRefused(profileId, zone)) return;
		this.#timeZoneOffered = true;
		try {
			const timeZone = await this.#api.ensureCompanyTimeZone(profileId, zone);
			const current = this.store.get().team;
			if (!this.#stopped && current?.timeZone === null) this.store.set({ team: { ...current, timeZone } });
		} catch (error) {
			// 22023: the cloud does not know this zone's name. Anything else (offline, a cloud without the call) is left.
			if (error instanceof CloudRpcError && error.code === "22023") rememberTimeZoneRefused(profileId, zone);
		}
	}

	async refreshStaff(): Promise<void> {
		if (this.#stopped) return;
		const version = ++this.#versions.staff;
		try {
			const staff = await this.#api.listStaff(this.profile.profileId);
			if (this.#stopped || version !== this.#versions.staff) return;
			this.store.set((state) => ({ staff, hierarchy: buildCompanyHierarchy(state.organization, staff) }));
		} catch (error) {
			if (this.#stopped || version !== this.#versions.staff) return;
			if (!this.#lost(error)) this.store.set({ error: describeError(error) });
		}
	}

	/** Reads every conversation the member may read. */
	async refreshSessions(): Promise<void> {
		if (this.#stopped) return;
		const version = ++this.#versions.sessions;
		const started = Date.now();
		const read = (async () => {
			try {
				const sessions = await this.#api.listSessions(this.profile.environmentId, this.signal);
				if (this.#stopped || version !== this.#versions.sessions) return;
				this.#sessionsCursor = newestSession(sessions);
				this.#sessionsReadAt = started;
				this.#sessionsWholeReads += 1;
				this.store.set({ sessions, sessionsError: undefined });
				if (!this.store.get().loading) await this.refreshGroups();
			} catch (error) {
				if (this.#stopped || version !== this.#versions.sessions) return;
				this.store.set({ sessionsError: this.#lost(error) ? undefined : describeError(error) });
			}
		})();
		this.#sessionsFullRead = read;
		await read;
		if (this.#sessionsFullRead === read) this.#sessionsFullRead = undefined;
	}

	/** A sessions hint: reads what changed, then reads again only what it touched. The open
	 * conversation is read again when it changed, the mentions when a room changed; a whole read
	 * (no cursor yet, or an old one) counts as everything changed, as every hint did before. */
	async #sessionsChanged(): Promise<void> {
		if (this.#stopped) return;
		if (this.#changedRead) {
			this.#changedAgain = true;
			return this.#changedRead;
		}
		const read = (async () => {
			do {
				this.#changedAgain = false;
				const changed = await this.#readChangedSessions();
				if (this.#stopped) return;
				const open = this.#openSessionId;
				if (open && (!changed || changed.some((session) => session.sessionId === open)))
					this.#refreshOpenConversation();
				if (!changed || changed.some((session) => typeof session.executionScope?.roomId === "string"))
					this.#refreshMentionsSoon();
			} while (this.#changedAgain && !this.#stopped);
		})();
		this.#changedRead = read;
		try {
			await read;
		} finally {
			this.#changedRead = undefined;
		}
	}

	/** The conversations changed since the newest one read (updated_at cursor, reaching back
	 * SESSIONS_OVERLAP_MS), merged into the list; the whole list without a cursor or when its last
	 * whole read is old (undefined: all may have changed). A read on its way is waited for first. */
	async #readChangedSessions(): Promise<HostedSession[] | undefined> {
		if (this.#sessionsFullRead) await this.#sessionsFullRead;
		const cursor = this.#sessionsCursor;
		if (!cursor || Date.now() - this.#sessionsReadAt > SESSIONS_FULL_MS) {
			await this.refreshSessions();
			return undefined;
		}
		const since = Date.parse(cursor.time) - SESSIONS_OVERLAP_MS;
		const wholeReads = this.#sessionsWholeReads;
		try {
			const read = await this.#api.listSessions(
				this.profile.environmentId,
				this.signal,
				Number.isFinite(since) ? { time: new Date(since).toISOString(), id: NO_ID } : undefined,
			);
			if (this.#stopped) return [];
			// A whole read on its way, or one that landed meanwhile, is newer than this one's copies.
			if (this.#sessionsFullRead || wholeReads !== this.#sessionsWholeReads) return undefined;
			const known = new Map(this.store.get().sessions.map((session) => [session.sessionId, session]));
			const changed = read.filter((session) => known.get(session.sessionId)?.updatedAt !== session.updatedAt);
			this.#sessionsCursor = newestSession(read, this.#sessionsCursor);
			if (changed.length)
				this.store.set((state) => ({ sessions: mergeSessions(state.sessions, changed), sessionsError: undefined }));
			else if (this.store.get().sessionsError) this.store.set({ sessionsError: undefined });
			// A room's conversation changed (or appeared): its details are read again, as a whole read does.
			if (
				!this.store.get().loading &&
				changed.some((session) => !session.staffAgentId && typeof session.executionScope?.roomId === "string")
			)
				await this.refreshGroups();
			return changed;
		} catch (error) {
			if (!this.#stopped) this.store.set({ sessionsError: this.#lost(error) ? undefined : describeError(error) });
			// Unknown, not unchanged: what the hint would have read is read anyway.
			return undefined;
		}
	}

	#lost(error: unknown): boolean {
		if (this.#stopped || !connectionLost(error)) return false;
		this.#connectionFailures += 1;
		if (!this.store.get().connectionLost) this.store.set({ connectionLost: true });
		this.#reconnect.lost();
		return true;
	}

	async #tryAgain(): Promise<boolean> {
		const failures = this.#connectionFailures;
		await this.refreshTeam();
		await Promise.all([this.refreshSessions(), this.refreshStaff(), this.refreshOrganization()]);
		if (this.#stopped || this.#connectionFailures !== failures) return false;
		this.store.set({ connectionLost: undefined });
		for (const listener of this.#invalidations) listener("sessions");
		if (this.#openSessionId) void this.loadConversation(this.#openSessionId);
		return true;
	}

	async refreshOrganization(): Promise<void> {
		if (this.#stopped) return;
		const version = ++this.#versions.organization;
		try {
			const organization = await this.#api.getOrganization(this.profile.profileId);
			if (this.#stopped || version !== this.#versions.organization) return;
			this.store.set((state) => ({
				organization,
				organizationState: organization ? "ready" : "not-seeded",
				organizationError: undefined,
				hierarchy: buildCompanyHierarchy(organization, state.staff),
			}));
		} catch (error) {
			if (this.#stopped || version !== this.#versions.organization) return;
			if (error instanceof CloudRpcError && error.missing) {
				this.store.set((state) => ({
					organizationState: "not-deployed",
					hierarchy: buildCompanyHierarchy(undefined, state.staff),
				}));
			} else if (!this.#lost(error)) {
				this.store.set({ organizationState: "error", organizationError: describeError(error) });
			}
		}
	}

	async refreshSidebar(): Promise<void> {
		if (this.#stopped || this.store.get().sidebarUnavailable) return;
		const version = ++this.#versions.sidebar;
		try {
			const sidebar = await this.#api.readCompanySidebar(this.profile.profileId);
			// A change in flight answers with a newer sidebar than this read.
			if (this.#stopped || version !== this.#versions.sidebar || this.#sidebarPending) return;
			this.store.set({ sidebar });
			// The member's apps layout is part of their own sidebar: a hint for one is a hint for the other.
			if (sidebar.own) void this.refreshAppLayout();
			// Hints from now on: on the company's topic, or by postgres_changes on a channel of their own, so a cloud without
			// the sidebar tables must not degrade the company's hints.
			this.#sidebarRealtime ??= this.#realtime?.followSidebar(() => this.#onHint("sidebar"));
		} catch (error) {
			if (this.#stopped || version !== this.#versions.sidebar) return;
			if (error instanceof CloudRpcError && error.missing)
				this.store.set({ sidebarUnavailable: true, sidebar: undefined });
			// Otherwise the rail keeps what it showed: the sidebar arranges agents, it holds no content.
		}
	}

	/** What the sidebar arranges, in roster order: the active agents but the Co-Founder, then,
	 * where the cloud places them, the open group chats oldest first (as the cloud orders them). */
	sidebarRoster(): string[] {
		const cofounder = this.cofounderId();
		const agents = this.store
			.get()
			.staff.filter((agent) => agent.employmentStatus === "active" && agent.id !== cofounder)
			.map((agent) => agent.id);
		return this.store.get().sidebar?.groupChats ? [...agents, ...this.groupChatRooms().keys()] : agents;
	}

	/** The open group chats by room id, oldest first (by their conversations, as the cloud
	 * orders them), each with its conversation. Read-only: it is kept until the sessions change. */
	groupChatRooms(): ReadonlyMap<string, HostedSession> {
		const sessions = this.store.get().sessions;
		if (this.#groupRooms?.sessions === sessions) return this.#groupRooms.rooms;
		const rooms = new Map<string, HostedSession>();
		const chats = sessions
			.filter((session) => session.status === "open" && isGroupChat(session))
			.sort(
				(a, b) =>
					Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
					(a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0),
			);
		for (const session of chats) {
			const roomId = String(session.executionScope?.roomId).toLowerCase();
			if (UUID_PATTERN.test(roomId) && !rooms.has(roomId)) rooms.set(roomId, session);
		}
		this.#groupRooms = { sessions, rooms };
		return rooms;
	}

	/** Whether this cloud takes images in group chats: the migration that places group
	 * chats in the sidebar (20260928030000) lifted the text-only rule too. Undefined until
	 * the sidebar has been read; a cloud without the sidebar predates it. */
	groupChatImages(): boolean | undefined {
		const state = this.store.get();
		if (state.sidebarUnavailable) return false;
		return state.sidebar ? state.sidebar.groupChats === true : this.#groupChatImagesRead;
	}

	/** The same answer, read from the cloud now when the sidebar has not given it yet. The
	 * read's own answer counts, whatever other sidebar reads are in flight. */
	async #groupChatImagesNow(): Promise<boolean | undefined> {
		const known = this.groupChatImages();
		if (known !== undefined) return known;
		try {
			const sidebar = await this.#api.readCompanySidebar(this.profile.profileId);
			this.#groupChatImagesRead = sidebar.groupChats === true;
			// The rail takes the sidebar through its usual path, with its live updates.
			void this.refreshSidebar();
		} catch (error) {
			if (error instanceof CloudRpcError && error.missing) this.#groupChatImagesRead = false;
		}
		return this.groupChatImages();
	}

	cofounderId(): string | undefined {
		const state = this.store.get();
		return (
			(state.organization ? this.staffById(state.organization.cofounder.staffAgentId)?.id : undefined) ??
			state.staff.find((agent) => agent.employmentStatus === "active" && agent.templateId === "co-founder")?.id
		);
	}

	/** Makes section changes and moves edits of QorperaOS/agents/sections.md through the member's folder client, on a
	 * cloud from before each member's own sidebar (20260930727000) only; pins and hidden items stay with the RPC. */
	useSectionsFile(folder: (signal: AbortSignal) => WebMemberFolder): void {
		this.#sectionsFolder = folder;
	}

	/** Whether a reorder in Unassigned cannot be saved: the sections are QorperaOS/agents/sections.md and the cloud
	 * predates its order of what is in no section (20260930519000). */
	unassignedOrderLost(): boolean {
		const sidebar = this.store.get().sidebar;
		return this.#sectionsFolder !== undefined && sidebar?.own === undefined && sidebar?.unassignedOrder !== true;
	}

	/** Whether the sidebar is the member's own over the company's (20260930727000): what they change is theirs alone,
	 * and Reset sidebar brings back the company's. */
	ownSidebar(): boolean {
		const state = this.store.get();
		return Boolean(state.sidebar?.own && !state.sidebarUnavailable);
	}

	/** Takes away everything the member changed in this company's sidebar, or with `undo` puts back what the last
	 * reset took. Contacts' places and the apps layout come back with their next read, which this starts. */
	async resetSidebar(undo = false): Promise<boolean> {
		if (!this.ownSidebar()) return false;
		// One after the other with the apps layout's writes: a move on its way lands first. Until the reset and the apps
		// layout's read after it are done, the drawer makes no move, so none is built on what the reset took away.
		this.#resetting++;
		const reset = this.#appLayoutWrites
			.then(() => this.changeSidebar({ action: undo ? "undo_reset" : "reset" }))
			.then(async (done) => {
				// A cloud without each member's apps layout (before 20260930728000) has none to read again.
				if (!done || this.store.get().appLayoutUnavailable) return done;
				// The layout as the reset left it, read here and taken whatever other read is on its way; until one is
				// taken, moves stay held (a failed read leaves them held until a later read works).
				this.#appLayoutStale = true;
				++this.#appLayoutReads;
				try {
					const read = await this.#api.readMemberAppLayout(this.profile.profileId);
					// Reads sent before this one are dropped when they land (their version is older); this one is always taken.
					if (!this.#stopped) this.store.set({ appLayout: read });
					this.#appLayoutStale = false;
				} catch (error) {
					// No such read on this cloud: nothing to wait for. Otherwise moves wait for the next read that works.
					if (error instanceof CloudRpcError && error.missing) {
						this.#appLayoutStale = false;
						this.store.set({ appLayoutUnavailable: true });
					}
				}
				return done;
			})
			.finally(() => {
				this.#resetting--;
			});
		// What the next write names as last written is read again after a reset: nothing is carried over it.
		this.#appLayoutWrites = reset.then(
			() => undefined,
			() => undefined,
		);
		const done = await reset;
		if (done) void this.memberChats.refresh();
		return done;
	}

	/** Reads an app's own icons; the application sets it to the apps' reader. */
	appIconReader?: (app: string) => Promise<CompanyAppIcon[]>;
	/** The member's model accounts, for Generate icon's message: the thread's own account, chosen as its thread chooses
	 * it (as Mailbox's note does, app/company-mail.ts). The application sets it. */
	appIconAccounts?: Pick<WebNativeSubscription, "listConnections" | "selectSessionAccount">;
	readonly #iconReads = new Map<string, Promise<void>>();
	#iconWatch?: ReturnType<typeof setInterval>;

	/** Reads an app's own icons into `appIcons`, one read at a time for each app. A read that fails keeps what was read
	 * before. A new icon ends the app's drawing. */
	loadAppIcons(app: string): Promise<void> {
		const running = this.#iconReads.get(app);
		if (running || this.#stopped || !this.appIconReader) return running ?? Promise.resolve();
		const read = this.appIconReader(app)
			.then((icons) => {
				if (this.#stopped) return;
				const state = this.store.get();
				const drawing = state.appIconsDrawing?.[app];
				// A new icon, or an old id drawn again (an app at its 12 replaces one), ends the drawing.
				const done = drawing && icons.some((icon) => !drawing.known.includes(iconVersion(icon)));
				this.store.set({
					appIcons: { ...state.appIcons, [app]: icons },
					...(done ? { appIconsDrawing: withoutKey(state.appIconsDrawing, app) } : {}),
				});
			})
			.catch(() => undefined)
			.finally(() => this.#iconReads.delete(app));
		this.#iconReads.set(app, read);
		return read;
	}

	/** Reads again the icons of every app whose icons were read: the apps' folder changed. */
	refreshAppIcons(): void {
		for (const app of Object.keys(this.store.get().appIcons ?? {})) void this.loadAppIcons(app);
	}

	/** Generate icon (Jonas, 12 Nov 2026): asks the agent who made the app, or the Co-Founder when none did or it left, to
	 * draw three new icons, as a message in its thread the member can see and answer. The drawer shows the app drawing
	 * until a new icon is read (every ten seconds), or for ten minutes. Says why when it could not ask. */
	async requestAppIcons(app: CompanyApp): Promise<{ ok: true; agent: string } | { ok: false; reason: string }> {
		if (this.#stopped || !app.manifest) return { ok: false, reason: t("This company is no longer open.") };
		const state = this.store.get();
		const owner = app.manifest.owner
			? state.staff.find((agent) => agent.id === app.manifest?.owner && agent.employmentStatus === "active")
			: undefined;
		let sessionId: string | undefined;
		let name: string;
		try {
			if (owner) {
				sessionId = await this.openStaffConversation(owner);
				name = owner.displayName;
			} else {
				const opened = await this.openCofounderConversation();
				if (!opened.sessionId)
					return { ok: false, reason: opened.reason ?? t("The Co-Founder could not be reached.") };
				sessionId = opened.sessionId;
				name = this.staffById(this.cofounderId() ?? "")?.displayName ?? t("The Co-Founder");
			}
		} catch (error) {
			return { ok: false, reason: describeError(error) };
		}
		const text = t("Please draw 3 new icons for {name} (apps/{app}), from its name and what it shows.", {
			name: app.manifest.name,
			app: app.name,
		});
		// The ask goes only into an empty composer, as Mailbox's note does (app/company-mail.ts): a draft the member (or
		// another member, in a shared draft) is writing to this agent, its images and a message on its way stay as they
		// are, and the member is told why nothing was sent.
		const room = this.roomDrafts.room(sessionId);
		if (room) await room.refresh();
		const busy = () => {
			const now = this.conversation(sessionId, false).get();
			return (
				(room !== undefined && !room.usable()) ||
				Boolean((room?.draft(this.#userId)?.body ?? "").trim()) ||
				Boolean((now.draft ?? "").trim()) ||
				Boolean(now.attachments?.length) ||
				// An answer the member chose to a question of the agent's: the send would prefix it (review F1 on #1696, r2).
				now.answering !== undefined ||
				Boolean(now.sending) ||
				Boolean(now.retrySend)
			);
		};
		const started = t("You have a message started to {agent}. Send or clear it, then press Generate icon again.", {
			agent: name,
		});
		if (this.#stopped) return { ok: false, reason: t("This company is no longer open.") };
		if (busy()) return { ok: false, reason: started };
		await this.#chooseThreadAccount(sessionId);
		if (busy()) return { ok: false, reason: started };
		// What the icons were before the ask, by id and version: a new one, or one drawn again, ends the drawing.
		const known = (this.store.get().appIcons?.[app.name] ?? []).map(iconVersion);
		// Pressed in the apps drawer, over whatever page is open: the member's press stands for the thread on screen.
		if (!(await this.sendNote(sessionId, text)))
			return {
				ok: false,
				reason: this.conversation(sessionId, false).get().sendError ?? t("The message could not be sent."),
			};
		this.store.set((now) => ({
			appIconsDrawing: { ...now.appIconsDrawing, [app.name]: { since: Date.now(), known } },
		}));
		this.#watchIcons();
		return { ok: true, agent: name };
	}

	/** Gives a thread the model account the cloud chooses for it now, as its view does when it opens: the conversation's
	 * own account, never another; a message on its way keeps the one it carries. Without accounts, nothing changes. */
	async #chooseThreadAccount(sessionId: string): Promise<void> {
		const accounts = this.appIconAccounts;
		const conversation = this.conversation(sessionId, false).get();
		if (!accounts?.selectSessionAccount || conversation.sending || conversation.retrySend) return;
		try {
			const connectionId = await accounts.selectSessionAccount(sessionId, this.signal);
			if (!connectionId) return;
			const observed = await accounts.listConnections(this.signal);
			const now = this.conversation(sessionId, false).get();
			if (now.sending || now.retrySend) return;
			this.setExecutionSponsor(sessionId, observed, connectionId);
		} catch {
			// The send says what is missing.
		}
	}

	/** While an app is drawing: its icons are read every ten seconds, and a drawing older than ten minutes ends. */
	#watchIcons(): void {
		if (this.#iconWatch) return;
		this.#iconWatch = setInterval(() => {
			const drawing = this.store.get().appIconsDrawing ?? {};
			const names = Object.keys(drawing);
			if (this.#stopped || !names.length) {
				clearInterval(this.#iconWatch);
				this.#iconWatch = undefined;
				return;
			}
			const now = Date.now();
			const stale = names.filter((name) => now - drawing[name]!.since > APP_ICONS_DRAWING_MS);
			if (stale.length)
				this.store.set((state) => ({
					appIconsDrawing: stale.reduce((all, name) => withoutKey(all, name), state.appIconsDrawing),
				}));
			for (const name of names) if (!stale.includes(name)) void this.loadAppIcons(name);
		}, APP_ICONS_WATCH_MS);
	}

	/** Whether a Reset sidebar (or its Undo) is on its way: the drawer waits for it to move anything. */
	resettingSidebar(): boolean {
		return this.#resetting > 0 || this.#appLayoutStale;
	}

	/** Reads the member's own arrangement of the apps drawer. A cloud without it (before 20260930728000) says so once. */
	async refreshAppLayout(): Promise<void> {
		if (this.#stopped || this.store.get().appLayoutUnavailable) return;
		const version = ++this.#appLayoutReads;
		try {
			const read = await this.#api.readMemberAppLayout(this.profile.profileId);
			if (this.#stopped || version !== this.#appLayoutReads || this.#appLayoutPending) return;
			this.#appLayoutStale = false;
			this.store.set({ appLayout: read });
		} catch (error) {
			if (this.#stopped) return;
			if (error instanceof CloudRpcError && error.missing) this.store.set({ appLayoutUnavailable: true });
		}
	}

	/** Changes the member's own arrangement of the drawer: drawn at once, then written whole, one write at a time. A
	 * write another tab overtook is read again and said in the rail. */
	async changeAppLayout(next: MemberAppLayout): Promise<boolean> {
		const current = this.store.get().appLayout;
		if (this.#stopped || !current || this.#resetting || this.#appLayoutStale) return false;
		this.store.set({ appLayout: { ...current, layout: next }, railError: undefined, sidebarReset: undefined });
		// With nothing on its way, the time last read is the one to name; behind another write, the time it answered.
		const behind = this.#appLayoutPending > 0;
		this.#appLayoutPending++;
		const write = this.#appLayoutWrites.then((last) =>
			this.#api.setMemberAppLayout(
				this.profile.profileId,
				next,
				behind && last !== undefined ? last : current.updatedAt,
			),
		);
		this.#appLayoutWrites = write.then(
			(read) => read.updatedAt,
			() => undefined,
		);
		try {
			const read = await write;
			this.#appLayoutPending--;
			if (this.#stopped) return false;
			++this.#appLayoutReads;
			if (!this.#appLayoutPending) this.store.set({ appLayout: read });
			// Reset sidebar's count of the member's changes moves with it.
			void this.refreshSidebar();
			return true;
		} catch (error) {
			this.#appLayoutPending--;
			if (this.#stopped) return false;
			this.store.set({
				railError:
					error instanceof CloudRpcError && error.code === "QAL01"
						? t("Your apps changed in another tab. Try again.")
						: t("The apps could not be arranged. Try again."),
			});
			if (!this.#appLayoutPending) await this.refreshAppLayout();
			return false;
		}
	}

	/** Draws a sidebar change at once and sends it; changes go one at a time, in order.
	 * A refusal puts back what the cloud has and says why. */
	async changeSidebar(change: SidebarRequest): Promise<boolean> {
		const current = this.store.get();
		if (this.#stopped || !current.sidebar || current.sidebarUnavailable) return false;
		// Where the cloud places group chats, pin rows and section orders name them too; a
		// request without the flag is taken as one from a page that predates them.
		const request: SidebarRequest =
			current.sidebar.groupChats && (change.action === "set_pins" || change.action === "move_agent")
				? { ...change, groupChats: true }
				: change;
		const folder = this.#sectionsFolder;
		let send: () => Promise<CompanySidebar>;
		const roster = this.sidebarRoster();
		let drawn = applySidebarRequest(current.sidebar, request, roster);
		// Since 20260930727000 a section change is the member's own, through the RPC; the file is the company's.
		if (folder && current.sidebar.own === undefined && isSectionsRequest(request)) {
			const keeps = current.sidebar.unassignedOrder === true;
			let named: ReturnType<typeof sectionsChange>;
			try {
				// The file names sections, so they are named now, as the member sees them; Unassigned is written in the
				// order drawn, where the cloud keeps it.
				named = sectionsChange(
					current.sidebar,
					request,
					keeps ? containerOrder(drawn, undefined, roster) : undefined,
				);
			} catch (error) {
				this.store.set({ railError: sidebarRefusal(error, request) });
				return false;
			}
			// A cloud that keeps no order for Unassigned stands it in roster order, as it will answer.
			if (!keeps)
				drawn = {
					...drawn,
					placements: Object.fromEntries(Object.entries(drawn.placements).filter(([, place]) => place.sectionId)),
				};
			send = () => this.#writeSections(folder, named, "unpin" in request && request.unpin === true);
		} else send = () => this.#api.manageCompanySidebar(this.profile.profileId, request);
		// The offer to undo a reset goes with any other change; Undo itself keeps it until it worked, so a failed one can
		// be tried again.
		this.store.set({
			sidebar: drawn,
			railError: undefined,
			sidebarReset: request.action === "undo_reset" ? current.sidebarReset : undefined,
		});
		this.#sidebarPending++;
		const write = this.#sidebarWrites.then(send);
		this.#sidebarWrites = write.catch(() => {});
		try {
			const sidebar = await write;
			this.#sidebarPending--;
			if (this.#stopped) return false;
			++this.#versions.sidebar;
			if (!this.#sidebarPending) this.store.set({ sidebar });
			return true;
		} catch (error) {
			this.#sidebarPending--;
			if (this.#stopped) return false;
			this.store.set({ railError: sidebarRefusal(error, request) });
			if (!this.#sidebarPending) await this.refreshSidebar();
			return false;
		}
	}

	/** Writes a sections change to QorperaOS/agents/sections.md and answers the sidebar the commit placed. An item moved
	 * out of the pinned row is unpinned after, as the RPC did in the same request. */
	async #writeSections(
		folder: (signal: AbortSignal) => WebMemberFolder,
		change: ReturnType<typeof sectionsChange>,
		unpin: boolean,
	): Promise<CompanySidebar> {
		const signal = this.#abort.signal;
		const check = () => signal.throwIfAborted();
		const client = folder(signal);
		const rooms = this.groupChatRooms();
		const words = (id: string) => this.staffById(id)?.displayName ?? rooms.get(id)?.title;
		await rewriteStateFile(
			client,
			{
				locate: async () => SECTIONS_PATH,
				rewrite: (text) => rewriteSectionsFile(text, change, words),
				key: () => `web:sidebar-sections:${crypto.randomUUID()}`,
				gone: t("This company has no sections file."),
				failure: t("The sidebar could not be changed. Try again."),
			},
			signal,
			check,
		);
		const sidebar = await this.#api.readCompanySidebar(this.profile.profileId);
		// The member may have left the company or signed out meanwhile: their pins are written only while it is theirs.
		check();
		const item =
			change.action === "move" ? change.item : change.action === "create_section" ? change.item : undefined;
		if (!unpin || !item || !sidebar.pinned.includes(item)) return sidebar;
		return this.#api.manageCompanySidebar(this.profile.profileId, {
			action: "set_pins",
			order: sidebar.pinned.filter((pinned) => pinned !== item),
			...(sidebar.groupChats ? { groupChats: true as const } : {}),
		});
	}

	/** Says in the rail why a rail action did not happen; undefined clears it. */
	reportRailError(text: string | undefined): void {
		if (!this.#stopped) this.store.set({ railError: text });
	}

	async refreshActivity(): Promise<void> {
		if (this.#stopped) return;
		const version = ++this.#versions.activity;
		try {
			const activity = await this.#api.listStaffActivity(this.profile.environmentId);
			if (this.#stopped || version !== this.#versions.activity) return;
			this.store.set((state) => ({ activity, recoveries: stillFailed(state.recoveries, activity) }));
			if (activity.some((item) => item.activity !== "needs_attention")) this.#watchWork(6_000);
			this.#settleStops();
			void this.#readRecoveries(activity);
		} catch {
			/* Activity is an indicator; its absence must not block the company. */
		}
	}

	/* A failed run's details say why it failed and whether it left an open Company
	 * File proposal, which makes it a decision rather than a failure. */
	async #readRecoveries(activity: HostedStaffExecutionActivity[]): Promise<void> {
		if (this.#recoveriesMissing) return;
		const now = performance.now();
		const failed = new Set(activity.filter(isFailedRun).map((row) => row.runId));
		for (const runId of this.#recoveryReads.keys()) if (!failed.has(runId)) this.#recoveryReads.delete(runId);
		const due = [...failed].filter((runId) => (this.#recoveryReads.get(runId)?.due ?? 0) <= now);
		if (!due.length) return;
		const answers = await Promise.all(
			due.map((runId) => {
				const request = (this.#recoveryReads.get(runId)?.request ?? 0) + 1;
				// Not due again until this answer is in.
				this.#recoveryReads.set(runId, { due: Number.POSITIVE_INFINITY, request });
				return this.#api.getRunRecovery(runId).then(
					(recovery) => ({ runId, request, recovery }),
					(error: unknown) => ({ runId, request, error }),
				);
			}),
		);
		if (this.#stopped) return;
		const read: HostedRunRecovery[] = [];
		for (const answer of answers) {
			const entry = this.#recoveryReads.get(answer.runId);
			if (entry?.request !== answer.request) continue;
			if ("recovery" in answer) {
				const { recovery } = answer;
				const changes = recovery.proposalId !== undefined || recovery.unsettledOperations > 0;
				entry.due = changes ? performance.now() + RECOVERY_RECHECK_MS : Number.POSITIVE_INFINITY;
				read.push(recovery);
			} else if (answer.error instanceof CloudRpcError && answer.error.missing) {
				this.#recoveriesMissing = true;
			} else {
				entry.due = performance.now() + RECOVERY_RETRY_MS;
			}
		}
		const known = this.store.get().recoveries;
		const changed = read.filter((recovery) => JSON.stringify(known[recovery.runId]) !== JSON.stringify(recovery));
		if (changed.length)
			this.store.set((state) => {
				const recoveries = { ...state.recoveries };
				for (const recovery of changed) recoveries[recovery.runId] = recovery;
				return { recoveries: stillFailed(recoveries, state.activity) };
			});
		this.#settleStops();
	}

	/* A run a member stopped is no failure. A cloud before 20260926192436 still lists
	 * a stop, ranked above the agent's live work, which it then hides (and that work's
	 * Stop with it). Once the stop's details show it left no decision, a member who can
	 * write acknowledges it for the company, and the live work shows again. A newer
	 * cloud lists a stop only while its proposal waits, so this finds nothing there. A
	 * refused acknowledgment is tried again on a later activity read. */
	#settleStops(): void {
		const { activity, recoveries, acknowledgedRuns, team, accessLost } = this.store.get();
		if (!team?.capabilities.write || accessLost) return;
		for (const row of activity) {
			const recovery = recoveries[row.runId];
			if (row.jobStatus !== "cancelled" || !isFailedRun(row) || !recovery || recovery.proposalId) continue;
			if (acknowledgedRuns?.[row.runId]) continue;
			void this.dismissFailedRun(row.runId, { refresh: false }).then(
				() => this.refreshActivity(),
				() => undefined,
			);
		}
	}

	/** The next activity read asks again for a run's details. */
	#recheckRecovery(runId: string): void {
		const entry = this.#recoveryReads.get(runId);
		if (entry) entry.due = 0;
	}

	async groupDetails(sessionId: string, viewSignal: AbortSignal): Promise<GroupChatDetails> {
		const signal = AbortSignal.any([this.signal, viewSignal]);
		const current = () => {
			signal.throwIfAborted();
			const state = this.store.get();
			const session = state.sessions.find((item) => item.sessionId === sessionId);
			if (
				state.accessLost ||
				!state.team?.capabilities.read ||
				state.team.profileId !== this.profile.profileId ||
				!session ||
				session.staffAgentId ||
				typeof session.executionScope?.roomId !== "string" ||
				session.profileId !== this.profile.profileId ||
				session.environmentId !== this.profile.environmentId
			)
				throw new Error(t("This group chat is no longer available."));
			return session;
		};
		const session = current();
		const details = await readGroupChatDetails(this.#api.cloud, session, signal);
		if (current().executionScope?.roomId !== session.executionScope?.roomId)
			throw new Error(t("This group chat has changed. Open its details again."));
		const previous = this.store.get().groups?.[details.roomId];
		const latest =
			previous &&
			previous.roomId === details.roomId &&
			previous.sessionId === details.sessionId &&
			previous.environmentId === details.environmentId &&
			previous.version > details.version
				? previous
				: details;
		this.store.set((state) => ({ groups: { ...state.groups, [details.roomId]: latest } }));
		return latest;
	}

	/** One company-wide read supplies the membership behind every group avatar. */
	async refreshGroups(): Promise<void> {
		const state = this.store.get();
		const profile = this.profile;
		const canRead = () => {
			const current = this.store.get();
			return (
				!this.#stopped &&
				!current.accessLost &&
				Boolean(current.team?.capabilities.read) &&
				current.team?.profileId === profile.profileId &&
				this.profile.profileId === profile.profileId &&
				this.profile.environmentId === profile.environmentId
			);
		};
		if (!canRead()) return;
		const version = ++this.#versions.groups;
		const sessions = state.sessions.filter(
			(session) =>
				!session.staffAgentId &&
				typeof session.executionScope?.roomId === "string" &&
				session.profileId === profile.profileId &&
				session.environmentId === profile.environmentId,
		);
		if (!sessions.length) {
			this.store.set({ groups: {}, groupsError: undefined });
			return;
		}
		try {
			const rooms = await listGroupChatDetails(this.#api.cloud, profile.profileId, this.signal);
			if (!canRead() || version !== this.#versions.groups) return;
			const current = this.store.get();
			const groups: Record<string, GroupChatDetails> = {};
			for (const room of rooms) {
				const session = current.sessions.find((item) => item.sessionId === room.sessionId);
				if (
					!session ||
					session.staffAgentId ||
					session.profileId !== profile.profileId ||
					session.environmentId !== profile.environmentId ||
					session.executionScope?.roomId !== room.roomId ||
					room.environmentId !== profile.environmentId
				)
					continue;
				const previous = current.groups?.[room.roomId];
				groups[room.roomId] =
					previous &&
					previous.roomId === room.roomId &&
					previous.sessionId === room.sessionId &&
					previous.environmentId === room.environmentId &&
					previous.version > room.version
						? previous
						: room;
			}
			this.store.set({ groups, groupsError: undefined });
		} catch (error) {
			if (canRead() && version === this.#versions.groups)
				this.store.set({ groups: {}, groupsError: describeError(error) });
		}
	}

	groupAgents(sessionId: string): HostedStaffAgent[] {
		const state = this.store.get();
		if (
			this.#stopped ||
			state.accessLost ||
			!state.team?.capabilities.read ||
			state.team.profileId !== this.profile.profileId
		)
			return [];
		const session = state.sessions.find((item) => item.sessionId === sessionId);
		const roomId = session?.executionScope?.roomId;
		if (
			!session ||
			session.staffAgentId ||
			typeof roomId !== "string" ||
			session.profileId !== this.profile.profileId ||
			session.environmentId !== this.profile.environmentId
		)
			return [];
		const room = state.groups?.[roomId];
		if (
			!room ||
			room.roomId !== roomId ||
			room.sessionId !== sessionId ||
			room.environmentId !== session.environmentId
		)
			return [];
		return room.members.flatMap((member) => {
			const agent = member.kind === "staff_agent" ? this.staffById(member.id) : undefined;
			return agent?.employmentStatus === "active" && agent.profileId === this.profile.profileId ? [agent] : [];
		});
	}

	/** Shows an agent in a figure and colour not saved yet, or (`undefined`) as the roster has it. */
	showLook(agentId: string, look: FigureChoice | undefined): void {
		const shown = this.store.get().looks?.[agentId];
		if (shown?.figure === look?.figure && shown?.color === look?.color) return;
		this.store.set((state) => {
			const looks = { ...(state.looks ?? {}) };
			if (look) looks[agentId] = look;
			else delete looks[agentId];
			return { looks };
		});
	}

	staffById(id: string | undefined): HostedStaffAgent | undefined {
		return id ? this.store.get().staff.find((agent) => agent.id === id) : undefined;
	}

	memberName(userId: string | undefined): string {
		if (!userId) return t("Member");
		if (userId === this.#userId) return t("You");
		return this.store.get().team?.members.find((member) => member.userId === userId)?.displayName ?? t("Member");
	}

	/** The agent's newest run as the server reports it, settled or not. A failure from before the agent's newer work
	 * (20260930542000) is not the agent's run any more: it is listed apart. */
	#newestActivity(staffAgentId: string | undefined): HostedStaffExecutionActivity | undefined {
		if (!staffAgentId) return undefined;
		return this.store
			.get()
			.activity.filter((item) => item.staffAgentId === staffAgentId && !item.superseded)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
	}

	/** The agent's failure from before its newer work, if the server lists one (20260930542000). */
	#earlierFailure(staffAgentId: string | undefined): HostedStaffExecutionActivity | undefined {
		if (!staffAgentId) return undefined;
		return this.store
			.get()
			.activity.find((item) => item.staffAgentId === staffAgentId && item.superseded && isFailedRun(item));
	}

	activityFor(staffAgentId: string | undefined): HostedStaffExecutionActivity | undefined {
		const row = this.#newestActivity(staffAgentId);
		if (!row || !isFailedRun(row)) return row;
		const state = this.store.get();
		const recovery = state.recoveries[row.runId];
		// An open proposal is a decision, not a failure, and stays until it is decided.
		if (recovery?.proposalId) return row;
		// A dismissed failure is settled for this member even before the cloud's next
		// activity read; the agent reads as idle until newer work is reported. A run a
		// member stopped is no failure at all: once its details show it left no
		// decision, it is settled too (a cloud before 20260926192436 still lists it).
		return state.acknowledgedRuns?.[row.runId] || (row.jobStatus === "cancelled" && recovery) ? undefined : row;
	}

	/** What the member sees of an agent's execution. A queued run is already the
	 * agent's work from the member's side of the screen. needs_attention is either
	 * a decision (a run's Company File proposal is open) or a run that did not
	 * finish. The server reports one run per agent and ranks an undismissed failure
	 * above the run the agent works on, so "failed" stands until the member dismisses
	 * it, or until the agent has newer work: a failure from before that is listed
	 * apart (20260930542000) and never sets the state. A run a member stopped (every
	 * cancelled job is one) is never "failed": the server lists it only while its
	 * proposal waits, below all of the agent's work. An agent with no work of its own
	 * and an approval card waiting for this member's answer (its own or a worker's, in
	 * its thread) needs them too.
	 * An agent whose work waits on this member (waitingFor: a card it raised for them, or an approval card they
	 * answer) needs them whatever else it lists, except while a run of its own works: then it reads as working, and the
	 * rail marks it with a raised hand (Jonas, 11 Nov 2026: "it's really stopped at you"). */
	agentState(staffAgentId: string | undefined): AgentState {
		const row = this.activityFor(staffAgentId);
		const waiting = this.waitingFor(staffAgentId) !== undefined;
		if (!row) return waiting ? "decision" : "idle";
		// A run waiting at its login's usage limit is no work in progress: the agent rests until the reset
		// (20260930703000), and its thread says why.
		if (pausedNow(row)) return waiting ? "decision" : "idle";
		if (row.activity !== "needs_attention") {
			if (row.jobStatus === "leased" && row.phase === "writing") return "writing";
			// Working, and using its desktop computer now (20260930742000): only while its run works.
			return this.atComputer(staffAgentId) ? "computer" : "working";
		}
		if (waiting || !isFailedRun(row)) return "decision";
		return row.jobStatus === "cancelled" || this.store.get().recoveries[row.runId]?.proposalId
			? "decision"
			: "failed";
	}

	/** The desktop computer this agent uses now, by the database's word (20260930742000), whether its run works or not;
	 * undefined when it uses none. The rail and the thread show it only while the agent works (agentState). */
	atComputer(staffAgentId: string | undefined): AgentAtComputer | undefined {
		if (!staffAgentId) return undefined;
		const entry = this.store.get().atComputers?.[staffAgentId];
		return entry && entry.until > Date.now() ? entry : undefined;
	}

	/** What the agent's work waits on this member for: the newest item in a few words (`what`, when the cloud says),
	 * its kind (a question, or something else), and how many wait. A cloud before 20260930723000 says only how many approval cards wait, with no words. */
	waitingFor(staffAgentId: string | undefined): { count: number; what?: string; kind?: WaitingKind } | undefined {
		if (!staffAgentId) return undefined;
		const state = this.store.get();
		const work = state.waitingOnMe?.[staffAgentId];
		if (work)
			return {
				count: work.count,
				...(work.what ? { what: work.what } : {}),
				...(work.kind ? { kind: work.kind } : {}),
			};
		const approvals = state.approvals?.[staffAgentId];
		return approvals ? { count: approvals } : undefined;
	}

	/** How many of the company's agents wait on this member: the tab's title counts them. */
	agentsWaitingOnMe(): number {
		return this.store
			.get()
			.staff.filter((agent) => agent.employmentStatus === "active" && this.waitingFor(agent.id) !== undefined)
			.length;
	}

	/** The agent's run waiting at its login's usage limit, while the pause holds (20260930703000). */
	pausedRunFor(staffAgentId: string | undefined): HostedStaffExecutionActivity | undefined {
		const row = this.activityFor(staffAgentId);
		return row && pausedNow(row) ? row : undefined;
	}

	/** The member whose own login pays for a waiting run moves it to another of their logins, by their own pick: it goes
	 * on there at once (20260930703000). Activity is read again either way, so the thread shows what holds now. */
	async movePausedRun(runId: string, connectionId: string): Promise<void> {
		if (this.#stopped) return;
		try {
			await this.#api.movePausedRun(runId, connectionId);
		} finally {
			if (!this.#stopped) await this.refreshActivity();
		}
		if (!this.#stopped) this.#watchWork(20_000);
	}

	/** The agent's failure to show: the one that is its state, or else the one from before its newer work. */
	failedRunFor(staffAgentId: string | undefined): FailedRun | undefined {
		const current = this.activityFor(staffAgentId);
		if (current && isFailedRun(current)) return this.#failedRun(current);
		const earlier = this.#earlierFailure(staffAgentId);
		if (!earlier || this.store.get().acknowledgedRuns?.[earlier.runId]) return undefined;
		const failed = this.#failedRun(earlier);
		return failed && { ...failed, earlier: true };
	}

	#failedRun(row: HostedStaffExecutionActivity): FailedRun | undefined {
		const recovery = this.store.get().recoveries[row.runId];
		// A stopped run's line only ever asks for its decision, so it waits for the details that name it.
		if (row.jobStatus === "cancelled" && !recovery?.proposalId) return undefined;
		return recovery ? { activity: row, recovery } : { activity: row };
	}

	/** Whether Try again can be offered for this run. A session turn is re-queued by the
	 * recovery RPC; a post into a room needs qorpera_retry_room_delivery (20260920080000).
	 * Routine and agent wakes, and proposal reviews, are not the member's to repeat, and
	 * neither is a run a member stopped: to repeat the message, they send it again. Nor is
	 * a run whose work already took effect or may have: the cloud refuses to repeat it. */
	canRetryFailedRun(failed: FailedRun): boolean {
		const state = this.store.get();
		const recovery = failed.recovery;
		if (!state.team?.capabilities.write || state.accessLost || recovery?.proposalId) return false;
		if (failed.activity.jobStatus === "cancelled") return false;
		if ((recovery?.unsettledOperations ?? 0) > 0 || recovery?.durableOutcome) return false;
		// Only the member whose ChatGPT plan paid for a session turn may try it again (20260929950000); a post runs
		// again on the account selected here.
		if (failed.activity.sourceKind === "session_turn")
			return recovery?.paidByChatgptPlan !== true || recovery.requestedByUserId === this.#userId.toLowerCase();
		return failed.activity.sourceKind === "room_delivery" && !state.roomRetryUnavailable;
	}

	/** Try again. The member's message stays as it is; the cloud runs it once more on
	 * the model account selected in this conversation. */
	async retryFailedRun(runId: string, sessionId: string): Promise<void> {
		if (this.#stopped || this.store.get().runRetries?.[runId]?.pending) return;
		const failed = this.store.get().activity.find((row) => row.runId === runId);
		if (!failed) return;
		const mark = (value: { pending: boolean; error?: string } | undefined) => {
			const runRetries = { ...(this.store.get().runRetries ?? {}) };
			if (value) runRetries[runId] = value;
			else delete runRetries[runId];
			this.store.set({ runRetries });
		};
		mark({ pending: true });
		try {
			if (failed.sourceKind === "session_turn") await this.#api.retryFailedRun(runId);
			else {
				const sponsor = this.conversation(sessionId, false).get().executionSponsor;
				if (!sponsor) {
					mark({ pending: false, error: t("Select an active model account, then try again.") });
					return;
				}
				await this.#api.retryRoomDelivery(runId, sponsor.sponsorBindingId, sponsor.sponsorVersion);
			}
			mark(undefined);
		} catch (error) {
			if (this.#stopped) return;
			if (error instanceof CloudRpcError && error.missing) {
				// The web is ahead of the deployed cloud. Say so once and stop offering it.
				mark({ pending: false, error: t("Trying again is not available yet. Send the message again instead.") });
				this.store.set({ roomRetryUnavailable: true });
			} else mark({ pending: false, error: retryRefusal(error) });
		} finally {
			// Released or refused: someone may have settled the run first.
			this.#recheckRecovery(runId);
			await this.refreshActivity();
		}
	}

	/** Dismiss: the run stops standing in for the agent's state, here at once and in
	 * the cloud durably, so it does not return on reload or on another device. The
	 * cloud acknowledges any failed run, including one whose durable outcome is still
	 * unknown; a cloud without that action falls back to discard where it can. */
	async dismissFailedRun(runId: string, options: { refresh?: boolean } = {}): Promise<void> {
		if (this.#stopped) return;
		const mark = (acknowledged: boolean) =>
			this.store.set((state) => {
				const acknowledgedRuns = { ...(state.acknowledgedRuns ?? {}) };
				if (acknowledged) acknowledgedRuns[runId] = true;
				else delete acknowledgedRuns[runId];
				return { acknowledgedRuns };
			});
		mark(true);
		// A member known to lack write access hides the card for this session only;
		// acknowledging needs write access.
		const { team, accessLost } = this.store.get();
		if ((team && !team.capabilities.write) || accessLost) return;
		try {
			await this.#api.acknowledgeFailedRun(runId);
		} catch (error) {
			if (this.#stopped) return;
			if (error instanceof CloudRpcError && error.status !== 401 && error.status !== 403) {
				// Older cloud: try the discard it knows; a refused discard changes nothing,
				// and the dismissal stays local for this session.
				await this.#api.discardFailedRun(runId).catch(() => undefined);
			} else {
				// Nothing reached the cloud: the failure is not settled, so show it again.
				mark(false);
				throw error;
			}
		} finally {
			if (!this.#stopped && options.refresh !== false) {
				// Refused or not, read again: someone may have settled the run first.
				this.#recheckRecovery(runId);
				await this.refreshActivity();
			}
		}
	}

	/** A new message supersedes the agent's last failure: dismiss it on the member's behalf. */
	#dismissFailureFor(sessionId: string): void {
		const state = this.store.get();
		const session = state.sessions.find((item) => item.sessionId === sessionId);
		const current = this.#newestActivity(session?.staffAgentId);
		// The last failure is the agent's earlier one once it has newer work (20260930542000).
		const row = current && isFailedRun(current) ? current : this.#earlierFailure(session?.staffAgentId);
		const recovery = row ? state.recoveries[row.runId] : undefined;
		// Only a failure whose details are known and that left no decision behind; a
		// run with an open proposal is the member's to decide, not to dismiss by sending.
		// A stop reads as settled already, but a cloud before 20260926192436 still ranks
		// it above the new message's run, so it is dismissed the same way.
		if (
			row &&
			recovery &&
			row.sourceKind !== "proposal_review" &&
			!recovery.proposalId &&
			!state.acknowledgedRuns?.[row.runId]
		)
			// sendPrompt reads activity again right after; no second read here.
			void this.dismissFailedRun(row.runId, { refresh: false }).catch(() => undefined);
	}

	primarySessionFor(staffAgentId: string): HostedSession | undefined {
		const sessions = this.store.get().sessions.filter((session) => session.staffAgentId === staffAgentId);
		return sessions.find(isAgentThreadSession) ?? sessions.find(isPrimaryStaffSession);
	}

	/** The agent's shared thread (2026-09-17 amendment): one conversation every
	 * member sees, bound to the agent's room by the kernel. */
	async openStaffConversation(agent: HostedStaffAgent): Promise<string> {
		if (this.#stopped) throw new Error(t("This company is no longer open."));
		const existing = this.primarySessionFor(agent.id);
		if (existing) return existing.sessionId;
		const thread = await this.#api.agentThread(this.profile.environmentId, agent.id);
		await this.refreshSessions();
		return thread.sessionId;
	}

	/** The Co-Founder's shared thread; there is no member-private conversation. */
	async openCofounderConversation(): Promise<{ sessionId?: string; reason?: string }> {
		if (this.#stopped) return { reason: t("This company is no longer open.") };
		const { organization, organizationState, team, sessions, staff } = this.store.get();
		// A company on the folder core has no organization record (that is the old core's Order 0): its Co-Founder is the
		// active agent hired from the Co-Founder template, which company creation makes.
		const cofounderId =
			organization?.cofounder.staffAgentId ??
			staff.find((agent) => agent.templateId === "co-founder" && agent.employmentStatus === "active")?.id;
		if (!cofounderId) {
			if (organizationState === "not-deployed") {
				return {
					reason: t(
						"The organization kernel (Order 0) is not deployed on this cloud yet, so there is no Co-Founder home here.",
					),
				};
			}
			return {
				reason: t("This company has no Co-Founder yet. The cloud seeds one when Order 0 bootstraps the company."),
			};
		}
		if (organization?.cofounder.memberSessionId) return { sessionId: organization.cofounder.memberSessionId };
		const thread = sessions.find((session) => session.staffAgentId === cofounderId && isAgentThreadSession(session));
		if (thread) return { sessionId: thread.sessionId };
		if (!team?.capabilities.read) return { reason: t("This company is not readable.") };
		try {
			const handle = await this.#api.agentThread(this.profile.environmentId, cofounderId);
			await this.refreshSessions();
			return { sessionId: handle.sessionId };
		} catch (error) {
			if (error instanceof CloudRpcError && error.missing) {
				return { reason: t("Agent threads are not deployed on this cloud yet.") };
			}
			return { reason: describeError(error) };
		}
	}

	conversation(sessionId: string, load = true): Store<ConversationState> {
		let store = this.conversations.get(sessionId);
		if (!store) {
			store = new Store<ConversationState>({
				sessionId,
				events: [],
				pending: [],
				projection: { items: [], hiddenCount: 0, lastSequence: 0 },
				loading: true,
				complete: false,
				sending: false,
				optimistic: [],
			});
			this.conversations.set(sessionId, store);
			if (load) void this.loadConversation(sessionId);
		}
		return store;
	}

	setOpenSession(sessionId: string | undefined): void {
		this.#openSessionId = sessionId;
		this.#trackOpen();
		this.#seeMentions();
	}

	/** Where this tab is when no conversation is open (app/presence-place.ts), or nowhere (undefined). */
	setOpenPlace(place: string | undefined): void {
		this.#openPlace = place;
		this.#trackOpen();
	}

	/** The other members who have this conversation open now, one entry per member. */
	presentIn(sessionId: string): { userId: string; name: string }[] {
		return this.#peopleWhere((at) => at.sessionId === sessionId);
	}

	/** The other members in the company now, by the place in the rail their tab shows (an agent, a group chat, a page or
	 * an app; app/presence-place.ts), one entry per member and place. */
	peopleByPlace(): Map<string, { userId: string; name: string }[]> {
		const places = new Map<string, { userId: string; name: string }[]>();
		const state = this.store.get();
		const seen = new Set<string>();
		for (const member of state.here ?? []) {
			const place = parsePresenceValue(member.staffAgentId).place;
			if (!place || member.userId === this.#userId || seen.has(`${member.userId} ${place}`)) continue;
			seen.add(`${member.userId} ${place}`);
			const list = places.get(place) ?? [];
			list.push({ userId: member.userId, name: this.#memberName(member.userId, member.name) });
			places.set(place, list);
		}
		return places;
	}

	#memberName(userId: string, fallback: string): string {
		return this.store.get().team?.members.find((item) => item.userId === userId)?.displayName ?? fallback;
	}

	#peopleWhere(test: (at: { sessionId?: string; place?: string }) => boolean): { userId: string; name: string }[] {
		const seen = new Map<string, { userId: string; name: string }>();
		for (const member of this.store.get().here ?? [])
			if (
				member.userId !== this.#userId &&
				!seen.has(member.userId) &&
				test(parsePresenceValue(member.staffAgentId))
			)
				seen.set(member.userId, { userId: member.userId, name: this.#memberName(member.userId, member.name) });
		return [...seen.values()];
	}

	/** Join the presence channel once the company has another member: alone, nobody could be here. */
	#joinPresence(): void {
		const team = this.store.get().team;
		if (this.#stopped || this.#presence || !team?.members.some((member) => member.userId !== this.#userId)) return;
		try {
			this.#presence = this.#api.joinPresence(
				this.profile.profileId,
				(members) => {
					if (!this.#stopped) this.store.set({ here: members.filter((member) => member.userId !== this.#userId) });
				},
				() => {},
			);
		} catch {
			return;
		}
		this.#tracked = null;
		if (typeof document !== "undefined")
			document.addEventListener("visibilitychange", () => this.#trackOpen(), { signal: this.signal });
		// The open conversation's place is known once its session is: track again when the sessions arrive.
		const stop = this.store.subscribe(() => this.#trackOpen());
		this.signal.addEventListener("abort", stop, { once: true });
		this.#trackOpen();
	}

	/** Say which conversation this tab shows, and where it is in the rail: nothing while the tab is hidden. */
	#trackOpen(): void {
		if (!this.#presence || this.#stopped) return;
		const visible = typeof document === "undefined" || document.visibilityState !== "hidden";
		const sessionId = this.#openSessionId;
		const place = sessionId
			? sessionPlace(this.store.get().sessions.find((session) => session.sessionId === sessionId))
			: this.#openPlace;
		const open = visible ? presenceValue(sessionId, place) : null;
		if (open === this.#tracked) return;
		this.#tracked = open;
		this.#presence.setOpenThread(open);
	}

	/** Reads a conversation's new events, its waiting inputs and its coding sessions; with
	 * `eventsOnly`, only its new events (a thread that has read its history before). Full or not,
	 * a thread with events reads forward from the newest one it has: one that opened at its newest
	 * events keeps that window and only "Show earlier" reads further back, so hints, the trailing
	 * full read, the watch and a catch-up after Realtime returns never read from the start. */
	loadConversation(sessionId: string, options: { eventsOnly?: boolean } = {}): Promise<void> {
		if (this.#stopped) return Promise.resolve();
		const full = !options.eventsOnly;
		const existing = this.#conversationLoads.get(sessionId);
		if (existing) {
			existing.repeat = true;
			existing.full ||= full;
			return existing.promise;
		}
		const request = { repeat: false, full, promise: Promise.resolve() };
		this.#conversationLoads.set(sessionId, request);
		request.promise = this.#loadConversation(sessionId, request).finally(() =>
			this.#conversationLoads.delete(sessionId),
		);
		return request.promise;
	}

	async #loadConversation(sessionId: string, request: { repeat: boolean; full: boolean }): Promise<void> {
		const store = this.conversations.get(sessionId);
		if (!store) return;
		do {
			request.repeat = false;
			const known = store.get();
			// A conversation read for the first time is read in full.
			const full = request.full || !known.complete;
			request.full = false;
			const events = [...known.events];
			const places = new Map(events.map((event, place) => [event.sequence, place]));
			/** Set when a read replaced an event with its erased copy. */
			let replaced = false;
			const add = (read: readonly HostedSessionEvent[]) => {
				for (const event of read) {
					const place = places.get(event.sequence);
					if (place === undefined) {
						places.set(event.sequence, events.length);
						events.push(event);
					} else if (erasedCopy(events[place], event)) {
						events[place] = event;
						replaced = true;
					}
				}
			};
			/** Set when this load read the newest events first; else the thread keeps what it knew. */
			let hasEarlier: boolean | undefined;
			// A failed read ends the others at their next page.
			let failed = false;
			const live = () => !this.#stopped && !failed;
			// The history after `from`, page by page, oldest first.
			const readForward = async (from: number): Promise<boolean> => {
				let after = from;
				for (;;) {
					const page = await this.#api.readSessionEvents(sessionId, after, EVENT_PAGE);
					if (!live()) return false;
					add(page);
					if (page.length < EVENT_PAGE) return true;
					const next = page[page.length - 1]?.sequence ?? after;
					if (next <= after) throw new Error(t("The transcript cursor did not advance."));
					after = next;
				}
			};
			const readEvents = async (): Promise<boolean> => {
				// A thread opens at its newest events; "Show earlier" reads further back (loadEarlier).
				if (!known.events.length && !this.#tailMissing) {
					try {
						const read = await this.#readTail(sessionId, [], undefined, live);
						if (!read) return false;
						add(read.events);
						hasEarlier = read.hasEarlier;
						return true;
					} catch (error) {
						if (!missingTailRead(error) || !live()) throw error;
						// A cloud before 20260928279410 reads the whole history forward, as before.
						this.#tailMissing = true;
					}
				}
				// The history after what the thread has.
				return readForward(known.projection.lastSequence);
			};
			// Every input still waiting, all pages.
			const readPending = async (): Promise<PendingSessionInput[] | undefined> => {
				const pending: PendingSessionInput[] = [];
				let position = 0;
				for (;;) {
					const page = await this.#api.listSessionInputs(sessionId, position, 100);
					if (!live()) return undefined;
					pending.push(...page.items);
					if (!page.hasMore) return pending;
					if (page.nextAfterPosition <= position || !page.items.length)
						throw new Error(t("The input cursor did not advance."));
					position = page.nextAfterPosition;
				}
			};
			// "Show earlier" may have read older events meanwhile: both stay.
			const current = () => (store.get().events === known.events ? events : mergeEvents(store.get().events, events));
			// The member's open proposals of the agent wait in the agent's thread (not a group chat, a routine's or a
			// worker's session).
			const session = this.store.get().sessions.find((item) => item.sessionId === sessionId);
			const agent = session && isPrimaryStaffSession(session) ? session : undefined;
			try {
				// The history, the waiting inputs, the coding sessions, the proposals and the erasure generation do not
				// depend on one another: they are read side by side, and the thread draws once, when all landed.
				const [complete, read, listed, proposals, generation] = await Promise.all([
					readEvents(),
					// New events only: the waiting inputs, coding sessions and proposals stay as last read.
					full ? readPending() : Promise.resolve(undefined),
					// The listing is optional: a cloud without Order 9 answers with a missing
					// RPC, and a refused or failed listing keeps what the thread already shows.
					full ? this.#api.listCodingSessions(sessionId).catch(() => undefined) : Promise.resolve(undefined),
					// So are the proposals: a company not on folder-v2 refuses, a cloud before P40c has no RPC.
					full && agent?.staffAgentId
						? this.#api.listAgentProposals(agent.environmentId, agent.staffAgentId).catch(() => undefined)
						: Promise.resolve(undefined),
					// An erase rewrites an event the thread may have read already. A failed read keeps the generation the
					// events reflect, and the next full read asks again.
					full
						? this.#api.readSessionMemoryGeneration(sessionId).catch(() => undefined)
						: Promise.resolve(undefined),
				]);
				const pending = full ? read : store.get().pending;
				if (this.#stopped || !complete || !pending) return;
				// Another generation than the events reflect (or, first found, above 0, which may have come after a read
				// that ran beside it): the events read so far are read again, and each erased copy replaces its event.
				const reflected = store.get().memoryGeneration;
				const reread =
					generation !== undefined && (reflected === undefined ? generation > 0 : generation !== reflected)
						? current()[0]?.sequence
						: undefined;
				if (reread !== undefined && !(await readForward(reread - 1))) return;
				let merged = current();
				let earlier = hasEarlier ?? store.get().hasEarlier ?? false;
				// An input a run took before the oldest event read stands in the transcript before it: read
				// back until its place is read, so it is not shown again as waiting.
				const taken = earlier
					? takenBefore(pending, merged).filter((input) => !this.#readBackFor.has(input.inputId))
					: [];
				if (taken.length) {
					for (const input of taken) this.#readBackFor.add(input.inputId);
					const read = await this.#readTail(sessionId, merged, taken, () => !this.#stopped);
					if (!read) return;
					// "Show earlier" may have landed meanwhile, and reached further back.
					merged = mergeEvents(store.get().events, read.events);
					earlier = earlierOf(read, store.get());
				}
				const optimistic = reconcileOptimistic({ optimistic: store.get().optimistic, pending, events: merged });
				const projection = projectTranscript(merged, pending);
				const codingSessions = listed
					? newerCodingSessions(listed, store.get().codingSessions)
					: (store.get().codingSessions ?? []);
				const now = Date.now();
				this.#conversationReadAt.set(sessionId, {
					any: now,
					full: full ? now : (this.#conversationReadAt.get(sessionId)?.full ?? 0),
				});
				// A "Show earlier" that landed meanwhile may hold copies from before an erase: unless it reached no
				// further back than the events read again, and left the generation as this read found it, the generation
				// stays unknown and the next full read reads the events again.
				const settled =
					store.get().memoryGeneration === reflected &&
					(reread === undefined || (store.get().events[0]?.sequence ?? reread) >= reread);
				store.set({
					events: merged,
					pending,
					projection,
					loading: false,
					complete: true,
					error: undefined,
					optimistic,
					interactionAnswers: reconcileInteractionAnswers(store.get().interactionAnswers, projection, pending),
					codingSessions,
					...(proposals ? { proposals: this.#withoutDiscarded(proposals) } : {}),
					...(generation === undefined ? {} : { memoryGeneration: settled ? generation : undefined }),
					hasEarlier: earlier,
				});
			} catch (error) {
				failed = true;
				// The history read before the failure stays, so the next read resumes after it, and so do erased copies.
				// The generation the events reflect stays as it was: a failed read of them again is repeated.
				const merged = current();
				const read =
					!this.#stopped && (events.length > known.events.length || replaced)
						? {
								events: merged,
								projection: projectTranscript(merged, store.get().pending),
								optimistic: reconcileOptimistic({
									optimistic: store.get().optimistic,
									pending: store.get().pending,
									events: merged,
								}),
								...(hasEarlier === undefined ? {} : { hasEarlier }),
							}
						: {};
				this.#lost(error);
				store.set({ ...read, loading: false, complete: false, error: describeError(error) });
				return;
			}
		} while (request.repeat && !this.#stopped);
	}

	/** Reads a transcript back from the oldest event in `loaded` (from its end when empty), a page
	 * at a time, until the thread shows TAIL_ITEMS more items, every input in `pending` has its
	 * place read, or the start is reached; at most TAIL_PAGES pages. Undefined once `live` fails. */
	async #readTail(
		sessionId: string,
		loaded: readonly HostedSessionEvent[],
		pending: readonly PendingSessionInput[] | undefined,
		live: () => boolean,
	): Promise<{ events: HostedSessionEvent[]; hasEarlier: boolean } | undefined> {
		let events = [...loaded];
		const shown = () => projectTranscript(events, []).items.length;
		const wanted = pending ? 0 : shown() + TAIL_ITEMS;
		let hasEarlier = true;
		for (let page = 0; page < TAIL_PAGES && hasEarlier; page++) {
			const read = await this.#api.readSessionEventsTail(sessionId, events[0]?.sequence, TAIL_PAGE);
			if (!live()) return undefined;
			events = mergeEvents(read, events);
			// Sequences start at 1: a full page that does not reach it may have more before it.
			hasEarlier = read.length === TAIL_PAGE && (read[0]?.sequence ?? 1) > 1;
			if (pending ? !waitingBefore(pending, events) : shown() >= wanted) break;
		}
		return { events, hasEarlier };
	}

	/** "Show earlier": reads the transcript back from the oldest event this browser has read. */
	async loadEarlier(sessionId: string): Promise<void> {
		const store = this.conversations.get(sessionId);
		const state = store?.get();
		if (!store || !state?.hasEarlier || state.earlierLoading || this.#stopped) return;
		store.set({ earlierLoading: true, earlierError: undefined });
		try {
			const read = await this.#readTail(sessionId, state.events, undefined, () => !this.#stopped);
			if (!read) return;
			// A read of new events that landed meanwhile keeps them; a read-back that went further
			// back meanwhile keeps its start.
			const current = store.get();
			const events = mergeEvents(read.events, current.events);
			const projection = projectTranscript(events, current.pending);
			store.set({
				events,
				projection,
				hasEarlier: earlierOf(read, current),
				earlierLoading: false,
				optimistic: reconcileOptimistic({ optimistic: current.optimistic, pending: current.pending, events }),
				interactionAnswers: reconcileInteractionAnswers(current.interactionAnswers, projection, current.pending),
				// A full read found another erasure generation meanwhile, and may have read the events again before these
				// landed: they may predate an erase, so the next full read reads them again.
				...(current.memoryGeneration === state.memoryGeneration ? {} : { memoryGeneration: undefined }),
			});
		} catch (error) {
			if (!this.#stopped) store.set({ earlierLoading: false, earlierError: describeError(error) });
		}
	}

	// Coding sessions: the thread element follows one session's stream itself; the
	// owner's answer and delegation go through here so the listing stays current.

	readCodingSession(workerId: string, afterEvent = 0): Promise<CodingSessionRead> {
		return this.#api.readCodingSession(workerId, afterEvent);
	}

	/** The thread's sessions read again, for the header's figures while one is still going. */
	async refreshCodingSessions(sessionId: string): Promise<void> {
		const store = this.conversations.get(sessionId);
		if (!store || this.#stopped) return;
		const listed = await this.#api.listCodingSessions(sessionId);
		if (!this.#stopped) store.set({ codingSessions: newerCodingSessions(listed, store.get().codingSessions) });
	}

	async answerCodingSession(
		sessionId: string,
		workerId: string,
		text: string,
		clientRequestId: string,
	): Promise<void> {
		this.#mergeCodingSession(sessionId, await this.#api.answerCodingSession(workerId, text, clientRequestId));
	}

	async delegateCodingSession(sessionId: string, workerId: string, clientRequestId: string): Promise<void> {
		this.#mergeCodingSession(sessionId, await this.#api.delegateCodingSession(workerId, clientRequestId));
	}

	async archiveCodingSession(sessionId: string, workerId: string, clientRequestId: string): Promise<void> {
		this.#mergeCodingSession(sessionId, await this.#api.archiveCodingSession(workerId, clientRequestId));
	}

	/** The session's owner: its login and the other logins of theirs that can pay for it (20260930551000). */
	listCodingSessionLogins(workerId: string): Promise<CodingSessionLogins> {
		return this.#api.listCodingSessionLogins(workerId);
	}

	/** The session's owner moves it to another of their logins, by hand. */
	async chooseCodingSessionLogin(sessionId: string, workerId: string, connectionId: string): Promise<void> {
		this.#mergeCodingSession(sessionId, await this.#api.chooseCodingSessionLogin(workerId, connectionId));
	}

	#mergeCodingSession(sessionId: string, session: CodingSession): void {
		const store = this.conversations.get(sessionId);
		if (!store) return;
		const current = store.get().codingSessions ?? [];
		const merged = current.some((item) => item.workerId === session.workerId)
			? current.map((item) =>
					item.workerId === session.workerId && compareCodingSessions(session, item) >= 0
						? { ...session, isOwner: session.isOwner ?? item.isOwner }
						: item,
				)
			: [...current, session];
		store.set({ codingSessions: merged });
	}

	assertCanSend(sessionId: string): void {
		const state = this.store.get();
		const session = state.sessions.find((item) => item.sessionId === sessionId);
		if (
			this.#stopped ||
			state.accessLost ||
			!state.team?.capabilities.write ||
			state.team.profileId !== this.profile.profileId ||
			!session ||
			session.status !== "open" ||
			session.profileId !== this.profile.profileId ||
			session.environmentId !== this.profile.environmentId
		)
			throw new Error(t("This conversation is not available for sending."));
	}

	setExecutionSponsor(sessionId: string, observed: NativeExecutionConnections, connectionId?: string): void {
		this.assertCanSend(sessionId);
		const executionSponsor = connectionId
			? selectSessionExecutionSponsor(observed, connectionId, this.#userId)
			: undefined;
		this.conversation(sessionId, false).set({ executionSponsor, sendError: undefined });
	}

	/** Explicitly abandon local replay identity; the cloud may have accepted it. */
	discardSendRetry(sessionId: string): void {
		this.assertCanSend(sessionId);
		const store = this.conversation(sessionId, false);
		const state = store.get();
		if (state.sending) throw new Error(t("Wait for message submission before starting a new request."));
		if (!state.retrySend) return;
		const clientInputId = state.retrySend.clientInputId;
		store.set({
			retrySend: undefined,
			sendError: undefined,
			optimistic: state.optimistic.filter((item) => item.clientInputId !== clientInputId),
		});
	}

	/** The room of a conversation whose drafts this member shares: an open room this
	 * member writes in, where another member of the company can write too. */
	#sharedDraftRoom(sessionId: string): string | undefined {
		const state = this.store.get();
		if (this.#stopped || state.accessLost || !state.team?.capabilities.write) return undefined;
		const session = state.sessions.find((item) => item.sessionId === sessionId);
		if (session?.status !== "open") return undefined;
		let roomId: string | undefined;
		try {
			roomId = this.roomTargetFor(sessionId)?.roomId;
		} catch {
			return undefined;
		}
		if (!roomId) return undefined;
		// An agent thread is every writing member's; a group chat is its own members'.
		const group = state.groups?.[roomId];
		const others = group
			? group.members.some((member) => member.kind === "member" && member.id !== this.#userId)
			: state.team.members.some((member) => member.userId !== this.#userId && member.role !== "viewer");
		return others ? roomId.toLowerCase() : undefined;
	}

	roomTargetFor(sessionId: string): RoomMessageTarget | undefined {
		const session = this.store.get().sessions.find((item) => item.sessionId === sessionId);
		const scope = session?.executionScope;
		if (!session || !scope || !("roomId" in scope)) return undefined;
		if (typeof scope.roomId !== "string" || !UUID_PATTERN.test(scope.roomId))
			throw new Error(t("The team room conversation is unavailable."));
		// An agent thread is a room the kernel bound to one agent; a team room has no single agent.
		const agentThread = isAgentThreadSession(session);
		return Object.freeze({
			roomId: scope.roomId,
			environmentId: session.environmentId,
			agentThread,
			images: agentThread || this.groupChatImages() === true,
		});
	}

	/** Editors are company/member scoped and survive navigation and transcript polling. */
	emailDraftEditor(interactionId: string): EmailDraftEditor {
		let editor = this.#emailDraftEditors.get(interactionId);
		if (!editor) {
			editor = {};
			this.#emailDraftEditors.set(interactionId, editor);
		}
		return editor;
	}

	/** Who each agent works for, and the asks that move one (cloud/works-for.ts; the Members page). */
	worksFor(): WorksForCalls {
		this.#worksFor ??= worksForCalls(this.#api.cloud, this.profile.profileId);
		return this.#worksFor;
	}

	async loadEmailDraft(sessionId: string, interactionId: string): Promise<EmailDraftState> {
		this.signal.throwIfAborted();
		if (this.store.get().accessLost || !this.store.get().team?.capabilities.read)
			throw new Error(t("This conversation is not available for sending."));
		this.#emailDraftClient ??= new EmailDraftClient(this.#api.cloud, this.#userId, this.signal);
		return this.#notifyEmailDraft(
			sessionId,
			interactionId,
			await this.#emailDraftClient.read(sessionId, interactionId),
		);
	}

	async actEmailDraft(
		sessionId: string,
		interactionId: string,
		action: EmailDraftAction,
		content: EmailDraftContent,
	): Promise<EmailDraftState> {
		this.assertCanSend(sessionId);
		this.#emailDraftClient ??= new EmailDraftClient(this.#api.cloud, this.#userId, this.signal);
		const result = await this.#notifyEmailDraft(
			sessionId,
			interactionId,
			await this.#emailDraftClient.act(sessionId, interactionId, action, content, this.#answerSponsor(sessionId)),
		);
		// The broker records delivery before the answer. Never optimistically mark an email sent.
		if (!this.#stopped && (result.status === "sent" || result.status === "discarded")) {
			void this.loadConversation(sessionId);
			void this.refreshActivity();
			this.#watchWork(20_000);
		}
		return result;
	}

	async #notifyEmailDraft(sessionId: string, interactionId: string, state: EmailDraftState): Promise<EmailDraftState> {
		if (!state.notificationPending || !state.actionId || (state.status !== "sent" && state.status !== "discarded"))
			return state;
		try {
			this.assertCanSend(sessionId);
			// The kernel replaces this empty answer with its durable provider receipt.
			// Retrying only the notification cannot invoke Gmail again.
			await this.#api.answerInteraction(
				sessionId,
				state.actionId,
				interactionId,
				state.status,
				{},
				this.#answerSponsor(sessionId),
			);
			void this.loadConversation(sessionId);
			void this.refreshActivity();
			this.#watchWork(20_000);
			return { ...state, notificationPending: false };
		} catch {
			return state; // Keep the confirmed delivery visible while notification is pending.
		}
	}

	/** Answer a card the agent raised in this thread. The answer is sent like a
	 * message and shows on the card at once; the kernel refuses a second answer,
	 * an expired card, or a member who does not answer it (answersInteraction). */
	async answerInteraction(
		sessionId: string,
		interactionId: string,
		outcome: InteractionOutcome,
		answer: Record<string, JsonValue> = {},
	): Promise<void> {
		this.assertCanSend(sessionId);
		const store = this.conversation(sessionId);
		const key = interactionId.toLowerCase();
		if (store.get().interactionAnswers?.[key]) return;
		store.set({
			interactionAnswers: {
				...store.get().interactionAnswers,
				[key]: { outcome, answer, answeredBy: this.#userId, answeredAt: new Date().toISOString(), pending: true },
			},
			interactionError: undefined,
		});
		try {
			const sponsor = this.#answerSponsor(sessionId);
			const receipt = await this.#api
				.answerInteraction(sessionId, crypto.randomUUID(), interactionId, outcome, answer, sponsor)
				.catch((error: unknown) => {
					// A cloud before bundle v100 cannot deliver an answer in an agent's thread:
					// it would queue one that never wakes the agent. Keep the card open.
					if (error instanceof CloudRpcError && error.missing)
						throw new Error(t("Answering cards here is not available yet. Reply in a message instead."));
					throw error;
				});
			// Remembered so a delivery that fails later opens the card again (reconcileInteractionAnswers).
			const sent = store.get().interactionAnswers?.[key];
			if (sent)
				store.set({
					interactionAnswers: { ...store.get().interactionAnswers, [key]: { ...sent, inputId: receipt.inputId } },
				});
		} catch (error) {
			const { [key]: _dropped, ...rest } = store.get().interactionAnswers ?? {};
			store.set({
				interactionAnswers: Object.keys(rest).length ? rest : undefined,
				interactionError: answerRefusal(error),
			});
			throw error;
		}
		void this.loadConversation(sessionId);
		// The answer wakes the agent, as a message does; watch for its run. The card no longer waits on the member.
		void this.refreshActivity();
		void this.refreshApprovals();
		this.#watchWork(20_000);
	}

	/** Answer an approval card of an agent's action (bundle v130): Allow once,
	 * Always allow (saves `ruleText` as a company rule) or Deny. The card shows the
	 * answer at once; the kernel refuses a member the card does not wait for
	 * (answersActionReview). If the agent stopped waiting, the answer wakes it on
	 * the member's selected model account; while it still waits, none is needed. */
	async answerActionReview(
		sessionId: string,
		reviewId: string,
		answer: ActionReviewAnswer,
		ruleText?: string,
	): Promise<void> {
		const store = this.conversation(sessionId);
		const key = reviewId.toLowerCase();
		if (store.get().interactionAnswers?.[key]) return;
		try {
			this.assertCanSend(sessionId);
		} catch (error) {
			// Say why on the thread (an archived conversation, no write access), not silently.
			store.set({ interactionError: answerRefusal(error) });
			throw error;
		}
		store.set({
			interactionAnswers: {
				...store.get().interactionAnswers,
				[key]: {
					outcome: answer === "deny" ? "declined" : "approved",
					answer: { answer },
					answeredBy: this.#userId,
					answeredAt: new Date().toISOString(),
					pending: true,
				},
			},
			interactionError: undefined,
		});
		try {
			const selected = this.conversation(sessionId).get().executionSponsor;
			const receipt = await this.#api
				.answerActionReview(
					reviewId,
					crypto.randomUUID(),
					answer,
					ruleText,
					selected
						? { sponsorBindingId: selected.sponsorBindingId, sponsorVersion: selected.sponsorVersion }
						: undefined,
				)
				.catch((error: unknown) => {
					if (error instanceof CloudRpcError && error.missing)
						throw new Error(t("Approvals are not available here yet. Reply in a message instead."));
					throw error;
				});
			const sent = store.get().interactionAnswers?.[key];
			if (sent)
				store.set({
					interactionAnswers: { ...store.get().interactionAnswers, [key]: { ...sent, inputId: receipt.inputId } },
				});
		} catch (error) {
			const { [key]: _dropped, ...rest } = store.get().interactionAnswers ?? {};
			store.set({
				interactionAnswers: Object.keys(rest).length ? rest : undefined,
				interactionError: answerRefusal(error),
			});
			// Someone else may have answered first: show the card as it is now.
			void this.loadConversation(sessionId);
			throw error;
		}
		void this.loadConversation(sessionId);
		void this.refreshActivity();
		void this.refreshApprovals();
		this.#watchWork(20_000);
	}

	/** Discard one of the member's open proposals in an agent's thread (P40c): the agent's run cannot apply it anymore.
	 * The core decides who may (the member it waits for, owners and admins). One that is gone (decided, or erased with
	 * its run) leaves the thread as a discarded one does. */
	async discardProposal(sessionId: string, proposalId: string): Promise<void> {
		const store = this.conversation(sessionId);
		const id = proposalId.toLowerCase();
		const session = this.store.get().sessions.find((item) => item.sessionId === sessionId);
		if (!session || store.get().discardingProposals?.includes(id)) return;
		store.set({ discardingProposals: [...(store.get().discardingProposals ?? []), id], interactionError: undefined });
		try {
			await this.#api.discardProposal(session.environmentId, id).catch((error: unknown) => {
				if (!(error instanceof CloudRpcError && error.code === "P0002")) throw error;
			});
			this.#discardedProposals.add(id);
			const proposals = store.get().proposals;
			if (proposals) store.set({ proposals: this.#withoutDiscarded(proposals) });
		} catch (error) {
			store.set({ interactionError: describeError(error) });
			throw error;
		} finally {
			const discarding = store.get().discardingProposals?.filter((item) => item !== id) ?? [];
			store.set({ discardingProposals: discarding.length ? discarding : undefined });
			void this.loadConversation(sessionId);
		}
	}

	#withoutDiscarded(page: FolderProposalPage): FolderProposalPage {
		const proposals = page.proposals.filter((proposal) => !this.#discardedProposals.has(proposal.proposalId));
		return proposals.length === page.proposals.length ? page : { ...page, proposals };
	}

	/** An answer runs the agent the way a message there does, on the member's
	 * selected model account: like a post in an agent's shared thread (bundle
	 * v100), like a turn request in a plain conversation (bundle v105). */
	#answerSponsor(sessionId: string): { sponsorBindingId: string; sponsorVersion: number } {
		const sponsor = this.conversation(sessionId).get().executionSponsor;
		if (!sponsor) throw new Error(t("Select an active model account, then try again."));
		return { sponsorBindingId: sponsor.sponsorBindingId, sponsorVersion: sponsor.sponsorVersion };
	}

	/** Put a secret card's value into the company's cloud custody and answer the
	 * card as provided. The value goes from this browser to the secret broker
	 * and nowhere else; the card learns a reference. Owners and admins save it
	 * for the company, other members for themselves. An existing secret with the
	 * same connector and name is replaced (a new version), never duplicated.
	 * A coding value (connector `environment`, 20260930693000) that names a
	 * repository is given to that repository's coding sessions when an owner or
	 * admin saves it for the company; without a repository it is the member's
	 * own, which reaches their coding sessions in every repository (a company
	 * value reaches none until it is given to one). */
	/** Whether this member's save of a secret card is the company's (an owner or admin, and for a coding value only one
	 * that names its repository) or their own: what the card says and what provideSecret saves. */
	secretSavedForCompany(request: InteractionRequest): boolean {
		const role = this.store.get().team?.role;
		const coding = request.payload.connectorId === "environment";
		return (role === "owner" || role === "admin") && (!coding || typeof request.payload.repository === "string");
	}

	async provideSecret(
		sessionId: string,
		interactionId: string,
		request: InteractionRequest,
		value: string,
	): Promise<void> {
		this.assertCanSend(sessionId);
		const store = this.conversation(sessionId);
		const name = typeof request.payload.name === "string" ? request.payload.name : "";
		const connectorId = typeof request.payload.connectorId === "string" ? request.payload.connectorId : "vault";
		const purpose = typeof request.payload.purpose === "string" ? request.payload.purpose : request.title;
		const coding = connectorId === "environment";
		const repository = typeof request.payload.repository === "string" ? request.payload.repository : undefined;
		const company = this.secretSavedForCompany(request);
		store.set({ interactionError: undefined });
		try {
			// Never store a value whose answer could not be sent.
			this.#answerSponsor(sessionId);
			const existing = (
				await this.#api.listSecretConnections(this.profile.profileId, this.profile.environmentId)
			).find(
				(secret) =>
					secret.status === "active" &&
					secret.connectorId === connectorId &&
					secret.secretName === name &&
					(company ? secret.ownerKind === "company" : secret.ownerUserId === this.#userId),
			);
			const ticket = await this.#api.beginSecretCapture({
				profileId: this.profile.profileId,
				environmentId: this.profile.environmentId,
				ownerKind: company ? "company" : "member",
				...(company ? {} : { ownerUserId: this.#userId }),
				connectorId,
				secretName: name,
				purpose: purpose.slice(0, 512),
				...(existing ? { existingSecretId: existing.secretId } : {}),
			});
			const saved = await this.#api.captureSecret(ticket, value);
			if (coding && company && repository)
				await createWebCodingEnvironment(this.#api.cloud, this.profile, this.#userId)
					.grant(saved.secretId, repository)
					.catch((error: unknown) => {
						throw new Error(
							t("{variable} is saved, but it could not be given to {repository}: {error} Try again.", {
								variable: name.toUpperCase(),
								repository,
								error: describeError(error),
							}),
						);
					});
		} catch (error) {
			store.set({ interactionError: describeError(error) });
			throw error;
		}
		await this.answerInteraction(sessionId, interactionId, "provided", {});
	}

	canChooseMailAddress(): boolean {
		const role = this.store.get().team?.role;
		return role === "owner" || role === "admin";
	}

	mailAddressCalls(sessionId: string, interactionId: string): MailAddressCalls {
		const hooks = createWebEventHooks(this.#api.cloud, this.profile);
		return {
			canChoose: this.canChooseMailAddress(),
			handles: (signal) => hooks.mailHandles(signal),
			status: (handle, signal) => hooks.handleStatus(handle, signal),
			choose: (handle) => this.chooseMailAddress(sessionId, interactionId, handle),
		};
	}

	async chooseMailAddress(sessionId: string, interactionId: string, handle: string): Promise<void> {
		this.assertCanSend(sessionId);
		this.conversation(sessionId).set({ interactionError: undefined });
		const hooks = createWebEventHooks(this.#api.cloud, this.profile);
		const localPart = `hello.${handle}`;
		let address: string | undefined;
		try {
			this.#answerSponsor(sessionId);
			const kept = (await hooks.list()).find(
				(hook) => hook.proof === "mail" && hook.email?.split("@")[0] === localPart,
			);
			if (kept?.status === "paused") await hooks.setStatus(kept.id, "active");
			address = (kept ?? (await hooks.createMailbox(localPart, "The company's main email"))).email;
		} catch (error) {
			throw new Error(mailboxRefusal(error));
		}
		if (!address) throw new Error(t("The address could not be made. Try again."));
		await this.answerInteraction(sessionId, interactionId, "answered", { values: [address] });
	}

	/** The quotes of outside content in a conversation's draft: its records' words wherever they stand in «» marks. */
	draftQuotes(sessionId: string): MessageQuote[] {
		const state = this.conversation(sessionId, false).get();
		return placeQuotes(state.draft ?? "", state.quoteRecords ?? []);
	}

	/** The draft holds a quote's words with only one of their marks (app/quotes.ts, brokenQuotes): it is neither saved
	 * nor sent until the member mends or removes them, so the words never go as their own. */
	draftBroken(sessionId: string): boolean {
		const state = this.conversation(sessionId, false).get();
		return brokenQuotes(state.draft ?? "", state.quoteRecords ?? []).length > 0;
	}

	/** The member changed the draft's text in a composer; `caret` is where theirs stands. A change that reaches into a
	 * quote removes the whole quote (app/quotes.ts). Returns the text kept, which the composer shows, and its caret. */
	editDraft(
		sessionId: string,
		text: string,
		caret?: number,
		edit?: FieldEdit,
	): { text: string; caret: number | undefined } {
		const store = this.conversation(sessionId, false);
		const before = store.get().draft ?? "";
		const kept = keepQuotesWhole(before, store.get().quoteRecords ?? [], text, caret, edit);
		store.set({ draft: kept.text });
		return kept;
	}

	/** Put a message button's text after the conversation's draft, its outside values as quotes. Nothing is sent. */
	addToDraft(sessionId: string, addition: QuotedText): void {
		const store = this.conversation(sessionId);
		const state = store.get();
		const next = appendQuoted(state.draft ?? "", state.quoteRecords ?? [], addition);
		if (!next)
			throw new Error(
				t("That message already quotes the same words from another email. Send it or remove that quote first."),
			);
		if (placeQuotes(next.text, next.records).length > QUOTES_MAX)
			throw new Error(t("That message already quotes as much as one message can. Send it or remove a quote first."));
		store.set((now) => ({ draft: next.text, quoteRecords: next.records, ...draftReplaced(now) }));
		// A shared draft shares it at once, as if the member had typed it.
		this.roomDrafts.input(sessionId);
	}

	/** What the conversation's draft answers: an app's line (a note from an app's page, app/tell-agent.ts), or
	 * nothing. An app's line is part of the draft where it is shared, so it is shared at once, as the draft's text
	 * would be. */
	setAnswering(sessionId: string, answering: string | undefined): void {
		this.conversation(sessionId, false).set({ answering });
		this.roomDrafts.input(sessionId);
	}

	async sendPrompt(sessionId: string, text: string, viewSignal?: AbortSignal): Promise<boolean> {
		if (this.#stopped || viewSignal?.aborted) return false;
		try {
			this.assertCanSend(sessionId);
		} catch {
			return false;
		}
		const store = this.conversation(sessionId);
		const files = [...(store.get().attachments ?? [])];
		const trimmed = withReply(store.get().answering, text.trim(), files.length);
		// The quotes of the text as sent: its records' words in their marks, counted from the trimmed start.
		const quotes = placeQuotes(trimmed, store.get().quoteRecords ?? []);
		if ((!trimmed && !files.length) || store.get().sending) return false;
		// The last guard: a quote's words with one mark gone never go as the member's own.
		if (brokenQuotes(trimmed, store.get().quoteRecords ?? []).length) {
			store.set({ sendError: t("A quote is missing one of its « » marks. Remove it, or put the mark back.") });
			return false;
		}
		if (quotes.length > QUOTES_MAX) {
			store.set({
				sendError: t("A message can hold at most {count} quotes. Remove some to send it.", { count: QUOTES_MAX }),
			});
			return false;
		}
		const problem = sessionAttachmentProblem(files);
		if (problem) {
			store.set({ sendError: attachmentProblemText(problem) });
			return false;
		}
		const retry = store.get().retrySend;
		const sameFiles = (other: readonly File[]) =>
			other.length === files.length && other.every((file, index) => file === files[index]);
		// The cloud compares a repeated call's whole body, quotes included.
		const sameRequest = retry?.text === trimmed && sameFiles(retry.files) && sameQuotes(retry.quotes ?? [], quotes);
		if (retry && !sameRequest) {
			store.set({
				draft: text,
				sendError: t(
					"The earlier message may already have been accepted. Choose {action} before sending changed text or images.",
					{ action: `"${t("Start a new message request")}"` },
				),
			});
			return false;
		}
		// Images wait until the cloud is known to take them in a group chat: read the sidebar
		// now if it has not been read (it says so), and ask for another try if it cannot be.
		const session = this.store.get().sessions.find((item) => item.sessionId === sessionId);
		if (files.length && isGroupChat(session) && this.groupChatImages() === undefined) {
			const images = await this.#groupChatImagesNow();
			if (this.#stopped || viewSignal?.aborted) return false;
			// An edit while the cloud was asked is a new message: this send stops, the edit stays.
			const now = store.get();
			if (now.sending || now.draft !== text || !sameFiles(now.attachments ?? [])) return false;
			if (images === undefined) {
				store.set({ sendError: t("Could not check whether this group chat takes images. Try again.") });
				return false;
			}
		}
		let roomTarget: RoomMessageTarget | undefined;
		try {
			const observed = this.roomTargetFor(sessionId);
			roomTarget = sameRequest ? retry.roomTarget : observed;
			if (
				observed?.roomId !== roomTarget?.roomId ||
				observed?.environmentId !== roomTarget?.environmentId ||
				observed?.agentThread !== roomTarget?.agentThread
			)
				throw new Error(t("The conversation destination changed. Refresh before starting a new request."));
			if (roomTarget && !roomTarget.images && files.length)
				throw new Error(t("Images are not supported in team rooms. Use Company File."));
			// A room post carries text; the cloud refuses images alone.
			if (roomTarget && !trimmed) throw new Error(t("Add a message to send with the images."));
		} catch (error) {
			store.set({ sendError: describeError(error), draft: text });
			return false;
		}
		// An uncertain attempt retains its original sponsor even if discovery or
		// the current chooser has changed. SQL checks exact replay identity.
		const executionSponsor = sameRequest ? retry.executionSponsor : store.get().executionSponsor;
		if (!executionSponsor) {
			store.set({ sendError: t("Select an active model account before sending."), draft: text });
			return false;
		}
		const clientInputId = sameRequest ? retry.clientInputId : crypto.randomUUID();
		const clientRequestId = sameRequest ? retry.clientRequestId : clientInputId;
		// Another member may add to a shared draft while it is on its way; their words stay.
		this.roomDrafts.sending(sessionId);
		store.set((state) => ({
			sending: true,
			sendError: undefined,
			draft: text,
			optimistic: [
				...state.optimistic,
				{
					clientInputId,
					text: trimmed,
					...(quotes.length ? { quotes } : {}),
					attachmentCount: files.length,
					createdAt: new Date().toISOString(),
					authorUserId: this.#userId,
				},
			],
		}));
		try {
			const signal = AbortSignal.any([this.signal, ...(viewSignal ? [viewSignal] : [])]);
			const receipt = quotes.length
				? await this.#writeInput(
						sessionId,
						clientInputId,
						trimmed,
						signal,
						files,
						executionSponsor,
						roomTarget,
						quotes,
					)
				: roomTarget
					? await this.#writeInput(sessionId, clientInputId, trimmed, signal, files, executionSponsor, roomTarget)
					: await this.#writeInput(sessionId, clientInputId, trimmed, signal, files, executionSponsor);
			if (this.#stopped) return false;
			signal.throwIfAborted();
			store.set((state) => {
				const rest = this.roomDrafts.sent(sessionId, text, state.draft ?? "", true);
				return {
					sending: false,
					retrySend: undefined,
					answering: undefined,
					draft: rest,
					// The records go with the sent text; words another member added meanwhile keep theirs.
					quoteRecords: rest ? state.quoteRecords : undefined,
					...draftReplaced(state),
					attachments: sameFiles(state.attachments ?? []) ? [] : state.attachments,
					optimistic: reconcileOptimistic({
						...state,
						optimistic: state.optimistic.map((item) =>
							item.clientInputId === clientInputId ? { ...item, inputId: receipt.inputId } : item,
						),
					}),
				};
			});
			this.roomDrafts.settle(sessionId);
			this.#dismissFailureFor(sessionId);
			await this.loadConversation(sessionId);
			void this.refreshActivity();
			// The run is admitted a moment after the message; watch for it to appear.
			this.#watchWork(20_000);
			return true;
		} catch (error) {
			if (this.#stopped) return false;
			this.roomDrafts.sent(sessionId, text, "", false);
			store.set((state) => ({
				sending: false,
				sendError: describeError(error),
				retrySend: {
					clientInputId,
					clientRequestId,
					text: trimmed,
					...(quotes.length ? { quotes } : {}),
					files,
					executionSponsor,
					...(roomTarget ? { roomTarget } : {}),
				},
				optimistic: state.optimistic.filter((item) => item.clientInputId !== clientInputId),
			}));
			return false;
		}
	}

	/** Notes on their way, by conversation (`sendNote`). */
	readonly #notes = new Map<string, number>();

	/** Sends a note the member wrote and sent somewhere other than the conversation's own thread (a note from an app's
	 * page or from the Mailbox, app/tell-agent.ts; Generate icon in the apps drawer, `requestAppIcons`), as `sendPrompt`
	 * sends the thread's own message. A send goes only
	 * while the conversation is on screen (the app's input writer checks the route, app/application.ts); for a note
	 * the member's own press, on the bar that named the agent, stands for that, for as long as the note is on its way
	 * (`noteOnItsWay`). Every other check of a send holds. */
	async sendNote(sessionId: string, text: string): Promise<boolean> {
		this.#notes.set(sessionId, (this.#notes.get(sessionId) ?? 0) + 1);
		try {
			return await this.sendPrompt(sessionId, text);
		} finally {
			const left = (this.#notes.get(sessionId) ?? 1) - 1;
			if (left > 0) this.#notes.set(sessionId, left);
			else this.#notes.delete(sessionId);
		}
	}

	/** Whether a note to the conversation is on its way (`sendNote`). */
	noteOnItsWay(sessionId: string): boolean {
		return this.#notes.has(sessionId);
	}

	/** While an agent works, the member watches it happen: activity and the open
	 * conversation are re-read every couple of seconds, easing off after two
	 * minutes. The watch ends by itself a few seconds after the work does. */
	#watching: ReturnType<typeof setTimeout> | undefined;
	#watchUntil = 0;
	#watchSince = 0;
	#watchWork(forMs: number): void {
		if (this.#stopped) return;
		this.#watchUntil = Math.max(this.#watchUntil, Date.now() + forMs);
		if (this.#watching) return;
		if (!this.#watchSince) this.#watchSince = Date.now();
		const wait = Date.now() - this.#watchSince < 120_000 ? 2_000 : 5_000;
		this.#watching = setTimeout(() => {
			this.#watching = undefined;
			if (this.#stopped) return;
			if (Date.now() >= this.#watchUntil) {
				this.#watchSince = 0;
				return;
			}
			// Re-arm first: a refresh that still sees work extends the watch.
			this.#watchWork(0);
			if (this.#restsWhileHidden()) return;
			// With live hints, a change to the open conversation reads it in full and the agents'
			// activity (#onHint); the watch then reads only new events, which arrive faster than
			// the hints settle. Without them it reads everything, as the recovery path.
			if (this.store.get().realtime === "connected") {
				const open = this.#openSessionId;
				if (open && Date.now() - (this.#conversationReadAt.get(open)?.any ?? 0) >= WATCH_SKIP_MS)
					void this.loadConversation(open, { eventsOnly: true });
				// Activity also changes without a hint (a lease, a run that fails to start), and reading
				// it is what keeps the watch going while an agent works: on the hints' 3 s bound.
				this.#refreshActivitySoon();
				return;
			}
			if (this.#openSessionId) void this.loadConversation(this.#openSessionId);
			void this.refreshActivity();
		}, wait);
	}

	/** Hints about one change arrive together (a move, then another member's echo). */
	readonly #refreshSidebarSoon = debounce(() => void this.refreshSidebar(), 250);

	/** A room's new messages may name the member: the badges are read again, at most every few
	 * seconds while a room is busy. */
	readonly #refreshMentionsSoon = throttle(() => void this.refreshMentions(), 5_000);

	/** A change to the open conversation is read as a hint says (readOnHint). */
	readonly #refreshOpenConversation = readOnHint(() => {
		const open = this.#openSessionId;
		if (!open) return;
		const due = (this.#conversationReadAt.get(open)?.full ?? 0) + OPEN_FULL_MS - Date.now();
		void this.loadConversation(open, { eventsOnly: due > 0 });
		// Its waiting inputs and coding sessions are read within OPEN_FULL_MS of the hint, also
		// when no later hint comes; a full read meanwhile (a send, the clock) makes this one moot.
		if (due > 0 && !this.#openFullTimer)
			this.#openFullTimer = setTimeout(() => {
				this.#openFullTimer = undefined;
				if (this.#stopped || this.#openSessionId !== open) return;
				if (Date.now() - (this.#conversationReadAt.get(open)?.full ?? 0) >= OPEN_FULL_MS)
					void this.loadConversation(open);
			}, due);
	}, 400);

	/** Realtime is back after an error: what changed while hints could not arrive is read once. */
	#catchUp(): void {
		if (this.#stopped || this.store.get().loading) return;
		void this.#sessionsChanged();
		void this.refreshActivity();
		void this.refreshMentions();
		void this.refreshSidebar();
		this.memberChats.hinted();
		this.#atComputers.read();
		if (this.#openSessionId) void this.loadConversation(this.#openSessionId);
	}

	/** A burst of transcript events is at most one read an interval, plus the first at once where someone is looking
	 * (readOnHint). */
	readonly #sessionsChangedSoon = readOnHint(() => void this.#sessionsChanged(), 250);

	/** The agents' activity moves with their events: read at most every few seconds while they write. */
	readonly #refreshActivitySoon = throttle(() => void this.refreshActivity(), 3_000);

	#onHint(resource: RealtimeResource): void {
		if (this.#stopped) return;
		for (const listener of this.#invalidations) listener(resource);
		if (resource === "sessions") {
			// Every transcript event touches its conversation: read what changed, and the agents'
			// activity, which moves with it.
			this.#sessionsChangedSoon();
			this.#refreshActivitySoon();
		} else if (resource === "staff") {
			void this.refreshStaff();
			void this.refreshOrganization();
		} else if (resource === "access") {
			void this.refreshTeam();
		} else if (resource === "sidebar") {
			this.#refreshSidebarSoon();
		} else if (resource === "member-chats") {
			this.memberChats.hinted();
		} else if (resource === "machines") {
			// An agent may have begun a stretch at its computer (20260930742000).
			this.#atComputers.hinted();
		} else if (resource === "company-file") {
			void this.refreshGroups();
			// Accepting a proposal moves the Company File head: runs waiting on one are read again.
			const waiting = Object.values(this.store.get().recoveries).filter((recovery) => recovery.proposalId);
			for (const recovery of waiting) this.#recheckRecovery(recovery.runId);
			if (waiting.length) void this.refreshActivity();
		}
	}

	async #tick(): Promise<void> {
		if (this.#stopped || this.#polling || this.#restsWhileHidden()) return;
		this.#polling = true;
		try {
			// Polling is the recovery path when Realtime is degraded; a light
			// heartbeat otherwise keeps activity and the open transcript honest.
			if (this.store.get().realtime !== "connected") {
				await this.refreshTeam();
				await Promise.all([this.refreshSessions(), this.refreshStaff(), this.refreshOrganization()]);
				if (!this.#stopped)
					for (const listener of this.#invalidations) {
						listener("sessions");
					}
				// The `machines` hint comes by push only: without it, an agent's new stretch at its computer is read here.
				if (!this.#stopped && this.store.get().team?.capabilities.read) this.#atComputers.read();
			} else if (Date.now() - this.#sessionsReadAt > SESSIONS_FULL_MS)
				await (this.#sessionsFullRead ?? this.refreshSessions());
			// Proposal comments/rejections do not all touch the Company File head.
			// Refresh this surface even with a healthy Realtime channel.
			if (!this.#stopped) for (const listener of this.#invalidations) listener("company-file");
			if (this.#openSessionId) await this.loadConversation(this.#openSessionId);
			await Promise.all([
				this.refreshActivity(),
				this.refreshSidebar(),
				this.refreshMentions(),
				this.refreshHoursWait(),
				// The member chats and the open one, whole: what a missed hint would have brought.
				this.memberChats.poll(),
			]);
		} finally {
			this.#polling = false;
		}
	}
}

/** How long the drawer shows an app drawing new icons at most, and how often their folder is read meanwhile. */
const APP_ICONS_DRAWING_MS = 10 * 60_000;
const APP_ICONS_WATCH_MS = 10_000;

/** An icon by its id and the version of its file: the same id drawn again is a new version. */
const iconVersion = (icon: CompanyAppIcon) => `${icon.id}@${icon.seq}`;

function withoutKey<T>(record: Readonly<Record<string, T>> | undefined, key: string): Record<string, T> {
	const { [key]: _gone, ...rest } = record ?? {};
	return rest;
}
