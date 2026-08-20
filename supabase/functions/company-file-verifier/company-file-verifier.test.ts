import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
	type CachedVerifiedCompanyFile,
	CompanySnapshotVerificationPending,
	verifyCompanySnapshotClosure,
} from "./company-file-verifier.ts";

function sha256(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function encoded(value: unknown): Uint8Array {
	return Buffer.from(JSON.stringify(value), "utf8");
}

function fixture(): {
	reference: Parameters<typeof verifyCompanySnapshotClosure>[0];
	objects: Map<string, Uint8Array>;
	chunkSha256: string;
	fileManifestSha256: string;
} {
	const objects = new Map<string, Uint8Array>();
	const chunk = Buffer.from("hello", "utf8");
	const chunkSha256 = sha256(chunk);
	objects.set(chunkSha256, chunk);
	const fileManifest = encoded({
		schema: "qorpera.cloud-file-manifest/v1",
		fileSha256: chunkSha256,
		bytes: chunk.byteLength,
		mediaType: "application/octet-stream",
		chunks: [{ sha256: chunkSha256, bytes: chunk.byteLength }],
	});
	const fileManifestSha256 = sha256(fileManifest);
	objects.set(fileManifestSha256, fileManifest);
	const tree = encoded({
		schema: "qorpera.company-tree/v1",
		contractVersion: 3,
		omittedLayers: [
			"company-git-history",
			"session-trail",
			"staff-registry",
			"product-git-checkouts",
			"dependency-caches",
			"staff-instructions",
			"system-metadata",
		],
		entries: [
			{
				kind: "file",
				path: "notes.txt",
				executable: false,
				file: {
					manifestSha256: fileManifestSha256,
					fileSha256: chunkSha256,
					bytes: chunk.byteLength,
					mediaType: "application/octet-stream",
				},
			},
		],
	});
	const manifestSha256 = sha256(tree);
	objects.set(manifestSha256, tree);
	return {
		reference: {
			profileId: "14000000-0000-4000-8000-000000000001",
			manifestSha256,
			manifestBytes: tree.byteLength,
			contractVersion: 3,
			fileCount: 1,
			totalBytes: chunk.byteLength,
		},
		objects,
		chunkSha256,
		fileManifestSha256,
	};
}

test("verifies the exact tree and derives its complete reachable object set", async () => {
	const input = fixture();
	const result = await verifyCompanySnapshotClosure(input.reference, async (_profileId, sha) => {
		const bytes = input.objects.get(sha);
		if (!bytes) throw new Error("missing");
		return bytes;
	});
	const reachable = [
		[input.chunkSha256, input.objects.get(input.chunkSha256)?.byteLength ?? 0],
		[input.fileManifestSha256, input.objects.get(input.fileManifestSha256)?.byteLength ?? 0],
		[input.reference.manifestSha256, input.reference.manifestBytes],
	] as const;
	const canonical = [...reachable].sort(([left], [right]) => left.localeCompare(right, "en"));
	assert.deepEqual(result, {
		reachableContentSha256: sha256(canonical.map(([sha, bytes]) => `${sha}:${bytes}`).join("\n")),
		objectCount: 3,
		storageBytes: canonical.reduce((total, [, bytes]) => total + bytes, 0),
		restoredContentSha256: input.reference.manifestSha256,
		restoredBytes: 5,
	});
});

test("rejects a tree object whose bytes do not match the prepared revision", async () => {
	const input = fixture();
	await assert.rejects(
		verifyCompanySnapshotClosure(input.reference, async (_profileId, sha) => {
			if (sha === input.reference.manifestSha256) return Buffer.from("tampered", "utf8");
			const bytes = input.objects.get(sha);
			if (!bytes) throw new Error("missing");
			return bytes;
		}),
		/integrity verification/,
	);
});

test("rejects corrupt chunk bytes even when the object path claims the expected hash", async () => {
	const input = fixture();
	await assert.rejects(
		verifyCompanySnapshotClosure(input.reference, async (_profileId, sha) => {
			if (sha === input.chunkSha256) return Buffer.from("jello", "utf8");
			const bytes = input.objects.get(sha);
			if (!bytes) throw new Error("missing");
			return bytes;
		}),
		/integrity verification/,
	);
});

test("rejects file metadata that is not bound to its content-addressed manifest", async () => {
	const input = fixture();
	const treeBytes = input.objects.get(input.reference.manifestSha256);
	assert.ok(treeBytes);
	const tree = JSON.parse(Buffer.from(treeBytes).toString("utf8")) as {
		entries: Array<{ file: { fileSha256: string } }>;
	};
	tree.entries[0].file.fileSha256 = "f".repeat(64);
	const changedTree = encoded(tree);
	const changedSha256 = sha256(changedTree);
	input.objects.set(changedSha256, changedTree);
	await assert.rejects(
		verifyCompanySnapshotClosure(
			{ ...input.reference, manifestSha256: changedSha256, manifestBytes: changedTree.byteLength },
			async (_profileId, sha) => {
				const bytes = input.objects.get(sha);
				if (!bytes) throw new Error("missing");
				return bytes;
			},
		),
		/reference does not match/,
	);
});

test("resumes verification from durable per-file proofs and reuses them across checkpoints", async () => {
	const input = fixture();
	const secondChunk = Buffer.from("world", "utf8");
	const secondChunkSha256 = sha256(secondChunk);
	input.objects.set(secondChunkSha256, secondChunk);
	const secondManifest = encoded({
		schema: "qorpera.cloud-file-manifest/v1",
		fileSha256: secondChunkSha256,
		bytes: secondChunk.byteLength,
		mediaType: "application/octet-stream",
		chunks: [{ sha256: secondChunkSha256, bytes: secondChunk.byteLength }],
	});
	const secondManifestSha256 = sha256(secondManifest);
	input.objects.set(secondManifestSha256, secondManifest);
	const originalTree = JSON.parse(
		Buffer.from(input.objects.get(input.reference.manifestSha256)!).toString("utf8"),
	) as { entries: unknown[] };
	originalTree.entries.push({
		kind: "file",
		path: "summary.txt",
		executable: false,
		file: {
			manifestSha256: secondManifestSha256,
			fileSha256: secondChunkSha256,
			bytes: secondChunk.byteLength,
			mediaType: "application/octet-stream",
		},
	});
	const tree = encoded(originalTree);
	const treeSha256 = sha256(tree);
	input.objects.set(treeSha256, tree);
	const reference = {
		...input.reference,
		manifestSha256: treeSha256,
		manifestBytes: tree.byteLength,
		fileCount: 2,
		totalBytes: 10,
	};
	const cache = new Map<string, CachedVerifiedCompanyFile>();
	let objectLoads = 0;
	const loader = async (_profileId: string, objectSha256: string): Promise<Uint8Array> => {
		objectLoads++;
		const bytes = input.objects.get(objectSha256);
		if (!bytes) throw new Error("missing");
		return bytes;
	};
	const verificationCache = {
		maxNewFileBytes: 5,
		load: async (_profileId: string, manifestSha256: string) => cache.get(manifestSha256),
		save: async (_profileId: string, file: CachedVerifiedCompanyFile) => {
			cache.set(file.manifestSha256, file);
		},
	};
	await assert.rejects(
		verifyCompanySnapshotClosure(reference, loader, verificationCache),
		CompanySnapshotVerificationPending,
	);
	assert.equal(cache.size, 1);
	await verifyCompanySnapshotClosure(reference, loader, verificationCache);
	assert.equal(cache.size, 2);
	const beforeReuse = objectLoads;
	await verifyCompanySnapshotClosure(reference, loader, verificationCache);
	assert.equal(objectLoads - beforeReuse, 1, "a fully cached checkpoint should download only its tree manifest");
});
