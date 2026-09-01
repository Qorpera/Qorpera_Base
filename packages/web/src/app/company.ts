import type { CloudApi } from "../cloud/api.ts";
import { CloudRpcError, describeError } from "../cloud/client.ts";
import { buildCompanyHierarchy, type CompanyHierarchy, type HostedCompanyOrganization } from "../cloud/organization.ts";
import {
	type RealtimePhase,
	type RealtimeResource,
	type RealtimeSubscription,
	subscribeProfileRealtime,
} from "../cloud/realtime.ts";
import { projectTranscript, type TranscriptProjection } from "../cloud/transcript.ts";
import type {
	HostedProfile,
	HostedProfileTeam,
	HostedSession,
	HostedSessionEvent,
	HostedStaffAgent,
	HostedStaffExecutionActivity,
	PendingSessionInput,
} from "../cloud/types.ts";
import { debounce, Store } from "./state.ts";

/* One controller per open company. It holds the canonical projections the
 * views render (team, staff, sessions, organization, activity) and re-reads
 * them on Realtime hints. Nothing here executes work or owns a wake. */

export type Deployment = "loading" | "ready" | "not-deployed" | "not-seeded" | "error";

export interface CompanyState {
	profile: HostedProfile;
	team?: HostedProfileTeam;
	staff: HostedStaffAgent[];
	sessions: HostedSession[];
	organization?: HostedCompanyOrganization;
	organizationState: Deployment;
	organizationError?: string;
	hierarchy: CompanyHierarchy;
	activity: HostedStaffExecutionActivity[];
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
	/** Inputs this browser appended that the cloud has not listed back yet. */
	optimistic: { clientInputId: string; text: string; createdAt: string; authorUserId: string }[];
}

const EVENT_PAGE = 500;

/** Company-audience staff conversations, as the desktop arbiter selects them. */
export function isPrimaryStaffSession(session: HostedSession): boolean {
	if (!session.staffAgentId || session.status !== "open" || session.audience.kind !== "company") return false;
	const scope = session.executionScope ?? {};
	return !("autonomousLabel" in scope || "roomId" in scope || "group" in scope || "parentSession" in scope);
}

export class CompanyController {
	readonly store: Store<CompanyState>;
	readonly conversations = new Map<string, Store<ConversationState>>();
	readonly #api: CloudApi;
	readonly #userId: string;
	#realtime: RealtimeSubscription | undefined;
	#poll: ReturnType<typeof setInterval> | undefined;
	#openSessionId: string | undefined;
	#stopped = false;

	constructor(api: CloudApi, profile: HostedProfile, userId: string) {
		this.#api = api;
		this.#userId = userId;
		this.store = new Store<CompanyState>({
			profile,
			staff: [],
			sessions: [],
			organizationState: "loading",
			hierarchy: { primary: [], inactive: [] },
			activity: [],
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

	async start(): Promise<void> {
		this.#realtime = subscribeProfileRealtime(
			this.#api.cloud,
			this.profile.profileId,
			(resource) => this.#onHint(resource),
			(phase, error) =>
				this.store.set({ realtime: phase, ...(error ? { realtimeError: error } : { realtimeError: undefined }) }),
		);
		await this.refreshAll();
		this.#poll = setInterval(() => void this.#tick(), 30_000);
	}

	stop(): void {
		this.#stopped = true;
		this.#realtime?.stop();
		if (this.#poll) clearInterval(this.#poll);
	}

	async refreshAll(): Promise<void> {
		this.store.set({ loading: true, error: undefined });
		await Promise.all([
			this.refreshTeam(),
			this.refreshStaff(),
			this.refreshSessions(),
			this.refreshOrganization(),
			this.refreshActivity(),
		]);
		this.store.set({ loading: false });
	}

	async refreshTeam(): Promise<void> {
		try {
			const team = await this.#api.getTeam(this.profile.profileId);
			this.store.set({ team, accessLost: false });
		} catch (error) {
			if (error instanceof CloudRpcError && error.denied) this.store.set({ accessLost: true });
			else this.store.set({ error: describeError(error) });
		}
	}

	async refreshStaff(): Promise<void> {
		try {
			const staff = await this.#api.listStaff(this.profile.profileId);
			this.store.set((state) => ({ staff, hierarchy: buildCompanyHierarchy(state.organization, staff) }));
		} catch (error) {
			this.store.set({ error: describeError(error) });
		}
	}

	async refreshSessions(): Promise<void> {
		try {
			const sessions = await this.#api.listSessions(this.profile.environmentId);
			this.store.set({ sessions });
		} catch (error) {
			this.store.set({ error: describeError(error) });
		}
	}

	async refreshOrganization(): Promise<void> {
		try {
			const organization = await this.#api.getOrganization(this.profile.profileId);
			this.store.set((state) => ({
				organization,
				organizationState: organization ? "ready" : "not-seeded",
				organizationError: undefined,
				hierarchy: buildCompanyHierarchy(organization, state.staff),
			}));
		} catch (error) {
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
		try {
			const activity = await this.#api.listStaffActivity(this.profile.environmentId);
			this.store.set({ activity });
		} catch {
			/* Activity is an indicator; its absence must not block the company. */
		}
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
		return this.store
			.get()
			.activity.filter((item) => item.staffAgentId === staffAgentId)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
	}

	primarySessionFor(staffAgentId: string): HostedSession | undefined {
		return this.store
			.get()
			.sessions.find((session) => session.staffAgentId === staffAgentId && isPrimaryStaffSession(session));
	}

	/** Adopt-or-create the company-audience conversation for a staff agent. */
	async openStaffConversation(agent: HostedStaffAgent): Promise<string> {
		const existing = this.primarySessionFor(agent.id);
		if (existing) return existing.sessionId;
		const team = this.store.get().team;
		if (!team?.capabilities.write)
			throw new Error("Only a contributor can start this conversation. There is none yet.");
		const handle = await this.#api.ensureStaffSession(
			this.profile.environmentId,
			agent.id,
			crypto.randomUUID(),
			agent.displayName,
		);
		await this.refreshSessions();
		return handle.sessionId;
	}

	/** The member's private Co-Founder conversation (contract §14.2). */
	async openCofounderConversation(): Promise<{ sessionId?: string; reason?: string }> {
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
		const privateSession = sessions.find(
			(session) =>
				session.staffAgentId === organization.cofounder.staffAgentId &&
				session.audience.kind === "member_private" &&
				session.audience.userId === this.#userId &&
				session.status === "open",
		);
		if (privateSession) return { sessionId: privateSession.sessionId };
		if (!team?.capabilities.write) return { reason: "Viewers do not have a private Co-Founder conversation." };
		try {
			const handle = await this.#api.ensureMemberPrivateStaffSession(
				this.profile.environmentId,
				organization.cofounder.staffAgentId,
				this.#userId,
				crypto.randomUUID(),
				"Co-Founder",
			);
			await this.refreshSessions();
			return { sessionId: handle.sessionId };
		} catch (error) {
			if (error instanceof CloudRpcError && error.missing) {
				return { reason: "Member-private Co-Founder sessions are not deployed on this cloud yet." };
			}
			return { reason: describeError(error) };
		}
	}

	conversation(sessionId: string): Store<ConversationState> {
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
			void this.loadConversation(sessionId);
		}
		return store;
	}

	setOpenSession(sessionId: string | undefined): void {
		this.#openSessionId = sessionId;
	}

	async loadConversation(sessionId: string): Promise<void> {
		const store = this.conversations.get(sessionId);
		if (!store) return;
		try {
			let after = store.get().projection.lastSequence;
			const events = [...store.get().events];
			for (;;) {
				const page = await this.#api.readSessionEvents(sessionId, after, EVENT_PAGE);
				for (const event of page)
					if (!events.some((existing) => existing.sequence === event.sequence)) events.push(event);
				if (page.length < EVENT_PAGE) break;
				after = page[page.length - 1]?.sequence ?? after;
				store.set({ events: [...events], projection: projectTranscript(events, store.get().pending) });
			}
			const pending = (await this.#api.listSessionInputs(sessionId, 0, 100)).items;
			const optimistic = store
				.get()
				.optimistic.filter(
					(item) =>
						!pending.some((input) => input.inputId === item.clientInputId) &&
						!events.some((event) => event.sessionInputId === item.clientInputId),
				);
			store.set({
				events,
				pending,
				projection: projectTranscript(events, pending),
				loading: false,
				complete: true,
				error: undefined,
				optimistic,
			});
		} catch (error) {
			store.set({ loading: false, error: describeError(error) });
		}
	}

	async sendPrompt(sessionId: string, text: string): Promise<void> {
		const store = this.conversation(sessionId);
		const trimmed = text.trim();
		if (!trimmed) return;
		const clientInputId = crypto.randomUUID();
		store.set((state) => ({
			sending: true,
			sendError: undefined,
			optimistic: [
				...state.optimistic,
				{ clientInputId, text: trimmed, createdAt: new Date().toISOString(), authorUserId: this.#userId },
			],
		}));
		try {
			await this.#api.appendPrompt(sessionId, clientInputId, trimmed);
			store.set({ sending: false });
			await this.loadConversation(sessionId);
			void this.refreshActivity();
		} catch (error) {
			store.set((state) => ({
				sending: false,
				sendError: describeError(error),
				optimistic: state.optimistic.filter((item) => item.clientInputId !== clientInputId),
			}));
		}
	}

	readonly #refreshOpenConversation = debounce(() => {
		if (this.#openSessionId) void this.loadConversation(this.#openSessionId);
		void this.refreshActivity();
	}, 400);

	#onHint(resource: RealtimeResource): void {
		if (this.#stopped) return;
		if (resource === "sessions") {
			void this.refreshSessions();
			this.#refreshOpenConversation();
		} else if (resource === "staff") {
			void this.refreshStaff();
			void this.refreshOrganization();
		} else if (resource === "access") {
			void this.refreshTeam();
		}
	}

	async #tick(): Promise<void> {
		if (this.#stopped) return;
		// Polling is the recovery path when Realtime is degraded; a light
		// heartbeat otherwise keeps activity and the open transcript honest.
		if (this.store.get().realtime !== "connected") await this.refreshSessions();
		if (this.#openSessionId) await this.loadConversation(this.#openSessionId);
		await this.refreshActivity();
	}
}
