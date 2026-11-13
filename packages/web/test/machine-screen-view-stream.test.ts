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
	/** Which canvas each picture went on: the view has two and neither ever writes where the other draws (r6 of #1746). */
	const strokes: { name: string; on: HTMLCanvasElement }[] = [];
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
		return {
			drawImage: (picture: { name: string }, x: number, y: number) => {
				drawn.push([picture.name, x, y]);
				strokes.push({ name: picture.name, on: this });
			},
			clearRect: () => {},
		} as unknown as CanvasRenderingContext2D;
	} as unknown as HTMLCanvasElement["getContext"]);
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
	// Two canvases stand in the stage: the window's own pictures first, the live picture second (review r6 of #1746).
	const [canvas, live] = [...mount.querySelectorAll<HTMLCanvasElement>(".machine-screen-canvas")] as [
		HTMLCanvasElement,
		HTMLCanvasElement,
	];
	canvases.set(screen, canvas);
	/** The names of what was drawn on one of the two canvases, in order. */
	const on = (which: HTMLCanvasElement) => strokes.filter((stroke) => stroke.on === which).map((one) => one.name);
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
	return { screen, area, look, drawn, canvas, live, on, decode, closed };
}

describe("the live picture in the screen view (20260930745000)", () => {
	it("takes the screen's size, then draws the areas of each message at their places, in the order the messages came", async () => {
		const { screen, area, drawn, live } = view();
		let release: () => void = () => {};
		const slow = new Promise<void>((resolve) => {
			release = resolve;
		});
		expect(await screen.stream({ kind: "size", width: 1600, height: 1000 })).toBe("drawn");
		expect([live.width, live.height]).toEqual([1600, 1000]);
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

	it("gives the window's own pictures and the live picture a canvas each: neither ever writes where the other draws (review r6 of #1746)", async () => {
		const { screen, area, look, canvas, live, on } = view();
		// Only the window's own picture: it is the one shown.
		expect(await screen.show(look("first", 100, 100))).toBe(true);
		expect([canvas.hidden, live.hidden]).toEqual([false, true]);
		await screen.stream({ kind: "size", width: 100, height: 100 });
		// A size alone shows nothing of the stream: the window's own picture is still the one up.
		expect([canvas.hidden, live.hidden]).toEqual([false, true]);
		expect(await screen.stream({ kind: "rects", rects: [area("pixels", 0, 0, 10, 10)] })).toBe("drawn");
		// The live picture's own canvas takes its place.
		expect([canvas.hidden, live.hidden]).toEqual([true, false]);
		// A look that arrives while the live picture is up paints its own canvas, out of sight, and touches nothing of
		// the stream: when the stream ends, that look is what the member sees.
		expect(await screen.show(look("meanwhile", 100, 100))).toBe(true);
		expect([canvas.hidden, live.hidden]).toEqual([true, false]);
		screen.streamEnded();
		expect([canvas.hidden, live.hidden]).toEqual([false, true]);
		expect(screen.shown).toBe(true);
		// Each source wrote only on its own canvas, the whole way through.
		expect(on(canvas)).toEqual(["first", "meanwhile"]);
		expect(on(live)).toEqual(["pixels"]);
	});

	it("applies everything of one stream in the order it came, so a resize behind a stalled area is never dropped (review r6 F1 of #1746)", async () => {
		const { screen, area, drawn, live } = view();
		// The picture takes input, so the desktop's own pointer shape shows on it.
		screen.capture({ act: vi.fn() });
		expect(await screen.stream({ kind: "size", width: 100, height: 100 })).toBe("drawn");
		let release: () => void = () => {};
		const stalled = new Promise<void>((resolve) => {
			release = resolve;
		});
		const slow = screen.stream({ kind: "rects", rects: [area("stalled", 0, 0, 100, 100, stalled)] });
		// Behind that stalled area: the screen resizes, a pointer shape comes, and the first pixels of the new size.
		const resized = screen.stream({ kind: "size", width: 50, height: 50 });
		const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" });
		const shape = screen.stream({ kind: "cursor", hotX: 1, hotY: 2, width: 16, height: 16, png });
		const small = screen.stream({ kind: "rects", rects: [area("small", 0, 0, 50, 50)] });
		await Promise.resolve();
		// Nothing of this stream moves past the message before it, however long that one decodes.
		expect(drawn).toEqual([]);
		expect([live.width, live.height]).toEqual([100, 100]);
		expect(live.style.cursor).toBe("");
		release();
		// All four land, in the order they came, and none is dropped for the sake of the order.
		expect(await Promise.all([slow, resized, shape, small])).toEqual(["drawn", "drawn", "drawn", "drawn"]);
		expect(drawn).toEqual([
			["stalled", 0, 0],
			["small", 0, 0],
		]);
		// The resize stands, and the pixels of the new size are on a canvas of that size: no stale pixels, and the
		// member's clicks are counted on what they see.
		expect([live.width, live.height]).toEqual([50, 50]);
		// The cursor message queued behind the stalled area went the same way, in its place.
		expect(live.style.cursor).toMatch(/^url\("data:image\/png;base64,iVBORw=="\) 1 2, default$/);
	});

	it("a picture of the window's own never clears the live picture's size, whichever lands first (review r6 F2 and r5 F2 of #1746)", async () => {
		const { screen, area, look, drawn, canvas, live } = view();
		await screen.stream({ kind: "size", width: 100, height: 100 });
		// The window looks until the live picture shows, so its own picture commits first — and it says so.
		expect(await screen.show(look("fallback", 100, 100))).toBe(true);
		expect(screen.streaming).toBe(false);
		expect([canvas.hidden, live.hidden]).toEqual([false, true]);
		// Then valid streamed pixels of the size the stream told: they draw, and the looking stops.
		expect(await screen.stream({ kind: "rects", rects: [area("pixels", 0, 0, 10, 10)] })).toBe("drawn");
		expect(screen.streaming).toBe(true);
		expect([canvas.hidden, live.hidden]).toEqual([true, false]);
		// And the areas after it still fit that size: no look ever closes a healthy stream.
		expect(await screen.stream({ kind: "rects", rects: [area("more", 90, 90, 10, 10)] })).toBe("drawn");
		expect(await screen.show(look("later", 100, 100))).toBe(true);
		expect(await screen.stream({ kind: "rects", rects: [area("after", 0, 90, 10, 10)] })).toBe("drawn");
		expect(drawn).toEqual([
			["fallback", 0, 0],
			["pixels", 0, 0],
			["more", 90, 90],
			["later", 0, 0],
			["after", 0, 90],
		]);
	});

	it("keeps as tests the two shapes that once broke the painter, which its shape now makes impossible (review r6 of #1746)", async () => {
		// (a) A look while the stream has not shown. The window looks until the live picture is up, so a look lands
		//     between a stream's size and its first pixels every single time: were it to count against that stream, no
		//     stream could ever show.
		{
			const { screen, area, look } = view();
			await screen.stream({ kind: "size", width: 100, height: 100 });
			for (const name of ["look-1", "look-2", "look-3"]) expect(await screen.show(look(name, 100, 100))).toBe(true);
			expect(await screen.stream({ kind: "rects", rects: [area("pixels", 0, 0, 10, 10)] })).toBe("drawn");
			expect(screen.streaming).toBe(true);
		}
		// (b) A stream's own size before its own areas: those areas are of exactly that size and come after it, so the
		//     first picture of every stream depends on the size not counting against them.
		{
			const { screen, area, drawn } = view();
			await screen.stream({ kind: "size", width: 100, height: 100 });
			expect(await screen.stream({ kind: "rects", rects: [area("a", 0, 0, 10, 10)] })).toBe("drawn");
			expect(await screen.stream({ kind: "rects", rects: [area("b", 10, 0, 10, 10)] })).toBe("drawn");
			expect(drawn).toEqual([
				["a", 0, 0],
				["b", 10, 0],
			]);
		}
	});

	it("a renewal while the pixels of the stream before it are up: the window's own picture comes back at once, and nothing of the old stream shows through the new one", async () => {
		const { screen, area, look, drawn, canvas, live } = view();
		expect(await screen.show(look("look", 100, 100))).toBe(true);
		await screen.stream({ kind: "size", width: 100, height: 100 });
		expect(await screen.stream({ kind: "rects", rects: [area("first", 0, 0, 10, 10)] })).toBe("drawn");
		expect([canvas.hidden, live.hidden]).toEqual([true, false]);
		// The pass ran out: that socket ends while its pixels are on the screen.
		screen.streamEnded();
		expect(screen.streaming).toBe(false);
		expect([canvas.hidden, live.hidden]).toEqual([false, true]);
		expect(screen.shown).toBe(true);
		// The new socket sends the same size: it empties its canvas all the same, so not one pixel of the stream before
		// it can show through, and the window keeps its own picture until the new stream's first pixels land.
		const sized = vi.spyOn(HTMLCanvasElement.prototype, "width", "set");
		await screen.stream({ kind: "size", width: 100, height: 100 });
		expect(sized).toHaveBeenCalledWith(100);
		expect([canvas.hidden, live.hidden]).toEqual([false, true]);
		expect(await screen.stream({ kind: "rects", rects: [area("second", 0, 0, 10, 10)] })).toBe("drawn");
		expect([canvas.hidden, live.hidden]).toEqual([true, false]);
		expect(screen.streaming).toBe(true);
		expect(drawn).toEqual([
			["look", 0, 0],
			["first", 0, 0],
			["second", 0, 0],
		]);
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

	it("reaches the safe mode on a real inconsistency only: never on a look, a late decode or a renewal (review r6 of #1746)", async () => {
		const { screen, area, look } = view();
		await screen.stream({ kind: "size", width: 100, height: 100 });
		let release: () => void = () => {};
		const stalled = new Promise<void>((resolve) => {
			release = resolve;
		});
		// A whole screen decoding slowly, a look landing meanwhile, a resize and pixels of the new size behind it.
		const slow = screen.stream({ kind: "rects", rects: [area("slow", 0, 0, 100, 100, stalled)] });
		expect(await screen.show(look("meanwhile", 100, 100))).toBe(true);
		const resized = screen.stream({ kind: "size", width: 50, height: 50 });
		const after = screen.stream({ kind: "rects", rects: [area("after", 0, 0, 50, 50)] });
		release();
		// Not one of them is a failure: the window never ends a stream for anything but pixels that do not agree.
		expect(await Promise.all([slow, resized, after])).toEqual(["drawn", "drawn", "drawn"]);
		// A renewal, with work of the stream before it still unfinished: dropped work, never a failure.
		let late: () => void = () => {};
		const pending = new Promise<void>((resolve) => {
			late = resolve;
		});
		const hanging = screen.stream({ kind: "rects", rects: [area("hanging", 0, 0, 10, 10, pending)] });
		screen.streamEnded();
		late();
		expect(await hanging).toBe("dropped");
		await screen.stream({ kind: "size", width: 50, height: 50 });
		expect(await screen.stream({ kind: "rects", rects: [area("renewed", 0, 0, 10, 10)] })).toBe("drawn");
		// And the inconsistency still ends it: an area outside the size THIS stream told.
		expect(await screen.stream({ kind: "rects", rects: [area("outside", 45, 0, 10, 10)] })).toBe("failed");
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
