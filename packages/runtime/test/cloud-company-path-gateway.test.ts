import { createHash, randomUUID } from "node:crypto";
import { type CloudCompanyPathPlan, parseCloudCompanyPath } from "@qorpera/cloud-client/company-path-schema";
import type { CloudCompanyTreeEntry } from "@qorpera/cloud-client/node/cloud-company-snapshot";
import { CloudContentAddressedStore, type CloudObjectTransport } from "@qorpera/cloud-client/node/cloud-object-store";
import type { JsonValue } from "@qorpera/contracts";
import { HttpCloudCompanyPathControl } from "@qorpera/runtime/cloud-company-path-control";
import {
	CloudCompanyHeadConflict,
	type CloudCompanyPathControl,
	CloudCompanyPathGateway,
	CloudCompanyPathNotText,
	type CloudCompanyPathRpc,
} from "@qorpera/runtime/cloud-company-path-gateway";
import {
	CloudCompanyPathParentMissing,
	CloudCompanyPathRpcMissing,
	CloudCompanyPathRpcPrecondition,
	CloudCompanyPathRpcRefusal,
	CloudCompanyPathVersionChanged,
} from "@qorpera/runtime/cloud-company-path-refusal";
import type { CloudNativeFenceRequest } from "@qorpera/runtime/cloud-native-result-fence";
import { CLOUD_NATIVE_TOOL_AUTHORITY_SCHEMA } from "@qorpera/runtime/cloud-native-tool-authority";
import { type CloudNativeTool, CloudNativeToolBoundary } from "@qorpera/runtime/cloud-native-tool-boundary";
import { CloudRuntimeObservability, type CloudRuntimeObservation } from "@qorpera/runtime/cloud-runtime-observability";
import { describe, expect, it, vi } from "vitest";
import { companyFilePostgrest } from "./fixtures/company-file-postgrest.ts";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

/**
 * company_write, company_mkdir and company_delete over the gateway's mutate(), as its own
 * tools() offered them until C-P5: a closed text change each. A company run's model has
 * the folder core's tools (cloudFolderFileTools); these drive mutate() through a real
 * boundary until C-P7 deletes that lane.
 */
function mutationTools(gateway: CloudCompanyPathGateway): CloudNativeTool[] {
	return (["write", "mkdir", "delete"] as const).map((operation): CloudNativeTool => {
		const keys = ["expectedVersion", "operationKey", "path", ...(operation === "write" ? ["text"] : [])];
		return {
			name: `company_${operation}`,
			source: "company_file",
			description: `Company File ${operation} through the path gateway's mutate().`,
			inputSchema: {
				type: "object",
				additionalProperties: false,
				required: keys,
				properties: {
					path: { type: "string" },
					operationKey: { type: "string" },
					expectedVersion: { type: ["string", "null"] },
					...(operation === "write" ? { text: { type: "string" } } : {}),
				},
			},
			parseArguments: (value) => {
				if (
					!value ||
					typeof value !== "object" ||
					Array.isArray(value) ||
					Object.keys(value).sort().join() !== keys.join()
				)
					throw new Error("Invalid Company File write");
				return value;
			},
			execute: async (value, context) => {
				const input = value as {
					path: string;
					operationKey: string;
					expectedVersion: string | null;
					text?: string;
				};
				return {
					kind: "json",
					value: { ...(await gateway.mutate(operation, input, context.signal, context.observation)) },
				};
			},
		};
	});
}

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
function fixture(observability?: CloudRuntimeObservability, tools: readonly CloudNativeTool[] = []) {
	const { binding, authority } = nativeToolAuthorityFixture();
	const identity = authority.identity;
	const objects = new Map<string, Uint8Array>();
	const entries = new Map<string, CloudCompanyTreeEntry>();
	const versions = new Map<string, string>();
	const receipts = new Map<string, JsonValue>();
	/** What the folder core recorded as released: read id to the hash of the text it released. */
	const released = new Map<string, string>();
	let snapshotId = randomUUID();
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
		if (["qorpera_verify_company_path_file", "qorpera_verify_company_path_tree"].includes(method)) {
			expect(args.p_profile_id).toBe(identity.companyId);
			return method === "qorpera_verify_company_path_tree"
				? createHash("sha256")
						.update(args.p_manifest_text as string)
						.digest("hex")
				: null;
		}
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
		const plan = args.p_plan as CloudCompanyPathPlan;
		if (method === "qorpera_check_company_path_mutation" || method === "qorpera_prepare_company_path_mutation") {
			const receipt = receipts.get(plan.operationKey);
			if (receipt) return { state: "completed", result: receipt };
			if (plan.entry === null || plan.path === "AGENTS.md") return { state: "protected" };
			return {
				state: "ready",
				...(method === "qorpera_prepare_company_path_mutation"
					? { snapshotId, entries: [...entries.values()] }
					: {}),
			};
		}
		if (method === "qorpera_commit_company_path_mutation") {
			const proposed = args.p_tree_sha256 === null;
			const version = proposed ? plan.expectedVersion : randomUUID();
			if (!proposed) {
				snapshotId = randomUUID();
				if (plan.entry) entries.set(plan.path, plan.entry);
				else entries.delete(plan.path);
				versions.set(plan.path, version!);
			}
			const result = {
				schema: "qorpera.company-path-result/v1",
				state: proposed ? "proposed" : "applied",
				path: plan.path,
				operationKey: plan.operationKey,
				receiptId: randomUUID(),
				version,
				snapshotId: proposed ? null : snapshotId,
				proposalId: proposed ? randomUUID() : null,
			};
			receipts.set(plan.operationKey, result);
			return result;
		}
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
		tools: [...mutationTools(gateway), ...tools],
		assertActive: (signal) => gateway.assertReadableContext(signal),
		signal,
		observability,
	});
	return {
		binding,
		identity,
		objects,
		entries,
		versions,
		receipts,
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
	it("carries a real bounded HTTP42501 through the gateway into a redacted denied tool result", async () => {
		const f = fixture();
		const fetch = vi.fn(async () =>
			Response.json(
				{ code: "42501", message: "PRIVATE_PATH_DIAGNOSTIC", details: null, hint: null },
				{ status: 403 },
			),
		);
		const control = new HttpCloudCompanyPathControl({
			supabaseUrl: "https://authority.example",
			serviceRoleKey: "fixture",
			fetch,
		});
		const gateway = new CloudCompanyPathGateway({
			binding: f.binding,
			identity: f.identity,
			control,
			store: f.store,
		});
		const boundary = new CloudNativeToolBoundary({
			companyId: f.identity.companyId,
			runId: f.identity.runId,
			identity: f.identity,
			tools: mutationTools(gateway),
			assertActive: async () => {},
			signal: f.signal,
		});
		const args = { path: "private.txt", text: "never staged", operationKey: "http-denied", expectedVersion: null };
		const response = await boundary.invoke("http_denied", "qorpera", "company_write", args);
		expect(JSON.parse(response.contentItems[0].text)).toMatchObject({
			status: "denied",
			content: { text: "COMPANY_FILE_ACCESS_DENIED" },
		});
		expect(response.contentItems[0].text).not.toContain("PRIVATE_PATH_DIAGNOSTIC");
		expect(await boundary.invoke("http_denied", "qorpera", "company_write", args)).toEqual(response);
		expect(fetch).toHaveBeenCalledOnce();
		expect(f.transport.get).not.toHaveBeenCalled();
		expect(f.transport.put).not.toHaveBeenCalled();
	});
	it("does not infer confirmed refusal from an adapter's42501 text", async () => {
		const f = fixture();
		f.overrides.set("qorpera_check_company_path_mutation", async () => {
			throw new Error("42501 PRIVATE_ADAPTER_MESSAGE");
		});
		const response = await f.boundary.invoke("text_denied", "qorpera", "company_write", {
			path: "private.txt",
			text: "never staged",
			operationKey: "text-denied",
			expectedVersion: null,
		});
		expect(JSON.parse(response.contentItems[0].text)).toMatchObject({
			status: "unconfirmed",
			content: { text: "TOOL_OUTCOME_UNCONFIRMED" },
		});
		expect(response.contentItems[0].text).not.toContain("PRIVATE_ADAPTER_MESSAGE");
	});

	it.each([
		[
			"company_write",
			"qorpera_check_company_path_mutation",
			{ path: "private.txt", text: "never staged", operationKey: "denied", expectedVersion: null },
		],
	] as const)("reports initial %s admission refusal as denied without effects or replay", async (tool, rpc, args) => {
		const f = fixture();
		f.overrides.set(rpc, async () => {
			throw new CloudCompanyPathRpcRefusal();
		});
		const response = await f.boundary.invoke("denied_call", "qorpera", tool, args);
		expect(JSON.parse(response.contentItems[0].text)).toMatchObject({
			status: "denied",
			content: { text: "COMPANY_FILE_ACCESS_DENIED" },
		});
		expect(await f.boundary.invoke("denied_call", "qorpera", tool, args)).toEqual(response);
		expect(f.call.mock.calls.filter(([method]) => method === rpc)).toHaveLength(1);
		expect(f.transport.put).not.toHaveBeenCalled();
		expect(f.transport.get).not.toHaveBeenCalled();
		expect(f.receipts.size).toBe(0);
	});
	it.each([
		"qorpera_verify_company_path_file",
		"qorpera_prepare_company_path_mutation",
		"qorpera_commit_company_path_mutation",
	] as const)("retains ambiguity for a transaction denial at %s after staging", async (rpc) => {
		const f = fixture();
		f.overrides.set(rpc, async () => {
			throw new CloudCompanyPathRpcRefusal();
		});
		const args = { path: "a.txt", text: "staged", operationKey: "staged", expectedVersion: null };
		const result = await f.boundary.invoke("staged_call", "qorpera", "company_write", args);
		expect(JSON.parse(result.contentItems[0].text).status).toBe("unconfirmed");
		expect(f.transport.put).toHaveBeenCalled();
		expect(f.call.mock.calls.filter(([method]) => method === rpc)).toHaveLength(1);
		expect(await f.boundary.invoke("staged_call", "qorpera", "company_write", args)).toEqual(result);
		expect(f.call.mock.calls.filter(([method]) => method === rpc)).toHaveLength(1);
	});
	it("keeps a lost commit response unconfirmed even though the canonical effect happened", async () => {
		const f = fixture();
		f.overrides.set("qorpera_commit_company_path_mutation", async (args) => {
			await f.defaultCall("qorpera_commit_company_path_mutation", args);
			throw new Error("PRIVATE_NETWORK_403_42501");
		});
		const args = { path: "a.txt", text: "committed", operationKey: "committed", expectedVersion: null };
		const result = await f.boundary.invoke("lost_commit", "qorpera", "company_write", args);
		expect(JSON.parse(result.contentItems[0].text)).toMatchObject({
			status: "unconfirmed",
			content: { text: "TOOL_OUTCOME_UNCONFIRMED" },
		});
		expect(f.receipts.size).toBe(1);
		expect(await f.boundary.invoke("lost_commit", "qorpera", "company_write", args)).toEqual(result);
		expect(f.call.mock.calls.filter(([method]) => method === "qorpera_commit_company_path_mutation")).toHaveLength(1);
	});

	it.each([
		["at its version check", "qorpera_check_company_path_mutation", false],
		["at prepare, after staging", "qorpera_prepare_company_path_mutation", true],
		["at commit", "qorpera_commit_company_path_mutation", true],
	] as const)("carries a real HTTP 412/PT412 %s into a typed version-changed result", async (_label, rpc, staged) => {
		const db = companyFilePostgrest();
		await db.seed("notes/plan.md", "v1\n");
		const read = db.entries.get("notes/plan.md")!.version;
		let raced = false;
		db.before.hook = async (method) => {
			if (method !== rpc || raced) return;
			raced = true;
			await db.seed("notes/plan.md", "v2 by a member\n");
		};
		const boundary = new CloudNativeToolBoundary({
			companyId: db.identity.companyId,
			runId: db.identity.runId,
			identity: db.identity,
			tools: mutationTools(db.gateway),
			assertActive: async () => {},
			signal: new AbortController().signal,
		});
		try {
			const args = { path: "notes/plan.md", operationKey: "plan-edit", expectedVersion: read, text: "v1 edited\n" };
			const response = await boundary.invoke("stale_write", "qorpera", "company_write", args);
			const envelope = JSON.parse(response.contentItems[0].text);
			expect(response.success).toBe(false);
			expect(envelope).toMatchObject({ status: "denied" });
			expect(envelope.content.text).toMatch(/^COMPANY_FILE_VERSION_CHANGED: nothing was written/);
			expect(envelope.content.text).not.toContain("Company File path version changed");
			expect(db.requests.filter((request) => request.status === 412)).toEqual([
				{ method: rpc, path: "notes/plan.md", status: 412 },
			]);
			expect(db.requests.filter((request) => request.method === "qorpera_verify_company_path_file")).toHaveLength(
				staged ? 1 : 0,
			);
			expect(await db.text("notes/plan.md")).toBe("v2 by a member\n");
			// Nothing was written, so the same change against the current version applies.
			const current = db.entries.get("notes/plan.md")!.version;
			const retried = await boundary.invoke("stale_retry", "qorpera", "company_write", {
				...args,
				expectedVersion: current,
			});
			expect(JSON.parse(retried.contentItems[0].text)).toMatchObject({ status: "ok" });
			expect(await db.text("notes/plan.md")).toBe("v1 edited\n");
		} finally {
			boundary.close();
		}
	});
	// Live 2026-09-26 (run 71b86758): company_write into acceptance/auto-review/ when only acceptance/
	// existed uploaded its bytes and came back unconfirmed/unknown, twice. The check refuses it first now.
	it.each([
		["company_write", "acceptance/auto-review/check-1.txt", { text: "check 1\n" }],
		["company_mkdir", "acceptance/auto-review/round-1", {}],
	] as const)(
		"refuses %s into a missing folder before anything is staged, then applies once it exists",
		async (tool, path, extra) => {
			const db = companyFilePostgrest();
			db.directory("acceptance");
			const rows: CloudRuntimeObservation[] = [];
			const observability = new CloudRuntimeObservability({
				assignmentId: null,
				publish: async (batch) => {
					rows.push(...batch);
				},
			});
			const boundary = new CloudNativeToolBoundary({
				companyId: db.identity.companyId,
				runId: db.identity.runId,
				identity: db.identity,
				tools: mutationTools(db.gateway),
				assertActive: async () => {},
				signal: new AbortController().signal,
				observability,
			});
			try {
				const objects = db.objects.size;
				const args = { path, operationKey: "check-1", expectedVersion: null, ...extra };
				const response = await boundary.invoke("missing_parent", "qorpera", tool, args);
				const envelope = JSON.parse(response.contentItems[0].text);
				expect(response.success).toBe(false);
				expect(envelope).toMatchObject({ status: "denied" });
				expect(envelope.content.text).toMatch(
					/^COMPANY_FILE_PARENT_MISSING: nothing was written; the folder this path goes in does not exist\. When a member or your assignment named this folder, or a category of files needs it as its home, create it with company_mkdir first.*Otherwise, for a single file, choose an existing folder where it fits/,
				);
				expect(envelope.content.text).toContain("do not replace the file");
				expect(envelope.content.text).not.toContain("Company File parent folder is missing");
				// Only the check crossed the wire: no upload, no prepare or commit.
				expect(db.requests).toEqual([{ method: "qorpera_check_company_path_mutation", path, status: 424 }]);
				expect(db.objects.size).toBe(objects);
				expect(db.entries.has(path)).toBe(false);
				// As the result says: create the folder, then repeat the same call.
				const folder = await boundary.invoke("create_folder", "qorpera", "company_mkdir", {
					path: "acceptance/auto-review",
					operationKey: "auto-review-folder",
					expectedVersion: null,
				});
				expect(JSON.parse(folder.contentItems[0].text)).toMatchObject({ status: "ok" });
				const repeated = await boundary.invoke("missing_parent_again", "qorpera", tool, args);
				expect(JSON.parse(repeated.contentItems[0].text)).toMatchObject({
					status: "ok",
					content: { kind: "json" },
				});
				expect(db.entries.get(path)?.entry?.kind).toBe(tool === "company_write" ? "file" : "directory");
				if (tool === "company_write") expect(await db.text(path)).toBe("check 1\n");
				await observability.close();
				const finishes = rows.filter((row) => row.operation === tool && row.phase === "finish");
				// For company_mkdir, creating the folder is the middle one.
				expect(finishes.map((row) => [row.status, row.errorCategory])).toEqual([
					["denied", "parent_missing"],
					...(tool === "company_mkdir" ? [["succeeded", null]] : []),
					["succeeded", null],
				]);
			} finally {
				boundary.close();
			}
		},
	);
	it.each([
		["at prepare, after staging", "qorpera_prepare_company_path_mutation"],
		["at commit", "qorpera_commit_company_path_mutation"],
	] as const)("carries a folder deleted after the check (%s) into the same typed result", async (_label, rpc) => {
		const db = companyFilePostgrest();
		db.directory("acceptance/auto-review");
		let raced = false;
		db.before.hook = (method) => {
			if (method !== rpc || raced) return;
			raced = true;
			db.remove("acceptance/auto-review");
		};
		const boundary = new CloudNativeToolBoundary({
			companyId: db.identity.companyId,
			runId: db.identity.runId,
			identity: db.identity,
			tools: mutationTools(db.gateway),
			assertActive: async () => {},
			signal: new AbortController().signal,
		});
		try {
			const path = "acceptance/auto-review/check-1.txt";
			const response = await boundary.invoke("folder_deleted", "qorpera", "company_write", {
				path,
				operationKey: "check-1",
				expectedVersion: null,
				text: "check 1\n",
			});
			expect(JSON.parse(response.contentItems[0].text)).toMatchObject({
				status: "denied",
				content: { text: expect.stringMatching(/^COMPANY_FILE_PARENT_MISSING: nothing was written/) },
			});
			expect(db.requests.filter((request) => request.status === 424)).toEqual([{ method: rpc, path, status: 424 }]);
			expect(db.entries.has(path)).toBe(false);
		} finally {
			boundary.close();
		}
	});
	it("refuses a plan whose folder is missing from the entries it would stage, before any commit", async () => {
		// SQL found the folder at the check; it was deleted before prepare listed the head.
		const f = fixture();
		const response = await f.boundary.invoke("stage_orphan", "qorpera", "company_write", {
			path: "gone/check-1.txt",
			operationKey: "stage-orphan",
			expectedVersion: null,
			text: "x",
		});
		expect(JSON.parse(response.contentItems[0].text)).toMatchObject({
			status: "denied",
			content: { text: expect.stringMatching(/^COMPANY_FILE_PARENT_MISSING: /) },
		});
		expect(f.call.mock.calls.filter(([method]) => method === "qorpera_commit_company_path_mutation")).toHaveLength(0);
		expect(f.call.mock.calls.filter(([method]) => method === "qorpera_verify_company_path_tree")).toHaveLength(0);
		expect(f.receipts.size).toBe(0);
	});
	it("does not infer a missing folder from adapter text or from a refusal outside a mutation", async () => {
		const f = fixture(undefined, [failingRead(new CloudCompanyPathParentMissing())]);
		f.overrides.set("qorpera_check_company_path_mutation", async () => {
			throw new Error("PT424 Company File parent folder is missing");
		});
		const write = await f.boundary.invoke("text_orphan", "qorpera", "company_write", {
			path: "a/b.txt",
			text: "x",
			operationKey: "text-orphan",
			expectedVersion: null,
		});
		expect(JSON.parse(write.contentItems[0].text)).toMatchObject({
			status: "unconfirmed",
			content: { text: "TOOL_OUTCOME_UNCONFIRMED" },
		});
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
	it("does not infer a version change from adapter text or from a precondition outside a mutation", async () => {
		const f = fixture(undefined, [failingRead(new CloudCompanyPathVersionChanged())]);
		f.overrides.set("qorpera_check_company_path_mutation", async () => {
			throw new Error("PT412 Company File path version changed");
		});
		const write = await f.boundary.invoke("text_stale", "qorpera", "company_write", {
			path: "a.txt",
			text: "x",
			operationKey: "text-stale",
			expectedVersion: null,
		});
		expect(JSON.parse(write.contentItems[0].text)).toMatchObject({
			status: "unconfirmed",
			content: { text: "TOOL_OUTCOME_UNCONFIRMED" },
		});
		// A read that finds the file moved is a precondition too, but not a write's version check:
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
		const f = fixture(undefined, [releasedRead("A", readId)]);
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
		const f = fixture(undefined, [releasedRead("sensitive company text", readId)]);
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

	it("checks the exact plan before any immutable upload", async () => {
		const f = fixture();
		f.overrides.set("qorpera_check_company_path_mutation", async () => {
			throw new Error("denied");
		});
		await expect(
			f.gateway.mutate(
				"write",
				{ path: "secret.txt", operationKey: "write", expectedVersion: null, text: "must not stage" },
				f.signal,
			),
		).rejects.toThrow();
		expect(f.transport.put).not.toHaveBeenCalled();
		expect(f.call).toHaveBeenCalledTimes(1);
	});

	it("stages and restores content, then publishes one exact validated tree", async () => {
		const f = fixture();
		await f.seed("existing.md", "keep");
		const result = await f.gateway.mutate(
			"write",
			{ path: "new.md", operationKey: "work-1", expectedVersion: null, text: "done" },
			f.signal,
		);
		expect(result.state).toBe("applied");
		const calls = f.call.mock.calls.map(([name]) => name);
		expect(calls).toEqual([
			"qorpera_check_company_path_mutation",
			"qorpera_verify_company_path_file",
			"qorpera_prepare_company_path_mutation",
			"qorpera_verify_company_path_tree",
			"qorpera_commit_company_path_mutation",
		]);
		const verified = f.call.mock.calls.find(([method]) => method === "qorpera_verify_company_path_tree")![1];
		expect(
			JSON.parse(verified.p_manifest_text as string).entries.map((entry: CloudCompanyTreeEntry) => entry.path),
		).toEqual(["existing.md", "new.md"]);
		expect(f.receipts.size).toBe(1);
	});

	it("does not advance metadata when immutable storage verification fails", async () => {
		const f = fixture();
		vi.mocked(f.transport.get).mockResolvedValue(Buffer.from("corrupted"));
		await expect(
			f.gateway.mutate(
				"write",
				{ path: "new.md", operationKey: "work", expectedVersion: null, text: "data" },
				f.signal,
			),
		).rejects.toThrow();
		expect(f.call.mock.calls.map(([method]) => method)).toEqual(["qorpera_check_company_path_mutation"]);
		expect(f.entries.size).toBe(0);
	});

	it("returns protected changes as proposals without constructing a live candidate", async () => {
		const f = fixture();
		const result = await f.gateway.mutate(
			"write",
			{ path: "AGENTS.md", operationKey: "proposal", expectedVersion: null, text: "proposed policy" },
			f.signal,
		);
		expect(result).toMatchObject({ state: "proposed", snapshotId: null });
		expect(f.call.mock.calls.some(([method]) => method === "qorpera_verify_company_path_tree")).toBe(false);
		expect(f.entries.size).toBe(0);
		expect(f.call).toHaveBeenLastCalledWith(
			"qorpera_commit_company_path_mutation",
			expect.objectContaining({ p_expected_head: null, p_tree_sha256: null }),
			expect.any(AbortSignal),
		);
	});

	it("quarantines a lost response and recovers the same receipt on an explicit retry", async () => {
		const f = fixture();
		f.overrides.set("qorpera_commit_company_path_mutation", async (args) => {
			await f.defaultCall("qorpera_commit_company_path_mutation", args);
			throw new Error("response lost");
		});
		const input = { path: "new.md", operationKey: "same-work", expectedVersion: null, text: "one effect" };
		await expect(f.gateway.mutate("write", input, f.signal)).rejects.toThrow("lost");
		expect(f.call.mock.calls.filter(([method]) => method === "qorpera_commit_company_path_mutation")).toHaveLength(1);
		f.call.mockClear();
		vi.mocked(f.transport.put).mockClear();
		const replay = await f.gateway.mutate("write", input, f.signal);
		expect(replay).toEqual(f.receipts.get("same-work"));
		expect(f.call.mock.calls.map(([method]) => method)).toEqual(["qorpera_check_company_path_mutation"]);
		expect(f.transport.put).not.toHaveBeenCalled();
	});

	it.each(["preflight", "preparation", "proposal", "lost-response"])(
		"retains canonical %s replay metadata across new native call IDs",
		async (mode) => {
			const rows: CloudRuntimeObservation[] = [];
			const observability = new CloudRuntimeObservability({
				assignmentId: null,
				publish: async (batch) => {
					rows.push(...batch);
				},
			});
			const f = fixture(observability);
			if (mode === "lost-response")
				f.overrides.set("qorpera_commit_company_path_mutation", async (args) => {
					await f.defaultCall("qorpera_commit_company_path_mutation", args);
					throw new Error("PRIVATE_LOST_RESPONSE");
				});
			const input = {
				path: mode === "proposal" ? "AGENTS.md" : "PRIVATE_PATH",
				operationKey: "PRIVATE_WORK_KEY",
				expectedVersion: null,
				text: "PRIVATE_WRITE_TEXT",
			};
			const first = await f.boundary.invoke("first-call", "qorpera", "company_write", input);
			expect(first.success).toBe(mode !== "lost-response");
			if (mode === "preparation")
				f.overrides.set("qorpera_check_company_path_mutation", async () => ({ state: "ready" }));
			const replay = await f.boundary.invoke("new-call-id", "qorpera", "company_write", input);
			expect(replay.success).toBe(true);
			await observability.close();
			f.boundary.close();
			const finishes = rows.filter((row) => row.operation === "company_write" && row.phase === "finish");
			expect(finishes.map((row) => row.status)).toEqual([
				mode === "lost-response" ? "unconfirmed" : mode === "proposal" ? "proposed" : "succeeded",
				mode === "proposal" ? "proposed" : "replayed",
			]);
			expect(finishes[1].receiptId).toBe(
				(f.receipts.get(input.operationKey) as Record<string, JsonValue>).receiptId,
			);
			if (mode !== "lost-response") expect(finishes[0].receiptId).toBe(finishes[1].receiptId);
			expect(finishes[0].attemptId).not.toBe(finishes[1].attemptId);
			expect(f.call.mock.calls.filter(([method]) => method === "qorpera_commit_company_path_mutation")).toHaveLength(
				1,
			);
			expect(JSON.stringify(rows)).not.toMatch(/PRIVATE_|AGENTS\.md/);
		},
	);

	it("rebuilds after an explicit head conflict without weakening the target version", async () => {
		const f = fixture();
		let calls = 0;
		f.overrides.set("qorpera_commit_company_path_mutation", async (args) => {
			if (++calls === 1) {
				f.entries.set("other", { kind: "directory", path: "other" });
				throw new CloudCompanyHeadConflict();
			}
			return f.defaultCall("qorpera_commit_company_path_mutation", args);
		});
		await f.gateway.mutate("mkdir", { path: "mine", operationKey: "same-target", expectedVersion: null }, f.signal);
		const commits = f.call.mock.calls.filter(([method]) => method === "qorpera_commit_company_path_mutation");
		expect(commits).toHaveLength(2);
		expect(commits[0][1].p_plan).toEqual(commits[1][1].p_plan);
		expect(commits[0][1].p_tree_sha256).not.toEqual(commits[1][1].p_tree_sha256);
		expect(f.entries.has("other")).toBe(true);
	});

	it("bounds head conflicts and fails closed on malformed receipts or blocked ancestors", async () => {
		const f = fixture();
		f.overrides.set("qorpera_commit_company_path_mutation", async () => {
			throw new CloudCompanyHeadConflict();
		});
		await expect(
			f.gateway.mutate("mkdir", { path: "dir", operationKey: "bounded", expectedVersion: null }, f.signal),
		).rejects.toThrow(CloudCompanyHeadConflict);
		expect(f.call.mock.calls.filter(([method]) => method === "qorpera_commit_company_path_mutation")).toHaveLength(4);
		f.overrides.delete("qorpera_commit_company_path_mutation");
		f.overrides.set("qorpera_check_company_path_mutation", async () => ({
			state: "completed",
			result: { approved: true },
		}));
		await expect(
			f.gateway.mutate("mkdir", { path: "dir", operationKey: "receipt", expectedVersion: null }, f.signal),
		).rejects.toThrow();
		f.overrides.clear();
		await f.seed("parent", "file");
		await expect(
			f.gateway.mutate("mkdir", { path: "parent/child", operationKey: "link", expectedVersion: null }, f.signal),
		).rejects.toThrow("parent");
	});
});

describe("Company File mutation inputs", () => {
	it("refuses a change's inputs before any call or transfer, a shared export's among them", async () => {
		const f = fixture();
		const base = { path: "output.txt", operationKey: "inputs", expectedVersion: null };
		for (const operation of ["mkdir", "delete"] as const)
			await expect(f.gateway.mutate(operation, { ...base, text: "x" }, f.signal)).rejects.toThrow(
				"Only a Company File write carries text",
			);
		// The source write is gone (C-P5): a shared export names no text, so the write refuses it.
		const exported = { ...base, source: { realm: "object_storage", assetId: randomUUID() } };
		await expect(f.gateway.mutate("write", exported, f.signal)).rejects.toThrow("Invalid Company File text write");
		await expect(f.gateway.mutate("write", { ...base, text: "x".repeat(32 * 1024 + 1) }, f.signal)).rejects.toThrow(
			"Invalid Company File text write",
		);
		await expect(f.gateway.mutate("write", { ...base, path: "../hidden", text: "x" }, f.signal)).rejects.toThrow();
		await expect(f.gateway.mutate("write", { ...base, operationKey: "", text: "x" }, f.signal)).rejects.toThrow(
			"Invalid Company File operation key",
		);
		await expect(
			f.gateway.mutate("write", { ...base, expectedVersion: "current", text: "x" }, f.signal),
		).rejects.toThrow("Invalid Company File version");
		expect(f.call).not.toHaveBeenCalled();
		expect(f.transport.get).not.toHaveBeenCalled();
		expect(f.transport.put).not.toHaveBeenCalled();
	});
});
