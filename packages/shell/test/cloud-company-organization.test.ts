import { describe, expect, it } from "vitest";
import {
	buildCompanyOrganizationHierarchy,
	parseHostedCompanyOrganization,
} from "../src/cloud-company-organization.ts";
import type { HostedStaffAgent } from "../src/hosted-primary.ts";

const PROFILE = "10000000-0000-4000-8000-000000000001";
const COFOUNDER = "10000000-0000-4000-8000-000000000002";
const LEAD = "10000000-0000-4000-8000-000000000003";
const SPECIALIST = "10000000-0000-4000-8000-000000000004";
const ARCHIVED = "10000000-0000-4000-8000-000000000005";
const FORMATION = "10000000-0000-4000-8000-000000000006";
const SESSION = "10000000-0000-4000-8000-000000000007";
const DEPARTMENT = "10000000-0000-4000-8000-000000000008";
const PROJECT = "10000000-0000-4000-8000-000000000009";
const DEPARTMENT_ROOM = "10000000-0000-4000-8000-000000000010";
const PROJECT_ROOM = "10000000-0000-4000-8000-000000000011";
const PATH_VERSION = "10000000-0000-4000-8000-000000000012";
const SNAPSHOT = "10000000-0000-4000-8000-000000000013";
const HASH = "a".repeat(64);
const CREATED = "2026-08-29T08:00:00.000Z";

function rawOrganization(): Record<string, unknown> {
	return {
		schema: "qorpera.company-organization/v1",
		profile_id: PROFILE,
		cofounder: {
			staff_agent_id: COFOUNDER,
			formation_id: FORMATION,
			member_session_id: SESSION,
		},
		formation: {
			formation_id: FORMATION,
			state: "organization_formation",
			status: "active",
			revision: 6,
			projection_status: "verified",
			source_path: "organization/formation.json",
			source_path_version: PATH_VERSION,
			source_snapshot_id: SNAPSHOT,
			source_file_sha256: HASH,
		},
		departments: [
			{
				department_id: DEPARTMENT,
				slug: "product",
				name: "Product",
				charter: "Own product outcomes.",
				non_responsibilities: ["Sales"],
				accountable_user_id: null,
				lead_staff_agent_id: LEAD,
				default_room_id: DEPARTMENT_ROOM,
				status: "active",
				version: 3,
				intake_policy: {},
				prioritization_policy: {},
				budget_policy: {},
				effort_policy: {},
				concurrency_policy: {},
				execution_policy: {},
				project_creation_policy: {},
				escalation_policy: {},
				routine_ids: [],
				listener_ids: [],
				external_operation_grants: [],
				resources: [],
				active_projects: [],
				source_path: "organization/departments/product.json",
				source_path_version: PATH_VERSION,
				source_snapshot_id: SNAPSHOT,
				source_file_sha256: HASH,
				staff: [
					{ staff_agent_id: LEAD, assignment_kind: "primary", role: "Lead", status: "active" },
					{
						staff_agent_id: SPECIALIST,
						assignment_kind: "supporting",
						role: "Research",
						status: "active",
					},
				],
				responsibilities: [],
				measures: [],
			},
		],
		projects: [
			{
				project_id: PROJECT,
				key: "launch",
				name: "Launch",
				objective: "Launch the company.",
				definition_of_done: "The product is live.",
				scope_kind: "department",
				sponsoring_department_id: DEPARTMENT,
				lead_staff_agent_id: LEAD,
				room_id: PROJECT_ROOM,
				status: "active",
				authorized_source_paths: ["product"],
				authorized_output_paths: ["product/releases"],
				dependencies: [],
				reasoning_policy: {},
				worker_policy: {},
				execution_policy: {},
				resources: [],
				outcome: {},
				version: 2,
				source_path: "organization/projects/launch.json",
				source_path_version: PATH_VERSION,
				source_snapshot_id: SNAPSHOT,
				source_file_sha256: HASH,
				staff: [{ staff_agent_id: SPECIALIST, role: "Research", status: "active" }],
			},
		],
	};
}

function staff(id: string, displayName: string, employmentStatus: "active" | "archived" = "active"): HostedStaffAgent {
	return {
		id,
		profileId: PROFILE,
		displayName,
		role: "Company staff",
		charter: "Work over canonical company state.",
		appearance: { color: "blue", shape: "round" },
		employmentStatus,
		lifecycleState: "active",
		version: 1,
		createdAt: CREATED,
		updatedAt: CREATED,
		updatedByUserId: COFOUNDER,
	};
}

describe("canonical company organization projection", () => {
	it("rebuilds the same semantic hierarchy from cloud state on a replacement client", () => {
		const source = rawOrganization();
		const agents = [
			staff(COFOUNDER, "Co-Founder"),
			staff(LEAD, "Product Lead"),
			staff(SPECIALIST, "Researcher"),
			staff(ARCHIVED, "Former Teammate", "archived"),
		];
		const organization = parseHostedCompanyOrganization(source);
		const hierarchy = buildCompanyOrganizationHierarchy(organization, agents);
		const replacement = buildCompanyOrganizationHierarchy(
			parseHostedCompanyOrganization(JSON.parse(JSON.stringify(source))),
			JSON.parse(JSON.stringify(agents)),
		);

		expect(replacement).toEqual(hierarchy);
		expect(hierarchy.primary.map((node) => node.kind)).toEqual(["cofounder", "department"]);
		expect(hierarchy.primary[1]?.children.map((node) => node.kind)).toEqual(["project", "room", "agent"]);
		expect(hierarchy.primary[1]?.children[0]?.children.map((node) => node.kind)).toEqual(["room", "agent"]);
		expect(hierarchy.primary[1]?.children[0]?.children[1]).toMatchObject({
			kind: "agent",
			status: "active",
			role: "Research",
		});
		expect(hierarchy.inactive).toMatchObject([{ kind: "agent", canonicalId: ARCHIVED, status: "archived" }]);
	});

	it("fails closed on unverified, inconsistent, duplicate, or unattributed organization state", () => {
		const unverified = rawOrganization();
		(unverified.formation as Record<string, unknown>).projection_status = "pending";
		expect(() => parseHostedCompanyOrganization(unverified)).toThrow("unverified company organization");

		const outsideDepartment = rawOrganization();
		(
			(outsideDepartment.projects as Record<string, unknown>[])[0] as Record<string, unknown>
		).sponsoring_department_id = SESSION;
		expect(() => parseHostedCompanyOrganization(outsideDepartment)).toThrow("outside its department");

		const duplicate = rawOrganization();
		duplicate.projects = [
			...(duplicate.projects as Record<string, unknown>[]),
			{ ...(duplicate.projects as Record<string, unknown>[])[0] },
		];
		expect(() => parseHostedCompanyOrganization(duplicate)).toThrow("duplicate company projects");

		const missingProvenance = rawOrganization();
		((missingProvenance.departments as Record<string, unknown>[])[0] as Record<string, unknown>).source_file_sha256 =
			"not-a-hash";
		expect(() => parseHostedCompanyOrganization(missingProvenance)).toThrow("invalid department source hash");

		const organization = parseHostedCompanyOrganization(rawOrganization());
		expect(() => buildCompanyOrganizationHierarchy(organization, [staff(COFOUNDER, "Co-Founder")])).toThrow(
			"unknown company staff",
		);
	});

	it("keeps active staff in the primary hierarchy when their former organization is inactive", () => {
		const source = rawOrganization();
		((source.departments as Record<string, unknown>[])[0] as Record<string, unknown>).status = "retired";
		((source.projects as Record<string, unknown>[])[0] as Record<string, unknown>).status = "completed";
		const hierarchy = buildCompanyOrganizationHierarchy(parseHostedCompanyOrganization(source), [
			staff(COFOUNDER, "Co-Founder"),
			staff(LEAD, "Product Lead"),
			staff(SPECIALIST, "Researcher"),
		]);

		expect(hierarchy.primary.map((node) => [node.kind, node.canonicalId])).toEqual([
			["cofounder", COFOUNDER],
			["agent", LEAD],
			["agent", SPECIALIST],
		]);
		expect(hierarchy.inactive.map((node) => node.kind)).toEqual(["department", "project"]);
	});
});
