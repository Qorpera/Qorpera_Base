import { createHash } from "node:crypto";
import type { CloudFileReference } from "@qorpera/cloud-client/node/cloud-object-store";
import {
	type CloudCompanyFolderBytes,
	CloudCompanyFolderError,
	type CloudCompanyFolderFile,
	type CloudCompanyFolderRunActor,
	cloudCompanyFolderFailure,
	cloudCompanyFolderRunActor,
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
/** A chunk and the manifest's bound (C1D §2): 64 chunks of 4 MiB. */
const CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_CHUNKS = 64;
const MAX_MANIFEST_BYTES = 32 * 1024;
/** An open intent lasts 15 minutes; a long upload renews it before that. */
const RENEW_AFTER_MS = 10 * 60 * 1000;
/** A busy gateway (503: its NAS lanes or its database circuit) is asked twice more, after a short random wait. An
 * object is content-addressed, so a put asked again under the same intent is the same put. */
const BUSY_RETRIES = 2;

interface Manifest {
	readonly schema: "qorpera.cloud-file-manifest/v2";
	readonly fileSha256: string;
	readonly bytes: number;
	readonly mediaType: string;
	readonly executable: boolean;
	readonly chunks: readonly { readonly sha256: string; readonly bytes: number }[];
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
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

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(value, key))
	)
		invalid();
	return value as Record<string, unknown>;
}

/** The canonical version-2 manifest of a file: keys in this order, no spaces, so the same file, media type and bit
 * always give the same manifest hash, and a retried commit sends the same reference. */
function manifestOf(bytes: Uint8Array, mediaType: string, executable: boolean): { manifest: Manifest; text: string } {
	if (bytes.byteLength > MAX_CHUNKS * CHUNK_BYTES)
		throw new CloudRuntimeDiagnosticError("invalid_arguments", "Company folder file is larger than 256 MiB");
	const chunks: { sha256: string; bytes: number }[] = [];
	for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
		const chunk = bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, bytes.byteLength));
		chunks.push({ sha256: sha256(chunk), bytes: chunk.byteLength });
	}
	const manifest: Manifest = {
		schema: "qorpera.cloud-file-manifest/v2",
		fileSha256: sha256(bytes),
		bytes: bytes.byteLength,
		mediaType,
		executable,
		chunks,
	};
	return { manifest, text: JSON.stringify(manifest) };
}

export class HttpCloudCompanyFolderBytes implements CloudCompanyFolderBytes {
	readonly #origin: string;
	readonly #token: string;
	readonly #binding: string;
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
			!UUID.test(options.identity.environmentId) ||
			binding.runId !== options.identity.runId ||
			binding.jobId !== options.identity.jobId
		)
			throw new Error("Invalid Company folder byte transport");
		this.#origin = url.origin;
		this.#token = options.token;
		this.#binding = Buffer.from(JSON.stringify(binding)).toString("base64url");
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
		const manifestSha256 = sha256(manifestBytes);
		const open = record(await this.#call("qorpera_folder_open_upload", { p_manifest: text }, signal), [
			"schema",
			"intentId",
			"manifestSha256",
			"expiresAt",
			"present",
		]);
		if (
			open.schema !== "qorpera.folder-upload/v1" ||
			typeof open.intentId !== "string" ||
			!UUID.test(open.intentId) ||
			open.manifestSha256 !== manifestSha256 ||
			typeof open.expiresAt !== "string" ||
			!Array.isArray(open.present) ||
			open.present.some((hash) => typeof hash !== "string" || !SHA.test(hash))
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
		const putAll = async (hashes: Iterable<string>): Promise<void> => {
			for (const hash of hashes) {
				const object = objects.get(hash);
				if (!object) invalid();
				if (this.#now() - renewed >= RENEW_AFTER_MS) {
					const renew = record(await this.#call("qorpera_folder_renew_upload", { p_intent: intentId }, signal), [
						"schema",
						"intentId",
						"state",
						"expiresAt",
					]);
					if (
						renew.schema !== "qorpera.folder-upload-renew/v1" ||
						renew.intentId !== intentId ||
						renew.state !== "open" ||
						typeof renew.expiresAt !== "string"
					)
						invalid();
					renewed = this.#now();
				}
				await this.#put(hash, object, intentId, signal);
			}
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
			const input = record(value, ["schema", "state", "intentId", "missing"]);
			if (
				input.schema !== "qorpera.folder-seal/v1" ||
				input.intentId !== intentId ||
				!Array.isArray(input.missing) ||
				input.missing.length < 1 ||
				input.missing.some((hash) => typeof hash !== "string" || !SHA.test(hash))
			)
				invalid();
			return { state: "incomplete", missing: input.missing as string[] };
		}
		const input = record(value, ["schema", "state", "intentId", "file"]);
		const file = record(input.file, ["manifestSha256", "fileSha256", "bytes", "mediaType", "executable"]);
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
				body: Uint8Array.from(object),
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
			receipt = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
		} catch {
			invalid();
		}
		const input = record(receipt, ["status", "sha256", "bytes", "replication"]);
		if (
			input.sha256 !== hash ||
			input.bytes !== object.byteLength ||
			input.replication !== "pending" ||
			!((status === 201 && input.status === "stored") || (status === 200 && input.status === "exists"))
		)
			invalid();
	}

	/** A file's bytes: its manifest, then each chunk, each checked against its hash and the file's reference. */
	async get(file: CloudCompanyFolderFile, signal: AbortSignal): Promise<Uint8Array> {
		const manifestBytes = await this.#fetchObject(file.manifestSha256, MAX_MANIFEST_BYTES, signal);
		let manifest: Manifest;
		try {
			manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)) as Manifest;
		} catch {
			invalid();
		}
		const input = record(manifest, ["schema", "fileSha256", "bytes", "mediaType", "executable", "chunks"]);
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
		// Every chunk is checked, and their sizes must add up to the file's, before anything is fetched; the file is then
		// read into one buffer of its size.
		const chunks = (input.chunks as unknown[]).map((value) => {
			const chunk = record(value, ["sha256", "bytes"]);
			if (
				typeof chunk.sha256 !== "string" ||
				!SHA.test(chunk.sha256) ||
				!Number.isSafeInteger(chunk.bytes) ||
				(chunk.bytes as number) < 1 ||
				(chunk.bytes as number) > CHUNK_BYTES
			)
				invalid();
			return { sha256: chunk.sha256, bytes: chunk.bytes as number };
		});
		if (chunks.reduce((sum, chunk) => sum + chunk.bytes, 0) !== file.bytes) invalid();
		const bytes = Buffer.allocUnsafe(file.bytes);
		let offset = 0;
		for (const chunk of chunks) {
			const part = await this.#fetchObject(chunk.sha256, chunk.bytes, signal);
			if (part.byteLength !== chunk.bytes) invalid();
			bytes.set(part, offset);
			offset += part.byteLength;
		}
		// The chunks are the manifest's; the manifest's fileSha256 is only its writer's word.
		if (sha256(bytes) !== file.fileSha256)
			throw new CloudRuntimeDiagnosticError("invalid_response", "Company folder bytes do not match their entry");
		return bytes;
	}

	async #fetchObject(hash: string, maximum: number, signal: AbortSignal): Promise<Uint8Array> {
		if (!SHA.test(hash)) invalid();
		const { status, body } = await this.#requestUnlessBusy(hash, { method: "GET" }, maximum, signal);
		if (status !== 200 || sha256(body) !== hash)
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
				const timer = setTimeout(done, 50 + Math.floor(Math.random() * 200));
				function done(): void {
					signal.removeEventListener("abort", stop);
					resolve();
				}
				function stop(): void {
					clearTimeout(timer);
					reject(new CloudRuntimeDiagnosticError("cancelled", "Cloud tool authority unavailable"));
				}
				signal.addEventListener("abort", stop, { once: true });
				if (signal.aborted) stop();
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
						const next = await reader.read();
						if (next.done) break;
						count += next.value.byteLength;
						if (count > maximum) invalid();
						chunks.push(next.value);
					}
					requestSignal.throwIfAborted();
					if (declared !== null && count !== Number(declared)) invalid();
					return { status: response.status, body: Buffer.concat(chunks, count) };
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
