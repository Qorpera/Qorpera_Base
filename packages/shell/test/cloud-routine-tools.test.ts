import { randomUUID } from "node:crypto";
import type { CloudCompanyPathControl } from "@qorpera/runtime/cloud-company-path-gateway";
import { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { CloudNativeToolBoundary } from "@qorpera/runtime/cloud-native-tool-boundary";
import { cloudRoutineTools } from "@qorpera/runtime/cloud-routine-tools";
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
	it.each([
		["another agent", { staffAgentId: randomUUID() }],
		["a sponsor", { sponsorBindingId: randomUUID() }],
		["a trigger id", { trigger: { kind: "every", minutes: 30, id: "mine" } }],
		["a cron", { trigger: { kind: "cron", expression: "* * * * *" } }],
		["a one-minute loop", { trigger: { kind: "every", minutes: 1 } }],
		["an unknown time zone", { trigger: { kind: "weekly", localTime: "08:00", timeZone: "Mars/Olympus" } }],
		["a path escape", { trigger: { kind: "file_change", path: "../secrets", timeZone: "UTC" } }],
		["equal quiet bounds", { quietHours: { start: "08:00", end: "08:00", timeZone: "UTC" } }],
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
