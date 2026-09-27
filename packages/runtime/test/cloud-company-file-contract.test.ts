import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureCloudCompanyTreeWithReachability } from "@qorpera/cloud-client/node/cloud-company-snapshot";
import { CloudContentAddressedStore, type CloudObjectTransport } from "@qorpera/cloud-client/node/cloud-object-store";
import { afterEach, describe, expect, it } from "vitest";
import { verifyCompanySnapshotClosure } from "../../../supabase/functions/company-file-verifier/company-file-verifier.ts";
import { scaffoldCompany } from "./fixtures/scaffold-company.ts";

const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const temporaryDirectories: string[] = [];

class MemoryObjectTransport implements CloudObjectTransport {
	readonly objects = new Map<string, Uint8Array>();

	async put(path: string, bytes: Uint8Array): Promise<"exists" | "stored"> {
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

async function companyFixture(): Promise<string> {
	const directory = await mkdtemp(join(await realpath(tmpdir()), "qorpera-company-file-contract-"));
	temporaryDirectories.push(directory);
	const root = join(directory, "company");
	scaffoldCompany(root);
	await writeFile(join(root, "company.md"), "# Shared company\n", "utf-8");
	await mkdir(join(root, "app", "substrates"), { recursive: true });
	await writeFile(join(root, "app", "substrates", "market.md"), "durable substrate\n", "utf-8");
	return root;
}

function sha256(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function objectLoader(transport: MemoryObjectTransport) {
	return async (ownerProfileId: string, objectSha256: string): Promise<Uint8Array> =>
		transport.get(`${ownerProfileId}/${objectSha256}`);
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("company file producer and verifier golden contract", () => {
	it("accepts the exact serialized tree the producer publishes and reproduces its closure", async () => {
		const root = await companyFixture();
		const transport = new MemoryObjectTransport();
		const store = new CloudContentAddressedStore(transport);
		const captured = await captureCloudCompanyTreeWithReachability(root, profileId, store);

		const verified = await verifyCompanySnapshotClosure(
			{
				profileId,
				manifestSha256: captured.tree.manifestSha256,
				manifestBytes: captured.tree.manifestBytes,
				contractVersion: captured.tree.contractVersion,
				fileCount: captured.tree.fileCount,
				totalBytes: captured.tree.totalBytes,
			},
			objectLoader(transport),
		);

		expect(verified.restoredContentSha256).toBe(captured.tree.manifestSha256);
		expect(verified.restoredBytes).toBe(captured.tree.totalBytes);
		expect(verified.objectCount).toBe(captured.restore.objects.length);
		expect(verified.storageBytes).toBe(captured.restore.objects.reduce((total, object) => total + object.bytes, 0));
		expect(verified.reachableContentSha256).toBe(
			sha256(captured.restore.objects.map((object) => `${object.sha256}:${object.bytes}`).join("\n")),
		);
	});

	it("rejects a tree whose file reference leaks private reachability metadata", async () => {
		const root = await companyFixture();
		const transport = new MemoryObjectTransport();
		const store = new CloudContentAddressedStore(transport);
		const captured = await captureCloudCompanyTreeWithReachability(root, profileId, store);

		const manifestBytes = await transport.get(`${profileId}/${captured.tree.manifestSha256}`);
		const manifest = JSON.parse(Buffer.from(manifestBytes).toString("utf-8")) as {
			entries: Array<{ kind: string; file?: Record<string, unknown> }>;
		};
		const fileEntry = manifest.entries.find((entry) => entry.kind === "file" && entry.file);
		expect(fileEntry?.file).toBeDefined();
		(fileEntry as { file: Record<string, unknown> }).file.objects = [];
		const leakedBytes = Buffer.from(JSON.stringify(manifest), "utf-8");
		const leakedSha256 = sha256(leakedBytes);
		transport.objects.set(`${profileId}/${leakedSha256}`, Uint8Array.from(leakedBytes));

		await expect(
			verifyCompanySnapshotClosure(
				{
					profileId,
					manifestSha256: leakedSha256,
					manifestBytes: leakedBytes.byteLength,
					contractVersion: captured.tree.contractVersion,
					fileCount: captured.tree.fileCount,
					totalBytes: captured.tree.totalBytes,
				},
				objectLoader(transport),
			),
		).rejects.toThrow("Invalid Company File reference");
	});
});
