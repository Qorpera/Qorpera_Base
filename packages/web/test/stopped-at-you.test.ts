// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthController } from "../src/app/auth.ts";
import { CompanyController } from "../src/app/company.ts";
import { interfaceRows } from "../src/app/interfaces.ts";
import { showWaitingInTitle } from "../src/app/tab-title.ts";
import { renderRail } from "../src/app/views/shell.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import type { HostedStaffAgent, HostedStaffExecutionActivity } from "../src/cloud/types.ts";
import { parseWaitingWork, type WaitingWork } from "../src/cloud/waiting-work.ts";
import { setLanguagePreference, untranslated } from "../src/ui/preferences.ts";
import { fixture, id, profileA, session, settle, staff, stubFigureMotion, team, timestamp, userA } from "./fixtures.ts";

/* "Stopped at you" (Jonas, 11 Nov 2026: "I would like the agents to be better at indicating when they need the users
 * input and it's really stopped at you"): what an agent's work waits on the member for (20260930723000) makes it need
 * them, says what for in the rail with a raised hand, and counts in the tab's title. */

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const dispose of cleanup.splice(0).reverse()) dispose();
	document.body.replaceChildren();
	document.title = "";
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const cofounder: HostedStaffAgent = { ...staff, id: id(40), displayName: "Co-Founder", templateId: "co-founder" };
const question = "Which logo should the shop use?";
const waits = (agent: string, extra: Partial<WaitingWork> = {}): WaitingWork => ({
	staffAgentId: agent,
	sessionId: session.sessionId,
	count: 1,
	questions: 1,
	approvals: 0,
	latestAt: timestamp,
	kind: "question",
	what: question,
	...extra,
});
const run = (extra: Partial<HostedStaffExecutionActivity> = {}): HostedStaffExecutionActivity => ({
	runId: id(90),
	staffAgentId: staff.id,
	sourceKind: "session_turn",
	jobStatus: "leased",
	activity: "working",
	updatedAt: timestamp,
	...extra,
});

function setup(agents: HostedStaffAgent[] = [staff]) {
	stubFigureMotion();
	const f = fixture();
	const company = new CompanyController(f.api, profileA, userA.id);
	const auth = new AuthController(f.cloud);
	company.store.set({ team, staff: agents, sessions: [{ ...session, staffAgentId: staff.id }], loading: false });
	const rail = document.createElement("aside");
	document.body.append(rail);
	const draw = () =>
		renderRail(rail, company, {
			profiles: [profileA],
			user: userA,
			auth,
			invitations: 0,
			route: { name: "company", profileId: profileA.profileId, section: "home" },
			openSettings() {},
			openFeedback() {},
			openFriends() {},
		});
	cleanup.push(() => {
		company.stop();
		auth.dispose();
	});
	const work = vi.mocked(f.api.listWaitingWork).mockReset();
	const row = () => rail.querySelector<HTMLElement>(`.rail-row[data-agent-id="${staff.id}"]`)!;
	return { company, rail, draw, api: f.api, work, row };
}

describe("an agent stopped at the member", () => {
	it("says what for under its name, in the warning colour, with a raised hand and the words in its name", async () => {
		const f = setup();
		f.work.mockResolvedValue([waits(staff.id)]);
		await f.company.refreshMentions();
		await settle();
		f.draw();
		expect(f.work).toHaveBeenCalledWith(profileA.profileId);
		expect(f.company.agentState(staff.id)).toBe("decision");
		const line = f.row().querySelector(".rail-row-copy small")!;
		expect(line.textContent).toBe(`Stopped: ${question}`);
		expect(line.classList.contains("is-waiting")).toBe(true);
		const hand = f.row().querySelector(".rail-row-stand > .rail-hand")!;
		expect(hand.getAttribute("aria-hidden")).toBe("true");
		expect(hand.querySelector("svg")).not.toBeNull();
		expect(f.row().getAttribute("aria-label")).toBe(`${staff.displayName} · Waiting for you: ${question}`);
		// The figure waits, as for any decision.
		expect(f.row().querySelector(".alert-mark")).toBeNull();
	});

	it("keeps the hand while the agent works on something else, and drops both once nothing waits", async () => {
		const f = setup();
		f.work.mockResolvedValue([waits(staff.id)]);
		await f.company.refreshApprovals();
		f.company.store.set({ activity: [run()] });
		f.draw();
		expect(f.company.agentState(staff.id)).toBe("working");
		expect(f.row().querySelector(".rail-row-copy small")?.textContent).toBe("Working");
		expect(f.row().querySelector(".rail-row-copy small")?.classList.contains("is-waiting")).toBe(false);
		expect(f.row().querySelector(".rail-hand")).not.toBeNull();
		expect(f.row().getAttribute("aria-label")).toBe(`${staff.displayName} · Working · Waiting for you: ${question}`);
		// Answered: the next read lists nothing for the agent.
		f.work.mockResolvedValue([]);
		await f.company.refreshApprovals();
		f.company.store.set({ activity: [] });
		f.draw();
		expect(f.company.agentState(staff.id)).toBe("idle");
		expect(f.row().querySelector(".rail-hand")).toBeNull();
		expect(f.row().getAttribute("aria-label")).not.toContain("Waiting for you");
	});

	it("needs the member over any listed run except one that works or writes", async () => {
		const f = setup();
		const later = new Date(Date.now() + 3_600_000).toISOString();
		const paused = {
			until: later,
			sponsorBindingId: id(70),
			paidByChatgptPlan: false,
			paidWhileAway: false,
			movable: false,
		};
		const cases: [HostedStaffExecutionActivity | undefined, string, string][] = [
			[undefined, "idle", "decision"],
			[run(), "working", "working"],
			[run({ phase: "writing" }), "writing", "writing"],
			[run({ jobStatus: "queued", activity: "waiting" }), "working", "working"],
			[run({ jobStatus: "queued", activity: "waiting", paused }), "idle", "decision"],
			[run({ jobStatus: "failed", activity: "needs_attention" }), "failed", "decision"],
			[run({ jobStatus: "leased", activity: "needs_attention" }), "decision", "decision"],
		];
		for (const [row, alone, waiting] of cases) {
			f.company.store.set({ activity: row ? [row] : [], waitingOnMe: {}, approvals: {} });
			expect(f.company.agentState(staff.id), `${row?.jobStatus} ${row?.activity} alone`).toBe(alone);
			f.company.store.set({ waitingOnMe: { [staff.id]: waits(staff.id) } });
			expect(f.company.agentState(staff.id), `${row?.jobStatus} ${row?.activity} waiting`).toBe(waiting);
		}
	});

	it("gives the pinned Co-Founder's card the hand too, without a line", async () => {
		const f = setup([cofounder, staff]);
		f.work.mockResolvedValue([
			waits(cofounder.id, { kind: "approval", what: "Send an email", questions: 0, approvals: 1 }),
		]);
		await f.company.refreshApprovals();
		f.draw();
		const card = f.rail.querySelector<HTMLElement>(".cofounder-home")!;
		expect(card.querySelector(".cofounder-stand > .rail-hand")).not.toBeNull();
		expect(card.getAttribute("aria-label")).toBe("Co-Founder · Waiting for you: Send an email");
		expect(f.company.store.get().approvals).toEqual({ [cofounder.id]: 1 });
		expect(f.row().querySelector(".rail-hand")).toBeNull();
	});

	it("says what for on the home page's waiting row", async () => {
		const f = setup();
		f.work.mockResolvedValue([waits(staff.id, { latestAt: "2026-10-02T09:50:00.250Z" })]);
		await f.company.refreshApprovals();
		const rows = interfaceRows(f.company, "waiting") ?? [];
		expect(rows.map(({ row }) => [row.title, row.due])).toEqual([
			[`${staff.displayName} needs you: ${question}`, "2026-10-02T09:50:00Z"],
		]);
	});

	it("speaks Danish", async () => {
		const f = setup();
		f.work.mockResolvedValue([waits(staff.id)]);
		await f.company.refreshApprovals();
		setLanguagePreference("da");
		try {
			f.draw();
			expect(f.row().querySelector(".rail-row-copy small")?.textContent).toBe(`Stoppet: ${question}`);
			expect(f.row().getAttribute("aria-label")).toBe(`${staff.displayName} · Venter på dig: ${question}`);
			expect(untranslated()).toEqual([]);
		} finally {
			setLanguagePreference("system");
			localStorage.clear();
		}
	});
});

describe("the tab's title", () => {
	it("counts the agents that wait on the member, and gives the title back at none", async () => {
		const f = setup([cofounder, staff, { ...staff, id: id(41), displayName: "Gone", employmentStatus: "archived" }]);
		document.title = "Qorpera";
		f.work.mockResolvedValue([waits(staff.id), waits(cofounder.id), waits(id(41))]);
		await f.company.refreshApprovals();
		// The agent no longer employed is not counted.
		expect(f.company.agentsWaitingOnMe()).toBe(2);
		showWaitingInTitle(f.company.agentsWaitingOnMe());
		expect(document.title).toBe("(2) Qorpera");
		f.work.mockResolvedValue([waits(staff.id)]);
		await f.company.refreshApprovals();
		showWaitingInTitle(f.company.agentsWaitingOnMe());
		expect(document.title).toBe("(1) Qorpera");
		showWaitingInTitle(0);
		expect(document.title).toBe("Qorpera");
		showWaitingInTitle(0);
		expect(document.title).toBe("Qorpera");
	});
});

describe("a cloud before 20260930723000", () => {
	it("reads the approval cards alone, as before, and does not ask for the new read again", async () => {
		const f = setup();
		f.work.mockRejectedValue(
			new CloudRpcError("qorpera_list_member_waiting_work", { message: "missing", code: "PGRST202" }, 404),
		);
		const approvals = vi
			.mocked(f.api.listWaitingApprovals)
			.mockReset()
			.mockResolvedValue([{ staffAgentId: staff.id, sessionId: session.sessionId, count: 2, latestAt: timestamp }]);
		await f.company.refreshApprovals();
		await f.company.refreshApprovals();
		f.draw();
		expect(f.work).toHaveBeenCalledTimes(1);
		expect(approvals).toHaveBeenCalledTimes(2);
		expect(f.company.store.get().waitingWorkUnavailable).toBe(true);
		expect(f.company.agentState(staff.id)).toBe("decision");
		// No words to say what for: "Needs you", as before, with the hand.
		expect(f.row().querySelector(".rail-row-copy small")?.textContent).toBe("Needs you");
		expect(f.row().getAttribute("aria-label")).toBe(`${staff.displayName} · Needs you`);
		expect(f.row().querySelector(".rail-hand")).not.toBeNull();
		expect(f.company.agentsWaitingOnMe()).toBe(1);
	});

	it("keeps what it had when the read fails another way, and asks again next time", async () => {
		const f = setup();
		f.work.mockResolvedValueOnce([waits(staff.id)]).mockRejectedValueOnce(new Error("offline"));
		const approvals = vi.mocked(f.api.listWaitingApprovals).mockReset();
		await f.company.refreshApprovals();
		await f.company.refreshApprovals();
		expect(f.company.store.get().waitingWorkUnavailable).toBeUndefined();
		expect(approvals).not.toHaveBeenCalled();
		expect(f.company.waitingFor(staff.id)).toEqual({ count: 1, what: question });
		f.work.mockResolvedValue([]);
		await f.company.refreshApprovals();
		expect(f.company.waitingFor(staff.id)).toBeUndefined();
	});
});

describe("the waiting work read", () => {
	it("parses each agent's newest item, and leaves out words and kinds it can't use", () => {
		const parsed = parseWaitingWork({
			schema: "qorpera.member-waiting-work/v1",
			agents: [
				{ ...waits(staff.id), staffAgentId: staff.id.toUpperCase(), what: "  Pick\n a   name  " },
				{ ...waits(id(41)), kind: "form", what: null },
			],
		});
		expect(parsed).toEqual([
			{ ...waits(staff.id), what: "Pick a name" },
			{
				staffAgentId: id(41),
				sessionId: session.sessionId,
				count: 1,
				questions: 1,
				approvals: 0,
				latestAt: timestamp,
			},
		]);
		expect(() => parseWaitingWork({ schema: "qorpera.member-waiting-work/v2", agents: [] })).toThrow();
		expect(() =>
			parseWaitingWork({ schema: "qorpera.member-waiting-work/v1", agents: [{ ...waits(staff.id), count: 0 }] }),
		).toThrow();
	});
});
