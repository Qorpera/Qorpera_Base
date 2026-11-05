import type { AuthChangeEvent, Session, User } from "@supabase/supabase-js";
import { vi } from "vitest";
import { CloudApi } from "../src/cloud/api.ts";
import { type Cloud, CloudRpcError } from "../src/cloud/client.ts";
import { joinFoundingPresence } from "../src/cloud/founding-presence.ts";
import type {
	HostedCompanyFile,
	HostedProfile,
	HostedProfileTeam,
	HostedSession,
	HostedSessionEvent,
	HostedStaffAgent,
	PendingSessionInput,
} from "../src/cloud/types.ts";
import * as figureMotion from "../src/ui/figure-motion.ts";

export const id = (n: number): string => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
export const timestamp = "2026-09-05T10:00:00Z";
export const userA: User = {
	id: id(1),
	aud: "authenticated",
	email: "a@example.invalid",
	app_metadata: {},
	user_metadata: { full_name: "Account A" },
	created_at: timestamp,
};
export const userB: User = {
	...userA,
	id: id(2),
	email: "b@example.invalid",
	user_metadata: { full_name: "Account B" },
};
export const profileA: HostedProfile = {
	profileId: id(3),
	environmentId: id(4),
	profileName: "Company A PRIVATE",
	environmentName: "Main",
	role: "owner",
	contractVersion: 1,
	createdAt: timestamp,
};
export const profileB: HostedProfile = {
	...profileA,
	profileId: id(5),
	environmentId: id(6),
	profileName: "Company B",
};
export const team: HostedProfileTeam = {
	profileId: profileA.profileId,
	role: "owner",
	capabilities: { read: true, write: true, authorize: true, manageMembers: true },
	members: [],
	invitations: [],
};
export const session: HostedSession = {
	sessionId: id(7),
	clientSessionId: id(8),
	profileId: profileA.profileId,
	environmentId: profileA.environmentId,
	title: "Fixture conversation",
	status: "open",
	audience: { kind: "company" },
	createdByUserId: userA.id,
	createdAt: timestamp,
	updatedAt: timestamp,
};
export const staff: HostedStaffAgent = {
	profileId: profileA.profileId,
	id: id(9),
	displayName: "Fixture agent",
	role: "Designer",
	charter: "Design",
	appearance: { color: "#123456", shape: "circle" },
	employmentStatus: "active",
	lifecycleState: "active",
	version: 1,
	createdAt: timestamp,
	updatedAt: timestamp,
	updatedByUserId: userA.id,
};
export const file: HostedCompanyFile = {
	profileId: profileA.profileId,
	environmentId: profileA.environmentId,
	storageUsedBytes: 18,
	storageLimitBytes: 100,
	createdAt: timestamp,
	updatedAt: timestamp,
};

export function event(sequence: number, text = `Message ${sequence}`): HostedSessionEvent {
	return {
		sessionId: session.sessionId,
		eventId: id(1000 + sequence),
		sequence,
		actorUserId: userA.id,
		sessionInputId: id(2000 + sequence),
		eventType: "message",
		eventHash: "a".repeat(64),
		createdAt: timestamp,
		body: {
			schema: "qorpera.runner-transcript-entry/v1",
			entry: { type: "message", id: id(1000 + sequence), message: { role: "user", content: text } },
		},
	};
}
export function pending(position: number, text = `Input ${position}`): PendingSessionInput {
	return {
		inputId: id(2000 + position),
		position,
		kind: "user_message",
		authorUserId: userA.id,
		authorDisplayName: "Account A",
		body: { schema: "qorpera.session-prompt/v1", text, images: [] },
		createdAt: timestamp,
		status: "queued",
	};
}
export function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
export async function settle(): Promise<void> {
	for (let i = 0; i < 30; i++) await Promise.resolve();
}

/** Stands in for the vendored figure scripts; the spy records each figure's mount options. */
export function stubFigureMotion(dispose: () => void = () => {}) {
	vi.stubGlobal("QORPERA_MOTION_MODEL", { avatars: [] });
	vi.stubGlobal("QORPERA_AVATAR_APPEARANCE", { palette: [] });
	return vi.spyOn(figureMotion, "mountFigureMotion").mockReturnValue({ dispose });
}

export function fixture() {
	let authCallback: ((event: AuthChangeEvent, session: Session | null) => void) | undefined;
	let currentUser: User | null = userA;
	const getSession = (): Session | null =>
		currentUser
			? {
					user: currentUser,
					access_token: "fixture-token",
					refresh_token: "fixture-refresh",
					expires_in: 3600,
					token_type: "bearer",
				}
			: null;
	const hints = new Map<string, () => void>();
	const unsubscribe = vi.fn();
	const channel = {
		on: vi.fn((_kind: string, filter: { table: string }, callback: () => void) => {
			hints.set(filter.table, callback);
			return channel;
		}),
		subscribe: vi.fn(() => channel),
	};
	const cloud = {
		config: { projectUrl: "https://fixture.invalid", publishableKey: "fixture-publishable" },
		rpc: vi.fn(async () => {
			throw new Error("Unexpected RPC");
		}),
		supabase: {
			auth: {
				initialize: vi.fn(async () => ({ error: null })),
				getSession: vi.fn(async () => ({ data: { session: getSession() } })),
				onAuthStateChange: vi.fn((callback: typeof authCallback) => {
					authCallback = callback;
					return { data: { subscription: { unsubscribe } } };
				}),
			},
			channel: vi.fn(() => channel),
			removeChannel: vi.fn(async () => {}),
		},
	} as unknown as Cloud;
	const api = new CloudApi(cloud);
	vi.spyOn(api, "listProfiles").mockResolvedValue([profileA]);
	vi.spyOn(api, "listIncomingInvitations").mockResolvedValue([]);
	vi.spyOn(api, "listFriends").mockResolvedValue([]);
	// A cloud that still creates companies at once: no founding tables.
	vi.spyOn(api, "companyFoundingAvailable").mockResolvedValue(false);
	vi.spyOn(api, "listCompanyFoundings").mockResolvedValue([]);
	vi.spyOn(api, "findAccountByEmail").mockResolvedValue(null);
	vi.spyOn(api, "listMemberPictures").mockResolvedValue([]);
	vi.spyOn(api, "getAccountEntitlement").mockResolvedValue({
		planKey: "Account A private plan",
		billingMode: "fixture",
		featureSet: "fixture",
		storageAllocation: "fixture",
		source: "fixture",
	});
	vi.spyOn(api, "getTeam").mockResolvedValue(team);
	vi.spyOn(api, "listStaff").mockResolvedValue([staff]);
	vi.spyOn(api, "listSessions").mockResolvedValue([session]);
	vi.spyOn(api, "getOrganization").mockResolvedValue(undefined);
	vi.spyOn(api, "listStaffActivity").mockResolvedValue([]);
	// A cloud without the sidebar RPCs: the rail shows one list, as before sections.
	vi.spyOn(api, "readCompanySidebar").mockRejectedValue(
		new CloudRpcError("qorpera_read_company_sidebar", { message: "missing", code: "PGRST202" }, 404),
	);
	// A cloud without shared drafts: conversations keep each member's draft to themselves.
	vi.spyOn(api, "listRoomDrafts").mockRejectedValue(
		new CloudRpcError("qorpera_list_room_drafts", { message: "missing", code: "PGRST202" }, 404),
	);
	// Presence joins the company's live channel; the fixture's tabs see nobody else.
	vi.spyOn(api, "joinPresence").mockReturnValue({
		setOpenThread: vi.fn(),
		sendTyping: vi.fn(),
		sendActivity: vi.fn(),
		stop: vi.fn(async () => {}),
	});
	// A cloud without the founding table's presence (20260930531000): the real topic client meets PGRST202 and gives
	// up, so every table runs on its own reads, as before it.
	const withoutTablePresence: Cloud = {
		...cloud,
		rpc: vi.fn(async (name: string) => {
			throw new CloudRpcError(name, { message: "Could not find the function", code: "PGRST202" }, 404);
		}),
	};
	vi.spyOn(api, "joinFoundingPresence").mockImplementation((profileId, listener) =>
		joinFoundingPresence(withoutTablePresence, profileId, listener),
	);
	// A cloud that reads no mentions yet: no names to pick, no badges.
	vi.spyOn(api, "listMemberMentions").mockRejectedValue(
		new CloudRpcError("qorpera_list_member_mentions", { message: "missing", code: "PGRST202" }, 404),
	);
	vi.spyOn(api, "companyWaitingForHours").mockResolvedValue(false);
	// A cloud before the memory choice (C5): Settings show no Memory section.
	vi.spyOn(api, "getCompanyMemory").mockRejectedValue(
		new CloudRpcError("qorpera_company_memory_mode", { message: "missing", code: "PGRST202" }, 404),
	);
	vi.spyOn(api, "readSessionEvents").mockResolvedValue([]);
	// No message of the fixture's conversations was ever erased.
	vi.spyOn(api, "readSessionMemoryGeneration").mockResolvedValue(0);
	// A cloud before the newest-first read (20260928279410): threads read their history forward.
	vi.spyOn(api, "readSessionEventsTail").mockRejectedValue(
		new CloudRpcError("qorpera_read_session_events_tail", { message: "missing", code: "PGRST202" }, 404),
	);
	vi.spyOn(api, "listSessionInputs").mockResolvedValue({ items: [], hasMore: false, nextAfterPosition: 0 });
	vi.spyOn(api, "listCodingSessions").mockResolvedValue([]);
	vi.spyOn(api, "readCodingSession").mockRejectedValue(new Error("No coding session in this fixture"));
	vi.spyOn(api, "answerCodingSession").mockRejectedValue(new Error("No coding session in this fixture"));
	vi.spyOn(api, "delegateCodingSession").mockRejectedValue(new Error("No coding session in this fixture"));
	vi.spyOn(api, "archiveCodingSession").mockRejectedValue(new Error("No coding session in this fixture"));
	vi.spyOn(api, "listAgentProposals").mockResolvedValue({ proposals: [], moreProposals: 0 });
	vi.spyOn(api, "discardProposal").mockRejectedValue(new Error("No proposal in this fixture"));
	vi.spyOn(api, "getCompanyFile").mockResolvedValue(file);
	// A cloud before good will (20260930566000): Settings and the account page show no good will.
	vi.spyOn(api, "getCompanyGoodWill").mockRejectedValue(
		new CloudRpcError("qorpera_company_good_will", { message: "missing", code: "PGRST202" }, 404),
	);
	vi.spyOn(api, "getMyGoodWill").mockRejectedValue(
		new CloudRpcError("qorpera_my_good_will", { message: "missing", code: "PGRST202" }, 404),
	);
	return {
		api,
		cloud,
		hints,
		unsubscribe,
		auth(user: User | null) {
			currentUser = user;
			authCallback?.(user ? "SIGNED_IN" : "SIGNED_OUT", getSession());
		},
	};
}

/** What the loading placeholder under `root` tells a screen reader. */
export function placeholderLabel(root: ParentNode | null | undefined): string | undefined {
	return root?.querySelector(".skeleton-group[role=status] > .visually-hidden")?.textContent ?? undefined;
}

/** The text a sighted member sees: everything except screen-reader-only text. */
export function visibleText(element: Element | null | undefined): string {
	const copy = element?.cloneNode(true) as Element | undefined;
	for (const hidden of copy?.querySelectorAll(".visually-hidden") ?? []) hidden.remove();
	return copy?.textContent ?? "";
}
