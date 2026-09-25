// @vitest-environment jsdom
import type { NativeMemberConnection } from "@qorpera/cloud-client/cloud-native-subscription-control";
import {
	type CloudRoutine,
	CloudRoutineClient,
	describeCloudRoutineTrigger,
	parseCloudRoutine,
	parseCloudRoutineTrigger,
} from "@qorpera/cloud-client/cloud-routines";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRoutines } from "../src/app/views/agent-routines.ts";
import type { Cloud } from "../src/cloud/client.ts";
import { createWebRoutines, type WebRoutines } from "../src/cloud/routines.ts";
import { setLanguagePreference, setTimeZonePreference } from "../src/ui/preferences.ts";
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
		setLanguagePreference("en");
		setTimeZonePreference("Europe/Copenhagen");
	});
	afterEach(() => {
		vi.useRealTimers();
		localStorage.clear();
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
			const when = form.querySelector<HTMLSelectElement>('[aria-label="When it runs"]')!;
			when.value = "interval";
			when.dispatchEvent(new Event("change"));
			expect(waiting(form).hidden).toBe(true);
		});
		// The weekly date does not become the interval's anchor.
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
