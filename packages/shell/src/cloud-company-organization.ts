import type { HostedStaffAgent } from "./hosted-primary.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface HostedOrganizationMembership {
	staffAgentId: string;
	role: string;
	status: "active" | "ended";
}

export interface HostedOrganizationMeasureSource {
	path: string;
	pathMatch: "exact" | "subtree";
	sourcePathVersion: string;
	sourceSnapshotId: string;
	sourceFileSha256?: string;
}

export interface HostedOrganizationMeasure {
	measureId: string;
	key: string;
	label: string;
	status: "active" | "paused" | "retired";
	sources: HostedOrganizationMeasureSource[];
}

/**
 * A responsibility is the owned outcome with exactly one accountable agent
 * (contract 14.3). It has no lead, officer, or member list.
 */
export interface HostedOrganizationResponsibility {
	responsibilityId: string;
	slug: string;
	name: string;
	status: "proposed" | "active" | "degraded" | "paused" | "retired";
	accountableStaffAgentId: string;
	accountableUserId?: string;
	attentionCadence: string;
	measures: HostedOrganizationMeasure[];
	version: number;
	sourcePath: string;
	sourcePathVersion: string;
	sourceSnapshotId: string;
	sourceFileSha256: string;
}

export interface HostedOrganizationProject {
	projectId: string;
	key: string;
	name: string;
	status: "proposed" | "active" | "blocked" | "completed" | "cancelled";
	sponsoringResponsibilityId?: string;
	leadStaffAgentId: string;
	roomId?: string;
	staff: HostedOrganizationMembership[];
	version: number;
	sourcePath: string;
	sourcePathVersion: string;
	sourceSnapshotId: string;
	sourceFileSha256: string;
}

export interface HostedCompanyOrganization {
	schema: "qorpera.company-organization/v1";
	profileId: string;
	cofounder: {
		staffAgentId: string;
		formationId: string;
		memberSessionId?: string;
	};
	formation: {
		formationId: string;
		state:
			| "source_inventory"
			| "discovery"
			| "research"
			| "vision_proposal"
			| "goals_ratified"
			| "responsibility_map"
			| "operating";
		status: "active" | "completed" | "paused";
		revision: number;
		sourcePath: string;
		sourcePathVersion: string;
		sourceSnapshotId: string;
		sourceFileSha256: string;
	};
	responsibilities: HostedOrganizationResponsibility[];
	projects: HostedOrganizationProject[];
}

export interface CompanyOrganizationHierarchyNode {
	id: string;
	kind: "cofounder" | "responsibility" | "project" | "room" | "agent";
	label: string;
	status: string;
	role?: string;
	canonicalId: string;
	children: CompanyOrganizationHierarchyNode[];
}

export interface CompanyOrganizationHierarchy {
	schema: "qorpera.company-organization-hierarchy/v1";
	profileId: string;
	formationState: HostedCompanyOrganization["formation"]["state"];
	primary: CompanyOrganizationHierarchyNode[];
	inactive: CompanyOrganizationHierarchyNode[];
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Hosted primary returned invalid ${label}`);
	}
	return value as Record<string, unknown>;
}

function exact(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
	const input = record(value, label);
	if (Object.keys(input).length !== keys.length || keys.some((key) => !Object.hasOwn(input, key))) {
		throw new Error(`Hosted primary returned invalid ${label}`);
	}
	return input;
}

function uuid(value: unknown, label: string): string {
	if (typeof value !== "string" || !UUID.test(value)) throw new Error(`Hosted primary returned invalid ${label}`);
	return value;
}

function nullableUuid(value: unknown, label: string): string | undefined {
	return value === null ? undefined : uuid(value, label);
}

function text(value: unknown, label: string, maximum = 32 * 1024): string {
	if (typeof value !== "string" || !value.trim() || value !== value.trim() || Buffer.byteLength(value) > maximum) {
		throw new Error(`Hosted primary returned invalid ${label}`);
	}
	return value;
}

function integer(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) {
		throw new Error(`Hosted primary returned invalid ${label}`);
	}
	return value as number;
}

function status<const T extends string>(value: unknown, values: readonly T[], label: string): T {
	if (typeof value !== "string" || !values.includes(value as T)) {
		throw new Error(`Hosted primary returned invalid ${label}`);
	}
	return value as T;
}

function source(
	input: Record<string, unknown>,
	label: string,
): {
	sourcePath: string;
	sourcePathVersion: string;
	sourceSnapshotId: string;
	sourceFileSha256: string;
} {
	const sourceFileSha256 = input.source_file_sha256;
	if (typeof sourceFileSha256 !== "string" || !SHA256.test(sourceFileSha256)) {
		throw new Error(`Hosted primary returned invalid ${label} source hash`);
	}
	return {
		sourcePath: text(input.source_path, `${label} source path`, 4096),
		sourcePathVersion: uuid(input.source_path_version, `${label} source path version`),
		sourceSnapshotId: uuid(input.source_snapshot_id, `${label} source snapshot`),
		sourceFileSha256,
	};
}

function membership(value: unknown): HostedOrganizationMembership {
	const input = exact(value, "organization staff membership", ["staff_agent_id", "role", "status"]);
	return {
		staffAgentId: uuid(input.staff_agent_id, "organization staff id"),
		role: text(input.role, "organization staff role", 320),
		status: status(input.status, ["active", "ended"], "organization staff status"),
	};
}

function measureSource(value: unknown): HostedOrganizationMeasureSource {
	const input = exact(value, "responsibility measure source", [
		"path",
		"path_match",
		"source_path_version",
		"source_snapshot_id",
		"source_file_sha256",
	]);
	const pathMatch = status(input.path_match, ["exact", "subtree"], "responsibility measure source match");
	const sourceFileSha256 = input.source_file_sha256;
	if (
		(pathMatch === "exact") !== (typeof sourceFileSha256 === "string") ||
		(typeof sourceFileSha256 === "string" && !SHA256.test(sourceFileSha256)) ||
		(sourceFileSha256 !== null && typeof sourceFileSha256 !== "string")
	) {
		throw new Error("Hosted primary returned invalid responsibility measure source hash");
	}
	return {
		path: text(input.path, "responsibility measure source path", 4096),
		pathMatch,
		sourcePathVersion: uuid(input.source_path_version, "responsibility measure source version"),
		sourceSnapshotId: uuid(input.source_snapshot_id, "responsibility measure source snapshot"),
		...(typeof sourceFileSha256 === "string" ? { sourceFileSha256 } : {}),
	};
}

function measure(value: unknown): HostedOrganizationMeasure {
	const input = record(value, "responsibility measure");
	const required = ["measure_id", "key", "label", "status", "sources"] as const;
	if (required.some((key) => !Object.hasOwn(input, key)) || !Array.isArray(input.sources) || !input.sources.length) {
		throw new Error("Hosted primary returned invalid responsibility measure");
	}
	return {
		measureId: uuid(input.measure_id, "responsibility measure id"),
		key: text(input.key, "responsibility measure key", 96),
		label: text(input.label, "responsibility measure label", 256),
		status: status(input.status, ["active", "paused", "retired"], "responsibility measure status"),
		sources: input.sources.map(measureSource),
	};
}

function responsibility(value: unknown): HostedOrganizationResponsibility {
	const input = record(value, "company responsibility");
	const required = [
		"responsibility_id",
		"slug",
		"name",
		"status",
		"accountable_staff_agent_id",
		"accountable_user_id",
		"attention_cadence",
		"measures",
		"version",
		"source_path",
		"source_path_version",
		"source_snapshot_id",
		"source_file_sha256",
	] as const;
	if (required.some((key) => !Object.hasOwn(input, key)) || !Array.isArray(input.measures) || !input.measures.length) {
		throw new Error("Hosted primary returned invalid company responsibility");
	}
	return {
		responsibilityId: uuid(input.responsibility_id, "responsibility id"),
		slug: text(input.slug, "responsibility slug", 64),
		name: text(input.name, "responsibility name", 160),
		status: status(input.status, ["proposed", "active", "degraded", "paused", "retired"], "responsibility status"),
		accountableStaffAgentId: uuid(input.accountable_staff_agent_id, "responsibility accountable agent"),
		accountableUserId: nullableUuid(input.accountable_user_id, "responsibility accountable member"),
		attentionCadence: text(input.attention_cadence, "responsibility attention cadence", 256),
		measures: input.measures.map(measure),
		version: integer(input.version, "responsibility version"),
		...source(input, "responsibility"),
	};
}

function project(value: unknown): HostedOrganizationProject {
	const input = record(value, "company project");
	const required = [
		"project_id",
		"key",
		"name",
		"status",
		"sponsoring_responsibility_id",
		"lead_staff_agent_id",
		"room_id",
		"staff",
		"version",
		"source_path",
		"source_path_version",
		"source_snapshot_id",
		"source_file_sha256",
	] as const;
	if (required.some((key) => !Object.hasOwn(input, key)) || !Array.isArray(input.staff)) {
		throw new Error("Hosted primary returned invalid company project");
	}
	return {
		projectId: uuid(input.project_id, "project id"),
		key: text(input.key, "project key", 96),
		name: text(input.name, "project name", 256),
		status: status(input.status, ["proposed", "active", "blocked", "completed", "cancelled"], "project status"),
		sponsoringResponsibilityId: nullableUuid(input.sponsoring_responsibility_id, "project responsibility"),
		leadStaffAgentId: uuid(input.lead_staff_agent_id, "project lead"),
		roomId: nullableUuid(input.room_id, "project room"),
		staff: input.staff.map(membership),
		version: integer(input.version, "project version"),
		...source(input, "project"),
	};
}

export function parseHostedCompanyOrganization(value: unknown): HostedCompanyOrganization {
	const input = exact(value, "company organization", [
		"schema",
		"profile_id",
		"cofounder",
		"formation",
		"responsibilities",
		"projects",
	]);
	if (
		input.schema !== "qorpera.company-organization/v1" ||
		!Array.isArray(input.responsibilities) ||
		!Array.isArray(input.projects)
	) {
		throw new Error("Hosted primary returned invalid company organization");
	}
	const cofounder = exact(input.cofounder, "company organization Co-Founder", [
		"staff_agent_id",
		"formation_id",
		"member_session_id",
	]);
	const formation = exact(input.formation, "company organization formation", [
		"formation_id",
		"state",
		"status",
		"revision",
		"projection_status",
		"source_path",
		"source_path_version",
		"source_snapshot_id",
		"source_file_sha256",
	]);
	if (formation.projection_status !== "verified") {
		throw new Error("Hosted primary returned an unverified company organization");
	}
	const profileId = uuid(input.profile_id, "company organization profile id");
	const formationId = uuid(formation.formation_id, "company formation id");
	if (uuid(cofounder.formation_id, "Co-Founder formation id") !== formationId) {
		throw new Error("Hosted primary returned inconsistent company formation identity");
	}
	const responsibilities = input.responsibilities.map(responsibility);
	const projects = input.projects.map(project);
	if (new Set(responsibilities.map((item) => item.responsibilityId)).size !== responsibilities.length) {
		throw new Error("Hosted primary returned duplicate company responsibilities");
	}
	if (new Set(projects.map((item) => item.projectId)).size !== projects.length) {
		throw new Error("Hosted primary returned duplicate company projects");
	}
	const responsibilityIds = new Set(responsibilities.map((item) => item.responsibilityId));
	if (
		projects.some((item) => item.sponsoringResponsibilityId && !responsibilityIds.has(item.sponsoringResponsibilityId))
	) {
		throw new Error("Hosted primary returned a project outside its responsibility");
	}
	return {
		schema: "qorpera.company-organization/v1",
		profileId,
		cofounder: {
			staffAgentId: uuid(cofounder.staff_agent_id, "Co-Founder staff id"),
			formationId,
			memberSessionId: nullableUuid(cofounder.member_session_id, "Co-Founder member session"),
		},
		formation: {
			formationId,
			state: status(
				formation.state,
				[
					"source_inventory",
					"discovery",
					"research",
					"vision_proposal",
					"goals_ratified",
					"responsibility_map",
					"operating",
				],
				"company formation state",
			),
			status: status(formation.status, ["active", "completed", "paused"], "company formation status"),
			revision: integer(formation.revision, "company formation revision"),
			...source(formation, "company formation"),
		},
		responsibilities,
		projects,
	};
}

function agentNode(agent: HostedStaffAgent, role?: string): CompanyOrganizationHierarchyNode {
	return {
		id: `agent:${agent.id}`,
		kind: "agent",
		label: agent.displayName,
		status: agent.employmentStatus,
		...(role ? { role } : {}),
		canonicalId: agent.id,
		children: [],
	};
}

function roomNode(id: string, label: string): CompanyOrganizationHierarchyNode {
	return { id: `room:${id}`, kind: "room", label, status: "active", canonicalId: id, children: [] };
}

export function buildCompanyOrganizationHierarchy(
	organization: HostedCompanyOrganization,
	staff: readonly HostedStaffAgent[],
): CompanyOrganizationHierarchy {
	const agents = new Map(staff.map((agent) => [agent.id, agent]));
	if (agents.size !== staff.length || staff.some((agent) => agent.profileId !== organization.profileId)) {
		throw new Error("Hosted primary returned inconsistent company staff identity");
	}
	const requiredStaffIds = new Set<string>([organization.cofounder.staffAgentId]);
	for (const responsibilityValue of organization.responsibilities) {
		requiredStaffIds.add(responsibilityValue.accountableStaffAgentId);
	}
	for (const projectValue of organization.projects) {
		requiredStaffIds.add(projectValue.leadStaffAgentId);
		for (const membershipValue of projectValue.staff) requiredStaffIds.add(membershipValue.staffAgentId);
	}
	if ([...requiredStaffIds].some((staffAgentId) => !agents.has(staffAgentId))) {
		throw new Error("Hosted primary returned an organization with unknown company staff");
	}
	const placed = new Set<string>([organization.cofounder.staffAgentId]);
	const projectNode = (
		projectValue: HostedOrganizationProject,
		trackPrimaryPlacement: boolean,
	): CompanyOrganizationHierarchyNode => {
		const children: CompanyOrganizationHierarchyNode[] = [];
		if (projectValue.roomId) children.push(roomNode(projectValue.roomId, `${projectValue.name} room`));
		for (const membershipValue of projectValue.staff.filter((item) => item.status === "active")) {
			const agent = agents.get(membershipValue.staffAgentId);
			if (!agent) continue;
			if (trackPrimaryPlacement) placed.add(agent.id);
			children.push(agentNode(agent, membershipValue.role));
		}
		return {
			id: `project:${projectValue.projectId}`,
			kind: "project",
			label: projectValue.name,
			status: projectValue.status,
			canonicalId: projectValue.projectId,
			children,
		};
	};
	const activeProject = (projectValue: HostedOrganizationProject): boolean =>
		projectValue.status === "proposed" || projectValue.status === "active" || projectValue.status === "blocked";
	const primary: CompanyOrganizationHierarchyNode[] = [];
	const inactive: CompanyOrganizationHierarchyNode[] = [];
	const cofounder = agents.get(organization.cofounder.staffAgentId);
	primary.push({
		id: `cofounder:${organization.cofounder.staffAgentId}`,
		kind: "cofounder",
		label: cofounder?.displayName ?? "Co-Founder",
		status: organization.formation.status,
		canonicalId: organization.cofounder.staffAgentId,
		children: [],
	});
	// Responsibilities and their accountable agents form the dedicated
	// high-level area (contract 14.5). The Co-Founder stays the company home
	// and is not re-listed under the company-level responsibilities it holds.
	for (const responsibilityValue of organization.responsibilities) {
		const trackPrimaryPlacement = responsibilityValue.status !== "retired";
		const children = organization.projects
			.filter(
				(projectValue) =>
					projectValue.sponsoringResponsibilityId === responsibilityValue.responsibilityId &&
					activeProject(projectValue),
			)
			.map((projectValue) => projectNode(projectValue, trackPrimaryPlacement));
		const accountable = agents.get(responsibilityValue.accountableStaffAgentId);
		if (accountable && !placed.has(accountable.id)) {
			if (trackPrimaryPlacement) placed.add(accountable.id);
			children.push(agentNode(accountable, "Accountable"));
		}
		const node: CompanyOrganizationHierarchyNode = {
			id: `responsibility:${responsibilityValue.responsibilityId}`,
			kind: "responsibility",
			label: responsibilityValue.name,
			status: responsibilityValue.status,
			canonicalId: responsibilityValue.responsibilityId,
			children,
		};
		(responsibilityValue.status === "retired" ? inactive : primary).push(node);
	}
	for (const projectValue of organization.projects) {
		if (projectValue.sponsoringResponsibilityId) {
			if (!activeProject(projectValue)) inactive.push(projectNode(projectValue, false));
			continue;
		}
		const isPrimary = activeProject(projectValue);
		(isPrimary ? primary : inactive).push(projectNode(projectValue, isPrimary));
	}
	for (const agent of staff) {
		if (placed.has(agent.id)) continue;
		(agent.employmentStatus === "active" ? primary : inactive).push(agentNode(agent));
	}
	return {
		schema: "qorpera.company-organization-hierarchy/v1",
		profileId: organization.profileId,
		formationState: organization.formation.state,
		primary,
		inactive,
	};
}
