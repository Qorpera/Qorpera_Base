import type { HostedStaffAgent } from "./hosted-primary.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface HostedOrganizationMembership {
	staffAgentId: string;
	role: string;
	status: "active" | "ended";
	assignmentKind?: "primary" | "supporting";
}

export interface HostedOrganizationDepartment {
	departmentId: string;
	slug: string;
	name: string;
	status: "proposed" | "forming" | "active" | "degraded" | "paused" | "retired";
	leadStaffAgentId?: string;
	defaultRoomId?: string;
	staff: HostedOrganizationMembership[];
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
	sponsoringDepartmentId?: string;
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
			| "organization_formation"
			| "operating";
		status: "active" | "completed" | "paused";
		revision: number;
		sourcePath: string;
		sourcePathVersion: string;
		sourceSnapshotId: string;
		sourceFileSha256: string;
	};
	departments: HostedOrganizationDepartment[];
	projects: HostedOrganizationProject[];
}

export interface CompanyOrganizationHierarchyNode {
	id: string;
	kind: "cofounder" | "department" | "project" | "room" | "agent";
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

function membership(value: unknown, department: boolean): HostedOrganizationMembership {
	const input = exact(
		value,
		"organization staff membership",
		department ? ["staff_agent_id", "assignment_kind", "role", "status"] : ["staff_agent_id", "role", "status"],
	);
	return {
		staffAgentId: uuid(input.staff_agent_id, "organization staff id"),
		role: text(input.role, "organization staff role", 320),
		status: status(input.status, ["active", "ended"], "organization staff status"),
		...(department
			? {
					assignmentKind: status(input.assignment_kind, ["primary", "supporting"], "department assignment kind"),
				}
			: {}),
	};
}

function department(value: unknown): HostedOrganizationDepartment {
	const input = record(value, "company department");
	const required = [
		"department_id",
		"slug",
		"name",
		"status",
		"lead_staff_agent_id",
		"default_room_id",
		"staff",
		"version",
		"source_path",
		"source_path_version",
		"source_snapshot_id",
		"source_file_sha256",
	] as const;
	if (required.some((key) => !Object.hasOwn(input, key)) || !Array.isArray(input.staff)) {
		throw new Error("Hosted primary returned invalid company department");
	}
	return {
		departmentId: uuid(input.department_id, "department id"),
		slug: text(input.slug, "department slug", 64),
		name: text(input.name, "department name", 160),
		status: status(
			input.status,
			["proposed", "forming", "active", "degraded", "paused", "retired"],
			"department status",
		),
		leadStaffAgentId: nullableUuid(input.lead_staff_agent_id, "department lead"),
		defaultRoomId: nullableUuid(input.default_room_id, "department room"),
		staff: input.staff.map((item) => membership(item, true)),
		version: integer(input.version, "department version"),
		...source(input, "department"),
	};
}

function project(value: unknown): HostedOrganizationProject {
	const input = record(value, "company project");
	const required = [
		"project_id",
		"key",
		"name",
		"status",
		"sponsoring_department_id",
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
		sponsoringDepartmentId: nullableUuid(input.sponsoring_department_id, "project department"),
		leadStaffAgentId: uuid(input.lead_staff_agent_id, "project lead"),
		roomId: nullableUuid(input.room_id, "project room"),
		staff: input.staff.map((item) => membership(item, false)),
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
		"departments",
		"projects",
	]);
	if (
		input.schema !== "qorpera.company-organization/v1" ||
		!Array.isArray(input.departments) ||
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
	const departments = input.departments.map(department);
	const projects = input.projects.map(project);
	if (new Set(departments.map((item) => item.departmentId)).size !== departments.length) {
		throw new Error("Hosted primary returned duplicate company departments");
	}
	if (new Set(projects.map((item) => item.projectId)).size !== projects.length) {
		throw new Error("Hosted primary returned duplicate company projects");
	}
	const departmentIds = new Set(departments.map((item) => item.departmentId));
	if (projects.some((item) => item.sponsoringDepartmentId && !departmentIds.has(item.sponsoringDepartmentId))) {
		throw new Error("Hosted primary returned a project outside its department");
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
					"organization_formation",
					"operating",
				],
				"company formation state",
			),
			status: status(formation.status, ["active", "completed", "paused"], "company formation status"),
			revision: integer(formation.revision, "company formation revision"),
			...source(formation, "company formation"),
		},
		departments,
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
	for (const departmentValue of organization.departments) {
		if (departmentValue.leadStaffAgentId) requiredStaffIds.add(departmentValue.leadStaffAgentId);
		for (const membershipValue of departmentValue.staff) requiredStaffIds.add(membershipValue.staffAgentId);
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
	for (const departmentValue of organization.departments) {
		const trackPrimaryPlacement = departmentValue.status !== "retired";
		const children = organization.projects
			.filter(
				(projectValue) =>
					projectValue.sponsoringDepartmentId === departmentValue.departmentId && activeProject(projectValue),
			)
			.map((projectValue) => projectNode(projectValue, trackPrimaryPlacement));
		if (departmentValue.defaultRoomId) {
			children.push(roomNode(departmentValue.defaultRoomId, `${departmentValue.name} room`));
		}
		for (const membershipValue of departmentValue.staff.filter((item) => item.status === "active")) {
			if (placed.has(membershipValue.staffAgentId)) continue;
			const agent = agents.get(membershipValue.staffAgentId);
			if (!agent) continue;
			if (trackPrimaryPlacement) placed.add(agent.id);
			children.push(agentNode(agent, membershipValue.role));
		}
		const node: CompanyOrganizationHierarchyNode = {
			id: `department:${departmentValue.departmentId}`,
			kind: "department",
			label: departmentValue.name,
			status: departmentValue.status,
			canonicalId: departmentValue.departmentId,
			children,
		};
		(departmentValue.status === "retired" ? inactive : primary).push(node);
	}
	for (const projectValue of organization.projects) {
		if (projectValue.sponsoringDepartmentId) {
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
