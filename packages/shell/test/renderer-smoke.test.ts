import { describe, expect, it } from "vitest";
import { bitmapLooksBlank } from "../src/renderer-smoke.ts";

describe("renderer visual smoke", () => {
	it("rejects empty and single-color captures", () => {
		expect(bitmapLooksBlank(new Uint8Array())).toBe(true);
		expect(bitmapLooksBlank(new Uint8Array([255, 255, 255, 255, 255, 255, 255, 255]))).toBe(true);
	});

	it("accepts a frame containing visible foreground contrast", () => {
		const bitmap = new Uint8Array(4 * 64);
		bitmap.fill(255);
		bitmap.set([20, 20, 20, 255], 4 * 32);
		expect(bitmapLooksBlank(bitmap)).toBe(false);
	});
});
