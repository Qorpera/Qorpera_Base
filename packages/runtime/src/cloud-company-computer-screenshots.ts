import { isRecord, UUID_ANY_CASE_PATTERN as SCREENSHOT_UUID } from "@qorpera/contracts";

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

export interface CloudCompanyComputerScreenshots {
	read(value: CompanyComputerScreenshotAsset, signal: AbortSignal): Promise<Uint8Array>;
	assertReadable(values: readonly CompanyComputerScreenshotAsset[], signal: AbortSignal): Promise<void>;
}

function screenshotObject(value: unknown, keys: string): Record<string, unknown> {
	if (!isRecord(value) || Object.keys(value).sort().join() !== keys) throw new Error("INVALID_OFFICE_CAPTURE");
	return value;
}

export function parseCompanyComputerScreenshotAsset(value: unknown): CompanyComputerScreenshotAsset {
	const asset = screenshotObject(value, "assetId,bytes,height,mediaType,screenId,sha256,surface,width");
	if (
		typeof asset.assetId !== "string" ||
		!SCREENSHOT_UUID.test(asset.assetId) ||
		typeof asset.screenId !== "string" ||
		!SCREENSHOT_UUID.test(asset.screenId) ||
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
