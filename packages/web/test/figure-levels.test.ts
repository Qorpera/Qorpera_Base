// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bucketOf, level, reduce } from "../src/ui/figure-levels.ts";

interface Draw {
	target: HTMLCanvasElement;
	source: CanvasImageSource;
	size: number[];
}
let draws: Draw[];
let clears: HTMLCanvasElement[];

beforeEach(() => {
	draws = [];
	clears = [];
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
		return {
			imageSmoothingQuality: "low",
			clearRect: () => clears.push(this),
			drawImage: (source: CanvasImageSource, ...size: number[]) => draws.push({ target: this, source, size }),
		} as unknown as CanvasRenderingContext2D;
	});
});
afterEach(() => vi.restoreAllMocks());

function surface(): HTMLCanvasElement {
	const canvas = document.createElement("canvas");
	canvas.width = canvas.height = 512;
	return canvas;
}

/** Every draw is an exact 2:1 step: each target is half its source. */
function expectHalvings(from: CanvasImageSource, to: number): void {
	let source = from,
		size = 512;
	for (const draw of draws) {
		size /= 2;
		expect(draw.source).toBe(source);
		expect([draw.target.width, draw.target.height]).toEqual([size, size]);
		expect(draw.size).toEqual([0, 0, size, size]);
		source = draw.target;
	}
	expect(size).toBe(to);
}

describe("figure levels", () => {
	it("picks the power of two at or above the painted side, from 32 to 512", () => {
		expect([10, 32, 36, 120, 128, 250, 600].map(bucketOf)).toEqual([32, 32, 64, 128, 128, 256, 512]);
	});

	it("halves a fixed surface to its level in exact 2:1 steps, once per size", () => {
		const image = surface();
		const scaled = level("crown#fcb51b:body", image, 64) as HTMLCanvasElement;
		expect(scaled.width).toBe(64);
		expectHalvings(image, 64);
		draws = [];
		expect(level("crown#fcb51b:body", image, 64)).toBe(scaled);
		expect(draws).toEqual([]);
		expect(level("crown#fcb51b:body", image, 512)).toBe(image);
	});

	it("halves a surface drawn each frame through the same canvases, cleared first", () => {
		const eyes = surface();
		const first = reduce(eyes, 32) as HTMLCanvasElement;
		expect(first.width).toBe(32);
		expectHalvings(eyes, 32);
		const steps = draws.map((draw) => draw.target);
		expect(clears).toEqual(steps);
		draws = [];
		expect(reduce(eyes, 32)).toBe(first);
		expect(draws.map((draw) => draw.target)).toEqual(steps);
		expect(reduce(eyes, 512)).toBe(eyes);
	});
});
