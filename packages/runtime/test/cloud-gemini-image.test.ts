import {
	DEFAULT_GEMINI_IMAGE_MODEL,
	GEMINI_IMAGE_MODELS,
	geminiImageSpendMicrodollars,
	generateGeminiImage,
	isGeminiImageModel,
} from "@qorpera/runtime/cloud-gemini-image";
import { GeminiProviderError } from "@qorpera/runtime/cloud-gemini-tool-session";
import { CloudPictureFailure } from "@qorpera/runtime/cloud-picture-channel";
import { JpegChroma, JpegEncoder } from "image-in-browser/lib/src/formats/jpeg-encoder.js";
import { MemoryImage } from "image-in-browser/lib/src/image/image.js";
import { describe, expect, it, vi } from "vitest";
import { PNG_SIGNATURE, pngFile, pngHeader, pngRows } from "./fixtures/png-fixture.ts";

const samplePng = () =>
	pngFile(
		pngHeader(2, 2, 8, 2),
		pngRows([
			[255, 0, 0, 0, 255, 0],
			[0, 0, 255, 255, 255, 0],
		]),
	);

const sampleJpeg = (): Buffer => {
	const image = new MemoryImage({ width: 8, height: 8 });
	for (let y = 0; y < 8; y += 1) {
		for (let x = 0; x < 8; x += 1) {
			image.setPixelRgb(x, y, x < 4 ? 220 : 30, 80, x < 4 ? 30 : 220);
		}
	}
	return Buffer.from(new JpegEncoder(90).encode({ image, chroma: JpegChroma.yuv444 }));
};

describe("cloud-gemini-image", () => {
	it("recognizes supported Gemini image models and computes exact spend microdollars", () => {
		expect(GEMINI_IMAGE_MODELS).toEqual(["gemini-3-pro-image"]);
		expect(DEFAULT_GEMINI_IMAGE_MODEL).toBe("gemini-3-pro-image");
		expect(isGeminiImageModel("gemini-3-pro-image")).toBe(true);
		expect(isGeminiImageModel("chatgpt-image")).toBe(false);
		expect(isGeminiImageModel(null)).toBe(false);

		expect(
			geminiImageSpendMicrodollars("gemini-3-pro-image", {
				inputTokens: 1_000,
				cachedTokens: 201,
				textOutputTokens: 50,
				imageOutputTokens: 1_120,
			}),
		).toBe((1_000 - 201) * 2 + Math.ceil(201 / 4) + 50 * 12 + 1_120 * 120);
	});

	it("generates a PNG, skips thought parts, and parses modality token details", async () => {
		const thoughtPng = pngFile(pngHeader(1, 1, 8, 2), pngRows([[10, 10, 10]]));
		const finalPng = samplePng();
		const seen: { url: string; apiKey: string | null; body: Record<string, unknown> }[] = [];
		const fetcher = vi.fn<typeof fetch>(async (input, init) => {
			const headers = new Headers(init?.headers);
			seen.push({
				url: String(input),
				apiKey: headers.get("x-goog-api-key"),
				body: JSON.parse(String(init?.body)) as Record<string, unknown>,
			});
			return Response.json({
				candidates: [
					{
						finishReason: "STOP",
						content: {
							parts: [
								{
									thought: true,
									inlineData: { mimeType: "image/png", data: thoughtPng.toString("base64") },
								},
								{
									inlineData: { mimeType: "image/png", data: finalPng.toString("base64") },
								},
							],
						},
					},
				],
				usageMetadata: {
					promptTokenCount: 120,
					cachedContentTokenCount: 20,
					thoughtsTokenCount: 40,
					candidatesTokenCount: 1130,
					candidatesTokensDetails: [
						{ modality: "TEXT", tokenCount: 10 },
						{ modality: "IMAGE", tokenCount: 1120 },
					],
				},
			});
		});

		const result = await generateGeminiImage({
			apiKey: "AIzaSyExampleKey",
			prompt: "Warm editorial ceramics on linen.",
			fetcher,
			signal: new AbortController().signal,
		});

		expect(seen).toHaveLength(1);
		expect(seen[0]).toEqual({
			url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent",
			apiKey: "AIzaSyExampleKey",
			body: {
				contents: [{ role: "user", parts: [{ text: "Warm editorial ceramics on linen." }] }],
				generationConfig: { responseModalities: ["IMAGE"] },
			},
		});
		expect(result.png.equals(finalPng)).toBe(true);
		expect(result.usage).toEqual({
			inputTokens: 120,
			cachedTokens: 20,
			textOutputTokens: 50,
			imageOutputTokens: 1120,
		});
	});

	it("converts JPEG responses to PNG and falls back to candidatesTokenCount when modality details are absent", async () => {
		const jpeg = sampleJpeg();
		const fetcher = vi.fn<typeof fetch>(async () =>
			Response.json({
				candidates: [
					{
						finishReason: "STOP",
						content: {
							parts: [{ inline_data: { mime_type: "image/jpeg", data: jpeg.toString("base64") } }],
						},
					},
				],
				usageMetadata: {
					promptTokenCount: 80,
					thoughtsTokenCount: 15,
					candidatesTokenCount: 1120,
				},
			}),
		);

		const result = await generateGeminiImage({
			apiKey: "AIzaSyExampleKey",
			prompt: "Abstract split red and blue tiles.",
			fetcher,
			signal: new AbortController().signal,
		});

		expect(result.png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
		expect(result.png.readUInt32BE(16)).toBe(8);
		expect(result.png.readUInt32BE(20)).toBe(8);
		expect(result.usage).toEqual({
			inputTokens: 80,
			cachedTokens: 0,
			textOutputTokens: 15,
			imageOutputTokens: 1120,
		});
	});

	it("maps blocked or empty responses to CloudPictureFailure reasons while still reporting billed usage", async () => {
		const recordedUsages: unknown[] = [];
		const blocked = vi.fn<typeof fetch>(async () =>
			Response.json({
				promptFeedback: { blockReason: "SAFETY" },
				usageMetadata: { promptTokenCount: 42 },
			}),
		);
		await expect(
			generateGeminiImage({
				apiKey: "AIzaSyExampleKey",
				prompt: "Blocked prompt.",
				fetcher: blocked,
				onUsage: (usage) => {
					recordedUsages.push(usage);
				},
				signal: new AbortController().signal,
			}),
		).rejects.toMatchObject({ reason: "refused" });
		expect(recordedUsages).toEqual([{ inputTokens: 42, cachedTokens: 0, textOutputTokens: 0, imageOutputTokens: 0 }]);

		const imageSafety = vi.fn<typeof fetch>(async () =>
			Response.json({
				candidates: [{ finishReason: "IMAGE_SAFETY", content: { parts: [] } }],
				usageMetadata: { promptTokenCount: 60, thoughtsTokenCount: 15 },
			}),
		);
		await expect(
			generateGeminiImage({
				apiKey: "AIzaSyExampleKey",
				prompt: "Blocked candidate.",
				fetcher: imageSafety,
				onUsage: (usage) => {
					recordedUsages.push(usage);
				},
				signal: new AbortController().signal,
			}),
		).rejects.toMatchObject({ reason: "refused" });
		expect(recordedUsages).toHaveLength(2);
		expect(recordedUsages[1]).toEqual({
			inputTokens: 60,
			cachedTokens: 0,
			textOutputTokens: 15,
			imageOutputTokens: 0,
		});

		const empty = vi.fn<typeof fetch>(async () =>
			Response.json({
				candidates: [{ finishReason: "STOP", content: { parts: [{ text: "No image." }] } }],
			}),
		);
		const emptyError = await generateGeminiImage({
			apiKey: "AIzaSyExampleKey",
			prompt: "Empty output.",
			fetcher: empty,
			signal: new AbortController().signal,
		}).catch((error: unknown) => error);
		expect(emptyError).toBeInstanceOf(CloudPictureFailure);
		expect((emptyError as CloudPictureFailure).reason).toBe("no_picture");
	});

	it("classifies non-transient HTTP errors without retry and retries transient 503 responses", async () => {
		const keyRejected = vi.fn<typeof fetch>(
			async () =>
				new Response(JSON.stringify({ error: { status: "UNAUTHENTICATED", message: "API key not valid." } }), {
					status: 401,
				}),
		);
		const authErr = await generateGeminiImage({
			apiKey: "AIzaSyBad",
			prompt: "Test.",
			fetcher: keyRejected,
			signal: new AbortController().signal,
		}).catch((error: unknown) => error);
		expect(authErr).toBeInstanceOf(GeminiProviderError);
		expect((authErr as GeminiProviderError).code).toBe("key_rejected");
		expect(keyRejected).toHaveBeenCalledTimes(1);

		const billingErrFetch = vi.fn<typeof fetch>(
			async () =>
				new Response(
					JSON.stringify({ error: { status: "FAILED_PRECONDITION", message: "Billing not enabled." } }),
					{
						status: 402,
					},
				),
		);
		const billingErr = await generateGeminiImage({
			apiKey: "AIzaSyNoBilling",
			prompt: "Test.",
			fetcher: billingErrFetch,
			signal: new AbortController().signal,
		}).catch((error: unknown) => error);
		expect(billingErr).toBeInstanceOf(GeminiProviderError);
		expect((billingErr as GeminiProviderError).code).toBe("billing_required");
		expect(billingErrFetch).toHaveBeenCalledTimes(1);

		const png = samplePng();
		let calls = 0;
		const flaky = vi.fn<typeof fetch>(async () => {
			calls += 1;
			if (calls === 1) {
				return new Response(JSON.stringify({ error: { status: "UNAVAILABLE", message: "Try again" } }), {
					status: 503,
					headers: { "retry-after": "1" },
				});
			}
			return Response.json({
				candidates: [
					{
						finishReason: "STOP",
						content: { parts: [{ inlineData: { mimeType: "image/png", data: png.toString("base64") } }] },
					},
				],
			});
		});
		const recovered = await generateGeminiImage({
			apiKey: "AIzaSyOk",
			prompt: "Retry test.",
			fetcher: flaky,
			signal: new AbortController().signal,
		});
		expect(calls).toBe(2);
		expect(recovered.png.equals(png)).toBe(true);
	});
});
