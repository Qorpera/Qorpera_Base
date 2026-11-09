// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountApplication, WEBSITE_KEYS } from "../src/app/application.ts";
import { SIGN_IN_CALLBACK_FIELDS } from "../src/app/auth.ts";
import { AUTH_STORAGE_KEY } from "../src/cloud/client.ts";
import {
	applyBoot,
	type BootView,
	bootView,
	breatheOnDocumentClock,
	CALLBACK,
	RAIL_COMPACT,
	RAIL_MIN,
	RAIL_WIDTH_KEY,
	STORED_SESSION_KEY,
	WEBSITE,
} from "../src/ui/boot.ts";
import { COMPACT, DEFAULT, MAX_SHARE, MIN, SMALL_DEFAULT, STORAGE_KEY } from "../src/ui/rail-layout.ts";
import { companyCardsSkeleton, railSkeleton, threadSkeleton } from "../src/ui/skeleton.ts";
import { deferred, fixture, settle } from "./fixtures.ts";

/* index.html's static first screens (ui/boot.ts): the head script picks the one the app will draw, the static
 * markup is the app's own placeholder markup, and the app keeps it until it knows which screen to draw. */

const page = new DOMParser().parseFromString(readFileSync(resolve("public/index.html"), "utf8"), "text/html");
const boot = page.querySelector("#app > .boot")!;
const COMPANY = "0f8fad5b-d9cb-469f-a165-70867728950e";

/** Tags and classes, in order, all the way down: what the stylesheet lays out. Text, labels and state are not. */
function outline(node: Element): string {
	const classes = [...node.classList].sort().join(".");
	return `<${node.tagName.toLowerCase()}${classes ? `.${classes}` : ""}>${[...node.children].map(outline).join("")}</>`;
}

describe("which first screen stands while main.js loads", () => {
	it("is the one application.ts draws first, for every kind of address", () => {
		// The company's thread placeholder for its home, a chat and a new chat; the company list for the hub and any
		// address the router does not know; none where the first screen is not a placeholder of these three.
		const expected: [string, BootView | undefined][] = [
			["", "hub"],
			["#", "hub"],
			["#/", "hub"],
			["#/elsewhere", "hub"],
			["#/new/x", "hub"],
			["#/found/not-a-company", "hub"],
			["#/c/not-a-company", "hub"],
			["#/account", undefined],
			["#/account/x", undefined],
			["#/new", undefined],
			["#/new?idea=Bakery", undefined],
			[`#/found/${COMPANY}`, undefined],
			[`#/c/${COMPANY}`, "thread"],
			[`#/c/${COMPANY.toUpperCase()}`, "thread"],
			[`#/c/${COMPANY}/chat/abc`, "thread"],
			[`#/c/${COMPANY}/chat`, "thread"],
			[`#/c/${COMPANY}/staff/abc`, "thread"],
			[`#/c/${COMPANY}/new`, "thread"],
			[`#/c/${COMPANY}/anything`, "thread"],
			[`#/c/${COMPANY}/i`, "thread"],
			[`#/c/${COMPANY}/i/Not_A_Name`, "thread"],
			[`#/c/${COMPANY}/i/sales-board`, undefined],
			[`#/c/${COMPANY}/file`, undefined],
			[`#/c/${COMPANY}/team`, undefined],
			[`#/c/${COMPANY}/meet`, undefined],
		];
		for (const [hash, view] of expected) expect(bootView(`https://app.example/${hash}`, true), hash).toBe(view);
	});

	it("shows the sign-in page without a stored session, and nothing while a sign-in callback is finished", () => {
		expect(bootView("https://app.example/", false)).toBe("sign-in");
		expect(bootView(`https://app.example/#/c/${COMPANY}`, false)).toBe("sign-in");
		for (const href of [
			"https://app.example/?code=abc",
			"https://app.example/?error=access_denied&error_description=x",
			"https://app.example/#access_token=abc&refresh_token=def",
		]) {
			expect(bootView(href, false), href).toBeUndefined();
			expect(bootView(href, true), href).toBeUndefined();
		}
		// qorpera.com's idea goes to the new-company box.
		expect(bootView("https://app.example/?ide=Bakery&kind=shop", true)).toBeUndefined();
		// An app route that happens to carry a word like "code" is no callback.
		expect(bootView("https://app.example/#/c/x?code=1", true)).toBe("hub");
	});

	it("reads only whether Auth's session is stored, under Auth's own key", () => {
		expect(STORED_SESSION_KEY).toBe(AUTH_STORAGE_KEY);
	});

	it("keeps the app's own callback fields, website keys and rail widths: a change there must change these", () => {
		expect(CALLBACK).toEqual(SIGN_IN_CALLBACK_FIELDS);
		expect(WEBSITE).toEqual([...WEBSITE_KEYS]);
		expect([RAIL_WIDTH_KEY, RAIL_COMPACT, RAIL_MIN]).toEqual([STORAGE_KEY, COMPACT, MIN]);
		// styles/boot.css's static rail: RailLayout's default per interface size, its minimum and its share of the window.
		const css = readFileSync(resolve("src/styles/boot.css"), "utf8");
		const widths = [
			...css.matchAll(
				/--rail-width: min\(calc\(var\(--boot-rail, (\d+)\) \* var\(--px\)\), max\((\d+)px, (\d+)vw\)\)/g,
			),
		].map((match) => match.slice(1).map(Number));
		expect(widths).toEqual([
			[DEFAULT, MIN, MAX_SHARE * 100],
			[SMALL_DEFAULT, MIN, MAX_SHARE * 100],
		]);
		expect(css).toMatch(
			/:root\[data-ui-size="small"\] \.boot \.rail \{ --rail-width: min\(calc\(var\(--boot-rail, 502\)/,
		);
	});
});

describe("the head script", () => {
	beforeEach(() => {
		localStorage.clear();
		delete document.documentElement.dataset.boot;
		document.documentElement.style.removeProperty("--boot-rail");
	});
	afterEach(() => {
		history.replaceState(null, "", "/");
		localStorage.clear();
		delete document.documentElement.dataset.boot;
		document.documentElement.style.removeProperty("--boot-rail");
	});

	it("names the screen on <html>, with a member's stored rail width", () => {
		history.replaceState(null, "", `/#/c/${COMPANY}`);
		applyBoot();
		expect(document.documentElement.dataset.boot).toBe("sign-in");
		localStorage.setItem(AUTH_STORAGE_KEY, "{}");
		localStorage.setItem("qorpera.web.rail-width.v5", "412");
		applyBoot();
		expect(document.documentElement.dataset.boot).toBe("thread");
		expect(document.documentElement.style.getPropertyValue("--boot-rail")).toBe("412");
		// And the static shapes breathe on the document's clock from their first breath.
		const shape = document.createElement("span");
		const breath = { animationName: "skeleton-breathe", startTime: 1280 };
		Object.assign(shape, { getAnimations: () => [breath] });
		const wrap = document.createElement("div");
		wrap.className = "boot";
		wrap.append(shape);
		document.body.append(wrap);
		const event = new Event("animationstart", { bubbles: true });
		Object.defineProperty(event, "animationName", { value: "skeleton-breathe" });
		shape.dispatchEvent(event);
		wrap.remove();
		expect(breath.startTime).toBe(0);
	});

	it("sets the static shapes' breath on the document's clock, as the app's own shapes are, and leaves the app's", () => {
		const target = document.createElement("div");
		breatheOnDocumentClock(target);
		const shape = (inBoot: boolean, startTime: number) => {
			const element = document.createElement("span");
			element.className = "skeleton";
			const animation = { animationName: "skeleton-breathe", startTime };
			const other = { animationName: "fade", startTime };
			Object.assign(element, { getAnimations: () => [animation, other] });
			if (inBoot) {
				const wrap = document.createElement("div");
				wrap.className = "boot";
				wrap.append(element);
				target.append(wrap);
			} else target.append(element);
			return { element, animation, other };
		};
		const started = (element: Element, name = "skeleton-breathe") => {
			const event = new Event("animationstart", { bubbles: true });
			Object.defineProperty(event, "animationName", { value: name });
			element.dispatchEvent(event);
		};
		const still = shape(true, 1280);
		started(still.element);
		expect(still.animation.startTime).toBe(0);
		expect(still.other.startTime).toBe(1280);
		const own = shape(false, 3200);
		started(own.element);
		expect(own.animation.startTime).toBe(3200);
		const fading = shape(true, 900);
		started(fading.element, "fade");
		expect(fading.animation.startTime).toBe(900);
	});

	it("leaves a compact rail's thread and a width RailLayout would not take alone", () => {
		localStorage.setItem(AUTH_STORAGE_KEY, "{}");
		history.replaceState(null, "", `/#/c/${COMPANY}`);
		localStorage.setItem("qorpera.web.rail-width.v5", "80");
		applyBoot();
		expect(document.documentElement.dataset.boot).toBeUndefined();
		localStorage.setItem("qorpera.web.rail-width.v5", "120");
		applyBoot();
		expect(document.documentElement.dataset.boot).toBe("thread");
		expect(document.documentElement.style.getPropertyValue("--boot-rail")).toBe("");
	});
});

describe("index.html's static first screens", () => {
	it("are the app's own placeholders, shape for shape", () => {
		const rail = boot.querySelector(".boot-thread aside.rail")!;
		expect([...rail.children].map(outline)).toEqual(railSkeleton().map(outline));
		const thread = boot.querySelector(".boot-thread section.thread")!;
		expect(outline(thread)).toBe(outline(threadSkeleton("Opening company", { open: false, toggle() {} })));
		const cards = boot.querySelector(".boot-hub .company-grid")!;
		expect(outline(cards)).toBe(outline(companyCardsSkeleton()));
	});

	it("stand in the app's frames, one per screen, hidden from assistive technology and never focusable", () => {
		expect(boot.getAttribute("aria-hidden")).toBe("true");
		expect(boot.hasAttribute("inert")).toBe(true);
		expect([...boot.children].map((child) => child.className)).toEqual(["boot-sign-in", "boot-hub", "boot-thread"]);
		expect(outline(boot.querySelector(".boot-thread > .frame")!)).toMatch(
			/^<div\.frame\.has-thread><header\.topbar\.topbar-company><\/><div\.body><aside\.rail>.*<\/><main\.main><section\.thread\.thread-skeleton>/,
		);
		expect(outline(boot.querySelector(".boot-hub > .frame")!)).toMatch(
			/^<div\.frame><header\.topbar\.topbar-plain><\/><div\.body><main\.main><section\.hub><div\.hub-inner\.hub-pick><h1\.hub-title>.*<p\.hub-lead>/,
		);
		expect(outline(boot.querySelector(".boot-sign-in > .auth")!)).toMatch(
			/^<div\.auth><section\.auth-panel><header\.auth-brand>.*<div\.auth-body><h1>.*<p\.auth-lead>.*<div\.auth-form><label>.*<footer\.auth-foot>.*<aside\.auth-art><\/><\/>$/,
		);
	});

	it("download nothing: no image, no style, no script, no link", () => {
		expect(
			boot.querySelectorAll(
				"img, picture, source, video, link, script, style, iframe, object, [style], [src], [href]",
			),
		).toHaveLength(0);
	});
});

describe("the app's first draw", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("No cloud transport in this UI fixture")));
		vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	});
	afterEach(() => {
		document.body.replaceChildren();
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		history.replaceState(null, "", "/");
	});

	it("keeps the static screen until it knows who is signed in, then replaces it", async () => {
		history.replaceState(null, "", "/#/");
		const f = fixture();
		const started = deferred<{ error: null }>();
		vi.mocked(f.cloud.supabase.auth.initialize).mockReturnValue(started.promise as never);
		const root = document.createElement("div");
		root.append(boot.cloneNode(true));
		document.body.append(root);
		const dispose = mountApplication(root, f.cloud, f.api);
		try {
			// A route change before Auth has answered draws again: the static screen stays, never a blank one.
			history.replaceState(null, "", `/#/c/${COMPANY}`);
			window.dispatchEvent(new HashChangeEvent("hashchange"));
			await settle();
			await vi.advanceTimersByTimeAsync(60);
			expect(root.querySelector(":scope > .boot")).not.toBeNull();
			expect(root.querySelector(".skeleton-blank")).toBeNull();
			started.resolve({ error: null });
			await settle();
			await vi.advanceTimersByTimeAsync(60);
			expect(root.querySelector(".boot")).toBeNull();
			expect(root.querySelector(":scope > .frame")).not.toBeNull();
		} finally {
			dispose();
		}
	});
});
