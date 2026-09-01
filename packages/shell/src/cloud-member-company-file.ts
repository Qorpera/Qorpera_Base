import { createHash } from "node:crypto";
import { parseCloudCompanyPath } from "./cloud-company-path-gateway.ts";
import { CloudContentAddressedStore, type CloudFileReference, GATEWAY_EDGE_USER_AGENT } from "./cloud-object-store.ts";
import { readBoundedCloudResponse, withCloudDeadline } from "./cloud-request.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const MAX_OBJECT_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024 * 1024;

interface MemberPathDescriptor {
	path: string;
	version: string | null;
	entry: { kind: "directory" } | { kind: "file"; executable: boolean; file: CloudFileReference } | null;
	manifestBytes: number | null;
}

export interface CloudMemberCompanyFileRead {
	path: string;
	version: string | null;
	kind: "file" | "directory" | "absent";
	executable: boolean;
	bytes: Uint8Array | null;
}

function origin(value: string): string {
	const url = new URL(value);
	if (
		(url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1")) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/"
	)
		throw new Error("Invalid member Company File endpoint");
	return url.origin;
}

function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(value, key))
	)
		throw new Error("Invalid member Company File response");
	return value as Record<string, unknown>;
}

/** Human display transport only. It has no model, provider, service-role,
 * offline-cache or whole-company checkout dependency. Every object belongs to
 * the one currently authorized path/version, and a final descriptor check
 * prevents returning an assembled file after access or content changed. */
export class CloudMemberCompanyFileReader {
	readonly #companyId: string;
	readonly #environmentId: string;
	readonly #controlOrigin: string;
	readonly #objectOrigin: string;
	readonly #publishableKey: string;
	readonly #accessToken: (signal: AbortSignal) => Promise<string>;
	readonly #fetch: typeof fetch;
	readonly #timeoutMs: number;

	constructor(options: {
		companyId: string;
		environmentId: string;
		supabaseUrl: string;
		objectGatewayUrl: string;
		publishableKey: string;
		accessToken: (signal: AbortSignal) => Promise<string>;
		fetch?: typeof fetch;
		timeoutMs?: number;
	}) {
		if (
			!UUID.test(options.companyId) ||
			!UUID.test(options.environmentId) ||
			!options.publishableKey ||
			options.publishableKey.length > 8192 ||
			/[\0\r\n]/.test(options.publishableKey)
		)
			throw new Error("Invalid member Company File configuration");
		this.#companyId = options.companyId;
		this.#environmentId = options.environmentId;
		this.#controlOrigin = origin(options.supabaseUrl);
		this.#objectOrigin = origin(options.objectGatewayUrl);
		this.#publishableKey = options.publishableKey;
		this.#accessToken = options.accessToken;
		this.#fetch = options.fetch ?? fetch;
		this.#timeoutMs = options.timeoutMs ?? 30_000;
		if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 30_000)
			throw new Error("Invalid member Company File deadline");
	}

	read(pathValue: string, signal: AbortSignal): Promise<CloudMemberCompanyFileRead> {
		const path = parseCloudCompanyPath(pathValue);
		return withCloudDeadline(
			async (requestSignal) => {
				let token: string;
				try {
					token = await this.#accessToken(requestSignal);
				} catch {
					throw new Error("Member sign-in is unavailable");
				}
				requestSignal.throwIfAborted();
				if (typeof token !== "string" || !/^[A-Za-z0-9._~-]{1,8192}$/.test(token))
					throw new Error("Member sign-in is unavailable");
				const first = await this.#describe(path, token, requestSignal);
				if (first.entry?.kind !== "file")
					return {
						path,
						version: first.version,
						kind: first.entry?.kind ?? "absent",
						executable: false,
						bytes: null,
					};
				const file = first.entry.file;
				const store = new CloudContentAddressedStore({
					put: async () => {
						throw new Error("Member file reader cannot stage objects");
					},
					get: async (objectPath) => {
						const parts = objectPath.split("/");
						if (parts.length !== 2 || parts[0] !== this.#companyId || !SHA.test(parts[1]!))
							throw new Error("Member file object scope changed");
						const bytes = await this.#request(
							`${this.#objectOrigin}/v1/member-company-objects/${this.#environmentId}/${first.version}/${parts[1]}`,
							{
								method: "GET",
								headers: {
									authorization: `Bearer ${token}`,
									"user-agent": GATEWAY_EDGE_USER_AGENT,
									"x-qorpera-company-path": Buffer.from(path, "utf8").toString("base64url"),
								},
							},
							MAX_OBJECT_BYTES,
							requestSignal,
							true,
						);
						if (
							createHash("sha256").update(bytes).digest("hex") !== parts[1] ||
							(parts[1] === file.manifestSha256 && bytes.length !== first.manifestBytes)
						)
							throw new Error("Member file object failed integrity verification");
						return bytes;
					},
				});
				const bytes = await store.getFile(this.#companyId, file);
				const current = await this.#describe(path, token, requestSignal);
				if (JSON.stringify(current) !== JSON.stringify(first)) throw new Error("Company File changed during read");
				requestSignal.throwIfAborted();
				return { path, version: first.version, kind: "file", executable: first.entry.executable, bytes };
			},
			this.#timeoutMs,
			signal,
		);
	}

	async #describe(path: string, token: string, signal: AbortSignal): Promise<MemberPathDescriptor> {
		const bytes = await this.#request(
			`${this.#controlOrigin}/rest/v1/rpc/qorpera_read_company_path`,
			{
				method: "POST",
				headers: {
					apikey: this.#publishableKey,
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ p_environment_id: this.#environmentId, p_binding: null, p_path: path }),
			},
			32 * 1024,
			signal,
			false,
		);
		let value: unknown;
		try {
			value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
		} catch {
			throw new Error("Invalid member Company File response");
		}
		const input = closed(value, ["path", "version", "entry", "manifestBytes", "companyId"]);
		if (
			input.path !== path ||
			input.companyId !== this.#companyId ||
			(input.version !== null && (typeof input.version !== "string" || !UUID.test(input.version)))
		)
			throw new Error("Member Company File scope changed");
		const base = { path, version: input.version as string | null };
		if (input.entry === null && input.manifestBytes === null) return { ...base, entry: null, manifestBytes: null };
		const entry = closed(
			input.entry,
			input.manifestBytes === null ? ["path", "kind"] : ["path", "kind", "executable", "file"],
		);
		if (entry.path !== path || base.version === null) throw new Error("Member Company File target changed");
		if (entry.kind === "directory" && input.manifestBytes === null)
			return { ...base, entry: { kind: "directory" }, manifestBytes: null };
		if (
			entry.kind !== "file" ||
			typeof entry.executable !== "boolean" ||
			!Number.isSafeInteger(input.manifestBytes) ||
			(input.manifestBytes as number) < 1 ||
			(input.manifestBytes as number) > MAX_OBJECT_BYTES
		)
			throw new Error("Invalid member Company File entry");
		const file = closed(entry.file, ["manifestSha256", "fileSha256", "bytes", "mediaType"]);
		if (
			typeof file.manifestSha256 !== "string" ||
			!SHA.test(file.manifestSha256) ||
			typeof file.fileSha256 !== "string" ||
			!SHA.test(file.fileSha256) ||
			!Number.isSafeInteger(file.bytes) ||
			(file.bytes as number) < 0 ||
			(file.bytes as number) > MAX_FILE_BYTES ||
			file.mediaType !== "application/octet-stream"
		)
			throw new Error("Invalid member Company File reference");
		return {
			...base,
			entry: {
				kind: "file",
				executable: entry.executable,
				file: {
					manifestSha256: file.manifestSha256,
					fileSha256: file.fileSha256,
					bytes: file.bytes as number,
					mediaType: file.mediaType,
				},
			},
			manifestBytes: input.manifestBytes as number,
		};
	}

	async #request(
		url: string,
		init: RequestInit,
		maximum: number,
		signal: AbortSignal,
		object: boolean,
	): Promise<Uint8Array> {
		signal.throwIfAborted();
		const request: RequestInit & Pick<Request, "cache"> = { ...init, signal, redirect: "error", cache: "no-store" };
		const response = await this.#fetch(url, request);
		if (
			response.status !== 200 ||
			(object && response.headers.get("x-qorpera-access-mode") !== "live-path-authority")
		) {
			void response.body?.cancel().catch(() => undefined);
			throw new Error(`Company File access is unavailable (${response.status})`);
		}
		const bytes = await readBoundedCloudResponse(response, maximum, signal);
		const declared = response.headers.get("content-length");
		if (declared !== null && Number(declared) !== bytes.length)
			throw new Error("Company File response is incomplete");
		return bytes;
	}
}
