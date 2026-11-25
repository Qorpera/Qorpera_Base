import { SHA256_HEX_PATTERN as SHA, UUID_PATTERN as UUID } from "@qorpera/contracts";
import { cloudFileBytesSha256 } from "./cloud-file-bytes.ts";
import { readBoundedCloudResponse, withCloudDeadline } from "./cloud-request.ts";

const MEDIA = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export interface CloudSessionAttachment {
	sha256: string;
	bytes: number;
	mediaType: string;
}

/** Human chat-media transport. Uploads prove possession of the bytes for one
 * pending input; downloads require an already canonical, authorized input. */
export class CloudSessionAttachments {
	readonly #url: string;
	readonly #token: (signal: AbortSignal) => Promise<string>;
	readonly #fetch: typeof fetch;
	readonly #timeout: number;
	constructor(options: {
		objectGatewayUrl: string;
		accessToken: (signal: AbortSignal) => Promise<string>;
		fetch?: typeof fetch;
		timeoutMs?: number;
	}) {
		const url = new URL(options.objectGatewayUrl);
		if (url.protocol !== "https:" || ![url.origin, `${url.origin}/`].includes(options.objectGatewayUrl))
			throw new Error("Invalid chat attachment gateway");
		this.#url = url.origin;
		this.#token = options.accessToken;
		this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
		this.#timeout = options.timeoutMs ?? 30_000;
		if (!Number.isSafeInteger(this.#timeout) || this.#timeout < 1 || this.#timeout > 30_000)
			throw new Error("Invalid attachment deadline");
	}

	upload(
		sessionId: string,
		clientInputId: string,
		bytes: Uint8Array,
		mediaType: string,
		signal: AbortSignal,
	): Promise<CloudSessionAttachment> {
		return this.#upload("upload", sessionId, clientInputId, bytes, mediaType, signal);
	}

	uploadSurface(
		surfaceId: string,
		clientInputId: string,
		bytes: Uint8Array,
		mediaType: string,
		signal: AbortSignal,
	): Promise<CloudSessionAttachment> {
		return this.#upload("surface-upload", surfaceId, clientInputId, bytes, mediaType, signal);
	}

	read(
		sessionId: string,
		inputId: string,
		reference: CloudSessionAttachment,
		signal: AbortSignal,
	): Promise<Uint8Array> {
		return this.#read("input", sessionId, inputId, reference, signal);
	}

	readSurface(
		sessionId: string,
		clientInputId: string,
		reference: CloudSessionAttachment,
		signal: AbortSignal,
	): Promise<Uint8Array> {
		return this.#read("surface-input", sessionId, clientInputId, reference, signal);
	}

	async #upload(
		kind: "upload" | "surface-upload",
		ownerId: string,
		clientInputId: string,
		bytes: Uint8Array,
		mediaType: string,
		signal: AbortSignal,
	): Promise<CloudSessionAttachment> {
		signal.throwIfAborted();
		if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > 8 * 1024 * 1024)
			throw new Error("Invalid chat attachment");
		const selected = Uint8Array.from(bytes);
		const reference = {
			sha256: await cloudFileBytesSha256(selected),
			bytes: selected.byteLength,
			mediaType,
		};
		const result = await this.#request(kind, ownerId, clientInputId, reference, signal, selected);
		let value: unknown;
		try {
			value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result));
		} catch {
			throw new Error("Invalid chat attachment upload receipt");
		}
		if (
			!value ||
			typeof value !== "object" ||
			Array.isArray(value) ||
			Object.keys(value).length !== 3 ||
			Object.entries(reference).some(([key, expected]) => (value as Record<string, unknown>)[key] !== expected)
		)
			throw new Error("Chat attachment upload receipt changed");
		return reference;
	}

	async #read(
		kind: "input" | "surface-input",
		sessionId: string,
		inputId: string,
		reference: CloudSessionAttachment,
		signal: AbortSignal,
	): Promise<Uint8Array> {
		const selected = { ...reference };
		const bytes = await this.#request(kind, sessionId, inputId, selected, signal);
		if (bytes.byteLength !== selected.bytes || (await cloudFileBytesSha256(bytes)) !== selected.sha256)
			throw new Error("Chat attachment integrity check failed");
		signal.throwIfAborted();
		return bytes;
	}

	#request(
		kind: "upload" | "input" | "surface-upload" | "surface-input",
		sessionId: string,
		inputId: string,
		reference: CloudSessionAttachment,
		signal: AbortSignal,
		body?: Uint8Array<ArrayBuffer>,
	): Promise<Uint8Array> {
		if (
			!UUID.test(sessionId) ||
			!UUID.test(inputId) ||
			!SHA.test(reference.sha256) ||
			!Number.isSafeInteger(reference.bytes) ||
			reference.bytes < 1 ||
			reference.bytes > 8 * 1024 * 1024 ||
			!MEDIA.has(reference.mediaType)
		)
			throw new Error("Invalid chat attachment");
		return withCloudDeadline(
			async (deadline) => {
				const token = await this.#token(deadline);
				deadline.throwIfAborted();
				if (!/^[A-Za-z0-9._~-]{1,8192}$/.test(token)) throw new Error("Member sign-in is unavailable");
				const request: RequestInit & { cache: "no-store"; credentials: "omit" } = {
					method: body ? "PUT" : "GET",
					redirect: "error",
					cache: "no-store",
					credentials: "omit",
					signal: deadline,
					headers: {
						authorization: `Bearer ${token}`,
						...(body ? { "content-type": reference.mediaType } : {}),
					},
					...(body ? { body } : {}),
				};
				const response = await this.#fetch(
					`${this.#url}/v1/member-session-attachments/${kind}/${sessionId}/${inputId}/${reference.sha256}`,
					request,
				);
				if (response.status !== 200) {
					void response.body?.cancel().catch(() => undefined);
					throw new Error(
						response.status === 401 || response.status === 403
							? "Chat attachment access was denied"
							: "Chat attachment is unavailable; try again",
					);
				}
				return readBoundedCloudResponse(response, body ? 1024 : reference.bytes, deadline);
			},
			this.#timeout,
			signal,
		);
	}
}
