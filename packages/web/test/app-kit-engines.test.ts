// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

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

/** Lets what is due run: the page's reads, and its timers up to `ms` from now. */
const settle = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

/** An app of the kit opened on a stand-in, as the frame opens it: the page's QORPERA_KIT, then the engine. A web with
 * a note to the app's owner gives the page's `qorpera` a `tell`; an older one has none. */
async function open(
	kit: Kit,
	file: string | Error,
	before?: (now: ReturnType<typeof standIn>["now"]) => void,
	tell?: Mock,
) {
	const bridge = standIn(file);
	before?.(bridge.now);
	page.QORPERA_KIT = { app: "demo", kit, data: `${kit}.json` };
	page.qorpera = tell ? { ...bridge.qorpera, tell } : bridge.qorpera;
	new Function(kitFile(kit, "engine.js"))();
	await settle();
	return bridge;
}

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

describe("each data kit's note to the app's owner", () => {
	interface Thing {
		readonly id: string;
		readonly name: string;
		readonly ask?: unknown;
	}
	/** Each kit's data with one thing in it, how a member opens the thing's detail, what then shows and how it closes,
	 * what the note is about and which thing it names, and an id the kit keeps that the call's pattern does not take. */
	const KIT_THING: Readonly<
		Record<
			Kit,
			{
				readonly data: (thing: Thing, words: unknown) => string;
				readonly open: (thing: Thing) => void;
				readonly shown: string;
				readonly close: () => void;
				readonly about: (thing: Thing) => string;
				readonly at: (thing: Thing) => string;
				readonly odd: string;
			}
		>
	> = {
		model: {
			data: (thing, words) =>
				JSON.stringify({
					lang: "en",
					title: "Prices",
					words,
					groups: [
						{
							label: "Numbers",
							inputs: [
								{
									id: thing.id,
									label: thing.name,
									unit: "kr",
									min: 0,
									max: 100,
									value: 40,
									state: "known",
									note: "From the supplier's list",
									ask: thing.ask,
								},
							],
						},
					],
				}),
			open: () => press(".mk-label"),
			shown: ".mk-tip.mk-on",
			// a second tap on the label closes its note
			close: () => press(".mk-label"),
			about: (thing) => `${thing.name} · 40 kr`,
			at: (thing) => thing.id,
			odd: "_price",
		},
		board: {
			data: (thing, words) =>
				JSON.stringify({
					lang: "en",
					mode: "scale",
					title: "Prices",
					words,
					items: [{ id: thing.id, name: thing.name, value: 10, ask: thing.ask }],
				}),
			open: (thing) => press(`.bk-item[data-id="${thing.id}"]`),
			shown: ".bk-sheet.is-open",
			close: () => press(".bk-sheet .bk-x"),
			about: (thing) => thing.name,
			at: (thing) => thing.id,
			odd: "two words",
		},
		path: {
			data: (thing, words) =>
				JSON.stringify({
					lang: "en",
					title: "Customers",
					words,
					steps: [{ id: "look", name: "Look" }],
					lanes: [{ id: thing.id, name: thing.name, steps: { look: { state: "known", ask: thing.ask } } }],
				}),
			open: (thing) => press(`.pk-node[data-key="n:${thing.id}:look"]`),
			shown: ".pk-sheet",
			close: () => press(".pk-sheet .pk-x"),
			about: (thing) => `Look · ${thing.name}`,
			at: (thing) => `${thing.id}:look`,
			odd: "two words",
		},
		object: {
			data: (thing, words) =>
				JSON.stringify({
					lang: "en",
					title: "Box",
					picture: "pictures/box.webp",
					words,
					parts: [{ id: thing.id, name: thing.name, track: [[0.5, 0.5, 1]], ask: thing.ask }],
				}),
			open: (thing) => press(`.ok-strip button[data-id="${thing.id}"]`),
			shown: ".ok-note.open",
			close: () => press(".ok-close"),
			about: (thing) => thing.name,
			at: (thing) => thing.id,
			odd: "two words",
		},
	};
	const BUTTON = ".bk-tell-b, .pk-tell-b, .ok-tell-b, .mk-tell-b";
	const WHY = ".bk-tell-why, .pk-tell-why, .ok-tell-why, .mk-tell-why";
	const WORDS = { tell: "Ask Ida", told: "Sent to Ida" };
	const LYS: Thing = { id: "lys", name: "Lys", ask: "Get a quote from them" };
	const press = (selector: string) => document.querySelector<HTMLElement>(selector)?.click();
	const button = () => document.querySelector<HTMLButtonElement>(BUTTON);

	it.each(KITS)("of %s draws no button for a note where the page's bridge has no tell", async (kit) => {
		const thing = KIT_THING[kit];
		await open(kit, thing.data(LYS, WORDS));
		thing.open(LYS);
		expect(document.querySelector(thing.shown)).not.toBeNull();
		expect(button()).toBeNull();
	});

	it.each(KITS)(
		"of %s asks for a note once, from a press on the button at the foot of what a member opened",
		async (kit) => {
			const thing = KIT_THING[kit];
			const tell = vi.fn(async (_note: unknown): Promise<unknown> => ({ sent: true }));
			await open(kit, thing.data(LYS, WORDS), undefined, tell);
			thing.open(LYS);
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

	it.each(KITS)("of %s says for a few seconds why a note did not go, and keeps its button", async (kit) => {
		const thing = KIT_THING[kit];
		const tell = vi.fn(async (_note: unknown): Promise<unknown> => {
			throw new Error("The member said not now.");
		});
		await open(kit, thing.data(LYS, WORDS), undefined, tell);
		thing.open(LYS);
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

	it.each(KITS)("of %s takes the reason a note did not go away at once when the detail closes", async (kit) => {
		const thing = KIT_THING[kit];
		const tell = vi.fn(async (_note: unknown): Promise<unknown> => {
			throw new Error("The member said not now.");
		});
		await open(kit, thing.data(LYS, WORDS), undefined, tell);
		thing.open(LYS);
		button()?.click();
		await settle();
		expect(document.querySelector(WHY)?.textContent).toBe("The member said not now.");
		thing.close();
		expect(document.querySelector(thing.shown)).toBeNull();
		for (const line of document.querySelectorAll(WHY)) expect(line.textContent).toBe("");
		// Opened again before the six seconds are up, the thing shows its button and no reason.
		thing.open(LYS);
		expect(document.querySelector(WHY)?.textContent).toBe("");
		expect(button()?.textContent).toBe("Ask Ida");
	});

	it.each(KITS)(
		"of %s names no thing the call cannot take, sends no draft past 40 characters, and draws a mark without words",
		async (kit) => {
			const thing = KIT_THING[kit];
			const odd: Thing = { id: thing.odd, name: "Lys", ask: "x".repeat(41) };
			const tell = vi.fn(async (_note: unknown): Promise<unknown> => ({ sent: true }));
			// Words that are no text are left out, as a kit's other words are.
			await open(kit, thing.data(odd, { tell: ["Ask Ida"], told: { text: "Sent" } }), undefined, tell);
			thing.open(odd);
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
