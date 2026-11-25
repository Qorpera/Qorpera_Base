import type { JsonValue } from "@qorpera/contracts";
import {
	CODING_MAKE_PICTURE_SCHEMA,
	createCodingPictureTool,
	parseCodingPicturePath,
} from "@qorpera/runtime/cloud-coding-picture-tool";
import type { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import {
	CloudNativeToolBoundary,
	CloudToolArgumentRefusal,
	type CloudToolContent,
	CloudToolRefusal,
} from "@qorpera/runtime/cloud-native-tool-boundary";
import { CloudNativeToolOperations } from "@qorpera/runtime/cloud-native-tool-operations";
import {
	CloudPictureChannel,
	CloudPictureFailure,
	type CloudPictureMade,
} from "@qorpera/runtime/cloud-picture-channel";
import { afterEach, describe, expect, it, vi } from "vitest";
import { folderWriterFixture, sha } from "./fixtures/folder-writer-fixture.ts";
import { pngFile, pngHeader, pngRows } from "./fixtures/png-fixture.ts";

const WORKTREE = "code/surfaces/website/worktrees/00000000-0000-4000-8000-000000000001";
const runs: CloudNativeToolRun[] = [];
afterEach(() => {
	for (const run of runs.splice(0)) run.close();
});

const picture = (red = 255) =>
	pngFile(
		pngHeader(2, 2, 8, 2),
		pngRows([
			[red, 0, 0, red, 0, 0],
			[0, red, 0, 0, 0, red],
		]),
	);

async function fixture(
	seed: Parameters<typeof folderWriterFixture>[0] = {},
	options: Parameters<typeof folderWriterFixture>[1] = {},
	lane: (prompt: string) => Promise<CloudPictureMade> = async (prompt) => ({
		png: picture(),
		revisedPrompt: prompt,
		transparent: false,
	}),
) {
	const folders = [
		"code",
		"code/surfaces",
		"code/surfaces/website",
		"code/surfaces/website/worktrees",
		WORKTREE,
		...(seed.folders ?? []),
	];
	const f = await folderWriterFixture({ ...seed, folders }, options);
	runs.push(f.run);
	const pictures = new CloudPictureChannel();
	const made = vi.fn(async (input: { prompt: string }) => lane(input.prompt));
	pictures.attach(made);
	const tool = createCodingPictureTool({
		folder: f.folder,
		worktreeArea: WORKTREE,
		operations: f.operations(),
		pictures,
	});
	const call = async (value: JsonValue) => {
		const parsed = tool.parseArguments(value);
		return tool.execute(parsed, f.context);
	};
	return { ...f, tool, call, made, pictures };
}

const answer = (content: CloudToolContent) => content.value as Record<string, JsonValue>;

async function refuses(call: Promise<unknown>, text: string) {
	const error = await call.then(
		() => null,
		(thrown: unknown) => thrown,
	);
	expect(error).toBeInstanceOf(CloudToolRefusal);
	expect((error as Error).message).toContain(text);
}

const request = (more: Record<string, JsonValue> = {}) => ({
	operationKey: "hero-1",
	path: "assets/hero.png",
	prompt:
		"Editorial lifestyle shot of a matte purple meditation headband resting on warm stone, soft morning daylight.",
	...more,
});

describe("cloud-coding-picture-tool", () => {
	it("declares worker provenance with inline image support and bounded description", async () => {
		const f = await fixture();
		expect([f.tool.name, f.tool.source, f.tool.images]).toEqual(["make_picture", "worker", true]);
		expect(Buffer.byteLength(f.tool.description)).toBeLessThanOrEqual(4096);
		expect(f.tool.description).toContain("repository worktree");
		expect(f.tool.description).toContain("expectedVersion");
	});

	it("validates relative workspace .png paths and rejects traversal, .git, and malformed arguments", async () => {
		const f = await fixture();
		for (const bad of [
			"",
			".png",
			"assets/hero.jpg",
			"/assets/hero.png",
			"../hero.png",
			"assets/../hero.png",
			"assets\\hero.png",
			"assets//hero.png",
			".git/hero.png",
			"sub/.GIT/hero.png",
			" assets/hero.png",
			"assets/hero.png\n",
			`${"a".repeat(510)}.png`,
		]) {
			expect(() => parseCodingPicturePath(bad), bad).toThrow(CloudToolArgumentRefusal);
		}
		expect(parseCodingPicturePath("assets/HERO.PNG")).toBe("assets/HERO.PNG");
		expect(() => f.tool.parseArguments({ operationKey: "k", path: "a.png" })).toThrow(CloudToolArgumentRefusal);
		expect(() => f.tool.parseArguments({ ...request(), extra: true })).toThrow(CloudToolArgumentRefusal);
		expect(() => f.tool.parseArguments(request({ prompt: "" }))).toThrow(CloudToolArgumentRefusal);
		expect(() => f.tool.parseArguments(request({ prompt: "x".repeat(4097) }))).toThrow(CloudToolArgumentRefusal);
		expect(() => f.tool.parseArguments(request({ expectedVersion: "not-a-uuid" }))).toThrow(CloudToolArgumentRefusal);
		expect(() => f.tool.parseArguments(request({ operationKey: "-bad" }))).toThrow(CloudToolArgumentRefusal);
		expect(f.made).not.toHaveBeenCalled();
	});

	it("creates missing parent folders inside the worktree, commits the PNG, and returns an inline image", async () => {
		const f = await fixture();
		const boundary = new CloudNativeToolBoundary({
			companyId: f.identity.companyId,
			runId: f.identity.runId,
			identity: f.identity,
			signal: new AbortController().signal,
			assertActive: async () => undefined,
			tools: [f.tool],
		});
		const response = await boundary.invoke(
			"call-1",
			"qorpera",
			"make_picture",
			request({ path: "assets/img/hero.png" }),
		);
		boundary.close();
		expect(response.success).toBe(true);
		expect(response.contentItems).toHaveLength(2);
		expect(f.made).toHaveBeenCalledExactlyOnceWith({ prompt: request().prompt }, expect.any(AbortSignal));
		expect(f.commits).toHaveLength(1);
		expect(f.commits[0].units.map((unit) => [unit.op, unit.path])).toEqual([
			["mkdir", `${WORKTREE}/assets`],
			["mkdir", `${WORKTREE}/assets/img`],
			["write", `${WORKTREE}/assets/img/hero.png`],
		]);
		const png = picture();
		const stored = f.files.get(`${WORKTREE}/assets/img/hero.png`);
		expect(stored?.file).toMatchObject({ mediaType: "image/png", fileSha256: sha(png), bytes: png.length });
		const envelope = JSON.parse(response.contentItems[0].text);
		expect(envelope.provenance).toMatchObject({ source: "worker", tool: "make_picture" });
		expect(envelope.provenance.companyReadId).toBeUndefined();
		const value = JSON.parse(envelope.content.text);
		expect(value).toMatchObject({
			schema: CODING_MAKE_PICTURE_SCHEMA,
			state: "applied",
			operationKey: "hero-1",
			path: "assets/img/hero.png",
			kind: "image",
			mediaType: "image/png",
			bytes: png.length,
			fileSha256: sha(png),
			width: 2,
			height: 2,
			shownWidth: 2,
			shownHeight: 2,
			transparent: false,
		});
		expect(typeof value.version).toBe("string");
		expect(response.contentItems[1]).toMatchObject({ type: "inputImage" });
	});

	it("replaces an existing PNG only when expectedVersion matches", async () => {
		let count = 0;
		const f = await fixture({ folders: [`${WORKTREE}/assets`] }, {}, async (prompt) => ({
			png: picture(++count === 1 ? 255 : 40),
			revisedPrompt: prompt,
		}));
		const first = await f.call(request());
		const firstValue = answer(first);
		expect(firstValue.state).toBe("applied");
		expect(first.image).toBeDefined();

		const conflict = await f.call(request({ operationKey: "hero-conflict" }));
		expect(answer(conflict)).toMatchObject({ state: "not_applied", outcome: "conflict", reason: "exists" });
		expect(conflict.image).toBeUndefined();

		const replaced = await f.call(
			request({
				operationKey: "hero-2",
				expectedVersion: firstValue.version as string,
				prompt: "Updated angle with softer warm lighting.",
			}),
		);
		expect(answer(replaced)).toMatchObject({
			state: "applied",
			path: "assets/hero.png",
			fileSha256: sha(picture(40)),
		});
		expect(replaced.image).toBeDefined();
	});

	it("refuses before spending a picture when worktree is missing, parent is a file, or target is a folder or symlink", async () => {
		const missingWorktree = await folderWriterFixture({ folders: ["code"] });
		runs.push(missingWorktree.run);
		const channel = new CloudPictureChannel();
		const lane = vi.fn(async () => ({ png: picture() }));
		channel.attach(lane);
		const missingTool = createCodingPictureTool({
			folder: missingWorktree.folder,
			worktreeArea: WORKTREE,
			operations: missingWorktree.operations(),
			pictures: channel,
		});
		await refuses(
			missingTool.execute(missingTool.parseArguments(request()), missingWorktree.context),
			"CODING_WORKTREE_UNAVAILABLE",
		);
		expect(lane).not.toHaveBeenCalled();

		const f = await fixture({
			folders: [`${WORKTREE}/assets`, `${WORKTREE}/assets/dir.png`],
			files: { [`${WORKTREE}/not-a-dir`]: "hello" },
			links: { [`${WORKTREE}/assets/link.png`]: "other.png" },
		});
		await refuses(f.call(request({ path: "not-a-dir/hero.png" })), "CODING_PICTURE_PARENT_NOT_A_FOLDER");
		await refuses(f.call(request({ path: "assets/dir.png" })), "CODING_PICTURE_NOT_A_FILE");
		await refuses(f.call(request({ path: "assets/link.png" })), "CODING_PICTURE_IS_A_LINK");
		expect(f.made).not.toHaveBeenCalled();
	});

	it("deduplicates exact operationKey replays without regenerating and refuses key reuse for other work", async () => {
		const f = await fixture({ folders: [`${WORKTREE}/assets`] });
		const first = await f.call(request());
		const replay = await f.call(request());
		expect(f.made).toHaveBeenCalledTimes(1);
		expect(answer(replay)).toEqual(answer(first));
		expect(replay.image?.sha256).toBe(first.image?.sha256);

		await refuses(f.call(request({ prompt: "A different prompt on the same key." })), "OPERATION_KEY_USED");
		expect(f.made).toHaveBeenCalledTimes(1);
	});

	it("maps picture channel unavailability, failures, and invalid PNG bytes to clear tool refusals", async () => {
		const f = await fixture({ folders: [`${WORKTREE}/assets`] });
		f.pictures.attach(undefined);
		await refuses(f.call(request()), "PICTURES_UNAVAILABLE");

		const reasons: ReadonlyArray<[CloudPictureFailure, string]> = [
			[new CloudPictureFailure("picture_limit", 1_800_000_000), "PICTURE_LIMIT_REACHED"],
			[new CloudPictureFailure("usage_limit"), "USAGE_LIMIT_REACHED"],
			[new CloudPictureFailure("spend_cap"), "GEMINI_SPEND_CAP_REACHED"],
			[new CloudPictureFailure("billing_required"), "GEMINI_BILLING_REQUIRED"],
			[new CloudPictureFailure("refused"), "PICTURE_REFUSED"],
			[new CloudPictureFailure("free_plan"), "NO_PICTURE_FREE_PLAN"],
			[new CloudPictureFailure("no_picture"), "NO_PICTURE"],
			[new CloudPictureFailure("timeout"), "PICTURE_TIMEOUT"],
			[new CloudPictureFailure("invalid"), "PICTURE_UNUSABLE"],
			[new CloudPictureFailure("too_large"), "PICTURE_TOO_LARGE"],
			[new CloudPictureFailure("busy"), "PICTURE_BUSY"],
			[new CloudPictureFailure("failed"), "PICTURE_FAILED"],
		];
		for (const [failure, code] of reasons) {
			f.pictures.attach(async () => {
				throw failure;
			});
			await refuses(f.call(request({ operationKey: `fail-${failure.reason}` })), code);
		}

		f.pictures.attach(async () => ({ png: Buffer.from("not-a-png", "utf8") }));
		await refuses(f.call(request({ operationKey: "bad-png" })), "PICTURE_UNUSABLE");
	});

	it("marks cut revised prompts and refuses when the control plane cannot complete folder commits", async () => {
		const f = await fixture({ folders: [`${WORKTREE}/assets`] }, {}, async () => ({
			png: picture(),
			revisedPrompt: "r".repeat(4096),
			revisedPromptCut: true,
		}));
		const cut = await f.call(request());
		expect(answer(cut).revisedPromptCut).toBe(true);
		expect(answer(cut).revisedPrompt).toBeUndefined();

		const noFolderComplete = await folderWriterFixture({ folders: [WORKTREE] });
		runs.push(noFolderComplete.run);
		const channel = new CloudPictureChannel();
		channel.attach(async () => ({ png: picture() }));
		const tool = createCodingPictureTool({
			folder: noFolderComplete.folder,
			worktreeArea: WORKTREE,
			operations: new CloudNativeToolOperations(noFolderComplete.run, {
				beginToolOperation: noFolderComplete.operationControl.beginToolOperation,
				completeToolOperation: noFolderComplete.operationControl.completeToolOperation,
			}),
			pictures: channel,
		});
		await expect(tool.execute(tool.parseArguments(request()), noFolderComplete.context)).rejects.toThrow(
			"This run cannot complete folder writes",
		);
	});
});
