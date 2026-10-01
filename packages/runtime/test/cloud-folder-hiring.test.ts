import { randomUUID } from "node:crypto";
import { parseCompanyStateFile } from "@qorpera/cloud-client/company-state-files";
import { type CloudFolderHire, CloudFolderHiring } from "@qorpera/runtime/cloud-folder-hiring";
import {
	CLOUD_HIRE_TOOL_DESCRIPTION,
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
		agent: { name: "Ada Lind", role: "Bookkeeper", folder: "agents/ada-lind" },
	});
	expect(result.next).toContain("has not started yet");
	expect(result.next).toContain(`send_coworker_message (recipientStaffId ${result.agent.id})`);
	// One unit; the review is this call's approval, recorded for exactly the units the commit carries.
	expect(f.commits).toHaveLength(1);
	const [commit] = f.commits;
	expect(commit).toMatchObject({ key: "hire-folder:hire-1", receiptId: result.receiptId });
	expect(commit?.units.map((unit) => [unit.op, unit.path])).toEqual([["new_folder", "agents/ada-lind"]]);
	expect(f.recordings).toHaveLength(1);
	expect(f.recordings[0]?.p_request).toEqual({
		actionReviewId: f.context.actionReviewId,
		tool: "hire_agent",
		argumentSha256: f.context.argumentSha256,
		units: commit?.units,
	});
	expect(f.reviews.get(commit?.reviewId as string)).toBe(JSON.stringify(commit?.units));
	expect([...f.folders].filter((path) => path.startsWith("agents/ada-lind")).sort()).toEqual([
		"agents/ada-lind",
		"agents/ada-lind/memory",
		"agents/ada-lind/routines",
		"agents/ada-lind/skills",
		"agents/ada-lind/todos",
	]);
	// The files are the shared writers' and parse as the database will check them.
	const agent = parseCompanyStateFile("agents/ada-lind/agent.md", f.text("agents/ada-lind/agent.md") ?? "");
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
		"agents/ada-lind/todos/first-assignment.md",
		f.text("agents/ada-lind/todos/first-assignment.md") ?? "",
	);
	expect(todo?.ok && todo.file).toMatchObject({
		kind: "todo",
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
	const f = await fixture({ folders: ["agents/ada-lind"] });
	expect(parse(await f.hiring().hire(HIRE, f.context)).agent.folder).toBe("agents/ada-lind-2");
	// Each tool call has its own call id and its own approval.
	const call = () => ({ ...f.context, callId: randomUUID(), actionReviewId: randomUUID() });
	expect(parse(await f.hiring().hire({ ...HIRE, operationKey: "hire-2", name: "Groups" }, call())).agent.folder).toBe(
		"agents/groups-2",
	);
	expect(parse(await f.hiring().hire({ ...HIRE, operationKey: "hire-3", name: "Ærø Ø" }, call())).agent.folder).toBe(
		"agents/aeroe-oe",
	);
});

it("titles the first todo with the assignment's first line, as one line of at most 200 bytes", async () => {
	const f = await fixture();
	const long = `${"Å".repeat(150)}\u0007more`;
	await f.hiring().hire({ ...HIRE, firstAssignment: `\n  ${long}\nThe rest.` }, f.context);
	const todo = parseCompanyStateFile(
		"agents/ada-lind/todos/first-assignment.md",
		f.text("agents/ada-lind/todos/first-assignment.md") ?? "",
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
	f.folders.add("agents/ada-lind");
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
	const gateway = { mutate: vi.fn(), applyOwnOrganizationDocument: vi.fn() };
	const [legacy] = cloudHiringTools(gateway, f.identity);
	const [tool] = cloudHiringTools(gateway, f.identity, undefined, { folderHiring: f.hiring() });
	expect(legacy?.description).toBe(CLOUD_HIRE_TOOL_DESCRIPTION);
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
		legacy?.parseArguments({ ...args, operationKey: "hire-9", firstAssignment: "x".repeat(4001) }),
	).not.toThrow();
	const parsed = tool?.parseArguments(args);
	const result = parse((await tool?.execute(parsed ?? {}, f.context)) as { value: unknown });
	expect(result).toMatchObject({ outcome: "saved", agent: { folder: "agents/ada-lind" } });
	expect(gateway.mutate).not.toHaveBeenCalled();
	// The key is bound to that request: other arguments under it are refused, pointing at agents/.
	expect(() => tool?.parseArguments({ ...args, name: "Someone Else" })).toThrow(/check agents\/ before hiring again/);
});
