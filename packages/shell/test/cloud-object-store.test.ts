import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	CloudContentAddressedStore,
	type CloudObjectTransport,
	HttpCloudObjectTransport,
} from "../src/cloud-object-store.ts";

const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";

class MemoryObjectTransport implements CloudObjectTransport {
	readonly objects = new Map<string, Uint8Array>();
	putCalls = 0;

	async put(path: string, bytes: Uint8Array): Promise<"exists" | "stored"> {
		this.putCalls++;
		if (this.objects.has(path)) return "exists";
		this.objects.set(path, Uint8Array.from(bytes));
		return "stored";
	}

	async get(path: string): Promise<Uint8Array> {
		const bytes = this.objects.get(path);
		if (!bytes) throw new Error("object not found");
		return Uint8Array.from(bytes);
	}
}

describe("cloud content-addressed object store", () => {
	it("uses the authenticated HTTP gateway without exposing storage credentials", async () => {
		const requests: Request[] = [];
		const bytes = Buffer.from("gateway object", "utf-8");
		const transport = new HttpCloudObjectTransport({
			baseUrl: "https://objects.example.test/",
			accessToken: async () => "member-access-token",
			fetch: async (input, init) => {
				requests.push(new Request(input, init));
				return requests.length === 1
					? Response.json({ status: "stored" }, { status: 201 })
					: new Response(bytes, { status: 200 });
			},
		});
		expect(await transport.put(`${profileId}/${"a".repeat(64)}`, bytes, "text/plain")).toBe("stored");
		expect(Buffer.from(await transport.get(`${profileId}/${"a".repeat(64)}`))).toEqual(bytes);
		expect(requests.map((request) => request.url)).toEqual([
			`https://objects.example.test/v1/profile-objects/${profileId}/${"a".repeat(64)}`,
			`https://objects.example.test/v1/profile-objects/${profileId}/${"a".repeat(64)}`,
		]);
		expect(requests[0]?.headers.get("authorization")).toBe("Bearer member-access-token");
		expect(requests[0]?.headers.get("content-length")).toBe(String(bytes.byteLength));
	});

	it("deduplicates immutable objects and verifies existing content", async () => {
		const transport = new MemoryObjectTransport();
		const store = new CloudContentAddressedStore(transport);
		const bytes = Buffer.from("shared artifact", "utf-8");
		const first = await store.putObject(profileId, bytes, "text/plain");
		const second = await store.putObject(profileId, bytes, "text/plain");
		expect(second).toEqual(first);
		expect(transport.objects.size).toBe(1);
		expect(transport.putCalls).toBe(2);
		expect(Buffer.from(await store.getObject(profileId, first)).toString("utf-8")).toBe("shared artifact");
	});

	it("round-trips chunked files through a content-addressed manifest", async () => {
		const transport = new MemoryObjectTransport();
		const store = new CloudContentAddressedStore(transport);
		const bytes = Buffer.alloc(4 * 1024 * 1024 + 17, 7);
		const reference = await store.putFile(profileId, bytes, "application/pdf");
		expect(transport.objects.size).toBe(3);
		expect(Buffer.compare(Buffer.from(await store.getFile(profileId, reference)), bytes)).toBe(0);
		const restored = await store.restoreFile(profileId, reference);
		expect(Buffer.compare(Buffer.from(restored.bytes), bytes)).toBe(0);
		expect(restored.objects).toHaveLength(3);
		expect(restored.objects.reduce((total, object) => total + object.bytes, 0)).toBeGreaterThan(bytes.byteLength);
	});

	it("stages a file path as immutable chunks while checking its exact receipt identity", async () => {
		const root = mkdtempSync(join(tmpdir(), "qorpera-object-stage-"));
		try {
			const path = join(root, "output.bin");
			const bytes = Buffer.alloc(4 * 1024 * 1024 + 17, 9);
			writeFileSync(path, bytes);
			const transport = new MemoryObjectTransport();
			const store = new CloudContentAddressedStore(transport);
			const reference = await store.putFileFromPath(profileId, path, "application/octet-stream", {
				bytes: bytes.byteLength,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			});
			expect(reference.objects).toHaveLength(3);
			expect(Buffer.compare(Buffer.from(await store.getFile(profileId, reference)), bytes)).toBe(0);
			await expect(
				store.putFileFromPath(profileId, path, "application/octet-stream", {
					bytes: bytes.byteLength,
					sha256: "f".repeat(64),
				}),
			).rejects.toThrow("changed");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects corrupted objects before materialization", async () => {
		const transport = new MemoryObjectTransport();
		const store = new CloudContentAddressedStore(transport);
		const reference = await store.putObject(profileId, Buffer.from("verified"), "text/plain");
		transport.objects.set(`${profileId}/${reference.sha256}`, Buffer.from("corrupt"));
		await expect(store.getObject(profileId, reference)).rejects.toThrow("integrity");
	});
});
