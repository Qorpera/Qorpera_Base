import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSystemObjectStore } from "../src/object-store.ts";
import { createObjectGatewayHandler } from "../src/service.ts";
import type { AuthorizedObject, ObjectGatewayAuthority } from "../src/supabase-authority.ts";

const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const leaseId = "73dc6943-b71c-4ba4-a38d-78da0861e0dc";
const userToken = "member-token";
const controlToken = "gateway-control-token";
const roots: string[] = [];

class FakeAuthority implements ObjectGatewayAuthority {
	readonly objects = new Map<string, AuthorizedObject>();
	readonly legacy = new Map<string, Uint8Array>();
	readonly confirmedDeletes: string[] = [];

	async authorizeUpload(token: string, profile: string, sha256: string, bytes: number): Promise<void> {
		if (token !== userToken || profile !== profileId || bytes < 0 || !sha256) throw new Error("denied");
	}

	async authorizeDownload(token: string, profile: string, sha256: string): Promise<AuthorizedObject> {
		if (token !== userToken || profile !== profileId) throw new Error("denied");
		const object = this.objects.get(sha256);
		if (!object) throw new Error("missing");
		return object;
	}

	async confirmUpload(profile: string, sha256: string, bytes: number): Promise<void> {
		if (profile !== profileId) throw new Error("wrong profile");
		this.objects.set(sha256, { backend: "nas-object-gateway", bytes });
	}

	async confirmDelete(profile: string, sha256: string, bytes: number, lease: string): Promise<void> {
		if (profile !== profileId || lease !== leaseId || this.objects.get(sha256)?.bytes !== bytes) {
			throw new Error("invalid deletion");
		}
		this.objects.delete(sha256);
		this.confirmedDeletes.push(sha256);
	}

	async readLegacyObject(_profile: string, sha256: string): Promise<Uint8Array> {
		const bytes = this.legacy.get(sha256);
		if (!bytes) throw new Error("missing legacy object");
		return bytes;
	}
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function gateway(): Promise<{
	baseUrl: string;
	authority: FakeAuthority;
	close: () => Promise<void>;
	root: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "qorpera-object-gateway-"));
	roots.push(root);
	const authority = new FakeAuthority();
	const server = createServer(
		createObjectGatewayHandler({ store: new FileSystemObjectStore(root), authority, controlToken }),
	);
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
		root,
		close: () => new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
	};
}

function objectSha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

describe("object gateway", () => {
	it("hashes, stores, deduplicates, and re-verifies NAS objects", async () => {
		const service = await gateway();
		try {
			const bytes = Buffer.from("company file object", "utf-8");
			const sha256 = objectSha256(bytes);
			const url = `${service.baseUrl}/v1/profile-objects/${profileId}/${sha256}`;
			const first = await fetch(url, {
				method: "PUT",
				headers: { authorization: `Bearer ${userToken}`, "content-type": "application/octet-stream" },
				body: bytes,
			});
			expect(first.status).toBe(201);
			expect(await first.json()).toMatchObject({ status: "stored", sha256, bytes: bytes.byteLength });

			const duplicate = await fetch(url, {
				method: "PUT",
				headers: { authorization: `Bearer ${userToken}` },
				body: bytes,
			});
			expect(duplicate.status).toBe(200);
			expect(await duplicate.json()).toMatchObject({ status: "exists" });

			const downloaded = await fetch(url, { headers: { authorization: `Bearer ${userToken}` } });
			expect(downloaded.status).toBe(200);
			expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(bytes);
		} finally {
			await service.close();
		}
	});

	it("rejects unauthorized and incorrectly addressed uploads", async () => {
		const service = await gateway();
		try {
			const bytes = Buffer.from("wrong address", "utf-8");
			const wrongSha256 = "a".repeat(64);
			const url = `${service.baseUrl}/v1/profile-objects/${profileId}/${wrongSha256}`;
			expect((await fetch(url, { method: "PUT", body: bytes })).status).toBe(401);
			const mismatched = await fetch(url, {
				method: "PUT",
				headers: { authorization: `Bearer ${userToken}` },
				body: bytes,
			});
			expect(mismatched.status).toBe(400);
			expect(await rm(join(service.root, profileId), { recursive: true, force: true })).toBeUndefined();
		} finally {
			await service.close();
		}
	});

	it("serves verified legacy objects during per-object migration", async () => {
		const service = await gateway();
		try {
			const bytes = Buffer.from("legacy object", "utf-8");
			const sha256 = objectSha256(bytes);
			service.authority.objects.set(sha256, { backend: "supabase-storage", bytes: bytes.byteLength });
			service.authority.legacy.set(sha256, bytes);
			const response = await fetch(`${service.baseUrl}/v1/profile-objects/${profileId}/${sha256}`, {
				headers: { authorization: `Bearer ${userToken}` },
			});
			expect(response.status).toBe(200);
			expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
		} finally {
			await service.close();
		}
	});

	it("requires the private control token and a live cleanup lease before catalog deletion", async () => {
		const service = await gateway();
		try {
			const bytes = Buffer.from("delete me", "utf-8");
			const sha256 = objectSha256(bytes);
			const url = `${service.baseUrl}/v1/profile-objects/${profileId}/${sha256}`;
			await fetch(url, {
				method: "PUT",
				headers: { authorization: `Bearer ${userToken}` },
				body: bytes,
			});
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

	it("refuses a corrupt object already present on the NAS", async () => {
		const service = await gateway();
		try {
			const bytes = Buffer.from("expected", "utf-8");
			const sha256 = objectSha256(bytes);
			service.authority.objects.set(sha256, { backend: "nas-object-gateway", bytes: bytes.byteLength });
			await mkdir(join(service.root, profileId), { recursive: true });
			await writeFile(join(service.root, profileId, sha256), Buffer.from("corrupt!", "utf-8"));
			const response = await fetch(`${service.baseUrl}/v1/profile-objects/${profileId}/${sha256}`, {
				headers: { authorization: `Bearer ${userToken}` },
			});
			expect(response.status).toBe(503);
		} finally {
			await service.close();
		}
	});
});
