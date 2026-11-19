// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { type MembersOptions, renderMembers } from "../src/app/views/members.ts";
import type { HostedProfileMember, HostedStaffAgent } from "../src/cloud/types.ts";
import { parseWorksFor, type WorksFor, type WorksForAsk, type WorksForCalls } from "../src/cloud/works-for.ts";
import { openMenu } from "../src/ui/context-menu.ts";
import {
	deferred,
	fixture,
	id,
	profileA,
	settle,
	staff,
	stubFigureMotion,
	team,
	timestamp,
	userA,
} from "./fixtures.ts";

/* The Members page (app/views/members.ts; Jonas, 9 and 10 Nov 2026): who each agent works for, as pictures only. A
 * line per member with their agents; an agent moves by a drag onto another line or by a tap and a choice from a menu,
 * as an ask the other side says yes to. */

const cofounder: HostedStaffAgent = { ...staff, id: id(40), displayName: "Kaya", templateId: "co-founder" };
const agent = (n: number, name: string, role: string): HostedStaffAgent => ({
	...staff,
	id: id(n),
	displayName: name,
	role,
});
const crew = [
	agent(41, "Bo", "Developer"),
	agent(42, "Freja", "Developer"),
	agent(43, "Clara", "Marketing"),
	agent(44, "Astrid", "Marketing"),
];
const member = (userId: string, name: string, role: HostedProfileMember["role"] = "admin"): HostedProfileMember => ({
	userId,
	email: `${name.toLowerCase()}@example.invalid`,
	displayName: name,
	role,
	joinedAt: timestamp,
});
const ann = member(userA.id, "Ann Holm", "owner");
const sofie = member(id(60), "Sofie Lund");
const mads = member(id(61), "Mads Berg");

function works(extra: Partial<WorksFor> = {}): WorksFor {
	return {
		mayAsk: true,
		mayAskForOthers: true,
		agents: crew.map((entry) => ({ agentId: entry.id, userId: userA.id })),
		logins: [
			{ userId: userA.id, state: "ready", usedPercent: 71, resetsAt: null },
			{ userId: sofie.userId, state: "ready", usedPercent: 0, resetsAt: null },
		],
		asks: [],
		...extra,
	};
}
/** Who each agent of the crew works for: the viewer, but for the ones named here. */
const held = (others: Record<string, string | null>) =>
	crew.map((entry) => ({ agentId: entry.id, userId: entry.id in others ? (others[entry.id] ?? null) : userA.id }));
/** An open ask for Clara. */
const ask = (from: HostedProfileMember, to: HostedProfileMember, askedBy: HostedProfileMember): WorksForAsk => ({
	id: id(91),
	agentId: id(43),
	fromUserId: from.userId,
	toUserId: to.userId,
	askedByUserId: askedBy.userId,
	askedByAgentId: null,
	answerByUserId: askedBy.userId === to.userId ? from.userId : to.userId,
	createdAt: timestamp,
	why: null,
	batch: null,
});

const cleanup: (() => void)[] = [];
beforeEach(() => stubFigureMotion());
afterEach(() => {
	for (const dispose of cleanup.splice(0).reverse()) dispose();
	openMenu()?.close();
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function page(
	members: HostedProfileMember[],
	read: WorksFor,
	extra: { staff?: HostedStaffAgent[]; reader?: () => Promise<WorksFor>; options?: MembersOptions } = {},
) {
	const f = fixture();
	const controller = new CompanyController(f.api, profileA, userA.id);
	controller.store.set({
		loading: false,
		staff: extra.staff ?? [cofounder, ...crew],
		team: { ...team, members },
		interfaceFolder: { tables: new Map(), files: new Map() },
	});
	cleanup.push(() => controller.stop());
	const calls = {
		read: vi.fn(extra.reader ?? (async () => read)),
		ask: vi.fn<WorksForCalls["ask"]>(async () => ({ moved: false, askId: id(90) })),
		answer: vi.fn<WorksForCalls["answer"]>(async () => ({ status: "yes" as const, moved: true })),
	} satisfies WorksForCalls;
	vi.spyOn(controller, "worksFor").mockReturnValue(calls);
	const container = document.createElement("main");
	document.body.append(container);
	renderMembers(container, controller, extra.options);
	return { container, calls };
}

/** The members' lines, top down. */
const lines = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>(".members-row[data-drop-lane]")];
const lineNames = (root: ParentNode) =>
	lines(root).map((line) => line.querySelector(".members-who-text b")?.textContent);
const agentNames = (root: ParentNode) =>
	[...root.querySelectorAll(".members-agent-name")].map((name) => name.textContent);
const agentButton = (root: ParentNode, name: string) => {
	const button = [...root.querySelectorAll<HTMLButtonElement>(".members-agent")].find(
		(candidate) => candidate.querySelector(".members-agent-name")?.textContent === name,
	);
	if (!button) throw new Error(`No agent ${name}`);
	return button;
};
const menuRows = () => [...document.querySelectorAll<HTMLElement>(".context-menu [role=menuitem]")];
/** The open menu: its line of plain text, and each row's label and second line. */
const menu = () => ({
	caption: document.querySelector(".context-menu-caption")?.textContent,
	rows: menuRows().map((row) => [
		row.querySelector(".context-menu-label")?.textContent,
		row.querySelector(".context-menu-hint")?.textContent ?? null,
	]),
});
const choose = (label: string) => {
	const row = menuRows().find((item) => item.querySelector(".context-menu-label")?.textContent === label);
	if (!row) throw new Error(`No menu row ${label}`);
	row.click();
};
/** A mouse event as a browser sends it: the button is held from the press until the release. */
const pointer = (type: string, x: number, y: number, target: EventTarget = document) =>
	target.dispatchEvent(
		new PointerEvent(type, {
			bubbles: true,
			cancelable: true,
			pointerId: 1,
			pointerType: "mouse",
			button: 0,
			buttons: type === "pointerup" ? 0 : 1,
			clientX: x,
			clientY: y,
		}),
	);

describe("the Members page", () => {
	it("draws a line per member, their ChatGPT as a meter and their agents by name only", async () => {
		const { container } = page([ann, sofie], works());
		await settle();
		const [mine, hers] = lines(container);
		expect(lineNames(container)).toEqual(["Ann (you)", "Sofie Lund"]);
		expect(mine?.getAttribute("aria-label")).toBe("4 agents work for you");
		expect(agentNames(mine!)).toEqual(["Astrid", "Bo", "Clara", "Freja"]);
		expect(mine?.querySelector(".members-sub")?.getAttribute("title")).toBe("ChatGPT: 71 % used");
		expect(mine?.querySelector<HTMLElement>(".members-meter i")?.style.width).toBe("71%");
		expect(mine?.querySelector(".members-sub")?.textContent).toBe("71 %");
		// A name is enough for an agent: no title under it, and no words on its button.
		expect(container.textContent).not.toMatch(/Developer|Marketing|Designer/);
		expect(agentButton(container, "Bo").hasAttribute("title")).toBe(false);
		// An empty line shows an empty place, and says so in its tooltip.
		expect(hers?.classList.contains("is-empty")).toBe(true);
		expect(hers?.getAttribute("aria-label")).toBe("0 agents work for Sofie");
		expect(hers?.querySelector(".members-slot")?.getAttribute("title")).toBe("No agents work for Sofie yet.");
		expect(hers?.querySelector(".members-meter i")).toBeNull();
		expect(mine?.querySelector(".members-slot")?.hasAttribute("title")).toBe(false);
		expect(container.querySelector(".members-nobody-face")).toBeNull();
	});

	it("has no header, no tabs and no text of its own", async () => {
		const { container } = page([ann, sofie], works());
		await settle();
		const headings = [...container.querySelectorAll("h1, h2, h3")];
		expect(headings.map((heading) => [heading.className, heading.textContent])).toEqual([
			["visually-hidden", "Members"],
		]);
		expect(container.querySelector(".interface-title, .interface-tabs, [role=tablist]")).toBeNull();
		expect(container.querySelector(".members-page p")).toBeNull();
		// All it writes: each member's initials, name and how much of their ChatGPT is used, and each agent's name.
		expect(container.querySelector(".members-page")?.textContent).toBe(
			[
				...["AH", "Ann (you)", "71 %", "Astrid", "Bo", "Clara", "Freja"],
				...["SL", "Sofie Lund", "0 %"],
				...["AH", "SL", "Everyone", "Kaya"],
			].join(""),
		);
	});

	it("stands the Co-Founder by everyone's faces, where it stays", async () => {
		const { container } = page([ann, sofie], works());
		await settle();
		const everyone = container.querySelector(".members-row.is-everyone");
		expect(everyone?.getAttribute("aria-label")).toBe("The Co-Founder works for everyone.");
		expect(everyone?.querySelectorAll(".members-faces .person-avatar")).toHaveLength(2);
		expect(everyone?.querySelector(".members-who-text b")?.textContent).toBe("Everyone");
		expect(agentNames(everyone!)).toEqual(["Kaya"]);
		const kaya = agentButton(container, "Kaya");
		expect(kaya.disabled).toBe(true);
		expect(kaya.classList.contains("is-draggable")).toBe(false);
		expect(kaya.getAttribute("title")).toBe("The Co-Founder works for everyone.");
		// Nothing can be dropped on it.
		expect(everyone?.hasAttribute("data-drop-lane")).toBe(false);
	});

	it("moves an agent by a tap and a choice from its menu", async () => {
		const { container, calls } = page([ann, sofie], works());
		await settle();
		const clara = agentButton(container, "Clara");
		expect(clara.getAttribute("aria-haspopup")).toBe("menu");
		clara.click();
		expect(document.querySelector(".context-menu")?.getAttribute("aria-label")).toBe("Clara");
		expect(menu()).toEqual({ caption: "Clara works for you", rows: [["Move to Sofie", "Sofie says yes first."]] });
		expect(menuRows()[0]?.querySelector(".person-avatar")?.textContent).toBe("SL");
		choose("Move to Sofie");
		// The page waits for the call.
		expect(agentButton(container, "Bo").disabled).toBe(true);
		await settle();
		expect(calls.ask).toHaveBeenCalledTimes(1);
		expect(calls.ask).toHaveBeenCalledWith(id(43), sofie.userId);
		// It reads again, and shows what the call did.
		expect(calls.read).toHaveBeenCalledTimes(2);
		expect(agentButton(container, "Bo").disabled).toBe(false);
		expect(container.querySelector(".members-note")).toBeNull();
	});

	it("closes an agent's menu on a second press, and opens it on the next", async () => {
		const { container } = page([ann, sofie], works());
		await settle();
		const clara = agentButton(container, "Clara");
		const press = () => {
			pointer("pointerdown", 10, 10, clara);
			pointer("pointerup", 10, 10, clara);
			clara.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
		};
		press();
		expect(document.querySelector(".context-menu")).not.toBeNull();
		press();
		expect(document.querySelector(".context-menu")).toBeNull();
		press();
		expect(document.querySelector(".context-menu")).not.toBeNull();
		// A press elsewhere closes it; the next press on the agent opens it.
		pointer("pointerdown", 300, 300, document.body);
		expect(document.querySelector(".context-menu")).toBeNull();
		press();
		expect(document.querySelector(".context-menu")).not.toBeNull();
	});

	it("moves an agent by a drag onto another member's line", async () => {
		const { container, calls } = page([ann, sofie], works());
		await settle();
		const [mine, hers] = lines(container);
		vi.spyOn(mine!, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 500, 100));
		vi.spyOn(hers!, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 200, 500, 100));
		const clara = agentButton(container, "Clara");
		expect(clara.classList.contains("is-draggable")).toBe(true);
		pointer("pointerdown", 10, 10, clara);
		pointer("pointermove", 60, 120);
		expect(clara.classList.contains("is-dragging")).toBe(true);
		expect(container.querySelector(".members-page")?.classList.contains("is-dragging")).toBe(true);
		// Only another member's line takes it: its own line is no place to drop it.
		expect(hers?.classList.contains("is-drop-target")).toBe(true);
		expect(mine?.classList.contains("is-drop-target")).toBe(false);
		expect(hers?.classList.contains("is-drop-over")).toBe(false);
		pointer("pointermove", 100, 250);
		expect(hers?.classList.contains("is-drop-over")).toBe(true);
		pointer("pointerup", 100, 250);
		await settle();
		expect(calls.ask).toHaveBeenCalledTimes(1);
		expect(calls.ask).toHaveBeenCalledWith(id(43), sofie.userId);
		// The drag's own click was swallowed; a later one is not.
		await new Promise((resolve) => setTimeout(resolve, 0));
	});

	it("asks nothing when a dragged agent is let go outside a line", async () => {
		const { container, calls } = page([ann, sofie], works());
		await settle();
		vi.spyOn(lines(container)[1]!, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 200, 500, 100));
		pointer("pointerdown", 10, 10, agentButton(container, "Clara"));
		pointer("pointermove", 700, 700);
		pointer("pointerup", 700, 700);
		await settle();
		expect(calls.ask).not.toHaveBeenCalled();
		expect(container.querySelector(".is-drop-target, .is-dragging")).toBeNull();
		await new Promise((resolve) => setTimeout(resolve, 0));
	});

	it("stands an agent another member asks the viewer to take faded in the viewer's line, with yes and no", async () => {
		const read = works({ agents: held({ [id(43)]: sofie.userId }), asks: [ask(sofie, ann, sofie)] });
		const { container, calls } = page([ann, sofie], read);
		await settle();
		const [mine, hers] = lines(container);
		const coming = mine?.querySelector<HTMLButtonElement>(".members-agent.is-coming");
		expect(coming?.getAttribute("data-coming")).toBe(id(43));
		expect(coming?.querySelector(".members-agent-name")?.textContent).toBe("Clara");
		expect(coming?.getAttribute("title")).toBe("Waiting for you");
		// Where it works, the face of the member it would go to sits on its figure.
		const there = hers?.querySelector<HTMLButtonElement>(`.members-agent[data-agent="${id(43)}"]`);
		expect(there?.querySelector(".members-to .person-avatar")?.textContent).toBe("AH");
		expect(there?.classList.contains("is-draggable")).toBe(false);
		// Yes and no stand under the faded one only.
		const answers = [...container.querySelectorAll<HTMLButtonElement>(".members-answer button")];
		expect(answers.map((button) => button.getAttribute("aria-label"))).toEqual(["Yes", "No"]);
		expect(answers[0]?.closest(".members-tile")).toBe(coming?.closest(".members-tile"));
		// A tap says the ask in words.
		coming?.click();
		expect(menu()).toEqual({
			caption: "Sofie asks you to take Clara. Your ChatGPT then carries the work handed to Clara.",
			rows: [
				["Yes", null],
				["No", null],
			],
		});
		answers[0]?.click();
		await settle();
		expect(calls.answer).toHaveBeenCalledTimes(1);
		expect(calls.answer).toHaveBeenCalledWith(id(91), true);
	});

	it("puts yes and no by the viewer's own agent when another member asks to take it", async () => {
		const read = works({ asks: [ask(ann, sofie, sofie)] });
		const { container, calls } = page([ann, sofie], read);
		await settle();
		const [mine, hers] = lines(container);
		const clara = mine?.querySelector<HTMLButtonElement>(`.members-agent[data-agent="${id(43)}"]`);
		expect(clara?.querySelector(".members-to .person-avatar")?.textContent).toBe("SL");
		expect(clara?.closest(".members-tile")?.querySelectorAll(".members-answer button")).toHaveLength(2);
		expect(hers?.querySelector(".members-agent.is-coming")).not.toBeNull();
		expect(hers?.querySelector(".members-answer")).toBeNull();
		expect(hers?.classList.contains("is-empty")).toBe(false);
		clara?.click();
		expect(menu().caption).toBe("Sofie asks to take Clara from you.");
		choose("No");
		await settle();
		expect(calls.answer).toHaveBeenCalledWith(id(91), false);
	});

	it("marks an agent the viewer asked to move, and takes the ask back", async () => {
		const read = works({ asks: [ask(ann, sofie, ann)] });
		const { container, calls } = page([ann, sofie], read);
		await settle();
		const clara = agentButton(lines(container)[0]!, "Clara");
		expect(clara.getAttribute("title")).toBe("Waiting for Sofie");
		expect(clara.querySelector(".members-to")).not.toBeNull();
		expect(clara.classList.contains("is-draggable")).toBe(false);
		// The other side answers: the viewer has no yes and no.
		expect(container.querySelector(".members-answer")).toBeNull();
		clara.click();
		expect(menu()).toEqual({ caption: "Waiting for Sofie", rows: [["Take back", null]] });
		choose("Take back");
		await settle();
		expect(calls.answer).toHaveBeenCalledWith(id(91), false);
	});

	it("says who asked when it was the Co-Founder, and why", async () => {
		const read = works({
			agents: held({ [id(43)]: sofie.userId }),
			asks: [
				{
					...ask(sofie, ann, sofie),
					askedByUserId: null,
					askedByAgentId: cofounder.id,
					why: "You said you want to run growth.",
				},
			],
		});
		const { container } = page([ann, sofie], read);
		await settle();
		container.querySelector<HTMLButtonElement>(".members-agent.is-coming")?.click();
		expect(menu().caption).toBe(
			"Kaya, your Co-Founder, asks you to take Clara. Your ChatGPT then carries the work handed to Clara. “You said you want to run growth.”",
		);
	});

	it("draws more than three members small, the viewer first", async () => {
		const three = page([sofie, ann, mads], works());
		await settle();
		expect(three.container.querySelector(".members-rows")?.classList.contains("is-compact")).toBe(false);
		expect(lineNames(three.container)).toEqual(["Ann (you)", "Sofie Lund", "Mads Berg"]);
		const others = Array.from({ length: 9 }, (_, n) => member(id(70 + n), `Person${n}`));
		const ten = page([...others, ann], works());
		await settle();
		expect(ten.container.querySelector(".members-rows")?.classList.contains("is-compact")).toBe(true);
		expect(lineNames(ten.container)).toEqual(["Ann (you)", ...others.map((other) => other.displayName)]);
		// Everyone shows the first three faces.
		expect(ten.container.querySelectorAll(".members-faces .person-avatar")).toHaveLength(3);
	});

	it("greys the agents of a member whose ChatGPT is full or signed out, and not of one who has none", async () => {
		const ida = member(id(62), "Ida Krog");
		const read = works({
			agents: held({ [id(42)]: sofie.userId, [id(43)]: mads.userId, [id(44)]: ida.userId }),
			logins: [
				{ userId: userA.id, state: "ready", usedPercent: null, resetsAt: null },
				{ userId: sofie.userId, state: "full", usedPercent: 100, resetsAt: "2026-09-10T13:00:00Z" },
				{ userId: mads.userId, state: "sign_in", usedPercent: null, resetsAt: null },
				{ userId: ida.userId, state: "none", usedPercent: null, resetsAt: null },
			],
		});
		const { container } = page([ann, sofie, mads, ida], read);
		await settle();
		const [mine, full, out, none] = lines(container);
		const sub = (line: HTMLElement | undefined) => line?.querySelector(".members-sub");
		expect(lines(container).map((line) => line.classList.contains("is-stuck"))).toEqual([false, true, true, false]);
		expect(sub(mine)?.getAttribute("title")).toBe("ChatGPT: Connected");
		expect(sub(mine)?.querySelector(".members-meter")).toBeNull();
		expect(sub(full)?.classList.contains("is-warn")).toBe(true);
		expect(sub(full)?.getAttribute("title")).toMatch(/^Full until .+\.$/);
		expect(sub(full)?.querySelector("span:last-child")?.textContent).not.toBe("");
		expect(sub(out)?.classList.contains("is-out")).toBe(true);
		expect(sub(out)?.getAttribute("title")).toBe("Needs a new sign-in.");
		expect(sub(none)?.classList.contains("is-none")).toBe(true);
		expect(sub(none)?.getAttribute("title")).toBe("No ChatGPT connected");
		// Another member's ChatGPT is theirs to connect: no button on their line.
		expect(container.querySelector(".members-sub button")).toBeNull();
		// The menu says what the member an agent would go to lacks.
		agentButton(container, "Bo").click();
		expect(menu().rows).toEqual([
			["Move to Sofie", "Sofie says yes first."],
			["Move to Mads", "Mads says yes first."],
			["Move to Ida", "Ida says yes first. Ida has no ChatGPT yet."],
		]);
	});

	it("says a full ChatGPT with no reset time is full for now, and greys no line without agents", async () => {
		const read = works({
			logins: [
				{ userId: userA.id, state: "ready", usedPercent: 12, resetsAt: null },
				{ userId: sofie.userId, state: "full", usedPercent: 100, resetsAt: null },
			],
		});
		const { container } = page([ann, sofie], read);
		await settle();
		const hers = lines(container)[1];
		expect(hers?.querySelector(".members-sub")?.getAttribute("title")).toBe("Full for now.");
		expect(hers?.classList.contains("is-stuck")).toBe(false);
	});

	it("offers the viewer their own missing ChatGPT where the meter would be", async () => {
		const openSettings = vi.fn();
		const logins = (state: "none" | "sign_in") => [
			{ userId: userA.id, state, usedPercent: null, resetsAt: null },
			{ userId: sofie.userId, state, usedPercent: null, resetsAt: null },
		];
		const none = page([ann, sofie], works({ logins: logins("none") }), { options: { openSettings } });
		await settle();
		const [mine, hers] = lines(none.container);
		expect(mine?.querySelector(".members-sub")?.getAttribute("title")).toBe("You have not connected ChatGPT.");
		expect(mine?.querySelector(".members-sub")?.textContent).toBe("Connect ChatGPT");
		expect(hers?.querySelector(".members-sub button")).toBeNull();
		mine?.querySelector<HTMLButtonElement>(".members-sub button")?.click();
		expect(openSettings).toHaveBeenCalledWith("ai-subscriptions");
		const out = page([ann, sofie], works({ logins: logins("sign_in") }), { options: { openSettings } });
		await settle();
		expect(lines(out.container)[0]?.querySelector(".members-sub")?.textContent).toBe("Sign in again");
		// Without a way to Settings, the picture alone.
		const plain = page([ann, sofie], works({ logins: [] }));
		await settle();
		expect(plain.container.querySelector(".members-sub button")).toBeNull();
		expect(lines(plain.container)[0]?.querySelector(".members-sub.is-none .members-meter")).not.toBeNull();
	});

	it("lets a viewer look but not move anything", async () => {
		const { container } = page([ann, sofie], works({ mayAsk: false, mayAskForOthers: false }));
		await settle();
		const buttons = [...container.querySelectorAll<HTMLButtonElement>(".members-agent")];
		expect(buttons).toHaveLength(5);
		expect(buttons.every((button) => button.disabled && !button.classList.contains("is-draggable"))).toBe(true);
		expect(container.querySelector("[aria-haspopup]")).toBeNull();
	});

	it("lets a member who may not ask for others give and take only their own", async () => {
		const read = works({ mayAskForOthers: false, agents: held({ [id(42)]: sofie.userId }) });
		const { container } = page([ann, sofie, mads], read);
		await settle();
		agentButton(container, "Freja").click();
		expect(menu()).toEqual({ caption: "Freja works for Sofie", rows: [["Move to me", "Sofie says yes first."]] });
		agentButton(container, "Bo").click();
		expect(menu().rows.map(([label]) => label)).toEqual(["Move to Sofie", "Move to Mads"]);
	});

	it("keeps the line of a member made a viewer while agents work for them, and sends them nothing", async () => {
		const viewer = { ...sofie, role: "viewer" as const };
		const { container } = page([ann, viewer], works({ agents: held({ [id(41)]: sofie.userId }) }));
		await settle();
		expect(lineNames(container)).toEqual(["Ann (you)", "Sofie Lund"]);
		expect(agentButton(container, "Clara").disabled).toBe(true);
		agentButton(container, "Bo").click();
		expect(menu().rows).toEqual([["Move to me", "Sofie says yes first."]]);
		// With no agents, a viewer has no line.
		const without = page([ann, viewer, mads], works());
		await settle();
		expect(lineNames(without.container)).toEqual(["Ann (you)", "Mads Berg"]);
	});

	it("gives the agents nobody works for a last line of their own", async () => {
		const { container, calls } = page([ann, sofie], works({ agents: held({ [id(44)]: null }) }));
		await settle();
		const last = container.querySelector(".members-rows")?.lastElementChild;
		expect(last?.querySelector(".members-who-text b")?.textContent).toBe("Nobody");
		expect(last?.querySelector(".members-nobody-face")?.textContent).toBe("?");
		expect(last?.getAttribute("aria-label")).toBe("1 agent");
		expect(agentNames(last!)).toEqual(["Astrid"]);
		// Nothing is dropped on it, and nobody has a ChatGPT.
		expect(last?.hasAttribute("data-drop-lane")).toBe(false);
		expect(last?.querySelector(".members-sub, .members-slot")).toBeNull();
		agentButton(container, "Astrid").click();
		expect(menu()).toEqual({
			caption: "Astrid works for nobody",
			rows: [
				["Move to me", null],
				["Move to Sofie", "Sofie says yes first."],
			],
		});
		choose("Move to me");
		await settle();
		expect(calls.ask).toHaveBeenCalledWith(id(44), userA.id);
	});

	it("says why a call failed, until the next one", async () => {
		const { container, calls } = page([ann, sofie], works());
		await settle();
		calls.ask.mockRejectedValueOnce(new Error("Sofie cannot take agents right now."));
		agentButton(container, "Clara").click();
		choose("Move to Sofie");
		await settle();
		const note = container.querySelector(".members-note");
		expect(note?.textContent).toBe("Sofie cannot take agents right now.");
		expect(note?.getAttribute("role")).toBe("alert");
		agentButton(container, "Clara").click();
		choose("Move to Sofie");
		await settle();
		expect(container.querySelector(".members-note")).toBeNull();
	});

	it("says it is reading, and what went wrong when the read failed", async () => {
		const reading = deferred<WorksFor>();
		const { container } = page([ann, sofie], works(), { reader: () => reading.promise });
		expect(container.querySelector(".members-foot")?.textContent).toBe("Reading who each agent works for…");
		reading.reject(new Error("The cloud did not answer."));
		await settle();
		expect(container.querySelector(".members-foot")?.textContent).toBe("The cloud did not answer.");
		expect(container.querySelector(".members-rows")).toBeNull();
	});

	it("never draws a late answer over the view that took the page's place", async () => {
		const late = deferred<WorksFor>();
		const { container } = page([ann, sofie], works(), { reader: () => late.promise });
		expect(container.querySelector(".members-page")).not.toBeNull();
		// The app shows a conversation in the same container; the read answers afterwards.
		container.replaceChildren(document.createElement("section"));
		container.firstElementChild!.textContent = "a conversation";
		late.resolve(works());
		await settle();
		expect(container.textContent).toBe("a conversation");
	});
});

describe("the works-for read (cloud/works-for.ts)", () => {
	it("reads the cloud's shape and refuses another", () => {
		const value = {
			schema: "qorpera.works-for/v1",
			may_ask: true,
			may_ask_for_others: false,
			agents: [{ staff_agent_id: id(41), user_id: null, since: null }],
			logins: [{ user_id: userA.id, state: "full", used_percent: 100, resets_at: "2026-09-10T13:00:00Z" }],
			asks: [],
		};
		expect(parseWorksFor(value)).toEqual({
			mayAsk: true,
			mayAskForOthers: false,
			agents: [{ agentId: id(41), userId: null }],
			logins: [{ userId: userA.id, state: "full", usedPercent: 100, resetsAt: "2026-09-10T13:00:00Z" }],
			asks: [],
		});
		expect(() => parseWorksFor({ ...value, schema: "qorpera.works-for/v2" })).toThrow();
		expect(() => parseWorksFor({ ...value, logins: [{ user_id: userA.id, state: "busy" }] })).toThrow();
	});
});
