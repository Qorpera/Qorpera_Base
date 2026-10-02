// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthController } from "../src/app/auth.ts";
import { CompanyController } from "../src/app/company.ts";
import { renderRail } from "../src/app/views/shell.ts";
import { openContextMenu } from "../src/ui/context-menu.ts";
import { h } from "../src/ui/dom.ts";
import { foldFrom } from "../src/ui/motion.ts";
import { fixture, profileA, session, staff, stubFigureMotion, team, userA } from "./fixtures.ts";

/* The views as they behave with an animation engine. jsdom has none, so every helper in
 * ui/motion.ts would take its immediate path; these tests give elements getAnimations and
 * animate, so leaving parts stay on the page and one-play classes are added. */
let running = false;
const cleanup: (() => void)[] = [];
beforeEach(() => {
	running = false;
	localStorage.clear();
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("No cloud transport in this UI fixture")));
	Element.prototype.getAnimations = () => (running ? [{ playState: "running" }] : []) as unknown as Animation[];
	Element.prototype.animate = () =>
		({ finished: new Promise(() => {}), cancel() {}, currentTime: 0 }) as unknown as Animation;
});
afterEach(() => {
	for (const dispose of cleanup.splice(0).reverse()) dispose();
	delete (Element.prototype as { getAnimations?: unknown }).getAnimations;
	delete (Element.prototype as { animate?: unknown }).animate;
	vi.unstubAllGlobals();
	document.body.replaceChildren();
});

describe("a menu that animates out", () => {
	it("gives focus back to its opener at once, before a dialog its choice opens takes note of it", () => {
		running = true;
		const opener = h("button", { type: "button" }, "Bo");
		document.body.append(opener);
		let focusedWhenChosen: Element | null = null;
		const menu = openContextMenu({
			label: "Bo",
			x: 10,
			y: 10,
			opener,
			items: [
				{
					label: "Rename",
					select: () => {
						focusedWhenChosen = document.activeElement;
					},
				},
			],
		});
		const item = menu.el.querySelector<HTMLElement>("[role^=menuitem]")!;
		expect(document.activeElement).toBe(item);
		item.click();
		// The menu is still leaving on the page, but out of reach, and the opener has the keyboard.
		expect(menu.el.isConnected).toBe(true);
		expect(menu.el.inert).toBe(true);
		expect(document.activeElement).toBe(opener);
		expect(focusedWhenChosen).toBe(opener);
	});
});

describe("rail rows that come back", () => {
	function mount(company: CompanyController) {
		const rail = h("aside", { class: "rail" });
		document.body.append(rail);
		const auth = new AuthController(fixture().cloud);
		cleanup.push(() => auth.dispose());
		const draw = () =>
			renderRail(rail, company, {
				profiles: [profileA],
				user: userA,
				route: { name: "company", profileId: profileA.profileId, section: "home" },
				auth,
				invitations: 0,
				openSettings: () => {},
				openFeedback: () => {},
			});
		draw();
		return { rail, draw };
	}

	it("are not hired again after a search; only an agent the company never listed is", () => {
		stubFigureMotion();
		const f = fixture();
		const company = new CompanyController(f.api, profileA, userA.id);
		cleanup.push(() => company.stop());
		const second = { ...staff, id: "33333333-3333-4333-8333-000000000099", displayName: "Second agent" };
		company.store.set({ loading: false, staff: [staff, second], sessions: [session], team });
		const { rail, draw } = mount(company);
		draw();
		const search = rail.querySelector<HTMLInputElement>('input[type="search"]')!;
		search.value = "Second";
		draw();
		search.value = "";
		draw();
		expect(rail.querySelector(".is-hired, .is-arriving")).toBeNull();
		const hired = { ...staff, id: "33333333-3333-4333-8333-000000000098", displayName: "New hire" };
		company.store.set({ staff: [staff, second, hired] });
		draw();
		const row = rail.querySelector(`a[href$="/staff/${hired.id}"]`);
		expect(row?.classList.contains("is-hired")).toBe(true);
		expect(rail.querySelectorAll(".is-hired")).toHaveLength(1);
	});

	it("play nothing while the company is still loading, nor on the draw that finishes it", () => {
		stubFigureMotion();
		const f = fixture();
		const company = new CompanyController(f.api, profileA, userA.id);
		cleanup.push(() => company.stop());
		company.store.set({ loading: true, staff: [staff], sessions: [], team });
		const { rail, draw } = mount(company);
		company.store.set({ sessions: [session] });
		draw();
		company.store.set({ loading: false });
		draw();
		expect(rail.querySelector(".is-hired, .is-arriving, .state-working, .mention-arrived")).toBeNull();
	});
});

describe("the fold over an answered card", () => {
	it("lays a copy of the old card over the fold that no lookup finds as the card", () => {
		const card = h(
			"article",
			{ class: "auth-card", "data-review-id": "r1" },
			h("input", { "data-review-rule": "r1", id: "rule-r1", name: "rule" }),
			h("label", { for: "rule-r1" }, "Always allow"),
		);
		const folded = h("article", { class: "action-review-card is-folded", "data-review-id": "r1" });
		document.body.append(folded);
		folded.getBoundingClientRect = () => ({ height: 30 }) as DOMRect;
		foldFrom(folded, 180, card.cloneNode(true) as Element);
		const ghost = folded.querySelector(".fold-ghost")!;
		expect(ghost).not.toBeNull();
		expect((ghost as HTMLElement).inert).toBe(true);
		expect(document.querySelectorAll("[data-review-id]")).toHaveLength(1);
		expect(document.querySelector("input[data-review-rule], #rule-r1, [name=rule], [for]")).toBeNull();
	});
});
