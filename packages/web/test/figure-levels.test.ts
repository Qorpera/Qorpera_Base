// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alignRegion, boxCanvas, bucketOf, level, reduce } from "../src/ui/figure-levels.ts";

interface Draw {
	target: HTMLCanvasElement;
	source: CanvasImageSource;
	size: number[];
	quality: ImageSmoothingQuality;
}
let draws: Draw[];
let clears: HTMLCanvasElement[];

beforeEach(() => {
	draws = [];
	clears = [];
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
		const context = {
			imageSmoothingQuality: "medium" as ImageSmoothingQuality,
			clearRect: () => clears.push(this),
			setTransform: () => {},
			drawImage: (source: CanvasImageSource, ...size: number[]) =>
				draws.push({ target: this, source, size, quality: context.imageSmoothingQuality }),
		};
		return context as unknown as CanvasRenderingContext2D;
	});
});
afterEach(() => vi.restoreAllMocks());

function surface(): HTMLCanvasElement {
	const canvas = document.createElement("canvas");
	canvas.width = canvas.height = 512;
	return canvas;
}

/** Every draw is an exact 2:1 step: each target is half its source, sampled plainly
 * (bilinear at 2:1 is the 2x2 average; "high" costs more for nothing). */
function expectHalvings(from: CanvasImageSource, to: number): void {
	let source = from,
		size = 512;
	for (const draw of draws) {
		size /= 2;
		expect(draw.source).toBe(source);
		expect([draw.target.width, draw.target.height]).toEqual([size, size]);
		expect(draw.size).toEqual([0, 0, size, size]);
		expect(draw.quality).toBe("low");
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

	it("aligns a box outward, a pixel to spare, to whole pixels at a level", () => {
		expect(alignRegion([153.6, 204.8, 358.4, 307.2], 128)).toEqual([152, 200, 360, 312]);
		expect(alignRegion([0.5, 0, 511.5, 512], 256)).toEqual([0, 0, 512, 512]);
	});

	it("keeps one box canvas per level for its owner, clears it whole, and replaces rather than resizes it", () => {
		const boxes = new Map<number, HTMLCanvasElement>();
		const first = boxCanvas(boxes, 512, 100, 40);
		expect([first.width, first.height]).toEqual([128, 64]);
		expect(boxCanvas(boxes, 512, 90, 50)).toBe(first);
		expect(clears).toEqual([first]);
		// A larger box gets a new canvas: the old one may still be drawn from.
		const grown = boxCanvas(boxes, 512, 140, 50);
		expect(grown).not.toBe(first);
		expect([first.width, first.height, grown.width, grown.height]).toEqual([128, 64, 160, 64]);
		expect(boxCanvas(boxes, 256, 300, 300).width).toBe(256);
		expect(boxCanvas(new Map(), 512, 10, 10)).not.toBe(first);
	});
});
