// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppGridDrag, gridOrder, orderApps } from "../src/ui/app-grid-drag.ts";
import { h } from "../src/ui/dom.ts";

/* The apps drawer's icons reorder by dragging (Jonas, 9 Nov 2026). jsdom lays nothing out, so each icon's box is
 * taken from where it stands now: four to a row, 50 × 60 each. */

let stop: AbortController;
beforeEach(() => {
	stop = new AbortController();
});
afterEach(() => {
	stop.abort();
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

/** The layout jsdom lacks: four to a row, 50 × 60, measured from the grid (as a positioned grid's icons are). */
function layOut(element: HTMLElement, icon: HTMLElement) {
	const index = () => [...element.children].indexOf(icon);
	Object.defineProperties(icon, {
		offsetParent: { get: () => element },
		offsetLeft: { get: () => (index() % 4) * 50 },
		offsetTop: { get: () => Math.floor(index() / 4) * 60 },
		offsetWidth: { get: () => 50 },
		offsetHeight: { get: () => 60 },
	});
}

function grid(keys: readonly string[]) {
	const element = h("div", { class: "rail-apps-grid" });
	for (const key of keys) {
		const icon = h("a", { class: "rail-app", href: `#/${key}`, "data-app-key": key }, key);
		vi.spyOn(icon, "getBoundingClientRect").mockImplementation(() => {
			const index = [...element.children].indexOf(icon);
			return new DOMRect((index % 4) * 50, Math.floor(index / 4) * 60, 50, 60);
		});
		layOut(element, icon);
		element.append(icon);
	}
	vi.spyOn(element, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 200, 120));
	document.body.append(element);
	return element;
}

function setup(keys: readonly string[], canDrag = () => true) {
	const element = grid(keys);
	const drops: string[][] = [];
	let ends = 0;
	const drag = new AppGridDrag(
		element,
		() => ({ canDrag, drop: (order) => drops.push(order), end: () => ends++ }),
		stop.signal,
	);
	return {
		element,
		drops,
		drag,
		ends: () => ends,
		icon: (key: string) => element.querySelector<HTMLElement>(`[data-app-key="${key}"]`)!,
	};
}

/** A mouse event as a browser sends it: the button is held from the press until the release. */
const pointer = (
	type: string,
	x: number,
	y: number,
	target: EventTarget = document,
	buttons = type === "pointerup" ? 0 : 1,
) =>
	target.dispatchEvent(
		new PointerEvent(type, {
			bubbles: true,
			cancelable: true,
			pointerId: 1,
			pointerType: "mouse",
			button: 0,
			buttons,
			clientX: x,
			clientY: y,
		}),
	);

/** Whether a click on `icon` reaches the page (true) or was swallowed. */
function clickReaches(icon: HTMLElement): boolean {
	let reached = false;
	const listen = (event: Event) => {
		reached = !event.defaultPrevented;
		event.preventDefault();
	};
	document.addEventListener("click", listen);
	icon.click();
	document.removeEventListener("click", listen);
	return reached;
}

describe("the apps drawer's order", () => {
	it("puts the icons the member ordered first, as ordered, and the rest after them as they come", () => {
		const keys = ["mailbox", "members", "bank", "app:shop", "concepts"];
		expect(orderApps(keys, (k) => k, [])).toEqual(keys);
		expect(orderApps(keys, (k) => k, ["bank", "mailbox"])).toEqual([
			"bank",
			"mailbox",
			"members",
			"app:shop",
			"concepts",
		]);
		// A key for an icon that is gone changes nothing.
		expect(orderApps(keys, (k) => k, ["app:gone", "concepts"])).toEqual([
			"concepts",
			"mailbox",
			"members",
			"bank",
			"app:shop",
		]);
	});

	it("moves a dragged icon to where it is let go, the others making way, and reports the new order", () => {
		const { element, drops, drag, icon } = setup(["mailbox", "members", "bank", "app:shop"]);
		pointer("pointerdown", 25, 30, icon("mailbox"));
		pointer("pointermove", 28, 30);
		expect(drag.dragging).toBe(false);
		pointer("pointermove", 125, 30);
		expect(drag.dragging).toBe(true);
		expect(icon("mailbox").classList.contains("is-lifted")).toBe(true);
		expect(gridOrder(element)).toEqual(["members", "bank", "mailbox", "app:shop"]);
		pointer("pointerup", 125, 30);
		expect(drag.dragging).toBe(false);
		expect(icon("mailbox").classList.contains("is-lifted")).toBe(false);
		expect(icon("mailbox").style.translate).toBe("");
		expect(drops).toEqual([["members", "bank", "mailbox", "app:shop"]]);
		// The click that ends the drag opens nothing; the next one does.
		expect(clickReaches(icon("mailbox"))).toBe(false);
	});

	it("keeps a press that never moves a click, and reports nothing", () => {
		const { drops, icon } = setup(["mailbox", "members"]);
		pointer("pointerdown", 25, 30, icon("members"));
		pointer("pointerup", 26, 30);
		expect(drops).toEqual([]);
		expect(clickReaches(icon("members"))).toBe(true);
	});

	it("lets a later click through when a drag ended off the icons", async () => {
		const { drops, icon } = setup(["mailbox", "members"]);
		pointer("pointerdown", 25, 30, icon("mailbox"));
		pointer("pointermove", 75, 30);
		pointer("pointerup", 300, 300);
		expect(drops).toEqual([["members", "mailbox"]]);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(clickReaches(icon("members"))).toBe(true);
	});

	it("puts everything back on Escape", () => {
		const { element, drops, drag, icon } = setup(["mailbox", "members", "bank"]);
		pointer("pointerdown", 25, 30, icon("mailbox"));
		pointer("pointermove", 125, 30);
		expect(gridOrder(element)).toEqual(["members", "bank", "mailbox"]);
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		expect(drag.dragging).toBe(false);
		expect(gridOrder(element)).toEqual(["mailbox", "members", "bank"]);
		pointer("pointerup", 125, 30);
		expect(drops).toEqual([]);
	});

	it("leaves touch to scroll, and drags nothing while the hooks say no", () => {
		let allowed = false;
		const { drag, drops, icon } = setup(["mailbox", "members"], () => allowed);
		pointer("pointerdown", 25, 30, icon("mailbox"));
		pointer("pointermove", 75, 30);
		expect(drag.dragging).toBe(false);
		pointer("pointerup", 75, 30);
		allowed = true;
		icon("mailbox").dispatchEvent(
			new PointerEvent("pointerdown", {
				bubbles: true,
				pointerId: 2,
				pointerType: "touch",
				button: 0,
				clientX: 25,
				clientY: 30,
			}),
		);
		document.dispatchEvent(
			new PointerEvent("pointermove", { pointerId: 2, pointerType: "touch", clientX: 75, clientY: 30 }),
		);
		expect(drag.dragging).toBe(false);
		expect(drops).toEqual([]);
	});

	it("moves the focused icon one place with Alt and an arrow, and keeps it focused", () => {
		const { element, drops, icon } = setup(["mailbox", "members", "bank"]);
		icon("members").focus();
		const key = (k: string) =>
			document.activeElement!.dispatchEvent(
				new KeyboardEvent("keydown", { key: k, altKey: true, bubbles: true, cancelable: true }),
			);
		key("ArrowRight");
		expect(gridOrder(element)).toEqual(["mailbox", "bank", "members"]);
		expect(document.activeElement).toBe(icon("members"));
		key("ArrowUp");
		key("ArrowLeft");
		expect(gridOrder(element)).toEqual(["members", "mailbox", "bank"]);
		// Already first: nothing moves and nothing is reported.
		key("ArrowLeft");
		expect(drops).toEqual([
			["mailbox", "bank", "members"],
			["mailbox", "members", "bank"],
			["members", "mailbox", "bank"],
		]);
		// Without Alt an arrow is the page's own.
		document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
		expect(gridOrder(element)).toEqual(["members", "mailbox", "bank"]);
	});

	it("never undoes a swap while the icon it passed is still gliding away from under the pointer", () => {
		const { element, drops, icon } = setup(["mailbox", "members", "bank"]);
		pointer("pointerdown", 25, 30, icon("mailbox"));
		pointer("pointermove", 75, 30);
		expect(gridOrder(element)).toEqual(["members", "mailbox", "bank"]);
		// Mid-glide, Members' box is still where it came from, under the pointer.
		vi.spyOn(icon("members"), "getBoundingClientRect").mockReturnValue(new DOMRect(50, 0, 50, 60));
		pointer("pointermove", 77, 31);
		pointer("pointermove", 79, 32);
		expect(gridOrder(element)).toEqual(["members", "mailbox", "bank"]);
		pointer("pointerup", 79, 32);
		expect(drops).toEqual([["members", "mailbox", "bank"]]);
	});

	it("lifts the icon as it stands now when the drawer redrew it between the press and the lift", () => {
		const { element, drops, drag, icon } = setup(["mailbox", "members", "bank"]);
		const pressed = icon("mailbox");
		pointer("pointerdown", 25, 30, pressed);
		// A new badge rebuilds the Mailbox icon before the pointer has moved far.
		const rebuilt = h("a", { class: "rail-app", href: "#/mailbox", "data-app-key": "mailbox" }, "mailbox 1");
		layOut(element, rebuilt);
		vi.spyOn(rebuilt, "getBoundingClientRect").mockImplementation(() => {
			const index = [...element.children].indexOf(rebuilt);
			return new DOMRect((index % 4) * 50, Math.floor(index / 4) * 60, 50, 60);
		});
		pressed.replaceWith(rebuilt);
		pointer("pointermove", 125, 30);
		expect(drag.dragging).toBe(true);
		expect(rebuilt.classList.contains("is-lifted")).toBe(true);
		expect(pressed.isConnected).toBe(false);
		expect(gridOrder(element)).toEqual(["members", "bank", "mailbox"]);
		pointer("pointerup", 125, 30);
		expect(drops).toEqual([["members", "bank", "mailbox"]]);
	});

	it("gives up a press whose icon a redraw took away before the lift", () => {
		const { element, drag, drops, ends, icon } = setup(["mailbox", "members"]);
		pointer("pointerdown", 25, 30, icon("mailbox"));
		icon("mailbox").remove();
		pointer("pointermove", 75, 30);
		expect(drag.dragging).toBe(false);
		expect(gridOrder(element)).toEqual(["members"]);
		pointer("pointerup", 75, 30);
		expect(drops).toEqual([]);
		expect(ends()).toBe(0);
	});

	it("tells the drawer every time a drag ends, so what it held back draws, kept order or not", () => {
		const { drops, ends, icon } = setup(["mailbox", "members", "bank"]);
		// Lifted and let go where it started: no new order, but the end.
		pointer("pointerdown", 25, 30, icon("mailbox"));
		pointer("pointermove", 35, 30);
		pointer("pointerup", 35, 30);
		expect(drops).toEqual([]);
		expect(ends()).toBe(1);
		// Put back with Escape.
		pointer("pointerdown", 25, 30, icon("mailbox"));
		pointer("pointermove", 125, 30);
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		expect(ends()).toBe(2);
		// Dropped in a new place.
		pointer("pointerdown", 25, 30, icon("mailbox"));
		pointer("pointermove", 75, 30);
		pointer("pointerup", 75, 30);
		expect(drops).toEqual([["members", "mailbox", "bank"]]);
		expect(ends()).toBe(3);
	});

	it("puts everything back when the window loses focus mid-drag, or the button came up unheard", () => {
		const { element, drag, drops, ends, icon } = setup(["mailbox", "members", "bank"]);
		pointer("pointerdown", 25, 30, icon("mailbox"));
		pointer("pointermove", 125, 30);
		window.dispatchEvent(new Event("blur"));
		expect(drag.dragging).toBe(false);
		expect(gridOrder(element)).toEqual(["mailbox", "members", "bank"]);
		expect(icon("mailbox").classList.contains("is-lifted")).toBe(false);
		expect(ends()).toBe(1);
		// Back in the window with the button already up: the next move ends it too.
		pointer("pointerdown", 25, 30, icon("mailbox"));
		pointer("pointermove", 125, 30);
		pointer("pointermove", 130, 30, document, 0);
		expect(drag.dragging).toBe(false);
		expect(gridOrder(element)).toEqual(["mailbox", "members", "bank"]);
		// Later moves reorder nothing.
		pointer("pointermove", 75, 30);
		expect(gridOrder(element)).toEqual(["mailbox", "members", "bank"]);
		expect(drops).toEqual([]);
		expect(ends()).toBe(2);
	});

	it("measures true places when a new drag starts while the last move is still gliding", () => {
		const { element, drops, icon } = setup(["mailbox", "members", "bank", "app:shop"]);
		// Each icon glides as a browser would: until its animation finishes, its box is offset by the animation's start.
		const offsets = new Map<Element, { dx: number; dy: number }>();
		for (const item of element.children) {
			vi.spyOn(item as HTMLElement, "getBoundingClientRect").mockImplementation(() => {
				const index = [...element.children].indexOf(item);
				const box = new DOMRect((index % 4) * 50, Math.floor(index / 4) * 60, 50, 60);
				const offset = offsets.get(item);
				return offset ? new DOMRect(box.x + offset.dx, box.y + offset.dy, box.width, box.height) : box;
			});
			(item as HTMLElement).animate = ((frames: Keyframe[]) => {
				const [dx = 0, dy = 0] = String(frames[0]?.translate ?? "0 0")
					.split(" ")
					.map((part) => Number.parseFloat(part));
				offsets.set(item, { dx, dy });
				const done = () => offsets.delete(item);
				return { finish: done, cancel: done, addEventListener: () => {} } as unknown as Animation;
			}) as HTMLElement["animate"];
		}
		// Alt+Right moves Mailbox one place; Members glides back from Mailbox's old place.
		icon("mailbox").focus();
		icon("mailbox").dispatchEvent(
			new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, bubbles: true, cancelable: true }),
		);
		expect(gridOrder(element)).toEqual(["members", "mailbox", "bank", "app:shop"]);
		expect(offsets.has(icon("members"))).toBe(true);
		// Mid-glide, Bank is dragged onto the first place. Members stands there once its glide ends.
		pointer("pointerdown", 125, 30, icon("bank"));
		pointer("pointermove", 25, 30);
		expect(gridOrder(element)).toEqual(["bank", "members", "mailbox", "app:shop"]);
		pointer("pointerup", 25, 30);
		expect(drops.at(-1)).toEqual(["bank", "members", "mailbox", "app:shop"]);
	});

	it("measures the places as laid out while the drawer is still opening, its icons scaled and sliding in", () => {
		const { element, drops, icon } = setup(["mailbox", "members", "bank", "app:shop"]);
		// Mid-opening, every icon is drawn at 0.4 of its size and 6px up from its place.
		for (const item of element.children)
			vi.spyOn(item as HTMLElement, "getBoundingClientRect").mockImplementation(() => {
				const index = [...element.children].indexOf(item);
				return new DOMRect((index % 4) * 50 + 15, Math.floor(index / 4) * 60 + 12, 20, 24);
			});
		pointer("pointerdown", 25, 30, icon("mailbox"));
		pointer("pointermove", 35, 30);
		// Near the third place's edge, outside the shrunken drawing but inside the place.
		pointer("pointermove", 104, 55);
		expect(gridOrder(element)).toEqual(["members", "bank", "mailbox", "app:shop"]);
		pointer("pointerup", 104, 55);
		expect(drops).toEqual([["members", "bank", "mailbox", "app:shop"]]);
	});
});
