import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObjectDependencyError } from "../src/dependency.ts";
import { ObjectGatewayJournal } from "../src/journal.ts";
import type { MemberCompanyAuthority } from "../src/member-company-authority.ts";
import { FileSystemObjectStore } from "../src/object-store.ts";
import { ObjectGatewayReplication } from "../src/replication.ts";
import { createObjectGatewayHandler } from "../src/service.ts";
import { SupabaseObjectAuthority } from "../src/supabase-authority.ts";

const companyId = "29600000-0000-4000-8000-000000000010";
const sessionId = "29600000-0000-4000-8000-000000000060";
const inputId = "29600000-0000-4000-8000-000000000070";
const uploadId = "29600000-0000-4000-8000-000000000080";
const bytes = Buffer.from("PNG_BYTES");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const token = "synthetic-member-jwt";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "qorpera-chat-attachment-"));
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
	const state = {
		verified: false,
		canonical: false,
		revoked: false,
		denyStage: false,
		loseConfirm: false,
		tamperScope: false,
		confirms: 0,
	};
	const member: MemberCompanyAuthority["member"] = vi.fn(async (method, memberToken, args) => {
		if (memberToken !== token || state.revoked || args.p_session_id !== sessionId || args.p_sha256 !== sha256)
			throw new ObjectDependencyError(403);
		if (method === "qorpera_begin_member_session_attachment_upload") {
			if (args.p_client_input_id !== inputId || args.p_bytes !== bytes.length || args.p_media_type !== "image/png")
				throw new ObjectDependencyError(403);
			state.verified = false;
			return {
				companyId,
				sessionId: state.tamperScope ? companyId : sessionId,
				clientInputId: inputId,
				sha256,
				bytes: bytes.length,
				mediaType: "image/png",
				uploadId,
			};
		}
		if (method === "qorpera_authorize_member_session_attachment") {
			if (!state.canonical || !state.verified || args.p_input_id !== inputId) throw new ObjectDependencyError(403);
			return {
				companyId,
				sessionId: state.tamperScope ? companyId : sessionId,
				inputId,
				sha256,
				bytes: bytes.length,
				mediaType: "image/png",
			};
		}
		throw new Error(`Unexpected member RPC ${method}`);
	});
	const publisher: MemberCompanyAuthority["publisher"] = vi.fn(async (method, args) => {
		if (state.revoked || state.denyStage || args.p_upload_id !== uploadId) throw new ObjectDependencyError(403);
		if (method !== "qorpera_stage_member_session_attachment") throw new Error(`Unexpected publisher RPC ${method}`);
		if (args.p_confirm) {
			expect(Buffer.from(await store.get(companyId, sha256, bytes.length))).toEqual(bytes);
			state.verified = true;
			state.confirms++;
			if (state.loseConfirm) {
				state.loseConfirm = false;
				throw new ObjectDependencyError(503);
			}
		}
		return companyId;
	});
	const server = createServer(
		createObjectGatewayHandler({
			store,
			authority: objects,
			replication,
			controlToken: "synthetic-control",
			verifierToken: "synthetic-verifier",
			memberFiles: { member, publisher },
		}),
	);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing fixture port");
	cleanups.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(root, { recursive: true, force: true });
	});
	return {
		state,
		store,
		member,
		publisher,
		replication,
		async request(kind = "upload", body: Buffer | null = bytes, bearer = token, requestedInput = inputId) {
			return fetch(
				`http://127.0.0.1:${address.port}/v1/member-session-attachments/${kind}/${sessionId}/${requestedInput}/${sha256}`,
				{
					method: body ? "PUT" : "GET",
					headers: {
						authorization: `Bearer ${bearer}`,
						...(body ? { "content-type": "image/png", "content-length": String(body.length) } : {}),
					},
					...(body ? { body } : {}),
				},
			);
		},
	};
}

describe("input-scoped chat attachment gateway", () => {
	it("requires actual bytes for upload proof and canonical input for subsequent reads", async () => {
		const service = await fixture();
		expect((await service.request("input", null)).status).toBe(403);
		const upload = await service.request();
		expect(upload.status).toBe(200);
		expect(await upload.json()).toEqual({ sha256, bytes: bytes.length, mediaType: "image/png" });
		expect(service.state.verified).toBe(true);
		expect((await service.request("input", null)).status).toBe(403);
		service.state.canonical = true;
		const download = await service.request("input", null);
		expect(download.status).toBe(200);
		expect(download.headers.get("cache-control")).toBe("private, no-store");
		expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);
		expect(await service.replication.status()).toMatchObject({ pending: 1, blocked: 0 });
	});
	it("cannot turn possession of a hash into possession of bytes", async () => {
		const service = await fixture();
		await service.store.put(companyId, sha256, bytes);
		expect((await service.request("upload", Buffer.from("BAD_BYTES"))).status).toBe(400);
		expect(service.publisher).not.toHaveBeenCalled();
		expect(service.state.verified).toBe(false);
		expect((await service.request("upload", null)).status).toBe(405);
	});
	it.each(["synthetic-control", "synthetic-verifier", "synthetic-native", "other-member"])(
		"does not accept %s as member authority",
		async (bearer) => {
			const service = await fixture();
			expect((await service.request("upload", bytes, bearer)).status).toBe(403);
			expect(service.publisher).not.toHaveBeenCalled();
		},
	);
	it("requires current service-side original-member authority before staging", async () => {
		const service = await fixture();
		service.state.denyStage = true;
		expect((await service.request()).status).toBe(403);
		expect(service.state.verified).toBe(false);
		await expect(service.store.get(companyId, sha256, bytes.length)).rejects.toThrow("Object not found");
	});
	it("recovers an uncertain upload acknowledgement only by re-supplying the exact bytes", async () => {
		const service = await fixture();
		service.state.loseConfirm = true;
		expect((await service.request()).status).toBe(503);
		expect(service.state.verified).toBe(true);
		expect((await service.request("input", null)).status).toBe(403);
		expect((await service.request()).status).toBe(200);
		expect(await service.replication.status()).toMatchObject({ pending: 1 });
	});
	it("rechecks membership after object I/O without returning revoked bytes", async () => {
		const service = await fixture();
		await service.request();
		service.state.canonical = true;
		const get = service.store.get.bind(service.store);
		vi.spyOn(service.store, "get").mockImplementationOnce(async (...args) => {
			const result = await get(...args);
			service.state.revoked = true;
			return result;
		});
		const response = await service.request("input", null);
		expect(response.status).toBe(403);
		expect(await response.text()).not.toContain("PNG_BYTES");
	});
	it("rejects changed authority identity before object access", async () => {
		const service = await fixture();
		service.state.tamperScope = true;
		expect((await service.request()).status).toBe(503);
		expect(service.publisher).not.toHaveBeenCalled();
	});
	it("does not let another input borrow the upload", async () => {
		const service = await fixture();
		await service.request();
		service.state.canonical = true;
		expect((await service.request("input", null, token, uploadId)).status).toBe(403);
	});
});
