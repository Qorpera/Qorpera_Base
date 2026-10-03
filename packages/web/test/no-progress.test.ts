// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import { parseStaffExecutionActivity } from "../src/cloud/parse.ts";
import type { HostedStaffExecutionActivity } from "../src/cloud/types.ts";
import { fixture, id, profileA, session, settle, staff, stubFigureMotion, team, timestamp, userA } from "./fixtures.ts";

/* A run with no progress for the cloud's stall minutes (session-buildup audit gap 4, migration 20260930002600): the
 * thread says so above the composer, with the cloud's number; nothing is stopped. */
const NOTICE = "No progress for 15 minutes.";
const stall = { noProgressSince: timestamp, noProgressMinutes: 15 };
const cleanup: (() => void)[] = [];
beforeEach(() => {
	stubFigureMotion();
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
	for (const dispose of cleanup.splice(0).reverse()) dispose();
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const working: HostedStaffExecutionActivity = {
	runId: id(90),
	staffAgentId: staff.id,
	sourceKind: "session_turn",
	jobStatus: "leased",
	activity: "working",
	updatedAt: timestamp,
};

function setup() {
	const f = fixture();
	const company = new CompanyController(f.api, profileA, userA.id);
	company.store.set({ team, staff: [staff], sessions: [{ ...session, staffAgentId: staff.id }], loading: false });
	company.conversation(session.sessionId, false).set({ loading: false });
	const view = new ConversationView(company, session.sessionId);
	document.body.append(view.el);
	cleanup.push(() => {
		view.dispose();
		company.stop();
	});
	const show = async (rows: HostedStaffExecutionActivity[]) => {
		vi.mocked(f.api.listStaffActivity).mockResolvedValue(rows);
		await company.refreshActivity();
		await settle();
		view.update();
	};
	const notice = () => view.el.textContent?.includes(NOTICE) ?? false;
	return { company, view, show, notice };
}

describe("a run with no progress for 15 minutes", () => {
	it("reads the stall time and minutes when the cloud names them, and nothing from an older cloud", () => {
		const row = {
			run_id: id(90),
			staff_agent_id: staff.id,
			source_kind: "wake",
			job_status: "leased",
			activity: "working",
			updated_at: timestamp,
		};
		expect(
			parseStaffExecutionActivity([{ ...row, no_progress_since: timestamp, no_progress_minutes: 15 }])[0],
		).toMatchObject(stall);
		for (const value of [undefined, null])
			expect(parseStaffExecutionActivity([{ ...row, no_progress_since: value }])[0]).not.toHaveProperty(
				"noProgressSince",
			);
		const parse = (extra: Record<string, unknown>) => () => parseStaffExecutionActivity([{ ...row, ...extra }]);
		expect(parse({ no_progress_since: "yesterday", no_progress_minutes: 15 })).toThrow();
		// The minutes come with the time, or the row is refused.
		expect(parse({ no_progress_since: timestamp })).toThrow();
		expect(parse({ no_progress_since: timestamp, no_progress_minutes: 0 })).toThrow();
		expect(parse({ no_progress_minutes: 15 })).toThrow();
	});

	it("says so in the agent's thread while the run works on, and stops saying it once it progresses", async () => {
		const f = setup();
		await f.show([working]);
		expect(f.notice()).toBe(false);
		await f.show([{ ...working, ...stall }]);
		expect(f.notice()).toBe(true);
		// The number is the cloud's.
		await f.show([{ ...working, ...stall, noProgressMinutes: 20 }]);
		expect(f.view.el.textContent).toContain("No progress for 20 minutes.");
		await f.show([{ ...working, ...stall }]);
		// The run is still shown as working: nothing is stopped or failed.
		expect(f.company.agentState(staff.id)).toBe("working");
		expect(f.view.el.querySelector(".thread-activity")).not.toBeNull();
		await f.show([{ ...working, phase: "writing" }]);
		expect(f.notice()).toBe(false);
		// A queued run has no stall to show, whatever a row says.
		await f.show([{ ...working, jobStatus: "queued", activity: "waiting", ...stall }]);
		expect(f.company.noProgress(staff.id)).toBe(undefined);
		await f.show([{ ...working, activity: "needs_attention", jobStatus: "failed", ...stall }]);
		expect(f.company.noProgress(staff.id)).toBe(undefined);
		expect(f.notice()).toBe(false);
	});
});
