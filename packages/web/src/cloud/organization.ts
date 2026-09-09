import {
	array,
	boundedInteger,
	CloudShapeError,
	nonEmptyString,
	oneOf,
	record,
	SHA256_PATTERN,
	uuid,
} from "./parse.ts";
import type { HostedStaffAgent } from "./types.ts";

/* Organization projection (runtime contract §14.3, §14.5), ported from the
 * desktop's cloud-company-organization.ts. Responsibilities have exactly one
 * accountable agent and no department, lead or officer. Extra keys the kernel
 * adds over time are carried where useful and otherwise ignored. */

export interface HostedOrganizationMembership {
	staffAgentId: string;
	role: string;
	status: "active" | "ended";
}

export interface HostedOrganizationMeasure {
	measureId: string;
	key: string;
	label: string;
	status: "active" | "paused" | "retired";
	definition?: string;
	target?: string;
	cadence?: string;
	sourcePaths: string[];
}

export interface HostedOrganizationResponsibility {
	responsibilityId: string;
	slug: string;
	name: string;
	outcome?: string;
	status: "proposed" | "active" | "degraded" | "paused" | "retired";
	accountableStaffAgentId: string;
	accountableUserId?: string;
	attentionCadence: string;
	escalationThreshold?: string;
	measures: HostedOrganizationMeasure[];
	version: number;
	sourcePath: string;
}

export interface HostedOrganizationProject {
	projectId: string;
	key: string;
	name: string;
	objective?: string;
	status: "proposed" | "active" | "blocked" | "completed" | "cancelled";
	sponsoringResponsibilityId?: string;
	leadStaffAgentId: string;
	roomId?: string;
	staff: HostedOrganizationMembership[];
	version: number;
	sourcePath: string;
}

export type FormationState =
	| "source_inventory"
	| "discovery"
	| "research"
	| "vision_proposal"
	| "goals_ratified"
	| "responsibility_map"
	| "operating";

export interface HostedCompanyOrganization {
	schema: "qorpera.company-organization/v1";
	profileId: string;
	cofounder: { staffAgentId: string; formationId: string; memberSessionId?: string };
	formation: {
		formationId: string;
		state: FormationState;
		status: "active" | "completed" | "paused";
		revision: number;
		projectionStatus: string;
		sourcePath: string;
	};
	responsibilities: HostedOrganizationResponsibility[];
	projects: HostedOrganizationProject[];
}

function optionalText(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function textOr(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() ? value : fallback;
}

function membership(value: unknown): HostedOrganizationMembership {
	const input = record(value, "organization staff membership");
	return {
		staffAgentId: uuid(input.staff_agent_id, "organization staff id"),
		role: textOr(input.role, "Member"),
		status: input.status === "ended" ? "ended" : "active",
	};
}

function measure(value: unknown): HostedOrganizationMeasure {
	const input = record(value, "responsibility measure");
	const definition = optionalText(input.definition);
	const target = optionalText(input.target);
	const cadence = optionalText(input.cadence);
	return {
		measureId: uuid(input.measure_id, "responsibility measure id"),
		key: textOr(input.key, "measure"),
		label: textOr(input.label, "Measure"),
		status: oneOf(input.status ?? "active", ["active", "paused", "retired"], "responsibility measure status"),
		...(definition ? { definition } : {}),
		...(target ? { target } : {}),
		...(cadence ? { cadence } : {}),
		sourcePaths: Array.isArray(input.sources)
			? input.sources
					.map((source) =>
						source && typeof source === "object" ? (source as { path?: unknown }).path : undefined,
					)
					.filter((path): path is string => typeof path === "string")
			: [],
	};
}

function responsibility(value: unknown): HostedOrganizationResponsibility {
	const input = record(value, "company responsibility");
	const accountableUserId = input.accountable_user_id;
	const outcome = optionalText(input.outcome);
	const escalationThreshold = optionalText(input.escalation_threshold);
	return {
		responsibilityId: uuid(input.responsibility_id, "responsibility id"),
		slug: textOr(input.slug, "responsibility"),
		name: nonEmptyString(input.name, "responsibility name", 160),
		...(outcome ? { outcome } : {}),
		status: oneOf(input.status, ["proposed", "active", "degraded", "paused", "retired"], "responsibility status"),
		accountableStaffAgentId: uuid(input.accountable_staff_agent_id, "responsibility accountable agent"),
		...(typeof accountableUserId === "string"
			? { accountableUserId: uuid(accountableUserId, "accountable member") }
			: {}),
		attentionCadence: textOr(input.attention_cadence, "as needed"),
		...(escalationThreshold ? { escalationThreshold } : {}),
		measures: array(input.measures ?? [], "responsibility measures").map(measure),
		version: boundedInteger(input.version ?? 1, "responsibility version", 1, Number.MAX_SAFE_INTEGER),
		sourcePath: textOr(input.source_path, ""),
	};
}

function project(value: unknown): HostedOrganizationProject {
	const input = record(value, "company project");
	const sponsoring = input.sponsoring_responsibility_id;
	const roomId = input.room_id;
	const objective = optionalText(input.objective);
	return {
		projectId: uuid(input.project_id, "project id"),
		key: textOr(input.key, "project"),
		name: nonEmptyString(input.name, "project name", 256),
		...(objective ? { objective } : {}),
		status: oneOf(input.status, ["proposed", "active", "blocked", "completed", "cancelled"], "project status"),
		...(typeof sponsoring === "string"
			? { sponsoringResponsibilityId: uuid(sponsoring, "project responsibility") }
			: {}),
		leadStaffAgentId: uuid(input.lead_staff_agent_id, "project lead"),
		...(typeof roomId === "string" ? { roomId: uuid(roomId, "project room") } : {}),
		staff: array(input.staff ?? [], "project staff").map(membership),
		version: boundedInteger(input.version ?? 1, "project version", 1, Number.MAX_SAFE_INTEGER),
		sourcePath: textOr(input.source_path, ""),
	};
}

/** Returns undefined for a company the organization kernel has not seeded
 * yet (no Co-Founder row). The caller renders that as canonical state, not
 * as an error and not as a fake Co-Founder. */
export function parseHostedCompanyOrganization(value: unknown): HostedCompanyOrganization | undefined {
	const input = record(value, "company organization");
	if (input.schema !== "qorpera.company-organization/v1") throw new CloudShapeError("company organization schema");
	const profileId = uuid(input.profile_id, "company organization profile id");
	if (
		input.cofounder === null ||
		input.cofounder === undefined ||
		input.formation === null ||
		input.formation === undefined
	) {
		return undefined;
	}
	const cofounder = record(input.cofounder, "company organization Co-Founder");
	const formation = record(input.formation, "company organization formation");
	const formationId = uuid(formation.formation_id, "company formation id");
	if (uuid(cofounder.formation_id, "Co-Founder formation id") !== formationId) {
		throw new CloudShapeError("company formation identity");
	}
	const memberSessionId = cofounder.member_session_id;
	const responsibilities = array(input.responsibilities ?? [], "company responsibilities").map(responsibility);
	const projects = array(input.projects ?? [], "company projects").map(project);
	if (typeof formation.source_file_sha256 === "string" && !SHA256_PATTERN.test(formation.source_file_sha256)) {
		throw new CloudShapeError("company formation source hash");
	}
	return {
		schema: "qorpera.company-organization/v1",
		profileId,
		cofounder: {
			staffAgentId: uuid(cofounder.staff_agent_id, "Co-Founder staff id"),
			formationId,
			...(typeof memberSessionId === "string"
				? { memberSessionId: uuid(memberSessionId, "Co-Founder member session") }
				: {}),
		},
		formation: {
			formationId,
			state: oneOf(
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
			status: oneOf(formation.status, ["active", "completed", "paused"], "company formation status"),
			revision: boundedInteger(formation.revision ?? 1, "company formation revision", 1, Number.MAX_SAFE_INTEGER),
			projectionStatus: textOr(formation.projection_status, "unknown"),
			sourcePath: textOr(formation.source_path, ""),
		},
		responsibilities,
		projects,
	};
}

/* Attention hierarchy (§14.5): Co-Founder home, responsibilities with their
 * accountable agents, active projects and rooms, then individual staff;
 * completed projects, retired responsibilities and archived staff outside the
 * primary surface. Recency never decides placement. */

export interface HierarchyNode {
	id: string;
	kind: "cofounder" | "responsibility" | "project" | "room" | "agent";
	label: string;
	status: string;
	role?: string;
	canonicalId: string;
	children: HierarchyNode[];
}

export interface CompanyHierarchy {
	formationState?: FormationState;
	primary: HierarchyNode[];
	inactive: HierarchyNode[];
}

function agentNode(agent: HostedStaffAgent, role?: string): HierarchyNode {
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

export function buildCompanyHierarchy(
	organization: HostedCompanyOrganization | undefined,
	staff: readonly HostedStaffAgent[],
): CompanyHierarchy {
	const agents = new Map(staff.map((agent) => [agent.id, agent]));
	const primary: HierarchyNode[] = [];
	const inactive: HierarchyNode[] = [];
	const placed = new Set<string>();
	if (!organization) {
		for (const agent of staff) (agent.employmentStatus === "active" ? primary : inactive).push(agentNode(agent));
		return { primary, inactive };
	}
	placed.add(organization.cofounder.staffAgentId);
	const cofounder = agents.get(organization.cofounder.staffAgentId);
	primary.push({
		id: `cofounder:${organization.cofounder.staffAgentId}`,
		kind: "cofounder",
		label: cofounder?.displayName ?? "Co-Founder",
		status: organization.formation.status,
		canonicalId: organization.cofounder.staffAgentId,
		children: [],
	});
	const activeProject = (value: HostedOrganizationProject): boolean =>
		value.status === "proposed" || value.status === "active" || value.status === "blocked";
	const projectNode = (value: HostedOrganizationProject, track: boolean): HierarchyNode => {
		const children: HierarchyNode[] = [];
		if (value.roomId) {
			children.push({
				id: `room:${value.roomId}`,
				kind: "room",
				label: `${value.name} room`,
				status: "active",
				canonicalId: value.roomId,
				children: [],
			});
		}
		for (const member of value.staff.filter((item) => item.status === "active")) {
			const agent = agents.get(member.staffAgentId);
			if (!agent) continue;
			if (track) placed.add(agent.id);
			children.push(agentNode(agent, member.role));
		}
		return {
			id: `project:${value.projectId}`,
			kind: "project",
			label: value.name,
			status: value.status,
			canonicalId: value.projectId,
			children,
		};
	};
	for (const value of organization.responsibilities) {
		const track = value.status !== "retired";
		const children = organization.projects
			.filter((item) => item.sponsoringResponsibilityId === value.responsibilityId && activeProject(item))
			.map((item) => projectNode(item, track));
		const accountable = agents.get(value.accountableStaffAgentId);
		if (accountable && !placed.has(accountable.id)) {
			if (track) placed.add(accountable.id);
			children.push(agentNode(accountable, "Accountable"));
		}
		const node: HierarchyNode = {
			id: `responsibility:${value.responsibilityId}`,
			kind: "responsibility",
			label: value.name,
			status: value.status,
			canonicalId: value.responsibilityId,
			children,
		};
		(value.status === "retired" ? inactive : primary).push(node);
	}
	for (const value of organization.projects) {
		if (value.sponsoringResponsibilityId) {
			if (!activeProject(value)) inactive.push(projectNode(value, false));
			continue;
		}
		const isPrimary = activeProject(value);
		(isPrimary ? primary : inactive).push(projectNode(value, isPrimary));
	}
	for (const agent of staff) {
		if (placed.has(agent.id)) continue;
		(agent.employmentStatus === "active" ? primary : inactive).push(agentNode(agent));
	}
	return { formationState: organization.formation.state, primary, inactive };
}
