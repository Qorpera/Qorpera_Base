import type { CloudApi } from "./api.ts";
import { CloudRpcError } from "./client.ts";
import { SHA256_PATTERN } from "./parse.ts";
import type {
	CloudCompanyTreeEntry,
	CloudCompanyTreeManifest,
	CloudFileReference,
	HostedCompanySnapshot,
} from "./types.ts";

/* Content-addressed reads for published snapshots. Bytes come from the
 * profile-scoped Storage bucket after `qorpera_authorize_profile_object_download`
 * admits the read; every object is rehashed before use, as the desktop does.
 * Companies served by the object gateway (Order 0 path authority) need the
 * gateway to allow this browser origin — see Requests in CLIENT-CONTRACT.md. */

export const PROFILE_OBJECT_BUCKET = "qorpera-profile-objects";
const TREE_MANIFEST_SCHEMA = "qorpera.company-tree/v1";
const FILE_MANIFEST_SCHEMA = "qorpera.cloud-file-manifest/v1";

export class ObjectAccessError extends Error {
	readonly reason: "gateway-required" | "denied" | "integrity" | "unavailable" | "too-large";
	constructor(reason: ObjectAccessError["reason"], message: string) {
		super(message);
		this.name = "ObjectAccessError";
		this.reason = reason;
	}
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
	);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class ObjectReader {
	readonly #api: CloudApi;
	readonly #profileId: string;
	readonly #cache = new Map<string, Uint8Array>();
	#disposed = false;
	#cachedBytes = 0;

	constructor(api: CloudApi, profileId: string) {
		this.#api = api;
		this.#profileId = profileId;
	}

	dispose(): void {
		this.#disposed = true;
		this.#cache.clear();
		this.#cachedBytes = 0;
	}

	async read(sha256: string, expectedBytes?: number): Promise<Uint8Array> {
		if (this.#disposed) throw new ObjectAccessError("unavailable", "Object reader was closed");
		if (!SHA256_PATTERN.test(sha256)) throw new ObjectAccessError("unavailable", "Object hash is invalid");
		let admitted: { backend: string; bytes: number };
		try {
			admitted = await this.#api.authorizeObjectDownload(this.#profileId, sha256);
		} catch (error) {
			if (error instanceof CloudRpcError && error.denied) {
				throw new ObjectAccessError("denied", "You do not have permission to read this object.");
			}
			throw new ObjectAccessError("unavailable", error instanceof Error ? error.message : String(error));
		}
		if (this.#disposed) throw new ObjectAccessError("unavailable", "Object reader was closed");
		if (!Number.isSafeInteger(admitted.bytes) || admitted.bytes < 0)
			throw new ObjectAccessError("integrity", "Object size is invalid");
		if (expectedBytes !== undefined && admitted.bytes !== expectedBytes) {
			throw new ObjectAccessError("integrity", "Object size does not match its reference");
		}
		if (admitted.bytes > 64 * 1024 * 1024)
			throw new ObjectAccessError("too-large", "Object is too large to open in the browser");
		const cached = this.#cache.get(sha256);
		if (cached && cached.byteLength === admitted.bytes) return cached;
		if (admitted.backend !== "supabase-storage")
			throw new ObjectAccessError(
				"gateway-required",
				"This object's storage backend is not supported by the browser client yet.",
			);
		const { data, error } = await this.#api.cloud.supabase.storage
			.from(PROFILE_OBJECT_BUCKET)
			.download(`${this.#profileId}/${sha256}`);
		if (error || !data) {
			throw new ObjectAccessError(
				"unavailable",
				error?.message ?? "Object bytes are unavailable from cloud storage",
			);
		}
		const bytes = new Uint8Array(await data.arrayBuffer());
		if (this.#disposed) throw new ObjectAccessError("unavailable", "Object reader was closed");
		if (bytes.byteLength !== admitted.bytes || (await sha256Hex(bytes)) !== sha256) {
			throw new ObjectAccessError("integrity", "Object bytes failed verification");
		}
		if (!this.#disposed && bytes.byteLength <= 8 * 1024 * 1024 && !this.#cache.has(sha256)) {
			while (this.#cachedBytes + bytes.byteLength > 32 * 1024 * 1024) {
				const oldest = this.#cache.entries().next().value;
				if (!oldest) break;
				this.#cache.delete(oldest[0]);
				this.#cachedBytes -= oldest[1].byteLength;
			}
			this.#cache.set(sha256, bytes);
			this.#cachedBytes += bytes.byteLength;
		}
		return bytes;
	}

	async readTreeManifest(snapshot: HostedCompanySnapshot): Promise<CloudCompanyTreeManifest> {
		const bytes = await this.read(snapshot.tree.manifestSha256, snapshot.tree.manifestBytes);
		const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
		const input = parsed as Partial<CloudCompanyTreeManifest> | null;
		if (!input || input.schema !== TREE_MANIFEST_SCHEMA || !Array.isArray(input.entries)) {
			throw new ObjectAccessError("integrity", "Company tree manifest is invalid");
		}
		const entries: CloudCompanyTreeEntry[] = [];
		for (const value of input.entries as unknown[]) {
			if (!value || typeof value !== "object" || Array.isArray(value))
				throw new ObjectAccessError("integrity", "Company tree entry is invalid");
			const entry = value as Record<string, unknown>;
			const path = typeof entry.path === "string" ? entry.path : "";
			if (!path) throw new ObjectAccessError("integrity", "Company tree entry is invalid");
			if (entry.kind === "directory") {
				entries.push({ kind: "directory", path });
				continue;
			}
			const file = entry.file as Partial<CloudFileReference> | undefined;
			if (
				entry.kind !== "file" ||
				!file ||
				typeof file.manifestSha256 !== "string" ||
				typeof file.fileSha256 !== "string" ||
				!Number.isSafeInteger(file.bytes) ||
				(file.bytes as number) < 0 ||
				!SHA256_PATTERN.test(file.manifestSha256) ||
				!SHA256_PATTERN.test(file.fileSha256)
			) {
				throw new ObjectAccessError("integrity", "Company tree entry is invalid");
			}
			entries.push({
				kind: "file",
				path,
				executable: entry.executable === true,
				file: {
					manifestSha256: file.manifestSha256,
					fileSha256: file.fileSha256,
					bytes: file.bytes as number,
					mediaType: typeof file.mediaType === "string" ? file.mediaType : "application/octet-stream",
				},
			});
		}
		return {
			schema: TREE_MANIFEST_SCHEMA,
			contractVersion: Number(input.contractVersion ?? snapshot.tree.contractVersion),
			omittedLayers: Array.isArray(input.omittedLayers) ? input.omittedLayers.map(String) : [],
			entries,
		};
	}

	async readFile(reference: CloudFileReference): Promise<Uint8Array> {
		if (!Number.isSafeInteger(reference.bytes) || reference.bytes < 0 || !SHA256_PATTERN.test(reference.fileSha256))
			throw new ObjectAccessError("integrity", "File reference is invalid");
		if (reference.bytes > 32 * 1024 * 1024)
			throw new ObjectAccessError("too-large", "File is too large to open in the browser");
		const manifestBytes = await this.read(reference.manifestSha256);
		const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as {
			schema?: unknown;
			fileSha256?: unknown;
			bytes?: unknown;
			chunks?: unknown;
		};
		if (
			!manifest ||
			manifest.schema !== FILE_MANIFEST_SCHEMA ||
			manifest.fileSha256 !== reference.fileSha256 ||
			manifest.bytes !== reference.bytes ||
			!Array.isArray(manifest.chunks)
		) {
			throw new ObjectAccessError("integrity", "File manifest is invalid");
		}
		const chunks: Uint8Array[] = [];
		let declaredBytes = 0;
		for (const chunk of manifest.chunks as { sha256?: unknown; bytes?: unknown }[]) {
			if (
				!chunk ||
				typeof chunk.sha256 !== "string" ||
				!SHA256_PATTERN.test(chunk.sha256) ||
				!Number.isSafeInteger(chunk.bytes) ||
				(chunk.bytes as number) < 0
			)
				throw new ObjectAccessError("integrity", "File chunk reference is invalid");
			declaredBytes += chunk.bytes as number;
			if (declaredBytes > reference.bytes)
				throw new ObjectAccessError("integrity", "File chunks exceed the declared file size");
		}
		if (declaredBytes !== reference.bytes)
			throw new ObjectAccessError("integrity", "File chunk sizes do not match the file reference");
		for (const chunk of manifest.chunks as { sha256?: unknown; bytes?: unknown }[]) {
			if (typeof chunk.sha256 !== "string" || !Number.isSafeInteger(chunk.bytes)) {
				throw new ObjectAccessError("integrity", "File chunk reference is invalid");
			}
			chunks.push(await this.read(chunk.sha256, chunk.bytes as number));
		}
		const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
		const bytes = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		if (bytes.byteLength !== reference.bytes || (await sha256Hex(bytes)) !== reference.fileSha256) {
			throw new ObjectAccessError("integrity", "File bytes failed verification");
		}
		return bytes;
	}
}
