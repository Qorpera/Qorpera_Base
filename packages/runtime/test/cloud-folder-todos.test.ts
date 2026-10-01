import { randomUUID } from "node:crypto";
import { CloudCompanyFolderClient } from "@qorpera/runtime/cloud-company-folder-client";
import { CloudFolderTodos } from "@qorpera/runtime/cloud-folder-todos";
import type { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { CloudNativeToolOperations } from "@qorpera/runtime/cloud-native-tool-operations";
import { afterEach, expect, it, vi } from "vitest";
import { folderWriterFixture } from "./fixtures/folder-writer-fixture.ts";

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

it("refuses what can never be saved, before any receipt", async () => {
	const f = await fixture();
	const todos = f.todos();
	for (const todoKey of ["call.the.bank", "Call-the-bank", "call_the_bank", "a".repeat(65)])
		await expect(
			todos.change({ action: "upsert", operationKey: "k", todoKey, title: "x", state: "open" }, f.context),
		).rejects.toThrow("a todoKey is the todo's file name");
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
	expect(f.operationControl.completeFolderToolOperation).toHaveBeenCalledTimes(2);
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

it("lists the todos from their files, newest first, open by default, and releases what it shows", async () => {
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
	const listed = parse(await todos.list({}, { ...f.context, callId: "list-1" }, fits));
	expect(listed).toMatchObject({
		schema: "qorpera.agent-todos/v1",
		runId: f.identity.runId,
		moreTodos: 0,
		nextCursor: null,
		todos: [
			{ todoKey: "book-the-room", title: "Book the room", state: "open" },
			{ todoKey: "call-the-bank", title: "Call the bank", state: "open" },
		],
	});
	expect(listed.todos[0].detail).toHaveLength(281);
	expect(f.releases).toHaveLength(releases + 1);
	expect((f.releases.at(-1) as { p_reads: unknown[] }).p_reads).toHaveLength(2);
	// Closed ones on request, a search, one todo's whole detail.
	expect(parse(await todos.list({ state: "done" }, f.context, fits)).todos).toMatchObject([
		{ todoKey: "send-the-offer" },
	]);
	expect(parse(await todos.list({ includeClosed: true, search: "BANK" }, f.context, fits)).todos).toMatchObject([
		{ todoKey: "call-the-bank" },
	]);
	expect(parse(await todos.list({ todoKey: "call-the-bank" }, f.context, fits)).todos[0].detail).toBe("x".repeat(400));
	// A page that fits one todo continues from its version.
	const first = parse(await todos.list({}, f.context, (text) => text.split('"todoKey"').length <= 2));
	// The closed todo changed last and sorts first, so one file is left after this page.
	expect(first).toMatchObject({ todos: [{ todoKey: "book-the-room" }], moreTodos: 1 });
	expect(first.nextCursor).toBe(first.todos[0].version);
	const second = parse(await todos.list({ cursor: first.nextCursor }, f.context, fits));
	expect(second.todos).toMatchObject([{ todoKey: "call-the-bank" }]);
	await expect(todos.list({ cursor: randomUUID() }, f.context, fits)).rejects.toThrow("list again without it");
});

it("lists nothing for an agent without a todos folder", async () => {
	const f = await fixture();
	expect(parse(await f.todos().list({}, f.context, () => true))).toMatchObject({
		todos: [],
		moreTodos: 0,
		nextCursor: null,
	});
	expect(f.releases).toHaveLength(0);
});
