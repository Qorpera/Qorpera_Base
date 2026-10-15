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

const profileId = "29600000-0000-4000-8000-000000000010";
const environmentId = "29600000-0000-4000-8000-000000000020";
const userId = "29600000-0000-4000-8000-000000000030";
const sessionId = "29600000-0000-4000-8000-000000000060";
/** The id the web gives a message before it posts it; the upload names it. */
const clientInputId = "29600000-0000-4000-8000-000000000070";
/** The posted message's id; the read names it. */
const inputId = "29600000-0000-4000-8000-000000000080";
const otherInputId = "29600000-0000-4000-8000-000000000090";
const bytes = Buffer.from("PNG_BYTES");
const digest = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const sha256 = digest(bytes);
const token = "synthetic-member-jwt";
const imagePath = (id: string) => `group-chats/launch/images/${id}/${sha256}.png`;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** The gateway with a fake database: the chat image functions of 20260930260000 and the folder core's staging. */
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "qorpera-chat-image-"));
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
		posted: false,
		revoked: false,
		refuseCommit: false,
		tamperBegin: false,
		tamperDownload: false,
		platformWriter: false,
	};
	const manifests = new Map<string, string>();
	const confirmed = new Map<string, number>();
	const files = new Map<string, Record<string, unknown>>();
	let intents = 0;
	const member: MemberCompanyAuthority["member"] = vi.fn(async (method, memberToken, args) => {
		if (memberToken !== token || state.revoked) throw new ObjectDependencyError(403);
		switch (method) {
			case "qorpera_room_image_begin":
				if (args.p_session_id !== sessionId) throw new ObjectDependencyError(403);
				return {
					schema: "qorpera.room-image-begin/v1",
					environmentId,
					sessionId: state.tamperBegin ? environmentId : sessionId,
					clientInputId: args.p_client_input_id,
					sha256: args.p_sha256,
					bytes: args.p_bytes,
					mediaType: args.p_media_type,
					path: imagePath(args.p_client_input_id as string),
				};
			case "qorpera_member_folder_writer":
				expect(args).toEqual({ p_environment_id: environmentId });
				return {
					schema: "qorpera.member-folder-writer/v1",
					actor: state.platformWriter ? { kind: "platform" } : { kind: "member", userId },
					profileId,
				};
			case "qorpera_room_image_download": {
				// One image of a posted message, found under the id it was uploaded with.
				const file = files.get(imagePath(clientInputId));
				if (!state.posted || args.p_session_id !== sessionId || args.p_input_id !== inputId || !file)
					throw new ObjectDependencyError(403);
				if (args.p_sha256 !== file.fileSha256) throw new ObjectDependencyError(403);
				return {
					schema: "qorpera.room-image-download/v1",
					environmentId,
					sessionId,
					inputId,
					sha256: args.p_sha256,
					bytes: file.bytes,
					mediaType: file.mediaType,
					manifestSha256: file.manifestSha256,
					fileSha256: state.tamperDownload ? digest("OTHER_BYTES") : file.fileSha256,
					path: imagePath(clientInputId),
				};
			}
		}
		throw new Error(`Unexpected member RPC ${method}`);
	});
	const publisher: MemberCompanyAuthority["publisher"] = vi.fn(async (method, args) => {
		// The bytes move as the platform; only the save names the member.
		if (method !== "qorpera_room_image_commit") expect(args.p_actor).toEqual({ kind: "platform" });
		switch (method) {
			case "qorpera_folder_open_upload": {
				const intentId = `29600000-0000-4000-8000-${String(++intents).padStart(12, "0")}`;
				manifests.set(intentId, args.p_manifest as string);
				return {
					schema: "qorpera.folder-upload/v1",
					intentId,
					manifestSha256: digest(args.p_manifest as string),
					expiresAt: "x",
					present: [],
				};
			}
			case "qorpera_folder_authorize_object_upload":
				expect(args.p_environment_id).toBe(environmentId);
				return { schema: "qorpera.folder-object-upload/v1", profileId };
			case "qorpera_folder_confirm_object":
				confirmed.set(args.p_sha256 as string, args.p_bytes as number);
				return { schema: "qorpera.folder-object/v1", sha256: args.p_sha256, bytes: args.p_bytes };
			case "qorpera_folder_seal_upload": {
				const manifest = manifests.get(args.p_intent as string) as string;
				const parsed = JSON.parse(manifest);
				return {
					schema: "qorpera.folder-seal/v1",
					state: "sealed",
					intentId: args.p_intent,
					file: {
						manifestSha256: digest(manifest),
						fileSha256: parsed.fileSha256,
						bytes: parsed.bytes,
						mediaType: parsed.mediaType,
						executable: parsed.executable,
					},
				};
			}
			case "qorpera_folder_authorize_object_download": {
				const size = confirmed.get(args.p_sha256 as string);
				if (size === undefined) throw new ObjectDependencyError(403);
				return { schema: "qorpera.folder-object-download/v1", profileId, bytes: size };
			}
			case "qorpera_room_image_commit": {
				if (state.refuseCommit) throw new ObjectDependencyError(403);
				const file = args.p_file as Record<string, unknown>;
				const path = imagePath(args.p_client_input_id as string);
				files.set(path, file);
				return {
					schema: "qorpera.room-image/v1",
					sha256: file.fileSha256,
					bytes: file.bytes,
					mediaType: file.mediaType,
					path,
				};
			}
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
		files,
		member,
		publisher,
		replication,
		async request(kind = "upload", body: Buffer | null = bytes, bearer = token, id?: string) {
			const input = id ?? (kind === "upload" ? clientInputId : inputId);
			return fetch(
				`http://127.0.0.1:${address.port}/v1/member-session-attachments/${kind}/${sessionId}/${input}/${sha256}`,
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

describe("a member's chat images on folder-v2", () => {
	it("stages the bytes as the platform, saves them for the member and serves them once posted", async () => {
		const service = await fixture();
		expect((await service.request("input", null)).status).toBe(403);
		const upload = await service.request();
		expect(upload.status).toBe(200);
		expect(upload.headers.get("cache-control")).toBe("private, no-store");
		expect(await upload.json()).toEqual({ sha256, bytes: bytes.length, mediaType: "image/png" });
		// The read, the begin and the writer check ran with the member's own token.
		expect(vi.mocked(service.member).mock.calls.map(([method, bearer, args]) => [method, bearer, args])).toEqual([
			["qorpera_room_image_download", token, { p_session_id: sessionId, p_input_id: inputId, p_sha256: sha256 }],
			[
				"qorpera_room_image_begin",
				token,
				{
					p_session_id: sessionId,
					p_client_input_id: clientInputId,
					p_sha256: sha256,
					p_bytes: bytes.length,
					p_media_type: "image/png",
				},
			],
			["qorpera_member_folder_writer", token, { p_environment_id: environmentId }],
		]);
		// The save names the member the database answered, and exactly the file staged.
		const commit = vi.mocked(service.publisher).mock.calls.find(([method]) => method === "qorpera_room_image_commit");
		expect(commit?.[1]).toEqual({
			p_user_id: userId,
			p_session_id: sessionId,
			p_client_input_id: clientInputId,
			p_file: {
				manifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
				fileSha256: sha256,
				bytes: bytes.length,
				mediaType: "image/png",
				executable: false,
			},
		});
		expect([...service.files.keys()]).toEqual([imagePath(clientInputId)]);
		// Saved but not posted: nobody reads it yet.
		expect((await service.request("input", null)).status).toBe(403);
		service.state.posted = true;
		const download = await service.request("input", null);
		expect(download.status).toBe(200);
		expect(download.headers.get("content-type")).toBe("application/octet-stream");
		expect(download.headers.get("cache-control")).toBe("private, no-store");
		expect(download.headers.get("x-content-type-options")).toBe("nosniff");
		expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);
		// The image and its manifest wait for their replica.
		expect(await service.replication.status()).toMatchObject({ pending: 2, blocked: 0 });
	});
	it("cannot turn possession of a hash into possession of bytes", async () => {
		const service = await fixture();
		await service.store.put(profileId, sha256, bytes);
		expect((await service.request("upload", Buffer.from("BAD_BYTES"))).status).toBe(400);
		expect(service.publisher).not.toHaveBeenCalled();
		expect((await service.request("upload", null)).status).toBe(405);
		service.state.posted = true;
		expect((await service.request("input", null)).status).toBe(403);
	});
	it.each(["synthetic-control", "synthetic-verifier", "synthetic-native", "other-member"])(
		"does not accept %s as member authority",
		async (bearer) => {
			const service = await fixture();
			expect((await service.request("upload", bytes, bearer)).status).toBe(403);
			expect(service.publisher).not.toHaveBeenCalled();
		},
	);
	it("saves nothing without a member the writer check names", async () => {
		const service = await fixture();
		service.state.platformWriter = true;
		expect((await service.request()).status).toBe(403);
		expect(service.publisher).not.toHaveBeenCalled();
	});
	it("leaves no image when the database refuses the save", async () => {
		const service = await fixture();
		service.state.refuseCommit = true;
		expect((await service.request()).status).toBe(403);
		expect(service.files.size).toBe(0);
		service.state.posted = true;
		expect((await service.request("input", null)).status).toBe(403);
	});
	it("rechecks access after the read without serving revoked bytes", async () => {
		const service = await fixture();
		expect((await service.request()).status).toBe(200);
		service.state.posted = true;
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
	it("refuses a changed database answer before any bytes move", async () => {
		const service = await fixture();
		service.state.tamperBegin = true;
		expect((await service.request()).status).toBe(503);
		expect(service.publisher).not.toHaveBeenCalled();
		service.state.tamperBegin = false;
		expect((await service.request()).status).toBe(200);
		service.state.posted = true;
		service.state.tamperDownload = true;
		const get = vi.spyOn(service.store, "get");
		expect((await service.request("input", null)).status).toBe(503);
		expect(get).not.toHaveBeenCalled();
	});
	it("does not let another message borrow the image", async () => {
		const service = await fixture();
		expect((await service.request()).status).toBe(200);
		service.state.posted = true;
		expect((await service.request("input", null, token, otherInputId)).status).toBe(403);
		expect((await service.request("input", null, token, clientInputId)).status).toBe(403);
	});
});
