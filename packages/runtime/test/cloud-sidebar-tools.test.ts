import type { CloudCompanyPathControl } from "@qorpera/runtime/cloud-company-path-gateway";
import type { CloudFolderSidebar } from "@qorpera/runtime/cloud-folder-sidebar";
import { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { CloudNativeToolBoundary } from "@qorpera/runtime/cloud-native-tool-boundary";
import { cloudSidebarTools } from "@qorpera/runtime/cloud-sidebar-tools";
import { describe, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

const bob = "30000000-0000-4000-8000-000000000031";

async function fixture(result?: (request: Record<string, unknown>, runId: string) => unknown) {
	const { binding, authority } = nativeToolAuthorityFixture();
	const run = await CloudNativeToolRun.open(
		binding,
		{ describeToolAuthority: async () => authority },
		new AbortController().signal,
	);
	const call = vi.fn<CloudCompanyPathControl["call"]>(async (_method, args) => {
		const request = (args as { p_request: Record<string, unknown> }).p_request;
		if (result) return result(request, binding.runId);
		return {
			schema: "qorpera.agent-sidebar/v1",
			runId: binding.runId,
			action: request.action,
			changed: request.action !== "list",
			sections: [
				{ id: "51000000-0000-4000-8000-000000000001", name: "Research", agents: [{ id: bob, name: "Bob" }] },
			],
			unassigned: [],
		};
	});
	const boundary = new CloudNativeToolBoundary({
		companyId: run.identity.companyId,
		runId: run.identity.runId,
		identity: run.identity,
		tools: cloudSidebarTools(binding, run.identity, { call }),
		assertActive: (signal) => run.assertActive(signal),
		signal: run.signal,
	});
	return { binding, run, call, boundary };
}

describe("agent sidebar tool", () => {
	it("moves a coworker by section name through the run binding", async () => {
		const f = await fixture();
		try {
			const moved = await f.boundary.invoke("sidebar_1", "qorpera", "organize_sidebar", {
				action: "move_agent",
				agentId: bob.toUpperCase(),
				section: " Research ",
			});
			expect(moved.success, JSON.stringify(moved)).toBe(true);
			expect(f.call.mock.calls[0].slice(0, 2)).toEqual([
				"qorpera_manage_agent_sidebar",
				{ p_binding: f.binding, p_request: { action: "move_agent", agentId: bob, section: "Research" } },
			]);
			expect(JSON.parse(moved.contentItems[0].text).trust).toBe("untrusted_data");
			expect(JSON.stringify(moved)).not.toContain(f.binding.credentialCapsuleId);
			// Out of every section: null is Unassigned.
			const unassigned = await f.boundary.invoke("sidebar_2", "qorpera", "organize_sidebar", {
				action: "move_agent",
				agentId: bob,
				section: null,
			});
			expect(unassigned.success, JSON.stringify(unassigned)).toBe(true);
			expect(f.call.mock.calls[1][1]).toEqual({
				p_binding: f.binding,
				p_request: { action: "move_agent", agentId: bob, section: null },
			});
		} finally {
			f.run.close();
		}
	});
	it("normalizes section names and refuses fields an action does not take", async () => {
		const f = await fixture();
		try {
			const created = await f.boundary.invoke("sidebar_3", "qorpera", "organize_sidebar", {
				action: "create_section",
				name: "  Customer   support ",
			});
			expect(created.success, JSON.stringify(created)).toBe(true);
			expect(f.call.mock.calls[0][1]).toEqual({
				p_binding: f.binding,
				p_request: { action: "create_section", name: "Customer support" },
			});
			for (const [callId, args] of [
				["bad_1", { action: "list", section: "Research" }],
				["bad_2", { action: "create_section", name: "   " }],
				["bad_3", { action: "create_section", name: "x".repeat(61) }],
				["bad_4", { action: "move_agent", agentId: "Bob", section: "Research" }],
				["bad_5", { action: "move_agent", agentId: bob }],
				["bad_6", { action: "delete_section", section: null }],
				["bad_7", { action: "pin", agentId: bob }],
			] as const) {
				const refused = await f.boundary.invoke(callId, "qorpera", "organize_sidebar", args);
				expect(refused.success, callId).toBe(false);
			}
			expect(f.call).toHaveBeenCalledTimes(1);
		} finally {
			f.run.close();
		}
	});
	it("hands a refusal to the model as a result, and rejects a refusal that claims a change", async () => {
		const f = await fixture((request, runId) => ({
			schema: "qorpera.agent-sidebar/v1",
			runId,
			action: request.action,
			changed: request.action === "rename_section",
			refused: "No section is called that",
			sections: [],
			unassigned: [],
		}));
		try {
			const refused = await f.boundary.invoke("sidebar_5", "qorpera", "organize_sidebar", {
				action: "move_agent",
				agentId: bob,
				section: "Nowhere",
			});
			expect(refused.success, JSON.stringify(refused)).toBe(true);
			expect(refused.contentItems[0].text).toContain("No section is called that");
			const contradictory = await f.boundary.invoke("sidebar_6", "qorpera", "organize_sidebar", {
				action: "rename_section",
				section: "Sales",
				name: "Growth",
			});
			expect(contradictory.success).toBe(false);
		} finally {
			f.run.close();
		}
	});
	it("rejects a receipt for another run or action", async () => {
		const f = await fixture((request) => ({
			schema: "qorpera.agent-sidebar/v1",
			runId: "00000000-0000-4000-8000-000000000000",
			action: request.action,
			changed: false,
			sections: [],
			unassigned: [],
		}));
		try {
			const listed = await f.boundary.invoke("sidebar_4", "qorpera", "organize_sidebar", { action: "list" });
			expect(listed.success).toBe(false);
		} finally {
			f.run.close();
		}
	});
});

describe("a folder-v2 company's sections", () => {
	it("goes through the sections file writer and names sections by name", async () => {
		const { binding, authority } = nativeToolAuthorityFixture();
		const identity = authority.identity;
		const call = vi.fn<CloudCompanyPathControl["call"]>(async () => ({}));
		const run = vi.fn(async () => ({ kind: "text" as const, value: '{"changed":true}' }));
		const [tool] = cloudSidebarTools(
			binding,
			identity,
			{ call },
			{
				folderSidebar: { run } as unknown as CloudFolderSidebar,
			},
		);
		if (!tool) throw new Error("Missing sidebar tool");
		expect(tool.description).toContain("agents/sections.md");
		expect(tool.description).toContain("name the section by its name;");
		expect(tool.description).not.toContain("by its id or name");
		const context = {
			companyId: identity.companyId,
			runId: identity.runId,
			callId: "call-1",
			argumentSha256: "a".repeat(64),
			signal: new AbortController().signal,
			identity,
		};
		const request = tool.parseArguments({ action: "move_agent", agentId: bob, section: "Sales" });
		await expect(tool.execute(request, context)).resolves.toEqual({ kind: "text", value: '{"changed":true}' });
		expect(run).toHaveBeenCalledWith({ action: "move_agent", agentId: bob, section: "Sales" }, context);
		expect(call).not.toHaveBeenCalled();
	});
});
