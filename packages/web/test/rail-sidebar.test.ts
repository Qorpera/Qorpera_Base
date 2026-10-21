// @vitest-environment jsdom
import { parseCompanyStateFile, writeSectionsFile } from "@qorpera/cloud-client/company-state-files";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthController } from "../src/app/auth.ts";
import { CompanyController } from "../src/app/company.ts";
import type { Route } from "../src/app/router.ts";
import { renderRail, type ShellContext } from "../src/app/views/shell.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import type { GroupChatDetails } from "../src/cloud/group-details.ts";
import {
	applySidebarRequest,
	type CompanySidebar,
	containerOrder,
	parseCompanySidebar,
	type SidebarRequest,
} from "../src/cloud/sidebar.ts";
import { SECTIONS_PATH } from "../src/cloud/sidebar-sections-file.ts";
import type { HostedSession, HostedStaffAgent, HostedStaffExecutionActivity } from "../src/cloud/types.ts";
import { openMenu } from "../src/ui/context-menu.ts";
import { h } from "../src/ui/dom.ts";
import { deferred, fixture, id, profileA, session, settle, staff, stubFigureMotion, team, userA } from "./fixtures.ts";
import { folderFake } from "./folder-fake.ts";

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

const demoWire = () => ({
	schema: "qorpera.company-sidebar/v1",
	sections: [],
	placements: [],
	pinned: [],
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
function companyWith(
	sidebar: CompanySidebar | "missing",
	actions: ShellContext["agentActions"] = {},
	extra: {
		sessions?: HostedSession[];
		groups?: Record<string, GroupChatDetails>;
		roster?: string[];
		/** A shell that opens no cards: a right-click on an agent or a group chat is the browser's. */
		cardless?: boolean;
	} = {},
) {
	const f = fixture();
	let stored = sidebar === "missing" ? undefined : sidebar;
	const read = vi.spyOn(f.api, "readCompanySidebar");
	if (stored) read.mockImplementation(async () => structuredClone(stored!));
	const manage = vi.spyOn(f.api, "manageCompanySidebar").mockImplementation(async (_profileId, request) => {
		stored = applySidebarRequest(stored!, request, extra.roster ?? roster);
		return structuredClone(stored);
	});
	const company = new CompanyController(f.api, profileA, userA.id);
	company.store.set({
		loading: false,
		staff: [cofounder, ada, bo, cy, dee],
		sessions: [session, ...(extra.sessions ?? [])],
		team,
		...(extra.groups ? { groups: extra.groups } : {}),
	});
	cleanup.push(() => company.stop());
	const rail = h("aside", { class: "rail" });
	document.body.append(h("div", { class: "frame" }, rail));
	const auth = new AuthController(f.cloud);
	cleanup.push(() => auth.dispose());
	const route: Route = { name: "company", profileId: profileA.profileId, section: "home" };
	const openCard = vi.fn<NonNullable<ShellContext["openAgentCard"]>>();
	const openGroup = vi.fn<NonNullable<ShellContext["openGroupCard"]>>();
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
			...(extra.cardless ? {} : { openAgentCard: openCard, openGroupCard: openGroup }),
		});
	cleanup.push(company.store.subscribe(draw));
	draw();
	return { f, company, rail, draw, manage, read, openCard, openGroup, ready: company.refreshSidebar() };
}

/** A folder-v2 company: its sections are agents/sections.md, whose commit places the sidebar (sections keep their ids
 * by name), and the sidebar RPC refuses section changes and moves, as the cloud does; pins stay the RPC's. */
function companyWithFile(
	sections: [string, ...string[]][],
	pinned: string[] = [],
	/** A cloud that keeps the order of what is in no section (20260930519000). */
	keeps = false,
) {
	const fake = folderFake();
	fake.put(
		SECTIONS_PATH,
		writeSectionsFile({
			sections: sections.map(([name, ...ids]) => ({
				name,
				line: 0,
				members: ids.map((itemId) => ({ id: itemId, line: 0 })),
			})),
		}),
	);
	const sectionIds = new Map([
		["research", research],
		["ops", ops],
	]);
	let pins = [...pinned];
	const placed = (): CompanySidebar => {
		const parsed = parseCompanyStateFile(SECTIONS_PATH, fake.text(SECTIONS_PATH) ?? "");
		if (!parsed?.ok || parsed.file.kind !== "sections") throw new Error("agents/sections.md does not parse");
		const placements: CompanySidebar["placements"] = {};
		const list = parsed.file.sections.map((section) => {
			const key = section.name.toLowerCase();
			if (!sectionIds.has(key)) sectionIds.set(key, id(70 + sectionIds.size));
			const sectionId = sectionIds.get(key)!;
			section.members.forEach((member, position) => {
				placements[member.id] = { sectionId, position };
			});
			return { sectionId, name: section.name };
		});
		if (keeps)
			(parsed.file.unassigned ?? []).forEach((member, position) => {
				placements[member.id] = { position };
			});
		return {
			sections: list,
			placements,
			pinned: [...pins],
			hidden: [],
			groupChats: true,
			...(keeps ? { unassignedOrder: true } : {}),
		};
	};
	const made = companyWith(placed());
	made.read.mockImplementation(async () => placed());
	made.manage.mockImplementation(async (_profileId, request) => {
		if (request.action !== "set_pins")
			throw new CloudRpcError(
				"qorpera_manage_company_sidebar",
				{ message: "This company keeps its sections in agents/sections.md; edit that file", code: "55000" },
				400,
			);
		pins = [...request.order];
		return placed();
	});
	made.company.useSectionsFile(() => fake.folder);
	return { ...made, fake, placed };
}

/** The file's sections as names, each with its ids. */
function fileSections(text: string | undefined): [string, ...string[]][] {
	const parsed = parseCompanyStateFile(SECTIONS_PATH, text ?? "");
	if (!parsed?.ok || parsed.file.kind !== "sections") throw new Error("agents/sections.md does not parse");
	return parsed.file.sections.map((section) => [section.name, ...section.members.map((member) => member.id)]);
}
/** The ids the file orders in no section. */
function fileUnassigned(text: string | undefined): string[] {
	const parsed = parseCompanyStateFile(SECTIONS_PATH, text ?? "");
	if (!parsed?.ok || parsed.file.kind !== "sections") throw new Error("agents/sections.md does not parse");
	return (parsed.file.unassigned ?? []).map((member) => member.id);
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
	const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 });
	element.dispatchEvent(event);
	return event;
}
/** What the rail gave the card it opened last (an agent's or a group chat's): Copy, Hide (or Show) and Delete,
 * where the member can use them. */
const lastCard = <C>(open: { mock: { lastCall: [unknown, HTMLElement, C, ...unknown[]] | undefined } }) =>
	open.mock.lastCall![2];
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
	it("reads group chats' places beside the agents' where the cloud places them", () => {
		const room = id(91);
		const parsed = parseCompanySidebar({
			schema: "qorpera.company-sidebar/v1",
			sections: [{ sectionId: research, name: "Research" }],
			placements: [{ staffAgentId: bo.id, sectionId: research, position: 0 }],
			roomPlacements: [{ roomId: room.toUpperCase(), sectionId: research, position: 1 }],
			pinned: [room],
			hidden: [],
		});
		expect(parsed).toEqual({
			sections: [{ sectionId: research, name: "Research" }],
			placements: { [bo.id]: { sectionId: research, position: 0 }, [room]: { sectionId: research, position: 1 } },
			pinned: [room],
			hidden: [],
			groupChats: true,
		});
		expect(containerOrder(parsed, research, [...roster, room])).toEqual([bo.id, room]);
		// An older cloud places agents only.
		expect(parseCompanySidebar({ ...demoWire(), roomPlacements: undefined }).groupChats).toBeUndefined();
		expect(() => parseCompanySidebar({ ...demoWire(), roomPlacements: [{ roomId: room }] })).toThrow();
		const apply = (request: SidebarRequest) => applySidebarRequest(parsed, request, [...roster, room]);
		expect(
			containerOrder(
				apply({ action: "move_room", roomId: room, sectionId: research, order: [room, bo.id] }),
				research,
				[...roster, room],
			),
		).toEqual([room, bo.id]);
		expect(apply({ action: "set_hidden", roomId: room, hidden: true })).toMatchObject({
			pinned: [],
			hidden: [room],
			groupChats: true,
		});
		const created = apply({ action: "create_section", sectionId: id(62), name: "Sales", roomId: room, unpin: true });
		expect(containerOrder(created, id(62), [...roster, room])).toEqual([room]);
		expect(created.pinned).toEqual([]);
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
		expect(rail.querySelector(".rail-pinned")!.getAttribute("aria-label")).toBe("Pinned");
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
		rail.querySelector<HTMLButtonElement>(".rail-search-toggle")!.click();
		const input = rail.querySelector<HTMLInputElement>(".rail-search input")!;
		input.value = "cy";
		draw();
		expect(groups(rail)).toEqual([["Unassigned", "Cy"]]);
	});
	it("folds hidden agents at the foot of the list, where they can be shown again", async () => {
		localStorage.removeItem("qorpera.web.rail-hidden-open");
		const { rail, manage, openCard, ready } = companyWith({ ...demo(), hidden: [cy.id, dee.id], pinned: [] });
		await ready;
		await settle();
		const list = rail.querySelector(".rail-scroll")!;
		const hidden = rail.querySelector<HTMLElement>(".rail-hidden")!;
		const toggle = hidden.querySelector<HTMLButtonElement>(".rail-hidden-toggle")!;
		// The last thing in the list: "Hidden" and the count, folded.
		expect([...list.children].filter((child) => !child.matches(".rail-empty")).at(-1)).toBe(hidden);
		expect(toggle.textContent).toBe("Hidden2");
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(hidden.querySelector(".rail-hidden-list")!.children.length).toBe(0);
		toggle.click();
		await settle();
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		expect(hidden.querySelector<HTMLElement>(".rail-hidden-count")!.hidden).toBe(true);
		expect(hidden.querySelector<HTMLElement>(".rail-hidden-chevron")!.hidden).toBe(false);
		expect(names(hidden.querySelectorAll(".rail-hidden-list > a"))).toEqual(["Cy", "Dee"]);
		expect(localStorage.getItem("qorpera.web.rail-hidden-open")).toBe("1");
		// A hidden agent's card shows it again.
		rightClick(rowOf(rail, "Dee"));
		expect(lastCard(openCard)).toMatchObject({ hidden: true });
		lastCard(openCard).hide!();
		await settle();
		expect(manage).toHaveBeenLastCalledWith(profileA.profileId, {
			action: "set_hidden",
			staffAgentId: dee.id,
			hidden: false,
		});
		expect(names(hidden.querySelectorAll(".rail-hidden-list > a"))).toEqual(["Cy"]);
		expect(groups(rail).at(-1)).toEqual(["Unassigned", "Dee", "Fixture conversation"]);
		// Cy's too, back in its place in Unassigned.
		rightClick(rowOf(rail, "Cy"));
		lastCard(openCard).hide!();
		await settle();
		expect(groups(rail).at(-1)).toEqual(["Unassigned", "Cy", "Dee", "Fixture conversation"]);
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

describe("rail right-clicks", () => {
	it("opens the agent's card on a right-click in the page's first moments", async () => {
		// The long-press guard swallows the browser's own menu for 800 ms after a
		// press opened one; with no press yet, nothing is swallowed, however new the page.
		vi.spyOn(performance, "now").mockReturnValue(100);
		const { rail, openCard, ready } = companyWith(demo(), { updateAgent: vi.fn(), deleteAgent: vi.fn() });
		await ready;
		await settle();
		rightClick(rowOf(rail, "Cy"));
		expect(openCard).toHaveBeenCalledWith(cy, rowOf(rail, "Cy"), expect.anything(), expect.any(Function));
	});
	it("opens an agent's card beside its row, with Hide and Delete, instead of a menu", async () => {
		const { rail, manage, openCard, ready } = companyWith(demo(), { updateAgent: vi.fn(), deleteAgent: vi.fn() });
		await ready;
		await settle();
		const event = rightClick(rowOf(rail, "Cy"));
		expect(event.defaultPrevented).toBe(true);
		expect(openMenu()).toBeUndefined();
		expect(openCard).toHaveBeenCalledOnce();
		expect(openCard).toHaveBeenCalledWith(
			cy,
			rowOf(rail, "Cy"),
			{
				pinned: false,
				pin: expect.any(Function),
				hidden: false,
				hide: expect.any(Function),
				remove: expect.any(Function),
			},
			expect.any(Function),
		);
		// The card finds the agent's row again for focus, though the rail rebuilds it.
		expect(openCard.mock.calls[0]![3]()).toBe(rowOf(rail, "Cy"));
		lastCard(openCard).hide!();
		await settle();
		expect(manage).toHaveBeenLastCalledWith(profileA.profileId, {
			action: "set_hidden",
			staffAgentId: cy.id,
			hidden: true,
		});
		expect(groups(rail).at(-1)).toEqual(["Unassigned", "Fixture conversation"]);
		// A pinned agent's card opens beside its pinned card.
		const pin = rail.querySelector<HTMLElement>(`.rail-pin[data-agent-id="${dee.id}"]`)!;
		rightClick(pin);
		expect(openCard).toHaveBeenLastCalledWith(
			dee,
			pin,
			expect.objectContaining({ hidden: false }),
			expect.any(Function),
		);
	});
	it("leaves a right-click on an agent or a group chat to the browser where the shell opens no card", async () => {
		const [sidebar, actions, extra] = launchCompany({ deleteAgent: vi.fn(), deleteGroup: vi.fn() });
		const { rail, ready } = companyWith(sidebar, actions, { ...extra, cardless: true });
		await ready;
		await settle();
		expect(rightClick(rowOf(rail, "Cy")).defaultPrevented).toBe(false);
		expect(rightClick(groupRow(rail)).defaultPrevented).toBe(false);
		expect(openMenu()).toBeUndefined();
	});
	it("never shows a network error's text, and leaves Shift+right-click to the browser", async () => {
		const { rail, manage, openCard, ready } = companyWith(demo());
		await ready;
		await settle();
		manage.mockRejectedValueOnce(
			new CloudRpcError("qorpera_manage_company_sidebar", { message: "TypeError: Failed to fetch" }, 0),
		);
		rightClick(rowOf(rail, "Cy"));
		lastCard(openCard).hide!();
		await settle();
		expect(rail.querySelector(".notice")?.textContent).toContain("The sidebar could not be changed. Try again.");
		expect(rail.querySelector(".notice")?.textContent).not.toContain("fetch");
		openCard.mockClear();
		const shifted = new MouseEvent("contextmenu", {
			bubbles: true,
			cancelable: true,
			shiftKey: true,
			clientX: 30,
			clientY: 30,
		});
		rowOf(rail, "Cy").dispatchEvent(shifted);
		expect(shifted.defaultPrevented).toBe(false);
		expect(openCard).not.toHaveBeenCalled();
		expect(openMenu()).toBeUndefined();
	});
	it("moves the focused agent with Alt and an arrow, and keeps focus on its row when the row is rebuilt", async () => {
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
		expect(document.activeElement).toBe(rowOf(rail, "Ada"));
		// The agent starts working: its row is built anew, and focus moves to the new one.
		company.store.set({
			activity: [{ ...activityRow, staffAgentId: ada.id }],
		});
		await settle();
		expect(rowOf(rail, "Ada")).not.toBe(ada2);
		expect(document.activeElement).toBe(rowOf(rail, "Ada"));
	});
	it("gives the Co-Founder's card its conversation ID to copy, and no hide or delete", async () => {
		const { rail, company, openCard, ready } = companyWith(demo(), { updateAgent: vi.fn(), deleteAgent: vi.fn() });
		company.store.set({
			sessions: [
				{ ...session, sessionId: id(70), staffAgentId: cofounder.id, executionScope: { agentThread: true } },
			],
		});
		await ready;
		await settle();
		const home = rail.querySelector<HTMLElement>(".cofounder-home")!;
		rightClick(home);
		expect(openCard).toHaveBeenCalledWith(cofounder, home, { conversationId: id(70) }, expect.any(Function));
	});
	it("leaves shared sections to members who can write, and deleting to owners and admins", async () => {
		const { rail, manage, company, openCard, openGroup, ready } = companyWith(
			...launchCompany({ updateAgent: vi.fn(), deleteAgent: vi.fn(), updateGroup: vi.fn(), deleteGroup: vi.fn() }),
		);
		company.store.set({
			team: {
				...team,
				role: "viewer",
				capabilities: { read: true, write: false, authorize: false, manageMembers: false },
			},
		});
		await ready;
		await settle();
		// A viewer keeps their own pins and hidden agents and group chats.
		rightClick(rowOf(rail, "Cy"));
		expect(lastCard(openCard)).toEqual({
			pinned: false,
			pin: expect.any(Function),
			hidden: false,
			hide: expect.any(Function),
		});
		// Pinning is theirs too: a tap on the card's Pin works with no edit rights and no drag (a phone).
		lastCard(openCard).pin!();
		await settle();
		expect(manage).toHaveBeenLastCalledWith(
			profileA.profileId,
			expect.objectContaining({ action: "set_pins", order: expect.arrayContaining([cy.id]) }),
		);
		manage.mockClear();
		rightClick(groupRow(rail));
		expect(lastCard(openGroup)).toEqual({
			conversationId: launchSession.sessionId,
			pinned: false,
			pin: expect.any(Function),
			hidden: false,
			hide: expect.any(Function),
		});
		// Nor does Alt and an arrow move anything in a shared section.
		rowOf(rail, "Ada").focus();
		rowOf(rail, "Ada").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true }));
		await settle();
		expect(manage).not.toHaveBeenCalled();
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
		rowOf(rail, "Ada").focus();
		rowOf(rail, "Ada").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true }));
		await settle();
		// Drawn at once, before the cloud answers.
		expect(groups(rail)[0]).toEqual(["Research", "Ada", "Bo"]);
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
	it("deletes an agent from its card after confirming", async () => {
		const deleteAgent = vi.fn(async () => {});
		const { rail, openCard, ready } = companyWith(demo(), { updateAgent: vi.fn(), deleteAgent });
		await ready;
		await settle();
		rightClick(rowOf(rail, "Cy"));
		lastCard(openCard).remove!();
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
			".rail-scroll, [data-drop-zone], [data-agent-id], [data-room-id], .rail-section-title",
		)) {
			if (element.matches(".rail-scroll")) continue;
			const height = element.matches("[data-drop-zone]") ? 0 : 40;
			boxes.set(element, new DOMRect(0, y, 300, height));
			y += height;
		}
		// A zone spans its children.
		for (const zone of rail.querySelectorAll<HTMLElement>("[data-drop-zone]")) {
			const inner = [...zone.querySelectorAll("[data-agent-id], [data-room-id], .rail-section-title")].map(
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
		rail.querySelector<HTMLButtonElement>(".rail-search-toggle")!.click();
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
	it("drags a group chat into a section, and pins and unpins one by dragging", async () => {
		const { rail, manage, ready } = companyWith(...launchCompany());
		await ready;
		await settle();
		let boxes = layout(rail);
		// Dropped where it already stands: nothing to send.
		expect(drag(groupRow(rail), boxes.get(groupRow(rail))!, rail)).toBe("unassigned");
		await settle();
		expect(manage).not.toHaveBeenCalled();
		await new Promise((resolve) => setTimeout(resolve, 0));
		drag(groupRow(rail), boxes.get(rowOf(rail, "Ada"))!, rail);
		await ready;
		await settle();
		expect(manage).toHaveBeenLastCalledWith(profileA.profileId, {
			action: "move_room",
			roomId: launchRoom,
			sectionId: research,
			order: [bo.id, launchRoom, ada.id],
		});
		expect(groups(rail)[0]).toEqual(["Research", "Bo", "Launch", "Ada"]);
		boxes = layout(rail);
		drag(groupRow(rail), boxes.get(rail.querySelector(".rail-pin")!)!, rail);
		await ready;
		await settle();
		expect(manage).toHaveBeenLastCalledWith(profileA.profileId, {
			action: "set_pins",
			order: [launchRoom, dee.id],
			groupChats: true,
		});
		expect(names(rail.querySelectorAll(".rail-pin"))).toEqual(["Launch", "Dee"]);
		boxes = layout(rail);
		drag(rail.querySelector(`.rail-pin[data-room-id="${launchRoom}"]`)!, boxes.get(rowOf(rail, "Cy"))!, rail);
		await ready;
		await settle();
		expect(manage).toHaveBeenLastCalledWith(profileA.profileId, {
			action: "move_room",
			roomId: launchRoom,
			sectionId: null,
			order: [launchRoom, cy.id, dee.id],
			unpin: true,
		});
		expect(names(rail.querySelectorAll(".rail-pin"))).toEqual(["Dee"]);
		// The drop's click guard lasts one task; let it go before the next test clicks.
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	it("shows a hidden group chat again where it is dragged out of Hidden", async () => {
		localStorage.setItem("qorpera.web.rail-hidden-open", "1");
		const [, actions, extra] = launchCompany();
		const { rail, manage, ready } = companyWith(
			{ ...demo(), groupChats: true, hidden: [launchRoom] },
			actions,
			extra,
		);
		await ready;
		await settle();
		const boxes = layout(rail);
		drag(groupRow(rail), boxes.get(rowOf(rail, "Ada"))!, rail);
		await settle();
		expect(manage.mock.calls.slice(-2).map(([, request]) => request)).toEqual([
			{ action: "set_hidden", roomId: launchRoom, hidden: false },
			{ action: "move_room", roomId: launchRoom, sectionId: research, order: [bo.id, launchRoom, ada.id] },
		]);
		expect(groups(rail)[0]).toEqual(["Research", "Bo", "Launch", "Ada"]);
		expect(rail.querySelector(".rail-hidden")).toBeNull();
		localStorage.removeItem("qorpera.web.rail-hidden-open");
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	it("leaves a deleted agent out of the pins it sends, by drag and by Alt and an arrow", async () => {
		const { rail, manage, company, ready } = companyWith({ ...demo(), pinned: [dee.id, id(99)] });
		await ready;
		await settle();
		const boxes = layout(rail);
		drag(rowOf(rail, "Bo"), boxes.get(rail.querySelector(".rail-pin")!)!, rail);
		await settle();
		expect(manage).toHaveBeenLastCalledWith(profileA.profileId, { action: "set_pins", order: [bo.id, dee.id] });
		expect(company.store.get().railError).toBeUndefined();
		await new Promise((resolve) => setTimeout(resolve, 0));
		const pin = rail.querySelector<HTMLElement>(`.rail-pin[data-agent-id="${dee.id}"]`)!;
		pin.focus();
		pin.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true }));
		await settle();
		expect(manage).toHaveBeenLastCalledWith(profileA.profileId, { action: "set_pins", order: [dee.id, bo.id] });
	});
	it("moves agents by editing agents/sections.md, where the sidebar RPC refuses moves", async () => {
		const { rail, manage, fake, ready } = companyWithFile([["Research", bo.id, ada.id], ["Ops"]], [dee.id]);
		await ready;
		await settle();
		let boxes = layout(rail);
		drag(rowOf(rail, "Cy"), boxes.get(rowOf(rail, "Ada"))!, rail);
		await settle();
		expect(fileSections(fake.text(SECTIONS_PATH))).toEqual([["Research", bo.id, cy.id, ada.id], ["Ops"]]);
		expect(fake.text(SECTIONS_PATH)).toContain(`- ${cy.id} Cy\n`);
		expect(manage).not.toHaveBeenCalled();
		expect(groups(rail)[0]).toEqual(["Research", "Bo", "Cy", "Ada"]);
		expect(rail.querySelector(".notice")).toBeNull();
		// Out of the pinned row into a section: the file places it, and the pin goes.
		boxes = layout(rail);
		drag(rail.querySelector(".rail-pin")!, boxes.get(rowOf(rail, "Cy"))!, rail);
		await settle();
		expect(fileSections(fake.text(SECTIONS_PATH))).toEqual([["Research", bo.id, dee.id, cy.id, ada.id], ["Ops"]]);
		expect(manage).toHaveBeenLastCalledWith(profileA.profileId, { action: "set_pins", order: [], groupChats: true });
		expect(rail.querySelector(".rail-pin")).toBeNull();
		expect(groups(rail)[0]).toEqual(["Research", "Bo", "Dee", "Cy", "Ada"]);
		expect(rail.querySelector(".notice")).toBeNull();
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	it("says Unassigned keeps no order, and sends nothing for a reorder there", async () => {
		const { rail, manage, fake, ready } = companyWithFile([["Research", bo.id, ada.id]]);
		await ready;
		await settle();
		const unassigned = () =>
			groups(rail)
				.find((group) => group.includes("Cy"))!
				.slice(1);
		expect(unassigned()).toEqual(["Cy", "Dee", "Fixture conversation"]);
		const boxes = layout(rail);
		drag(rowOf(rail, "Dee"), boxes.get(rowOf(rail, "Cy"))!, rail);
		await settle();
		expect(rail.querySelector(".notice")?.textContent).toContain(
			"Agents outside a section stay in the order they joined. Put them in a section to order them.",
		);
		expect(fake.commits).toHaveLength(0);
		expect(manage).not.toHaveBeenCalled();
		expect(unassigned()).toEqual(["Cy", "Dee", "Fixture conversation"]);
		// So does Alt and an arrow.
		rail.querySelector<HTMLElement>(".notice button")?.click();
		const dee2 = rowOf(rail, "Dee");
		dee2.focus();
		dee2.dispatchEvent(
			new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true, cancelable: true }),
		);
		await settle();
		expect(rail.querySelector(".notice")?.textContent).toContain("Agents outside a section stay in the order");
		expect(fake.commits).toHaveLength(0);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	it("reorders Unassigned where the cloud keeps its order, and moves an agent into it at its drop", async () => {
		const { company, rail, manage, fake, ready } = companyWithFile([["Research", bo.id, ada.id]], [], true);
		await ready;
		await settle();
		const room = [...company.groupChatRooms().keys()];
		const unassigned = () =>
			groups(rail)
				.find((group) => group.includes("Cy"))!
				.slice(1);
		expect(unassigned()).toEqual(["Cy", "Dee", "Fixture conversation"]);
		let boxes = layout(rail);
		drag(rowOf(rail, "Dee"), boxes.get(rowOf(rail, "Cy"))!, rail);
		await settle();
		expect(rail.querySelector(".notice")).toBeNull();
		expect(fileUnassigned(fake.text(SECTIONS_PATH))).toEqual([dee.id, cy.id, ...room]);
		expect(fileSections(fake.text(SECTIONS_PATH))).toEqual([["Research", bo.id, ada.id]]);
		expect(unassigned()).toEqual(["Dee", "Cy", "Fixture conversation"]);
		// Out of a section, into Unassigned above Cy.
		boxes = layout(rail);
		drag(rowOf(rail, "Ada"), boxes.get(rowOf(rail, "Cy"))!, rail);
		await settle();
		expect(fileSections(fake.text(SECTIONS_PATH))).toEqual([["Research", bo.id]]);
		expect(fileUnassigned(fake.text(SECTIONS_PATH))).toEqual([dee.id, ada.id, cy.id, ...room]);
		expect(
			groups(rail)
				.find((group) => group.includes("Cy"))!
				.slice(1),
		).toEqual(["Dee", "Ada", "Cy", "Fixture conversation"]);
		// And back into the section: it leaves the order.
		boxes = layout(rail);
		drag(rowOf(rail, "Ada"), boxes.get(rowOf(rail, "Bo"))!, rail);
		await settle();
		expect(fileSections(fake.text(SECTIONS_PATH))).toEqual([["Research", ada.id, bo.id]]);
		expect(fileUnassigned(fake.text(SECTIONS_PATH))).toEqual([dee.id, cy.id, ...room]);
		// Alt and an arrow too.
		const cyRow = rowOf(rail, "Cy");
		cyRow.focus();
		cyRow.dispatchEvent(
			new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true, cancelable: true }),
		);
		await settle();
		expect(fileUnassigned(fake.text(SECTIONS_PATH))).toEqual([cy.id, dee.id, ...room]);
		expect(manage).not.toHaveBeenCalled();
		expect(rail.querySelector(".notice")).toBeNull();
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	it("names a new section in the moves queued behind it, before the cloud answers", async () => {
		const { company, rail, fake, ready } = companyWithFile([["Research", bo.id, ada.id]]);
		await ready;
		await settle();
		const made = company.changeSidebar({
			action: "create_section",
			sectionId: id(80),
			name: "Sales",
			staffAgentId: cy.id,
		});
		const moved = company.changeSidebar({ action: "move_agent", staffAgentId: dee.id, sectionId: id(80) });
		expect(await Promise.all([made, moved])).toEqual([true, true]);
		await settle();
		expect(fileSections(fake.text(SECTIONS_PATH))).toEqual([
			["Research", bo.id, ada.id],
			["Sales", cy.id, dee.id],
		]);
		expect(groups(rail).slice(0, 2)).toEqual([
			["Research", "Bo", "Ada"],
			["Sales", "Cy", "Dee"],
		]);
		expect(company.store.get().sidebar?.sections.map((section) => section.sectionId)).not.toContain(id(80));
	});
	it("sends no unpin once the company is left while the moved sidebar is read", async () => {
		const { company, rail, read, manage, fake, placed, ready } = companyWithFile(
			[["Research", bo.id, ada.id]],
			[dee.id],
		);
		await ready;
		await settle();
		const answer = deferred<CompanySidebar>();
		read.mockImplementationOnce(() => answer.promise);
		const boxes = layout(rail);
		drag(rail.querySelector(".rail-pin")!, boxes.get(rowOf(rail, "Ada"))!, rail);
		await settle();
		expect(fileSections(fake.text(SECTIONS_PATH))).toEqual([["Research", bo.id, dee.id, ada.id]]);
		company.stop();
		// What the commit placed: Dee is in Research and still pinned, until the unpin that must not come.
		const moved = placed();
		expect(moved.pinned).toEqual([dee.id]);
		answer.resolve(moved);
		await settle();
		expect(manage).not.toHaveBeenCalled();
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	it("puts the sections back and says why when the company folder refuses the file", async () => {
		const { rail, fake, ready } = companyWithFile([["Research", bo.id, ada.id]]);
		await ready;
		await settle();
		fake.answer("refused", "structured_rule", [`the Co-Founder stands above the sections; remove ${cofounder.id}`]);
		const boxes = layout(rail);
		drag(rowOf(rail, "Cy"), boxes.get(rowOf(rail, "Ada"))!, rail);
		await settle();
		expect(fake.commits).toHaveLength(1);
		expect(rail.querySelector(".notice")?.textContent).toContain("The Co-Founder stays on top, above the sections.");
		expect(groups(rail)[0]).toEqual(["Research", "Bo", "Ada"]);
		expect(fileSections(fake.text(SECTIONS_PATH))).toEqual([["Research", bo.id, ada.id]]);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
});

const launchRoom = id(91);
const launchSession: HostedSession = {
	...session,
	sessionId: id(90),
	title: "Launch",
	executionScope: { roomId: launchRoom },
};
const launchDetails: GroupChatDetails = {
	roomId: launchRoom,
	sessionId: launchSession.sessionId,
	environmentId: profileA.environmentId,
	version: 3,
	name: "Launch",
	purpose: "Plan the launch",
	status: "active",
	members: [
		{ kind: "member", id: userA.id },
		{ kind: "staff_agent", id: ada.id },
		{ kind: "staff_agent", id: bo.id },
	],
};
/** A company with one group chat, on a cloud that places group chats (or, with agentsOnly, one that does not). */
function launchCompany(actions: ShellContext["agentActions"] = {}, agentsOnly = false): Parameters<typeof companyWith> {
	return [
		agentsOnly ? demo() : { ...demo(), groupChats: true },
		actions,
		{ sessions: [launchSession], groups: { [launchRoom]: launchDetails }, roster: [...roster, launchRoom] },
	];
}
const groupRow = (rail: HTMLElement) => rail.querySelector<HTMLElement>(`.rail-row[data-room-id="${launchRoom}"]`)!;

describe("group chats in the rail", () => {
	it("stands a group chat among the agents of its section, and pins it as a card", async () => {
		const [, actions, extra] = launchCompany();
		const sidebar: CompanySidebar = { ...demo(), groupChats: true };
		const { rail, ready } = companyWith(
			{
				...sidebar,
				placements: {
					[bo.id]: { sectionId: research, position: 0 },
					[launchRoom]: { sectionId: research, position: 1 },
					[ada.id]: { sectionId: research, position: 2 },
				},
			},
			actions,
			extra,
		);
		await ready;
		await settle();
		expect(groups(rail)).toEqual([
			["Research", "Bo", "Launch", "Ada"],
			["Ops"],
			["Unassigned", "Cy", "Fixture conversation"],
		]);
		const pinned = companyWith({ ...sidebar, pinned: [launchRoom, dee.id] }, actions, extra);
		await pinned.ready;
		await settle();
		const cards = pinned.rail.querySelectorAll<HTMLElement>(".rail-pin");
		expect(names(cards)).toEqual(["Launch", "Dee"]);
		expect(cards[0]!.dataset.roomId).toBe(launchRoom);
		expect(cards[0]!.getAttribute("href")).toBe(`#/c/${profileA.profileId}/chat/${launchSession.sessionId}`);
	});
	it("shows '@' on a pinned group chat where the member was mentioned", async () => {
		const [, actions, extra] = launchCompany();
		const pinned = companyWith({ ...demo(), groupChats: true, pinned: [launchRoom] }, actions, extra);
		await pinned.ready;
		await settle();
		const card = () => pinned.rail.querySelector<HTMLElement>(`.rail-pin[data-room-id="${launchRoom}"]`)!;
		expect(card().querySelector(".rail-mention")).toBeNull();
		expect(card().title).not.toContain("You were mentioned");
		pinned.company.store.set({ mentions: { [launchSession.sessionId]: 1 } });
		await settle();
		expect(card().querySelector(".rail-mention")?.textContent).toBe("@");
		expect(card().title).toContain("You were mentioned");
	});
	it("opens a group chat's card beside its row, with Copy, Hide and Delete, instead of a menu", async () => {
		localStorage.removeItem("qorpera.web.rail-hidden-open");
		const { rail, manage, openGroup, ready } = companyWith(
			...launchCompany({ updateGroup: vi.fn(), deleteGroup: vi.fn() }),
		);
		await ready;
		await settle();
		expect(groups(rail).at(-1)).toEqual(["Unassigned", "Cy", "Launch", "Fixture conversation"]);
		const event = rightClick(groupRow(rail));
		expect(event.defaultPrevented).toBe(true);
		expect(openMenu()).toBeUndefined();
		expect(openGroup).toHaveBeenCalledWith(
			launchSession,
			groupRow(rail),
			{
				conversationId: launchSession.sessionId,
				pinned: false,
				pin: expect.any(Function),
				hidden: false,
				hide: expect.any(Function),
				remove: expect.any(Function),
			},
			expect.any(Function),
		);
		// The card finds the group chat's row again for focus, though the rail rebuilds it.
		expect(openGroup.mock.calls[0]![3]()).toBe(groupRow(rail));
		lastCard(openGroup).hide!();
		await ready;
		await settle();
		expect(manage).toHaveBeenLastCalledWith(profileA.profileId, {
			action: "set_hidden",
			roomId: launchRoom,
			hidden: true,
		});
		expect(groupRow(rail)).toBeNull();
		expect(rail.querySelector(".rail-hidden-toggle")!.textContent).toBe("Hidden1");
		rail.querySelector<HTMLElement>(".rail-hidden-toggle")!.click();
		await settle();
		// A hidden group chat's card shows it again.
		rightClick(groupRow(rail));
		expect(lastCard(openGroup)).toMatchObject({ hidden: true });
		lastCard(openGroup).hide!();
		await ready;
		await settle();
		expect(manage).toHaveBeenLastCalledWith(profileA.profileId, {
			action: "set_hidden",
			roomId: launchRoom,
			hidden: false,
		});
		expect(groups(rail).at(-1)).toEqual(["Unassigned", "Cy", "Launch", "Fixture conversation"]);
		expect(rail.querySelector(".rail-hidden")).toBeNull();
		localStorage.removeItem("qorpera.web.rail-hidden-open");
	});
	it("moves the focused group chat with Alt and an arrow", async () => {
		const { rail, manage, ready } = companyWith(...launchCompany());
		await ready;
		await settle();
		groupRow(rail).focus();
		groupRow(rail).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true }));
		await ready;
		await settle();
		expect(manage).toHaveBeenLastCalledWith(profileA.profileId, {
			action: "move_room",
			roomId: launchRoom,
			sectionId: null,
			// Dee is pinned: it keeps its place in the company's order.
			order: [launchRoom, cy.id, dee.id],
		});
		expect(groups(rail).at(-1)).toEqual(["Unassigned", "Launch", "Cy", "Fixture conversation"]);
	});
	it("keeps a group chat a group chat when its conversation leaves the list before the choice", async () => {
		const { company, rail, manage, openGroup, ready } = companyWith(...launchCompany());
		await ready;
		await settle();
		rightClick(groupRow(rail));
		// Another member deleted it; the sessions list no longer has it.
		company.store.set({ sessions: [session] });
		lastCard(openGroup).hide!();
		await ready;
		await settle();
		expect(manage).toHaveBeenLastCalledWith(profileA.profileId, {
			action: "set_hidden",
			roomId: launchRoom,
			hidden: true,
		});
	});
	it("sends an agent's move with the group chat flag where the cloud places group chats", async () => {
		const { rail, manage, ready } = companyWith(...launchCompany());
		await ready;
		await settle();
		rowOf(rail, "Cy").focus();
		rowOf(rail, "Cy").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true }));
		await ready;
		await settle();
		expect(manage).toHaveBeenLastCalledWith(profileA.profileId, {
			action: "move_agent",
			staffAgentId: cy.id,
			sectionId: null,
			// Dee is pinned: it keeps its place in the company's order.
			order: [dee.id, launchRoom, cy.id],
			groupChats: true,
		});
	});
	it("keeps copy and delete, and no hide, on a cloud that places agents only", async () => {
		const { rail, manage, openGroup, ready } = companyWith(
			...launchCompany({ updateGroup: vi.fn(), deleteGroup: vi.fn() }, true),
		);
		await ready;
		await settle();
		// The group chat stands after the Unassigned agents, among the other conversations, as before.
		expect(groups(rail).at(-1)).toEqual(["Unassigned", "Cy", "Fixture conversation", "Launch"]);
		rightClick(groupRow(rail));
		expect(lastCard(openGroup)).toEqual({ conversationId: launchSession.sessionId, remove: expect.any(Function) });
		groupRow(rail).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true }));
		await settle();
		expect(manage).not.toHaveBeenCalled();
	});
	it("leaves deleting to owners and admins", async () => {
		const { company, rail, openGroup, ready } = companyWith(
			...launchCompany({ updateGroup: vi.fn(), deleteGroup: vi.fn() }),
		);
		await ready;
		company.store.set({
			team: { ...team, role: "contributor", capabilities: { ...team.capabilities, authorize: false } },
		});
		await settle();
		rightClick(groupRow(rail));
		expect(lastCard(openGroup)).toEqual({
			conversationId: launchSession.sessionId,
			pinned: false,
			pin: expect.any(Function),
			hidden: false,
			hide: expect.any(Function),
		});
	});
	it("deletes a group chat from its card after confirming", async () => {
		const deleteGroup = vi.fn(async () => {});
		const { f, rail, openGroup, ready } = companyWith(...launchCompany({ updateGroup: vi.fn(), deleteGroup }));
		await ready;
		await settle();
		const listSessions = vi.spyOn(f.api, "listSessions").mockResolvedValue([session]);
		rightClick(groupRow(rail));
		lastCard(openGroup).remove!();
		expect(document.querySelector(".modal p")?.textContent).toContain("Delete Launch?");
		[...document.querySelectorAll<HTMLButtonElement>(".modal button")]
			.find((button) => button.textContent === "Delete")!
			.click();
		await ready;
		await settle();
		expect(deleteGroup).toHaveBeenCalledWith(launchSession.sessionId, launchRoom, expect.any(AbortSignal));
		expect(listSessions).toHaveBeenCalled();
	});
	it("says in the rail when a group chat could not be deleted", async () => {
		const deleteGroup = vi.fn(async () => {
			throw new Error("gateway said no");
		});
		const { rail, openGroup, ready } = companyWith(...launchCompany({ updateGroup: vi.fn(), deleteGroup }));
		await ready;
		await settle();
		rightClick(groupRow(rail));
		lastCard(openGroup).remove!();
		[...document.querySelectorAll<HTMLButtonElement>(".modal button")]
			.find((button) => button.textContent === "Delete")!
			.click();
		await settle();
		expect(rail.textContent).toContain("Launch could not be deleted.");
		expect(rail.textContent).not.toContain("gateway said no");
	});
});
