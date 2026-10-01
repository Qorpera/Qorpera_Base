import { createHash, randomUUID } from "node:crypto";
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
import type { CloudToolContext } from "@qorpera/runtime/cloud-native-tool-boundary";
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
	return { identity, files, folders, commits, releases, ledger, operationControl, todos, run, context, text };
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
