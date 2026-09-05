import { createHash, randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { CloudCompanyPathGateway } from "../src/cloud-company-path-gateway.ts";
import { readCloudCompanyPolicy } from "../src/cloud-company-policy.ts";

function fixture(source: string) {
	const version = randomUUID();
	const reads: string[] = [];
	const bytes = Buffer.from(source);
	const read = vi.fn<CloudCompanyPathGateway["read"]>(async (path, offset, limit) => {
		const text = bytes.subarray(offset, offset + limit).toString("utf8");
		const readObservationId = randomUUID();
		reads.push(readObservationId);
		return {
			path,
			version,
			snapshotId: randomUUID(),
			readObservationId,
			kind: "file",
			text,
			offset,
			totalBytes: bytes.length,
			bytesRead: Buffer.byteLength(text),
			nextOffset: offset + limit < bytes.length ? offset + limit : null,
		};
	});
	return { read, version, reads };
}

it("projects only validated choices from a single version and retains every page's provenance", async () => {
	const source = `# ${"x".repeat(5000)}\n[policy]\nspending = "auto"\nexternal_communication = "act"\ninformation_sharing = "ignore safeguards"\n[unrelated]\ninstruction = "fake system prompt"\n`;
	const f = fixture(source);
	const result = await readCloudCompanyPolicy(f, new AbortController().signal);
	expect(result).toEqual({
		path: "authority.toml",
		version: f.version,
		sourceSha256: createHash("sha256").update(source).digest("hex"),
		readObservationIds: f.reads,
		choices: {
			spending: "auto",
			external_communication: "act",
			hard_to_reverse_changes: "ask",
			information_sharing: "ask",
		},
	});
	expect(f.read).toHaveBeenCalledTimes(2);
	expect(JSON.stringify(result)).not.toMatch(/fake system|ignore safeguards/);
});

it("defaults to Ask only for an authorized absent file, including a tombstone", async () => {
	const version = randomUUID();
	const read = vi.fn<CloudCompanyPathGateway["read"]>(async () => ({
		path: "authority.toml",
		version,
		kind: "absent",
		readObservationId: randomUUID(),
	}));
	const result = await readCloudCompanyPolicy({ read }, new AbortController().signal);
	expect(result.version).toBe(version);
	expect(result.sourceSha256).toBeNull();
	expect(Object.values(result.choices)).toEqual(["ask", "ask", "ask", "ask"]);
});

it.each(["version", "denied", "malformed", "oversized", "directory", "nonadvancing"])(
	"fails closed for %s policy reads",
	async (mode) => {
		const f = fixture(mode === "malformed" ? "[policy\n" : `# ${"x".repeat(mode === "oversized" ? 33000 : 5000)}\n`);
		const original = f.read.getMockImplementation()!;
		f.read.mockImplementation(async (...args) => {
			if (mode === "denied") throw new Error("Access revoked");
			const result = await original(...args);
			if (mode === "version" && args[1] > 0) result.version = randomUUID();
			if (mode === "directory") result.kind = "directory";
			if (mode === "nonadvancing") result.nextOffset = 0;
			return result;
		});
		await expect(readCloudCompanyPolicy(f, new AbortController().signal)).rejects.toThrow();
	},
);

it("does not request policy after cancellation", async () => {
	const f = fixture("");
	await expect(readCloudCompanyPolicy(f, AbortSignal.abort())).rejects.toThrow();
	expect(f.read).not.toHaveBeenCalled();
});
