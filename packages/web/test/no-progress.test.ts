// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import { parseStaffExecutionActivity } from "../src/cloud/parse.ts";
import type { HostedStaffExecutionActivity } from "../src/cloud/types.ts";
import { fixture, id, profileA, session, settle, staff, stubFigureMotion, team, timestamp, userA } from "./fixtures.ts";

/* A run with no progress for 15 minutes (session-buildup audit gap 4, migration 20260930002600): the thread says so
 * above the composer; nothing is stopped. */
const NOTICE = "No progress for 15 minutes.";
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
	it("reads the stall time when the cloud names one, and nothing from an older cloud", () => {
		const row = {
			run_id: id(90),
			staff_agent_id: staff.id,
			source_kind: "wake",
			job_status: "leased",
			activity: "working",
			updated_at: timestamp,
		};
		expect(parseStaffExecutionActivity([{ ...row, no_progress_since: timestamp }])[0]?.noProgressSince).toBe(
			timestamp,
		);
		for (const value of [undefined, null])
			expect(parseStaffExecutionActivity([{ ...row, no_progress_since: value }])[0]).not.toHaveProperty(
				"noProgressSince",
			);
		expect(() => parseStaffExecutionActivity([{ ...row, no_progress_since: "yesterday" }])).toThrow();
	});

	it("says so in the agent's thread while the run works on, and stops saying it once it progresses", async () => {
		const f = setup();
		await f.show([working]);
		expect(f.notice()).toBe(false);
		await f.show([{ ...working, noProgressSince: timestamp }]);
		expect(f.notice()).toBe(true);
		// The run is still shown as working: nothing is stopped or failed.
		expect(f.company.agentState(staff.id)).toBe("working");
		expect(f.view.el.querySelector(".thread-activity")).not.toBeNull();
		await f.show([{ ...working, phase: "writing" }]);
		expect(f.notice()).toBe(false);
		// A queued run has no stall to show, whatever a row says.
		await f.show([{ ...working, jobStatus: "queued", activity: "waiting", noProgressSince: timestamp }]);
		expect(f.company.noProgressSince(staff.id)).toBe(undefined);
		await f.show([{ ...working, activity: "needs_attention", jobStatus: "failed", noProgressSince: timestamp }]);
		expect(f.company.noProgressSince(staff.id)).toBe(undefined);
		expect(f.notice()).toBe(false);
	});
});
