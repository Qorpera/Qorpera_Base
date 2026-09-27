// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostedStaffAgent } from "../src/cloud/types.ts";
import { FIGURE_IDS } from "../src/ui/avatar.ts";
import { groupAvatar } from "../src/ui/group-avatar.ts";
import { deferred, id, settle, staff } from "./fixtures.ts";

function imageData(width: number, height: number) {
	return { width, height, data: new Uint8ClampedArray(width * height * 4) } as ImageData;
}
function mockContext() {
	const paints: { source: CanvasImageSource; position: number[]; operation: string }[] = [];
	const text: { value: string; x: number; y: number; color: string }[] = [];
	const context = {
		globalCompositeOperation: "source-over",
		fillStyle: "",
		font: "",
		textAlign: "",
		textBaseline: "",
		paints,
		text,
		drawImage: vi.fn((source: CanvasImageSource, ...position: number[]) => {
			paints.push({ source, position, operation: context.globalCompositeOperation });
		}),
		fillText: vi.fn((value: string, x: number, y: number) => {
			text.push({ value, x, y, color: context.fillStyle });
		}),
		fillRect: vi.fn(),
		getImageData: vi.fn((_x: number, _y: number, width: number, height: number) => {
			const data = imageData(width, height);
			// A single opaque point makes the silhouette's dilation measurable.
			data.data[(Math.floor(height / 2) * width + Math.floor(width / 2)) * 4 + 3] = 255;
			return data;
		}),
		createImageData: vi.fn(imageData),
		putImageData: vi.fn(),
	};
	return context;
}
let contexts: Map<HTMLCanvasElement, ReturnType<typeof mockContext>>;
let resized: ResizeObserverCallback;
const observed = { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
let artwork: { prepare: ReturnType<typeof vi.fn>; drawable: ReturnType<typeof vi.fn> };
let decode: ReturnType<typeof vi.fn<() => Promise<void>>>;

beforeEach(() => {
	contexts = new Map();
	for (const spy of Object.values(observed)) spy.mockClear();
	vi.stubGlobal("devicePixelRatio", 2);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(callback: ResizeObserverCallback) {
				resized = callback;
			}
			observe = observed.observe;
			unobserve = observed.unobserve;
			disconnect = observed.disconnect;
		},
	);
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
		let context = contexts.get(this);
		if (!context) {
			context = mockContext();
			contexts.set(this, context);
		}
		return context as unknown as CanvasRenderingContext2D;
	});
	decode = vi.fn(async () => {});
	HTMLImageElement.prototype.decode = decode;
	artwork = {
		prepare: vi.fn(),
		drawable: vi.fn((figure: string, color: string) => {
			const canvas = document.createElement("canvas");
			canvas.dataset.figure = figure;
			canvas.dataset.color = color;
			return canvas;
		}),
	};
	vi.stubGlobal("QORPERA_AVATAR_APPEARANCE", { ...artwork, palette: [{ color: "#312f2d", name: "Charcoal" }] });
	vi.stubGlobal("QORPERA_MOTION_MODEL", {
		avatars: FIGURE_IDS.map((figure) => ({ id: figure, color: "#fcb51b" })),
		faces: {},
		avatarColor: (_figure: string, _surface: string, color: string) => (color === "#312f2d" ? "#a29d97" : color),
	});
});
afterEach(async () => {
	document.body.replaceChildren();
	delete document.documentElement.dataset.theme;
	await settle();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function agents(count: number) {
	return Array.from({ length: count }, (_, index) => ({
		...staff,
		id: id(100 + index),
		appearance: { ...staff.appearance, creature: FIGURE_IDS[index % FIGURE_IDS.length], color: "#312f2d" },
	}));
}
async function show(count: number, options: Parameters<typeof groupAvatar>[1] = {}) {
	const canvas = groupAvatar(agents(count), options) as HTMLCanvasElement;
	document.body.append(canvas);
	await settle();
	return { canvas, context: contexts.get(canvas)! };
}

describe("approved group avatar compositor", () => {
	it.each([
		{ count: 1, positions: [[4, 0, 88, 88]] },
		{
			count: 2,
			positions: [
				[8, 4, 54, 54],
				[34, 30, 54, 54],
			],
		},
		{
			count: 3,
			positions: [
				[25, 4, 46, 46],
				[10, 34, 46, 46],
				[40, 34, 46, 46],
			],
		},
		{
			count: 4,
			positions: [
				[11, 6, 46, 46],
				[41, 6, 46, 46],
				[11, 36, 46, 46],
				[41, 36, 46, 46],
			],
		},
	])("uses approved layout coordinates for $count agents", async ({ count, positions }) => {
		const { canvas, context } = await show(count);
		expect([canvas.width, canvas.height]).toEqual([96, 88]);
		expect(
			context.paints.filter((paint) => paint.operation === "source-over").map((paint) => paint.position),
		).toEqual(positions);
		expect(artwork.prepare).toHaveBeenCalledTimes(count);
		for (const [, image] of artwork.prepare.mock.calls) expect(image.src).toContain("/assets/avatars/status-2d-v1/");
		expect(canvas.getAttribute("aria-hidden")).toBe("true");
	});

	it("erases a dilated figure silhouette rather than painting a background circle", async () => {
		const { context } = await show(2);
		expect(context.paints.map((paint) => paint.operation)).toEqual(["source-over", "destination-out", "source-over"]);
		expect(context.fillRect).not.toHaveBeenCalled();
		const mask = context.paints[1]!.source as HTMLCanvasElement;
		const pixels = contexts.get(mask)!.putImageData.mock.calls[0]![0] as ImageData;
		const cx = Math.floor(pixels.width / 2),
			cy = Math.floor(pixels.height / 2);
		const alpha = (x: number, y: number) => pixels.data[(y * pixels.width + x) * 4 + 3];
		expect(alpha(cx, cy)).toBe(255);
		expect(alpha(cx + 2, cy)).toBe(255);
		expect(alpha(cx + 2, cy + 2)).toBe(0);
		expect(alpha(0, 0)).toBe(0);
	});

	it("shows only three actual agents and the remainder count for a larger group", async () => {
		const { context } = await show(7);
		const figures = context.paints.filter((paint) => paint.operation === "source-over");
		expect(figures).toHaveLength(3);
		expect(figures.map((paint) => (paint.source as HTMLCanvasElement).dataset.figure)).toEqual([
			"planet",
			"acorn",
			"flame",
		]);
		expect(context.text).toEqual([{ value: "+4", x: 65, y: 61.4, color: "#686864" }]);
		expect(artwork.prepare).toHaveBeenCalledTimes(3);
	});

	it("repaints saved colors and count text for dark and selected surfaces", async () => {
		const plain = await show(5);
		expect(artwork.drawable).toHaveBeenCalledWith("planet", "#312f2d");
		document.documentElement.dataset.theme = "dark";
		await settle();
		expect(artwork.drawable).toHaveBeenCalledWith("planet", "#a29d97");
		expect(plain.context.text.at(-1)?.color).toBe("#c5c5c0");
		const selected = await show(5, { selected: true });
		expect(selected.context.text.at(-1)?.color).toBe("#ffffff");
	});

	it("draws a seeded Co-Founder in its native artwork color and a chosen color once picked", async () => {
		const chosen = { ...agents(1)[0]!, templateId: "co-founder" };
		const seeded = { ...chosen, appearance: { ...chosen.appearance, color: "qorpera-blue" } };
		const drawn = async (subject: HostedStaffAgent) => {
			artwork.drawable.mockClear();
			document.body.append(groupAvatar([subject]));
			await settle();
			return new Set(artwork.drawable.mock.calls.map(([figure, color]) => `${figure} ${color}`));
		};
		expect(await drawn(seeded)).toEqual(new Set(["planet #fcb51b"]));
		expect(await drawn(chosen)).toEqual(new Set(["planet #312f2d"]));
	});

	it("scales its bitmap and layout to the actual responsive size", async () => {
		const { canvas, context } = await show(2);
		vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ width: 96, height: 88 } as DOMRect);
		resized(
			[
				{
					target: canvas,
					contentRect: canvas.getBoundingClientRect(),
					borderBoxSize: [],
					contentBoxSize: [],
					devicePixelContentBoxSize: [],
				},
			],
			{} as ResizeObserver,
		);
		expect([canvas.width, canvas.height]).toEqual([192, 176]);
		expect(context.paints.at(-1)?.position).toEqual([68, 60, 108, 108]);
	});

	it("leaves unknown membership transparent without a generic chat icon", async () => {
		const { canvas } = await show(0);
		expect(canvas.className).toBe("group-chat-avatar");
		expect(canvas.children).toHaveLength(0);
		expect(artwork.prepare).not.toHaveBeenCalled();
		expect(observed.observe).not.toHaveBeenCalled();
	});

	it("stops observing removed clusters and ignores artwork that arrives after removal", async () => {
		const pending = deferred<void>();
		decode.mockReturnValue(pending.promise);
		const canvas = groupAvatar(agents(2)) as HTMLCanvasElement;
		document.body.append(canvas);
		await settle();
		canvas.remove();
		await settle();
		expect(observed.unobserve).toHaveBeenCalledWith(canvas);
		expect(observed.disconnect).toHaveBeenCalled();
		pending.resolve();
		await settle();
		expect(contexts.has(canvas)).toBe(false);
	});
});
