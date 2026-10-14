import { randomUUID } from "node:crypto";
import { CloudFolderGroupChats } from "@qorpera/runtime/cloud-folder-group-chats";
import { CloudFolderHiring } from "@qorpera/runtime/cloud-folder-hiring";
import { cloudHiringTools } from "@qorpera/runtime/cloud-hiring-tools";
import type { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { CloudNativeToolBoundary } from "@qorpera/runtime/cloud-native-tool-boundary";
import { CloudNativeToolOperations } from "@qorpera/runtime/cloud-native-tool-operations";
import { afterEach, describe, expect, it } from "vitest";
import { folderWriterFixture } from "./fixtures/folder-writer-fixture.ts";

const runs: CloudNativeToolRun[] = [];
afterEach(() => {
	for (const run of runs.splice(0)) run.close();
});

/** The hiring tools on their folder writers, behind the boundary, with a review that lets every call run. */
async function fixture() {
	const f = await folderWriterFixture({ folders: ["agents/groups"] });
	runs.push(f.run);
	const operations = new CloudNativeToolOperations(f.run, f.operationControl);
	const tools = cloudHiringTools(f.identity, {
		folderHiring: new CloudFolderHiring({ folder: f.folder, operations, identity: f.identity }),
		folderGroupChats: new CloudFolderGroupChats({ folder: f.folder, operations, identity: f.identity }),
	});
	const boundary = new CloudNativeToolBoundary({
		companyId: f.identity.companyId,
		runId: f.identity.runId,
		identity: f.identity,
		tools,
		assertActive: (signal) => f.run.assertActive(signal),
		signal: f.run.signal,
		review: { check: async () => ({ run: true, reviewId: randomUUID() }) },
	});
	return { ...f, tools, boundary };
}
/** The tool result envelope and, for an ok result, the receipt inside it. */
function outcome(response: Awaited<ReturnType<CloudNativeToolBoundary["invoke"]>>) {
	const result = JSON.parse(response.contentItems[0].text);
	return {
		status: result.status as string,
		text: result.content.text as string,
		receipt: result.status === "ok" ? JSON.parse(result.content.text) : null,
	};
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
	it.each([
		["a grant", { grants: { resources: [] } }],
		["an identity", { agentId: "6f3f4c3e-3c0b-4a4e-9d55-2f0f7f1f8a12" }],
		["a path", { path: "agents/mikkel" }],
		["a model", { modelId: "gpt" }],
		["an unknown figure", { figure: "dragon" }],
		["an empty job", { jobDescription: "  " }],
	])("rejects %s before any write", async (_label, extra) => {
		const f = await fixture();
		expect((await f.boundary.invoke("bad", "qorpera", "hire_agent", { ...hire, ...extra })).success).toBe(false);
		expect(f.commits).toEqual([]);
		expect(f.operationControl.beginToolOperation).not.toHaveBeenCalled();
	});
	it("refuses a reused key with changed arguments before any write, and replays only the same request", async () => {
		const f = await fixture();
		const alpha = { ...hire, name: "Alpha" };
		const first = outcome(await f.boundary.invoke("hire_1", "qorpera", "hire_agent", alpha));
		expect(first.receipt).toMatchObject({ outcome: "saved", agent: { name: "Alpha", folder: "agents/alpha" } });
		const beta = outcome(await f.boundary.invoke("hire_2", "qorpera", "hire_agent", { ...alpha, name: "Beta" }));
		expect(beta.status).toBe("denied");
		expect(beta.text).toMatch(/^INVALID_ARGUMENTS: operationKey is already used in this run for a different hire/);
		// The first hire may exist already: the refusal says where to look, not to hire anew.
		expect(beta.text).toContain("check agents/ before hiring again");
		expect(beta.text).not.toContain("Beta");
		expect(f.commits).toHaveLength(1);
		// Only the same request replays, from the first call's receipt: nothing is written again.
		const replay = outcome(await f.boundary.invoke("hire_3", "qorpera", "hire_agent", { ...alpha, name: " Alpha " }));
		expect(replay.receipt).toEqual(first.receipt);
		expect(f.commits).toHaveLength(1);
	});
	it("binds the key when a call runs, so of two calls parsed under one key only the first runs", async () => {
		const f = await fixture();
		const [tool] = f.tools;
		const alpha = tool?.parseArguments({ ...hire, name: "Alpha" }) ?? {};
		const beta = tool?.parseArguments({ ...hire, name: "Beta" }) ?? {};
		expect(JSON.parse(String((await tool?.execute(alpha, f.context))?.value)).outcome).toBe("saved");
		const second = { ...f.context, callId: randomUUID(), actionReviewId: randomUUID() };
		await expect(tool?.execute(beta, second)).rejects.toThrow(
			/^operationKey is already used in this run for a different hire, .*check agents\/ before/,
		);
		expect(f.commits).toHaveLength(1);
	});
});

describe("group chat tool", () => {
	it("refuses a reused group chat key with changed arguments before any write", async () => {
		const f = await fixture();
		const first = outcome(await f.boundary.invoke("chat_1", "qorpera", "create_group_chat", chat));
		expect(first.receipt).toMatchObject({ outcome: "saved", chat: { folder: "agents/groups/onboarding-sync" } });
		const renamed = outcome(
			await f.boundary.invoke("chat_2", "qorpera", "create_group_chat", { ...chat, name: "Billing sync" }),
		);
		expect(renamed.status).toBe("denied");
		expect(renamed.text).toMatch(
			/^INVALID_ARGUMENTS: operationKey is already used in this run for a different group chat/,
		);
		expect(renamed.text).toContain("check agents/groups/ before opening another");
		expect(f.commits).toHaveLength(1);
		// The same chat with its coworkers in another order is the same request.
		const replay = outcome(
			await f.boundary.invoke("chat_3", "qorpera", "create_group_chat", {
				...chat,
				coworkerIds: [...chat.coworkerIds].reverse(),
			}),
		);
		expect(replay.receipt).toEqual(first.receipt);
		expect(f.commits).toHaveLength(1);
	});
	it.each([
		["itself as a coworker", (id: string) => ({ coworkerIds: [id] })],
		["no coworkers", () => ({ coworkerIds: [] })],
		["a member list", () => ({ members: [] })],
	])("rejects a group chat with %s", async (_label, extra) => {
		const f = await fixture();
		const response = await f.boundary.invoke("bad", "qorpera", "create_group_chat", {
			...chat,
			...extra(f.identity.staffAgentId),
		});
		expect(response.success).toBe(false);
		expect(f.commits).toEqual([]);
		expect(f.operationControl.beginToolOperation).not.toHaveBeenCalled();
	});
});
