import { createHash, randomUUID } from "node:crypto";
import { parseCloudCompanyPath } from "@qorpera/cloud-client/company-path-schema";
import type { CloudCompanyTreeEntry } from "@qorpera/cloud-client/node/cloud-company-snapshot";
import { CloudContentAddressedStore, type CloudObjectTransport } from "@qorpera/cloud-client/node/cloud-object-store";
import {
	type CloudCompanyPathControl,
	CloudCompanyPathGateway,
	CloudCompanyPathNotText,
	type CloudCompanyPathRpc,
} from "@qorpera/runtime/cloud-company-path-gateway";
import {
	CloudCompanyPathParentMissing,
	CloudCompanyPathRpcMissing,
	CloudCompanyPathRpcPrecondition,
	CloudCompanyPathVersionChanged,
} from "@qorpera/runtime/cloud-company-path-refusal";
import type { CloudNativeFenceRequest } from "@qorpera/runtime/cloud-native-result-fence";
import { CLOUD_NATIVE_TOOL_AUTHORITY_SCHEMA } from "@qorpera/runtime/cloud-native-tool-authority";
import { type CloudNativeTool, CloudNativeToolBoundary } from "@qorpera/runtime/cloud-native-tool-boundary";
import { describe, expect, it, vi } from "vitest";
import { companyFilePostgrest } from "./fixtures/company-file-postgrest.ts";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

/** Stands for the folder core's company_read (cloud-folder-file-tools): its text, cited by the
 * release it recorded (qorpera_folder_record_release). Tests seed the release into `released`. */
function releasedRead(text: string, readId: string = randomUUID()): CloudNativeTool {
	return {
		name: "company_read",
		source: "company_file",
		description: "Read a Company File window the folder core released.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["path"],
			properties: { path: { type: "string" } },
		},
		parseArguments: (value) => value,
		execute: async () => ({ kind: "text", value: text, companyReadId: readId }),
	};
}

/** A Company File tool outside a mutation that fails with `error`. */
function failingRead(error: Error): CloudNativeTool {
	return {
		...releasedRead(""),
		execute: async () => {
			throw error;
		},
	};
}

/** Only wire/storage orchestration is simulated here. SQL 290 exercises the
 * actual membership, native lease, path policy and transaction boundaries. */
function fixture(tools: readonly CloudNativeTool[] = []) {
	const { binding, authority } = nativeToolAuthorityFixture();
	const identity = authority.identity;
	const objects = new Map<string, Uint8Array>();
	const entries = new Map<string, CloudCompanyTreeEntry>();
	const versions = new Map<string, string>();
	/** What the folder core recorded as released: read id to the hash of the text it released. */
	const released = new Map<string, string>();
	const snapshotId = randomUUID();
	const transport: CloudObjectTransport = {
		put: vi.fn(async (path: string, bytes: Uint8Array) => {
			if (objects.has(path)) return "exists";
			objects.set(path, Uint8Array.from(bytes));
			return "stored";
		}),
		get: vi.fn(async (path: string) => {
			const bytes = objects.get(path);
			if (!bytes) throw new Error("Missing fixture object");
			return bytes;
		}),
	};
	const store = new CloudContentAddressedStore(transport);
	const overrides = new Map<CloudCompanyPathRpc, (args: Record<string, unknown>) => Promise<unknown>>();
	const defaultCall = async (method: CloudCompanyPathRpc, args: Record<string, unknown>): Promise<unknown> => {
		expect(args.p_binding).toEqual(binding);
		expect(args.p_environment_id).toBe(identity.environmentId);
		if (method === "qorpera_read_company_path") {
			const path = args.p_path as string;
			const entry = entries.get(path) ?? null;
			return {
				path,
				version: versions.get(path) ?? null,
				entry,
				manifestBytes:
					entry?.kind === "file"
						? objects.get(`${identity.companyId}/${entry.file.manifestSha256}`)?.length
						: null,
				companyId: identity.companyId,
			};
		}
		if (method === "qorpera_assert_company_path_reads") return null;
		if (method === "qorpera_record_native_context_view") {
			const view = args.p_view as {
				requestId: string;
				outputs: Array<{ readId: string | null; readSha256: string | null }>;
			};
			for (const output of view.outputs)
				if (output.readId && released.get(output.readId) !== output.readSha256)
					throw new Error("Read evidence differs");
			return {
				schema: "qorpera.native-context-view-receipt/v1",
				viewId: randomUUID(),
				requestId: view.requestId,
				sha256: "c".repeat(64),
				ordinal: 1,
			};
		}
		if (method === "qorpera_list_company_paths")
			return {
				snapshotId,
				items: [...entries.values()]
					.filter((entry) => entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))) === args.p_path)
					.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
					.map((entry) => ({
						path: entry.path,
						version: versions.get(entry.path),
						kind: entry.kind,
						bytes: entry.kind === "file" ? entry.file.bytes : null,
					})),
				hasMore: false,
				nextAfter: null,
			};
		throw new Error("Unexpected fixture RPC");
	};
	const call = vi.fn(async (method: CloudCompanyPathRpc, args: Record<string, unknown>, signal: AbortSignal) => {
		signal.throwIfAborted();
		return overrides.has(method) ? overrides.get(method)!(args) : defaultCall(method, args);
	});
	const control: CloudCompanyPathControl = { call };
	const gateway = new CloudCompanyPathGateway({ binding, identity, control, store });
	const signal = new AbortController().signal;
	const boundary = new CloudNativeToolBoundary({
		companyId: identity.companyId,
		runId: identity.runId,
		identity,
		tools: [...tools],
		assertActive: (signal) => gateway.assertReadableContext(signal),
		signal,
	});
	return {
		binding,
		identity,
		objects,
		entries,
		versions,
		released,
		transport,
		store,
		call,
		overrides,
		defaultCall,
		gateway,
		boundary,
		signal,
		async seed(path: string, text: string) {
			const file = await store.putFile(identity.companyId, Buffer.from(text), "application/octet-stream");
			entries.set(path, { kind: "file", path, executable: false, file });
			versions.set(path, randomUUID());
			vi.mocked(transport.put).mockClear();
			vi.mocked(transport.get).mockClear();
			return file;
		},
	};
}

describe("cloud Company File path gateway", () => {
	it("does not infer a missing folder from a refusal outside a mutation", async () => {
		const f = fixture([failingRead(new CloudCompanyPathParentMissing())]);
		// Even the gateway's own brand, thrown by a tool that is not a mutation, proves nothing about a folder.
		const read = await f.boundary.invoke("read_orphan", "qorpera", "company_read", { path: "a/b.txt" });
		expect(JSON.parse(read.contentItems[0].text)).toMatchObject({
			status: "unconfirmed",
			content: { text: "TOOL_OUTCOME_UNCONFIRMED" },
		});
	});
	it("pages the trusted listing to its end and starts again, a bounded number of times, when the company moves on", async () => {
		const db = companyFilePostgrest();
		for (let index = 0; index < 150; index++) await db.seed(`notebook/${String(index).padStart(3, "0")}.md`, "x\n");
		const listed = await db.gateway.listTrusted("notebook", new AbortController().signal);
		expect(listed.map((item) => item.path)).toEqual(
			Array.from({ length: 150 }, (_, index) => `notebook/${String(index).padStart(3, "0")}.md`),
		);
		// A company that writes between every two pages: the listing gives up rather than return a mixed view.
		db.before.hook = (method, args) => {
			if (method === "qorpera_list_company_paths" && args.p_after !== null) db.moveHead();
		};
		db.requests.length = 0;
		await expect(db.gateway.listTrusted("notebook", new AbortController().signal)).rejects.toBeInstanceOf(
			CloudCompanyPathRpcPrecondition,
		);
		expect(
			db.requests.filter((request) => request.method === "qorpera_list_company_paths").map((r) => r.status),
		).toEqual([200, 412, 200, 412, 200, 412, 200, 412]);
	});
	it("tells text that is not UTF-8 apart from bytes that do not match their digest", async () => {
		const db = companyFilePostgrest();
		await db.seedBytes("notes/binary.md", Buffer.from([0xff, 0xfe, 0x00]));
		await expect(db.gateway.readTrusted("notes/binary.md", new AbortController().signal)).rejects.toBeInstanceOf(
			CloudCompanyPathNotText,
		);
		// A verified manifest whose chunks are not the file it names is an integrity failure, never "not text".
		const chunk = await db.store.putObject(
			db.identity.companyId,
			Buffer.from([0xff, 0xfe]),
			"application/octet-stream",
		);
		const claimed = createHash("sha256").update("ok").digest("hex");
		const manifest = Buffer.from(
			JSON.stringify({
				schema: "qorpera.cloud-file-manifest/v1",
				fileSha256: claimed,
				bytes: 2,
				mediaType: "application/octet-stream",
				chunks: [{ sha256: chunk.sha256, bytes: 2 }],
			}),
		);
		const stored = await db.store.putObject(
			db.identity.companyId,
			manifest,
			"application/vnd.qorpera.file-manifest+json",
		);
		db.directory("notes");
		db.entries.set("notes/forged.md", {
			version: randomUUID(),
			entry: {
				kind: "file",
				path: "notes/forged.md",
				executable: false,
				file: {
					manifestSha256: stored.sha256,
					fileSha256: claimed,
					bytes: 2,
					mediaType: "application/octet-stream",
				},
			},
		});
		const forged = await db.gateway.readTrusted("notes/forged.md", new AbortController().signal).catch((e) => e);
		expect(forged).toBeInstanceOf(Error);
		expect(forged).not.toBeInstanceOf(CloudCompanyPathNotText);
		expect(String(forged)).toContain("does not match its digest");
	});
	it("refuses a trusted listing page that claims more without a cursor", async () => {
		const f = fixture();
		f.overrides.set("qorpera_list_company_paths", async () => ({
			snapshotId: randomUUID(),
			items: [],
			hasMore: true,
			nextAfter: null,
		}));
		await expect(f.gateway.listTrusted("notebook", f.signal)).rejects.toThrow("Invalid Company File page cursor");
	});
	it("does not infer a version change from a precondition outside a mutation", async () => {
		const f = fixture([failingRead(new CloudCompanyPathVersionChanged())]);
		// A read that finds the file moved is a precondition, but not a write's version check:
		// even the gateway's own brand, thrown by a tool that is not a mutation, is no version change.
		const read = await f.boundary.invoke("read_moved", "qorpera", "company_read", { path: "b.txt" });
		expect(JSON.parse(read.contentItems[0].text)).toMatchObject({
			status: "unconfirmed",
			content: { text: "TOOL_OUTCOME_UNCONFIRMED" },
		});
	});

	/** The one call as the database answers it: it reports the sent paths its read set keeps. */
	function keptFence(f: ReturnType<typeof fixture>) {
		const authority = { schema: CLOUD_NATIVE_TOOL_AUTHORITY_SCHEMA, validForMs: 30_000, identity: f.identity };
		const fence = vi.fn(async (args: Record<string, unknown>) => ({
			schema: "qorpera.native-context-fence/v1",
			authority,
			receipt: await f.defaultCall("qorpera_record_native_context_view", args),
			kept: args.p_paths,
		}));
		f.overrides.set("qorpera_fence_native_context", fence);
		const frame = (requestId: string): CloudNativeFenceRequest => ({
			schema: "qorpera.native-result-fence/v1",
			requestId,
			threadId: "thread-1",
			turnId: "turn-1",
			purpose: "turn",
			outputs: [],
		});
		const sent = () =>
			f.call.mock.calls
				.filter(
					([method]) =>
						method === "qorpera_assert_company_path_reads" || method === "qorpera_fence_native_context",
				)
				.map(([method, args]) => [method === "qorpera_fence_native_context" ? "fence" : "check", args.p_paths]);
		return { authority, fence, frame, sent };
	}

	it("names no path to the one call or the separate check, and takes no kept path it did not send", async () => {
		// A folder-v2 run's reads are the folder core's: their releases travel in the view, never as paths.
		const readId = randomUUID();
		const f = fixture([releasedRead("A", readId)]);
		const digest = createHash("sha256").update("A").digest("hex");
		f.released.set(readId, digest);
		const { fence, frame, sent } = keptFence(f);
		const response = await f.boundary.invoke("read-a", "qorpera", "company_read", { path: "a.md" });
		const outputs = await f.boundary.fenceNativeResults([
			{ kind: "function_call_output", callId: "read-a", output: response.contentItems[0].text },
		]);
		await f.gateway.fenceContextView(frame("request-1"), outputs, f.signal);
		expect((fence.mock.calls[0][0].p_view as { outputs: unknown[] }).outputs).toEqual([
			expect.objectContaining({ callId: "read-a", readId, readSha256: digest }),
		]);
		// A call that fails (or times out) confirmed nothing, and the next one is the same.
		f.overrides.set("qorpera_fence_native_context", async () => {
			throw new Error("PRIVATE_TIMEOUT");
		});
		await expect(f.gateway.fenceContextView(frame("request-2"), [], f.signal)).rejects.toThrow();
		f.overrides.set("qorpera_fence_native_context", fence);
		await f.gateway.fenceContextView(frame("request-3"), [], f.signal);
		await f.gateway.assertReadableContext(f.signal);
		// The call's own two checks, the release's, then the three fences and a separate check.
		expect(sent()).toEqual([
			["check", []],
			["check", []],
			["check", []],
			["fence", []],
			["fence", []],
			["fence", []],
			["check", []],
		]);
		// A kept path the host did not send is not an answer to this call.
		f.overrides.set("qorpera_fence_native_context", async (args) => ({ ...(await fence(args)), kept: ["z.md"] }));
		await expect(f.gateway.fenceContextView(frame("request-4"), [], f.signal)).rejects.toThrow(
			"Native context provenance was not confirmed",
		);
	});

	it("fences a model request in one call and falls back only when the database lacks it", async () => {
		const f = fixture();
		const { authority, fence, frame } = keptFence(f);
		await expect(f.gateway.fenceContextView(frame("request-1"), [], f.signal)).resolves.toEqual(authority);
		await expect(f.gateway.fenceContextView(frame("request-2"), [], f.signal)).resolves.toEqual(authority);
		expect(
			fence.mock.calls.map(([args]) => [args.p_paths, (args.p_view as { requestId: string }).requestId]),
		).toEqual([
			[[], "request-1"],
			[[], "request-2"],
		]);
		expect(fence.mock.calls[0][0]).toMatchObject({
			p_binding: f.binding,
			p_environment_id: f.identity.environmentId,
		});
		// A receipt for another request is not a recorded view.
		f.overrides.set("qorpera_fence_native_context", async (args) => ({
			...(await fence(args)),
			receipt: await f.defaultCall("qorpera_record_native_context_view", {
				...args,
				p_view: { ...(args.p_view as Record<string, unknown>), requestId: "another-request" },
			}),
		}));
		await expect(f.gateway.fenceContextView(frame("request-3"), [], f.signal)).rejects.toThrow(
			"Native context provenance was not confirmed",
		);
		// Without the function (PostgREST PGRST202) nothing ran: undefined, and it is not asked again.
		const missing = vi.fn(async () => {
			throw new CloudCompanyPathRpcMissing();
		});
		f.overrides.set("qorpera_fence_native_context", missing);
		await expect(f.gateway.fenceContextView(frame("request-4"), [], f.signal)).resolves.toBeUndefined();
		await expect(f.gateway.fenceContextView(frame("request-5"), [], f.signal)).resolves.toBeUndefined();
		expect(missing).toHaveBeenCalledOnce();
		// The separate calls still check the run's read set, naming no path.
		await f.gateway.assertReadableContext(f.signal);
		expect(f.call.mock.calls.at(-1)).toEqual([
			"qorpera_assert_company_path_reads",
			expect.objectContaining({ p_paths: [] }),
			expect.any(AbortSignal),
		]);
	});

	it("leaves the one call's attempt to the run's retry, adding no deadline of its own (6 Oct 2026)", async () => {
		const f = fixture();
		const { authority, fence, frame } = keptFence(f);
		// The run cuts each attempt (10 s at first, twice as long after one is cut); the gateway's other calls stop at 5 s.
		let answer: () => void = () => undefined;
		f.overrides.set("qorpera_fence_native_context", async (args) => {
			await new Promise<void>((resolve) => {
				answer = resolve;
			});
			return fence(args);
		});
		vi.useFakeTimers();
		const fenced = f.gateway.fenceContextView(frame("request-1"), [], f.signal);
		await vi.advanceTimersByTimeAsync(12_000);
		vi.useRealTimers();
		answer();
		await expect(fenced).resolves.toEqual(authority);
	});

	it("refuses a gateway whose identity is not the admitted run's", () => {
		const f = fixture();
		expect(
			() =>
				new CloudCompanyPathGateway({
					binding: f.binding,
					identity: { ...f.identity, runId: randomUUID() },
					control: { call: f.call },
					store: f.store,
				}),
		).toThrow("does not match the admitted run");
		expect(f.call).not.toHaveBeenCalled();
	});

	it.each([
		"../x",
		"/absolute",
		"a//b",
		"a/./b",
		"a/../b",
		"a\\b",
		"a%2fb",
		"a/CON.txt",
		"a\0b",
		"a\u007fb",
		"a/Ｂ：b",
		"dir／child",
		"e\u0301.md",
		"dir./x",
	])("rejects path representation %s before transport", (path) => {
		expect(() => parseCloudCompanyPath(path)).toThrow();
	});

	it("rejects corrupted immutable bytes and forged path/company metadata in a trusted read", async () => {
		const f = fixture();
		const file = await f.seed("note.md", "valid bytes");
		f.objects.set(`${f.identity.companyId}/${file.fileSha256}`, Buffer.from("other bytes"));
		await expect(f.gateway.readTrusted("note.md", f.signal)).rejects.toThrow("integrity");
		for (const forged of [{ companyId: randomUUID() }, { path: "other.md" }]) {
			f.overrides.set("qorpera_read_company_path", async (args) => ({
				...((await f.defaultCall("qorpera_read_company_path", args)) as Record<string, unknown>),
				...forged,
			}));
			vi.mocked(f.transport.get).mockClear();
			await expect(f.gateway.readTrusted("note.md", f.signal)).rejects.toThrow("scope");
			expect(f.transport.get).not.toHaveBeenCalled();
		}
	});

	it("lists only the server's projected children in a trusted listing, without object capabilities", async () => {
		const f = fixture();
		await f.seed("note.md", "data");
		const items = await f.gateway.listTrusted("", f.signal);
		expect(items).toEqual([{ path: "note.md", version: f.versions.get("note.md"), kind: "file", bytes: 4 }]);
		expect(JSON.stringify(items)).not.toContain("Sha256");
		expect(f.transport.get).not.toHaveBeenCalled();
		f.overrides.set("qorpera_list_company_paths", async () => ({
			snapshotId: randomUUID(),
			items: [{ path: "secret/child", kind: "file", bytes: 4, version: randomUUID() }],
			hasMore: false,
			nextAfter: null,
		}));
		await expect(f.gateway.listTrusted("", f.signal)).rejects.toThrow("child");
	});

	it("records exact delivered read hashes before turn and compaction requests, without storing text", async () => {
		const readId = randomUUID();
		const f = fixture([releasedRead("sensitive company text", readId)]);
		const response = await f.boundary.invoke("read-view", "qorpera", "company_read", { path: "note.md" });
		// What the folder core recorded when it released the text (qorpera_folder_record_release).
		f.released.set(readId, JSON.parse(response.contentItems[0].text).content.sha256);
		const inputs = [
			{ kind: "function_call_output" as const, callId: "read-view", output: response.contentItems[0].text },
		];
		const outputs = await f.boundary.fenceNativeResults(inputs);
		for (const purpose of ["turn", "compaction"] as const)
			await f.gateway.recordContextView(
				{
					schema: "qorpera.native-result-fence/v1",
					requestId: `${purpose}-view`,
					threadId: "thread",
					turnId: "turn",
					purpose,
					outputs: inputs,
				},
				outputs,
				f.signal,
			);
		const views = f.call.mock.calls.filter(([method]) => method === "qorpera_record_native_context_view");
		expect(views).toHaveLength(2);
		expect(JSON.stringify(views)).not.toContain("sensitive company text");
		const output = (views[0][1].p_view as { outputs: Array<{ readId: string; readSha256: string; sha256: string }> })
			.outputs[0];
		expect(output.readId).toBe(readId);
		expect(output.readSha256).toBe(f.released.get(readId));
		expect(output.sha256).toBe(createHash("sha256").update(outputs[0].output).digest("hex"));
		f.released.clear();
		await expect(
			f.gateway.recordContextView(
				{
					schema: "qorpera.native-result-fence/v1",
					requestId: "unconfirmed",
					threadId: "thread",
					turnId: "turn",
					purpose: "turn",
					outputs: inputs,
				},
				outputs,
				f.signal,
			),
		).rejects.toThrow("evidence differs");
	});

	it.each(["valid", "hash", "content", "run", "status"])(
		"records capture metadata only when it matches the issued result: %s",
		async (fault) => {
			const f = fixture();
			const capture = {
				assetId: randomUUID(),
				screenId: randomUUID(),
				sha256: "f".repeat(64),
				bytes: 68,
				width: 1,
				height: 1,
				mediaType: "image/png" as const,
				surface: "browser" as const,
			};
			const output = JSON.stringify({
				status: fault === "status" ? "unconfirmed" : "ok",
				provenance: {
					companyId: f.identity.companyId,
					runId: fault === "run" ? randomUUID() : f.identity.runId,
					tool: "computer_screenshot",
				},
				content: { text: JSON.stringify(fault === "content" ? { ...capture, width: 2 } : capture) },
			});
			const request = f.gateway.recordContextView(
				{
					schema: "qorpera.native-result-fence/v1",
					requestId: "capture-context",
					threadId: "thread",
					turnId: "turn",
					purpose: "turn",
					outputs: [],
				},
				[
					{
						kind: "function_call_output",
						callId: "capture-call",
						output,
						imageSha256: fault === "hash" ? "a".repeat(64) : capture.sha256,
						capture,
					},
				],
				f.signal,
			);
			if (fault !== "valid") await expect(request).rejects.toThrow("Native capture provenance changed");
			else {
				await request;
				const views = f.call.mock.calls.filter(([method]) => method === "qorpera_record_native_context_view");
				expect(views).toHaveLength(1);
				expect(views[0][1].p_view).toMatchObject({
					outputs: [
						{
							capture,
							sha256: createHash("sha256").update(output).digest("hex"),
							bytes: Buffer.byteLength(output),
							readId: null,
						},
					],
				});
				expect(JSON.stringify(views)).not.toContain("data:image");
			}
		},
	);

	it("records any number of model requests", async () => {
		// Runtime v92: a run used to fail past 256 model requests.
		const f = fixture();
		f.overrides.set("qorpera_record_native_context_view", async (args) => ({
			schema: "qorpera.native-context-view-receipt/v1",
			viewId: randomUUID(),
			requestId: (args.p_view as { requestId: string }).requestId,
			sha256: "c".repeat(64),
			ordinal: 300,
		}));
		await f.gateway.recordContextView(
			{
				schema: "qorpera.native-result-fence/v1",
				requestId: "request-300",
				threadId: "thread",
				turnId: "turn",
				purpose: "turn",
				outputs: [],
			},
			[],
			f.signal,
		);
	});
	it("rechecks the context read set even when native result batches are empty", async () => {
		const f = fixture();
		f.overrides.set("qorpera_assert_company_path_reads", async () => {
			throw new Error("now private");
		});
		await expect(f.boundary.fenceNativeResults([])).rejects.toThrow("now private");
	});
});
