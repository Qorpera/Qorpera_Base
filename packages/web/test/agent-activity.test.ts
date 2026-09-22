// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthController } from "../src/app/auth.ts";
import { CompanyController } from "../src/app/company.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import { renderRail } from "../src/app/views/shell.ts";
import { parseStaffExecutionActivity } from "../src/cloud/parse.ts";
import type { HostedStaffExecutionActivity } from "../src/cloud/types.ts";
import { fixture, id, profileA, session, settle, staff, stubFigureMotion, team, timestamp, userA } from "./fixtures.ts";

const cleanup: (() => void)[] = [];
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
	const mount = stubFigureMotion();
	const f = fixture();
	const company = new CompanyController(f.api, profileA, userA.id);
	const auth = new AuthController(f.cloud);
	company.store.set({ team, staff: [staff], sessions: [{ ...session, staffAgentId: staff.id }], loading: false });
	company.conversation(session.sessionId, false).set({ loading: false });
	const view = new ConversationView(company, session.sessionId);
	const rail = document.createElement("aside");
	document.body.append(rail, view.el);
	const draw = () =>
		renderRail(rail, company, {
			profiles: [profileA],
			user: userA,
			auth,
			invitations: 0,
			route: { name: "company", profileId: profileA.profileId, section: "chat", id: session.sessionId },
			openSettings() {},
			openFeedback() {},
		});
	cleanup.push(() => {
		view.dispose();
		company.stop();
		auth.dispose();
	});
	return { company, view, rail, draw, mount, api: f.api, cloud: f.cloud };
}

describe("shared agent activity", () => {
	it("refreshes RPC activity into matching thread and sidebar figures, colours and hover text", async () => {
		const f = setup();
		vi.mocked(f.api.listStaffActivity).mockRestore();
		const rpc = vi.mocked(f.cloud.rpc);
		for (const phase of ["working", "writing", "working"] as const) {
			f.mount.mockClear();
			rpc.mockResolvedValueOnce([
				{
					run_id: working.runId,
					staff_agent_id: working.staffAgentId,
					source_kind: working.sourceKind,
					job_status: working.jobStatus,
					activity: working.activity,
					updated_at: working.updatedAt,
					phase,
				},
			]);
			await f.company.refreshActivity();
			await settle();
			f.draw();
			expect(rpc).toHaveBeenLastCalledWith("qorpera_list_staff_execution_activity", {
				p_environment_id: profileA.environmentId,
			});
			const indicator = f.view.el.querySelector<HTMLElement>(".thread-activity")!;
			const label = phase === "writing" ? "Writing" : "Working";
			const sentence = `${staff.displayName} is ${label.toLowerCase()}`;
			expect(indicator.getAttribute("aria-label")).toBe(sentence);
			expect(indicator.dataset.state).toBe(phase);
			expect(indicator.tabIndex).toBe(0);
			expect(indicator.hasAttribute("title")).toBe(false);
			const caption = indicator.querySelector<HTMLElement>(".status-caption")!;
			expect(caption.textContent).toBe(sentence);
			expect(caption.getAttribute("aria-hidden")).toBe("true");
			expect(caption.querySelector(".status-caption-name")?.textContent).toBe(staff.displayName);
			expect(caption.querySelectorAll(".status-wave-letter")).toHaveLength(sentence.replace(/\s/g, "").length);
			expect(f.rail.querySelector(".rail-row-copy small")?.textContent).toBe(label);
			expect(f.rail.querySelector(".rail-row")?.getAttribute("title")).toContain(label);
			expect(indicator.querySelector(".bubble, .typing")).toBeNull();
			const calls = f.mount.mock.calls.filter(([, , , , options]) => options?.identity === staff.id);
			expect(calls).toHaveLength(2);
			expect(calls[0]![1]).toBe(calls[1]![1]);
			expect(calls[0]![2]).toBe(calls[1]![2]);
			for (const call of calls) expect(call[4]?.activity).toBe(phase === "writing" ? "Thinking" : "Working");
		}
		rpc.mockResolvedValueOnce([]);
		await f.company.refreshActivity();
		await settle();
		f.draw();
		expect(rpc).toHaveBeenCalledTimes(4);
		expect(f.view.el.querySelector(".thread-activity")).toBeNull();
		expect(f.rail.querySelector(".rail-row-status")).toBeNull();
	});

	it("does not pretend a local upload is agent work or let writing override queued/attention states", async () => {
		const f = setup();
		f.company.conversation(session.sessionId).set({ sending: true });
		await settle();
		expect(f.view.el.querySelector(".thread-activity")).toBeNull();
		for (const [jobStatus, activity, expected] of [
			["queued", "waiting", "working"],
			["failed", "needs_attention", "failed"],
			["leased", "needs_attention", "decision"],
		] as const) {
			f.company.store.set({ activity: [{ ...working, jobStatus, activity, phase: "writing" }] });
			expect(f.company.agentState(staff.id)).toBe(expected);
		}
		await settle();
		expect(f.view.el.querySelector(".thread-activity")).toBeNull();
	});

	it("reads optional writing hints while keeping older or unknown hints on the working fallback", () => {
		const row = {
			run_id: id(90),
			staff_agent_id: staff.id,
			source_kind: "session_turn",
			job_status: "leased",
			activity: "working",
			updated_at: timestamp,
		};
		for (const phase of ["writing", "working"] as const)
			expect(parseStaffExecutionActivity([{ ...row, phase }])[0]?.phase).toBe(phase);
		for (const phase of [undefined, null, "future-phase", { text: "private" }])
			expect(parseStaffExecutionActivity([{ ...row, phase }])[0]?.phase).toBeUndefined();
	});
});
