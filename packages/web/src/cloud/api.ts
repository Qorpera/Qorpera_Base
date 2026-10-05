import type { Cloud } from "./client.ts";
import {
	type CodingSession,
	type CodingSessionRead,
	parseCodingSession,
	parseCodingSessionRead,
	parseCodingSessions,
} from "./coding-session.ts";
import { CompanyFoundingApi, type FoundingTableEntry } from "./company-founding.ts";
import {
	type ComputerHourOffer,
	listComputerHourOffers,
	type MyComputerPlan,
	openComputerBillingPortal,
	readMyComputerPlan,
	startComputerCheckout,
} from "./computer-billing.ts";
import { type CompanyComputerHours, readCompanyComputerHours } from "./computer-hours.ts";
import {
	isMemberPictureName,
	MEMBER_PICTURE_BUCKET,
	type MemberPicture,
	type MemberPictureChange,
	type MemberPictureObject,
	parseMemberPictureChange,
	parseMemberPictureObjects,
	parseMemberPictures,
} from "./member-pictures.ts";
import { listMemberMentions, type MemberMentions, markMentionsSeen } from "./mentions.ts";
import { type HostedCompanyOrganization, parseHostedCompanyOrganization } from "./organization.ts";
import { collectPages, type PageCursor } from "./pagination.ts";
import {
	type AgentThreadHandle,
	parseAccountEntitlement,
	parseAccountMatch,
	parseAgentThreadHandle,
	parseCompanyFile,
	parseEvents,
	parseFriends,
	parseIncomingInvitations,
	parseInvitation,
	parsePendingSessionInputs,
	parseProfiles,
	parseRoomDeliveryRetry,
	parseRunRecovery,
	parseRunResolution,
	parseSessionInputReceipt,
	parseSessionPage,
	parseStaffExecutionActivity,
	parseStaffList,
	parseStaffSessionHandle,
	parseTeam,
	parseWorkerRunControl,
	UUID_PATTERN,
} from "./parse.ts";
import { type CloudPresenceHandle, joinCompanyPresence, type PresenceHealth, type PresenceMember } from "./presence.ts";
import type { MessageQuote } from "./quotes.ts";
import type { RealtimePhase } from "./realtime.ts";
import { type ActionReviewAnswer, type ActionReviewReceipt, parseActionReviewReceipt } from "./review-rules.ts";
import {
	listRoomDrafts,
	putRoomDraft,
	type RoomDraft,
	type RoomDraftSubscription,
	type RoomDraftWrite,
	subscribeRoomDrafts,
} from "./room-drafts.ts";
import { type CompanySidebar, parseCompanySidebar, type SidebarRequest } from "./sidebar.ts";
import type {
	HostedAccountEntitlement,
	HostedAccountMatch,
	HostedCompanyFile,
	HostedFriend,
	HostedIncomingProfileInvitation,
	HostedProfile,
	HostedProfileInvitation,
	HostedProfileRole,
	HostedProfileTeam,
	HostedRunRecovery,
	HostedSession,
	HostedSessionEvent,
	HostedStaffAgent,
	HostedStaffExecutionActivity,
	JsonValue,
	PendingSessionInputPage,
	SessionInputReceipt,
	StaffSessionHandle,
	WorkerRunControl,
} from "./types.ts";

/* Typed member surface over CLIENT-CONTRACT.md §2. One method per RPC the web
 * app uses; nothing here writes a table, runs an agent, or resolves a secret. */

function requiredUuid(value: string, label: string): string {
	if (!UUID_PATTERN.test(value)) throw new Error(`${label} must be a UUID`);
	return value;
}

export const SESSION_PROMPT_SCHEMA = "qorpera.session-prompt/v1";

export class CloudApi {
	readonly cloud: Cloud;

	constructor(cloud: Cloud) {
		this.cloud = cloud;
	}

	// Accounts, profiles, membership

	listProfiles(): Promise<HostedProfile[]> {
		return this.cloud.rpc("qorpera_list_hosted_profiles").then(parseProfiles);
	}

	getAccountEntitlement(): Promise<HostedAccountEntitlement> {
		return this.cloud.rpc("qorpera_get_account_entitlement").then(parseAccountEntitlement);
	}

	/** The company's computer hours this month, measured (not charged yet). */
	getCompanyComputerHours(profileId: string): Promise<CompanyComputerHours> {
		return readCompanyComputerHours(this.cloud, requiredUuid(profileId, "Profile id"));
	}

	/** Whether the company is out of computer hours, so new work waits until hours are added
	 * (the zero rule; migration 20260928259280_company_waiting_for_hours). Any member may ask. */
	companyWaitingForHours(profileId: string): Promise<boolean> {
		return this.cloud
			.rpc("qorpera_company_waiting_for_hours", { p_profile_id: requiredUuid(profileId, "Profile id") })
			.then((value) => value === true);
	}

	/** A worker's own run, which has no conversation: its state and whether this member may stop it (gap 4b). */
	workerRunControl(runId: string): Promise<WorkerRunControl> {
		const id = requiredUuid(runId, "Run id");
		return this.cloud
			.rpc("qorpera_get_worker_run_control", { p_run_id: id })
			.then((value) => parseWorkerRunControl(value, id));
	}

	/** A member's Stop of a worker's own run: the thread run's stop, by run id (gap 4b). */
	stopWorkerRun(runId: string): Promise<WorkerRunControl> {
		const id = requiredUuid(runId, "Run id");
		return this.cloud
			.rpc("qorpera_cancel_worker_run", { p_run_id: id })
			.then((value) => parseWorkerRunControl(value, id));
	}

	/** The plans and packs of hours this member can buy. */
	listComputerHourOffers(): Promise<ComputerHourOffer[]> {
		return listComputerHourOffers(this.cloud);
	}

	/** The member's own plan: its period, its hours and what each company used of them. */
	getMyComputerPlan(): Promise<MyComputerPlan> {
		return readMyComputerPlan(this.cloud);
	}

	/** Stripe's checkout page for a plan, or for a pack of hours for a company (founders only). */
	startComputerCheckout(itemKey: string, profileId?: string): Promise<string> {
		return startComputerCheckout(this.cloud, itemKey, profileId ? requiredUuid(profileId, "Profile id") : undefined);
	}

	/** Stripe's billing page for the member's cards, invoices and plan. */
	openComputerBillingPortal(): Promise<string> {
		return openComputerBillingPortal(this.cloud);
	}

	listIncomingInvitations(): Promise<HostedIncomingProfileInvitation[]> {
		return this.cloud.rpc("qorpera_list_profile_invitations").then(parseIncomingInvitations);
	}

	async acceptInvitation(invitationId: string): Promise<void> {
		await this.cloud.rpc("qorpera_accept_profile_invitation", {
			p_invitation_id: requiredUuid(invitationId, "Invitation id"),
		});
	}

	async declineInvitation(invitationId: string): Promise<void> {
		await this.cloud.rpc("qorpera_decline_profile_invitation", {
			p_invitation_id: requiredUuid(invitationId, "Invitation id"),
		});
	}

	// Founding tables: the hub's two reads. A table's own calls are in company-founding.ts.

	companyFoundingAvailable(): Promise<boolean> {
		return new CompanyFoundingApi(this.cloud).available();
	}

	listCompanyFoundings(): Promise<FoundingTableEntry[]> {
		return new CompanyFoundingApi(this.cloud).list();
	}

	// Friends. Company invitations only reach accounts you are already friends
	// with, so this list is the account's address book (CLIENT-CONTRACT.md §2,
	// "Members, presence, friends, feedback").

	listFriends(): Promise<HostedFriend[]> {
		return this.cloud.rpc("qorpera_list_friends").then(parseFriends);
	}

	/** The account that has confirmed exactly this address, or null when none has. */
	findAccountByEmail(email: string): Promise<HostedAccountMatch | null> {
		return this.cloud
			.rpc("qorpera_find_account_by_email", { p_email: email.trim().toLowerCase() })
			.then(parseAccountMatch);
	}

	async sendFriendRequest(email: string): Promise<void> {
		await this.cloud.rpc("qorpera_send_friend_request", { p_email: email.trim().toLowerCase() });
	}

	async respondFriendRequest(userId: string, accept: boolean): Promise<void> {
		await this.cloud.rpc("qorpera_respond_friend_request", {
			p_user_id: requiredUuid(userId, "Account id"),
			p_accept: accept,
		});
	}

	async removeFriend(userId: string): Promise<void> {
		await this.cloud.rpc("qorpera_remove_friend", { p_user_id: requiredUuid(userId, "Account id") });
	}

	// Member pictures: the photo a member chose for their account. The cloud
	// returns only the pictures the caller may see (themselves, company
	// colleagues, friends); the bytes are private storage objects the member
	// uploads into their own folder.

	listMemberPictures(userIds: readonly string[]): Promise<MemberPicture[]> {
		if (userIds.length > 200) throw new Error("Ask for at most 200 pictures at a time.");
		return this.cloud
			.rpc("qorpera_member_pictures", { p_user_ids: userIds.map((userId) => requiredUuid(userId, "Account id")) })
			.then(parseMemberPictures);
	}

	/** Resolves true when this call stored the object, false when those bytes were already there. */
	async uploadMemberPicture(objectName: string, picture: Blob): Promise<boolean> {
		if (!isMemberPictureName(objectName)) throw new Error("Invalid picture name.");
		const { error } = await this.cloud.supabase.storage.from(MEMBER_PICTURE_BUCKET).upload(objectName, picture, {
			contentType: picture.type,
			// The name is the content's hash, so the bytes behind it never change.
			cacheControl: "31536000",
			upsert: false,
		});
		if (!error) return true;
		// The same picture uploaded again already sits under its name.
		if (error.statusCode === "409" || /already exists/i.test(error.message)) return false;
		throw error;
	}

	/** Everything in the caller's own folder: the current picture and uploads never chosen. */
	ownMemberPictureObjects(): Promise<MemberPictureObject[]> {
		return this.cloud.rpc("qorpera_own_member_picture_objects").then(parseMemberPictureObjects);
	}

	async downloadMemberPicture(objectName: string): Promise<Blob> {
		if (!isMemberPictureName(objectName)) throw new Error("Invalid picture name.");
		const { data, error } = await this.cloud.supabase.storage.from(MEMBER_PICTURE_BUCKET).download(objectName);
		if (error || !data) throw error ?? new Error("The picture is unavailable.");
		return data;
	}

	async deleteMemberPicture(objectName: string): Promise<void> {
		if (!isMemberPictureName(objectName)) throw new Error("Invalid picture name.");
		const { error } = await this.cloud.supabase.storage.from(MEMBER_PICTURE_BUCKET).remove([objectName]);
		if (error) throw error;
	}

	setMemberPicture(objectName: string): Promise<MemberPictureChange> {
		if (!isMemberPictureName(objectName)) throw new Error("Invalid picture name.");
		return this.cloud.rpc("qorpera_set_member_picture", { p_object_name: objectName }).then(parseMemberPictureChange);
	}

	clearMemberPicture(): Promise<MemberPictureChange> {
		return this.cloud.rpc("qorpera_clear_member_picture").then(parseMemberPictureChange);
	}

	getTeam(profileId: string): Promise<HostedProfileTeam> {
		return this.cloud
			.rpc("qorpera_profile_team_info", { p_profile_id: requiredUuid(profileId, "Profile id") })
			.then(parseTeam);
	}

	inviteMember(
		profileId: string,
		email: string,
		memberRole: Exclude<HostedProfileRole, "owner">,
	): Promise<HostedProfileInvitation> {
		return this.cloud
			.rpc("qorpera_invite_profile_member", {
				p_profile_id: requiredUuid(profileId, "Profile id"),
				p_email: email.trim().toLowerCase(),
				p_role: memberRole,
			})
			.then(parseInvitation);
	}

	async cancelInvitation(profileId: string, invitationId: string): Promise<void> {
		await this.cloud.rpc("qorpera_cancel_profile_invitation", {
			p_profile_id: requiredUuid(profileId, "Profile id"),
			p_invitation_id: requiredUuid(invitationId, "Invitation id"),
		});
	}

	async retryInvitationDelivery(profileId: string, invitationId: string): Promise<void> {
		await this.cloud.rpc("qorpera_retry_profile_invitation_delivery", {
			p_profile_id: requiredUuid(profileId, "Profile id"),
			p_invitation_id: requiredUuid(invitationId, "Invitation id"),
		});
	}

	async updateMemberRole(profileId: string, memberUserId: string, memberRole: HostedProfileRole): Promise<void> {
		await this.cloud.rpc("qorpera_update_profile_member_role", {
			p_profile_id: requiredUuid(profileId, "Profile id"),
			p_member_user_id: requiredUuid(memberUserId, "Member id"),
			p_role: memberRole,
		});
	}

	async removeMember(profileId: string, memberUserId: string): Promise<void> {
		await this.cloud.rpc("qorpera_remove_profile_member", {
			p_profile_id: requiredUuid(profileId, "Profile id"),
			p_member_user_id: requiredUuid(memberUserId, "Member id"),
		});
	}

	async leaveProfile(profileId: string): Promise<void> {
		await this.cloud.rpc("qorpera_leave_hosted_profile", { p_profile_id: requiredUuid(profileId, "Profile id") });
	}

	async deleteProfile(profileId: string): Promise<void> {
		await this.cloud.rpc("qorpera_delete_hosted_profile", { p_profile_id: requiredUuid(profileId, "Profile id") });
	}

	// Organization and staff

	listStaff(profileId: string): Promise<HostedStaffAgent[]> {
		return this.cloud
			.rpc("qorpera_list_profile_staff", { p_profile_id: requiredUuid(profileId, "Profile id") })
			.then(parseStaffList);
	}

	getOrganization(profileId: string): Promise<HostedCompanyOrganization | undefined> {
		return this.cloud
			.rpc("qorpera_company_organization_json", { p_profile_id: requiredUuid(profileId, "Profile id") })
			.then(parseHostedCompanyOrganization);
	}

	// Shared drafts: a member's unsent message in a room, which the room's other
	// members see and edit live (20260928000500). Only its owner sends it.

	listRoomDrafts(roomId: string): Promise<RoomDraft[]> {
		return listRoomDrafts(this.cloud, requiredUuid(roomId, "Room id").toLowerCase());
	}

	putRoomDraft(
		roomId: string,
		ownerUserId: string,
		baseRevision: number,
		body: string,
		quotes: readonly MessageQuote[],
	): Promise<RoomDraftWrite> {
		if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) throw new Error("Draft revision is invalid");
		return putRoomDraft(
			this.cloud,
			requiredUuid(roomId, "Room id").toLowerCase(),
			requiredUuid(ownerUserId, "Draft owner").toLowerCase(),
			baseRevision,
			body,
			quotes,
		);
	}

	subscribeRoomDrafts(
		roomId: string,
		onDraft: (draft: RoomDraft) => void,
		onHealth: (phase: RealtimePhase) => void,
	): RoomDraftSubscription {
		return subscribeRoomDrafts(this.cloud, requiredUuid(roomId, "Room id").toLowerCase(), onDraft, onHealth);
	}

	/** Who has which conversation open, live (the company's presence channel). */
	joinPresence(
		profileId: string,
		onMembers: (members: PresenceMember[]) => void,
		onHealth: (health: PresenceHealth) => void,
	): CloudPresenceHandle {
		return joinCompanyPresence(this.cloud, requiredUuid(profileId, "Profile id"), onMembers, onHealth);
	}

	/** The conversations where the signed-in member was mentioned and has not looked yet. */
	listMemberMentions(profileId: string): Promise<MemberMentions[]> {
		return listMemberMentions(this.cloud, requiredUuid(profileId, "Profile id"));
	}

	markMentionsSeen(sessionId: string): Promise<void> {
		return markMentionsSeen(this.cloud, requiredUuid(sessionId, "Session id"));
	}

	/** Sections are the company's; pins and hidden agents are the signed-in member's. */
	readCompanySidebar(profileId: string): Promise<CompanySidebar> {
		return this.cloud
			.rpc("qorpera_read_company_sidebar", { p_profile_id: requiredUuid(profileId, "Profile id") })
			.then(parseCompanySidebar);
	}

	manageCompanySidebar(profileId: string, request: SidebarRequest): Promise<CompanySidebar> {
		return this.cloud
			.rpc("qorpera_manage_company_sidebar", {
				p_profile_id: requiredUuid(profileId, "Profile id"),
				p_request: request,
			})
			.then(parseCompanySidebar);
	}

	listStaffActivity(environmentId: string): Promise<HostedStaffExecutionActivity[]> {
		return this.cloud
			.rpc("qorpera_list_staff_execution_activity", {
				p_environment_id: requiredUuid(environmentId, "Environment id"),
			})
			.then(parseStaffExecutionActivity);
	}

	getRunRecovery(runId: string): Promise<HostedRunRecovery> {
		return this.cloud
			.rpc("qorpera_get_execution_run_recovery", { p_run_id: requiredUuid(runId, "Run id") })
			.then(parseRunRecovery);
	}

	/** The desktop's "discard": the run stops counting against the agent. Nothing
	 * is re-run, and the member's own message stays marked failed. */
	discardFailedRun(runId: string): Promise<void> {
		const id = requiredUuid(runId, "Run id");
		return this.cloud
			.rpc("qorpera_resolve_failed_execution_run", { p_run_id: id, p_action: "discard" })
			.then((value) => parseRunResolution(value, id, "discard"));
	}

	/** Dismiss: a member saw the failure. The run stops standing in for the agent;
	 * nothing is discarded, replayed or changed, so this also settles a run whose
	 * durable outcome is still unknown, which discard refuses. */
	acknowledgeFailedRun(runId: string): Promise<void> {
		const id = requiredUuid(runId, "Run id");
		return this.cloud
			.rpc("qorpera_resolve_failed_execution_run", { p_run_id: id, p_action: "acknowledge" })
			.then((value) => parseRunResolution(value, id, "acknowledge"));
	}

	/** Try again for a session turn: the cloud releases the run and queues its inputs again. */
	retryFailedRun(runId: string): Promise<void> {
		const id = requiredUuid(runId, "Run id");
		return this.cloud
			.rpc("qorpera_resolve_failed_execution_run", { p_run_id: id, p_action: "retry" })
			.then((value) => parseRunResolution(value, id, "retry"));
	}

	/** Try again for a post into a room or agent thread (20260920080000): the member's
	 * message stays as it is and wakes the same agent once more, on the account chosen
	 * now. Only the author of the post may do this. */
	retryRoomDelivery(runId: string, sponsorBindingId: string, sponsorVersion: number): Promise<void> {
		const id = requiredUuid(runId, "Run id");
		if (!Number.isSafeInteger(sponsorVersion) || sponsorVersion < 1) throw new Error("Model account is invalid.");
		return this.cloud
			.rpc("qorpera_retry_room_delivery", {
				p_run_id: id,
				p_sponsor_binding_id: requiredUuid(sponsorBindingId, "Model account"),
				p_sponsor_version: sponsorVersion,
			})
			.then((value) => parseRoomDeliveryRetry(value, id));
	}

	// Conversations

	/** Every conversation of the environment the member may read, least recently changed first;
	 * with `since`, only those changed after it (the page's own updated_at, id cursor). */
	listSessions(environmentId: string, signal?: AbortSignal, since?: PageCursor): Promise<HostedSession[]> {
		return collectPages((cursor) => {
			signal?.throwIfAborted();
			const after = cursor ?? since;
			return this.cloud
				.rpc("qorpera_list_shared_sessions_page", {
					p_environment_id: requiredUuid(environmentId, "Environment id"),
					p_after_updated_at: after?.time ?? null,
					p_after_id: after?.id ?? null,
					p_limit: 100,
				})
				.then(parseSessionPage);
		});
	}

	ensureStaffSession(
		environmentId: string,
		staffAgentId: string,
		clientSessionId: string,
		title: string,
	): Promise<StaffSessionHandle> {
		return this.cloud
			.rpc("qorpera_ensure_staff_session", {
				p_environment_id: requiredUuid(environmentId, "Environment id"),
				p_staff_agent_id: staffAgentId,
				p_client_session_id: requiredUuid(clientSessionId, "Client session id"),
				p_title: title.trim().slice(0, 256) || "Conversation",
			})
			.then(parseStaffSessionHandle);
	}

	/** The agent's one shared thread (2026-09-17 amendment); the kernel binds it to the agent's room. */
	agentThread(environmentId: string, staffAgentId: string): Promise<AgentThreadHandle> {
		return this.cloud
			.rpc("qorpera_agent_thread", {
				p_environment_id: requiredUuid(environmentId, "Environment id"),
				p_staff_agent_id: requiredUuid(staffAgentId, "Staff agent id"),
			})
			.then(parseAgentThreadHandle);
	}

	readSessionEvents(sessionId: string, afterSequence = 0, limit = 500): Promise<HostedSessionEvent[]> {
		return this.cloud
			.rpc("qorpera_read_session_events", {
				p_session_id: requiredUuid(sessionId, "Session id"),
				p_after_sequence: afterSequence,
				p_limit: limit,
			})
			.then(parseEvents);
	}

	/** The newest `limit` events of a transcript, or the newest before `beforeSequence`, oldest
	 * first as readSessionEvents returns them (migration 20260928279410; a cloud without it
	 * answers with a missing RPC). Same authorization as the forward read, which it runs. */
	readSessionEventsTail(
		sessionId: string,
		beforeSequence: number | undefined,
		limit: number,
	): Promise<HostedSessionEvent[]> {
		return this.cloud
			.rpc("qorpera_read_session_events_tail", {
				p_session_id: requiredUuid(sessionId, "Session id"),
				p_before_sequence: beforeSequence ?? null,
				p_limit: limit,
			})
			.then(parseEvents);
	}

	// Coding sessions (Order 9): what the thread element renders. The list finds
	// the sessions an agent dispatched from a conversation; the read follows one
	// session's event stream; answer and delegate are the owner's only writes.

	// Each copy of a session is stamped with when it was asked for (CodingSession.askedAt).

	listCodingSessions(sessionId: string): Promise<CodingSession[]> {
		const asked = performance.now();
		return this.cloud
			.rpc("qorpera_list_coding_sessions", { p_session_id: requiredUuid(sessionId, "Session id") })
			.then((value) => parseCodingSessions(value, asked));
	}

	readCodingSession(workerId: string, afterEvent = 0, limit = 200): Promise<CodingSessionRead> {
		const asked = performance.now();
		return this.cloud
			.rpc("qorpera_read_coding_session", {
				p_worker_id: requiredUuid(workerId, "Coding session id"),
				p_after_event: afterEvent,
				p_limit: limit,
			})
			.then((value) => parseCodingSessionRead(value, asked));
	}

	answerCodingSession(workerId: string, text: string, clientRequestId: string): Promise<CodingSession> {
		const asked = performance.now();
		return this.cloud
			.rpc("qorpera_answer_coding_session", {
				p_worker_id: requiredUuid(workerId, "Coding session id"),
				p_text: text,
				p_client_request_id: requiredUuid(clientRequestId, "Client request id"),
			})
			.then((value) => parseCodingSession(value, asked));
	}

	delegateCodingSession(workerId: string, clientRequestId: string): Promise<CodingSession> {
		const asked = performance.now();
		return this.cloud
			.rpc("qorpera_delegate_coding_session", {
				p_worker_id: requiredUuid(workerId, "Coding session id"),
				p_client_request_id: requiredUuid(clientRequestId, "Client request id"),
			})
			.then((value) => parseCodingSession(value, asked));
	}

	/** The owner archives a session: what it runs stops and it leaves its machine; its files stay. */
	archiveCodingSession(workerId: string, clientRequestId: string): Promise<CodingSession> {
		const asked = performance.now();
		return this.cloud
			.rpc("qorpera_archive_coding_session", {
				p_worker_id: requiredUuid(workerId, "Coding session id"),
				p_client_request_id: requiredUuid(clientRequestId, "Client request id"),
			})
			.then((value) => parseCodingSession(value, asked));
	}

	listSessionInputs(sessionId: string, afterPosition = 0, limit = 100): Promise<PendingSessionInputPage> {
		return this.cloud
			.rpc("qorpera_list_session_inputs", {
				p_session_id: requiredUuid(sessionId, "Session id"),
				p_after_position: afterPosition,
				p_limit: limit,
			})
			.then(parsePendingSessionInputs);
	}

	/** The company's saved secrets (references only: never a value). */
	listSecretConnections(profileId: string, environmentId: string): Promise<CloudSecretReference[]> {
		return this.cloud
			.rpc("qorpera_list_cloud_secret_connections", {
				p_profile_id: requiredUuid(profileId, "Profile id"),
				p_environment_id: requiredUuid(environmentId, "Environment id"),
			})
			.then(parseSecretReferences);
	}

	/** A one-time ticket to put a secret into the company's cloud custody. The
	 * value itself goes to the secret broker's origin (`captureSecret`), never
	 * through this RPC. */
	beginSecretCapture(input: {
		profileId: string;
		environmentId: string;
		ownerKind: "company" | "member";
		ownerUserId?: string;
		connectorId: string;
		secretName: string;
		purpose: string;
		existingSecretId?: string;
	}): Promise<CloudSecretCaptureTicket> {
		return this.cloud
			.rpc("qorpera_begin_cloud_secret_capture", {
				p_profile_id: requiredUuid(input.profileId, "Profile id"),
				p_environment_id: requiredUuid(input.environmentId, "Environment id"),
				p_owner_kind: input.ownerKind,
				p_owner_user_id: input.ownerUserId ? requiredUuid(input.ownerUserId, "Owner") : null,
				p_connector_id: input.connectorId,
				p_secret_name: input.secretName,
				p_purpose: input.purpose,
				p_existing_secret_id: input.existingSecretId ? requiredUuid(input.existingSecretId, "Secret id") : null,
			})
			.then(parseSecretCaptureTicket);
	}

	/** Post the plaintext to the secret broker, the one place that may see it.
	 * The ticket's capability is the only credential; nothing else identifies
	 * the member, and the answer carries a reference, never the value. Several
	 * companies' brokers can share one origin, each its own process: the company
	 * id (not a secret) lets the origin's router pick the company's broker, and a
	 * broker refuses a ticket of any other company. */
	async captureSecret(ticket: CloudSecretCaptureTicket, value: string): Promise<CloudSecretReference> {
		if (!value || value.length > 32 * 1024) throw new Error("The secret is empty or too long.");
		const route = `${ticket.serviceOrigin}/v1/captures/${ticket.ticketId}?company=${ticket.companyId}`;
		const response = await fetch(route, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				schema: "qorpera.cloud-secret-capture-request/v1",
				captureCapability: ticket.captureCapability,
				fields: { value },
			}),
			redirect: "error",
			credentials: "omit",
		});
		if (!response.ok) throw new Error("The secret could not be saved. Try again in a moment.");
		return parseSecretReference(await response.json());
	}

	/** Answer a typed card the agent raised (kernel bundle v70). Never a secret
	 * value: a secret card answers with its outcome only. The answer is delivered
	 * the way a message there is and runs on the member's own model account,
	 * which `sponsor` names: like a post in an agent's shared thread (bundle v100),
	 * like a turn request in a plain conversation (bundle v105). */
	answerInteraction(
		sessionId: string,
		clientInputId: string,
		interactionId: string,
		outcome: string,
		answer: Record<string, JsonValue> = {},
		sponsor?: { sponsorBindingId: string; sponsorVersion: number },
	): Promise<SessionInputReceipt> {
		return this.cloud
			.rpc("qorpera_answer_interaction", {
				p_session_id: requiredUuid(sessionId, "Session id"),
				p_client_input_id: requiredUuid(clientInputId, "Client input id"),
				p_interaction_id: requiredUuid(interactionId, "Interaction id"),
				p_outcome: outcome,
				p_answer: answer,
				...(sponsor
					? {
							p_sponsor_binding_id: requiredUuid(sponsor.sponsorBindingId, "Sponsor binding id"),
							p_sponsor_version: sponsor.sponsorVersion,
						}
					: {}),
			})
			.then(parseSessionInputReceipt);
	}

	/** Answer an approval card of an agent's action (kernel bundle v130). Allow once,
	 * Always allow (a built-in check's card only; saves `ruleText` as a company
	 * Allow rule) or Deny. When the agent stopped waiting, the answer wakes it on
	 * the member's own model account, which `sponsor` names. */
	answerActionReview(
		reviewId: string,
		clientInputId: string,
		answer: ActionReviewAnswer,
		ruleText: string | undefined,
		sponsor?: { sponsorBindingId: string; sponsorVersion: number },
	): Promise<ActionReviewReceipt> {
		return this.cloud
			.rpc("qorpera_answer_action_review", {
				p_review_id: requiredUuid(reviewId, "Approval id"),
				p_client_input_id: requiredUuid(clientInputId, "Client input id"),
				p_answer: answer,
				...(ruleText === undefined ? {} : { p_rule_text: ruleText }),
				...(sponsor
					? {
							p_sponsor_binding_id: requiredUuid(sponsor.sponsorBindingId, "Sponsor binding id"),
							p_sponsor_version: sponsor.sponsorVersion,
						}
					: {}),
			})
			.then(parseActionReviewReceipt);
	}

	/** The one member write into a conversation: a queued prompt. The mouth is
	 * server-side; this never produces agent text. */
	appendPrompt(sessionId: string, clientInputId: string, text: string): Promise<SessionInputReceipt> {
		return this.cloud
			.rpc("qorpera_append_session_input", {
				p_session_id: requiredUuid(sessionId, "Session id"),
				p_client_input_id: requiredUuid(clientInputId, "Client input id"),
				p_kind: "user_message",
				p_body: { schema: SESSION_PROMPT_SCHEMA, text, images: [] },
			})
			.then(parseSessionInputReceipt);
	}

	// Company File

	getCompanyFile(environmentId: string): Promise<HostedCompanyFile> {
		return this.cloud
			.rpc("qorpera_get_company_file", { p_environment_id: requiredUuid(environmentId, "Environment id") })
			.then(parseCompanyFile);
	}

	// Objects

	authorizeObjectDownload(profileId: string, sha256: string): Promise<{ backend: string; bytes: number }> {
		return this.cloud
			.rpc("qorpera_authorize_profile_object_download", {
				p_profile_id: requiredUuid(profileId, "Profile id"),
				p_sha256: sha256,
			})
			.then((value) => {
				const input = value as { backend?: unknown; bytes?: unknown };
				return { backend: String(input.backend ?? "unknown"), bytes: Number(input.bytes ?? 0) };
			});
	}

	// Feedback

	async submitFeedback(clientFeedbackId: string, category: string, details: string): Promise<void> {
		await this.cloud.rpc("qorpera_submit_product_feedback", {
			p_client_feedback_id: requiredUuid(clientFeedbackId, "Feedback id"),
			p_category: category,
			p_details: details,
			p_include_diagnostics: false,
			p_diagnostics: {},
		});
	}
}

/** A saved secret as the custody describes it: ids, names and owner, never a value. */
export interface CloudSecretReference {
	secretId: string;
	version: number;
	connectorId: string;
	secretName: string;
	purpose: string;
	ownerKind: "company" | "member";
	ownerUserId?: string;
	status: "active" | "revoked";
}

export interface CloudSecretCaptureTicket {
	ticketId: string;
	captureCapability: string;
	serviceOrigin: string;
	companyId: string;
	secretId: string;
	version: number;
	expiresAt: string;
}

function parseSecretReference(value: unknown): CloudSecretReference {
	const input = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	if (
		typeof input.secretId !== "string" ||
		!Number.isSafeInteger(input.version) ||
		typeof input.connectorId !== "string" ||
		typeof input.secretName !== "string" ||
		(input.ownerKind !== "company" && input.ownerKind !== "member") ||
		(input.status !== "active" && input.status !== "revoked")
	)
		throw new Error("The saved secret's description is invalid.");
	return {
		secretId: requiredUuid(input.secretId, "Secret id"),
		version: input.version as number,
		connectorId: input.connectorId,
		secretName: input.secretName,
		purpose: typeof input.purpose === "string" ? input.purpose : "",
		ownerKind: input.ownerKind,
		...(typeof input.ownerUserId === "string" ? { ownerUserId: input.ownerUserId } : {}),
		status: input.status,
	};
}

function parseSecretReferences(value: unknown): CloudSecretReference[] {
	return Array.isArray(value) ? value.map(parseSecretReference) : [];
}

function parseSecretCaptureTicket(value: unknown): CloudSecretCaptureTicket {
	const input = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	const scope =
		input.scope && typeof input.scope === "object" && !Array.isArray(input.scope)
			? (input.scope as Record<string, unknown>)
			: {};
	let origin: string;
	try {
		const url = new URL(String(input.serviceOrigin));
		if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) throw new Error("origin");
		origin = url.origin;
	} catch {
		throw new Error("The secret service is not set up for this company.");
	}
	if (
		input.schema !== "qorpera.cloud-secret-capture/v1" ||
		typeof input.ticketId !== "string" ||
		typeof input.captureCapability !== "string" ||
		typeof scope.companyId !== "string" ||
		typeof scope.secretId !== "string" ||
		!Number.isSafeInteger(scope.version) ||
		typeof input.expiresAt !== "string"
	)
		throw new Error("The secret ticket is invalid.");
	return {
		ticketId: requiredUuid(input.ticketId, "Ticket id"),
		captureCapability: input.captureCapability,
		serviceOrigin: origin,
		companyId: requiredUuid(scope.companyId, "Company id"),
		secretId: requiredUuid(scope.secretId, "Secret id"),
		version: scope.version as number,
		expiresAt: input.expiresAt,
	};
}
