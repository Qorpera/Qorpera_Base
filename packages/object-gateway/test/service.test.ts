import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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
	it("answers 405 to raw object reads and uploads, and 404 on the old member export route", async () => {
		const member = vi.fn(async () => {
			throw new Error("Unexpected member RPC");
		});
		// Member files on, so the export path is refused for want of a route, not of its options.
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
			const exported = await fetch(
				`${service.baseUrl}/v1/member-file-exports/${profileId}/${authorizationId}/${sha256}`,
				{ headers },
			);
			expect(exported.status).toBe(404);
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
});
