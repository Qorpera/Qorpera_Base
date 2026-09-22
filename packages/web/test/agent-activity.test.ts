// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthController } from "../src/app/auth.ts";
import { CompanyController } from "../src/app/company.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import { renderRail } from "../src/app/views/shell.ts";
import { parseStaffExecutionActivity } from "../src/cloud/parse.ts";
import type { HostedStaffExecutionActivity } from "../src/cloud/types.ts";
import { AGENT_LOOK, stateLine, statusCaption, syncCaption } from "../src/ui/agent-activity.ts";
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
			expect(indicator.tabIndex).toBe(0);
			expect(indicator.hasAttribute("title")).toBe(false);
			const caption = indicator.querySelector<HTMLElement>(".status-caption")!;
			expect(caption.textContent).toBe(sentence);
			expect(caption.getAttribute("aria-hidden")).toBe("true");
			expect(caption.querySelector(".status-caption-name")?.textContent).toBe(staff.displayName);
			expect(caption.querySelectorAll(".status-wave-letter")).toHaveLength(sentence.replace(/\s/g, "").length);
			expect(f.rail.querySelector(".rail-row-copy small")?.textContent).toBe(label);
			expect(f.rail.querySelectorAll(".rail-row-copy small .status-wave-letter")).toHaveLength(label.length);
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

	it("waves only a live state; Needs you and roles stay still", () => {
		expect(stateLine(AGENT_LOOK.decision, "Marketing Lead")).toBe("Needs you");
		expect(stateLine(AGENT_LOOK.idle, "Marketing Lead")).toBe("Marketing Lead");
		expect(stateLine(AGENT_LOOK.failed, "Marketing Lead")).toBe("Marketing Lead");
		for (const state of ["working", "writing"] as const) {
			const line = stateLine(AGENT_LOOK[state], "Marketing Lead") as HTMLElement;
			expect(line.textContent).toBe(AGENT_LOOK[state].line);
			expect(line.querySelectorAll(".status-wave-letter")).toHaveLength(7);
		}
	});

	it("keeps every wave on one clock: later letters are delayed by the elapsed phase", () => {
		vi.useFakeTimers();
		try {
			const delay = (el: Element) => Number.parseFloat((el as HTMLElement).style.getPropertyValue("--wave-delay"));
			const first = stateLine(AGENT_LOOK.working, "") as HTMLElement;
			vi.advanceTimersByTime(500);
			const second = stateLine(AGENT_LOOK.working, "") as HTMLElement;
			const a = delay(first.querySelector(".status-wave-letter")!);
			const b = delay(second.querySelector(".status-wave-letter")!);
			expect(((a - b - 500) % 1400) + 0).toBe(0);
			// Letters step by 37.5 ms along the sentence, spaces counted, across the caption's parts.
			const caption = statusCaption("Bo", " is writing");
			const letters = [...caption.querySelectorAll(".status-wave-letter")];
			expect(letters.map((el) => el.textContent).join("")).toBe("Boiswriting");
			expect(delay(letters[2]!) - delay(letters[0]!)).toBeCloseTo(3 * 37.5);
			// Showing the caption again rebuilds its letters from the clock.
			vi.advanceTimersByTime(200);
			syncCaption(caption);
			const rebuilt = [...caption.querySelectorAll(".status-wave-letter")];
			expect(rebuilt[0]).not.toBe(letters[0]);
			expect(caption.textContent).toBe("Bo is writing");
			expect(((delay(letters[0]!) - delay(rebuilt[0]!) - 200) % 1400) + 0).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps keyboard focus on the thread row through a state change", async () => {
		const f = setup();
		f.company.store.set({ activity: [working] });
		f.view.update();
		await settle();
		const row = f.view.el.querySelector<HTMLElement>(".thread-activity")!;
		row.focus();
		expect(document.activeElement).toBe(row);
		f.company.store.set({ activity: [{ ...working, phase: "writing" }] });
		f.view.update();
		await settle();
		const next = f.view.el.querySelector<HTMLElement>(".thread-activity")!;
		expect(next).not.toBe(row);
		expect(next.getAttribute("aria-label")).toBe(`${staff.displayName} is writing`);
		expect(document.activeElement).toBe(next);
	});
});
