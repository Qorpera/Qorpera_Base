import { readBoundedCloudResponse } from "@qorpera/cloud-client/cloud-request";
import { withAbortScopes } from "./abort-scope.ts";
import {
	convertImageBytesToPng,
	FolderImageRefusal,
	MAX_FOLDER_IMAGE_BYTES,
	oneImageAtATime,
} from "./cloud-folder-images.ts";
import { classifyGeminiHttpError } from "./cloud-gemini-key-vault.ts";
import { GEMINI_DEFAULT_API_BASE, GeminiProviderError } from "./cloud-gemini-tool-session.ts";
import { tagNativeRuntimeFailure } from "./cloud-native-failure.ts";
import {
	CLOUD_PICTURE_MS,
	CloudPictureFailure,
	cloudPictureInput,
	MAX_CLOUD_PICTURE_BYTES,
} from "./cloud-picture-channel.ts";

export const GEMINI_IMAGE_MODELS = Object.freeze(["gemini-3-pro-image"] as const);
export type GeminiImageModel = (typeof GEMINI_IMAGE_MODELS)[number];
export const DEFAULT_GEMINI_IMAGE_MODEL: GeminiImageModel = "gemini-3-pro-image";

const MAX_IMAGE_RESPONSE_BYTES = 24 * 1024 * 1024;
const RETRY_DELAYS_MS = [1_000, 3_000] as const;
const MAX_RETRY_WAIT_MS = 10_000;
const MAX_USAGE_TOKENS = 1_000_000;
const REFUSAL_FINISH_REASONS = new Set([
	"SAFETY",
	"PROHIBITED_CONTENT",
	"BLOCKLIST",
	"SPII",
	"RECITATION",
	"IMAGE_SAFETY",
	"IMAGE_PROHIBITED_CONTENT",
	"IMAGE_OTHER",
]);

export function isGeminiImageModel(value: unknown): value is GeminiImageModel {
	return typeof value === "string" && (GEMINI_IMAGE_MODELS as readonly string[]).includes(value);
}

export interface GeminiImageUsage {
	readonly inputTokens: number;
	readonly cachedTokens: number;
	readonly textOutputTokens: number;
	readonly imageOutputTokens: number;
}

export interface GeminiImageResult {
	readonly png: Buffer;
	readonly usage: GeminiImageUsage;
}

export interface GenerateGeminiImageInput {
	readonly apiKey: string;
	readonly prompt: string;
	readonly model?: GeminiImageModel;
	readonly apiBaseUrl?: string;
	readonly allowLoopback?: boolean;
	readonly fetcher?: typeof fetch;
	readonly timeoutMs?: number;
	readonly signal: AbortSignal;
}

function validateGeminiImageBaseUrl(value: string, allowLoopback: boolean): string {
	const url = new URL(value);
	const allowedProduction = url.protocol === "https:" && url.hostname === "generativelanguage.googleapis.com";
	const allowedTest =
		allowLoopback && url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
	if ((!allowedProduction && !allowedTest) || url.username || url.password || url.search || url.hash) {
		throw new Error("Gemini API base URL is invalid");
	}
	return url.origin;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readTokenCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.min(MAX_USAGE_TOKENS, Math.trunc(value))
		: 0;
}

function parseUsage(raw: unknown): GeminiImageUsage {
	if (!isPlainObject(raw)) {
		return { inputTokens: 0, cachedTokens: 0, textOutputTokens: 0, imageOutputTokens: 0 };
	}
	const inputTokens = readTokenCount(raw.promptTokenCount);
	const cachedTokens = Math.min(inputTokens, readTokenCount(raw.cachedContentTokenCount));
	const thoughtsTokens = readTokenCount(raw.thoughtsTokenCount);
	const candidatesTotal = readTokenCount(raw.candidatesTokenCount);
	let detailImageTokens = 0;
	let detailTextTokens = 0;
	if (Array.isArray(raw.candidatesTokensDetails)) {
		for (const item of raw.candidatesTokensDetails) {
			if (!isPlainObject(item)) continue;
			const count = readTokenCount(item.tokenCount);
			if (count <= 0) continue;
			const modality = typeof item.modality === "string" ? item.modality.toUpperCase() : "";
			if (modality === "IMAGE") {
				detailImageTokens = Math.min(MAX_USAGE_TOKENS, detailImageTokens + count);
			} else {
				detailTextTokens = Math.min(MAX_USAGE_TOKENS, detailTextTokens + count);
			}
		}
	}
	if (detailImageTokens > 0 || detailTextTokens > 0) {
		return {
			inputTokens,
			cachedTokens,
			textOutputTokens: Math.min(MAX_USAGE_TOKENS, detailTextTokens + thoughtsTokens),
			imageOutputTokens: detailImageTokens,
		};
	}
	return {
		inputTokens,
		cachedTokens,
		textOutputTokens: thoughtsTokens,
		imageOutputTokens: candidatesTotal,
	};
}

export function geminiImageSpendMicrodollars(model: GeminiImageModel, usage: GeminiImageUsage): number {
	if (model !== "gemini-3-pro-image") return 0;
	const input = Math.max(0, Math.trunc(usage.inputTokens));
	const cached = Math.max(0, Math.min(input, Math.trunc(usage.cachedTokens)));
	const textOutput = Math.max(0, Math.trunc(usage.textOutputTokens));
	const imageOutput = Math.max(0, Math.trunc(usage.imageOutputTokens));
	const uncached = input - cached;
	return uncached * 2 + Math.ceil(cached / 4) + textOutput * 12 + imageOutput * 120;
}

function pauseWithAbort(ms: number, signal: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		timer.unref?.();
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

export async function generateGeminiImage(input: GenerateGeminiImageInput): Promise<GeminiImageResult> {
	const { prompt } = cloudPictureInput({ prompt: input.prompt });
	const model = input.model ?? DEFAULT_GEMINI_IMAGE_MODEL;
	const baseUrl = validateGeminiImageBaseUrl(
		input.apiBaseUrl ?? GEMINI_DEFAULT_API_BASE,
		input.allowLoopback === true,
	);
	const url = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
	const fetcher = input.fetcher ?? fetch;
	const timeoutMs = input.timeoutMs ?? CLOUD_PICTURE_MS;
	const body = JSON.stringify({
		contents: [{ role: "user", parts: [{ text: prompt }] }],
		generationConfig: {
			responseModalities: ["IMAGE"],
		},
	});

	for (let attempt = 0; ; attempt += 1) {
		input.signal.throwIfAborted();
		let retryWait: number | undefined;
		let bytes: Uint8Array | undefined;
		await withAbortScopes(
			[input.signal],
			async (requestSignal) => {
				let response: Response;
				try {
					response = await fetcher(url, {
						method: "POST",
						redirect: "error",
						headers: {
							"content-type": "application/json",
							"x-goog-api-key": input.apiKey,
						},
						body,
						signal: requestSignal,
					});
				} catch (error) {
					if (input.signal.aborted) throw error;
					if (requestSignal.aborted) throw new CloudPictureFailure("timeout");
					const wait = RETRY_DELAYS_MS[attempt];
					if (wait !== undefined) {
						retryWait = wait;
						return;
					}
					throw tagNativeRuntimeFailure(
						new GeminiProviderError("transport_unavailable", null, null, "Could not reach the Gemini Image API", {
							cause: error,
						}),
						"native-tools",
						"provider_failed",
					);
				}

				try {
					bytes = await readBoundedCloudResponse(response, MAX_IMAGE_RESPONSE_BYTES, requestSignal);
				} catch (error) {
					if (input.signal.aborted) throw error;
					if (requestSignal.aborted) throw new CloudPictureFailure("timeout");
					throw new CloudPictureFailure("too_large");
				} finally {
					if (!response.body?.locked) void response.body?.cancel().catch(() => undefined);
				}

				if (!response.ok) {
					const classified = classifyGeminiHttpError(response.status, bytes, response.headers.get("retry-after"));
					const transient =
						(response.status === 429 && classified.detailCode !== "daily_quota_exhausted") ||
						response.status === 500 ||
						response.status === 502 ||
						response.status === 503 ||
						response.status === 504;
					const fallbackWait = RETRY_DELAYS_MS[attempt];
					if (transient && fallbackWait !== undefined) {
						retryWait = Math.min(MAX_RETRY_WAIT_MS, classified.retryAfterMs ?? fallbackWait);
						return;
					}
					const snippet = new TextDecoder("utf-8")
						.decode(bytes.subarray(0, 512))
						.replace(/\s+/g, " ")
						.trim()
						.slice(0, 240);
					throw tagNativeRuntimeFailure(
						new GeminiProviderError(
							classified.code,
							response.status,
							classified.providerStatus,
							snippet
								? `Gemini image error (${response.status}): ${snippet}`
								: `Gemini image HTTP ${response.status}`,
							undefined,
							classified.detailCode,
						),
						"native-tools",
						classified.code === "quota_exhausted" || classified.code === "billing_required"
							? "budget_exhausted"
							: "provider_failed",
					);
				}
			},
			timeoutMs,
		);

		if (retryWait !== undefined) {
			await pauseWithAbort(retryWait, input.signal);
			continue;
		}
		if (!bytes) throw new CloudPictureFailure("failed");

		let parsed: unknown;
		try {
			parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
		} catch {
			throw new CloudPictureFailure("invalid");
		}
		if (!isPlainObject(parsed)) throw new CloudPictureFailure("invalid");
		const promptFeedback = isPlainObject(parsed.promptFeedback) ? parsed.promptFeedback : undefined;
		if (typeof promptFeedback?.blockReason === "string" && promptFeedback.blockReason.length > 0) {
			throw new CloudPictureFailure("refused");
		}
		const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
		const first = isPlainObject(candidates[0]) ? candidates[0] : undefined;
		const finishReason = typeof first?.finishReason === "string" ? first.finishReason : "";
		const content = first && isPlainObject(first.content) ? first.content : undefined;
		const parts = content && Array.isArray(content.parts) ? content.parts.filter(isPlainObject) : [];
		let imagePart: { readonly data: string; readonly mimeType: string } | undefined;
		for (const part of parts) {
			if (part.thought === true) continue;
			const inline = isPlainObject(part.inlineData)
				? part.inlineData
				: isPlainObject(part.inline_data)
					? part.inline_data
					: undefined;
			if (!inline || typeof inline.data !== "string" || inline.data.length === 0) continue;
			const mimeType =
				typeof inline.mimeType === "string"
					? inline.mimeType
					: typeof inline.mime_type === "string"
						? inline.mime_type
						: "";
			if (mimeType && !mimeType.toLowerCase().startsWith("image/")) continue;
			imagePart = { data: inline.data, mimeType };
		}
		if (!imagePart) {
			if (REFUSAL_FINISH_REASONS.has(finishReason)) {
				throw new CloudPictureFailure("refused");
			}
			throw new CloudPictureFailure("no_picture");
		}

		const decoded = Buffer.from(imagePart.data, "base64");
		if (decoded.byteLength === 0) throw new CloudPictureFailure("invalid");
		if (decoded.byteLength > MAX_FOLDER_IMAGE_BYTES) throw new CloudPictureFailure("too_large");

		let png: Buffer;
		try {
			png = await oneImageAtATime(input.signal, async () => convertImageBytesToPng(decoded));
		} catch (error) {
			if (error instanceof FolderImageRefusal) {
				throw new CloudPictureFailure(error.reason === "too_large" ? "too_large" : "invalid");
			}
			throw error;
		}
		if (png.byteLength > MAX_CLOUD_PICTURE_BYTES) {
			throw new CloudPictureFailure("too_large");
		}
		return {
			png,
			usage: parseUsage(parsed.usageMetadata),
		};
	}
}
