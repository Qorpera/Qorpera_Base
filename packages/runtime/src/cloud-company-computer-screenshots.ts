import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	assertCompanyComputerLease,
	assertCompanyComputerScope,
	COMPANY_COMPUTER_UUID,
	type CompanyComputerEffectContext,
	type CompanyComputerOperation,
	type CompanyComputerScope,
	type CompanyComputerScreenLease,
} from "@qorpera/cloud-client/cloud-company-computer-contract";
import type { CloudObjectTransport } from "@qorpera/cloud-client/node/cloud-object-store";
import type { CompanyComputerScreenshotPublisher } from "./cloud-company-computer-guest.ts";
import type { HttpCloudCompanyComputerRegistry } from "./cloud-company-computer-registry-http.ts";
import { parseCompanyComputerAction } from "./cloud-company-computer-tools.ts";
import { HttpNativeCompanyObjectTransport } from "./cloud-native-company-objects.ts";
import { type CloudNativeToolRun, cloudToolRequest } from "./cloud-native-tool-authority.ts";
import { cloudNativeToolOperationEnvelope } from "./cloud-native-tool-operations.ts";

export interface CompanyComputerScreenshotAsset {
	assetId: string;
	sha256: string;
	bytes: number;
	mediaType: "image/png";
	screenId: string;
	surface: "browser" | "desktop";
	width: number;
	height: number;
}

function record(value: unknown, keys: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys)
		throw new Error("INVALID_OFFICE_CAPTURE");
	return value as Record<string, unknown>;
}

function png(bytes: Uint8Array, surface: "browser" | "desktop") {
	const data = Buffer.from(bytes);
	if (
		data.length < 33 ||
		data.length > 8 * 1024 * 1024 ||
		!data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
		data.readUInt32BE(8) !== 13 ||
		data.toString("ascii", 12, 16) !== "IHDR"
	)
		throw new Error("INVALID_OFFICE_CAPTURE");
	const width = data.readUInt32BE(16),
		height = data.readUInt32BE(20);
	if (
		width < 1 ||
		width > 1920 ||
		height < 1 ||
		height > 1200 ||
		(surface === "desktop" && (width !== 1920 || height !== 1200))
	)
		throw new Error("INVALID_OFFICE_CAPTURE");
	return {
		sha256: createHash("sha256").update(data).digest("hex"),
		bytes: data.length,
		mediaType: "image/png" as const,
		width,
		height,
	};
}

export function parseCompanyComputerScreenshotAsset(value: unknown): CompanyComputerScreenshotAsset {
	const asset = record(value, "assetId,bytes,height,mediaType,screenId,sha256,surface,width");
	if (
		typeof asset.assetId !== "string" ||
		!COMPANY_COMPUTER_UUID.test(asset.assetId) ||
		typeof asset.screenId !== "string" ||
		!COMPANY_COMPUTER_UUID.test(asset.screenId) ||
		typeof asset.sha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(asset.sha256) ||
		!Number.isSafeInteger(asset.bytes) ||
		(asset.bytes as number) < 33 ||
		(asset.bytes as number) > 8 * 1024 * 1024 ||
		asset.mediaType !== "image/png" ||
		(asset.surface !== "browser" && asset.surface !== "desktop") ||
		!Number.isSafeInteger(asset.width) ||
		(asset.width as number) < 1 ||
		(asset.width as number) > 1920 ||
		!Number.isSafeInteger(asset.height) ||
		(asset.height as number) < 1 ||
		(asset.height as number) > 1200 ||
		(asset.surface === "desktop" && (asset.width !== 1920 || asset.height !== 1200))
	)
		throw new Error("INVALID_OFFICE_CAPTURE");
	return { ...asset } as unknown as CompanyComputerScreenshotAsset;
}

// Screenshots waiting in memory for the model, at most this many and each for at most this long (folder-v2, P06d):
// each is handed on right after its operation, so one is the usual count.
const INLINE_SCREENSHOTS = 4;
const INLINE_SCREENSHOT_MS = 60_000;

/** Screenshots that travel in their perform answer instead of being stored (folder-v2, P06d): the office service keeps
 * one until its native gateway answers, and the native host until the boundary hands it to the model. Each is taken
 * once; past the bound the oldest goes, each goes on its own timer once its time is up, and all go when the run ends. */
export class CompanyComputerInlineScreenshots {
	readonly #held = new Map<string, { bytes: Uint8Array; timer: ReturnType<typeof setTimeout> }>();

	hold(assetId: string, bytes: Uint8Array): void {
		this.#drop(assetId);
		const timer = setTimeout(() => this.#drop(assetId), INLINE_SCREENSHOT_MS);
		timer.unref?.();
		this.#held.set(assetId, { bytes: Uint8Array.from(bytes), timer });
		while (this.#held.size > INLINE_SCREENSHOTS) this.#drop(this.#held.keys().next().value as string);
	}

	take(assetId: string): Uint8Array | undefined {
		const held = this.#held.get(assetId);
		this.#drop(assetId);
		return held?.bytes;
	}

	clear(): void {
		for (const assetId of [...this.#held.keys()]) this.#drop(assetId);
	}

	get size(): number {
		return this.#held.size;
	}

	#drop(assetId: string): void {
		const held = this.#held.get(assetId);
		if (!held) return;
		clearTimeout(held.timer);
		this.#held.delete(assetId);
	}
}

/** How the capture authority says to keep the pixels: as a stored object (the published artifact), or not at all
 * (folder-v2: they go to the model once, in the perform answer, and the operation's receipt is the record). */
function captureStorage(value: unknown): "object" | "none" {
	const answer = record(value, value && typeof value === "object" && "storage" in value ? "state,storage" : "state");
	if (answer.state !== "authorized" || (answer.storage !== undefined && answer.storage !== "none"))
		throw new Error("OFFICE_CAPTURE_UNCONFIRMED");
	return answer.storage === "none" ? "none" : "object";
}

/** One admitted native run. Upload stages bytes; only the SQL transaction
 * publishes an artifact with the original effect receipt and retention hold.
 * On a folder-v2 company nothing is stored: the pixels go to the native host in
 * the perform answer and wait in memory for the model, and the effect receipt is
 * the capture's record.
 * Private sign-in surfaces never call this adapter. */
export class CloudCompanyComputerScreenshots implements CompanyComputerScreenshotPublisher {
	readonly #run: CloudNativeToolRun;
	readonly #scope: CompanyComputerScope;
	readonly #registry: Pick<HttpCloudCompanyComputerRegistry, "call">;
	readonly #objects: (signal: AbortSignal) => Pick<CloudObjectTransport, "put" | "get">;
	readonly #inline = new CompanyComputerInlineScreenshots();

	constructor(options: {
		run: CloudNativeToolRun;
		scope: CompanyComputerScope;
		registry: Pick<HttpCloudCompanyComputerRegistry, "call">;
		objects: (signal: AbortSignal) => Pick<CloudObjectTransport, "put" | "get">;
	}) {
		assertCompanyComputerScope(options.scope, options.scope);
		if (
			options.run.identity.companyId !== options.scope.companyId ||
			options.run.identity.environmentId !== options.scope.environmentId ||
			options.run.identity.audienceKind !== "company" ||
			options.run.identity.audienceUserId !== null
		)
			throw new Error("COMPUTER_RUN_MISMATCH");
		this.#run = options.run;
		this.#scope = Object.freeze({ ...options.scope });
		this.#registry = options.registry;
		this.#objects = options.objects;
		// A waiting screenshot never outlives its run (a closed native session closes its run).
		this.#run.signal.addEventListener("abort", () => this.#inline.clear(), { once: true });
	}

	async publish(
		bytes: Uint8Array,
		lease: CompanyComputerScreenLease,
		context: CompanyComputerEffectContext,
		operation: CompanyComputerOperation,
	): Promise<CompanyComputerScreenshotAsset> {
		// Own all caller-provided bytes/metadata before the first await.
		bytes = Uint8Array.from(bytes);
		lease = structuredClone(lease);
		operation = structuredClone(operation);
		const { receiptId, idempotencyKey } = context;
		assertCompanyComputerScope(lease.binding, this.#scope);
		assertCompanyComputerLease(lease, lease.binding, {
			kind: "agent",
			runId: this.#run.identity.runId,
			staffAgentId: this.#run.identity.staffAgentId,
		});
		const action = parseCompanyComputerAction(operation.arguments);
		if (
			!isDeepStrictEqual(context.identity, this.#run.identity) ||
			!COMPANY_COMPUTER_UUID.test(receiptId) ||
			!/^[0-9a-f]{64}$/.test(idempotencyKey) ||
			operation.tool !== "computer_screenshot" ||
			action.kind !== "screenshot" ||
			!isDeepStrictEqual(operation.target.binding, lease.binding)
		)
			throw new Error("INVALID_OFFICE_CAPTURE");
		const image = png(bytes, action.surface);
		const args = {
			p_binding: this.#run.binding,
			p_scope: this.#scope,
			p_lease: lease,
			p_envelope: cloudNativeToolOperationEnvelope(this.#run.identity, operation),
			p_receipt_id: receiptId,
			p_idempotency_sha256: createHash("sha256").update(idempotencyKey).digest("hex"),
			p_image: image,
		};
		return cloudToolRequest(
			async (signal) => {
				await this.#run.assertActive(signal);
				const storage = captureStorage(
					await this.#registry.call("qorpera_native_office_capture", { ...args, p_action: "authorize" }, signal),
				);
				signal.throwIfAborted();
				if (storage === "object") {
					const stored = await this.#objects(signal).put(
						`${this.#scope.companyId}/${image.sha256}`,
						bytes,
						image.mediaType,
					);
					if (stored !== "stored" && stored !== "exists") throw new Error("OFFICE_CAPTURE_UNCONFIRMED");
					signal.throwIfAborted();
				}
				const asset = parseCompanyComputerScreenshotAsset(
					await this.#registry.call("qorpera_native_office_capture", { ...args, p_action: "publish" }, signal),
				);
				if (
					!isDeepStrictEqual(asset, {
						...image,
						assetId: asset.assetId,
						screenId: lease.binding.screenId,
						surface: action.surface,
					})
				)
					throw new Error("OFFICE_CAPTURE_UNCONFIRMED");
				signal.throwIfAborted();
				if (storage === "none") {
					// The receipt names the capture; the pixels wait here for the native gateway's answer.
					if (asset.assetId !== receiptId) throw new Error("OFFICE_CAPTURE_UNCONFIRMED");
					this.#inline.hold(asset.assetId, bytes);
				}
				return asset;
			},
			AbortSignal.any([context.signal, this.#run.signal]),
			15_000,
		);
	}

	/** The office service's side: the pixels of a capture published without storage, once, for its perform answer. */
	takeInline(assetId: string): Uint8Array | undefined {
		return this.#inline.take(assetId);
	}

	/** The native host's side: the pixels that came in a capture's perform answer, kept for {@link read} once they
	 * are exactly the published capture's. */
	holdInline(value: CompanyComputerScreenshotAsset, bytes: Uint8Array): void {
		this.#run.signal.throwIfAborted();
		const asset = parseCompanyComputerScreenshotAsset(value);
		if (
			!isDeepStrictEqual(png(bytes, asset.surface), {
				sha256: asset.sha256,
				bytes: asset.bytes,
				mediaType: asset.mediaType,
				width: asset.width,
				height: asset.height,
			})
		)
			throw new Error("OFFICE_CAPTURE_CHANGED");
		this.#inline.hold(asset.assetId, bytes);
	}

	/** Fetch only a completed capture of this run, rechecking after object I/O.
	 * A capture whose pixels came in its perform answer is read from memory, once.
	 * This returns host bytes, not a model-visible URL or a member download grant. */
	async read(value: CompanyComputerScreenshotAsset, signal: AbortSignal): Promise<Uint8Array> {
		const asset = parseCompanyComputerScreenshotAsset(value);
		return cloudToolRequest(
			async (checked) => {
				const authorize = async () => {
					const current = parseCompanyComputerScreenshotAsset(
						await this.#registry.call(
							"qorpera_read_native_office_capture",
							{ p_binding: this.#run.binding, p_asset_id: asset.assetId },
							checked,
						),
					);
					if (!isDeepStrictEqual(current, asset)) throw new Error("OFFICE_CAPTURE_CHANGED");
					checked.throwIfAborted();
				};
				await this.#run.assertActive(checked);
				await authorize();
				const bytes = Uint8Array.from(
					this.#inline.take(asset.assetId) ??
						(await this.#objects(checked).get(`${this.#scope.companyId}/${asset.sha256}`)),
				);
				if (
					!isDeepStrictEqual(png(bytes, asset.surface), {
						sha256: asset.sha256,
						bytes: asset.bytes,
						mediaType: asset.mediaType,
						width: asset.width,
						height: asset.height,
					})
				)
					throw new Error("OFFICE_CAPTURE_CHANGED");
				await authorize();
				return bytes;
			},
			AbortSignal.any([signal, this.#run.signal]),
			15_000,
		);
	}

	/** One bounded authority round trip for the capture set in a native request.
	 * No object bytes or URLs are exposed by this check. */
	async assertReadable(values: readonly CompanyComputerScreenshotAsset[], signal: AbortSignal): Promise<void> {
		if (values.length > 128) throw new Error("INVALID_OFFICE_CAPTURE_BATCH");
		const assets = values.map(parseCompanyComputerScreenshotAsset);
		await cloudToolRequest(
			async (checked) => {
				await this.#run.assertActive(checked);
				const result = await this.#registry.call(
					"qorpera_assert_native_office_captures",
					{
						p_binding: this.#run.binding,
						p_assets: assets,
					},
					checked,
				);
				if (!isDeepStrictEqual(result, { state: "authorized", assets })) throw new Error("OFFICE_CAPTURE_CHANGED");
				checked.throwIfAborted();
			},
			AbortSignal.any([signal, this.#run.signal]),
			3_000,
		);
	}
}

/** Protected service configuration; credentials remain outside browser/command
 * namespaces. The existing immutable gateway rechecks the full native binding. */
export function parseCompanyComputerCaptureGateway(options: {
	baseUrl: string;
	token: string;
	fetch?: typeof fetch;
}): Readonly<typeof options> {
	const gateway = { ...options };
	const url = new URL(gateway.baseUrl);
	if (
		(url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1")) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/" ||
		!/^[A-Za-z0-9_-]{43}$/.test(gateway.token) ||
		(gateway.fetch !== undefined && typeof gateway.fetch !== "function")
	)
		throw new Error("INVALID_OFFICE_CAPTURE_GATEWAY");
	return Object.freeze(gateway);
}

export function createHttpCompanyComputerScreenshots(options: {
	run: CloudNativeToolRun;
	scope: CompanyComputerScope;
	registry: Pick<HttpCloudCompanyComputerRegistry, "call">;
	objectGateway: { baseUrl: string; token: string; fetch?: typeof fetch };
}): CloudCompanyComputerScreenshots {
	const gateway = parseCompanyComputerCaptureGateway(options.objectGateway);
	const companyId = options.scope.companyId;
	const binding = options.run.binding;
	return new CloudCompanyComputerScreenshots({
		...options,
		objects: (signal) =>
			new HttpNativeCompanyObjectTransport({
				...gateway,
				companyId,
				binding,
				signal,
			}),
	});
}
