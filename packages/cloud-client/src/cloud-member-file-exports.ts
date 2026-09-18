import { cloudFileBytesSha256 } from "./cloud-file-bytes.ts";
import {
	type CompanyComputerFileExportAsset,
	type ObjectStorageFileSelection,
	parseCompanyComputerFileExportAsset,
	parseObjectStorageFileSelection,
} from "./cloud-file-transfer.ts";
import type { CloudMemberCompanyFileReader } from "./cloud-member-company-file.ts";
import { readBoundedCloudResponse, withCloudDeadline } from "./cloud-request.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function closed(value: unknown, keys: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys)
		throw new Error("Invalid shared export response");
	return value as Record<string, unknown>;
}
function origin(value: string): string {
	const url = new URL(value);
	if (
		(url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1")) ||
		url.username ||
		url.password ||
		url.hash ||
		url.search ||
		url.pathname !== "/"
	)
		throw new Error("Invalid member export endpoint");
	return url.origin;
}
export interface CloudMemberFileExportDownload {
	source: ObjectStorageFileSelection & { companyId: string; environmentId: string };
	asset: CompanyComputerFileExportAsset;
	bytes: Uint8Array;
}
/** Shared member transport only. A native chooser or browser save interaction
 * consumes these verified bytes; neither runtime execution nor local paths are exposed. */
export class CloudMemberFileExports {
	readonly #options: ConstructorParameters<typeof CloudMemberCompanyFileReader>[0];
	readonly #control: string;
	readonly #gateway: string;
	readonly #fetch: typeof fetch;
	constructor(options: ConstructorParameters<typeof CloudMemberCompanyFileReader>[0]) {
		if (
			!UUID.test(options.companyId) ||
			!UUID.test(options.environmentId) ||
			!options.publishableKey ||
			options.publishableKey.length > 8192 ||
			/[\0\r\n]/.test(options.publishableKey) ||
			(options.timeoutMs !== undefined &&
				(!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 30_000))
		)
			throw new Error("Invalid member export configuration");
		this.#options = { ...options };
		this.#control = origin(options.supabaseUrl);
		this.#gateway = origin(options.objectGatewayUrl);
		this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
	}
	async list(
		signal: AbortSignal,
		after: string | null = null,
	): Promise<{ items: CompanyComputerFileExportAsset[]; nextAfter: string | null }> {
		if (after !== null && !UUID.test(after)) throw new Error("Invalid shared export page");
		return this.#withToken(async (token, deadline) => {
			const value = closed(
				await this.#rpc("qorpera_list_member_file_exports", { p_after: after, p_limit: 50 }, token, deadline),
				"items,nextAfter",
			);
			if (
				!Array.isArray(value.items) ||
				value.items.length > 50 ||
				(value.nextAfter !== null &&
					(typeof value.nextAfter !== "string" ||
						!UUID.test(value.nextAfter) ||
						(after !== null && value.nextAfter <= after)))
			)
				throw new Error("Invalid shared export page");
			let previous = after;
			const items = value.items.map((input) => {
				const asset = parseCompanyComputerFileExportAsset(input);
				if (previous !== null && asset.assetId <= previous) throw new Error("Shared export page changed");
				previous = asset.assetId;
				return asset;
			});
			if (value.nextAfter !== null && previous !== null && value.nextAfter < previous)
				throw new Error("Shared export page changed");
			return { items, nextAfter: value.nextAfter as string | null };
		}, signal);
	}
	download(value: ObjectStorageFileSelection, signal: AbortSignal): Promise<CloudMemberFileExportDownload> {
		const selection = parseObjectStorageFileSelection(value);
		return this.#withToken(async (token, deadline) => {
			const authorize = async () => {
				const descriptor = closed(
					await this.#rpc("qorpera_member_file_export_source", { p_source: selection }, token, deadline),
					"asset,companyId,environmentId",
				);
				const asset = parseCompanyComputerFileExportAsset(descriptor.asset);
				if (
					descriptor.companyId !== this.#options.companyId ||
					descriptor.environmentId !== this.#options.environmentId ||
					asset.assetId !== selection.assetId ||
					asset.sha256 !== selection.sha256
				)
					throw new Error("Selected shared export changed");
				return asset;
			};
			const asset = await authorize();
			const request: RequestInit & Pick<Request, "cache"> = {
				method: "GET",
				headers: { authorization: `Bearer ${token}` },
				signal: deadline,
				cache: "no-store",
				redirect: "error",
			};
			const response = await this.#fetch(
				`${this.#gateway}/v1/member-file-exports/${this.#options.environmentId}/${selection.assetId}/${selection.sha256}`,
				request,
			);
			if (
				response.status !== 200 ||
				response.headers.get("content-type") !== "application/octet-stream" ||
				response.headers.get("x-qorpera-access-mode") !== "live-export-authority"
			) {
				void response.body?.cancel().catch(() => undefined);
				throw new Error("Shared export access is unavailable");
			}
			const bytes = await readBoundedCloudResponse(response, asset.bytes, deadline);
			if (
				bytes.length !== asset.bytes ||
				(await cloudFileBytesSha256(bytes)) !== asset.sha256 ||
				(response.headers.has("content-length") && response.headers.get("content-length") !== String(bytes.length))
			)
				throw new Error("Shared export failed integrity verification");
			if (JSON.stringify(await authorize()) !== JSON.stringify(asset))
				throw new Error("Selected shared export changed");
			deadline.throwIfAborted();
			return {
				bytes,
				asset,
				source: { ...selection, companyId: this.#options.companyId, environmentId: this.#options.environmentId },
			};
		}, signal);
	}
	#withToken<T>(operation: (token: string, signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
		return withCloudDeadline(
			async (deadline) => {
				let token: string;
				try {
					token = await this.#options.accessToken(deadline);
				} catch {
					throw new Error("Member sign-in is unavailable");
				}
				deadline.throwIfAborted();
				if (typeof token !== "string" || !/^[A-Za-z0-9._~-]{1,8192}$/.test(token))
					throw new Error("Member sign-in is unavailable");
				const result = await operation(token, deadline);
				deadline.throwIfAborted();
				return result;
			},
			this.#options.timeoutMs ?? 30_000,
			signal,
		);
	}
	async #rpc(method: string, args: Record<string, unknown>, token: string, signal: AbortSignal): Promise<unknown> {
		const request: RequestInit & Pick<Request, "cache"> = {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				apikey: this.#options.publishableKey,
				"content-type": "application/json",
			},
			body: JSON.stringify({ p_environment_id: this.#options.environmentId, ...args }),
			signal,
			cache: "no-store",
			redirect: "error",
		};
		const response = await this.#fetch(`${this.#control}/rest/v1/rpc/${method}`, request);
		if (response.status !== 200) {
			void response.body?.cancel().catch(() => undefined);
			throw new Error("Shared export access is unavailable");
		}
		return JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(await readBoundedCloudResponse(response, 256 * 1024, signal)),
		);
	}
}
