import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { COMPANY_STATE_PARSER_VERSION, parseCompanyStateFile } from "@qorpera/cloud-client/company-state-files";
import type { CloudFileReference } from "@qorpera/cloud-client/node/cloud-object-store";
import {
	type CloudCompanyFolderBytes,
	CloudCompanyFolderClient,
	CloudCompanyFolderError,
	type CloudCompanyFolderFile,
	type CloudCompanyFolderSignedHooks,
	cloudCompanyFolderRelease,
} from "@qorpera/runtime/cloud-company-folder-client";
import {
	type CloudCompanyPathControl,
	CloudCompanyPathNotText,
	type CloudCompanyPathRpc,
} from "@qorpera/runtime/cloud-company-path-gateway";
import { CloudCompanyFolderRpcError } from "@qorpera/runtime/cloud-company-path-refusal";
import { CloudRuntimeDiagnosticError } from "@qorpera/runtime/cloud-runtime-observability";
import { describe, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

/** Only the wire is simulated here: every response has the exact shape the core's SQL returns for a run, which test
 * 760 pins against the real functions. */
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const signal = () => new AbortController().signal;
const AGENT_ID = "2d1c4a8e-5b6f-4c3d-9e2a-7f8b9c0d1e2f";
const AGENT_TEXT = `---\nid: ${AGENT_ID}\nname: Nora\nrole: Sales\nkind: agent\nstatus: active\n---\nSell.\n`;
const RECEIPT = { resourceId: randomUUID(), resourceRevision: 3, grantId: randomUUID(), grantRevision: 1 };

function folderEntry(path: string, file?: CloudCompanyFolderFile) {
	return {
		path,
		kind: file ? "file" : "folder",
		version: randomUUID(),
		seq: 7,
		updatedAt: "2026-09-29T12:00:00.123456+00:00",
		...(file ?? {}),
		authority: RECEIPT,
	};
}

function fixture(
	handle: (method: CloudCompanyPathRpc, args: Record<string, unknown>) => unknown,
	signedHooks?: CloudCompanyFolderSignedHooks,
) {
	const { binding, authority } = nativeToolAuthorityFixture();
	const stored = new Map<string, Uint8Array>();
	const bytes: CloudCompanyFolderBytes = {
		put: vi.fn(async (data: Uint8Array, mediaType: string): Promise<CloudFileReference> => {
			stored.set(sha(data), Uint8Array.from(data));
			return {
				manifestSha256: sha(`manifest:${sha(data)}`),
				fileSha256: sha(data),
				bytes: data.byteLength,
				mediaType,
			};
		}),
		get: vi.fn(async (file: CloudCompanyFolderFile) => {
			const data = stored.get(file.fileSha256);
			if (!data) throw new Error("Missing fixture bytes");
			return data;
		}),
		range: vi.fn(async (file: CloudCompanyFolderFile, offset: number, length: number) => {
			const data = stored.get(file.fileSha256);
			if (!data) throw new Error("Missing fixture bytes");
			return data.subarray(offset, offset + length);
		}),
	};
	const calls: { method: CloudCompanyPathRpc; args: Record<string, unknown> }[] = [];
	const control: CloudCompanyPathControl = {
		call: vi.fn(async (method, args) => {
			calls.push({ method, args: structuredClone(args) });
			return handle(method, args);
		}),
	};
	const client = new CloudCompanyFolderClient({
		binding,
		identity: authority.identity,
		control,
		bytes,
		...(signedHooks ? { signedHooks } : {}),
	});
	return { client, calls, bytes, stored, binding, identity: authority.identity };
}

function stagedFile(text: string, mediaType = "text/markdown"): CloudCompanyFolderFile {
	return {
		manifestSha256: sha(`manifest:${sha(text)}`),
		fileSha256: sha(text),
		bytes: Buffer.byteLength(text),
		mediaType,
		executable: false,
	};
}

function sqlError(code: string, message: string): CloudCompanyFolderRpcError {
	return new CloudCompanyFolderRpcError(code, message);
}

describe("the folder client's actor", () => {
	it("sends the run as the core's run actor, and nothing of the lease", async () => {
		const { client, calls, binding, identity } = fixture(() => ({
			schema: "qorpera.folder-read/v1",
			asOfSeq: 4,
			found: false,
			entry: null,
		}));
		await expect(client.read("notes/a.md", signal())).resolves.toEqual({ asOfSeq: 4, entry: null });
		expect(calls).toEqual([
			{
				method: "qorpera_folder_read",
				args: {
					p_environment_id: identity.environmentId,
					p_actor: {
						kind: "run",
						runId: binding.runId,
						jobId: binding.jobId,
						runnerId: binding.runnerId,
						assignmentId: binding.assignmentId,
					},
					p_path: "notes/a.md",
				},
			},
		]);
		expect(Object.isFrozen(client.actor)).toBe(true);
	});

	it("refuses a binding that is not the admitted run's", () => {
		const { binding, authority } = nativeToolAuthorityFixture();
		const control: CloudCompanyPathControl = { call: vi.fn() };
		const bytes: CloudCompanyFolderBytes = { put: vi.fn(), get: vi.fn(), range: vi.fn() };
		expect(
			() =>
				new CloudCompanyFolderClient({
					binding: { ...binding, jobId: randomUUID() },
					identity: authority.identity,
					control,
					bytes,
				}),
		).toThrow("does not match the admitted run");
	});
});

describe("reads and listings", () => {
	it("parses a file and a folder with their receipts, closed", async () => {
		const file = stagedFile("hello");
		const answers = [
			{ schema: "qorpera.folder-read/v1", asOfSeq: 9, found: true, entry: folderEntry("Notes/A.md", file) },
			{ schema: "qorpera.folder-read/v1", asOfSeq: 9, found: true, entry: folderEntry("notes") },
			{
				schema: "qorpera.folder-read/v1",
				asOfSeq: 9,
				found: true,
				entry: { ...folderEntry("notes"), extra: true },
			},
			{
				schema: "qorpera.folder-read/v1",
				asOfSeq: 9,
				found: true,
				entry: folderEntry("notes/a.md", { ...file, mediaType: "Text/Plain" }),
			},
			{
				schema: "qorpera.folder-read/v1",
				asOfSeq: 9,
				found: true,
				entry: folderEntry("notes/a.md", { ...file, bytes: -1 } as CloudCompanyFolderFile),
			},
			{
				schema: "qorpera.folder-read/v1",
				asOfSeq: 9,
				found: true,
				entry: { ...folderEntry("notes"), authority: { ...RECEIPT, grantRevision: null } },
			},
			{
				schema: "qorpera.folder-read/v1",
				asOfSeq: 9,
				found: true,
				entry: folderEntry("notes/a.md", { ...file, executable: "no" } as unknown as CloudCompanyFolderFile),
			},
			// SQL finds an entry by the path's key, with its own case rules: another spelling is its answer.
			{ schema: "qorpera.folder-read/v1", asOfSeq: 9, found: true, entry: folderEntry("İstanbul.md", file) },
		];
		const { client } = fixture(() => answers.shift());
		const read = await client.read("notes/a.md", signal());
		expect(read).toEqual({
			asOfSeq: 9,
			entry: {
				path: "Notes/A.md",
				kind: "file",
				version: expect.any(String),
				seq: 7,
				updatedAt: "2026-09-29T12:00:00.123456+00:00",
				authority: RECEIPT,
				file,
			},
		});
		expect((await client.read("notes", signal())).entry?.kind).toBe("folder");
		// An unknown key, a bad media type, a bad size, a half receipt and a bad executable bit are not answers.
		for (let i = 0; i < 5; i++)
			await expect(client.read("notes/a.md", signal())).rejects.toThrow("Company folder response is invalid");
		await expect(client.read("istanbul.md", signal())).resolves.toMatchObject({ entry: { path: "İstanbul.md" } });
	});

	it("parses a link with the target it holds, and refuses a target out of the core's bounds or on another kind", async () => {
		const link = (target?: unknown) => ({ ...folderEntry("docs/latest"), kind: "symlink", target });
		const answers = [
			link("../reports/q3 plan.md"),
			link("x".repeat(4095)),
			link(""),
			link("é".repeat(2048)),
			link(7),
			link(),
			{ ...folderEntry("docs"), target: "plan.md" },
			{ ...folderEntry("docs/plan.md", stagedFile("hi")), target: "plan.md" },
		].map((entry) => ({ schema: "qorpera.folder-read/v1", asOfSeq: 9, found: true, entry }));
		const { client } = fixture(() => answers.shift());
		await expect(client.read("docs/latest", signal())).resolves.toEqual({
			asOfSeq: 9,
			entry: {
				path: "docs/latest",
				kind: "symlink",
				version: expect.any(String),
				seq: 7,
				updatedAt: "2026-09-29T12:00:00.123456+00:00",
				authority: RECEIPT,
				target: "../reports/q3 plan.md",
			},
		});
		const longest = await client.read("docs/latest", signal());
		expect(longest.entry).toMatchObject({ kind: "symlink", target: "x".repeat(4095) });
		// An empty target, one of 4,096 bytes, one that is not text, a link without one, and a target on a folder or a
		// file are not answers.
		for (let i = 0; i < 6; i++)
			await expect(client.read("docs/latest", signal())).rejects.toThrow("Company folder response is invalid");
	});

	it("reads a file's text, checked against its entry", async () => {
		const text = "Første linje\n";
		const file = stagedFile(text);
		const entries: Record<string, unknown> = {
			"a.md": folderEntry("a.md", file),
			"big.md": folderEntry("big.md", { ...file, bytes: 10_000 }),
			folder: folderEntry("folder"),
			"binary.bin": folderEntry("binary.bin", stagedFile("\u0000", "application/octet-stream")),
			latest: { ...folderEntry("latest"), kind: "symlink", target: "a.md" },
		};
		const { client, stored } = fixture((_method, args) => {
			const entry = entries[args.p_path as string];
			return { schema: "qorpera.folder-read/v1", asOfSeq: 2, found: !!entry, entry: entry ?? null };
		});
		stored.set(file.fileSha256, new TextEncoder().encode(text));
		await expect(client.readText("a.md", 1024, signal())).resolves.toMatchObject({ text, entry: { path: "a.md" } });
		await expect(client.readText("missing.md", 1024, signal())).resolves.toBeNull();
		await expect(client.readText("folder", 1024, signal())).rejects.toBeInstanceOf(CloudCompanyPathNotText);
		// A link is not followed: no text, whatever it names.
		await expect(client.readText("latest", 1024, signal())).rejects.toThrow(
			new CloudCompanyPathNotText("Company folder path is a link"),
		);
		await expect(client.readText("big.md", 1024, signal())).rejects.toBeInstanceOf(CloudCompanyPathNotText);
		// Bytes that are not the entry's are refused, whatever they say.
		stored.set(sha("\u0000"), Uint8Array.of(0xff));
		await expect(client.readText("binary.bin", 1024, signal())).rejects.toThrow("do not match their entry");
		stored.set(sha("\u0000"), Uint8Array.of(0));
		await expect(client.readText("binary.bin", 1024, signal())).resolves.toMatchObject({ text: "\u0000" });
		// The right bytes under an entry that states another size.
		entries["short.bin"] = folderEntry("short.bin", { ...stagedFile("\u0000"), bytes: 2 });
		await expect(client.readText("short.bin", 1024, signal())).rejects.toThrow("do not match their entry");
	});

	it("refuses bytes that are not UTF-8 text", async () => {
		const bytes = Uint8Array.of(0xc3, 0x28);
		const file: CloudCompanyFolderFile = {
			manifestSha256: sha("m"),
			fileSha256: sha(bytes),
			bytes: 2,
			mediaType: "text/plain",
			executable: false,
		};
		const { client, stored } = fixture(() => ({
			schema: "qorpera.folder-read/v1",
			asOfSeq: 2,
			found: true,
			entry: folderEntry("a.txt", file),
		}));
		stored.set(file.fileSha256, bytes);
		await expect(client.readText("a.txt", 10, signal())).rejects.toThrow("not UTF-8 text");
	});

	it("pages a listing from the first page's clock", async () => {
		// SQL names `next` only on a full page.
		const first = Array.from({ length: 200 }, (_, index) => `t/${String(index).padStart(3, "0")}`);
		const pages = [
			{
				schema: "qorpera.folder-list/v1",
				asOfSeq: 5,
				entries: first.map((path) => folderEntry(path)),
				next: "t/199",
			},
			{ schema: "qorpera.folder-list/v1", asOfSeq: 6, entries: [folderEntry("t/200")], next: null },
		];
		const { client, calls } = fixture(() => pages.shift());
		const all = await client.listAll("t", { recursive: true, maxEntries: 201 }, signal());
		expect(all.asOfSeq).toBe(5);
		expect(all.entries.map((entry) => entry.path)).toEqual([...first, "t/200"]);
		expect(
			calls.map((call) => [call.args.p_parent, call.args.p_after, call.args.p_limit, call.args.p_recursive]),
		).toEqual([
			["t", null, 200, true],
			["t", "t/199", 200, true],
		]);
	});

	it("pages a code area by names only code/ holds, its cursor one of them (20260930446100)", async () => {
		const first = Array.from({ length: 200 }, (_, index) => `code/acme/a%${String(index).padStart(3, "0")}`);
		const pages = [
			{
				schema: "qorpera.folder-list/v1",
				asOfSeq: 5,
				entries: first.map((path) => folderEntry(path)),
				next: "code/acme/a%199",
			},
			{ schema: "qorpera.folder-list/v1", asOfSeq: 6, entries: [folderEntry("code/acme/con:x")], next: null },
		];
		const { client, calls } = fixture(() => pages.shift());
		const all = await client.listAll("code/acme", { recursive: true, maxEntries: 201 }, signal());
		expect(all.entries.map((entry) => entry.path)).toEqual([...first, "code/acme/con:x"]);
		expect(calls.map((call) => call.args.p_after)).toEqual([null, "code/acme/a%199"]);
	});

	it("stops a whole listing at the caller's bound", async () => {
		const first = Array.from({ length: 200 }, (_, index) => `t/${String(index).padStart(3, "0")}`);
		const { client, calls } = fixture(() => ({
			schema: "qorpera.folder-list/v1",
			asOfSeq: 5,
			entries: first.map((path) => folderEntry(path)),
			next: "t/199",
		}));
		await expect(client.listAll("t", { maxEntries: 150 }, signal())).rejects.toThrow("more entries than its bound");
		expect(calls).toHaveLength(1);
		await expect(client.listAll("t", { maxEntries: 0 }, signal())).rejects.toThrow(
			"Invalid Company folder listing bound",
		);
	});

	it("refuses a page that does not fit its request", async () => {
		const { client } = fixture(() => ({
			schema: "qorpera.folder-list/v1",
			asOfSeq: 5,
			entries: [folderEntry("a"), folderEntry("b")],
			next: null,
		}));
		await expect(client.list("", { limit: 1 }, signal())).rejects.toThrow("Company folder response is invalid");
		await expect(client.list("", { limit: 201 }, signal())).rejects.toThrow("Invalid Company folder page");
		await expect(client.list("", { limit: 2 }, signal())).resolves.toMatchObject({ next: null });
		// `next` only on a full page.
		const partial = fixture(() => ({
			schema: "qorpera.folder-list/v1",
			asOfSeq: 5,
			entries: [folderEntry("a"), folderEntry("b")],
			next: "b",
		}));
		await expect(partial.client.list("", { limit: 3 }, signal())).rejects.toThrow(
			"Company folder response is invalid",
		);
		await expect(partial.client.list("", { limit: 2 }, signal())).resolves.toMatchObject({ next: "b" });
	});

	it("pages the run's own todos from the todo index, closed", async () => {
		const todo = (todoKey: string, extra: Record<string, unknown> = {}) => ({
			todoKey,
			title: `Todo ${todoKey}`,
			state: "open",
			detail: "Call first.",
			path: `QorperaOS/agents/nora/todos/${todoKey}.md`,
			version: randomUUID(),
			updatedAt: "2026-10-01T10:00:00Z",
			cursor: randomUUID(),
			...extra,
		});
		const todos = [todo("b", { detailTruncated: true }), todo("a")];
		const { cursor: _cursor, ...uncursored } = todo("a");
		const answers: unknown[] = [];
		const { client, calls } = fixture(() => answers.shift());
		answers.push({ schema: "qorpera.folder-agent-todos/v1", todos, moreTodos: 3, nextCursor: todos[1]?.cursor });
		await expect(client.agentTodos({ state: "open", search: "call" }, signal())).resolves.toEqual({
			todos,
			moreTodos: 3,
			nextCursor: todos[1]?.cursor,
		});
		expect(calls).toMatchObject([
			{ method: "qorpera_folder_agent_todos", args: { p_request: { state: "open", search: "call" } } },
		]);
		for (const answer of [
			// The cursor continues from the page's last todo, and only when more follow.
			{ schema: "qorpera.folder-agent-todos/v1", todos, moreTodos: 3, nextCursor: todos[0]?.cursor },
			{ schema: "qorpera.folder-agent-todos/v1", todos, moreTodos: 0, nextCursor: todos[1]?.cursor },
			{ schema: "qorpera.folder-agent-todos/v1", todos, moreTodos: 3, nextCursor: null },
			{
				schema: "qorpera.folder-agent-todos/v1",
				todos: Array.from({ length: 33 }, (_, i) => todo(`t${i}`)),
				moreTodos: 0,
				nextCursor: null,
			},
			{
				schema: "qorpera.folder-agent-todos/v1",
				todos: [todo("a", { state: "waiting" })],
				moreTodos: 0,
				nextCursor: null,
			},
			{
				schema: "qorpera.folder-agent-todos/v1",
				todos: [todo("a", { detailTruncated: false })],
				moreTodos: 0,
				nextCursor: null,
			},
			{
				schema: "qorpera.folder-agent-todos/v1",
				todos: [todo("a", { owner: "x" })],
				moreTodos: 0,
				nextCursor: null,
			},
			{ schema: "qorpera.folder-list/v1", todos: [], moreTodos: 0, nextCursor: null },
			// A count and a cursor the page cannot have (the kernel todo tool's checks, legacy sweep C-P2).
			{ schema: "qorpera.folder-agent-todos/v1", todos, moreTodos: -1, nextCursor: null },
			{ schema: "qorpera.folder-agent-todos/v1", todos, moreTodos: 1, nextCursor: "not-a-cursor" },
			{ schema: "qorpera.folder-agent-todos/v1", todos, moreTodos: 1, nextCursor: randomUUID() },
			{ schema: "qorpera.folder-agent-todos/v1", todos, moreTodos: 0 },
			{ schema: "qorpera.folder-agent-todos/v1", todos: [uncursored], moreTodos: 0, nextCursor: null },
			{
				schema: "qorpera.folder-agent-todos/v1",
				todos: [todo("a", { cursor: "page-2" })],
				moreTodos: 0,
				nextCursor: null,
			},
		]) {
			answers.push(answer);
			await expect(client.agentTodos({}, signal())).rejects.toThrow("Company folder response is invalid");
		}
	});

	it("pages one todo's workers from the worker index, refusing a count or cursor the page cannot have", async () => {
		const worker = (workerKey: string, extra: Record<string, unknown> = {}) => ({
			workerKey,
			title: `Worker ${workerKey}`,
			state: "running",
			sequence: 1,
			access: "read",
			revival: "batch",
			outcome: null,
			summary: null,
			needs: null,
			outputs: [],
			reportedAt: null,
			decision: null,
			folder: `QorperaOS/agents/nora/todos/market-scan/${workerKey}`,
			cursor: randomUUID(),
			...extra,
		});
		const workers = [worker("b"), worker("a")];
		const { cursor: _cursor, ...uncursored } = worker("a");
		const page = (extra: Record<string, unknown>) => ({
			schema: "qorpera.folder-agent-workers/v1",
			todoKey: "market-scan",
			workers,
			...extra,
		});
		const answers: unknown[] = [];
		const { client, calls } = fixture(() => answers.shift());
		answers.push(page({ moreWorkers: 2, nextCursor: workers[1]?.cursor }));
		await expect(client.agentWorkers({ todoKey: "market-scan", state: "active" }, signal())).resolves.toMatchObject({
			workers: [{ workerKey: "b", cursor: workers[0]?.cursor }, { workerKey: "a" }],
			moreWorkers: 2,
			nextCursor: workers[1]?.cursor,
		});
		expect(calls).toMatchObject([
			{ method: "qorpera_folder_agent_workers", args: { p_request: { todoKey: "market-scan", state: "active" } } },
		]);
		for (const answer of [
			page({ moreWorkers: 2, nextCursor: null }),
			page({ moreWorkers: 0, nextCursor: workers[1]?.cursor }),
			page({ moreWorkers: 2, nextCursor: workers[0]?.cursor }),
			page({ moreWorkers: -1, nextCursor: null }),
			page({ moreWorkers: 1, nextCursor: "not-a-cursor" }),
			page({ moreWorkers: 1, nextCursor: randomUUID() }),
			page({ moreWorkers: 0 }),
			page({ todoKey: "other", moreWorkers: 0, nextCursor: null }),
			page({ workers: [uncursored], moreWorkers: 0, nextCursor: null }),
			page({ workers: [worker("a", { cursor: "page-2" })], moreWorkers: 0, nextCursor: null }),
			page({ workers: Array.from({ length: 17 }, (_, i) => worker(`w${i}`)), moreWorkers: 0, nextCursor: null }),
		]) {
			answers.push(answer);
			await expect(client.agentWorkers({ todoKey: "market-scan" }, signal())).rejects.toThrow(
				"Company folder response is invalid",
			);
		}
	});
});

describe("commits", () => {
	const saved = (units: Record<string, unknown>[]) => ({
		schema: "qorpera.folder-commit/v1",
		commitId: randomUUID(),
		seq: 11,
		replay: false,
		units: units.map((unit, index) => ({ unit: index + 1, outcome: "saved", version: randomUUID(), ...unit })),
	});

	it("stages each file once and sends each structured file's parse, made from the same bytes", async () => {
		const plain = "Notes\n";
		const refused = "---\nid: nope\n---\n";
		const { client, calls, bytes } = fixture((_method, args) =>
			saved(
				(args.p_units as Record<string, unknown>[]).map((unit) => ({
					op: unit.op,
					path: (unit.path ?? unit.from) as string,
					...(unit.to ? { to: unit.to } : {}),
				})),
			),
		);
		const expectedVersion = randomUUID();
		const result = await client.commit(
			"tool-call-1:save",
			[
				{ op: "write", path: "notes/a.md", content: { text: plain } },
				{ op: "write", path: "notes/b.md", content: { text: plain }, expectedVersion },
				{
					op: "new_folder",
					path: "QorperaOS/agents/nora",
					contents: [
						{ path: "agent.md", kind: "file", content: { text: AGENT_TEXT } },
						{ path: "memory", kind: "folder" },
					],
				},
				{ op: "write", path: "QorperaOS/agents/otto/agent.md", content: { text: refused } },
				{ op: "mkdir", path: "notes/old" },
				{ op: "delete", path: "notes/old", expectedVersion, asOfSeq: 3 },
				{ op: "move", from: "notes/a.md", to: "notes/c.md", expectedVersion },
				{ op: "copy", from: "notes/b.md", to: "notes/d.md" },
			],
			{},
			signal(),
		);
		expect(result.units.map((unit) => unit.outcome)).toEqual(Array(8).fill("saved"));
		// The same bytes are stored once.
		expect(bytes.put).toHaveBeenCalledTimes(3);
		const file = stagedFile(plain);
		const parse = parseCompanyStateFile("QorperaOS/agents/nora/agent.md", AGENT_TEXT);
		const problems = parseCompanyStateFile("QorperaOS/agents/otto/agent.md", refused);
		expect(parse?.ok).toBe(true);
		expect(problems?.ok).toBe(false);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.args).toEqual({
			p_environment_id: expect.any(String),
			p_actor: expect.objectContaining({ kind: "run" }),
			p_operation_key: "tool-call-1:save",
			p_units: [
				{ op: "write", path: "notes/a.md", file },
				{ op: "write", path: "notes/b.md", file, expectedVersion },
				{
					op: "new_folder",
					path: "QorperaOS/agents/nora",
					contents: [
						{ path: "agent.md", kind: "file", file: stagedFile(AGENT_TEXT) },
						{ path: "memory", kind: "folder" },
					],
					structured: [
						{
							path: "QorperaOS/agents/nora/agent.md",
							kind: "agent",
							text: AGENT_TEXT,
							parse: parse?.ok ? JSON.parse(JSON.stringify(parse.file)) : null,
							parserVersion: COMPANY_STATE_PARSER_VERSION,
						},
					],
				},
				{
					op: "write",
					path: "QorperaOS/agents/otto/agent.md",
					file: stagedFile(refused),
					structured: [
						{
							path: "QorperaOS/agents/otto/agent.md",
							kind: "agent",
							problems: problems?.ok ? null : JSON.parse(JSON.stringify(problems?.problems)),
						},
					],
				},
				{ op: "mkdir", path: "notes/old" },
				{ op: "delete", path: "notes/old", expectedVersion, asOfSeq: 3 },
				{ op: "move", from: "notes/a.md", to: "notes/c.md", expectedVersion },
				{ op: "copy", from: "notes/b.md", to: "notes/d.md" },
			],
		});
	});

	it("reports each unit's outcome, reason and problems", async () => {
		const problem = { line: 3, key: "status", code: "value", message: "status is one of active or archived" };
		// The commit strips nulls from each outcome, nested ones included.
		const whole = { code: "front_matter", message: "the platform could not read this file; save it again" };
		const { client } = fixture(() => ({
			schema: "qorpera.folder-commit/v1",
			commitId: randomUUID(),
			seq: null,
			replay: true,
			units: [
				{ unit: 1, op: "write", path: "a.md", outcome: "conflict", reason: "version_changed" },
				{
					unit: 2,
					op: "write",
					path: "QorperaOS/agents/x/agent.md",
					outcome: "refused",
					reason: "structured_invalid",
					problems: [problem, whole],
				},
				{ unit: 3, op: "delete", path: "b", outcome: "waiting_for_review", reason: "waiting_for_review" },
			],
		}));
		const result = await client.commit(
			"tool-call-2",
			[
				{ op: "write", path: "a.md", content: { text: "x" }, expectedVersion: randomUUID() },
				{ op: "write", path: "QorperaOS/agents/x/agent.md", content: { text: AGENT_TEXT } },
				{ op: "delete", path: "b", expectedVersion: randomUUID(), asOfSeq: 1 },
			],
			{ reviewId: randomUUID() },
			signal(),
		);
		expect(result).toMatchObject({ seq: null, replay: true });
		expect(result.units).toEqual([
			{
				unit: 1,
				op: "write",
				path: "a.md",
				to: null,
				version: null,
				outcome: "conflict",
				reason: "version_changed",
				problems: [],
			},
			{
				unit: 2,
				op: "write",
				path: "QorperaOS/agents/x/agent.md",
				to: null,
				version: null,
				outcome: "refused",
				reason: "structured_invalid",
				problems: [problem, { line: null, key: null, ...whole }],
			},
			{
				unit: 3,
				op: "delete",
				path: "b",
				to: null,
				version: null,
				outcome: "waiting_for_review",
				reason: "waiting_for_review",
				problems: [],
			},
		]);
	});

	it("refuses an answer that is not this change set's", async () => {
		const unit = { unit: 1, op: "mkdir", path: "a", outcome: "saved", version: randomUUID() };
		const answers = [
			{ schema: "qorpera.folder-commit/v1", commitId: randomUUID(), seq: 1, replay: false, units: [unit, unit] },
			{
				schema: "qorpera.folder-commit/v1",
				commitId: randomUUID(),
				seq: 1,
				replay: false,
				units: [{ ...unit, op: "write" }],
			},
			{ schema: "qorpera.folder-commit/v1", commitId: randomUUID(), seq: null, replay: false, units: [unit] },
			{
				schema: "qorpera.folder-commit/v1",
				commitId: randomUUID(),
				seq: 1,
				replay: false,
				units: [{ ...unit, reason: "x" }],
			},
			{
				schema: "qorpera.folder-commit/v1",
				commitId: randomUUID(),
				seq: 1,
				replay: false,
				units: [{ ...unit, unit: 2 }],
			},
			// A unit that was not saved without its reason, a sequence number with nothing saved, too many problems.
			{
				schema: "qorpera.folder-commit/v1",
				commitId: randomUUID(),
				seq: null,
				replay: false,
				units: [{ unit: 1, op: "mkdir", path: "a", outcome: "conflict" }],
			},
			{
				schema: "qorpera.folder-commit/v1",
				commitId: randomUUID(),
				seq: 1,
				replay: false,
				units: [{ unit: 1, op: "mkdir", path: "a", outcome: "conflict", reason: "exists" }],
			},
			{
				schema: "qorpera.folder-commit/v1",
				commitId: randomUUID(),
				seq: null,
				replay: false,
				units: [
					{
						unit: 1,
						op: "mkdir",
						path: "a",
						outcome: "refused",
						reason: "structured_invalid",
						problems: Array(52).fill({ code: "value", message: "x" }),
					},
				],
			},
			{
				schema: "qorpera.folder-commit/v1",
				commitId: randomUUID(),
				seq: null,
				replay: false,
				units: [
					{
						unit: 1,
						op: "mkdir",
						path: "a",
						outcome: "refused",
						reason: "structured_invalid",
						problems: [{ line: 0, code: "value", message: "x" }],
					},
				],
			},
		];
		const { client } = fixture(() => answers.shift());
		for (let i = 0; i < 9; i++)
			await expect(client.commit("tool-call-3", [{ op: "mkdir", path: "a" }], {}, signal())).rejects.toThrow(
				"Company folder response is invalid",
			);
	});

	it("checks its request before it stages or calls anything", async () => {
		const { client, calls, bytes } = fixture(() => null);
		const write = { op: "write", path: "a.md", content: { text: "x" } } as const;
		await expect(client.commit("short", [write], {}, signal())).rejects.toThrow("operation key");
		await expect(client.commit("tool-call-4", [], {}, signal())).rejects.toThrow("change set");
		await expect(client.commit("tool-call-4", [write], { receiptId: "nope" }, signal())).rejects.toThrow(
			"review or receipt",
		);
		await expect(
			client.commit("tool-call-4", [{ ...write, content: { text: "x", mediaType: "Text/Plain" } }], {}, signal()),
		).rejects.toThrow("media type");
		// A bad later unit stops the change set before the first unit's bytes are staged.
		await expect(
			client.commit("tool-call-4", [write, { op: "delete", path: "b", expectedVersion: "nope" }], {}, signal()),
		).rejects.toThrow("version");
		await expect(
			client.commit(
				"tool-call-4",
				[write, { op: "delete", path: "b", expectedVersion: randomUUID(), asOfSeq: -1 }],
				{},
				signal(),
			),
		).rejects.toThrow("sequence");
		await expect(
			client.commit(
				"tool-call-4",
				[
					write,
					{
						op: "new_folder",
						path: "a".repeat(3000),
						contents: [{ path: "b".repeat(2000), kind: "file", content: { text: "x" } }],
					},
				],
				{},
				signal(),
			),
		).rejects.toThrow("Invalid Company File path");
		expect(calls).toEqual([]);
		expect(bytes.put).not.toHaveBeenCalled();
	});

	it("takes the names only code/ holds there, a new folder's contents by their joined paths, as SQL does", async () => {
		const { client, calls } = fixture((_method, args) =>
			saved((args.p_units as Record<string, unknown>[]).map((unit) => ({ op: unit.op, path: unit.path as string }))),
		);
		const result = await client.commit(
			"tool-call-5:code",
			[
				{ op: "mkdir", path: "code/acme/app/main/a%b" },
				{
					op: "new_folder",
					path: "code/acme/app/main/c:d",
					contents: [
						{ path: "CON.txt", kind: "folder" },
						{ path: "CON.txt/50%", kind: "file", content: { text: "x" } },
					],
				},
			],
			{},
			signal(),
		);
		expect(result.units.map((unit) => unit.outcome)).toEqual(["saved", "saved"]);
		expect(calls[0]!.args.p_units).toEqual([
			{ op: "mkdir", path: "code/acme/app/main/a%b" },
			{
				op: "new_folder",
				path: "code/acme/app/main/c:d",
				contents: [
					{ path: "CON.txt", kind: "folder" },
					{ path: "CON.txt/50%", kind: "file", file: stagedFile("x", "text/plain") },
				],
			},
		]);
		// Elsewhere they stay refused, inside a new folder too, before anything is sent.
		for (const unit of [
			{ op: "mkdir", path: "docs/a%b" },
			{ op: "new_folder", path: "docs/x", contents: [{ path: "c:d", kind: "folder" }] },
			{ op: "new_folder", path: "docs/x", contents: [{ path: "", kind: "folder" }] },
		] as const)
			await expect(client.commit("tool-call-5:docs", [unit], {}, signal())).rejects.toThrow(
				"Invalid Company File path",
			);
		expect(calls).toHaveLength(1);
	});

	it("stages by content and media type, and names text by its path", async () => {
		const { client, calls, bytes } = fixture((_method, args) =>
			saved((args.p_units as Record<string, unknown>[]).map((unit) => ({ op: unit.op, path: unit.path as string }))),
		);
		await client.commit(
			"tool-call-13",
			[
				{ op: "write", path: "a.txt", content: { text: "same" } },
				{ op: "write", path: "b.md", content: { text: "same" } },
				{ op: "write", path: "c.md", content: { text: "same" } },
				{
					op: "write",
					path: "d.bin",
					content: { bytes: Uint8Array.of(1), mediaType: "application/octet-stream", executable: true },
				},
			],
			{},
			signal(),
		);
		const stagedPairs = vi.mocked(bytes.put).mock.calls.map(([, mediaType, executable]) => [mediaType, executable]);
		expect(stagedPairs).toHaveLength(3);
		expect(stagedPairs).toEqual(
			expect.arrayContaining([
				["text/plain", false],
				["text/markdown", false],
				["application/octet-stream", true],
			]),
		);
		const files = (calls[0]!.args.p_units as { file: CloudCompanyFolderFile }[]).map((unit) => unit.file);
		expect(files.map((file) => [file.mediaType, file.executable])).toEqual([
			["text/plain", false],
			["text/markdown", false],
			["text/markdown", false],
			["application/octet-stream", true],
		]);
	});

	it("sends a structured file whose bytes are not text with its problem, and lets SQL refuse it", async () => {
		const { client, calls } = fixture(() => saved([{ op: "write", path: "QorperaOS/agents/x/agent.md" }]));
		await client.commit(
			"tool-call-14",
			[
				{
					op: "write",
					path: "QorperaOS/agents/x/agent.md",
					content: { bytes: Uint8Array.of(0xc3, 0x28), mediaType: "text/markdown" },
				},
			],
			{},
			signal(),
		);
		expect((calls[0]!.args.p_units as Record<string, unknown>[])[0]!.structured).toEqual([
			{
				path: "QorperaOS/agents/x/agent.md",
				kind: "agent",
				problems: [{ line: null, key: null, code: "encoding", message: "the file is not UTF-8 text" }],
			},
		]);
	});

	it("passes a review and a folder receipt only when the caller has them", async () => {
		const { client, calls } = fixture(() => saved([{ op: "mkdir", path: "a" }]));
		const reviewId = randomUUID();
		const receiptId = randomUUID();
		await client.commit("tool-call-5", [{ op: "mkdir", path: "a" }], { reviewId, receiptId }, signal());
		await client.commit("tool-call-6", [{ op: "mkdir", path: "a" }], {}, signal());
		expect(calls[0]!.args).toMatchObject({ p_review_id: reviewId, p_receipt_id: receiptId });
		expect(calls[1]!.args).not.toHaveProperty("p_review_id");
		expect(calls[1]!.args).not.toHaveProperty("p_receipt_id");
	});

	it.each([{ fileSha256: sha("other") }, { bytes: 2 }, { mediaType: "text/plain" }, { manifestSha256: "not-a-hash" }])(
		"refuses bytes stored differently from what it sent (%j)",
		async (change) => {
			const { client, bytes } = fixture(() => null);
			vi.mocked(bytes.put).mockResolvedValueOnce({
				manifestSha256: sha("m"),
				fileSha256: sha("x"),
				bytes: 1,
				mediaType: "text/markdown",
				...change,
			});
			await expect(
				client.commit("tool-call-7", [{ op: "write", path: "a.md", content: { text: "x" } }], {}, signal()),
			).rejects.toThrow("stored differently");
		},
	);

	it.each([
		sqlError("QRC01", "Company folder authority changed"),
		sqlError("40P01", "deadlock detected"),
		sqlError("23505", "duplicate key value violates unique constraint"),
		sqlError("55P03", "Company folder path could not be locked"),
		new CloudRuntimeDiagnosticError("timeout", "Cloud tool authority unavailable"),
		new CloudRuntimeDiagnosticError("transport_unavailable", "Company File authority unavailable"),
	])("retries %s with the same key and the same units", async (thrown) => {
		let tries = 0;
		const { client, calls, bytes } = fixture(() => {
			if (++tries < 3) throw thrown;
			return saved([{ op: "write", path: "a.md" }]);
		});
		await client.commit("tool-call-8", [{ op: "write", path: "a.md", content: { text: "x" } }], {}, signal());
		expect(calls).toHaveLength(3);
		expect(calls[1]!.args).toEqual(calls[0]!.args);
		expect(calls[2]!.args).toEqual(calls[0]!.args);
		expect(bytes.put).toHaveBeenCalledTimes(1);
	});

	it("gives up after four tries, and never retries anything else", async () => {
		const always = fixture(() => {
			throw sqlError("QRC01", "Company folder authority changed");
		});
		const error = await always.client
			.commit("tool-call-9", [{ op: "mkdir", path: "a" }], {}, signal())
			.catch((error: unknown) => error);
		expect(error).toBeInstanceOf(CloudCompanyFolderError);
		expect(error).toMatchObject({ failure: "contended", category: "stale_version" });
		expect(always.calls).toHaveLength(4);
		const invalidRequest = fixture(() => {
			throw sqlError("22023", "Change set unit 1 is invalid");
		});
		await expect(
			invalidRequest.client.commit("tool-call-10", [{ op: "mkdir", path: "a" }], {}, signal()),
		).rejects.toBeInstanceOf(CloudCompanyFolderRpcError);
		expect(invalidRequest.calls).toHaveLength(1);
		const locked = fixture(() => {
			throw sqlError("55P03", "Company folder path could not be locked");
		});
		await expect(
			locked.client.commit("tool-call-15", [{ op: "mkdir", path: "a" }], {}, signal()),
		).rejects.toMatchObject({
			failure: "contended",
		});
		await expect(locked.client.read("a", signal())).rejects.toMatchObject({ failure: "contended" });
	});

	it("reports an outcome it could not learn as unknown, after the same tries", async () => {
		let tries = 0;
		const { client, calls } = fixture(() => {
			// A lost answer, then the folder moving on: the first try may have been recorded.
			throw ++tries === 1
				? new CloudRuntimeDiagnosticError("timeout", "Cloud tool authority unavailable")
				: sqlError("QRC01", "Company folder authority changed");
		});
		const error = await client
			.commit("tool-call-16", [{ op: "mkdir", path: "a" }], {}, signal())
			.catch((error: unknown) => error);
		expect(error).toMatchObject({ failure: "unknown", category: "transport_unavailable" });
		expect(calls).toHaveLength(4);
		expect(new Set(calls.map((call) => JSON.stringify(call.args))).size).toBe(1);
	});

	it("reports a cancel after a lost try as unknown", async () => {
		const aborted = new AbortController();
		let tries = 0;
		const { client, calls } = fixture(() => {
			if (++tries === 1) throw new CloudRuntimeDiagnosticError("timeout", "Cloud tool authority unavailable");
			aborted.abort();
			throw sqlError("QRC01", "Company folder authority changed");
		});
		await expect(
			client.commit("tool-call-19", [{ op: "mkdir", path: "a" }], {}, aborted.signal),
		).rejects.toMatchObject({ failure: "unknown" });
		expect(calls).toHaveLength(2);
	});

	it("reports a cancel while a try was sent as unknown, and one before any try as a cancel", async () => {
		const during = new AbortController();
		const inFlight = fixture(async (): Promise<unknown> => {
			during.abort();
			return new Promise(() => undefined);
		});
		await expect(
			inFlight.client.commit("tool-call-21", [{ op: "mkdir", path: "a" }], {}, during.signal),
		).rejects.toMatchObject({ failure: "unknown" });
		const before = new AbortController();
		before.abort();
		const idle = fixture(() => null);
		const error = await idle.client
			.commit("tool-call-22", [{ op: "mkdir", path: "a" }], {}, before.signal)
			.catch((error: unknown) => error);
		expect(error).toMatchObject({ category: "cancelled" });
		expect(error).not.toBeInstanceOf(CloudCompanyFolderError);
		expect(idle.calls).toHaveLength(0);
	});

	it("reports a cancel in the pause after a lost try as unknown", async () => {
		const paused = new AbortController();
		const { client, calls } = fixture(() => {
			setTimeout(() => paused.abort(), 1);
			throw new CloudRuntimeDiagnosticError("timeout", "Cloud tool authority unavailable");
		});
		await expect(
			client.commit("tool-call-23", [{ op: "mkdir", path: "a" }], {}, paused.signal),
		).rejects.toMatchObject({ failure: "unknown" });
		expect(calls).toHaveLength(1);
	});

	it("never retries a request PostgREST could not run", async () => {
		const { client, calls } = fixture(() => {
			throw sqlError("PGRST202", "Could not find the function public.qorpera_folder_commit");
		});
		const error = await client
			.commit("tool-call-20", [{ op: "mkdir", path: "a" }], { receiptId: randomUUID() }, signal())
			.catch((error: unknown) => error);
		expect(error).toBeInstanceOf(CloudCompanyFolderRpcError);
		expect(error).toMatchObject({ code: "PGRST202", category: "invalid_arguments" });
		expect(calls).toHaveLength(1);
	});

	it("stops retrying once the caller cancels", async () => {
		const aborted = new AbortController();
		const first = fixture(() => {
			aborted.abort();
			throw sqlError("QRC01", "Company folder authority changed");
		});
		// Cancelled while the try was sent: it may have committed.
		const error17 = await first.client
			.commit("tool-call-17", [{ op: "mkdir", path: "a" }], {}, aborted.signal)
			.catch((error: unknown) => error);
		expect(error17).toMatchObject({ failure: "unknown" });
		expect(first.calls).toHaveLength(1);
		// A cancel during the pause between tries is a cancel, not the folder's error.
		const later = new AbortController();
		const second = fixture(() => {
			setTimeout(() => later.abort(), 1);
			throw sqlError("QRC01", "Company folder authority changed");
		});
		const error = await second.client
			.commit("tool-call-18", [{ op: "mkdir", path: "a" }], {}, later.signal)
			.catch((error: unknown) => error);
		expect(error).toMatchObject({ category: "cancelled" });
		expect(error).not.toBeInstanceOf(CloudCompanyFolderRpcError);
		expect(second.calls).toHaveLength(1);
	});

	it.each([
		["55000", "Company execution is paused", "stopped"],
		["42501", "Run is unavailable", "unavailable"],
		["42501", "Company folder is unavailable", "unavailable"],
		["0A000", "Company File is unavailable", "unavailable"],
		["42501", "A read is no longer readable", "read_revoked"],
		["42501", "A released read is no longer readable", "read_revoked"],
	] as const)("tells the caller why (%s %s)", async (code, message, failure) => {
		const { client, calls } = fixture(() => {
			throw sqlError(code, message);
		});
		const error = await client
			.commit("tool-call-11", [{ op: "mkdir", path: "a" }], {}, signal())
			.catch((error: unknown) => error);
		expect(error).toBeInstanceOf(CloudCompanyFolderError);
		expect(error).toMatchObject({ failure, category: "authority_unavailable" });
		expect(calls).toHaveLength(1);
		const read = await client.read("a", signal()).catch((error: unknown) => error);
		expect(read).toMatchObject({ failure });
	});

	it("passes other failures through unchanged, without retrying them", async () => {
		const invalidAnswer = new CloudRuntimeDiagnosticError(
			"invalid_response",
			"Company File control response too large",
		);
		const { client, calls } = fixture(() => {
			throw invalidAnswer;
		});
		await expect(client.commit("tool-call-12", [{ op: "mkdir", path: "a" }], {}, signal())).rejects.toBe(
			invalidAnswer,
		);
		expect(calls).toHaveLength(1);
	});

	it("sends the actor's ids in the lower case SQL checks", async () => {
		const { binding, authority } = nativeToolAuthorityFixture();
		const upper = {
			...binding,
			runId: binding.runId.toUpperCase(),
			jobId: binding.jobId.toUpperCase(),
			runnerId: binding.runnerId.toUpperCase(),
			assignmentId: binding.assignmentId.toUpperCase(),
		};
		const client = new CloudCompanyFolderClient({
			binding: upper,
			identity: { ...authority.identity, ...upper },
			control: { call: vi.fn() },
			bytes: { put: vi.fn(), get: vi.fn(), range: vi.fn() },
		});
		expect(client.actor).toEqual({
			kind: "run",
			runId: binding.runId,
			jobId: binding.jobId,
			runnerId: binding.runnerId,
			assignmentId: binding.assignmentId,
		});
	});

	it("keeps SQL's words off its errors", () => {
		const cases = [
			["22023", "invalid_arguments"],
			["22P02", "invalid_arguments"],
			["PGRST202", "invalid_arguments"],
			["25000", "invalid_arguments"],
			["42501", "authority_unavailable"],
			["0A000", "authority_unavailable"],
			["55000", "authority_unavailable"],
			["40P01", "transport_unavailable"],
			["QRC01", "transport_unavailable"],
		] as const;
		for (const [code, category] of cases) {
			const error = sqlError(code, "PRIVATE_SQL_WORDS");
			expect(error.category).toBe(category);
			expect(error.detail).toBe("PRIVATE_SQL_WORDS");
			expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain("PRIVATE_SQL_WORDS");
		}
	});
});

describe("reviewed change sets (C2 R1)", () => {
	const recorded = (units: number, reviewId = randomUUID()) => ({
		schema: "qorpera.folder-review/v1",
		reviewId,
		approvedBy: null,
		units,
	});
	const approval = (actionReviewId: string = randomUUID()) => ({
		actionReviewId,
		tool: "hire_agent",
		argumentSha256: sha("call"),
	});
	const units = [
		{ op: "write", path: "QorperaOS/agents/nora/routines/daily.md", content: { text: "Daily.\n" } },
		{ op: "delete", path: "old.md", expectedVersion: randomUUID() },
	] as const;

	it("stages once, records the review of exactly the units the commit sends, then commits them", async () => {
		const actionReviewId = randomUUID();
		const reviewId = randomUUID();
		const { client, calls, bytes, binding } = fixture((method, args) =>
			method === "qorpera_folder_record_review"
				? recorded(2, reviewId)
				: {
						schema: "qorpera.folder-commit/v1",
						commitId: randomUUID(),
						seq: 4,
						replay: false,
						units: (args.p_units as Record<string, unknown>[]).map((unit, index) => ({
							unit: index + 1,
							op: unit.op,
							path: unit.path,
							outcome: "saved",
							version: randomUUID(),
						})),
					},
		);
		const staged = await client.stage(units, signal());
		expect(staged.unitCount).toBe(2);
		expect(bytes.put).toHaveBeenCalledTimes(1);
		await expect(client.recordReview(approval(actionReviewId), staged, signal())).resolves.toBe(reviewId);
		const result = await client.commitStaged("tool-call-r1", staged, { reviewId }, signal());
		expect(result.units.map((unit) => unit.outcome)).toEqual(["saved", "saved"]);
		expect(bytes.put).toHaveBeenCalledTimes(1);
		expect(calls.map((call) => call.method)).toEqual(["qorpera_folder_record_review", "qorpera_folder_commit"]);
		// A run effect: the binding and the request, nothing of the actor; the units are the commit's own.
		expect(Object.keys(calls[0]!.args).sort()).toEqual(["p_binding", "p_request"]);
		expect(calls[0]!.args.p_binding).toEqual(binding);
		expect(calls[0]!.args.p_request).toEqual({
			actionReviewId,
			tool: "hire_agent",
			argumentSha256: sha("call"),
			units: calls[1]!.args.p_units,
		});
		expect(calls[1]!.args.p_review_id).toBe(reviewId);
	});

	it("asks again after a lost answer or a deadlock with the same request, and nothing else", async () => {
		let tries = 0;
		const reviewId = randomUUID();
		const { client, calls } = fixture(() => {
			if (++tries === 1) throw new CloudRuntimeDiagnosticError("timeout", "Cloud tool authority unavailable");
			if (tries === 2) throw sqlError("40P01", "deadlock detected");
			// A card's allow names the member who gave it.
			return { ...recorded(2, reviewId), approvedBy: randomUUID() };
		});
		const staged = await client.stage(units, signal());
		await expect(client.recordReview(approval(), staged, signal())).resolves.toBe(reviewId);
		expect(calls).toHaveLength(3);
		expect(calls[1]!.args).toEqual(calls[0]!.args);
		expect(calls[2]!.args).toEqual(calls[0]!.args);
		for (const thrown of [sqlError("23505", "already used"), sqlError("22023", "Folder review request is invalid")]) {
			const refused = fixture(() => {
				throw thrown;
			});
			await expect(
				refused.client.recordReview(approval(), await refused.client.stage(units, signal()), signal()),
			).rejects.toBe(thrown);
			expect(refused.calls).toHaveLength(1);
		}
		const unavailable = fixture(() => {
			throw sqlError("42501", "This change has no approval in this run");
		});
		await expect(
			unavailable.client.recordReview(approval(), await unavailable.client.stage(units, signal()), signal()),
		).rejects.toMatchObject({ failure: "unavailable" });
	});

	it("refuses an answer that is not this change set's record", async () => {
		for (const answer of [
			recorded(1),
			{ ...recorded(2), approvedBy: "jonas" },
			{ ...recorded(2), schema: "qorpera.folder-review/v2" },
			{ ...recorded(2), reviewId: "review-1" },
			{ ...recorded(2), extra: true },
		]) {
			const { client } = fixture(() => answer);
			await expect(client.recordReview(approval(), await client.stage(units, signal()), signal())).rejects.toThrow(
				"Company folder response is invalid",
			);
		}
	});

	it("records and commits only a change set this client staged, and checks the approval's id first", async () => {
		const { client, calls } = fixture(() => null);
		const other = fixture(() => null).client;
		const foreign = await other.stage(units, signal());
		await expect(client.recordReview(approval(), foreign, signal())).rejects.toThrow("was not staged by this client");
		await expect(client.recordReview(approval(), { unitCount: 2 }, signal())).rejects.toThrow(
			"was not staged by this client",
		);
		await expect(client.commitStaged("tool-call-r2", foreign, {}, signal())).rejects.toThrow(
			"was not staged by this client",
		);
		for (const bad of [
			approval("review-1"),
			{ ...approval(), tool: "Hire agent" },
			{ ...approval(), argumentSha256: "not-a-digest" },
		])
			await expect(client.recordReview(bad, await client.stage(units, signal()), signal())).rejects.toThrow(
				"Invalid action review",
			);
		await expect(client.stage([], signal())).rejects.toThrow("Invalid Company folder change set");
		expect(calls).toEqual([]);
	});
});

describe("changes saved from a computer that wait for review (P40b)", () => {
	const PROPOSAL = "5b0c2d3e-1111-4111-8111-111111111111";
	const units = [
		{
			unit: 1,
			op: "new_folder",
			path: "QorperaOS/agents/nora",
			items: 1,
			contains: [{ path: "QorperaOS/agents/nora/agent.md", kind: "file" }],
			structured: [
				{
					path: "QorperaOS/agents/nora/agent.md",
					kind: "agent",
					parse: { kind: "agent", id: AGENT_ID, name: "Nora" },
				},
			],
		},
		{ unit: 2, op: "move", path: "docs/a.md", to: "docs/b.md" },
	] as const;
	// Every path it names, with its authority (the third unit's too, though it is not listed).
	const reads = ["QorperaOS/agents/nora", "QorperaOS/agents/nora/agent.md", "docs/a.md", "docs/b.md", "docs/c.md"].map(
		(path) => ({
			path,
			authority: RECEIPT,
		}),
	);
	const proposal = (extra: Record<string, unknown> = {}) => ({
		proposalId: PROPOSAL,
		createdAt: "2026-10-05T10:00:00+00:00",
		viewKind: "computer_desktop",
		effect: "delegation",
		createsAgent: true,
		unitCount: 3,
		units,
		moreUnits: 1,
		reads,
		...extra,
	});
	const page = (extra: Record<string, unknown> = {}) => ({
		schema: "qorpera.folder-agent-proposals/v1",
		proposals: [proposal()],
		moreProposals: 0,
		nextCursor: null,
		...extra,
	});
	const listed = {
		proposalId: PROPOSAL,
		createdAt: "2026-10-05T10:00:00+00:00",
		viewKind: "computer_desktop",
		effect: "delegation",
		createsAgent: true,
		unitCount: 3,
		units: [
			{ ...units[0], to: null },
			{ ...units[1], items: null, contains: [], structured: [] },
		],
		moreUnits: 1,
		// No file was read: no version.
		reads: reads.map((read) => ({ ...read, version: null })),
	} as const;

	it("lists the run's open proposals as the kernel pages them, and refuses any other shape", async () => {
		const answers: unknown[] = [page()];
		const { client, calls } = fixture(() => answers.shift());
		await expect(client.agentProposals({ cursor: PROPOSAL }, signal())).resolves.toEqual({
			proposals: [listed],
			moreProposals: 0,
			nextCursor: null,
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			method: "qorpera_folder_agent_proposals",
			args: { p_request: { cursor: PROPOSAL } },
		});
		for (const bad of [
			page({ schema: "qorpera.folder-agent-proposals/v2" }),
			page({ proposals: [proposal(), proposal(), proposal(), proposal(), proposal()] }),
			// The count is the listed units and the rest.
			page({ proposals: [proposal({ moreUnits: 0 })] }),
			page({ proposals: [proposal({ units: [] })] }),
			page({ proposals: [proposal({ units: [units[1], units[0]] })] }),
			page({ proposals: [proposal({ units: [{ ...units[0], op: "chmod" }, units[1]] })] }),
			// Only a new folder names what it contains, each item a path and a kind.
			page({ proposals: [proposal({ units: [units[0], { ...units[1], contains: [] }] })] }),
			page({
				proposals: [
					proposal({
						units: [{ ...units[0], contains: [{ path: "QorperaOS/agents/nora/agent.md", kind: "x" }] }, units[1]],
					}),
				],
			}),
			page({
				proposals: [proposal({ units: [{ ...units[0], contains: [{ path: "", kind: "file" }] }, units[1]] })],
			}),
			page({ proposals: [proposal({ effect: "external" })] }),
			page({ proposals: [proposal({ note: "x" })] }),
			// Its reads: at least one, each a path and a whole authority.
			page({ proposals: [proposal({ reads: undefined })] }),
			page({ proposals: [proposal({ reads: [] })] }),
			page({ proposals: [proposal({ reads: [{ path: "", authority: RECEIPT }] })] }),
			page({
				proposals: [proposal({ reads: [{ path: "docs/a.md", authority: { ...RECEIPT, grantRevision: null } }] })],
			}),
			page({ proposals: [proposal({ reads: [{ path: "docs/a.md", authority: RECEIPT, version: randomUUID() }] })] }),
			// A cursor comes with more, and is the last listed id.
			page({ moreProposals: 2 }),
			page({ moreProposals: 2, nextCursor: "5b0c2d3e-9999-4999-8999-999999999999" }),
		]) {
			answers.push(bad);
			await expect(client.agentProposals({}, signal()), JSON.stringify(bad)).rejects.toThrow(/invalid/);
		}
	});

	it("lists a view's links: a new folder's link with its target, and a link's own unit at its path", async () => {
		const contains = [
			{ path: "QorperaOS/agents/nora/agent.md", kind: "file" },
			{ path: "QorperaOS/agents/nora/latest", kind: "symlink", target: "../../../docs/b.md" },
		];
		const linked = [
			{ ...units[0], items: 2, contains },
			{ unit: 2, op: "symlink", path: "docs/latest" },
		];
		const answers: unknown[] = [page({ proposals: [proposal({ units: linked, unitCount: 2, moreUnits: 0 })] })];
		const { client } = fixture(() => answers.shift());
		const { proposals } = await client.agentProposals({}, signal());
		expect(proposals[0]?.units).toEqual([
			{ ...units[0], items: 2, contains, to: null },
			{ unit: 2, op: "symlink", path: "docs/latest", to: null, items: null, contains: [], structured: [] },
		]);
		const withItem = (item: Record<string, unknown>) =>
			page({ proposals: [proposal({ units: [{ ...units[0], contains: [item] }, units[1]] })] });
		for (const bad of [
			// A link's item carries its target, of 1 to 4,095 bytes; no other item has one.
			withItem({ path: "QorperaOS/agents/nora/latest", kind: "symlink" }),
			withItem({ path: "QorperaOS/agents/nora/latest", kind: "symlink", target: "" }),
			withItem({ path: "QorperaOS/agents/nora/latest", kind: "symlink", target: "x".repeat(4096) }),
			withItem({ path: "QorperaOS/agents/nora/agent.md", kind: "file", target: "x" }),
			withItem({ path: "QorperaOS/agents/nora/docs", kind: "folder", target: "x" }),
		]) {
			answers.push(bad);
			await expect(client.agentProposals({}, signal()), JSON.stringify(bad)).rejects.toThrow(/invalid/);
		}
	});

	it("records the approval as the review of the proposal's own units, and says when it is no longer open", async () => {
		const actionReviewId = randomUUID();
		const reviewId = randomUUID();
		const answers: unknown[] = [{ schema: "qorpera.folder-review/v1", reviewId, approvedBy: null, units: 3 }];
		const { client, calls, binding } = fixture(() => {
			const next = answers.shift();
			if (next instanceof Error) throw next;
			return next;
		});
		const approval = { actionReviewId, argumentSha256: sha("call") };
		await expect(client.recordProposalReview(approval, listed, signal())).resolves.toBe(reviewId);
		expect(calls[0]).toEqual({
			method: "qorpera_folder_record_review",
			args: {
				p_binding: binding,
				p_request: { actionReviewId, tool: "apply_proposal", argumentSha256: sha("call"), proposalId: PROPOSAL },
			},
		});
		answers.push(sqlError("42501", "This proposal is not open for this run"));
		await expect(client.recordProposalReview(approval, listed, signal())).resolves.toBeNull();
		// Any other refusal is not this one, and a review of another number of units is not this proposal's.
		answers.push(sqlError("42501", "Run authority is unavailable"));
		await expect(client.recordProposalReview(approval, listed, signal())).rejects.toThrow();
		answers.push({ schema: "qorpera.folder-review/v1", reviewId, approvedBy: null, units: 2 });
		await expect(client.recordProposalReview(approval, listed, signal())).rejects.toThrow(/invalid/);
		const before = calls.length;
		await expect(
			client.recordProposalReview({ ...approval, actionReviewId: "nope" }, listed, signal()),
		).rejects.toThrow("Invalid action review");
		expect(calls).toHaveLength(before);
	});

	it("applies a proposal under its receipt, with each unit's result, every unit counted", async () => {
		const reviewId = randomUUID();
		const receiptId = randomUUID();
		const commitId = randomUUID();
		const results = [
			{ unit: 1, op: "new_folder", path: "QorperaOS/agents/nora", outcome: "saved", version: randomUUID() },
			{ unit: 2, op: "move", path: "docs/a.md", to: "docs/b.md", outcome: "conflict", reason: "version_changed" },
			// Past the list, any op.
			{ unit: 3, op: "delete", path: "docs/c.md", outcome: "conflict", reason: "missing" },
		];
		const answers: unknown[] = [
			{ schema: "qorpera.folder-commit/v1", commitId, seq: 9, replay: false, units: results },
		];
		const { client, calls } = fixture(() => answers.shift());
		const committed = await client.applyProposal(
			`apply-proposal:${PROPOSAL}`,
			listed,
			{ reviewId, receiptId },
			signal(),
		);
		expect(committed).toMatchObject({ commitId, seq: 9, replay: false });
		if ("unapplied" in committed) throw new Error("not applied");
		expect(committed.units.map((unit) => [unit.outcome, unit.to, unit.reason])).toEqual([
			["saved", null, null],
			["conflict", "docs/b.md", "version_changed"],
			["conflict", null, "missing"],
		]);
		// As the run's actor, like a commit.
		expect(calls[0]).toMatchObject({
			method: "qorpera_folder_apply_proposal",
			args: {
				p_operation_key: `apply-proposal:${PROPOSAL}`,
				p_proposal_id: PROPOSAL,
				p_review_id: reviewId,
				p_receipt_id: receiptId,
			},
		});
		const failed = results.map(({ version: _, ...unit }) => ({ ...unit, outcome: "conflict", reason: "exists" }));
		for (const bad of [
			// Every unit of the proposal answers, the listed ones with their own op.
			{ seq: 9, units: results.slice(0, 2) },
			{ seq: 9, units: [{ ...results[0], op: "write" }, results[1], results[2]] },
			// A sequence number exactly when something was saved.
			{ seq: null, units: results },
			{ seq: 9, units: failed },
		]) {
			answers.push({ schema: "qorpera.folder-commit/v1", commitId, replay: false, ...bad });
			await expect(
				client.applyProposal(`apply-proposal:${PROPOSAL}`, listed, { reviewId, receiptId }, signal()),
				JSON.stringify(bad),
			).rejects.toThrow(/invalid/);
		}
		answers.push({ schema: "qorpera.folder-commit/v1", commitId, seq: null, replay: true, units: failed });
		await expect(
			client.applyProposal(`apply-proposal:${PROPOSAL}`, listed, { reviewId, receiptId }, signal()),
		).resolves.toMatchObject({ seq: null, replay: true });
		// Decided or erased before the apply reached it: the kernel cancelled this receipt, and says what the proposal is.
		const unapplied = { schema: "qorpera.folder-proposal-unapplied/v1", proposalId: PROPOSAL, receiptId };
		for (const status of ["discarded", "erased", "applied"]) {
			answers.push({ ...unapplied, status });
			await expect(
				client.applyProposal(`apply-proposal:${PROPOSAL}`, listed, { reviewId, receiptId }, signal()),
			).resolves.toEqual({ unapplied: status });
		}
		for (const bad of [
			{ status: "open" },
			{ status: "discarded", receiptId: randomUUID() },
			{ status: "discarded", proposalId: AGENT_ID },
			{ status: "discarded", commitId },
		]) {
			answers.push({ ...unapplied, ...bad });
			await expect(
				client.applyProposal(`apply-proposal:${PROPOSAL}`, listed, { reviewId, receiptId }, signal()),
				JSON.stringify(bad),
			).rejects.toThrow(/invalid/);
		}
	});

	it("closes a proposal as declined with the denial's id, else as discarded, and answers a decided one as it stands", async () => {
		const actionReviewId = randomUUID();
		const answers: unknown[] = [
			{ schema: "qorpera.folder-proposal/v1", proposalId: PROPOSAL, status: "declined" },
			{ schema: "qorpera.folder-proposal/v1", proposalId: PROPOSAL, status: "applied" },
			sqlError("P0002", "Proposal is unavailable"),
			{ schema: "qorpera.folder-proposal/v1", proposalId: PROPOSAL, status: "open" },
			{ schema: "qorpera.folder-proposal/v1", proposalId: AGENT_ID, status: "discarded" },
		];
		const { client, calls, binding } = fixture(() => {
			const next = answers.shift();
			if (next instanceof Error) throw next;
			return next;
		});
		await expect(client.closeProposal(PROPOSAL, actionReviewId, signal())).resolves.toBe("declined");
		await expect(client.closeProposal(PROPOSAL, undefined, signal())).resolves.toBe("applied");
		expect(calls.map((call) => call.args)).toEqual([
			{ p_binding: binding, p_request: { proposalId: PROPOSAL, actionReviewId } },
			{ p_binding: binding, p_request: { proposalId: PROPOSAL } },
		]);
		await expect(client.closeProposal(PROPOSAL, undefined, signal())).resolves.toBeNull();
		await expect(client.closeProposal(PROPOSAL, undefined, signal())).rejects.toThrow(/invalid/);
		await expect(client.closeProposal(PROPOSAL, undefined, signal())).rejects.toThrow(/invalid/);
		await expect(client.closeProposal(PROPOSAL.toUpperCase(), undefined, signal())).rejects.toThrow(
			"Invalid Company folder proposal",
		);
	});
});

describe("routines (thin writers W4c)", () => {
	const routine = (routineKey: string, extra: Record<string, unknown> = {}) => {
		const id = randomUUID();
		return {
			routineKey,
			routineId: id,
			version: 2,
			status: "active",
			pauseReason: null,
			title: `Routine ${routineKey}`,
			trigger: { id: "file", kind: "schedule", intervalMinutes: 60, replyPolicy: "optional" },
			effort: "medium",
			expiresAt: null,
			maxOccurrences: null,
			quietHours: null,
			occurrences: 3,
			nextRunAt: "2026-10-02T09:00:00+00:00",
			conclusion: null,
			concludedAt: null,
			path: `QorperaOS/agents/nora/routines/${routineKey}.md`,
			folderVersion: randomUUID(),
			cursor: id,
			file: { kind: "routine", id, title: `Routine ${routineKey}`, status: "active", instructions: "Look." },
			...extra,
		};
	};
	const page = (routines: unknown[], moreRoutines = 0, nextCursor: unknown = null) => ({
		schema: "qorpera.folder-agent-routines/v1",
		routines,
		moreRoutines,
		nextCursor,
	});

	it("pages the run's own routines from the routine index, closed", async () => {
		const routines = [
			routine("b", { instructionsTruncated: true }),
			routine("a", { status: "paused", pauseReason: "member" }),
		];
		const answers: unknown[] = [];
		const { client, calls } = fixture(() => answers.shift());
		answers.push(page(routines, 3, routines[1]?.cursor));
		const read = await client.agentRoutines({ cursor: routines[0]!.cursor }, signal());
		expect(read).toEqual({
			routines: routines.map((item) => ({
				routineKey: item.routineKey,
				routineId: item.routineId,
				status: item.status,
				pauseReason: item.pauseReason,
				nextRunAt: item.nextRunAt,
				occurrences: 3,
				path: item.path,
				folderVersion: item.folderVersion,
				file: item.file,
				...(item.routineKey === "b" ? { instructionsTruncated: true } : {}),
				cursor: item.cursor,
			})),
			moreRoutines: 3,
			nextCursor: routines[1]?.cursor,
		});
		expect(calls).toMatchObject([
			{ method: "qorpera_folder_agent_routines", args: { p_request: { cursor: routines[0]!.cursor } } },
		]);
		// One routine by its key.
		answers.push(page([routine("a")]));
		await expect(client.agentRoutines({ routineKey: "a" }, signal())).resolves.toMatchObject({
			routines: [{ routineKey: "a" }],
		});
		for (const [request, answer] of [
			// The cursor continues from the page's last routine, and only when more follow.
			[{}, page(routines, 3, routines[0]?.cursor)],
			[{}, page(routines, 0, routines[1]?.cursor)],
			[{}, page(routines, 3, null)],
			[{}, page(Array.from({ length: 33 }, (_, i) => routine(`r${i}`)))],
			[{}, page([routine("a", { status: "waiting" })])],
			[{}, page([routine("a", { instructionsTruncated: false })])],
			[{}, page([routine("a", { owner: "x" })])],
			[{}, page([routine("a", { cursor: randomUUID() })])],
			[{}, page([routine("a", { file: [] })])],
			[{}, page([routine("a", { occurrences: -1 })])],
			// A key reads that routine alone.
			[{ routineKey: "a" }, page([routine("a"), routine("b")])],
			[{ routineKey: "a" }, page([routine("b")])],
			[{}, { ...page([]), schema: "qorpera.folder-agent-todos/v1" }],
		] as const) {
			answers.push(answer);
			await expect(client.agentRoutines(request, signal())).rejects.toThrow("Company folder response is invalid");
		}
	});

	it("pins the routine login as a run effect, asks again after a deadlock, and names the wake's refusals", async () => {
		let tries = 0;
		const bindingId = randomUUID();
		const { client, calls, binding } = fixture(() => {
			if (++tries === 1) throw sqlError("40P01", "deadlock detected");
			return { schema: "qorpera.routine-login/v1", runId: binding.runId, login: { bindingId, version: 4 } };
		});
		await expect(client.prepareRoutineLogin(signal())).resolves.toEqual({ login: { bindingId, version: 4 } });
		// The run's binding as the run effect takes it: no folder actor.
		expect(calls).toEqual([
			{ method: "qorpera_prepare_routine_login", args: { p_binding: binding } },
			{ method: "qorpera_prepare_routine_login", args: { p_binding: binding } },
		]);
		const none = fixture(() => ({ schema: "qorpera.routine-login/v1", runId: none.binding.runId, login: null }));
		await expect(none.client.prepareRoutineLogin(signal())).resolves.toEqual({ login: null });
		for (const [message, refused] of [
			["Wake requires an acknowledgement before work", "acknowledgement"],
			["Wake public output is already final", "final"],
			["Company execution is paused", "paused"],
		] as const) {
			const wake = fixture(() => {
				throw sqlError("55000", message);
			});
			await expect(wake.client.prepareRoutineLogin(signal())).resolves.toEqual({ refused });
			expect(wake.calls).toHaveLength(1);
		}
		const cancelled = fixture(() => {
			throw sqlError("55000", "Worker was cancelled");
		});
		await expect(cancelled.client.prepareRoutineLogin(signal())).rejects.toMatchObject({ failure: "stopped" });
		const unavailable = fixture(() => {
			throw sqlError("42501", "Routine authority is unavailable");
		});
		await expect(unavailable.client.prepareRoutineLogin(signal())).rejects.toMatchObject({ failure: "unavailable" });
		for (const answer of [
			{ schema: "qorpera.routine-login/v1", runId: randomUUID(), login: null },
			{ schema: "qorpera.routine-login/v1", runId: binding.runId, login: { bindingId: "x", version: 1 } },
			{ schema: "qorpera.routine-login/v1", runId: binding.runId, login: { bindingId, version: 1, extra: 1 } },
			{ schema: "qorpera.folder-review/v1", runId: binding.runId, login: null },
		]) {
			const wrong = fixture(() => answer);
			await expect(wrong.client.prepareRoutineLogin(signal())).rejects.toThrow("Company folder response is invalid");
		}
	});
});

describe("hooks (E3a)", () => {
	const ADDRESS = "Ab_-".repeat(10).concat("xyz");
	const PATH = `/functions/v1/event-intake/${ADDRESS}`;
	const CREATE = {
		action: "create",
		kind: "hook",
		name: "site-form",
		purpose: "Leads from the website.",
		perMinute: 10,
		operationKey: "hook-1",
	} as const;
	const MAILBOX = {
		action: "create",
		kind: "mailbox",
		localPart: "sales.acme",
		purpose: "Sales mail.",
		operationKey: "box-1",
	} as const;
	type Fixture = ReturnType<typeof fixture>;
	/** The hook SQL's descriptor gives (qorpera_event_hook_descriptor), as test 939 pins it. */
	const hook = (f: Fixture, extra: Record<string, unknown> = {}) => ({
		schema: "qorpera.event-hook/v1",
		id: "73900000-0000-4000-8000-0000000000a1",
		companyId: f.identity.companyId,
		environmentId: f.identity.environmentId,
		name: "site-form",
		purpose: "Leads from the website.",
		proof: "address",
		status: "active",
		maxBodyBytes: 65536,
		perMinute: 10,
		createdAt: "2026-10-06T12:00:00.123456+00:00",
		...extra,
	});
	const receipt = (f: Fixture, action: string, answered: Record<string, unknown>) => ({
		schema: "qorpera.agent-hook-receipt/v1",
		runId: f.binding.runId,
		receiptId: "73900000-0000-4000-8000-0000000000c1",
		action,
		hook: answered,
	});
	const GITHUB = {
		...CREATE,
		name: "github-pushes",
		proof: "github",
		site: "github.com",
		operationKey: "gh-1",
	} as const;
	/** The hook's secret, as the descriptor names it (never its value), as test 987 pins it. */
	const SECRET = {
		connectorId: "event_hook",
		secretName: `h${"73900000-0000-4000-8000-0000000000a1".replaceAll("-", "")}`,
		ready: true,
	} as const;
	/** The secret broker's answer to a signed creation (qorpera_folder_open_signed_hook), as test 987 pins it. */
	const signedReceipt = (
		f: Fixture,
		request: { readonly name: string; readonly proof: string; readonly site: string },
	) => ({
		...receipt(
			f,
			"create",
			hook(f, { name: request.name, proof: request.proof, signingSecret: SECRET, address: ADDRESS, path: PATH }),
		),
		secretSite: request.site,
	});
	const brokerRefusal = (code: string, message: string) => ({
		schema: "qorpera.event-hook-refusal/v1",
		code,
		message,
	});
	/** A signed hook is never opened through SQL. */
	const noSql = () => {
		throw new Error("A signed hook never goes through SQL");
	};

	it("opens a hook as a run effect, asks again after a deadlock, and answers with its address", async () => {
		let tries = 0;
		const f: Fixture = fixture(() => {
			if (++tries === 1) throw sqlError("40P01", "deadlock detected");
			return receipt(f, "create", hook(f, { address: ADDRESS, path: PATH, url: `https://api.example.test${PATH}` }));
		});
		await expect(f.client.manageHook(CREATE, signal())).resolves.toEqual({
			receiptId: "73900000-0000-4000-8000-0000000000c1",
			action: "create",
			hook: hook(f, { address: ADDRESS, path: PATH, url: `https://api.example.test${PATH}` }),
		});
		// The run's binding and the request as the run effect takes them: no folder actor.
		expect(f.calls).toEqual([
			{ method: "qorpera_folder_manage_hook", args: { p_binding: f.binding, p_request: CREATE } },
			{ method: "qorpera_folder_manage_hook", args: { p_binding: f.binding, p_request: CREATE } },
		]);
		// Before the platform has a public address: no URL. A replay after the hook was removed: the receipt's hook, no
		// address.
		const early: Fixture = fixture(() => receipt(early, "create", hook(early, { address: ADDRESS, path: PATH })));
		await expect(early.client.manageHook(CREATE, signal())).resolves.toMatchObject({ hook: { path: PATH } });
		const removed: Fixture = fixture(() => receipt(removed, "create", hook(removed)));
		await expect(removed.client.manageHook(CREATE, signal())).resolves.toMatchObject({ action: "create" });
	});

	it("opens a mailbox, and pauses, resumes and removes a hook by its name", async () => {
		const box: Fixture = fixture(() =>
			receipt(
				box,
				"create",
				hook(box, {
					name: "mail-sales-acme-5d41c2",
					purpose: "Sales mail.",
					proof: "mail",
					maxBodyBytes: 262144,
					perMinute: 120,
					email: "sales.acme@mail.example.test",
				}),
			),
		);
		await expect(box.client.manageHook(MAILBOX, signal())).resolves.toMatchObject({
			action: "create",
			hook: { name: "mail-sales-acme-5d41c2", email: "sales.acme@mail.example.test" },
		});
		expect(box.calls[0].args).toEqual({ p_binding: box.binding, p_request: MAILBOX });
		for (const [action, status] of [
			["pause", "paused"],
			["resume", "active"],
			["remove", "removed"],
		] as const) {
			const request = { action, hook: "site-form", operationKey: `${action}-1` };
			const f: Fixture = fixture(() => receipt(f, action, hook(f, { status, lastReceivedAt: null })));
			await expect(f.client.manageHook(request, signal())).resolves.toMatchObject({ action, hook: { status } });
			expect(f.calls).toEqual([
				{ method: "qorpera_folder_manage_hook", args: { p_binding: f.binding, p_request: request } },
			]);
		}
	});

	it("names SQL's refusals in the model's words, at once, and fails on anything else", async () => {
		for (const [code, message, refused] of [
			["23505", "A hook with this name already exists", "A hook with this name already exists"],
			["54000", "A company has at most 50 hooks", "A company has at most 50 hooks"],
			["0A000", "Company mail is not set up yet", "Company mail is not set up yet"],
			["P0002", "No hook has this name", "No hook has this name"],
			["55000", "This hook was removed", "This hook was removed"],
			[
				"55000",
				"A run this hook woke cannot remove it; pause it instead",
				"A run this hook woke cannot remove it; pause it instead",
			],
			[
				"42501",
				"Only owners and admins can open hooks; ask one of them",
				"Only owners and admins can open hooks; ask one of them",
			],
			[
				"22023",
				"A new address is a name, a dot and the company's handle, like hello.acme",
				"A new address is a name, a dot and the company's handle, like hello.acme",
			],
			[
				"42501",
				"Only a member can choose the company's email handle",
				"Only a member can choose the company's email handle",
			],
			["23505", "This address is taken", "This address is taken"],
			[
				"23505",
				"logical operation key is already bound to other work",
				"That operationKey was used for a different request: use a new one",
			],
			["42501", "Hook authority is unavailable", "Only an agent's own run opens or changes hooks, never a worker's"],
			[
				"55000",
				"Wake requires an acknowledgement before work",
				"This conversation needs your first reply before any work: answer the member, then call again",
			],
			["55000", "Company execution is paused", "The company's work is paused, so nothing can be changed now"],
		] as const) {
			const f = fixture(() => {
				throw sqlError(code, message);
			});
			await expect(f.client.manageHook(CREATE, signal())).resolves.toEqual({ refused });
			expect(f.calls).toHaveLength(1);
		}
		const invalidRequest = fixture(() => {
			throw sqlError("22023", "Hook request is invalid");
		});
		await expect(invalidRequest.client.manageHook(CREATE, signal())).rejects.toBeInstanceOf(
			CloudCompanyFolderRpcError,
		);
		const cancelled = fixture(() => {
			throw sqlError("55000", "Worker was cancelled");
		});
		await expect(cancelled.client.manageHook(CREATE, signal())).rejects.toMatchObject({ failure: "stopped" });
	});

	it("reports a refusal after a lost answer as unknown, in that call and in later ones with the same key", async () => {
		let tries = 0;
		let refuse = false;
		const f: Fixture = fixture(() => {
			// A lost answer, then SQL refusing the replay: the first try may have opened the hook.
			if (++tries === 1) throw new CloudRuntimeDiagnosticError("timeout", "Cloud tool authority unavailable");
			if (refuse || tries === 2) throw sqlError("23505", "A hook with this name already exists");
			return receipt(f, "create", hook(f, { address: ADDRESS, path: PATH }));
		});
		await expect(f.client.manageHook(CREATE, signal())).rejects.toMatchObject({ failure: "unknown" });
		expect(f.calls).toHaveLength(2);
		refuse = true;
		await expect(f.client.manageHook(CREATE, signal())).rejects.toMatchObject({ failure: "unknown" });
		// Another key never met a lost answer: its refusal is SQL's.
		await expect(f.client.manageHook({ ...CREATE, operationKey: "hook-2" }, signal())).resolves.toEqual({
			refused: "A hook with this name already exists",
		});
		// An answer that did not check leaves its key uncertain too.
		const wrong: Fixture = fixture(() => {
			if (wrong.calls.length === 1) return receipt(wrong, "create", hook(wrong, { status: "paused" }));
			throw sqlError("23505", "A hook with this name already exists");
		});
		await expect(wrong.client.manageHook(CREATE, signal())).rejects.toThrow("Company folder response is invalid");
		await expect(wrong.client.manageHook(CREATE, signal())).rejects.toMatchObject({ failure: "unknown" });
	});

	it("refuses an answer that is not this change's", async () => {
		const pause = { action: "pause", hook: "site-form", operationKey: "pause-1" } as const;
		const live = { address: ADDRESS, path: PATH };
		for (const [request, answer] of [
			[CREATE, (f: Fixture) => ({ ...receipt(f, "create", hook(f, live)), runId: randomUUID() })],
			[CREATE, (f: Fixture) => receipt(f, "pause", hook(f, live))],
			[CREATE, (f: Fixture) => ({ ...receipt(f, "create", hook(f, live)), extra: 1 })],
			[CREATE, (f: Fixture) => ({ ...receipt(f, "create", hook(f, live)), receiptId: "r" })],
			[CREATE, (f: Fixture) => receipt(f, "create", hook(f, { ...live, status: "paused" }))],
			[CREATE, (f: Fixture) => receipt(f, "create", hook(f, { ...live, name: "other-form" }))],
			[CREATE, (f: Fixture) => receipt(f, "create", hook(f, { ...live, proof: "mail" }))],
			[CREATE, (f: Fixture) => receipt(f, "create", hook(f, { ...live, companyId: randomUUID() }))],
			[CREATE, (f: Fixture) => receipt(f, "create", hook(f, { ...live, environmentId: randomUUID() }))],
			[CREATE, (f: Fixture) => receipt(f, "create", hook(f, { ...live, schema: "qorpera.event-hooks/v1" }))],
			[CREATE, (f: Fixture) => receipt(f, "create", hook(f, { ...live, id: "site-form" }))],
			[CREATE, (f: Fixture) => receipt(f, "create", hook(f, { ...live, secret: "s" }))],
			[CREATE, (f: Fixture) => receipt(f, "create", hook(f, { ...live, address: "short" }))],
			[
				CREATE,
				(f: Fixture) =>
					receipt(f, "create", hook(f, { ...live, path: `/functions/v1/event-intake/${"b".repeat(43)}` })),
			],
			[
				CREATE,
				(f: Fixture) => receipt(f, "create", hook(f, { ...live, url: "https://api.example.test/elsewhere" })),
			],
			[CREATE, (f: Fixture) => receipt(f, "create", hook(f, { path: PATH }))],
			[CREATE, (f: Fixture) => receipt(f, "create", hook(f, { url: `https://api.example.test${PATH}` }))],
			[pause, (f: Fixture) => receipt(f, "pause", hook(f, { ...live, status: "paused" }))],
			[pause, (f: Fixture) => receipt(f, "pause", hook(f, { status: "active" }))],
			[pause, (f: Fixture) => receipt(f, "pause", hook(f, { status: "paused", name: "other-form" }))],
			[
				MAILBOX,
				(f: Fixture) =>
					receipt(
						f,
						"create",
						hook(f, { name: "mail-sales-acme-5d41c2", proof: "mail", email: "support.acme@mail.example.test" }),
					),
			],
			[
				MAILBOX,
				(f: Fixture) =>
					receipt(f, "create", hook(f, { name: "sales", proof: "mail", email: "sales.acme@mail.example.test" })),
			],
			[
				MAILBOX,
				(f: Fixture) =>
					receipt(
						f,
						"create",
						hook(f, { name: "mail-sales-acme-5d41c2", proof: "address", email: "sales.acme@mail.example.test" }),
					),
			],
			[
				MAILBOX,
				(f: Fixture) =>
					receipt(
						f,
						"create",
						hook(f, {
							name: "mail-sales-acme-5d41c2",
							proof: "mail",
							email: "sales.acme@mail.example.test",
							...live,
						}),
					),
			],
		] as const) {
			const f: Fixture = fixture(() => answer(f));
			await expect(f.client.manageHook(request, signal()), JSON.stringify(answer(f))).rejects.toThrow(
				"Company folder response is invalid",
			);
		}
		// An address hook's creation has no secret and names no site.
		const secretless: Fixture = fixture(() => ({
			...receipt(secretless, "create", hook(secretless, live)),
			secretSite: "github.com",
		}));
		await expect(secretless.client.manageHook(CREATE, signal())).rejects.toThrow(
			"Company folder response is invalid",
		);
		const withSecret: Fixture = fixture(() =>
			receipt(withSecret, "create", hook(withSecret, { ...live, signingSecret: SECRET })),
		);
		await expect(withSecret.client.manageHook(CREATE, signal())).rejects.toThrow(
			"Company folder response is invalid",
		);
	});

	it("opens a signed hook through the secret broker, never through SQL, and names the site its secret is typed into", async () => {
		const HMAC = { ...CREATE, name: "billing", proof: "hmac-sha256", site: "app.billing.example.com" } as const;
		for (const request of [GITHUB, HMAC]) {
			const eventHook = vi.fn<CloudCompanyFolderSignedHooks["eventHook"]>(async () => signedReceipt(f, request));
			const f: Fixture = fixture(noSql, { eventHook });
			await expect(f.client.manageHook(request, signal())).resolves.toEqual({
				receiptId: "73900000-0000-4000-8000-0000000000c1",
				action: "create",
				hook: hook(f, {
					name: request.name,
					proof: request.proof,
					signingSecret: SECRET,
					address: ADDRESS,
					path: PATH,
				}),
				secretSite: request.site,
			});
			// The run's binding and the request as the tool checked it.
			expect(eventHook.mock.calls.map(([sent]) => sent)).toEqual([{ binding: f.binding, request }]);
			expect(f.calls).toEqual([]);
		}
		// A replay after the hook was removed: the receipt's hook, its secret and site, no address.
		const removed: Fixture = fixture(noSql, {
			eventHook: async () => ({
				...receipt(removed, "create", hook(removed, { name: GITHUB.name, proof: "github", signingSecret: SECRET })),
				secretSite: "github.com",
			}),
		});
		await expect(removed.client.manageHook(GITHUB, signal())).resolves.toMatchObject({ secretSite: "github.com" });
	});

	it("refuses a signed hook as unavailable without the secret broker, and sends nothing", async () => {
		const f = fixture(noSql);
		await expect(f.client.manageHook(GITHUB, signal())).rejects.toMatchObject({ failure: "unavailable" });
		expect(f.calls).toEqual([]);
	});

	it("names the broker's refusals in the model's words, and asks again with the same key after a lost answer", async () => {
		for (const message of [
			"Only a signed hook names the site its secret is typed into",
			"An HMAC hook names the site its secret is typed into",
			"A site is a host name such as github.com",
			"A hook with this name already exists",
		]) {
			const eventHook = vi.fn<CloudCompanyFolderSignedHooks["eventHook"]>(async () =>
				brokerRefusal(message.startsWith("A hook") ? "23505" : "22023", message),
			);
			const f = fixture(noSql, { eventHook });
			await expect(f.client.manageHook(GITHUB, signal())).resolves.toEqual({ refused: message });
			expect(eventHook).toHaveBeenCalledTimes(1);
		}
		const stripe = fixture(noSql, {
			eventHook: async () => brokerRefusal("22023", "A Stripe hook's secret is taken from dashboard.stripe.com"),
		});
		await expect(stripe.client.manageHook(GITHUB, signal())).resolves.toEqual({
			refused: "A Stripe hook's secret is taken from dashboard.stripe.com",
		});
		// A refusal the model has no words for is the database's error.
		const malformed = fixture(noSql, { eventHook: async () => brokerRefusal("22023", "Hook request is invalid") });
		await expect(malformed.client.manageHook(GITHUB, signal())).rejects.toBeInstanceOf(CloudCompanyFolderRpcError);
		// The broker's own failure (its HTTP client throws a plain error) or a timeout loses the answer: the step may
		// have committed, so the same request is asked again, and its receipt answers.
		for (const lost of [
			new Error("Cloud secret broker rejected the event hook call"),
			new CloudRuntimeDiagnosticError("timeout", "Cloud tool authority unavailable"),
		]) {
			let tries = 0;
			const eventHook = vi.fn<CloudCompanyFolderSignedHooks["eventHook"]>(async () => {
				if (++tries === 1) throw lost;
				return signedReceipt(f, GITHUB);
			});
			const f: Fixture = fixture(noSql, { eventHook });
			await expect(f.client.manageHook(GITHUB, signal())).resolves.toMatchObject({ secretSite: "github.com" });
			expect(eventHook.mock.calls.map(([sent]) => sent)).toEqual([
				{ binding: f.binding, request: GITHUB },
				{ binding: f.binding, request: GITHUB },
			]);
		}
		// A lost answer, then the broker refusing the replay: the first try may have opened the hook, now and later.
		let tries = 0;
		const uncertain = fixture(noSql, {
			eventHook: async () => {
				if (++tries === 1) throw new Error("Cloud secret broker returned invalid data");
				return brokerRefusal("23505", "A hook with this name already exists");
			},
		});
		await expect(uncertain.client.manageHook(GITHUB, signal())).rejects.toMatchObject({ failure: "unknown" });
		await expect(uncertain.client.manageHook(GITHUB, signal())).rejects.toMatchObject({ failure: "unknown" });
		await expect(uncertain.client.manageHook({ ...GITHUB, operationKey: "gh-2" }, signal())).resolves.toEqual({
			refused: "A hook with this name already exists",
		});
	});

	it("refuses a signed answer whose site or secret is not this hook's", async () => {
		const live = { name: GITHUB.name, proof: "github", address: ADDRESS, path: PATH };
		for (const answer of [
			(f: Fixture) => receipt(f, "create", hook(f, { ...live, signingSecret: SECRET })),
			(f: Fixture) => ({ ...signedReceipt(f, GITHUB), secretSite: "gitlab.com" }),
			(f: Fixture) => ({ ...receipt(f, "create", hook(f, live)), secretSite: "github.com" }),
			(f: Fixture) => signedReceipt(f, { ...GITHUB, proof: "hmac-sha256" }),
			(f: Fixture) => signedReceipt(f, { ...GITHUB, proof: "address" }),
			...[
				{ ...SECRET, connectorId: "github" },
				{ ...SECRET, secretName: `${SECRET.secretName.slice(0, -1)}2` },
				{ ...SECRET, secretName: "73900000-0000-4000-8000-0000000000a1" },
				{ ...SECRET, ready: false },
				{ ...SECRET, value: "whsec" },
				{ connectorId: "event_hook", secretName: SECRET.secretName },
				SECRET.secretName,
				[SECRET],
			].map((signingSecret) => (f: Fixture) => ({
				...receipt(f, "create", hook(f, { ...live, signingSecret })),
				secretSite: "github.com",
			})),
		]) {
			const f: Fixture = fixture(noSql, { eventHook: async () => answer(f) });
			await expect(f.client.manageHook(GITHUB, signal()), JSON.stringify(answer(f))).rejects.toThrow(
				"Company folder response is invalid",
			);
		}
	});

	it("opens a Stripe hook with no secret yet, and refuses an answer that says it has one (E3c-2)", async () => {
		const STRIPE = {
			...GITHUB,
			name: "stripe-payments",
			proof: "stripe",
			site: "dashboard.stripe.com",
			operationKey: "st-1",
		} as const;
		const opened = (f: Fixture, ready: boolean) => ({
			...receipt(
				f,
				"create",
				hook(f, {
					name: STRIPE.name,
					proof: "stripe",
					signingSecret: { ...SECRET, ready },
					address: ADDRESS,
					path: PATH,
				}),
			),
			secretSite: STRIPE.site,
		});
		const f: Fixture = fixture(noSql, { eventHook: async () => opened(f, false) });
		await expect(f.client.manageHook(STRIPE, signal())).resolves.toMatchObject({
			secretSite: "dashboard.stripe.com",
		});
		const ready: Fixture = fixture(noSql, { eventHook: async () => opened(ready, true) });
		await expect(ready.client.manageHook(STRIPE, signal())).rejects.toThrow("Company folder response is invalid");
	});
});

describe("releases", () => {
	it("records the reads a tool result shows, with their receipts", async () => {
		const file = stagedFile("x");
		const entry = folderEntry("a.md", file);
		const { client, calls } = fixture((method, args) => {
			if (method === "qorpera_folder_read")
				return { schema: "qorpera.folder-read/v1", asOfSeq: 1, found: true, entry };
			return {
				schema: "qorpera.folder-release/v1",
				releaseId: args.p_release_id,
				reads: (args.p_reads as unknown[]).length,
				replay: false,
			};
		});
		const read = await client.read("a.md", signal());
		const releaseId = randomUUID();
		const output = sha("tool result");
		await expect(
			client.release(releaseId, [cloudCompanyFolderRelease(read.entry!)], output, signal()),
		).resolves.toEqual({ releaseId, reads: 1, replay: false });
		expect(calls[1]).toEqual({
			method: "qorpera_folder_record_release",
			args: {
				p_environment_id: expect.any(String),
				p_actor: expect.objectContaining({ kind: "run" }),
				p_release_id: releaseId,
				p_reads: [{ path: "a.md", version: entry.version, authority: RECEIPT, fileSha256: file.fileSha256 }],
				p_output_sha256: output,
			},
		});
	});

	it("retries with the same id, and refuses an answer about other reads", async () => {
		let tries = 0;
		const answers = [{ schema: "qorpera.folder-release/v1", releaseId: randomUUID(), reads: 0, replay: true }];
		const { client, calls } = fixture((_method, args) => {
			if (++tries === 1) throw sqlError("40P01", "deadlock detected");
			return tries === 2
				? { schema: "qorpera.folder-release/v1", releaseId: args.p_release_id, reads: 0, replay: true }
				: answers.shift();
		});
		const releaseId = randomUUID();
		await expect(client.release(releaseId, [], sha("x"), signal())).resolves.toEqual({
			releaseId,
			reads: 0,
			replay: true,
		});
		expect(calls[1]!.args).toEqual(calls[0]!.args);
		await expect(client.release(randomUUID(), [], sha("x"), signal())).rejects.toThrow(
			"Company folder response is invalid",
		);
		await expect(client.release("nope", [], sha("x"), signal())).rejects.toThrow("Invalid Company folder release");
	});

	it("retries an authority change, and checks what it sends and what it hears", async () => {
		const entry = { path: "a.md", version: randomUUID(), authority: RECEIPT, fileSha256: sha("x") };
		let tries = 0;
		const { client, calls } = fixture((_method, args) => {
			if (++tries === 1) throw sqlError("QRC01", "Company folder authority changed");
			return {
				schema: "qorpera.folder-release/v1",
				releaseId: args.p_release_id,
				reads: tries === 2 ? 1 : 2,
				replay: false,
			};
		});
		await expect(client.release(randomUUID(), [entry], sha("out"), signal())).resolves.toMatchObject({ reads: 1 });
		expect(calls).toHaveLength(2);
		// SQL counting other reads than were sent is not this release's answer.
		await expect(client.release(randomUUID(), [entry], sha("out"), signal())).rejects.toThrow(
			"Company folder response is invalid",
		);
		await expect(client.release(randomUUID(), [{ ...entry, fileSha256: "x" }], sha("out"), signal())).rejects.toThrow(
			"Invalid Company folder release",
		);
	});

	it("releases a path the context names without reading a file with no version (a proposal's, P40b)", async () => {
		const { client, calls } = fixture((_method, args) => ({
			schema: "qorpera.folder-release/v1",
			releaseId: args.p_release_id,
			reads: 1,
			replay: false,
		}));
		const named = { path: "docs/a.md", version: null, authority: RECEIPT };
		await expect(client.release(randomUUID(), [named], sha("out"), signal())).resolves.toMatchObject({ reads: 1 });
		expect(calls[0]).toMatchObject({ method: "qorpera_folder_record_release", args: { p_reads: [named] } });
		await expect(client.release(randomUUID(), [{ ...named, version: "v1" }], sha("out"), signal())).rejects.toThrow(
			"Invalid Company folder release",
		);
	});
});

describe("interface change notes (I10)", () => {
	const answer = (noted: unknown) => ({ schema: "qorpera.interface-change-notes/v1", noted });

	it("notes the run's changes as a run effect, asks again after a deadlock, and checks the answer", async () => {
		let tries = 0;
		const { client, calls, binding } = fixture(() => {
			if (++tries === 1) throw sqlError("40P01", "deadlock detected");
			return answer(2);
		});
		await expect(client.noteInterfaceChanges(signal())).resolves.toBe(2);
		// The run's binding and an empty request, as the run effect takes them: no folder actor.
		const call = { method: "qorpera_folder_note_interface_changes", args: { p_binding: binding, p_request: {} } };
		expect(calls).toEqual([call, call]);
		const none = fixture(() => answer(0));
		await expect(none.client.noteInterfaceChanges(signal())).resolves.toBe(0);
		for (const wrong of [
			answer(-1),
			answer(1.5),
			answer("1"),
			answer(null),
			answer(true),
			{ schema: "qorpera.interface-change-notes/v1" },
			{ ...answer(1), extra: 1 },
			{ ...answer(1), schema: "qorpera.interface-change-note/v1" },
		]) {
			const f = fixture(() => wrong);
			await expect(f.client.noteInterfaceChanges(signal()), JSON.stringify(wrong)).rejects.toThrow(
				"Company folder response is invalid",
			);
		}
		// SQL's refusals as folder errors: the run stopped, or it may no longer write.
		const stopped = fixture(() => {
			throw sqlError("55000", "Worker was cancelled");
		});
		await expect(stopped.client.noteInterfaceChanges(signal())).rejects.toMatchObject({ failure: "stopped" });
		const gone = fixture(() => {
			throw sqlError("42501", "Run is unavailable");
		});
		await expect(gone.client.noteInterfaceChanges(signal())).rejects.toMatchObject({ failure: "unavailable" });
	});
});

// Own code storage, step 2b (migration 20260930720000): an agent's undo of a change in the company's code, how its
// request stands, and a change's description. Each is sent with the run's binding, as the run effects are.
describe("the company's code: a change's description (20260930720000)", () => {
	it("describes a change with what was given, and reads what the change then holds or why its picture was not taken", async () => {
		const describe = { operationKey: "describe-12", owner: "acme", name: "shop", change: 12 };
		const saved = (over: Record<string, unknown> = {}) => ({
			schema: "qorpera.code-change-described/v1",
			state: "saved",
			change: 12,
			notice: "Each price now says free returns.",
			picture: null,
			...over,
		});
		const { client, calls, binding } = fixture(() => saved());
		await expect(
			client.describeCodeChange({ ...describe, notice: "Each price now says free returns." }, signal()),
		).resolves.toEqual({ state: "saved", notice: "Each price now says free returns.", picture: false });
		expect(calls).toEqual([
			{
				method: "qorpera_folder_describe_code_change",
				args: { p_binding: binding, p_request: { ...describe, notice: "Each price now says free returns." } },
			},
		]);
		const pictured = fixture(() =>
			saved({
				notice: null,
				picture: { source: "folder", path: "product/screens/price.png", sha256: sha("png"), bytes: 3 },
			}),
		);
		await expect(
			pictured.client.describeCodeChange({ ...describe, picture: "product/screens/price.png" }, signal()),
		).resolves.toEqual({ state: "saved", notice: null, picture: true });
		expect(pictured.calls[0]?.args.p_request).toEqual({ ...describe, picture: "product/screens/price.png" });
		for (const reason of ["missing", "not_a_file", "too_large", "not_a_picture", "not_shared"])
			await expect(
				fixture(() => ({
					schema: "qorpera.code-change-described/v1",
					state: "refused",
					reason,
				})).client.describeCodeChange({ ...describe, picture: "product/screens/price.png" }, signal()),
			).resolves.toEqual({ state: "refused", reason });
		const raised = fixture(() => {
			throw sqlError("P0002", "No such change");
		});
		await expect(raised.client.describeCodeChange({ ...describe, notice: "n" }, signal())).resolves.toEqual({
			state: "refused",
			reason: "no_change",
		});
		for (const wrong of [
			null,
			saved({ schema: "qorpera.code-request/v1" }),
			saved({ change: 13 }),
			saved({ notice: 1 }),
			saved({ picture: "product/screens/price.png" }),
			saved({ picture: ["a"] }),
			saved({ extra: 1 }),
			{ schema: "qorpera.code-change-described/v1", state: "refused", reason: "busy" },
			{ schema: "qorpera.code-change-described/v1", state: "queued", reason: "missing" },
		])
			await expect(
				fixture(() => wrong).client.describeCodeChange({ ...describe, notice: "n" }, signal()),
				JSON.stringify(wrong),
			).rejects.toThrow("Company folder response is invalid");
	});
});

// Own code storage, step 6 (migration 20260930736000): an agent's ask to bring existing code in, and how the import
// stands. Both are sent with the run's binding, as the run effects are, and both answers are read closed.
describe("the company's code: an import and how it stands (20260930736000)", () => {
	const REQUEST = "73600000-0000-4000-8000-000000000001";
	const ask = { operationKey: "bring-shop", owner: "acme", name: "shop", from: { github: "Acme/Shop" }, look: false };
	const queued = { schema: "qorpera.code-import/v1", state: "queued", requestId: REQUEST };
	const look = (over: Record<string, unknown> = {}) => ({
		schema: "qorpera.code-import-look/v1",
		bytes: 1000,
		defaultBranch: "main",
		mainSha: "b".repeat(40),
		commits: 3,
		firstAt: "2026-01-01T00:00:00Z",
		lastAt: "2026-11-01T00:00:00Z",
		authors30d: 1,
		tags: { seen: 2, kept: 1 },
		branches: { seen: 4, kept: 3 },
		leftOut: 1,
		files: 5,
		entries: 7,
		biggest: { path: null, bytes: 900 },
		lfs: { pointers: 0 },
		submodules: 0,
		refused: { code: null, paths: [], more: 0 },
		secrets: {
			found: 1,
			shown: [{ kind: "aws", path: null, inMain: true }],
			scan: { blobs: 9, bytes: 1000, all: true },
		},
		fits: true,
		why: null,
		...over,
	});
	const stands = (over: Record<string, unknown> = {}) => ({
		schema: "qorpera.code-import/v1",
		requestId: REQUEST,
		owner: "acme",
		name: "shop",
		state: "running",
		step: "look",
		waiting: null,
		look: null,
		result: null,
		change: null,
		code: null,
		...over,
	});

	it("asks with the run's binding and exactly the request's keys, and reads each answer", async () => {
		const { client, calls, binding } = fixture(() => queued);
		await expect(client.requestCodeImport(ask, signal())).resolves.toEqual({ state: "queued", requestId: REQUEST });
		expect(calls).toEqual([
			{ method: "qorpera_folder_request_code_import", args: { p_binding: binding, p_request: ask } },
		]);
		// A file with its branch; nothing the caller adds is sent.
		const file = fixture(() => queued);
		await file.client.requestCodeImport(
			{
				...ask,
				from: { file: "code/_incoming/shop/shop.bundle", branch: "release", extra: 1 },
				look: true,
				extra: 1,
			} as never,
			signal(),
		);
		expect(file.calls[0]?.args.p_request).toEqual({
			...ask,
			from: { file: "code/_incoming/shop/shop.bundle", branch: "release" },
			look: true,
		});
		const bare = fixture(() => queued);
		await bare.client.requestCodeImport({ ...ask, from: { file: "code/_incoming/shop/shop.bundle" } }, signal());
		expect(bare.calls[0]?.args.p_request).toEqual({ ...ask, from: { file: "code/_incoming/shop/shop.bundle" } });
		// The import's follow-ups (lead's decision 3): a GitHub project with the branch to bring in as main.
		const branch = fixture(() => queued);
		await branch.client.requestCodeImport(
			{ ...ask, from: { github: "Acme/Shop", branch: "feature/checkout", extra: 1 } as never },
			signal(),
		);
		expect(branch.calls[0]?.args.p_request).toEqual({
			...ask,
			from: { github: "Acme/Shop", branch: "feature/checkout" },
		});
		for (const reason of [
			"kept_here",
			"already_here",
			"busy",
			"sessions_open",
			"no_executor",
			"file_missing",
			"deleting",
		])
			await expect(
				fixture(() => ({ schema: "qorpera.code-import/v1", state: "refused", reason })).client.requestCodeImport(
					ask,
					signal(),
				),
			).resolves.toEqual({ state: "refused", reason });
		// The design's two dropped reasons, an undo's, and every other shape are not answers.
		for (const wrong of [
			null,
			{ ...queued, schema: "qorpera.code-request/v1" },
			{ ...queued, requestId: "not-a-uuid" },
			{ ...queued, extra: 1 },
			{ schema: "qorpera.code-import/v1", state: "queued" },
			{ schema: "qorpera.code-import/v1", state: "refused", reason: "no_grant" },
			{ schema: "qorpera.code-import/v1", state: "refused", reason: "file_too_large" },
			{ schema: "qorpera.code-import/v1", state: "refused", reason: "wall" },
			{ schema: "qorpera.code-import/v1", state: "done", reason: "busy" },
		])
			await expect(
				fixture(() => wrong).client.requestCodeImport(ask, signal()),
				JSON.stringify(wrong),
			).rejects.toThrow("Company folder response is invalid");
		// What SQL raised instead of taking it is a refusal, asked once; a lost answer is asked again with the same key.
		const raised = fixture(() => {
			throw new CloudCompanyFolderRpcError("22023", "Code request is invalid");
		});
		await expect(raised.client.requestCodeImport(ask, signal())).resolves.toEqual({
			state: "refused",
			reason: "invalid",
		});
		expect(raised.calls).toHaveLength(1);
		let tries = 0;
		const again = fixture(() => {
			if (++tries === 1)
				throw new CloudRuntimeDiagnosticError("transport_unavailable", "Company File authority unavailable");
			return queued;
		});
		await expect(again.client.requestCodeImport(ask, signal())).resolves.toEqual({
			state: "queued",
			requestId: REQUEST,
		});
		expect(again.calls.map((call) => call.args.p_request)).toEqual([ask, ask]);
	});

	it("reads how an import stands, with the run's binding and no receipt, and its look key by key", async () => {
		const { client, calls, binding } = fixture(() => stands());
		await expect(client.codeImport(REQUEST, signal())).resolves.toEqual({
			requestId: REQUEST,
			owner: "acme",
			name: "shop",
			state: "running",
			step: "look",
			waiting: null,
			look: null,
			result: null,
			change: null,
			code: null,
		});
		expect(calls).toEqual([
			{ method: "qorpera_folder_code_import", args: { p_binding: binding, p_request_id: REQUEST } },
		]);
		const { schema: _schema, ...read } = look();
		await expect(
			fixture(() =>
				stands({ state: "done", step: "open", look: look(), result: "imported", change: 1 }),
			).client.codeImport(REQUEST, signal()),
		).resolves.toMatchObject({ state: "done", result: "imported", change: 1, look: read });
		await expect(
			fixture(() => stands({ state: "queued", step: null, waiting: "SESSIONS_OPEN" })).client.codeImport(
				REQUEST,
				signal(),
			),
		).resolves.toMatchObject({ state: "queued", step: null, waiting: "SESSIONS_OPEN" });
		await expect(
			fixture(() =>
				stands({
					state: "refused",
					code: "IMPORT_USES_LFS",
					look: look({
						fits: false,
						refused: { code: "IMPORT_USES_LFS", paths: ["a.gitattributes", null], more: 4 },
						why: "IMPORT_USES_LFS",
					}),
				}),
			).client.codeImport(REQUEST, signal()),
		).resolves.toMatchObject({
			state: "refused",
			code: "IMPORT_USES_LFS",
			look: { fits: false, refused: { code: "IMPORT_USES_LFS", paths: ["a.gitattributes", null], more: 4 } },
		});
		// A commit time out of git's range is null.
		await expect(
			fixture(() => stands({ look: look({ firstAt: null, lastAt: null }) })).client.codeImport(REQUEST, signal()),
		).resolves.toMatchObject({ look: { firstAt: null, lastAt: null } });
		await expect(
			fixture(() => stands({ state: "failed", code: "DID_NOT_FINISH" })).client.codeImport(REQUEST, signal()),
		).resolves.toMatchObject({ state: "failed", code: "DID_NOT_FINISH" });
		const hit = { kind: "aws", path: null, inMain: true };
		for (const wrong of [
			null,
			stands({ schema: "qorpera.code-request/v1" }),
			stands({ requestId: randomUUID() }),
			stands({ owner: 1 }),
			stands({ state: "expired" }),
			stands({ step: "push" }),
			// The import's follow-ups, item 7: C1 has no tidy step and refuses a progress that names one.
			stands({ step: "tidy" }),
			stands({ waiting: "sessions busy" }),
			stands({ waiting: 5 }),
			stands({ result: "imported" }),
			stands({ state: "done", result: null }),
			stands({ state: "done", result: "undone" }),
			stands({ change: 0 }),
			stands({ code: 5 }),
			stands({ extra: 1 }),
			(({ code: _code, ...rest }) => rest)(stands()),
			stands({ look: look({ schema: "qorpera.code-import-look/v2" }) }),
			stands({ look: look({ extra: 1 }) }),
			stands({ look: (({ why: _why, ...rest }) => rest)(look()) }),
			stands({ look: look({ bytes: -1 }) }),
			stands({ look: look({ commits: null }) }),
			stands({ look: look({ mainSha: "b".repeat(39) }) }),
			stands({ look: look({ firstAt: "yesterday" }) }),
			stands({ look: look({ lastAt: "2026-11-01T00:00:00.000Z" }) }),
			stands({ look: look({ fits: false }) }),
			stands({ look: look({ why: "IMPORT_USES_LFS" }) }),
			stands({ look: look({ refused: { code: "IMPORT_USES_LFS", paths: [], more: 0 } }) }),
			stands({ look: look({ refused: { code: null, paths: [] } }) }),
			stands({ look: look({ refused: { code: null, paths: [7], more: 0 } }) }),
			stands({ look: look({ tags: { seen: 1 } }) }),
			stands({ look: look({ biggest: { path: 7, bytes: 1 } }) }),
			stands({ look: look({ refused: { code: "LFS", paths: [], more: 0 }, fits: false, why: "LFS" }) }),
			stands({ look: look({ refused: { code: null, paths: Array.from({ length: 11 }, () => "a"), more: 0 } }) }),
			stands({ look: look({ why: "too big" }) }),
			stands({ look: look({ fits: "yes" }) }),
			stands({
				look: look({ secrets: { found: 1, shown: [{ ...hit, kind: "AWS key" }], scan: look().secrets.scan } }),
			}),
			stands({ look: look({ secrets: { found: 1, shown: [{ ...hit, kind: "env" }], scan: look().secrets.scan } }) }),
			stands({ look: look({ secrets: { found: 1, shown: [{ ...hit, inMain: 1 }], scan: look().secrets.scan } }) }),
			stands({ look: look({ secrets: { found: 1, shown: [{ ...hit, value: "x" }], scan: look().secrets.scan } }) }),
			stands({
				look: look({
					secrets: { found: 31, shown: Array.from({ length: 31 }, () => hit), scan: look().secrets.scan },
				}),
			}),
			stands({ look: look({ secrets: { found: 1, shown: [hit], scan: { blobs: 1, bytes: 1, all: 1 } } }) }),
		])
			await expect(fixture(() => wrong).client.codeImport(REQUEST, signal()), JSON.stringify(wrong)).rejects.toThrow(
				"Company folder response is invalid",
			);
		// Another company's request is SQL's answer, and a read is asked once.
		const none = fixture(() => {
			throw new CloudCompanyFolderRpcError("P0002", "No such code import");
		});
		await expect(none.client.codeImport(REQUEST, signal())).rejects.toBeInstanceOf(CloudCompanyFolderRpcError);
		expect(none.calls).toHaveLength(1);
		await expect(fixture(() => stands()).client.codeImport("not-a-uuid", signal())).rejects.toThrow(
			"Company folder response is invalid",
		);
	});

	// The import's follow-ups (20260930741000; STEP6-BUILD.md "The shapes, exactly"): the look's lines and the read's
	// twelfth key file. Both are optional, since this runtime goes live before the SQL and executors that send them, and
	// both are read closed when sent.
	it("reads the look's other lines of work and the bundle left behind, each only when sent", async () => {
		const VERSION = "74100000-0000-4000-8000-00000000000b";
		const line = (over: Record<string, unknown> = {}) => ({
			name: "feature/checkout",
			ahead: 2,
			behind: 7,
			lastAt: "2026-11-09T08:00:00Z",
			fits: true,
			...over,
		});
		const lines = (over: Record<string, unknown> = {}) => ({
			count: 2,
			changes: 3,
			shown: [line(), line({ name: null, ahead: 3, behind: 0, lastAt: null, fits: null })],
			...over,
		});
		const read = async (answer: Record<string, unknown>) =>
			fixture(() => answer).client.codeImport(REQUEST, signal());
		// Today's answer: eleven keys, no lines; the result has neither key.
		const today = await read(stands({ state: "done", step: "open", look: look(), result: "imported", change: 1 }));
		expect(Object.keys(today).sort()).toEqual(
			["requestId", "owner", "name", "state", "step", "waiting", "look", "result", "change", "code"].sort(),
		);
		expect(Object.hasOwn(today.look ?? {}, "lines")).toBe(false);
		// Sent: read as sent.
		await expect(read(stands({ look: look({ lines: lines() }) }))).resolves.toMatchObject({
			look: { lines: lines() },
		});
		await expect(read(stands({ look: look({ lines: { count: 0, changes: 0, shown: [] } }) }))).resolves.toMatchObject(
			{
				look: { lines: { count: 0, changes: 0, shown: [] } },
			},
		);
		// At the bounds: as many as were kept, ten shown, a branch with every change.
		const ten = Array.from({ length: 10 }, (_, n) => line({ name: `b${n}`, ahead: n === 0 ? 3 : 1 }));
		await expect(
			read(stands({ look: look({ lines: { count: 3, changes: 3, shown: ten.slice(0, 3) } }) })),
		).resolves.toMatchObject({ look: { lines: { count: 3 } } });
		await expect(
			read(
				stands({ look: look({ branches: { seen: 20, kept: 12 }, lines: { count: 12, changes: 3, shown: ten } }) }),
			),
		).resolves.toMatchObject({ look: { lines: { count: 12, shown: ten } } });
		for (const file of [
			null,
			{ path: "code/_incoming/shop/shop.bundle", version: VERSION },
			{ path: "x.bundle", version: null },
		])
			await expect(read(stands({ file }))).resolves.toMatchObject({ file });
		for (const lines_ of [
			null,
			[],
			lines({ extra: 1 }),
			(({ shown: _shown, ...rest }) => rest)(lines()),
			lines({ count: 4 }),
			lines({ count: -1 }),
			lines({ count: 2, changes: 0 }),
			lines({ count: 0, changes: 1, shown: [] }),
			lines({ count: 1 }),
			lines({ shown: "none" }),
			lines({ shown: [line({ extra: 1 })] }),
			lines({ shown: [(({ fits: _fits, ...rest }) => rest)(line())] }),
			lines({ shown: [line({ name: 7 })] }),
			lines({ shown: [line({ ahead: 0 })] }),
			lines({ shown: [line({ ahead: 4 })] }),
			lines({ shown: [line({ ahead: 1.5 })] }),
			lines({ shown: [line({ behind: -1 })] }),
			lines({ shown: [line({ behind: null })] }),
			lines({ shown: [line({ lastAt: "2026-11-09T08:00:00.000Z" })] }),
			lines({ shown: [line({ lastAt: "yesterday" })] }),
			lines({ shown: [line({ fits: "yes" })] }),
			lines({ shown: [line({ fits: 0 })] }),
		])
			await expect(read(stands({ look: look({ lines: lines_ }) })), JSON.stringify(lines_)).rejects.toThrow(
				"Company folder response is invalid",
			);
		// More shown than ten, though more were kept.
		await expect(
			read(
				stands({
					look: look({
						branches: { seen: 20, kept: 12 },
						lines: { count: 12, changes: 3, shown: [...ten, line({ ahead: 1 })] },
					}),
				}),
			),
		).rejects.toThrow("Company folder response is invalid");
		// The folder's version is a UUID: what company_read reports and company_delete takes.
		for (const file of [
			"code/_incoming/shop/shop.bundle",
			{ path: "code/_incoming/shop/shop.bundle" },
			{ version: VERSION },
			{ path: "code/_incoming/shop/shop.bundle", version: VERSION, sha256: "a".repeat(64) },
			{ path: "", version: VERSION },
			{ path: 7, version: VERSION },
			{ path: "code/_incoming/shop/shop.bundle", version: 3 },
			{ path: "code/_incoming/shop/shop.bundle", version: "3" },
			{ path: "code/_incoming/shop/shop.bundle", version: VERSION.toUpperCase() },
		])
			await expect(read(stands({ file })), JSON.stringify(file)).rejects.toThrow(
				"Company folder response is invalid",
			);
	});

	// The cross-check of the merged parts: the looks the coding executor writes (runner-orchestrator's codeImportLook,
	// pinned there against these same literals), which SQL test 1235 section 2b takes, are read as they were written.
	it("reads every look the executor writes, as the kernel keeps it", async () => {
		const sql = readFileSync(
			new URL("../../../supabase/tests/1235_code_import_follow_ups.test.sql", import.meta.url),
			"utf8",
		);
		const section = sql.slice(
			sql.indexOf("-- BEGIN THE LOOKS PART B WRITES\n"),
			sql.indexOf("-- END THE LOOKS PART B WRITES\n"),
		);
		const looks = [...section.matchAll(/^\t'(\{.*\})',?$/gm)].map(
			(match) => JSON.parse((match[1] as string).replaceAll("''", "'")) as Record<string, unknown>,
		);
		expect(looks).toHaveLength(5);
		for (const sent of looks) {
			const read = await fixture(() =>
				stands({ state: "done", step: "open", look: sent, result: "imported", change: 1 }),
			).client.codeImport(REQUEST, signal());
			if (Object.hasOwn(sent, "lines")) expect(read.look?.lines, JSON.stringify(sent.lines)).toEqual(sent.lines);
			else expect(Object.hasOwn(read.look ?? {}, "lines")).toBe(false);
			expect(read.look?.branches).toEqual(sent.branches);
		}
	});

	it("stages distinct files concurrently up to the cap, serializes same-hash variants, and aborts siblings with typed errors", async () => {
		const { client, bytes } = fixture(() => ({}));
		let inFlight = 0;
		let peak = 0;
		const hashInFlight = new Map<string, number>();
		let sameHashPeak = 0;
		vi.mocked(bytes.put).mockImplementation(async (data, mediaType) => {
			const digest = sha(data);
			const nextHash = (hashInFlight.get(digest) ?? 0) + 1;
			hashInFlight.set(digest, nextHash);
			sameHashPeak = Math.max(sameHashPeak, nextHash);
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 15));
			inFlight--;
			hashInFlight.set(digest, (hashInFlight.get(digest) ?? 1) - 1);
			return {
				manifestSha256: sha(`manifest:${digest}:${mediaType}`),
				fileSha256: digest,
				bytes: data.byteLength,
				mediaType,
			};
		});
		const units = [
			...Array.from({ length: 10 }, (_, i) => ({
				op: "write" as const,
				path: `batch/file-${i}.txt`,
				content: { text: `content-${i}` },
			})),
			{
				op: "new_folder" as const,
				path: "batch/sub",
				contents: [
					{ path: "dup.txt", kind: "file" as const, content: { text: "content-0" } },
					{
						path: "same-bytes-exec.sh",
						kind: "file" as const,
						content: {
							bytes: new TextEncoder().encode("content-0"),
							mediaType: "text/x-shellscript",
							executable: true,
						},
					},
					{ path: "extra.txt", kind: "file" as const, content: { text: "extra-content" } },
				],
			},
		];
		const staged = await client.stage(units, signal());
		expect(staged.unitCount).toBe(11);
		expect(bytes.put).toHaveBeenCalledTimes(12);
		expect(peak).toBe(4);
		expect(sameHashPeak).toBe(1);
		let abortedSiblings = 0;
		vi.mocked(bytes.put).mockImplementation(async (data, mediaType, _exec, putSignal) => {
			const text = new TextDecoder().decode(data);
			if (text === "fail-me") {
				await new Promise((resolve) => setTimeout(resolve, 15));
				throw new CloudCompanyFolderError("full");
			}
			return await new Promise<CloudFileReference>((resolve, reject) => {
				const timer = setTimeout(() => {
					resolve({
						manifestSha256: sha(`manifest:${sha(data)}`),
						fileSha256: sha(data),
						bytes: data.byteLength,
						mediaType,
					});
				}, 500);
				putSignal.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						abortedSiblings++;
						reject(putSignal.reason ?? new Error("aborted"));
					},
					{ once: true },
				);
			});
		});
		await expect(
			client.stage(
				[
					{ op: "write", path: "a.txt", content: { text: "slow-1" } },
					{ op: "write", path: "b.txt", content: { text: "fail-me" } },
					{ op: "write", path: "c.txt", content: { text: "slow-2" } },
				],
				signal(),
			),
		).rejects.toMatchObject({ failure: "full", category: "budget_exhausted" });
		expect(abortedSiblings).toBe(2);
	});
});
