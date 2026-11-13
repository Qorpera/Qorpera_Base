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

/** Each view's canvas, for the tests that read it after the view was handed around. */
const canvases = new WeakMap<MachineScreenView, HTMLCanvasElement>();
const canvasOf = (screen: MachineScreenView) => canvases.get(screen) as HTMLCanvasElement;

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
	canvases.set(screen, canvas);
	/** A picture of the window's own looks, with its own gate (for the ordering tests). */
	const look = (name: string, width = 100, height = 100, gate?: Promise<void>) => {
		const png = new Blob([name], { type: "image/png" });
		pictures.set(png, { name, width, height, close: vi.fn() });
		if (gate) gates.set(png, gate);
		return png;
	};
	/** How many of what was decoded is closed, and how many decodes were begun. */
	const closed = (name: string) =>
		[...pictures.values()]
			.filter((picture) => picture.name === name)
			.flatMap((picture) => (picture.close as unknown as { mock: { calls: unknown[] } }).mock.calls).length;
	return { screen, area, look, drawn, canvas, decode, closed };
}

describe("the live picture in the screen view (20260930745000)", () => {
	it("takes the screen's size, then draws the areas of each message at their places, in the order the messages came", async () => {
		const { screen, area, drawn, canvas } = view();
		let release: () => void = () => {};
		const slow = new Promise<void>((resolve) => {
			release = resolve;
		});
		expect(await screen.stream({ kind: "size", width: 1600, height: 1000 })).toBe("drawn");
		expect([canvas.width, canvas.height]).toEqual([1600, 1000]);
		// The first message's area decodes late: the second message still draws after it.
		const first = screen.stream({ kind: "rects", rects: [area("whole", 0, 0, 1600, 1000, slow)] });
		const second = screen.stream({ kind: "rects", rects: [area("a", 10, 20, 30, 40), area("b", 100, 200, 5, 5)] });
		await Promise.resolve();
		expect(drawn).toEqual([]);
		release();
		expect(await Promise.all([first, second])).toEqual(["drawn", "drawn"]);
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
		).toBe("failed");
		const wrong = area("wrong", 0, 0, 10, 10);
		wrong.png = new Blob(["unknown"]);
		expect(await screen.stream({ kind: "rects", rects: [wrong] })).toBe("failed");
		expect(drawn).toEqual([]);
		let release: () => void = () => {};
		const slow = new Promise<void>((resolve) => {
			release = resolve;
		});
		const late = screen.stream({ kind: "rects", rects: [area("late", 0, 0, 10, 10, slow)] });
		screen.clear();
		release();
		// Cleared while it decoded: discarded work, not a failure (review r2 F4 of #1746).
		expect(await late).toBe("dropped");
		expect(drawn).toEqual([]);
		expect(screen.shown).toBe(false);
	});

	it("draws nothing of a stream that ended, however late its areas decode (review r1 F4 of #1746)", async () => {
		const { screen, area, drawn } = view();
		await screen.stream({ kind: "size", width: 100, height: 100 });
		let release: () => void = () => {};
		const slow = new Promise<void>((resolve) => {
			release = resolve;
		});
		const late = screen.stream({ kind: "rects", rects: [area("late", 0, 0, 10, 10, slow)] });
		// The socket closes while that area is still decoding, and the window's next look paints the screen as it is.
		screen.streamEnded();
		expect(await screen.show(new Blob(["look"], { type: "image/png" }))).toBe(false);
		release();
		expect(await late).toBe("dropped");
		expect(drawn).toEqual([]);
		// A pointer shape still being read when it ended paints nothing either.
		const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" });
		screen.capture({ act: vi.fn() });
		const shape = screen.stream({ kind: "cursor", hotX: 1, hotY: 1, width: 16, height: 16, png });
		screen.streamEnded();
		expect(await shape).toBe("dropped");
		expect(canvasOf(screen).style.cursor).toBe("");
	});

	it("a draw discarded at a renewal is not a failure: the window keeps the stream that replaced it (review r2 F4 of #1746)", async () => {
		const { screen, area, drawn } = view();
		await screen.stream({ kind: "size", width: 100, height: 100 });
		let release: () => void = () => {};
		const slow = new Promise<void>((resolve) => {
			release = resolve;
		});
		const pending = screen.stream({ kind: "rects", rects: [area("before", 0, 0, 10, 10, slow)] });
		// The pass ran out: that socket ended and the window opened another on the new pass, which draws at once.
		screen.streamEnded();
		await screen.stream({ kind: "size", width: 100, height: 100 });
		expect(await screen.stream({ kind: "rects", rects: [area("after", 20, 20, 10, 10)] })).toBe("drawn");
		release();
		// The old area finishing now is dropped, never "failed", so the window does not end the new socket.
		expect(await pending).toBe("dropped");
		expect(drawn).toEqual([["after", 20, 20]]);
	});

	it("holds a bounded amount while it decodes, and overflows rather than piling up behind a stalled decoder (review r3 F1 of #1746)", async () => {
		const { screen, area, drawn } = view();
		await screen.stream({ kind: "size", width: 1600, height: 1000 });
		// A decoder that never answers: the first message's areas are stuck.
		let release: () => void = () => {};
		const stuck = new Promise<void>((resolve) => {
			release = resolve;
		});
		const flood: Promise<unknown>[] = [];
		// A whole screen's worth of areas, then message after message of them, as a stalled page would see.
		for (let n = 0; n < 40; n++)
			flood.push(screen.stream({ kind: "rects", rects: [area(`late-${n}`, 0, n * 20, 1600, 20, stuck)] }));
		const answers = await Promise.all(
			flood.slice(0, 16).map((one) => Promise.race([one, Promise.resolve("pending")])),
		);
		// What the page holds while they decode is bounded in messages, bytes, pixels and decodes at once.
		const held = screen.pending;
		expect(held.messages).toBeLessThanOrEqual(16);
		expect(held.bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
		expect(held.pixels).toBeLessThanOrEqual(16 * 1000 * 1000);
		expect(held.decoding).toBeLessThanOrEqual(8);
		// Past the bound, a message is refused outright and the window ends the stream (its looks come back).
		expect(await flood[39]).toBe("overflow");
		expect(answers.every((one) => one === "pending")).toBe(true);
		expect(drawn).toEqual([]);
		// A renewal: the backlog is let go on its own as each decode lands, not kept behind the chain.
		screen.streamEnded();
		release();
		await Promise.all(flood);
		expect(screen.pending).toEqual({ messages: 0, bytes: 0, pixels: 0, decoding: 0 });
		// And the stream that replaced it draws at once, after its own size (the safe mode takes no pixels before one).
		await screen.stream({ kind: "size", width: 1600, height: 1000 });
		expect(await screen.stream({ kind: "rects", rects: [area("after", 0, 0, 10, 10)] })).toBe("drawn");
		expect(drawn).toEqual([["after", 0, 0]]);
	});

	it("a replacement stream waits for nothing of the one it replaced, even with every decoding turn of it still stalled (review r4 F1 of #1746)", async () => {
		const { screen, area, drawn } = view();
		await screen.stream({ kind: "size", width: 1600, height: 1000 });
		// Eight areas of the old stream are stuck in its decoder: every turn it has is taken, for ever.
		const stuck = new Promise<void>(() => {});
		const old: Promise<unknown>[] = [];
		for (let n = 0; n < 8; n++)
			old.push(screen.stream({ kind: "rects", rects: [area(`old-${n}`, 0, n * 20, 100, 20, stuck)] }));
		await Promise.resolve();
		expect(screen.pending.decoding).toBe(8);
		// The pass ran out and the window opened another socket. Nothing of the old stream is released, ever.
		screen.streamEnded();
		expect(screen.pending).toEqual({ messages: 0, bytes: 0, pixels: 0, decoding: 0 });
		// The replacement draws at once, with its own turns, and the old work is still stalled.
		await screen.stream({ kind: "size", width: 1600, height: 1000 });
		expect(await screen.stream({ kind: "rects", rects: [area("new", 0, 0, 10, 10)] })).toBe("drawn");
		expect(drawn).toEqual([["new", 0, 0]]);
		expect(screen.streaming).toBe(true);
		// The stalled ones never resolve; nothing of them is counted against the replacement.
		expect(await Promise.race([Promise.all(old), Promise.resolve("still stuck")])).toBe("still stuck");
		expect(screen.pending.decoding).toBeLessThanOrEqual(1);
	});

	it("says it shows the live picture only once pixels of it are drawn, so the member keeps a picture through a renewal that draws nothing (review r4 F1 of #1746)", async () => {
		const { screen, area } = view();
		// A look is up: the member has a picture.
		expect(await screen.show(new Blob(["look"], { type: "image/png" }))).toBe(false);
		await screen.stream({ kind: "size", width: 100, height: 100 });
		// A size alone is not showing: the window keeps looking.
		expect(screen.streaming).toBe(false);
		const stuck = new Promise<void>(() => {});
		void screen.stream({ kind: "rects", rects: [area("never", 0, 0, 10, 10, stuck)] });
		await Promise.resolve();
		expect(screen.streaming).toBe(false);
		// The socket is replaced and the new one also sends only a size: still not showing.
		screen.streamEnded();
		await screen.stream({ kind: "size", width: 100, height: 100 });
		expect(screen.streaming).toBe(false);
		// Only pixels make it showing.
		expect(await screen.stream({ kind: "rects", rects: [area("pixels", 0, 0, 10, 10)] })).toBe("drawn");
		expect(screen.streaming).toBe(true);
	});

	it("starts no decode for work a dropped stream can no longer land, and closes what it had already decoded (review r5 F1 of #1746)", async () => {
		const { screen, area, decode, closed } = view();
		await screen.stream({ kind: "size", width: 1600, height: 1000 });
		const stuck = new Promise<void>(() => {});
		const waiting: Promise<unknown>[] = [];
		// Six areas stall, so two decoding turns are left of this stream's eight.
		for (let n = 0; n < 6; n++)
			waiting.push(screen.stream({ kind: "rects", rects: [area(`stuck-${n}`, 0, n * 20, 100, 20, stuck)] }));
		// One message of two areas: one decodes at once, its sibling never does.
		let release = () => {};
		const ready = new Promise<void>((resolve) => {
			release = resolve;
		});
		waiting.push(
			screen.stream({
				kind: "rects",
				rects: [area("done", 0, 0, 10, 10, ready), area("never", 20, 0, 10, 10, stuck)],
			}),
		);
		// And one more message, which can get no turn while those eight are held.
		waiting.push(screen.stream({ kind: "rects", rects: [area("queued", 0, 0, 10, 10)] }));
		await vi.waitFor(() => expect(decode.mock.calls.length).toBe(8));
		release();
		await vi.waitFor(() => expect(closed("done")).toBe(0));
		// The stream is dropped while all that is in flight.
		screen.streamEnded();
		await vi.waitFor(() => expect(closed("done")).toBe(1));
		// Nothing more was decoded: the waiter was let go and then skipped its decode, never started it.
		expect(decode.mock.calls.length).toBe(8);
		// The stalled ones stay stalled to the end.
		expect(await Promise.race([Promise.all(waiting), Promise.resolve("still stuck")])).toBe("still stuck");
	});

	it("never lets the window's own picture land over streamed pixels that were drawn after it was asked for (review r5 F2 of #1746)", async () => {
		const { screen, area, look, drawn, closed } = view();
		await screen.stream({ kind: "size", width: 100, height: 100 });
		// A streamed area is on its way; the window asks for one of its own pictures while it decodes.
		let releaseArea = () => {};
		const areaReady = new Promise<void>((resolve) => {
			releaseArea = resolve;
		});
		let releaseLook = () => {};
		const lookReady = new Promise<void>((resolve) => {
			releaseLook = resolve;
		});
		const streamed = screen.stream({ kind: "rects", rects: [area("streamed", 0, 0, 10, 10, areaReady)] });
		const shown = screen.show(look("fallback", 100, 100, lookReady));
		// The streamed area draws first; the window's picture finishes afterwards.
		releaseArea();
		expect(await streamed).toBe("drawn");
		expect(drawn).toEqual([["streamed", 0, 0]]);
		releaseLook();
		// It is dropped at its commit, since newer pixels are on the canvas, and its bitmap is closed.
		expect(await shown).toBe(false);
		expect(drawn).toEqual([["streamed", 0, 0]]);
		await vi.waitFor(() => expect(closed("fallback")).toBe(1));
		// The other way round, a picture asked for after the stream's pixels does land.
		const after = await screen.show(look("later", 100, 100));
		expect(after).toBe(true);
		expect(drawn.at(-1)).toEqual(["later", 0, 0]);
	});

	it("fails to the safe mode: an area outside the size the stream told is never painted (review r5 of #1746)", async () => {
		const { screen, area, drawn } = view();
		// Pixels before any size: refused.
		expect(await screen.stream({ kind: "rects", rects: [area("early", 0, 0, 10, 10)] })).toBe("failed");
		await screen.stream({ kind: "size", width: 100, height: 100 });
		expect(await screen.stream({ kind: "rects", rects: [area("fits", 0, 0, 10, 10)] })).toBe("drawn");
		// An area outside that size, and a picture of another size than its area: both end the stream.
		expect(await screen.stream({ kind: "rects", rects: [area("outside", 95, 0, 10, 10)] })).toBe("failed");
		const wrong = area("wrong", 0, 0, 10, 10);
		(wrong as { width: number }).width = 20;
		expect(await screen.stream({ kind: "rects", rects: [wrong] })).toBe("failed");
		expect(drawn).toEqual([["fits", 0, 0]]);
	});

	it("shows the desktop's pointer shape over the picture only while the picture takes input, and drops it when the stream ends", async () => {
		const { screen, canvas } = view();
		const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" });
		expect(await screen.stream({ kind: "cursor", hotX: 3, hotY: 4, width: 16, height: 16, png })).toBe("drawn");
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
