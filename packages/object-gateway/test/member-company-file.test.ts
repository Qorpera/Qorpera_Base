import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObjectDependencyError } from "../src/dependency.ts";
import { ObjectGatewayJournal } from "../src/journal.ts";
import {
	type MemberCompanyAuthority,
	MemberCompanyHeadConflict,
	SupabaseMemberCompanyAuthority,
} from "../src/member-company-authority.ts";
import { MemberCompanyObservations } from "../src/member-observability.ts";
import { FileSystemObjectStore } from "../src/object-store.ts";
import { ObjectGatewayReplication } from "../src/replication.ts";
import { createObjectGatewayHandler } from "../src/service.ts";
import { SupabaseObjectAuthority } from "../src/supabase-authority.ts";

const companyId = "29500000-0000-4000-8000-000000000010";
const environmentId = "29500000-0000-4000-8000-000000000020";
const commandId = "29500000-0000-4000-8000-000000000030";
const snapshotId = "29500000-0000-4000-8000-000000000040";
const version = "29500000-0000-4000-8000-000000000050";
const proposalId = "29500000-0000-4000-8000-000000000060";
const token = "synthetic-member-jwt";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid fixture record");
	return value as Record<string, unknown>;
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "qorpera-member-edit-"));
	const store = new FileSystemObjectStore(join(root, "objects"));
	const objects = new SupabaseObjectAuthority({
		projectUrl: "https://cloud.test",
		publishableKey: "fixture-public",
		secretKey: "fixture-secret",
		fetch: async () => {
			throw new Error("Raw object authority must not be used");
		},
	});
	const replication = new ObjectGatewayReplication(new ObjectGatewayJournal(join(root, "journal")), store, objects);
	const observations = new MemberCompanyObservations();
	const pendingObjects = new Map<string, number>();
	const state = {
		uploadSource: undefined as unknown,
		current: undefined as Record<string, unknown> | undefined,
		protected: false,
		revoked: false,
		loseApply: false,
		conflict: false,
		proposalState: "open",
		denyMethod: "",
		denialStatus: 403,
		tamperPlan: false,
		effects: 0,
		entries: [] as Record<string, unknown>[],
		proposalPlan: {
			schema: "qorpera.company-path-mutation/v1",
			operationKey: "native-delete",
			path: "note.md",
			expectedVersion: version,
			entry: null,
		} as Record<string, unknown>,
	};
	const member: MemberCompanyAuthority["member"] = vi.fn(async (method, memberToken, args) => {
		if (memberToken !== token || state.revoked) throw new ObjectDependencyError(403);
		if (state.denyMethod === method) throw new ObjectDependencyError(state.denialStatus);
		if ("p_environment_id" in args && args.p_environment_id !== environmentId) throw new ObjectDependencyError(403);
		if (
			method === "qorpera_begin_member_company_path_command" ||
			method === "qorpera_begin_member_company_file_upload"
		) {
			if (method === "qorpera_begin_member_company_file_upload") {
				if (state.current && JSON.stringify(state.uploadSource) !== JSON.stringify(args.p_source))
					throw new ObjectDependencyError(409);
				state.uploadSource = structuredClone(args.p_source);
				const raw = String(args.p_manifest_text),
					manifest = JSON.parse(raw);
				pendingObjects.set(createHash("sha256").update(raw).digest("hex"), Buffer.byteLength(raw));
				for (const chunk of manifest.chunks) pendingObjects.set(chunk.sha256, chunk.bytes);
			}
			if (state.current) {
				if (JSON.stringify(state.current.plan) !== JSON.stringify(args.p_plan))
					throw new ObjectDependencyError(409);
			} else {
				state.current = {
					commandId,
					environmentId,
					companyId,
					plan: args.p_plan,
					planSha256: "a".repeat(64),
					state: state.protected ? "review_required" : "ready",
					expiresAt: "2099-01-01T00:00:00Z",
					result: null,
				};
			}
			if (state.tamperPlan)
				return { ...state.current, plan: { ...record(state.current.plan), path: "other.md", entry: null } };
			return structuredClone(state.current);
		}
		if (method === "qorpera_get_member_company_path_command") {
			if (args.p_command_id !== commandId || !state.current) throw new ObjectDependencyError(403);
			return structuredClone(state.current);
		}
		if (method === "qorpera_review_member_company_path_command") {
			if (!state.current || args.p_command_id !== commandId || args.p_plan_sha256 !== state.current.planSha256)
				throw new ObjectDependencyError(403);
			state.current.state = args.p_decision === "approve" ? "approved" : "rejected";
			return structuredClone(state.current);
		}
		if (method === "qorpera_authorize_member_company_command_object") {
			if (!state.current || args.p_command_id !== commandId || args.p_plan_sha256 !== state.current.planSha256)
				throw new ObjectDependencyError(403);
			const file = record(record(record(state.current.plan).entry).file);
			if (pendingObjects.has(String(args.p_sha256)))
				return {
					companyId,
					sha256: args.p_sha256,
					bytes: pendingObjects.get(String(args.p_sha256)),
					backend: "nas-object-gateway",
				};
			if (args.p_sha256 !== file.fileSha256) throw new ObjectDependencyError(403);
			return { companyId, sha256: file.fileSha256, bytes: file.bytes, backend: "nas-object-gateway" };
		}
		if (method === "qorpera_authorize_member_company_proposal_object") {
			if (args.p_proposal_id !== proposalId || args.p_plan_sha256 !== "b".repeat(64))
				throw new ObjectDependencyError(403);
			const file = record(record(state.proposalPlan.entry).file);
			if (pendingObjects.has(String(args.p_sha256)))
				return {
					companyId,
					sha256: args.p_sha256,
					bytes: pendingObjects.get(String(args.p_sha256)),
					backend: "nas-object-gateway",
				};
			if (args.p_sha256 !== file.fileSha256) throw new ObjectDependencyError(403);
			return { companyId, sha256: file.fileSha256, bytes: file.bytes, backend: "nas-object-gateway" };
		}
		if (method === "qorpera_describe_member_company_path_proposal") {
			return {
				proposalId,
				planSha256: "b".repeat(64),
				state: state.proposalState,
				plan: state.proposalPlan,
				snapshotId: state.proposalState === "applied" ? snapshotId : null,
			};
		}
		if (method === "qorpera_review_company_path_proposal") {
			if (args.p_proposal_id !== proposalId || args.p_plan_sha256 !== "b".repeat(64))
				throw new ObjectDependencyError(403);
			state.proposalState = args.p_decision === "approve" ? "approved" : "withdrawn";
			return { state: state.proposalState };
		}
		throw new Error(`Unexpected member RPC ${method}`);
	});
	const publisher: MemberCompanyAuthority["publisher"] = vi.fn(async (method, args) => {
		if (state.revoked) throw new ObjectDependencyError(403);
		if (state.denyMethod === method) throw new ObjectDependencyError(state.denialStatus);
		if (
			method === "qorpera_stage_member_company_path_object" ||
			method === "qorpera_stage_company_path_approval_object"
		)
			return companyId;
		if (method === "qorpera_verify_company_path_file") return null;
		if (method === "qorpera_verify_company_path_tree") {
			const text = String(args.p_manifest_text);
			const candidate = record(JSON.parse(text));
			expect(candidate.contractVersion).toBe(3);
			return createHash("sha256").update(text).digest("hex");
		}
		if (method === "qorpera_prepare_member_company_path_command")
			return { ...structuredClone(state.current), snapshotId, entries: state.entries };
		if (method === "qorpera_prepare_company_path_approval")
			return {
				state: state.proposalState,
				companyId,
				environmentId,
				plan: state.proposalPlan,
				snapshotId,
				entries: state.entries,
			};
		if (method === "qorpera_apply_company_path_approval_v3") {
			state.proposalState = "applied";
			state.effects++;
			return { state: "applied", proposalId, snapshotId };
		}
		if (method === "qorpera_apply_member_company_path_command_v3") {
			if (state.conflict) {
				state.conflict = false;
				throw new MemberCompanyHeadConflict();
			}
			if (!state.current) throw new Error("No command");
			const plan = record(state.current.plan);
			state.current.state = "applied";
			state.current.result = {
				state: "applied",
				operationKey: plan.operationKey,
				path: plan.path,
				version,
				snapshotId,
			};
			state.effects++;
			if (state.loseApply) {
				state.loseApply = false;
				throw new ObjectDependencyError(503);
			}
			return structuredClone(state.current);
		}
		throw new Error(`Unexpected publisher RPC ${method}`);
	});
	const server = createServer(
		createObjectGatewayHandler({
			store,
			authority: objects,
			replication,
			controlToken: "synthetic-control",
			verifierToken: "synthetic-verifier",
			memberFiles: { member, publisher },
			memberObservations: observations,
		}),
	);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing fixture port");
	const origin = `http://127.0.0.1:${address.port}/v1/member-company-file/${environmentId}`;
	cleanups.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(root, { recursive: true, force: true });
	});
	return {
		async upload(bytes: Uint8Array, metadata: unknown) {
			return fetch(`${origin}/uploads`, {
				method: "PUT",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/octet-stream",
					"x-qorpera-company-upload": Buffer.from(JSON.stringify(metadata)).toString("base64url"),
				},
				body: Uint8Array.from(bytes),
			});
		},
		state,
		observations,
		store,
		member,
		publisher,
		replication,
		async request(route: string, value?: unknown, bearer = token) {
			return fetch(`${origin}/${route}`, {
				method: value === undefined ? "GET" : "POST",
				headers: {
					authorization: `Bearer ${bearer}`,
					...(value === undefined ? {} : { "content-type": "application/json" }),
				},
				...(value === undefined ? {} : { body: JSON.stringify(value) }),
			});
		},
	};
}

const edit = {
	operation: "write",
	operationKey: "human-save-1",
	path: "note.md",
	expectedVersion: version,
	text: "Company work, not chat state.",
};

function uploadMetadata(bytes: Uint8Array) {
	const sha = (part: Uint8Array) => createHash("sha256").update(part).digest("hex");
	const chunks = [];
	for (let offset = 0; offset < bytes.length; offset += 4 * 1024 * 1024) {
		const part = bytes.subarray(offset, offset + 4 * 1024 * 1024);
		chunks.push({ sha256: sha(part), bytes: part.length });
	}
	return {
		schema: "qorpera.member-file-upload/v1",
		operationKey: "selected-upload-1",
		path: "upload.bin",
		expectedVersion: null,
		source: {
			realm: "member_file",
			name: "selected.bin",
			sha256: sha(bytes),
			bytes: bytes.length,
			mediaType: "application/octet-stream",
		},
		manifest: {
			schema: "qorpera.cloud-file-manifest/v1",
			fileSha256: sha(bytes),
			bytes: bytes.length,
			mediaType: "application/octet-stream",
			chunks,
		},
	};
}

describe("selected member binary uploads", () => {
	it.each([0, 6, 4194307, 8388608])("assembles a pending %i-byte upload for exact human review", async (size) => {
		const f = await fixture(),
			bytes = Buffer.alloc(size, 128);
		f.state.protected = true;
		expect((await f.upload(bytes, uploadMetadata(bytes))).status).toBe(200);
		const response = await f.request(`edits/${commandId}/file`);
		expect(response.status).toBe(200);
		expect(response.headers.get("x-qorpera-plan-sha256")).toBe("a".repeat(64));
		expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
		expect(f.state.effects).toBe(0);
		f.state.proposalPlan = structuredClone(record(f.state.current!.plan));
		const proposed = await f.request(`proposals/${proposalId}/file`);
		expect(proposed.status).toBe(200);
		expect(Buffer.from(await proposed.arrayBuffer()).equals(bytes)).toBe(true);
	});
	it.each(["revocation", "corruption", "plan-change", "expired"])(
		"refuses pending binary content after %s",
		async (mode) => {
			const f = await fixture(),
				bytes = Buffer.alloc(4194307, 128);
			f.state.protected = true;
			await (await f.upload(bytes, uploadMetadata(bytes))).text();
			if (mode === "expired") f.state.current!.expiresAt = "2000-01-01T00:00:00Z";
			const get = f.store.get.bind(f.store);
			vi.spyOn(f.store, "get").mockImplementation(async (...args) => {
				const value = await get(...args);
				if (mode === "revocation") f.state.revoked = true;
				if (mode === "plan-change") f.state.current!.planSha256 = "c".repeat(64);
				if (mode === "corruption") return new Uint8Array(value.length);
				return value;
			});
			const response = await f.request(`edits/${commandId}/file`);
			expect(response.status).toBeGreaterThanOrEqual(400);
			expect(f.state.effects).toBe(0);
		},
	);
	it.each([0, 6, 4 * 1024 * 1024 + 3, 8 * 1024 * 1024])(
		"stages and applies all %s selected bytes with exact manifest provenance",
		async (size) => {
			const service = await fixture(),
				bytes = Buffer.alloc(size, 128);
			if (size) bytes[size - 1] = 255;
			const metadata = uploadMetadata(bytes),
				response = await service.upload(bytes, metadata);
			expect(response.status).toBe(200);
			const result = record(await response.json());
			expect(result.state).toBe("applied");
			expect(service.state.uploadSource).toEqual(metadata.source);
			expect(service.state.effects).toBe(1);
			const chunks = await Promise.all(
				metadata.manifest.chunks.map((chunk) => service.store.get(companyId, chunk.sha256, chunk.bytes)),
			);
			// Buffer.equals, not toEqual: toEqual walks 4-8 MiB element by element and blocks the event loop
			// for seconds, longer than the server's keep-alive timeout, so the retry below could be written
			// onto a connection the server is closing (ECONNRESET).
			expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
			expect(service.member).toHaveBeenCalledWith(
				"qorpera_begin_member_company_file_upload",
				token,
				expect.objectContaining({ p_source: metadata.source, p_manifest_text: JSON.stringify(metadata.manifest) }),
				expect.any(AbortSignal),
			);
			const writes = vi.spyOn(service.replication, "uploadWithAuthority");
			expect((await service.upload(bytes, metadata)).status).toBe(200);
			expect(service.state.effects).toBe(1);
			expect(writes).not.toHaveBeenCalled();
		},
	);
	it("recovers a lost applied reply without a second canonical mutation", async () => {
		const service = await fixture(),
			bytes = Buffer.from([0, 255]);
		service.state.loseApply = true;
		expect((await service.upload(bytes, uploadMetadata(bytes))).status).toBe(503);
		expect(service.state.effects).toBe(1);
		expect((await service.upload(bytes, uploadMetadata(bytes))).status).toBe(200);
		expect(service.state.effects).toBe(1);
	});
	it("stages a protected file and applies only after its explicit review", async () => {
		const service = await fixture(),
			bytes = Buffer.from([0, 255]);
		service.state.protected = true;
		const response = await service.upload(bytes, uploadMetadata(bytes));
		expect(response.status).toBe(200);
		expect(record(await response.json()).state).toBe("review_required");
		expect(service.state.effects).toBe(0);
		expect(
			(await service.request(`edits/${commandId}/review`, { planSha256: "a".repeat(64), decision: "approve" }))
				.status,
		).toBe(200);
		expect(service.state.effects).toBe(1);
	});
	it.each([
		"qorpera_begin_member_company_file_upload",
		"qorpera_stage_member_company_path_object",
		"qorpera_verify_company_path_file",
		"qorpera_prepare_member_company_path_command",
	])("retains denial at %s without application", async (method) => {
		const service = await fixture(),
			bytes = Buffer.from([0, 255]);
		service.state.denyMethod = method;
		expect((await service.upload(bytes, uploadMetadata(bytes))).status).toBe(403);
		expect(service.state.effects).toBe(0);
		if (method === "qorpera_begin_member_company_file_upload") expect(service.publisher).not.toHaveBeenCalled();
	});
	it("rejects bytes or chunk identities inconsistent with the admitted source before any staging", async () => {
		const service = await fixture(),
			bytes = Buffer.from([0, 255]);
		const metadata = uploadMetadata(bytes);
		expect((await service.upload(Buffer.from([1, 255]), metadata)).status).toBe(400);
		expect(service.publisher).not.toHaveBeenCalled();
		metadata.manifest.chunks[0].sha256 = "a".repeat(64);
		const separate = await fixture();
		expect((await separate.upload(bytes, metadata)).status).toBe(400);
		expect(separate.publisher).not.toHaveBeenCalled();
	});
	it.each(["realm", "name", "length", "extra", "chunks"])(
		"rejects invalid %s metadata before admission",
		async (kind) => {
			const service = await fixture(),
				bytes = Buffer.from([0, 255]),
				metadata = uploadMetadata(bytes);
			if (kind === "realm") metadata.source.realm = "company_computer";
			if (kind === "name") metadata.source.name = "../local.bin";
			if (kind === "length") metadata.source.bytes = 8 * 1024 * 1024 + 1;
			if (kind === "extra") Object.assign(metadata.source, { localPath: "/private/local.bin" });
			if (kind === "chunks") metadata.manifest.chunks[0].bytes = 4 * 1024 * 1024 + 1;
			expect((await service.upload(bytes, metadata)).status).toBe(400);
			expect(service.member).not.toHaveBeenCalled();
			expect(service.publisher).not.toHaveBeenCalled();
		},
	);
	it("refuses a different selected name when retrying the same bytes", async () => {
		const service = await fixture(),
			bytes = Buffer.from([0, 255]),
			metadata = uploadMetadata(bytes);
		expect((await service.upload(bytes, metadata)).status).toBe(200);
		metadata.source.name = "different.bin";
		expect((await service.upload(bytes, metadata)).status).toBe(409);
		expect(service.state.effects).toBe(1);
	});
});

describe("cloud-owned human Company File edits", () => {
	it("resumes an exact ordinary intent after interrupted publication without inventing approval", async () => {
		const service = await fixture();
		service.state.denyMethod = "qorpera_prepare_member_company_path_command";
		expect((await service.request("edits", edit)).status).toBe(403);
		expect(service.state.current?.state).toBe("ready");
		service.state.denyMethod = "qorpera_review_member_company_path_command";
		expect(
			(await service.request(`edits/${commandId}/review`, { planSha256: "a".repeat(64), decision: "approve" }))
				.status,
		).toBe(200);
		expect(service.state.effects).toBe(1);
		expect(service.member).not.toHaveBeenCalledWith(
			"qorpera_review_member_company_path_command",
			expect.anything(),
			expect.anything(),
			expect.anything(),
		);
	});
	it("stages verified immutable bytes and publishes only the exact human plan", async () => {
		const service = await fixture();
		const response = await service.request("edits", edit);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		const receipt = record(await response.json());
		expect(receipt.state).toBe("applied");
		expect(receipt).not.toHaveProperty("entries");
		expect(service.state.effects).toBe(1);
		const entry = record(record(receipt.plan).entry);
		const file = record(entry.file);
		expect(
			Buffer.from(
				await service.store.get(companyId, String(file.fileSha256), Buffer.byteLength(edit.text)),
			).toString(),
		).toBe(edit.text);
		expect(await service.replication.status()).toMatchObject({ pending: 3, blocked: 0 });
		expect(service.publisher).toHaveBeenCalledWith(
			"qorpera_apply_member_company_path_command_v3",
			expect.objectContaining({ p_document_text: null }),
			expect.anything(),
		);
	});

	it("passes exact verified organization bytes only to the organization-aware publisher", async () => {
		const service = await fixture();
		const formation = JSON.stringify({
			schema: "qorpera.company-formation/v1",
			formationId: commandId,
			cofounderStaffAgentId: version,
			state: "source_inventory",
			status: "active",
			revision: 1,
		});
		expect(
			(
				await service.request("edits", {
					...edit,
					path: "Organization/Formation.json",
					text: formation,
				})
			).status,
		).toBe(200);
		expect(service.publisher).toHaveBeenCalledWith(
			"qorpera_apply_member_company_path_command_v3",
			expect.objectContaining({ p_document_text: formation }),
			expect.anything(),
		);
	});

	it("passes exact canonical agent bytes to the same atomic projection transaction", async () => {
		const service = await fixture();
		const agentId = "29500000-0000-4000-8000-000000000070";
		const document = JSON.stringify({
			schema: "qorpera.company-agent/v1",
			agentId,
			revision: 1,
			displayName: "Operations",
			role: "Own operations",
			hireOverlay: { charter: "Keep the company operating.", templateId: null },
			appearance: { color: "blue", shape: "round", creature: null },
			modelPolicy: { provider: null, modelId: null },
			reasoningPolicy: { effort: "low" },
			grants: { responsibilities: [], projects: [], rooms: [], resources: [] },
			startupInstructions: "Begin the assigned work once.",
			employmentStatus: "active",
			lifecycleState: "setup",
			createdAt: "2026-08-29T08:00:00.000Z",
		});
		expect(
			(
				await service.request("edits", {
					...edit,
					path: `organization/agents/${agentId}.json`,
					text: document,
				})
			).status,
		).toBe(200);
		expect(service.publisher).toHaveBeenCalledWith(
			"qorpera_apply_member_company_path_command_v3",
			expect.objectContaining({ p_document_text: document }),
			expect.anything(),
		);
	});

	it("passes exact canonical room bytes to the same atomic projection transaction", async () => {
		const service = await fixture();
		const roomId = "29500000-0000-4000-8000-000000000080";
		const document = JSON.stringify({
			schema: "qorpera.company-room/v1",
			roomId,
			key: "acceptance",
			name: "Acceptance room",
			purpose: "Bounded room conversation.",
			status: "active",
			projectId: null,
			members: [{ kind: "staff_agent", id: "29500000-0000-4000-8000-000000000070" }],
			version: 1,
		});
		expect(
			(
				await service.request("edits", {
					...edit,
					path: `organization/rooms/${roomId}.json`,
					text: document,
				})
			).status,
		).toBe(200);
		expect(service.publisher).toHaveBeenCalledWith(
			"qorpera_apply_member_company_path_command_v3",
			expect.objectContaining({ p_document_text: document }),
			expect.anything(),
		);
	});

	it("recovers a lost acknowledgement without staging or applying a second effect", async () => {
		const service = await fixture();
		service.state.loseApply = true;
		expect((await service.request("edits", edit)).status).toBe(503);
		const calls = vi.mocked(service.publisher).mock.calls.length;
		const retry = await service.request("edits", edit);
		expect(retry.status).toBe(200);
		expect(record(await retry.json()).state).toBe("applied");
		expect(service.state.effects).toBe(1);
		expect(vi.mocked(service.publisher).mock.calls).toHaveLength(calls);
	});

	it("does not repurpose an operation key or trust a changed command plan", async () => {
		const service = await fixture();
		expect((await service.request("edits", edit)).status).toBe(200);
		expect((await service.request("edits", { ...edit, text: "other" })).status).toBe(409);
		const tampered = await fixture();
		tampered.state.tamperPlan = true;
		expect((await tampered.request("edits", edit)).status).toBe(503);
		expect(tampered.publisher).not.toHaveBeenCalled();
	});

	it("rebuilds only an explicitly rolled-back head conflict", async () => {
		const service = await fixture();
		service.state.conflict = true;
		expect((await service.request("edits", edit)).status).toBe(200);
		expect(service.state.effects).toBe(1);
		expect(
			vi
				.mocked(service.publisher)
				.mock.calls.filter(([name]) => name === "qorpera_apply_member_company_path_command_v3"),
		).toHaveLength(2);
	});

	it.each(["qorpera_begin_member_company_path_command", "qorpera_apply_member_company_path_command_v3"])(
		"returns a stale precondition from %s without retrying or applying work",
		async (method) => {
			const service = await fixture();
			service.state.denyMethod = method;
			service.state.denialStatus = 412;
			expect((await service.request("edits", edit)).status).toBe(412);
			expect(service.state.effects).toBe(0);
			const calls = [...vi.mocked(service.member).mock.calls, ...vi.mocked(service.publisher).mock.calls];
			expect(calls.filter(([name]) => name === method)).toHaveLength(1);
			if (method === "qorpera_begin_member_company_path_command") {
				expect(service.publisher).not.toHaveBeenCalled();
				expect(await service.replication.status()).toMatchObject({ pending: 0 });
			}
		},
	);

	it.each([
		"qorpera_begin_member_company_path_command",
		"qorpera_stage_member_company_path_object",
		"qorpera_prepare_member_company_path_command",
		"qorpera_apply_member_company_path_command_v3",
	])("fails closed when authority is denied at %s", async (method) => {
		const service = await fixture();
		service.state.denyMethod = method;
		expect((await service.request("edits", edit)).status).toBe(403);
		expect(service.state.effects).toBe(0);
	});

	it.each(["synthetic-control", "synthetic-verifier", "synthetic-native", "another-human"])(
		"does not accept %s as human authority",
		async (bearer) => {
			const service = await fixture();
			expect((await service.request("edits", edit, bearer)).status).toBe(403);
			expect(service.publisher).not.toHaveBeenCalled();
		},
	);

	it.each(["reject", "skip"])("keeps protected work unapplied when review is %s", async (decision) => {
		const service = await fixture();
		service.state.protected = true;
		const pending = record(await (await service.request("edits", edit)).json());
		expect(pending.state).toBe("review_required");
		expect(service.state.effects).toBe(0);
		expect(
			(await service.request(`edits/${commandId}/review`, { planSha256: pending.planSha256, decision })).status,
		).toBe(200);
		expect(service.state.current?.state).toBe("rejected");
		expect(service.state.effects).toBe(0);
	});

	it("requires exact approval and current authority for protected edits", async () => {
		const service = await fixture();
		service.state.protected = true;
		await service.request("edits", edit);
		expect(
			(await service.request(`edits/${commandId}/review`, { planSha256: "c".repeat(64), decision: "approve" }))
				.status,
		).toBe(400);
		expect(
			(await service.request(`edits/${commandId}/review`, { planSha256: "a".repeat(64), decision: "approve" }))
				.status,
		).toBe(200);
		expect(service.state.effects).toBe(1);
	});

	it("applies a separately authorized native proposal through the same publisher", async () => {
		const service = await fixture();
		expect(
			(await service.request(`proposals/${proposalId}/review`, { planSha256: "b".repeat(64), decision: "approve" }))
				.status,
		).toBe(200);
		expect(service.state.effects).toBe(1);
		expect(vi.mocked(service.publisher).mock.calls.map(([method]) => method)).toContain(
			"qorpera_apply_company_path_approval_v3",
		);
	});

	it("passes an approved organization proposal's exact stored bytes to the projection transaction", async () => {
		const service = await fixture();
		const document = Buffer.from(
			JSON.stringify({
				schema: "qorpera.company-formation/v1",
				formationId: commandId,
				cofounderStaffAgentId: version,
				state: "source_inventory",
				status: "active",
				revision: 1,
			}),
		);
		const digest = createHash("sha256").update(document).digest("hex");
		service.state.proposalPlan = {
			schema: "qorpera.company-path-mutation/v1",
			operationKey: "native-formation-proposal",
			path: "organization/formation.json",
			expectedVersion: null,
			entry: {
				path: "organization/formation.json",
				kind: "file",
				executable: false,
				file: {
					manifestSha256: "c".repeat(64),
					fileSha256: digest,
					bytes: document.length,
					mediaType: "application/octet-stream",
				},
			},
		};
		await service.store.put(companyId, digest, document);
		expect(
			(await service.request(`proposals/${proposalId}/review`, { planSha256: "b".repeat(64), decision: "approve" }))
				.status,
		).toBe(200);
		expect(service.publisher).toHaveBeenCalledWith(
			"qorpera_apply_company_path_approval_v3",
			expect.objectContaining({ p_document_text: document.toString("utf8") }),
			expect.anything(),
		);
	});

	it.each(["reject", "skip"])("does not apply a native proposal after %s", async (decision) => {
		const service = await fixture();
		expect(
			(await service.request(`proposals/${proposalId}/review`, { planSha256: "b".repeat(64), decision })).status,
		).toBe(200);
		expect(service.publisher).not.toHaveBeenCalled();
	});

	it.each([
		{ ...edit, text: "x".repeat(32769) },
		{ ...edit, binding: { runId: version } },
		{ ...edit, operation: "execute" },
		{ ...edit, executable: true },
		{ ...edit, expectedVersion: "head" },
	])("rejects overbroad edit payloads before authority: %j", async (payload) => {
		const service = await fixture();
		expect((await service.request("edits", payload)).status).toBe(400);
		expect(service.member).not.toHaveBeenCalled();
	});

	it("supports an empty UTF-8 file without inventing an empty chunk", async () => {
		const service = await fixture();
		expect((await service.request("edits", { ...edit, text: "" })).status).toBe(200);
		expect(await service.replication.status()).toMatchObject({ pending: 2, blocked: 0 });
	});

	it("links applied human requests to canonical commands without storing text, path or credential metadata", async () => {
		const service = await fixture();
		const response = await service.request("edits", edit);
		const body = await response.text();
		const result = service.observations.snapshot({ limit: 10, commandId });
		expect(result.observations).toHaveLength(1);
		expect(result.observations[0]).toMatchObject({
			operation: "command_submit",
			commandId,
			companyId,
			environmentId,
			actorUserId: null,
			resourceId: null,
			responseOutcome: "succeeded",
			effectOutcome: "applied",
			requestBodyBytes: Buffer.byteLength(JSON.stringify(edit)),
			responseBodyBytes: Buffer.byteLength(body),
			logicalWriteInputBytes: Buffer.byteLength(edit.text),
			logicalObjectReadBytes: null,
		});
		for (const forbidden of [token, edit.path, edit.text, edit.operationKey, "a".repeat(64), "fixture-secret"])
			expect(JSON.stringify(result)).not.toContain(forbidden);
		expect(service.state.effects).toBe(1);
	});

	it("does not attribute a caller's intended company or command before canonical authorization", async () => {
		const service = await fixture();
		await (await service.request(`edits/${commandId}`, undefined, "other-member")).text();
		expect(service.observations.snapshot({ limit: 1 }).observations[0]).toMatchObject({
			companyId: null,
			environmentId: null,
			commandId: null,
			actorUserId: null,
			responseOutcome: "denied",
			errorCategory: "forbidden",
			effectOutcome: "none",
		});
		expect(service.publisher).not.toHaveBeenCalled();
	});

	it("preserves a confirmed effect when the final member read is denied", async () => {
		const service = await fixture();
		service.state.denyMethod = "qorpera_get_member_company_path_command";
		const response = await service.request("edits", edit);
		expect(response.status).toBe(403);
		await response.text();
		expect(service.observations.snapshot({ limit: 1 }).observations[0]).toMatchObject({
			commandId,
			effectOutcome: "applied",
			responseOutcome: "denied",
			errorCategory: "forbidden",
		});
		expect(service.state.effects).toBe(1);
		expect(
			vi
				.mocked(service.publisher)
				.mock.calls.filter(([method]) => method === "qorpera_apply_member_company_path_command_v3"),
		).toHaveLength(1);
	});

	it("keeps a lost acknowledgement unconfirmed and a subsequent exact replay separate", async () => {
		const service = await fixture();
		service.state.loseApply = true;
		await (await service.request("edits", edit)).text();
		expect(service.observations.snapshot({ limit: 1 }).observations[0]).toMatchObject({
			commandId,
			effectOutcome: "unconfirmed",
			responseOutcome: "failed",
		});
		const previous = vi.mocked(service.publisher).mock.calls.length;
		await (await service.request("edits", edit)).text();
		expect(service.observations.snapshot({ limit: 10 }).observations.map((row) => row.effectOutcome)).toEqual([
			"replayed",
			"unconfirmed",
		]);
		expect(service.state.effects).toBe(1);
		expect(service.publisher).toHaveBeenCalledTimes(previous);
	});

	it("records a proposed human edit separately from review and application", async () => {
		const service = await fixture();
		service.state.protected = true;
		await (await service.request("edits", edit)).text();
		expect(service.observations.snapshot({ limit: 1 }).observations[0]).toMatchObject({
			commandId,
			effectOutcome: "proposed",
			responseOutcome: "succeeded",
		});
		await (
			await service.request(`edits/${commandId}/review`, { planSha256: "a".repeat(64), decision: "approve" })
		).text();
		expect(
			service.observations.snapshot({ limit: 2 }).observations.map((row) => [row.operation, row.effectOutcome]),
		).toEqual([
			["command_review", "applied"],
			["command_submit", "proposed"],
		]);
	});

	it("retains the canonical proposal result when its separate response-release check fails", async () => {
		const service = await fixture();
		const original = vi.mocked(service.member).getMockImplementation()!;
		vi.mocked(service.member).mockImplementation(async (...args) => {
			if (args[0] === "qorpera_describe_member_company_path_proposal" && service.state.proposalState === "applied")
				throw new ObjectDependencyError(403);
			return original(...args);
		});
		const response = await service.request(`proposals/${proposalId}/review`, {
			planSha256: "b".repeat(64),
			decision: "approve",
		});
		expect(response.status).toBe(403);
		await response.text();
		expect(service.observations.snapshot({ limit: 1 }).observations[0]).toMatchObject({
			proposalId,
			companyId,
			environmentId,
			operation: "proposal_review",
			effectOutcome: "applied",
			responseOutcome: "denied",
			errorCategory: "forbidden",
		});
		expect(service.state.effects).toBe(1);
	});

	it("measures reviewed-command immutable content without calling it whole-file or NAS traffic", async () => {
		const service = await fixture();
		service.state.protected = true;
		await (await service.request("edits", edit)).text();
		const response = await service.request(`edits/${commandId}/content`);
		expect(response.status).toBe(200);
		await response.text();
		expect(service.observations.snapshot({ limit: 1 }).observations[0]).toMatchObject({
			operation: "command_content",
			commandId,
			companyId,
			logicalObjectReadBytes: Buffer.byteLength(edit.text),
			effectOutcome: "none",
		});
	});

	it("measures a proposal's immutable content with canonical proposal linkage", async () => {
		const service = await fixture();
		const bytes = Buffer.from("PRIVATE_PROPOSAL_CONTENT");
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		service.state.proposalPlan.entry = {
			path: "note.md",
			kind: "file",
			executable: false,
			file: {
				fileSha256: sha256,
				manifestSha256: "c".repeat(64),
				bytes: bytes.length,
				mediaType: "application/octet-stream",
			},
		};
		await service.store.put(companyId, sha256, bytes);
		const response = await service.request(`proposals/${proposalId}/content`);
		expect(response.status).toBe(200);
		await response.text();
		const result = service.observations.snapshot({ limit: 1 });
		expect(result.observations[0]).toMatchObject({
			operation: "proposal_content",
			proposalId,
			companyId,
			logicalObjectReadBytes: bytes.length,
			effectOutcome: "none",
		});
		expect(JSON.stringify(result)).not.toContain(bytes.toString());
		expect(JSON.stringify(result)).not.toContain(sha256);
	});
});

describe("human and publisher transport separation", () => {
	it("keeps service credentials out of member RPCs and member credentials out of publication", async () => {
		const requests: Request[] = [];
		const authority = new SupabaseMemberCompanyAuthority({
			projectUrl: "https://cloud.test",
			publishableKey: "public-fixture",
			secretKey: "secret-fixture",
			fetch: async (input, init) => {
				requests.push(new Request(input, init));
				return Response.json({});
			},
		});
		await authority.member("qorpera_get_member_company_path_command", token, {}, new AbortController().signal);
		await authority.publisher("qorpera_prepare_member_company_path_command", {}, new AbortController().signal);
		expect(
			requests.map((request) => [
				request.headers.get("apikey"),
				request.headers.get("authorization"),
				request.redirect,
			]),
		).toEqual([
			["public-fixture", `Bearer ${token}`, "error"],
			["secret-fixture", null, "error"],
		]);
	});

	it.each([
		[409, "PT409", true, 409],
		[409, "23505", false, 409],
		[500, "40001", false, 409],
		[409, "QRC01", false, 409],
		[412, "PT412", false, 412],
	] as const)("classifies %s/%s without retrying uncertainty", async (status, code, rebuild, expectedStatus) => {
		const authority = new SupabaseMemberCompanyAuthority({
			projectUrl: "https://cloud.test",
			publishableKey: "public",
			secretKey: "secret",
			fetch: async () => Response.json({ code }, { status }),
		});
		const error = await authority
			.publisher("qorpera_apply_member_company_path_command_v3", {}, new AbortController().signal)
			.catch((failure: unknown) => failure);
		expect(error).toBeInstanceOf(ObjectDependencyError);
		expect(error).toMatchObject({ status: expectedStatus });
		expect(error instanceof MemberCompanyHeadConflict).toBe(rebuild);
	});

	it("preserves a denial without waiting for its body", async () => {
		const authority = new SupabaseMemberCompanyAuthority({
			projectUrl: "https://cloud.test",
			publishableKey: "public",
			secretKey: "secret",
			requestTimeoutMs: 100,
			fetch: async () => new Response(new ReadableStream(), { status: 403 }),
		});
		await expect(
			authority.member("qorpera_get_member_company_path_command", token, {}, new AbortController().signal),
		).rejects.toMatchObject({ status: 403 });
	});
});
