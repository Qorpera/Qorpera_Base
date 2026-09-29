import { createHash, randomUUID } from "node:crypto";
import { COMPANY_STATE_PARSER_VERSION, parseCompanyStateFile } from "@qorpera/cloud-client/company-state-files";
import type { CloudFileReference } from "@qorpera/cloud-client/node/cloud-object-store";
import {
	type CloudCompanyFolderBytes,
	CloudCompanyFolderClient,
	CloudCompanyFolderError,
	type CloudCompanyFolderFile,
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

function fixture(handle: (method: CloudCompanyPathRpc, args: Record<string, unknown>) => unknown) {
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
	};
	const calls: { method: CloudCompanyPathRpc; args: Record<string, unknown> }[] = [];
	const control: CloudCompanyPathControl = {
		call: vi.fn(async (method, args) => {
			calls.push({ method, args: structuredClone(args) });
			return handle(method, args);
		}),
	};
	const client = new CloudCompanyFolderClient({ binding, identity: authority.identity, control, bytes });
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
		const bytes: CloudCompanyFolderBytes = { put: vi.fn(), get: vi.fn() };
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
			{ schema: "qorpera.folder-read/v1", asOfSeq: 9, found: true, entry: folderEntry("other.md", file) },
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
		// An unknown key, another path's entry, a bad size and a half receipt are not answers.
		for (let i = 0; i < 4; i++)
			await expect(client.read(i === 2 ? "notes/a.md" : "notes", signal())).rejects.toThrow(
				"Company folder response is invalid",
			);
	});

	it("reads a file's text, checked against its entry", async () => {
		const text = "Første linje\n";
		const file = stagedFile(text);
		const entries: Record<string, unknown> = {
			"a.md": folderEntry("a.md", file),
			"big.md": folderEntry("big.md", { ...file, bytes: 10_000 }),
			folder: folderEntry("folder"),
			"binary.bin": folderEntry("binary.bin", stagedFile("\u0000", "application/octet-stream")),
		};
		const { client, stored } = fixture((_method, args) => {
			const entry = entries[args.p_path as string];
			return { schema: "qorpera.folder-read/v1", asOfSeq: 2, found: !!entry, entry: entry ?? null };
		});
		stored.set(file.fileSha256, new TextEncoder().encode(text));
		await expect(client.readText("a.md", 1024, signal())).resolves.toMatchObject({ text, entry: { path: "a.md" } });
		await expect(client.readText("missing.md", 1024, signal())).resolves.toBeNull();
		await expect(client.readText("folder", 1024, signal())).rejects.toBeInstanceOf(CloudCompanyPathNotText);
		await expect(client.readText("big.md", 1024, signal())).rejects.toBeInstanceOf(CloudCompanyPathNotText);
		// Bytes that are not the entry's are refused, whatever they say.
		stored.set(sha("\u0000"), Uint8Array.of(0xff));
		await expect(client.readText("binary.bin", 1024, signal())).rejects.toThrow("do not match their entry");
		stored.set(sha("\u0000"), Uint8Array.of(0));
		await expect(client.readText("binary.bin", 1024, signal())).resolves.toMatchObject({ text: "\u0000" });
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
		const all = await client.listAll("t", { recursive: true }, signal());
		expect(all.asOfSeq).toBe(5);
		expect(all.entries.map((entry) => entry.path)).toEqual([...first, "t/200"]);
		expect(
			calls.map((call) => [call.args.p_parent, call.args.p_after, call.args.p_limit, call.args.p_recursive]),
		).toEqual([
			["t", null, 200, true],
			["t", "t/199", 200, true],
		]);
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
					path: "agents/nora",
					contents: [
						{ path: "agent.md", kind: "file", content: { text: AGENT_TEXT } },
						{ path: "memory", kind: "folder" },
					],
				},
				{ op: "write", path: "agents/otto/agent.md", content: { text: refused } },
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
		const parse = parseCompanyStateFile("agents/nora/agent.md", AGENT_TEXT);
		const problems = parseCompanyStateFile("agents/otto/agent.md", refused);
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
					path: "agents/nora",
					contents: [
						{ path: "agent.md", kind: "file", file: stagedFile(AGENT_TEXT) },
						{ path: "memory", kind: "folder" },
					],
					structured: [
						{
							path: "agents/nora/agent.md",
							kind: "agent",
							text: AGENT_TEXT,
							parse: parse?.ok ? JSON.parse(JSON.stringify(parse.file)) : null,
							parserVersion: COMPANY_STATE_PARSER_VERSION,
						},
					],
				},
				{
					op: "write",
					path: "agents/otto/agent.md",
					file: stagedFile(refused),
					structured: [
						{
							path: "agents/otto/agent.md",
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
					path: "agents/x/agent.md",
					outcome: "refused",
					reason: "structured_invalid",
					problems: [problem],
				},
				{ unit: 3, op: "delete", path: "b", outcome: "waiting_for_review", reason: "waiting_for_review" },
			],
		}));
		const result = await client.commit(
			"tool-call-2",
			[
				{ op: "write", path: "a.md", content: { text: "x" }, expectedVersion: randomUUID() },
				{ op: "write", path: "agents/x/agent.md", content: { text: AGENT_TEXT } },
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
				path: "agents/x/agent.md",
				to: null,
				version: null,
				outcome: "refused",
				reason: "structured_invalid",
				problems: [problem],
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
		];
		const { client } = fixture(() => answers.shift());
		for (let i = 0; i < 5; i++)
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
		expect(calls).toEqual([]);
		expect(bytes.put).not.toHaveBeenCalled();
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

	it("refuses bytes stored differently from what it sent", async () => {
		const { client, bytes } = fixture(() => null);
		vi.mocked(bytes.put).mockResolvedValueOnce({
			manifestSha256: sha("m"),
			fileSha256: sha("other"),
			bytes: 1,
			mediaType: "text/markdown",
		});
		await expect(
			client.commit("tool-call-7", [{ op: "write", path: "a.md", content: { text: "x" } }], {}, signal()),
		).rejects.toThrow("stored differently");
	});

	it.each(["QRC01", "40P01", "23505"])("retries %s with the same key and the same units", async (code) => {
		let tries = 0;
		const { client, calls, bytes } = fixture(() => {
			if (++tries < 3) throw sqlError(code, "retry me");
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

	it("passes transport failures through unchanged", async () => {
		const transport = new CloudRuntimeDiagnosticError("transport_unavailable", "Company File authority unavailable");
		const { client } = fixture(() => {
			throw transport;
		});
		await expect(client.commit("tool-call-12", [{ op: "mkdir", path: "a" }], {}, signal())).rejects.toBe(transport);
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
});
