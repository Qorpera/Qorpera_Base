import { describe, expect, it } from "vitest";
import { CloudContentAddressedStore, type CloudObjectTransport } from "../src/cloud-object-store.ts";

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

	it("rejects corrupted objects before materialization", async () => {
		const transport = new MemoryObjectTransport();
		const store = new CloudContentAddressedStore(transport);
		const reference = await store.putObject(profileId, Buffer.from("verified"), "text/plain");
		transport.objects.set(`${profileId}/${reference.sha256}`, Buffer.from("corrupt"));
		await expect(store.getObject(profileId, reference)).rejects.toThrow("integrity");
	});
});
