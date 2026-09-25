import type { CloudCompanyPathGateway } from "@qorpera/runtime/cloud-company-path-gateway";
import { cloudHiringTools } from "@qorpera/runtime/cloud-hiring-tools";
import { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { CloudNativeToolBoundary } from "@qorpera/runtime/cloud-native-tool-boundary";
import { describe, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

async function fixture() {
	const { binding, authority } = nativeToolAuthorityFixture();
	const run = await CloudNativeToolRun.open(
		binding,
		{ describeToolAuthority: async () => authority },
		new AbortController().signal,
	);
	const mutate = vi.fn<CloudCompanyPathGateway["mutate"]>(
		async (_operation, input) =>
			({
				schema: "qorpera.company-path-result/v1",
				state: "proposed",
				operationKey: input.operationKey,
				path: input.path,
				version: null,
				snapshotId: null,
				receiptId: "6f3f4c3e-3c0b-4a4e-9d55-2f0f7f1f8a10",
				proposalId: "6f3f4c3e-3c0b-4a4e-9d55-2f0f7f1f8a11",
			}) as never,
	);
	const apply = vi.fn<CloudCompanyPathGateway["applyOwnOrganizationDocument"]>(async (proposalId) => ({
		state: "applied",
		proposalId,
		snapshotId: "6f3f4c3e-3c0b-4a4e-9d55-2f0f7f1f8a12",
	}));
	let tick = 0;
	const boundary = new CloudNativeToolBoundary({
		companyId: run.identity.companyId,
		runId: run.identity.runId,
		identity: run.identity,
		tools: cloudHiringTools(
			{ mutate, applyOwnOrganizationDocument: apply },
			run.identity,
			() => new Date(Date.UTC(2026, 8, 19, 20, 0, tick++)),
		),
		assertActive: (signal) => run.assertActive(signal),
		signal: run.signal,
	});
	return { run, mutate, apply, boundary };
}
const hire = {
	operationKey: "sales-dev-1",
	name: "Mikkel",
	role: "Sales development",
	jobDescription:
		"Own outbound design-partner conversations. Voice: plain and friendly. Escalate signed pilots to the founder.",
	firstAssignment: "List the first ten salons to contact and why.",
	figure: "flame",
};

const chat = {
	operationKey: "onboarding-sync",
	name: "Onboarding sync",
	purpose: "Coordinate salon onboarding between support and billing.",
	coworkerIds: ["6f3f4c3e-3c0b-4a4e-9d55-2f0f7f1f8b01", "6f3f4c3e-3c0b-4a4e-9d55-2f0f7f1f8a99"],
};

describe("agent hiring tool", () => {
	it("writes one canonical agent document, approves it by policy and reports the hire as applied", async () => {
		const f = await fixture();
		try {
			const result = await f.boundary.invoke("hire_1", "qorpera", "hire_agent", hire);
			expect(result.success, JSON.stringify(result)).toBe(true);
			const [operation, input] = f.mutate.mock.calls[0];
			expect(operation).toBe("write");
			expect(input.expectedVersion).toBeNull();
			expect(input.operationKey).toBe("hire:sales-dev-1");
			expect(input.path).toMatch(/^organization\/agents\/[0-9a-f-]{36}\.json$/);
			const document = JSON.parse(input.text as string);
			expect(Object.keys(document)).toHaveLength(14);
			expect(document).toMatchObject({
				schema: "qorpera.company-agent/v1",
				agentId: input.path.slice(20, 56),
				revision: 1,
				displayName: "Mikkel",
				hireOverlay: { charter: hire.jobDescription, templateId: null },
				appearance: { color: "native", shape: "round", creature: "flame" },
				grants: { responsibilities: [], projects: [], rooms: [], resources: [] },
				startupInstructions: hire.firstAssignment,
				employmentStatus: "active",
				lifecycleState: "setup",
			});
			const receipt = JSON.parse(JSON.parse(result.contentItems[0].text).content.text);
			expect(f.apply.mock.calls[0].slice(0, 2)).toEqual(["6f3f4c3e-3c0b-4a4e-9d55-2f0f7f1f8a11", input.text]);
			expect(receipt).toMatchObject({ state: "applied", awaiting: null, agentId: document.agentId });
		} finally {
			f.run.close();
		}
	});
	it("retries one operation key with identical bytes and identity", async () => {
		const f = await fixture();
		try {
			await f.boundary.invoke("hire_a", "qorpera", "hire_agent", hire);
			await f.boundary.invoke("hire_b", "qorpera", "hire_agent", hire);
			expect(f.mutate).toHaveBeenCalledTimes(2);
			expect(f.mutate.mock.calls[1][1]).toEqual(f.mutate.mock.calls[0][1]);
			await f.boundary.invoke("hire_c", "qorpera", "hire_agent", { ...hire, operationKey: "sales-dev-2" });
			expect(f.mutate.mock.calls[2][1].path).not.toBe(f.mutate.mock.calls[0][1].path);
		} finally {
			f.run.close();
		}
	});
	it.each([
		["a grant", { grants: { resources: [] } }],
		["an identity", { agentId: "6f3f4c3e-3c0b-4a4e-9d55-2f0f7f1f8a12" }],
		["a path", { path: "organization/agents/x.json" }],
		["a model", { modelId: "gpt" }],
		["an unknown figure", { figure: "dragon" }],
		["an empty job", { jobDescription: "  " }],
	])("rejects %s before any write", async (_label, extra) => {
		const f = await fixture();
		try {
			expect((await f.boundary.invoke("bad", "qorpera", "hire_agent", { ...hire, ...extra })).success).toBe(false);
			expect(f.mutate).not.toHaveBeenCalled();
		} finally {
			f.run.close();
		}
	});
	it("falls back to a waiting proposal when the cloud declines policy approval", async () => {
		const f = await fixture();
		try {
			f.apply.mockRejectedValueOnce(new Error("Organization approval authority is unavailable"));
			const waiting = await f.boundary.invoke("hire_w", "qorpera", "hire_agent", hire);
			expect(JSON.parse(JSON.parse(waiting.contentItems[0].text).content.text)).toMatchObject({
				state: "proposed",
				awaiting: "member_approval",
			});
		} finally {
			f.run.close();
		}
	});
	it("opens a group chat with itself, the chosen coworkers and the requesting member", async () => {
		const f = await fixture();
		try {
			const result = await f.boundary.invoke("chat_1", "qorpera", "create_group_chat", chat);
			expect(result.success, JSON.stringify(result)).toBe(true);
			const [, input] = f.mutate.mock.calls[0];
			expect(input.path).toMatch(/^organization\/rooms\/[0-9a-f-]{36}\.json$/);
			const document = JSON.parse(input.text as string);
			expect(document).toMatchObject({
				schema: "qorpera.company-room/v1",
				roomId: input.path.slice(19, 55),
				name: "Onboarding sync",
				status: "active",
				projectId: null,
				version: 1,
			});
			expect(document.members).toEqual([
				{ kind: "member", id: f.run.identity.requesterUserId },
				{ kind: "staff_agent", id: f.run.identity.staffAgentId },
				...[...chat.coworkerIds].sort().map((id) => ({ kind: "staff_agent", id })),
			]);
			expect(f.apply).toHaveBeenCalledTimes(1);
			const solo = await f.boundary.invoke("chat_2", "qorpera", "create_group_chat", {
				...chat,
				operationKey: "agents-only",
				includeRequestingMember: false,
			});
			expect(solo.success).toBe(true);
			expect(JSON.parse(f.mutate.mock.calls[1][1].text as string).members[0]).toEqual({
				kind: "staff_agent",
				id: f.run.identity.staffAgentId,
			});
		} finally {
			f.run.close();
		}
	});
	it.each([
		["itself as a coworker", (id: string) => ({ coworkerIds: [id] })],
		["no coworkers", () => ({ coworkerIds: [] })],
		["a member list", () => ({ members: [] })],
	])("rejects a group chat with %s", async (_label, extra) => {
		const f = await fixture();
		try {
			const response = await f.boundary.invoke("bad", "qorpera", "create_group_chat", {
				...chat,
				...extra(f.run.identity.staffAgentId),
			});
			expect(response.success).toBe(false);
			expect(f.mutate).not.toHaveBeenCalled();
		} finally {
			f.run.close();
		}
	});
});
