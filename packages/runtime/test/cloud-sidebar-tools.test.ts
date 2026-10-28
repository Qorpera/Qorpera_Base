import type { CloudFolderSidebar } from "@qorpera/runtime/cloud-folder-sidebar";
import { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { CloudNativeToolBoundary } from "@qorpera/runtime/cloud-native-tool-boundary";
import { cloudSidebarTools } from "@qorpera/runtime/cloud-sidebar-tools";
import { describe, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

const bob = "30000000-0000-4000-8000-000000000031";

/** The tool over a fake of the sections file writer that answers every call (cloud-folder-sidebar.test.ts covers what
 * the writer saves and how it answers a refusal). */
async function fixture() {
	const { binding, authority } = nativeToolAuthorityFixture();
	const run = await CloudNativeToolRun.open(
		binding,
		{ describeToolAuthority: async () => authority },
		new AbortController().signal,
	);
	const writer = {
		run: vi.fn<CloudFolderSidebar["run"]>(async () => ({ kind: "text", value: '{"changed":true}' })),
	};
	const boundary = new CloudNativeToolBoundary({
		companyId: run.identity.companyId,
		runId: run.identity.runId,
		identity: run.identity,
		tools: cloudSidebarTools(binding, run.identity, { folderSidebar: writer as unknown as CloudFolderSidebar }),
		assertActive: (signal) => run.assertActive(signal),
		signal: run.signal,
	});
	return { binding, run, writer, boundary };
}

describe("agent sidebar tool", () => {
	it("hands the writer a coworker's move by section name through the run binding", async () => {
		const f = await fixture();
		try {
			const moved = await f.boundary.invoke("sidebar_1", "qorpera", "organize_sidebar", {
				action: "move_agent",
				agentId: bob.toUpperCase(),
				section: " Research ",
			});
			expect(moved.success, JSON.stringify(moved)).toBe(true);
			expect(f.writer.run).toHaveBeenCalledWith(
				{ action: "move_agent", agentId: bob, section: "Research" },
				expect.objectContaining({ callId: "sidebar_1" }),
			);
			expect(JSON.parse(moved.contentItems[0].text).trust).toBe("untrusted_data");
			expect(JSON.stringify(moved)).not.toContain(f.binding.credentialCapsuleId);
			// Out of every section: null is Unassigned.
			const unassigned = await f.boundary.invoke("sidebar_2", "qorpera", "organize_sidebar", {
				action: "move_agent",
				agentId: bob,
				section: null,
			});
			expect(unassigned.success, JSON.stringify(unassigned)).toBe(true);
			expect(f.writer.run).toHaveBeenLastCalledWith(
				{ action: "move_agent", agentId: bob, section: null },
				expect.objectContaining({ callId: "sidebar_2" }),
			);
			// The boundary replays a call it already made without a second save.
			expect(
				await f.boundary.invoke("sidebar_2", "qorpera", "organize_sidebar", {
					action: "move_agent",
					agentId: bob,
					section: null,
				}),
			).toEqual(unassigned);
			expect(f.writer.run).toHaveBeenCalledTimes(2);
		} finally {
			f.run.close();
		}
	});
	it("normalizes section names and refuses fields an action does not take before the writer sees them", async () => {
		const f = await fixture();
		try {
			const created = await f.boundary.invoke("sidebar_3", "qorpera", "organize_sidebar", {
				action: "create_section",
				name: "  Customer   support ",
			});
			expect(created.success, JSON.stringify(created)).toBe(true);
			expect(f.writer.run).toHaveBeenCalledWith(
				{ action: "create_section", name: "Customer support" },
				expect.objectContaining({ callId: "sidebar_3" }),
			);
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
			expect(f.writer.run).toHaveBeenCalledTimes(1);
		} finally {
			f.run.close();
		}
	});
});

describe("a folder-v2 company's sections", () => {
	it("goes through the sections file writer and names sections by name", async () => {
		const { binding, authority } = nativeToolAuthorityFixture();
		const identity = authority.identity;
		const run = vi.fn(async () => ({ kind: "text" as const, value: '{"changed":true}' }));
		const [tool] = cloudSidebarTools(binding, identity, {
			folderSidebar: { run } as unknown as CloudFolderSidebar,
		});
		if (!tool) throw new Error("Missing sidebar tool");
		expect(tool.description).toContain("QorperaOS/agents/sections.md");
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
	});
});
