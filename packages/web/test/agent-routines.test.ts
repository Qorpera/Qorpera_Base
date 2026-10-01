// @vitest-environment jsdom
import type { NativeMemberConnection } from "@qorpera/cloud-client/cloud-native-subscription-control";
import {
	type CloudRoutine,
	CloudRoutineClient,
	type CloudRoutineOccurrence,
	type CloudRoutineSaveInput,
	describeCloudRoutineTrigger,
	parseCloudRoutine,
	parseCloudRoutineTrigger,
} from "@qorpera/cloud-client/cloud-routines";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanyController } from "../src/app/company.ts";
import { AgentRoutines, routineAccessFor } from "../src/app/views/agent-routines.ts";
import type { WorkspaceActions } from "../src/app/workspace-actions.ts";
import type { Cloud } from "../src/cloud/client.ts";
import { createWebRoutines, type WebRoutine, type WebRoutines } from "../src/cloud/routines.ts";
import { fmtTime } from "../src/ui/dom.ts";
import { profileA, settle, staff } from "./fixtures.ts";

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
		runs: vi.fn(async (): Promise<CloudRoutineOccurrence[]> => []),
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
/** The editor over the real save; each upsert the cloud receives is kept. */
function mountSaving(items: CloudRoutine[]) {
	const upserts: Record<string, unknown>[] = [];
	const cloud = {
		rpc: vi.fn(async (name: string, args: Record<string, unknown> = {}) => {
			if (name === "qorpera_consent_provider_connection_autonomous")
				return { connection_id: account.connectionId, allow_autonomous: true, version: 2 };
			if (name === "qorpera_create_member_execution_sponsor")
				return { binding_id: "10000000-0000-4000-8000-000000000005", version: 1 };
			if (name !== "qorpera_upsert_cloud_routine") throw new Error(`Unexpected call ${name}`);
			upserts.push(args);
			return {
				routine_id: "10000000-0000-4000-8000-000000000002",
				client_routine_id: args.p_client_routine_id,
				version: upserts.length + 1,
				status: "active",
			};
		}),
	} as unknown as Cloud;
	const stop = new AbortController();
	const routines = {
		...createWebRoutines(cloud, profileA, stop.signal, () => {}),
		list: vi.fn(async () => items),
		runs: vi.fn(async () => []),
	} satisfies WebRoutines;
	const view = new AgentRoutines(
		() => staff,
		{ routines, accounts: async () => ({ connections: [account] }), canManage: () => true },
		stop.signal,
	);
	document.body.append(view.el);
	return { upserts, view, stop };
}
const click = (root: Element, label: string) =>
	[...root.querySelectorAll("button")]
		.find((item) => item.textContent === label || item.getAttribute("aria-label") === label)!
		.click();
/** A card's own controls, by what they read as: Edit, and the switch by its role and state. */
const controls = (card: Element) =>
	[...card.querySelectorAll(".routine-card-head > button:not(.routine-card-summary)")].map((item) =>
		item.getAttribute("role") === "switch" ? `switch:${item.getAttribute("aria-checked")}` : item.textContent,
	);
const cards = (root: Element) => [...root.querySelectorAll<HTMLElement>(".routine-card")];
afterEach(() => {
	document.body.replaceChildren();
	localStorage.clear();
});

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
		const hook = "10000000-0000-4000-8000-0000000000a1";
		expect(
			describeCloudRoutineTrigger(
				parseCloudRoutineTrigger({ id: "e", kind: "listener", source: "event", hookId: hook, timeZone: "UTC" }),
			),
		).toBe("When a hook receives an event");
		const typed = parseCloudRoutineTrigger({
			id: "e",
			kind: "listener",
			source: "event",
			hookId: hook,
			only: ["order.paid", "order.refunded"],
			timeZone: "UTC",
			replyPolicy: "optional",
		});
		expect(typed).toEqual({
			id: "e",
			kind: "listener",
			source: "event",
			hookId: hook,
			only: ["order.paid", "order.refunded"],
			timeZone: "UTC",
			replyPolicy: "optional",
		});
		expect(describeCloudRoutineTrigger(typed)).toBe("When a hook receives order.paid, order.refunded");
	});
	it.each([
		{ id: "a", kind: "schedule", intervalMinutes: 4 },
		{ id: "a", kind: "schedule", intervalMinutes: 60, weekdays: [], localTime: "09:00", timeZone: "UTC" },
		{ id: "a", kind: "schedule", intervalMinutes: 60, weekdays: ["monday"], localTime: "9:00", timeZone: "UTC" },
		{ id: "a", kind: "schedule", intervalMinutes: 60, weekdays: ["monday"], localTime: "09:00", timeZone: "auto" },
		{ id: "a", kind: "listener", source: "company-file", path: "../x", match: "exact", timeZone: "UTC" },
		{ id: "a", kind: "schedule", intervalMinutes: 60, cron: "* * * * *" },
		{ id: "a", kind: "listener", source: "event", hookId: "10000000-0000-4000-8000-0000000000A1", timeZone: "UTC" },
		{ id: "a", kind: "listener", source: "event", hookId: "forms", timeZone: "UTC" },
		{
			id: "a",
			kind: "listener",
			source: "event",
			hookId: "10000000-0000-4000-8000-0000000000a1",
			only: ["x", "x"],
			timeZone: "UTC",
		},
		{
			id: "a",
			kind: "listener",
			source: "event",
			hookId: "10000000-0000-4000-8000-0000000000a1",
			only: ["has space"],
			timeZone: "UTC",
		},
		{
			id: "a",
			kind: "listener",
			source: "event",
			hookId: "10000000-0000-4000-8000-0000000000a1",
			path: "finance",
			timeZone: "UTC",
		},
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
		expect(f.view.el.querySelector(".routine-card-summary span")?.textContent).toMatch(/^Mon at 8:30\sAM/);
		expect(f.view.el.textContent).not.toContain("Other");
		expect(f.view.el.textContent).not.toContain("Gone");
	});
	it("names a member from the company's team", () => {
		const anna = "10000000-0000-4000-8000-000000000031";
		const company = {
			store: {
				get: () => ({
					team: {
						capabilities: { authorize: false },
						members: [{ userId: anna, displayName: "Anna", email: "anna@example.test", role: "member" }],
					},
				}),
			},
		} as unknown as CompanyController;
		const actions = {
			routines: { list: vi.fn(), runs: vi.fn(), save: vi.fn(), setEnabled: vi.fn() },
			nativeSubscription: { listConnections: vi.fn() },
		} as unknown as WorkspaceActions;
		const access = routineAccessFor(company, actions)!;
		expect(access.memberName?.(anna)).toBe("Anna");
		expect(access.memberName?.("10000000-0000-4000-8000-000000000032")).toBeUndefined();
	});
	it("says when a routine started again because its member turned on work while away", async () => {
		const resumed = {
			...routine({ status: "active" }),
			resumeReason: "plan_turned_on",
			resumedAt: "2026-10-01T10:00:00.000Z",
			resumedByUserId: "10000000-0000-4000-8000-000000000031",
		} as WebRoutine;
		for (const [items, name, said] of [
			[[resumed], () => "Anna", "When Anna turned on “Work while you're away”"],
			[[resumed], () => undefined, "When a member turned on “Work while you're away”"],
			[[{ ...resumed, status: "paused" } as WebRoutine], () => "Anna", undefined],
			[[{ ...resumed, resumeReason: "member" } as WebRoutine], () => "Anna", undefined],
			[[routine({ status: "active" })], () => "Anna", undefined],
		] as const) {
			const stop = new AbortController();
			const view = new AgentRoutines(
				() => staff,
				{
					routines: {
						list: vi.fn(async () => [...items]),
						runs: vi.fn(async (): Promise<CloudRoutineOccurrence[]> => []),
						save: vi.fn(async () => {}),
						setEnabled: vi.fn(async () => {}),
					},
					accounts: async () => ({ connections: [account] }),
					canManage: () => true,
					memberName: name,
				},
				stop.signal,
			);
			document.body.append(view.el);
			await settle();
			const fact = [...view.el.querySelectorAll(".routine-card-fact")].find(
				(item) => item.querySelector("dt")?.textContent === "Resumed",
			);
			if (said)
				expect(fact?.querySelector("dd")?.textContent).toBe(`${said} · ${fmtTime("2026-10-01T10:00:00.000Z")}`);
			else expect(fact).toBeUndefined();
			stop.abort();
			view.el.remove();
		}
	});
	it("keeps why a routine is paused and whom it runs for, from the list's own answer", async () => {
		const row = {
			routine_id: "10000000-0000-4000-8000-000000000020",
			client_routine_id: "10000000-0000-4000-8000-000000000021",
			version: 1,
			status: "paused",
			staff_agent_id: staff.id,
			title: "Morning brief",
			prompt: "Brief me.",
			triggers: [{ id: "agent", kind: "schedule", intervalMinutes: 60, replyPolicy: "silent" }],
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
		const member = "10000000-0000-4000-8000-000000000022";
		const rpc = vi.fn(async (name: string) => {
			if (name !== "qorpera_list_cloud_routines") throw new Error(`Unexpected call ${name}`);
			return [
				{ ...row, pause_reason: "needs_model_account", runs_for_user_id: member },
				{
					...row,
					routine_id: "10000000-0000-4000-8000-000000000025",
					status: "active",
					runs_for_user_id: member,
					resume_reason: "plan_turned_on",
					resumed_at: "2026-10-01T10:00:00.000Z",
					resumed_by_user_id: member,
				},
				{
					...row,
					routine_id: "10000000-0000-4000-8000-000000000026",
					status: "active",
					resume_reason: "plan_turned_on",
					resumed_at: "soon",
					resumed_by_user_id: member,
				},
				...[
					["27", "Plan Turned On!", member],
					["28", "plan_turned_on", "someone"],
					["29", "plan_turned_on", 7],
				].map(([n, reason, by]) => ({
					...row,
					routine_id: `10000000-0000-4000-8000-0000000000${n}`,
					status: "active",
					resume_reason: reason,
					resumed_at: "2026-10-01T10:00:00.000Z",
					resumed_by_user_id: by,
				})),
				{
					...row,
					routine_id: "10000000-0000-4000-8000-000000000023",
					pause_reason: "Needs an account!",
					runs_for_user_id: "someone",
				},
				{ ...row, routine_id: "10000000-0000-4000-8000-000000000024" },
			];
		});
		const listed = await createWebRoutines(
			{ rpc } as unknown as Cloud,
			profileA,
			new AbortController().signal,
			() => {},
		).list();
		expect(listed.find((item) => item.routineId === "10000000-0000-4000-8000-000000000025")).toMatchObject({
			resumeReason: "plan_turned_on",
			resumedAt: "2026-10-01T10:00:00.000Z",
			resumedByUserId: member,
		});
		// A resume with a field it cannot read is not shown at all.
		for (const n of ["26", "27", "28", "29"])
			expect(
				listed.find((item) => item.routineId === `10000000-0000-4000-8000-0000000000${n}`)?.resumeReason,
			).toBeUndefined();
		expect(
			listed
				.filter((item) => !/-0000000000(2[5-9])$/.test(item.routineId))
				.map((item) => [item.routineId, item.pauseReason, item.runsForUserId]),
		).toEqual([
			[row.routine_id, "needs_model_account", member],
			["10000000-0000-4000-8000-000000000023", undefined, undefined],
			["10000000-0000-4000-8000-000000000024", undefined, undefined],
		]);
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
		const rows = cards(f.view.el);
		expect(rows.map((item) => item.querySelector("strong")?.textContent)).toEqual(["Morning brief", "One check"]);
		expect(rows[1]!.querySelector(".routine-card-state")?.textContent).toBe("Ended");
		// Read-only: a member save would keep its end, so there is nothing to edit or resume.
		expect(controls(rows[1]!)).toEqual([]);
		expect(controls(rows[0]!)).toEqual(["Edit", "switch:true"]);
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
		const rows = cards(f.view.el);
		expect(rows[0]!.querySelector(".routine-card-summary")?.textContent).toContain("The agent picks each next run");
		expect(rows[0]!.querySelector(".routine-card-facts")?.textContent).toContain("Next run");
		expect(rows[0]!.textContent).toContain(`Runs until ${staff.displayName} decides it is done`);
		// The editor has no shape for a dynamic routine; it can still be paused.
		expect(controls(rows[0]!)).toEqual(["switch:true"]);
		// A concluded routine says why instead of how it used to be scheduled.
		expect(rows[1]!.querySelector(".routine-card-summary span")?.textContent).toBe(
			"The launch went out on 24 September.",
		);
		expect(rows[1]!.querySelector(".routine-card-state")?.textContent).toBe("Done");
		expect(rows[1]!.textContent).not.toContain("Next run");
		expect(rows[1]!.textContent).not.toContain("When to run");
		expect(controls(rows[1]!)).toEqual([]);
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
	it("keeps the effort an agent chose when a member edits the routine", async () => {
		// An agent may set a routine up at medium or high; a member edit used to save it as low.
		const upserts: Record<string, unknown>[] = [];
		const cloud = {
			rpc: vi.fn(async (name: string, args: Record<string, unknown> = {}) => {
				if (name === "qorpera_consent_provider_connection_autonomous")
					return { connection_id: account.connectionId, allow_autonomous: true, version: 2 };
				if (name === "qorpera_create_member_execution_sponsor")
					return { binding_id: "10000000-0000-4000-8000-000000000005", version: 1 };
				if (name !== "qorpera_upsert_cloud_routine") throw new Error(`Unexpected call ${name}`);
				upserts.push(args);
				return {
					routine_id: "10000000-0000-4000-8000-000000000002",
					client_routine_id: args.p_client_routine_id,
					version: upserts.length + 1,
					status: "active",
				};
			}),
		} as unknown as Cloud;
		const stop = new AbortController();
		const cloudRoutines = createWebRoutines(cloud, profileA, stop.signal, () => {});
		const routines = {
			list: vi.fn(async () => [routine({ effort: "high" })]),
			runs: vi.fn(async () => []),
			save: vi.fn(cloudRoutines.save),
			setEnabled: vi.fn(cloudRoutines.setEnabled),
		} satisfies WebRoutines;
		const view = new AgentRoutines(
			() => staff,
			{ routines, accounts: async () => ({ connections: [account] }), canManage: () => true },
			stop.signal,
		);
		document.body.append(view.el);
		await settle();
		click(view.el, "Edit");
		await settle();
		expect(view.el.textContent).toContain("Effort: High");
		view.el.querySelector<HTMLInputElement>('[aria-label="Routine name"]')!.value = "Morning brief, shorter";
		click(view.el, "Save routine");
		await vi.waitFor(() => expect(upserts).toHaveLength(1), { timeout: 3000 });
		expect(routines.save).toHaveBeenCalledWith(
			expect.objectContaining({ title: "Morning brief, shorter", effort: "high" }),
			account,
			expect.any(String),
		);
		expect(upserts[0]).toMatchObject({
			p_client_routine_id: routine().clientRoutineId,
			p_title: "Morning brief, shorter",
			p_effort: "high",
		});
		// A routine a member starts from scratch keeps the low default.
		await vi.waitFor(() => expect(view.el.querySelector("h2")?.textContent).toBe("Routines"));
		click(view.el, "New routine");
		await settle();
		expect(view.el.textContent).toContain("Effort: Low");
		view.el.querySelector<HTMLInputElement>('[aria-label="Routine name"]')!.value = "Weekly close";
		view.el.querySelector<HTMLTextAreaElement>('[aria-label="What to do"]')!.value = "Close the week.";
		click(view.el, "Save routine");
		await vi.waitFor(() => expect(upserts).toHaveLength(2), { timeout: 3000 });
		expect(upserts[1]).toMatchObject({ p_title: "Weekly close", p_effort: "low" });
		expect(upserts[1]!.p_client_routine_id).not.toBe(routine().clientRoutineId);
		stop.abort();
	});
	it("refuses a routine save that does not say its effort, before asking the cloud", async () => {
		const rpc = vi.fn(async () => ({}));
		const { effort: _, ...unsaid } = {
			environmentId: profileA.environmentId,
			clientRoutineId: routine().clientRoutineId,
			clientVersionId: routine().routineId,
			staffAgentId: staff.id,
			title: "Morning brief",
			prompt: "Summarise what changed.",
			triggers: routine().triggers,
			effort: "high" as const,
			sponsorBindingId: routine().sponsorBindingId,
			sponsorVersion: 1,
			enabled: true,
		};
		await expect(
			new CloudRoutineClient(rpc).save(unsaid as CloudRoutineSaveInput, new AbortController().signal),
		).rejects.toThrow("Invalid routine effort");
		expect(rpc).not.toHaveBeenCalled();
	});
	it("offers no Edit for a routine the editor cannot show, so a save cannot drop part of it", async () => {
		const windowed = routine({
			routineId: "10000000-0000-4000-8000-000000000010",
			title: "Office hours",
			triggers: [
				{
					id: "w",
					kind: "schedule",
					intervalMinutes: 30,
					weekdays: ["monday"],
					windowStart: "09:00",
					windowEnd: "17:00",
					timeZone: "Europe/Copenhagen",
				},
			],
		});
		const two = routine({
			routineId: "10000000-0000-4000-8000-000000000011",
			title: "Twice",
			triggers: [
				routine().triggers[0]!,
				{ id: "f", kind: "listener", source: "company-file", path: "finance", match: "subtree", timeZone: "UTC" },
			],
		});
		const hooked = routine({
			routineId: "10000000-0000-4000-8000-000000000012",
			title: "New orders",
			triggers: [
				{
					id: "e",
					kind: "listener",
					source: "event",
					hookId: "10000000-0000-4000-8000-0000000000a1",
					timeZone: "UTC",
				},
			],
		});
		const f = mount([routine(), windowed, two, hooked]);
		await settle();
		expect(cards(f.view.el).map(controls)).toEqual([
			["Edit", "switch:true"],
			["switch:true"],
			["switch:true"],
			["switch:true"],
		]);
		expect(cards(f.view.el)[3]!.textContent).toContain("When a hook receives an event");
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
	it("pauses a routine with its switch and offers no controls to a member who cannot manage", async () => {
		const f = mount([routine()]);
		await settle();
		const lever = f.view.el.querySelector('[role="switch"]')!;
		click(f.view.el, "Morning brief");
		// The switch moves at once, before the cloud answers, and in place, so it slides.
		expect(f.view.el.querySelector('[role="switch"]')).toBe(lever);
		expect(controls(cards(f.view.el)[0]!)).toEqual(["Edit", "switch:false"]);
		expect(lever.getAttribute("aria-busy")).toBe("true");
		expect(lever.getAttribute("title")).toBe("Resume routine");
		await settle();
		expect(f.routines.setEnabled).toHaveBeenCalledWith(
			expect.objectContaining({ title: "Morning brief" }),
			account,
			false,
			expect.any(String),
		);
		const readOnly = mount([routine()], false);
		await settle();
		const card = cards(readOnly.view.el)[0]!;
		expect(controls(card)).toEqual(["switch:true"]);
		const locked = card.querySelector('[role="switch"]')!;
		expect(locked.getAttribute("aria-disabled")).toBe("true");
		expect(locked.classList.contains("is-locked")).toBe(true);
		expect(locked.getAttribute("title")).toBe("Only owners and admins can pause or resume routines.");
		(locked as HTMLButtonElement).click();
		await settle();
		expect(readOnly.routines.setEnabled).not.toHaveBeenCalled();
		expect([...readOnly.view.el.querySelectorAll("button")].map((item) => item.textContent)).not.toContain(
			"New routine",
		);
	});
	it("shows the switch as the cloud reads it after a change, and where it was moved while no read has come back", async () => {
		const other = routine({
			routineId: "10000000-0000-4000-8000-000000000017",
			clientRoutineId: "10000000-0000-4000-8000-000000000018",
			title: "Evening wrap",
		});
		const f = mount([routine(), other]);
		await settle();
		let release!: () => void;
		f.routines.setEnabled.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		click(f.view.el, "Morning brief");
		await settle();
		// While one switch moves, the others and Edit wait; clicking another does nothing.
		const [, second] = cards(f.view.el);
		expect(second!.querySelector('[role="switch"]')?.getAttribute("aria-disabled")).toBe("true");
		expect(second!.querySelector<HTMLButtonElement>(".routine-card-edit")?.disabled).toBe(true);
		click(f.view.el, "Evening wrap");
		expect(f.routines.setEnabled).toHaveBeenCalledTimes(1);
		// The change went through, but the read after it failed: the switch stays where it was moved.
		f.routines.list.mockRejectedValueOnce(new Error("offline"));
		release();
		await settle();
		expect(controls(cards(f.view.el)[0]!)).toEqual(["Edit", "switch:false"]);
		expect(controls(cards(f.view.el)[1]!)).toEqual(["Edit", "switch:true"]);
		expect(f.view.el.querySelector(".surface-status")?.textContent).toBe(
			"Routines could not be read. Refresh to try again.",
		);
		// The next read that answers decides.
		f.routines.list.mockResolvedValue([routine({ status: "paused" }), other]);
		f.view.refresh();
		await settle();
		expect(controls(cards(f.view.el)[0]!)).toEqual(["Edit", "switch:false"]);
		expect(cards(f.view.el)[0]!.querySelector('[role="switch"]')?.getAttribute("title")).toBe("Resume routine");
		f.routines.list.mockResolvedValue([routine(), other]);
		f.view.refresh();
		await settle();
		expect(controls(cards(f.view.el)[0]!)).toEqual(["Edit", "switch:true"]);
	});
	it("keeps a moved switch through a list read that went out before the change", async () => {
		const f = mount([routine()]);
		await settle();
		const held: Array<(items: CloudRoutine[]) => void> = [];
		const hold = () =>
			new Promise<CloudRoutine[]>((resolve) => {
				held.push(resolve);
			});
		// The read sent before the change, and the one the change sends afterwards.
		f.routines.list.mockImplementationOnce(hold).mockImplementationOnce(hold);
		f.view.refresh();
		click(f.view.el, "Morning brief");
		await settle();
		expect(f.routines.setEnabled).toHaveBeenCalledTimes(1);
		expect(held).toHaveLength(2);
		// The earlier read answers after the change went through, with the routine as it was.
		held[0]!([routine()]);
		await settle();
		expect(controls(cards(f.view.el)[0]!)).toEqual(["Edit", "switch:false"]);
		// The read after the change decides.
		held[1]!([routine({ status: "paused" })]);
		await settle();
		expect(controls(cards(f.view.el)[0]!)).toEqual(["Edit", "switch:false"]);
		f.routines.list.mockResolvedValue([routine()]);
		f.view.refresh();
		await settle();
		expect(controls(cards(f.view.el)[0]!)).toEqual(["Edit", "switch:true"]);
	});
	it("puts a switch back where it was moved when a second change fails before any read confirms the first", async () => {
		const f = mount([routine()]);
		await settle();
		// The pause goes through, but the read after it fails: the switch stays off.
		f.routines.list.mockRejectedValueOnce(new Error("offline"));
		click(f.view.el, "Morning brief");
		await settle();
		expect(controls(cards(f.view.el)[0]!)).toEqual(["Edit", "switch:false"]);
		// Turning it back on fails, and so does the read after it: it stays off, as the routine is.
		f.routines.setEnabled.mockRejectedValueOnce(new Error("offline"));
		f.routines.list.mockRejectedValueOnce(new Error("offline"));
		click(f.view.el, "Morning brief");
		await settle();
		expect(f.routines.setEnabled).toHaveBeenLastCalledWith(expect.anything(), account, true, expect.any(String));
		expect(controls(cards(f.view.el)[0]!)).toEqual(["Edit", "switch:false"]);
		expect(f.view.el.querySelector(".surface-status")?.textContent).toBe(
			"The routine could not be changed. Try again.",
		);
	});
	it("drops a list read that answers after a newer one", async () => {
		const f = mount([routine()]);
		await settle();
		const held: Array<(items: CloudRoutine[]) => void> = [];
		f.routines.list.mockImplementationOnce(
			() =>
				new Promise<CloudRoutine[]>((resolve) => {
					held.push(resolve);
				}),
		);
		f.view.refresh();
		// The change and the read after it both answer before the older read does.
		f.routines.list.mockResolvedValue([routine({ status: "paused" })]);
		click(f.view.el, "Morning brief");
		await settle();
		expect(controls(cards(f.view.el)[0]!)).toEqual(["Edit", "switch:false"]);
		held[0]!([routine()]);
		await settle();
		expect(controls(cards(f.view.el)[0]!)).toEqual(["Edit", "switch:false"]);
	});
	it.each([
		["while the read after the change is still out", "held"],
		["when the read after the change failed", "failed"],
	] as const)("an editor save keeps a switch the member just turned off, %s", async (_, read) => {
		const f = mount([routine()]);
		await settle();
		const held: Array<(items: CloudRoutine[]) => void> = [];
		if (read === "held")
			f.routines.list.mockImplementationOnce(
				() =>
					new Promise<CloudRoutine[]>((resolve) => {
						held.push(resolve);
					}),
			);
		else f.routines.list.mockRejectedValueOnce(new Error("offline"));
		click(f.view.el, "Morning brief");
		await settle();
		click(f.view.el, "Edit");
		await settle();
		f.view.el.querySelector<HTMLTextAreaElement>('[aria-label="What to do"]')!.value =
			"Summarise what changed, briefly.";
		click(f.view.el, "Save routine");
		await settle();
		expect(f.routines.save).toHaveBeenCalledTimes(1);
		const [draft] = f.routines.save.mock.calls[0] as unknown as [{ enabled: boolean; prompt: string }];
		expect(draft).toMatchObject({ enabled: false, prompt: "Summarise what changed, briefly." });
	});
	it("keeps focus on a switch through the redraw after its change", async () => {
		const f = mount([routine()]);
		await settle();
		f.view.el.querySelector<HTMLElement>('[role="switch"]')!.focus();
		click(f.view.el, "Morning brief");
		await settle();
		f.routines.list.mockResolvedValue([routine({ status: "paused" })]);
		f.view.refresh();
		await settle();
		const lever = f.view.el.querySelector('[role="switch"]');
		expect(document.activeElement).toBe(lever);
		expect(lever?.getAttribute("aria-checked")).toBe("false");
	});
	it("keeps saying why when the model accounts could not be read for a switch", async () => {
		const routines = {
			list: vi.fn(async () => [routine()]),
			runs: vi.fn(async (): Promise<CloudRoutineOccurrence[]> => []),
			save: vi.fn(async () => {}),
			setEnabled: vi.fn(async () => {}),
		} satisfies WebRoutines;
		const view = new AgentRoutines(
			() => staff,
			{
				routines,
				accounts: async () => {
					throw new Error("offline");
				},
				canManage: () => true,
			},
			new AbortController().signal,
		);
		document.body.append(view.el);
		await settle();
		click(view.el, "Morning brief");
		await settle();
		expect(routines.setEnabled).not.toHaveBeenCalled();
		expect(controls(cards(view.el)[0]!)).toEqual(["Edit", "switch:true"]);
		expect(view.el.querySelector(".surface-status")?.textContent).toBe(
			"Your model accounts could not be read. Try again.",
		);
	});
	it("puts a switch that could not be changed back, and keeps saying why", async () => {
		const f = mount([routine()]);
		await settle();
		f.routines.setEnabled.mockRejectedValueOnce(new Error("offline"));
		click(f.view.el, "Morning brief");
		await settle();
		expect(controls(cards(f.view.el)[0]!)).toEqual(["Edit", "switch:true"]);
		expect(f.view.el.querySelector(".surface-status")?.textContent).toBe(
			"The routine could not be changed. Try again.",
		);
	});
	it("opens one card at a time in place, with the instruction beside when it runs, the next run and the last", async () => {
		const other = routine({
			routineId: "10000000-0000-4000-8000-000000000014",
			clientRoutineId: "10000000-0000-4000-8000-000000000015",
			title: "Evening wrap",
			prompt: "Write down what is still open.\n\n1. Check the inbox.\n2. Note blockers.",
			nextRunAt: "2026-09-28T16:00:00.000Z",
		});
		const f = mount([routine(), other]);
		f.routines.runs.mockResolvedValue([
			{
				occurrenceId: "10000000-0000-4000-8000-000000000016",
				routineId: other.routineId,
				routineVersion: 1,
				triggerId: "t",
				scheduledFor: "2026-09-26T16:00:00.000Z",
				status: "completed",
				blockedReason: null,
				runId: null,
				createdAt: "2026-09-26T16:00:00.000Z",
				finishedAt: "2026-09-26T16:05:00.000Z",
			},
		]);
		// The first read went out when the page was built; read again with the run.
		await settle();
		f.view.refresh();
		await settle();
		const [first, second] = cards(f.view.el);
		const body = (card: Element) => card.querySelector(".routine-card-body")!;
		expect(first!.classList.contains("is-open")).toBe(false);
		expect(body(first!).hasAttribute("inert")).toBe(true);
		second!.querySelector<HTMLElement>(".routine-card-summary")!.click();
		expect(second!.classList.contains("is-open")).toBe(true);
		expect(second!.querySelector(".routine-card-summary")?.getAttribute("aria-expanded")).toBe("true");
		expect(body(second!).hasAttribute("inert")).toBe(false);
		// The instruction keeps its own lines.
		expect(second!.querySelector(".routine-card-prompt")?.textContent).toBe(other.prompt);
		const facts = second!.querySelector(".routine-card-facts")!.textContent!;
		expect(facts).toMatch(/When to runMon at 8:30\sAMEurope\/Copenhagen/);
		expect(facts).toContain("Next run");
		expect(facts).toMatch(/Last runFinished · /);
		// The switch and Edit act without opening or closing the card.
		second!.querySelector<HTMLElement>('[role="switch"]')!.click();
		first!.querySelector<HTMLElement>('[role="switch"]')!.click();
		await settle();
		const [firstAgain, secondAgain] = cards(f.view.el);
		expect(firstAgain!.classList.contains("is-open")).toBe(false);
		expect(secondAgain!.classList.contains("is-open")).toBe(true);
		// Opening another closes the first; the open one stays open through a refresh.
		firstAgain!.querySelector<HTMLElement>(".routine-card-head")!.click();
		expect(firstAgain!.classList.contains("is-open")).toBe(true);
		expect(secondAgain!.classList.contains("is-open")).toBe(false);
		expect(body(secondAgain!).hasAttribute("inert")).toBe(true);
		f.view.refresh();
		await settle();
		expect(cards(f.view.el).map((card) => card.classList.contains("is-open"))).toEqual([true, false]);
		cards(f.view.el)[0]!.querySelector<HTMLElement>(".routine-card-summary")!.click();
		expect(cards(f.view.el).some((card) => card.classList.contains("is-open"))).toBe(false);
	});
	it.each([
		[["monday", "tuesday", "wednesday", "thursday", "friday"], "Weekdays at 8:48"],
		[["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"], "Every day at 8:48"],
		[["saturday", "sunday"], "Weekends at 8:48"],
		[["friday", "monday"], "Mon, Fri at 8:48"],
	] as const)("says when %j runs in few words", async (weekdays, words) => {
		// The viewer reads times on the routine's own clock: no zone is named.
		localStorage.setItem("qorpera.web.time-zone", "Europe/Copenhagen");
		const f = mount([
			routine({
				triggers: [
					{
						id: "t",
						kind: "schedule",
						intervalMinutes: 1440,
						weekdays: [...weekdays],
						localTime: "08:48",
						timeZone: "Europe/Copenhagen",
					},
				],
			}),
		]);
		await settle();
		expect(f.view.el.querySelector(".routine-card-summary span")?.textContent).toMatch(new RegExp(`^${words}\\sAM$`));
	});
	it("names the routine's zone when the viewer's clock is another, beside the time it belongs to", async () => {
		localStorage.setItem("qorpera.web.time-zone", "America/New_York");
		const f = mount([
			routine({
				triggers: [
					routine().triggers[0]!,
					{
						id: "f",
						kind: "listener",
						source: "company-file",
						path: "finance/invoices",
						match: "exact",
						timeZone: "Europe/Copenhagen",
					},
				],
			}),
		]);
		await settle();
		expect(f.view.el.querySelector(".routine-card-summary span")?.textContent).toMatch(
			/^Mon at 8:30\sAM \(Europe\/Copenhagen\); When finance\/invoices changes$/,
		);
		expect(
			[...f.view.el.querySelectorAll(".routine-card-trigger")].map((item) => item.textContent?.replace(/\s/g, " ")),
		).toEqual(["Mon at 8:30 AMEurope/Copenhagen", "When finance/invoices changes"]);
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

describe("a member edit of an agent's routine", () => {
	// Monday 5 October, 08:30 in Copenhagen: the first run the agent held the routine back to.
	const firstRunAt = "2026-10-05T06:30:00.000Z";
	const weekly = {
		id: "agent",
		kind: "schedule",
		intervalMinutes: 1440,
		startAt: firstRunAt,
		weekdays: ["monday", "wednesday"],
		localTime: "08:30",
		timeZone: "Europe/Copenhagen",
		replyPolicy: "optional",
	} as const;
	const every = {
		id: "agent",
		kind: "schedule",
		intervalMinutes: 90,
		startAt: firstRunAt,
		replyPolicy: "silent",
	} as const;
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		// Half a minute before the hour: a new interval start rounds up to 11:00 however long a test takes.
		vi.setSystemTime(new Date("2026-09-25T09:59:30.000Z"));
		// Times show in the device's zone and jsdom's English.
		vi.stubEnv("TZ", "Europe/Copenhagen");
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});
	const type = (form: Element, label: string, value: string) => {
		const field = form.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
		field.value = value;
		field.dispatchEvent(new Event("input"));
	};
	const waiting = (form: Element) => form.querySelector<HTMLLabelElement>(".routine-wait")!;
	/** Edits the one routine with this trigger and returns what the cloud received. */
	async function saveEdited(trigger: unknown, change: (form: HTMLElement) => void) {
		const f = mountSaving([routine({ triggers: [parseCloudRoutineTrigger(trigger)] })]);
		await settle();
		click(f.view.el, "Edit");
		await settle();
		change(f.view.el);
		click(f.view.el, "Save routine");
		await vi.waitFor(() => expect(f.upserts).toHaveLength(1), { timeout: 3000 });
		f.stop.abort();
		return f.upserts[0]!;
	}

	it.each([
		["weekly", weekly],
		["every", every],
		[
			"file_change",
			{
				id: "agent",
				kind: "listener",
				source: "company-file",
				path: "finance/invoices",
				match: "subtree",
				timeZone: "Europe/Copenhagen",
				replyPolicy: "optional",
			},
		],
	] as const)("keeps a %s trigger as the agent set it when only the name changes", async (_, trigger) => {
		// A weekly routine lost the first-run date the agent chose, so the edit ran it at once.
		const upsert = await saveEdited(trigger, (form) => type(form, "Routine name", "Morning brief, shorter"));
		expect(upsert.p_title).toBe("Morning brief, shorter");
		expect(upsert.p_triggers).toEqual([trigger]);
	});
	it("moves a held first run with the clock time, so an earlier time still runs on the chosen day", async () => {
		const earlier = await saveEdited(weekly, (form) => {
			expect(waiting(form).hidden).toBe(false);
			expect(waiting(form).textContent).toMatch(/^Wait until Oct 5, 08:30.* before the first run$/);
			type(form, "Time", "08:00");
			expect(waiting(form).textContent).toMatch(/Oct 5, 08:00/);
		});
		// Monday 08:00 in Copenhagen; kept at 08:30, the first run would slip to Wednesday.
		expect(earlier.p_triggers).toEqual([{ ...weekly, localTime: "08:00", startAt: "2026-10-05T06:00:00.000Z" }]);
		const elsewhere = await saveEdited(weekly, (form) => type(form, "Time zone", "America/New_York"));
		expect(elsewhere.p_triggers).toEqual([
			{ ...weekly, timeZone: "America/New_York", startAt: "2026-10-05T12:30:00.000Z" },
		]);
	});
	it("keeps the agent's instant when the moved time has already passed that day", async () => {
		// 10:00 in Copenhagen on the held day; the agent held the first run until 15:00.
		vi.setSystemTime(new Date("2026-10-05T08:00:00.000Z"));
		const afternoon = { ...weekly, localTime: "15:00", startAt: "2026-10-05T13:00:00.000Z" } as const;
		const upsert = await saveEdited(afternoon, (form) => {
			type(form, "Time", "09:00");
			expect(waiting(form).textContent).toMatch(/^Wait until 03:00.PM before/);
		});
		// Moved to 09:00 it would lie behind the save and run the routine at once.
		expect(upsert.p_triggers).toEqual([{ ...afternoon, localTime: "09:00" }]);
	});
	it("leaves a held first run unmoved while the time or zone cannot be read", async () => {
		const upsert = await saveEdited(weekly, (form) => {
			type(form, "Time", "");
			expect(waiting(form).textContent).toMatch(/Oct 5, 08:30/);
			type(form, "Time", "08:30");
			// A zone this browser does not know; the cloud decides whether it is one.
			type(form, "Time zone", "Mars/Olympus");
			expect(waiting(form).textContent).toMatch(/Oct 5, 08:30/);
		});
		expect(upsert.p_triggers).toEqual([{ ...weekly, timeZone: "Mars/Olympus" }]);
	});
	it("lets a member drop a held first run, which never makes it later", async () => {
		const drop = (form: HTMLElement) => {
			waiting(form).querySelector("input")!.checked = false;
		};
		expect((await saveEdited(weekly, drop)).p_triggers).toEqual([{ ...weekly, startAt: undefined }]);
		// An interval starts within two minutes instead of one interval from now,
		expect((await saveEdited(every, drop)).p_triggers).toEqual([{ ...every, startAt: "2026-09-25T10:01:00.000Z" }]);
		const week = { ...every, intervalMinutes: 10080, startAt: "2026-09-27T10:00:00.000Z" } as const;
		expect((await saveEdited(week, drop)).p_triggers).toEqual([{ ...week, startAt: "2026-09-25T10:01:00.000Z" }]);
		// and a held start sooner than that stays.
		const shortly = { ...every, startAt: "2026-09-25T10:00:00.000Z" } as const;
		expect((await saveEdited(shortly, drop)).p_triggers).toEqual([shortly]);
	});
	it("offers no wait once the first run is reached, or for another kind of schedule", async () => {
		const reached = { ...weekly, startAt: "2026-09-21T06:30:00.000Z" };
		const past = await saveEdited(reached, (form) => expect(waiting(form).hidden).toBe(true));
		// Kept as it is: the scheduler ignores a weekly start it has passed.
		expect(past.p_triggers).toEqual([reached]);
		const switched = await saveEdited(weekly, (form) => {
			// Unchecked first: a hidden box no longer acts.
			waiting(form).querySelector("input")!.checked = false;
			const when = form.querySelector<HTMLSelectElement>('[aria-label="When it runs"]')!;
			when.value = "interval";
			when.dispatchEvent(new Event("change"));
			expect(waiting(form).hidden).toBe(true);
		});
		// The weekly date does not become the interval's anchor, and the interval starts one interval from now.
		expect(switched.p_triggers).toEqual([
			{
				id: "agent",
				kind: "schedule",
				intervalMinutes: 60,
				startAt: "2026-09-25T11:00:00.000Z",
				replyPolicy: "optional",
			},
		]);
	});
});

describe("routines on a ChatGPT plan (shown only when the member has one)", () => {
	const plan = (allowAutonomous: boolean) =>
		({
			...account,
			connectionId: "10000000-0000-4000-8000-000000000011",
			connectionVersion: 3,
			provider: "openai",
			providerAccountReference: "member@example.invalid",
			loginKind: "chatgpt_plan",
			allowAutonomous,
		}) as unknown as NativeMemberConnection;
	function mountPlan(items: CloudRoutine[], connections: NativeMemberConnection[]) {
		const calls: Array<[string, Record<string, unknown>]> = [];
		const cloud = {
			rpc: vi.fn(async (name: string, args: Record<string, unknown> = {}) => {
				calls.push([name, args]);
				if (name === "qorpera_consent_provider_connection_autonomous")
					return { connection_id: args.p_connection_id, allow_autonomous: true, version: 2 };
				if (name === "qorpera_create_member_execution_sponsor")
					return { binding_id: "10000000-0000-4000-8000-000000000005", version: 1 };
				if (name !== "qorpera_upsert_cloud_routine") throw new Error(`Unexpected call ${name}`);
				return {
					routine_id: "10000000-0000-4000-8000-000000000002",
					client_routine_id: args.p_client_routine_id,
					version: 2,
					status: "active",
				};
			}),
		} as unknown as Cloud;
		const stop = new AbortController();
		const routines = {
			...createWebRoutines(cloud, profileA, stop.signal, () => {}),
			list: vi.fn(async () => items),
			runs: vi.fn(async () => []),
		} satisfies WebRoutines;
		const view = new AgentRoutines(
			() => staff,
			{ routines, accounts: async () => ({ connections }), canManage: () => true },
			stop.signal,
		);
		document.body.append(view.el);
		return { calls, view, stop };
	}
	async function draft(view: AgentRoutines) {
		await settle();
		click(view.el, "New routine");
		await settle();
		view.el.querySelector<HTMLInputElement>('[aria-label="Routine name"]')!.value = "Weekly close";
		view.el.querySelector<HTMLTextAreaElement>('[aria-label="What to do"]')!.value = "Close the week.";
	}
	it("never turns on work while away for a plan: the editor says where to turn it on", async () => {
		const f = mountPlan([], [plan(false)]);
		await draft(f.view);
		const picker = f.view.el.querySelector<HTMLSelectElement>('[aria-label="Model account"]')!;
		expect(picker.selectedOptions[0]!.textContent).toBe("ChatGPT plan · member@example.invalid");
		expect(f.view.el.textContent).toContain(
			"Turn on “Work while you're away” for this ChatGPT plan in Settings first.",
		);
		click(f.view.el, "Save routine");
		await settle();
		// The editor's own refusal, on its status line (the note says the same).
		expect([...f.view.el.querySelectorAll("p.surface-status")].map((item) => item.textContent)).toContain(
			"Turn on “Work while you're away” for this ChatGPT plan in Settings first.",
		);
		expect(f.calls).toEqual([]);
		f.stop.abort();
	});
	it("binds a plan its member turned on without asking for consent again", async () => {
		const f = mountPlan([], [plan(true)]);
		await draft(f.view);
		expect(f.view.el.textContent).toContain(
			`${staff.displayName} uses your ChatGPT plan for this routine while you are away.`,
		);
		click(f.view.el, "Save routine");
		await vi.waitFor(() => expect(f.calls.map(([name]) => name)).toContain("qorpera_upsert_cloud_routine"), {
			timeout: 3000,
		});
		expect(f.calls.map(([name]) => name)).not.toContain("qorpera_consent_provider_connection_autonomous");
		expect(f.calls.find(([name]) => name === "qorpera_create_member_execution_sponsor")![1]).toMatchObject({
			p_provider_connection_id: "10000000-0000-4000-8000-000000000011",
			p_provider_connection_version: 3,
			p_allow_autonomous: true,
		});
		f.stop.abort();
	});
	it("keeps a file-change routine off a plan", async () => {
		const f = mountPlan(
			[
				routine({
					triggers: [
						parseCloudRoutineTrigger({
							id: "agent",
							kind: "listener",
							source: "company-file",
							path: "finance/invoices",
							match: "subtree",
							timeZone: "Europe/Copenhagen",
							replyPolicy: "optional",
						}),
					],
				}),
			],
			[plan(true)],
		);
		await settle();
		click(f.view.el, "Edit");
		await settle();
		click(f.view.el, "Save routine");
		await settle();
		expect(f.view.el.textContent).toContain(
			"A ChatGPT plan can't pay for routines that start on a file change or a webhook. Choose another account.",
		);
		expect(f.calls).toEqual([]);
		f.stop.abort();
	});
	/** The cloud over the real routines client, with the first routine write refused (the routine's
	 * own payer is not the member's), so the switch falls back to an account. */
	function fallbackRoutines() {
		const calls: string[] = [];
		let upserts = 0;
		const cloud = {
			rpc: vi.fn(async (name: string, args: Record<string, unknown> = {}) => {
				calls.push(name);
				if (name === "qorpera_consent_provider_connection_autonomous")
					return { connection_id: args.p_connection_id, allow_autonomous: true, version: 9 };
				if (name === "qorpera_create_member_execution_sponsor")
					return { binding_id: "10000000-0000-4000-8000-000000000005", version: 1 };
				if (name !== "qorpera_upsert_cloud_routine") throw new Error(`Unexpected call ${name}`);
				upserts += 1;
				if (upserts === 1) throw new Error("not your payer");
				return {
					routine_id: "10000000-0000-4000-8000-000000000002",
					client_routine_id: args.p_client_routine_id,
					version: 2,
					status: "active",
				};
			}),
		} as unknown as Cloud;
		return { calls, routines: createWebRoutines(cloud, profileA, new AbortController().signal, () => {}) };
	}
	const fileRoutine = () =>
		routine({
			triggers: [
				parseCloudRoutineTrigger({
					id: "agent",
					kind: "listener",
					source: "company-file",
					path: "finance/invoices",
					match: "subtree",
					timeZone: "Europe/Copenhagen",
					replyPolicy: "optional",
				}),
			],
		});
	it("never consents a plan on the switch's fallback, and never binds one for a file routine", async () => {
		let f = fallbackRoutines();
		await expect(f.routines.setEnabled(routine(), plan(false), true, crypto.randomUUID())).rejects.toThrow(
			"Turn on “Work while you're away”",
		);
		expect(f.calls).toEqual(["qorpera_upsert_cloud_routine"]);
		f = fallbackRoutines();
		await expect(f.routines.setEnabled(fileRoutine(), plan(true), true, crypto.randomUUID())).rejects.toThrow(
			"can't pay for routines that start on a file change",
		);
		expect(f.calls).toEqual(["qorpera_upsert_cloud_routine"]);
		// A Codex login falls back as before: consent, bind, save.
		f = fallbackRoutines();
		await f.routines.setEnabled(routine(), account, true, crypto.randomUUID());
		expect(f.calls).toEqual([
			"qorpera_upsert_cloud_routine",
			"qorpera_consent_provider_connection_autonomous",
			"qorpera_create_member_execution_sponsor",
			"qorpera_upsert_cloud_routine",
		]);
	});
	it("pauses or resumes on the routine's own payer first, falling back only to an account that can pay", async () => {
		// A Codex login comes before a plan for a file routine.
		const both = mount([fileRoutine()], true, [plan(true), account]);
		await settle();
		click(both.view.el, "Morning brief");
		await settle();
		expect(both.routines.setEnabled).toHaveBeenCalledWith(expect.anything(), account, false, expect.any(String));
		both.stop.abort();
		document.body.replaceChildren();
		// With only a plan that is not turned on, the routine's own payer still pauses it.
		const only = mount([routine()], true, [plan(false)]);
		await settle();
		click(only.view.el, "Morning brief");
		await settle();
		expect(only.routines.setEnabled).toHaveBeenCalledWith(expect.anything(), undefined, false, expect.any(String));
		expect(only.view.el.querySelector(".surface-status")).toBeNull();
		only.stop.abort();
		document.body.replaceChildren();
		// When the routine's own payer cannot, it says what to do.
		const refused = mount([routine()], true, [plan(false)]);
		refused.routines.setEnabled.mockRejectedValueOnce(new Error("not your payer"));
		await settle();
		click(refused.view.el, "Morning brief");
		await settle();
		expect(refused.view.el.querySelector(".surface-status")?.textContent).toBe(
			"Turn on “Work while you're away” for this ChatGPT plan in Settings first.",
		);
		refused.stop.abort();
		document.body.replaceChildren();
		const file = mount([fileRoutine()], true, [plan(true)]);
		file.routines.setEnabled.mockRejectedValueOnce(new Error("not your payer"));
		await settle();
		click(file.view.el, "Morning brief");
		await settle();
		expect(file.view.el.querySelector(".surface-status")?.textContent).toBe(
			"A ChatGPT plan can't pay for routines that start on a file change or a webhook.",
		);
		file.stop.abort();
	});
	it("keeps a file routine off a plan when it is saved directly, and its note says so as the trigger changes", async () => {
		const f = fallbackRoutines();
		await expect(
			f.routines.save(
				{
					clientRoutineId: "10000000-0000-4000-8000-000000000009",
					staffAgentId: staff.id,
					title: "Invoices",
					prompt: "File them.",
					trigger: fileRoutine().triggers[0]!,
					effort: "low",
					enabled: true,
				},
				plan(true),
				crypto.randomUUID(),
			),
		).rejects.toThrow("can't pay for routines that start on a file change");
		expect(f.calls).toEqual([]);
		const view = mountPlan([], [plan(true)]);
		await draft(view.view);
		const when = view.view.el.querySelector<HTMLSelectElement>('[aria-label="When it runs"]')!;
		when.value = "file";
		when.dispatchEvent(new Event("change"));
		expect(view.view.el.textContent).toContain(
			"A ChatGPT plan can't pay for routines that start on a file change or a webhook. Choose another account.",
		);
		view.stop.abort();
	});
	it("offers a Codex login first and a plan without work while away last; a Codex login is consented as before", async () => {
		const f = mountPlan([], [plan(false), account]);
		await draft(f.view);
		const picker = f.view.el.querySelector<HTMLSelectElement>('[aria-label="Model account"]')!;
		expect([...picker.options].map((option) => option.value)).toEqual([
			account.connectionId,
			"10000000-0000-4000-8000-000000000011",
		]);
		click(f.view.el, "Save routine");
		await vi.waitFor(() => expect(f.calls.map(([name]) => name)).toContain("qorpera_upsert_cloud_routine"), {
			timeout: 3000,
		});
		expect(f.calls[0]).toEqual([
			"qorpera_consent_provider_connection_autonomous",
			{ p_profile_id: profileA.profileId, p_connection_id: account.connectionId, p_allow_autonomous: true },
		]);
		f.stop.abort();
	});
});
