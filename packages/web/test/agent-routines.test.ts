// @vitest-environment jsdom
import type { NativeMemberConnection } from "@qorpera/cloud-client/cloud-native-subscription-control";
import {
	type CloudRoutine,
	CloudRoutineClient,
	describeCloudRoutineTrigger,
	parseCloudRoutine,
	parseCloudRoutineTrigger,
} from "@qorpera/cloud-client/cloud-routines";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRoutines } from "../src/app/views/agent-routines.ts";
import type { WebRoutines } from "../src/cloud/routines.ts";
import { settle, staff } from "./fixtures.ts";

const account = {
	connectionId: "10000000-0000-4000-8000-000000000001",
	connectionVersion: 1,
	provider: "openai-codex",
	connectionStatus: "active",
	authorizationState: "active",
	providerAccountReference: "owner@example.invalid",
} as unknown as NativeMemberConnection;
const routine = (update: Partial<CloudRoutine> = {}): CloudRoutine => ({
	routineId: "10000000-0000-4000-8000-000000000002",
	clientRoutineId: "10000000-0000-4000-8000-000000000003",
	version: 1,
	status: "active",
	staffAgentId: staff.id,
	title: "Morning brief",
	prompt: "Summarise what changed.",
	triggers: [
		{
			id: "t",
			kind: "schedule",
			intervalMinutes: 1440,
			weekdays: ["monday"],
			localTime: "08:30",
			timeZone: "Europe/Copenhagen",
		},
	],
	effort: "low",
	sponsorBindingId: "10000000-0000-4000-8000-000000000004",
	sponsorVersion: 1,
	logicalComputerId: null,
	requiredCapability: "agent_turn",
	jobType: "agent_turn",
	publicationMode: "automatic",
	reviewPolicyKey: null,
	reviewerStaffIds: [],
	createdAt: "2026-09-17T06:00:00.000Z",
	updatedAt: "2026-09-17T06:00:00.000Z",
	nextRunAt: null,
	conclusion: null,
	...update,
});
function mount(items: CloudRoutine[], manage = true, connections: NativeMemberConnection[] = [account]) {
	const routines = {
		list: vi.fn(async () => items),
		runs: vi.fn(async () => []),
		save: vi.fn(async () => {}),
		setEnabled: vi.fn(async () => {}),
	} satisfies WebRoutines;
	const stop = new AbortController();
	const view = new AgentRoutines(
		() => staff,
		{ routines, accounts: async () => ({ connections }), canManage: () => manage },
		stop.signal,
	);
	document.body.append(view.el);
	return { routines, view, stop };
}
const click = (root: Element, label: string) =>
	[...root.querySelectorAll("button")]
		.find((item) => item.textContent === label || item.getAttribute("aria-label") === label)!
		.click();
afterEach(() => document.body.replaceChildren());

describe("routine triggers", () => {
	it("accepts the cloud's three shapes and describes them in plain words", () => {
		expect(
			describeCloudRoutineTrigger(parseCloudRoutineTrigger({ id: "a", kind: "schedule", intervalMinutes: 120 })),
		).toBe("Every 2 hours");
		expect(describeCloudRoutineTrigger(routine().triggers[0]!)).toBe("Mon at 08:30 (Europe/Copenhagen)");
		expect(
			describeCloudRoutineTrigger(
				parseCloudRoutineTrigger({
					id: "f",
					kind: "listener",
					source: "company-file",
					path: "finance/invoices",
					match: "subtree",
					timeZone: "UTC",
					replyPolicy: "silent",
				}),
			),
		).toBe("When finance/invoices or anything under it changes");
	});
	it.each([
		{ id: "a", kind: "schedule", intervalMinutes: 4 },
		{ id: "a", kind: "schedule", intervalMinutes: 60, weekdays: [], localTime: "09:00", timeZone: "UTC" },
		{ id: "a", kind: "schedule", intervalMinutes: 60, weekdays: ["monday"], localTime: "9:00", timeZone: "UTC" },
		{ id: "a", kind: "schedule", intervalMinutes: 60, weekdays: ["monday"], localTime: "09:00", timeZone: "auto" },
		{ id: "a", kind: "listener", source: "company-file", path: "../x", match: "exact", timeZone: "UTC" },
		{ id: "a", kind: "schedule", intervalMinutes: 60, cron: "* * * * *" },
	])("refuses %j", (value) => {
		expect(() => parseCloudRoutineTrigger(value)).toThrow();
	});
});

describe("agent routines section", () => {
	it("lists this agent's routines and hides another agent's and retired ones", async () => {
		const f = mount([
			routine(),
			routine({
				routineId: "10000000-0000-4000-8000-000000000009",
				staffAgentId: "10000000-0000-4000-8000-00000000000a",
				title: "Other",
			}),
			routine({ routineId: "10000000-0000-4000-8000-00000000000b", status: "retired", title: "Gone" }),
		]);
		await settle();
		expect(f.view.el.textContent).toContain("Morning brief");
		expect(f.view.el.textContent).toContain("Mon at 08:30");
		expect(f.view.el.textContent).not.toContain("Other");
		expect(f.view.el.textContent).not.toContain("Gone");
	});
	it("reads an ended routine and shows it as ended, next to the others", async () => {
		// One expired routine (a finished finite watch) used to make the whole list unreadable.
		const row = {
			routine_id: "10000000-0000-4000-8000-00000000000c",
			client_routine_id: "10000000-0000-4000-8000-00000000000d",
			version: 1,
			status: "expired",
			staff_agent_id: staff.id,
			title: "One check",
			prompt: "Check once.",
			triggers: [{ id: "agent", kind: "schedule", intervalMinutes: 5, replyPolicy: "silent" }],
			effort: "medium",
			sponsor_binding_id: "10000000-0000-4000-8000-000000000004",
			sponsor_version: 1,
			logical_computer_id: null,
			required_capability: "agent_turn",
			job_type: "agent_turn",
			publication_mode: "automatic",
			review_policy_key: null,
			reviewer_staff_ids: [],
			created_at: "2026-09-17T06:00:00.000Z",
			updated_at: "2026-09-17T06:05:00.000Z",
		};
		const listed = await new CloudRoutineClient(async () => [
			{ ...row, routine_id: "10000000-0000-4000-8000-00000000000e", status: "active", title: "Still on" },
			row,
		]).list("10000000-0000-4000-8000-00000000000f", new AbortController().signal);
		expect(listed.map((item) => item.status)).toEqual(["active", "expired"]);
		// A row this client cannot read (a newer cloud's shape) is left out, not the whole list,
		// and the count is reported so a broken reader is not mistaken for missing routines.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const tolerant = await new CloudRoutineClient(async () => [
			row,
			{ ...row, routine_id: "10000000-0000-4000-8000-000000000013", status: "archived-by-the-future" },
		]).list("10000000-0000-4000-8000-00000000000f", new AbortController().signal);
		expect(tolerant.map((item) => item.routineId)).toEqual([row.routine_id]);
		expect(warn).toHaveBeenCalledWith("1 cloud routine row(s) could not be read and were left out");
		warn.mockRestore();
		const ended = parseCloudRoutine(row);
		expect(ended.status).toBe("expired");
		expect(() => parseCloudRoutine({ ...row, status: "finished" })).toThrow();
		const f = mount([routine(), ended]);
		await settle();
		const rows = [...f.view.el.querySelectorAll(".routine-row")];
		expect(rows.map((item) => item.querySelector("strong")?.textContent)).toEqual(["Morning brief", "One check"]);
		expect(rows[1]!.textContent).toContain("Ended");
		// Read-only: a member save would keep its end, so there is nothing to edit or resume.
		expect(rows[1]!.querySelectorAll("button")).toHaveLength(0);
		expect([...rows[0]!.querySelectorAll("button")].map((item) => item.textContent)).toEqual(["Edit", "Pause"]);
	});
	it("shows a dynamic routine's next run, that it runs until its agent decides, and why a routine is done", async () => {
		const row = {
			routine_id: "10000000-0000-4000-8000-000000000010",
			client_routine_id: "10000000-0000-4000-8000-000000000011",
			version: 3,
			status: "active",
			staff_agent_id: staff.id,
			title: "Invoice follow-up",
			prompt: "Invoice 42 is still open. Look again at noon.",
			triggers: [
				{
					id: "agent",
					kind: "once",
					at: "2026-09-26T10:00:00.000Z",
					timeZone: "Europe/Copenhagen",
					replyPolicy: "optional",
				},
			],
			effort: "medium",
			sponsor_binding_id: "10000000-0000-4000-8000-000000000004",
			sponsor_version: 1,
			logical_computer_id: null,
			required_capability: "agent_turn",
			job_type: "agent_turn",
			publication_mode: "automatic",
			review_policy_key: null,
			reviewer_staff_ids: [],
			created_at: "2026-09-25T06:00:00.000Z",
			updated_at: "2026-09-25T08:00:00.000Z",
			next_run_at: "2026-09-26T10:00:00+00:00",
			conclusion: null,
		};
		const dynamic = parseCloudRoutine(row);
		expect(dynamic.triggers[0]).toEqual({
			id: "agent",
			kind: "once",
			at: "2026-09-26T10:00:00.000Z",
			timeZone: "Europe/Copenhagen",
			replyPolicy: "optional",
		});
		expect(dynamic.nextRunAt).toBe("2026-09-26T10:00:00+00:00");
		const done = parseCloudRoutine({
			...row,
			routine_id: "10000000-0000-4000-8000-000000000012",
			title: "Launch watch",
			status: "concluded",
			next_run_at: null,
			conclusion: "The launch went out on 24 September.",
		});
		// A cloud older than dynamic routines sends neither field.
		const { next_run_at: _next, conclusion: _conclusion, ...older } = row;
		expect(parseCloudRoutine(older)).toMatchObject({ nextRunAt: null, conclusion: null });
		expect(() => parseCloudRoutineTrigger({ id: "agent", kind: "once", at: "tomorrow", timeZone: "UTC" })).toThrow();
		expect(() =>
			parseCloudRoutineTrigger({
				id: "agent",
				kind: "once",
				at: "2026-09-26T10:00:00.000Z",
				timeZone: "UTC",
				intervalMinutes: 60,
			}),
		).toThrow();
		const f = mount([dynamic, done]);
		await settle();
		const rows = [...f.view.el.querySelectorAll(".routine-row")];
		expect(rows[0]!.textContent).toContain("The agent picks each next run");
		expect(rows[0]!.textContent).toContain("Next run:");
		expect(rows[0]!.textContent).toContain(`Runs until ${staff.displayName} decides it is done`);
		// The editor has no shape for a dynamic routine; it can still be paused.
		expect([...rows[0]!.querySelectorAll("button")].map((item) => item.textContent)).toEqual(["Pause"]);
		expect(rows[1]!.textContent).toContain("Done: The launch went out on 24 September.");
		expect(rows[1]!.textContent).not.toContain("Next run:");
		expect(rows[1]!.querySelectorAll("button")).toHaveLength(0);
	});
	it("saves a new weekday routine on the chosen account with one stable identity across a retry", async () => {
		const f = mount([]);
		await settle();
		click(f.view.el, "New routine");
		await settle();
		f.view.el.querySelector<HTMLInputElement>('[aria-label="Routine name"]')!.value = "Weekly close";
		f.view.el.querySelector<HTMLTextAreaElement>('[aria-label="What to do"]')!.value = "Close the week.";
		f.routines.save.mockRejectedValueOnce(new Error("offline"));
		click(f.view.el, "Save routine");
		await settle();
		expect(f.view.el.textContent).toContain("Your draft is still here");
		click(f.view.el, "Save routine");
		await settle();
		expect(f.routines.save).toHaveBeenCalledTimes(2);
		const [first, second] = f.routines.save.mock.calls as unknown as Array<
			[{ clientRoutineId: string; trigger: unknown; enabled: boolean }, unknown, string]
		>;
		expect(second![0].clientRoutineId).toBe(first![0].clientRoutineId);
		expect(second![2]).not.toBe(first![2]);
		expect(second![1]).toBe(account);
		expect(second![0]).toMatchObject({
			enabled: true,
			trigger: {
				kind: "schedule",
				weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
				localTime: "09:00",
			},
		});
	});
	it("offers each account once, by email, and numbers a repeated account", async () => {
		const connections = [
			account,
			{ ...account, connectionVersion: 2, providerAccountEmail: "owner@example.invalid" },
			{
				...account,
				connectionId: "10000000-0000-4000-8000-000000000009",
				providerAccountEmail: "owner@example.invalid",
			},
			{ ...account, connectionId: "10000000-0000-4000-8000-000000000008", providerAccountReference: undefined },
		] as unknown as NativeMemberConnection[];
		const f = mount([], true, connections);
		await settle();
		click(f.view.el, "New routine");
		await settle();
		const options = [...f.view.el.querySelectorAll<HTMLOptionElement>('[aria-label="Model account"] option')];
		expect(options.map((item) => item.value)).toEqual([
			"10000000-0000-4000-8000-000000000001",
			"10000000-0000-4000-8000-000000000009",
			"10000000-0000-4000-8000-000000000008",
		]);
		expect(options.map((item) => item.textContent)).toEqual([
			"ChatGPT · owner@example.invalid",
			"ChatGPT · owner@example.invalid (2)",
			"ChatGPT",
		]);
	});
	it("pauses a routine and offers no controls to a member who cannot manage", async () => {
		const f = mount([routine()]);
		await settle();
		click(f.view.el, "Pause");
		await settle();
		expect(f.routines.setEnabled).toHaveBeenCalledWith(
			expect.objectContaining({ title: "Morning brief" }),
			account,
			false,
			expect.any(String),
		);
		const readOnly = mount([routine()], false);
		await settle();
		const labels = [...readOnly.view.el.querySelectorAll("button")].map((item) => item.textContent);
		expect(labels).not.toContain("Pause");
		expect(labels).not.toContain("New routine");
	});
	it("steps back from the editor to the list, and from the list to the page it was opened from", async () => {
		const back = vi.fn();
		const routines = {
			list: vi.fn(async () => [routine()]),
			runs: vi.fn(async () => []),
			save: vi.fn(async () => {}),
			setEnabled: vi.fn(async () => {}),
		} satisfies WebRoutines;
		const view = new AgentRoutines(
			() => staff,
			{ routines, accounts: async () => ({ connections: [account] }), canManage: () => true },
			new AbortController().signal,
			back,
		);
		document.body.append(view.el);
		await settle();
		click(view.el, "Edit");
		await settle();
		expect(view.el.querySelector("h2")?.textContent).toBe("Edit routine");
		view.refresh();
		await settle();
		expect(view.el.querySelector("h2")?.textContent).toBe("Edit routine");
		click(view.el, "Back to routines");
		expect(view.el.querySelector("h2")?.textContent).toBe("Routines");
		expect(view.el.textContent).toContain("Morning brief");
		click(view.el, "New routine");
		await settle();
		click(view.el, "Cancel");
		expect(view.el.querySelector("h2")?.textContent).toBe("Routines");
		click(view.el, "Back to agent details");
		expect(back).toHaveBeenCalledTimes(1);
		expect(routines.save).not.toHaveBeenCalled();
	});
});
