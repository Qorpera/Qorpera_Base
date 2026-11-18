// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthController } from "../src/app/auth.ts";
import { CompanyController } from "../src/app/company.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import { renderRail } from "../src/app/views/shell.ts";
import { h } from "../src/ui/dom.ts";
import { quietScroll } from "../src/ui/quiet-scroll.ts";
import { fixture, profileA, session, staff, team, userA } from "./fixtures.ts";

const cleanup: (() => void)[] = [];
beforeEach(() => {
	localStorage.clear();
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("No cloud transport in this UI fixture")));
});
afterEach(() => {
	for (const dispose of cleanup.splice(0).reverse()) dispose();
	document.body.replaceChildren();
	localStorage.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

/** jsdom has no layout, so the scroll position is set by hand and the event dispatched. */
function scrollTo(scroller: HTMLElement, top: number): void {
	Object.defineProperty(scroller, "scrollTop", { value: top, configurable: true, writable: true });
	scroller.dispatchEvent(new Event("scroll"));
}

describe("quiet scrollers", () => {
	it("marks the scroller and follows its distance from the top", () => {
		const scroller = h("div");
		const refresh = quietScroll(scroller);
		expect(scroller.classList.contains("scroll-quiet")).toBe(true);
		expect(scroller.hasAttribute("data-scrolled")).toBe(false);
		scrollTo(scroller, 120);
		expect(scroller.hasAttribute("data-scrolled")).toBe(true);
		scrollTo(scroller, 0);
		expect(scroller.hasAttribute("data-scrolled")).toBe(false);
		// A programmatic scroll reports at once through refresh, before any scroll event.
		Object.defineProperty(scroller, "scrollTop", { value: 300, configurable: true, writable: true });
		refresh();
		expect(scroller.hasAttribute("data-scrolled")).toBe(true);
	});

	it("applies to the thread and the rail", () => {
		const f = fixture();
		const company = new CompanyController(f.api, profileA, userA.id);
		cleanup.push(() => company.stop());
		company.store.set({ team, staff: [staff], sessions: [{ ...session, staffAgentId: staff.id }], loading: false });
		company
			.conversation(session.sessionId)
			.set({ projection: { items: [], hiddenCount: 0, lastSequence: 0 }, loading: false });
		const view = new ConversationView(company, session.sessionId);
		cleanup.push(() => view.dispose());
		document.body.append(view.el);
		expect(view.el.querySelector(".messages.scroll-quiet")).not.toBeNull();

		const rail = h("aside", { class: "rail" });
		document.body.append(h("div", { class: "frame" }, rail));
		const auth = new AuthController(f.cloud);
		cleanup.push(() => auth.dispose());
		renderRail(rail, company, {
			profiles: [profileA],
			user: userA,
			route: { name: "company", profileId: profileA.profileId, section: "home" },
			auth,
			invitations: 0,
			openSettings: () => {},
			openFeedback: () => {},
			openFriends: () => {},
		});
		expect(rail.querySelector(".rail-scroll.scroll-quiet")).not.toBeNull();
	});
});
