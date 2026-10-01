import { randomUUID } from "node:crypto";
import { CloudCompanyFolderClient } from "@qorpera/runtime/cloud-company-folder-client";
import { CloudFolderTodos } from "@qorpera/runtime/cloud-folder-todos";
import type { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { CloudToolRefusal } from "@qorpera/runtime/cloud-native-tool-boundary";
import { CloudNativeToolOperations } from "@qorpera/runtime/cloud-native-tool-operations";
import { afterEach, expect, it, vi } from "vitest";
import { folderWriterFixture, sha } from "./fixtures/folder-writer-fixture.ts";

const runs: CloudNativeToolRun[] = [];
afterEach(() => {
	for (const run of runs.splice(0)) run.close();
});

async function fixture() {
	const f = await folderWriterFixture();
	runs.push(f.run);
	const todos = (operations = new CloudNativeToolOperations(f.run, f.operationControl)) =>
		new CloudFolderTodos({ folder: f.folder, operations, identity: f.identity, handle: "nora" });
	return { ...f, todos };
}

const PATH = "agents/nora/todos/call-the-bank.md";
const parse = (content: { value: unknown }) => JSON.parse(String(content.value));

it("writes a new todo as its file, under the call's receipt, making the todos folder first", async () => {
	const f = await fixture();
	const result = parse(
		await f.todos().change(
			{
				action: "upsert",
				operationKey: "todo-1",
				todoKey: "call-the-bank",
				title: "Call the bank",
				detail: "Ask about the loan.",
				state: "open",
			},
			f.context,
		),
	);
	expect(result).toMatchObject({
		schema: "qorpera.agent-todo-receipt/v1",
		runId: f.identity.runId,
		action: "upsert",
		outcome: "saved",
		todo: { todoKey: "call-the-bank", title: "Call the bank", state: "open", path: PATH },
	});
	expect(f.commits).toHaveLength(1);
	expect(f.commits[0]).toMatchObject({ key: "todo-file:todo-1", receiptId: result.receiptId });
	expect(f.commits[0]?.units.map((unit) => unit.op)).toEqual(["mkdir", "write"]);
	const written = f.text(PATH);
	expect(written).toMatch(/^---\nid: [0-9a-f-]{36}\ntitle: Call the bank\nstatus: open\n/);
	expect(written).toContain(`requested_by: ${f.identity.requesterUserId}`);
	expect(written).toContain("Ask about the loan.");
	// The receipt is completed with the commit that carried it.
	expect(f.operationControl.completeFolderToolOperation).toHaveBeenCalledTimes(1);
	expect(f.operationControl.completeToolOperation).not.toHaveBeenCalled();
});

it("updates a todo keeping its id and requester, closes it, and replays a finished call from its receipt", async () => {
	const f = await fixture();
	const todos = f.todos();
	await todos.change(
		{ action: "upsert", operationKey: "todo-1", todoKey: "call-the-bank", title: "Call the bank", state: "open" },
		f.context,
	);
	const first = f.text(PATH) ?? "";
	const id = /^id: (.+)$/m.exec(first)?.[1];
	await todos.change(
		{
			action: "upsert",
			operationKey: "todo-2",
			todoKey: "call-the-bank",
			title: "Call the bank today",
			detail: "Waiting for a call back.",
			state: "blocked",
		},
		f.context,
	);
	const second = f.text(PATH) ?? "";
	expect(second).toContain(`id: ${id}`);
	expect(second).toContain("status: blocked");
	expect(f.commits[1]?.units).toHaveLength(1);
	expect(f.commits[1]?.units[0]?.expectedVersion).toBeDefined();
	const done = parse(
		await todos.change({ action: "done", operationKey: "todo-3", todoKey: "call-the-bank" }, f.context),
	);
	expect(done).toMatchObject({ outcome: "saved", todo: { title: "Call the bank today", state: "done" } });
	// Only the status changed, and the read the result shows was released with it.
	expect(f.text(PATH)).toBe(second.replace("status: blocked", "status: done"));
	expect(f.releases).toHaveLength(1);
	expect(f.releases[0]).toMatchObject({ p_release_id: done.receiptId });
	// The same call again, in a new process: its checks pass on the saved file, and the receipt answers.
	const replay = parse(
		await f.todos().change({ action: "done", operationKey: "todo-3", todoKey: "call-the-bank" }, f.context),
	);
	expect(replay).toEqual(done);
	expect(f.commits).toHaveLength(3);
});

it("keeps a todo's requester, changes only its status, and releases the read its result shows", async () => {
	const f = await fixture();
	const requester = randomUUID();
	// Written by someone else: keys in another order, and a comment the settings writer keeps.
	const original = `---\ntitle: Call the bank\n# asked on the phone\nid: ${randomUUID()}\nstatus: open\nrequested_by: ${requester}\n---\nAsk about the loan.\n`;
	f.seed(PATH, original);
	const read = f.files.get(PATH)?.version;
	const content = await f
		.todos()
		.change({ action: "done", operationKey: "todo-1", todoKey: "call-the-bank" }, f.context);
	const done = parse(content);
	expect(f.text(PATH)).toBe(original.replace("status: open", "status: done"));
	expect(f.releases).toHaveLength(1);
	expect(f.releases).toMatchObject([
		{
			p_release_id: done.receiptId,
			p_reads: [expect.objectContaining({ path: PATH, version: read })],
			p_output_sha256: sha(String(content.value)),
		},
	]);
	// An upsert keeps whoever asked, not the run's requester.
	f.seed("agents/nora/todos/send-the-offer.md", original.replace("Call the bank", "Send the offer"));
	await f
		.todos()
		.change(
			{ action: "upsert", operationKey: "todo-2", todoKey: "send-the-offer", title: "Send it", state: "blocked" },
			f.context,
		);
	expect(f.text("agents/nora/todos/send-the-offer.md")).toContain(`requested_by: ${requester}`);
	expect(f.text("agents/nora/todos/send-the-offer.md")).not.toContain(String(f.identity.requesterUserId));
});

it("binds a call's whole request to its receipt: the same operationKey with other content is refused", async () => {
	const f = await fixture();
	const todos = f.todos();
	const upsert = { action: "upsert", operationKey: "todo-1", todoKey: "call-the-bank", title: "Call" } as const;
	await todos.change({ ...upsert, detail: "Ask about the loan." }, f.context);
	await expect(todos.change({ ...upsert, detail: "Ask about the rate." }, f.context)).rejects.toThrow();
	await expect(
		todos.change({ ...upsert, detail: "Ask about the loan.", state: "blocked" }, f.context),
	).rejects.toThrow();
	await expect(
		todos.change({ ...upsert, title: "Call them", detail: "Ask about the loan." }, f.context),
	).rejects.toThrow();
	expect(f.commits).toHaveLength(1);
	expect(f.text(PATH)).toContain("Ask about the loan.");
});

it("refuses a todo file that does not read as a todo, to change it or to show it", async () => {
	const f = await fixture();
	f.seed(PATH, "---\ntitle: no id\n---\n");
	await expect(
		f.todos().change({ action: "done", operationKey: "todo-1", todoKey: "call-the-bank" }, f.context),
	).rejects.toThrow("does not read as a todo");
	await expect(f.todos().list({ todoKey: "call-the-bank" }, f.context, () => true)).rejects.toThrow(
		"does not read as a todo",
	);
	expect(f.ledger.size).toBe(0);
	expect(f.releases).toHaveLength(0);
});

it("refuses what can never be saved, before any receipt", async () => {
	const f = await fixture();
	const todos = f.todos();
	for (const todoKey of ["call.the.bank", "Call-the-bank", "call_the_bank", "a".repeat(65)])
		await expect(
			todos.change({ action: "upsert", operationKey: "k", todoKey, title: "x", state: "open" }, f.context),
		).rejects.toThrow("a todoKey is the todo's file name");
	// Each is the tool's own refusal before any effect, which the boundary shows the model (REFUSED: ...).
	await expect(
		todos.change({ action: "done", operationKey: "k", todoKey: "nothing-here" }, f.context),
	).rejects.toBeInstanceOf(CloudToolRefusal);
	await expect(
		todos.change({ action: "done", operationKey: "k", todoKey: "nothing-here" }, f.context),
	).rejects.toThrow("You have no todo with that todoKey");
	await todos.change({ action: "upsert", operationKey: "todo-1", todoKey: "call-the-bank", title: "x" }, f.context);
	await todos.change({ action: "cancel", operationKey: "todo-2", todoKey: "call-the-bank" }, f.context);
	await expect(
		todos.change({ action: "upsert", operationKey: "todo-3", todoKey: "call-the-bank", title: "again" }, f.context),
	).rejects.toThrow("a closed todo is not opened again");
	await expect(
		todos.change({ action: "done", operationKey: "todo-4", todoKey: "call-the-bank" }, f.context),
	).rejects.toThrow("already closed the other way");
	expect(f.ledger.size).toBe(2);
});

it("answers a conflict when the file changed after it was read, and the receipt still completes", async () => {
	const f = await fixture();
	const todos = f.todos();
	await todos.change({ action: "upsert", operationKey: "todo-1", todoKey: "call-the-bank", title: "x" }, f.context);
	// Another writer saves the file between this call's read and its commit.
	const stored = f.files.get(PATH);
	if (!stored) throw new Error("Missing fixture file");
	const original = CloudCompanyFolderClient.prototype.commit;
	const commit = vi.spyOn(CloudCompanyFolderClient.prototype, "commit").mockImplementationOnce(async function (
		this: CloudCompanyFolderClient,
		...args
	) {
		stored.version = randomUUID();
		return original.apply(this, args);
	});
	const result = parse(
		await todos.change({ action: "done", operationKey: "todo-2", todoKey: "call-the-bank" }, f.context),
	);
	commit.mockRestore();
	expect(result).toMatchObject({ outcome: "conflict", reason: "version_changed", todo: { state: "open" } });
	expect(result.next).toContain("new operationKey");
	// The result shows the state and version read: that read is released with it, for an upsert too.
	expect(f.releases.at(-1)).toMatchObject({ p_release_id: result.receiptId });
	const again = vi.spyOn(CloudCompanyFolderClient.prototype, "commit").mockImplementationOnce(async function (
		this: CloudCompanyFolderClient,
		...args
	) {
		stored.version = randomUUID();
		return original.apply(this, args);
	});
	const read = stored.version;
	const upsert = parse(
		await todos.change(
			{ action: "upsert", operationKey: "todo-3", todoKey: "call-the-bank", title: "y", state: "blocked" },
			f.context,
		),
	);
	again.mockRestore();
	expect(upsert).toMatchObject({ outcome: "conflict", todo: { state: "open", version: read } });
	expect(f.releases).toHaveLength(2);
	expect(f.releases.at(-1)).toMatchObject({ p_release_id: upsert.receiptId, p_reads: [{ version: read }] });
	expect(f.operationControl.completeFolderToolOperation).toHaveBeenCalledTimes(3);
});

it("refuses before reading or writing when this run cannot complete a folder write", async () => {
	const f = await fixture();
	const { completeFolderToolOperation: _, ...legacy } = f.operationControl;
	await expect(
		f
			.todos(new CloudNativeToolOperations(f.run, legacy))
			.change({ action: "upsert", operationKey: "todo-1", todoKey: "call-the-bank", title: "x" }, f.context),
	).rejects.toThrow("cannot complete folder writes");
	expect(f.commits).toHaveLength(0);
	expect(f.ledger.size).toBe(0);
});

it("lists the todos from the index, newest first, and reads one todo's whole content from its file", async () => {
	const f = await fixture();
	const todos = f.todos();
	for (const [key, title] of [
		["call-the-bank", "Call the bank"],
		["send-the-offer", "Send the offer"],
		["book-the-room", "Book the room"],
	] as const)
		await todos.change(
			{ action: "upsert", operationKey: `upsert-${key}`, todoKey: key, title, detail: "x".repeat(400) },
			f.context,
		);
	await todos.change({ action: "done", operationKey: "done-1", todoKey: "send-the-offer" }, f.context);
	const releases = f.releases.length;
	const fits = () => true;
	const listed = parse(await todos.list({}, f.context, fits));
	expect(listed).toMatchObject({
		schema: "qorpera.agent-todos/v1",
		runId: f.identity.runId,
		moreTodos: 0,
		nextCursor: null,
		todos: [
			{ todoKey: "book-the-room", title: "Book the room", state: "open", detailTruncated: true },
			{ todoKey: "call-the-bank", title: "Call the bank", state: "open" },
		],
	});
	expect(listed.todos[0].detail).toHaveLength(200);
	expect(listed.todos[0]).not.toHaveProperty("cursor");
	// An index page is no folder read: nothing to release.
	expect(f.releases).toHaveLength(releases);
	expect(parse(await todos.list({ state: "done" }, f.context, fits)).todos).toMatchObject([
		{ todoKey: "send-the-offer" },
	]);
	expect(parse(await todos.list({ includeClosed: true, search: "BANK" }, f.context, fits)).todos).toMatchObject([
		{ todoKey: "call-the-bank" },
	]);
	expect(
		parse(await todos.list({ includeClosed: true }, f.context, fits)).todos.map(
			(todo: { todoKey: string }) => todo.todoKey,
		),
	).toEqual(["book-the-room", "send-the-offer", "call-the-bank"]);
	// A key the title does not have.
	expect(parse(await todos.list({ search: "the-room" }, f.context, fits)).todos).toMatchObject([
		{ todoKey: "book-the-room" },
	]);
	// One todo's whole content comes from its file, released with the result.
	const one = parse(await todos.list({ todoKey: "call-the-bank" }, { ...f.context, callId: "one" }, fits));
	expect(one.todos).toMatchObject([{ todoKey: "call-the-bank", detail: "x".repeat(400), state: "open" }]);
	expect(f.releases).toHaveLength(releases + 1);
	expect((f.releases.at(-1) as { p_reads: { path: string }[] }).p_reads).toMatchObject([
		{ path: "agents/nora/todos/call-the-bank.md" },
	]);
	expect(parse(await todos.list({ todoKey: "nothing-here" }, f.context, fits))).toMatchObject({ todos: [] });
	// The same call showing the same read releases it under the same id; showing something else, under its own.
	const releaseId = (f.releases.at(-1) as { p_release_id: string }).p_release_id;
	await todos.list({ todoKey: "call-the-bank" }, { ...f.context, callId: "one" }, fits);
	expect((f.releases.at(-1) as { p_release_id: string }).p_release_id).toBe(releaseId);
	await todos.change(
		{ action: "upsert", operationKey: "upsert-again", todoKey: "call-the-bank", title: "Call the bank", detail: "y" },
		f.context,
	);
	await todos.list({ todoKey: "call-the-bank" }, { ...f.context, callId: "one" }, fits);
	expect((f.releases.at(-1) as { p_release_id: string }).p_release_id).not.toBe(releaseId);
	// A page that fits one todo continues from the index's cursor.
	const first = parse(await todos.list({}, f.context, (text) => text.split('"todoKey"').length <= 2));
	expect(first).toMatchObject({ todos: [{ todoKey: "book-the-room" }], moreTodos: 1 });
	const second = parse(await todos.list({ cursor: first.nextCursor }, f.context, fits));
	expect(second).toMatchObject({ todos: [{ todoKey: "call-the-bank" }], moreTodos: 0, nextCursor: null });
});

it("lists nothing for an agent without todos, and releases nothing", async () => {
	const f = await fixture();
	expect(parse(await f.todos().list({}, f.context, () => true))).toMatchObject({
		todos: [],
		moreTodos: 0,
		nextCursor: null,
	});
	expect(f.releases).toHaveLength(0);
});
