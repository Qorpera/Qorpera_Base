import { readBoundedCloudResponse } from "@qorpera/cloud-client/cloud-request";
import { withAbortScopes } from "./abort-scope.ts";
import { classifyGeminiHttpError } from "./cloud-gemini-key-vault.ts";
import { GEMINI_DEFAULT_API_BASE, GeminiProviderError } from "./cloud-gemini-tool-session.ts";
import { tagNativeRuntimeFailure } from "./cloud-native-failure.ts";

export const GEMINI_TTS_MODELS = Object.freeze(["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"] as const);
export type GeminiTtsModel = (typeof GEMINI_TTS_MODELS)[number];

export const GEMINI_TTS_VOICES = Object.freeze([
	"Charon",
	"Kore",
	"Puck",
	"Zephyr",
	"Aoede",
	"Fenrir",
	"Leda",
	"Orus",
	"Callirrhoe",
	"Autonoe",
	"Enceladus",
	"Iapetus",
	"Umbriel",
	"Algieba",
	"Despina",
	"Erinome",
	"Algenib",
	"Rasalgethi",
	"Laomedeia",
	"Achernar",
	"Alnilam",
	"Schedar",
	"Gacrux",
	"Pulcherrima",
	"Achird",
	"Zubenelgenubi",
	"Vindemiatrix",
	"Sadachbia",
	"Sadaltager",
	"Sulafat",
] as const);
export type GeminiTtsVoice = (typeof GEMINI_TTS_VOICES)[number];

export const DEFAULT_GEMINI_TTS_VOICE: GeminiTtsVoice = "Charon";

const MAX_TTS_RESPONSE_BYTES = 24 * 1024 * 1024;
const MAX_TTS_REQUEST_MS = 60_000;
const RETRY_DELAYS_MS = [1_000, 3_000] as const;
const MAX_RETRY_WAIT_MS = 10_000;
const DEFAULT_PCM_SAMPLE_RATE = 24_000;
const DEFAULT_PCM_CHANNELS = 1;
const MIN_SAMPLE_RATE = 8_000;
const MAX_SAMPLE_RATE = 96_000;

export function isGeminiTtsModel(value: unknown): value is GeminiTtsModel {
	return typeof value === "string" && (GEMINI_TTS_MODELS as readonly string[]).includes(value);
}

export function isGeminiTtsVoice(value: unknown): value is GeminiTtsVoice {
	return typeof value === "string" && (GEMINI_TTS_VOICES as readonly string[]).includes(value);
}

export interface GeminiTtsUsage {
	readonly inputTokens: number;
	readonly cachedTokens: number;
	readonly outputTokens: number;
}

export interface GeminiTtsSpeechResult {
	readonly audio: Uint8Array;
	readonly mediaType: "audio/wav" | "audio/mpeg" | "audio/mp4";
	readonly fileExtension: "wav" | "mp3" | "m4a";
	readonly seconds: number;
	readonly usage: GeminiTtsUsage;
}

export interface SynthesizeGeminiSpeechInput {
	readonly apiKey: string;
	readonly model: GeminiTtsModel;
	readonly voiceName: GeminiTtsVoice;
	readonly text: string;
	readonly apiBaseUrl?: string;
	readonly fetcher?: typeof fetch;
	readonly signal: AbortSignal;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function pcm16ToWav(
	pcm: Uint8Array,
	sampleRate = DEFAULT_PCM_SAMPLE_RATE,
	channels = DEFAULT_PCM_CHANNELS,
): Uint8Array {
	const alignedBytes = pcm.byteLength - (pcm.byteLength % (channels * 2));
	const wav = new Uint8Array(44 + alignedBytes);
	const view = new DataView(wav.buffer);
	const byteRate = sampleRate * channels * 2;
	const blockAlign = channels * 2;
	wav.set([0x52, 0x49, 0x46, 0x46], 0);
	view.setUint32(4, 36 + alignedBytes, true);
	wav.set([0x57, 0x41, 0x56, 0x45], 8);
	wav.set([0x66, 0x6d, 0x74, 0x20], 12);
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, channels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, byteRate, true);
	view.setUint16(32, blockAlign, true);
	view.setUint16(34, 16, true);
	wav.set([0x64, 0x61, 0x74, 0x61], 36);
	view.setUint32(40, alignedBytes, true);
	wav.set(pcm.subarray(0, alignedBytes), 44);
	return wav;
}

function parseWavSeconds(wav: Uint8Array): number | null {
	if (wav.byteLength < 44) return null;
	if (wav[0] !== 0x52 || wav[1] !== 0x49 || wav[2] !== 0x46 || wav[3] !== 0x46) return null;
	const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
	const byteRate = view.getUint32(28, true);
	const dataSize = view.getUint32(40, true);
	if (byteRate <= 0 || dataSize <= 0) return null;
	return Number(Math.max(0.25, dataSize / byteRate).toFixed(2));
}

function parsePcmParams(mimeType: string): { readonly sampleRate: number; readonly channels: number } {
	const rateMatch = /\brate=(\d{4,6})\b/i.exec(mimeType);
	const channelsMatch = /\bchannels=(\d)\b/i.exec(mimeType);
	const parsedRate = rateMatch ? Number.parseInt(rateMatch[1]!, 10) : DEFAULT_PCM_SAMPLE_RATE;
	const parsedChannels = channelsMatch ? Number.parseInt(channelsMatch[1]!, 10) : DEFAULT_PCM_CHANNELS;
	const sampleRate =
		Number.isFinite(parsedRate) && parsedRate >= MIN_SAMPLE_RATE && parsedRate <= MAX_SAMPLE_RATE
			? parsedRate
			: DEFAULT_PCM_SAMPLE_RATE;
	const channels = parsedChannels === 2 ? 2 : DEFAULT_PCM_CHANNELS;
	return { sampleRate, channels };
}

function parseUsage(raw: unknown): GeminiTtsUsage {
	if (!isPlainObject(raw)) return { inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
	const readCount = (value: unknown): number =>
		typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
	const inputTokens = readCount(raw.promptTokenCount);
	const cachedTokens = Math.min(inputTokens, readCount(raw.cachedContentTokenCount));
	const outputTokens = readCount(raw.candidatesTokenCount);
	return { inputTokens, cachedTokens, outputTokens };
}

export function geminiTtsSpendMicrodollars(model: GeminiTtsModel, usage: GeminiTtsUsage): number {
	const input = Math.max(0, Math.trunc(usage.inputTokens));
	const cached = Math.max(0, Math.min(input, Math.trunc(usage.cachedTokens)));
	const output = Math.max(0, Math.trunc(usage.outputTokens));
	const uncached = input - cached;
	const outputRate = model === "gemini-3.8-flash-lite-tts" ? 6 : 9;
	return Math.ceil(uncached / 2) + output * outputRate;
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

export async function synthesizeGeminiSpeech(input: SynthesizeGeminiSpeechInput): Promise<GeminiTtsSpeechResult> {
	const text = input.text.trim();
	if (!text) throw new Error("Gemini TTS text is empty");
	const baseUrl = (input.apiBaseUrl ?? GEMINI_DEFAULT_API_BASE).replace(/\/+$/, "");
	const url = `${baseUrl}/v1beta/models/${encodeURIComponent(input.model)}:generateContent`;
	const fetcher = input.fetcher ?? fetch;
	const body = JSON.stringify({
		contents: [{ role: "user", parts: [{ text }] }],
		generationConfig: {
			responseModalities: ["AUDIO"],
			speechConfig: {
				voiceConfig: {
					prebuiltVoiceConfig: {
						voiceName: input.voiceName,
					},
				},
			},
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
					const wait = RETRY_DELAYS_MS[attempt];
					if (wait !== undefined) {
						retryWait = wait;
						return;
					}
					throw tagNativeRuntimeFailure(
						new GeminiProviderError("transport_unavailable", null, null, "Could not reach the Gemini TTS API", {
							cause: error,
						}),
						"native-tools",
						"provider_failed",
					);
				}

				try {
					bytes = await readBoundedCloudResponse(response, MAX_TTS_RESPONSE_BYTES, requestSignal);
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
								? `Gemini TTS error (${response.status}): ${snippet}`
								: `Gemini TTS HTTP ${response.status}`,
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
			MAX_TTS_REQUEST_MS,
		);

		if (retryWait !== undefined) {
			await pauseWithAbort(retryWait, input.signal);
			continue;
		}
		if (!bytes) throw new Error("Gemini TTS returned no response");

		let parsed: unknown;
		try {
			parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
		} catch (error) {
			throw new Error("Gemini TTS response was not valid JSON", { cause: error });
		}
		if (!isPlainObject(parsed)) throw new Error("Gemini TTS response was invalid");
		const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
		const first = isPlainObject(candidates[0]) ? candidates[0] : undefined;
		const content = first && isPlainObject(first.content) ? first.content : undefined;
		const parts = content && Array.isArray(content.parts) ? content.parts.filter(isPlainObject) : [];
		let audioPart: { readonly data: string; readonly mimeType: string } | undefined;
		for (const part of parts) {
			const inline = isPlainObject(part.inlineData) ? part.inlineData : undefined;
			if (inline && typeof inline.data === "string" && inline.data.length > 0) {
				const mimeType = typeof inline.mimeType === "string" ? inline.mimeType : "audio/L16;codec=pcm;rate=24000";
				audioPart = { data: inline.data, mimeType };
				break;
			}
		}
		if (!audioPart) throw new Error("Gemini TTS response contained no audio data");

		const decoded = new Uint8Array(Buffer.from(audioPart.data, "base64"));
		if (decoded.byteLength === 0) throw new Error("Gemini TTS returned empty audio");
		const usage = parseUsage(parsed.usageMetadata);
		const lowerMime = audioPart.mimeType.toLowerCase();

		if (lowerMime.startsWith("audio/wav") || lowerMime.startsWith("audio/x-wav")) {
			const seconds = parseWavSeconds(decoded) ?? Number(Math.max(0.5, text.split(/\s+/).length / 2.8).toFixed(2));
			return { audio: decoded, mediaType: "audio/wav", fileExtension: "wav", seconds, usage };
		}
		if (lowerMime.startsWith("audio/mpeg") || lowerMime.startsWith("audio/mp3")) {
			const seconds = Number(Math.max(0.5, text.split(/\s+/).length / 2.8).toFixed(2));
			return { audio: decoded, mediaType: "audio/mpeg", fileExtension: "mp3", seconds, usage };
		}
		if (lowerMime.startsWith("audio/mp4") || lowerMime.startsWith("audio/m4a")) {
			const seconds = Number(Math.max(0.5, text.split(/\s+/).length / 2.8).toFixed(2));
			return { audio: decoded, mediaType: "audio/mp4", fileExtension: "m4a", seconds, usage };
		}
		const { sampleRate, channels } = parsePcmParams(audioPart.mimeType);
		const wav = pcm16ToWav(decoded, sampleRate, channels);
		const aligned = decoded.byteLength - (decoded.byteLength % (channels * 2));
		const seconds = Number(Math.max(0.25, aligned / (sampleRate * channels * 2)).toFixed(2));
		return { audio: wav, mediaType: "audio/wav", fileExtension: "wav", seconds, usage };
	}
}
