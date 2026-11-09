import type { CloudCompanyPathControl } from "@qorpera/runtime/cloud-company-path-gateway";
import { cloudMemberOfferTools } from "@qorpera/runtime/cloud-member-offer-tools";
import { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { CloudNativeToolBoundary } from "@qorpera/runtime/cloud-native-tool-boundary";
import { describe, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

/* The Co-Founder's tools to deal the team out between members (cloud-member-offer-tools.ts, migration 20260930702000):
 * crew_and_members reads who works for whom, offer_agents_to_member asks a member to take agents. */

const ANN = "70200000-0000-4000-8000-0000000000a1";
const BO = "70200000-0000-4000-8000-0000000000b1";
const CLARA = "70200000-0000-4000-8000-0000000000c1";
const DAGNY = "70200000-0000-4000-8000-0000000000d1";

async function fixture() {
	const { binding, authority } = nativeToolAuthorityFixture();
	const run = await CloudNativeToolRun.open(
		binding,
		{ describeToolAuthority: async () => authority },
		new AbortController().signal,
	);
	const call = vi.fn<CloudCompanyPathControl["call"]>(async (method, args) => {
		if (method === "qorpera_cofounder_crew")
			return {
				schema: "qorpera.cofounder-crew/v1",
				runId: binding.runId,
				members: [
					{
						userId: ANN,
						name: "Ann Holm",
						role: "owner",
						login: { state: "ready", used_percent: 71, resets_at: null },
					},
					{
						userId: BO,
						name: "Bo Lund",
						role: "admin",
						login: { state: "ready", used_percent: 0, resets_at: null },
					},
				],
				agents: [
					{ agentId: CLARA, name: "Clara", role: "Marketing Lead", worksFor: ANN },
					{ agentId: DAGNY, name: "Dagny", role: "Financial Officer", worksFor: null },
				],
				asks: [
					{
						agentId: CLARA,
						to: BO,
						answerBy: BO,
						byAgent: true,
						why: "You run growth.",
						at: "2026-11-09T12:00:00Z",
					},
				],
			};
		const request = (args as { p_request: { member: string; agents: string[] } }).p_request;
		return {
			schema: "qorpera.agent-offers/v1",
			runId: binding.runId,
			member: "Bo Lund",
			asked: request.agents,
			alreadyTheirs: [],
			alreadyAsked: [],
		};
	});
	const boundary = new CloudNativeToolBoundary({
		companyId: run.identity.companyId,
		runId: run.identity.runId,
		identity: run.identity,
		tools: cloudMemberOfferTools(binding, run.identity, { call }),
		assertActive: (signal) => run.assertActive(signal),
		signal: run.signal,
	});
	return { binding, run, call, boundary };
}

describe("the Co-Founder's member offer tools", () => {
	it("shows each member with their ChatGPT and agents, who works for nobody, and the open asks", async () => {
		const f = await fixture();
		try {
			const crew = await f.boundary.invoke("mo_1", "qorpera", "crew_and_members", {});
			expect(crew.success, JSON.stringify(crew)).toBe(true);
			expect(f.call.mock.calls[0]?.slice(0, 2)).toEqual(["qorpera_cofounder_crew", { p_binding: f.binding }]);
			// The tool's text sits inside the result envelope as a JSON string.
			const text = crew.contentItems[0]?.text ?? "";
			for (const shown of ["Ann Holm", "Bo Lund", "Clara", "worksForNobody", "Dagny", "You run growth."])
				expect(text).toContain(shown);
			expect(text.indexOf("Ann Holm")).toBeLessThan(text.indexOf("worksForNobody"));
		} finally {
			f.run.close();
		}
	});

	it("asks a member to take agents through the run binding, with the reason trimmed", async () => {
		const f = await fixture();
		try {
			const offered = await f.boundary.invoke("mo_2", "qorpera", "offer_agents_to_member", {
				member: " Bo ",
				agents: ["Clara", "Dagny"],
				why: " You said you run growth. ",
			});
			expect(offered.success, JSON.stringify(offered)).toBe(true);
			expect(f.call.mock.calls[0]?.slice(0, 2)).toEqual([
				"qorpera_offer_agents_to_member",
				{
					p_binding: f.binding,
					p_request: { member: "Bo", agents: ["Clara", "Dagny"], why: "You said you run growth." },
				},
			]);
			expect(offered.contentItems[0]?.text).toMatch(/asked.{0,6}\[.{0,4}Clara.{0,6}Dagny/);
			expect(offered.contentItems[0]?.text).toContain("Nothing moves until the member says yes");
			expect(JSON.stringify(offered)).not.toContain(f.binding.credentialCapsuleId);
		} finally {
			f.run.close();
		}
	});

	it("refuses a malformed offer without calling the cloud", async () => {
		const f = await fixture();
		try {
			for (const [callId, tool, args] of [
				["bad_1", "offer_agents_to_member", { member: "Bo", agents: [] }],
				["bad_2", "offer_agents_to_member", { member: "", agents: ["Clara"] }],
				["bad_3", "offer_agents_to_member", { member: "Bo", agents: ["Clara"], extra: true }],
				[
					"bad_4",
					"offer_agents_to_member",
					{ member: "Bo", agents: Array.from({ length: 21 }, (_, n) => `A${n}`) },
				],
				["bad_5", "offer_agents_to_member", { member: "Bo", agents: ["Clara"], why: "x".repeat(281) }],
				["bad_6", "crew_and_members", { anything: 1 }],
			] as const) {
				const refused = await f.boundary.invoke(callId, "qorpera", tool, args);
				expect(refused.success, callId).toBe(false);
			}
			expect(f.call).not.toHaveBeenCalled();
		} finally {
			f.run.close();
		}
	});
});
