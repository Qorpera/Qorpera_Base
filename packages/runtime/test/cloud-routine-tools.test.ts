import { randomUUID } from "node:crypto";
import type { CloudCompanyPathControl } from "@qorpera/runtime/cloud-company-path-gateway";
import { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { CloudNativeToolBoundary } from "@qorpera/runtime/cloud-native-tool-boundary";
import { cloudRoutineDecisionTool, cloudRoutineTools } from "@qorpera/runtime/cloud-routine-tools";
import { describe, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

async function fixture(result?: (request: Record<string, unknown>, runId: string) => unknown) {
	const { binding, authority } = nativeToolAuthorityFixture();
	const run = await CloudNativeToolRun.open(
		binding,
		{ describeToolAuthority: async () => authority },
		new AbortController().signal,
	);
	const call = vi.fn<CloudCompanyPathControl["call"]>(async (_method, args) => {
		const request = (args as { p_request: Record<string, unknown> }).p_request;
		if (result) return result(request, binding.runId);
		return request.action === "list"
			? { schema: "qorpera.agent-routines/v1", runId: binding.runId, routines: [] }
			: {
					schema: "qorpera.agent-routine-receipt/v1",
					runId: binding.runId,
					receiptId: randomUUID(),
					action: request.action,
					routine: { routineKey: request.routineKey, status: "active" },
				};
	});
	const boundary = new CloudNativeToolBoundary({
		companyId: run.identity.companyId,
		runId: run.identity.runId,
		identity: run.identity,
		tools: cloudRoutineTools(binding, run.identity, { call }),
		assertActive: (signal) => run.assertActive(signal),
		signal: run.signal,
	});
	return { binding, run, call, boundary };
}
const weekly = {
	action: "upsert",
	operationKey: "queue-1",
	routineKey: "morning-queue",
	title: "Morning queue check",
	intent: "Read support/queue.json. Tell the founder only when more than ten tickets wait.",
	trigger: { kind: "weekly", localTime: "08:00", timeZone: "Europe/Copenhagen" },
};

describe("agent routine tool", () => {
	it("compiles a business-day default, binds authority in the host and never retries the RPC", async () => {
		const f = await fixture();
		try {
			const first = await f.boundary.invoke("routine_1", "qorpera", "manage_routine", weekly);
			expect(first.success, JSON.stringify(first)).toBe(true);
			expect(await f.boundary.invoke("routine_1", "qorpera", "manage_routine", weekly)).toEqual(first);
			expect(f.call).toHaveBeenCalledTimes(1);
			expect(f.call.mock.calls[0].slice(0, 2)).toEqual([
				"qorpera_manage_agent_routine",
				{
					p_binding: f.binding,
					p_request: {
						...weekly,
						trigger: {
							kind: "schedule",
							intervalMinutes: 1440,
							weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
							localTime: "08:00",
							timeZone: "Europe/Copenhagen",
							replyPolicy: "optional",
						},
					},
				},
			]);
			expect(JSON.parse(first.contentItems[0].text).trust).toBe("untrusted_data");
			expect(JSON.stringify(first)).not.toContain(f.binding.credentialCapsuleId);
		} finally {
			f.run.close();
		}
	});
	it("carries the effort the agent chose and leaves an omitted one to the kernel", async () => {
		const f = await fixture();
		try {
			const high = await f.boundary.invoke("routine_e1", "qorpera", "manage_routine", { ...weekly, effort: "high" });
			expect(high.success, JSON.stringify(high)).toBe(true);
			const plain = await f.boundary.invoke("routine_e2", "qorpera", "manage_routine", {
				...weekly,
				operationKey: "queue-2",
			});
			expect(plain.success, JSON.stringify(plain)).toBe(true);
			const requests = f.call.mock.calls.map(
				(call) => (call[1] as { p_request: { effort?: string } }).p_request.effort,
			);
			// The kernel starts a new routine at medium and keeps a saved one's effort when none is sent.
			expect(requests).toEqual(["high", undefined]);
			const bad = await f.boundary.invoke("routine_e3", "qorpera", "manage_routine", { ...weekly, effort: "max" });
			expect(bad.success).toBe(false);
			expect(f.call).toHaveBeenCalledTimes(2);
		} finally {
			f.run.close();
		}
	});
	it("compiles a delayed first run for weekly work", async () => {
		const f = await fixture();
		try {
			const result = await f.boundary.invoke("routine_w", "qorpera", "manage_routine", {
				...weekly,
				trigger: { ...weekly.trigger, weekdays: ["monday"], firstRunAt: "2026-09-28T09:00:00+02:00" },
			});
			expect(result.success, JSON.stringify(result)).toBe(true);
			expect((f.call.mock.calls[0]?.[1] as { p_request: { trigger: unknown } }).p_request.trigger).toEqual({
				kind: "schedule",
				intervalMinutes: 1440,
				startAt: "2026-09-28T07:00:00.000Z",
				weekdays: ["monday"],
				localTime: "08:00",
				timeZone: "Europe/Copenhagen",
				replyPolicy: "optional",
			});
		} finally {
			f.run.close();
		}
	});
	it("compiles interval, file-change, expiry, finite and quiet forms", async () => {
		const f = await fixture();
		try {
			await f.boundary.invoke("a", "qorpera", "manage_routine", {
				...weekly,
				operationKey: "a",
				trigger: { kind: "every", minutes: 30, firstRunAt: "2026-09-21T06:00:00+02:00", report: "silent" },
				expiresAt: "2026-10-01T00:00:00Z",
				maxOccurrences: 10,
				quietHours: { start: "22:00", end: "07:00", timeZone: "Europe/Copenhagen" },
			});
			await f.boundary.invoke("b", "qorpera", "manage_routine", {
				...weekly,
				operationKey: "b",
				trigger: { kind: "file_change", path: "metrics/churn.json", timeZone: "UTC", report: "required" },
			});
			const [every, file] = f.call.mock.calls.map((call) => (call[1] as { p_request: any }).p_request);
			expect(every.trigger).toEqual({
				kind: "schedule",
				intervalMinutes: 30,
				startAt: "2026-09-21T04:00:00.000Z",
				replyPolicy: "silent",
			});
			expect(every).toMatchObject({
				expiresAt: "2026-10-01T00:00:00.000Z",
				maxOccurrences: 10,
				quietHours: { start: "22:00", end: "07:00", timeZone: "Europe/Copenhagen" },
			});
			expect(file.trigger).toEqual({
				kind: "listener",
				source: "company-file",
				path: "metrics/churn.json",
				match: "exact",
				timeZone: "UTC",
				replyPolicy: "required",
			});
		} finally {
			f.run.close();
		}
	});
	it("compiles an event listener on a hook, with and without a type filter", async () => {
		const f = await fixture();
		const hookId = "3B2C9E4A-1D7F-4E60-9A2B-5C8D0E1F2A3B";
		try {
			await f.boundary.invoke("e1", "qorpera", "manage_routine", {
				...weekly,
				operationKey: "e1",
				trigger: { kind: "event", hookId, timeZone: "Europe/Copenhagen", report: "silent" },
			});
			await f.boundary.invoke("e2", "qorpera", "manage_routine", {
				...weekly,
				operationKey: "e2",
				trigger: { kind: "event", hookId, only: ["invoice.paid", "charge.refunded"], timeZone: "UTC" },
			});
			const [all, filtered] = f.call.mock.calls.map((call) => (call[1] as { p_request: any }).p_request);
			expect(all.trigger).toEqual({
				kind: "listener",
				source: "event",
				hookId: hookId.toLowerCase(),
				timeZone: "Europe/Copenhagen",
				replyPolicy: "silent",
			});
			expect(filtered.trigger).toEqual({
				kind: "listener",
				source: "event",
				hookId: hookId.toLowerCase(),
				only: ["invoice.paid", "charge.refunded"],
				timeZone: "UTC",
				replyPolicy: "optional",
			});
		} finally {
			f.run.close();
		}
	});
	it("compiles a dynamic routine to one next run and concludes with a reason", async () => {
		const f = await fixture();
		try {
			const timed = await f.boundary.invoke("d1", "qorpera", "manage_routine", {
				...weekly,
				operationKey: "d1",
				trigger: {
					kind: "dynamic",
					firstRunAt: "2026-09-26T09:00:00+02:00",
					timeZone: "Europe/Copenhagen",
					report: "silent",
				},
			});
			expect(timed.success, JSON.stringify(timed)).toBe(true);
			const now = await f.boundary.invoke("d2", "qorpera", "manage_routine", {
				...weekly,
				operationKey: "d2",
				trigger: { kind: "dynamic", timeZone: "Europe/Copenhagen" },
			});
			expect(now.success, JSON.stringify(now)).toBe(true);
			const [first, second] = f.call.mock.calls.map((call) => (call[1] as { p_request: any }).p_request);
			expect(first.trigger).toEqual({
				kind: "once",
				at: "2026-09-26T07:00:00.000Z",
				timeZone: "Europe/Copenhagen",
				replyPolicy: "silent",
			});
			// Without firstRunAt the kernel stamps the save instant, so a retry is the same request.
			expect(second.trigger).toEqual({ kind: "once", timeZone: "Europe/Copenhagen", replyPolicy: "optional" });
			const limited = await f.boundary.invoke("d3", "qorpera", "manage_routine", {
				...weekly,
				operationKey: "d3",
				maxOccurrences: 3,
				trigger: { kind: "dynamic", timeZone: "UTC" },
			});
			expect(limited.success).toBe(false);
			expect(limited.contentItems[0].text).toContain("a dynamic routine takes no maxOccurrences");
			const done = await f.boundary.invoke("d4", "qorpera", "manage_routine", {
				action: "conclude",
				operationKey: "d4",
				routineKey: "morning-queue",
				summary: "The queue has stayed empty for a month.",
			});
			expect(done.success, JSON.stringify(done)).toBe(true);
			expect((f.call.mock.calls[2]?.[1] as { p_request: unknown }).p_request).toEqual({
				action: "conclude",
				operationKey: "d4",
				routineKey: "morning-queue",
				summary: "The queue has stayed empty for a month.",
			});
			expect(f.call).toHaveBeenCalledTimes(3);
		} finally {
			f.run.close();
		}
	});
	it.each([
		["another agent", { staffAgentId: randomUUID() }],
		["a sponsor", { sponsorBindingId: randomUUID() }],
		["a trigger id", { trigger: { kind: "every", minutes: 30, id: "mine" } }],
		["a cron", { trigger: { kind: "cron", expression: "* * * * *" } }],
		["a one-minute loop", { trigger: { kind: "every", minutes: 1 } }],
		["an unknown time zone", { trigger: { kind: "weekly", localTime: "08:00", timeZone: "Mars/Olympus" } }],
		["a path escape", { trigger: { kind: "file_change", path: "../secrets", timeZone: "UTC" } }],
		["an event listener without a hook id", { trigger: { kind: "event", hookId: "forms", timeZone: "UTC" } }],
		[
			"an event listener with an empty filter",
			{ trigger: { kind: "event", hookId: randomUUID(), only: [], timeZone: "UTC" } },
		],
		[
			"an event listener with a spaced type",
			{ trigger: { kind: "event", hookId: randomUUID(), only: ["invoice paid"], timeZone: "UTC" } },
		],
		[
			"an event listener with a repeated type",
			{ trigger: { kind: "event", hookId: randomUUID(), only: ["a", "a"], timeZone: "UTC" } },
		],
		[
			"an event listener with a path",
			{ trigger: { kind: "event", hookId: randomUUID(), path: "x", timeZone: "UTC" } },
		],
		["equal quiet bounds", { quietHours: { start: "08:00", end: "08:00", timeZone: "UTC" } }],
		["a dynamic routine without a time zone", { trigger: { kind: "dynamic" } }],
		["a dynamic routine with a cadence", { trigger: { kind: "dynamic", timeZone: "UTC", minutes: 30 } }],
		["an unreadable first run", { trigger: { kind: "dynamic", timeZone: "UTC", firstRunAt: "tomorrow" } }],
		[
			"a first run without an offset",
			{ trigger: { kind: "dynamic", timeZone: "UTC", firstRunAt: "2026-10-01T09:00" } },
		],
		// Without an offset the host would read these in its own zone, not the member's.
		[
			"an every first run without an offset",
			{ trigger: { kind: "every", minutes: 60, firstRunAt: "2026-10-01T09:00:00" } },
		],
		[
			"a weekly first run without an offset",
			{ trigger: { kind: "weekly", localTime: "09:00", timeZone: "UTC", firstRunAt: "2026-10-01T09:00:00" } },
		],
		["an expiry without an offset", { expiresAt: "2026-10-03T18:00" }],
		// Its one next run would never happen.
		[
			"a dynamic first run at its end",
			{
				trigger: { kind: "dynamic", timeZone: "UTC", firstRunAt: "2026-10-02T11:00:00+02:00" },
				expiresAt: "2026-10-02T09:00:00Z",
			},
		],
	])("rejects %s before dispatch", async (_label, extra) => {
		const f = await fixture();
		try {
			const response = await f.boundary.invoke("bad", "qorpera", "manage_routine", { ...weekly, ...extra });
			expect(response.success).toBe(false);
			expect(f.call).not.toHaveBeenCalled();
		} finally {
			f.run.close();
		}
	});
	it("lists, pauses and refuses a receipt for another routine or run", async () => {
		const f = await fixture();
		const forged = await fixture((request) => ({
			schema: "qorpera.agent-routine-receipt/v1",
			runId: randomUUID(),
			receiptId: randomUUID(),
			action: request.action,
			routine: { routineKey: request.routineKey },
		}));
		try {
			expect((await f.boundary.invoke("l", "qorpera", "manage_routine", { action: "list" })).success).toBe(true);
			expect(
				(
					await f.boundary.invoke("p", "qorpera", "manage_routine", {
						action: "pause",
						operationKey: "p",
						routineKey: "morning-queue",
					})
				).success,
			).toBe(true);
			expect(
				(await f.boundary.invoke("x", "qorpera", "manage_routine", { action: "list", routineKey: "x" })).success,
			).toBe(false);
			expect((await forged.boundary.invoke("f", "qorpera", "manage_routine", weekly)).success).toBe(false);
		} finally {
			f.run.close();
			forged.run.close();
		}
	});
});

describe("a dynamic routine's own run", () => {
	it("points the run at decide_routine instead of saving, pausing or removing its own routine", async () => {
		const { binding, authority } = nativeToolAuthorityFixture();
		const run = await CloudNativeToolRun.open(
			binding,
			{ describeToolAuthority: async () => authority },
			new AbortController().signal,
		);
		let owed = true;
		const settled = vi.fn(() => {
			owed = false;
		});
		const call = vi.fn<CloudCompanyPathControl["call"]>(async (_method, args) => {
			const request = (args as { p_request: Record<string, unknown> }).p_request;
			return {
				schema: "qorpera.agent-routine-receipt/v1",
				runId: binding.runId,
				receiptId: randomUUID(),
				action: request.action,
				routine: { routineKey: request.routineKey, status: "active" },
			};
		});
		const boundary = new CloudNativeToolBoundary({
			companyId: run.identity.companyId,
			runId: run.identity.runId,
			identity: run.identity,
			tools: cloudRoutineTools(
				binding,
				run.identity,
				{ call },
				{ routineKey: "invoice-watch", decisionOwed: () => owed, settled },
			),
			assertActive: (signal) => run.assertActive(signal),
			signal: run.signal,
		});
		try {
			for (const action of ["upsert", "pause", "resume", "remove"]) {
				const own = await boundary.invoke(`own-${action}`, "qorpera", "manage_routine", {
					...(action === "upsert" ? weekly : { action, operationKey: `own-${action}` }),
					...(action === "upsert" ? { operationKey: "own-upsert" } : {}),
					routineKey: "invoice-watch",
				});
				expect(own.success).toBe(false);
				expect(own.contentItems[0].text).toContain(
					action === "pause" || action === "remove"
						? "conclude it (manage_routine conclude, or decide_routine conclude) instead of pausing or removing it"
						: "this is the routine you are running: use decide_routine",
				);
			}
			// Other routines, and concluding its own, stay open; after the decision so does the rest.
			expect((await boundary.invoke("other", "qorpera", "manage_routine", weekly)).success).toBe(true);
			const done = await boundary.invoke("own-done", "qorpera", "manage_routine", {
				action: "conclude",
				operationKey: "own-done",
				routineKey: "invoice-watch",
				summary: "Done.",
			});
			expect(done.success).toBe(true);
			// Concluding its own routine settles the decision the run owed.
			expect(settled).toHaveBeenCalledTimes(1);
			expect(owed).toBe(false);
			// After the decision a save is fine, but pausing or removing it would still revoke this run.
			expect(
				(
					await boundary.invoke("later", "qorpera", "manage_routine", {
						...weekly,
						operationKey: "later",
						routineKey: "invoice-watch",
					})
				).success,
			).toBe(true);
			const laterPause = await boundary.invoke("later-pause", "qorpera", "manage_routine", {
				action: "pause",
				operationKey: "later-pause",
				routineKey: "invoice-watch",
			});
			expect(laterPause.success).toBe(false);
			expect(call).toHaveBeenCalledTimes(3);
		} finally {
			run.close();
		}
	});
});

describe("dynamic routine decision tool", () => {
	async function decision(result: (request: Record<string, unknown>, runId: string) => unknown) {
		const { binding, authority } = nativeToolAuthorityFixture();
		const run = await CloudNativeToolRun.open(
			binding,
			{ describeToolAuthority: async () => authority },
			new AbortController().signal,
		);
		let owed = true;
		const decided = vi.fn(() => {
			owed = false;
		});
		const call = vi.fn<CloudCompanyPathControl["call"]>(async (_method, args) =>
			result((args as { p_request: Record<string, unknown> }).p_request, binding.runId),
		);
		const boundary = new CloudNativeToolBoundary({
			companyId: run.identity.companyId,
			runId: run.identity.runId,
			identity: run.identity,
			tools: [cloudRoutineDecisionTool(binding, run.identity, { call }, { decisionOwed: () => owed, decided })],
			assertActive: (signal) => run.assertActive(signal),
			signal: run.signal,
		});
		return { binding, run, call, boundary, decided };
	}
	const receipt = (request: Record<string, unknown>, runId: string) => ({
		schema: "qorpera.agent-routine-receipt/v1",
		runId,
		receiptId: randomUUID(),
		action: request.action === "next" ? "upsert" : "conclude",
		routine: { routineKey: "invoice-watch", status: request.action === "next" ? "active" : "concluded" },
	});
	it("sets the next run with changed instructions, and records that the run decided", async () => {
		const f = await decision(receipt);
		try {
			const next = await f.boundary.invoke("n1", "qorpera", "decide_routine", {
				action: "next",
				operationKey: "next-1",
				at: "2026-09-26T09:00:00+02:00",
				intent: "Invoice 42 is still open. Remind finance tomorrow if it still is.",
			});
			expect(next.success, JSON.stringify(next)).toBe(true);
			expect(f.call.mock.calls[0]?.slice(0, 2)).toEqual([
				"qorpera_decide_agent_routine",
				{
					p_binding: f.binding,
					p_request: {
						action: "next",
						operationKey: "next-1",
						at: "2026-09-26T07:00:00.000Z",
						intent: "Invoice 42 is still open. Remind finance tomorrow if it still is.",
					},
				},
			]);
			expect(f.decided).toHaveBeenCalledTimes(1);
			expect(next.completesTurn).toBeUndefined();
			// A second decision would change nothing (the kernel answers settled), so the
			// run hears where a further change goes instead.
			const again = await f.boundary.invoke("n2", "qorpera", "decide_routine", {
				action: "next",
				operationKey: "next-2",
				at: "2026-09-25T20:00:00+02:00",
			});
			expect(again.success).toBe(false);
			expect(again.contentItems[0].text).toContain("INVALID_ARGUMENTS: nothing is owed any more");
			expect(f.call).toHaveBeenCalledTimes(1);
		} finally {
			f.run.close();
		}
	});
	it("concludes, and treats a routine that already moved on as decided", async () => {
		const settled = await decision((_request, runId) => ({
			schema: "qorpera.agent-routine-decision/v1",
			runId,
			state: "settled",
			routine: { routineKey: "invoice-watch", status: "paused" },
		}));
		const f = await decision(receipt);
		try {
			const done = await f.boundary.invoke("c1", "qorpera", "decide_routine", {
				action: "conclude",
				operationKey: "done-1",
				summary: "Invoice 42 was paid.",
			});
			expect(done.success, JSON.stringify(done)).toBe(true);
			expect((f.call.mock.calls[0]?.[1] as { p_request: unknown }).p_request).toEqual({
				action: "conclude",
				operationKey: "done-1",
				summary: "Invoice 42 was paid.",
			});
			expect(f.decided).toHaveBeenCalledTimes(1);
			const moved = await settled.boundary.invoke("s1", "qorpera", "decide_routine", {
				action: "conclude",
				operationKey: "done-2",
				summary: "Done.",
			});
			expect(moved.success).toBe(true);
			expect(JSON.parse(moved.contentItems[0].text).content.text).toContain('"state":"settled"');
			expect(settled.decided).toHaveBeenCalledTimes(1);
		} finally {
			f.run.close();
			settled.run.close();
		}
	});
	it("shows a refusal's reason without counting it as the decision", async () => {
		const f = await decision((_request, runId) => ({
			schema: "qorpera.agent-routine-decision/v1",
			runId,
			state: "refused",
			reason: "The routine ends at 2026-09-27T00:00:00Z. Choose an earlier time or conclude it.",
		}));
		try {
			const late = await f.boundary.invoke("r1", "qorpera", "decide_routine", {
				action: "next",
				operationKey: "late",
				at: "2026-10-01T09:00:00Z",
			});
			expect(late.success).toBe(true);
			expect(late.contentItems[0].text).toContain("Choose an earlier time or conclude it.");
			expect(f.decided).not.toHaveBeenCalled();
		} finally {
			f.run.close();
		}
	});
	it.each([
		["no time", { action: "next", operationKey: "k" }, "at must be"],
		["an unreadable time", { action: "next", operationKey: "k", at: "soon" }, "at must be"],
		// Without an offset the host would read it in its own zone, not the member's.
		["a time without an offset", { action: "next", operationKey: "k", at: "2026-10-01T09:00:00" }, "at must be"],
		["no summary", { action: "conclude", operationKey: "k" }, ""],
		["a routine key", { action: "conclude", operationKey: "k", summary: "x", routineKey: "other" }, ""],
		["another action", { action: "remove", operationKey: "k" }, "action must be next or conclude"],
	])("refuses %s before dispatch", async (_label, value, reason) => {
		const f = await decision(receipt);
		try {
			const response = await f.boundary.invoke("bad", "qorpera", "decide_routine", value);
			expect(response.success).toBe(false);
			expect(response.contentItems[0].text).toContain(`INVALID_ARGUMENTS${reason ? `: ${reason}` : ""}`);
			expect(f.call).not.toHaveBeenCalled();
		} finally {
			f.run.close();
		}
	});
	it("refuses a receipt for another run", async () => {
		const f = await decision((request) => receipt(request, randomUUID()));
		try {
			const forged = await f.boundary.invoke("f", "qorpera", "decide_routine", {
				action: "conclude",
				operationKey: "k",
				summary: "Done.",
			});
			expect(forged.success).toBe(false);
			expect(f.decided).not.toHaveBeenCalled();
		} finally {
			f.run.close();
		}
	});
});
