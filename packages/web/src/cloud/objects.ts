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

	constructor(api: CloudApi, profileId: string) {
		this.#api = api;
		this.#profileId = profileId;
	}

	async read(sha256: string, expectedBytes?: number): Promise<Uint8Array> {
		if (!SHA256_PATTERN.test(sha256)) throw new ObjectAccessError("unavailable", "Object hash is invalid");
		const cached = this.#cache.get(sha256);
		if (cached) return cached;
		let admitted: { backend: string; bytes: number };
		try {
			admitted = await this.#api.authorizeObjectDownload(this.#profileId, sha256);
		} catch (error) {
			if (error instanceof CloudRpcError && error.denied) {
				throw new ObjectAccessError(
					"gateway-required",
					"This company's objects are served by the object gateway, which does not yet admit browser origins.",
				);
			}
			throw new ObjectAccessError("unavailable", error instanceof Error ? error.message : String(error));
		}
		if (expectedBytes !== undefined && admitted.bytes !== expectedBytes) {
			throw new ObjectAccessError("integrity", "Object size does not match its reference");
		}
		if (admitted.bytes > 64 * 1024 * 1024)
			throw new ObjectAccessError("too-large", "Object is too large to open in the browser");
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
		if (bytes.byteLength !== admitted.bytes || (await sha256Hex(bytes)) !== sha256) {
			throw new ObjectAccessError("integrity", "Object bytes failed verification");
		}
		if (bytes.byteLength <= 8 * 1024 * 1024) this.#cache.set(sha256, bytes);
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
				!Number.isSafeInteger(file.bytes)
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
			manifest.schema !== FILE_MANIFEST_SCHEMA ||
			manifest.fileSha256 !== reference.fileSha256 ||
			!Array.isArray(manifest.chunks)
		) {
			throw new ObjectAccessError("integrity", "File manifest is invalid");
		}
		const chunks: Uint8Array[] = [];
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
