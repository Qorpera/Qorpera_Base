import { describe, expect, it } from "vitest";
import { buildCompanyHierarchy, parseHostedCompanyOrganization } from "../src/cloud/organization.ts";
import {
	parseCreatedCompany,
	parseFriends,
	parseProfiles,
	parseRunRecovery,
	parseRunResolution,
	parseSession,
	parseStaff,
	parseTeam,
} from "../src/cloud/parse.ts";
import type { HostedStaffAgent } from "../src/cloud/types.ts";

const P = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const E = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const U = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const S1 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const S2 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const F = "ffffffff-ffff-4fff-8fff-ffffffffffff";

describe("parsers", () => {
	it("reads a failed run's error, open proposal and unsettled operations", () => {
		const recovery = (job: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
			parseRunRecovery({
				run: { run_id: S1.toUpperCase(), source_kind: "room_delivery" },
				job: { status: "failed", ...job },
				proposal_id: null,
				inputs: [],
				operations: [{ status: "completed" }, { status: "ambiguous" }, { status: "executing" }],
				...extra,
			});
		expect(recovery({ last_error: "  Native provider bridge request failed (422)  " })).toEqual({
			runId: S1,
			sourceKind: "room_delivery",
			jobStatus: "failed",
			lastError: "Native provider bridge request failed (422)",
			unsettledOperations: 2,
		});
		// A missing or odd error never hides the run.
		expect(recovery({ last_error: { code: "x" } }, { proposal_id: F })).toMatchObject({ proposalId: F });
		expect(recovery({ last_error: { code: "x" } }).lastError).toBeUndefined();
		expect(() => recovery({ status: "completed" })).toThrow("recovery job status");
		expect(() => recovery({}, { proposal_id: "not-a-uuid" })).toThrow("recovery proposal id");
	});

	it("accepts only a resolution of the run and action that were asked for", () => {
		expect(() => parseRunResolution({ run_id: S1, action: "discard", resolved: true }, S1, "discard")).not.toThrow();
		expect(() =>
			parseRunResolution({ run_id: S1, action: "acknowledge", resolved: true }, S1, "acknowledge"),
		).not.toThrow();
		expect(() => parseRunResolution({ run_id: S2, action: "discard", resolved: true }, S1, "discard")).toThrow(
			"run discard",
		);
		expect(() => parseRunResolution({ run_id: S1, action: "discard", resolved: false }, S1, "discard")).toThrow(
			"run discard",
		);
		expect(() => parseRunResolution({ run_id: S1, action: "retry", resolved: true }, S1, "discard")).toThrow(
			"run discard",
		);
		expect(() => parseRunResolution({ run_id: S1, action: "discard", resolved: true }, S1, "acknowledge")).toThrow(
			"run acknowledge",
		);
	});

	it("parses the hosted profile list", () => {
		const profiles = parseProfiles([
			{
				profile_id: P,
				environment_id: E,
				profile_name: "Company41",
				environment_name: "main",
				role: "owner",
				contract_version: 2,
				created_at: "2026-08-20T00:00:00Z",
			},
		]);
		expect(profiles[0]?.profileName).toBe("Company41");
		expect(profiles[0]?.role).toBe("owner");
	});

	it("parses the friends list, with the direction the caller sees", () => {
		const friends = parseFriends([
			{
				user_id: U,
				email: "mia@havnegade.dk",
				display_name: "Mia Sørensen",
				status: "pending",
				direction: "incoming",
				since: "2026-08-30T09:00:00Z",
			},
			{
				user_id: F,
				email: "lena@nordlys.no",
				display_name: "Lena Berg",
				status: "accepted",
				direction: "outgoing",
				since: "2026-07-19T09:00:00Z",
			},
		]);
		expect(friends).toHaveLength(2);
		expect(friends[0]?.status).toBe("pending");
		expect(friends[0]?.direction).toBe("incoming");
		expect(friends[1]?.status).toBe("accepted");
		expect(friends[1]?.displayName).toBe("Lena Berg");
	});

	it("rejects a friend without an account identity", () => {
		expect(() =>
			parseFriends([
				{
					user_id: "not-a-uuid",
					email: "x@y.z",
					display_name: "X",
					status: "accepted",
					direction: "outgoing",
					since: "2026-07-19T09:00:00Z",
				},
			]),
		).toThrow();
	});

	it("rejects a profile with an invalid identity", () => {
		expect(() =>
			parseProfiles([
				{
					profile_id: "nope",
					environment_id: E,
					profile_name: "x",
					environment_name: "y",
					role: "owner",
					contract_version: 2,
					created_at: "2026-08-20T00:00:00Z",
				},
			]),
		).toThrow();
	});

	it("keeps team capabilities consistent", () => {
		const team = parseTeam({
			profile_id: P,
			role: "contributor",
			capabilities: { read: true, write: true, authorize: false, manage_members: false },
			members: [
				{ user_id: U, email: "a@b.c", display_name: "A", role: "contributor", joined_at: "2026-08-20T00:00:00Z" },
			],
			invitations: [],
		});
		expect(team.capabilities.manageMembers).toBe(false);
		expect(team.members[0]?.displayName).toBe("A");
	});

	it("parses company and private session audiences", () => {
		const base = {
			session_id: S1,
			client_session_id: S2,
			profile_id: P,
			environment_id: E,
			title: "T",
			status: "open",
			created_by_user_id: U,
			created_at: "2026-08-20T00:00:00Z",
			updated_at: "2026-08-20T00:00:00Z",
		};
		expect(parseSession({ ...base, audience_kind: "company", audience_user_id: null }).audience).toEqual({
			kind: "company",
		});
		expect(parseSession({ ...base, audience_kind: "member_private", audience_user_id: U }).audience).toEqual({
			kind: "member_private",
			userId: U,
		});
		expect(() => parseSession({ ...base, audience_kind: "member_private", audience_user_id: null })).toThrow();
	});

	it("reads created-company bootstrap state when present and tolerates its absence", () => {
		const base = {
			profile_id: P,
			environment_id: E,
			profile_name: "N",
			environment_name: "main",
			role: "owner",
			contract_version: 2,
			created_at: "2026-08-20T00:00:00Z",
		};
		expect(parseCreatedCompany(base).bootstrapState).toBeUndefined();
		expect(parseCreatedCompany({ ...base, bootstrap_state: "queued" }).bootstrapState).toBe("queued");
	});

	it("parses staff and tolerates older rosters without a creature", () => {
		const staff = parseStaff({
			profile_id: P,
			staff_agent_id: S1,
			display_name: "Ada",
			role: "Operations",
			charter: "Keep things running",
			appearance_color: "teal",
			appearance_shape: "round",
			appearance_creature: null,
			model_provider: null,
			model_id: null,
			employment_status: "active",
			lifecycle_state: "active",
			version: 3,
			created_at: "2026-08-20T00:00:00Z",
			updated_at: "2026-08-21T00:00:00Z",
			updated_by_user_id: U,
		});
		expect(staff.appearance.creature).toBeUndefined();
		expect(staff.version).toBe(3);
	});
});

describe("organization hierarchy", () => {
	const agent = (id: string, name: string, status: "active" | "archived" = "active"): HostedStaffAgent => ({
		profileId: P,
		id,
		displayName: name,
		role: "Staff",
		charter: "",
		appearance: { color: "teal", shape: "round" },
		employmentStatus: status,
		lifecycleState: "active",
		version: 1,
		createdAt: "2026-08-20T00:00:00Z",
		updatedAt: "2026-08-20T00:00:00Z",
		updatedByUserId: U,
	});

	it("returns undefined for an unseeded company and lists staff flat", () => {
		expect(
			parseHostedCompanyOrganization({
				schema: "qorpera.company-organization/v1",
				profile_id: P,
				cofounder: null,
				formation: null,
				responsibilities: [],
				projects: [],
			}),
		).toBeUndefined();
		const hierarchy = buildCompanyHierarchy(undefined, [agent(S1, "Ada"), agent(S2, "Bo", "archived")]);
		expect(hierarchy.primary.map((node) => node.kind)).toEqual(["agent"]);
		expect(hierarchy.inactive.map((node) => node.label)).toEqual(["Bo"]);
	});

	it("places the Co-Founder first, then responsibilities with their accountable agent, then remaining staff", () => {
		const organization = parseHostedCompanyOrganization({
			schema: "qorpera.company-organization/v1",
			profile_id: P,
			cofounder: { staff_agent_id: S1, formation_id: F, member_session_id: null },
			formation: {
				formation_id: F,
				state: "operating",
				status: "active",
				revision: 4,
				projection_status: "verified",
				source_path: "organization/formation.json",
			},
			responsibilities: [
				{
					responsibility_id: E,
					slug: "finance",
					name: "Finance",
					outcome: "Cash is known",
					status: "active",
					accountable_staff_agent_id: S2,
					accountable_user_id: null,
					attention_cadence: "weekly",
					measures: [],
					version: 1,
					source_path: "organization/responsibilities/finance.json",
				},
			],
			projects: [],
		});
		expect(organization?.formation.state).toBe("operating");
		const hierarchy = buildCompanyHierarchy(organization, [agent(S1, "Co"), agent(S2, "Fin"), agent(U, "Extra")]);
		expect(hierarchy.primary.map((node) => node.kind)).toEqual(["cofounder", "responsibility", "agent"]);
		expect(hierarchy.primary[1]?.children.map((node) => `${node.kind}:${node.role ?? ""}`)).toEqual([
			"agent:Accountable",
		]);
		expect(hierarchy.formationState).toBe("operating");
	});
});
