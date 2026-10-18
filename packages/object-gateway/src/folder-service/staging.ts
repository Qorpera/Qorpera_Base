import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { FolderActor, FolderCore } from "./core.ts";
import { type ContentCheck, SaveChecks, type StoredForm } from "./git-objects.ts";
import type { NasObjects } from "./objects.ts";
import type { ChunkRef, Content, FileRef } from "./pending.ts";
import { ErrorCode, ProtocolError } from "./protocol.ts";
import type { SecretSet } from "./secret-scan.ts";

/** One object put through the object gateway's route for the folder service (F3 step 3b), streamed. */
export interface Upload {
	/** Sends the next part; resolves when it may send another. */
	write(part: Buffer): Promise<void>;
	/** Ends the put; resolves once the gateway stored it. */
	end(): Promise<void>;
	abort(): void;
}

export interface FolderUploads {
	start(environmentId: string, actor: FolderActor, intentId: string, sha256: string, bytes: number): Upload;
}

/** What the gateway's answer means to the machine. */
function uploadError(status: number): ProtocolError {
	if (status === 403 || status === 401)
		return new ProtocolError(ErrorCode.denied, "The folder core refused the upload");
	if (status === 413) return new ProtocolError(ErrorCode.tooLarge, "The company's storage is full");
	return new ProtocolError(ErrorCode.unavailable, "The upload did not get through; try again");
}

/** The object gateway's `PUT /v1/folder-service-objects/<environment>/<sha256>` on the folder service's own token. */
export class GatewayUploads implements FolderUploads {
	readonly #origin: URL;
	readonly #token: string;

	constructor(options: { readonly url: string; readonly token: string }) {
		const url = new URL(options.url);
		if ((url.protocol !== "https:" && url.protocol !== "http:") || url.pathname !== "/" || url.search || url.username)
			throw new Error("The object gateway's address must be an exact origin");
		if (!/^[A-Za-z0-9_-]{43}$/.test(options.token)) throw new Error("The folder service's gateway token is invalid");
		this.#origin = url;
		this.#token = options.token;
	}

	start(environmentId: string, actor: FolderActor, intentId: string, sha256: string, bytes: number): Upload {
		const url = new URL(`/v1/folder-service-objects/${environmentId}/${sha256}`, this.#origin);
		const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
			method: "PUT",
			headers: {
				authorization: `Bearer ${this.#token}`,
				"x-qorpera-folder-actor": Buffer.from(JSON.stringify(actor)).toString("base64url"),
				"x-qorpera-upload-intent": intentId,
				"content-type": "application/octet-stream",
				"content-length": String(bytes),
			},
			timeout: 60_000,
		});
		const answer = new Promise<void>((resolve, reject) => {
			request.once("response", (response) => {
				response.resume();
				response.once("end", () =>
					response.statusCode === 200 || response.statusCode === 201
						? resolve()
						: reject(uploadError(response.statusCode ?? 0)),
				);
				response.once("error", () => reject(uploadError(0)));
			});
			request.once("error", () => reject(uploadError(0)));
			request.once("timeout", () => request.destroy(new Error("The upload took too long")));
		});
		void answer.catch(() => undefined);
		return {
			// A part the socket cannot take yet waits for it to drain; a request that fails, times out or is aborted
			// meanwhile fails the wait too (every such end closes it), so nothing hangs on a put that ended.
			write: (part) =>
				new Promise<void>((resolve, reject) => {
					if (request.destroyed) return reject(uploadError(0));
					if (request.write(part)) return resolve();
					const drained = (): void => {
						request.off("close", closed);
						resolve();
					};
					const closed = (): void => {
						request.off("drain", drained);
						reject(uploadError(0));
					};
					request.once("drain", drained);
					request.once("close", closed);
				}),
			end: async () => {
				request.end();
				await answer;
			},
			abort: () => {
				request.destroy();
			},
		};
	}
}

/** The canonical version-2 manifest (C1D §2): keys in this order, no spaces. */
export function manifestText(file: {
	readonly fileSha256: string;
	readonly bytes: number;
	readonly mediaType: string;
	readonly executable: boolean;
	readonly chunks: readonly ChunkRef[];
}): string {
	return JSON.stringify({
		schema: "qorpera.cloud-file-manifest/v2",
		fileSha256: file.fileSha256,
		bytes: file.bytes,
		mediaType: file.mediaType,
		executable: file.executable,
		chunks: file.chunks.map((c) => ({ sha256: c.sha256, bytes: c.bytes })),
	});
}

/** A file's media type from its name: the turn tools' rule first, then a short table; anything else is bytes. */
export function mediaTypeOf(name: string): string {
	const extension = name.toLowerCase().match(/\.([a-z0-9]{1,10})$/)?.[1];
	const known: Record<string, string> = {
		md: "text/markdown",
		txt: "text/plain",
		csv: "text/csv",
		json: "application/json",
		html: "text/html",
		css: "text/css",
		js: "text/javascript",
		ts: "text/plain",
		py: "text/x-python",
		sh: "application/x-sh",
		yaml: "application/yaml",
		yml: "application/yaml",
		toml: "application/toml",
		xml: "application/xml",
		pdf: "application/pdf",
		png: "image/png",
		jpg: "image/jpeg",
		jpeg: "image/jpeg",
		gif: "image/gif",
		svg: "image/svg+xml",
		webp: "image/webp",
		odt: "application/vnd.oasis.opendocument.text",
		ods: "application/vnd.oasis.opendocument.spreadsheet",
		docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		zip: "application/zip",
	};
	return (extension && known[extension]) || "application/octet-stream";
}

/**
 * Staging for one node's views (RUNTIME-FOLDER-WRITES.md, "Pending bytes"): a chunk sent while its file is still open
 * goes under an intent of its own (a one-chunk manifest, never sealed); a closed file's manifest goes under the file's
 * intent, which holds the chunks the view put already (3a) and is sealed. Every intent is the view's actor's.
 */
export class FolderStaging {
	readonly #core: FolderCore;
	readonly #uploads: FolderUploads;
	readonly #objects: NasObjects;
	readonly #checks: SaveChecks;

	constructor(core: FolderCore, uploads: FolderUploads, objects: NasObjects, checks = new SaveChecks()) {
		this.#core = core;
		this.#uploads = uploads;
		this.#objects = objects;
		this.#checks = checks;
	}

	/** Opens a chunk's own intent. `present`: the actor holds it already, and need not send it. */
	async openChunk(
		environmentId: string,
		actor: FolderActor,
		sha256: string,
		bytes: number,
	): Promise<{ intentId: string; present: boolean }> {
		const manifest = manifestText({
			fileSha256: sha256,
			bytes,
			mediaType: "application/octet-stream",
			executable: false,
			chunks: [{ sha256, bytes }],
		});
		const open = await this.#core.openUpload(environmentId, actor, manifest);
		return { intentId: open.intentId, present: open.present.includes(sha256) };
	}

	/** Holds a pending chunk again under a new intent of its own, after its intent lapsed: put again from the share
	 * when the actor no longer holds it. Returns the new intent. */
	async holdChunk(
		environmentId: string,
		actor: FolderActor,
		profileId: string,
		sha256: string,
		bytes: number,
	): Promise<string> {
		const open = await this.openChunk(environmentId, actor, sha256, bytes);
		if (!open.present)
			await this.#put(
				environmentId,
				actor,
				open.intentId,
				sha256,
				await this.#objects.chunk(profileId, sha256, bytes),
			);
		return open.intentId;
	}

	/** Starts streaming a chunk under its intent. */
	upload(environmentId: string, actor: FolderActor, intentId: string, sha256: string, bytes: number): Upload {
		return this.#uploads.start(environmentId, actor, intentId, sha256, bytes);
	}

	/** Stages a whole file: its hash from its chunks on the share, its manifest, any chunk the actor does not hold, and
	 * the seal. Returns the file's reference and the sealed intent that holds its bytes until it is published (renewed
	 * by the caller while it waits). With `secrets`, its bytes are checked for them first, as `form` stores them: it
	 * throws `SecretRefusal` before anything is sent to the core. */
	async stageFile(
		environmentId: string,
		actor: FolderActor,
		profileId: string,
		content: Content,
		mediaType: string,
		executable: boolean,
		secrets?: SecretSet,
		form: StoredForm = "plain",
	): Promise<{ readonly file: FileRef; readonly intentId: string }> {
		const hash = createHash("sha256");
		await this.#read(profileId, content, secrets && this.#checks.start(secrets, content.size, form), (bytes) =>
			hash.update(bytes),
		);
		const text = manifestText({
			fileSha256: hash.digest("hex"),
			bytes: content.size,
			mediaType,
			executable,
			chunks: content.chunks,
		});
		const manifest = Buffer.from(text);
		const manifestSha256 = createHash("sha256").update(manifest).digest("hex");
		for (let attempt = 0; attempt < 2; attempt++) {
			const open = await this.#core.openUpload(environmentId, actor, text);
			const present = new Set(open.present);
			for (const c of content.chunks)
				if (!present.has(c.sha256)) {
					present.add(c.sha256);
					await this.#put(
						environmentId,
						actor,
						open.intentId,
						c.sha256,
						await this.#objects.chunk(profileId, c.sha256, c.bytes),
					);
				}
			if (!present.has(manifestSha256))
				await this.#put(environmentId, actor, open.intentId, manifestSha256, manifest);
			const seal = await this.#core.sealUpload(environmentId, actor, open.intentId);
			if (seal.state === "sealed") return { file: seal.file, intentId: open.intentId };
		}
		throw new ProtocolError(ErrorCode.unavailable, "The file's bytes could not be saved now");
	}

	/** Checks a file's bytes, from its chunks on the share, for `secrets`, as `form` stores them: throws
	 * `SecretRefusal` if they carry one or cannot be checked. */
	async check(profileId: string, content: Content, secrets: SecretSet, form: StoredForm = "plain"): Promise<void> {
		if (secrets.size === 0) return;
		await this.#read(profileId, content, this.#checks.start(secrets, content.size, form));
	}

	/** Reads a file's chunks in order, each through `check` (to its end) and then `each`. A check that fails, or is
	 * left by a failed read, is stopped. */
	async #read(
		profileId: string,
		content: Content,
		check: ContentCheck | undefined,
		each?: (bytes: Buffer) => void,
	): Promise<void> {
		try {
			for (const c of content.chunks) {
				const bytes = await this.#objects.chunk(profileId, c.sha256, c.bytes);
				await check?.push(bytes);
				each?.(bytes);
			}
			await check?.end();
		} catch (error) {
			await check?.abort();
			throw error;
		}
	}

	async #put(
		environmentId: string,
		actor: FolderActor,
		intentId: string,
		sha256: string,
		bytes: Buffer,
	): Promise<void> {
		const upload = this.#uploads.start(environmentId, actor, intentId, sha256, bytes.byteLength);
		try {
			if (bytes.byteLength > 0) await upload.write(bytes);
			await upload.end();
		} catch (error) {
			upload.abort();
			throw error;
		}
	}
}
