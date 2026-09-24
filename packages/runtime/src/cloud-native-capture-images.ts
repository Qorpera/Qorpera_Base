import { createHash } from "node:crypto";
import {
	type CloudCompanyComputerScreenshots,
	type CompanyComputerScreenshotAsset,
	parseCompanyComputerScreenshotAsset,
} from "./cloud-company-computer-screenshots.ts";
import type { CloudToolContent } from "./cloud-native-tool-boundary.ts";

export const CLOUD_NATIVE_CAPTURE_IMAGES_CAPABILITY = "qorpera.native-capture-images/v1";
// One authority round trip checks at most this many captures and bytes (the
// kernel's per-call bounds). A run may issue any number; the set is checked in batches.
const ASSERT_BATCH_COUNT = 128;
const ASSERT_BATCH_BYTES = 128 * 1024 * 1024;

/** Host-only association of exact issued envelopes with authorized capture pixels.
 * A native digest is never a read capability. Current SQL authority is required
 * again on replay and before every provider/compaction context view. */
export class CloudNativeCaptureImages {
	readonly #reader: Pick<CloudCompanyComputerScreenshots, "read" | "assertReadable">;
	readonly #issued = new Map<string, Readonly<CompanyComputerScreenshotAsset>>();

	constructor(reader: Pick<CloudCompanyComputerScreenshots, "read" | "assertReadable">) {
		this.#reader = reader;
	}

	async issue(callId: string, envelope: string, content: CloudToolContent, signal: AbortSignal): Promise<string> {
		if (content.kind !== "json") throw new Error("INVALID_NATIVE_CAPTURE");
		const asset = Object.freeze(parseCompanyComputerScreenshotAsset(content.value));
		const key = this.#key(callId, envelope);
		// Only metadata is kept per capture (never pixels), so a run's captures are not counted.
		if (this.#issued.has(key)) throw new Error("NATIVE_CAPTURE_REISSUED");
		const pixels = Buffer.from(await this.#reader.read(asset, signal));
		signal.throwIfAborted();
		if (pixels.length !== asset.bytes || createHash("sha256").update(pixels).digest("hex") !== asset.sha256)
			throw new Error("NATIVE_CAPTURE_CHANGED");
		this.#issued.set(key, asset);
		return `data:image/png;base64,${pixels.toString("base64")}`;
	}

	verify(callId: string, envelope: string, sha256: string | undefined): CompanyComputerScreenshotAsset | undefined {
		const asset = this.#issued.get(this.#key(callId, envelope));
		if (asset?.sha256 !== sha256) throw new Error("NATIVE_CAPTURE_NOT_ISSUED");
		return asset ? { ...asset } : undefined;
	}

	async assertReadable(signal: AbortSignal): Promise<void> {
		// Compaction can retain a summary after dropping the original image. Its
		// source authority still belongs to this run's read set.
		const assets = [...new Map([...this.#issued.values()].map((asset) => [asset.assetId, asset])).values()];
		let batch: CompanyComputerScreenshotAsset[] = [];
		let bytes = 0;
		for (const asset of assets) {
			if (batch.length === ASSERT_BATCH_COUNT || bytes + asset.bytes > ASSERT_BATCH_BYTES) {
				await this.#reader.assertReadable(batch, signal);
				batch = [];
				bytes = 0;
			}
			batch.push(asset);
			bytes += asset.bytes;
		}
		if (batch.length) await this.#reader.assertReadable(batch, signal);
		signal.throwIfAborted();
	}

	#key(callId: string, envelope: string): string {
		return `${callId}:${createHash("sha256").update(envelope).digest("hex")}`;
	}
}
