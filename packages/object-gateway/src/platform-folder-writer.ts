import { createHash } from "node:crypto";
import { ObjectDependencyError } from "./dependency.ts";
import type { MemberCompanyAuthority, MemberCompanyPublisherRpc } from "./member-company-authority.ts";
import type { FileSystemObjectStore } from "./object-store.ts";
import type { ObjectGatewayReplication } from "./replication.ts";

/*
 * The folder core's platform writes for the gateway's own workers (core §3 "Who calls it"): the vault's
 * connection-file writer (P22b, connection-files.ts) and company creation (F2's P14b). A worker claims its work with
 * a lease from its own SQL function and finishes it there; between the two it uses this: stage a file's bytes as the
 * platform (an upload intent for its version-2 manifest, the objects the catalog lacks put into this gateway's store
 * and confirmed, then the seal into the file's reference), read a folder file back from the store, and commit as the
 * platform. Each call goes to the database with the service key; nothing here holds a lease or a lock.
 */

export const PLATFORM_ACTOR = Object.freeze({ kind: "platform" });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** A chunk and the manifest's bound (C1D §2): 64 chunks of 4 MiB. */
const CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_CHUNKS = 64;
const MAX_MANIFEST_BYTES = 32 * 1024;

/** Why a platform write could not be done as asked: a code a worker's finish keeps, never a message. */
export class PlatformFolderProblem extends Error {
	readonly code: string;
	constructor(code: string) {
		super(`Platform folder write problem: ${code}`);
		this.name = "PlatformFolderProblem";
		this.code = code;
	}
}

export const platformFolderProblem = (code: string): never => {
	throw new PlatformFolderProblem(code);
};

/** A worker's problem code for any failure: its own, the database's lock conflict or outage, or a refusal. */
export function platformFolderProblemCode(error: unknown): string {
	return error instanceof PlatformFolderProblem
		? error.code
		: error instanceof ObjectDependencyError
			? error.lockConflict
				? "lock_conflict"
				: error.unavailable
					? "unavailable"
					: "refused"
			: "writer_failed";
}

/** Runs `claimOne` until it reports that nothing is due or `max` were handled; returns how many were handled. */
export async function drainPlatformClaims(max: number, claimOne: () => Promise<boolean>): Promise<number> {
	let handled = 0;
	while (handled < max && (await claimOne())) handled++;
	return handled;
}

/** A staged file, as a commit unit's `file` names it. */
export interface PlatformFileReference {
	readonly manifestSha256: string;
	readonly fileSha256: string;
	readonly bytes: number;
	readonly mediaType: string;
	readonly executable: boolean;
}

export type PlatformFolderRpc = Extract<
	MemberCompanyPublisherRpc,
	| "qorpera_folder_authorize_object_download"
	| "qorpera_folder_open_upload"
	| "qorpera_folder_authorize_object_upload"
	| "qorpera_folder_confirm_object"
	| "qorpera_folder_seal_upload"
	| "qorpera_folder_commit"
>;

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function sealedFile(value: unknown): PlatformFileReference {
	const file = value as Record<string, unknown> | null;
	if (
		!file ||
		typeof file !== "object" ||
		Object.keys(file).sort().join() !== "bytes,executable,fileSha256,manifestSha256,mediaType" ||
		typeof file.manifestSha256 !== "string" ||
		typeof file.fileSha256 !== "string" ||
		!Number.isSafeInteger(file.bytes) ||
		typeof file.mediaType !== "string" ||
		typeof file.executable !== "boolean"
	)
		return platformFolderProblem("stage_invalid");
	return file as unknown as PlatformFileReference;
}

export interface PlatformFolderWriterOptions {
	readonly authority: Pick<MemberCompanyAuthority, "publisher">;
	readonly store: Pick<FileSystemObjectStore, "get">;
	readonly replication: Pick<ObjectGatewayReplication, "uploadWithAuthority">;
}

export class PlatformFolderWriter {
	readonly #options: PlatformFolderWriterOptions;

	constructor(options: PlatformFolderWriterOptions) {
		this.#options = options;
	}

	/** Stages `bytes` as the platform in one folder-v2 environment and returns the file's reference for a commit. */
	async stage(
		environmentId: string,
		bytes: Uint8Array,
		kind: { readonly mediaType: string; readonly executable: boolean },
		signal: AbortSignal,
	): Promise<PlatformFileReference> {
		if (bytes.byteLength > MAX_CHUNKS * CHUNK_BYTES) platformFolderProblem("file_too_large");
		const objects = new Map<string, Uint8Array>();
		const chunks: { sha256: string; bytes: number }[] = [];
		for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
			const chunk = bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, bytes.byteLength));
			chunks.push({ sha256: sha256(chunk), bytes: chunk.byteLength });
			objects.set(sha256(chunk), chunk);
		}
		const fileSha256 = sha256(bytes);
		// The canonical version-2 manifest: keys in this order, no spaces, so the same file gives the same manifest.
		const manifestText = JSON.stringify({
			schema: "qorpera.cloud-file-manifest/v2",
			fileSha256,
			bytes: bytes.byteLength,
			mediaType: kind.mediaType,
			executable: kind.executable,
			chunks,
		});
		const manifestBytes = new TextEncoder().encode(manifestText);
		const manifestSha256 = sha256(manifestBytes);
		objects.set(manifestSha256, manifestBytes);
		const open = (await this.#rpc(
			"qorpera_folder_open_upload",
			{ p_environment_id: environmentId, p_actor: PLATFORM_ACTOR, p_manifest: manifestText },
			signal,
		)) as { schema?: unknown; intentId?: unknown; manifestSha256?: unknown; present?: unknown } | null;
		if (
			open?.schema !== "qorpera.folder-upload/v1" ||
			typeof open.intentId !== "string" ||
			!UUID.test(open.intentId) ||
			open.manifestSha256 !== manifestSha256 ||
			!Array.isArray(open.present)
		)
			return platformFolderProblem("stage_invalid");
		const intentId = open.intentId;
		const present = new Set(open.present as string[]);
		const putAll = async (hashes: Iterable<string>) => {
			for (const hash of hashes) {
				const object = objects.get(hash) ?? platformFolderProblem("stage_invalid");
				const authorize = () => this.#uploadProfile(environmentId, intentId, hash, object.byteLength, signal);
				const profileId = await authorize();
				await this.#options.replication.uploadWithAuthority(profileId, hash, object, {
					authorize: async () => {
						if ((await authorize()) !== profileId) throw new ObjectDependencyError(403);
					},
					confirm: () => this.#confirm(environmentId, intentId, hash, object.byteLength, signal),
				});
			}
		};
		await putAll([...objects.keys()].filter((hash) => !present.has(hash)));
		let sealed = await this.#seal(environmentId, intentId, signal);
		// An object the catalog lost meanwhile is put once more.
		if (sealed.state === "incomplete") {
			await putAll(sealed.missing);
			sealed = await this.#seal(environmentId, intentId, signal);
		}
		const file = sealed.state === "sealed" ? sealed.file : platformFolderProblem("stage_incomplete");
		if (
			file.manifestSha256 !== manifestSha256 ||
			file.fileSha256 !== fileSha256 ||
			file.bytes !== bytes.byteLength ||
			file.mediaType !== kind.mediaType ||
			file.executable !== kind.executable
		)
			platformFolderProblem("stage_invalid");
		return file;
	}

	/** A folder file's bytes, read from this gateway's store by its manifest, at most `maxBytes`. */
	async read(
		environmentId: string,
		file: { readonly manifestSha256: string; readonly fileSha256: string; readonly bytes: number },
		maxBytes: number,
		signal: AbortSignal,
	): Promise<Uint8Array> {
		if (file.bytes > maxBytes) platformFolderProblem("file_too_large");
		const manifestBytes = await this.#object(environmentId, file.manifestSha256, signal);
		if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) platformFolderProblem("file_unreadable");
		let manifest: { schema?: unknown; fileSha256?: unknown; bytes?: unknown; chunks?: unknown };
		try {
			manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
		} catch {
			return platformFolderProblem("file_unreadable");
		}
		if (
			manifest.schema !== "qorpera.cloud-file-manifest/v2" ||
			manifest.fileSha256 !== file.fileSha256 ||
			manifest.bytes !== file.bytes ||
			!Array.isArray(manifest.chunks) ||
			manifest.chunks.length > MAX_CHUNKS
		)
			platformFolderProblem("file_unreadable");
		const parts: Uint8Array[] = [];
		for (const chunk of manifest.chunks as { sha256?: unknown }[]) {
			if (typeof chunk?.sha256 !== "string" || !SHA256.test(chunk.sha256)) platformFolderProblem("file_unreadable");
			parts.push(await this.#object(environmentId, chunk.sha256 as string, signal));
		}
		const bytes = Buffer.concat(parts);
		if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.fileSha256)
			platformFolderProblem("file_unreadable");
		return bytes;
	}

	/** Commits `units` as the platform under `operationKey`; the answer is the commit's (`qorpera.folder-commit/v1`). */
	commit(
		environmentId: string,
		operationKey: string,
		units: readonly unknown[],
		signal: AbortSignal,
	): Promise<unknown> {
		return this.#rpc(
			"qorpera_folder_commit",
			{ p_environment_id: environmentId, p_actor: PLATFORM_ACTOR, p_operation_key: operationKey, p_units: units },
			signal,
		);
	}

	async #object(environmentId: string, hash: string, signal: AbortSignal): Promise<Uint8Array> {
		const answer = (await this.#rpc(
			"qorpera_folder_authorize_object_download",
			{ p_environment_id: environmentId, p_actor: PLATFORM_ACTOR, p_sha256: hash },
			signal,
		)) as { schema?: unknown; profileId?: unknown; bytes?: unknown } | null;
		if (
			answer?.schema !== "qorpera.folder-object-download/v1" ||
			typeof answer.profileId !== "string" ||
			!UUID.test(answer.profileId) ||
			!Number.isSafeInteger(answer.bytes)
		)
			return platformFolderProblem("file_unreadable");
		const bytes = await this.#options.store.get(answer.profileId, hash, answer.bytes as number);
		if (sha256(bytes) !== hash) platformFolderProblem("file_unreadable");
		return bytes;
	}

	async #uploadProfile(environmentId: string, intentId: string, hash: string, bytes: number, signal: AbortSignal) {
		const answer = (await this.#rpc(
			"qorpera_folder_authorize_object_upload",
			{
				p_environment_id: environmentId,
				p_actor: PLATFORM_ACTOR,
				p_intent: intentId,
				p_sha256: hash,
				p_bytes: bytes,
			},
			signal,
		)) as { schema?: unknown; profileId?: unknown } | null;
		if (
			answer?.schema !== "qorpera.folder-object-upload/v1" ||
			typeof answer.profileId !== "string" ||
			!UUID.test(answer.profileId)
		)
			throw new ObjectDependencyError(403);
		return answer.profileId;
	}

	async #confirm(environmentId: string, intentId: string, hash: string, bytes: number, signal: AbortSignal) {
		const answer = (await this.#rpc(
			"qorpera_folder_confirm_object",
			{
				p_environment_id: environmentId,
				p_actor: PLATFORM_ACTOR,
				p_intent: intentId,
				p_sha256: hash,
				p_bytes: bytes,
			},
			signal,
		)) as { schema?: unknown; sha256?: unknown; bytes?: unknown } | null;
		if (answer?.schema !== "qorpera.folder-object/v1" || answer.sha256 !== hash || answer.bytes !== bytes)
			throw new ObjectDependencyError(403);
	}

	async #seal(
		environmentId: string,
		intentId: string,
		signal: AbortSignal,
	): Promise<{ state: "sealed"; file: PlatformFileReference } | { state: "incomplete"; missing: string[] }> {
		const value = (await this.#rpc(
			"qorpera_folder_seal_upload",
			{ p_environment_id: environmentId, p_actor: PLATFORM_ACTOR, p_intent: intentId },
			signal,
		)) as { schema?: unknown; state?: unknown; intentId?: unknown; missing?: unknown; file?: unknown } | null;
		if (value?.schema !== "qorpera.folder-seal/v1" || value.intentId !== intentId)
			return platformFolderProblem("stage_invalid");
		if (value.state === "incomplete") {
			if (
				!Array.isArray(value.missing) ||
				value.missing.some((hash) => typeof hash !== "string" || !SHA256.test(hash))
			)
				return platformFolderProblem("stage_invalid");
			return { state: "incomplete", missing: value.missing as string[] };
		}
		if (value.state !== "sealed") return platformFolderProblem("stage_invalid");
		return { state: "sealed", file: sealedFile(value.file) };
	}

	#rpc(method: PlatformFolderRpc, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
		return this.#options.authority.publisher(method, args, signal);
	}
}
