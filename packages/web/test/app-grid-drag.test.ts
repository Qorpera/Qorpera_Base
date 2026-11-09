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

function grid(keys: readonly string[]) {
	const element = h("div", { class: "rail-apps-grid" });
	for (const key of keys) {
		const icon = h("a", { class: "rail-app", href: `#/${key}`, "data-app-key": key }, key);
		vi.spyOn(icon, "getBoundingClientRect").mockImplementation(() => {
			const index = [...element.children].indexOf(icon);
			return new DOMRect((index % 4) * 50, Math.floor(index / 4) * 60, 50, 60);
		});
		element.append(icon);
	}
	vi.spyOn(element, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 200, 120));
	document.body.append(element);
	return element;
}

function setup(keys: readonly string[], canDrag = () => true) {
	const element = grid(keys);
	const drops: string[][] = [];
	const drag = new AppGridDrag(element, () => ({ canDrag, drop: (order) => drops.push(order) }), stop.signal);
	return {
		element,
		drops,
		drag,
		icon: (key: string) => element.querySelector<HTMLElement>(`[data-app-key="${key}"]`)!,
	};
}

const pointer = (type: string, x: number, y: number, target: EventTarget = document) =>
	target.dispatchEvent(
		new PointerEvent(type, {
			bubbles: true,
			cancelable: true,
			pointerId: 1,
			pointerType: "mouse",
			button: 0,
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
});
