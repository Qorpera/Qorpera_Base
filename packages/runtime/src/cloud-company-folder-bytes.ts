import { createHash } from "node:crypto";
import type { CloudFileReference } from "@qorpera/cloud-client/node/cloud-object-store";
import { isUuid, parseClosedRecord, SHA256_HEX_PATTERN } from "@qorpera/contracts";
import {
	type CloudCompanyFolderBytes,
	CloudCompanyFolderError,
	type CloudCompanyFolderFile,
	type CloudCompanyFolderRunActor,
	cloudCompanyFolderFailure,
	cloudCompanyFolderRunActor,
	sha256Hex,
} from "./cloud-company-folder-client.ts";
import type { CloudCompanyPathControl, CloudCompanyPathRpc } from "./cloud-company-path-gateway.ts";
import {
	type CloudNativeToolBinding,
	type CloudNativeToolIdentity,
	cloudToolRequest,
	parseCloudNativeToolBinding,
} from "./cloud-native-tool-authority.ts";
import { CloudRuntimeDiagnosticError } from "./cloud-runtime-observability.ts";

/*
 * The folder core's bytes for a folder-v2 run (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1D.md §8): the production
 * CloudCompanyFolderBytes. A put opens an upload intent for the file's version-2 manifest, puts the chunks and the
 * manifest the catalog lacks through the object gateway's folder route, then seals the intent into the file's proof.
 * A get fetches the manifest and its chunks, each checked against its hash. No step takes a company-wide lock, and
 * staging publishes nothing: the commit does. Nothing constructs it until the thin writers do.
 */

/** A chunk and the manifest's bound (C1D §2): 64 chunks of 4 MiB. */
const CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_CHUNKS = 64;
const MAX_MANIFEST_BYTES = 32 * 1024;
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const CHUNK_CONCURRENCY = 4;
const PUT_CONCURRENCY = 2;
const UTF8_FATAL = new TextDecoder("utf-8", { fatal: true });
/** An open intent lasts 15 minutes; a long upload renews it before that. */
const RENEW_AFTER_MS = 10 * 60 * 1000;
/** A busy gateway (503) is asked twice more, after a short random wait: meant for its NAS lanes, two operations in
 * flight. A database 500 opens its circuit for 5 s, so those tries fail fast without reaching the database. An object
 * is content-addressed, so a put asked again under the same intent is the same put. */
const BUSY_RETRIES = 2;

interface Manifest {
	readonly schema: "qorpera.cloud-file-manifest/v2";
	readonly fileSha256: string;
	readonly bytes: number;
	readonly mediaType: string;
	readonly executable: boolean;
	readonly chunks: readonly { readonly sha256: string; readonly bytes: number }[];
}

/** The gateway answered 503: busy or cut off from its database for a moment. */
class GatewayBusyError extends CloudRuntimeDiagnosticError {
	constructor() {
		super("transport_unavailable", "Company folder bytes unavailable");
	}
}

function invalid(): never {
	throw new CloudRuntimeDiagnosticError("invalid_response", "Company folder response is invalid");
}

/** An answer with exactly these fields (the shared closed-record check), or an invalid response. */
function answer(value: unknown, keys: readonly string[]): Record<string, unknown> {
	try {
		return parseClosedRecord(value, "Company folder answer", keys);
	} catch {
		invalid();
	}
}

function requestBody(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	return bytes.buffer instanceof ArrayBuffer
		? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
		: Uint8Array.from(bytes);
}

/** The canonical version-2 manifest of a file: keys in this order, no spaces, so the same file, media type and bit
 * always give the same manifest hash, and a retried commit sends the same reference. */
function manifestOf(bytes: Uint8Array, mediaType: string, executable: boolean): { manifest: Manifest; text: string } {
	if (bytes.byteLength > MAX_CHUNKS * CHUNK_BYTES)
		throw new CloudRuntimeDiagnosticError("invalid_arguments", "Company folder file is larger than 256 MiB");
	let fileSha256: string;
	const chunks: { sha256: string; bytes: number }[] = [];
	if (bytes.byteLength === 0) {
		fileSha256 = EMPTY_SHA256;
	} else if (bytes.byteLength <= CHUNK_BYTES) {
		fileSha256 = sha256Hex(bytes);
		chunks.push({ sha256: fileSha256, bytes: bytes.byteLength });
	} else {
		const whole = createHash("sha256");
		for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
			const chunk = bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, bytes.byteLength));
			whole.update(chunk);
			chunks.push({ sha256: sha256Hex(chunk), bytes: chunk.byteLength });
		}
		fileSha256 = whole.digest("hex");
	}
	const manifest: Manifest = {
		schema: "qorpera.cloud-file-manifest/v2",
		fileSha256,
		bytes: bytes.byteLength,
		mediaType,
		executable,
		chunks,
	};
	return { manifest, text: JSON.stringify(manifest) };
}

function canonicalSingleChunkManifestSha256(file: CloudCompanyFolderFile): string | null {
	if (!Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > CHUNK_BYTES) return null;
	if (!SHA256_HEX_PATTERN.test(file.fileSha256)) return null;
	const manifest: Manifest = {
		schema: "qorpera.cloud-file-manifest/v2",
		fileSha256: file.fileSha256,
		bytes: file.bytes,
		mediaType: file.mediaType,
		executable: file.executable,
		chunks: [{ sha256: file.fileSha256, bytes: file.bytes }],
	};
	return sha256Hex(Buffer.from(JSON.stringify(manifest), "utf8"));
}

export class HttpCloudCompanyFolderBytes implements CloudCompanyFolderBytes {
	readonly verifiesBytes = true as const;
	readonly #origin: string;
	readonly #token: string;
	readonly #binding: string;
	readonly #holder: () => string;
	readonly #environmentId: string;
	readonly #actor: CloudCompanyFolderRunActor;
	readonly #control: CloudCompanyPathControl;
	readonly #fetch: typeof fetch;
	readonly #timeoutMs: number;
	readonly #now: () => number;

	constructor(options: {
		baseUrl: string;
		token: string;
		binding: CloudNativeToolBinding;
		/** G2-6a: the run's holder credential, read per request (NativeHostDispatch.holderHeader). */
		holder: () => string;
		identity: CloudNativeToolIdentity;
		control: CloudCompanyPathControl;
		fetch?: typeof fetch;
		timeoutMs?: number;
		now?: () => number;
	}) {
		const url = new URL(options.baseUrl);
		const binding = parseCloudNativeToolBinding(options.binding);
		if (
			(url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1")) ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			url.pathname !== "/" ||
			!/^[A-Za-z0-9_-]{43}$/.test(options.token) ||
			!isUuid(options.identity.environmentId) ||
			binding.runId !== options.identity.runId ||
			binding.jobId !== options.identity.jobId
		)
			throw new Error("Invalid Company folder byte transport");
		this.#origin = url.origin;
		this.#token = options.token;
		this.#binding = Buffer.from(JSON.stringify(binding)).toString("base64url");
		this.#holder = options.holder;
		this.#environmentId = options.identity.environmentId;
		this.#actor = cloudCompanyFolderRunActor(binding);
		this.#control = options.control;
		this.#fetch = options.fetch ?? fetch;
		this.#timeoutMs = options.timeoutMs ?? 8000;
		this.#now = options.now ?? Date.now;
		if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 30_000)
			throw new Error("Invalid Company folder byte deadline");
	}

	async #call(method: CloudCompanyPathRpc, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
		try {
			return await cloudToolRequest(
				(requestSignal) =>
					this.#control.call(
						method,
						{ p_environment_id: this.#environmentId, p_actor: this.#actor, ...args },
						requestSignal,
					),
				signal,
			);
		} catch (error) {
			throw cloudCompanyFolderFailure(error);
		}
	}

	async put(
		bytes: Uint8Array,
		mediaType: string,
		executable: boolean,
		signal: AbortSignal,
	): Promise<CloudFileReference> {
		const { manifest, text } = manifestOf(bytes, mediaType, executable);
		const manifestBytes = new TextEncoder().encode(text);
		const manifestSha256 = sha256Hex(manifestBytes);
		const open = answer(await this.#call("qorpera_folder_open_upload", { p_manifest: text }, signal), [
			"schema",
			"intentId",
			"manifestSha256",
			"expiresAt",
			"present",
		]);
		if (
			open.schema !== "qorpera.folder-upload/v1" ||
			typeof open.intentId !== "string" ||
			!isUuid(open.intentId) ||
			open.manifestSha256 !== manifestSha256 ||
			typeof open.expiresAt !== "string" ||
			!Array.isArray(open.present) ||
			open.present.some((hash) => typeof hash !== "string" || !SHA256_HEX_PATTERN.test(hash))
		)
			invalid();
		const intentId = open.intentId;
		// Every object the intent lists: each distinct chunk and the manifest.
		const objects = new Map<string, Uint8Array>();
		manifest.chunks.forEach((chunk, index) => {
			objects.set(chunk.sha256, bytes.subarray(index * CHUNK_BYTES, index * CHUNK_BYTES + chunk.bytes));
		});
		objects.set(manifestSha256, manifestBytes);
		let renewed = this.#now();
		let renewInFlight: Promise<void> | null = null;
		const ensureRenewed = async (requestSignal: AbortSignal): Promise<void> => {
			if (this.#now() - renewed < RENEW_AFTER_MS) return;
			if (!renewInFlight) {
				renewInFlight = (async () => {
					const renew = answer(
						await this.#call("qorpera_folder_renew_upload", { p_intent: intentId }, requestSignal),
						["schema", "intentId", "state", "expiresAt"],
					);
					if (
						renew.schema !== "qorpera.folder-upload-renew/v1" ||
						renew.intentId !== intentId ||
						renew.state !== "open" ||
						typeof renew.expiresAt !== "string"
					)
						invalid();
					renewed = this.#now();
				})().finally(() => {
					renewInFlight = null;
				});
			}
			await renewInFlight;
		};
		const putOne = async (hash: string, requestSignal: AbortSignal): Promise<void> => {
			const object = objects.get(hash);
			if (!object) invalid();
			await ensureRenewed(requestSignal);
			await this.#put(hash, object, intentId, requestSignal);
		};
		const putAll = async (hashes: Iterable<string>): Promise<void> => {
			const list = [...hashes];
			if (list.length === 0) return;
			if (list.length <= 1) {
				await putOne(list[0]!, signal);
				return;
			}
			let cursor = 0;
			const abort = new AbortController();
			const putSignal = AbortSignal.any([signal, abort.signal]);
			let firstError: unknown;
			let failed = false;
			const worker = async (): Promise<void> => {
				while (!failed) {
					const index = cursor++;
					if (index >= list.length) return;
					try {
						await putOne(list[index]!, putSignal);
					} catch (error) {
						if (!failed) {
							failed = true;
							firstError = error;
							abort.abort();
						}
						return;
					}
				}
			};
			await Promise.allSettled(Array.from({ length: Math.min(PUT_CONCURRENCY, list.length) }, () => worker()));
			if (failed) throw firstError;
		};
		const present = new Set(open.present as string[]);
		await putAll([...objects.keys()].filter((hash) => !present.has(hash)));
		let sealed = await this.#seal(intentId, signal);
		// An object the catalog lost meanwhile is put once more.
		if (sealed.state === "incomplete") {
			await putAll(sealed.missing);
			sealed = await this.#seal(intentId, signal);
			if (sealed.state === "incomplete") throw new CloudCompanyFolderError("contended");
		}
		const file = sealed.file;
		if (
			file.manifestSha256 !== manifestSha256 ||
			file.fileSha256 !== manifest.fileSha256 ||
			file.bytes !== manifest.bytes ||
			file.mediaType !== mediaType ||
			file.executable !== executable
		)
			invalid();
		return {
			manifestSha256: file.manifestSha256,
			fileSha256: file.fileSha256,
			bytes: file.bytes,
			mediaType: file.mediaType,
		};
	}

	async #seal(
		intentId: string,
		signal: AbortSignal,
	): Promise<{ state: "sealed"; file: CloudCompanyFolderFile } | { state: "incomplete"; missing: string[] }> {
		const value = await this.#call("qorpera_folder_seal_upload", { p_intent: intentId }, signal);
		const state = (value as { state?: unknown } | null)?.state;
		if (state === "incomplete") {
			const input = answer(value, ["schema", "state", "intentId", "missing"]);
			if (
				input.schema !== "qorpera.folder-seal/v1" ||
				input.intentId !== intentId ||
				!Array.isArray(input.missing) ||
				input.missing.length < 1 ||
				input.missing.some((hash) => typeof hash !== "string" || !SHA256_HEX_PATTERN.test(hash))
			)
				invalid();
			return { state: "incomplete", missing: input.missing as string[] };
		}
		const input = answer(value, ["schema", "state", "intentId", "file"]);
		const file = answer(input.file, ["manifestSha256", "fileSha256", "bytes", "mediaType", "executable"]);
		if (
			input.schema !== "qorpera.folder-seal/v1" ||
			input.state !== "sealed" ||
			input.intentId !== intentId ||
			typeof file.manifestSha256 !== "string" ||
			typeof file.fileSha256 !== "string" ||
			!Number.isSafeInteger(file.bytes) ||
			typeof file.mediaType !== "string" ||
			typeof file.executable !== "boolean"
		)
			invalid();
		return { state: "sealed", file: file as unknown as CloudCompanyFolderFile };
	}

	async #put(hash: string, object: Uint8Array, intentId: string, signal: AbortSignal): Promise<void> {
		const { status, body } = await this.#requestUnlessBusy(
			hash,
			{
				method: "PUT",
				body: requestBody(object),
				headers: {
					"content-type": "application/octet-stream",
					"content-length": String(object.byteLength),
					"x-qorpera-upload-intent": intentId,
				},
			},
			4096,
			signal,
		);
		let receipt: unknown;
		try {
			receipt = JSON.parse(UTF8_FATAL.decode(body));
		} catch {
			invalid();
		}
		const input = answer(receipt, ["status", "sha256", "bytes", "replication"]);
		if (
			input.sha256 !== hash ||
			input.bytes !== object.byteLength ||
			input.replication !== "pending" ||
			!((status === 201 && input.status === "stored") || (status === 200 && input.status === "exists"))
		)
			invalid();
	}

	async #fetchChunks(
		entries: readonly { readonly sha256: string; readonly bytes: number }[],
		onChunk: (sha256: string, part: Uint8Array) => void,
		signal: AbortSignal,
	): Promise<void> {
		if (entries.length === 0) return;
		if (entries.length === 1) {
			const { sha256: hash, bytes: expectedBytes } = entries[0]!;
			const part = await this.#fetchObject(hash, expectedBytes, signal);
			if (part.byteLength !== expectedBytes) invalid();
			onChunk(hash, part);
			return;
		}
		let cursor = 0;
		if (signal.aborted) {
			const { sha256: hash, bytes: expectedBytes } = entries[0]!;
			const part = await this.#fetchObject(hash, expectedBytes, signal);
			if (part.byteLength !== expectedBytes) invalid();
			onChunk(hash, part);
			cursor = 1;
		}
		const abort = new AbortController();
		const fetchSignal = AbortSignal.any([signal, abort.signal]);
		let firstError: unknown;
		let failed = false;
		const worker = async (): Promise<void> => {
			while (!failed) {
				const index = cursor++;
				if (index >= entries.length) return;
				const { sha256: hash, bytes: expectedBytes } = entries[index]!;
				try {
					const part = await this.#fetchObject(hash, expectedBytes, fetchSignal);
					if (part.byteLength !== expectedBytes) invalid();
					if (!failed) onChunk(hash, part);
				} catch (error) {
					if (!failed) {
						failed = true;
						firstError = error;
						abort.abort();
					}
					return;
				}
			}
		};
		await Promise.allSettled(
			Array.from({ length: Math.min(CHUNK_CONCURRENCY, entries.length - cursor) }, () => worker()),
		);
		if (failed) throw firstError;
	}

	/** A file's bytes: its manifest, then each chunk, each checked against its hash and the file's reference. */
	async get(file: CloudCompanyFolderFile, signal: AbortSignal): Promise<Uint8Array> {
		const chunks = await this.#chunks(file, signal);
		if (chunks.length === 0) {
			if (file.fileSha256 !== EMPTY_SHA256)
				throw new CloudRuntimeDiagnosticError("invalid_response", "Company folder bytes do not match their entry");
			return new Uint8Array(0);
		}
		if (chunks.length === 1) {
			const chunk = chunks[0]!;
			const part = await this.#fetchObject(chunk.sha256, chunk.bytes, signal);
			if (part.byteLength !== chunk.bytes) invalid();
			// WHY: #fetchObject already verified sha256Hex(part) === chunk.sha256, so a single chunk needs no second hash or copy.
			if (chunk.sha256 !== file.fileSha256)
				throw new CloudRuntimeDiagnosticError("invalid_response", "Company folder bytes do not match their entry");
			return part;
		}
		const unique = new Map<string, { readonly sha256: string; readonly bytes: number; readonly offsets: number[] }>();
		let offset = 0;
		for (const chunk of chunks) {
			let entry = unique.get(chunk.sha256);
			if (!entry) {
				entry = { sha256: chunk.sha256, bytes: chunk.bytes, offsets: [] };
				unique.set(chunk.sha256, entry);
			} else if (entry.bytes !== chunk.bytes) {
				invalid();
			}
			entry.offsets.push(offset);
			offset += chunk.bytes;
		}
		const bytes = Buffer.allocUnsafe(file.bytes);
		await this.#fetchChunks(
			[...unique.values()],
			(hash, part) => {
				const entry = unique.get(hash)!;
				for (const pos of entry.offsets) bytes.set(part, pos);
			},
			signal,
		);
		// The chunks are the manifest's; the manifest's fileSha256 is only its writer's word.
		if (sha256Hex(bytes) !== file.fileSha256)
			throw new CloudRuntimeDiagnosticError("invalid_response", "Company folder bytes do not match their entry");
		return bytes;
	}

	/** Bytes `offset` to `offset + length` of a file (fewer at its end): only the chunks they fall in are fetched, each
	 * checked against its hash, as the manifest (itself checked against the entry's hash) names them. A range that is the
	 * whole file is checked against the file's hash too. */
	async range(file: CloudCompanyFolderFile, offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
		if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0)
			throw new Error("Invalid Company folder byte range");
		const end = Math.min(file.bytes, offset + length);
		if (offset >= end) return new Uint8Array();
		if (offset === 0 && end === file.bytes) return this.get(file, signal);
		const chunks = await this.#chunks(file, signal);
		const unique = new Map<
			string,
			{
				readonly sha256: string;
				readonly bytes: number;
				readonly copies: { readonly srcStart: number; readonly srcEnd: number; readonly dstOffset: number }[];
			}
		>();
		let position = 0;
		for (const chunk of chunks) {
			if (position < end && position + chunk.bytes > offset) {
				let entry = unique.get(chunk.sha256);
				if (!entry) {
					entry = { sha256: chunk.sha256, bytes: chunk.bytes, copies: [] };
					unique.set(chunk.sha256, entry);
				} else if (entry.bytes !== chunk.bytes) {
					invalid();
				}
				entry.copies.push({
					srcStart: Math.max(0, offset - position),
					srcEnd: Math.min(chunk.bytes, end - position),
					dstOffset: Math.max(0, position - offset),
				});
			}
			position += chunk.bytes;
		}
		const bytes = Buffer.allocUnsafe(end - offset);
		await this.#fetchChunks(
			[...unique.values()],
			(hash, part) => {
				const entry = unique.get(hash)!;
				for (const copy of entry.copies) {
					bytes.set(part.subarray(copy.srcStart, copy.srcEnd), copy.dstOffset);
				}
			},
			signal,
		);
		return bytes;
	}

	/** A file's manifest, fetched by its hash and checked against the entry: its chunks, whose sizes add up to the
	 * file's. */
	async #chunks(
		file: CloudCompanyFolderFile,
		signal: AbortSignal,
	): Promise<{ readonly sha256: string; readonly bytes: number }[]> {
		// WHY: canonical manifest hash proves chunks === [{ sha256: fileSha256, bytes }] without a manifest HTTP round trip.
		if (canonicalSingleChunkManifestSha256(file) === file.manifestSha256)
			return [{ sha256: file.fileSha256, bytes: file.bytes }];
		const manifestBytes = await this.#fetchObject(file.manifestSha256, MAX_MANIFEST_BYTES, signal);
		let manifest: Manifest;
		try {
			manifest = JSON.parse(UTF8_FATAL.decode(manifestBytes)) as Manifest;
		} catch {
			invalid();
		}
		const input = answer(manifest, ["schema", "fileSha256", "bytes", "mediaType", "executable", "chunks"]);
		if (
			input.schema !== "qorpera.cloud-file-manifest/v2" ||
			input.fileSha256 !== file.fileSha256 ||
			input.bytes !== file.bytes ||
			input.mediaType !== file.mediaType ||
			input.executable !== file.executable ||
			!Array.isArray(input.chunks) ||
			input.chunks.length > MAX_CHUNKS
		)
			invalid();
		// Every chunk is checked, and their sizes must add up to the file's, before anything is fetched.
		const chunks = (input.chunks as unknown[]).map((value) => {
			const chunk = answer(value, ["sha256", "bytes"]);
			if (
				typeof chunk.sha256 !== "string" ||
				!SHA256_HEX_PATTERN.test(chunk.sha256) ||
				!Number.isSafeInteger(chunk.bytes) ||
				(chunk.bytes as number) < 1 ||
				(chunk.bytes as number) > CHUNK_BYTES
			)
				invalid();
			return { sha256: chunk.sha256, bytes: chunk.bytes as number };
		});
		if (chunks.reduce((sum, chunk) => sum + chunk.bytes, 0) !== file.bytes) invalid();
		return chunks;
	}

	async #fetchObject(hash: string, maximum: number, signal: AbortSignal): Promise<Uint8Array> {
		if (!SHA256_HEX_PATTERN.test(hash)) invalid();
		const { status, body } = await this.#requestUnlessBusy(hash, { method: "GET" }, maximum, signal);
		if (status !== 200 || sha256Hex(body) !== hash)
			throw new CloudRuntimeDiagnosticError("invalid_response", "Company folder object failed its check");
		return body;
	}

	async #requestUnlessBusy(
		hash: string,
		init: RequestInit,
		maximum: number,
		signal: AbortSignal,
	): Promise<{ status: number; body: Uint8Array }> {
		for (let attempt = 0; ; attempt += 1) {
			try {
				return await this.#request(hash, init, maximum, signal);
			} catch (error) {
				if (!(error instanceof GatewayBusyError) || attempt >= BUSY_RETRIES) throw error;
			}
			await new Promise<void>((resolve, reject) => {
				const cancelled = (): CloudRuntimeDiagnosticError =>
					new CloudRuntimeDiagnosticError("cancelled", "Cloud tool authority unavailable");
				if (signal.aborted) {
					reject(cancelled());
					return;
				}
				const timer = setTimeout(done, 50 + Math.floor(Math.random() * 200));
				function done(): void {
					signal.removeEventListener("abort", stop);
					resolve();
				}
				function stop(): void {
					clearTimeout(timer);
					reject(cancelled());
				}
				signal.addEventListener("abort", stop, { once: true });
			});
		}
	}

	#request(
		hash: string,
		init: RequestInit,
		maximum: number,
		signal: AbortSignal,
	): Promise<{ status: number; body: Uint8Array }> {
		return cloudToolRequest(
			async (requestSignal) => {
				const response = await this.#fetch(`${this.#origin}/v1/folder-objects/${this.#environmentId}/${hash}`, {
					...init,
					redirect: "error",
					signal: requestSignal,
					headers: {
						...init.headers,
						authorization: `Bearer ${this.#token}`,
						"x-qorpera-native-binding": this.#binding,
						"x-qorpera-identity": this.#holder(),
					},
				}).catch(() => {
					throw new CloudRuntimeDiagnosticError("transport_unavailable", "Company folder bytes unavailable");
				});
				if (!response.ok) {
					void response.body?.cancel().catch(() => undefined);
					// The gateway answers a refusal of the folder core's checks as 403: the intent, the run or the
					// read is not (or no longer) this run's. 423: the company's work is stopped. 409: a lock conflict.
					if (response.status === 403) throw new CloudCompanyFolderError("unavailable");
					if (response.status === 423) throw new CloudCompanyFolderError("stopped");
					if (response.status === 409) throw new CloudCompanyFolderError("contended");
					// 413: the company's storage allowance has no room for this new object (the gateway's own body bound is
					// 8 MiB, which no object this adapter puts reaches).
					if (response.status === 413) throw new CloudCompanyFolderError("full");
					if (response.status === 503) throw new GatewayBusyError();
					throw new CloudRuntimeDiagnosticError("transport_unavailable", "Company folder bytes unavailable");
				}
				const declared = response.headers.get("content-length");
				if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > maximum)) {
					void response.body?.cancel().catch(() => undefined);
					invalid();
				}
				const reader = response.body?.getReader();
				if (!reader) invalid();
				const cancel = (): void => {
					void reader.cancel().catch(() => undefined);
				};
				requestSignal.addEventListener("abort", cancel, { once: true });
				const chunks: Uint8Array[] = [];
				let count = 0;
				try {
					for (;;) {
						requestSignal.throwIfAborted();
						// A body cut off after its headers (the connection dropped) is a lost answer, as a fetch that failed
						// is; a cancel or the call's own deadline stays what it is.
						const next = await reader.read().catch((error: unknown) => {
							if (requestSignal.aborted) throw error;
							throw new CloudRuntimeDiagnosticError("transport_unavailable", "Company folder bytes unavailable");
						});
						if (next.done) break;
						count += next.value.byteLength;
						if (count > maximum) invalid();
						chunks.push(next.value);
					}
					requestSignal.throwIfAborted();
					if (declared !== null && count !== Number(declared)) invalid();
					return {
						status: response.status,
						body: chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, count),
					};
				} finally {
					requestSignal.removeEventListener("abort", cancel);
					cancel();
					reader.releaseLock();
				}
			},
			signal,
			this.#timeoutMs,
		);
	}
}
