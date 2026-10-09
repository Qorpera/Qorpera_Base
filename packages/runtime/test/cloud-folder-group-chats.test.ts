import { createHash } from "node:crypto";
import { parseCompanyStateFile } from "@qorpera/cloud-client/company-state-files";
import { type CloudFolderGroupChat, CloudFolderGroupChats } from "@qorpera/runtime/cloud-folder-group-chats";
import { CloudFolderHiring } from "@qorpera/runtime/cloud-folder-hiring";
import { CLOUD_GROUP_CHAT_TOOL_DESCRIPTION_FOLDER, cloudHiringTools } from "@qorpera/runtime/cloud-hiring-tools";
import type { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { CloudToolArgumentRefusal, CloudToolRefusal } from "@qorpera/runtime/cloud-native-tool-boundary";
import { CloudNativeToolOperations } from "@qorpera/runtime/cloud-native-tool-operations";
import { afterEach, expect, it, vi } from "vitest";
import { folderWriterFixture } from "./fixtures/folder-writer-fixture.ts";

const runs: CloudNativeToolRun[] = [];
afterEach(() => {
	for (const run of runs.splice(0)) run.close();
});

async function fixture(...args: Parameters<typeof folderWriterFixture>) {
	const f = await folderWriterFixture(...args);
	runs.push(f.run);
	const chats = (operations = new CloudNativeToolOperations(f.run, f.operationControl)) =>
		new CloudFolderGroupChats({ folder: f.folder, operations, identity: f.identity });
	return { ...f, chats };
}

const COWORKERS = ["0a1b2c3d-1111-4111-8111-111111111111", "0a1b2c3d-2222-4222-8222-222222222222"];
const CHAT: CloudFolderGroupChat = {
	operationKey: "chat-1",
	name: "Launch Week",
	purpose: "Plan the launch and keep each other posted.",
	coworkerIds: COWORKERS,
	includeRequestingMember: true,
};
const parse = (content: { value: unknown }) => JSON.parse(String(content.value));
const hashedId = (namespace: string, runId: string, key: string) => {
	const hex = createHash("sha256").update(`${namespace}:${runId}:${key}`).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((Number.parseInt(hex[16] ?? "0", 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
async function refuses(call: Promise<unknown>, reason: string) {
	const error = await call.then(
		() => null,
		(thrown: unknown) => thrown,
	);
	expect(error).toBeInstanceOf(CloudToolRefusal);
	expect((error as Error).message).toContain(reason);
}

it("saves a group chat as one new folder with group.md, recording its review", async () => {
	const f = await fixture({ folders: ["agents/groups"] });
	const result = parse(await f.chats().create(CHAT, f.context));
	const id = hashedId("qorpera.folder-group/v1", f.identity.runId, "chat-1");
	expect(result).toMatchObject({
		schema: "qorpera.group-chat-receipt/v2",
		runId: f.identity.runId,
		outcome: "saved",
		chat: { id, name: "Launch Week", folder: "agents/groups/launch-week" },
	});
	expect(result.next).toBe("The group chat Launch Week is open: tell the member its name.");
	expect(f.commits).toHaveLength(1);
	const [commit] = f.commits;
	expect(commit).toMatchObject({ key: "group-folder:chat-1", receiptId: result.receiptId });
	expect(commit?.units.map((unit) => [unit.op, unit.path])).toEqual([["new_folder", "agents/groups/launch-week"]]);
	expect(f.recordings[0]?.p_request).toEqual({
		actionReviewId: f.context.actionReviewId,
		tool: "create_group_chat",
		argumentSha256: f.context.argumentSha256,
		units: commit?.units,
	});
	const group = parseCompanyStateFile(
		"agents/groups/launch-week/group.md",
		f.text("agents/groups/launch-week/group.md") ?? "",
	);
	expect(group?.ok && group.file).toEqual({
		kind: "group",
		id,
		name: "Launch Week",
		subtitle: null,
		agents: [f.identity.staffAgentId, ...COWORKERS],
		people: [f.identity.requesterUserId],
		purpose: CHAT.purpose,
	});
	expect(f.operationControl.completeFolderToolOperation).toHaveBeenCalledTimes(1);
});

it("leaves the member out when asked, and binds the receipt to the chat and the request", async () => {
	const f = await fixture({ folders: ["agents/groups"] });
	const execute = vi.spyOn(CloudNativeToolOperations.prototype, "execute");
	const result = parse(await f.chats().create({ ...CHAT, includeRequestingMember: false }, f.context));
	expect(result.outcome).toBe("saved");
	expect(execute.mock.calls[0]?.[0].operation).toEqual({
		tool: "create_group_chat",
		toolVersion: "folder-v2/1",
		logicalOperationKey: "group:chat-1",
		arguments: { name: CHAT.name, purpose: CHAT.purpose, coworkerIds: COWORKERS, includeRequestingMember: false },
		target: { chatId: result.chat.id },
		requiresCompanyRevision: true,
	});
	execute.mockRestore();
	const group = parseCompanyStateFile(
		"agents/groups/launch-week/group.md",
		f.text("agents/groups/launch-week/group.md") ?? "",
	);
	expect(group?.ok && group.file.kind === "group" && group.file.people).toEqual([]);
});

it("numbers the handle past the chats there, and replays a finished call from its receipt", async () => {
	const f = await fixture({ folders: ["agents/groups", "agents/groups/launch-week"] });
	const first = parse(await f.chats().create(CHAT, f.context));
	expect(first.chat.folder).toBe("agents/groups/launch-week-2");
	// Only the chats under agents/groups count: "groups" is reserved under agents/, not here.
	const groups = parse(
		await f
			.chats()
			.create(
				{ ...CHAT, operationKey: "chat-2", name: "Groups" },
				{ ...f.context, callId: "call-2", actionReviewId: "5b0c2d3e-3333-4333-8333-333333333333" },
			),
	);
	expect(groups.chat.folder).toBe("agents/groups/groups");
	expect(parse(await f.chats().create(CHAT, f.context))).toEqual(first);
	expect(f.commits).toHaveLength(2);
	expect(f.recordings).toHaveLength(2);
});

it("checks the file before the review, and refuses a call without the review's approval", async () => {
	const f = await fixture({ folders: ["agents/groups"] });
	const chats = f.chats();
	let thrown: unknown = null;
	try {
		chats.check({ ...CHAT, name: "Launch\tWeek" });
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(CloudToolArgumentRefusal);
	expect((thrown as Error).message).toMatch(/^This group chat cannot be saved as the company's files: \S/);
	expect(() => chats.check(CHAT)).not.toThrow();
	const { actionReviewId: _, ...unreviewed } = f.context;
	await refuses(chats.create(CHAT, unreviewed), "needs the automatic review's approval");
	expect(f.commits).toEqual([]);
	expect(f.operationControl.beginToolOperation).not.toHaveBeenCalled();
});

it("tells the model what a conflict, a refusal and a waiting chat mean", async () => {
	const f = await fixture({ folders: ["agents/groups"] });
	vi.spyOn(f.folder, "listAll").mockResolvedValueOnce({ asOfSeq: 1, entries: [] });
	f.folders.add("agents/groups/launch-week");
	const conflict = parse(await f.chats().create(CHAT, f.context));
	expect(conflict).toMatchObject({ outcome: "conflict", reason: "exists" });
	expect(conflict.next).toContain("choose a slightly different name");
	const g = await fixture(
		{ folders: ["agents/groups"] },
		{
			hook: () => ({
				outcome: "refused",
				reason: "structured_rule",
				problems: [{ code: "rule", message: "unknown agent" }],
			}),
		},
	);
	const refused = parse(await g.chats().create(CHAT, g.context));
	expect(refused).toMatchObject({
		outcome: "refused",
		reason: "structured_rule",
		problems: [{ message: "unknown agent" }],
	});
	expect(refused.next).toContain("No group chat was opened");
	const h = await fixture(
		{ folders: ["agents/groups"] },
		{ hook: () => ({ outcome: "waiting_for_review", reason: "waiting_for_review" }) },
	);
	expect(parse(await h.chats().create(CHAT, h.context)).next).toContain("do not open it again");
});

it("is the group chat tool's folder-v2 path: its description, the check before review, a bound key, the writer behind execute", async () => {
	const f = await fixture({ folders: ["agents/groups"] });
	const operations = new CloudNativeToolOperations(f.run, f.operationControl);
	const tool = cloudHiringTools(f.identity, {
		folderHiring: new CloudFolderHiring({ folder: f.folder, operations, identity: f.identity }),
		folderGroupChats: f.chats(operations),
	})[1];
	expect(tool?.description).toBe(CLOUD_GROUP_CHAT_TOOL_DESCRIPTION_FOLDER);
	const args = {
		operationKey: "chat-1",
		name: "Launch Week",
		purpose: CHAT.purpose,
		coworkerIds: [...COWORKERS].reverse(),
	};
	expect(() => tool?.parseArguments({ ...args, name: "Launch\tWeek" })).toThrow(CloudToolArgumentRefusal);
	const parsed = tool?.parseArguments(args);
	const result = parse((await tool?.execute(parsed ?? {}, f.context)) as { value: unknown });
	expect(result).toMatchObject({ outcome: "saved", chat: { folder: "agents/groups/launch-week" } });
	expect(() => tool?.parseArguments({ ...args, name: "Other" })).toThrow(
		/check agents\/groups\/ before opening another/,
	);
});
