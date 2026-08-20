import { createHash } from "node:crypto";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_OBJECT_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_TREE_BYTES = 1024 * 1024 * 1024 * 1024;
const MAX_TREE_ENTRIES = 50_000;
const MAX_RELATIVE_PATH_BYTES = 4 * 1024;
const TREE_SCHEMA = "qorpera.company-tree/v1";
const FILE_SCHEMA = "qorpera.cloud-file-manifest/v1";
const OMITTED_LAYERS = [
	"company-git-history",
	"session-trail",
	"staff-registry",
	"product-git-checkouts",
	"dependency-caches",
	"staff-instructions",
	"system-metadata",
] as const;

export interface CompanySnapshotVerificationReference {
	profileId: string;
	manifestSha256: string;
	manifestBytes: number;
	contractVersion: number;
	fileCount: number;
	totalBytes: number;
}

export interface VerifiedCompanySnapshotClosure {
	reachableContentSha256: string;
	objectCount: number;
	storageBytes: number;
	restoredContentSha256: string;
	restoredBytes: number;
}

export interface CachedVerifiedCompanyFile {
	manifestSha256: string;
	manifestBytes: number;
	fileSha256: string;
	bytes: number;
	mediaType: string;
	objects: Array<{ sha256: string; bytes: number }>;
}

export interface CompanySnapshotVerificationCache {
	load: (profileId: string, manifestSha256: string) => Promise<CachedVerifiedCompanyFile | undefined>;
	save: (profileId: string, file: CachedVerifiedCompanyFile) => Promise<void>;
	maxNewFileBytes: number;
}

export class CompanySnapshotVerificationPending extends Error {
	constructor() {
		super("Company File verification is continuing");
		this.name = "CompanySnapshotVerificationPending";
	}
}

export type CompanyObjectLoader = (profileId: string, sha256: string) => Promise<Uint8Array>;

interface FileChunk {
	sha256: string;
	bytes: number;
}

interface FileManifest {
	fileSha256: string;
	bytes: number;
	mediaType: string;
	chunks: FileChunk[];
}

function sha256(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
	return value as Record<string, unknown>;
}

function safeInteger(value: unknown, minimum: number, maximum: number, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw new Error(`Invalid ${label}`);
	}
	return value as number;
}

function hash(value: unknown, label: string): string {
	if (typeof value !== "string" || !SHA256_PATTERN.test(value)) throw new Error(`Invalid ${label}`);
	return value;
}

function normalizedPath(value: unknown): string {
	if (typeof value !== "string") throw new Error("Invalid Company File path");
	if (
		!value ||
		value.startsWith("/") ||
		value.endsWith("/") ||
		value.includes("\\") ||
		value.includes("\0") ||
		Buffer.byteLength(value, "utf8") > MAX_RELATIVE_PATH_BYTES ||
		value.split("/").some(
			(segment) =>
				!segment ||
				segment === "." ||
				segment === ".." ||
				segment.includes(":") ||
				/[\u0001-\u001f]/.test(segment) ||
				/[. ]$/.test(segment) ||
				/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\..*)?$/i.test(segment),
		)
	) {
		throw new Error("Invalid Company File path");
	}
	return value;
}

function omitted(path: string): boolean {
	const parts = path.split("/");
	if (parts[0] === ".git" || parts[0] === "trail" || parts.includes("node_modules")) return true;
	if (parts[0] === ".qorpera" && parts.length > 1 && parts[1] !== "agent-messages.json") return true;
	if (parts[0] === "agents" && parts.length === 3 && parts[2] === "instructions.md") return true;
	return parts[0] === "departments" && parts.length >= 3 && (parts[2] === "repository" || parts[2] === "worktrees");
}

async function exactObject(
	loadObject: CompanyObjectLoader,
	profileId: string,
	sha: string,
	expectedBytes: number | undefined,
): Promise<Uint8Array> {
	const bytes = await loadObject(profileId, sha);
	if (
		bytes.byteLength > MAX_OBJECT_BYTES ||
		(expectedBytes !== undefined && bytes.byteLength !== expectedBytes) ||
		sha256(bytes) !== sha
	) {
		throw new Error("Company File object failed integrity verification");
	}
	return bytes;
}

function fileManifest(bytes: Uint8Array): FileManifest {
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
	} catch {
		throw new Error("Invalid Company File file manifest");
	}
	const input = record(parsed, "Company File file manifest");
	if (
		input.schema !== FILE_SCHEMA ||
		Object.keys(input).length !== 5 ||
		typeof input.mediaType !== "string" ||
		input.mediaType !== "application/octet-stream" ||
		!Array.isArray(input.chunks)
	) {
		throw new Error("Invalid Company File file manifest");
	}
	const expectedBytes = safeInteger(input.bytes, 0, MAX_FILE_BYTES, "Company File byte length");
	const chunks = input.chunks.map((value): FileChunk => {
		const chunk = record(value, "Company File chunk");
		if (Object.keys(chunk).length !== 2) throw new Error("Invalid Company File chunk");
		return {
			sha256: hash(chunk.sha256, "Company File chunk hash"),
			bytes: safeInteger(chunk.bytes, 1, 4 * 1024 * 1024, "Company File chunk length"),
		};
	});
	if (chunks.reduce((total, chunk) => total + chunk.bytes, 0) !== expectedBytes) {
		throw new Error("Company File chunks do not match the file length");
	}
	return {
		fileSha256: hash(input.fileSha256, "Company File hash"),
		bytes: expectedBytes,
		mediaType: input.mediaType,
		chunks,
	};
}

function addReachable(reachable: Map<string, number>, objectSha256: string, bytes: number): void {
	const existing = reachable.get(objectSha256);
	if (existing !== undefined && existing !== bytes) {
		throw new Error("Company File graph contains inconsistent object sizes");
	}
	reachable.set(objectSha256, bytes);
}

function cachedFile(
	value: CachedVerifiedCompanyFile,
	expected: { manifestSha256: string; fileSha256: string; bytes: number; mediaType: string },
): CachedVerifiedCompanyFile {
	if (
		value.manifestSha256 !== expected.manifestSha256 ||
		value.fileSha256 !== expected.fileSha256 ||
		value.bytes !== expected.bytes ||
		value.mediaType !== expected.mediaType ||
		!Number.isSafeInteger(value.manifestBytes) ||
		value.manifestBytes < 1 ||
		value.manifestBytes > MAX_OBJECT_BYTES ||
		!Array.isArray(value.objects) ||
		value.objects.length < 1 ||
		value.objects.length > 65 ||
		value.objects.some(
			(object) =>
				!SHA256_PATTERN.test(object.sha256) ||
				!Number.isSafeInteger(object.bytes) ||
				object.bytes < 0 ||
				object.bytes > MAX_OBJECT_BYTES,
		) ||
		!value.objects.some(
			(object) => object.sha256 === value.manifestSha256 && object.bytes === value.manifestBytes,
		) ||
		new Set(value.objects.map((object) => object.sha256)).size !== value.objects.length
	) {
		throw new Error("Invalid cached Company File verification");
	}
	return value;
}

export async function verifyCompanySnapshotClosure(
	reference: CompanySnapshotVerificationReference,
	loadObject: CompanyObjectLoader,
	cache?: CompanySnapshotVerificationCache,
): Promise<VerifiedCompanySnapshotClosure> {
	if (
		!SHA256_PATTERN.test(reference.manifestSha256) ||
		reference.contractVersion !== 3 ||
		!Number.isSafeInteger(reference.manifestBytes) ||
		reference.manifestBytes < 1 ||
		reference.manifestBytes > MAX_OBJECT_BYTES ||
		!Number.isSafeInteger(reference.fileCount) ||
		reference.fileCount < 0 ||
		reference.fileCount > MAX_TREE_ENTRIES ||
		!Number.isSafeInteger(reference.totalBytes) ||
		reference.totalBytes < 0 ||
		reference.totalBytes > MAX_TREE_BYTES
	) {
		throw new Error("Invalid Company File snapshot reference");
	}
	const treeBytes = await exactObject(
		loadObject,
		reference.profileId,
		reference.manifestSha256,
		reference.manifestBytes,
	);
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(treeBytes).toString("utf8"));
	} catch {
		throw new Error("Invalid Company File tree manifest");
	}
	const tree = record(parsed, "Company File tree manifest");
	if (
		tree.schema !== TREE_SCHEMA ||
		tree.contractVersion !== 3 ||
		Object.keys(tree).length !== 4 ||
		!Array.isArray(tree.omittedLayers) ||
		tree.omittedLayers.length !== OMITTED_LAYERS.length ||
		tree.omittedLayers.some((layer, index) => layer !== OMITTED_LAYERS[index]) ||
		!Array.isArray(tree.entries) ||
		tree.entries.length > MAX_TREE_ENTRIES
	) {
		throw new Error("Invalid Company File tree manifest");
	}

	const reachable = new Map<string, number>([[reference.manifestSha256, reference.manifestBytes]]);
	const foldedPaths = new Set<string>();
	let previousPath = "";
	let fileCount = 0;
	let restoredBytes = 0;
	let newFileBytes = 0;
	let newlyVerifiedFiles = 0;
	for (const value of tree.entries) {
		const entry = record(value, "Company File tree entry");
		const path = normalizedPath(entry.path);
		const folded = path.toLowerCase();
		if (path <= previousPath || foldedPaths.has(folded) || omitted(path)) {
			throw new Error("Company File paths are invalid or collide");
		}
		previousPath = path;
		foldedPaths.add(folded);
		if (entry.kind === "directory" && Object.keys(entry).length === 2) continue;
		if (
			entry.kind !== "file" ||
			Object.keys(entry).length !== 4 ||
			typeof entry.executable !== "boolean"
		) {
			throw new Error("Invalid Company File tree entry");
		}
		const file = record(entry.file, "Company File reference");
		if (
			Object.keys(file).length !== 4 ||
			file.mediaType !== "application/octet-stream"
		) {
			throw new Error("Invalid Company File reference");
		}
		const manifestSha256 = hash(file.manifestSha256, "Company File manifest hash");
		const expectedFileSha256 = hash(file.fileSha256, "Company File hash");
		const expectedFileBytes = safeInteger(file.bytes, 0, MAX_FILE_BYTES, "Company File byte length");
		const cached = cache
			? await cache.load(reference.profileId, manifestSha256)
			: undefined;
		if (cached) {
			const verified = cachedFile(cached, {
				manifestSha256,
				fileSha256: expectedFileSha256,
				bytes: expectedFileBytes,
				mediaType: String(file.mediaType),
			});
			for (const object of verified.objects) addReachable(reachable, object.sha256, object.bytes);
			fileCount++;
			restoredBytes += verified.bytes;
			if (!Number.isSafeInteger(restoredBytes) || restoredBytes > MAX_TREE_BYTES) {
				throw new Error("Company File exceeds its byte limit");
			}
			continue;
		}
		if (
			cache &&
			newlyVerifiedFiles > 0 &&
			newFileBytes + expectedFileBytes > cache.maxNewFileBytes
		) {
			throw new CompanySnapshotVerificationPending();
		}
		const manifestBytes = await exactObject(loadObject, reference.profileId, manifestSha256, undefined);
		const manifest = fileManifest(manifestBytes);
		if (
			manifest.fileSha256 !== expectedFileSha256 ||
			manifest.bytes !== expectedFileBytes ||
			manifest.mediaType !== file.mediaType
		) {
			throw new Error("Company File reference does not match its manifest");
		}
		addReachable(reachable, manifestSha256, manifestBytes.byteLength);
		const restoredFile = createHash("sha256");
		let restoredFileBytes = 0;
		const verifiedObjects: Array<{ sha256: string; bytes: number }> = [
			{ sha256: manifestSha256, bytes: manifestBytes.byteLength },
		];
		for (const chunk of manifest.chunks) {
			const chunkBytes = await exactObject(loadObject, reference.profileId, chunk.sha256, chunk.bytes);
			restoredFile.update(chunkBytes);
			restoredFileBytes += chunkBytes.byteLength;
			addReachable(reachable, chunk.sha256, chunk.bytes);
			if (!verifiedObjects.some((object) => object.sha256 === chunk.sha256)) verifiedObjects.push({ ...chunk });
		}
		if (restoredFileBytes !== manifest.bytes || restoredFile.digest("hex") !== manifest.fileSha256) {
			throw new Error("Company File chunks do not restore the declared file");
		}
		fileCount++;
		restoredBytes += manifest.bytes;
		newFileBytes += manifest.bytes;
		newlyVerifiedFiles++;
		await cache?.save(reference.profileId, {
			manifestSha256,
			manifestBytes: manifestBytes.byteLength,
			fileSha256: manifest.fileSha256,
			bytes: manifest.bytes,
			mediaType: manifest.mediaType,
			objects: verifiedObjects,
		});
		if (!Number.isSafeInteger(restoredBytes) || restoredBytes > MAX_TREE_BYTES) {
			throw new Error("Company File exceeds its byte limit");
		}
	}
	if (fileCount !== reference.fileCount || restoredBytes !== reference.totalBytes) {
		throw new Error("Company File manifest does not match its snapshot declaration");
	}
	const objects = [...reachable.entries()].sort(([left], [right]) => left.localeCompare(right, "en"));
	return {
		reachableContentSha256: sha256(objects.map(([objectSha256, bytes]) => `${objectSha256}:${bytes}`).join("\n")),
		objectCount: objects.length,
		storageBytes: objects.reduce((total, [, bytes]) => total + bytes, 0),
		restoredContentSha256: reference.manifestSha256,
		restoredBytes,
	};
}
