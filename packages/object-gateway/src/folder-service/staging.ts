import { createHash } from "node:crypto";
import { type ClientRequest, Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import type { FolderActor, FolderCore } from "./core.ts";
import { type ContentCheck, SaveChecks, type StoredForm } from "./git-objects.ts";
import { CHUNK_BYTES, type NasObjects } from "./objects.ts";
import type { ChunkRef, Content, FileRef } from "./pending.ts";
import { ErrorCode, ProtocolError } from "./protocol.ts";
import type { SecretSet } from "./secret-scan.ts";

export const STAGE_CONCURRENCY = 4;

const REUSED_RESET_CODES = new Set(["ECONNRESET", "EPIPE", "ERR_SOCKET_CLOSED"]);

class ReusedSocketResetError extends Error {}

interface OpenedRequest {
	readonly request: ClientRequest;
	readonly answer: Promise<void>;
	readonly earlyError: () => ProtocolError | undefined;
}

function isReusedSocketReset(request: ClientRequest, error: unknown): boolean {
	if (!request.reusedSocket || !(error instanceof Error)) return false;
	return "code" in error && typeof error.code === "string" && REUSED_RESET_CODES.has(error.code);
}

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
	close?(): void;
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
	readonly #ca: string | undefined;
	readonly #agent: HttpAgent | HttpsAgent;

	constructor(options: { readonly url: string; readonly token: string; readonly ca?: string }) {
		const url = new URL(options.url);
		if ((url.protocol !== "https:" && url.protocol !== "http:") || url.pathname !== "/" || url.search || url.username)
			throw new Error("The object gateway's address must be an exact origin");
		if (!/^[A-Za-z0-9_-]{43}$/.test(options.token)) throw new Error("The folder service's gateway token is invalid");
		if (options.ca !== undefined && !options.ca.includes("-----BEGIN CERTIFICATE-----"))
			throw new Error("The object gateway's CA certificate is invalid");
		this.#origin = url;
		this.#token = options.token;
		this.#ca = options.ca;
		this.#agent =
			url.protocol === "https:"
				? new HttpsAgent({
						keepAlive: true,
						keepAliveMsecs: 30_000,
						maxSockets: 32,
						maxFreeSockets: 16,
						...(options.ca ? { ca: options.ca, minVersion: "TLSv1.2" } : {}),
					})
				: new HttpAgent({
						keepAlive: true,
						keepAliveMsecs: 30_000,
						maxSockets: 32,
						maxFreeSockets: 16,
					});
	}

	close(): void {
		this.#agent.destroy();
	}

	#openRequest(url: URL, headers: Record<string, string>, agent: HttpAgent | HttpsAgent | false): OpenedRequest {
		const request =
			url.protocol === "https:"
				? httpsRequest(url, {
						method: "PUT",
						headers,
						timeout: 60_000,
						agent,
						...(this.#ca ? { ca: this.#ca, minVersion: "TLSv1.2" } : {}),
					})
				: httpRequest(url, { method: "PUT", headers, timeout: 60_000, agent });
		let settled = false;
		let earlyError: ProtocolError | undefined;
		let responseSeen = false;
		const answer = new Promise<void>((resolve, reject) => {
			const fail = (error: ProtocolError | ReusedSocketResetError): void => {
				if (settled) return;
				settled = true;
				if (error instanceof ProtocolError) earlyError ??= error;
				reject(error);
			};
			const ok = (): void => {
				if (settled) return;
				settled = true;
				resolve();
			};
			request.once("response", (response) => {
				responseSeen = true;
				const status = response.statusCode ?? 0;
				if (status !== 200 && status !== 201) earlyError = uploadError(status);
				response.resume();
				response.once("end", () =>
					status === 200 || status === 201 ? ok() : fail(earlyError ?? uploadError(status)),
				);
				response.once("error", () => fail(earlyError ?? uploadError(0)));
				response.once("close", () => {
					if (!response.complete) fail(earlyError ?? uploadError(0));
				});
			});
			request.once("error", (error) => {
				fail(
					earlyError ??
						(!responseSeen && isReusedSocketReset(request, error)
							? new ReusedSocketResetError()
							: uploadError(0)),
				);
			});
			request.once("close", () => {
				if (!responseSeen) fail(earlyError ?? uploadError(0));
			});
			request.once("timeout", () => request.destroy(new Error("The upload took too long")));
		});
		void answer.catch(() => undefined);
		return { request, answer, earlyError: () => earlyError };
	}

	start(environmentId: string, actor: FolderActor, intentId: string, sha256: string, bytes: number): Upload {
		const url = new URL(`/v1/folder-service-objects/${environmentId}/${sha256}`, this.#origin);
		const headers = {
			authorization: `Bearer ${this.#token}`,
			"x-qorpera-folder-actor": Buffer.from(JSON.stringify(actor)).toString("base64url"),
			"x-qorpera-upload-intent": intentId,
			"content-type": "application/octet-stream",
			"content-length": String(bytes),
		};
		let aborted = false;
		let streamed = false;
		let singlePart: Buffer | undefined;
		let active: OpenedRequest | undefined;

		const failWrite = (opened: OpenedRequest): Promise<never> => {
			const early = opened.earlyError();
			if (early !== undefined) return Promise.reject(early);
			return opened.answer.then(
				() => Promise.reject(uploadError(0)),
				(error) => Promise.reject(error instanceof ReusedSocketResetError ? uploadError(0) : error),
			);
		};

		const writePart = (opened: OpenedRequest, part: Buffer): Promise<void> =>
			new Promise<void>((resolve, reject) => {
				if (opened.earlyError() !== undefined || opened.request.destroyed) {
					void failWrite(opened).then(resolve, reject);
					return;
				}
				if (opened.request.write(part)) return resolve();
				const drained = (): void => {
					opened.request.off("close", closed);
					resolve();
				};
				const closed = (): void => {
					opened.request.off("drain", drained);
					void failWrite(opened).then(resolve, reject);
				};
				opened.request.once("drain", drained);
				opened.request.once("close", closed);
			});

		const sendSingle = async (agent: HttpAgent | HttpsAgent | false, body: Buffer | undefined): Promise<void> => {
			if (aborted) throw uploadError(0);
			const opened = this.#openRequest(url, headers, agent);
			active = opened;
			try {
				if (body && body.byteLength > 0) opened.request.end(body);
				else opened.request.end();
				await opened.answer;
			} catch (error) {
				opened.request.destroy();
				throw error;
			}
		};

		return {
			write: async (part) => {
				if (aborted) throw uploadError(0);
				if (part.byteLength === 0) return;
				// WHY: hold a single full-body write until end() so a stale keep-alive socket reset can retry once without copying.
				if (!active && !streamed && singlePart === undefined && part.byteLength === bytes) {
					singlePart = part;
					return;
				}
				streamed = true;
				if (!active) active = this.#openRequest(url, headers, this.#agent);
				if (singlePart !== undefined) {
					const first = singlePart;
					singlePart = undefined;
					await writePart(active, first);
				}
				await writePart(active, part);
			},
			end: async () => {
				if (aborted) throw uploadError(0);
				if (active) {
					active.request.end();
					try {
						await active.answer;
					} catch (error) {
						throw error instanceof ReusedSocketResetError ? uploadError(0) : error;
					}
					return;
				}
				const body = singlePart;
				singlePart = undefined;
				try {
					await sendSingle(this.#agent, body);
				} catch (error) {
					if (aborted || !(error instanceof ReusedSocketResetError)) {
						throw error instanceof ReusedSocketResetError ? uploadError(0) : error;
					}
					try {
						await sendSingle(false, body);
					} catch (retryError) {
						throw retryError instanceof ReusedSocketResetError ? uploadError(0) : retryError;
					}
				}
			},
			abort: () => {
				aborted = true;
				singlePart = undefined;
				active?.request.destroy();
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

const UPLOAD_BUFFER_CAP_BYTES = 32 * 1024 * 1024;

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
	readonly #uploadBufferMax: number;
	#uploadBufferBytes = 0;

	constructor(core: FolderCore, uploads: FolderUploads, objects: NasObjects, checks = new SaveChecks()) {
		this.#core = core;
		this.#uploads = uploads;
		this.#objects = objects;
		this.#checks = checks;
		this.#uploadBufferMax = Math.min(UPLOAD_BUFFER_CAP_BYTES, objects.maxCacheBytes);
	}

	close(): void {
		this.#uploads.close?.();
	}

	/** Opens a chunk's own intent. `present`: the actor holds it already, and need not send it. */
	async openChunk(
		environmentId: string,
		actor: FolderActor,
		sha256: string,
		bytes: number,
		mediaType = "application/octet-stream",
		executable = false,
	): Promise<{ intentId: string; present: boolean; manifestSha256: string; manifestPresent: boolean }> {
		const manifest = manifestText({
			fileSha256: sha256,
			bytes,
			mediaType,
			executable,
			chunks: [{ sha256, bytes }],
		});
		const manifestSha256 = createHash("sha256").update(manifest).digest("hex");
		const open = await this.#core.openUpload(environmentId, actor, manifest);
		return {
			intentId: open.intentId,
			present: open.present.includes(sha256),
			manifestSha256,
			manifestPresent: open.present.includes(manifestSha256),
		};
	}

	/** Holds a pending chunk again under a new intent of its own, after its intent lapsed: put again from the share
	 * when the actor no longer holds it. Returns the new intent. */
	async holdChunk(
		environmentId: string,
		actor: FolderActor,
		profileId: string,
		sha256: string,
		bytes: number,
		mediaType = "application/octet-stream",
		executable = false,
	): Promise<{ intentId: string; manifestSha256: string; manifestPresent: boolean }> {
		const open = await this.openChunk(environmentId, actor, sha256, bytes, mediaType, executable);
		if (!open.present)
			await this.#put(
				environmentId,
				actor,
				open.intentId,
				sha256,
				await this.#objects.chunk(profileId, sha256, bytes),
			);
		return { intentId: open.intentId, manifestSha256: open.manifestSha256, manifestPresent: open.manifestPresent };
	}

	/** Starts streaming a chunk under its intent. */
	upload(
		environmentId: string,
		actor: FolderActor,
		intentId: string,
		sha256: string,
		bytes: number,
		profileId?: string,
	): Upload {
		const inner = this.#uploads.start(environmentId, actor, intentId, sha256, bytes);
		if (
			!profileId ||
			bytes < 1 ||
			bytes > CHUNK_BYTES ||
			!this.#objects.canCache(bytes) ||
			this.#objects.has(profileId, sha256)
		)
			return inner;
		let single: Buffer | undefined;
		let buffer: Buffer | undefined;
		let reserved = 0;
		let written = 0;
		let overflow = false;
		const release = (): void => {
			if (reserved > 0) {
				this.#uploadBufferBytes -= reserved;
				reserved = 0;
			}
			single = undefined;
			buffer = undefined;
		};
		return {
			write: async (part) => {
				try {
					await inner.write(part);
				} catch (error) {
					release();
					throw error;
				}
				if (overflow || part.byteLength === 0) return;
				if (written + part.byteLength > bytes) {
					overflow = true;
					release();
					return;
				}
				if (written === 0 && part.byteLength === bytes) {
					single = part;
					written = part.byteLength;
					return;
				}
				if (!buffer) {
					if (this.#uploadBufferBytes + bytes > this.#uploadBufferMax) {
						overflow = true;
						return;
					}
					this.#uploadBufferBytes += bytes;
					reserved = bytes;
					buffer = Buffer.allocUnsafeSlow(bytes);
				}
				part.copy(buffer, written);
				written += part.byteLength;
			},
			end: async () => {
				try {
					await inner.end();
					const body = single ?? buffer;
					// WHY: seed ByteCache only after the gateway confirms the upload; manifests stay uncached so publish reads remain verified.
					if (!overflow && body && written === bytes) this.#objects.put(profileId, sha256, body);
				} finally {
					release();
				}
			},
			abort: () => {
				release();
				inner.abort();
			},
		};
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
		existingIntent?: {
			readonly intentId: string;
			readonly manifestSha256: string;
			readonly manifestPresent: boolean;
		},
	): Promise<{ readonly file: FileRef; readonly intentId: string }> {
		const singleChunk = content.chunks.length === 1 && content.chunks[0]!.bytes === content.size;
		const hash = singleChunk ? undefined : createHash("sha256");
		const check = secrets && secrets.size > 0 ? this.#checks.start(secrets, content.size, form) : undefined;
		if (check || hash) {
			await this.#read(profileId, content, check, hash ? (bytes) => hash.update(bytes) : undefined);
		}
		const text = manifestText({
			fileSha256: singleChunk ? content.chunks[0]!.sha256 : hash!.digest("hex"),
			bytes: content.size,
			mediaType,
			executable,
			chunks: content.chunks,
		});
		const manifest = Buffer.from(text);
		const manifestSha256 = createHash("sha256").update(manifest).digest("hex");
		if (existingIntent && existingIntent.manifestSha256 === manifestSha256) {
			try {
				if (!existingIntent.manifestPresent)
					await this.#put(environmentId, actor, existingIntent.intentId, manifestSha256, manifest);
				const seal = await this.#core.sealUpload(environmentId, actor, existingIntent.intentId);
				if (seal.state === "sealed") return { file: seal.file, intentId: existingIntent.intentId };
			} catch {
				// WHY: Reuse of the chunk's upload intent is best-effort; if it lapsed or was rejected, fall back to opening a fresh intent.
			}
		}
		for (let attempt = 0; attempt < 2; attempt++) {
			const open = await this.#core.openUpload(environmentId, actor, text);
			const present = new Set(open.present);
			const missing: { readonly sha256: string; readonly bytes: number; readonly data?: Buffer }[] = [];
			for (const c of content.chunks) {
				if (present.has(c.sha256)) continue;
				present.add(c.sha256);
				missing.push({ sha256: c.sha256, bytes: c.bytes });
			}
			if (!present.has(manifestSha256))
				missing.push({ sha256: manifestSha256, bytes: manifest.byteLength, data: manifest });
			await this.#putBounded(missing, async (item) => {
				const data = item.data ?? (await this.#objects.chunk(profileId, item.sha256, item.bytes, "bulk"));
				await this.#put(environmentId, actor, open.intentId, item.sha256, data);
			});
			const seal = await this.#core.sealUpload(environmentId, actor, open.intentId);
			if (seal.state === "sealed") return { file: seal.file, intentId: open.intentId };
		}
		throw new ProtocolError(ErrorCode.unavailable, "The file's bytes could not be saved now");
	}

	async check(profileId: string, content: Content, secrets: SecretSet, form: StoredForm = "plain"): Promise<void> {
		if (secrets.size === 0) return;
		await this.#read(profileId, content, this.#checks.start(secrets, content.size, form));
	}

	async #read(
		profileId: string,
		content: Content,
		check: ContentCheck | undefined,
		each?: (bytes: Buffer) => void,
	): Promise<void> {
		const chunks = content.chunks;
		const prefetched = new Map<number, Promise<Buffer>>();
		const prefetch = (index: number): void => {
			if (index >= chunks.length || prefetched.has(index)) return;
			const c = chunks[index]!;
			const pending = this.#objects.chunk(profileId, c.sha256, c.bytes, "bulk");
			void pending.catch(() => undefined);
			prefetched.set(index, pending);
		};
		try {
			const window = Math.min(STAGE_CONCURRENCY, chunks.length);
			for (let i = 0; i < window; i++) prefetch(i);
			for (let i = 0; i < chunks.length; i++) {
				const bytes = await prefetched.get(i)!;
				prefetched.delete(i);
				await check?.push(bytes);
				each?.(bytes);
				prefetch(i + window);
			}
			await check?.end();
		} catch (error) {
			await check?.abort();
			throw error;
		}
	}

	async #putBounded<T>(items: readonly T[], run: (item: T) => Promise<void>): Promise<void> {
		if (items.length === 0) return;
		if (items.length === 1) {
			await run(items[0]!);
			return;
		}
		let next = 0;
		let failed = false;
		let firstIndex = Number.POSITIVE_INFINITY;
		let firstError: unknown;
		const worker = async (): Promise<void> => {
			while (!failed) {
				const index = next++;
				if (index >= items.length) return;
				try {
					await run(items[index]!);
				} catch (error) {
					failed = true;
					if (index < firstIndex) {
						firstIndex = index;
						firstError = error;
					}
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(STAGE_CONCURRENCY, items.length) }, () => worker()));
		if (failed) throw firstError;
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
