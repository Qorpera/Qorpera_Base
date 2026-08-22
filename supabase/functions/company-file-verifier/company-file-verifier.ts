import { Buffer } from "node:buffer";
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
	restrictedContentSha256: string;
}

export interface CachedVerifiedCompanyFile {
	manifestSha256: string;
	manifestBytes: number;
	fileSha256: string;
	bytes: number;
	mediaType: string;
	objects: Array<{ sha256: string; bytes: number }>;
}

export interface CompanyFileSha256Progress {
	words: number[];
	tailBase64: string;
	bytes: number;
}

export interface CachedCompanyFileVerificationProgress extends CachedVerifiedCompanyFile {
	nextChunkIndex: number;
	verifiedBytes: number;
	sha256: CompanyFileSha256Progress;
}

export interface CompanySnapshotVerificationCache {
	load: (profileId: string, manifestSha256: string) => Promise<CachedVerifiedCompanyFile | undefined>;
	save: (profileId: string, file: CachedVerifiedCompanyFile) => Promise<void>;
	loadProgress: (
		profileId: string,
		manifestSha256: string,
	) => Promise<CachedCompanyFileVerificationProgress | undefined>;
	saveProgress: (profileId: string, progress: CachedCompanyFileVerificationProgress) => Promise<void>;
	clearProgress: (profileId: string, manifestSha256: string) => Promise<void>;
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

const SHA256_INITIAL = [
	0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];
const SHA256_ROUND = [
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotateRight(value: number, bits: number): number {
	return (value >>> bits) | (value << (32 - bits));
}

class DurableSha256 {
	#words: number[];
	#tail: Uint8Array;
	#bytes: number;

	constructor(progress?: CompanyFileSha256Progress) {
		if (!progress) {
			this.#words = [...SHA256_INITIAL];
			this.#tail = new Uint8Array();
			this.#bytes = 0;
			return;
		}
		const tail = Buffer.from(progress.tailBase64, "base64");
		if (
			!Array.isArray(progress.words) ||
			progress.words.length !== 8 ||
			progress.words.some((word) => !Number.isSafeInteger(word) || word < 0 || word > 0xffffffff) ||
			tail.toString("base64") !== progress.tailBase64 ||
			tail.byteLength >= 64 ||
			!Number.isSafeInteger(progress.bytes) ||
			progress.bytes < tail.byteLength ||
			(progress.bytes - tail.byteLength) % 64 !== 0 ||
			progress.bytes > MAX_FILE_BYTES
		) {
			throw new Error("Invalid cached Company File hash progress");
		}
		this.#words = [...progress.words];
		this.#tail = Uint8Array.from(tail);
		this.#bytes = progress.bytes;
	}

	update(bytes: Uint8Array): void {
		this.#bytes += bytes.byteLength;
		if (!Number.isSafeInteger(this.#bytes) || this.#bytes > MAX_FILE_BYTES + 128) {
			throw new Error("Company File exceeds its byte limit");
		}
		const combined = new Uint8Array(this.#tail.byteLength + bytes.byteLength);
		combined.set(this.#tail);
		combined.set(bytes, this.#tail.byteLength);
		let offset = 0;
		while (offset + 64 <= combined.byteLength) {
			this.#compress(combined.subarray(offset, offset + 64));
			offset += 64;
		}
		this.#tail = combined.slice(offset);
	}

	progress(): CompanyFileSha256Progress {
		return { words: [...this.#words], tailBase64: Buffer.from(this.#tail).toString("base64"), bytes: this.#bytes };
	}

	digestHex(): string {
		const clone = new DurableSha256(this.progress());
		const bitLength = BigInt(clone.#bytes) * 8n;
		const paddingBytes = clone.#tail.byteLength < 56 ? 56 - clone.#tail.byteLength : 120 - clone.#tail.byteLength;
		const padding = new Uint8Array(paddingBytes + 8);
		padding[0] = 0x80;
		for (let index = 0; index < 8; index += 1) {
			padding[padding.length - 1 - index] = Number((bitLength >> BigInt(index * 8)) & 0xffn);
		}
		clone.update(padding);
		return clone.#words.map((word) => word.toString(16).padStart(8, "0")).join("");
	}

	#compress(block: Uint8Array): void {
		const schedule = new Uint32Array(64);
		for (let index = 0; index < 16; index += 1) {
			const offset = index * 4;
			schedule[index] =
				((block[offset] << 24) | (block[offset + 1] << 16) | (block[offset + 2] << 8) | block[offset + 3]) >>> 0;
		}
		for (let index = 16; index < 64; index += 1) {
			const left = schedule[index - 15];
			const right = schedule[index - 2];
			const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
			const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
			schedule[index] = (schedule[index - 16] + sigma0 + schedule[index - 7] + sigma1) >>> 0;
		}
		let [a, b, c, d, e, f, g, h] = this.#words;
		for (let index = 0; index < 64; index += 1) {
			const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
			const choice = (e & f) ^ (~e & g);
			const temporary1 = (h + sum1 + choice + SHA256_ROUND[index] + schedule[index]) >>> 0;
			const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
			const majority = (a & b) ^ (a & c) ^ (b & c);
			const temporary2 = (sum0 + majority) >>> 0;
			h = g;
			g = f;
			f = e;
			e = (d + temporary1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (temporary1 + temporary2) >>> 0;
		}
		this.#words = [
			(this.#words[0] + a) >>> 0,
			(this.#words[1] + b) >>> 0,
			(this.#words[2] + c) >>> 0,
			(this.#words[3] + d) >>> 0,
			(this.#words[4] + e) >>> 0,
			(this.#words[5] + f) >>> 0,
			(this.#words[6] + g) >>> 0,
			(this.#words[7] + h) >>> 0,
		];
	}
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
	const canonical = value.normalize("NFC");
	if (
		!value ||
		canonical !== value ||
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
	return canonical;
}

function pathCollisionKey(path: string): string {
	return path.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC");
}

function omitted(path: string): boolean {
	const parts = path.split("/").map(pathCollisionKey);
	if (parts[0] === ".git" || parts[0] === "trail" || parts.includes("node_modules")) return true;
	if (
		parts[0] === ".qorpera" &&
		parts.length > 1 &&
		parts[1] !== "agent-messages.json" &&
		parts[1] !== "authority.sig.json" &&
		parts[1] !== "products.json" &&
		parts[1] !== "product-sources" &&
		parts[1] !== "routines"
	) {
		return true;
	}
	if (parts[0] === "agents" && parts.length === 3 && parts[2] === "instructions.md") return true;
	return parts[0] === "departments" && parts.length >= 3 && (parts[2] === "repository" || parts[2] === "worktrees");
}

function authorityCritical(path: string): boolean {
	const key = pathCollisionKey(path);
	return key === "authority.toml" || key === "agents.md" || key === "claude.md" || key === ".qorpera/authority.sig.json";
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
	if (
		chunks.some((chunk, index) => index < chunks.length - 1 && chunk.bytes !== 4 * 1024 * 1024) ||
		chunks.reduce((total, chunk) => total + chunk.bytes, 0) !== expectedBytes
	) {
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

function cachedProgress(
	value: CachedCompanyFileVerificationProgress,
	expected: {
		manifestSha256: string;
		manifestBytes: number;
		fileSha256: string;
		bytes: number;
		mediaType: string;
		chunks: FileChunk[];
	},
): CachedCompanyFileVerificationProgress {
	const verified = cachedFile(value, expected);
	if (
		value.manifestBytes !== expected.manifestBytes ||
		!Number.isSafeInteger(value.nextChunkIndex) ||
		value.nextChunkIndex < 0 ||
		value.nextChunkIndex > expected.chunks.length ||
		!Number.isSafeInteger(value.verifiedBytes) ||
		value.verifiedBytes < 0 ||
		value.verifiedBytes !== expected.chunks.slice(0, value.nextChunkIndex).reduce((sum, chunk) => sum + chunk.bytes, 0) ||
		value.objects.some((object) => {
			if (object.sha256 === expected.manifestSha256) return object.bytes !== expected.manifestBytes;
			const chunk = expected.chunks.slice(0, value.nextChunkIndex).find((candidate) => candidate.sha256 === object.sha256);
			return !chunk || chunk.bytes !== object.bytes;
		}) ||
		expected.chunks
			.slice(0, value.nextChunkIndex)
			.some(
				(chunk) => !value.objects.some((object) => object.sha256 === chunk.sha256 && object.bytes === chunk.bytes),
			)
	) {
		throw new Error("Invalid cached Company File verification progress");
	}
	const hasher = new DurableSha256(value.sha256);
	if (hasher.progress().bytes !== value.verifiedBytes) {
		throw new Error("Invalid cached Company File verification progress");
	}
	return { ...verified, nextChunkIndex: value.nextChunkIndex, verifiedBytes: value.verifiedBytes, sha256: value.sha256 };
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
		throw new Error("Invalid Company File tree manifest JSON");
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
		throw new Error("Invalid Company File tree manifest contract");
	}

	const reachable = new Map<string, number>([[reference.manifestSha256, reference.manifestBytes]]);
	const foldedPaths = new Set<string>();
	let previousPath = "";
	let fileCount = 0;
	let restoredBytes = 0;
	let newFileBytes = 0;
	const restrictedEntries: string[] = [];
	if (
		cache &&
		(!Number.isSafeInteger(cache.maxNewFileBytes) || cache.maxNewFileBytes < 1)
	) {
		throw new Error("Invalid Company File verification budget");
	}
	for (const value of tree.entries) {
		const entry = record(value, "Company File tree entry");
		const path = normalizedPath(entry.path);
		const folded = pathCollisionKey(path);
		if (path <= previousPath || foldedPaths.has(folded) || omitted(path)) {
			throw new Error("Company File paths are invalid or collide");
		}
		previousPath = path;
		foldedPaths.add(folded);
		if (entry.kind === "directory" && Object.keys(entry).length === 2) {
			if (authorityCritical(path)) restrictedEntries.push(`d:${path}`);
			continue;
		}
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
		if (authorityCritical(path)) {
			restrictedEntries.push(
				`f:${path}:${entry.executable ? "x" : "-"}:${manifestSha256}:${expectedFileSha256}:${expectedFileBytes}`,
			);
		}
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
		const storedProgress = cache ? await cache.loadProgress(reference.profileId, manifestSha256) : undefined;
		const progress = storedProgress
			? cachedProgress(storedProgress, {
					manifestSha256,
					manifestBytes: manifestBytes.byteLength,
					fileSha256: manifest.fileSha256,
					bytes: manifest.bytes,
					mediaType: manifest.mediaType,
					chunks: manifest.chunks,
				})
			: {
					manifestSha256,
					manifestBytes: manifestBytes.byteLength,
					fileSha256: manifest.fileSha256,
					bytes: manifest.bytes,
					mediaType: manifest.mediaType,
					objects: [{ sha256: manifestSha256, bytes: manifestBytes.byteLength }],
					nextChunkIndex: 0,
					verifiedBytes: 0,
					sha256: new DurableSha256().progress(),
				};
		const restoredFile = new DurableSha256(progress.sha256);
		const verifiedObjects = [...progress.objects];
		for (const object of verifiedObjects) addReachable(reachable, object.sha256, object.bytes);
		let nextChunkIndex = progress.nextChunkIndex;
		let restoredFileBytes = progress.verifiedBytes;
		for (; nextChunkIndex < manifest.chunks.length; nextChunkIndex += 1) {
			const chunk = manifest.chunks[nextChunkIndex];
			if (cache && newFileBytes + chunk.bytes > cache.maxNewFileBytes) {
				throw new CompanySnapshotVerificationPending();
			}
			const chunkBytes = await exactObject(loadObject, reference.profileId, chunk.sha256, chunk.bytes);
			restoredFile.update(chunkBytes);
			restoredFileBytes += chunkBytes.byteLength;
			newFileBytes += chunkBytes.byteLength;
			addReachable(reachable, chunk.sha256, chunk.bytes);
			if (!verifiedObjects.some((object) => object.sha256 === chunk.sha256)) verifiedObjects.push({ ...chunk });
			await cache?.saveProgress(reference.profileId, {
				manifestSha256,
				manifestBytes: manifestBytes.byteLength,
				fileSha256: manifest.fileSha256,
				bytes: manifest.bytes,
				mediaType: manifest.mediaType,
				objects: verifiedObjects,
				nextChunkIndex: nextChunkIndex + 1,
				verifiedBytes: restoredFileBytes,
				sha256: restoredFile.progress(),
			});
		}
		if (restoredFileBytes !== manifest.bytes || restoredFile.digestHex() !== manifest.fileSha256) {
			throw new Error("Company File chunks do not restore the declared file");
		}
		fileCount++;
		restoredBytes += manifest.bytes;
		await cache?.save(reference.profileId, {
			manifestSha256,
			manifestBytes: manifestBytes.byteLength,
			fileSha256: manifest.fileSha256,
			bytes: manifest.bytes,
			mediaType: manifest.mediaType,
			objects: verifiedObjects,
		});
		await cache?.clearProgress(reference.profileId, manifestSha256);
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
		restrictedContentSha256: sha256(restrictedEntries.join("\n")),
	};
}
