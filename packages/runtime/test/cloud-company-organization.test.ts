import {
	buildCompanyOrganizationHierarchy,
	parseHostedCompanyOrganization,
} from "@qorpera/cloud-client/cloud-company-organization";
import type { HostedStaffAgent } from "@qorpera/cloud-client/hosted-primary";
import { describe, expect, it } from "vitest";

const PROFILE = "10000000-0000-4000-8000-000000000001";
const COFOUNDER = "10000000-0000-4000-8000-000000000002";
const LEAD = "10000000-0000-4000-8000-000000000003";
const SPECIALIST = "10000000-0000-4000-8000-000000000004";
const ARCHIVED = "10000000-0000-4000-8000-000000000005";
const FORMATION = "10000000-0000-4000-8000-000000000006";
const SESSION = "10000000-0000-4000-8000-000000000007";
const RESPONSIBILITY = "10000000-0000-4000-8000-000000000008";
const PROJECT = "10000000-0000-4000-8000-000000000009";
const MEASURE = "10000000-0000-4000-8000-000000000010";
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
			state: "responsibility_map",
			status: "active",
			revision: 6,
			projection_status: "verified",
			source_path: "organization/formation.json",
			source_path_version: PATH_VERSION,
			source_snapshot_id: SNAPSHOT,
			source_file_sha256: HASH,
		},
		responsibilities: [
			{
				responsibility_id: RESPONSIBILITY,
				slug: "product",
				name: "Product",
				outcome: "Own product outcomes.",
				accountable_staff_agent_id: LEAD,
				accountable_user_id: null,
				attention_cadence: "weekly",
				escalation_threshold: {},
				escalation_target: { kind: "cofounder", id: null },
				effort_policy: {},
				budget_policy: {},
				concurrency_policy: {},
				routine_ids: [],
				listener_ids: [],
				external_operation_grants: [],
				resources: [],
				active_projects: [],
				status: "active",
				version: 3,
				source_path: "organization/responsibilities/product.json",
				source_path_version: PATH_VERSION,
				source_snapshot_id: SNAPSHOT,
				source_file_sha256: HASH,
				measures: [
					{
						measure_id: MEASURE,
						key: "retention",
						label: "Retention",
						definition: "Customers still active after 90 days.",
						direction: "higher_is_better",
						target: { percent: 80 },
						guardrails: [],
						cadence: "weekly",
						status: "active",
						sources: [
							{
								path: "product/metrics.json",
								path_match: "exact",
								source_path_version: PATH_VERSION,
								source_snapshot_id: SNAPSHOT,
								source_file_sha256: HASH,
							},
							{
								path: "product",
								path_match: "subtree",
								source_path_version: PATH_VERSION,
								source_snapshot_id: SNAPSHOT,
								source_file_sha256: null,
							},
						],
					},
				],
			},
		],
		projects: [
			{
				project_id: PROJECT,
				key: "launch",
				name: "Launch",
				objective: "Launch the company.",
				definition_of_done: "The product is live.",
				scope_kind: "responsibility",
				sponsoring_responsibility_id: RESPONSIBILITY,
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
		expect(hierarchy.primary.map((node) => node.kind)).toEqual(["cofounder", "responsibility"]);
		expect(hierarchy.primary[1]?.children.map((node) => node.kind)).toEqual(["project", "agent"]);
		expect(hierarchy.primary[1]?.children[1]).toMatchObject({
			kind: "agent",
			canonicalId: LEAD,
			role: "Accountable",
		});
		expect(hierarchy.primary[1]?.children[0]?.children.map((node) => node.kind)).toEqual(["room", "agent"]);
		expect(hierarchy.primary[1]?.children[0]?.children[1]).toMatchObject({
			kind: "agent",
			status: "active",
			role: "Research",
		});
		expect(organization.responsibilities[0]?.measures[0]?.sources.map((source) => source.pathMatch)).toEqual([
			"exact",
			"subtree",
		]);
		expect(hierarchy.inactive).toMatchObject([{ kind: "agent", canonicalId: ARCHIVED, status: "archived" }]);
	});

	it("fails closed on unverified, inconsistent, duplicate, or unattributed organization state", () => {
		const unverified = rawOrganization();
		(unverified.formation as Record<string, unknown>).projection_status = "pending";
		expect(() => parseHostedCompanyOrganization(unverified)).toThrow("unverified company organization");

		const outsideResponsibility = rawOrganization();
		(
			(outsideResponsibility.projects as Record<string, unknown>[])[0] as Record<string, unknown>
		).sponsoring_responsibility_id = SESSION;
		expect(() => parseHostedCompanyOrganization(outsideResponsibility)).toThrow("outside its responsibility");

		const ceremonial = rawOrganization();
		((ceremonial.responsibilities as Record<string, unknown>[])[0] as Record<string, unknown>).measures = [];
		expect(() => parseHostedCompanyOrganization(ceremonial)).toThrow("invalid company responsibility");

		const duplicate = rawOrganization();
		duplicate.projects = [
			...(duplicate.projects as Record<string, unknown>[]),
			{ ...(duplicate.projects as Record<string, unknown>[])[0] },
		];
		expect(() => parseHostedCompanyOrganization(duplicate)).toThrow("duplicate company projects");

		const missingProvenance = rawOrganization();
		(
			(missingProvenance.responsibilities as Record<string, unknown>[])[0] as Record<string, unknown>
		).source_file_sha256 = "not-a-hash";
		expect(() => parseHostedCompanyOrganization(missingProvenance)).toThrow("invalid responsibility source hash");

		const organization = parseHostedCompanyOrganization(rawOrganization());
		expect(() => buildCompanyOrganizationHierarchy(organization, [staff(COFOUNDER, "Co-Founder")])).toThrow(
			"unknown company staff",
		);
	});

	it("keeps active staff in the primary hierarchy when their former organization is inactive", () => {
		const source = rawOrganization();
		((source.responsibilities as Record<string, unknown>[])[0] as Record<string, unknown>).status = "retired";
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
		expect(hierarchy.inactive.map((node) => node.kind)).toEqual(["responsibility", "project"]);
	});
});
