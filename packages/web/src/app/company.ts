import type { NativeExecutionConnections } from "@qorpera/cloud-client/cloud-native-subscription-control";
import type { CloudApi } from "../cloud/api.ts";
import { CloudRpcError, describeError } from "../cloud/client.ts";
import type { CodingSession, CodingSessionRead } from "../cloud/coding-session.ts";
import { type GroupChatDetails, listGroupChatDetails, readGroupChatDetails } from "../cloud/group-details.ts";
import type { InteractionAnswer, InteractionOutcome, InteractionRequest } from "../cloud/interactions.ts";
import { buildCompanyHierarchy, type CompanyHierarchy, type HostedCompanyOrganization } from "../cloud/organization.ts";
import { UUID_PATTERN } from "../cloud/parse.ts";
import {
	type RealtimePhase,
	type RealtimeResource,
	type RealtimeSubscription,
	subscribeProfileRealtime,
} from "../cloud/realtime.ts";
import { sessionAttachmentIssue } from "../cloud/session-attachments.ts";
import {
	type RoomMessageTarget,
	type SessionExecutionSponsor,
	type SessionInputWriter,
	selectSessionExecutionSponsor,
} from "../cloud/session-input.ts";
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
import { debounce, Store } from "./state.ts";

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

/** Why the cloud would not try a run again, in the member's words. */
function retryRefusal(error: unknown): string {
	const message = error instanceof Error ? error.message : "";
	if (/author of the post/i.test(message)) return "Only the person who wrote the message can try it again.";
	if (/sponsor|model account/i.test(message)) return "Select an active model account, then try again.";
	if (/paused/i.test(message)) return "The company is paused. Resume it, then try again.";
	if (/already resolved/i.test(message)) return "This run was already handled.";
	if (/already answered|durable operation|open proposal/i.test(message))
		return "This run already did part of its work, so it cannot be repeated. Send the message again instead.";
	return "It could not be tried again. Send the message again instead.";
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
	realtime: RealtimePhase;
	realtimeError?: string;
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

/** Drop optimistic card answers once the projection carries them. */
function reconcileInteractionAnswers(
	answers: Record<string, InteractionAnswer> | undefined,
	projection: TranscriptProjection,
): Record<string, InteractionAnswer> | undefined {
	if (!answers) return undefined;
	const settled = new Set(
		projection.items.flatMap((item) => (item.kind === "interaction" && item.answer ? [item.id.toLowerCase()] : [])),
	);
	const kept = Object.fromEntries(Object.entries(answers).filter(([id]) => !settled.has(id)));
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

const EVENT_PAGE = 500;

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
	readonly #userId: string;
	readonly #writeInput: SessionInputWriter;
	#realtime: RealtimeSubscription | undefined;
	#poll: ReturnType<typeof setInterval> | undefined;
	#openSessionId: string | undefined;
	#stopped = false;
	readonly #abort = new AbortController();
	readonly #versions = { team: 0, staff: 0, sessions: 0, groups: 0, organization: 0, activity: 0 };
	#polling = false;
	readonly #invalidations = new Set<(resource: RealtimeResource) => void>();
	readonly #conversationLoads = new Map<string, { promise: Promise<void>; repeat: boolean }>();
	/** Per failed run: when its details may be read next (performance.now()), and
	 * the latest request, so an older answer never replaces a newer one. */
	readonly #recoveryReads = new Map<string, { due: number; request: number }>();
	/** The details RPC is not deployed on this cloud. */
	#recoveriesMissing = false;

	constructor(api: CloudApi, profile: HostedProfile, userId: string, writeInput?: SessionInputWriter) {
		this.#api = api;
		this.#userId = userId;
		this.#writeInput =
			writeInput ??
			(async () => {
				throw new Error("Sponsored message transport is unavailable.");
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
	}

	stop(): void {
		if (this.#stopped) return;
		this.#stopped = true;
		this.#abort.abort();
		for (const store of this.conversations.values())
			store.set({ draft: "", attachments: [], retrySend: undefined, executionSponsor: undefined });
		this.#realtime?.stop();
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
		]);
		await this.refreshGroups();
		this.store.set({ loading: false });
	}

	async refreshTeam(): Promise<void> {
		if (this.#stopped) return;
		const version = ++this.#versions.team;
		try {
			const team = await this.#api.getTeam(this.profile.profileId);
			if (this.#stopped || version !== this.#versions.team) return;
			this.store.set({ team, accessLost: false });
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

	async refreshSessions(): Promise<void> {
		if (this.#stopped) return;
		const version = ++this.#versions.sessions;
		try {
			const sessions = await this.#api.listSessions(this.profile.environmentId, this.signal);
			if (this.#stopped || version !== this.#versions.sessions) return;
			this.store.set({ sessions, sessionsError: undefined });
			if (!this.store.get().loading) await this.refreshGroups();
		} catch (error) {
			if (this.#stopped || version !== this.#versions.sessions) return;
			this.store.set({ sessionsError: describeError(error) });
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

	async refreshActivity(): Promise<void> {
		if (this.#stopped) return;
		const version = ++this.#versions.activity;
		try {
			const activity = await this.#api.listStaffActivity(this.profile.environmentId);
			if (this.#stopped || version !== this.#versions.activity) return;
			this.store.set((state) => ({ activity, recoveries: stillFailed(state.recoveries, activity) }));
			if (activity.some((item) => item.activity !== "needs_attention")) this.#watchWork(6_000);
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
		if (!changed.length) return;
		this.store.set((state) => {
			const recoveries = { ...state.recoveries };
			for (const recovery of changed) recoveries[recovery.runId] = recovery;
			return { recoveries: stillFailed(recoveries, state.activity) };
		});
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
				throw new Error("This group chat is no longer available.");
			return session;
		};
		const session = current();
		const details = await readGroupChatDetails(this.#api.cloud, session, signal);
		if (current().executionScope?.roomId !== session.executionScope?.roomId)
			throw new Error("This group chat has changed. Open its details again.");
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
		if (!userId) return "Member";
		if (userId === this.#userId) return "You";
		return this.store.get().team?.members.find((member) => member.userId === userId)?.displayName ?? "Member";
	}

	activityFor(staffAgentId: string | undefined): HostedStaffExecutionActivity | undefined {
		if (!staffAgentId) return undefined;
		const state = this.store.get();
		const row = state.activity
			.filter((item) => item.staffAgentId === staffAgentId)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
		// A dismissed failure is settled for this member even before the cloud's next
		// activity read; the agent reads as idle until newer work is reported. An open
		// proposal is a decision, not a failure, and stays until it is decided.
		return row && isFailedRun(row) && state.acknowledgedRuns?.[row.runId] && !state.recoveries[row.runId]?.proposalId
			? undefined
			: row;
	}

	/** What the member sees of an agent's execution. A queued run is already the
	 * agent's work from the member's side of the screen. needs_attention is either
	 * a decision (a run's Company File proposal is open) or a run that did not
	 * finish. The server reports one run per agent and ranks an undismissed failure
	 * above newer work, so "failed" stands until the member dismisses it. */
	agentState(staffAgentId: string | undefined): AgentState {
		const row = this.activityFor(staffAgentId);
		if (!row) return "idle";
		if (row.activity !== "needs_attention")
			return row.jobStatus === "leased" && row.phase === "writing" ? "writing" : "working";
		if (!isFailedRun(row)) return "decision";
		return this.store.get().recoveries[row.runId]?.proposalId ? "decision" : "failed";
	}

	failedRunFor(staffAgentId: string | undefined): FailedRun | undefined {
		const row = this.activityFor(staffAgentId);
		if (!row || !isFailedRun(row)) return undefined;
		const recovery = this.store.get().recoveries[row.runId];
		return recovery ? { activity: row, recovery } : { activity: row };
	}

	/** Whether Try again can be offered for this run. A session turn is re-queued by the
	 * recovery RPC; a post into a room needs qorpera_retry_room_delivery (20260920080000).
	 * Routine and agent wakes, and proposal reviews, are not the member's to repeat. */
	canRetryFailedRun(failed: FailedRun): boolean {
		const state = this.store.get();
		if (!state.team?.capabilities.write || state.accessLost || failed.recovery?.proposalId) return false;
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
				if (!sponsor) throw new Error("Select an active model account, then try again.");
				await this.#api.retryRoomDelivery(runId, sponsor.sponsorBindingId, sponsor.sponsorVersion);
			}
			mark(undefined);
		} catch (error) {
			if (this.#stopped) return;
			if (error instanceof CloudRpcError && error.missing) {
				// The web is ahead of the deployed cloud. Say so once and stop offering it.
				mark({ pending: false, error: "Trying again is not available yet. Send the message again instead." });
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
		const session = this.store.get().sessions.find((item) => item.sessionId === sessionId);
		const failed = this.failedRunFor(session?.staffAgentId);
		// Only a failure whose details are known and that left no decision behind; a
		// run with an open proposal is the member's to decide, not to dismiss by sending.
		if (failed?.recovery && failed.activity.sourceKind !== "proposal_review" && !failed.recovery.proposalId)
			// sendPrompt reads activity again right after; no second read here.
			void this.dismissFailedRun(failed.activity.runId, { refresh: false }).catch(() => undefined);
	}

	primarySessionFor(staffAgentId: string): HostedSession | undefined {
		const sessions = this.store.get().sessions.filter((session) => session.staffAgentId === staffAgentId);
		return sessions.find(isAgentThreadSession) ?? sessions.find(isPrimaryStaffSession);
	}

	/** The agent's shared thread (2026-09-17 amendment): one conversation every
	 * member sees, bound to the agent's room by the kernel. */
	async openStaffConversation(agent: HostedStaffAgent): Promise<string> {
		if (this.#stopped) throw new Error("This company is no longer open.");
		const existing = this.primarySessionFor(agent.id);
		if (existing) return existing.sessionId;
		const thread = await this.#api.agentThread(this.profile.environmentId, agent.id);
		await this.refreshSessions();
		return thread.sessionId;
	}

	/** The Co-Founder's shared thread; there is no member-private conversation. */
	async openCofounderConversation(): Promise<{ sessionId?: string; reason?: string }> {
		if (this.#stopped) return { reason: "This company is no longer open." };
		const { organization, organizationState, team, sessions } = this.store.get();
		if (organizationState === "not-deployed") {
			return {
				reason:
					"The organization kernel (Order 0) is not deployed on this cloud yet, so there is no Co-Founder home here.",
			};
		}
		if (!organization)
			return {
				reason: "This company has no Co-Founder yet. The cloud seeds one when Order 0 bootstraps the company.",
			};
		if (organization.cofounder.memberSessionId) return { sessionId: organization.cofounder.memberSessionId };
		const thread = sessions.find(
			(session) => session.staffAgentId === organization.cofounder.staffAgentId && isAgentThreadSession(session),
		);
		if (thread) return { sessionId: thread.sessionId };
		if (!team?.capabilities.read) return { reason: "This company is not readable." };
		try {
			const handle = await this.#api.agentThread(this.profile.environmentId, organization.cofounder.staffAgentId);
			await this.refreshSessions();
			return { sessionId: handle.sessionId };
		} catch (error) {
			if (error instanceof CloudRpcError && error.missing) {
				return { reason: "Agent threads are not deployed on this cloud yet." };
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
	}

	loadConversation(sessionId: string): Promise<void> {
		if (this.#stopped) return Promise.resolve();
		const existing = this.#conversationLoads.get(sessionId);
		if (existing) {
			existing.repeat = true;
			return existing.promise;
		}
		const request = { repeat: false, promise: Promise.resolve() };
		this.#conversationLoads.set(sessionId, request);
		request.promise = this.#loadConversation(sessionId, request).finally(() =>
			this.#conversationLoads.delete(sessionId),
		);
		return request.promise;
	}

	async #loadConversation(sessionId: string, request: { repeat: boolean }): Promise<void> {
		const store = this.conversations.get(sessionId);
		if (!store) return;
		do {
			request.repeat = false;
			try {
				let after = store.get().projection.lastSequence;
				const events = [...store.get().events];
				for (;;) {
					const page = await this.#api.readSessionEvents(sessionId, after, EVENT_PAGE);
					if (this.#stopped) return;
					for (const event of page)
						if (!events.some((existing) => existing.sequence === event.sequence)) events.push(event);
					if (page.length < EVENT_PAGE) break;
					const next = page[page.length - 1]?.sequence ?? after;
					if (next <= after) throw new Error("The transcript cursor did not advance.");
					after = next;
					store.set({ events: [...events], projection: projectTranscript(events, store.get().pending) });
				}
				const pending: PendingSessionInput[] = [];
				let position = 0;
				for (;;) {
					const page = await this.#api.listSessionInputs(sessionId, position, 100);
					if (this.#stopped) return;
					pending.push(...page.items);
					if (!page.hasMore) break;
					if (page.nextAfterPosition <= position || !page.items.length)
						throw new Error("The input cursor did not advance.");
					position = page.nextAfterPosition;
				}
				const optimistic = reconcileOptimistic({ optimistic: store.get().optimistic, pending, events });
				const projection = projectTranscript(events, pending);
				// The listing is optional: a cloud without Order 9 answers with a missing
				// RPC, and a refused or failed listing keeps what the thread already shows.
				let codingSessions = store.get().codingSessions;
				try {
					codingSessions = await this.#api.listCodingSessions(sessionId);
				} catch {
					codingSessions ??= [];
				}
				if (this.#stopped) return;
				store.set({
					events,
					pending,
					projection,
					loading: false,
					complete: true,
					error: undefined,
					optimistic,
					interactionAnswers: reconcileInteractionAnswers(store.get().interactionAnswers, projection),
					codingSessions,
				});
			} catch (error) {
				store.set({ loading: false, complete: false, error: describeError(error) });
				return;
			}
		} while (request.repeat && !this.#stopped);
	}

	// Coding sessions: the thread element follows one session's stream itself; the
	// owner's answer and delegation go through here so the listing stays current.

	readCodingSession(workerId: string, afterEvent = 0): Promise<CodingSessionRead> {
		return this.#api.readCodingSession(workerId, afterEvent);
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

	#mergeCodingSession(sessionId: string, session: CodingSession): void {
		const store = this.conversations.get(sessionId);
		if (!store) return;
		const current = store.get().codingSessions ?? [];
		const merged = current.some((item) => item.workerId === session.workerId)
			? current.map((item) =>
					item.workerId === session.workerId ? { ...session, isOwner: session.isOwner ?? item.isOwner } : item,
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
			throw new Error("This conversation is not available for sending.");
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
		if (state.sending) throw new Error("Wait for message submission before starting a new request.");
		if (!state.retrySend) return;
		const clientInputId = state.retrySend.clientInputId;
		store.set({
			retrySend: undefined,
			sendError: undefined,
			optimistic: state.optimistic.filter((item) => item.clientInputId !== clientInputId),
		});
	}

	roomTargetFor(sessionId: string): RoomMessageTarget | undefined {
		const session = this.store.get().sessions.find((item) => item.sessionId === sessionId);
		const scope = session?.executionScope;
		if (!session || !scope || !("roomId" in scope)) return undefined;
		if (typeof scope.roomId !== "string" || !UUID_PATTERN.test(scope.roomId))
			throw new Error("The team room conversation is unavailable.");
		// An agent thread is a room the kernel bound to one agent; a team room has no single agent.
		return Object.freeze({
			roomId: scope.roomId,
			environmentId: session.environmentId,
			agentThread: isAgentThreadSession(session),
		});
	}

	/** Answer a card the agent raised in this thread. The answer is queued like a
	 * message and shows on the card at once; the kernel refuses a second answer,
	 * an expired card, or a member the thread does not belong to. */
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
			await this.#api.answerInteraction(sessionId, crypto.randomUUID(), interactionId, outcome, answer);
		} catch (error) {
			const { [key]: _dropped, ...rest } = store.get().interactionAnswers ?? {};
			store.set({
				interactionAnswers: Object.keys(rest).length ? rest : undefined,
				interactionError: describeError(error),
			});
			throw error;
		}
		void this.loadConversation(sessionId);
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
		const issue = sessionAttachmentIssue(files);
		if (issue) {
			store.set({ sendError: issue });
			return false;
		}
		const retry = store.get().retrySend;
		const sameFiles = (other: readonly File[]) =>
			other.length === files.length && other.every((file, index) => file === files[index]);
		const sameRequest = retry?.text === trimmed && sameFiles(retry.files);
		if (retry && !sameRequest) {
			store.set({
				draft: text,
				sendError:
					'The earlier message may already have been accepted. Choose "Start a new message request" before sending changed text or images.',
			});
			return false;
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
				throw new Error("The conversation destination changed. Refresh before starting a new request.");
			if (roomTarget && !roomTarget.agentThread && files.length)
				throw new Error("Images are not supported in team rooms. Use Company File.");
		} catch (error) {
			store.set({ sendError: describeError(error), draft: text });
			return false;
		}
		// An uncertain attempt retains its original sponsor even if discovery or
		// the current chooser has changed. SQL checks exact replay identity.
		const executionSponsor = sameRequest ? retry.executionSponsor : store.get().executionSponsor;
		if (!executionSponsor) {
			store.set({ sendError: "Select an active model account before sending.", draft: text });
			return false;
		}
		const clientInputId = sameRequest ? retry.clientInputId : crypto.randomUUID();
		const clientRequestId = sameRequest ? retry.clientRequestId : clientInputId;
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
				draft: state.draft === text ? "" : state.draft,
				attachments: sameFiles(state.attachments ?? []) ? [] : state.attachments,
				optimistic: reconcileOptimistic({
					...state,
					optimistic: state.optimistic.map((item) =>
						item.clientInputId === clientInputId ? { ...item, inputId: receipt.inputId } : item,
					),
				}),
			}));
			this.#dismissFailureFor(sessionId);
			await this.loadConversation(sessionId);
			void this.refreshActivity();
			// The run is admitted a moment after the message; watch for it to appear.
			this.#watchWork(20_000);
			return true;
		} catch (error) {
			if (this.#stopped) return false;
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
			if (this.#openSessionId) void this.loadConversation(this.#openSessionId);
			void this.refreshActivity();
		}, wait);
	}

	readonly #refreshOpenConversation = debounce(() => {
		if (this.#openSessionId) void this.loadConversation(this.#openSessionId);
		void this.refreshActivity();
	}, 400);

	#onHint(resource: RealtimeResource): void {
		if (this.#stopped) return;
		for (const listener of this.#invalidations) listener(resource);
		if (resource === "sessions") {
			void this.refreshSessions();
			this.#refreshOpenConversation();
		} else if (resource === "staff") {
			void this.refreshStaff();
			void this.refreshOrganization();
		} else if (resource === "access") {
			void this.refreshTeam();
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
			}
			// Proposal comments/rejections do not all touch the Company File head.
			// Refresh this surface even with a healthy Realtime channel.
			if (!this.#stopped) for (const listener of this.#invalidations) listener("company-file");
			if (this.#openSessionId) await this.loadConversation(this.#openSessionId);
			await this.refreshActivity();
		} finally {
			this.#polling = false;
		}
	}
}
