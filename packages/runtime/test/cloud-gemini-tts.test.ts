import { describe, expect, it, vi } from "vitest";
import { geminiTtsSpendMicrodollars, pcm16ToWav, synthesizeGeminiSpeech } from "../src/cloud-gemini-tts.ts";

describe("cloud-gemini-tts", () => {
	it("wraps 24kHz mono PCM16 into a valid WAV header with exact duration", () => {
		const pcm = new Uint8Array(24_000 * 2 * 2);
		const wav = pcm16ToWav(pcm, 24_000, 1);
		expect(wav.byteLength).toBe(44 + pcm.byteLength);
		const view = new DataView(wav.buffer);
		expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
		expect(new TextDecoder().decode(wav.subarray(8, 12))).toBe("WAVE");
		expect(view.getUint32(24, true)).toBe(24_000);
		expect(view.getUint16(22, true)).toBe(1);
		expect(view.getUint32(40, true)).toBe(pcm.byteLength);
	});

	it("calls Gemini generateContent with verbatim transcript and selected voice profile", async () => {
		const pcm = new Uint8Array(24_000 * 2 * 3);
		const captured: { url?: string; headers?: Record<string, string>; body?: Record<string, unknown> } = {};
		const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			captured.url = String(url);
			captured.headers = init?.headers as Record<string, string>;
			captured.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return Response.json({
				candidates: [
					{
						content: {
							parts: [
								{
									inlineData: {
										mimeType: "audio/L16;codec=pcm;rate=24000",
										data: Buffer.from(pcm).toString("base64"),
									},
								},
							],
						},
					},
				],
				usageMetadata: {
					promptTokenCount: 12,
					candidatesTokenCount: 180,
				},
			});
		}) as unknown as typeof fetch;

		const result = await synthesizeGeminiSpeech({
			apiKey: "AIzaSyTestKey12345678901234567890",
			model: "gemini-3.8-flash-tts",
			voiceName: "Kore",
			text: "The buyer sets a budget ceiling.",
			fetcher,
			signal: new AbortController().signal,
		});

		expect(captured.url).toBe(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-tts:generateContent",
		);
		expect(captured.headers?.["x-goog-api-key"]).toBe("AIzaSyTestKey12345678901234567890");
		expect(captured.body).toEqual({
			contents: [{ role: "user", parts: [{ text: "The buyer sets a budget ceiling." }] }],
			generationConfig: {
				responseModalities: ["AUDIO"],
				speechConfig: {
					voiceConfig: {
						prebuiltVoiceConfig: {
							voiceName: "Kore",
						},
					},
				},
			},
		});
		expect(result.mediaType).toBe("audio/wav");
		expect(result.fileExtension).toBe("wav");
		expect(result.seconds).toBe(3);
		expect(result.audio.byteLength).toBe(44 + pcm.byteLength);
		expect(result.usage).toEqual({ inputTokens: 12, cachedTokens: 0, outputTokens: 180 });
	});

	it("computes spend microdollars for flash and flash-lite TTS models", () => {
		expect(
			geminiTtsSpendMicrodollars("gemini-3.8-flash-tts", { inputTokens: 100, cachedTokens: 0, outputTokens: 1000 }),
		).toBe(9050);
		expect(
			geminiTtsSpendMicrodollars("gemini-3.8-flash-lite-tts", {
				inputTokens: 100,
				cachedTokens: 0,
				outputTokens: 1000,
			}),
		).toBe(6050);
	});

	it("validates Gemini TTS apiBaseUrl and requires allowLoopback for loopback http", async () => {
		await expect(
			synthesizeGeminiSpeech({
				apiKey: "AIzaSyTestKey12345678901234567890",
				model: "gemini-3.8-flash-tts",
				voiceName: "Kore",
				text: "Test.",
				apiBaseUrl: "http://127.0.0.1:8080",
				fetcher: vi.fn() as unknown as typeof fetch,
				signal: new AbortController().signal,
			}),
		).rejects.toThrow("Gemini API base URL is invalid");

		await expect(
			synthesizeGeminiSpeech({
				apiKey: "AIzaSyTestKey12345678901234567890",
				model: "gemini-3.8-flash-tts",
				voiceName: "Kore",
				text: "Test.",
				apiBaseUrl: "https://evil.example.com",
				allowLoopback: true,
				fetcher: vi.fn() as unknown as typeof fetch,
				signal: new AbortController().signal,
			}),
		).rejects.toThrow("Gemini API base URL is invalid");

		const pcm = new Uint8Array(24_000 * 2);
		const fetcher = vi.fn(async (url: string | URL | Request) => {
			expect(String(url)).toBe("http://127.0.0.1:8080/v1beta/models/gemini-3.8-flash-tts:generateContent");
			return Response.json({
				candidates: [
					{
						content: {
							parts: [
								{
									inlineData: {
										mimeType: "audio/L16;codec=pcm;rate=24000",
										data: Buffer.from(pcm).toString("base64"),
									},
								},
							],
						},
					},
				],
				usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 40 },
			});
		}) as unknown as typeof fetch;

		const ok = await synthesizeGeminiSpeech({
			apiKey: "AIzaSyTestKey12345678901234567890",
			model: "gemini-3.8-flash-tts",
			voiceName: "Kore",
			text: "Test.",
			apiBaseUrl: "http://127.0.0.1:8080",
			allowLoopback: true,
			fetcher,
			signal: new AbortController().signal,
		});
		expect(ok.seconds).toBe(1);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
});
