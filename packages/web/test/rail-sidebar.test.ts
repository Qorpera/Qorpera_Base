// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthController } from "../src/app/auth.ts";
import { CompanyController } from "../src/app/company.ts";
import type { Route } from "../src/app/router.ts";
import { renderRail, type ShellContext } from "../src/app/views/shell.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import {
	applySidebarRequest,
	type CompanySidebar,
	containerOrder,
	parseCompanySidebar,
	type SidebarRequest,
} from "../src/cloud/sidebar.ts";
import type { HostedStaffAgent, HostedStaffExecutionActivity } from "../src/cloud/types.ts";
import { openMenu } from "../src/ui/context-menu.ts";
import { h } from "../src/ui/dom.ts";
import { deferred, fixture, id, profileA, session, settle, staff, stubFigureMotion, team, userA } from "./fixtures.ts";

const agent = (n: number, name: string): HostedStaffAgent => ({
	...staff,
	id: id(n),
	displayName: name,
	role: `${name} role`,
});
const cofounder: HostedStaffAgent = { ...agent(40, "Co-Founder"), templateId: "co-founder" };
const [ada, bo, cy, dee] = [agent(41, "Ada"), agent(42, "Bo"), agent(43, "Cy"), agent(44, "Dee")];
const research = id(60);
const ops = id(61);
const roster = [ada.id, bo.id, cy.id, dee.id];
const demo = (): CompanySidebar => ({
	sections: [
		{ sectionId: research, name: "Research" },
		{ sectionId: ops, name: "Ops" },
	],
	placements: { [bo.id]: { sectionId: research, position: 0 }, [ada.id]: { sectionId: research, position: 1 } },
	pinned: [dee.id],
	hidden: [],
});

const activityRow: HostedStaffExecutionActivity = {
	staffAgentId: "",
	runId: id(80),
	sourceKind: "session_turn",
	activity: "working",
	jobStatus: "leased",
	updatedAt: "2026-09-05T10:00:00Z",
};

const cleanup: (() => void)[] = [];
beforeEach(() => {
	stubFigureMotion();
	vi.stubGlobal("innerWidth", 1280);
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
	for (const dispose of cleanup.splice(0).reverse()) dispose();
	openMenu()?.close();
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

/** A company whose cloud answers the sidebar like the real RPCs do (the same rules as the client). */
function companyWith(sidebar: CompanySidebar | "missing", actions: ShellContext["agentActions"] = {}) {
	const f = fixture();
	let stored = sidebar === "missing" ? undefined : sidebar;
	const read = vi.spyOn(f.api, "readCompanySidebar");
	if (stored) read.mockImplementation(async () => structuredClone(stored!));
	const manage = vi.spyOn(f.api, "manageCompanySidebar").mockImplementation(async (_profileId, request) => {
		stored = applySidebarRequest(stored!, request, roster);
		return structuredClone(stored);
	});
	const company = new CompanyController(f.api, profileA, userA.id);
	company.store.set({ loading: false, staff: [cofounder, ada, bo, cy, dee], sessions: [session], team });
	cleanup.push(() => company.stop());
	const rail = h("aside", { class: "rail" });
	document.body.append(h("div", { class: "frame" }, rail));
	const auth = new AuthController(f.cloud);
	cleanup.push(() => auth.dispose());
	const route: Route = { name: "company", profileId: profileA.profileId, section: "home" };
	const draw = () =>
		renderRail(rail, company, {
			profiles: [profileA],
			user: userA,
			route,
			auth,
			invitations: 0,
			openSettings: () => {},
			openFeedback: () => {},
			agentActions: actions,
		});
	cleanup.push(company.store.subscribe(draw));
	draw();
	return { f, company, rail, draw, manage, read, ready: company.refreshSidebar() };
}

const names = (elements: Iterable<Element>) =>
	[...elements].map((element) => element.querySelector("strong")?.textContent);
const groups = (rail: HTMLElement) =>
	[...rail.querySelectorAll<HTMLElement>(".rail-section")].map((group) => [
		group.querySelector<HTMLElement>(".rail-section-title")!.hidden
			? ""
			: group.querySelector(".rail-section-title")!.textContent,
		...names(group.querySelectorAll(".rail-section-list > a")),
	]);
const rowOf = (rail: HTMLElement, name: string) =>
	[...rail.querySelectorAll<HTMLElement>("[data-agent-id], [data-cofounder-id]")].find(
		(row) => row.querySelector("strong")?.textContent === name,
	)!;
function rightClick(element: Element) {
	element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
}
const menuItems = () =>
	[...document.querySelectorAll<HTMLElement>(".context-menu [role^=menuitem]")].map((item) => item.textContent);
const choose = (label: string) =>
	[...document.querySelectorAll<HTMLElement>(".context-menu [role^=menuitem]")]
		.find((item) => item.textContent === label)!
		.click();

describe("sidebar model", () => {
	it("parses the member's sidebar and refuses a malformed one", () => {
		const parsed = parseCompanySidebar({
			schema: "qorpera.company-sidebar/v1",
			sections: [{ sectionId: research.toUpperCase(), name: "Research" }],
			placements: [
				{ staffAgentId: bo.id, sectionId: research, position: 0 },
				{ staffAgentId: ada.id, sectionId: null, position: 3 },
			],
			pinned: [dee.id],
			hidden: [cy.id],
		});
		expect(parsed).toEqual({
			sections: [{ sectionId: research, name: "Research" }],
			placements: { [bo.id]: { sectionId: research, position: 0 }, [ada.id]: { position: 3 } },
			pinned: [dee.id],
			hidden: [cy.id],
		});
		expect(() =>
			parseCompanySidebar({ schema: "qorpera.company-sidebar/v1", sections: [], placements: [{}] }),
		).toThrow();
		expect(() => parseCompanySidebar({ schema: "other" })).toThrow();
	});
	it("orders a section by position, then the rest in roster order, as the cloud does", () => {
		const sidebar = demo();
		expect(containerOrder(sidebar, research, roster)).toEqual([bo.id, ada.id]);
		expect(containerOrder(sidebar, undefined, roster)).toEqual([cy.id, dee.id]);
		// A section that is gone leaves its agents Unassigned.
		expect(containerOrder({ ...sidebar, sections: [] }, undefined, roster)).toEqual(roster);
	});
	it("draws each change the way the cloud will answer it", () => {
		const apply = (request: SidebarRequest, from = demo()) => applySidebarRequest(from, request, roster);
		expect(
			containerOrder(apply({ action: "move_agent", staffAgentId: cy.id, sectionId: research }), research, roster),
		).toEqual([bo.id, ada.id, cy.id]);
		const ordered = apply({ action: "move_agent", staffAgentId: cy.id, sectionId: research, order: [cy.id, ada.id] });
		expect(containerOrder(ordered, research, roster)).toEqual([cy.id, ada.id, bo.id]);
		const deleted = apply({ action: "delete_section", sectionId: research });
		expect(deleted.sections.map((section) => section.name)).toEqual(["Ops"]);
		expect(containerOrder(deleted, undefined, roster)).toEqual([cy.id, dee.id, bo.id, ada.id]);
		expect(apply({ action: "set_hidden", staffAgentId: dee.id, hidden: true })).toMatchObject({
			pinned: [],
			hidden: [dee.id],
		});
		expect(apply({ action: "set_pins", order: [cy.id] }, { ...demo(), hidden: [cy.id] })).toMatchObject({
			pinned: [cy.id],
			hidden: [],
		});
		const created = apply({
			action: "create_section",
			sectionId: id(62),
			name: "Sales",
			staffAgentId: dee.id,
			unpin: true,
		});
		expect(created.sections.at(-1)).toEqual({ sectionId: id(62), name: "Sales" });
		expect(created.pinned).toEqual([]);
		expect(containerOrder(created, id(62), roster)).toEqual([dee.id]);
	});
});

describe("rail sections and pins", () => {
	it("stands pinned agents as cards under the Co-Founder, then sections, then Unassigned", async () => {
		const { rail, ready } = companyWith(demo());
		await ready;
		await settle();
		const list = rail.querySelector(".rail-scroll")!;
		const order = [...list.children].map((child) => child.className.split(" ")[0]);
		expect(order).toEqual(["rail-cofounder", "rail-pinned", "rail-section", "rail-section", "rail-section"]);
		expect(names(rail.querySelectorAll(".rail-pin"))).toEqual(["Dee"]);
		expect(groups(rail)).toEqual([["Research", "Bo", "Ada"], ["Ops"], ["Unassigned", "Cy", "Fixture conversation"]]);
		expect(rail.querySelector(".rail-pinned")!.getAttribute("aria-label")).toBe("Pinned agents");
	});
	it("keeps one list, with no drop zones, on a cloud without the sidebar", async () => {
		const { rail, ready } = companyWith("missing");
		await ready;
		await settle();
		expect(groups(rail)).toEqual([["", "Ada", "Bo", "Cy", "Dee", "Fixture conversation"]]);
		expect(rail.querySelector("[data-drop-zone]")).toBeNull();
		expect(rail.querySelector(".rail-pinned")?.isConnected).toBeFalsy();
	});
	it("leaves hidden agents out until a search asks for them", async () => {
		const { rail, draw, ready } = companyWith({ ...demo(), hidden: [cy.id] });
		await ready;
		await settle();
		expect(groups(rail).at(-1)).toEqual(["Unassigned", "Fixture conversation"]);
		const input = rail.querySelector<HTMLInputElement>(".rail-search input")!;
		input.value = "cy";
		draw();
		expect(groups(rail)).toEqual([["Unassigned", "Cy"]]);
	});
	it("folds hidden agents at the foot of the list, where they can be shown again", async () => {
		localStorage.removeItem("qorpera.web.rail-hidden-open");
		const { rail, manage, ready } = companyWith({ ...demo(), hidden: [cy.id, dee.id], pinned: [] });
		await ready;
		await settle();
		const list = rail.querySelector(".rail-scroll")!;
		const hidden = rail.querySelector<HTMLElement>(".rail-hidden")!;
		const toggle = hidden.querySelector<HTMLButtonElement>(".rail-hidden-toggle")!;
		// The last thing in the list: "Hidden agents" and the count, folded.
		expect([...list.children].filter((child) => !child.matches(".rail-empty")).at(-1)).toBe(hidden);
		expect(toggle.textContent).toBe("Hidden agents2");
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(hidden.querySelector(".rail-hidden-list")!.children.length).toBe(0);
		toggle.click();
		await settle();
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		expect(hidden.querySelector<HTMLElement>(".rail-hidden-count")!.hidden).toBe(true);
		expect(hidden.querySelector<HTMLElement>(".rail-hidden-chevron")!.hidden).toBe(false);
		expect(names(hidden.querySelectorAll(".rail-hidden-list > a"))).toEqual(["Cy", "Dee"]);
		expect(localStorage.getItem("qorpera.web.rail-hidden-open")).toBe("1");
		// A hidden agent's menu shows it again.
		rightClick(rowOf(rail, "Dee"));
		expect(menuItems()).toContain("Show in sidebar");
		choose("Show in sidebar");
		await settle();
		expect(manage).toHaveBeenLastCalledWith(profileA.profileId, {
			action: "set_hidden",
			staffAgentId: dee.id,
			hidden: false,
		});
		expect(names(hidden.querySelectorAll(".rail-hidden-list > a"))).toEqual(["Cy"]);
		expect(groups(rail).at(-1)).toEqual(["Unassigned", "Dee", "Fixture conversation"]);
		// Moving a hidden agent to a section shows it there.
		rightClick(rowOf(rail, "Cy"));
		document
			.querySelector<HTMLElement>(".context-menu [aria-haspopup=menu]")!
			.dispatchEvent(new PointerEvent("pointerenter"));
		choose("Ops");
		await settle();
		expect(manage.mock.calls.slice(-2).map(([, request]) => request)).toEqual([
			{ action: "set_hidden", staffAgentId: cy.id, hidden: false },
			{ action: "move_agent", staffAgentId: cy.id, sectionId: ops },
		]);
		expect(groups(rail)[1]).toEqual(["Ops", "Cy"]);
		// Nothing left hidden: the group leaves the list.
		expect(rail.querySelector(".rail-hidden")).toBeNull();
	});
	it("marks the groups the collapsed rail parts with a line: never under the Co-Founder, never around an empty section", async () => {
		const divided = (rail: HTMLElement) =>
			[...rail.querySelectorAll(".rail-section.rail-divided")].map(
				(group) => group.querySelector(".rail-section-title")!.textContent,
			);
		const none: CompanySidebar = { sections: [], placements: {}, pinned: [], hidden: [] };
		const cases: [CompanySidebar | "missing", string[]][] = [
			[demo(), ["Research", "Unassigned"]],
			[{ ...demo(), pinned: [] }, ["Unassigned"]],
			// A pinned agent that is hidden leaves no pinned row to part from.
			[{ ...demo(), hidden: [dee.id] }, ["Unassigned"]],
			[{ ...none, pinned: [dee.id] }, ["Unassigned"]],
			[none, []],
			["missing", []],
		];
		for (const [sidebar, expected] of cases) {
			const { rail, ready } = companyWith(sidebar);
			await ready;
			await settle();
			expect(divided(rail)).toEqual(expected);
		}
	});
});

describe("rail right-click menus", () => {
	it("opens the menu on a right-click in the page's first moments", async () => {
		// The long-press guard swallows the browser's own menu for 800 ms after a
		// press opened one; with no press yet, nothing is swallowed, however new the page.
		vi.spyOn(performance, "now").mockReturnValue(100);
		const { rail, ready } = companyWith(demo(), { updateAgent: vi.fn(), deleteAgent: vi.fn() });
		await ready;
		await settle();
		rightClick(rowOf(rail, "Cy"));
		expect(menuItems()).toContain("Rename");
	});
	it("offers Grok Bot's agent menu and sends what is chosen", async () => {
		const { rail, manage, ready } = companyWith(demo(), { updateAgent: vi.fn(), deleteAgent: vi.fn() });
		await ready;
		await settle();
		rightClick(rowOf(rail, "Cy"));
		expect(menuItems()).toEqual(["Pin", "Move to", "Rename", "Hide from sidebar", "Delete"]);
		expect(rowOf(rail, "Cy").classList.contains("menu-open")).toBe(true);
		// The submenu lists the sections with the current one checked, then New section.
		document
			.querySelector<HTMLElement>(".context-menu [aria-haspopup=menu]")!
			.dispatchEvent(new PointerEvent("pointerenter"));
		const submenu = document.querySelector(".context-submenu")!;
		expect([...submenu.querySelectorAll("[role^=menuitem]")].map((item) => item.textContent)).toEqual([
			"Research",
			"Ops",
			"Unassigned",
			"New section",
		]);
		expect(submenu.querySelector("[aria-checked=true]")!.textContent).toBe("Unassigned");
		choose("Ops");
		await ready;
		await settle();
		expect(manage).toHaveBeenLastCalledWith(profileA.profileId, {
			action: "move_agent",
			staffAgentId: cy.id,
			sectionId: ops,
		});
		expect(groups(rail)[1]).toEqual(["Ops", "Cy"]);
		expect(openMenu()).toBeUndefined();
		rightClick(rowOf(rail, "Dee"));
		expect(menuItems()[0]).toBe("Unpin");
		choose("Unpin");
		await ready;
		await settle();
		expect(manage).toHaveBeenLastCalledWith(profileA.profileId, { action: "set_pins", order: [] });
		expect(rail.querySelector(".rail-pinned")!.classList.contains("is-empty")).toBe(true);
	});
	it("moves a pinned agent out of the pinned row, and leaves an agent where it already is", async () => {
		const { rail, manage, ready } = companyWith(demo());
		await ready;
		await settle();
		const openMoveTo = (name: string) => {
			rightClick(rowOf(rail, name));
			document
				.querySelector<HTMLElement>(".context-menu [aria-haspopup=menu]")!
				.dispatchEvent(new PointerEvent("pointerenter"));
		};
		openMoveTo("Bo");
		choose("Research");
		await settle();
		expect(manage).not.toHaveBeenCalled();
		expect(groups(rail)[0]).toEqual(["Research", "Bo", "Ada"]);
		openMoveTo("Dee");
		choose("Ops");
		await settle();
		expect(manage).toHaveBeenLastCalledWith(profileA.profileId, {
			action: "move_agent",
			staffAgentId: dee.id,
			sectionId: ops,
			unpin: true,
		});
		expect(names(rail.querySelectorAll(".rail-pin"))).toEqual([]);
		expect(groups(rail)[1]).toEqual(["Ops", "Dee"]);
	});
	it("never shows a network error's text, and leaves Shift+right-click to the browser", async () => {
		const { rail, manage, ready } = companyWith(demo());
		await ready;
		await settle();
		manage.mockRejectedValueOnce(
			new CloudRpcError("qorpera_manage_company_sidebar", { message: "TypeError: Failed to fetch" }, 0),
		);
		rightClick(rowOf(rail, "Cy"));
		choose("Pin");
		await settle();
		expect(rail.querySelector(".notice")?.textContent).toContain("The sidebar could not be changed. Try again.");
		expect(rail.querySelector(".notice")?.textContent).not.toContain("fetch");
		const shifted = new MouseEvent("contextmenu", {
			bubbles: true,
			cancelable: true,
			shiftKey: true,
			clientX: 30,
			clientY: 30,
		});
		rowOf(rail, "Cy").dispatchEvent(shifted);
		expect(shifted.defaultPrevented).toBe(false);
		expect(openMenu()).toBeUndefined();
	});
	it("leaves a deleted agent out of the pins it sends", async () => {
		const { rail, manage, company, ready } = companyWith({ ...demo(), pinned: [dee.id, id(99)] });
		await ready;
		await settle();
		rightClick(rowOf(rail, "Cy"));
		choose("Pin");
		await settle();
		expect(manage).toHaveBeenLastCalledWith(profileA.profileId, { action: "set_pins", order: [dee.id, cy.id] });
		expect(company.store.get().railError).toBeUndefined();
	});
	it("moves the focused agent with Alt and an arrow, and returns focus to a rebuilt row", async () => {
		const { rail, manage, company, ready } = companyWith(demo());
		await ready;
		await settle();
		const ada2 = rowOf(rail, "Ada");
		ada2.focus();
		ada2.dispatchEvent(
			new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true, cancelable: true }),
		);
		await settle();
		expect(manage).toHaveBeenLastCalledWith(profileA.profileId, {
			action: "move_agent",
			staffAgentId: ada.id,
			sectionId: research,
			order: [ada.id, bo.id],
		});
		expect(groups(rail)[0]).toEqual(["Research", "Ada", "Bo"]);
		// The menu's row is rebuilt while it is open (the agent starts working): Escape still lands on the row.
		rightClick(rowOf(rail, "Bo"));
		company.store.set({
			activity: [{ ...activityRow, staffAgentId: bo.id }],
		});
		await settle();
		document
			.querySelector(".context-menu")!
			.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(document.activeElement).toBe(rowOf(rail, "Bo"));
	});
	it("gives the Co-Founder no pin, move, hide or delete", async () => {
		const { rail, company, ready } = companyWith(demo(), { updateAgent: vi.fn(), deleteAgent: vi.fn() });
		company.store.set({
			sessions: [
				{ ...session, sessionId: id(70), staffAgentId: cofounder.id, executionScope: { agentThread: true } },
			],
		});
		await ready;
		await settle();
		rightClick(rail.querySelector(".cofounder-home")!);
		expect(menuItems()).toEqual(["Rename", "Copy conversation ID"]);
	});
	it("leaves shared sections to members who can write", async () => {
		const { rail, company, ready } = companyWith(demo(), { updateAgent: vi.fn(), deleteAgent: vi.fn() });
		company.store.set({
			team: {
				...team,
				role: "viewer",
				capabilities: { read: true, write: false, authorize: false, manageMembers: false },
			},
		});
		await ready;
		await settle();
		rightClick(rowOf(rail, "Cy"));
		// A viewer keeps their own pins and hidden agents.
		expect(menuItems()).toEqual(["Pin", "Hide from sidebar"]);
		openMenu()?.close();
		const title = rail.querySelector(".rail-section-title[data-section-id]")!;
		const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
		title.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(false);
		expect(openMenu()).toBeUndefined();
	});
	it("renames and deletes sections, and makes new ones from the rail", async () => {
		const { rail, manage, ready } = companyWith(demo());
		await ready;
		await settle();
		rightClick(rail.querySelector(".rail-section-title[data-section-id]")!);
		expect(menuItems()).toEqual(["Rename section", "Delete section"]);
		choose("Rename section");
		const input = document.querySelector<HTMLInputElement>(".name-dialog-input")!;
		expect(input.value).toBe("Research");
		expect(document.activeElement).toBe(input);
		input.value = "  Labs   team ";
		input.dispatchEvent(new Event("input"));
		input.form!.requestSubmit();
		await ready;
		await settle();
		expect(manage).toHaveBeenLastCalledWith(profileA.profileId, {
			action: "rename_section",
			sectionId: research,
			name: "Labs team",
		});
		expect(groups(rail)[0]![0]).toBe("Labs team");
		// An empty spot in the rail offers a new section.
		rightClick(rail.querySelector(".rail-scroll")!);
		expect(menuItems()).toEqual(["New section"]);
		choose("New section");
		const name = document.querySelector<HTMLInputElement>(".name-dialog-input")!;
		name.value = "labs TEAM";
		name.dispatchEvent(new Event("input"));
		name.form!.requestSubmit();
		await ready;
		await settle();
		// The name is taken: nothing is sent and the rail says why.
		expect(manage).toHaveBeenCalledTimes(1);
		expect(rail.querySelector(".notice")?.textContent).toContain('A section called "Labs team" already exists.');
	});
	it("puts back what the cloud refused and says why", async () => {
		const { rail, manage, ready } = companyWith(demo());
		await ready;
		await settle();
		const refusal = deferred<CompanySidebar>();
		manage.mockImplementationOnce(() => refusal.promise);
		rightClick(rowOf(rail, "Cy"));
		document
			.querySelector<HTMLElement>(".context-menu [aria-haspopup=menu]")!
			.dispatchEvent(new PointerEvent("pointerenter"));
		choose("Research");
		await settle();
		// Drawn at once, before the cloud answers.
		expect(groups(rail)[0]).toEqual(["Research", "Bo", "Ada", "Cy"]);
		refusal.reject(
			new CloudRpcError(
				"qorpera_manage_company_sidebar",
				{ message: "No section is called that", code: "P0002" },
				404,
			),
		);
		await settle();
		expect(groups(rail)[0]).toEqual(["Research", "Bo", "Ada"]);
		expect(rail.querySelector(".notice")?.textContent).toContain("No section is called that");
	});
	it("renames an agent through its document and deletes one after confirming", async () => {
		const updateAgent = vi.fn(async () => 2);
		const deleteAgent = vi.fn(async () => {});
		const { rail, f, ready } = companyWith(demo(), { updateAgent, deleteAgent });
		await ready;
		await settle();
		const listStaff = vi.spyOn(f.api, "listStaff").mockResolvedValue([cofounder, ada, bo, cy, dee]);
		rightClick(rowOf(rail, "Cy"));
		choose("Rename");
		const input = document.querySelector<HTMLInputElement>(".name-dialog-input")!;
		input.value = "Cyra";
		input.dispatchEvent(new Event("input"));
		input.form!.requestSubmit();
		await ready;
		await settle();
		expect(updateAgent).toHaveBeenCalledWith(
			cy,
			expect.objectContaining({ displayName: "Cyra", role: cy.role }),
			expect.any(AbortSignal),
		);
		expect(listStaff).toHaveBeenCalled();
		rightClick(rowOf(rail, "Cy"));
		choose("Delete");
		expect(document.querySelector(".modal p")?.textContent).toContain("Delete Cy?");
		[...document.querySelectorAll<HTMLButtonElement>(".modal button")]
			.find((button) => button.textContent === "Delete")!
			.click();
		await ready;
		await settle();
		expect(deleteAgent).toHaveBeenCalledWith(cy, expect.any(AbortSignal));
	});
});

describe("dragging agents in the rail", () => {
	let boxSpy: ReturnType<typeof vi.spyOn> | undefined;
	afterEach(() => {
		boxSpy = undefined;
	});
	/** jsdom has no layout: each row and zone gets a box, top to bottom in document order. */
	function layout(rail: HTMLElement) {
		const boxes = new Map<Element, DOMRect>();
		let y = 0;
		for (const element of rail.querySelectorAll<HTMLElement>(
			".rail-scroll, [data-drop-zone], [data-agent-id], .rail-section-title",
		)) {
			if (element.matches(".rail-scroll")) continue;
			const height = element.matches("[data-drop-zone]") ? 0 : 40;
			boxes.set(element, new DOMRect(0, y, 300, height));
			y += height;
		}
		// A zone spans its children.
		for (const zone of rail.querySelectorAll<HTMLElement>("[data-drop-zone]")) {
			const inner = [...zone.querySelectorAll("[data-agent-id], .rail-section-title")].map(
				(child) => boxes.get(child)!,
			);
			const top = inner.length ? Math.min(...inner.map((box) => box.top)) : 0;
			const bottom = inner.length ? Math.max(...inner.map((box) => box.bottom)) : 0;
			boxes.set(zone, new DOMRect(0, top, 300, bottom - top));
		}
		boxSpy?.mockRestore();
		boxSpy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
			return this.matches(".rail-scroll") ? new DOMRect(0, 0, 300, 1000) : (boxes.get(this) ?? new DOMRect());
		});
		document.elementsFromPoint = (x: number, y: number) =>
			[...boxes]
				.filter(([, box]) => x >= box.left && x <= box.right && y >= box.top && y < box.bottom)
				.map(([element]) => element)
				.reverse();
		return boxes;
	}
	const pointer = (type: string, x: number, y: number) =>
		new PointerEvent(type, {
			bubbles: true,
			cancelable: true,
			pointerId: 1,
			pointerType: "mouse",
			button: 0,
			clientX: x,
			clientY: y,
		});
	function drag(from: Element, to: DOMRect, rail: HTMLElement) {
		const start = from.getBoundingClientRect();
		from.dispatchEvent(pointer("pointerdown", 20, start.top + 20));
		document.dispatchEvent(pointer("pointermove", 20, start.top + 34));
		document.dispatchEvent(pointer("pointermove", 20, to.top + 5));
		const lit = rail.querySelector<HTMLElement>(".is-drop-target")?.dataset.dropZone;
		document.dispatchEvent(pointer("pointerup", 20, to.top + 5));
		return lit;
	}
	it("moves an agent above another in a section and swallows the click that ends the drag", async () => {
		const { rail, manage, ready } = companyWith(demo());
		await ready;
		await settle();
		const boxes = layout(rail);
		const lit = drag(rowOf(rail, "Cy"), boxes.get(rowOf(rail, "Ada"))!, rail);
		expect(lit).toBe(`section:${research}`);
		const click = new MouseEvent("click", { bubbles: true, cancelable: true });
		rowOf(rail, "Cy").dispatchEvent(click);
		expect(click.defaultPrevented).toBe(true);
		await ready;
		await settle();
		expect(manage).toHaveBeenLastCalledWith(profileA.profileId, {
			action: "move_agent",
			staffAgentId: cy.id,
			sectionId: research,
			order: [bo.id, cy.id, ada.id],
		});
		expect(groups(rail)[0]).toEqual(["Research", "Bo", "Cy", "Ada"]);
		expect(document.querySelector(".rail-drag-ghost")).toBeNull();
	});
	it("pins by dragging into the pinned row and unpins by dragging out", async () => {
		const { rail, manage, ready } = companyWith(demo());
		await ready;
		await settle();
		let boxes = layout(rail);
		drag(rowOf(rail, "Bo"), boxes.get(rowOf(rail, "Dee"))!, rail);
		await ready;
		await settle();
		expect(manage).toHaveBeenLastCalledWith(profileA.profileId, { action: "set_pins", order: [bo.id, dee.id] });
		expect(names(rail.querySelectorAll(".rail-pin"))).toEqual(["Bo", "Dee"]);
		boxes = layout(rail);
		const cyRow = rowOf(rail, "Cy");
		drag(rail.querySelector(".rail-pin")!, boxes.get(cyRow)!, rail);
		await ready;
		await settle();
		expect(manage).toHaveBeenLastCalledWith(profileA.profileId, {
			action: "move_agent",
			staffAgentId: bo.id,
			sectionId: null,
			order: [bo.id, cy.id, dee.id],
			unpin: true,
		});
		expect(names(rail.querySelectorAll(".rail-pin"))).toEqual(["Dee"]);
	});
	it("shows a hidden agent again where it is dragged out of Hidden agents", async () => {
		localStorage.setItem("qorpera.web.rail-hidden-open", "1");
		const { rail, manage, ready } = companyWith({ ...demo(), hidden: [cy.id] });
		await ready;
		await settle();
		const boxes = layout(rail);
		drag(rowOf(rail, "Cy"), boxes.get(rowOf(rail, "Ada"))!, rail);
		await settle();
		expect(manage.mock.calls.slice(-2).map(([, request]) => request)).toEqual([
			{ action: "set_hidden", staffAgentId: cy.id, hidden: false },
			{ action: "move_agent", staffAgentId: cy.id, sectionId: research, order: [bo.id, cy.id, ada.id] },
		]);
		expect(groups(rail)[0]).toEqual(["Research", "Bo", "Cy", "Ada"]);
		expect(rail.querySelector(".rail-hidden")).toBeNull();
		localStorage.removeItem("qorpera.web.rail-hidden-open");
	});
	it("keeps the drop spot when the rail redraws mid-drag", async () => {
		const { rail, manage, company, ready } = companyWith(demo());
		await ready;
		await settle();
		const boxes = layout(rail);
		const row = rowOf(rail, "Cy");
		const target = boxes.get(rowOf(rail, "Ada"))!;
		row.dispatchEvent(pointer("pointerdown", 20, boxes.get(row)!.top + 20));
		document.dispatchEvent(pointer("pointermove", 20, boxes.get(row)!.top + 34));
		document.dispatchEvent(pointer("pointermove", 20, target.top + 5));
		expect(rail.querySelector(".rail-drop-marker")).not.toBeNull();
		// An activity poll redraws the rail while the pointer holds still.
		company.store.set({ activity: [] });
		await settle();
		expect(rail.querySelector(".rail-drop-marker")).not.toBeNull();
		expect(rail.querySelector(".is-drop-target")?.getAttribute("data-drop-zone")).toBe(`section:${research}`);
		document.dispatchEvent(pointer("pointerup", 20, target.top + 5));
		await settle();
		expect(manage).toHaveBeenLastCalledWith(profileA.profileId, {
			action: "move_agent",
			staffAgentId: cy.id,
			sectionId: research,
			order: [bo.id, cy.id, ada.id],
		});
	});
	it("does not pick an agent up while searching, and Escape puts a drag back", async () => {
		const { rail, manage, draw, ready } = companyWith(demo());
		await ready;
		await settle();
		let boxes = layout(rail);
		const row = rowOf(rail, "Cy");
		row.dispatchEvent(pointer("pointerdown", 20, boxes.get(row)!.top + 20));
		document.dispatchEvent(pointer("pointermove", 20, boxes.get(row)!.top + 60));
		expect(rail.querySelector(".rail-scroll")!.classList.contains("rail-dragging")).toBe(true);
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(rail.querySelector(".rail-scroll")!.classList.contains("rail-dragging")).toBe(false);
		document.dispatchEvent(pointer("pointerup", 20, 0));
		const input = rail.querySelector<HTMLInputElement>(".rail-search input")!;
		input.value = "c";
		draw();
		boxes = layout(rail);
		drag(rowOf(rail, "Cy"), boxes.get(rowOf(rail, "Cy"))!, rail);
		expect(document.querySelector(".rail-drag-ghost")).toBeNull();
		await ready;
		await settle();
		expect(manage).not.toHaveBeenCalled();
	});
});
