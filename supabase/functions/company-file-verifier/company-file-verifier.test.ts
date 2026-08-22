import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
	type CachedCompanyFileVerificationProgress,
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
		restrictedContentSha256: sha256(""),
	});
});

test("does not depend on a runtime-global Buffer", async () => {
	const input = fixture();
	const runtimeBuffer = globalThis.Buffer;
	assert.equal(Reflect.deleteProperty(globalThis, "Buffer"), true);
	try {
		await verifyCompanySnapshotClosure(input.reference, async (_profileId, sha) => {
			const bytes = input.objects.get(sha);
			if (!bytes) throw new Error("missing");
			return bytes;
		});
	} finally {
		globalThis.Buffer = runtimeBuffer;
	}
});

test("derives an authority-only tree fingerprint for publish permission checks", async () => {
	const input = fixture();
	const treeBytes = input.objects.get(input.reference.manifestSha256);
	assert.ok(treeBytes);
	const tree = JSON.parse(Buffer.from(treeBytes).toString("utf8")) as {
		entries: Array<{
			path: string;
			executable: boolean;
			file: { manifestSha256: string; fileSha256: string; bytes: number };
		}>;
	};
	tree.entries[0].path = "authority.toml";
	const changedTree = encoded(tree);
	const changedSha256 = sha256(changedTree);
	input.objects.set(changedSha256, changedTree);
	const result = await verifyCompanySnapshotClosure(
		{ ...input.reference, manifestSha256: changedSha256, manifestBytes: changedTree.byteLength },
		async (_profileId, sha) => {
			const bytes = input.objects.get(sha);
			if (!bytes) throw new Error("missing");
			return bytes;
		},
	);
	assert.equal(
		result.restrictedContentSha256,
		sha256(`f:authority.toml:-:${input.fileManifestSha256}:${input.chunkSha256}:5`),
	);
});

test("rejects noncanonical Unicode paths and protects authority names case-insensitively", async () => {
	const input = fixture();
	const original = input.objects.get(input.reference.manifestSha256);
	assert.ok(original);
	const tree = JSON.parse(Buffer.from(original).toString("utf8")) as {
		entries: Array<{
			path: string;
			executable: boolean;
			file: { manifestSha256: string; fileSha256: string; bytes: number };
		}>;
	};
	tree.entries[0].path = "e\u0301.txt";
	let changedTree = encoded(tree);
	let changedSha256 = sha256(changedTree);
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
		/Invalid Company File path/,
	);

	tree.entries = [
		{ ...tree.entries[0], path: "ς.txt" },
		{ ...tree.entries[0], path: "σ.txt" },
	];
	changedTree = encoded(tree);
	changedSha256 = sha256(changedTree);
	input.objects.set(changedSha256, changedTree);
	await assert.rejects(
		verifyCompanySnapshotClosure(
			{
				...input.reference,
				manifestSha256: changedSha256,
				manifestBytes: changedTree.byteLength,
				fileCount: 2,
				totalBytes: 10,
			},
			async (_profileId, sha) => {
				const bytes = input.objects.get(sha);
				if (!bytes) throw new Error("missing");
				return bytes;
			},
		),
		/paths are invalid or collide/,
	);

	tree.entries = [{ ...tree.entries[0], path: "agents.md" }];
	changedTree = encoded(tree);
	changedSha256 = sha256(changedTree);
	input.objects.set(changedSha256, changedTree);
	const result = await verifyCompanySnapshotClosure(
		{ ...input.reference, manifestSha256: changedSha256, manifestBytes: changedTree.byteLength },
		async (_profileId, sha) => {
			const bytes = input.objects.get(sha);
			if (!bytes) throw new Error("missing");
			return bytes;
		},
	);
	assert.equal(
		result.restrictedContentSha256,
		sha256(`f:agents.md:-:${input.fileManifestSha256}:${input.chunkSha256}:5`),
	);
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
	const progress = new Map<string, CachedCompanyFileVerificationProgress>();
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
		loadProgress: async (_profileId: string, manifestSha256: string) => progress.get(manifestSha256),
		save: async (_profileId: string, file: CachedVerifiedCompanyFile) => {
			cache.set(file.manifestSha256, file);
		},
		saveProgress: async (_profileId: string, file: CachedCompanyFileVerificationProgress) => {
			progress.set(file.manifestSha256, structuredClone(file));
		},
		clearProgress: async (_profileId: string, manifestSha256: string) => {
			progress.delete(manifestSha256);
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

test("never verifies more than the configured chunk-byte budget for the first uncached file", async () => {
	const input = fixture();
	const first = Buffer.alloc(4 * 1024 * 1024, "a");
	const second = Buffer.from("world", "utf8");
	const firstSha = sha256(first);
	const secondSha = sha256(second);
	input.objects.set(firstSha, first);
	input.objects.set(secondSha, second);
	const fileBytes = Buffer.concat([first, second]);
	const manifest = encoded({
		schema: "qorpera.cloud-file-manifest/v1",
		fileSha256: sha256(fileBytes),
		bytes: fileBytes.byteLength,
		mediaType: "application/octet-stream",
		chunks: [
			{ sha256: firstSha, bytes: first.byteLength },
			{ sha256: secondSha, bytes: second.byteLength },
		],
	});
	const manifestSha = sha256(manifest);
	input.objects.set(manifestSha, manifest);
	const treeBytes = input.objects.get(input.reference.manifestSha256);
	assert.ok(treeBytes);
	const tree = JSON.parse(Buffer.from(treeBytes).toString("utf8")) as {
		entries: Array<{ file: { manifestSha256: string; fileSha256: string; bytes: number } }>;
	};
	tree.entries[0].file = {
		...tree.entries[0].file,
		manifestSha256: manifestSha,
		fileSha256: sha256(fileBytes),
		bytes: fileBytes.byteLength,
	};
	const changedTree = encoded(tree);
	const changedTreeSha = sha256(changedTree);
	input.objects.set(changedTreeSha, changedTree);
	const reference = {
		...input.reference,
		manifestSha256: changedTreeSha,
		manifestBytes: changedTree.byteLength,
		totalBytes: fileBytes.byteLength,
	};
	const cache = new Map<string, CachedVerifiedCompanyFile>();
	const progress = new Map<string, CachedCompanyFileVerificationProgress>();
	let invocationChunkBytes = 0;
	const verificationCache = {
		maxNewFileBytes: first.byteLength,
		load: async (_profileId: string, objectManifestSha: string) => cache.get(objectManifestSha),
		loadProgress: async (_profileId: string, objectManifestSha: string) => progress.get(objectManifestSha),
		save: async (_profileId: string, file: CachedVerifiedCompanyFile) => {
			cache.set(file.manifestSha256, structuredClone(file));
		},
		saveProgress: async (_profileId: string, file: CachedCompanyFileVerificationProgress) => {
			progress.set(file.manifestSha256, structuredClone(file));
		},
		clearProgress: async (_profileId: string, objectManifestSha: string) => {
			progress.delete(objectManifestSha);
		},
	};
	const loader = async (_profileId: string, objectSha: string): Promise<Uint8Array> => {
		const bytes = input.objects.get(objectSha);
		if (!bytes) throw new Error("missing");
		if (objectSha === firstSha || objectSha === secondSha) invocationChunkBytes += bytes.byteLength;
		return bytes;
	};
	await assert.rejects(
		verifyCompanySnapshotClosure(reference, loader, verificationCache),
		CompanySnapshotVerificationPending,
	);
	assert.equal(invocationChunkBytes, first.byteLength);
	invocationChunkBytes = 0;
	await verifyCompanySnapshotClosure(reference, loader, verificationCache);
	assert.equal(invocationChunkBytes, second.byteLength);
	assert.equal(cache.size, 1);
	assert.equal(progress.size, 0);
});
