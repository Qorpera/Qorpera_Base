// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* The data kits' engines (packages/runtime/kits/{model,board,path,object}/engine.js; RUNTIME-INTERFACE-APPS.md §3b),
 * run in a DOM. save_app writes an engine into an app's folder and the web hands it to the app's frame knowing nothing
 * of it, so it is tested here, where there is a DOM: each engine is driven through a stand-in for the page's bridge,
 * `window.qorpera` (reads that fail and then work, questions that come later, the rows a Save asks for), with the ten
 * seconds of the bridge's pace on a fake clock, and a page that changes size. What they draw is looked at in a browser. */

const KITS = ["model", "board", "path", "object"] as const;
type Kit = (typeof KITS)[number];
// From the web package's own folder, where its tests run.
const kitFile = (kit: Kit, name: string) => readFileSync(resolve(`../runtime/kits/${kit}/${name}`), "utf8");
/** A kit's guide example: the data in its KIT.md, as an agent reads it. */
const example = (kit: Kit) => /```json\n([\s\S]*?)\n```/.exec(kitFile(kit, "KIT.md"))?.[1] ?? "";
const titleOf = (text: string) => (JSON.parse(text) as { title: string }).title;

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

/** An app of the kit opened on a stand-in, as the frame opens it: the page's QORPERA_KIT, then the engine. */
async function open(kit: Kit, file: string | Error, before?: (now: ReturnType<typeof standIn>["now"]) => void) {
	const bridge = standIn(file);
	before?.(bridge.now);
	page.QORPERA_KIT = { app: "demo", kit, data: `${kit}.json` };
	page.qorpera = bridge.qorpera;
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

	it("neither stops nor moves a slider being dragged when a value moves, and keeps an open note open", async () => {
		const db = databases({ "shop/month": { orders: 340 }, "shop/visits": { visits: 4200 } });
		const noted = {
			...orders,
			groups: [
				{
					...orders.groups[0],
					inputs: [{ ...orders.groups[0].inputs[0], note: "Paid orders" }, orders.groups[0].inputs[1]],
				},
			],
		};
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
