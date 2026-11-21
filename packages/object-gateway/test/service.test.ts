import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileSystemObjectStore } from "../src/object-store.ts";
import type { ObjectGatewayReplication } from "../src/replication.ts";
import { createObjectGatewayHandler, type ObjectGatewayServiceOptions } from "../src/service.ts";
import type { ObjectDeletionAuthorization, ObjectGatewayAuthority } from "../src/supabase-authority.ts";

const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const leaseId = "73dc6943-b71c-4ba4-a38d-78da0861e0dc";
const authorizationId = "83dc6943-b71c-4ba4-a38d-78da0861e0dc";
const userToken = "member-token";
const controlToken = "gateway-control-token";
const roots: string[] = [];

class FakeAuthority implements ObjectGatewayAuthority {
	/** The catalog: an object's size by its hash. */
	readonly objects = new Map<string, number>();
	readonly authorizedDeletes = new Map<string, string>();
	readonly confirmedDeletes: string[] = [];
	allowDeletion = true;

	async authorizeDelete(
		profile: string,
		sha256: string,
		bytes: number,
		lease: string,
	): Promise<ObjectDeletionAuthorization> {
		if (!this.allowDeletion || profile !== profileId || lease !== leaseId || this.objects.get(sha256) !== bytes) {
			throw new Error("invalid deletion");
		}
		this.authorizedDeletes.set(authorizationId, sha256);
		return { state: "authorized", authorizationId };
	}

	async resumeDelete(
		authorization: string,
		profile: string,
		sha256: string,
		bytes: number,
	): Promise<ObjectDeletionAuthorization> {
		if (
			profile !== profileId ||
			authorization !== authorizationId ||
			this.authorizedDeletes.get(authorization) !== sha256 ||
			this.objects.get(sha256) !== bytes
		) {
			throw new Error("invalid deletion authorization");
		}
		return { state: "authorized", authorizationId: authorization };
	}

	async finalizeDelete(authorization: string, profile: string, sha256: string, bytes: number): Promise<void> {
		if (
			profile !== profileId ||
			authorization !== authorizationId ||
			this.authorizedDeletes.get(authorization) !== sha256 ||
			this.objects.get(sha256) !== bytes
		) {
			throw new Error("invalid deletion finalization");
		}
		this.objects.delete(sha256);
		this.authorizedDeletes.delete(authorization);
		this.confirmedDeletes.push(sha256);
	}

	async readLegacyObject(): Promise<Uint8Array> {
		throw new Error("missing legacy object");
	}
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function gateway(extra: Partial<ObjectGatewayServiceOptions> = {}): Promise<{
	baseUrl: string;
	authority: FakeAuthority;
	store: FileSystemObjectStore;
	close: () => Promise<void>;
}> {
	const root = await mkdtemp(join(tmpdir(), "qorpera-object-gateway-"));
	roots.push(root);
	const authority = new FakeAuthority();
	const store = new FileSystemObjectStore(root);
	const server = createServer(createObjectGatewayHandler({ store, authority, controlToken, ...extra }));
	await new Promise<void>((resolvePromise, rejectPromise) => {
		server.once("error", rejectPromise);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", rejectPromise);
			resolvePromise();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Gateway address unavailable");
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		authority,
		store,
		close: () => new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
	};
}

function objectSha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** An object on the NAS with its catalog row, as an upload left it. */
async function seed(service: Awaited<ReturnType<typeof gateway>>, bytes: Uint8Array): Promise<string> {
	const sha256 = objectSha256(bytes);
	await service.store.put(profileId, sha256, bytes);
	service.authority.objects.set(sha256, bytes.byteLength);
	return sha256;
}

describe("object gateway", () => {
	it("answers 405 to raw object reads and uploads", async () => {
		const member = vi.fn(async () => {
			throw new Error("Unexpected member RPC");
		});
		const service = await gateway({
			memberFiles: { member, publisher: member },
			replication: {} as ObjectGatewayReplication,
		});
		try {
			const bytes = Buffer.from("no raw reads", "utf-8");
			const sha256 = await seed(service, bytes);
			const url = `${service.baseUrl}/v1/profile-objects/${profileId}/${sha256}`;
			const headers = { authorization: `Bearer ${userToken}` };
			expect((await fetch(url, { headers })).status).toBe(405);
			expect((await fetch(url, { method: "PUT", headers, body: bytes })).status).toBe(405);
			expect(member).not.toHaveBeenCalled();
		} finally {
			await service.close();
		}
	});

	it("requires the private control token and a live cleanup lease before catalog deletion", async () => {
		const service = await gateway();
		try {
			const bytes = Buffer.from("delete me", "utf-8");
			const sha256 = await seed(service, bytes);
			const url = `${service.baseUrl}/v1/profile-objects/${profileId}/${sha256}`;
			const denied = await fetch(url, {
				method: "DELETE",
				headers: {
					authorization: "Bearer wrong-token",
					"x-qorpera-gc-lease-id": leaseId,
					"x-qorpera-object-bytes": String(bytes.byteLength),
				},
			});
			expect(denied.status).toBe(401);
			const removed = await fetch(url, {
				method: "DELETE",
				headers: {
					authorization: `Bearer ${controlToken}`,
					"x-qorpera-gc-lease-id": leaseId,
					"x-qorpera-object-bytes": String(bytes.byteLength),
				},
			});
			expect(removed.status).toBe(204);
			expect(service.authority.confirmedDeletes).toEqual([sha256]);
			expect(service.authority.objects.has(sha256)).toBe(false);
		} finally {
			await service.close();
		}
	});

	it("does not remove bytes when durable deletion authorization is rejected", async () => {
		const service = await gateway();
		try {
			const bytes = Buffer.from("keep me", "utf-8");
			const sha256 = await seed(service, bytes);
			const url = `${service.baseUrl}/v1/profile-objects/${profileId}/${sha256}`;
			service.authority.allowDeletion = false;
			expect(
				(
					await fetch(url, {
						method: "DELETE",
						headers: {
							authorization: `Bearer ${controlToken}`,
							"x-qorpera-gc-lease-id": leaseId,
							"x-qorpera-object-bytes": String(bytes.byteLength),
						},
					})
				).status,
			).toBe(503);
			expect(Buffer.from(await service.store.get(profileId, sha256, bytes.byteLength))).toEqual(bytes);
			expect(service.authority.objects.get(sha256)).toBe(bytes.byteLength);
		} finally {
			await service.close();
		}
	});

	it("resumes an authorized deletion after a lost gateway response", async () => {
		const service = await gateway();
		try {
			const bytes = Buffer.from("resume deletion", "utf-8");
			const sha256 = await seed(service, bytes);
			const url = `${service.baseUrl}/v1/profile-objects/${profileId}/${sha256}`;
			service.authority.authorizedDeletes.set(authorizationId, sha256);
			const removed = await fetch(url, {
				method: "DELETE",
				headers: {
					authorization: `Bearer ${controlToken}`,
					"x-qorpera-deletion-authorization-id": authorizationId,
					"x-qorpera-object-bytes": String(bytes.byteLength),
				},
			});
			expect(removed.status).toBe(204);
			expect(service.authority.confirmedDeletes).toEqual([sha256]);
		} finally {
			await service.close();
		}
	});

	it("serves verified content-addressed bytes to internal platform callers without touching Supabase Storage", async () => {
		const internalToken = "A".repeat(43);
		const readLegacySpy = vi.spyOn(FakeAuthority.prototype, "readLegacyObject");
		const unconfigured = await gateway();
		try {
			const sha256 = await seed(unconfigured, Buffer.from("off", "utf-8"));
			expect(
				(
					await fetch(`${unconfigured.baseUrl}/v1/internal-objects/${profileId}/${sha256}`, {
						headers: { authorization: `Bearer ${internalToken}` },
					})
				).status,
			).toBe(404);
		} finally {
			await unconfigured.close();
		}
		expect(() =>
			createObjectGatewayHandler({
				store: new FileSystemObjectStore(tmpdir()),
				authority: new FakeAuthority(),
				controlToken: internalToken,
				internalObjectToken: internalToken,
			}),
		).toThrow("distinct private credential");
		expect(() =>
			createObjectGatewayHandler({
				store: new FileSystemObjectStore(tmpdir()),
				authority: new FakeAuthority(),
				controlToken,
				internalObjectToken: "short-token",
			}),
		).toThrow("distinct private credential");
		const service = await gateway({ internalObjectToken: internalToken });
		try {
			const payload = Buffer.from("mail attachment chunk", "utf-8");
			const sha256 = await seed(service, payload);
			const url = `${service.baseUrl}/v1/internal-objects/${profileId}/${sha256}`;
			expect((await fetch(url)).status).toBe(401);
			expect((await fetch(url, { headers: { authorization: `Bearer ${controlToken}` } })).status).toBe(401);
			expect(
				(await fetch(url, { method: "DELETE", headers: { authorization: `Bearer ${internalToken}` } })).status,
			).toBe(405);
			const ok = await fetch(url, { headers: { authorization: `Bearer ${internalToken}` } });
			expect(ok.status).toBe(200);
			expect(ok.headers.get("content-type")).toBe("application/octet-stream");
			expect(ok.headers.get("etag")).toBe(`"sha256-${sha256}"`);
			expect(Buffer.from(await ok.arrayBuffer())).toEqual(payload);
			const missing = await fetch(`${service.baseUrl}/v1/internal-objects/${profileId}/${"f".repeat(64)}`, {
				headers: { authorization: `Bearer ${internalToken}` },
			});
			expect(missing.status).toBe(404);
			const badPath = await fetch(`${service.baseUrl}/v1/internal-objects/not-a-uuid/${sha256}`, {
				headers: { authorization: `Bearer ${internalToken}` },
			});
			expect(badPath.status).toBe(404);
			const withQuery = await fetch(`${url}?extra=1`, {
				headers: { authorization: `Bearer ${internalToken}` },
			});
			expect(withQuery.status).toBe(404);
			const emptySha = await seed(service, Buffer.alloc(0));
			const emptyRes = await fetch(`${service.baseUrl}/v1/internal-objects/${profileId}/${emptySha}`, {
				headers: { authorization: `Bearer ${internalToken}` },
			});
			expect(emptyRes.status).toBe(200);
			expect(emptyRes.headers.get("content-length")).toBe("0");
			expect((await emptyRes.arrayBuffer()).byteLength).toBe(0);
			const rootDir = roots[roots.length - 1]!;
			const linkTarget = join(rootDir, "outside-secret");
			await writeFile(linkTarget, payload);
			const linkSha = "e".repeat(64);
			await symlink(linkTarget, join(rootDir, profileId, linkSha));
			const symlinkRes = await fetch(`${service.baseUrl}/v1/internal-objects/${profileId}/${linkSha}`, {
				headers: { authorization: `Bearer ${internalToken}` },
			});
			expect(symlinkRes.status).toBe(503);
			await writeFile(join(rootDir, profileId, sha256), Buffer.from("corrupted", "utf-8"));
			const corrupted = await fetch(url, { headers: { authorization: `Bearer ${internalToken}` } });
			expect(corrupted.status).toBe(503);
			expect(readLegacySpy).not.toHaveBeenCalled();
		} finally {
			readLegacySpy.mockRestore();
			await service.close();
		}
	});
});
