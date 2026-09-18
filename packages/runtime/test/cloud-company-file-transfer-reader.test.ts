import { createHash, randomUUID } from "node:crypto";
import { parseCompanyFileTransferSource } from "@qorpera/cloud-client/cloud-file-transfer";
import { expect, it, vi } from "vitest";
import { readCompanyFileTransfer } from "../src/cloud-company-file-transfer-reader.ts";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function fixture(bytes: Uint8Array, change?: (manifest: Record<string, unknown>) => void) {
	const objects = new Map<string, Uint8Array>();
	const chunks = [];
	for (let offset = 0; offset < bytes.length; offset += 4194304) {
		const part = bytes.slice(offset, offset + 4194304);
		objects.set(sha(part), part);
		chunks.push({ sha256: sha(part), bytes: part.length });
	}
	const manifest: Record<string, unknown> = {
		schema: "qorpera.cloud-file-manifest/v1",
		fileSha256: sha(bytes),
		bytes: bytes.length,
		mediaType: "application/octet-stream",
		chunks,
	};
	change?.(manifest);
	const encoded = new TextEncoder().encode(JSON.stringify(manifest));
	objects.set(sha(encoded), encoded);
	const source = parseCompanyFileTransferSource({
		schema: "qorpera.company-file-transfer-source/v1",
		companyId: randomUUID(),
		environmentId: randomUUID(),
		source: { realm: "company_file", path: "Shared/data.bin", version: randomUUID() },
		sha256: sha(bytes),
		bytes: bytes.length,
		manifestSha256: sha(encoded),
		manifestBytes: encoded.length,
		mediaType: "application/octet-stream",
	});
	const get = vi.fn(async (key: string) => {
		const [company, hash] = key.split("/");
		expect(company).toBe(source.companyId);
		const object = objects.get(hash);
		if (!object) throw new Error("NO_OBJECT");
		return object;
	});
	const controller = new AbortController();
	return { source, get, objects, controller, read: () => readCompanyFileTransfer(source, { get }, controller.signal) };
}
it.each([0, 5, 4194305, 8388608])("verifies exact binary bytes and chunk assembly for %s bytes", async (length) => {
	const bytes = new Uint8Array(length).fill(255);
	if (length) bytes[length - 1] = 128;
	const f = fixture(bytes);
	// Compare every byte without constructing millions of assertion properties.
	expect(Buffer.compare(await f.read(), bytes)).toBe(0);
	expect(f.get).toHaveBeenCalledTimes(1 + Math.ceil(length / 4194304));
});
it.each([
	(m: Record<string, unknown>) => {
		m.schema = "other";
	},
	(m: Record<string, unknown>) => {
		m.path = "/private";
	},
	(m: Record<string, unknown>) => {
		m.bytes = 3;
	},
	(m: Record<string, unknown>) => {
		m.fileSha256 = "a".repeat(64);
	},
	(m: Record<string, unknown>) => {
		m.mediaType = "text/plain";
	},
	(m: Record<string, unknown>) => {
		m.chunks = [];
	},
	(m: Record<string, unknown>) => {
		m.chunks = [{ sha256: "a".repeat(64), bytes: 0 }];
	},
	(m: Record<string, unknown>) => {
		m.chunks = [{ sha256: "a".repeat(64), bytes: 2.5 }];
	},
	(m: Record<string, unknown>) => {
		m.chunks = [{ sha256: "a".repeat(64), bytes: 5, path: "x" }];
	},
	(m: Record<string, unknown>) => {
		m.chunks = [
			{ sha256: "a".repeat(64), bytes: 2 },
			{ sha256: "b".repeat(64), bytes: 3 },
		];
	},
])("rejects a malformed bound manifest before reading any chunk (%#)", async (change) => {
	const f = fixture(new Uint8Array(5), change);
	await expect(f.read()).rejects.toThrow();
	expect(f.get).toHaveBeenCalledOnce();
});
it.each(["manifest", "chunk"])("rejects corrupted %s bytes", async (kind) => {
	const f = fixture(new Uint8Array([0, 255, 128]));
	f.objects.set(kind === "manifest" ? f.source.manifestSha256 : f.source.sha256, new Uint8Array([1, 2, 3]));
	await expect(f.read()).rejects.toThrow("COMPANY_FILE_TRANSFER_BYTES_CHANGED");
});
it("verifies the assembled hash even when all individually hashed chunks match", async () => {
	const f = fixture(new Uint8Array([1, 2, 3]), (m) => {
		m.fileSha256 = "a".repeat(64);
	});
	f.source.sha256 = "a".repeat(64);
	await expect(f.read()).rejects.toThrow("COMPANY_FILE_TRANSFER_BYTES_CHANGED");
	expect(f.get).toHaveBeenCalledTimes(2);
});
it("honors cancellation after download without returning bytes", async () => {
	const f = fixture(new Uint8Array([0, 255]));
	const get = f.get.getMockImplementation()!;
	f.get.mockImplementation(async (key) => {
		const result = await get(key);
		f.controller.abort();
		return result;
	});
	await expect(f.read()).rejects.toThrow();
	expect(f.get).toHaveBeenCalledOnce();
});
