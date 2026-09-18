/** Browser-safe verification of one immutable Company File. Callers own the
 * authenticated transport and must recheck live path authority before release. */
export interface CloudFileBytesReference {
	manifestSha256: string;
	fileSha256: string;
	bytes: number;
	mediaType: string;
}

const SHA = /^[a-f0-9]{64}$/;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const CHUNK_BYTES = 4 * 1024 * 1024;

function closed(value: unknown, keys: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys)
		throw new Error("Invalid Company File manifest");
	return value as Record<string, unknown>;
}

export async function cloudFileBytesSha256(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function readCloudFileBytes(
	reference: CloudFileBytesReference,
	manifestBytes: number,
	get: (sha256: string, bytes: number, signal: AbortSignal) => Promise<Uint8Array>,
	signal: AbortSignal,
): Promise<Uint8Array> {
	reference = { ...reference };
	if (
		!SHA.test(reference.manifestSha256) ||
		!SHA.test(reference.fileSha256) ||
		reference.mediaType !== "application/octet-stream" ||
		!Number.isSafeInteger(reference.bytes) ||
		reference.bytes < 0 ||
		reference.bytes > MAX_FILE_BYTES ||
		!Number.isSafeInteger(manifestBytes) ||
		manifestBytes < 1 ||
		manifestBytes > 8 * 1024 * 1024
	)
		throw new Error("Invalid Company File reference");
	const verified = async (hash: string, size: number) => {
		signal.throwIfAborted();
		const bytes = Uint8Array.from(await get(hash, size, signal));
		if (bytes.length !== size || (await cloudFileBytesSha256(bytes)) !== hash)
			throw new Error("Company File object failed integrity verification");
		signal.throwIfAborted();
		return bytes;
	};
	const manifest = closed(
		JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(await verified(reference.manifestSha256, manifestBytes)),
		),
		"bytes,chunks,fileSha256,mediaType,schema",
	);
	if (
		manifest.schema !== "qorpera.cloud-file-manifest/v1" ||
		manifest.fileSha256 !== reference.fileSha256 ||
		manifest.bytes !== reference.bytes ||
		manifest.mediaType !== reference.mediaType ||
		!Array.isArray(manifest.chunks) ||
		manifest.chunks.length > MAX_FILE_BYTES / CHUNK_BYTES
	)
		throw new Error("Company File reference does not match its manifest");
	const count = manifest.chunks.length;
	const chunks = manifest.chunks.map((input, index) => {
		const value = closed(input, "bytes,sha256");
		if (
			typeof value.sha256 !== "string" ||
			!SHA.test(value.sha256) ||
			!Number.isSafeInteger(value.bytes) ||
			(value.bytes as number) < 1 ||
			(value.bytes as number) > CHUNK_BYTES ||
			(index < count - 1 && value.bytes !== CHUNK_BYTES)
		)
			throw new Error("Invalid Company File chunk");
		return { sha256: value.sha256, bytes: value.bytes as number };
	});
	if (chunks.reduce((sum, chunk) => sum + chunk.bytes, 0) !== reference.bytes)
		throw new Error("Invalid Company File manifest length");
	const output = new Uint8Array(reference.bytes);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(await verified(chunk.sha256, chunk.bytes), offset);
		offset += chunk.bytes;
	}
	if ((await cloudFileBytesSha256(output)) !== reference.fileSha256)
		throw new Error("Company File failed integrity verification");
	signal.throwIfAborted();
	return output;
}
