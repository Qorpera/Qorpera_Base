import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_CHATGPT_PLAN_IMAGE_MODEL,
	generateChatGptPlanImage,
	hasChatGptPlanDirectory,
	hasChatGptPlanToken,
} from "@qorpera/runtime/cloud-chatgpt-plan-image";
import { CloudPictureFailure, CloudPictureUnavailable } from "@qorpera/runtime/cloud-picture-channel";
import { JpegChroma, JpegEncoder } from "image-in-browser/lib/src/formats/jpeg-encoder.js";
import { MemoryImage } from "image-in-browser/lib/src/image/image.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PNG_SIGNATURE, pngFile, pngHeader, pngRows } from "./fixtures/png-fixture.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function makeIdentityRoot(token?: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "chatgpt-plan-image-"));
	roots.push(root);
	if (token !== undefined) {
		await mkdir(join(root, "chatgpt-plan"), { mode: 0o700 });
		if (token !== "") {
			await writeFile(join(root, "chatgpt-plan", "access-token"), token, { mode: 0o600 });
		}
	}
	return root;
}

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
			image.setPixelRgb(x, y, 40, 120, 220);
		}
	}
	return Buffer.from(new JpegEncoder(90).encode({ image, chroma: JpegChroma.yuv444 }));
};

describe("cloud-chatgpt-plan-image", () => {
	it("distinguishes missing plan directory, empty plan directory, and active access-token file", async () => {
		const none = await makeIdentityRoot();
		const emptyDir = await makeIdentityRoot("");
		const active = await makeIdentityRoot("plan-token-abc");

		expect(await hasChatGptPlanDirectory(none)).toBe(false);
		expect(await hasChatGptPlanToken(none)).toBe(false);

		expect(await hasChatGptPlanDirectory(emptyDir)).toBe(true);
		expect(await hasChatGptPlanToken(emptyDir)).toBe(false);

		expect(await hasChatGptPlanDirectory(active)).toBe(true);
		expect(await hasChatGptPlanToken(active)).toBe(true);
	});

	it("calls OpenAI Responses API with image_generation tool, converts JPEG to PNG, and trims revised prompt", async () => {
		const root = await makeIdentityRoot("plan-token-live-1\n");
		const png = samplePng();
		const seen: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
		const fetcher = vi.fn<typeof fetch>(async (input, init) => {
			const headers = new Headers(init?.headers);
			seen.push({
				url: String(input),
				auth: headers.get("authorization"),
				body: JSON.parse(String(init?.body)) as Record<string, unknown>,
			});
			return Response.json({
				output: [
					{
						type: "image_generation_call",
						status: "completed",
						result: png.toString("base64"),
						revised_prompt: "A minimal oak desk in crisp morning daylight.",
					},
				],
			});
		});

		const first = await generateChatGptPlanImage({
			identityRoot: root,
			prompt: "Oak desk in morning light.",
			fetcher,
			signal: new AbortController().signal,
		});
		expect(seen[0]).toEqual({
			url: "https://api.openai.com/v1/responses",
			auth: "Bearer plan-token-live-1",
			body: {
				model: DEFAULT_CHATGPT_PLAN_IMAGE_MODEL,
				input: "Oak desk in morning light.",
				tools: [{ type: "image_generation", output_format: "png" }],
				tool_choice: { type: "image_generation" },
				store: false,
			},
		});
		expect(first.png.equals(png)).toBe(true);
		expect(first.revisedPrompt).toBe("A minimal oak desk in crisp morning daylight.");
		expect(first.revisedPromptCut).toBeUndefined();

		const jpeg = sampleJpeg();
		const second = await generateChatGptPlanImage({
			identityRoot: root,
			prompt: "Blue tile.",
			fetcher: vi.fn<typeof fetch>(async () =>
				Response.json({
					output: [
						{
							type: "image_generation_call",
							status: "completed",
							result: jpeg.toString("base64"),
							revised_prompt: "x".repeat(5_000),
						},
					],
				}),
			),
			signal: new AbortController().signal,
		});
		expect(second.png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
		expect(second.revisedPromptCut).toBe(true);
		expect(Buffer.byteLength(second.revisedPrompt ?? "")).toBeLessThanOrEqual(4096);
	});

	it("throws CloudPictureUnavailable when token is absent and classifies plan API errors", async () => {
		const emptyDir = await makeIdentityRoot("");
		await expect(
			generateChatGptPlanImage({
				identityRoot: emptyDir,
				prompt: "Missing token.",
				signal: new AbortController().signal,
			}),
		).rejects.toBeInstanceOf(CloudPictureUnavailable);

		const active = await makeIdentityRoot("plan-token-live-2");
		const cases: ReadonlyArray<[Response, CloudPictureFailure["reason"], number?]> = [
			[
				new Response(
					JSON.stringify({
						error: { code: "image_gen_limit", message: "Too many images", resets_at: 1_800_000_000 },
					}),
					{ status: 429 },
				),
				"picture_limit",
				1_800_000_000,
			],
			[
				new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "Rate limit" } }), {
					status: 429,
				}),
				"usage_limit",
			],
			[
				new Response(JSON.stringify({ error: { message: "Free plan cannot generate images." } }), { status: 403 }),
				"free_plan",
			],
			[
				new Response(JSON.stringify({ error: { code: "content_policy_violation", message: "Safety refusal" } }), {
					status: 400,
				}),
				"refused",
			],
			[
				Response.json({
					output: [{ type: "message", content: [{ type: "refusal", refusal: "Cannot draw this." }] }],
				}),
				"refused",
			],
			[Response.json({ output: [] }), "no_picture"],
		];

		for (const [response, reason, resetsAt] of cases) {
			const err = await generateChatGptPlanImage({
				identityRoot: active,
				prompt: "Test error case.",
				fetcher: vi.fn<typeof fetch>(async () => response),
				signal: new AbortController().signal,
			}).catch((thrown: unknown) => thrown);
			expect(err).toBeInstanceOf(CloudPictureFailure);
			expect((err as CloudPictureFailure).reason).toBe(reason);
			if (resetsAt !== undefined) {
				expect((err as CloudPictureFailure).resetsAt).toBe(resetsAt);
			}
		}
	});
});
