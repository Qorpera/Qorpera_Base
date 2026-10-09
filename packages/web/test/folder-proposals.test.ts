// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import { CloudApi } from "../src/cloud/api.ts";
import { type Cloud, CloudRpcError } from "../src/cloud/client.ts";
import {
	type FolderProposal,
	type FolderProposalUnit,
	parseFolderProposalDiscard,
	parseFolderProposalPage,
} from "../src/cloud/proposals.ts";
import { proposalChange, renderProposalCard } from "../src/ui/proposal-card.ts";
import {
	deferred,
	fixture,
	id,
	profileA,
	session,
	settle,
	staff,
	stubFigureMotion,
	team,
	timestamp,
	userA,
} from "./fixtures.ts";

const agentFile = "agents/sales-lead/agent.md";

function unitJson(unit: number, overrides: Record<string, unknown> = {}) {
	return { unit, op: "write", path: `notes/plan-${unit}.md`, ...overrides };
}

function proposalJson(n: number, units: unknown[], overrides: Record<string, unknown> = {}) {
	return {
		proposalId: id(n),
		createdAt: timestamp,
		viewKind: "coding_session",
		createsAgent: false,
		unitCount: units.length,
		units,
		moreUnits: 0,
		...overrides,
	};
}

function pageJson(proposals: unknown[], overrides: Record<string, unknown> = {}) {
	return { schema: "qorpera.member-folder-proposals/v1", proposals, moreProposals: 0, nextCursor: null, ...overrides };
}

function unit(overrides: Partial<FolderProposalUnit> = {}): FolderProposalUnit {
	return { unit: 1, op: "write", path: "notes/plan.md", structured: [], ...overrides };
}

function proposal(n: number, units: FolderProposalUnit[], overrides: Partial<FolderProposal> = {}): FolderProposal {
	return {
		proposalId: id(n),
		createdAt: timestamp,
		viewKind: "coding_session",
		createsAgent: false,
		unitCount: units.length,
		units,
		moreUnits: 0,
		...overrides,
	};
}

describe("the proposals page", () => {
	it("reads the caller's open proposals with only the strings a card names them by", () => {
		const page = parseFolderProposalPage(
			pageJson([
				proposalJson(
					500,
					[
						unitJson(1, {
							path: agentFile,
							structured: [
								{
									path: agentFile,
									kind: "agent",
									parse: { name: "Sales Lead", role: "Sales", instructions: "secret", status: 3 },
								},
							],
						}),
						unitJson(2, { op: "move", path: "notes/a.md", to: "notes/b.md" }),
					],
					{ proposalId: id(500).toUpperCase(), createsAgent: true },
				),
			]),
		);
		expect(page).toEqual({
			proposals: [
				{
					proposalId: id(500),
					createdAt: timestamp,
					viewKind: "coding_session",
					createsAgent: true,
					unitCount: 2,
					units: [
						{
							unit: 1,
							op: "write",
							path: agentFile,
							structured: [{ path: agentFile, kind: "agent", name: "Sales Lead", role: "Sales" }],
						},
						{ unit: 2, op: "move", path: "notes/a.md", to: "notes/b.md", structured: [] },
					],
					moreUnits: 0,
				},
			],
			moreProposals: 0,
		});
	});

	it("reads a full page that has more after it, with its cursor", () => {
		const four = [501, 502, 503, 504].map((n) => proposalJson(n, [unitJson(1)]));
		const units = Array.from({ length: 50 }, (_, index) => unitJson(index + 1));
		four[3] = proposalJson(504, units, { unitCount: 60, moreUnits: 10 });
		const page = parseFolderProposalPage(pageJson(four, { moreProposals: 3, nextCursor: id(504) }));
		expect(page.proposals.map((item) => item.proposalId)).toEqual([id(501), id(502), id(503), id(504)]);
		expect(page.proposals[3]).toMatchObject({ unitCount: 60, moreUnits: 10 });
		expect(page.proposals[3]?.units).toHaveLength(50);
		expect(page).toMatchObject({ moreProposals: 3, nextCursor: id(504) });
	});

	it.each([
		["another schema", pageJson([], { schema: "qorpera.folder-proposals/v1" })],
		["five proposals", pageJson([501, 502, 503, 504, 505].map((n) => proposalJson(n, [unitJson(1)])))],
		["a proposal twice", pageJson([proposalJson(501, [unitJson(1)]), proposalJson(501, [unitJson(1)])])],
		["more without a cursor", pageJson([proposalJson(501, [unitJson(1)])], { moreProposals: 1 })],
		[
			"a cursor on a short page",
			pageJson([proposalJson(501, [unitJson(1)])], { moreProposals: 1, nextCursor: id(501) }),
		],
		[
			"a cursor that is not the last proposal",
			pageJson(
				[501, 502, 503, 504].map((n) => proposalJson(n, [unitJson(1)])),
				{ moreProposals: 1, nextCursor: id(501) },
			),
		],
		["a cursor without more", pageJson([proposalJson(501, [unitJson(1)])], { nextCursor: id(501) })],
		["no units", pageJson([proposalJson(501, [], { unitCount: 0 })])],
		["fewer units than counted", pageJson([proposalJson(501, [unitJson(1)], { unitCount: 2 })])],
		["a miscounted rest", pageJson([proposalJson(501, [unitJson(1)], { moreUnits: 1 })])],
		["units out of order", pageJson([proposalJson(501, [unitJson(2), unitJson(1)])])],
		["no createsAgent", pageJson([proposalJson(501, [unitJson(1)], { createsAgent: null })])],
		[
			"a file without a parse",
			pageJson([proposalJson(501, [unitJson(1, { structured: [{ path: agentFile, kind: "agent" }] })])]),
		],
	])("refuses %s", (_label, value) => {
		expect(() => parseFolderProposalPage(value)).toThrow(/invalid/);
	});

	it("reads a discard's answer for the proposal asked for", () => {
		const answer = { schema: "qorpera.folder-proposal/v1", proposalId: id(500), status: "discarded" };
		expect(parseFolderProposalDiscard(answer, id(500).toUpperCase())).toBe("discarded");
		expect(parseFolderProposalDiscard({ ...answer, status: "applied" }, id(500))).toBe("applied");
		expect(() => parseFolderProposalDiscard({ ...answer, proposalId: id(501) }, id(500))).toThrow(/invalid/);
		expect(() => parseFolderProposalDiscard({ ...answer, status: "open" }, id(500))).toThrow(/invalid/);
		expect(() => parseFolderProposalDiscard({ ...answer, schema: "x" }, id(500))).toThrow(/invalid/);
	});

	it("lists and discards through the member's functions", async () => {
		const rpc = vi.fn<Cloud["rpc"]>(async (name: string) =>
			name === "qorpera_member_folder_agent_proposals"
				? pageJson([])
				: { schema: "qorpera.folder-proposal/v1", proposalId: id(500), status: "discarded" },
		);
		const api = new CloudApi({ rpc } as unknown as Cloud);
		await expect(api.listAgentProposals(profileA.environmentId, staff.id)).resolves.toEqual({
			proposals: [],
			moreProposals: 0,
		});
		expect(rpc).toHaveBeenCalledWith("qorpera_member_folder_agent_proposals", {
			p_environment_id: profileA.environmentId,
			p_staff_agent_id: staff.id,
			p_request: {},
		});
		await expect(api.discardProposal(profileA.environmentId, id(500).toUpperCase())).resolves.toBe("discarded");
		expect(rpc).toHaveBeenCalledWith("qorpera_member_folder_discard_proposal", {
			p_environment_id: profileA.environmentId,
			p_proposal_id: id(500),
		});
	});
});

describe("a proposal's changes in plain words", () => {
	const structured = (kind: string, path: string, parse: Record<string, string> = {}) => ({ path, kind, ...parse });

	it("names agents, group chats, routines, interfaces and tables by their parse, else by their folder", () => {
		const agent = (parse: Record<string, string>) =>
			unit({ path: agentFile, structured: [structured("agent", agentFile, parse)] });
		expect(proposalChange(agent({ name: "Sales  Lead", role: "Head of sales" }), true)).toBe(
			"Hire “Sales Lead” as Head of sales",
		);
		expect(proposalChange(agent({}), true)).toBe("Hire “Sales lead”");
		expect(proposalChange(agent({ name: "Sales Lead" }), false)).toBe("Make the agent “Sales Lead” active again");
		expect(proposalChange(agent({ name: "Sales Lead", status: "archived" }), false)).toBe(
			"Archive the agent “Sales Lead”",
		);
		const group = "agents/groups/launch-team/group.md";
		expect(proposalChange(unit({ path: group, structured: [structured("group", group)] }), false)).toBe(
			"Start the group chat “Launch team”",
		);
		const routine = (parse: Record<string, string>) =>
			unit({
				path: "agents/sales-lead/routines/weekly-report.md",
				structured: [structured("routine", "agents/sales-lead/routines/weekly-report.md", parse)],
			});
		expect(proposalChange(routine({ title: "Friday report" }), false)).toBe(
			"Set up or change the routine “Friday report”",
		);
		expect(proposalChange(routine({}), false)).toBe("Set up or change the routine “Weekly report”");
		expect(proposalChange(routine({ title: "Friday report", status: "paused" }), false)).toBe(
			"Pause the routine “Friday report”",
		);
		expect(proposalChange(routine({ title: "Friday report", status: "concluded" }), false)).toBe(
			"End the routine “Friday report”",
		);
		const shown = "interfaces/leads/interface.md";
		expect(proposalChange(unit({ path: shown, structured: [structured("interface", shown)] }), false)).toBe(
			"Set up or change the interface “Leads”",
		);
		expect(
			proposalChange(unit({ structured: [structured("table", "tables/leads.json", { name: "Leads" })] }), false),
		).toBe("Set up or change the table “Leads”");
		const long = "x".repeat(200);
		expect(proposalChange(agent({ name: long }), false)).toBe(`Make the agent “${"x".repeat(119)}…” active again`);
	});

	it("says a delete, a rename, a move and any other change by the file's name, never its path", () => {
		expect(proposalChange(unit({ op: "delete", path: "clients/old-offer.md" }), false)).toBe(
			"Delete “Old offer” from “Clients”",
		);
		expect(proposalChange(unit({ op: "delete", path: "old-offer.md" }), false)).toBe("Delete “Old offer”");
		expect(proposalChange(unit({ op: "move", path: "clients/a-plan.md", to: "clients/b-plan.md" }), false)).toBe(
			"Rename “A plan” to “B plan”",
		);
		expect(proposalChange(unit({ op: "move", path: "clients/plan.md", to: "archive/2026/plan.md" }), false)).toBe(
			"Move “Plan” to “2026”",
		);
		expect(proposalChange(unit({ op: "move", path: "clients/plan.md", to: "plan.md" }), false)).toBe(
			"Move “Plan” to the top of the Company File",
		);
		expect(proposalChange(unit({ path: "clients/acme/notes.md" }), false)).toBe("Change “Notes”");
	});

	it("is one card: the change or a count, where it was saved, and Discard", () => {
		const discard = vi.fn();
		const one = renderProposalCard(proposal(500, [unit({ path: "clients/notes.md" })]), {
			discarding: false,
			discard,
		});
		expect(one.dataset.proposalId).toBe(id(500));
		expect(one.querySelector("h3")?.textContent).toBe("Change “Notes”");
		expect(one.querySelector(".review-change")).toBeNull();
		expect(one.querySelector(".review-waiting")?.textContent).toBe(
			"From a coding session. Not in the Company File yet.",
		);
		const button = one.querySelector<HTMLButtonElement>("button")!;
		expect(button.textContent).toBe("Discard");
		button.click();
		expect(discard).toHaveBeenCalledOnce();
		expect(one.textContent).not.toContain("clients/");

		const units = Array.from({ length: 10 }, (_, index) =>
			unit({ unit: index + 1, path: `notes/plan-${index + 1}.md` }),
		);
		const many = renderProposalCard(proposal(501, units, { unitCount: 60, moreUnits: 50, viewKind: "run_box" }), {
			discarding: true,
			discard,
		});
		expect(many.querySelector("h3")?.textContent).toBe("60 saved changes");
		expect([...many.querySelectorAll(".review-change p")].map((node) => node.textContent)).toEqual([
			...Array.from({ length: 8 }, (_, index) => `Change “Plan ${index + 1}”`),
			"And 52 more.",
		]);
		expect(many.querySelector(".review-waiting")?.textContent).toBe(
			"From the agent's workspace. Not in the Company File yet.",
		);
		expect(many.querySelector("button")?.disabled).toBe(true);
		expect(many.querySelector("button")?.textContent).toBe("Discarding…");
		expect(many.textContent).not.toContain("notes/");
	});
});

let dispose: (() => void) | undefined;
beforeEach(() => {
	vi.useFakeTimers({ now: Date.parse("2026-09-22T10:10:00Z") });
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	vi.stubGlobal("innerWidth", 1280);
	stubFigureMotion();
	history.replaceState(null, "", `/#/c/${profileA.profileId}/chat/${session.sessionId}`);
});
afterEach(() => {
	dispose?.();
	dispose = undefined;
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function mount(sessionOverrides: Partial<typeof session> = { staffAgentId: staff.id }) {
	const f = fixture();
	const company = new CompanyController(f.api, profileA, userA.id);
	company.store.set({ team, staff: [staff], sessions: [{ ...session, ...sessionOverrides }], loading: false });
	const store = company.conversation(session.sessionId, false);
	const view = new ConversationView(company, session.sessionId);
	document.body.append(view.el);
	dispose = () => {
		view.dispose();
		company.stop();
	};
	return { ...f, company, view, store, log: () => view.el.querySelector<HTMLElement>('[role="log"]')! };
}

const page = (proposals: FolderProposal[], moreProposals = 0) =>
	moreProposals
		? { proposals, moreProposals, nextCursor: proposals.at(-1)?.proposalId }
		: { proposals, moreProposals };

describe("open proposals in the agent's thread", () => {
	it("waits below the thread, and a discarded one leaves it with the keyboard on the thread", async () => {
		const f = mount();
		const first = proposal(500, [unit({ path: "clients/notes.md" })]);
		const second = proposal(501, [unit({ op: "delete", path: "clients/old-offer.md" })], {
			viewKind: "test_machine",
		});
		vi.mocked(f.api.listAgentProposals).mockResolvedValue(page([first, second]));
		await f.company.loadConversation(session.sessionId);
		await settle();
		expect(f.api.listAgentProposals).toHaveBeenCalledWith(profileA.environmentId, staff.id);
		const cards = () => [...f.log().querySelectorAll<HTMLElement>(".proposal-card")];
		expect(cards().map((card) => card.querySelector("h3")?.textContent)).toEqual([
			"Change “Notes”",
			"Delete “Old offer” from “Clients”",
		]);
		expect(f.log().textContent).not.toContain("clients/");
		expect(f.log().querySelector(".empty")).toBeNull();

		const discarded = deferred<"discarded">();
		vi.mocked(f.api.discardProposal).mockReturnValue(discarded.promise);
		vi.mocked(f.api.listAgentProposals).mockResolvedValue(page([first, second]));
		cards()[0]!.querySelector<HTMLButtonElement>("button")!.focus();
		cards()[0]!.querySelector<HTMLButtonElement>("button")!.click();
		await settle();
		expect(f.api.discardProposal).toHaveBeenCalledWith(profileA.environmentId, id(500));
		// While it is sent, the card says so and keeps the keyboard.
		const sending = cards()[0]!;
		expect(sending.querySelector("button")?.disabled).toBe(true);
		expect(sending.querySelector("button")?.textContent).toBe("Discarding…");
		expect(document.activeElement).toBe(sending);
		discarded.resolve("discarded");
		await settle();
		// A listing read before the discard landed does not bring it back.
		expect(cards().map((card) => card.dataset.proposalId)).toEqual([id(501)]);
		expect(document.activeElement).toBe(f.view.el.querySelector(".messages"));
		expect(f.store.get().discardingProposals).toBeUndefined();
	});

	it("drops one that is gone, and keeps one the cloud refused with why", async () => {
		const f = mount();
		const first = proposal(500, [unit()]);
		const second = proposal(501, [unit()]);
		vi.mocked(f.api.listAgentProposals).mockResolvedValue(page([first, second], 2));
		await f.company.loadConversation(session.sessionId);
		await settle();
		expect(f.log().querySelector(".conversation-note")?.textContent).toBe("More saved changes wait after these.");
		vi.mocked(f.api.discardProposal).mockRejectedValueOnce(
			new CloudRpcError("qorpera_member_folder_discard_proposal", {
				message: "Proposal is unavailable",
				code: "P0002",
			}),
		);
		await f.company.discardProposal(session.sessionId, id(500));
		await settle();
		expect(
			[...f.log().querySelectorAll<HTMLElement>(".proposal-card")].map((card) => card.dataset.proposalId),
		).toEqual([id(501)]);
		vi.mocked(f.api.discardProposal).mockRejectedValueOnce(
			new CloudRpcError("qorpera_member_folder_discard_proposal", {
				message: "Only the member it waits for, owners and admins discard a proposal",
				code: "42501",
			}),
		);
		await expect(f.company.discardProposal(session.sessionId, id(501))).rejects.toThrow(/Only the member/);
		await settle();
		expect(f.store.get().interactionError).toBe("Only the member it waits for, owners and admins discard a proposal");
		expect(f.log().querySelector<HTMLElement>(".proposal-card")?.dataset.proposalId).toBe(id(501));
	});

	it("is read only in the agent's thread, and a failed listing keeps the cards", async () => {
		const f = mount();
		vi.mocked(f.api.listAgentProposals).mockResolvedValue(page([proposal(500, [unit()])]));
		await f.company.loadConversation(session.sessionId);
		vi.mocked(f.api.listAgentProposals).mockRejectedValue(new Error("offline"));
		await f.company.loadConversation(session.sessionId);
		await settle();
		expect(f.log().querySelectorAll(".proposal-card")).toHaveLength(1);
		dispose?.();

		// A routine's session is the agent's too, but not its thread.
		const routine = mount({ staffAgentId: staff.id, executionScope: { autonomousLabel: "Weekly report" } });
		await routine.company.loadConversation(session.sessionId);
		await settle();
		expect(routine.api.listAgentProposals).not.toHaveBeenCalled();
		expect(routine.store.get().proposals).toBeUndefined();
	});
});
