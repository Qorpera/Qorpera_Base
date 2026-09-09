import { createHash } from "node:crypto";
import {
	type CompanyFileTransferSource,
	parseCompanyFileTransferSource,
} from "@qorpera/cloud-client/cloud-file-transfer";
import type { CloudObjectTransport } from "@qorpera/cloud-client/node/cloud-object-store";

/** Call only after current path/version authorization. Verify the exact manifest,
 * every chunk and complete binary contents before exposing any workbench bytes. */
export async function readCompanyFileTransfer(
	source: CompanyFileTransferSource,
	objects: Pick<CloudObjectTransport, "get">,
	signal: AbortSignal,
): Promise<Uint8Array> {
	source = parseCompanyFileTransferSource(source);
	const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
	const get = async (hash: string, length: number) => {
		signal.throwIfAborted();
		const bytes = Uint8Array.from(await objects.get(`${source.companyId}/${hash}`));
		signal.throwIfAborted();
		if (bytes.length !== length || sha(bytes) !== hash) throw new Error("COMPANY_FILE_TRANSFER_BYTES_CHANGED");
		return bytes;
	};
	const manifest: unknown = JSON.parse(
		new TextDecoder("utf-8", { fatal: true }).decode(await get(source.manifestSha256, source.manifestBytes)),
	);
	if (
		!manifest ||
		typeof manifest !== "object" ||
		Array.isArray(manifest) ||
		Object.keys(manifest).sort().join() !== "bytes,chunks,fileSha256,mediaType,schema"
	)
		throw new Error("INVALID_COMPANY_FILE_TRANSFER_MANIFEST");
	const row = manifest as Record<string, unknown>;
	if (
		row.schema !== "qorpera.cloud-file-manifest/v1" ||
		row.bytes !== source.bytes ||
		row.fileSha256 !== source.sha256 ||
		row.mediaType !== source.mediaType ||
		!Array.isArray(row.chunks) ||
		row.chunks.length > 2
	)
		throw new Error("INVALID_COMPANY_FILE_TRANSFER_MANIFEST");
	const chunks = row.chunks.map((value: unknown, index: number) => {
		if (
			!value ||
			typeof value !== "object" ||
			Array.isArray(value) ||
			Object.keys(value).sort().join() !== "bytes,sha256"
		)
			throw new Error("INVALID_COMPANY_FILE_TRANSFER_CHUNK");
		const chunk = value as { sha256: unknown; bytes: unknown };
		if (
			typeof chunk.sha256 !== "string" ||
			!/^[a-f0-9]{64}$/.test(chunk.sha256) ||
			!Number.isSafeInteger(chunk.bytes) ||
			(chunk.bytes as number) < 1 ||
			(chunk.bytes as number) > 4194304 ||
			(index < (row.chunks as unknown[]).length - 1 && chunk.bytes !== 4194304)
		)
			throw new Error("INVALID_COMPANY_FILE_TRANSFER_CHUNK");
		return { sha256: chunk.sha256, bytes: chunk.bytes as number };
	});
	if (chunks.reduce((sum, chunk) => sum + chunk.bytes, 0) !== source.bytes)
		throw new Error("INVALID_COMPANY_FILE_TRANSFER_LENGTH");
	const output = new Uint8Array(source.bytes);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(await get(chunk.sha256, chunk.bytes), offset);
		offset += chunk.bytes;
	}
	if (sha(output) !== source.sha256) throw new Error("COMPANY_FILE_TRANSFER_BYTES_CHANGED");
	signal.throwIfAborted();
	return output;
}
