import { randomUUID } from "node:crypto";
import type { CloudFolderRoutineDecision } from "@qorpera/runtime/cloud-folder-routine-decision";
import type { CloudFolderRoutines } from "@qorpera/runtime/cloud-folder-routines";
import { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import {
	CloudNativeToolBoundary,
	CloudToolArgumentRefusal,
	CloudToolRefusal,
} from "@qorpera/runtime/cloud-native-tool-boundary";
import { cloudRoutineDecisionTool, cloudRoutineTools } from "@qorpera/runtime/cloud-routine-tools";
import { fitsOneResult } from "@qorpera/runtime/cloud-worker-tools";
import { describe, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

/** The tool over a fake of the routine files writer that answers every call (cloud-folder-routines.test.ts covers what
 * the writer saves). */
async function fixture(ownDynamicRoutine?: Parameters<typeof cloudRoutineTools>[2]) {
	const { binding, authority } = nativeToolAuthorityFixture();
	const run = await CloudNativeToolRun.open(
		binding,
		{ describeToolAuthority: async () => authority },
		new AbortController().signal,
	);
	const writer = {
		path: vi.fn<CloudFolderRoutines["path"]>((routineKey) => `QorperaOS/agents/nora/routines/${routineKey}.md`),
		check: vi.fn<CloudFolderRoutines["check"]>(),
		list: vi.fn<CloudFolderRoutines["list"]>(async () => ({ kind: "text", value: '{"routines":[]}' })),
		change: vi.fn<CloudFolderRoutines["change"]>(async (request) => ({
			content: { kind: "text", value: '{"outcome":"saved"}' },
			concluded: request.action === "conclude",
		})),
	};
	const boundary = new CloudNativeToolBoundary({
		companyId: run.identity.companyId,
		runId: run.identity.runId,
		identity: run.identity,
		tools: cloudRoutineTools(binding, run.identity, ownDynamicRoutine, writer as unknown as CloudFolderRoutines),
		assertActive: (signal) => run.assertActive(signal),
		signal: run.signal,
	});
	// What the writer was asked to save, in order.
	const saved = () => writer.change.mock.calls.map(([request]) => request as unknown as Record<string, unknown>);
	return { binding, run, writer, boundary, saved };
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
	it("hands the writer a business-day default, binds authority in the host and never retries the save", async () => {
		const f = await fixture();
		try {
			const first = await f.boundary.invoke("routine_1", "qorpera", "manage_routine", weekly);
			expect(first.success, JSON.stringify(first)).toBe(true);
			expect(await f.boundary.invoke("routine_1", "qorpera", "manage_routine", weekly)).toEqual(first);
			expect(f.writer.change).toHaveBeenCalledTimes(1);
			const compiled = {
				...weekly,
				trigger: {
					kind: "schedule",
					intervalMinutes: 1440,
					weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
					localTime: "08:00",
					timeZone: "Europe/Copenhagen",
					replyPolicy: "optional",
				},
			};
			expect(f.writer.change).toHaveBeenCalledWith(compiled, expect.objectContaining({ callId: "routine_1" }));
			// The file's own checks see the same request, before the automatic review.
			expect(f.writer.check).toHaveBeenCalledWith(compiled);
			expect(JSON.parse(first.contentItems[0].text).trust).toBe("untrusted_data");
			expect(JSON.stringify(first)).not.toContain(f.binding.credentialCapsuleId);
		} finally {
			f.run.close();
		}
	});
	it("carries the effort the agent chose and leaves an omitted one to the writer", async () => {
		const f = await fixture();
		try {
			const high = await f.boundary.invoke("routine_e1", "qorpera", "manage_routine", { ...weekly, effort: "high" });
			expect(high.success, JSON.stringify(high)).toBe(true);
			const plain = await f.boundary.invoke("routine_e2", "qorpera", "manage_routine", {
				...weekly,
				operationKey: "queue-2",
			});
			expect(plain.success, JSON.stringify(plain)).toBe(true);
			// The writer starts a new routine at medium and keeps a saved one's effort when none is sent.
			expect(f.saved().map((request) => request.effort)).toEqual(["high", undefined]);
			const bad = await f.boundary.invoke("routine_e3", "qorpera", "manage_routine", { ...weekly, effort: "max" });
			expect(bad.success).toBe(false);
			expect(f.writer.change).toHaveBeenCalledTimes(2);
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
			expect(f.saved()[0]?.trigger).toEqual({
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
			const [every, file] = f.saved();
			expect(every?.trigger).toEqual({
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
			expect(file?.trigger).toEqual({
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
	// Run a2d48302 (16 Oct 2026): inbox/l23/ was refused as INVALID_ARGUMENTS with no reason, before any review.
	it("drops a slash at the end of a watched path, as the routine file does", async () => {
		const f = await fixture();
		try {
			for (const [operationKey, path] of [
				["s1", "orders/incoming/"],
				["s2", "inbox/l23//"],
			] as const) {
				const result = await f.boundary.invoke(operationKey, "qorpera", "manage_routine", {
					...weekly,
					operationKey,
					trigger: { kind: "file_change", path, match: "subtree", timeZone: "UTC" },
				});
				expect(result.success, JSON.stringify(result)).toBe(true);
			}
			expect(f.saved().map((request) => (request.trigger as { path: string }).path)).toEqual([
				"orders/incoming",
				"inbox/l23",
			]);
		} finally {
			f.run.close();
		}
	});
	it.each(["../secrets", "/orders/incoming", "orders//incoming", "./orders", "orders/../secrets", "/"])(
		"refuses the watched path %s with the reason, before the writer sees it",
		async (path) => {
			const f = await fixture();
			try {
				const response = await f.boundary.invoke("p", "qorpera", "manage_routine", {
					...weekly,
					trigger: { kind: "file_change", path, timeZone: "UTC" },
				});
				expect(response.success).toBe(false);
				expect(response.contentItems[0].text).toContain(
					"INVALID_ARGUMENTS: path is a folder or file path inside the company, like sales/leads",
				);
				expect(f.writer.check).not.toHaveBeenCalled();
				expect(f.writer.change).not.toHaveBeenCalled();
			} finally {
				f.run.close();
			}
		},
	);
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
			const [all, filtered] = f.saved();
			expect(all?.trigger).toEqual({
				kind: "listener",
				source: "event",
				hookId: hookId.toLowerCase(),
				timeZone: "Europe/Copenhagen",
				replyPolicy: "silent",
			});
			expect(filtered?.trigger).toEqual({
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
			const [first, second] = f.saved();
			expect(first?.trigger).toEqual({
				kind: "once",
				at: "2026-09-26T07:00:00.000Z",
				timeZone: "Europe/Copenhagen",
				replyPolicy: "silent",
			});
			// Without firstRunAt the writer takes the save instant, so a retry is the same request.
			expect(second?.trigger).toEqual({ kind: "once", timeZone: "Europe/Copenhagen", replyPolicy: "optional" });
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
			expect(f.saved()[2]).toEqual({
				action: "conclude",
				operationKey: "d4",
				routineKey: "morning-queue",
				summary: "The queue has stayed empty for a month.",
			});
			expect(f.writer.change).toHaveBeenCalledTimes(3);
		} finally {
			f.run.close();
		}
	});
	// What the model is told about a bad trigger: the argument's name and a good value ("" is no reason).
	const because = {
		kind: 'trigger is an object whose kind is dynamic, when_done, every, weekly, file_change or event, like {"kind":"dynamic","timeZone":"Europe/Copenhagen"}',
		everyKeys:
			'a trigger of kind every takes minutes, and optionally firstRunAt and report, nothing else, like {"kind":"every","minutes":60}',
		dynamicKeys:
			'a trigger of kind dynamic takes timeZone, and optionally firstRunAt and report, nothing else, like {"kind":"dynamic","timeZone":"Europe/Copenhagen"}',
		weeklyKeys:
			'a trigger of kind weekly takes localTime and timeZone, and optionally weekdays, firstRunAt and report, nothing else, like {"kind":"weekly","localTime":"08:00","timeZone":"Europe/Copenhagen"}',
		fileKeys:
			'a trigger of kind file_change takes path and timeZone, and optionally match and report, nothing else, like {"kind":"file_change","path":"sales/leads","timeZone":"Europe/Copenhagen"}',
		eventKeys:
			'a trigger of kind event takes hookId and timeZone, and optionally only and report, nothing else, like {"kind":"event","hookId":"<an id from list_hooks>","timeZone":"Europe/Copenhagen"}',
		minutes: "minutes is a whole number from 5 to 10080 (one week), like 60",
		weekdays: 'weekdays is 1 to 7 different days, sunday to saturday in lowercase, like ["monday", "thursday"]',
		localTime: "localTime is a time of day as HH:MM on a 24-hour clock, like 08:00",
		timeZone: "timeZone is an IANA time zone, like Europe/Copenhagen",
		report: "report is optional, required or silent",
		match: "match is exact (the path itself) or subtree (anything under it)",
		path: "path is a folder or file path inside the company, like sales/leads",
		hook: "hookId is the id of one of the company's hooks or mailboxes, a UUID copied from list_hooks",
		only: 'only is 1 to 20 different event types, each up to 128 ASCII letters, digits or punctuation marks without spaces, like ["invoice.paid"]',
		firstRunAt: "firstRunAt must be an ISO 8601 date and time with its offset",
	};
	it.each([
		["another agent", { staffAgentId: randomUUID() }, ""],
		["a sponsor", { sponsorBindingId: randomUUID() }, ""],
		["a trigger id", { trigger: { kind: "every", minutes: 30, id: "mine" } }, because.everyKeys],
		["a cron", { trigger: { kind: "cron", expression: "* * * * *" } }, because.kind],
		["a trigger in words", { trigger: "every morning at eight" }, because.kind],
		["a one-minute loop", { trigger: { kind: "every", minutes: 1 } }, because.minutes],
		["a loop over a week", { trigger: { kind: "every", minutes: 10_081 } }, because.minutes],
		["a fractional interval", { trigger: { kind: "every", minutes: 7.5 } }, because.minutes],
		["a weekly routine without a time", { trigger: { kind: "weekly", timeZone: "UTC" } }, because.weeklyKeys],
		["a capitalised weekday", { trigger: { ...weekly.trigger, weekdays: ["Monday"] } }, because.weekdays],
		["no weekdays", { trigger: { ...weekly.trigger, weekdays: [] } }, because.weekdays],
		["a repeated weekday", { trigger: { ...weekly.trigger, weekdays: ["monday", "monday"] } }, because.weekdays],
		["a 12-hour time", { trigger: { ...weekly.trigger, localTime: "8:00 am" } }, because.localTime],
		["an unknown time zone", { trigger: { ...weekly.trigger, timeZone: "Mars/Olympus" } }, because.timeZone],
		["an automatic time zone", { trigger: { kind: "dynamic", timeZone: "auto" } }, because.timeZone],
		["an unknown report", { trigger: { kind: "dynamic", timeZone: "UTC", report: "loud" } }, because.report],
		["a path escape", { trigger: { kind: "file_change", path: "../secrets", timeZone: "UTC" } }, because.path],
		[
			"an unknown path match",
			{ trigger: { kind: "file_change", path: "sales/leads", match: "prefix", timeZone: "UTC" } },
			because.match,
		],
		[
			"a file watch with a cadence",
			{ trigger: { kind: "file_change", path: "sales/leads", timeZone: "UTC", minutes: 30 } },
			because.fileKeys,
		],
		[
			"an event listener without a hook id",
			{ trigger: { kind: "event", hookId: "forms", timeZone: "UTC" } },
			because.hook,
		],
		[
			"an event listener with an empty filter",
			{ trigger: { kind: "event", hookId: randomUUID(), only: [], timeZone: "UTC" } },
			because.only,
		],
		[
			"an event listener with a spaced type",
			{ trigger: { kind: "event", hookId: randomUUID(), only: ["invoice paid"], timeZone: "UTC" } },
			because.only,
		],
		[
			"an event listener with a repeated type",
			{ trigger: { kind: "event", hookId: randomUUID(), only: ["a", "a"], timeZone: "UTC" } },
			because.only,
		],
		[
			"an event listener with a path",
			{ trigger: { kind: "event", hookId: randomUUID(), path: "x", timeZone: "UTC" } },
			because.eventKeys,
		],
		[
			"an event listener with 21 types",
			{
				trigger: {
					kind: "event",
					hookId: randomUUID(),
					only: Array.from({ length: 21 }, (_, index) => `type.${index}`),
					timeZone: "UTC",
				},
			},
			because.only,
		],
		[
			"equal quiet bounds",
			{ quietHours: { start: "08:00", end: "08:00", timeZone: "UTC" } },
			"quietHours.start and quietHours.end differ, like 22:00 and 07:00",
		],
		[
			"a quiet start past midnight",
			{ quietHours: { start: "24:00", end: "07:00", timeZone: "UTC" } },
			"quietHours.start is a time of day as HH:MM on a 24-hour clock, like 08:00",
		],
		[
			"an unknown quiet time zone",
			{ quietHours: { start: "22:00", end: "07:00", timeZone: "Mars/Olympus" } },
			"quietHours.timeZone is an IANA time zone, like Europe/Copenhagen",
		],
		["a dynamic routine without a time zone", { trigger: { kind: "dynamic" } }, because.dynamicKeys],
		[
			"a dynamic routine with a cadence",
			{ trigger: { kind: "dynamic", timeZone: "UTC", minutes: 30 } },
			because.dynamicKeys,
		],
		[
			"an unreadable first run",
			{ trigger: { kind: "dynamic", timeZone: "UTC", firstRunAt: "tomorrow" } },
			because.firstRunAt,
		],
		[
			"a first run without an offset",
			{ trigger: { kind: "dynamic", timeZone: "UTC", firstRunAt: "2026-10-01T09:00" } },
			because.firstRunAt,
		],
		// Without an offset the host would read these in its own zone, not the member's.
		[
			"an every first run without an offset",
			{ trigger: { kind: "every", minutes: 60, firstRunAt: "2026-10-01T09:00:00" } },
			because.firstRunAt,
		],
		[
			"a weekly first run without an offset",
			{ trigger: { kind: "weekly", localTime: "09:00", timeZone: "UTC", firstRunAt: "2026-10-01T09:00:00" } },
			because.firstRunAt,
		],
		[
			"an expiry without an offset",
			{ expiresAt: "2026-10-03T18:00" },
			"expiresAt must be an ISO 8601 date and time with its offset",
		],
		// Its one next run would never happen.
		[
			"a dynamic first run at its end",
			{
				trigger: { kind: "dynamic", timeZone: "UTC", firstRunAt: "2026-10-02T11:00:00+02:00" },
				expiresAt: "2026-10-02T09:00:00Z",
			},
			"firstRunAt must come before expiresAt",
		],
	])("rejects %s before the writer sees it", async (_label, extra, reason) => {
		const f = await fixture();
		try {
			const response = await f.boundary.invoke("bad", "qorpera", "manage_routine", { ...weekly, ...extra });
			expect(response.success).toBe(false);
			// The result is JSON, so the reason's quotes are read from its parsed content.
			const told = (JSON.parse(response.contentItems[0].text) as { content: { text: string } }).content.text;
			expect(told).toContain(`INVALID_ARGUMENTS${reason ? `: ${reason}` : ""}`);
			expect(f.writer.check).not.toHaveBeenCalled();
			expect(f.writer.change).not.toHaveBeenCalled();
		} finally {
			f.run.close();
		}
	});
	it("compiles a when_done listener on a todo or a human task, with its latest time", async () => {
		const f = await fixture();
		try {
			const todo = await f.boundary.invoke("w1", "qorpera", "manage_routine", {
				...weekly,
				operationKey: "w1",
				trigger: {
					kind: "when_done",
					path: "QorperaOS/agents/product-builder/todos/landing-page.md",
					latestAt: "2026-11-06T09:00:00+01:00",
					timeZone: "Europe/Copenhagen",
				},
			});
			expect(todo.success, JSON.stringify(todo)).toBe(true);
			// A todo named without .md, as lists show it, and a human task.
			const bare = await f.boundary.invoke("w2", "qorpera", "manage_routine", {
				...weekly,
				operationKey: "w2",
				trigger: {
					kind: "when_done",
					path: "QorperaOS/agents/product-builder/todos/landing-page",
					latestAt: "2026-11-06T09:00:00Z",
					timeZone: "UTC",
				},
			});
			const task = await f.boundary.invoke("w3", "qorpera", "manage_routine", {
				...weekly,
				operationKey: "w3",
				trigger: {
					kind: "when_done",
					path: "QorperaOS/human-tasks/sign-contract.md",
					latestAt: "2026-11-06T09:00:00Z",
					timeZone: "UTC",
					report: "required",
				},
			});
			expect(bare.success && task.success, JSON.stringify([bare, task])).toBe(true);
			expect(f.saved().map((request) => request.trigger)).toEqual([
				{
					kind: "once",
					at: "2026-11-06T08:00:00.000Z",
					after: "QorperaOS/agents/product-builder/todos/landing-page.md",
					timeZone: "Europe/Copenhagen",
					replyPolicy: "optional",
				},
				{
					kind: "once",
					at: "2026-11-06T09:00:00.000Z",
					after: "QorperaOS/agents/product-builder/todos/landing-page.md",
					timeZone: "UTC",
					replyPolicy: "optional",
				},
				{
					kind: "once",
					at: "2026-11-06T09:00:00.000Z",
					after: "QorperaOS/human-tasks/sign-contract.md",
					timeZone: "UTC",
					replyPolicy: "required",
				},
			]);
			// Anything else is refused in words the model can act on, before any save: another file, no latest time.
			const other = await f.boundary.invoke("w4", "qorpera", "manage_routine", {
				...weekly,
				operationKey: "w4",
				trigger: { kind: "when_done", path: "product/plan.md", latestAt: "2026-11-06T09:00:00Z", timeZone: "UTC" },
			});
			expect(other.success).toBe(false);
			expect(other.contentItems[0].text).toContain("path is the path of a todo or a human task file");
			const open = await f.boundary.invoke("w5", "qorpera", "manage_routine", {
				...weekly,
				operationKey: "w5",
				trigger: {
					kind: "when_done",
					path: "QorperaOS/human-tasks/sign-contract.md",
					timeZone: "UTC",
				},
			});
			expect(open.success).toBe(false);
			expect(open.contentItems[0].text).toContain("a trigger of kind when_done takes path, latestAt and timeZone");
			expect(f.writer.change).toHaveBeenCalledTimes(3);
		} finally {
			f.run.close();
		}
	});
	it("lists through the writer, a page or one routine, and hands it a pause", async () => {
		const f = await fixture();
		try {
			const page = await f.boundary.invoke("l", "qorpera", "manage_routine", { action: "list" });
			expect(page.success, JSON.stringify(page)).toBe(true);
			expect(f.writer.list).toHaveBeenLastCalledWith(
				{ action: "list" },
				expect.objectContaining({ callId: "l" }),
				fitsOneResult,
			);
			const one = await f.boundary.invoke("l1", "qorpera", "manage_routine", {
				action: "list",
				routineKey: "morning-queue",
			});
			expect(one.success, JSON.stringify(one)).toBe(true);
			// The key is the routine's file name, which the writer's own rule checks.
			expect(f.writer.path).toHaveBeenCalledWith("morning-queue");
			expect(f.writer.list).toHaveBeenLastCalledWith(
				{ action: "list", routineKey: "morning-queue" },
				expect.objectContaining({ callId: "l1" }),
				fitsOneResult,
			);
			expect(
				(await f.boundary.invoke("x", "qorpera", "manage_routine", { action: "list", search: "queue" })).success,
			).toBe(false);
			expect(f.writer.list).toHaveBeenCalledTimes(2);
			const paused = await f.boundary.invoke("p", "qorpera", "manage_routine", {
				action: "pause",
				operationKey: "p",
				routineKey: "morning-queue",
			});
			expect(paused.success, JSON.stringify(paused)).toBe(true);
			expect(f.saved()).toEqual([{ action: "pause", operationKey: "p", routineKey: "morning-queue" }]);
		} finally {
			f.run.close();
		}
	});
	it("refuses an operationKey reused for another change, and the writer's own check, before any save", async () => {
		const f = await fixture();
		try {
			expect((await f.boundary.invoke("k1", "qorpera", "manage_routine", weekly)).success).toBe(true);
			const rebound = await f.boundary.invoke("k2", "qorpera", "manage_routine", { ...weekly, title: "Other" });
			expect(rebound.success).toBe(false);
			expect(rebound.contentItems[0].text).toContain(
				"INVALID_ARGUMENTS: operationKey is already used in this run for a different routine change",
			);
			f.writer.check.mockImplementationOnce(() => {
				throw new CloudToolArgumentRefusal("expiresAt has already passed: choose a later end, or leave it out");
			});
			const ended = await f.boundary.invoke("k3", "qorpera", "manage_routine", {
				...weekly,
				operationKey: "queue-2",
				expiresAt: "2026-10-01T00:00:00Z",
			});
			expect(ended.success).toBe(false);
			expect(ended.contentItems[0].text).toContain("INVALID_ARGUMENTS: expiresAt has already passed");
			expect(f.writer.change).toHaveBeenCalledTimes(1);
		} finally {
			f.run.close();
		}
	});
});

describe("a dynamic routine's own run", () => {
	it("points the run at decide_routine instead of saving, pausing or removing its own routine", async () => {
		let owed = true;
		const settled = vi.fn(() => {
			owed = false;
		});
		const f = await fixture({ routineKey: "invoice-watch", decisionOwed: () => owed, settled });
		try {
			for (const action of ["upsert", "pause", "resume", "remove"]) {
				const own = await f.boundary.invoke(`own-${action}`, "qorpera", "manage_routine", {
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
			expect((await f.boundary.invoke("other", "qorpera", "manage_routine", weekly)).success).toBe(true);
			const done = await f.boundary.invoke("own-done", "qorpera", "manage_routine", {
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
					await f.boundary.invoke("later", "qorpera", "manage_routine", {
						...weekly,
						operationKey: "later",
						routineKey: "invoice-watch",
					})
				).success,
			).toBe(true);
			const laterPause = await f.boundary.invoke("later-pause", "qorpera", "manage_routine", {
				action: "pause",
				operationKey: "later-pause",
				routineKey: "invoice-watch",
			});
			expect(laterPause.success).toBe(false);
			expect(f.saved().map((request) => [request.action, request.routineKey])).toEqual([
				["upsert", "morning-queue"],
				["conclude", "invoice-watch"],
				["upsert", "invoice-watch"],
			]);
		} finally {
			f.run.close();
		}
	});
});

describe("dynamic routine decision tool", () => {
	/** The tool over a fake of the routine file's decision writer that saves every decision
	 * (cloud-folder-routine-decision.test.ts covers what the writer saves). */
	async function decision() {
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
		const writer = {
			check: vi.fn<CloudFolderRoutineDecision["check"]>(),
			decide: vi.fn<CloudFolderRoutineDecision["decide"]>(async () => ({
				content: { kind: "text", value: '{"outcome":"saved"}' },
				decided: true,
			})),
		};
		const boundary = new CloudNativeToolBoundary({
			companyId: run.identity.companyId,
			runId: run.identity.runId,
			identity: run.identity,
			tools: [
				cloudRoutineDecisionTool(binding, run.identity, {
					decisionOwed: () => owed,
					decided,
					folderDecision: writer as unknown as CloudFolderRoutineDecision,
				}),
			],
			assertActive: (signal) => run.assertActive(signal),
			signal: run.signal,
		});
		return { binding, run, writer, boundary, decided };
	}
	it("hands the writer the next run with changed instructions, and records that the run decided", async () => {
		const f = await decision();
		try {
			const next = await f.boundary.invoke("n1", "qorpera", "decide_routine", {
				action: "next",
				operationKey: "next-1",
				at: "2026-09-26T09:00:00+02:00",
				intent: "Invoice 42 is still open. Remind finance tomorrow if it still is.",
			});
			expect(next.success, JSON.stringify(next)).toBe(true);
			const request = {
				action: "next",
				operationKey: "next-1",
				at: "2026-09-26T07:00:00.000Z",
				intent: "Invoice 42 is still open. Remind finance tomorrow if it still is.",
			};
			expect(f.writer.check).toHaveBeenCalledWith(request);
			expect(f.writer.decide).toHaveBeenCalledWith(request, expect.objectContaining({ callId: "n1" }));
			expect(f.decided).toHaveBeenCalledTimes(1);
			expect(next.completesTurn).toBeUndefined();
			expect(JSON.stringify(next)).not.toContain(f.binding.credentialCapsuleId);
			// A second decision would change nothing (the routine moved on), so the run hears where a further change goes
			// instead.
			const again = await f.boundary.invoke("n2", "qorpera", "decide_routine", {
				action: "next",
				operationKey: "next-2",
				at: "2026-09-25T20:00:00+02:00",
			});
			expect(again.success).toBe(false);
			expect(again.contentItems[0].text).toContain("INVALID_ARGUMENTS: nothing is owed any more");
			expect(f.writer.decide).toHaveBeenCalledTimes(1);
		} finally {
			f.run.close();
		}
	});
	it("hands the writer a next run that waits for a todo, and refuses another file", async () => {
		const f = await decision();
		try {
			const refused = await f.boundary.invoke("l1", "qorpera", "decide_routine", {
				action: "next",
				operationKey: "next-1",
				at: "2026-11-06T09:00:00Z",
				whenDone: "QorperaOS/vision/vision.md",
			});
			expect(refused.success).toBe(false);
			expect(refused.contentItems[0].text).toContain("whenDone is the path of a todo or a human task file");
			const next = await f.boundary.invoke("l2", "qorpera", "decide_routine", {
				action: "next",
				operationKey: "next-2",
				at: "2026-11-06T09:00:00Z",
				whenDone: "QorperaOS/agents/product-builder/todos/landing-page.md",
			});
			expect(next.success, JSON.stringify(next)).toBe(true);
			expect(f.writer.decide).toHaveBeenCalledWith(
				{
					action: "next",
					operationKey: "next-2",
					at: "2026-11-06T09:00:00.000Z",
					after: "QorperaOS/agents/product-builder/todos/landing-page.md",
				},
				expect.objectContaining({ callId: "l2" }),
			);
			expect(f.decided).toHaveBeenCalledTimes(1);
		} finally {
			f.run.close();
		}
	});
	it("hands the writer a conclusion with its reason", async () => {
		const f = await decision();
		try {
			const done = await f.boundary.invoke("c1", "qorpera", "decide_routine", {
				action: "conclude",
				operationKey: "done-1",
				summary: "Invoice 42 was paid.",
			});
			expect(done.success, JSON.stringify(done)).toBe(true);
			expect(f.writer.decide).toHaveBeenCalledWith(
				{ action: "conclude", operationKey: "done-1", summary: "Invoice 42 was paid." },
				expect.objectContaining({ callId: "c1" }),
			);
			expect(f.decided).toHaveBeenCalledTimes(1);
		} finally {
			f.run.close();
		}
	});
	it.each([
		["no time", { action: "next", operationKey: "k" }, "at must be"],
		["an unreadable time", { action: "next", operationKey: "k", at: "soon" }, "at must be"],
		// Without an offset the host would read it in its own zone, not the member's.
		["a time without an offset", { action: "next", operationKey: "k", at: "2026-10-01T09:00:00" }, "at must be"],
		[
			"an unknown report",
			{ action: "next", operationKey: "k", at: "2026-10-01T09:00:00Z", report: "loud" },
			"report is optional, required or silent",
		],
		["no summary", { action: "conclude", operationKey: "k" }, ""],
		["a routine key", { action: "conclude", operationKey: "k", summary: "x", routineKey: "other" }, ""],
		["another action", { action: "remove", operationKey: "k" }, "action must be next or conclude"],
	])("refuses %s before the writer sees it", async (_label, value, reason) => {
		const f = await decision();
		try {
			const response = await f.boundary.invoke("bad", "qorpera", "decide_routine", value);
			expect(response.success).toBe(false);
			expect(response.contentItems[0].text).toContain(`INVALID_ARGUMENTS${reason ? `: ${reason}` : ""}`);
			expect(f.writer.check).not.toHaveBeenCalled();
			expect(f.writer.decide).not.toHaveBeenCalled();
			expect(f.decided).not.toHaveBeenCalled();
		} finally {
			f.run.close();
		}
	});
});

describe("a folder-v2 dynamic routine's decision", () => {
	it("goes through the routine file writer and is made only when the file saved", async () => {
		const { binding, authority } = nativeToolAuthorityFixture();
		const identity = authority.identity;
		const decided = vi.fn();
		const answers = [
			{ content: { kind: "text" as const, value: '{"state":"refused"}' }, decided: false },
			{ content: { kind: "text" as const, value: '{"saved":true}' }, decided: true },
		];
		const decide = vi.fn(async () => answers.shift() ?? answers[0]!);
		const check = vi.fn();
		const tool = cloudRoutineDecisionTool(binding, identity, {
			decisionOwed: () => true,
			decided,
			folderDecision: { decide, check } as unknown as CloudFolderRoutineDecision,
		});
		const context = {
			companyId: identity.companyId,
			runId: identity.runId,
			callId: randomUUID(),
			argumentSha256: "a".repeat(64),
			signal: new AbortController().signal,
			identity,
		};
		const request = tool.parseArguments({ action: "next", operationKey: "decide-1", at: "2026-10-03T07:30:00Z" });
		// The file's own check runs with the arguments, before the automatic review.
		expect(check).toHaveBeenCalledWith(request);
		await expect(tool.execute(request, context)).resolves.toEqual({ kind: "text", value: '{"state":"refused"}' });
		expect(decided).not.toHaveBeenCalled();
		await expect(tool.execute(request, context)).resolves.toEqual({ kind: "text", value: '{"saved":true}' });
		expect(decided).toHaveBeenCalledTimes(1);
		expect(decide).toHaveBeenCalledWith(request, context);
	});

	it("says what this company's run can decide, and shows a refusal before any effect, owing still", async () => {
		const { binding, authority } = nativeToolAuthorityFixture();
		const run = await CloudNativeToolRun.open(
			binding,
			{ describeToolAuthority: async () => authority },
			new AbortController().signal,
		);
		const decided = vi.fn();
		const decide = vi.fn(async () => {
			throw new CloudToolRefusal("A conclusion keeps the routine's title and instructions: conclude without them");
		});
		const tool = cloudRoutineDecisionTool(binding, run.identity, {
			decisionOwed: () => true,
			decided,
			folderDecision: { decide, check: () => {} } as unknown as CloudFolderRoutineDecision,
		});
		expect(tool.description).toContain(
			"In this company the routine is a file, and a new intent or title goes through the automatic review; if it is not approved, decide again without them.",
		);
		expect(tool.description).toContain("a refused one is decided again under a new operationKey");
		expect(tool.description).toContain("intent, when the work changed");
		expect(tool.description).toContain("state refused carries the reason: choose again or conclude.");
		const boundary = new CloudNativeToolBoundary({
			companyId: run.identity.companyId,
			runId: run.identity.runId,
			identity: run.identity,
			tools: [tool],
			assertActive: (signal) => run.assertActive(signal),
			signal: run.signal,
		});
		try {
			const refused = await boundary.invoke("d1", "qorpera", "decide_routine", {
				action: "next",
				operationKey: "decide-1",
				at: "2026-10-03T07:30:00Z",
				intent: "Compare this week's prices.",
			});
			expect(JSON.parse(refused.contentItems[0].text)).toMatchObject({
				status: "denied",
				content: {
					text: "REFUSED: A conclusion keeps the routine's title and instructions: conclude without them",
				},
			});
			expect(decided).not.toHaveBeenCalled();
		} finally {
			run.close();
		}
	});
});
