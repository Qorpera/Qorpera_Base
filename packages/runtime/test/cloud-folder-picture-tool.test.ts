import { createHash, randomUUID } from "node:crypto";
import type { JsonValue } from "@qorpera/contracts";
import { cloudActionEffect, describeCloudAction } from "@qorpera/runtime/cloud-action-review";
import { CLOUD_MAKE_PICTURE_DESCRIPTION, cloudPictureTool } from "@qorpera/runtime/cloud-folder-picture-tool";
import type { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import {
	CloudNativeToolBoundary,
	CloudToolArgumentRefusal,
	type CloudToolContent,
	CloudToolRefusal,
} from "@qorpera/runtime/cloud-native-tool-boundary";
import {
	CloudPictureChannel,
	CloudPictureFailure,
	type CloudPictureMade,
	CloudPictureUnavailable,
} from "@qorpera/runtime/cloud-picture-channel";
import { afterEach, describe, expect, it, vi } from "vitest";
import { folderWriterFixture, sha } from "./fixtures/folder-writer-fixture.ts";
import { pngFile, pngHeader, pngRows } from "./fixtures/png-fixture.ts";

const runs: CloudNativeToolRun[] = [];
afterEach(() => {
	for (const run of runs.splice(0)) run.close();
});

/** A picture as the generator gives it: one red pixel, or another colour for a second picture. */
const picture = (red = 255) => pngFile(pngHeader(1, 1, 8, 2), pngRows([[red, 0, 0]]));

async function fixture(
	seed: Parameters<typeof folderWriterFixture>[0] = {},
	options: Parameters<typeof folderWriterFixture>[1] = {},
	lane: (prompt: string) => Promise<CloudPictureMade> = async (prompt) => ({
		png: picture(),
		revisedPrompt: prompt,
		transparent: false,
	}),
) {
	const f = await folderWriterFixture(seed, options);
	runs.push(f.run);
	const pictures = new CloudPictureChannel();
	const made = vi.fn(async (input: { prompt: string }) => lane(input.prompt));
	pictures.attach(made);
	const tool = cloudPictureTool({ folder: f.folder, operations: f.operations(), identity: f.identity, pictures });
	const call = async (value: JsonValue) => {
		const parsed = tool.parseArguments(value);
		const prepared = await tool.prepare!(parsed, f.context);
		return { prepared, content: await tool.execute(prepared, f.context) };
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
	operationKey: "mug-1",
	path: "pictures/mug.png",
	prompt: "A white ceramic mug, front view, soft daylight, plain white background.",
	...more,
});

it("is a runtime tool that shows the model a picture, told in under 4096 bytes", async () => {
	const f = await fixture();
	expect([f.tool.name, f.tool.source, f.tool.images]).toEqual(["make_picture", "runtime", true]);
	expect(f.tool.description).toBe(CLOUD_MAKE_PICTURE_DESCRIPTION);
	expect(Buffer.byteLength(f.tool.description)).toBeLessThanOrEqual(4096);
	for (const rule of [
		"something that does not exist yet, such as the company's own product idea, a scene, a look or an illustration for an app",
		"One picture per call.",
		"A real thing is shown by its real picture, never a generated one: for a real product, person or place, or a competitor's product, save a screenshot of the maker's own picture instead.",
		"Never pass a generated picture off as a photo of something real: where an app shows one, it says drawn or illustration.",
		"says the subject, the view, the light and the background; for a thing that will stand on a page, ask for a plain or transparent-looking background",
		"The answer shows you the picture: look at it, and when it is not good enough, call again with a better prompt",
		"Pictures for an app go into the app's folder, such as apps/<name>/pictures/, before the save_app that shows them.",
	])
		expect(f.tool.description).toContain(rule);
});

it("refuses arguments it cannot make a picture of before any picture is made", async () => {
	const f = await fixture({ folders: ["pictures"] });
	const refused = (value: JsonValue, text: string) => {
		expect(() => f.tool.parseArguments(value)).toThrow(CloudToolArgumentRefusal);
		expect(() => f.tool.parseArguments(value)).toThrow(text);
	};
	refused({ operationKey: "k", path: "pictures/mug.png" }, "takes operationKey, path and prompt");
	refused({ ...request(), size: "1024x1024" }, "takes operationKey, path and prompt");
	refused(request({ path: "pictures/mug.jpg" }), "path must end in .png");
	refused(request({ path: "/pictures/mug.png" }), "path must be a company-relative path");
	refused(request({ path: "apps/sales/icons/mug.png" }), "an app's icons are SVG drawings that save_app writes");
	refused(request({ prompt: "" }), "prompt must be plain text of 1 to 4096 bytes");
	refused(request({ prompt: "x".repeat(4097) }), "prompt must be plain text of 1 to 4096 bytes");
	refused(request({ expectedVersion: "v1" }), "expectedVersion must be the version company_read reported");
	refused(request({ operationKey: "-k" }), "operationKey must be");
	// Upper case is a PNG too; expectedVersion may be left out or null.
	expect(f.tool.parseArguments(request({ path: "pictures/MUG.PNG" }))).toMatchObject({
		path: "pictures/MUG.PNG",
		expectedVersion: null,
	});
	expect(f.made).not.toHaveBeenCalled();
});

it("saves a new picture as one PNG unit under the call's receipt, and shows it after its answer", async () => {
	const f = await fixture({ folders: ["pictures"] });
	const boundary = new CloudNativeToolBoundary({
		companyId: f.identity.companyId,
		runId: f.identity.runId,
		identity: f.identity,
		signal: new AbortController().signal,
		assertActive: async () => undefined,
		tools: [f.tool],
	});
	const response = await boundary.invoke("call-1", "qorpera", "make_picture", request());
	boundary.close();
	expect(response.success).toBe(true);
	expect(f.made).toHaveBeenCalledExactlyOnceWith({ prompt: request().prompt }, expect.any(AbortSignal));
	// One write of the picture's bytes as image/png, under the call's receipt.
	expect(f.commits).toHaveLength(1);
	const png = picture();
	expect(f.commits[0].units).toHaveLength(1);
	expect(f.commits[0].units[0]).toMatchObject({
		op: "write",
		path: "pictures/mug.png",
		file: { mediaType: "image/png", bytes: png.length, fileSha256: sha(png) },
	});
	expect(f.commits[0].units[0]).not.toHaveProperty("expectedVersion");
	expect(f.commits[0].receiptId).toEqual(expect.any(String));
	const stored = f.files.get("pictures/mug.png");
	expect(stored?.file).toMatchObject({ mediaType: "image/png", fileSha256: sha(png), bytes: png.length });
	const envelope = JSON.parse(response.contentItems[0].text);
	const value = JSON.parse(envelope.content.text);
	expect(value).toEqual({
		schema: "qorpera.company-folder-result/v1",
		state: "applied",
		operationKey: "mug-1",
		path: "pictures/mug.png",
		version: stored?.version,
		receiptId: f.commits[0].receiptId,
		outcome: "saved",
		kind: "picture",
		mediaType: "image/png",
		bytes: png.length,
		fileSha256: sha(png),
		width: 1,
		height: 1,
		shownWidth: 1,
		shownHeight: 1,
		imageSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
		transparent: false,
		next: "Saved. Look at the picture: if it is not good enough, call again with a better prompt, a new operationKey and this version as expectedVersion.",
	});
	// The prompt the generator got was the call's own: the answer does not repeat it.
	expect(value).not.toHaveProperty("revisedPrompt");
	// The picture follows its answer, as the fitted PNG the answer names.
	expect(response.contentItems).toHaveLength(2);
	const shown = Buffer.from(
		(response.contentItems[1] as { imageUrl: string }).imageUrl.slice("data:image/png;base64,".length),
		"base64",
	);
	expect(createHash("sha256").update(shown).digest("hex")).toBe(value.imageSha256);
	expect(f.ledger.size).toBe(1);
});

it("fits a large picture to what the model is shown, and names a prompt the generator was given in other words", async () => {
	const wide = pngFile(
		pngHeader(2400, 100, 8, 2),
		pngRows(Array.from({ length: 100 }, () => new Array(7200).fill(90))),
	);
	const f = await fixture({ folders: ["pictures"] }, {}, async () => ({ png: wide, revisedPrompt: "A mug, wide" }));
	const { content } = await f.call(request());
	expect(answer(content)).toMatchObject({
		state: "applied",
		width: 2400,
		height: 100,
		shownWidth: 1920,
		shownHeight: 80,
		bytes: wide.length,
		revisedPrompt: "A mug, wide",
	});
	expect(answer(content)).not.toHaveProperty("transparent");
	expect(content.image?.png.readUInt32BE(16)).toBe(1920);
	expect(content.image?.sha256).toBe(answer(content).imageSha256);
});

it("replaces a picture only under its version, as company_write does, and shows none that was not saved", async () => {
	const f = await fixture({ folders: ["pictures"] });
	f.seed("pictures/mug.png", picture(10), "image/png");
	const version = f.files.get("pictures/mug.png")?.version as string;
	// Without a version, a file that is there stays as it is.
	const exists = await f.call(request());
	expect(answer(exists.content)).toMatchObject({ state: "not_applied", outcome: "conflict", reason: "exists" });
	expect(String(answer(exists.content).next)).toContain("COMPANY_FILE_EXISTS");
	expect(exists.content.image).toBeUndefined();
	expect(f.tool.refused?.(exists.content)).toBe("stale_version");
	// Another version is a conflict.
	const stale = await f.call(request({ operationKey: "mug-2", expectedVersion: randomUUID() }));
	expect(String(answer(stale.content).next)).toContain("COMPANY_FILE_VERSION_CHANGED");
	expect(stale.content.image).toBeUndefined();
	// Its own version replaces it.
	const replaced = await f.call(request({ operationKey: "mug-3", expectedVersion: version }));
	expect(answer(replaced.content)).toMatchObject({ state: "applied", fileSha256: sha(picture()) });
	expect(replaced.content.image).toBeDefined();
	expect(f.commits.at(-1)?.units[0]).toMatchObject({ op: "write", expectedVersion: version });
	expect(f.files.get("pictures/mug.png")?.file.fileSha256).toBe(sha(picture()));
});

it("answers a repeat of a saved call from its receipt, without the picture it made again", async () => {
	let red = 255;
	const f = await fixture({ folders: ["pictures"] }, {}, async () => ({ png: picture(red--) }));
	const first = await f.call(request());
	const again = await f.call(request());
	expect(answer(again.content)).toEqual(answer(first.content));
	expect(first.content.image).toBeDefined();
	expect(again.content.image).toBeUndefined();
	expect(f.commits).toHaveLength(1);
	expect(f.files.get("pictures/mug.png")?.file.fileSha256).toBe(sha(picture(255)));
});

it("shows a picture parked for review at a protected path, and notes one among the company's pages", async () => {
	const f = await fixture(
		{ folders: ["pictures", "QorperaOS/interfaces/pulse"] },
		{
			hook: (path) =>
				path === "pictures/mug.png" ? { outcome: "waiting_for_review", reason: "review_required" } : null,
		},
	);
	const parked = await f.call(request());
	expect(answer(parked.content)).toMatchObject({ state: "proposed", outcome: "waiting_for_review" });
	expect(parked.content.image).toBeDefined();
	expect(f.tool.refused?.(parked.content)).toBeUndefined();
	expect(f.notes).toHaveLength(0);
	await f.call(request({ operationKey: "hero-1", path: "QorperaOS/interfaces/pulse/hero.png" }));
	expect(f.notes).toHaveLength(1);
});

it("refuses before making a picture where none could be saved", async () => {
	const f = await fixture({ folders: ["pictures"], links: { "pictures/link.png": "elsewhere.png" } });
	await refuses(f.call(request({ path: "missing/mug.png" })), "COMPANY_FILE_PARENT_MISSING");
	f.folders.add("pictures/shelf.png");
	await refuses(f.call(request({ path: "pictures/shelf.png" })), "COMPANY_FILE_NOT_A_FILE");
	await refuses(f.call(request({ path: "pictures/link.png" })), "COMPANY_FILE_IS_A_LINK");
	f.seed("notes.md", "a file");
	await refuses(f.call(request({ path: "notes.md/mug.png" })), "COMPANY_FILE_PARENT_MISSING");
	expect(f.made).not.toHaveBeenCalled();
	expect(f.commits).toEqual([]);
});

describe("when no picture comes back", () => {
	it.each([
		[
			new CloudPictureFailure("picture_limit", 1763049600),
			`PICTURE_LIMIT_REACHED: the member's ChatGPT has no pictures left for now, until about ${new Date(1763049600 * 1000).toISOString()}; nothing was saved.`,
		],
		[
			new CloudPictureFailure("picture_limit"),
			"PICTURE_LIMIT_REACHED: the member's ChatGPT has no pictures left for now; nothing was saved.",
		],
		[
			new CloudPictureFailure("usage_limit"),
			"USAGE_LIMIT_REACHED: the member's ChatGPT usage limit stopped the picture",
		],
		[
			new CloudPictureFailure("refused"),
			"PICTURE_REFUSED: the picture generator refused this prompt or could not draw it",
		],
		[new CloudPictureFailure("no_picture"), "NO_PICTURE: no picture was made"],
		[new CloudPictureFailure("timeout"), "PICTURE_TIMEOUT: no picture came back within 4 minutes"],
		[new CloudPictureFailure("invalid"), "PICTURE_UNUSABLE"],
		[new CloudPictureFailure("too_large"), "PICTURE_TOO_LARGE: the picture is larger than 12 MiB"],
		[new CloudPictureFailure("busy"), "PICTURE_BUSY"],
		[new CloudPictureFailure("failed"), "PICTURE_FAILED"],
		[new CloudPictureUnavailable(), "PICTURES_UNAVAILABLE: this run's login cannot make pictures"],
	])("refuses with plain words, and saves nothing: %s", async (failure, words) => {
		const f = await fixture({ folders: ["pictures"] }, {}, async () => {
			throw failure;
		});
		await refuses(f.call(request()), words);
		expect(f.commits).toEqual([]);
		expect(f.ledger.size).toBe(0);
	});

	it("refuses with plain words when no lane is attached", async () => {
		const f = await fixture({ folders: ["pictures"] });
		f.pictures.attach(undefined);
		await refuses(f.call(request()), "PICTURES_UNAVAILABLE");
	});

	it.each([
		["not a PNG", Buffer.from("GIF89a, PRIVATE_NOT_A_PICTURE"), "PICTURE_UNUSABLE"],
		[
			"a PNG that does not decode",
			Buffer.concat([picture().subarray(0, 8), Buffer.from("PRIVATE_BROKEN")]),
			"PICTURE_UNUSABLE",
		],
		["over the bound", Buffer.alloc(12 * 1024 * 1024 + 1), "PICTURE_TOO_LARGE"],
	])("refuses a picture that is %s, and saves nothing", async (_what, png, words) => {
		const f = await fixture({ folders: ["pictures"] }, {}, async () => ({ png }));
		await refuses(f.call(request()), words);
		expect(f.commits).toEqual([]);
	});
});

describe("a picture in an app", () => {
	it("goes into its own app as a write does, and into another's app only after the review as delegation", async () => {
		const f = await fixture({ folders: ["apps/mine/pictures", "apps/theirs/pictures"] });
		f.seed(
			"apps/mine/app.toml",
			`name = "Mine"\nowner = "${f.identity.staffAgentId.toLowerCase()}"\nposted = false\n`,
		);
		f.seed("apps/theirs/app.toml", `name = "Theirs"\nowner = "${randomUUID()}"\nposted = false\n`);
		const own = await f.call(request({ path: "apps/mine/pictures/mug.png" }));
		expect(own.prepared).not.toHaveProperty("foreignOwner");
		expect(cloudActionEffect(f.tool, own.prepared)).toBe("internal");
		expect(answer(own.content)).toMatchObject({ state: "applied" });
		const theirs = await f.call(request({ operationKey: "mug-2", path: "apps/theirs/pictures/mug.png" }));
		expect(theirs.prepared).toMatchObject({ foreignOwner: true });
		expect(cloudActionEffect(f.tool, theirs.prepared)).toBe("delegation");
		expect(describeCloudAction(f.tool, theirs.prepared)).toEqual({
			title: "Put a picture into another agent's app",
			target: "apps/theirs/pictures/mug.png",
			details: {
				picture: request().prompt,
				effect: "Members see the picture in that app, which shows it under its maker's name",
			},
		});
		expect(describeCloudAction(f.tool, own.prepared).title).toBe("Make a picture");
		// A picture outside apps/ reads no manifest.
		expect(await f.tool.prepare!(f.tool.parseArguments(request()), f.context)).not.toHaveProperty("foreignOwner");
	});
});
