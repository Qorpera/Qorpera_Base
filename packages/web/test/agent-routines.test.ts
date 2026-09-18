// @vitest-environment jsdom
import type { NativeMemberConnection } from "@qorpera/cloud-client/cloud-native-subscription-control";
import {
	type CloudRoutine,
	describeCloudRoutineTrigger,
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
	...update,
});
function mount(items: CloudRoutine[], manage = true) {
	const routines = {
		list: vi.fn(async () => items),
		runs: vi.fn(async () => []),
		save: vi.fn(async () => {}),
		setEnabled: vi.fn(async () => {}),
	} satisfies WebRoutines;
	const stop = new AbortController();
	const view = new AgentRoutines(
		staff,
		{ routines, accounts: async () => ({ connections: [account] }), canManage: () => manage },
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
	it("saves a new weekday routine on the chosen account with one stable identity across a retry", async () => {
		const f = mount([]);
		await settle();
		click(f.view.el, "Create routine");
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
		expect([...readOnly.view.el.querySelectorAll("button")].map((item) => item.textContent)).not.toContain("Pause");
		expect(readOnly.view.el.querySelector<HTMLButtonElement>('[aria-label="Create routine"]')!.disabled).toBe(true);
	});
});
