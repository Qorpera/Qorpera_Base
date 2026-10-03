import type {
	CreatedCompanyResult,
	HostedAccountEntitlement,
	HostedAccountMatch,
	HostedCompanyFile,
	HostedCompanyProposal,
	HostedCompanyProposalComment,
	HostedCompanyProposalCommentPage,
	HostedCompanyProposalPage,
	HostedCompanyProposalReview,
	HostedCompanySnapshot,
	HostedCompanyWorkspace,
	HostedFriend,
	HostedIncomingProfileInvitation,
	HostedProfile,
	HostedProfileInvitation,
	HostedProfileMember,
	HostedProfileRole,
	HostedProfileTeam,
	HostedRunRecovery,
	HostedSession,
	HostedSessionAudience,
	HostedSessionEvent,
	HostedSessionEventType,
	HostedStaffAgent,
	HostedStaffExecutionActivity,
	JsonValue,
	PendingSessionInput,
	PendingSessionInputPage,
	SessionInputReceipt,
	StaffSessionHandle,
} from "./types.ts";
import { EXECUTION_SOURCE_KINDS, HOSTED_PROFILE_ROLES, HOSTED_SESSION_EVENT_TYPES } from "./types.ts";

/* Strict parsers ported from the desktop's hosted-primary.ts. Identities are
 * always validated; presentational fields tolerate absence where an older
 * deployed schema could legitimately omit them. */

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export class CloudShapeError extends Error {
	constructor(label: string) {
		super(`The cloud returned an invalid ${label}`);
		this.name = "CloudShapeError";
	}
}

export function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new CloudShapeError(label);
	return value as Record<string, unknown>;
}

export function array(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value)) throw new CloudShapeError(label);
	return value;
}

export function uuid(value: unknown, label: string): string {
	if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new CloudShapeError(label);
	return value.toLowerCase();
}

function optionalUuid(value: unknown, label: string): string | undefined {
	return value === null || value === undefined ? undefined : uuid(value, label);
}

export function nonEmptyString(value: unknown, label: string, maximum = 32 * 1024): string {
	if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new CloudShapeError(label);
	return value;
}

function optionalString(value: unknown, label: string, maximum = 32 * 1024): string | undefined {
	return value === null || value === undefined ? undefined : nonEmptyString(value, label, maximum);
}

export function timestamp(value: unknown, label: string): string {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new CloudShapeError(label);
	return value;
}

function optionalTimestamp(value: unknown, label: string): string | undefined {
	return value === null || value === undefined ? undefined : timestamp(value, label);
}

export function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw new CloudShapeError(label);
	}
	return value as number;
}

function optionalInteger(value: unknown, label: string, minimum: number): number | undefined {
	return value === null || value === undefined
		? undefined
		: boundedInteger(value, label, minimum, Number.MAX_SAFE_INTEGER);
}

export function oneOf<const T extends string>(value: unknown, values: readonly T[], label: string): T {
	if (typeof value !== "string" || !values.includes(value as T)) throw new CloudShapeError(label);
	return value as T;
}

export function jsonValue(value: unknown): JsonValue {
	if (value === undefined) return null;
	return value as JsonValue;
}

function role(value: unknown): HostedProfileRole {
	return oneOf(value, HOSTED_PROFILE_ROLES, "profile role");
}

export function parseProfile(value: unknown): HostedProfile {
	const input = record(value, "profile");
	return {
		profileId: uuid(input.profile_id, "profile id"),
		environmentId: uuid(input.environment_id, "environment id"),
		profileName: nonEmptyString(input.profile_name, "profile name", 512),
		environmentName: nonEmptyString(input.environment_name, "environment name", 512),
		role: role(input.role),
		contractVersion: boundedInteger(input.contract_version, "environment contract version", 1, 1000),
		createdAt: timestamp(input.created_at, "profile creation time"),
	};
}

export function parseProfiles(value: unknown): HostedProfile[] {
	return array(value, "profile list").map(parseProfile);
}

export function parseAccountEntitlement(value: unknown): HostedAccountEntitlement {
	const input = record(value, "account entitlement");
	const storageAllocationBytes = input.storage_allocation_bytes;
	return {
		planKey: nonEmptyString(input.plan_key, "account plan", 64),
		billingMode: nonEmptyString(input.billing_mode, "account billing mode", 64),
		featureSet: nonEmptyString(input.feature_set, "account feature set", 64),
		storageAllocation: nonEmptyString(input.storage_allocation, "account storage allocation", 64),
		...(Number.isSafeInteger(storageAllocationBytes)
			? { storageAllocationBytes: storageAllocationBytes as number }
			: {}),
		source: nonEmptyString(input.source, "account entitlement source", 64),
		...(typeof input.updated_at === "string" ? { updatedAt: timestamp(input.updated_at, "entitlement time") } : {}),
	};
}

export function parseCreatedCompany(value: unknown): CreatedCompanyResult {
	const input = record(value, "created company");
	const profile = parseProfile(input);
	const state = input.bootstrap_state;
	if (state === "queued" || state === "leased" || state === "completed" || state === "blocked") {
		return { profile, bootstrapState: state };
	}
	return { profile };
}

function parseInvitationDelivery(value: unknown): HostedProfileInvitation["delivery"] {
	const input = record(value, "invitation delivery");
	return {
		status: nonEmptyString(input.status, "invitation delivery status", 64),
		attemptCount: boundedInteger(input.attempt_count, "invitation delivery attempts", 0, 1_000_000),
		nextAttemptAt: timestamp(input.next_attempt_at, "invitation delivery schedule"),
		...(typeof input.provider_message_id === "string" ? { providerMessageId: input.provider_message_id } : {}),
		...(typeof input.last_error === "string" && input.last_error ? { lastError: input.last_error } : {}),
		...(typeof input.sent_at === "string" ? { sentAt: timestamp(input.sent_at, "invitation sent time") } : {}),
	};
}

export function parseInvitation(value: unknown): HostedProfileInvitation {
	const input = record(value, "profile invitation");
	const invitationRole = role(input.role);
	if (invitationRole === "owner") throw new CloudShapeError("invitation role");
	const delivery =
		input.delivery === null || input.delivery === undefined ? undefined : parseInvitationDelivery(input.delivery);
	return {
		id: uuid(input.id, "invitation id"),
		profileId: uuid(input.profile_id, "invitation profile id"),
		email: nonEmptyString(input.email, "invitation email", 320),
		role: invitationRole,
		invitedByUserId: uuid(input.invited_by_user_id, "invitation actor id"),
		createdAt: timestamp(input.created_at, "invitation creation time"),
		expiresAt: timestamp(input.expires_at, "invitation expiry"),
		...(delivery ? { delivery } : {}),
	};
}

export function parseIncomingInvitations(value: unknown): HostedIncomingProfileInvitation[] {
	return array(value, "incoming invitation list").map((item) => {
		const invitation = parseInvitation(item);
		const input = record(item, "incoming invitation");
		return {
			...invitation,
			environmentId: uuid(input.environment_id, "invitation environment id"),
			profileName: nonEmptyString(input.profile_name, "invitation profile name", 512),
			environmentName: nonEmptyString(input.environment_name, "invitation environment name", 512),
		};
	});
}

function parseFriend(value: unknown): HostedFriend {
	const input = record(value, "friend");
	const status = input.status === "accepted" ? "accepted" : "pending";
	return {
		userId: uuid(input.user_id, "friend user id"),
		email: nonEmptyString(input.email, "friend email", 320),
		displayName: nonEmptyString(input.display_name, "friend display name", 256),
		status,
		direction: input.direction === "outgoing" ? "outgoing" : "incoming",
		since: timestamp(input.since, "friend time"),
	};
}

export function parseFriends(value: unknown): HostedFriend[] {
	return array(value, "friend list").map(parseFriend);
}

/** Null when no account holds the address. */
export function parseAccountMatch(value: unknown): HostedAccountMatch | null {
	if (value === null || value === undefined) return null;
	const input = record(value, "account");
	if (typeof input.self !== "boolean") throw new CloudShapeError("account self flag");
	return {
		userId: uuid(input.user_id, "account user id"),
		email: nonEmptyString(input.email, "account email", 320),
		displayName: nonEmptyString(input.display_name, "account display name", 256),
		self: input.self,
	};
}

function parseMember(value: unknown): HostedProfileMember {
	const input = record(value, "profile member");
	const avatarUrl = optionalString(input.avatar_url, "member avatar", 2048);
	return {
		userId: uuid(input.user_id, "member user id"),
		email: nonEmptyString(input.email, "member email", 320),
		displayName: nonEmptyString(input.display_name, "member display name", 256),
		...(avatarUrl ? { avatarUrl } : {}),
		role: role(input.role),
		joinedAt: timestamp(input.joined_at, "member join time"),
	};
}

export function parseTeam(value: unknown): HostedProfileTeam {
	const input = record(value, "profile team");
	const teamRole = role(input.role);
	const capabilities = record(input.capabilities, "profile capabilities");
	if (
		capabilities.read !== true ||
		typeof capabilities.write !== "boolean" ||
		typeof capabilities.authorize !== "boolean"
	) {
		throw new CloudShapeError("profile capabilities");
	}
	const manageMembers =
		typeof capabilities.manage_members === "boolean" ? capabilities.manage_members : capabilities.authorize;
	const flag = (value: unknown) => (typeof value === "boolean" ? value : undefined);
	const manageFounders = flag(capabilities.manage_founders);
	const leave = flag(capabilities.leave);
	const deleteCompany = flag(capabilities.delete_company);
	return {
		profileId: uuid(input.profile_id, "team profile id"),
		role: teamRole,
		capabilities: {
			read: true,
			write: capabilities.write,
			authorize: capabilities.authorize,
			manageMembers,
			...(manageFounders === undefined ? {} : { manageFounders }),
			...(leave === undefined ? {} : { leave }),
			...(deleteCompany === undefined ? {} : { deleteCompany }),
		},
		members: array(input.members, "profile member list").map(parseMember),
		invitations: array(input.invitations, "profile invitation list").map(parseInvitation),
	};
}

function parseSessionAudience(input: Record<string, unknown>): HostedSessionAudience {
	const kind = input.audience_kind;
	const userId = input.audience_user_id;
	if ((kind === "company" || kind === undefined) && (userId === null || userId === undefined))
		return { kind: "company" };
	if (kind === "member_private" && typeof userId === "string") {
		return { kind: "member_private", userId: uuid(userId, "session audience user id") };
	}
	throw new CloudShapeError("session audience");
}

export function parseSession(value: unknown): HostedSession {
	const input = record(value, "session");
	const status = oneOf(input.status, ["open", "closed"], "session status");
	const scope = input.execution_scope;
	const executionScope =
		scope && typeof scope === "object" && !Array.isArray(scope) ? (scope as Record<string, JsonValue>) : undefined;
	const staffAgentId = optionalString(input.staff_agent_id, "staff agent id", 128);
	const parentSessionId = optionalUuid(input.parent_session_id, "parent session id");
	const companySnapshotId = optionalUuid(input.company_snapshot_id, "session company snapshot id");
	const staffVersion = optionalInteger(input.staff_version, "session staff version", 1);
	return {
		sessionId: uuid(input.session_id, "session id"),
		clientSessionId: uuid(input.client_session_id, "client session id"),
		profileId: uuid(input.profile_id, "session profile id"),
		environmentId: uuid(input.environment_id, "session environment id"),
		title: typeof input.title === "string" && input.title.trim() ? input.title : "Conversation",
		...(staffAgentId ? { staffAgentId } : {}),
		...(parentSessionId ? { parentSessionId } : {}),
		...(executionScope ? { executionScope } : {}),
		...(companySnapshotId ? { companySnapshotId } : {}),
		...(staffVersion ? { staffVersion } : {}),
		audience: parseSessionAudience(input),
		status,
		createdByUserId: uuid(input.created_by_user_id, "session creator id"),
		createdAt: timestamp(input.created_at, "session creation time"),
		updatedAt: timestamp(input.updated_at, "session update time"),
	};
}

export function parseSessions(value: unknown): HostedSession[] {
	return array(value, "session list").map(parseSession);
}

export interface AgentThreadHandle {
	sessionId: string;
	roomId: string;
	staffAgentId: string;
	status: "active" | "archived";
}
export function parseAgentThreadHandle(value: unknown): AgentThreadHandle {
	const input = record(value, "agent thread");
	if (input.schema !== "qorpera.agent-thread/v1" || (input.status !== "active" && input.status !== "archived"))
		throw new Error("Invalid agent thread.");
	return {
		sessionId: uuid(input.session_id, "agent thread session id"),
		roomId: uuid(input.room_id, "agent thread room id"),
		staffAgentId: uuid(input.staff_agent_id, "agent thread staff id"),
		status: input.status,
	};
}
export function parseStaffSessionHandle(value: unknown): StaffSessionHandle {
	const input = record(value, "staff session");
	const companySnapshotId = optionalUuid(input.company_snapshot_id, "session Company File revision");
	const staffVersion = optionalInteger(input.staff_version, "session staff version", 1);
	return {
		sessionId: uuid(input.session_id, "session id"),
		clientSessionId: uuid(input.client_session_id, "client session id"),
		environmentId: uuid(input.environment_id, "environment id"),
		title: String(input.title ?? ""),
		...(companySnapshotId ? { companySnapshotId } : {}),
		...(staffVersion ? { staffVersion } : {}),
		audience: parseSessionAudience(input),
		created: input.created === true,
		createdByUserId: uuid(input.created_by_user_id, "session creator"),
		createdAt: timestamp(input.created_at, "session creation time"),
	};
}

export function parseSessionInputReceipt(value: unknown): SessionInputReceipt {
	const input = record(value, "session input receipt");
	return {
		inputId: uuid(input.input_id, "session input id"),
		position: boundedInteger(input.position, "session input position", 1, Number.MAX_SAFE_INTEGER),
	};
}

export function parsePendingSessionInputs(value: unknown): PendingSessionInputPage {
	const page = record(value, "pending session input page");
	const items = array(page.items, "pending session inputs").map((entry): PendingSessionInput => {
		const input = record(entry, "pending session input");
		const status = input.status === "processing" ? "processing" : input.status === "failed" ? "failed" : "queued";
		const failureReason = optionalString(input.failure_reason, "input failure reason", 4096);
		return {
			inputId: uuid(input.input_id, "input id"),
			position: boundedInteger(input.position, "input position", 1, Number.MAX_SAFE_INTEGER),
			kind: input.kind === "kickoff" ? "kickoff" : "user_message",
			authorUserId: uuid(input.author_user_id, "input author"),
			authorDisplayName:
				typeof input.author_display_name === "string" && input.author_display_name.trim()
					? input.author_display_name
					: "Member",
			body: jsonValue(input.body ?? {}),
			createdAt: timestamp(input.created_at, "input created at"),
			status,
			...(failureReason ? { failureReason } : {}),
		};
	});
	return {
		items,
		nextAfterPosition: boundedInteger(page.next_after_position ?? 0, "input cursor", 0, Number.MAX_SAFE_INTEGER),
		hasMore: page.has_more === true,
	};
}

export function parseStaff(value: unknown): HostedStaffAgent {
	const input = record(value, "staff agent");
	const appearance =
		input.appearance && typeof input.appearance === "object" ? (input.appearance as Record<string, unknown>) : {};
	const color = optionalString(input.appearance_color ?? appearance.color, "staff appearance color", 64);
	const shape = optionalString(input.appearance_shape ?? appearance.shape, "staff appearance shape", 64);
	const creature = optionalString(input.appearance_creature ?? appearance.creature, "staff appearance creature", 64);
	const modelProvider = optionalString(input.model_provider, "staff model provider", 128);
	const modelId = optionalString(input.model_id, "staff model id", 256);
	const templateId = optionalString(input.template_id, "staff template id", 256);
	// Carried so a write can hand it straight back; the client never reads it.
	const departmentId = optionalString(input.department_id, "staff department id", 256);
	return {
		profileId: uuid(input.profile_id, "staff profile id"),
		id: uuid(input.staff_agent_id ?? input.id, "staff agent id"),
		displayName: nonEmptyString(input.display_name, "staff display name", 160),
		role: typeof input.role === "string" && input.role.trim() ? input.role : "Staff",
		charter: typeof input.charter === "string" ? input.charter : "",
		...(templateId ? { templateId } : {}),
		...(departmentId ? { departmentId } : {}),
		appearance: { color: color ?? "slate", shape: shape ?? "round", ...(creature ? { creature } : {}) },
		...(modelProvider && modelId ? { model: { provider: modelProvider, modelId } } : {}),
		employmentStatus: input.employment_status === "archived" ? "archived" : "active",
		lifecycleState: input.lifecycle_state === "setup" ? "setup" : "active",
		version: boundedInteger(input.version ?? 1, "staff version", 1, Number.MAX_SAFE_INTEGER),
		createdAt: timestamp(input.created_at, "staff creation time"),
		updatedAt: timestamp(input.updated_at, "staff update time"),
		updatedByUserId: uuid(input.updated_by_user_id, "staff updating user id"),
	};
}

export function parseStaffList(value: unknown): HostedStaffAgent[] {
	const raw = Array.isArray(value) ? value : record(value, "staff list").items;
	return array(raw, "staff list").map(parseStaff);
}

export function parseStaffExecutionActivity(value: unknown): HostedStaffExecutionActivity[] {
	return array(value, "staff execution activity").map((entry) => {
		const activity = record(entry, "staff execution activity");
		return {
			runId: uuid(activity.run_id, "activity run id"),
			staffAgentId: uuid(activity.staff_agent_id, "activity staff id"),
			sourceKind: oneOf(activity.source_kind, EXECUTION_SOURCE_KINDS, "activity source"),
			jobStatus: oneOf(activity.job_status, ["queued", "leased", "completed", "failed", "cancelled"], "job status"),
			activity: oneOf(activity.activity, ["waiting", "working", "needs_attention"], "activity state"),
			...(activity.phase === "writing" || activity.phase === "working" ? { phase: activity.phase } : {}),
			...(activity.no_progress_since === undefined || activity.no_progress_since === null
				? {}
				: { noProgressSince: timestamp(activity.no_progress_since, "activity stall time") }),
			updatedAt: timestamp(activity.updated_at, "activity time"),
		};
	});
}

export function parseRunRecovery(value: unknown): HostedRunRecovery {
	const recovery = record(value, "run recovery");
	const run = record(recovery.run, "recovery run");
	const job = record(recovery.job, "recovery job");
	const operations = array(recovery.operations ?? [], "recovery operations").map((entry) =>
		record(entry, "recovery operation"),
	);
	// The error is shown to the member as found; a missing or odd one is not a reason to hide the run.
	const lastError = typeof job.last_error === "string" ? job.last_error.trim().slice(0, 500) : "";
	return {
		runId: uuid(run.run_id, "recovery run id"),
		sourceKind: oneOf(run.source_kind, EXECUTION_SOURCE_KINDS, "recovery source"),
		jobStatus: oneOf(job.status, ["failed", "cancelled"], "recovery job status"),
		...(lastError ? { lastError } : {}),
		...(recovery.proposal_id ? { proposalId: uuid(recovery.proposal_id, "recovery proposal id") } : {}),
		// Absent before 20260929910000: then only the error text can tell.
		...(typeof recovery.usage_limit === "boolean" ? { usageLimit: recovery.usage_limit } : {}),
		// Absent before 20260929993000: then a plan's limit reads as any account's.
		...(typeof recovery.paid_by_chatgpt_plan === "boolean"
			? { paidByChatgptPlan: recovery.paid_by_chatgpt_plan }
			: {}),
		...(typeof run.requested_by_user_id === "string" && UUID_PATTERN.test(run.requested_by_user_id)
			? { requestedByUserId: run.requested_by_user_id.toLowerCase() }
			: {}),
		unsettledOperations: operations.filter(
			(operation) => operation.status === "executing" || operation.status === "ambiguous",
		).length,
	};
}

/** qorpera_resolve_failed_execution_run answers with the run it resolved and the action taken. */
export function parseRunResolution(value: unknown, runId: string, action: "discard" | "retry" | "acknowledge"): void {
	const result = record(value, `run ${action}`);
	if (
		uuid(result.run_id, `${action} run id`) !== runId.toLowerCase() ||
		result.action !== action ||
		result.resolved !== true
	) {
		throw new CloudShapeError(`run ${action}`);
	}
}

/** qorpera_retry_room_delivery: the same post wakes the same agent once more. */
export function parseRoomDeliveryRetry(value: unknown, runId: string): void {
	const result = record(value, "room delivery retry");
	if (
		result.schema !== "qorpera.company-room-retry/v1" ||
		uuid(result.runId, "retried run id") !== runId.toLowerCase()
	)
		throw new CloudShapeError("room delivery retry");
	uuid(result.occurrenceId, "retry occurrence id");
}

function sessionEventType(value: unknown): HostedSessionEventType {
	return oneOf(value, HOSTED_SESSION_EVENT_TYPES, "session event type");
}

export function parseEvent(value: unknown): HostedSessionEvent {
	const input = record(value, "session event");
	const previousHash = input.previous_hash;
	if (typeof input.event_hash !== "string" || !SHA256_PATTERN.test(input.event_hash)) {
		throw new CloudShapeError("event hash");
	}
	const executionKind = input.execution_kind;
	const sessionInputId = optionalUuid(input.session_input_id, "event session input id");
	let execution: HostedSessionEvent["execution"];
	if (executionKind === "run") {
		execution = {
			kind: "run",
			id: uuid(input.execution_id, "event execution id"),
			claimantId: uuid(input.execution_claimant_id, "event claimant id"),
			runnerAssignmentId: uuid(input.runner_assignment_id, "event runner assignment id"),
		};
	} else if (executionKind === "turn" || executionKind === "wake") {
		execution = {
			kind: executionKind,
			id: uuid(input.execution_id, "event execution id"),
			claimantId: uuid(input.execution_claimant_id, "event claimant id"),
		};
	}
	let staffSpeaker: HostedSessionEvent["staffSpeaker"];
	if (input.staff_speaker !== undefined && input.staff_speaker !== null) {
		const speaker = record(input.staff_speaker, "staff speaker");
		const runId = uuid(speaker.run_id, "speaker run id");
		if (
			Object.keys(speaker).some(
				(key) => !["run_id", "staff_agent_id", "staff_version", "display_name"].includes(key),
			) ||
			execution?.kind !== "run" ||
			execution.id !== runId ||
			sessionInputId ||
			(speaker.display_name !== null &&
				(typeof speaker.display_name !== "string" ||
					!speaker.display_name.trim() ||
					speaker.display_name.length > 512))
		)
			throw new CloudShapeError("staff speaker");
		staffSpeaker = {
			runId,
			staffAgentId: uuid(speaker.staff_agent_id, "speaker staff id"),
			staffVersion: boundedInteger(speaker.staff_version, "speaker staff version", 1, Number.MAX_SAFE_INTEGER),
			...(typeof speaker.display_name === "string" ? { displayName: speaker.display_name } : {}),
		};
	}
	return {
		sessionId: uuid(input.session_id, "event session id"),
		sequence: boundedInteger(input.sequence, "event sequence", 1, Number.MAX_SAFE_INTEGER),
		eventId: uuid(input.event_id, "event id"),
		eventType: sessionEventType(input.event_type),
		actorUserId: uuid(input.actor_user_id, "event actor id"),
		body: jsonValue(input.body),
		...(typeof previousHash === "string" && SHA256_PATTERN.test(previousHash) ? { previousHash } : {}),
		eventHash: input.event_hash,
		...(execution ? { execution } : {}),
		...(staffSpeaker ? { staffSpeaker } : {}),
		...(sessionInputId ? { sessionInputId } : {}),
		createdAt: timestamp(input.created_at, "event creation time"),
	};
}

export function parseEvents(value: unknown): HostedSessionEvent[] {
	return array(value, "session event list").map(parseEvent);
}

export function parseCompanyFile(value: unknown): HostedCompanyFile {
	const input = record(value, "company file");
	const headSnapshotId = optionalUuid(input.head_snapshot_id, "company file head snapshot id");
	const entitlement =
		input.entitlement && typeof input.entitlement === "object"
			? parseAccountEntitlement(input.entitlement)
			: undefined;
	return {
		profileId: uuid(input.profile_id, "company file profile id"),
		environmentId: uuid(input.environment_id, "company file environment id"),
		canonicalWorkspaceId: uuid(input.canonical_workspace_id, "company file workspace id"),
		...(headSnapshotId ? { headSnapshotId } : {}),
		state: oneOf(input.state, ["provisioning", "ready"], "company file state"),
		logicalBytes: boundedInteger(input.logical_bytes ?? 0, "company file logical bytes", 0, Number.MAX_SAFE_INTEGER),
		retainedStorageBytes: boundedInteger(
			input.retained_storage_bytes ?? 0,
			"company file retained storage",
			0,
			Number.MAX_SAFE_INTEGER,
		),
		storageUsedBytes: boundedInteger(
			input.storage_used_bytes ?? 0,
			"company file storage",
			0,
			Number.MAX_SAFE_INTEGER,
		),
		storageLimitBytes: boundedInteger(
			input.storage_limit_bytes ?? 0,
			"company file storage allowance",
			0,
			Number.MAX_SAFE_INTEGER,
		),
		objectBackends: Array.isArray(input.object_backends) ? input.object_backends.map(String) : [],
		...(entitlement ? { entitlement } : {}),
		createdAt: timestamp(input.created_at, "company file creation time"),
		updatedAt: timestamp(input.updated_at, "company file update time"),
	};
}

export function parseCompanyWorkspaces(value: unknown): HostedCompanyWorkspace[] {
	return array(value, "company workspace list").map((entry) => {
		const input = record(entry, "company workspace");
		const headSnapshotId = optionalUuid(input.head_snapshot_id, "workspace head snapshot id");
		return {
			workspaceId: uuid(input.workspace_id, "workspace id"),
			profileId: uuid(input.profile_id, "workspace profile id"),
			environmentId: uuid(input.environment_id, "workspace environment id"),
			clientWorkspaceId: uuid(input.client_workspace_id, "client workspace id"),
			name: typeof input.name === "string" && input.name.trim() ? input.name : "Workspace",
			...(headSnapshotId ? { headSnapshotId } : {}),
			createdByUserId: uuid(input.created_by_user_id, "workspace creator id"),
			createdAt: timestamp(input.created_at, "workspace creation time"),
			updatedAt: timestamp(input.updated_at, "workspace update time"),
		};
	});
}

export function parseCompanySnapshot(value: unknown): HostedCompanySnapshot {
	const input = record(value, "company snapshot");
	if (typeof input.tree_manifest_sha256 !== "string" || !SHA256_PATTERN.test(input.tree_manifest_sha256)) {
		throw new CloudShapeError("company tree manifest hash");
	}
	const parentSnapshotId = optionalUuid(input.parent_snapshot_id, "parent snapshot id");
	const publicationState = input.publication_state;
	return {
		snapshotId: uuid(input.snapshot_id, "snapshot id"),
		profileId: uuid(input.profile_id, "snapshot profile id"),
		environmentId: uuid(input.environment_id, "snapshot environment id"),
		workspaceId: uuid(input.workspace_id, "snapshot workspace id"),
		clientSnapshotId: uuid(input.client_snapshot_id, "client snapshot id"),
		...(parentSnapshotId ? { parentSnapshotId } : {}),
		tree: {
			manifestSha256: input.tree_manifest_sha256,
			manifestBytes: boundedInteger(input.tree_manifest_bytes, "tree manifest bytes", 1, Number.MAX_SAFE_INTEGER),
			contractVersion: boundedInteger(input.tree_contract_version, "tree contract version", 1, 100),
			fileCount: boundedInteger(input.file_count, "tree file count", 0, Number.MAX_SAFE_INTEGER),
			totalBytes: boundedInteger(input.total_bytes, "tree total bytes", 0, Number.MAX_SAFE_INTEGER),
		},
		createdByUserId: uuid(input.created_by_user_id, "snapshot creator id"),
		createdAt: timestamp(input.created_at, "snapshot creation time"),
		...(publicationState === "prepared" || publicationState === "published" ? { publicationState } : {}),
	};
}

export function parseCompanySnapshots(value: unknown): HostedCompanySnapshot[] {
	return array(value, "company snapshot list").map(parseCompanySnapshot);
}

function parseProposalReview(value: unknown): HostedCompanyProposalReview {
	const review = record(value, "company proposal review");
	const runId = optionalUuid(review.run_id, "review run id");
	const commentId = optionalUuid(review.comment_id, "review comment id");
	const failureReason = optionalString(review.failure_reason, "review failure", 4000);
	const startedAt = optionalTimestamp(review.started_at, "review start time");
	const completedAt = optionalTimestamp(review.completed_at, "review completion time");
	return {
		assignmentId: uuid(review.assignment_id, "review assignment id"),
		proposalRevision: boundedInteger(review.proposal_revision, "review revision", 1, Number.MAX_SAFE_INTEGER),
		reviewerStaffAgentId: uuid(review.reviewer_staff_agent_id, "reviewer staff id"),
		reviewerName: typeof review.reviewer_name === "string" ? review.reviewer_name : "Reviewer",
		status: oneOf(review.status, ["queued", "running", "approved", "changes_requested", "failed"], "review status"),
		...(runId ? { runId } : {}),
		...(commentId ? { commentId } : {}),
		...(failureReason ? { failureReason } : {}),
		createdAt: timestamp(review.created_at, "review creation time"),
		...(startedAt ? { startedAt } : {}),
		...(completedAt ? { completedAt } : {}),
	};
}

export function parseCompanyProposal(value: unknown): HostedCompanyProposal {
	const input = record(value, "company proposal");
	const sessionId = optionalUuid(input.session_id, "proposal session id");
	const policyKey = optionalString(input.policy_key, "proposal policy", 128);
	const resolvedByUserId = optionalUuid(input.resolved_by_user_id, "proposal resolver id");
	const resolvedAt = optionalTimestamp(input.resolved_at, "proposal resolution time");
	return {
		proposalId: uuid(input.proposal_id, "proposal id"),
		profileId: uuid(input.profile_id, "proposal profile id"),
		environmentId: uuid(input.environment_id, "proposal environment id"),
		clientProposalId: uuid(input.client_proposal_id, "client proposal id"),
		baseSnapshotId: uuid(input.base_snapshot_id, "proposal base snapshot id"),
		proposalSnapshot: parseCompanySnapshot(input.proposal_snapshot),
		execution: {
			kind: oneOf(input.execution_kind, ["turn", "wake", "run"], "proposal execution kind"),
			id: uuid(input.execution_id, "proposal execution id"),
			claimantId: uuid(input.execution_claimant_id, "proposal claimant id"),
		},
		...(sessionId ? { sessionId } : {}),
		trailEndSequence: boundedInteger(
			input.trail_end_sequence ?? 0,
			"proposal trail sequence",
			0,
			Number.MAX_SAFE_INTEGER,
		),
		reason: oneOf(input.reason, ["policy", "authority", "conflict", "recovery"], "proposal reason"),
		...(policyKey ? { policyKey } : {}),
		title: typeof input.title === "string" && input.title.trim() ? input.title : "Proposal",
		reviewerStaffIds: array(input.reviewer_staff_ids ?? [], "proposal reviewers").map((id) =>
			uuid(id, "reviewer id"),
		),
		reviewRevision: boundedInteger(
			input.review_revision ?? 1,
			"proposal review revision",
			1,
			Number.MAX_SAFE_INTEGER,
		),
		reviews: array(input.reviews ?? [], "proposal reviews").map(parseProposalReview),
		status: oneOf(input.status, ["open", "accepted", "rejected"], "proposal status"),
		createdByUserId: uuid(input.created_by_user_id, "proposal creator id"),
		createdByName: typeof input.created_by_name === "string" ? input.created_by_name : "Member",
		createdAt: timestamp(input.created_at, "proposal creation time"),
		...(resolvedByUserId ? { resolvedByUserId } : {}),
		...(resolvedAt ? { resolvedAt } : {}),
	};
}

export function parseCompanyProposalPage(value: unknown): HostedCompanyProposalPage {
	const page = record(value, "company proposal page");
	const nextCreatedAt = optionalTimestamp(page.next_created_at, "proposal cursor time");
	const nextId = optionalUuid(page.next_id, "proposal cursor id");
	return {
		items: array(page.items, "company proposals").map(parseCompanyProposal),
		hasMore: page.has_more === true,
		...(nextCreatedAt ? { nextCreatedAt } : {}),
		...(nextId ? { nextId } : {}),
	};
}

export function parseSessionPage(value: unknown) {
	const page = record(value, "session page");
	return {
		items: parseSessions(page.items),
		hasMore: page.has_more === true,
		nextTime: optionalTimestamp(page.next_updated_at, "session cursor time"),
		nextId: optionalUuid(page.next_id, "session cursor id"),
	};
}

export function parseCompanyProposalComment(value: unknown): HostedCompanyProposalComment {
	const input = record(value, "company proposal comment");
	const authorUserId = optionalUuid(input.author_user_id, "comment author id");
	const authorStaffAgentId = optionalUuid(input.author_staff_agent_id, "comment staff author id");
	return {
		commentId: uuid(input.comment_id, "comment id"),
		proposalId: uuid(input.proposal_id, "comment proposal id"),
		body: typeof input.body === "string" ? input.body : "",
		...(authorUserId ? { authorUserId } : {}),
		...(authorStaffAgentId ? { authorStaffAgentId } : {}),
		authorName: typeof input.author_name === "string" ? input.author_name : "Author",
		createdAt: timestamp(input.created_at, "comment creation time"),
	};
}

export function parseCompanyProposalCommentPage(value: unknown): HostedCompanyProposalCommentPage {
	const page = record(value, "company proposal comment page");
	const nextCreatedAt = optionalTimestamp(page.next_created_at, "comment cursor time");
	const nextId = optionalUuid(page.next_id, "comment cursor id");
	return {
		items: array(page.items, "company proposal comments").map(parseCompanyProposalComment),
		hasMore: page.has_more === true,
		...(nextCreatedAt ? { nextCreatedAt } : {}),
		...(nextId ? { nextId } : {}),
	};
}
