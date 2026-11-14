import { createHash, randomUUID } from "node:crypto";
import { parseCompanyStateFile, writeAgentFile } from "@qorpera/cloud-client/company-state-files";
import { CloudFolderGroupChats } from "@qorpera/runtime/cloud-folder-group-chats";
import { type CloudFolderHire, CloudFolderHiring } from "@qorpera/runtime/cloud-folder-hiring";
import {
	CLOUD_END_ROLE_TOOL_DESCRIPTION,
	CLOUD_HIRE_TOOL_DESCRIPTION_FOLDER,
	cloudHiringTools,
} from "@qorpera/runtime/cloud-hiring-tools";
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
	const hiring = (operations = new CloudNativeToolOperations(f.run, f.operationControl)) =>
		new CloudFolderHiring({ folder: f.folder, operations, identity: f.identity });
	return { ...f, hiring };
}

const HIRE: CloudFolderHire = {
	operationKey: "hire-1",
	name: "Ada Lind",
	role: "Bookkeeper",
	jobDescription: "Keep the books.\n\nEscalate anything over 10,000 kr to the founders.",
	firstAssignment: "Reconcile September\nMatch every bank line to a receipt.",
	figure: "acorn",
};
const parse = (content: { value: unknown }) => JSON.parse(String(content.value));
/** The writer's ids: a namespace, the run and the operation key, formatted as a version-4 UUID. */
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

it("saves a hire as one new folder with agent.md, its folders and the first assignment, recording its review", async () => {
	const f = await fixture();
	const result = parse(await f.hiring().hire(HIRE, f.context));
	expect(result).toMatchObject({
		schema: "qorpera.agent-hire-receipt/v2",
		runId: f.identity.runId,
		outcome: "saved",
		agent: { name: "Ada Lind", role: "Bookkeeper", folder: "QorperaOS/agents/ada-lind" },
	});
	expect(result.next).toContain(
		"the platform starts Ada Lind on it by itself, usually within a minute: no start message is needed.",
	);
	expect(result.next).toContain("if Ada Lind has not begun after a few minutes");
	expect(result.next).toContain(`send_coworker_message (recipientStaffId ${result.agent.id})`);
	expect(result.next).toContain("a message sent while Ada Lind is still starting waits for it.");
	expect(result.next).not.toContain("has not started");
	expect(result.agent.id).toBe(hashedId("qorpera.folder-hire/v1", f.identity.runId, "hire-1"));
	// One unit; the review is this call's approval, recorded for exactly the units the commit carries.
	expect(f.commits).toHaveLength(1);
	const [commit] = f.commits;
	expect(commit).toMatchObject({ key: "hire-folder:hire-1", receiptId: result.receiptId });
	expect(commit?.units.map((unit) => [unit.op, unit.path])).toEqual([["new_folder", "QorperaOS/agents/ada-lind"]]);
	expect(f.recordings).toHaveLength(1);
	expect(f.recordings[0]?.p_request).toEqual({
		actionReviewId: f.context.actionReviewId,
		tool: "hire_agent",
		argumentSha256: f.context.argumentSha256,
		units: commit?.units,
	});
	expect(f.reviews.get(commit?.reviewId as string)).toBe(JSON.stringify(commit?.units));
	expect([...f.folders].filter((path) => path.startsWith("QorperaOS/agents/ada-lind")).sort()).toEqual([
		"QorperaOS/agents/ada-lind",
		"QorperaOS/agents/ada-lind/memory",
		"QorperaOS/agents/ada-lind/routines",
		"QorperaOS/agents/ada-lind/skills",
		"QorperaOS/agents/ada-lind/todos",
	]);
	// The files are the shared writers' and parse as the database will check them.
	const agent = parseCompanyStateFile(
		"QorperaOS/agents/ada-lind/agent.md",
		f.text("QorperaOS/agents/ada-lind/agent.md") ?? "",
	);
	expect(agent?.ok && agent.file).toMatchObject({
		kind: "agent",
		id: result.agent.id,
		name: "Ada Lind",
		role: "Bookkeeper",
		agentKind: "agent",
		status: "active",
		figure: "acorn",
		instructions: HIRE.jobDescription,
	});
	const todo = parseCompanyStateFile(
		"QorperaOS/agents/ada-lind/todos/first-assignment.md",
		f.text("QorperaOS/agents/ada-lind/todos/first-assignment.md") ?? "",
	);
	expect(todo?.ok && todo.file).toMatchObject({
		kind: "todo",
		id: hashedId("qorpera.folder-hire-todo/v1", f.identity.runId, "hire-1"),
		title: "Reconcile September",
		status: "open",
		requestedBy: f.identity.requesterUserId,
		detail: HIRE.firstAssignment,
	});
	expect(f.operationControl.completeFolderToolOperation).toHaveBeenCalledTimes(1);
});

it("derives the agent and todo ids from the run and the operation key, so a call built again is the same", async () => {
	const one = await fixture();
	const two = await fixture();
	const a = parse(await one.hiring().hire(HIRE, one.context));
	const b = parse(await two.hiring().hire(HIRE, two.context));
	// Two fixtures are two runs: other ids. In one run the same key gives the same files (the replay below).
	expect(a.agent.id).not.toBe(b.agent.id);
	const hiring = one.hiring();
	const again = parse(await hiring.hire(HIRE, one.context));
	expect(again).toEqual(a);
	// A finished call replays from its receipt: nothing is staged, recorded or committed again.
	expect(one.commits).toHaveLength(1);
	expect(one.recordings).toHaveLength(1);
});

it("numbers the handle past the names taken, the reserved ones included", async () => {
	const f = await fixture({ folders: ["QorperaOS/agents/ada-lind"] });
	expect(parse(await f.hiring().hire(HIRE, f.context)).agent.folder).toBe("QorperaOS/agents/ada-lind-2");
	// Each tool call has its own call id and its own approval.
	const call = () => ({ ...f.context, callId: randomUUID(), actionReviewId: randomUUID() });
	expect(parse(await f.hiring().hire({ ...HIRE, operationKey: "hire-2", name: "Groups" }, call())).agent.folder).toBe(
		"QorperaOS/agents/groups-2",
	);
	expect(parse(await f.hiring().hire({ ...HIRE, operationKey: "hire-3", name: "Ærø Ø" }, call())).agent.folder).toBe(
		"QorperaOS/agents/aeroe-oe",
	);
});

it("titles the first todo with the assignment's first line, as one line of at most 200 bytes", async () => {
	const f = await fixture();
	const long = `${"Å".repeat(150)}\u0007more`;
	await f.hiring().hire({ ...HIRE, firstAssignment: `\n  ${long}\nThe rest.` }, f.context);
	const todo = parseCompanyStateFile(
		"QorperaOS/agents/ada-lind/todos/first-assignment.md",
		f.text("QorperaOS/agents/ada-lind/todos/first-assignment.md") ?? "",
	);
	const title = todo?.ok && todo.file.kind === "todo" ? todo.file.title : "";
	expect(Buffer.byteLength(title)).toBeLessThanOrEqual(200);
	expect(title).toBe("Å".repeat(100));
});

it("refuses before its receipt what can never be saved, and a call without the review's approval", async () => {
	const f = await fixture();
	await refuses(
		f.hiring().hire({ ...HIRE, name: "Ada\tLind" }, f.context),
		"This hire cannot be saved as the company's files: ",
	);
	await refuses(f.hiring().hire({ ...HIRE, role: "\u2028" }, f.context), "This hire cannot be saved");
	const { actionReviewId: _, ...unreviewed } = f.context;
	await refuses(f.hiring().hire(HIRE, unreviewed), "needs the automatic review's approval");
	expect(f.commits).toEqual([]);
	expect(f.recordings).toEqual([]);
	expect(f.operationControl.beginToolOperation).not.toHaveBeenCalled();
});

it("refuses to start when the run cannot complete a folder commit", async () => {
	const f = await fixture();
	const operations = new CloudNativeToolOperations(f.run, {
		...f.operationControl,
		completeFolderToolOperation: undefined,
	});
	await expect(f.hiring(operations).hire(HIRE, f.context)).rejects.toThrow("cannot complete folder writes");
	expect(f.commits).toEqual([]);
});

it("checks the files with the arguments, before the review, naming the parser's problems", async () => {
	const f = await fixture();
	const hiring = f.hiring();
	for (const bad of [
		{ ...HIRE, name: "Ada\tLind" },
		{ ...HIRE, jobDescription: "Keep\u0000 the books." },
		// The todo's own check: its body holds at most 4000 bytes.
		{ ...HIRE, firstAssignment: "x".repeat(4001) },
	]) {
		let thrown: unknown = null;
		try {
			hiring.check(bad);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(CloudToolArgumentRefusal);
		expect(String((thrown as Error).message)).toMatch(/^This hire cannot be saved as the company's files: \S/);
	}
	expect(() => hiring.check(HIRE)).not.toThrow();
	expect(f.recordings).toEqual([]);
});

it("tells the model a hire that waits for a member's approval not to hire again", async () => {
	const f = await fixture(
		{},
		{
			hook: (path) =>
				path.endsWith("/agent.md") ? { outcome: "waiting_for_review", reason: "waiting_for_review" } : null,
		},
	);
	const waiting = parse(await f.hiring().hire(HIRE, f.context));
	expect(waiting).toMatchObject({ outcome: "waiting_for_review" });
	expect(waiting.next).toContain("do not hire again");
});

it("reports a folder taken meanwhile as a conflict, and a save the review does not cover as denied", async () => {
	const f = await fixture();
	const hiring = f.hiring();
	// The listing missed the folder another save just made.
	vi.spyOn(f.folder, "listAll").mockResolvedValueOnce({ asOfSeq: 1, entries: [] });
	f.folders.add("QorperaOS/agents/ada-lind");
	const conflict = parse(await hiring.hire(HIRE, f.context));
	expect(conflict).toMatchObject({ outcome: "conflict", reason: "exists" });
	expect(conflict.next).toContain("new operationKey");
	expect(conflict.next).toContain("choose a slightly different name");
	// A recorded review of other units is not this change set's.
	const g = await fixture(
		{},
		{ recorder: () => ({ schema: "qorpera.folder-review/v1", reviewId: randomUUID(), approvedBy: null, units: 1 }) },
	);
	const denied = parse(await g.hiring().hire(HIRE, g.context));
	expect(denied).toMatchObject({ outcome: "denied", reason: "review_required" });
	expect(denied.next).toContain("Nothing was hired");
});

it("is the hire tool's folder-v2 path: its description, a 4000-byte assignment, and the writer behind execute", async () => {
	const f = await fixture();
	const operations = new CloudNativeToolOperations(f.run, f.operationControl);
	const [tool] = cloudHiringTools(f.identity, {
		folderHiring: f.hiring(operations),
		folderGroupChats: new CloudFolderGroupChats({ folder: f.folder, operations, identity: f.identity }),
	});
	expect(tool?.description).toBe(CLOUD_HIRE_TOOL_DESCRIPTION_FOLDER);
	expect(tool?.inputSchema).toMatchObject({ properties: { firstAssignment: { maxLength: 4000 } } });
	const args = { ...HIRE };
	expect(() => tool?.parseArguments({ ...args, firstAssignment: "x".repeat(4001) })).toThrow();
	// Bytes, not characters: 2001 letters of two bytes each are refused with the field's limit, before the review.
	expect(() => tool?.parseArguments({ ...args, firstAssignment: "Å".repeat(2001) })).toThrow(
		new CloudToolArgumentRefusal("firstAssignment holds at most 4000 bytes in this company: shorten it"),
	);
	expect(() => tool?.parseArguments({ ...args, name: "Ada\tLind" })).toThrow(CloudToolArgumentRefusal);
	expect(() =>
		tool?.parseArguments({ ...args, operationKey: "hire-4000", firstAssignment: "Å".repeat(2000) }),
	).not.toThrow();
	const parsed = tool?.parseArguments(args);
	const result = parse((await tool?.execute(parsed ?? {}, f.context)) as { value: unknown });
	expect(result).toMatchObject({ outcome: "saved", agent: { folder: "QorperaOS/agents/ada-lind" } });
	// The key is bound to that request: other arguments under it are refused, pointing at QorperaOS/agents/.
	expect(() => tool?.parseArguments({ ...args, name: "Someone Else" })).toThrow(
		/check QorperaOS\/agents\/ before hiring again/,
	);
});

// Ending a role (the company's reading of itself, 20260930766000): agent.md set to archived through a reviewed commit.
const agentMd = (
	id: string,
	name: string,
	kind: "co-founder" | "agent" = "agent",
	status: "active" | "archived" = "active",
) =>
	writeAgentFile({
		id,
		name,
		role: name,
		agentKind: kind,
		status,
		colour: null,
		figure: null,
		model: null,
		effort: null,
		instructions: `Own ${name}.`,
	});
async function roles() {
	const research = randomUUID();
	const f = await fixture({
		files: {
			"QorperaOS/agents/research/agent.md": agentMd(research, "Research"),
			"QorperaOS/agents/market/agent.md": agentMd(randomUUID(), "Market", "agent", "archived"),
			"QorperaOS/agents/co-founder/agent.md": agentMd(randomUUID(), "Co-Founder", "co-founder"),
		},
	});
	f.seed("QorperaOS/agents/nora/agent.md", agentMd(f.identity.staffAgentId, "Nora"));
	return { ...f, research };
}
const END = { operationKey: "end-1", agent: "research", reason: "The customer interviews are done." };

it("ends a role by setting agent.md to archived, recording the call's review for exactly that change", async () => {
	const f = await roles();
	const prepared = await f.hiring().prepareEndRole(END, f.context.signal);
	expect(prepared).toEqual({ ...END, name: "Research" });
	const result = parse(await f.hiring().endRole(END, f.context));
	expect(result).toMatchObject({
		schema: "qorpera.agent-role-end-receipt/v1",
		runId: f.identity.runId,
		outcome: "saved",
		agent: { id: f.research, name: "Research", folder: "QorperaOS/agents/research" },
	});
	expect(result.next).toBe(
		"Research's role has ended. The platform now pauses its routines and closes its threads by itself; its files stay, and a member can bring it back. Tell the founders who and why.",
	);
	expect(f.commits).toHaveLength(1);
	const [commit] = f.commits;
	expect(commit).toMatchObject({ key: "end-role:end-1", receiptId: result.receiptId });
	expect(commit?.units.map((unit) => [unit.op, unit.path, typeof unit.expectedVersion])).toEqual([
		["write", "QorperaOS/agents/research/agent.md", "string"],
	]);
	expect(f.recordings[0]?.p_request).toEqual({
		actionReviewId: f.context.actionReviewId,
		tool: "end_role",
		argumentSha256: f.context.argumentSha256,
		units: commit?.units,
	});
	const agent = parseCompanyStateFile(
		"QorperaOS/agents/research/agent.md",
		f.text("QorperaOS/agents/research/agent.md") ?? "",
	);
	// Only the status changed: nothing else is deleted.
	expect(agent?.ok && agent.file).toMatchObject({
		kind: "agent",
		id: f.research,
		name: "Research",
		status: "archived",
		instructions: "Own Research.",
	});
	expect([...f.folders]).toContain("QorperaOS/agents/research");
	// Once ended, a new call to end it is refused before any review.
	await refuses(f.hiring().prepareEndRole(END, f.context.signal), "Research's role has already ended");
});

it("refuses before the review the Co-Founder, the calling agent, an ended role and a folder that is no agent's", async () => {
	const f = await roles();
	for (const [agent, reason] of [
		["co-founder", "The Co-Founder's role does not end"],
		["nora", "An agent does not end its own role"],
		["market", "Market's role has already ended"],
		["sales", "No agent has the folder QorperaOS/agents/sales"],
		["groups", "No agent has the folder QorperaOS/agents/groups"],
		["Not A Handle", "No agent has the folder"],
	] as const)
		await refuses(f.hiring().prepareEndRole({ ...END, agent }, f.context.signal), reason);
	// The same refusals stand at the effect, but for an ended role: a replay must reach its receipt.
	await refuses(f.hiring().endRole({ ...END, agent: "nora" }, f.context), "An agent does not end its own role");
	const { actionReviewId: _, ...unreviewed } = f.context;
	await refuses(f.hiring().endRole(END, unreviewed), "needs the automatic review's approval");
	expect(f.commits).toEqual([]);
	expect(f.recordings).toEqual([]);
});

it("tells the model an end that waits for a member not to call again, and is the end_role tool", async () => {
	const waiting = await fixture(
		{ files: { "QorperaOS/agents/research/agent.md": agentMd(randomUUID(), "Research") } },
		{
			hook: (path) =>
				path.endsWith("research/agent.md") ? { outcome: "waiting_for_review", reason: "waiting_for_review" } : null,
		},
	);
	const result = parse(await waiting.hiring().endRole(END, waiting.context));
	expect(result).toMatchObject({ outcome: "waiting_for_review" });
	expect(result.next).toContain("do not call again");
	const f = await roles();
	const operations = new CloudNativeToolOperations(f.run, f.operationControl);
	const tools = cloudHiringTools(f.identity, {
		folderHiring: f.hiring(operations),
		folderGroupChats: new CloudFolderGroupChats({ folder: f.folder, operations, identity: f.identity }),
	});
	expect(tools.map((tool) => tool.name)).toEqual(["hire_agent", "create_group_chat", "end_role"]);
	const tool = tools[2]!;
	expect(tool.description).toBe(CLOUD_END_ROLE_TOOL_DESCRIPTION);
	expect(tool.description).toContain("agent is its folder name under QorperaOS/agents/; reason is one sentence");
	expect(() => tool.parseArguments({ ...END, reason: "Two\nlines" })).toThrow(CloudToolArgumentRefusal);
	expect(() => tool.parseArguments({ ...END, reason: "x".repeat(281) })).toThrow(CloudToolArgumentRefusal);
	expect(() => tool.parseArguments({ ...END, extra: 1 })).toThrow();
	const parsed = tool.parseArguments(END);
	// The card names the agent: prepare reads it before the review.
	const prepared = await tool.prepare!(parsed, f.context);
	expect(prepared).toEqual({ ...END, name: "Research" });
	expect(parse((await tool.execute(prepared, f.context)) as { value: unknown })).toMatchObject({ outcome: "saved" });
	expect(() => tool.parseArguments({ ...END, reason: "Another reason." })).toThrow(
		/already used in this run for ending another role/,
	);
	// hire_agent says when an existing coworker takes new work.
	expect(CLOUD_HIRE_TOOL_DESCRIPTION_FOLDER).toContain(
		"Give it to an existing coworker only when it is the same kind of work and that coworker has room; otherwise hire.",
	);
	expect(CLOUD_HIRE_TOOL_DESCRIPTION_FOLDER).not.toContain("beats a new hire");
});
