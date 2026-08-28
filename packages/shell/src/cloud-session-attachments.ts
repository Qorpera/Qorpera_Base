import { createHash } from "node:crypto";
import { GATEWAY_EDGE_USER_AGENT } from "./cloud-object-store.ts";
import { readBoundedCloudResponse, withCloudDeadline } from "./cloud-request.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
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
		this.#fetch = options.fetch ?? fetch;
		this.#timeout = options.timeoutMs ?? 30_000;
		if (!Number.isSafeInteger(this.#timeout) || this.#timeout < 1 || this.#timeout > 30_000)
			throw new Error("Invalid attachment deadline");
	}

	async upload(
		sessionId: string,
		clientInputId: string,
		bytes: Uint8Array,
		mediaType: string,
		signal: AbortSignal,
	): Promise<CloudSessionAttachment> {
		const reference = {
			sha256: createHash("sha256").update(bytes).digest("hex"),
			bytes: bytes.byteLength,
			mediaType,
		};
		const result = await this.#request("upload", sessionId, clientInputId, reference, signal, bytes);
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

	async read(
		sessionId: string,
		inputId: string,
		reference: CloudSessionAttachment,
		signal: AbortSignal,
	): Promise<Uint8Array> {
		const bytes = await this.#request("input", sessionId, inputId, reference, signal);
		if (bytes.byteLength !== reference.bytes || createHash("sha256").update(bytes).digest("hex") !== reference.sha256)
			throw new Error("Chat attachment integrity check failed");
		return bytes;
	}

	#request(
		kind: "upload" | "input",
		sessionId: string,
		inputId: string,
		reference: CloudSessionAttachment,
		signal: AbortSignal,
		body?: Uint8Array,
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
				const response = await this.#fetch(
					`${this.#url}/v1/member-session-attachments/${kind}/${sessionId}/${inputId}/${reference.sha256}`,
					{
						method: body ? "PUT" : "GET",
						redirect: "error",
						signal: deadline,
						headers: {
							authorization: `Bearer ${token}`,
							"user-agent": GATEWAY_EDGE_USER_AGENT,
							...(body
								? { "content-type": reference.mediaType, "content-length": String(body.byteLength) }
								: {}),
						},
						...(body ? { body: Buffer.from(body) } : {}),
					},
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
