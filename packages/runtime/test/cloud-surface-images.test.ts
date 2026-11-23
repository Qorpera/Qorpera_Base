import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { CloudCompanyFolderClient } from "../src/cloud-company-folder-client.ts";
import {
	CloudToolArgumentRefusal,
	type CloudToolContext,
	CloudToolRefusal,
} from "../src/cloud-native-tool-boundary.ts";
import {
	CODING_ATTACHMENT_VIEW_SCHEMA,
	createCodingViewAttachmentTool,
	parseNativeSurfaceSessionImages,
	readSurfaceMemberImage,
	type SurfaceMemberImage,
	surfaceMemberImagesSection,
} from "../src/cloud-surface-images.ts";
import { buildSurfaceTurnBrief } from "../src/cloud-surface-turn-context.ts";

const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
	"base64",
);
const sha = createHash("sha256").update(png).digest("hex");
const sessionId = randomUUID();
const earlierInput = randomUUID();
const latestInput = randomUUID();
const image = (clientInputId: string, latest: boolean): SurfaceMemberImage => ({
	clientInputId,
	sha256: sha,
	bytes: png.byteLength,
	mediaType: "image/png",
	path: `QorperaOS/surfaces/site/images/${clientInputId}/${sha}.png`,
	latest,
});
const context = { signal: new AbortController().signal } as CloudToolContext;

describe("interface session images for the runtime", () => {
	it("reads the runtime answer into images with their paths and the latest marked", () => {
		const answer = {
			schema: "qorpera.native-surface-session-images/v1",
			sessionId,
			latestMemberMessageId: randomUUID(),
			messages: [
				{
					messageId: randomUUID(),
					clientInputId: earlierInput,
					latest: false,
					images: [
						{ sha256: sha, bytes: png.byteLength, mediaType: "image/png", path: image(earlierInput, false).path },
					],
				},
				{
					messageId: randomUUID(),
					clientInputId: latestInput,
					latest: true,
					images: [
						{ sha256: sha, bytes: png.byteLength, mediaType: "image/png", path: image(latestInput, true).path },
					],
				},
			],
		};
		expect(parseNativeSurfaceSessionImages(answer, sessionId)).toEqual([
			image(earlierInput, false),
			image(latestInput, true),
		]);
		expect(() => parseNativeSurfaceSessionImages({ ...answer, sessionId: randomUUID() }, sessionId)).toThrow();
		expect(() => parseNativeSurfaceSessionImages({ ...answer, schema: "other" }, sessionId)).toThrow();
		const outside = structuredClone(answer);
		outside.messages[0].images[0].path = "secrets/key.png";
		expect(() => parseNativeSurfaceSessionImages(outside, sessionId)).toThrow();
	});

	it("lists the images for company_read or coding_view_attachment, the latest message's first", () => {
		const images = [image(earlierInput, false), image(latestInput, true)];
		expect(surfaceMemberImagesSection([], "company_read")).toBeNull();
		expect(surfaceMemberImagesSection(images, "company_read")).toBe(
			[
				"## Images the member attached (open each with company_read on its path)",
				"With the latest member message:",
				`- ${images[1].path}`,
				"With earlier messages:",
				`- ${images[0].path}`,
			].join("\n"),
		);
		const brief = buildSurfaceTurnBrief({
			sessionId,
			surfaceSlug: "site",
			surfaceTitle: "Site",
			briefMarkdown: null,
			memberImages: images,
			viewAttachment: async () => png,
		});
		expect(brief).toContain(
			"## Images the member attached (open each with coding_view_attachment {clientInputId, sha256})",
		);
		expect(brief).toContain(`- clientInputId ${latestInput}, sha256 ${sha} (image/png)`);
		expect(brief).not.toContain(images[1].path);
	});

	it("reads an image from the company folder only when its hash still matches", async () => {
		const target = image(latestInput, true);
		const entry = {
			path: target.path,
			kind: "file" as const,
			file: {
				fileSha256: sha,
				bytes: png.byteLength,
				manifestSha256: "a".repeat(64),
				mediaType: "image/png",
				executable: false,
			},
		};
		const folder = {
			read: vi.fn(async () => ({ asOfSeq: 1, entry })),
			readRange: vi.fn(async () => Uint8Array.from(png)),
		} as unknown as Pick<CloudCompanyFolderClient, "read" | "readRange">;
		expect(Buffer.from(await readSurfaceMemberImage(folder, target, context.signal))).toEqual(png);
		await expect(
			readSurfaceMemberImage(folder, { ...target, sha256: "f".repeat(64) }, context.signal),
		).rejects.toThrow(CloudToolRefusal);
		vi.mocked(folder.readRange).mockResolvedValueOnce(Uint8Array.from(Buffer.from("tampered")));
		await expect(readSurfaceMemberImage(folder, target, context.signal)).rejects.toThrow("changed");
		vi.mocked(folder.read).mockResolvedValueOnce({ asOfSeq: 1, entry: null });
		await expect(readSurfaceMemberImage(folder, target, context.signal)).rejects.toThrow("no longer");
	});

	it("shows a listed image to the coding model and refuses any other", async () => {
		const read = vi.fn(async () => Uint8Array.from(png));
		const tool = createCodingViewAttachmentTool([image(latestInput, true)], read);
		expect(tool.images).toBe(true);
		const result = await tool.execute(tool.parseArguments({ clientInputId: latestInput, sha256: sha }), context);
		expect(result.kind).toBe("json");
		expect(result.value).toMatchObject({
			schema: CODING_ATTACHMENT_VIEW_SCHEMA,
			kind: "image",
			clientInputId: latestInput,
			sha256: sha,
			mediaType: "image/png",
			width: 1,
			height: 1,
		});
		expect(result.image?.sha256).toBe((result.value as { imageSha256: string }).imageSha256);
		await expect(
			tool.execute(tool.parseArguments({ clientInputId: earlierInput, sha256: sha }), context),
		).rejects.toThrow("CODING_ATTACHMENT_UNKNOWN");
		expect(read).toHaveBeenCalledTimes(1);
		expect(() => tool.parseArguments({ clientInputId: "x", sha256: sha })).toThrow(CloudToolArgumentRefusal);
		expect(() => tool.parseArguments({ clientInputId: latestInput, sha256: sha, path: "a" })).toThrow(
			CloudToolArgumentRefusal,
		);
	});
});
