import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { HostedPrimaryDatabase } from "./hosted-primary.ts";

export const QORPERA_PROFILE_OBJECT_BUCKET = "qorpera-profile-objects";
const OBJECT_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_OBJECT_BYTES = 8 * 1024 * 1024;
const FILE_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const FILE_MANIFEST_SCHEMA = "qorpera.cloud-file-manifest/v1";
const FILE_MANIFEST_MEDIA_TYPE = "application/vnd.qorpera.file-manifest+json";

export interface CloudObjectReference {
	sha256: string;
	bytes: number;
	mediaType: string;
}

export interface CloudFileReference {
	manifestSha256: string;
	fileSha256: string;
	bytes: number;
	mediaType: string;
}

export interface StagedCloudFileReference extends CloudFileReference {
	objects: CloudReachableObject[];
}

export interface CloudReachableObject {
	sha256: string;
	bytes: number;
}

export interface RestoredCloudFile {
	bytes: Uint8Array;
	objects: CloudReachableObject[];
}

export interface CloudObjectTransport {
	put(path: string, bytes: Uint8Array, mediaType: string): Promise<"exists" | "stored">;
	get(path: string): Promise<Uint8Array>;
}

interface CloudFileChunk {
	sha256: string;
	bytes: number;
}

interface CloudFileManifest {
	schema: typeof FILE_MANIFEST_SCHEMA;
	fileSha256: string;
	bytes: number;
	mediaType: string;
	chunks: CloudFileChunk[];
}

function requiredProfileId(profileId: string): void {
	if (!UUID_PATTERN.test(profileId)) throw new Error("Profile id must be a UUID");
}

function requiredSha256(sha256: string): void {
	if (!OBJECT_SHA256_PATTERN.test(sha256)) throw new Error("Cloud object SHA-256 is invalid");
}

function requiredMediaType(mediaType: string): string {
	const value = mediaType.trim().toLowerCase();
	if (!value || value.length > 256 || /[\r\n\0]/.test(value) || !value.includes("/")) {
		throw new Error("Cloud object media type is invalid");
	}
	return value;
}

function objectPath(profileId: string, sha256: string): string {
	requiredProfileId(profileId);
	requiredSha256(sha256);
	return `${profileId}/${sha256}`;
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function isExistingObjectError(error: { code?: unknown; status?: number; statusCode?: string }): boolean {
	return (
		error.status === 409 ||
		error.statusCode === "409" ||
		error.code === "ResourceAlreadyExists" ||
		error.code === "KeyAlreadyExists"
	);
}

export class SupabaseCloudObjectTransport implements CloudObjectTransport {
	readonly #client: SupabaseClient<HostedPrimaryDatabase>;

	constructor(client: SupabaseClient<HostedPrimaryDatabase>) {
		this.#client = client;
	}

	async put(path: string, bytes: Uint8Array, mediaType: string): Promise<"exists" | "stored"> {
		const body = Uint8Array.from(bytes).buffer;
		const { error } = await this.#client.storage.from(QORPERA_PROFILE_OBJECT_BUCKET).upload(path, body, {
			cacheControl: "31536000",
			contentType: mediaType,
			upsert: false,
		});
		if (!error) return "stored";
		if (isExistingObjectError(error)) return "exists";
		throw error;
	}

	async get(path: string): Promise<Uint8Array> {
		const { data, error } = await this.#client.storage.from(QORPERA_PROFILE_OBJECT_BUCKET).download(path);
		if (error) throw error;
		return new Uint8Array(await data.arrayBuffer());
	}
}

export class CloudContentAddressedStore {
	readonly #transport: CloudObjectTransport;

	constructor(transport: CloudObjectTransport) {
		this.#transport = transport;
	}

	async putObject(profileId: string, bytes: Uint8Array, mediaType: string): Promise<CloudObjectReference> {
		requiredProfileId(profileId);
		if (bytes.byteLength > MAX_OBJECT_BYTES) throw new Error("Cloud object exceeds the 8 MiB object limit");
		const normalizedMediaType = requiredMediaType(mediaType);
		const reference: CloudObjectReference = {
			sha256: sha256(bytes),
			bytes: bytes.byteLength,
			mediaType: normalizedMediaType,
		};
		const path = objectPath(profileId, reference.sha256);
		const result = await this.#transport.put(path, bytes, normalizedMediaType);
		if (result === "exists") await this.getObject(profileId, reference);
		return reference;
	}

	async getObject(profileId: string, reference: CloudObjectReference): Promise<Uint8Array> {
		requiredProfileId(profileId);
		requiredSha256(reference.sha256);
		requiredMediaType(reference.mediaType);
		if (!Number.isSafeInteger(reference.bytes) || reference.bytes < 0 || reference.bytes > MAX_OBJECT_BYTES) {
			throw new Error("Cloud object byte length is invalid");
		}
		const bytes = await this.#transport.get(objectPath(profileId, reference.sha256));
		if (bytes.byteLength !== reference.bytes || sha256(bytes) !== reference.sha256) {
			throw new Error("Cloud object failed SHA-256 integrity verification");
		}
		return bytes;
	}

	async putFile(profileId: string, bytes: Uint8Array, mediaType: string): Promise<CloudFileReference> {
		requiredProfileId(profileId);
		if (bytes.byteLength > MAX_FILE_BYTES) throw new Error("Cloud file exceeds the 256 MiB in-memory limit");
		const normalizedMediaType = requiredMediaType(mediaType);
		const chunks: CloudFileChunk[] = [];
		for (let offset = 0; offset < bytes.byteLength; offset += FILE_CHUNK_BYTES) {
			const chunk = bytes.slice(offset, Math.min(offset + FILE_CHUNK_BYTES, bytes.byteLength));
			const reference = await this.putObject(profileId, chunk, "application/octet-stream");
			chunks.push({ sha256: reference.sha256, bytes: reference.bytes });
		}
		const manifest: CloudFileManifest = {
			schema: FILE_MANIFEST_SCHEMA,
			fileSha256: sha256(bytes),
			bytes: bytes.byteLength,
			mediaType: normalizedMediaType,
			chunks,
		};
		const encoded = Buffer.from(JSON.stringify(manifest), "utf-8");
		const manifestReference = await this.putObject(profileId, encoded, FILE_MANIFEST_MEDIA_TYPE);
		return {
			manifestSha256: manifestReference.sha256,
			fileSha256: manifest.fileSha256,
			bytes: manifest.bytes,
			mediaType: manifest.mediaType,
		};
	}

	async putFileFromPath(
		profileId: string,
		path: string,
		mediaType: string,
		expected: { bytes: number; sha256: string },
	): Promise<StagedCloudFileReference> {
		requiredProfileId(profileId);
		requiredSha256(expected.sha256);
		if (!Number.isSafeInteger(expected.bytes) || expected.bytes < 0 || expected.bytes > MAX_FILE_BYTES) {
			throw new Error("Cloud file exceeds the 256 MiB file limit");
		}
		const normalizedMediaType = requiredMediaType(mediaType);
		const handle = await open(path, "r");
		const chunks: CloudFileChunk[] = [];
		const digest = createHash("sha256");
		let offset = 0;
		try {
			const stat = await handle.stat();
			if (!stat.isFile() || stat.size !== expected.bytes) {
				throw new Error("Cloud file changed before durable staging");
			}
			while (offset < stat.size) {
				const buffer = Buffer.allocUnsafe(Math.min(FILE_CHUNK_BYTES, stat.size - offset));
				const read = await handle.read(buffer, 0, buffer.byteLength, offset);
				if (read.bytesRead !== buffer.byteLength) throw new Error("Cloud file changed during durable staging");
				offset += read.bytesRead;
				digest.update(buffer);
				const reference = await this.putObject(profileId, buffer, "application/octet-stream");
				chunks.push({ sha256: reference.sha256, bytes: reference.bytes });
			}
		} finally {
			await handle.close();
		}
		if (offset !== expected.bytes || digest.digest("hex") !== expected.sha256) {
			throw new Error("Cloud file changed during durable staging");
		}
		const manifest: CloudFileManifest = {
			schema: FILE_MANIFEST_SCHEMA,
			fileSha256: expected.sha256,
			bytes: expected.bytes,
			mediaType: normalizedMediaType,
			chunks,
		};
		const manifestReference = await this.putObject(
			profileId,
			Buffer.from(JSON.stringify(manifest), "utf-8"),
			FILE_MANIFEST_MEDIA_TYPE,
		);
		return {
			manifestSha256: manifestReference.sha256,
			fileSha256: manifest.fileSha256,
			bytes: manifest.bytes,
			mediaType: manifest.mediaType,
			objects: [
				...new Map(
					[
						...chunks.map((chunk) => ({ sha256: chunk.sha256, bytes: chunk.bytes })),
						{ sha256: manifestReference.sha256, bytes: manifestReference.bytes },
					].map((object) => [object.sha256, object]),
				).values(),
			],
		};
	}

	async getFile(profileId: string, reference: CloudFileReference): Promise<Uint8Array> {
		return (await this.restoreFile(profileId, reference)).bytes;
	}

	async restoreFile(profileId: string, reference: CloudFileReference): Promise<RestoredCloudFile> {
		requiredProfileId(profileId);
		requiredSha256(reference.manifestSha256);
		requiredSha256(reference.fileSha256);
		const mediaType = requiredMediaType(reference.mediaType);
		if (!Number.isSafeInteger(reference.bytes) || reference.bytes < 0 || reference.bytes > MAX_FILE_BYTES) {
			throw new Error("Cloud file byte length is invalid");
		}
		const manifestBytes = await this.#transport.get(objectPath(profileId, reference.manifestSha256));
		if (manifestBytes.byteLength > MAX_OBJECT_BYTES || sha256(manifestBytes) !== reference.manifestSha256) {
			throw new Error("Cloud file manifest failed SHA-256 integrity verification");
		}
		const manifest = this.#parseManifest(manifestBytes);
		if (
			manifest.fileSha256 !== reference.fileSha256 ||
			manifest.bytes !== reference.bytes ||
			manifest.mediaType !== mediaType
		) {
			throw new Error("Cloud file reference does not match its manifest");
		}
		const output = new Uint8Array(manifest.bytes);
		const reachable = new Map<string, number>([[reference.manifestSha256, manifestBytes.byteLength]]);
		let offset = 0;
		for (const chunk of manifest.chunks) {
			const chunkBytes = await this.getObject(profileId, {
				sha256: chunk.sha256,
				bytes: chunk.bytes,
				mediaType: "application/octet-stream",
			});
			const existingBytes = reachable.get(chunk.sha256);
			if (existingBytes !== undefined && existingBytes !== chunk.bytes) {
				throw new Error("Cloud file reachability contains inconsistent object sizes");
			}
			reachable.set(chunk.sha256, chunk.bytes);
			output.set(chunkBytes, offset);
			offset += chunkBytes.byteLength;
		}
		if (offset !== output.byteLength || sha256(output) !== reference.fileSha256) {
			throw new Error("Cloud file failed SHA-256 integrity verification");
		}
		return {
			bytes: output,
			objects: [...reachable.entries()]
				.map(([objectSha256, bytes]) => ({ sha256: objectSha256, bytes }))
				.sort((left, right) => left.sha256.localeCompare(right.sha256, "en")),
		};
	}

	#parseManifest(bytes: Uint8Array): CloudFileManifest {
		let parsed: unknown;
		try {
			parsed = JSON.parse(Buffer.from(bytes).toString("utf-8"));
		} catch {
			throw new Error("Cloud file manifest is invalid JSON");
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("Cloud file manifest is invalid");
		}
		const manifest = parsed as Partial<CloudFileManifest>;
		if (
			manifest.schema !== FILE_MANIFEST_SCHEMA ||
			!OBJECT_SHA256_PATTERN.test(manifest.fileSha256 ?? "") ||
			!Number.isSafeInteger(manifest.bytes) ||
			(manifest.bytes ?? -1) < 0 ||
			(manifest.bytes ?? 0) > MAX_FILE_BYTES ||
			!manifest.mediaType ||
			requiredMediaType(manifest.mediaType) !== manifest.mediaType ||
			!Array.isArray(manifest.chunks) ||
			manifest.chunks.some(
				(chunk) =>
					!chunk ||
					!OBJECT_SHA256_PATTERN.test(chunk.sha256) ||
					!Number.isSafeInteger(chunk.bytes) ||
					chunk.bytes < 1 ||
					chunk.bytes > FILE_CHUNK_BYTES,
			) ||
			manifest.chunks.reduce((total, chunk) => total + chunk.bytes, 0) !== manifest.bytes
		) {
			throw new Error("Cloud file manifest is invalid");
		}
		return manifest as CloudFileManifest;
	}
}
