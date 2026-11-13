import {
	CLOUD_PICTURE_MAKER_RULE,
	CLOUD_PICTURE_MS,
	CloudPictureChannel,
	CloudPictureFailure,
	type CloudPictureMade,
	CloudPictureUnavailable,
	cloudPictureInput,
	isCloudPicturePng,
	MAX_CLOUD_PICTURE_BYTES,
	MAX_CLOUD_PICTURE_PROMPT_BYTES,
} from "@qorpera/runtime/cloud-picture-channel";
import { describe, expect, it, vi } from "vitest";

describe("CloudPictureChannel", () => {
	it("refuses a picture while no run's lane is attached, and after it is detached", async () => {
		const channel = new CloudPictureChannel();
		const signal = new AbortController().signal;
		await expect(channel.make({ prompt: "a red apple" }, signal)).rejects.toBeInstanceOf(CloudPictureUnavailable);
		expect(channel.attached).toBe(false);
		const made: CloudPictureMade = { png: Buffer.from("PNG") };
		const lane = vi.fn(async () => made);
		channel.attach(lane);
		expect(channel.attached).toBe(true);
		await expect(channel.make({ prompt: "a red apple" }, signal)).resolves.toBe(made);
		expect(lane).toHaveBeenCalledWith({ prompt: "a red apple" }, signal);
		channel.attach(undefined);
		await expect(channel.make({ prompt: "a red apple" }, signal)).rejects.toBeInstanceOf(CloudPictureUnavailable);
		expect(lane).toHaveBeenCalledOnce();
		expect(channel.timeoutMs).toBeUndefined();
		expect(new CloudPictureChannel({ timeoutMs: 200 }).timeoutMs).toBe(200);
	});
});

describe("cloudPictureInput", () => {
	it("takes a description of a few paragraphs, line breaks included", () => {
		const prompt = "A ceramic mug on a plain white table,\nseen from the front.\tSoft daylight.";
		expect(cloudPictureInput({ prompt })).toEqual({ prompt });
		const longest = "é".repeat(MAX_CLOUD_PICTURE_PROMPT_BYTES / 2);
		expect(cloudPictureInput({ prompt: longest })).toEqual({ prompt: longest });
	});

	it("refuses one that is empty, too long, not text or holds a control character, without repeating it", () => {
		for (const prompt of [
			"",
			" \n\t",
			"x".repeat(MAX_CLOUD_PICTURE_PROMPT_BYTES + 1),
			"PRIVATE\u0000PROMPT",
			"PRIVATE\u001bPROMPT",
			"PRIVATE\u007fPROMPT",
			"PRIVATE\ud800PROMPT",
			7 as never,
		])
			expect(() => cloudPictureInput({ prompt })).toThrow(/^Invalid picture prompt$/);
	});
});

it("tells the picture's model to make one picture of the description and nothing else", () => {
	expect(CLOUD_PICTURE_MAKER_RULE).toBe(
		"You make pictures and nothing else. Each message is the description of one picture. Call image_gen.imagegen exactly once, with that description as its prompt, word for word, and no other argument. Never answer in words, never ask a question and never use another tool.",
	);
});

it("holds every picture to an app's bound for one picture, and a call to four minutes", () => {
	expect(MAX_CLOUD_PICTURE_BYTES).toBe(12 * 1024 * 1024);
	expect(CLOUD_PICTURE_MS).toBe(240_000);
	expect(isCloudPicturePng(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe(true);
	expect(isCloudPicturePng(Buffer.from("GIF89a"))).toBe(false);
	expect(isCloudPicturePng(Buffer.alloc(0))).toBe(false);
	const failure = new CloudPictureFailure("picture_limit", 1763049600);
	expect([failure.reason, failure.resetsAt, failure.message]).toEqual([
		"picture_limit",
		1763049600,
		"Native picture failed: picture_limit",
	]);
	expect(new CloudPictureFailure("refused")).not.toHaveProperty("resetsAt");
});
