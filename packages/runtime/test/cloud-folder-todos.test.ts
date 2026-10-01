import { createHash, randomUUID } from "node:crypto";
import { parseCompanyStateFile } from "@qorpera/cloud-client/company-state-files";
import type { CloudFileReference } from "@qorpera/cloud-client/node/cloud-object-store";
import type { JsonValue } from "@qorpera/contracts";
import {
	type CloudCompanyFolderBytes,
	CloudCompanyFolderClient,
	type CloudCompanyFolderFile,
} from "@qorpera/runtime/cloud-company-folder-client";
import type { CloudCompanyPathControl } from "@qorpera/runtime/cloud-company-path-gateway";
import { CloudFolderTodos } from "@qorpera/runtime/cloud-folder-todos";
import { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { type CloudToolContext, CloudToolRefusal } from "@qorpera/runtime/cloud-native-tool-boundary";
import {
	type CloudNativeToolOperationControlPlane,
	CloudNativeToolOperations,
} from "@qorpera/runtime/cloud-native-tool-operations";
import type { BeginCloudRunnerOperationInput } from "@qorpera/runtime/cloud-runner-broker";
import { afterEach, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

/** The folder core and the receipt ledger are simulated at the wire, with the shapes the client and the operations
 * parse (tests 760 and 650 pin them against the real SQL). The todo tool, the folder client and the operations are the
 * real ones. */
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const runs: CloudNativeToolRun[] = [];
afterEach(() => {
	for (const run of runs.splice(0)) run.close();
});

interface Stored {
	version: string;
	file: CloudCompanyFolderFile;
	updatedAt: string;
}

async function fixture() {
	const { binding, authority } = nativeToolAuthorityFixture();
	const identity = authority.identity;
	const receipt = { resourceId: randomUUID(), resourceRevision: 1, grantId: randomUUID(), grantRevision: 1 };
	const bytesBySha = new Map<string, Uint8Array>();
	const files = new Map<string, Stored>();
	const rowIds = new Map<string, string>();
	const folders = new Set<string>(["agents", "agents/nora"]);
	const commits: { key: string; receiptId: unknown; units: Record<string, unknown>[] }[] = [];
	const releases: Record<string, unknown>[] = [];
	let seq = 1;
	let tick = 0;
	const now = () =>
		`2026-10-01T00:${String(Math.floor(tick / 60)).padStart(2, "0")}:${String(tick++ % 60).padStart(2, "0")}+00:00`;
	const entry = (path: string) => {
		const file = files.get(path);
		if (file)
			return {
				path,
				kind: "file",
				version: file.version,
				seq,
				updatedAt: file.updatedAt,
				...file.file,
				authority: receipt,
			};
		if (folders.has(path))
			return {
				path,
				kind: "folder",
				version: randomUUID(),
				seq,
				updatedAt: "2026-10-01T00:00:00+00:00",
				authority: receipt,
			};
		return null;
	};
	const bytes: CloudCompanyFolderBytes = {
		put: vi.fn(async (data: Uint8Array, mediaType: string): Promise<CloudFileReference> => {
			bytesBySha.set(sha(data), Uint8Array.from(data));
			return {
				manifestSha256: sha(`manifest:${sha(data)}`),
				fileSha256: sha(data),
				bytes: data.byteLength,
				mediaType,
			};
		}),
		get: vi.fn(async (file: CloudCompanyFolderFile) => bytesBySha.get(file.fileSha256) ?? new Uint8Array()),
	};
	const control: CloudCompanyPathControl = {
		call: vi.fn(async (method, args) => {
			if (method === "qorpera_folder_read") {
				const found = entry(args.p_path as string);
				return { schema: "qorpera.folder-read/v1", asOfSeq: seq, found: found !== null, entry: found };
			}
			if (method === "qorpera_folder_commit") {
				const units = args.p_units as Record<string, unknown>[];
				commits.push({ key: args.p_operation_key as string, receiptId: args.p_receipt_id, units });
				const results = units.map((unit, index) => {
					const path = unit.path as string;
					const parent = path.split("/").slice(0, -1).join("/");
					const base = { unit: index + 1, op: unit.op, path };
					if (unit.op === "mkdir") {
						folders.add(path);
						return { ...base, outcome: "saved", version: randomUUID() };
					}
					if (!folders.has(parent)) return { ...base, outcome: "refused", reason: "parent_missing" };
					const current = files.get(path);
					if (unit.expectedVersion === undefined ? current : current?.version !== unit.expectedVersion)
						return { ...base, outcome: "conflict", reason: current ? "version_changed" : "missing" };
					const version = randomUUID();
					files.set(path, { version, file: unit.file as CloudCompanyFolderFile, updatedAt: now() });
					return { ...base, outcome: "saved", version };
				});
				// The folder's clock moves only when a unit is saved.
				const any = results.some((result) => result.outcome === "saved");
				if (any) seq += 1;
				return {
					schema: "qorpera.folder-commit/v1",
					commitId: randomUUID(),
					seq: any ? seq : null,
					replay: false,
					units: results,
				};
			}
			// The todo index as the commit keeps it: one row per todo file, in the order the files were made.
			if (method === "qorpera_folder_agent_todos") {
				const request = args.p_request as {
					includeClosed?: boolean;
					state?: string;
					search?: string;
					cursor?: string;
				};
				const rows = [...files.entries()]
					.filter(([path]) => /^agents\/nora\/todos\/[^/]+\.md$/.test(path))
					.map(([path, stored]) => {
						const parsed = parseCompanyStateFile(
							path,
							new TextDecoder().decode(bytesBySha.get(stored.file.fileSha256)),
						);
						const todo = parsed?.ok && parsed.file.kind === "todo" ? parsed.file : null;
						if (!todo) throw new Error("Fixture todo does not parse");
						if (!rowIds.has(path)) rowIds.set(path, randomUUID());
						return { path, stored, todo, id: rowIds.get(path) as string };
					})
					.reverse()
					.filter(({ path, todo }) => {
						const key = path.slice("agents/nora/todos/".length, -3);
						return (
							(request.state
								? todo.status === request.state
								: request.includeClosed || todo.status === "open" || todo.status === "blocked") &&
							(!request.search ||
								todo.title.toLowerCase().includes(request.search.toLowerCase()) ||
								key.includes(request.search.toLowerCase()))
						);
					});
				const start = request.cursor ? rows.findIndex((row) => row.id === request.cursor) + 1 : 0;
				const page = rows.slice(start, start + 32);
				const more = rows.length - start - page.length;
				return {
					schema: "qorpera.folder-agent-todos/v1",
					todos: page.map(({ path, stored, todo, id }) => ({
						todoKey: path.slice("agents/nora/todos/".length, -3),
						title: todo.title,
						state: todo.status,
						detail: todo.detail.slice(0, 200),
						...(todo.detail.length > 200 ? { detailTruncated: true } : {}),
						path,
						version: stored.version,
						updatedAt: stored.updatedAt,
						cursor: id,
					})),
					moreTodos: more,
					nextCursor: more > 0 ? (page.at(-1)?.id ?? null) : null,
				};
			}
			if (method === "qorpera_folder_list") {
				const parent = args.p_parent as string;
				const after = args.p_after as string | null;
				const children = [...files.keys(), ...folders]
					.filter((path) => path.startsWith(`${parent}/`) && !path.slice(parent.length + 1).includes("/"))
					.sort()
					.filter((path) => after === null || path > after);
				const page = children.slice(0, args.p_limit as number);
				return {
					schema: "qorpera.folder-list/v1",
					asOfSeq: seq,
					entries: page.map(entry),
					next: page.length === (args.p_limit as number) ? (page.at(-1) ?? null) : null,
				};
			}
			if (method === "qorpera_folder_record_release") {
				releases.push(structuredClone(args));
				return {
					schema: "qorpera.folder-release/v1",
					releaseId: args.p_release_id,
					reads: (args.p_reads as unknown[]).length,
					replay: false,
				};
			}
			throw new Error(`Unexpected ${method}`);
		}),
	};
	const folder = new CloudCompanyFolderClient({ binding, identity, control, bytes });
	// The receipt ledger: folder receipts that a commit satisfies, completed with that commit.
	const ledger = new Map<
		string,
		{ input: BeginCloudRunnerOperationInput; result: JsonValue | null; commit: string | null }
	>();
	const operationControl = {
		beginToolOperation: vi.fn<CloudNativeToolOperationControlPlane["beginToolOperation"]>(async (b, input) => {
			let row = ledger.get(input.logicalOperationKey);
			if (row && row.input.inputSha256 !== input.inputSha256) throw new Error("other work");
			if (!row) {
				row = { input: structuredClone(input), result: null, commit: null };
				ledger.set(input.logicalOperationKey, row);
			}
			return {
				run_id: b.runId,
				receipt_id: row.input.receiptId,
				state: row.result === null ? "executing" : "completed",
				result: row.result,
				output_snapshot_id: null,
				proposal_id: null,
				folder_commit_id: row.commit,
			};
		}),
		completeToolOperation: vi.fn<CloudNativeToolOperationControlPlane["completeToolOperation"]>(async () => {
			throw new Error("A folder writer completes with its commit");
		}),
		completeFolderToolOperation: vi.fn<
			NonNullable<CloudNativeToolOperationControlPlane["completeFolderToolOperation"]>
		>(async (b, input) => {
			const row = [...ledger.values()].find((value) => value.input.receiptId === input.receiptId);
			if (!row || row.result !== null) throw new Error("invalid completion");
			row.result = structuredClone(input.result);
			row.commit = input.folderCommitId;
			return {
				run_id: b.runId,
				receipt_id: input.receiptId,
				state: "completed",
				result: input.result,
				folder_commit_id: input.folderCommitId,
			};
		}),
	};
	const abort = new AbortController();
	const run = await CloudNativeToolRun.open(
		binding,
		{ describeToolAuthority: vi.fn(async () => structuredClone(authority)) },
		abort.signal,
	);
	runs.push(run);
	const todos = (operations = new CloudNativeToolOperations(run, operationControl)) =>
		new CloudFolderTodos({ folder, operations, identity, handle: "nora" });
	const context: CloudToolContext = {
		companyId: identity.companyId,
		runId: identity.runId,
		callId: randomUUID(),
		argumentSha256: "a".repeat(64),
		signal: abort.signal,
		identity,
	};
	const text = (path: string) => {
		const stored = files.get(path);
		return stored ? new TextDecoder().decode(bytesBySha.get(stored.file.fileSha256)) : null;
	};
	// A file as another writer left it.
	const seed = (path: string, body: string) => {
		const data = new TextEncoder().encode(body);
		bytesBySha.set(sha(data), data);
		const file = {
			manifestSha256: sha(`manifest:${sha(data)}`),
			fileSha256: sha(data),
			bytes: data.byteLength,
			mediaType: "text/markdown",
			executable: false,
		};
		files.set(path, { version: randomUUID(), file, updatedAt: now() });
		folders.add(path.split("/").slice(0, -1).join("/"));
	};
	return { identity, files, folders, commits, releases, ledger, operationControl, todos, run, context, text, seed };
}

const PATH = "agents/nora/todos/call-the-bank.md";
/** The tool's own refusal before any effect, which the boundary shows the model as REFUSED: <reason>. */
async function refuses(call: Promise<unknown>, reason: string) {
	const error = await call.then(
		() => null,
		(thrown: unknown) => thrown,
	);
	expect(error).toBeInstanceOf(CloudToolRefusal);
	expect((error as Error).message).toContain(reason);
}
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
	await refuses(
		f.todos().change({ action: "done", operationKey: "todo-1", todoKey: "call-the-bank" }, f.context),
		"does not read as a todo",
	);
	await refuses(
		f.todos().list({ todoKey: "call-the-bank" }, f.context, () => true),
		"does not read as a todo",
	);
	expect(f.ledger.size).toBe(0);
	expect(f.releases).toHaveLength(0);
});

it("refuses what can never be saved, before any receipt", async () => {
	const f = await fixture();
	const todos = f.todos();
	for (const todoKey of ["call.the.bank", "Call-the-bank", "call_the_bank", "a".repeat(65)])
		await refuses(
			todos.change({ action: "upsert", operationKey: "k", todoKey, title: "x", state: "open" }, f.context),
			"a todoKey is the todo's file name",
		);
	await refuses(
		todos.change({ action: "done", operationKey: "k", todoKey: "nothing-here" }, f.context),
		"You have no todo with that todoKey",
	);
	await todos.change({ action: "upsert", operationKey: "todo-1", todoKey: "call-the-bank", title: "x" }, f.context);
	await todos.change({ action: "cancel", operationKey: "todo-2", todoKey: "call-the-bank" }, f.context);
	await refuses(
		todos.change({ action: "upsert", operationKey: "todo-3", todoKey: "call-the-bank", title: "again" }, f.context),
		"a closed todo is not opened again",
	);
	await refuses(
		todos.change({ action: "done", operationKey: "todo-4", todoKey: "call-the-bank" }, f.context),
		"already closed the other way",
	);
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
