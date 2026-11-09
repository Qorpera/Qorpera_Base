// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { renderMembers } from "../src/app/views/members.ts";
import type { HostedProfileMember, HostedStaffAgent } from "../src/cloud/types.ts";
import { parseWorksFor, type WorksFor, type WorksForCalls } from "../src/cloud/works-for.ts";
import { fixture, id, profileA, settle, staff, stubFigureMotion, team, timestamp, userA } from "./fixtures.ts";

/* The Members page (app/views/members.ts; Jonas, 9 Nov 2026): who each agent works for, drawn big. Up to three
 * members a mat each; more, a tile each and one opened below. An agent moves by an ask the other side says yes to. */

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

const cleanup: (() => void)[] = [];
beforeEach(() => stubFigureMotion());
afterEach(() => {
	for (const dispose of cleanup.splice(0).reverse()) dispose();
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function page(members: HostedProfileMember[], read: WorksFor, staffList: HostedStaffAgent[] = [cofounder, ...crew]) {
	const f = fixture();
	const controller = new CompanyController(f.api, profileA, userA.id);
	controller.store.set({
		loading: false,
		staff: staffList,
		team: { ...team, members },
		interfaceFolder: { tables: new Map(), files: new Map(), sources: new Map() },
	});
	cleanup.push(() => controller.stop());
	const calls: WorksForCalls = {
		read: vi.fn(async () => read),
		ask: vi.fn(async () => ({ moved: false, askId: id(90) })),
		answer: vi.fn(async () => ({ status: "yes" as const, moved: true })),
	};
	vi.spyOn(controller, "worksFor").mockReturnValue(calls);
	const container = document.createElement("main");
	document.body.append(container);
	renderMembers(container, controller);
	return { container, calls };
}

const click = (root: ParentNode, label: string) => {
	const target = [...root.querySelectorAll("button")].find((button) => button.textContent?.trim() === label);
	if (!target) throw new Error(`No button ${label}`);
	target.click();
};
const agentButton = (root: ParentNode, name: string) =>
	[...root.querySelectorAll<HTMLButtonElement>(".members-agent")].find(
		(button) => button.querySelector(".members-agent-name")?.textContent === name,
	);

describe("the Members page", () => {
	it("draws a mat per member with the agents that work for them, and no tabs", async () => {
		const { container } = page([ann, sofie], works());
		await settle();
		const mats = [...container.querySelectorAll(".members-mat")];
		expect(mats).toHaveLength(2);
		expect(mats[0]?.textContent).toContain("Ann (you)");
		expect(mats[0]?.textContent).toContain("4 agents work for you");
		expect(mats[0]?.textContent).toContain("71 % used");
		expect(mats[1]?.textContent).toContain("No agents work for Sofie yet.");
		expect(container.querySelector(".interface-tabs, [role=tablist]")).toBeNull();
		// The Co-Founder works for everyone and is not on a mat.
		expect(agentButton(container, "Kaya")).toBeUndefined();
	});

	it("suggests a split when one member carries the crew, and asks for that area's agents", async () => {
		const { container, calls } = page([ann, sofie], works());
		await settle();
		expect(container.querySelector(".members-suggest")?.textContent).toContain(
			"You carry 4 agents and Sofie none. Shall Sofie take Marketing?",
		);
		click(container, "Ask Sofie");
		await settle();
		expect(calls.ask).toHaveBeenCalledWith(id(44), sofie.userId);
		expect(calls.ask).toHaveBeenCalledWith(id(43), sofie.userId);
		expect(calls.ask).toHaveBeenCalledTimes(2);
		expect(container.querySelector(".members-note")?.textContent).toBe(
			"Asked Sofie. Nothing moves until they say yes.",
		);
	});

	it("moves a picked agent with the member's button", async () => {
		const { container, calls } = page([ann, sofie], works());
		await settle();
		agentButton(container, "Clara")?.click();
		expect(container.querySelector(".members-move")?.textContent).toContain("Move Clara to");
		click(container, "Sofie");
		await settle();
		expect(calls.ask).toHaveBeenCalledWith(id(43), sofie.userId);
	});

	it("shows the asks the member answers, and an agent waiting on one", async () => {
		const asks = [
			{
				id: id(91),
				agentId: id(43),
				fromUserId: sofie.userId,
				toUserId: userA.id,
				askedByUserId: sofie.userId,
				askedByAgentId: null,
				answerByUserId: userA.id,
				createdAt: timestamp,
			},
		];
		const read = works({
			agents: crew.map((entry) => ({ agentId: entry.id, userId: entry.id === id(43) ? sofie.userId : userA.id })),
			asks,
		});
		const { container, calls } = page([ann, sofie], read);
		await settle();
		expect(container.querySelector(".members-ask")?.textContent).toContain("Sofie asks you to take Clara.");
		expect(agentButton(container, "Clara")?.disabled).toBe(true);
		expect(container.textContent).toContain("Waiting for you");
		click(container, "Yes");
		await settle();
		expect(calls.answer).toHaveBeenCalledWith(id(91), true);
		expect(container.querySelector(".members-note")?.textContent).toBe("Clara now works for you.");
	});

	it("draws ten members as tiles with one opened, problems first after you", async () => {
		const others = Array.from({ length: 9 }, (_, n) => member(id(70 + n), `Person${n}`));
		const read = works({
			logins: [
				{ userId: userA.id, state: "ready", usedPercent: 40, resetsAt: null },
				{ userId: id(75), state: "full", usedPercent: 100, resetsAt: "2026-09-10T13:00:00Z" },
				{ userId: id(77), state: "sign_in", usedPercent: null, resetsAt: null },
			],
		});
		const { container } = page([ann, ...others], read);
		await settle();
		const tiles = [...container.querySelectorAll(".members-tile")];
		expect(tiles).toHaveLength(10);
		expect(container.querySelectorAll(".members-mat")).toHaveLength(1);
		expect(tiles[0]?.textContent).toContain("You");
		expect(tiles[1]?.classList.contains("is-warn")).toBe(true);
		expect(tiles[2]?.classList.contains("is-warn")).toBe(true);
		expect(container.querySelector(".members-summary")?.textContent).toContain("2 can't work right now");
		// A tap on a tile opens that member below.
		(tiles[3] as HTMLButtonElement).click();
		expect(container.querySelector(".members-mat .members-who b")?.textContent).toMatch(/^Person/);
	});

	it("lets a viewer look but not move anything", async () => {
		const { container } = page([ann, sofie], works({ mayAsk: false, mayAskForOthers: false }));
		await settle();
		expect(agentButton(container, "Bo")?.disabled).toBe(true);
		expect(container.querySelector(".members-suggest")).toBeNull();
	});

	it("puts agents that work for nobody in the open pile", async () => {
		const read = works({
			agents: crew.map((entry) => ({ agentId: entry.id, userId: entry.id === id(44) ? null : userA.id })),
		});
		const { container } = page([ann, sofie], read);
		await settle();
		expect(container.querySelector(".members-mat.is-pile")?.textContent).toContain("Astrid");
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
