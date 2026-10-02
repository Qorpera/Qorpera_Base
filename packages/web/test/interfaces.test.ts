// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthController } from "../src/app/auth.ts";
import { CompanyController } from "../src/app/company.ts";
import { companyInterfaces, interfaceRows } from "../src/app/interfaces.ts";
import { parseRoute, type Route, routeHash } from "../src/app/router.ts";
import { renderInterface } from "../src/app/views/interface.ts";
import { renderRail } from "../src/app/views/shell.ts";
import type { HostedStaffAgent, HostedStaffExecutionActivity } from "../src/cloud/types.ts";
import { h } from "../src/ui/dom.ts";
import { fixture, id, profileA, session, staff, stubFigureMotion, team, userA } from "./fixtures.ts";

const agent = (n: number, name: string): HostedStaffAgent => ({
	...staff,
	id: id(n),
	displayName: name,
	role: `${name} role`,
});
const cofounder: HostedStaffAgent = { ...agent(40, "Co-Founder"), templateId: "co-founder" };
const [ada, bo, cy] = [agent(41, "Ada"), agent(42, "Bo"), agent(43, "Cy")];
const run = (
	staffAgentId: string,
	n: number,
	extra: Partial<HostedStaffExecutionActivity>,
): HostedStaffExecutionActivity => ({
	staffAgentId,
	runId: id(80 + n),
	sourceKind: "session_turn",
	activity: "working",
	jobStatus: "leased",
	updatedAt: "2026-10-02T09:44:00Z",
	...extra,
});

const cleanup: (() => void)[] = [];
beforeEach(() => {
	stubFigureMotion();
	vi.stubGlobal("innerWidth", 1280);
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
	for (const dispose of cleanup.splice(0).reverse()) dispose();
	document.body.replaceChildren();
	sessionStorage.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function company(
	activity: HostedStaffExecutionActivity[] = [],
	extra: { mentions?: Record<string, number>; members?: number } = {},
) {
	const f = fixture();
	const controller = new CompanyController(f.api, profileA, userA.id);
	const members = Array.from({ length: extra.members ?? 1 }, (_, n) => ({ ...team.members[0]!, userId: id(200 + n) }));
	controller.store.set({
		loading: false,
		staff: [cofounder, ada, bo, cy],
		sessions: [session],
		team: { ...team, members },
		activity,
		...(extra.mentions ? { mentions: extra.mentions } : {}),
	});
	cleanup.push(() => controller.stop());
	return { f, controller };
}

describe("interface routes", () => {
	it("reads and writes #/c/{id}/i/{name}", () => {
		const route = parseRoute(`#/c/${profileA.profileId}/i/pulse`);
		expect(route).toEqual({ name: "company", profileId: profileA.profileId, section: "interface", id: "pulse" });
		expect(routeHash(route)).toBe(`#/c/${profileA.profileId}/i/pulse`);
		for (const bad of ["i", "i/Pulse", "i/../x", `i/${"a".repeat(65)}`]) {
			expect(parseRoute(`#/c/${profileA.profileId}/${bad}`)).toMatchObject({ section: "home" });
		}
	});
});

describe("which interfaces a company lists", () => {
	it("lists Pulse only: Mailbox needs a mailbox and Members needs folder tables this client can't read yet", () => {
		expect(companyInterfaces(company().controller).map((entry) => entry.name)).toEqual(["pulse"]);
		expect(companyInterfaces(company([], { members: 3 }).controller).map((entry) => entry.name)).toEqual(["pulse"]);
	});

	it("reads who is working and what waits for the member from the company's live state", () => {
		const { controller } = company(
			[
				run(ada.id, 1, { phase: "writing" }),
				run(bo.id, 2, { activity: "needs_attention", jobStatus: "failed" }),
				run(cy.id, 3, { activity: "needs_attention", jobStatus: "leased" }),
			],
			{ mentions: { [session.sessionId]: 2 } },
		);
		expect(interfaceRows(controller, "working")?.map(({ row }) => row)).toEqual([
			{ agent: ada.id, what: "Writing", since: "2026-10-02T09:44:00Z" },
		]);
		const waiting = interfaceRows(controller, "waiting") ?? [];
		expect(waiting.map(({ row }) => row.title)).toEqual([
			"Bo has a run that did not finish",
			"Cy needs you",
			`You were mentioned in ${session.title}`,
		]);
		expect(waiting.map(({ href }) => href)).toEqual([
			`#/c/${profileA.profileId}/staff/${bo.id}`,
			`#/c/${profileA.profileId}/staff/${cy.id}`,
			`#/c/${profileA.profileId}/chat/${session.sessionId}`,
		]);
		expect(interfaceRows(controller, "activity")).toBeUndefined();
		expect(interfaceRows(controller, "table:numbers")).toBeUndefined();
	});
});

describe("the Pulse page", () => {
	it("draws only the blocks it can read, and leaves an unchanged page alone", () => {
		const { controller } = company([run(ada.id, 1, {})]);
		const main = h("main");
		document.body.append(main);
		renderInterface(main, controller, "pulse");
		expect(main.querySelector(".interface-title h1")?.textContent).toBe("Pulse");
		expect([...main.querySelectorAll(".interface-block h2")].map((el) => el.textContent)).toEqual([
			"Needs you",
			"Working now",
		]);
		const working = main.querySelectorAll<HTMLAnchorElement>(".interface-block:nth-child(2) a.interface-item");
		expect(working).toHaveLength(1);
		expect(working[0]?.textContent).toContain("Ada");
		expect(working[0]?.getAttribute("href")).toBe(`#/c/${profileA.profileId}/staff/${ada.id}`);
		expect(main.querySelector(".interface-block:nth-child(1) .interface-empty")?.textContent).toBe(
			"Nothing here right now.",
		);
		const page = main.firstElementChild;
		renderInterface(main, controller, "pulse");
		expect(main.firstElementChild).toBe(page);
		controller.store.set({ activity: [] });
		renderInterface(main, controller, "pulse");
		expect(main.firstElementChild).not.toBe(page);
		expect(main.querySelectorAll("a.interface-item")).toHaveLength(0);
	});

	it("never shows an interface this client can't draw", () => {
		const { controller } = company();
		const main = h("main");
		renderInterface(main, controller, "members");
		expect(main.textContent).toContain("This page isn't available here yet.");
		expect(main.querySelector("a")?.getAttribute("href")).toBe(`#/c/${profileA.profileId}`);
	});
});

describe("the rail's Agents | Interfaces switch", () => {
	function rail(route: Route) {
		const { f, controller } = company();
		const element = h("aside", { class: "rail" });
		document.body.append(h("div", { class: "frame" }, element));
		const auth = new AuthController(f.cloud);
		cleanup.push(() => auth.dispose());
		const context = {
			profiles: [profileA],
			user: userA,
			route,
			auth,
			invitations: 0,
			openSettings: () => {},
			openFeedback: () => {},
			agentActions: {},
		};
		const draw = (next: Route = route) => renderRail(element, controller, { ...context, route: next });
		draw();
		return { element, draw, controller };
	}
	const tabs = (element: HTMLElement) =>
		[...element.querySelectorAll<HTMLButtonElement>(".rail-switch-tab")].map((tab) => [
			tab.textContent,
			tab.getAttribute("aria-pressed"),
		]);
	const home: Route = { name: "company", profileId: profileA.profileId, section: "home" };

	it("starts on Agents and switches lists without leaving the page", () => {
		const { element } = rail(home);
		expect(tabs(element)).toEqual([
			["Agents", "true"],
			["Interfaces", "false"],
		]);
		expect(element.querySelector(".rail-scroll:not(.rail-interfaces)")).not.toBeNull();
		expect(element.querySelector(".rail-interfaces")).toBeNull();
		const before = location.hash;
		element.querySelectorAll<HTMLButtonElement>(".rail-switch-tab")[1]!.click();
		expect(tabs(element)[1]).toEqual(["Interfaces", "true"]);
		expect(location.hash).toBe(before);
		const pulse = element.querySelector<HTMLAnchorElement>(".rail-interfaces a.interface-home");
		expect(pulse?.textContent).toBe("Pulse");
		expect(pulse?.getAttribute("href")).toBe(`#/c/${profileA.profileId}/i/pulse`);
		expect(element.querySelector(".rail-add")?.hasAttribute("hidden")).toBe(true);
		expect(sessionStorage.getItem(`qorpera.web.rail-tab:${profileA.profileId}`)).toBe("interfaces");
	});

	it("lets the route pick the tab, and marks the open interface", () => {
		const { element, draw } = rail({
			name: "company",
			profileId: profileA.profileId,
			section: "interface",
			id: "pulse",
		});
		expect(tabs(element)[1]).toEqual(["Interfaces", "true"]);
		expect(element.querySelector(".interface-home")?.getAttribute("aria-current")).toBe("page");
		draw({ name: "company", profileId: profileA.profileId, section: "staff", id: ada.id });
		expect(tabs(element)[0]).toEqual(["Agents", "true"]);
		draw({ name: "company", profileId: profileA.profileId, section: "file" });
		expect(tabs(element)[0]).toEqual(["Agents", "true"]);
	});

	it("filters interfaces by the search field", () => {
		const { element, draw } = rail({
			name: "company",
			profileId: profileA.profileId,
			section: "interface",
			id: "pulse",
		});
		const input = element.querySelector<HTMLInputElement>(".rail-search input")!;
		input.value = "mail";
		draw({ name: "company", profileId: profileA.profileId, section: "interface", id: "pulse" });
		expect(element.querySelector(".rail-interfaces")?.textContent).toBe("No matching interfaces.");
	});
});

describe("review round 1 (web)", () => {
	it("draws Pulse again after another page took the area, and follows the company", () => {
		const { controller } = company([run(ada.id, 1, {})]);
		const main = h("main");
		document.body.append(main);
		renderInterface(main, controller, "pulse");
		const pulse = main.firstElementChild;
		main.replaceChildren(h("section", null, "a thread"));
		renderInterface(main, controller, "pulse");
		expect(main.firstElementChild).not.toBe(pulse);
		expect(main.querySelector(".interface-title h1")?.textContent).toBe("Pulse");
	});

	it("shows rows in the block's order", () => {
		const { controller } = company([
			run(ada.id, 1, { updatedAt: "2026-10-02T09:00:00Z" }),
			run(bo.id, 2, { updatedAt: "2026-10-02T10:00:00Z" }),
		]);
		const rows = interfaceRows(controller, "working") ?? [];
		expect(rows.map(({ row }) => row.agent)).toEqual([ada.id, bo.id]);
		// Library Pulse lists "Working now" in source order; an ordered block keeps the query's order.
		const main = h("main");
		renderInterface(main, controller, "pulse");
		expect([...main.querySelectorAll(".interface-block:nth-child(2) strong")].map((el) => el.textContent)).toEqual([
			"Ada",
			"Bo",
		]);
	});

	it("waits while the company loads and says when live updates are not connected", () => {
		const { controller } = company();
		controller.store.set({ loading: true, staff: [] });
		const main = h("main");
		renderInterface(main, controller, "pulse");
		expect(main.querySelector(".interface-waiting")).not.toBeNull();
		expect(main.textContent).not.toContain("Nothing here right now.");
		controller.store.set({ loading: false, staff: [cofounder, ada, bo, cy], realtime: "connecting" });
		renderInterface(main, controller, "pulse");
		expect(main.querySelector(".interface-live")?.textContent).toBe("connecting");
		controller.store.set({ realtime: "connected" });
		renderInterface(main, controller, "pulse");
		expect(main.querySelector(".interface-live")?.textContent).toBe("Live");
	});

	it("calls a waiting decision a review, and skips mentions the rail doesn't offer", () => {
		const closed = { ...session, sessionId: id(301), status: "closed" as const, title: "Closed" };
		const { controller } = company([run(cy.id, 3, { activity: "needs_attention", jobStatus: "leased" })], {
			mentions: { [session.sessionId]: 1, [closed.sessionId]: 1 },
		});
		controller.store.set({ sessions: [session, closed] });
		const waiting = interfaceRows(controller, "waiting") ?? [];
		expect(waiting.map(({ row }) => row.kind)).toEqual(["review", "mention"]);
	});

	it("labels the search for the list it searches", () => {
		const { f, controller } = company();
		const element = h("aside", { class: "rail" });
		document.body.append(h("div", { class: "frame" }, element));
		const auth = new AuthController(f.cloud);
		cleanup.push(() => auth.dispose());
		const route: Route = { name: "company", profileId: profileA.profileId, section: "interface", id: "pulse" };
		renderRail(element, controller, {
			profiles: [profileA],
			user: userA,
			route,
			auth,
			invitations: 0,
			openSettings: () => {},
			openFeedback: () => {},
			agentActions: {},
		});
		expect(element.querySelector(".rail-search input")?.getAttribute("aria-label")).toBe("Search interfaces");
		expect(element.querySelector(".rail-switch")?.getAttribute("role")).toBe("group");
		expect(element.querySelectorAll("[role=tab]")).toHaveLength(0);
		expect(element.querySelector(".interface-home")?.getAttribute("aria-label")).toBe("Pulse");
	});
});
