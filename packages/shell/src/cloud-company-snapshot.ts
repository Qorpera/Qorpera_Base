import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
	type CompanyRuntimeLock,
	canonicalCompanyRoot,
	claimCompanyRuntimeLock,
	releaseCompanyRuntimeLock,
} from "@qorpera/pi-coding-agent/company";
import type {
	CloudContentAddressedStore,
	CloudFileReference,
	CloudObjectReference,
	CloudReachableObject,
} from "./cloud-object-store.ts";

const TREE_MANIFEST_SCHEMA = "qorpera.company-tree/v1";
const TREE_MANIFEST_MEDIA_TYPE = "application/vnd.qorpera.company-tree+json";
const TREE_CONTRACT_VERSION = 1;
const MAX_TREE_ENTRIES = 50_000;
const MAX_TREE_BYTES = 1024 * 1024 * 1024 * 1024;
const MAX_RELATIVE_PATH_BYTES = 4 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const CLOUD_COMPANY_TREE_OMITTED_LAYERS = [
	"company-git-history",
	"session-trail",
	"staff-registry",
	"product-git-checkouts",
	"dependency-caches",
] as const;

export interface CloudCompanyDirectoryEntry {
	kind: "directory";
	path: string;
}

export interface CloudCompanyFileEntry {
	kind: "file";
	path: string;
	executable: boolean;
	file: CloudFileReference;
}

export type CloudCompanyTreeEntry = CloudCompanyDirectoryEntry | CloudCompanyFileEntry;

export interface CloudCompanyTreeManifest {
	schema: typeof TREE_MANIFEST_SCHEMA;
	contractVersion: typeof TREE_CONTRACT_VERSION;
	omittedLayers: readonly (typeof CLOUD_COMPANY_TREE_OMITTED_LAYERS)[number][];
	entries: CloudCompanyTreeEntry[];
}

export interface CloudCompanyTreeReference {
	manifestSha256: string;
	manifestBytes: number;
	contractVersion: typeof TREE_CONTRACT_VERSION;
	fileCount: number;
	totalBytes: number;
}

export interface VerifiedCloudCompanyTreeRestore {
	restoredContentSha256: string;
	restoredBytes: number;
	objects: CloudReachableObject[];
}

export interface CaptureCloudCompanyTreeOptions {
	runtimeLock?: CompanyRuntimeLock;
}

export function currentCloudCompanyTreeReference(value: {
	manifestSha256: string;
	manifestBytes: number;
	contractVersion: number;
	fileCount: number;
	totalBytes: number;
}): CloudCompanyTreeReference {
	if (
		!SHA256_PATTERN.test(value.manifestSha256) ||
		!Number.isSafeInteger(value.manifestBytes) ||
		value.manifestBytes < 1 ||
		value.contractVersion !== TREE_CONTRACT_VERSION ||
		!Number.isSafeInteger(value.fileCount) ||
		value.fileCount < 0 ||
		!Number.isSafeInteger(value.totalBytes) ||
		value.totalBytes < 0
	) {
		throw new Error("Cloud company tree reference is not supported by this client");
	}
	return { ...value, contractVersion: TREE_CONTRACT_VERSION };
}

function normalizedRelativePath(path: string): string {
	const normalized = path.split(sep).join("/");
	if (
		!normalized ||
		normalized.startsWith("/") ||
		normalized.endsWith("/") ||
		normalized.includes("\\") ||
		normalized.includes("\0") ||
		Buffer.byteLength(normalized, "utf-8") > MAX_RELATIVE_PATH_BYTES ||
		normalized
			.split("/")
			.some(
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
		throw new Error("Cloud company tree path is invalid");
	}
	return normalized;
}

function shouldOmit(path: string): boolean {
	const parts = path.split("/");
	if (parts[0] === ".git" || parts[0] === "trail" || parts.includes("node_modules")) return true;
	if (parts[0] === ".qorpera") {
		if (parts[1] === "staff.json" || parts[1] === "product-worktrees" || parts[1] === "w") return true;
	}
	return parts[0] === "departments" && parts.length >= 3 && (parts[2] === "repository" || parts[2] === "worktrees");
}

export function cloudCompanyPathBelongsToLogicalTree(relativePath: string): boolean {
	try {
		return !shouldOmit(normalizedRelativePath(relativePath));
	} catch {
		return false;
	}
}

function manifestReference(reference: CloudCompanyTreeReference): CloudObjectReference {
	return {
		sha256: reference.manifestSha256,
		bytes: reference.manifestBytes,
		mediaType: TREE_MANIFEST_MEDIA_TYPE,
	};
}

function parseFileReference(value: unknown): CloudFileReference {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Cloud company tree file reference is invalid");
	}
	const input = value as Partial<CloudFileReference>;
	if (
		!SHA256_PATTERN.test(input.manifestSha256 ?? "") ||
		!SHA256_PATTERN.test(input.fileSha256 ?? "") ||
		!Number.isSafeInteger(input.bytes) ||
		(input.bytes ?? -1) < 0 ||
		(input.bytes ?? 0) > MAX_TREE_BYTES ||
		typeof input.mediaType !== "string" ||
		input.mediaType !== "application/octet-stream"
	) {
		throw new Error("Cloud company tree file reference is invalid");
	}
	return input as CloudFileReference;
}

function parseManifest(bytes: Uint8Array, reference: CloudCompanyTreeReference): CloudCompanyTreeManifest {
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(bytes).toString("utf-8"));
	} catch {
		throw new Error("Cloud company tree manifest is invalid JSON");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Cloud company tree manifest is invalid");
	}
	const input = parsed as Partial<CloudCompanyTreeManifest>;
	if (
		input.schema !== TREE_MANIFEST_SCHEMA ||
		input.contractVersion !== TREE_CONTRACT_VERSION ||
		!Array.isArray(input.omittedLayers) ||
		input.omittedLayers.length !== CLOUD_COMPANY_TREE_OMITTED_LAYERS.length ||
		input.omittedLayers.some((layer, index) => layer !== CLOUD_COMPANY_TREE_OMITTED_LAYERS[index]) ||
		!Array.isArray(input.entries) ||
		input.entries.length > MAX_TREE_ENTRIES
	) {
		throw new Error("Cloud company tree manifest is invalid");
	}
	const seen = new Set<string>();
	const folded = new Set<string>();
	let previousPath = "";
	let fileCount = 0;
	let totalBytes = 0;
	const entries = (input.entries as unknown[]).map((value): CloudCompanyTreeEntry => {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error("Cloud company tree entry is invalid");
		}
		const entry = value as Record<string, unknown>;
		const path = normalizedRelativePath(String(entry.path ?? ""));
		if (path <= previousPath || seen.has(path) || folded.has(path.toLowerCase()) || shouldOmit(path)) {
			throw new Error("Cloud company tree paths are invalid or collide");
		}
		previousPath = path;
		seen.add(path);
		folded.add(path.toLowerCase());
		if (entry.kind === "directory" && Object.keys(entry).length === 2) return { kind: "directory", path };
		if (entry.kind !== "file" || typeof entry.executable !== "boolean" || Object.keys(entry).length !== 4) {
			throw new Error("Cloud company tree entry is invalid");
		}
		const file = parseFileReference(entry.file);
		fileCount++;
		totalBytes += file.bytes;
		if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TREE_BYTES) {
			throw new Error("Cloud company tree exceeds its byte limit");
		}
		return { kind: "file", path, executable: entry.executable, file };
	});
	if (
		reference.contractVersion !== TREE_CONTRACT_VERSION ||
		reference.fileCount !== fileCount ||
		reference.totalBytes !== totalBytes
	) {
		throw new Error("Cloud company tree reference does not match its manifest");
	}
	return {
		schema: TREE_MANIFEST_SCHEMA,
		contractVersion: TREE_CONTRACT_VERSION,
		omittedLayers: CLOUD_COMPANY_TREE_OMITTED_LAYERS,
		entries,
	};
}

export async function readCloudCompanyTreeManifest(
	profileId: string,
	reference: CloudCompanyTreeReference,
	store: CloudContentAddressedStore,
): Promise<CloudCompanyTreeManifest> {
	const manifestBytes = await store.getObject(profileId, manifestReference(reference));
	return parseManifest(manifestBytes, reference);
}

export async function verifyCloudCompanyTreeRestore(
	profileId: string,
	reference: CloudCompanyTreeReference,
	store: CloudContentAddressedStore,
): Promise<VerifiedCloudCompanyTreeRestore> {
	const manifest = await readCloudCompanyTreeManifest(profileId, reference, store);
	const reachable = new Map<string, number>([[reference.manifestSha256, reference.manifestBytes]]);
	let restoredBytes = 0;
	for (const entry of manifest.entries) {
		if (entry.kind !== "file") continue;
		const restored = await store.restoreFile(profileId, entry.file);
		restoredBytes += restored.bytes.byteLength;
		for (const object of restored.objects) {
			const existingBytes = reachable.get(object.sha256);
			if (existingBytes !== undefined && existingBytes !== object.bytes) {
				throw new Error("Cloud company reachability contains inconsistent object sizes");
			}
			reachable.set(object.sha256, object.bytes);
		}
	}
	if (restoredBytes !== reference.totalBytes) {
		throw new Error("Cloud company restore does not match its declared byte length");
	}
	return {
		restoredContentSha256: reference.manifestSha256,
		restoredBytes,
		objects: [...reachable.entries()]
			.map(([objectSha256, bytes]) => ({ sha256: objectSha256, bytes }))
			.sort((left, right) => left.sha256.localeCompare(right.sha256, "en")),
	};
}

async function assertEmptyDestination(target: string): Promise<void> {
	try {
		const targetStat = await stat(target);
		if (!targetStat.isDirectory() || (await readdir(target)).length > 0) {
			throw new Error("Cloud company tree destination must be an empty directory");
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

export async function captureCloudCompanyTree(
	companyRoot: string,
	profileId: string,
	store: CloudContentAddressedStore,
	options: CaptureCloudCompanyTreeOptions = {},
): Promise<CloudCompanyTreeReference> {
	const root = canonicalCompanyRoot(companyRoot);
	const suppliedLock = options.runtimeLock;
	if (
		suppliedLock &&
		(process.platform === "win32"
			? resolve(suppliedLock.root).toLowerCase() !== resolve(root).toLowerCase()
			: resolve(suppliedLock.root) !== resolve(root))
	) {
		throw new Error("Cloud company tree lock belongs to another company");
	}
	const lock = suppliedLock ?? claimCompanyRuntimeLock(root);
	try {
		const entries: CloudCompanyTreeEntry[] = [];
		const foldedPaths = new Set<string>();
		let fileCount = 0;
		let totalBytes = 0;
		const visit = async (directory: string): Promise<void> => {
			const children = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
				left.name.localeCompare(right.name, "en"),
			);
			for (const child of children) {
				const absolutePath = join(directory, child.name);
				const path = normalizedRelativePath(relative(root, absolutePath));
				if (shouldOmit(path)) continue;
				const folded = path.toLowerCase();
				if (foldedPaths.has(folded)) throw new Error(`Cloud company tree path collision: ${path}`);
				foldedPaths.add(folded);
				const entryStat = await lstat(absolutePath);
				if (entryStat.isSymbolicLink()) throw new Error(`Cloud company tree cannot contain links: ${path}`);
				if (child.isDirectory() && entryStat.isDirectory()) {
					entries.push({ kind: "directory", path });
					await visit(absolutePath);
					continue;
				}
				if (!child.isFile() || !entryStat.isFile() || entryStat.nlink !== 1) {
					throw new Error(`Cloud company tree can contain only physical files and directories: ${path}`);
				}
				const bytes = await readFile(absolutePath);
				totalBytes += bytes.byteLength;
				fileCount++;
				if (
					entries.length >= MAX_TREE_ENTRIES ||
					fileCount > MAX_TREE_ENTRIES ||
					!Number.isSafeInteger(totalBytes) ||
					totalBytes > MAX_TREE_BYTES
				) {
					throw new Error("Cloud company tree exceeds its size limits");
				}
				entries.push({
					kind: "file",
					path,
					executable: (entryStat.mode & 0o111) !== 0,
					file: await store.putFile(profileId, bytes, "application/octet-stream"),
				});
			}
		};
		await visit(root);
		entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
		if (entries.length > MAX_TREE_ENTRIES) throw new Error("Cloud company tree has too many entries");
		const manifest: CloudCompanyTreeManifest = {
			schema: TREE_MANIFEST_SCHEMA,
			contractVersion: TREE_CONTRACT_VERSION,
			omittedLayers: CLOUD_COMPANY_TREE_OMITTED_LAYERS,
			entries,
		};
		const encoded = Buffer.from(JSON.stringify(manifest), "utf-8");
		const reference = await store.putObject(profileId, encoded, TREE_MANIFEST_MEDIA_TYPE);
		return {
			manifestSha256: reference.sha256,
			manifestBytes: reference.bytes,
			contractVersion: TREE_CONTRACT_VERSION,
			fileCount,
			totalBytes,
		};
	} finally {
		if (!suppliedLock) releaseCompanyRuntimeLock(lock);
	}
}

export async function materializeCloudCompanyTree(
	destination: string,
	profileId: string,
	reference: CloudCompanyTreeReference,
	store: CloudContentAddressedStore,
): Promise<void> {
	const target = resolve(destination);
	await assertEmptyDestination(target);
	await mkdir(target, { recursive: true });
	const manifest = await readCloudCompanyTreeManifest(profileId, reference, store);
	const physicalTarget = await realpath(target);
	for (const entry of manifest.entries) {
		const absolutePath = resolve(target, ...entry.path.split("/"));
		const targetRelative = relative(physicalTarget, absolutePath);
		if (!targetRelative || targetRelative.startsWith(`..${sep}`) || targetRelative === "..") {
			throw new Error("Cloud company tree path escapes its destination");
		}
		if (entry.kind === "directory") {
			await mkdir(absolutePath, { recursive: true });
			continue;
		}
		await mkdir(dirname(absolutePath), { recursive: true });
		await writeFile(absolutePath, await store.getFile(profileId, entry.file), { flag: "wx" });
		if (entry.executable && process.platform !== "win32") await chmod(absolutePath, 0o755);
	}
}

export function newCloudCompanySnapshotId(): string {
	return randomUUID();
}
