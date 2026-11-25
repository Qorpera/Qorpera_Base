import { createHash, randomUUID } from "node:crypto";
import {
	CloudToolArgumentRefusal,
	type CloudToolContext,
	CloudToolRefusal,
} from "@qorpera/runtime/cloud-native-tool-boundary";
import {
	CloudPictureChannel,
	CloudPictureFailure,
	CloudPictureUnavailable,
} from "@qorpera/runtime/cloud-picture-channel";
import {
	createStudioPictureTool,
	normalizeStudioPicturePath,
	STUDIO_MAKE_PICTURE_SCHEMA,
} from "@qorpera/runtime/cloud-surface-picture-tool";
import { describe, expect, it, vi } from "vitest";
import { pngFile, pngHeader, pngRows } from "./fixtures/png-fixture.ts";

const samplePng = () =>
	pngFile(
		pngHeader(2, 2, 8, 2),
		pngRows([
			[255, 0, 0, 0, 255, 0],
			[0, 0, 255, 255, 255, 0],
		]),
	);

function makeContext(): CloudToolContext {
	return {
		companyId: randomUUID(),
		runId: randomUUID(),
		callId: "studio-pic-1",
		argumentSha256: "a".repeat(64),
		signal: new AbortController().signal,
	};
}

describe("cloud-surface-picture-tool", () => {
	it("normalizes relative Studio PNG paths and rejects layout.json, icons/, traversal, and non-PNG names", () => {
		expect(normalizeStudioPicturePath("pictures/hero.png", "product")).toBe("pictures/hero.png");
		expect(normalizeStudioPicturePath("product/pictures/hero.png", "product")).toBe("pictures/hero.png");
		expect(normalizeStudioPicturePath("/product/HERO.PNG", "product/")).toBe("HERO.PNG");

		for (const bad of [
			"",
			"layout.json",
			"icons/mark.png",
			"pictures/hero.jpg",
			"../outside.png",
			"pictures/../hero.png",
			"pictures\\hero.png",
			".png",
			"pictures/hero.png\n",
		]) {
			expect(() => normalizeStudioPicturePath(bad, "product"), bad).toThrow(CloudToolArgumentRefusal);
		}
	});

	it("generates a PNG, stages binary bytes and surface patch with optional targeting, and returns inline image", async () => {
		const png = samplePng();
		const pngSha = createHash("sha256").update(png).digest("hex");
		const sessionId = randomUUID();
		const existingChangeId = randomUUID();
		const stageBytes = vi.fn(async (bytes: Uint8Array, mediaType: string) => ({
			manifestSha256: "m".repeat(64),
			fileSha256: pngSha,
			bytes: bytes.byteLength,
			mediaType,
		}));
		const stageSurfacePatch = vi.fn(async () => ({
			changeId: existingChangeId,
			seq: 2,
			openChangeCount: 1,
		}));
		const pictures = new CloudPictureChannel();
		pictures.attach(async () => ({
			png,
			revisedPrompt: "Warm ceramic diffuser on travertine stone.",
			transparent: false,
		}));
		const tool = createStudioPictureTool({
			sessionId,
			folderRoot: "product",
			stageBytes,
			surfacePatch: { stageSurfacePatch },
			pictures,
		});

		expect([tool.name, tool.source, tool.images]).toEqual(["make_picture", "runtime", true]);

		const parsed = tool.parseArguments({
			path: "product/pictures/diffuser.png",
			prompt: "Ceramic diffuser on stone.",
			title: "Add diffuser hero",
			summary: "Generated a Studio hero image.",
			changeId: existingChangeId,
			optionGroup: "hero-concepts",
			optionGroupTitle: "Hero concepts",
		});
		const result = await tool.execute(parsed, makeContext());

		expect(stageBytes).toHaveBeenCalledExactlyOnceWith(png, "image/png", expect.any(AbortSignal));
		expect(stageSurfacePatch).toHaveBeenCalledExactlyOnceWith(
			sessionId,
			{
				title: "Add diffuser hero",
				summary: "Generated a Studio hero image.",
				ops: [
					{
						op: "write_file",
						path: "pictures/diffuser.png",
						file: {
							manifestSha256: "m".repeat(64),
							fileSha256: pngSha,
							bytes: png.byteLength,
							mediaType: "image/png",
						},
					},
				],
				notePaths: [],
				finishSession: false,
				changeId: existingChangeId,
				optionGroup: "hero-concepts",
				optionGroupTitle: "Hero concepts",
			},
			expect.any(Object),
		);
		expect(result.kind).toBe("json");
		expect(result.image).toBeDefined();
		expect(result.value).toMatchObject({
			schema: STUDIO_MAKE_PICTURE_SCHEMA,
			ok: true,
			kind: "picture",
			changeId: existingChangeId,
			seq: 2,
			path: "pictures/diffuser.png",
			mediaType: "image/png",
			bytes: png.byteLength,
			fileSha256: pngSha,
			width: 2,
			height: 2,
			shownWidth: 2,
			shownHeight: 2,
			imageSha256: result.image!.sha256,
			transparent: false,
			revisedPrompt: "Warm ceramic diffuser on travertine stone.",
		});
	});

	it("maps picture channel unavailability and every failure reason to CloudToolRefusal without staging", async () => {
		const stageBytes = vi.fn();
		const stageSurfacePatch = vi.fn();
		const pictures = new CloudPictureChannel();
		const tool = createStudioPictureTool({
			sessionId: randomUUID(),
			folderRoot: "product",
			stageBytes,
			surfacePatch: { stageSurfacePatch },
			pictures,
		});

		const runRefusal = async (error: unknown, expected: string) => {
			pictures.attach(async () => {
				throw error;
			});
			const thrown = await tool
				.execute(tool.parseArguments({ path: "pictures/a.png", prompt: "A calm desk." }), makeContext())
				.catch((err: unknown) => err);
			expect(thrown).toBeInstanceOf(CloudToolRefusal);
			expect((thrown as Error).message).toContain(expected);
		};

		await runRefusal(new CloudPictureUnavailable(), "PICTURES_UNAVAILABLE");
		await runRefusal(new CloudPictureFailure("picture_limit", 1_800_000_000), "PICTURE_LIMIT_REACHED");
		await runRefusal(new CloudPictureFailure("usage_limit"), "USAGE_LIMIT_REACHED");
		await runRefusal(new CloudPictureFailure("spend_cap"), "GEMINI_SPEND_CAP_REACHED");
		await runRefusal(new CloudPictureFailure("billing_required"), "GEMINI_BILLING_REQUIRED");
		await runRefusal(new CloudPictureFailure("refused"), "PICTURE_REFUSED");
		await runRefusal(new CloudPictureFailure("free_plan"), "NO_PICTURE_FREE_PLAN");
		await runRefusal(new CloudPictureFailure("no_picture"), "NO_PICTURE");
		await runRefusal(new CloudPictureFailure("timeout"), "PICTURE_TIMEOUT");
		await runRefusal(new CloudPictureFailure("invalid"), "PICTURE_UNUSABLE");
		await runRefusal(new CloudPictureFailure("too_large"), "PICTURE_TOO_LARGE");
		await runRefusal(new CloudPictureFailure("busy"), "PICTURE_BUSY");
		await runRefusal(new CloudPictureFailure("failed"), "PICTURE_FAILED");
		expect(stageBytes).not.toHaveBeenCalled();
		expect(stageSurfacePatch).not.toHaveBeenCalled();
	});
});
