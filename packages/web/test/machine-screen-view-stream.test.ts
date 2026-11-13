// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { MachineStreamRect } from "../src/cloud/machine-stream.ts";
import { MachineScreenView } from "../src/ui/machine-screen-view.ts";

/* The desktop's live picture drawn (20260930745000): the size, the changed areas in order at their places, the pointer's
 * shape over the picture while it takes input. Nothing is drawn after the picture was cleared. */

afterEach(() => {
	vi.restoreAllMocks();
	document.body.replaceChildren();
});

function view() {
	const drawn: [string, number, number][] = [];
	const context = {
		drawImage: (picture: { name: string }, x: number, y: number) => drawn.push([picture.name, x, y]),
		clearRect: () => {},
	};
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
	/** Each area's PNG stands for a picture of its own size; `slow` ones decode only when let go. */
	const pictures = new Map<Blob, { name: string; width: number; height: number; close(): void }>();
	const gates = new Map<Blob, Promise<void>>();
	const decode = vi.fn(async (png: Blob) => {
		await gates.get(png);
		const picture = pictures.get(png);
		if (!picture) throw new Error("not a picture");
		return picture as unknown as ImageBitmap;
	});
	const mount = document.createElement("div");
	document.body.append(mount);
	const screen = new MachineScreenView({ mount, title: "Ada · Computer", onExpandedChange: () => {}, decode });
	const area = (name: string, x: number, y: number, width: number, height: number, gate?: Promise<void>) => {
		const png = new Blob([name], { type: "image/png" });
		pictures.set(png, { name, width, height, close: vi.fn() });
		if (gate) gates.set(png, gate);
		return { x, y, width, height, png } satisfies MachineStreamRect;
	};
	const canvas = mount.querySelector<HTMLCanvasElement>(".machine-screen-canvas")!;
	return { screen, area, drawn, canvas };
}

describe("the live picture in the screen view (20260930745000)", () => {
	it("takes the screen's size, then draws the areas of each message at their places, in the order the messages came", async () => {
		const { screen, area, drawn, canvas } = view();
		let release: () => void = () => {};
		const slow = new Promise<void>((resolve) => {
			release = resolve;
		});
		expect(await screen.stream({ kind: "size", width: 1600, height: 1000 })).toBe(true);
		expect([canvas.width, canvas.height]).toEqual([1600, 1000]);
		// The first message's area decodes late: the second message still draws after it.
		const first = screen.stream({ kind: "rects", rects: [area("whole", 0, 0, 1600, 1000, slow)] });
		const second = screen.stream({ kind: "rects", rects: [area("a", 10, 20, 30, 40), area("b", 100, 200, 5, 5)] });
		await Promise.resolve();
		expect(drawn).toEqual([]);
		release();
		expect(await Promise.all([first, second])).toEqual([true, true]);
		expect(drawn).toEqual([
			["whole", 0, 0],
			["a", 10, 20],
			["b", 100, 200],
		]);
		expect(screen.shown).toBe(true);
	});

	it("draws nothing of a message with an area that does not decode or does not fit, and nothing after a clear", async () => {
		const { screen, area, drawn } = view();
		await screen.stream({ kind: "size", width: 100, height: 100 });
		expect(
			await screen.stream({ kind: "rects", rects: [area("fits", 0, 0, 10, 10), area("off", 95, 0, 10, 10)] }),
		).toBe(false);
		const wrong = area("wrong", 0, 0, 10, 10);
		wrong.png = new Blob(["unknown"]);
		expect(await screen.stream({ kind: "rects", rects: [wrong] })).toBe(false);
		expect(drawn).toEqual([]);
		let release: () => void = () => {};
		const slow = new Promise<void>((resolve) => {
			release = resolve;
		});
		const late = screen.stream({ kind: "rects", rects: [area("late", 0, 0, 10, 10, slow)] });
		screen.clear();
		release();
		expect(await late).toBe(false);
		expect(drawn).toEqual([]);
		expect(screen.shown).toBe(false);
	});

	it("shows the desktop's pointer shape over the picture only while the picture takes input, and drops it when the stream ends", async () => {
		const { screen, canvas } = view();
		const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" });
		await screen.stream({ kind: "cursor", hotX: 3, hotY: 4, width: 16, height: 16, png });
		expect(canvas.style.cursor).toBe("");
		screen.capture({ act: vi.fn() });
		expect(canvas.style.cursor).toMatch(/^url\("data:image\/png;base64,iVBORw=="\) 3 4, default$/);
		screen.capture(null);
		expect(canvas.style.cursor).toBe("");
		screen.capture({ act: vi.fn() });
		screen.streamEnded();
		expect(canvas.style.cursor).toBe("");
	});
});
