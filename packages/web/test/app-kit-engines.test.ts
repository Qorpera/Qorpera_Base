// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

/* The data kits' engines (packages/runtime/kits/<kit>/engine.js; RUNTIME-INTERFACE-APPS.md §3b),
 * run in a DOM. save_app writes an engine into an app's folder and the web hands it to the app's frame knowing nothing
 * of it, so it is tested here, where there is a DOM: each engine is driven through a stand-in for the page's bridge,
 * `window.qorpera` (reads that fail and then work, questions that come later, the rows a Save asks for), with the ten
 * seconds of the bridge's pace on a fake clock, and a page that changes size. What they draw is looked at in a browser. */

const KITS = ["model", "board", "path", "object", "curve", "stack", "shelf", "map", "ring", "flow"] as const;
type Kit = (typeof KITS)[number];
/** The kits where a member opens a thing, with a note to the app's owner at its foot. */
const THING_KITS = ["model", "board", "path", "object", "shelf"] as const;
type ThingKit = (typeof THING_KITS)[number];
// From the web package's own folder, where its tests run.
const kitFile = (kit: Kit, name: string) => readFileSync(resolve(`../runtime/kits/${kit}/${name}`), "utf8");
/** A kit's guide example: the data in its KIT.md, as an agent reads it. */
const example = (kit: Kit) => /```json\n([\s\S]*?)\n```/.exec(kitFile(kit, "KIT.md"))?.[1] ?? "";
/** The page's title as the data gives it: a map's is its first layer's. */
const titleOf = (text: string) => {
	const data = JSON.parse(text) as { title?: string; top?: { title?: string } };
	return data.title ?? data.top?.title;
};

interface Question {
	readonly id: string;
	readonly agent: string;
	readonly title: string;
	readonly body: string;
	readonly options: readonly { readonly label: string; readonly value: string; readonly description: string }[];
	readonly multiSelect: boolean;
}

const page = window as unknown as Record<string, unknown>;

/** The page's bridge as a test sets it: the data file's text, or why a read of it fails, and the open questions, or
 * why they cannot be read, after `slow` milliseconds. */
function standIn(file: string | Error) {
	const now = { file, questions: [] as Question[] | Error, slow: 0 };
	const notices: (() => void)[] = [];
	const qorpera = {
		read: vi.fn(async (_path: string) => {
			if (now.file instanceof Error) throw now.file;
			return now.file;
		}),
		questions: vi.fn(async () => {
			if (now.slow) await new Promise((done) => setTimeout(done, now.slow));
			if (now.questions instanceof Error) throw now.questions;
			return now.questions;
		}),
		answer: vi.fn(async (_id: string, _value: unknown) => undefined),
		setRow: vi.fn(async (_table: string, _key: unknown, _cells: Record<string, unknown>) => undefined),
		addRow: vi.fn(async (_table: string, _cells: Record<string, unknown>) => undefined),
		onChange: vi.fn((notice: () => void) => {
			notices.push(notice);
		}),
	};
	// The company folder changed: the bridge tells the page.
	const change = () => {
		for (const notice of notices) notice();
	};
	return { qorpera, now, change };
}

/** The script a kit's page runs before its engine (packages/runtime/src/cloud-app-kits.ts `kitPage`): the stand-in
 * bridge for outside Qorpera, then the live values from the company's databases. Read from the runtime's source, where
 * the page's text is tested. */
const kitsSource = readFileSync(resolve("../runtime/src/cloud-app-kits.ts"), "utf8");
const constant = (name: string) =>
	new Function(
		`return ${new RegExp(`const ${name} =\\s*([\\s\\S]*?);\\n\\n`).exec(kitsSource)?.[1] ?? '""'}`,
	)() as string;
const PAGE_SCRIPT = constant("KIT_OUTSIDE_QORPERA") + constant("KIT_LIVE_VALUES");

type Row = Record<string, number>;
/** A company's databases as the bridge gives them to a page: each question's answer, given to a watch at once and
 * again when it changed. `fail` is an ask that failed, as the bridge hands it on. */
function databases(answers: Record<string, Row>) {
	const now = new Map(Object.entries(answers));
	const watches: { name: string; listener: (answer: unknown) => void }[] = [];
	const answer = (row: Row) => ({ columns: Object.keys(row), rows: [row], more: false, asOf: "2026-11-13T12:00:00Z" });
	const watch = vi.fn((name: string, _params: Record<string, unknown>, listener: (answer: unknown) => void) => {
		watches.push({ name, listener });
		const row = now.get(name);
		if (row) queueMicrotask(() => listener(answer(row)));
		return () => undefined;
	});
	const tell = (name: string, given: unknown) => {
		for (const one of watches) if (one.name === name) one.listener(given);
	};
	return {
		watch,
		set: (name: string, row: Row) => {
			now.set(name, row);
			tell(name, answer(row));
		},
		fail: (name: string) => tell(name, { error: "The database is busy." }),
	};
}

/** Lets what is due run: the page's reads, and its timers up to `ms` from now. */
const settle = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

/** An app of the kit opened on a stand-in, as the frame opens it: the page's QORPERA_KIT, then the engine. A web with
 * a note to the app's owner gives the page's `qorpera` a `tell`; an older one has none. */
async function open(
	kit: Kit,
	file: string | Error,
	before?: (now: ReturnType<typeof standIn>["now"]) => void,
	tell?: Mock,
	concept = false,
) {
	const bridge = standIn(file);
	before?.(bridge.now);
	page.QORPERA_KIT = { app: "demo", kit, data: `${kit}.json`, ...(concept ? { concept: true } : {}) };
	page.qorpera = tell ? { ...bridge.qorpera, tell } : bridge.qorpera;
	new Function(kitFile(kit, "engine.js"))();
	await settle();
	return bridge;
}

/** An app of the kit whose data holds live values, opened as the frame opens its page: the page's QORPERA_KIT and its
 * own script, then the engine. With `db` the bridge watches the company's databases; with none it is an older web app's
 * bridge, with no watch; `outside` opens the page with no bridge at all, as an agent does on a machine. */
async function openLive(kit: Kit, data: object, db?: ReturnType<typeof databases> | "outside") {
	const bridge = standIn(JSON.stringify(data));
	page.QORPERA_KIT = { app: "demo", kit, data: `${kit}.json` };
	if (db === "outside") {
		const saved = document.createElement("script");
		saved.type = "application/json";
		saved.id = "kit-data";
		saved.textContent = JSON.stringify(data);
		document.body.append(saved);
	} else page.qorpera = db ? { ...bridge.qorpera, watch: db.watch } : bridge.qorpera;
	new Function(PAGE_SCRIPT)();
	new Function(kitFile(kit, "engine.js"))();
	await settle();
	return bridge;
}

/** Where a page has no watch: outside Qorpera, and in an older web app. */
const WITHOUT_WATCH = [
	["outside Qorpera", "outside"],
	["in a web app with no watch", undefined],
] as const;

// jsdom draws no frames: an engine's are kept here and drawn by hand.
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
function drawFrames(count = 1) {
	for (let n = 0; n < count; n++) {
		const due = [...frames.values()];
		frames.clear();
		for (const frame of due) frame(performance.now());
	}
}

// jsdom lays nothing out: every box is as wide and as tall as the window.
const view = { width: 1280, height: 800 };
function resize(width: number, height: number) {
	view.width = width;
	view.height = height;
	vi.stubGlobal("innerWidth", width);
	vi.stubGlobal("innerHeight", height);
}

const undo: (() => void)[] = [];

beforeEach(() => {
	// The bridge's pace is ten seconds of Date; the engines' own motion runs on frames, drawn by hand.
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	frames.clear();
	vi.stubGlobal("requestAnimationFrame", (frame: FrameRequestCallback) => {
		frames.set(++frameId, frame);
		return frameId;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
	resize(1280, 800);
	vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(() => view.width);
	vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(() => view.height);
	// What jsdom lacks and an engine asks for: a size watcher, CSS.escape and a canvas that draws nothing.
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe = () => undefined;
			unobserve = () => undefined;
			disconnect = () => undefined;
		},
	);
	vi.stubGlobal("CSS", { escape: (text: string) => text.replace(/["\\]/g, "\\$&") });
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
		const context: Record<PropertyKey, unknown> = {
			canvas: this,
			measureText: (text: string) => ({ width: text.length * 8 }),
			getImageData: (_x: number, _y: number, width: number, height: number) => ({
				data: new Uint8ClampedArray(width * height * 4),
			}),
		};
		return new Proxy(context, {
			get: (target, key) => (key in target ? target[key] : () => undefined),
		}) as unknown as CanvasRenderingContext2D;
	});
	// What an engine listens to on the window and the document goes with its test, so that the engines of the tests
	// before do not answer this one's events.
	for (const target of [window, document] as EventTarget[]) {
		const add = target.addEventListener;
		target.addEventListener = (
			type: string,
			listener: EventListenerOrEventListenerObject | null,
			options?: boolean | AddEventListenerOptions,
		) => {
			undo.push(() => target.removeEventListener(type, listener, options));
			add.call(target, type, listener, options);
		};
		undo.push(() => {
			target.addEventListener = add;
		});
	}
});

afterEach(() => {
	for (const step of undo.splice(0)) step();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	for (const key of ["qorpera", "QORPERA_KIT", "__qorperaBoardKit"]) Reflect.deleteProperty(page, key);
	document.documentElement.removeAttribute("lang");
	document.body.replaceChildren();
	document.head.replaceChildren();
});

describe("each data kit's engine", () => {
	it.each(KITS)("draws the %s guide's example with its title, and draws its frames", async (kit) => {
		await open(kit, example(kit));
		drawFrames(3);
		expect(document.querySelector("h1")?.textContent).toBe(titleOf(example(kit)));
	});

	it.each(KITS)("of %s reads again ten seconds after a read failed, until one works, and then waits", async (kit) => {
		const { now, qorpera } = await open(kit, new Error("The bridge is busy"));
		expect(document.body.textContent).toContain("Nothing to show yet.");
		await settle(10000);
		expect(qorpera.read).toHaveBeenCalledTimes(2);
		now.file = example(kit);
		await settle(10000);
		expect(qorpera.read).toHaveBeenCalledTimes(3);
		expect(document.querySelector("h1")?.textContent).toBe(titleOf(example(kit)));
		// A page that shows its data reads it again when the folder changes, and never on a timer.
		await settle(60000);
		expect(qorpera.read).toHaveBeenCalledTimes(3);
	});
});

describe("the model kit's engine", () => {
	const price = { id: "price", label: "Price", unit: "kr", min: 0, max: 100, step: 1, value: 40, state: "known" };
	const model = (inputs: readonly unknown[], save?: unknown) =>
		JSON.stringify({ lang: "en", title: "Prices", groups: [{ label: "Numbers", inputs }], save });
	/** Moves a slider as a member's hand does. */
	function slide(label: string, value: number) {
		const range = document.querySelector<HTMLInputElement>(`.mk-range[aria-label="${label}"]`) as HTMLInputElement;
		range.value = String(value);
		range.dispatchEvent(new Event("input"));
		return range;
	}
	const saveButton = () => document.querySelector<HTMLButtonElement>(".mk-save");
	/** Inputs n1, n2, … of 0 to 10, each at 5. */
	const numbers = (count: number) =>
		Array.from({ length: count }, (_, n) => ({
			id: `n${n + 1}`,
			label: `Number ${n + 1}`,
			min: 0,
			max: 10,
			step: 1,
			value: 5,
			state: "known",
		}));

	it.each([1, 0, "Basis", { region: "eu", year: 2026 }])("saves to the row whose key is %j", async (key) => {
		const { qorpera } = await open("model", model([price], { table: "prices", key }));
		slide("Price", 50);
		saveButton()?.click();
		await settle();
		expect(qorpera.setRow).toHaveBeenCalledWith("prices", key, { price: 50 });
		expect(qorpera.addRow).not.toHaveBeenCalled();
	});

	it("adds a row when the save names no key, and offers no Save for a key that is none", async () => {
		const added = await open("model", model([price], { table: "prices" }));
		slide("Price", 50);
		saveButton()?.click();
		await settle();
		expect(added.qorpera.addRow).toHaveBeenCalledWith("prices", { price: 50 });
		expect(added.qorpera.setRow).not.toHaveBeenCalled();
		for (const key of [[1], "", {}, { region: null }]) {
			const refused = await open("model", model([price], { table: "prices", key }));
			expect(saveButton(), JSON.stringify(key)).toBeNull();
			expect(document.querySelector(".mk-err")?.textContent).toContain("save: key");
			expect(refused.qorpera.addRow).not.toHaveBeenCalled();
		}
	});

	it("keeps a slider on its own steps when its minimum has decimals", async () => {
		const size = { id: "size", label: "Size", min: 0.5, max: 5.5, step: 1, value: 2.5, state: "known" };
		const { qorpera } = await open("model", model([size], { table: "sizes" }));
		const range = slide("Size", 1.5);
		expect(range.value).toBe("1.5");
		expect(document.querySelector(".mk-val b")?.textContent).toBe("1.5");
		saveButton()?.click();
		await settle();
		expect(qorpera.addRow).toHaveBeenCalledWith("sizes", { size: 1.5 });
	});

	it("offers Save of a keyed row for at most 12 cells, setRow's most, and saves the columns it names", async () => {
		const inputs = numbers(13);
		await open("model", model(inputs, { table: "plan", key: "now" }));
		expect(saveButton()).toBeNull();
		expect(document.querySelector(".mk-err")?.textContent).toContain("save: name at most 12 columns");
		const columns = inputs.slice(0, 12).map((input) => input.id);
		const { qorpera } = await open("model", model(inputs, { table: "plan", key: "now", columns }));
		slide("Number 1", 7);
		saveButton()?.click();
		await settle();
		expect(qorpera.setRow).toHaveBeenCalledWith(
			"plan",
			"now",
			Object.fromEntries(columns.map((id) => [id, id === "n1" ? 7 : 5])),
		);
	});

	it("adds a whole row of more than 12 cells when the save names no key", async () => {
		// addRow takes as many cells as the table has columns: a new row may need all of them.
		const inputs = numbers(13);
		const { qorpera } = await open("model", model(inputs, { table: "plan" }));
		slide("Number 1", 7);
		saveButton()?.click();
		await settle();
		expect(qorpera.addRow).toHaveBeenCalledWith(
			"plan",
			Object.fromEntries(inputs.map((input) => [input.id, input.id === "n1" ? 7 : 5])),
		);
	});
});

describe("the model kit's engine with live values", () => {
	const orders = {
		lang: "en",
		title: "Orders",
		groups: [
			{
				label: "Shop",
				inputs: [
					{
						id: "orders",
						label: "Orders",
						min: 0,
						max: 1000,
						step: 1,
						start: 100,
						value: { query: "shop/month", column: "orders", example: 120 },
					},
					{ id: "visits", label: "Visits", min: 0, max: 9000, step: 1, value: { query: "shop/visits" } },
				],
			},
		],
		scenarios: [{ label: "Busy", values: { orders: 800 } }],
	};
	/** A slider's value and the state it is drawn in. */
	const shown = (label: string) => {
		const range = document.querySelector<HTMLInputElement>(`.mk-range[aria-label="${label}"]`);
		return [range?.value, range?.closest<HTMLElement>(".mk-row")?.dataset.st];
	};
	/** Moves a slider as a member's hand does. */
	function slide(label: string, value: number) {
		const range = document.querySelector<HTMLInputElement>(`.mk-range[aria-label="${label}"]`) as HTMLInputElement;
		range.value = String(value);
		range.dispatchEvent(new Event("input"));
	}
	/** A live value moved: the page draws it in the next frame. */
	async function moved(db: ReturnType<typeof databases>, name: string, row: Row) {
		db.set(name, row);
		drawFrames();
		await settle();
	}

	it("draws a live value as known, and again at once when it moves, not after ten seconds", async () => {
		const db = databases({ "shop/month": { orders: 340 }, "shop/visits": { visits: 4200 } });
		const { qorpera, change } = await openLive("model", orders, db);
		expect(shown("Orders")).toEqual(["340", "known"]);
		expect(shown("Visits")).toEqual(["4200", "known"]);
		expect(db.watch).toHaveBeenCalledTimes(2);
		await moved(db, "shop/month", { orders: 360 });
		expect(shown("Orders")).toEqual(["360", "known"]);
		expect(qorpera.read).toHaveBeenCalledTimes(2);
		expect(db.watch).toHaveBeenCalledTimes(2);
		// A change in the folder still waits for its ten seconds.
		change();
		await settle(9000);
		expect(qorpera.read).toHaveBeenCalledTimes(2);
		await settle(1000);
		expect(qorpera.read).toHaveBeenCalledTimes(3);
	});

	it("draws a live value with no answer yet as not known, at its start, until it answers", async () => {
		const db = databases({ "shop/visits": { visits: 4200 } });
		await openLive("model", orders, db);
		await settle(3000);
		expect(shown("Orders")).toEqual(["100", "unknown"]);
		expect(document.querySelector(".mk-val b")?.textContent).toBe("?");
		expect(shown("Visits")).toEqual(["4200", "known"]);
		await moved(db, "shop/month", { orders: 340 });
		expect(shown("Orders")).toEqual(["340", "known"]);
	});

	it("keeps a live slider the member moved until they reset it, and moves the ones they did not touch", async () => {
		const db = databases({ "shop/month": { orders: 340 }, "shop/visits": { visits: 4200 } });
		await openLive("model", orders, db);
		slide("Orders", 500);
		await moved(db, "shop/month", { orders: 360 });
		expect(shown("Orders")).toEqual(["500", "yours"]);
		await moved(db, "shop/visits", { visits: 4300 });
		expect(shown("Visits")).toEqual(["4300", "known"]);
		// Reset goes back to the live number, which it follows again.
		document.querySelector<HTMLButtonElement>(".mk-row .mk-mine")?.click();
		expect(shown("Orders")).toEqual(["360", "known"]);
		await moved(db, "shop/month", { orders: 380 });
		expect(shown("Orders")).toEqual(["380", "known"]);
		// A scenario the member chose is theirs too.
		[...document.querySelectorAll<HTMLButtonElement>(".mk-chip")]
			.find((chip) => chip.textContent === "Busy")
			?.click();
		await moved(db, "shop/month", { orders: 400 });
		expect(shown("Orders")).toEqual(["800", "yours"]);
		document.querySelector<HTMLButtonElement>(".mk-plain")?.click();
		expect(shown("Orders")).toEqual(["400", "known"]);
	});

	it("keeps the last live value when a later ask fails", async () => {
		const db = databases({ "shop/month": { orders: 340 }, "shop/visits": { visits: 4200 } });
		const { qorpera, change } = await openLive("model", orders, db);
		db.fail("shop/month");
		drawFrames();
		await settle();
		expect(qorpera.read).toHaveBeenCalledTimes(1);
		change();
		await settle(10000);
		expect(qorpera.read).toHaveBeenCalledTimes(2);
		expect(shown("Orders")).toEqual(["340", "known"]);
	});

	it("lets an example give way when the number arrives, and keeps what the member chose", async () => {
		// "Try an example" on a value with no answer yet: the answer, when it comes, replaces the guess.
		const db = databases({ "shop/visits": { visits: 4200 } });
		await openLive("model", orders, db);
		await settle(3000);
		document.querySelector<HTMLButtonElement>(".mk-gobtn")?.click();
		expect(shown("Orders")).toEqual(["100", "yours"]);
		await moved(db, "shop/month", { orders: 340 });
		expect(shown("Orders")).toEqual(["340", "known"]);
		// Dragged before the answer came: the member's value stays.
		const dragged = databases({ "shop/visits": { visits: 4200 } });
		await openLive("model", orders, dragged);
		await settle(3000);
		slide("Orders", 500);
		await moved(dragged, "shop/month", { orders: 340 });
		expect(shown("Orders")).toEqual(["500", "yours"]);
		// A scenario chip's value stays through a live tick.
		const chosen = databases({ "shop/month": { orders: 340 }, "shop/visits": { visits: 4200 } });
		await openLive("model", orders, chosen);
		[...document.querySelectorAll<HTMLButtonElement>(".mk-chip")]
			.find((chip) => chip.textContent === "Busy")
			?.click();
		await moved(chosen, "shop/month", { orders: 360 });
		expect(shown("Orders")).toEqual(["800", "yours"]);
	});

	it("leaves alone a slider whose scenario value has no answer yet", async () => {
		const db = databases({ "shop/month": { orders: 340 }, "shop/visits": { visits: 4200 } });
		const goal = { query: "shop/goal", column: "visits" };
		await openLive("model", { ...orders, scenarios: [{ label: "Goal", values: { orders: 800, visits: goal } }] }, db);
		await settle(3000);
		[...document.querySelectorAll<HTMLButtonElement>(".mk-chip")]
			.find((chip) => chip.textContent === "Goal")
			?.click();
		expect(shown("Orders")).toEqual(["800", "yours"]);
		expect(shown("Visits")).toEqual(["4200", "known"]);
	});

	it("keeps a read that ends while the member drags, and shows it when they let go", async () => {
		const db = databases({ "shop/month": { orders: 340 }, "shop/visits": { visits: 4200 } });
		const { qorpera } = await openLive("model", orders, db);
		let release: () => void = () => undefined;
		qorpera.read.mockImplementationOnce(
			() =>
				new Promise<string>((done) => {
					release = () => done(JSON.stringify(orders));
				}),
		);
		// A value moves and the page reads; the member takes the slider before the read ends.
		db.set("shop/month", { orders: 360 });
		db.set("shop/visits", { visits: 4300 });
		drawFrames();
		await settle();
		expect(qorpera.read).toHaveBeenCalledTimes(2);
		const range = document.querySelector<HTMLInputElement>('.mk-range[aria-label="Orders"]') as HTMLInputElement;
		range.dispatchEvent(new Event("pointerdown"));
		slide("Orders", 500);
		release();
		await settle();
		expect(range.isConnected).toBe(true);
		expect(shown("Orders")).toEqual(["500", "yours"]);
		expect(shown("Visits")).toEqual(["4200", "known"]);
		// Let go: what was read shows, with no read again.
		range.dispatchEvent(new Event("pointerup"));
		await settle(1500);
		expect(qorpera.read).toHaveBeenCalledTimes(2);
		expect(shown("Orders")).toEqual(["500", "yours"]);
		expect(shown("Visits")).toEqual(["4300", "known"]);
	});

	it("never shows an older read held for a drag over a newer one", async () => {
		const db = databases({ "shop/month": { orders: 340 }, "shop/visits": { visits: 4200 } });
		const { qorpera } = await openLive("model", orders, db);
		const reads: ((text: string) => void)[] = [];
		const pendingRead = () => new Promise<string>((done) => reads.push(done));
		qorpera.read.mockImplementationOnce(pendingRead).mockImplementationOnce(pendingRead);
		// Two values move one after the other: two loads, the second waiting on the first.
		db.set("shop/month", { orders: 360 });
		drawFrames();
		await settle();
		db.set("shop/visits", { visits: 4300 });
		drawFrames();
		await settle();
		const range = document.querySelector<HTMLInputElement>('.mk-range[aria-label="Orders"]') as HTMLInputElement;
		range.dispatchEvent(new Event("pointerdown"));
		slide("Orders", 500);
		// The older read ends during the drag and is held; the newer ends after the member lets go.
		reads.shift()?.(JSON.stringify({ ...orders, title: "Older" }));
		await settle();
		expect(document.querySelector("h1")?.textContent).toBe("Orders");
		range.dispatchEvent(new Event("pointerup"));
		reads.shift()?.(JSON.stringify({ ...orders, title: "Newer" }));
		await settle();
		expect(document.querySelector("h1")?.textContent).toBe("Newer");
		await settle(3000);
		expect(document.querySelector("h1")?.textContent).toBe("Newer");
		expect(shown("Visits")).toEqual(["4300", "known"]);
		expect(qorpera.read).toHaveBeenCalledTimes(3);
	});

	it("neither stops nor moves a slider being dragged when a value moves, and keeps an open note open", async () => {
		const db = databases({ "shop/month": { orders: 340 }, "shop/visits": { visits: 4200 } });
		const noted = structuredClone(orders);
		Object.assign(noted.groups[0]?.inputs[0] ?? {}, { note: "Paid orders" });
		const { qorpera } = await openLive("model", noted, db);
		const range = document.querySelector<HTMLInputElement>('.mk-range[aria-label="Orders"]') as HTMLInputElement;
		range.dispatchEvent(new Event("pointerdown"));
		slide("Orders", 500);
		await moved(db, "shop/month", { orders: 360 });
		await moved(db, "shop/visits", { visits: 4300 });
		// The page waits for the hand: the same slider, where the member holds it.
		expect(range.isConnected).toBe(true);
		expect(shown("Orders")).toEqual(["500", "yours"]);
		expect(qorpera.read).toHaveBeenCalledTimes(1);
		range.dispatchEvent(new Event("pointerup"));
		await settle(1500);
		expect(qorpera.read).toHaveBeenCalledTimes(2);
		expect(shown("Orders")).toEqual(["500", "yours"]);
		expect(shown("Visits")).toEqual(["4300", "known"]);
		// A note the member opened stays open through a redraw.
		document.querySelector<HTMLElement>(".mk-noted")?.click();
		expect(document.querySelector(".mk-tip.mk-on")?.textContent).toBe("Paid orders");
		await moved(db, "shop/visits", { visits: 4400 });
		expect(shown("Visits")).toEqual(["4400", "known"]);
		expect(document.querySelector(".mk-tip.mk-on")?.textContent).toBe("Paid orders");
		expect(document.querySelector(".mk-noted")?.getAttribute("aria-expanded")).toBe("true");
	});

	it("keeps an input's note to the app's owner open through a live value, with its button", async () => {
		const db = databases({ "shop/month": { orders: 340 }, "shop/visits": { visits: 4200 } });
		await openLive("model", orders, db);
		const tell = vi.fn(async (_note: unknown): Promise<unknown> => ({ sent: true }));
		Object.assign(page.qorpera as object, { tell });
		// Drawn again with a bridge that takes a note: a label with no note of its own opens one with the button.
		await moved(db, "shop/visits", { visits: 4300 });
		document.querySelector<HTMLElement>(".mk-noted")?.click();
		expect(document.querySelector(".mk-tip.mk-on .mk-tell-b")).not.toBeNull();
		await moved(db, "shop/visits", { visits: 4400 });
		expect(shown("Visits")).toEqual(["4400", "known"]);
		expect(document.querySelector(".mk-tip.mk-on .mk-tell-b")).not.toBeNull();
		expect(document.querySelector(".mk-noted")?.getAttribute("aria-expanded")).toBe("true");
		document.querySelector<HTMLButtonElement>(".mk-tip.mk-on .mk-tell-b")?.click();
		await settle();
		expect(tell).toHaveBeenCalledWith({ about: "Orders · 340", at: "orders" });
	});

	it.each(WITHOUT_WATCH)("draws a live value's example %s, and else not known", async (_where, db) => {
		await openLive("model", orders, db);
		expect(shown("Orders")).toEqual(["120", "assumed"]);
		expect(shown("Visits")).toEqual(["4500", "unknown"]);
	});
});

describe("the path kit's engine with live values", () => {
	const funnel = {
		lang: "en",
		title: "Orders",
		steps: [
			{ id: "visit", name: "Visit" },
			{ id: "buy", name: "Buy" },
		],
		lanes: [
			{
				id: "web",
				name: "Web",
				steps: {
					visit: { value: { query: "shop/funnel", column: "visits" } },
					buy: { value: { query: "shop/funnel", column: "orders", example: 12 } },
				},
			},
		],
		figures: [{ value: { query: "shop/revenue", example: 5000 }, label: "Revenue", unit: "kr" }],
	};
	const step = (id: string) => document.querySelector(`.pk-val[data-lane="web"][data-step="${id}"]`);
	const revenue = () =>
		[...document.querySelectorAll(".pk-fig")].find((figure) => figure.textContent?.includes("Revenue"));

	it("draws a step's and a figure's live value, and again at once when they move", async () => {
		const db = databases({ "shop/funnel": { visits: 1200, orders: 30 }, "shop/revenue": { revenue: 48000 } });
		const { qorpera } = await openLive("path", funnel, db);
		expect(step("visit")?.textContent).toBe("1,200");
		expect(step("buy")?.className).toBe("pk-val");
		expect(revenue()?.classList.contains("unk")).toBe(false);
		db.set("shop/funnel", { visits: 1300, orders: 31 });
		db.set("shop/revenue", { revenue: 49000 });
		drawFrames();
		await settle();
		expect(qorpera.read).toHaveBeenCalledTimes(2);
		expect(step("visit")?.textContent).toBe("1,300");
		expect(step("buy")?.textContent).toBe("31");
		expect(revenue()?.querySelector(".pk-fig-n")?.textContent).toBe("49,000");
	});

	it("draws a value with no answer yet as not known, and keeps the last one when a later ask fails", async () => {
		const db = databases({ "shop/funnel": { visits: 1200, orders: 30 } });
		const { change } = await openLive("path", funnel, db);
		await settle(3000);
		expect(step("visit")?.textContent).toBe("1,200");
		expect(revenue()?.classList.contains("unk")).toBe(true);
		db.set("shop/revenue", { revenue: 48000 });
		drawFrames();
		await settle();
		expect(revenue()?.classList.contains("unk")).toBe(false);
		db.fail("shop/funnel");
		change();
		await settle(10000);
		expect(step("visit")?.textContent).toBe("1,200");
		expect(revenue()?.querySelector(".pk-fig-n")?.textContent).toBe("48,000");
	});

	it("keeps an open step's sheet open through a live value, and plays its entrance once", async () => {
		const db = databases({ "shop/funnel": { visits: 1200, orders: 30 }, "shop/revenue": { revenue: 48000 } });
		await openLive("path", funnel, db);
		expect(document.querySelector(".pk")?.classList.contains("pk-intro")).toBe(true);
		document.querySelector<HTMLButtonElement>('.pk-node[data-key="n:web:visit"]')?.click();
		expect(document.querySelectorAll(".pk-sheet")).toHaveLength(1);
		db.set("shop/funnel", { visits: 1300, orders: 31 });
		drawFrames();
		await settle();
		expect(document.querySelectorAll(".pk-sheet")).toHaveLength(1);
		expect(document.querySelector('.pk-node[data-key="n:web:visit"]')?.getAttribute("aria-expanded")).toBe("true");
		// The open step's number is the new one, marked as the open step's.
		expect(step("visit")?.textContent).toBe("1,300");
		expect(step("visit")?.classList.contains("mine")).toBe(true);
		// No entrance again: the figures stand at their numbers at once.
		expect(document.querySelector(".pk")?.classList.contains("pk-intro")).toBe(false);
		expect(revenue()?.querySelector(".pk-fig-n")?.textContent).toBe("48,000");
	});

	it.each(WITHOUT_WATCH)("draws a live value's example %s, and else not known", async (_where, db) => {
		await openLive("path", funnel, db);
		// A step with no example is a hole; one with an example is drawn as assumed.
		expect(step("visit")).toBeNull();
		expect(step("buy")?.textContent).toBe("12");
		expect(step("buy")?.className).toBe("pk-val a");
		expect(revenue()?.classList.contains("unk")).toBe(false);
	});
});

describe("the board kit's engine", () => {
	const board = JSON.stringify({
		lang: "en",
		mode: "choose",
		title: "Names",
		items: [
			{ id: "lys", name: "Lys" },
			{ id: "ro", name: "Ro" },
		],
	});
	const question: Question = {
		id: "q-1",
		agent: "Ida",
		title: "Which name?",
		body: "",
		options: [
			{ label: "Lys", value: "lys", description: "" },
			{ label: "Ro", value: "ro", description: "" },
		],
		multiSelect: false,
	};

	it("reads the open questions again on a change, also when its own file is as it was", async () => {
		const { now, change, qorpera } = await open("board", board);
		document.querySelector<HTMLButtonElement>('.bk-panel[data-id="lys"]')?.click();
		expect(document.querySelector(".bk-world")).not.toBeNull();
		expect(document.querySelector(".bk-pick")).toBeNull();
		// The agent asks once the member has the board open: the Choose button comes with the next change.
		now.questions = [question];
		change();
		await settle(10000);
		expect(qorpera.read).toHaveBeenCalledTimes(2);
		expect(document.querySelector(".bk-world .bk-pick")?.textContent).toBe("Choose Lys");
		// Answered in the chat: the button goes with the next change.
		now.questions = [];
		change();
		await settle(10000);
		expect(document.querySelector(".bk-pick")).toBeNull();
	});

	it("asks for the questions again ten seconds after the call failed, until it works, and then waits", async () => {
		const { now, qorpera } = await open("board", board, (bridge) => {
			bridge.questions = new Error("Too many calls");
		});
		document.querySelector<HTMLButtonElement>('.bk-panel[data-id="lys"]')?.click();
		expect(document.querySelector(".bk-pick")).toBeNull();
		// No change in the folder: the page asks again by itself.
		now.questions = [question];
		await settle(10000);
		expect(qorpera.questions).toHaveBeenCalledTimes(2);
		expect(document.querySelector(".bk-world .bk-pick")?.textContent).toBe("Choose Lys");
		// Once a call worked, it asks again only on a change, never on a timer.
		await settle(60000);
		expect(qorpera.questions).toHaveBeenCalledTimes(2);
		expect(qorpera.read).toHaveBeenCalledTimes(1);
	});

	it("keeps the Choose button it shows while the questions cannot be read", async () => {
		const { now, change } = await open("board", board, (bridge) => {
			bridge.questions = [question];
		});
		document.querySelector<HTMLButtonElement>('.bk-panel[data-id="lys"]')?.click();
		expect(document.querySelector(".bk-world .bk-pick")?.textContent).toBe("Choose Lys");
		now.questions = new Error("Too many calls");
		change();
		await settle(10000);
		expect(document.querySelector(".bk-world .bk-pick")?.textContent).toBe("Choose Lys");
		// Answered in the chat meanwhile: the next call that works takes the button away.
		now.questions = [];
		await settle(10000);
		expect(document.querySelector(".bk-pick")).toBeNull();
	});

	it("draws the pictures as the page, grows the one under the pointer and marks the chosen one on its picture", async () => {
		resize(1700, 700);
		const media = document.createElement("div");
		media.id = "kit-media";
		media.hidden = true;
		media.innerHTML = ["lys", "ro"]
			.map((id) => `<img data-kit-src="pictures/${id}.webp" src="data:image/webp;base64,AA==" alt="">`)
			.join("");
		document.body.append(media);
		const pictures = JSON.stringify({
			...JSON.parse(board),
			line: "Two names",
			items: [
				{ id: "lys", name: "Lys", poster: "pictures/lys.webp" },
				{ id: "ro", name: "Ro", poster: "pictures/ro.webp" },
			],
		});
		const { qorpera } = await open("board", pictures, (bridge) => {
			bridge.questions = [question];
		});
		const row = document.querySelector(".bk-panels") as HTMLElement;
		expect(row.classList.contains("is-pics")).toBe(true);
		expect(document.querySelector("h1")?.textContent).toBe("Names");
		expect(getComputedStyle(document.querySelector(".bk-head") as Element).position).toBe("absolute");
		expect(document.querySelector('.bk-panel[data-id="lys"] .bk-stage > .bk-win > .bk-ptop')).not.toBeNull();
		expect(row.style.getPropertyValue("--tc")).toBe("minmax(0,1fr) minmax(0,1fr)");
		const enter = Object.assign(new Event("pointerenter"), { pointerType: "mouse" });
		document.querySelector('.bk-panel[data-id="ro"]')?.dispatchEvent(enter);
		expect(row.style.getPropertyValue("--tc")).toBe("minmax(0,1fr) minmax(0,1.4fr)");
		document.querySelector('.bk-panel[data-id="ro"]')?.dispatchEvent(new Event("pointerleave"));
		expect(row.style.getPropertyValue("--tc")).toBe("minmax(0,1fr) minmax(0,1fr)");
		document.querySelector<HTMLButtonElement>('.bk-panel[data-id="lys"]')?.click();
		document.querySelector<HTMLButtonElement>(".bk-world .bk-pick")?.click();
		await settle();
		expect(qorpera.answer).toHaveBeenCalledWith("q-1", "lys");
		const chip = (id: string) =>
			getComputedStyle(document.querySelector(`.bk-panel[data-id="${id}"] .bk-chosen`) as Element).display;
		expect(chip("lys")).toBe("inline-flex");
		expect(chip("ro")).toBe("none");
	});

	it("asks nothing more for a board it has drawn again", async () => {
		const { now, change, qorpera } = await open("board", board, (bridge) => {
			bridge.questions = new Error("Too many calls");
			bridge.slow = 2000;
		});
		// Drawn again before the failed call's ten seconds are up, as a shelf, which has no question to ask.
		now.file = JSON.stringify({
			lang: "en",
			mode: "scale",
			title: "Prices",
			items: [{ id: "lys", name: "Lys", value: 10 }],
		});
		change();
		await settle(10000);
		expect(document.querySelector("h1")?.textContent).toBe("Prices");
		await settle(60000);
		expect(qorpera.questions).toHaveBeenCalledTimes(1);
	});
});

describe("the path kit's engine", () => {
	it("keeps one detail sheet, which closes, when a phone turns with a step open", async () => {
		resize(390, 844);
		await open("path", example("path"));
		document.querySelector<HTMLButtonElement>('.pk-node[data-key="n:homes:look"]')?.click();
		expect(document.querySelectorAll(".pk-sheet")).toHaveLength(1);
		resize(430, 932);
		window.dispatchEvent(new Event("resize"));
		drawFrames();
		expect(document.querySelectorAll(".pk-sheet")).toHaveLength(1);
		document.querySelector<HTMLButtonElement>(".pk-sheet .pk-x")?.click();
		expect(document.querySelectorAll(".pk-sheet")).toHaveLength(0);
	});
});

describe("the object kit's engine", () => {
	const object = (title: string) =>
		JSON.stringify({ lang: "en", title, picture: "pictures/box.webp", facts: [{ label: "Weight", value: "320 g" }] });

	it("builds its page once a read works after the first failed, and keeps up with changes after", async () => {
		const { now, change, qorpera } = await open("object", new Error("The bridge is busy"));
		expect(document.querySelector(".ok-empty")?.textContent).toBe("Nothing to show yet.");
		// It listens to the folder already.
		expect(qorpera.onChange).toHaveBeenCalledTimes(1);
		now.file = object("The box");
		change();
		await settle(10000);
		expect(document.querySelector(".ok-head h1")?.textContent).toBe("The box");
		now.file = object("The new box");
		change();
		await settle(10000);
		expect(document.querySelector(".ok-head h1")?.textContent).toBe("The new box");
	});
});

describe("each data kit's note to the app's owner", () => {
	interface Thing {
		readonly id: string;
		readonly name: string;
		readonly ask?: unknown;
	}
	/** Each kit's data with the given things in it, how a member opens a thing's detail, what then shows and how it
	 * closes, what the note is about and which thing it names, and an id the kit keeps that the call's pattern does
	 * not take (two of them, so two such things can be told apart). */
	const KIT_THING: Readonly<
		Record<
			ThingKit,
			{
				readonly data: (things: readonly Thing[], words: unknown) => string;
				readonly open: (thing: Thing, index: number) => void;
				readonly shown: string;
				readonly close: () => void;
				readonly about: (thing: Thing) => string;
				readonly at: (thing: Thing) => string;
				readonly odd: readonly [string, string];
			}
		>
	> = {
		model: {
			data: (things, words) =>
				JSON.stringify({
					lang: "en",
					title: "Prices",
					words,
					groups: [
						{
							label: "Numbers",
							inputs: things.map((thing) => ({
								id: thing.id,
								label: thing.name,
								unit: "kr",
								min: 0,
								max: 100,
								value: 40,
								state: "known",
								note: "From the supplier's list",
								ask: thing.ask,
							})),
						},
					],
				}),
			open: (_thing, index) => pressNth(".mk-label", index),
			shown: ".mk-tip.mk-on",
			// a second tap on the label closes its note
			close: () => press(".mk-label"),
			about: (thing) => `${thing.name} · 40 kr`,
			at: (thing) => thing.id,
			// a model's own ids may start with an underscore, which the call's pattern does not take
			odd: ["_price_one", "_price_two"],
		},
		board: {
			data: (things, words) =>
				JSON.stringify({
					lang: "en",
					mode: "scale",
					title: "Prices",
					words,
					items: things.map((thing) => ({ id: thing.id, name: thing.name, value: 10, ask: thing.ask })),
				}),
			open: (thing) => press(`.bk-item[data-id="${thing.id}"]`),
			shown: ".bk-sheet.is-open",
			close: () => press(".bk-sheet .bk-x"),
			about: (thing) => thing.name,
			at: (thing) => thing.id,
			odd: ["supplier 1", "supplier 2"],
		},
		path: {
			data: (things, words) =>
				JSON.stringify({
					lang: "en",
					title: "Customers",
					words,
					steps: [{ id: "look", name: "Look" }],
					lanes: things.map((thing) => ({
						id: thing.id,
						name: thing.name,
						steps: { look: { state: "known", ask: thing.ask } },
					})),
				}),
			open: (thing) => press(`.pk-node[data-key="n:${thing.id}:look"]`),
			shown: ".pk-sheet",
			close: () => press(".pk-sheet .pk-x"),
			about: (thing) => `Look · ${thing.name}`,
			at: (thing) => `${thing.id}:look`,
			odd: ["lane one", "lane two"],
		},
		object: {
			data: (things, words) =>
				JSON.stringify({
					lang: "en",
					title: "Box",
					picture: "pictures/box.webp",
					words,
					parts: things.map((thing) => ({
						id: thing.id,
						name: thing.name,
						track: [[0.5, 0.5, 1]],
						ask: thing.ask,
					})),
				}),
			open: (thing) => press(`.ok-strip button[data-id="${thing.id}"]`),
			shown: ".ok-note.open",
			close: () => press(".ok-close"),
			about: (thing) => thing.name,
			at: (thing) => thing.id,
			odd: ["part one", "part two"],
		},
		shelf: {
			data: (things, words) =>
				JSON.stringify({
					lang: "en",
					title: "Lamps",
					words,
					things: things.map((thing) => ({ id: thing.id, name: thing.name, value: 10, max: 20, ask: thing.ask })),
				}),
			open: (thing) => press(`.sh-thing[data-id="${thing.id}"]`),
			shown: ".sh-sheet.is-open",
			close: () => press(".sh-sheet .sh-x"),
			about: (thing) => thing.name,
			at: (thing) => thing.id,
			odd: ["lamp one", "lamp two"],
		},
	};
	const BUTTON = ".bk-tell-b, .pk-tell-b, .ok-tell-b, .mk-tell-b, .sh-tell-b";
	const WHY = ".bk-tell-why, .pk-tell-why, .ok-tell-why, .mk-tell-why, .sh-tell-why";
	const WORDS = { tell: "Ask Ida", told: "Sent to Ida" };
	const LYS: Thing = { id: "lys", name: "Lys", ask: "Get a quote from them" };
	const press = (selector: string) => document.querySelector<HTMLElement>(selector)?.click();
	const pressNth = (selector: string, index: number) =>
		document.querySelectorAll<HTMLElement>(selector)[index]?.click();
	const button = () => document.querySelector<HTMLButtonElement>(BUTTON);

	it.each(THING_KITS)("of %s draws no button for a note where the page's bridge has no tell", async (kit) => {
		const thing = KIT_THING[kit];
		await open(kit, thing.data([LYS], WORDS));
		thing.open(LYS, 0);
		expect(document.querySelector(thing.shown)).not.toBeNull();
		expect(button()).toBeNull();
	});

	it.each(THING_KITS)(
		"of %s asks for a note once, from a press on the button at the foot of what a member opened",
		async (kit) => {
			const thing = KIT_THING[kit];
			const tell = vi.fn(async (_note: unknown): Promise<unknown> => ({ sent: true }));
			await open(kit, thing.data([LYS], WORDS), undefined, tell);
			thing.open(LYS, 0);
			// Nothing asks by itself: not when the page opens, not when a thing opens, not on a timer.
			await settle(60000);
			expect(tell).not.toHaveBeenCalled();
			expect(document.querySelector(thing.shown)?.contains(button())).toBe(true);
			expect(button()?.textContent).toBe("Ask Ida");
			// One request a press: a second press while the member decides asks nothing more.
			button()?.click();
			button()?.click();
			await settle();
			expect(tell).toHaveBeenCalledTimes(1);
			expect(tell).toHaveBeenCalledWith({
				about: thing.about(LYS),
				at: thing.at(LYS),
				text: "Get a quote from them",
			});
			// The note went: the button says so, and asks nothing more.
			expect(button()?.textContent).toBe("Sent to Ida");
			expect(button()?.getAttribute("aria-disabled")).toBe("true");
			button()?.click();
			await settle();
			expect(tell).toHaveBeenCalledTimes(1);
		},
	);

	it.each(THING_KITS)("of %s says for a few seconds why a note did not go, and keeps its button", async (kit) => {
		const thing = KIT_THING[kit];
		const tell = vi.fn(async (_note: unknown): Promise<unknown> => {
			throw new Error("The member said not now.");
		});
		await open(kit, thing.data([LYS], WORDS), undefined, tell);
		thing.open(LYS, 0);
		const why = document.querySelector(WHY);
		expect(why?.textContent).toBe("");
		expect(why?.getAttribute("aria-live")).toBe("polite");
		button()?.click();
		await settle();
		// The bridge's sentence, read out, in the line that was there empty: nothing moves for it.
		expect(document.querySelector(WHY)).toBe(why);
		expect(why?.textContent).toBe("The member said not now.");
		expect(button()?.textContent).toBe("Ask Ida");
		expect(button()?.hasAttribute("aria-disabled")).toBe(false);
		// Most often it is the member's own "not now" of a moment ago: it goes by itself after six seconds.
		await settle(5900);
		expect(why?.textContent).toBe("The member said not now.");
		await settle(100);
		expect(why?.textContent).toBe("");
		// Refused again and pressed again, it goes at once; the note then waits in the agent's thread, as done as one
		// that went.
		button()?.click();
		await settle();
		expect(why?.textContent).toBe("The member said not now.");
		tell.mockResolvedValueOnce({ sent: false, waiting: true });
		button()?.click();
		expect(why?.textContent).toBe("");
		await settle();
		expect(tell).toHaveBeenCalledTimes(3);
		expect(button()?.textContent).toBe("Sent to Ida");
		expect(why?.textContent).toBe("");
	});

	it.each(THING_KITS)(
		"of %s keeps each thing's note its own, also where the call takes neither thing's id",
		async (kit) => {
			// Two things of the same name whose ids the call cannot take: both send no `at`, and the note of one said
			// nothing about the other (their state was once kept under what went out, which was empty for both).
			const thing = KIT_THING[kit];
			const one: Thing = { id: thing.odd[0], name: "Lys", ask: "Get a quote from them" };
			const two: Thing = { id: thing.odd[1], name: "Lys", ask: "Get a quote from them" };
			const tell = vi.fn(async (_note: unknown): Promise<unknown> => ({ sent: true }));
			await open(kit, thing.data([one, two], WORDS), undefined, tell);
			thing.open(one, 0);
			button()?.click();
			await settle();
			expect(tell).toHaveBeenCalledWith({ about: thing.about(one), text: "Get a quote from them" });
			expect(button()?.textContent).toBe("Sent to Ida");
			thing.close();
			// The other thing offers its own button, and sends its own note.
			thing.open(two, 1);
			expect(button()?.textContent).toBe("Ask Ida");
			button()?.click();
			await settle();
			expect(tell).toHaveBeenCalledTimes(2);
			expect(button()?.textContent).toBe("Sent to Ida");
			// And the first one is still sent: each thing keeps its own.
			thing.close();
			thing.open(one, 0);
			expect(button()?.textContent).toBe("Sent to Ida");
		},
	);

	it.each(THING_KITS)("of %s takes nothing of a closed detail into the member's way", async (kit) => {
		// A detail faded out but left in the page kept its note's button in the tab order, so Shift+Tab reached it and
		// asked about a thing no longer open.
		const thing = KIT_THING[kit];
		const tell = vi.fn(async (_note: unknown): Promise<unknown> => ({ sent: true }));
		await open(kit, thing.data([LYS], WORDS), undefined, tell);
		thing.open(LYS, 0);
		const opened = button() as HTMLButtonElement;
		opened.focus();
		expect(document.activeElement).toBe(opened);
		thing.close();
		// What the member can reach: the detail is gone, or hidden and inert, and the focus is back in the page.
		const detail = document.querySelector(thing.shown);
		expect(detail).toBeNull();
		for (const node of document.querySelectorAll(BUTTON)) {
			const hidden = node.closest("[inert]") !== null || getComputedStyle(node).visibility === "hidden";
			expect(hidden || node.isConnected === false, `${kit}: a closed detail's button is still in the page`).toBe(
				true,
			);
		}
		// And the focus went back to what opened the detail, never left on a button nobody can see.
		expect(document.activeElement).not.toBe(opened);
		expect(document.activeElement?.closest("[inert]") ?? null).toBeNull();
		expect(tell).not.toHaveBeenCalled();
	});

	it.each(THING_KITS)("of %s takes the reason a note did not go away at once when the detail closes", async (kit) => {
		const thing = KIT_THING[kit];
		const tell = vi.fn(async (_note: unknown): Promise<unknown> => {
			throw new Error("The member said not now.");
		});
		await open(kit, thing.data([LYS], WORDS), undefined, tell);
		thing.open(LYS, 0);
		button()?.click();
		await settle();
		expect(document.querySelector(WHY)?.textContent).toBe("The member said not now.");
		thing.close();
		expect(document.querySelector(thing.shown)).toBeNull();
		for (const line of document.querySelectorAll(WHY)) expect(line.textContent).toBe("");
		// Opened again before the six seconds are up, the thing shows its button and no reason.
		thing.open(LYS, 0);
		expect(document.querySelector(WHY)?.textContent).toBe("");
		expect(button()?.textContent).toBe("Ask Ida");
	});

	it.each(THING_KITS)(
		"of %s names no thing the call cannot take, sends no draft past 40 characters, and draws a mark without words",
		async (kit) => {
			const thing = KIT_THING[kit];
			const odd: Thing = { id: thing.odd[0], name: "Lys", ask: "x".repeat(41) };
			const tell = vi.fn(async (_note: unknown): Promise<unknown> => ({ sent: true }));
			// Words that are no text are left out, as a kit's other words are.
			await open(kit, thing.data([odd], { tell: ["Ask Ida"], told: { text: "Sent" } }), undefined, tell);
			thing.open(odd, 0);
			expect(button()?.textContent).toBe("");
			expect(button()?.getAttribute("aria-label")).toBe("Send a note");
			expect(button()?.querySelector("svg")).not.toBeNull();
			button()?.click();
			await settle();
			expect(tell).toHaveBeenCalledWith({ about: thing.about(odd) });
			expect(button()?.getAttribute("aria-label")).toBe("Sent");
		},
	);

	it("cuts what a model's note is about at a word, to the call's 60 characters", async () => {
		// A model's label is at most 28 characters, but the value as shown has no such bound.
		const tell = vi.fn(async (_note: unknown): Promise<unknown> => ({ sent: true }));
		const world = {
			id: "people",
			label: "Customers in the whole world",
			min: 0,
			max: 1e30,
			value: 1e30,
			state: "known",
		};
		await open(
			"model",
			JSON.stringify({ lang: "en", title: "World", groups: [{ label: "Numbers", inputs: [world] }] }),
			undefined,
			tell,
		);
		press(".mk-label");
		button()?.click();
		await settle();
		// The whole line would end in a number cut short: the number goes, and the line stops at a word.
		expect(tell).toHaveBeenCalledWith({ about: "Customers in the whole world…", at: "people" });
	});
});

describe("a kit's page as a concept", () => {
	/* A concept opens full screen beside the Concepts viewer, which already names the app and says what it is, so the
	 * page is the thing itself: no title block, and almost nothing around the stage (Jonas, 13 November 2026: "get rid
	 * of it ... minimize the borders/framing around the visual we are just trying to show"). The page says so, in
	 * QORPERA_KIT.concept (kitPage), never the agent's data. */
	const BARE: Readonly<Record<Kit, { readonly root: string; readonly header: string; readonly kept: string }>> = {
		// the root's class when the page is a concept, the title block it then leaves out, and a control that stays
		model: { root: "mk--bare", header: ".mk-title", kept: ".mk-row" },
		board: { root: "bk--bare", header: ".bk-titles", kept: ".bk-item" },
		path: { root: "pk--bare", header: ".pk-head", kept: ".pk-node" },
		object: { root: "ok--bare", header: ".ok-head", kept: ".ok-strip button" },
		curve: { root: "ck--bare", header: ".ck-head", kept: ".ck-plot" },
		stack: { root: "st--bare", header: ".st-head", kept: ".st-card" },
		shelf: { root: "sh--bare", header: ".sh-head", kept: ".sh-thing" },
		map: { root: "mp--bare", header: ".mp-head", kept: ".mp-thing" },
		ring: { root: "rk--bare", header: ".rk-head", kept: ".rk-stage" },
		flow: { root: "fk--bare", header: ".fk-head", kept: ".fk-stage" },
	};
	/** What the page shows of an element: jsdom reads the engine's own stylesheet for a class selector. */
	const shows = (selector: string) => {
		const found = document.querySelector(selector);
		return found !== null && getComputedStyle(found).display !== "none";
	};

	it.each(KITS)("of %s draws its title block and its own padding when the page is no concept", async (kit) => {
		await open(kit, example(kit));
		drawFrames(3);
		const root = document.querySelector("main") as HTMLElement;
		expect(root.className).not.toContain("--bare");
		expect(shows(BARE[kit].header)).toBe(true);
		expect(document.querySelector("h1")?.textContent).toBe(titleOf(example(kit)));
	});

	it.each(KITS)("of %s draws no title block when the page is a concept, and keeps what a member does", async (kit) => {
		await open(kit, example(kit), undefined, undefined, true);
		drawFrames(3);
		const root = document.querySelector("main") as HTMLElement;
		expect(root.className).toContain(BARE[kit].root);
		expect(shows(BARE[kit].header)).toBe(false);
		// every control is still there; how little room the stage then keeps around it is looked at in a browser
		expect(document.querySelector(BARE[kit].kept)).not.toBeNull();
	});
});

describe("the curve kit's engine", () => {
	const money = {
		lang: "en",
		title: "Money ahead",
		unit: "kr",
		points: [
			{ label: "Sep", value: 37200 },
			{ label: "Oct", value: 45600 },
			{ label: "Nov", value: 62400 },
			{ label: "Dec", value: 58000, band: [52000, 65000] },
			{ label: "Jan", band: [40000, 58000] },
			{ label: "Feb" },
		],
		now: "Nov",
		safe: { value: 25000, label: "safe level" },
		marks: [{ at: "Dec", text: "low point" }],
	};
	const big = () => document.querySelector(".ck-n")?.textContent;
	const under = () => document.querySelector(".ck-sub")?.textContent;

	it("draws the past as an area, what is expected as a band, now, the safe level, a mark and the fog", async () => {
		await open("curve", JSON.stringify(money));
		// the big number counts to its figure as the page opens
		drawFrames(100);
		expect(document.querySelectorAll(".ck-area")).toHaveLength(1);
		expect(document.querySelector(".ck-past")).not.toBeNull();
		expect(document.querySelector(".ck-band")).not.toBeNull();
		// a dotted line where a value is expected, and none where only the band is
		expect(document.querySelectorAll(".ck-ahead")).toHaveLength(1);
		expect(document.querySelector(".ck-now")).not.toBeNull();
		expect(document.querySelector(".ck-safe-t")?.textContent).toBe("safe level");
		expect(document.querySelector(".ck-mark-t")?.textContent).toBe("low point");
		expect(document.querySelector(".ck-mark-v")?.textContent).toBe("58,000");
		// a point nobody has said anything about is fog with a question mark, never a number
		expect(document.querySelector(".ck-q")?.textContent).toBe("?");
		// the big number is the value now
		expect(big()).toBe("62,400");
		expect(under()).toBe("now");
	});

	it("lets the big number follow the arrow keys along the curve, a band for a point with no value", async () => {
		await open("curve", JSON.stringify(money));
		const plot = document.querySelector<HTMLElement>(".ck-plot");
		expect(plot?.getAttribute("role")).toBe("slider");
		const key = (name: string) => plot?.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
		key("ArrowRight");
		expect(big()).toBe("58,000");
		expect(under()).toBe("Decexpected52,000 to 65,000");
		expect(plot?.getAttribute("aria-valuetext")).toBe("Dec: 58,000 kr");
		key("ArrowRight");
		expect(big()).toBe("40,000–58,000");
		key("Home");
		expect(big()).toBe("37,200");
		expect(under()).toBe("Sep");
		key("Escape");
		expect(big()).toBe("62,400");
	});

	it("draws a live value as known, and again at once when it moves", async () => {
		const live = {
			...money,
			points: money.points.map((point, at) =>
				at === 2 ? { label: "Nov", value: { query: "bank/balance", column: "balance" } } : point,
			),
		};
		const db = databases({ "bank/balance": { balance: 62400 } });
		const { qorpera } = await openLive("curve", live, db);
		drawFrames(100);
		expect(big()).toBe("62,400");
		db.set("bank/balance", { balance: 63100 });
		drawFrames();
		await settle();
		expect(qorpera.read).toHaveBeenCalledTimes(2);
		expect(big()).toBe("63,100");
	});

	it.each(WITHOUT_WATCH)("draws a live value's example %s as assumed", async (_where, db) => {
		const live = {
			...money,
			points: money.points.map((point, at) =>
				at === 2 ? { label: "Nov", value: { query: "bank/balance", example: 61000 } } : point,
			),
		};
		await openLive("curve", live, db);
		drawFrames(100);
		expect(big()).toBe("61,000");
		expect(under()).toBe("nowassumed");
	});

	it("draws a live value with no answer yet as not known, with no number", async () => {
		const live = {
			...money,
			points: money.points.map((point, at) =>
				at === 2 ? { label: "Nov", value: { query: "bank/balance" } } : point,
			),
		};
		await openLive("curve", live, databases({}));
		await settle(3000);
		expect(big()).toBe("?");
		expect(under()).toBe("nownot known");
	});
});

describe("the stack kit's engine", () => {
	const stack = JSON.stringify({
		lang: "en",
		title: "Wants your yes",
		cards: [
			{ id: "parts", title: "Pay the parts bill?", value: 4200, unit: "kr", line: "Due Friday", by: "Mads" },
			{ id: "vat", title: "Send the VAT return?", value: 3120, unit: "kr", by: "Co-Founder" },
			{ id: "box", title: "Order new boxes?", value: 900, unit: "kr", answer: "Yes" },
		],
	});
	const ask = (id: string, title: string, labels = ["No", "Yes"]): Question => ({
		id,
		agent: "Mads",
		title,
		body: "",
		options: labels.map((label) => ({ label, value: label.toLowerCase(), description: "" })),
		multiSelect: false,
	});
	const PARTS = ask("q-parts", "Pay the parts bill?", ["No", "Change", "Yes"]);
	const VAT = ask("q-vat", "Send the VAT return?");
	const front = () => document.querySelector(".st-card h2")?.textContent;
	const buttons = () => [...document.querySelectorAll<HTMLButtonElement>(".st-acts .st-b")];

	it("draws a card's open question as its buttons, the last the main one, and answers it from a press", async () => {
		const { qorpera } = await open("stack", stack, (bridge) => {
			bridge.questions = [PARTS, VAT];
		});
		expect(front()).toBe("Pay the parts bill?");
		expect(document.querySelector(".st-num b")?.textContent).toBe("4,200");
		expect(buttons().map((button) => button.textContent)).toEqual(["No", "Change", "Yes"]);
		expect(buttons().map((button) => button.classList.contains("main"))).toEqual([false, false, true]);
		// Nothing answers by itself.
		await settle(60000);
		expect(qorpera.answer).not.toHaveBeenCalled();
		buttons()[2]?.click();
		// One answer a press: the other buttons wait.
		buttons()[0]?.click();
		await settle();
		expect(qorpera.answer).toHaveBeenCalledTimes(1);
		expect(qorpera.answer).toHaveBeenCalledWith("q-parts", "yes");
		// The card is stamped with the answer, then the next comes forward.
		expect(document.querySelector(".st-stamp")?.textContent).toBe("Yes");
		await settle(1200);
		expect(front()).toBe("Send the VAT return?");
		expect(document.querySelectorAll(".st-dot.done")).toHaveLength(2);
		buttons()[1]?.click();
		await settle(1200);
		expect(qorpera.answer).toHaveBeenLastCalledWith("q-vat", "yes");
		expect(document.querySelector(".st-done h2")?.textContent).toBe("Nothing waits on you");
		expect(document.querySelector(".st-done p")?.textContent).toBe("3 answered");
	});

	it("says why an answer did not go, and keeps the card and its buttons", async () => {
		const { qorpera } = await open("stack", stack, (bridge) => {
			bridge.questions = [PARTS];
		});
		qorpera.answer.mockRejectedValueOnce(new Error("The member said not now."));
		buttons()[2]?.click();
		await settle(2000);
		expect(document.querySelector(".st-why")?.textContent).toBe("The member said not now.");
		expect(front()).toBe("Pay the parts bill?");
		expect(buttons().every((button) => !button.disabled)).toBe(true);
	});

	it("shows no button for a card whose question is not open", async () => {
		await open("stack", stack);
		expect(front()).toBe("Pay the parts bill?");
		expect(buttons()).toHaveLength(0);
		expect(document.querySelector(".st-wait")?.textContent).toBe("Not asked yet");
	});

	it("finds a card's question by its whole title, also one longer than a card shows", async () => {
		const title = "Pay the October parts bill from Nordic Supply AS?";
		const { qorpera } = await open(
			"stack",
			JSON.stringify({
				lang: "en",
				title: "Wants your yes",
				cards: [{ id: "parts", title, value: 4200, unit: "kr" }],
			}),
			(bridge) => {
				bridge.questions = [ask("q-long", title)];
			},
		);
		// The card shows its title cut, and still holds the question: one card, not a second one for the question.
		expect(front()).toBe("Pay the October parts bill from Nordic Supply A…");
		expect(document.querySelector(".st-dots")).toBeNull();
		expect(document.querySelector(".st-wait")).toBeNull();
		expect(buttons().map((button) => button.textContent)).toEqual(["No", "Yes"]);
		buttons()[1]?.click();
		await settle(1200);
		expect(qorpera.answer).toHaveBeenCalledWith("q-long", "yes");
		expect(document.querySelector(".st-done h2")?.textContent).toBe("Nothing waits on you");
	});

	it("keeps a question answered on the page gone when a read still lists it", async () => {
		const { change, qorpera } = await open(
			"stack",
			JSON.stringify({
				lang: "en",
				title: "Wants your yes",
				cards: [{ id: "parts", title: "Pay the parts bill?" }],
			}),
			(bridge) => {
				bridge.questions = [PARTS];
			},
		);
		buttons()[2]?.click();
		await settle(1200);
		expect(qorpera.answer).toHaveBeenCalledWith("q-parts", "yes");
		// The read began before the answer: it still lists the question, which is drawn as no card of its own.
		change();
		await settle(10000);
		expect(qorpera.questions.mock.calls.length).toBeGreaterThan(1);
		expect(document.querySelector(".st-done h2")?.textContent).toBe("Nothing waits on you");
		expect(document.querySelector(".st-done p")?.textContent).toBe("1 answered");
		expect(buttons()).toHaveLength(0);
		expect(qorpera.answer).toHaveBeenCalledTimes(1);
	});

	it("gives a new question of a done card's title a card of its own", async () => {
		const { now, change, qorpera } = await open(
			"stack",
			JSON.stringify({
				lang: "en",
				title: "Wants your yes",
				cards: [
					{ id: "box", title: "Order new boxes?", answer: "Yes" },
					{ id: "parts", title: "Pay the parts bill?" },
				],
			}),
			(bridge) => {
				bridge.questions = [ask("q-box-2", "Order new boxes?"), PARTS];
			},
		);
		// The done card keeps its answer; this month's ask of the same title is open, a card of its own.
		expect(document.querySelectorAll(".st-dot.done")).toHaveLength(1);
		expect(document.querySelectorAll(".st-dot:not(.done)")).toHaveLength(2);
		expect(front()).toBe("Pay the parts bill?");
		buttons()[2]?.click();
		await settle(1200);
		expect(qorpera.answer).toHaveBeenLastCalledWith("q-parts", "yes");
		expect(front()).toBe("Order new boxes?");
		expect(buttons().map((button) => button.textContent)).toEqual(["No", "Yes"]);
		// A card answered on this page is done too: the next ask of its title is again a card of its own.
		now.questions = [ask("q-box-2", "Order new boxes?"), ask("q-parts-2", "Pay the parts bill?")];
		change();
		await settle(10000);
		expect(document.querySelectorAll(".st-dot.done")).toHaveLength(2);
		expect(document.querySelectorAll(".st-dot:not(.done)")).toHaveLength(2);
		expect(buttons()).toHaveLength(2);
	});

	it("takes a card whose question was answered in the chat as done, and shows an open question no card names", async () => {
		const { now, change } = await open("stack", stack, (bridge) => {
			bridge.questions = [PARTS, ask("q-other", "Hire a photographer?")];
		});
		expect(document.querySelectorAll(".st-dot:not(.done)")).toHaveLength(3);
		now.questions = [ask("q-other", "Hire a photographer?")];
		change();
		await settle(10000);
		// parts went: answered elsewhere; the question no card names is a card of its own, before the cards not asked
		expect(front()).toBe("Hire a photographer?");
		expect(document.querySelectorAll(".st-dot.done")).toHaveLength(2);
		expect(buttons().map((button) => button.textContent)).toEqual(["No", "Yes"]);
	});

	it("asks for the questions again ten seconds after the call failed, until it works, and then waits", async () => {
		const { now, qorpera } = await open("stack", stack, (bridge) => {
			bridge.questions = new Error("Too many calls");
		});
		expect(buttons()).toHaveLength(0);
		now.questions = [PARTS];
		await settle(10000);
		expect(qorpera.questions).toHaveBeenCalledTimes(2);
		expect(buttons()).toHaveLength(3);
		await settle(60000);
		expect(qorpera.questions).toHaveBeenCalledTimes(2);
		expect(qorpera.read).toHaveBeenCalledTimes(1);
	});

	it("draws a card's live value, and again at once when it moves", async () => {
		const data = {
			lang: "en",
			title: "Bills",
			cards: [
				{
					id: "a",
					title: "Remind Café Nordlys?",
					paper: true,
					value: { query: "shop/owed", column: "amount" },
					unit: "kr",
				},
			],
			total: { value: { query: "shop/owed", column: "total" }, label: "owed to us" },
		};
		const db = databases({ "shop/owed": { amount: 3480, total: 9840 } });
		await openLive("stack", data, db);
		expect(document.querySelector(".st-card.paper .st-num b")?.textContent).toBe("3,480");
		expect(document.querySelector(".st-total-n")?.textContent).toBe("9,840");
		db.set("shop/owed", { amount: 3500, total: 9860 });
		drawFrames();
		await settle();
		expect(document.querySelector(".st-card.paper .st-num b")?.textContent).toBe("3,500");
		expect(document.querySelector(".st-total-n")?.textContent).toBe("9,860");
	});
});

describe("the shelf kit's engine", () => {
	const shelf = {
		lang: "en",
		title: "Lamps in stock",
		unit: "in stock",
		things: [
			{ id: "desk", name: "Desk lamp", value: 212, max: 240, low: 20 },
			{ id: "mushroom", name: "Mushroom lamp", value: 9, max: 240, low: 20, note: "Order more?", by: "Mads" },
			{ id: "floor", name: "Floor lamp", state: "unknown", max: 240 },
		],
	};
	const thing = (id: string) => document.querySelector(`.sh-thing[data-id="${id}"]`);

	it("stands each thing on the shelf with a level behind it, a low one warm, and a hole where it is not known", async () => {
		await open("shelf", JSON.stringify(shelf));
		// the numbers count to their figures as the page opens
		drawFrames(100);
		expect(document.querySelectorAll(".sh-thing")).toHaveLength(3);
		expect((thing("desk")?.querySelector(".sh-level") as HTMLElement).style.height).toBe("83%");
		expect(thing("desk")?.querySelector(".sh-num b")?.textContent).toBe("212");
		expect(thing("mushroom")?.querySelector(".sh-level")?.classList.contains("low")).toBe(true);
		expect(thing("mushroom")?.querySelector(".sh-num")?.classList.contains("low")).toBe(true);
		expect(thing("mushroom")?.querySelector(".sh-note")?.textContent).toBe("MOrder more?");
		expect(thing("floor")?.querySelector(".sh-level")?.classList.contains("unk")).toBe(true);
		expect(thing("floor")?.querySelector(".sh-num b")?.textContent).toBe("?");
		// a picture the page does not name is a quiet placeholder
		expect(thing("desk")?.querySelector(".sh-ph")).not.toBeNull();
	});

	it("opens a thing larger, and closes it again with Escape, the focus back on the thing", async () => {
		await open("shelf", JSON.stringify(shelf));
		(thing("mushroom") as HTMLButtonElement).click();
		expect(document.querySelector(".sh-sheet.is-open h2")?.textContent).toBe("Mushroom lamp");
		expect(thing("mushroom")?.getAttribute("aria-expanded")).toBe("true");
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(document.querySelector(".sh-sheet.is-open")).toBeNull();
		expect(document.activeElement).toBe(thing("mushroom"));
	});

	it("shows the agent's figure the page carries, and the maker's under a thing with no level", async () => {
		const crown = document.createElement("div");
		crown.id = "kit-media";
		crown.hidden = true;
		crown.innerHTML = '<img data-kit-src="figure:crown" src="data:image/webp;base64,AA==" alt="">';
		document.body.append(crown);
		await open(
			"shelf",
			JSON.stringify({
				lang: "en",
				title: "Made",
				things: [{ id: "box", name: "New box", by: "Theo", figure: "crown" }],
			}),
		);
		expect(document.querySelector(".sh-frame")).not.toBeNull();
		expect(document.querySelector(".sh-maker img")?.getAttribute("src")).toBe("data:image/webp;base64,AA==");
		expect(document.querySelector(".sh-maker")?.textContent).toBe("Theo");
		// the page keeps the pictures it names where they are
		expect(document.getElementById("kit-media")).not.toBeNull();
	});

	it("draws a thing's live value and its level, and again at once when it moves", async () => {
		const data = {
			...shelf,
			things: [{ id: "desk", name: "Desk lamp", max: 200, low: 20, value: { query: "shop/stock", column: "desk" } }],
		};
		const db = databases({ "shop/stock": { desk: 150 } });
		await openLive("shelf", data, db);
		drawFrames(100);
		expect(thing("desk")?.querySelector(".sh-num b")?.textContent).toBe("150");
		expect((thing("desk")?.querySelector(".sh-level") as HTMLElement).style.height).toBe("71%");
		db.set("shop/stock", { desk: 12 });
		drawFrames();
		await settle();
		expect(thing("desk")?.querySelector(".sh-num b")?.textContent).toBe("12");
		expect(thing("desk")?.querySelector(".sh-num")?.classList.contains("low")).toBe(true);
	});
});

describe("the map kit's engine", () => {
	/* The company, or an owner's area, as a picture (Jonas, 15 November 2026: "Use a map kit"): its things as shapes
	 * that fill, the agents' figures at them, layers to dive into; the company's own map takes its first layer from
	 * qorpera.reading(). */
	const agent = (name: string, figure: string, working = false) => ({ name, figure, working });
	const reading = (over: Record<string, unknown> = {}) => ({
		reading: {
			sentence: "We know what a workshop needs and have a repair tracker on paper.",
			line: "One thing waits for you.",
			attention: "tracker",
			things: [
				{
					key: "needs",
					name: "What workshops need",
					shape: "factory",
					full: 62,
					state: "One workshop known",
					agents: [agent("Customer research", "heart")],
					waits: [],
				},
				{
					key: "tracker",
					name: "The repair tracker",
					shape: "board",
					full: 34,
					state: "On paper",
					agents: [agent("Product", "puzzle", true), agent("Engineering", "bolt")],
					waits: [],
				},
				{
					key: "money",
					name: "Money",
					shape: "coin",
					full: 14,
					state: "Waits for you",
					agents: [agent("Strategy", "puzzle")],
					waits: [{ name: "Jonas Krüger", me: true }],
				},
			],
			changes: [{ agent: { name: "Sales", figure: "rocket" }, what: "joined", line: "Sales joined" }],
			notes: [],
		},
		team: [
			agent("Product", "puzzle", true),
			{ ...agent("Co-Founder", "crown"), cofounder: true },
			agent("Strategy", "puzzle"),
		],
		standing: { stopped: false, since: null, why: null, member: null, resetsAt: null },
		...over,
	});
	const company = (layers: Record<string, unknown> = {}) => JSON.stringify({ lang: "en", top: "reading", layers });
	const parts = {
		tracker: {
			line: "Its parts",
			things: [
				{ id: "jobs", name: "Job list", shape: "board", full: 60, agents: ["Product"] },
				{ id: "login", name: "Sign-in", shape: "code", full: 80, seen: "2026-10-20" },
				{ id: "sms", name: "Text the customer", shape: "chat", state: "assumed" },
				{ id: "pay", name: "Payments", shape: "coin", state: "unknown" },
				{ id: "costs", name: "What it costs", shape: "chart", opens: "app:business-model" },
			],
		},
		jobs: { things: [{ id: "list", name: "The list", shape: "document", full: 40 }] },
	};
	/** The map opened as the frame opens it, with the figures its page carries and the bridge's reading and note. */
	async function openMap(file: string, answer: unknown, tell?: Mock) {
		const media = document.createElement("div");
		media.id = "kit-media";
		media.hidden = true;
		media.innerHTML = ["crown", "heart", "puzzle", "bolt", "rocket"]
			.map((id) => `<img data-kit-src="figure:${id}" src="data:image/webp;base64,${id}" alt="">`)
			.join("");
		document.body.append(media);
		const bridge = standIn(file);
		const said = { answer };
		const read = vi.fn(async () => said.answer);
		page.QORPERA_KIT = { app: "company", kit: "map", data: "map.json" };
		page.qorpera = { ...bridge.qorpera, reading: read, ...(tell ? { tell } : {}) };
		new Function(kitFile("map", "engine.js"))();
		await settle();
		return { ...bridge, read, said };
	}
	const thing = (id: string) => document.querySelector<HTMLElement>(`.mp-thing[data-id="${id}"]`);

	beforeEach(() => {
		vi.setSystemTime(new Date("2026-11-15T12:00:00Z"));
	});

	it("draws the company's reading: its sentence, the attended thing biggest in the middle, the agents at their things", async () => {
		await openMap(company(), reading());
		expect(document.querySelector("h1")?.textContent).toBe(
			"We know what a workshop needs and have a repair tracker on paper.",
		);
		expect(document.querySelector(".mp-line")?.textContent).toBe("One thing waits for you.");
		const size = (id: string) =>
			Number.parseFloat((thing(id)?.querySelector(".mp-shape") as HTMLElement).style.width);
		// three things at 1052 px: the attended one is the table's first slot, 230 units, in the middle
		expect(size("tracker")).toBe(230);
		expect(size("needs")).toBe(150);
		const middle =
			Number.parseFloat(thing("tracker")?.style.left ?? "0") +
			Number.parseFloat(thing("tracker")?.style.width ?? "0") / 2;
		expect(middle).toBe(526);
		expect((thing("tracker")?.querySelector(".mp-fill") as HTMLElement).style.height).toBe("34%");
		expect(thing("tracker")?.querySelector(".mp-label")?.textContent).toBe("On paper");
		// each agent as its figure, a working one with its mark; the member a thing waits for by a face
		const names = [...document.querySelectorAll(".mp-canvas .mp-fig")].map((fig) => fig.getAttribute("aria-label"));
		expect(names).toEqual(["Product, working", "Engineering", "Customer research", "Strategy", "Jonas Krüger"]);
		expect(document.querySelector('.mp-canvas .mp-fig[aria-label="Product, working"] img')?.getAttribute("src")).toBe(
			"data:image/webp;base64,puzzle",
		);
		expect(document.querySelector('.mp-canvas .mp-fig[aria-label="Product, working"] .mp-dot')).not.toBeNull();
		expect(document.querySelector(".mp-face.me")?.textContent).toBe("JK");
		// what changed, quietly; with no tell on the bridge, no "Not right?"
		expect(document.querySelector(".mp-changes")?.textContent).toBe("Sales joined");
		expect(document.querySelector(".mp-pill")).toBeNull();
	});

	it('asks "Not right?" as a draft the member sends from the bar, never by itself', async () => {
		const tell = vi.fn(async () => ({ sent: true }));
		await openMap(company(), reading(), tell);
		const pill = document.querySelector<HTMLButtonElement>(".mp-pill");
		expect(pill?.textContent).toBe("Not right?");
		expect(tell).not.toHaveBeenCalled();
		pill?.click();
		await settle();
		expect(tell).toHaveBeenCalledWith({
			about: "We know what a workshop needs and have a repair tracker on…",
			text: "Not right: Sales joined.",
		});
		expect(document.querySelector(".mp-pill")?.textContent).toBe("Sent");
	});

	it("stands the team in a row, the Co-Founder first, before the company's first reading", async () => {
		await openMap(company(), reading({ reading: null }));
		expect(document.querySelector("h1")?.textContent).toBe(
			"We are finding our feet. The first reading comes with the next plan.",
		);
		expect(document.querySelector(".mp-thing")).toBeNull();
		expect([...document.querySelectorAll(".mp-canvas .mp-fig")].map((fig) => fig.getAttribute("aria-label"))).toEqual(
			["Co-Founder", "Product, working", "Strategy"],
		);
	});

	it("says whose login holds the company only when the reading says so, and no one's when nobody can be named", async () => {
		// review r1 of #1847, F3: a null member is not "you"
		const line = async (standing: Record<string, unknown>) => {
			await openMap(
				company(),
				reading({
					standing: { stopped: true, since: null, why: "sign_in", resetsAt: null, ...standing },
				}),
			);
			const said = document.querySelector(".mp-line")?.textContent;
			document.body.replaceChildren();
			return said;
		};
		expect(await line({ you: true, member: null })).toBe("Your ChatGPT needs a new sign-in, so none of us can work.");
		expect(await line({ you: false, member: "Sofie Lund" })).toBe(
			"Sofie's ChatGPT needs a new sign-in, so none of us can work.",
		);
		expect(await line({ you: false, member: null })).toBe(
			"A ChatGPT login needs a new sign-in, so none of us can work.",
		);
	});

	it("turns grey and still while the company stands still, and says since when and why", async () => {
		await openMap(
			company(),
			reading({
				standing: {
					stopped: true,
					since: "2026-11-15T09:10:00Z",
					why: "login_full",
					member: "Sofie Lund",
					resetsAt: "2026-11-20T09:00:00Z",
				},
			}),
		);
		expect(document.querySelector("main")?.classList.contains("is-still")).toBe(true);
		expect(document.querySelector("h1")?.textContent).toMatch(/^We have stood still since .+\.$/);
		expect(document.querySelector(".mp-line")?.textContent).toBe(
			"Sofie's ChatGPT is full, so none of us can work. It opens again on November 20.",
		);
		// no working marks, no change line
		expect(document.querySelector(".mp-label")).not.toBeNull();
		expect(document.querySelector(".mp-dot")).toBeNull();
		expect((document.querySelector(".mp-changes") as HTMLElement).hidden).toBe(true);
	});

	it("opens a thing into its layer, names the way back, and goes up with Escape to the thing it came from", async () => {
		await openMap(company(parts), reading());
		const dive = thing("tracker")?.querySelector<HTMLButtonElement>("button.mp-hit");
		expect(dive?.getAttribute("aria-label")).toBe("The repair tracker, On paper, opens");
		// a thing with no layer does not open
		expect(thing("needs")?.querySelector("button")).toBeNull();
		dive?.click();
		expect(document.querySelector("h1")?.textContent).toBe("The repair tracker");
		expect(document.querySelector(".mp-line")?.textContent).toBe("Its parts");
		expect(document.querySelector(".mp-trail")?.textContent).toBe(
			"We know what a workshop needs and have…›The repair tracker",
		);
		expect(document.querySelectorAll(".mp-thing")).toHaveLength(5);
		// where you are: the opened thing's own shape, small, filled as far as it is, beside the title; no ground
		const here = document.querySelector<HTMLElement>(".mp-here");
		expect(here?.hidden).toBe(false);
		expect(here?.getAttribute("aria-hidden")).toBe("true");
		expect((here?.querySelector(".mp-fill") as HTMLElement).style.height).toBe("34%");
		expect(document.querySelector(".mp-ground")).toBeNull();
		// an agent named in the data is drawn as the team's figure; a stale thing by its age; open and assumed things
		expect(document.querySelector('.mp-canvas .mp-fig[aria-label="Product, working"]')).not.toBeNull();
		expect(thing("login")?.classList.contains("is-stale")).toBe(true);
		expect(thing("login")?.querySelector(".mp-label")?.textContent).toBe("3 w");
		expect(thing("pay")?.classList.contains("is-unknown")).toBe(true);
		expect((thing("pay")?.querySelector(".mp-q") as HTMLElement).hidden).toBe(false);
		// a thing not known, or only assumed, is its outline alone: the coin's dashed path has no cut, its whole one has
		const subpaths = (id: string, which: string) =>
			thing(id)?.querySelector(`.${which} path`)?.getAttribute("d")?.match(/M/g)?.length;
		expect(subpaths("pay", "mp-dash")).toBe(1);
		expect(subpaths("pay", "mp-solid")).toBe(2);
		expect(subpaths("sms", "mp-pale")).toBe(1);
		expect(thing("sms")?.classList.contains("is-assumed")).toBe(true);
		expect(thing("costs")?.querySelector("a.mp-hit")?.getAttribute("href")).toBe("app:business-model");
		// one layer further, then back up one at a time
		thing("jobs")?.querySelector<HTMLButtonElement>("button.mp-hit")?.click();
		expect(document.querySelector("h1")?.textContent).toBe("Job list");
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		await settle();
		expect(document.querySelector("h1")?.textContent).toBe("The repair tracker");
		const up = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
		document.dispatchEvent(up);
		expect(up.defaultPrevented).toBe(true);
		await settle();
		expect(document.querySelector("h1")?.textContent).toBe(
			"We know what a workshop needs and have a repair tracker on paper.",
		);
		expect(document.activeElement).toBe(thing("tracker")?.querySelector("button.mp-hit"));
		expect((document.querySelector(".mp-here") as HTMLElement).hidden).toBe(true);
		// at the first layer Escape is the frame's again
		const last = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
		document.dispatchEvent(last);
		expect(last.defaultPrevented).toBe(false);
	});

	it("keeps the open layer through a change of the company, and moves what changed", async () => {
		const map = await openMap(company(parts), reading());
		thing("tracker")?.querySelector<HTMLButtonElement>("button.mp-hit")?.click();
		const jobs = thing("jobs");
		map.said.answer = reading({ team: [agent("Product", "puzzle", false)] });
		map.change();
		await settle(10000);
		expect(map.read).toHaveBeenCalledTimes(2);
		expect(document.querySelector("h1")?.textContent).toBe("The repair tracker");
		expect(thing("jobs")).toBe(jobs);
		expect(document.querySelector('.mp-canvas .mp-fig[aria-label="Product"]')).not.toBeNull();
	});

	it("draws an owner's own map from its data, with nobody standing where the company has no such agent", async () => {
		await openMap(
			JSON.stringify({
				lang: "en",
				top: {
					title: "Sales",
					attention: "leads",
					things: [
						{ id: "leads", name: "Leads", shape: "people", full: 30, agents: ["Strategy", "Nobody"] },
						{ id: "deals", name: "Deals", shape: "handshake", full: 10, waits: true },
						{ id: "ads", name: "Ads", shape: "megaphone", state: "unknown" },
					],
				},
			}),
			reading(),
		);
		expect(document.querySelector("h1")?.textContent).toBe("Sales");
		const names = [...document.querySelectorAll(".mp-canvas .mp-fig")].map((fig) => fig.getAttribute("aria-label"));
		expect(names).toEqual(["Strategy", "waits for a founder"]);
		// the founder it waits for is the member's accent mark, as on the company's map
		expect(document.querySelector(".mp-face.founder")).not.toBeNull();
		// an owner's map has no change line
		expect((document.querySelector(".mp-changes") as HTMLElement).hidden).toBe(true);
	});

	it("stacks the things in one column, the attended one first, under 720 px", async () => {
		resize(390, 844);
		await openMap(company(), reading());
		expect(document.querySelector(".mp-canvas")?.classList.contains("is-column")).toBe(true);
		const tops = ["tracker", "needs", "money"].map((id) => Number.parseFloat(thing(id)?.style.top ?? "0"));
		expect(tops[0]).toBeLessThan(tops[1] ?? 0);
		expect(tops[1]).toBeLessThan(tops[2] ?? 0);
	});
});

describe("the map kit's way back", () => {
	it("goes up by the path at the top, each step a button, and leaves the browser's history alone", async () => {
		const pushes = vi.spyOn(history, "pushState");
		const goes = vi.spyOn(history, "go");
		page.QORPERA_KIT = { app: "own", kit: "map", data: "map.json" };
		page.qorpera = standIn(
			JSON.stringify({
				lang: "en",
				top: {
					title: "Sales",
					attention: "leads",
					things: [
						{ id: "leads", name: "Leads", shape: "people", full: 30 },
						{ id: "deals", name: "Deals", shape: "handshake", full: 10 },
						{ id: "ads", name: "Ads", shape: "megaphone", full: 5 },
					],
				},
				layers: { leads: { things: [{ id: "list", name: "The list", shape: "document", full: 40 }] } },
			}),
		).qorpera;
		new Function(kitFile("map", "engine.js"))();
		await settle();
		document.querySelector<HTMLButtonElement>('.mp-thing[data-id="leads"] button.mp-hit')?.click();
		expect(document.querySelector("h1")?.textContent).toBe("Leads");
		const crumb = document.querySelector<HTMLButtonElement>(".mp-trail button.mp-crumb");
		expect(crumb?.textContent).toBe("Sales");
		crumb?.click();
		expect(document.querySelector("h1")?.textContent).toBe("Sales");
		expect(document.activeElement).toBe(document.querySelector('.mp-thing[data-id="leads"] button.mp-hit'));
		expect(pushes).not.toHaveBeenCalled();
		expect(goes).not.toHaveBeenCalled();
	});
});

describe("the ring kit's engine", () => {
	const year = {
		lang: "en",
		title: "Our year",
		span: "year",
		start: "2026-01-01",
		now: "2026-11-15",
		unit: "kr",
		marks: [
			{ name: "VAT return", at: "2026-03-01", tone: "warm" },
			{ name: "Lamp launch", at: "2026-10-08", tone: "good" },
			{ name: "Black Friday", at: "2026-11-27" },
			{ name: "VAT return", at: "2026-12-01", tone: "warm", value: 41800 },
			// outside the year: not drawn
			{ name: "VAT return", at: "2027-03-01" },
		],
		wedges: [
			{ name: "Summer break", from: "2026-07-06", to: "2026-07-31", tone: "teal" },
			{ name: "Christmas season", from: "2026-11-15", to: "2026-12-24", tone: "warm" },
		],
	};
	const big = () => document.querySelector(".rk-n")?.textContent;
	const unit = () => document.querySelector(".rk-u")?.textContent ?? "";
	const what = () => document.querySelector(".rk-what")?.textContent;
	const when = () => document.querySelector(".rk-when")?.textContent;
	const stage = () => document.querySelector<HTMLElement>(".rk-stage");
	const key = (name: string) => stage()?.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));

	it("draws the year's months, the part gone by, its marks and wedges, the hand, and the next thing in the middle", async () => {
		await open("ring", JSON.stringify(year));
		expect(document.querySelectorAll(".rk-seg")).toHaveLength(12);
		// January to October are gone by on the 15th of November
		expect(document.querySelectorAll(".rk-seg.gone")).toHaveLength(10);
		expect(document.querySelector(".rk-tick.now")?.textContent).toBe("Nov");
		expect(document.querySelectorAll(".rk-mark")).toHaveLength(4);
		expect(document.querySelectorAll(".rk-mark.gone")).toHaveLength(2);
		expect(document.querySelectorAll(".rk-wedge")).toHaveLength(2);
		expect(document.querySelector(".rk-hand")).not.toBeNull();
		// the next thing: a mark today or later, or a wedge not yet begun; a wedge that begins today is going on
		expect([big(), unit(), what(), when()]).toEqual(["12", "days", "to Black Friday", "Nov 27"]);
		expect(document.querySelector(".rk-mark.next")).not.toBeNull();
		expect(stage()?.getAttribute("aria-valuetext")).toBe("12 days, to Black Friday, Nov 27");
	});

	it("lets the middle follow the arrow keys round the ring, and Escape bring back the next thing", async () => {
		await open("ring", JSON.stringify(year));
		expect(stage()?.getAttribute("role")).toBe("slider");
		key("ArrowRight");
		// a mark with an amount shows it
		expect([big(), unit(), what(), when()]).toEqual(["41,800", "kr", "VAT return", "Dec 1"]);
		expect(document.querySelector(".rk.picking")).not.toBeNull();
		key("ArrowLeft");
		key("ArrowLeft");
		// a wedge going on now: the days left of it
		expect([big(), unit(), what(), when()]).toEqual(["40", "days", "left of Christmas season", "Nov 15 – Dec 24"]);
		key("Home");
		// a mark gone by: its day, and how long ago
		expect([big(), what(), when()]).toEqual(["Mar 1", "VAT return", "259 days ago"]);
		key("Escape");
		expect([big(), what()]).toEqual(["12", "to Black Friday"]);
		expect(document.querySelector(".rk.picking")).toBeNull();
	});

	it("turns with the pointer: the middle shows the mark near it, else the wedge it is in", async () => {
		await open("ring", JSON.stringify(year));
		// jsdom lays nothing out: the ring is as wide as the window lets it be, its middle half of that
		const size = Number.parseFloat(stage()?.style.width ?? "0");
		const c = size / 2;
		const at = (day: number, r: number) => {
			const a = (day / 365) * Math.PI * 2;
			return { clientX: c + r * Math.sin(a), clientY: c - r * Math.cos(a), bubbles: true };
		};
		const r = c - 50;
		// 8 October is the 281st day of the year
		stage()?.dispatchEvent(new MouseEvent("pointermove", at(280.5, r)));
		expect(what()).toBe("Lamp launch");
		// mid July, inside the summer break, far from any mark
		stage()?.dispatchEvent(new MouseEvent("pointermove", at(200, r)));
		expect(what()).toBe("Summer break");
		// in the middle: nothing is picked, and the next thing comes back
		stage()?.dispatchEvent(new MouseEvent("pointermove", { clientX: c, clientY: c, bubbles: true }));
		expect(what()).toBe("to Black Friday");
	});

	it("draws a week's wedges as far out as their amounts, one not known open with a question mark", async () => {
		const week = {
			lang: "en",
			title: "Sales this week",
			span: "week",
			start: "2026-11-16",
			now: "2026-11-18",
			centre: { value: 15000, unit: "kr", label: "this week" },
			wedges: [
				{ name: "Monday", from: "2026-11-16", value: 3000 },
				{ name: "Tuesday", from: "2026-11-17", value: 6000 },
				{ name: "Wednesday", from: "2026-11-18", state: "unknown" },
			],
		};
		await open("ring", JSON.stringify(week));
		expect(document.querySelectorAll(".rk-seg")).toHaveLength(7);
		expect([...document.querySelectorAll(".rk-tick")].map((tick) => tick.textContent)).toEqual([
			"Mon",
			"Tue",
			"Wed",
			"Thu",
			"Fri",
			"Sat",
			"Sun",
		]);
		expect(document.querySelectorAll(".rk-wedge.unk")).toHaveLength(1);
		expect(document.querySelector(".rk-q")?.textContent).toBe("?");
		// Tuesday's amount is twice Monday's, and reaches twice as far out from the inner edge
		const outer = (index: number) => {
			const d = document.querySelectorAll(".rk-wedge")[index]?.getAttribute("d") ?? "";
			const [, x, y] = /^M([\d.-]+) ([\d.-]+)/.exec(d) ?? [];
			return Math.hypot(
				Number(x) - Number.parseFloat(stage()?.style.width ?? "0") / 2,
				Number(y) - Number.parseFloat(stage()?.style.width ?? "0") / 2,
			);
		};
		const inner = (index: number) => {
			const d = document.querySelectorAll(".rk-wedge")[index]?.getAttribute("d") ?? "";
			const [, rin] = /L[\d.-]+ [\d.-]+A([\d.-]+)/.exec(d) ?? [];
			return Number(rin);
		};
		expect((outer(1) - inner(1)) / (outer(0) - inner(0))).toBeCloseTo(2, 1);
		// the middle holds the given number while nobody points
		expect([big(), unit(), what()]).toEqual(["15,000", "kr", "this week"]);
		key("End");
		expect([big(), what()]).toEqual(["?", "Wednesday"]);
		expect(document.querySelector(".rk-tag")?.textContent).toBe("not known");
	});

	it("never draws one mark on another: a mark a day after another takes an orbit of its own", async () => {
		const close = {
			...year,
			marks: [
				{ name: "Annual report", at: "2026-05-31" },
				{ name: "VAT return", at: "2026-06-01" },
				{ name: "Payday", at: "2026-06-02" },
			],
		};
		await open("ring", JSON.stringify(close));
		const dots = [...document.querySelectorAll(".rk-mark")].map((dot) => ({
			x: Number(dot.getAttribute("cx")),
			y: Number(dot.getAttribute("cy")),
			r: Number(dot.getAttribute("r")),
		}));
		expect(dots).toHaveLength(3);
		// apart by more than two marks' width, room for a picked one drawn half as large again
		for (const [at, dot] of dots.entries())
			for (const other of dots.slice(at + 1))
				expect(Math.hypot(dot.x - other.x, dot.y - other.y)).toBeGreaterThan(dot.r * 2.9);
		// the pointer finds each where it lies
		for (const [at, dot] of dots.entries()) {
			stage()?.dispatchEvent(new MouseEvent("pointermove", { clientX: dot.x, clientY: dot.y, bubbles: true }));
			expect(what()).toBe(["Annual report", "VAT return", "Payday"][at]);
		}
	});

	it("keeps 12 marks of one day apart and clear of the middle on a phone, each found by the pointer", async () => {
		resize(390, 844);
		const crowd = {
			...year,
			marks: Array.from({ length: 12 }, (_, at) => ({ name: `Due ${at}`, at: "2026-06-01" })),
		};
		await open("ring", JSON.stringify(crowd));
		const c = Number.parseFloat(stage()?.style.width ?? "0") / 2;
		const dots = [...document.querySelectorAll(".rk-mark")].map((dot) => ({
			x: Number(dot.getAttribute("cx")),
			y: Number(dot.getAttribute("cy")),
			r: Number(dot.getAttribute("r")),
		}));
		expect(dots).toHaveLength(12);
		for (const [at, dot] of dots.entries()) {
			// never under the middle's words, never across the ring
			expect(Math.hypot(dot.x - c, dot.y - c)).toBeGreaterThan(c * 0.4);
			for (const other of dots.slice(at + 1))
				expect(Math.hypot(dot.x - other.x, dot.y - other.y)).toBeGreaterThan(dot.r * 2);
			stage()?.dispatchEvent(new MouseEvent("pointermove", { clientX: dot.x, clientY: dot.y, bubbles: true }));
			expect(what()).toBe(`Due ${at}`);
		}
		// the crowd stays round its day, as many drawn before it as after
		const angle = (dot: { x: number; y: number }) => Math.atan2(dot.x - c, c - dot.y);
		const day = angle(dots[0] ?? { x: c, y: 0 });
		expect(dots.filter((dot) => angle(dot) < day - 1e-6).length).toBeGreaterThan(0);
		expect(dots.filter((dot) => angle(dot) > day + 1e-6).length).toBeGreaterThan(0);
	});

	it("draws 12 marks and 8 wedges at most, and only what falls in its span", async () => {
		const many = {
			...year,
			marks: Array.from({ length: 14 }, (_, at) => ({
				name: `Pay ${at}`,
				at: `2026-${String((at % 12) + 1).padStart(2, "0")}-25`,
			})),
			wedges: Array.from({ length: 10 }, (_, at) => ({
				name: `Stretch ${at}`,
				from: `2026-${String(at + 1).padStart(2, "0")}-02`,
				to: `2026-${String(at + 1).padStart(2, "0")}-09`,
			})),
		};
		await open("ring", JSON.stringify(many));
		expect(document.querySelectorAll(".rk-mark")).toHaveLength(12);
		expect(document.querySelectorAll(".rk-wedge")).toHaveLength(8);
	});

	it("draws the middle's live number as known, and again at once when it moves", async () => {
		const live = {
			...year,
			centre: { value: { query: "shop/sales", column: "kr" }, unit: "kr", label: "sold this year" },
		};
		const db = databases({ "shop/sales": { kr: 182400 } });
		const { qorpera } = await openLive("ring", live, db);
		expect([big(), unit(), what()]).toEqual(["182,400", "kr", "sold this year"]);
		db.set("shop/sales", { kr: 190000 });
		drawFrames();
		await settle();
		expect(qorpera.read).toHaveBeenCalledTimes(2);
		expect(big()).toBe("190,000");
	});

	it("draws the middle's live number with no answer yet as not known", async () => {
		const live = {
			...year,
			centre: { value: { query: "shop/sales", column: "kr" }, unit: "kr", label: "sold this year" },
		};
		await openLive("ring", live, databases({}));
		await settle(3000);
		expect([big(), what()]).toEqual(["?", "sold this year"]);
		expect(document.querySelector(".rk-tag")?.textContent).toBe("not known");
	});
});

describe("the flow kit's engine", () => {
	const money = {
		lang: "en",
		title: "Money in November",
		unit: "kr",
		middle: "Bank",
		from: [
			{ id: "shop", name: "Web shop", value: 180000 },
			{ id: "retail", name: "Retailers", value: 60000 },
		],
		to: [
			{ id: "parts", name: "Parts", value: 70000 },
			{ id: "kept", name: "Kept", value: 30000, kept: true },
			{ id: "salaries", name: "Salaries", value: 90000 },
			{ id: "ads", name: "Ads", value: 50000 },
		],
	};
	const big = () => document.querySelector(".fk-n")?.textContent;
	const sub = () => document.querySelector(".fk-sub")?.textContent;
	const names = () => [...document.querySelectorAll(".fk-name")].map((name) => name.textContent);
	const stage = () => document.querySelector<HTMLElement>(".fk-stage");
	const key = (name: string) => stage()?.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
	/** A band's width where it leaves its end: the path's two edges at its start. */
	const width = (index: number) => {
		const d = document.querySelectorAll(".fk-band")[index]?.getAttribute("d") ?? "";
		const numbers = (d.match(/-?[\d.]+/g) ?? []).map(Number);
		// M x y0 C … x1 y1 L x1 y2 C … x y3 Z: the end's edges are y0 and the last y
		return Math.abs((numbers[numbers.length - 1] ?? 0) - (numbers[1] ?? 0));
	};

	it("draws a band for each end through the middle, each as wide as its amount, and all that came in big", async () => {
		await open("flow", JSON.stringify(money));
		expect(document.querySelectorAll(".fk-band")).toHaveLength(6);
		expect(document.querySelector(".fk-mid")).not.toBeNull();
		expect(document.querySelector(".fk-mid-t")?.textContent).toBe("Bank");
		// what is kept stands last, under the rest
		expect(names()).toEqual(["Web shop", "Retailers", "Parts", "Salaries", "Ads", "Kept"]);
		expect(width(0) / width(1)).toBeCloseTo(3, 1);
		expect(width(3) / width(4)).toBeCloseTo(90 / 50, 1);
		// both sides add up: nothing is left over
		expect(document.querySelector(".fk-band.rest")).toBeNull();
		expect(big()).toBe("240,000");
		expect(sub()).toBe("in all");
	});

	it("makes the big number a band's amount and share as the arrow keys step through the bands", async () => {
		await open("flow", JSON.stringify(money));
		expect(stage()?.getAttribute("role")).toBe("slider");
		key("ArrowRight");
		expect([big(), sub()]).toEqual(["180,000", "Web shop75%"]);
		expect(document.querySelectorAll(".fk-band.on")).toHaveLength(1);
		expect(document.querySelector(".fk.picking")).not.toBeNull();
		key("End");
		expect([big(), sub()]).toEqual(["30,000", "Kept13%"]);
		expect(stage()?.getAttribute("aria-valuetext")).toBe("Kept: 30,000 kr");
		key("Escape");
		expect(big()).toBe("240,000");
		expect(document.querySelector(".fk.picking")).toBeNull();
	});

	it("joins the smallest ends past six into one band, Other, and keeps what is kept", async () => {
		const many = {
			...money,
			from: [{ id: "shop", name: "Web shop", value: 36500 }],
			to: [
				...["Parts", "Salaries", "Ads", "Tax", "Rent", "Freight", "Software", "Bank fees"].map((name, at) => ({
					id: `t${at}`,
					name,
					value: (8 - at) * 1000,
				})),
				{ id: "kept", name: "Kept", value: 500, kept: true },
			],
		};
		await open("flow", JSON.stringify(many));
		expect(document.querySelectorAll(".fk-band")).toHaveLength(1 + 6);
		expect(names().slice(1)).toEqual(["Parts", "Salaries", "Ads", "Tax", "Other", "Kept"]);
		// Other is the four smallest together: 4,000 + 3,000 + 2,000 + 1,000
		key("End");
		key("ArrowLeft");
		expect([big(), sub()]).toEqual(["10,000", "Other27%"]);
	});

	it("keeps the band a finger picked when it lifts, and lets a pointer that leaves take it away", async () => {
		await open("flow", JSON.stringify(money));
		const leave = (pointerType: string) => {
			const event = new MouseEvent("pointerleave");
			Object.defineProperty(event, "pointerType", { value: pointerType });
			stage()?.dispatchEvent(event);
		};
		// a name with its bar is a finger's room to pick by, as wide as the name and as tall as a finger
		document
			.querySelector(".fk-lab[data-n=salaries] .fk-hit")
			?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
		expect([big(), sub()]).toEqual(["90,000", "Salaries38%"]);
		leave("touch");
		expect(big()).toBe("90,000");
		leave("mouse");
		expect(big()).toBe("240,000");
	});

	it("draws what one side lacks of the other as a quiet band of its own, in the data's word", async () => {
		// 240,000 came in and 215,000 went out: the 25,000 between is drawn going out, before what is kept
		await open(
			"flow",
			JSON.stringify({ ...money, to: money.to.map((end) => (end.id === "ads" ? { ...end, value: 25000 } : end)) }),
		);
		expect(names()).toEqual(["Web shop", "Retailers", "Parts", "Salaries", "Ads", "Not accounted for", "Kept"]);
		expect(document.querySelectorAll(".fk-band.rest")).toHaveLength(1);
		expect(document.querySelector(".fk-lab.rest .fk-amt")?.textContent).toBe("25,000 kr");
		// it is no end of the company's own: the big number is still what came in
		expect(big()).toBe("240,000");
		key("End");
		key("ArrowLeft");
		// a share of all the side's bands, so the side's shares add up: 25,000 of the 240,000 drawn
		expect([big(), sub()]).toEqual(["25,000", "Not accounted for10%"]);
		document.body.replaceChildren();
		// more out than in: the difference comes in, on the left, in the data's own word
		await open(
			"flow",
			JSON.stringify({
				...money,
				words: { rest: "Unexplained" },
				from: [{ id: "shop", name: "Web shop", value: 200000 }],
			}),
		);
		expect(names().slice(0, 2)).toEqual(["Web shop", "Unexplained"]);
		expect(document.querySelector(".fk-lab.rest .fk-amt")?.textContent).toBe("40,000 kr");
		document.body.replaceChildren();
		// a rounding (1 % at most) is no band
		await open("flow", JSON.stringify({ ...money, from: [{ id: "shop", name: "Web shop", value: 241000 }] }));
		expect(document.querySelector(".fk-band.rest")).toBeNull();
	});

	it("runs bands straight from each source to each end with links, with no middle", async () => {
		const people = {
			lang: "en",
			title: "Visits",
			unit: "visits",
			from: [
				{ id: "google", name: "Google" },
				{ id: "mail", name: "Newsletter" },
			],
			to: [
				{ id: "bought", name: "Bought", tone: "good" },
				{ id: "left", name: "Left" },
			],
			links: [
				{ from: "google", to: "bought", value: 200 },
				{ from: "google", to: "left", value: 3800 },
				{ from: "mail", to: "bought", value: 150 },
				{ from: "mail", to: "left", value: 850 },
			],
		};
		await open("flow", JSON.stringify(people));
		expect(document.querySelectorAll(".fk-band")).toHaveLength(4);
		expect(document.querySelector(".fk-mid")).toBeNull();
		// an end's amount is what its bands carry
		expect([...document.querySelectorAll(".fk-amt")].map((amount) => amount.textContent)).toEqual([
			"4,000 visits",
			"1,000 visits",
			"350 visits",
			"4,650 visits",
		]);
		expect(big()).toBe("5,000");
		key("ArrowRight");
		expect([big(), sub()]).toEqual(["200", "Google → Bought4%"]);
		expect(document.querySelectorAll(".fk-lab.on")).toHaveLength(2);
	});

	it("draws a live amount as known, and again at once when it moves", async () => {
		const live = {
			...money,
			from: [{ id: "shop", name: "Web shop", value: { query: "bank/money_in", column: "amount" } }, money.from[1]],
		};
		const db = databases({ "bank/money_in": { amount: 180000 } });
		const { qorpera } = await openLive("flow", live, db);
		expect(big()).toBe("240,000");
		db.set("bank/money_in", { amount: 200000 });
		drawFrames();
		await settle();
		expect(qorpera.read).toHaveBeenCalledTimes(2);
		expect(big()).toBe("260,000");
	});

	it("draws a live amount with no answer yet as an open band, and no total", async () => {
		const live = {
			...money,
			from: [{ id: "shop", name: "Web shop", value: { query: "bank/money_in", column: "amount" } }, money.from[1]],
		};
		await openLive("flow", live, databases({}));
		await settle(3000);
		expect(big()).toBe("?");
		expect(sub()).toBe("in allnot known");
		expect(document.querySelectorAll(".fk-band.unk")).toHaveLength(1);
		expect(document.querySelector(".fk-q")?.textContent).toBe("?");
	});
});
