import type { NativeExecutionConnections } from "@qorpera/cloud-client/cloud-native-subscription-control";
import type { CloudApi } from "../cloud/api.ts";
import { CloudRpcError, describeError } from "../cloud/client.ts";
import { type CodingSession, type CodingSessionRead, compareCodingSessions } from "../cloud/coding-session.ts";
import {
	type EmailDraftAction,
	EmailDraftClient,
	type EmailDraftContent,
	type EmailDraftEditor,
	type EmailDraftState,
} from "../cloud/email-drafts.ts";
import { type GroupChatDetails, listGroupChatDetails, readGroupChatDetails } from "../cloud/group-details.ts";
import type { InteractionAnswer, InteractionOutcome, InteractionRequest } from "../cloud/interactions.ts";
import { buildCompanyHierarchy, type CompanyHierarchy, type HostedCompanyOrganization } from "../cloud/organization.ts";
import type { PageCursor } from "../cloud/pagination.ts";
import { UUID_PATTERN } from "../cloud/parse.ts";
import type { CloudPresenceHandle, PresenceMember } from "../cloud/presence.ts";
import {
	type RealtimePhase,
	type RealtimeResource,
	type RealtimeSubscription,
	subscribeProfileRealtime,
	subscribeSidebarRealtime,
} from "../cloud/realtime.ts";
import type { ActionReviewAnswer } from "../cloud/review-rules.ts";
import { sessionAttachmentProblem } from "../cloud/session-attachments.ts";
import {
	type RoomMessageTarget,
	type SessionExecutionSponsor,
	type SessionInputWriter,
	selectSessionExecutionSponsor,
} from "../cloud/session-input.ts";
import { applySidebarRequest, type CompanySidebar, type SidebarRequest } from "../cloud/sidebar.ts";
import { projectTranscript, type TranscriptProjection } from "../cloud/transcript.ts";
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
import { attachmentProblemText } from "../ui/attachments.ts";
import { isGroupChat } from "../ui/group-chat.ts";
import type { MentionTarget } from "../ui/mentions.ts";
import { t } from "../ui/preferences.ts";
import { RoomDrafts } from "./room-drafts.ts";
import { debounce, Store, throttle } from "./state.ts";

/* One controller per open company. It holds the canonical projections the
 * views render (team, staff, sessions, organization, activity) and re-reads
 * them on Realtime hints. Nothing here executes work or owns a wake. */

export type Deployment = "loading" | "ready" | "not-deployed" | "not-seeded" | "error";

/** What a member sees of an agent's execution: see CompanyController.agentState. */
export type AgentState = "idle" | "working" | "writing" | "decision" | "failed";

/** A run the server holds against the agent until someone dismisses it. */
export interface FailedRun {
	activity: HostedStaffExecutionActivity;
	/** Its details, once read. */
	recovery?: HostedRunRecovery;
}

const isFailedRun = (row: HostedStaffExecutionActivity) =>
	row.activity === "needs_attention" && (row.jobStatus === "failed" || row.jobStatus === "cancelled");

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

/** Why the cloud would not take a card's answer, in the member's words. */
function answerRefusal(error: unknown): string {
	const message = error instanceof Error ? error.message : "";
	// In an agent's thread an answer runs the agent on the member's own model account.
	if (/sponsor|model account/i.test(message)) return t("Select an active model account, then try again.");
	if (/paused/i.test(message)) return t("Agents are paused for a moment while Qorpera updates. Try again shortly.");
	return describeError(error);
}

export interface CompanyState {
	profile: HostedProfile;
	team?: HostedProfileTeam;
	staff: HostedStaffAgent[];
	sessions: HostedSession[];
	sessionsError?: string;
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
	/** The rail's sections (the company's) and pins and hidden agents (this member's). */
	sidebar?: CompanySidebar;
	/** The deployed cloud has no sidebar yet: the rail shows no sections, pins or hiding. */
	sidebarUnavailable?: boolean;
	/** A rail action (a sidebar change, a rename, a delete) that did not happen, in the member's words. */
	railError?: string;
	realtime: RealtimePhase;
	realtimeError?: string;
	/** Mentions of this member not seen yet, by conversation (session id → count). */
	mentions?: Readonly<Record<string, number>>;
	/** The cloud does not read mentions yet: no mention picker, no badges. */
	mentionsUnavailable?: boolean;
	/** The cloud answered a mentions read: it reads mentions, so names are offered. */
	mentionsReady?: boolean;
	/** The other members' open browser tabs and the conversation each shows (presence). */
	here?: readonly PresenceMember[];
	/** The company is out of computer hours: new work waits until hours are added (the zero rule). */
	waitingForHours?: boolean;
	/** The deployed cloud cannot say yet whether the company waits for computer hours. */
	hoursWaitUnavailable?: boolean;
	loading: boolean;
	error?: string;
	accessLost?: boolean;
}

export interface ConversationState {
	sessionId: string;
	events: HostedSessionEvent[];
	pending: PendingSessionInput[];
	projection: TranscriptProjection;
	loading: boolean;
	complete: boolean;
	error?: string;
	sending: boolean;
	sendError?: string;
	draft?: string;
	/** Local selected bytes, staged only after an explicit send. */
	attachments?: File[];
	executionSponsor?: SessionExecutionSponsor;
	retrySend?: {
		clientInputId: string;
		clientRequestId: string;
		text: string;
		files: File[];
		executionSponsor: SessionExecutionSponsor;
		roomTarget?: RoomMessageTarget;
	};
	/** The coding sessions the agent dispatched from this conversation (Order 9),
	 * oldest first; absent until the first listing, empty when the cloud has none
	 * or does not carry coding sessions yet. */
	codingSessions?: CodingSession[];
	/** Inputs this browser appended that the cloud has not listed back yet. */
	optimistic: {
		clientInputId: string;
		inputId?: string;
		text: string;
		attachmentCount?: number;
		createdAt: string;
		authorUserId: string;
	}[];
	/** Card answers this browser sent that the cloud has not listed back yet, by interaction id. */
	interactionAnswers?: Record<string, InteractionAnswer>;
	/** What went wrong with the last card answer, in the member's words. */
	interactionError?: string;
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
	readonly #emailDraftEditors = new Map<string, EmailDraftEditor>();
	readonly #userId: string;
	readonly #writeInput: SessionInputWriter;
	#realtime: RealtimeSubscription | undefined;
	#sidebarRealtime: RealtimeSubscription | undefined;
	/** Sidebar changes sent and not yet answered; each answer carries the whole sidebar. */
	#sidebarPending = 0;
	/** What a send's own read found about group chat images, before the sidebar had said. */
	#groupChatImagesRead: boolean | undefined;
	/** The group chats of the last sessions list, kept until the list is replaced. */
	#groupRooms: { sessions: HostedSession[]; rooms: Map<string, HostedSession> } | undefined;
	#sidebarWrites: Promise<unknown> = Promise.resolve();
	#poll: ReturnType<typeof setInterval> | undefined;
	#openSessionId: string | undefined;
	#stopped = false;
	readonly #abort = new AbortController();
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
	/** Per failed run: when its details may be read next (performance.now()), and
	 * the latest request, so an older answer never replaces a newer one. */
	readonly #recoveryReads = new Map<string, { due: number; request: number }>();
	/** The details RPC is not deployed on this cloud. */
	#recoveriesMissing = false;
	/** Members' unsent messages in the conversations they share (20260928000500). */
	readonly roomDrafts: RoomDrafts;
	#mentionReads = 0;
	#hoursWaitReads = 0;
	/** This tab on the company's presence channel, once another member could be here. */
	#presence: CloudPresenceHandle | undefined;
	/** The conversation this tab says it shows: the open one while the tab is visible. */
	#tracked: string | null = null;

	constructor(api: CloudApi, profile: HostedProfile, userId: string, writeInput?: SessionInputWriter) {
		this.#api = api;
		this.#userId = userId;
		this.roomDrafts = new RoomDrafts(api, userId, this.#abort.signal, {
			sharedRoom: (sessionId) => this.#sharedDraftRoom(sessionId),
			draft: (sessionId) => this.conversation(sessionId).get().draft ?? "",
			setDraft: (sessionId, text) => this.conversation(sessionId).set({ draft: text }),
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
		this.#realtime = subscribeProfileRealtime(
			this.#api.cloud,
			this.profile.profileId,
			(resource) => this.#onHint(resource),
			(phase, error) => {
				if (!this.#stopped) this.store.set({ realtime: phase, realtimeError: error });
			},
		);
		await this.refreshAll();
		if (!this.#stopped) this.#poll = setInterval(() => void this.#tick(), 30_000);
		if (!this.#stopped && typeof document !== "undefined")
			document.addEventListener("visibilitychange", () => this.#seeMentions(), { signal: this.signal });
	}

	stop(): void {
		if (this.#stopped) return;
		this.#stopped = true;
		this.#abort.abort();
		this.#emailDraftEditors.clear();
		for (const store of this.conversations.values())
			store.set({ draft: "", attachments: [], retrySend: undefined, executionSponsor: undefined });
		this.#realtime?.stop();
		this.#sidebarRealtime?.stop();
		void this.#presence?.stop().catch(() => {});
		this.#presence = undefined;
		if (this.#poll) clearInterval(this.#poll);
		clearTimeout(this.#watching);
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
			this.store.set({ team, accessLost: false });
			this.#joinPresence();
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
					store.set({
						events: [],
						pending: [],
						optimistic: [],
						draft: "",
						attachments: [],
						projection: { items: [], hiddenCount: 0, lastSequence: 0 },
					});
				this.stop();
			} else this.store.set({ error: describeError(error) });
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
			this.store.set({ error: describeError(error) });
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
				this.store.set({ sessions, sessionsError: undefined });
				if (!this.store.get().loading) await this.refreshGroups();
			} catch (error) {
				if (this.#stopped || version !== this.#versions.sessions) return;
				this.store.set({ sessionsError: describeError(error) });
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
		try {
			const read = await this.#api.listSessions(
				this.profile.environmentId,
				this.signal,
				Number.isFinite(since) ? { time: new Date(since).toISOString(), id: NO_ID } : undefined,
			);
			if (this.#stopped) return [];
			// A whole read that landed meanwhile is newer than what this one saw of its own window.
			if (this.#sessionsFullRead) return undefined;
			const known = new Map(this.store.get().sessions.map((session) => [session.sessionId, session]));
			const changed = read.filter((session) => known.get(session.sessionId)?.updatedAt !== session.updatedAt);
			this.#sessionsCursor = newestSession(read, this.#sessionsCursor);
			if (changed.length)
				this.store.set((state) => ({ sessions: mergeSessions(state.sessions, changed), sessionsError: undefined }));
			// A room's conversation changed (or appeared): its details are read again, as a whole read does.
			if (
				!this.store.get().loading &&
				changed.some((session) => !session.staffAgentId && typeof session.executionScope?.roomId === "string")
			)
				await this.refreshGroups();
			return changed;
		} catch (error) {
			if (!this.#stopped) this.store.set({ sessionsError: describeError(error) });
			return [];
		}
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
			} else {
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
			// Its own channel: a cloud without the sidebar tables must not degrade the company's hints.
			this.#sidebarRealtime ??= subscribeSidebarRealtime(this.#api.cloud, this.profile.profileId, () =>
				this.#onHint("sidebar"),
			);
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
		this.store.set({
			sidebar: applySidebarRequest(current.sidebar, request, this.sidebarRoster()),
			railError: undefined,
		});
		this.#sidebarPending++;
		const write = this.#sidebarWrites.then(() => this.#api.manageCompanySidebar(this.profile.profileId, request));
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

	staffById(id: string | undefined): HostedStaffAgent | undefined {
		return id ? this.store.get().staff.find((agent) => agent.id === id) : undefined;
	}

	memberName(userId: string | undefined): string {
		if (!userId) return t("Member");
		if (userId === this.#userId) return t("You");
		return this.store.get().team?.members.find((member) => member.userId === userId)?.displayName ?? t("Member");
	}

	/** The agent's newest run as the server reports it, settled or not. */
	#newestActivity(staffAgentId: string | undefined): HostedStaffExecutionActivity | undefined {
		if (!staffAgentId) return undefined;
		return this.store
			.get()
			.activity.filter((item) => item.staffAgentId === staffAgentId)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
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
	 * above newer work, so "failed" stands until the member dismisses it. A run a
	 * member stopped (every cancelled job is one) is never "failed": the server
	 * lists it only while its proposal waits, below all of the agent's work. */
	agentState(staffAgentId: string | undefined): AgentState {
		const row = this.activityFor(staffAgentId);
		if (!row) return "idle";
		if (row.activity !== "needs_attention")
			return row.jobStatus === "leased" && row.phase === "writing" ? "writing" : "working";
		if (!isFailedRun(row)) return "decision";
		return row.jobStatus === "cancelled" || this.store.get().recoveries[row.runId]?.proposalId
			? "decision"
			: "failed";
	}

	failedRunFor(staffAgentId: string | undefined): FailedRun | undefined {
		const row = this.activityFor(staffAgentId);
		if (!row || !isFailedRun(row)) return undefined;
		const recovery = this.store.get().recoveries[row.runId];
		// A stopped run's line only ever asks for its decision, so it waits for the details that name it.
		if (row.jobStatus === "cancelled" && !recovery?.proposalId) return undefined;
		return recovery ? { activity: row, recovery } : { activity: row };
	}

	/** Whether Try again can be offered for this run. A session turn is re-queued by the
	 * recovery RPC; a post into a room needs qorpera_retry_room_delivery (20260920080000).
	 * Routine and agent wakes, and proposal reviews, are not the member's to repeat, and
	 * neither is a run a member stopped: to repeat the message, they send it again. */
	canRetryFailedRun(failed: FailedRun): boolean {
		const state = this.store.get();
		if (!state.team?.capabilities.write || state.accessLost || failed.recovery?.proposalId) return false;
		if (failed.activity.jobStatus === "cancelled") return false;
		if ((failed.recovery?.unsettledOperations ?? 0) > 0) return false;
		if (failed.activity.sourceKind === "session_turn") return true;
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
		const row = this.#newestActivity(session?.staffAgentId);
		const recovery = row && isFailedRun(row) ? state.recoveries[row.runId] : undefined;
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
		const { organization, organizationState, team, sessions } = this.store.get();
		if (organizationState === "not-deployed") {
			return {
				reason: t(
					"The organization kernel (Order 0) is not deployed on this cloud yet, so there is no Co-Founder home here.",
				),
			};
		}
		if (!organization)
			return {
				reason: t("This company has no Co-Founder yet. The cloud seeds one when Order 0 bootstraps the company."),
			};
		if (organization.cofounder.memberSessionId) return { sessionId: organization.cofounder.memberSessionId };
		const thread = sessions.find(
			(session) => session.staffAgentId === organization.cofounder.staffAgentId && isAgentThreadSession(session),
		);
		if (thread) return { sessionId: thread.sessionId };
		if (!team?.capabilities.read) return { reason: t("This company is not readable.") };
		try {
			const handle = await this.#api.agentThread(this.profile.environmentId, organization.cofounder.staffAgentId);
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

	/** The other members who have this conversation open now, one entry per member. */
	presentIn(sessionId: string): { userId: string; name: string }[] {
		const state = this.store.get();
		const seen = new Map<string, { userId: string; name: string }>();
		for (const member of state.here ?? [])
			if (member.staffAgentId === sessionId && member.userId !== this.#userId && !seen.has(member.userId))
				seen.set(member.userId, {
					userId: member.userId,
					name: state.team?.members.find((item) => item.userId === member.userId)?.displayName ?? member.name,
				});
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
		this.#trackOpen();
	}

	/** Say which conversation this tab shows: none while the tab is hidden. */
	#trackOpen(): void {
		if (!this.#presence || this.#stopped) return;
		const visible = typeof document === "undefined" || document.visibilityState !== "hidden";
		const open = visible ? (this.#openSessionId ?? null) : null;
		if (open === this.#tracked) return;
		this.#tracked = open;
		this.#presence.setOpenThread(open);
	}

	/** Reads a conversation's new events, its waiting inputs and its coding sessions; with
	 * `eventsOnly`, only its new events (a thread that has read its history before). */
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
			const sequences = new Set(events.map((event) => event.sequence));
			// A failed read ends the others at their next page.
			let failed = false;
			// The history after what the thread has, page by page, oldest first.
			const readEvents = async (): Promise<boolean> => {
				let after = known.projection.lastSequence;
				for (;;) {
					const page = await this.#api.readSessionEvents(sessionId, after, EVENT_PAGE);
					if (this.#stopped || failed) return false;
					for (const event of page)
						if (!sequences.has(event.sequence)) {
							sequences.add(event.sequence);
							events.push(event);
						}
					if (page.length < EVENT_PAGE) return true;
					const next = page[page.length - 1]?.sequence ?? after;
					if (next <= after) throw new Error(t("The transcript cursor did not advance."));
					after = next;
				}
			};
			// Every input still waiting, all pages.
			const readPending = async (): Promise<PendingSessionInput[] | undefined> => {
				const pending: PendingSessionInput[] = [];
				let position = 0;
				for (;;) {
					const page = await this.#api.listSessionInputs(sessionId, position, 100);
					if (this.#stopped || failed) return undefined;
					pending.push(...page.items);
					if (!page.hasMore) return pending;
					if (page.nextAfterPosition <= position || !page.items.length)
						throw new Error(t("The input cursor did not advance."));
					position = page.nextAfterPosition;
				}
			};
			try {
				// The history, the waiting inputs and the coding sessions do not depend on one
				// another: they are read side by side, and the thread draws once, when all landed.
				const [complete, read, listed] = await Promise.all([
					readEvents(),
					// New events only: the waiting inputs and coding sessions stay as last read.
					full ? readPending() : Promise.resolve(undefined),
					// The listing is optional: a cloud without Order 9 answers with a missing
					// RPC, and a refused or failed listing keeps what the thread already shows.
					full ? this.#api.listCodingSessions(sessionId).catch(() => undefined) : Promise.resolve(undefined),
				]);
				const pending = full ? read : store.get().pending;
				if (this.#stopped || !complete || !pending) return;
				const optimistic = reconcileOptimistic({ optimistic: store.get().optimistic, pending, events });
				const projection = projectTranscript(events, pending);
				const codingSessions = listed
					? newerCodingSessions(listed, store.get().codingSessions)
					: (store.get().codingSessions ?? []);
				const now = Date.now();
				this.#conversationReadAt.set(sessionId, {
					any: now,
					full: full ? now : (this.#conversationReadAt.get(sessionId)?.full ?? 0),
				});
				store.set({
					events,
					pending,
					projection,
					loading: false,
					complete: true,
					error: undefined,
					optimistic,
					interactionAnswers: reconcileInteractionAnswers(store.get().interactionAnswers, projection, pending),
					codingSessions,
				});
			} catch (error) {
				failed = true;
				// The history read before the failure stays, so the next read resumes after it.
				const read =
					!this.#stopped && events.length > known.events.length
						? {
								events: [...events],
								projection: projectTranscript(events, store.get().pending),
								optimistic: reconcileOptimistic({
									optimistic: store.get().optimistic,
									pending: store.get().pending,
									events,
								}),
							}
						: {};
				store.set({ ...read, loading: false, complete: false, error: describeError(error) });
				return;
			}
		} while (request.repeat && !this.#stopped);
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
		// The answer wakes the agent, as a message does; watch for its run.
		void this.refreshActivity();
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
		this.#watchWork(20_000);
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
	 * same connector and name is replaced (a new version), never duplicated. */
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
		const role = this.store.get().team?.role;
		const company = role === "owner" || role === "admin";
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
			await this.#api.captureSecret(ticket, value);
		} catch (error) {
			store.set({ interactionError: describeError(error) });
			throw error;
		}
		await this.answerInteraction(sessionId, interactionId, "provided", {});
	}

	async sendPrompt(sessionId: string, text: string, viewSignal?: AbortSignal): Promise<boolean> {
		if (this.#stopped || viewSignal?.aborted) return false;
		try {
			this.assertCanSend(sessionId);
		} catch {
			return false;
		}
		const store = this.conversation(sessionId);
		const trimmed = text.trim();
		const files = [...(store.get().attachments ?? [])];
		if ((!trimmed && !files.length) || store.get().sending) return false;
		const problem = sessionAttachmentProblem(files);
		if (problem) {
			store.set({ sendError: attachmentProblemText(problem) });
			return false;
		}
		const retry = store.get().retrySend;
		const sameFiles = (other: readonly File[]) =>
			other.length === files.length && other.every((file, index) => file === files[index]);
		const sameRequest = retry?.text === trimmed && sameFiles(retry.files);
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
					attachmentCount: files.length,
					createdAt: new Date().toISOString(),
					authorUserId: this.#userId,
				},
			],
		}));
		try {
			const signal = AbortSignal.any([this.signal, ...(viewSignal ? [viewSignal] : [])]);
			const receipt = roomTarget
				? await this.#writeInput(sessionId, clientInputId, trimmed, signal, files, executionSponsor, roomTarget)
				: await this.#writeInput(sessionId, clientInputId, trimmed, signal, files, executionSponsor);
			if (this.#stopped) return false;
			signal.throwIfAborted();
			store.set((state) => ({
				sending: false,
				retrySend: undefined,
				draft: this.roomDrafts.sent(sessionId, text, state.draft ?? "", true),
				attachments: sameFiles(state.attachments ?? []) ? [] : state.attachments,
				optimistic: reconcileOptimistic({
					...state,
					optimistic: state.optimistic.map((item) =>
						item.clientInputId === clientInputId ? { ...item, inputId: receipt.inputId } : item,
					),
				}),
			}));
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
					files,
					executionSponsor,
					...(roomTarget ? { roomTarget } : {}),
				},
				optimistic: state.optimistic.filter((item) => item.clientInputId !== clientInputId),
			}));
			return false;
		}
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
			// With live hints, a change to the open conversation reads it in full and the agents'
			// activity (#onHint); the watch then reads only new events, which arrive faster than
			// the hints settle. Without them it reads everything, as the recovery path.
			if (this.store.get().realtime === "connected") {
				const open = this.#openSessionId;
				if (open && Date.now() - (this.#conversationReadAt.get(open)?.any ?? 0) >= WATCH_SKIP_MS)
					void this.loadConversation(open, { eventsOnly: true });
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

	readonly #refreshOpenConversation = debounce(() => {
		const open = this.#openSessionId;
		if (!open) return;
		const full = Date.now() - (this.#conversationReadAt.get(open)?.full ?? 0) >= OPEN_FULL_MS;
		void this.loadConversation(open, { eventsOnly: !full });
	}, 400);

	/** A burst of transcript events is one hint's worth of reads. */
	readonly #sessionsChangedSoon = debounce(() => void this.#sessionsChanged(), 250);

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
		} else if (resource === "company-file") {
			void this.refreshGroups();
			// Accepting a proposal moves the Company File head: runs waiting on one are read again.
			const waiting = Object.values(this.store.get().recoveries).filter((recovery) => recovery.proposalId);
			for (const recovery of waiting) this.#recheckRecovery(recovery.runId);
			if (waiting.length) void this.refreshActivity();
		}
	}

	async #tick(): Promise<void> {
		if (this.#stopped || this.#polling) return;
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
			} else if (Date.now() - this.#sessionsReadAt > SESSIONS_FULL_MS) await this.refreshSessions();
			// Proposal comments/rejections do not all touch the Company File head.
			// Refresh this surface even with a healthy Realtime channel.
			if (!this.#stopped) for (const listener of this.#invalidations) listener("company-file");
			if (this.#openSessionId) await this.loadConversation(this.#openSessionId);
			await Promise.all([
				this.refreshActivity(),
				this.refreshSidebar(),
				this.refreshMentions(),
				this.refreshHoursWait(),
			]);
		} finally {
			this.#polling = false;
		}
	}
}
