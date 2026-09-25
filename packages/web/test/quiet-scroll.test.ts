// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthController } from "../src/app/auth.ts";
import { CompanyController } from "../src/app/company.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import { renderRail } from "../src/app/views/shell.ts";
import { h } from "../src/ui/dom.ts";
import { QUIET_SCROLL_FADE, QUIET_SCROLL_RAIL_FADE, quietScroll } from "../src/ui/quiet-scroll.ts";
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

	it("hides the bar in the stylesheet and draws the fade at the helper's sizes", () => {
		const css = readFileSync(resolve("src/styles/app.css"), "utf8");
		const rule = css.match(/\.scroll-quiet \{([^}]*)\}/)?.[1] ?? "";
		const fade = `var(--quiet-fade, ${QUIET_SCROLL_FADE}px)`;
		expect(rule).toContain("scrollbar-width: none");
		expect(rule).toContain(`mask-image: linear-gradient(to bottom, transparent, #000 ${fade})`);
		expect(rule).toContain(`mask-size: 100% calc(100% + ${fade})`);
		expect(rule).toContain(`mask-position: 0 calc(-1 * ${fade})`);
		// The rail keeps a hint of a fade, not a band over the Co-Founder card.
		expect(css).toMatch(new RegExp(`\\.rail-scroll \\{[^}]*--quiet-fade: ${QUIET_SCROLL_RAIL_FADE}px;`));
		expect(css).toContain(".scroll-quiet::-webkit-scrollbar { display: none; }");
		expect(css).toContain(".scroll-quiet[data-scrolled] { -webkit-mask-position: 0 0; mask-position: 0 0; }");
		const messages = readFileSync(resolve("src/styles/conversation.css"), "utf8");
		expect(messages).toMatch(/\.messages \{[^}]*overflow: hidden auto;/);
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
		});
		expect(rail.querySelector(".rail-scroll.scroll-quiet")).not.toBeNull();
	});
});
