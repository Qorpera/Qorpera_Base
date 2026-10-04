// @vitest-environment jsdom
import type { CloudMemberFolderCommit, CloudMemberFolderUnit } from "@qorpera/cloud-client/cloud-member-folder";
import type { NativeMemberConnection } from "@qorpera/cloud-client/cloud-native-subscription-control";
import { cloudRoutineTriggerOfFile, routineFileTrigger } from "@qorpera/cloud-client/cloud-routine-file";
import {
	type CloudRoutine,
	CloudRoutineClient,
	type CloudRoutineOccurrence,
	type CloudRoutineSaveInput,
	describeCloudRoutineTrigger,
	parseCloudRoutine,
	parseCloudRoutineTrigger,
} from "@qorpera/cloud-client/cloud-routines";
import {
	parseCompanyStateFile,
	type RoutineFile,
	writeAgentFile,
	writeRoutineFile,
} from "@qorpera/cloud-client/company-state-files";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanyController } from "../src/app/company.ts";
import { AgentRoutines, routineAccessFor } from "../src/app/views/agent-routines.ts";
import type { WorkspaceActions } from "../src/app/workspace-actions.ts";
import { type Cloud, CloudRpcError } from "../src/cloud/client.ts";
import { WebCompanyFolderRejectedError } from "../src/cloud/company-folder-writes.ts";
import type { WebMemberConnection } from "../src/cloud/native-subscription.ts";
import {
	createWebRoutines,
	parseRoutinePayer,
	type WebRoutine,
	WebRoutineChangedError,
	type WebRoutineDraft,
	WebRoutineEndedError,
	type WebRoutineFile,
	WebRoutineGoneError,
	WebRoutineLoginRefusedError,
	type WebRoutinePayer,
	type WebRoutines,
} from "../src/cloud/routines.ts";
import { fmtDate, fmtTime } from "../src/ui/dom.ts";
import { profileA, settle, staff } from "./fixtures.ts";
import { type FolderFake, folderFake } from "./folder-fake.ts";

const account = {
	connectionId: "10000000-0000-4000-8000-000000000001",
	connectionVersion: 1,
	provider: "openai-codex",
	connectionStatus: "active",
	authorizationState: "active",
	providerAccountReference: "owner@example.invalid",
} as unknown as NativeMemberConnection;
/** The routine's id in the index, and its file's own id (the index's client routine id). */
const ROUTINE_ID = "10000000-0000-4000-8000-000000000002";
const FILE_ID = "10000000-0000-4000-8000-000000000003";
/** Another routine's file id. */
const OTHER_FILE = "10000000-0000-4000-8000-0000000000e1";
/** The agent's folder in the company's folder, and the routine's file in it. */
const AGENT_PATH = "agents/nora/agent.md";
const PATH = "agents/nora/routines/morning-brief.md";
const CONSENT = "qorpera_consent_provider_connection_autonomous";
const SPONSOR = "qorpera_create_member_execution_sponsor";
const routine = (update: Partial<CloudRoutine> = {}): CloudRoutine => ({
	routineId: ROUTINE_ID,
	clientRoutineId: FILE_ID,
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
/** The routine's file, as the index's routine above reads it. */
function routineFile(update: Partial<Omit<RoutineFile, "kind">> = {}): Omit<RoutineFile, "kind"> {
	return {
		id: FILE_ID,
		title: "Morning brief",
		status: "active",
		trigger: { when: "weekly", days: ["mon"], time: "08:30", starts: null },
		timezone: "Europe/Copenhagen",
		ends: null,
		runs: null,
		quiet: null,
		effort: "low",
		reply: "required",
		conclusion: null,
		instructions: "Summarise what changed.",
		...update,
	};
}
const routineText = (update: Partial<Omit<RoutineFile, "kind">> = {}) => writeRoutineFile(routineFile(update));
function parsed(text: string | undefined, path = PATH): RoutineFile {
	const result = parseCompanyStateFile(path, text ?? "");
	if (!result?.ok || result.file.kind !== "routine")
		throw new Error(`${path} is not a routine: ${JSON.stringify(result)}`);
	return result.file;
}
/** The index's routine for a file, as the routine list reads it. */
function indexed(text: string, update: Partial<CloudRoutine> = {}): CloudRoutine {
	const file = parsed(text);
	return routine({
		title: file.title,
		prompt: file.instructions,
		triggers: [cloudRoutineTriggerOfFile(file)!],
		effort: file.effort,
		status: file.status,
		...update,
	});
}
/** A routine as the index lists it, for a pause or resume that reads the list again. */
const indexRow = (status: string) => ({
	routine_id: ROUTINE_ID,
	client_routine_id: FILE_ID,
	version: 1,
	status,
	staff_agent_id: staff.id,
	title: "Morning brief",
	prompt: "Summarise what changed.",
	triggers: [
		{
			id: "file",
			kind: "schedule",
			intervalMinutes: 1440,
			weekdays: ["monday"],
			localTime: "08:30",
			timeZone: "Europe/Copenhagen",
		},
	],
	effort: "low",
	sponsor_binding_id: "10000000-0000-4000-8000-000000000004",
	sponsor_version: 1,
	logical_computer_id: null,
	required_capability: "agent_turn",
	job_type: "agent_turn",
	publication_mode: "automatic",
	review_policy_key: null,
	reviewer_staff_ids: [],
	created_at: "2026-09-17T06:00:00.000Z",
	updated_at: "2026-09-17T06:00:00.000Z",
});
/** The company's folder with the agent's folder and, unless told otherwise, the routine's file. */
function seeded(options: { text?: string | null; routinesFolder?: boolean; listsRoutines?: boolean } = {}): FolderFake {
	const fake = folderFake({
		routineIds: (fileId) => (fileId === FILE_ID ? ROUTINE_ID : fileId),
		listsRoutines: options.listsRoutines ?? true,
	});
	fake.put(
		AGENT_PATH,
		writeAgentFile({
			id: staff.id,
			name: "Nora",
			role: "Designer",
			agentKind: "agent",
			status: "active",
			colour: null,
			figure: null,
			model: null,
			effort: null,
			instructions: "Design.",
		}),
	);
	if (options.routinesFolder !== false) fake.mkdir("agents/nora/routines");
	if (options.text !== null) fake.put(PATH, options.text ?? routineText());
	return fake;
}
/** The routines over a folder fake, as the web makes them. `log` has each cloud call and each commit in order; `more`
 * answers the calls the fake has no answer of its own for. */
function writer(
	fake: FolderFake,
	rows: () => unknown[] = () => [],
	more?: (name: string, args: Record<string, unknown>) => unknown,
) {
	const log: string[] = [];
	const calls: Array<[string, Record<string, unknown>]> = [];
	const commit = fake.folder.commit.getMockImplementation()!;
	fake.folder.commit.mockImplementation(async (...args) => {
		log.push("commit");
		return commit(...args);
	});
	const cloud = {
		rpc: vi.fn(async (name: string, args: Record<string, unknown> = {}) => {
			calls.push([name, args]);
			log.push(name);
			if (name === CONSENT) return { connection_id: args.p_connection_id, allow_autonomous: true, version: 2 };
			if (name === SPONSOR) return { binding_id: "10000000-0000-4000-8000-000000000005", version: 1 };
			if (name === "qorpera_list_cloud_routines") return rows();
			if (more) return more(name, args);
			throw new Error(`Unexpected call ${name}`);
		}),
	} as unknown as Cloud;
	const stop = new AbortController();
	return {
		log,
		calls,
		stop,
		routines: createWebRoutines(
			cloud,
			profileA,
			stop.signal,
			() => {},
			() => fake.folder,
		),
	};
}
/** What the editor opens for a listed routine, without a folder. */
function openedOf(item: CloudRoutine): WebRoutineFile {
	const [trigger] = item.triggers;
	const mapped = trigger ? routineFileTrigger(trigger) : null;
	const fields = routineFile({
		id: item.clientRoutineId,
		title: item.title,
		instructions: item.prompt,
		effort: item.effort as RoutineFile["effort"],
		reply: trigger?.replyPolicy ?? "required",
		...(mapped ? { trigger: mapped.trigger, timezone: mapped.timezone } : {}),
	});
	return {
		routineId: item.routineId,
		path: PATH,
		version: "f0000000-0000-4000-8000-000000000999",
		text: writeRoutineFile(fields),
		file: { kind: "routine", ...fields },
		...(mapped && trigger ? { trigger } : {}),
	};
}
/** Routine calls that answer at once: every listed routine has a file. */
function mocked(items: CloudRoutine[]) {
	return {
		list: vi.fn(async () => items),
		runs: vi.fn(async (): Promise<CloudRoutineOccurrence[]> => []),
		files: vi.fn(async (): Promise<ReadonlySet<string>> => new Set(items.map((item) => item.routineId))),
		open: vi.fn(async (item: CloudRoutine) => openedOf(item)),
		save: vi.fn(async (): Promise<"saved" | "unchanged"> => "saved"),
		setEnabled: vi.fn(async () => {}),
		// A cloud without the payer calls, unless a test says who pays.
		payer: vi.fn(async (_routineId: string): Promise<WebRoutinePayer | null> => null),
		setLogin: vi.fn(
			async (_routineId: string, _account: WebMemberConnection): Promise<WebRoutinePayer | null> => null,
		),
	} satisfies WebRoutines;
}
function mount(items: CloudRoutine[], manage = true, connections: NativeMemberConnection[] = [account]) {
	const routines = mocked(items);
	const stop = new AbortController();
	const view = new AgentRoutines(
		() => staff,
		{ routines, accounts: async () => ({ connections }), canManage: () => manage },
		stop.signal,
	);
	document.body.append(view.el);
	return { routines, view, stop };
}
/** The page over the real routines and a folder fake: the list is the index's (given here), the files the folder's. */
function mountFolder(
	items: CloudRoutine[],
	options: {
		fake?: FolderFake;
		connections?: NativeMemberConnection[];
		rows?: () => unknown[];
		more?: (name: string, args: Record<string, unknown>) => unknown;
		memberId?: string;
	} = {},
) {
	const fake = options.fake ?? seeded();
	const w = writer(fake, options.rows, options.more);
	const routines = {
		...w.routines,
		list: vi.fn(async () => items),
		runs: vi.fn(async (): Promise<CloudRoutineOccurrence[]> => []),
		open: vi.fn(w.routines.open),
		save: vi.fn(w.routines.save),
		setEnabled: vi.fn(w.routines.setEnabled),
		// Who pays is read here, so the cloud's log has only what the member did; a test says who pays.
		payer: vi.fn(async (_routineId: string): Promise<WebRoutinePayer | null> => null),
		setLogin: vi.fn(w.routines.setLogin),
	} satisfies WebRoutines;
	const view = new AgentRoutines(
		() => staff,
		{
			routines,
			accounts: async () => ({ connections: options.connections ?? [account] }),
			canManage: () => true,
			...(options.memberId ? { memberId: options.memberId } : {}),
		},
		w.stop.signal,
	);
	document.body.append(view.el);
	return { ...w, fake, routines, view };
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
const field = <T extends HTMLElement = HTMLInputElement>(root: Element, label: string) =>
	root.querySelector<T>(`[aria-label="${label}"]`)!;
/** The editor's status line. */
const status = (root: Element) => root.querySelector(".routine-editor .surface-status")?.textContent;
/** Waits for the list's first read to show its routines. */
const listed = (view: AgentRoutines) => vi.waitFor(() => expect(cards(view.el).length).toBeGreaterThan(0));
/** Opens the editor with this button and waits for its form. */
async function openEditor(view: AgentRoutines, label = "Edit") {
	await vi.waitFor(() =>
		expect([...view.el.querySelectorAll("button")].some((item) => item.textContent === label)).toBe(true),
	);
	click(view.el, label);
	await vi.waitFor(() => expect(view.el.querySelector(".routine-editor")).not.toBeNull());
}
/** A draft for a new routine, as the editor makes it. */
const newDraft = (update: Partial<WebRoutineDraft> = {}): WebRoutineDraft => ({
	clientRoutineId: "10000000-0000-4000-8000-0000000000d1",
	staffAgentId: staff.id,
	title: "Weekly close",
	prompt: "Close the week.",
	trigger: parseCloudRoutineTrigger({
		id: "new",
		kind: "schedule",
		intervalMinutes: 1440,
		weekdays: ["monday", "friday"],
		localTime: "16:00",
		timeZone: "Europe/Copenhagen",
	}),
	effort: "low",
	...update,
});
/** An edit's draft of an opened routine file. */
const editDraft = (opened: WebRoutineFile, update: Partial<WebRoutineDraft> = {}): WebRoutineDraft => ({
	clientRoutineId: opened.file.id,
	staffAgentId: staff.id,
	title: opened.file.title,
	prompt: opened.file.instructions,
	trigger: opened.trigger!,
	effort: opened.file.effort,
	opened,
	...update,
});
/** Each unit of a change set as its op and path. */
const paths = (units: readonly CloudMemberFolderUnit[]) =>
	units.map((unit) => [unit.op, unit.op === "move" ? unit.from : unit.path]);
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
					routines: mocked([...items]),
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
			() => folderFake().folder,
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
	it("saves a new weekday routine on the chosen account, as the same save across a retry", async () => {
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
		const [first, second] = f.routines.save.mock.calls as unknown as Array<[WebRoutineDraft, unknown, string]>;
		expect(second![0].clientRoutineId).toBe(first![0].clientRoutineId);
		// The same save id: a change set whose answer never came goes again as it was.
		expect(second![2]).toBe(first![2]);
		expect(second![1]).toBe(account);
		expect(second![0].opened).toBeUndefined();
		expect(second![0]).toMatchObject({
			effort: "low",
			trigger: {
				kind: "schedule",
				weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
				localTime: "09:00",
			},
		});
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
		// A pause needs no login.
		expect(f.routines.setEnabled).toHaveBeenCalledWith(
			expect.objectContaining({ title: "Morning brief" }),
			undefined,
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
	it("says why a paused routine waits, and keeps an archived agent's switch off until the agent is back", async () => {
		const paused = (n: number, pauseReason?: string): WebRoutine => ({
			...routine({
				routineId: `10000000-0000-4000-8000-00000000010${n}`,
				clientRoutineId: `10000000-0000-4000-8000-00000000020${n}`,
				title: `Routine ${n}`,
				status: "paused",
			}),
			...(pauseReason ? { pauseReason } : {}),
		});
		const items = [
			paused(1, "member"),
			paused(2, "agent"),
			paused(3, "authorization_failed"),
			paused(4, "needs_model_account"),
			paused(5, "agent_archived"),
			paused(6, "something_new"),
			paused(7),
		];
		const reasons = (root: Element) =>
			cards(root).map((card) => card.querySelector(".routine-card-paused")?.textContent ?? null);
		const f = mount(items);
		await settle();
		expect(reasons(f.view.el)).toEqual([
			"Paused by a member",
			`Paused by ${staff.displayName}`,
			"Paused: it could not start with the access it had",
			"Paused: no model account pays for it",
			"Paused when its agent was archived",
			null,
			null,
		]);
		// An active agent's paused routine resumes from its switch as before.
		const lever = cards(f.view.el)[4]!.querySelector('[role="switch"]')!;
		expect(lever.getAttribute("aria-disabled")).toBeNull();
		expect(lever.getAttribute("title")).toBe("Resume routine");

		// Under an archived agent a routine never runs: its switch is off and locked, and says what comes first.
		const routines = mocked([paused(5, "agent_archived"), routine()]);
		const view = new AgentRoutines(
			() => ({ ...staff, employmentStatus: "archived" }),
			{ routines, accounts: async () => ({ connections: [account] }), canManage: () => true },
			new AbortController().signal,
		);
		document.body.append(view.el);
		await settle();
		const [off, on] = cards(view.el).map((card) => card.querySelector<HTMLButtonElement>('[role="switch"]')!);
		expect(off!.getAttribute("aria-disabled")).toBe("true");
		expect(off!.classList.contains("is-locked")).toBe(true);
		expect(off!.getAttribute("title")).toBe("Reactivate the agent first");
		off!.click();
		await settle();
		expect(routines.setEnabled).not.toHaveBeenCalled();
		// A routine still on (until the cloud pauses it) can be paused.
		expect(on!.getAttribute("aria-disabled")).toBeNull();
		expect(on!.getAttribute("title")).toBe("Pause routine");
		on!.click();
		await settle();
		expect(routines.setEnabled).toHaveBeenCalledWith(
			expect.objectContaining({ title: "Morning brief" }),
			undefined,
			false,
			expect.any(String),
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
	it("an edit never writes the status: a routine the member just paused stays paused", async () => {
		const f = mountFolder([routine()]);
		await listed(f.view);
		click(f.view.el, "Morning brief");
		await vi.waitFor(() => expect(f.fake.commits).toHaveLength(1));
		expect(parsed(f.fake.text(PATH)).status).toBe("paused");
		await vi.waitFor(() => expect(f.view.el.querySelector('[role="switch"]')?.getAttribute("aria-busy")).toBeNull());
		await openEditor(f.view);
		f.view.el.querySelector<HTMLTextAreaElement>('[aria-label="What to do"]')!.value =
			"Summarise what changed, briefly.";
		click(f.view.el, "Save routine");
		await vi.waitFor(() => expect(f.fake.commits).toHaveLength(2));
		expect(parsed(f.fake.text(PATH))).toMatchObject({
			status: "paused",
			instructions: "Summarise what changed, briefly.",
		});
		f.stop.abort();
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
	it("reads the model accounts for a resume only, and keeps saying why when they could not be read", async () => {
		const routines = mocked([
			routine({ status: "paused" }),
			routine({
				routineId: "10000000-0000-4000-8000-000000000017",
				clientRoutineId: "10000000-0000-4000-8000-000000000018",
				title: "Evening wrap",
			}),
		]);
		const accounts = vi.fn(async () => {
			throw new Error("offline");
		});
		const view = new AgentRoutines(
			() => staff,
			{ routines, accounts, canManage: () => true },
			new AbortController().signal,
		);
		document.body.append(view.el);
		await settle();
		click(view.el, "Morning brief");
		await settle();
		expect(routines.setEnabled).not.toHaveBeenCalled();
		expect(controls(cards(view.el)[0]!)).toEqual(["Edit", "switch:false"]);
		expect(view.el.querySelector(".surface-status")?.textContent).toBe(
			"Your model accounts could not be read. Try again.",
		);
		// A pause needs no login: it goes ahead without the accounts.
		click(view.el, "Evening wrap");
		await settle();
		expect(routines.setEnabled).toHaveBeenCalledWith(
			expect.objectContaining({ title: "Evening wrap" }),
			undefined,
			false,
			expect.any(String),
		);
		expect(accounts).toHaveBeenCalledTimes(1);
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
		const routines = mocked([routine()]);
		const view = new AgentRoutines(
			() => staff,
			{ routines, accounts: async () => ({ connections: [account] }), canManage: () => true },
			new AbortController().signal,
			back,
		);
		document.body.append(view.el);
		await openEditor(view);
		expect(view.el.querySelector("h2")?.textContent).toBe("Edit routine");
		expect(routines.open).toHaveBeenCalledWith(expect.objectContaining({ routineId: ROUTINE_ID }));
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

describe("a new routine's file (P34r)", () => {
	it("writes the file in the agent's routines folder, its name from the title, after the consent and binding", async () => {
		const fake = seeded();
		fake.put(
			"agents/nora/routines/weekly-close.md",
			writeRoutineFile(routineFile({ id: OTHER_FILE, title: "Weekly close" })),
		);
		const f = mountFolder([], { fake });
		await openEditor(f.view, "New routine");
		field(f.view.el, "Routine name").value = "Weekly close";
		field<HTMLTextAreaElement>(f.view.el, "What to do").value = "Close the week.";
		click(f.view.el, "Save routine");
		await vi.waitFor(() => expect(fake.commits).toHaveLength(1));
		// The name is free among the listed routines' file names, without their .md.
		const path = "agents/nora/routines/weekly-close-2.md";
		const [commit] = fake.commits;
		expect(commit!.operationKey).toMatch(/^web:routine-create:[0-9a-f-]{36}$/);
		expect(commit!.units).toEqual([{ op: "write", path, text: expect.any(String) }]);
		// The reply and the effort are written out: a member's routine replies every time, at low effort.
		const text = (commit!.units[0] as { text: string }).text;
		expect(text).toContain("\nreply: required\n");
		expect(text).toContain("\neffort: low\n");
		const file = parsed(fake.text(path), path);
		expect(file).toMatchObject({
			title: "Weekly close",
			status: "active",
			trigger: { when: "weekly", days: ["mon", "tue", "wed", "thu", "fri"], time: "09:00", starts: null },
			effort: "low",
			reply: "required",
			instructions: "Close the week.",
		});
		expect(file.id).not.toBe(OTHER_FILE);
		expect(f.log).toEqual([CONSENT, SPONSOR, "commit"]);
		await vi.waitFor(() => expect(f.view.el.querySelector("h2")?.textContent).toBe("Routines"));
		f.stop.abort();
	});
	it("makes the routines folder first, in the same change set, when the agent has none", async () => {
		const fake = seeded({ routinesFolder: false, text: null });
		const f = writer(fake);
		await expect(f.routines.save(newDraft(), account, "save-1")).resolves.toBe("saved");
		expect(fake.commits.map((commit) => paths(commit.units))).toEqual([
			[
				["mkdir", "agents/nora/routines"],
				["write", "agents/nora/routines/weekly-close.md"],
			],
		]);
		expect(fake.kind("agents/nora/routines")).toBe("folder");
		expect(
			parsed(fake.text("agents/nora/routines/weekly-close.md"), "agents/nora/routines/weekly-close.md"),
		).toMatchObject({
			id: newDraft().clientRoutineId,
			trigger: { when: "weekly", days: ["mon", "fri"], time: "16:00", starts: null },
			timezone: "Europe/Copenhagen",
		});
	});
	it("reads each unit's outcome: a folder made since the read leaves the write saved; else it goes again without the mkdir", async () => {
		const fake = seeded({ routinesFolder: false, text: null });
		const read = fake.folder.read.getMockImplementation()!;
		fake.folder.read.mockImplementationOnce(async (...args) => {
			const answer = await read(...args);
			fake.mkdir("agents/nora/routines");
			return answer;
		});
		const f = writer(fake);
		await expect(f.routines.save(newDraft(), account, "save-1")).resolves.toBe("saved");
		expect(fake.commits).toHaveLength(1);
		expect(fake.has("agents/nora/routines/weekly-close.md")).toBe(true);

		// The mkdir is exists and the write was not saved: the folder is read again and the write goes alone.
		const other = seeded({ routinesFolder: false, text: null });
		const g = writer(other);
		other.folder.commit.mockImplementationOnce(async (_key, units) => {
			other.mkdir("agents/nora/routines");
			return {
				commitId: "10000000-0000-4000-8000-0000000000f1",
				seq: null,
				replay: false,
				units: units.map((unit, index) => ({
					unit: index + 1,
					op: unit.op,
					path: unit.op === "move" ? unit.from : unit.path,
					to: null,
					version: null,
					outcome: index === 0 ? "conflict" : "refused",
					reason: index === 0 ? "exists" : "parent_missing",
					problems: [],
				})),
			} satisfies CloudMemberFolderCommit;
		});
		await expect(g.routines.save(newDraft(), account, "save-1")).resolves.toBe("saved");
		const sent = other.folder.commit.mock.calls.map(([, units]) => paths(units));
		expect(sent).toEqual([
			[
				["mkdir", "agents/nora/routines"],
				["write", "agents/nora/routines/weekly-close.md"],
			],
			[["write", "agents/nora/routines/weekly-close.md"]],
		]);
	});
	it("takes the next name, with a new operation key, when another writer took the file since the listing", async () => {
		const fake = seeded({ text: null });
		const list = fake.folder.list.getMockImplementation()!;
		fake.folder.list.mockImplementationOnce(async (...args) => {
			const page = await list(...args);
			fake.put(
				"agents/nora/routines/weekly-close.md",
				writeRoutineFile(routineFile({ id: OTHER_FILE, title: "Weekly close" })),
			);
			return page;
		});
		const f = writer(fake);
		await expect(f.routines.save(newDraft(), account, "save-1")).resolves.toBe("saved");
		expect(fake.commits.map((commit) => paths(commit.units))).toEqual([
			[["write", "agents/nora/routines/weekly-close.md"]],
			[["write", "agents/nora/routines/weekly-close-2.md"]],
		]);
		expect(fake.commits[1]!.operationKey).not.toBe(fake.commits[0]!.operationKey);
		expect(parsed(fake.text("agents/nora/routines/weekly-close.md"), "agents/nora/routines/weekly-close.md").id).toBe(
			OTHER_FILE,
		);
		expect(
			parsed(fake.text("agents/nora/routines/weekly-close-2.md"), "agents/nora/routines/weekly-close-2.md").id,
		).toBe(newDraft().clientRoutineId);
	});
	it("sends a change set whose answer was lost again as it was; a file there with the draft's id is this routine", async () => {
		const fake = seeded({ text: null });
		const f = writer(fake);
		fake.loseAnswer();
		await expect(f.routines.save(newDraft(), account, "save-1")).rejects.toThrow("Failed to fetch");
		await expect(f.routines.save(newDraft(), account, "save-1")).resolves.toBe("saved");
		expect(fake.commits).toHaveLength(2);
		expect(fake.commits[1]).toEqual(fake.commits[0]);
		expect(fake.children("agents/nora/routines")).toEqual(["agents/nora/routines/weekly-close.md"]);
		// A save that does not know that change set finds the draft's id at the name it takes: it is saved.
		fake.folder.list.mockResolvedValueOnce({ asOfSeq: fake.seq, entries: [], next: null });
		await expect(f.routines.save(newDraft(), account, "save-2")).resolves.toBe("saved");
		expect(fake.commits).toHaveLength(3);
		expect(fake.children("agents/nora/routines")).toEqual(["agents/nora/routines/weekly-close.md"]);
	});
	it("saves a new routine whose answer was lost with the next Save, as one file, and the list comes back", async () => {
		const fake = seeded({ text: null });
		const f = mountFolder([], { fake });
		await openEditor(f.view, "New routine");
		field(f.view.el, "Routine name").value = "Weekly close";
		field<HTMLTextAreaElement>(f.view.el, "What to do").value = "Close the week.";
		fake.loseAnswer();
		click(f.view.el, "Save routine");
		await vi.waitFor(() =>
			expect(status(f.view.el)).toBe("The routine could not be saved. Your draft is still here."),
		);
		click(f.view.el, "Save routine");
		await vi.waitFor(() => expect(f.view.el.querySelector("h2")?.textContent).toBe("Routines"));
		// The second Save sends the same change set again, under its key: a replay of the routine it made.
		expect(fake.commits).toHaveLength(2);
		expect(fake.commits[1]).toEqual(fake.commits[0]);
		expect(fake.children("agents/nora/routines")).toEqual(["agents/nora/routines/weekly-close.md"]);
		expect(f.view.el.textContent).not.toContain("Nothing changed.");
		f.stop.abort();
	});
	it("is saved when a lost change set's replay saved the routine, though the draft's change since adds nothing", async () => {
		const fake = seeded({ text: null });
		const f = writer(fake);
		fake.loseAnswer();
		await expect(f.routines.save(newDraft(), account, "save-1")).rejects.toThrow("Failed to fetch");
		// Another trigger id is the same draft (the file does not keep it); a title the file trims makes the same file.
		const again = newDraft({ title: "Weekly close ", trigger: { ...newDraft().trigger, id: "another" } });
		await expect(f.routines.save(again, account, "save-1")).resolves.toBe("saved");
		expect(fake.commits).toHaveLength(2);
		expect(fake.commits[1]).toEqual(fake.commits[0]);
		expect(fake.children("agents/nora/routines")).toEqual(["agents/nora/routines/weekly-close.md"]);
	});
	it("opens a new routine that a lost answer made on its file when someone changed it before the draft's change", async () => {
		const fake = seeded({ text: null });
		const f = mountFolder([], { fake });
		// The list is the index's: each routine file in the folder, by its index id and its file's id.
		f.routines.list.mockImplementation(async () =>
			(fake.stateFolders().routines ?? []).map((item) =>
				indexed(fake.text(item.file)!, {
					routineId: item.routineId,
					clientRoutineId: parsed(fake.text(item.file), item.file).id,
				}),
			),
		);
		await openEditor(f.view, "New routine");
		field(f.view.el, "Routine name").value = "Weekly close";
		field<HTMLTextAreaElement>(f.view.el, "What to do").value = "Close the week.";
		fake.loseAnswer();
		click(f.view.el, "Save routine");
		await vi.waitFor(() =>
			expect(status(f.view.el)).toBe("The routine could not be saved. Your draft is still here."),
		);
		// Someone renames the routine the lost answer made, and the member changes their draft.
		const made = "agents/nora/routines/weekly-close.md";
		const renamed = fake.put(made, fake.text(made)!.replace("title: Weekly close", "title: Friday close"));
		field<HTMLTextAreaElement>(f.view.el, "What to do").value = "Close the week, with totals.";
		click(f.view.el, "Save routine");
		// The replay is saved; the draft's change since meets the rename, and the form opens on the routine's file.
		await vi.waitFor(() => expect(status(f.view.el)).toBe("This routine changed while you were editing it."));
		expect(f.view.el.querySelector("h2")?.textContent).toBe("Edit routine");
		expect(field(f.view.el, "Routine name").value).toBe("Friday close");
		expect(field<HTMLTextAreaElement>(f.view.el, "What to do").value).toBe("Close the week.");
		expect(fake.commits).toHaveLength(3);
		expect(fake.commits[1]).toEqual(fake.commits[0]);
		expect(fake.children("agents/nora/routines")).toEqual([made]);
		// The next Save edits the file as it is now.
		field<HTMLTextAreaElement>(f.view.el, "What to do").value = "Close the week, with totals.";
		click(f.view.el, "Save routine");
		await vi.waitFor(() => expect(f.view.el.querySelector("h2")?.textContent).toBe("Routines"));
		expect(fake.commits).toHaveLength(4);
		expect(fake.commits[3]!.operationKey).toMatch(/^web:routine-update:/);
		expect(fake.commits[3]!.units).toEqual([
			{ op: "write", path: made, text: expect.any(String), expectedVersion: renamed },
		]);
		expect(parsed(fake.text(made), made)).toMatchObject({
			title: "Friday close",
			instructions: "Close the week, with totals.",
		});
		expect(fake.children("agents/nora/routines")).toEqual([made]);
		f.stop.abort();
	});
	it("saves no trigger a member's editor does not make, such as a file change", async () => {
		const fake = seeded({ text: null });
		const f = writer(fake);
		const trigger = parseCloudRoutineTrigger({
			id: "f",
			kind: "listener",
			source: "company-file",
			path: "finance/invoices",
			match: "subtree",
			timeZone: "UTC",
		});
		await expect(f.routines.save(newDraft({ trigger }), account, "save-1")).rejects.toThrow(
			"every few minutes or on chosen days",
		);
		expect(f.calls).toEqual([]);
		expect(fake.commits).toEqual([]);
	});
});

describe("an edit of a routine's file (P34r)", () => {
	it("rewrites only what the edit changes, and keeps every other byte", async () => {
		const before = routineText({
			ends: "2027-01-01T00:00:00Z",
			runs: 40,
			quiet: { start: "22:00", end: "07:00", timezone: "Europe/Copenhagen" },
			effort: "high",
			reply: "optional",
		}).replace("effort: high", "effort: high # the agent's choice");
		const fake = seeded({ text: before });
		const version = fake.version(PATH);
		const f = mountFolder([indexed(before)], { fake });
		await openEditor(f.view);
		// The form is the file's: an agent's effort shows, and stays.
		expect(f.view.el.textContent).toContain("Effort: High");
		expect(field<HTMLSelectElement>(f.view.el, "Reply").value).toBe("optional");
		field(f.view.el, "Routine name").value = "Morning digest";
		field<HTMLTextAreaElement>(f.view.el, "What to do").value = "Summarise what changed, in three lines.";
		click(f.view.el, "Save routine");
		await vi.waitFor(() => expect(fake.commits).toHaveLength(1));
		expect(fake.commits[0]!.operationKey).toMatch(/^web:routine-update:/);
		expect(fake.commits[0]!.units).toEqual([
			{ op: "write", path: PATH, text: expect.any(String), expectedVersion: version },
		]);
		expect(fake.text(PATH)).toBe(
			before
				.replace("title: Morning brief", "title: Morning digest")
				.replace("Summarise what changed.", "Summarise what changed, in three lines."),
		);
		expect(f.log).toEqual([CONSENT, SPONSOR, "commit"]);
		await vi.waitFor(() => expect(f.view.el.querySelector("h2")?.textContent).toBe("Routines"));
		f.stop.abort();
	});
	it("keeps the effort an agent chose, and a member's new routine starts at low", async () => {
		const text = routineText({ effort: "high" });
		const fake = seeded({ text });
		const f = mountFolder([indexed(text)], { fake });
		await openEditor(f.view);
		field(f.view.el, "Routine name").value = "Morning brief, shorter";
		click(f.view.el, "Save routine");
		await vi.waitFor(() => expect(fake.commits).toHaveLength(1));
		expect(parsed(fake.text(PATH))).toMatchObject({ title: "Morning brief, shorter", effort: "high" });
		await vi.waitFor(() => expect(f.view.el.querySelector("h2")?.textContent).toBe("Routines"));
		await openEditor(f.view, "New routine");
		expect(f.view.el.textContent).toContain("Effort: Low");
		field(f.view.el, "Routine name").value = "Weekly close";
		field<HTMLTextAreaElement>(f.view.el, "What to do").value = "Close the week.";
		click(f.view.el, "Save routine");
		await vi.waitFor(() => expect(fake.commits).toHaveLength(2));
		const made = "agents/nora/routines/weekly-close.md";
		expect(parsed(fake.text(made), made)).toMatchObject({ title: "Weekly close", effort: "low" });
		expect(parsed(fake.text(made), made).id).not.toBe(FILE_ID);
		f.stop.abort();
	});
	it("writes nothing when nothing changed, and asks for no login", async () => {
		const f = mountFolder([routine()]);
		await openEditor(f.view);
		click(f.view.el, "Save routine");
		await vi.waitFor(() => expect(status(f.view.el)).toBe("Nothing changed."));
		expect(f.fake.commits).toEqual([]);
		expect(f.calls).toEqual([]);
		expect(f.view.el.querySelector("h2")?.textContent).toBe("Edit routine");
		f.stop.abort();
	});
	it("retries a version_changed while what the form shows is as it opened, keeping the other change", async () => {
		const fake = seeded();
		const f = mountFolder([routine()], { fake });
		await openEditor(f.view);
		// Meanwhile someone pauses the routine and gives it quiet hours: nothing the form shows.
		const quiet = { start: "22:00", end: "07:00", timezone: "Europe/Copenhagen" };
		fake.put(PATH, routineText({ status: "paused", quiet }));
		field(f.view.el, "Routine name").value = "Morning digest";
		click(f.view.el, "Save routine");
		await vi.waitFor(() => expect(fake.commits).toHaveLength(2));
		expect(fake.commits[1]!.operationKey).not.toBe(fake.commits[0]!.operationKey);
		expect(parsed(fake.text(PATH))).toMatchObject({ title: "Morning digest", status: "paused", quiet });
		await vi.waitFor(() => expect(f.view.el.querySelector("h2")?.textContent).toBe("Routines"));
		f.stop.abort();
	});
	it("stops when someone changed what the form shows, and opens the form again on the file", async () => {
		const fake = seeded();
		const f = mountFolder([routine()], { fake });
		await openEditor(f.view);
		fake.put(PATH, routineText({ title: "Morning digest" }));
		field<HTMLTextAreaElement>(f.view.el, "What to do").value = "Summarise it all.";
		click(f.view.el, "Save routine");
		await vi.waitFor(() => expect(status(f.view.el)).toBe("This routine changed while you were editing it."));
		expect(fake.commits).toHaveLength(1);
		expect(field(f.view.el, "Routine name").value).toBe("Morning digest");
		expect(field<HTMLTextAreaElement>(f.view.el, "What to do").value).toBe("Summarise what changed.");
		expect(parsed(fake.text(PATH)).instructions).toBe("Summarise what changed.");
		f.stop.abort();
	});
	it("says why a refusal saved nothing, in the hook's words, under the editor", async () => {
		const f = mountFolder([routine()]);
		await openEditor(f.view);
		field(f.view.el, "Routine name").value = "Morning digest";
		f.fake.answer("refused", "structured_rule", ["timezone Mars/Olympus is not a time zone the database knows"]);
		click(f.view.el, "Save routine");
		await vi.waitFor(() =>
			expect(status(f.view.el)).toBe(
				"The routine could not be saved: timezone Mars/Olympus is not a time zone the database knows.",
			),
		);
		expect(parsed(f.fake.text(PATH)).title).toBe("Morning brief");
		f.stop.abort();
	});
	it("sends a change set again with its key after a transport failure; only an answer that saved nothing frees it", async () => {
		const fake = seeded();
		const f = writer(fake);
		const opened = await f.routines.open(routine());
		expect(opened).toMatchObject({ routineId: ROUTINE_ID, path: PATH, version: fake.version(PATH) });
		const draft = editDraft(opened, { title: "Morning digest" });
		fake.failCommit();
		await expect(f.routines.save(draft, account, "save-1")).rejects.toThrow("Failed to fetch");
		fake.answer("refused", "structured_rule", ["the title is not allowed"]);
		const refused = await f.routines.save(draft, account, "save-1").catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(WebCompanyFolderRejectedError);
		expect((refused as WebCompanyFolderRejectedError).problems).toEqual(["the title is not allowed"]);
		await expect(f.routines.save(draft, account, "save-1")).resolves.toBe("saved");
		const keys = fake.commits.map((commit) => commit.operationKey);
		expect(keys).toHaveLength(3);
		expect(keys[1]).toBe(keys[0]);
		expect(fake.commits[1]!.units).toEqual(fake.commits[0]!.units);
		expect(keys[2]).not.toBe(keys[1]);
		expect(parsed(fake.text(PATH)).title).toBe("Morning digest");
	});
	it("writes a draft changed after a lost answer on top of what that change set wrote", async () => {
		const fake = seeded();
		const f = writer(fake);
		const opened = await f.routines.open(routine());
		fake.loseAnswer();
		await expect(f.routines.save(editDraft(opened, { title: "Morning digest" }), account, "save-1")).rejects.toThrow(
			"Failed to fetch",
		);
		await expect(
			f.routines.save(editDraft(opened, { title: "Morning digest", prompt: "Brief me." }), account, "save-1"),
		).resolves.toBe("saved");
		expect(fake.commits).toHaveLength(3);
		expect(fake.commits[1]).toEqual(fake.commits[0]);
		expect(parsed(fake.text(PATH))).toMatchObject({ title: "Morning digest", instructions: "Brief me." });
	});
	it("checks a change made since a lost answer against what that change set wrote, at the version its replay gives", async () => {
		const fake = seeded();
		const f = writer(fake);
		const opened = await f.routines.open(routine());
		fake.loseAnswer();
		await expect(f.routines.save(editDraft(opened, { title: "Morning digest" }), account, "save-1")).rejects.toThrow(
			"Failed to fetch",
		);
		const written = fake.version(PATH);
		// Meanwhile someone changes what the form shows: the edit stops instead of writing over it.
		fake.put(PATH, routineText({ title: "Evening brief" }));
		const changed = editDraft(opened, { title: "Morning digest", prompt: "Brief me." });
		await expect(f.routines.save(changed, account, "save-1")).rejects.toBeInstanceOf(WebRoutineChangedError);
		expect(fake.commits).toHaveLength(3);
		expect(fake.commits[2]!.units).toEqual([
			{ op: "write", path: PATH, text: expect.any(String), expectedVersion: written },
		]);
		expect(parsed(fake.text(PATH))).toMatchObject({
			title: "Evening brief",
			instructions: "Summarise what changed.",
		});

		// A change to what the form does not show is kept under the edit.
		const other = seeded();
		const g = writer(other);
		const again = await g.routines.open(routine());
		other.loseAnswer();
		await expect(g.routines.save(editDraft(again, { title: "Morning digest" }), account, "save-2")).rejects.toThrow(
			"Failed to fetch",
		);
		other.put(PATH, routineText({ title: "Morning digest", status: "paused" }));
		await expect(
			g.routines.save(editDraft(again, { title: "Morning digest", prompt: "Brief me." }), account, "save-2"),
		).resolves.toBe("saved");
		expect(other.commits).toHaveLength(4);
		expect(parsed(other.text(PATH))).toMatchObject({
			title: "Morning digest",
			status: "paused",
			instructions: "Brief me.",
		});
	});
	it("forgets a save that failed with nothing unanswered: the next save with its id starts from what it opened", async () => {
		const fake = seeded();
		const f = writer(fake);
		const opened = await f.routines.open(routine());
		fake.answer("refused", "structured_rule", ["the title is not allowed"]);
		await expect(
			f.routines.save(editDraft(opened, { title: "Morning digest" }), account, "save-1"),
		).rejects.toBeInstanceOf(WebCompanyFolderRejectedError);
		// Someone renames the routine, and it is opened again: a save under the same id edits that read, not the first.
		fake.put(PATH, routineText({ title: "Evening brief" }));
		const reopened = await f.routines.open(routine());
		await expect(f.routines.save(editDraft(reopened, { prompt: "Brief me." }), account, "save-1")).resolves.toBe(
			"saved",
		);
		expect(fake.commits).toHaveLength(2);
		expect(parsed(fake.text(PATH))).toMatchObject({ title: "Evening brief", instructions: "Brief me." });
	});
});

describe("pausing and resuming a routine's file (P34r)", () => {
	it("pauses by writing status: paused with no login, and writes nothing when the file already says paused", async () => {
		const f = mountFolder([routine()]);
		await listed(f.view);
		const before = f.fake.text(PATH)!;
		click(f.view.el, "Morning brief");
		await vi.waitFor(() => expect(f.fake.commits).toHaveLength(1));
		expect(f.fake.text(PATH)).toBe(before.replace("status: active", "status: paused"));
		expect(f.fake.commits[0]!.operationKey).toMatch(/^web:routine-pause:/);
		expect(f.calls).toEqual([]);
		f.stop.abort();
		document.body.replaceChildren();

		const paused = mountFolder([routine()], { fake: seeded({ text: routineText({ status: "paused" }) }) });
		await listed(paused.view);
		click(paused.view.el, "Morning brief");
		await vi.waitFor(() => expect(paused.routines.setEnabled).toHaveBeenCalledTimes(1));
		await vi.waitFor(() =>
			expect(paused.view.el.querySelector('[role="switch"]')?.getAttribute("aria-busy")).toBeNull(),
		);
		expect(paused.fake.commits).toEqual([]);
		expect(paused.view.el.querySelector(".surface-status")).toBeNull();
		paused.stop.abort();
	});
	it("resumes after the consent and binding; an active file is saved as it is, ending a pause the index alone records", async () => {
		const f = mountFolder([routine({ status: "paused" })], {
			fake: seeded({ text: routineText({ status: "paused" }) }),
		});
		await listed(f.view);
		click(f.view.el, "Morning brief");
		await vi.waitFor(() => expect(f.fake.commits).toHaveLength(1));
		expect(parsed(f.fake.text(PATH)).status).toBe("active");
		expect(f.fake.commits[0]!.operationKey).toMatch(/^web:routine-resume:/);
		expect(f.log).toEqual([CONSENT, SPONSOR, "commit"]);
		f.stop.abort();
		document.body.replaceChildren();

		// No model account paid, so the platform paused it in the index only: the file still says active.
		const index = mountFolder([
			{ ...routine({ status: "paused" }), pauseReason: "needs_model_account" } as WebRoutine,
		]);
		await listed(index.view);
		const text = index.fake.text(PATH);
		const version = index.fake.version(PATH);
		click(index.view.el, "Morning brief");
		await vi.waitFor(() => expect(index.fake.commits).toHaveLength(1));
		expect(index.fake.commits[0]!.units).toEqual([{ op: "write", path: PATH, text, expectedVersion: version }]);
		expect(index.log).toEqual([CONSENT, SPONSOR, "commit"]);
		index.stop.abort();
	});
	it("says why the hook refused a resume, in its words, and puts the switch back", async () => {
		const f = mountFolder([routine({ status: "paused" })], {
			fake: seeded({ text: routineText({ status: "paused" }) }),
		});
		await listed(f.view);
		f.fake.answer("refused", "structured_rule", ["no login of yours pays for this routine's runs"]);
		click(f.view.el, "Morning brief");
		await vi.waitFor(() =>
			expect(f.view.el.querySelector(".surface-status")?.textContent).toBe(
				"The routine could not be changed: no login of yours pays for this routine's runs.",
			),
		);
		expect(controls(cards(f.view.el)[0]!)).toEqual(["Edit", "switch:false"]);
		expect(parsed(f.fake.text(PATH)).status).toBe("paused");
		f.stop.abort();
	});
	it("retries while the file is active or paused, and stops at a file concluded or a routine the index has ended", async () => {
		const rows = vi.fn(() => [indexRow("active")]);
		const fake = seeded();
		const f = writer(fake, rows);
		const commit = fake.folder.commit.getMockImplementation()!;
		// Someone renames the routine between the read and the pause.
		fake.folder.commit.mockImplementationOnce(async (...args) => {
			fake.put(PATH, routineText({ title: "Morning digest" }));
			return commit(...args);
		});
		await f.routines.setEnabled(routine(), undefined, false, "pause-1");
		expect(fake.commits.map((item) => item.operationKey)).toEqual([
			"web:routine-pause:pause-1:1",
			"web:routine-pause:pause-1:2",
		]);
		expect(parsed(fake.text(PATH))).toMatchObject({ title: "Morning digest", status: "paused" });
		expect(rows).toHaveBeenCalledTimes(1);

		// A file concluded meanwhile: nothing is written over it.
		fake.folder.commit.mockImplementationOnce(async (...args) => {
			fake.put(PATH, routineText({ status: "concluded", conclusion: "Done for the year." }));
			return commit(...args);
		});
		await expect(f.routines.setEnabled(routine(), account, true, "resume-1")).rejects.toBeInstanceOf(
			WebRoutineEndedError,
		);
		expect(parsed(fake.text(PATH)).status).toBe("concluded");

		// A routine the index now reads as expired stops too.
		fake.put(PATH, routineText({ status: "paused" }));
		rows.mockReturnValue([indexRow("expired")]);
		fake.folder.commit.mockImplementationOnce(async (...args) => {
			fake.put(PATH, routineText({ status: "paused", title: "Morning digest" }));
			return commit(...args);
		});
		const writes = fake.commits.length;
		await expect(f.routines.setEnabled(routine(), account, true, "resume-2")).rejects.toBeInstanceOf(
			WebRoutineEndedError,
		);
		expect(fake.commits).toHaveLength(writes + 1);
		expect(parsed(fake.text(PATH))).toMatchObject({ status: "paused", title: "Morning digest" });
	});
	it("leaves a routine without a file it can find read-only: no switch, no Edit", async () => {
		const other = routine({
			routineId: "10000000-0000-4000-8000-000000000017",
			clientRoutineId: "10000000-0000-4000-8000-000000000018",
			title: "Evening wrap",
		});
		const f = mountFolder([routine(), other]);
		await vi.waitFor(() => expect(cards(f.view.el)).toHaveLength(2));
		expect(cards(f.view.el).map(controls)).toEqual([["Edit", "switch:true"], []]);
		f.stop.abort();
		document.body.replaceChildren();

		// A cloud whose state folders read does not list routines' files yet: every routine is read-only.
		const older = mountFolder([routine()], { fake: seeded({ listsRoutines: false }) });
		await vi.waitFor(() => expect(cards(older.view.el)).toHaveLength(1));
		expect(cards(older.view.el).map(controls)).toEqual([[]]);
		await expect(older.routines.setEnabled(routine(), account, true, "resume-1")).rejects.toBeInstanceOf(
			WebRoutineGoneError,
		);
		await expect(older.routines.open(routine())).rejects.toBeInstanceOf(WebRoutineGoneError);
		expect(older.calls).toEqual([]);
		expect(older.fake.commits).toEqual([]);
		older.stop.abort();
		document.body.replaceChildren();

		// The files could not be read this time: the list still shows, read-only, without an error.
		const unread = seeded();
		unread.folder.stateFolders.mockRejectedValueOnce(new Error("Company folder is unavailable (503)"));
		const g = mountFolder([routine()], { fake: unread });
		await vi.waitFor(() => expect(cards(g.view.el)).toHaveLength(1));
		expect(cards(g.view.el).map(controls)).toEqual([[]]);
		expect(g.view.el.querySelector(".surface-status")).toBeNull();
		g.stop.abort();
	});
});

describe("the routine editor's choices", () => {
	it("offers every few minutes or days at a time, never a file change, and minutes from 5", async () => {
		const f = mount([]);
		await openEditor(f.view, "New routine");
		// The instructions may be as long as the file allows.
		expect(field<HTMLTextAreaElement>(f.view.el, "What to do").maxLength).toBe(32768);
		const when = field<HTMLSelectElement>(f.view.el, "When it runs");
		expect([...when.options].map((option) => option.value)).toEqual(["weekly", "interval"]);
		expect(f.view.el.querySelector('[aria-label="Company File path"]')).toBeNull();
		const every = field(f.view.el, "Interval");
		const unit = field<HTMLSelectElement>(f.view.el, "Interval unit");
		expect([unit.value, every.value, every.min, every.max]).toEqual(["hours", "1", "1", "168"]);
		for (const [name, bounds] of [
			["minutes", ["5", "10080"]],
			["days", ["1", "7"]],
		] as const) {
			unit.value = name;
			unit.dispatchEvent(new Event("change"));
			expect([every.min, every.max]).toEqual(bounds);
		}
		when.value = "interval";
		when.dispatchEvent(new Event("change"));
		unit.value = "minutes";
		every.value = "2";
		field(f.view.el, "Routine name").value = "Ping";
		field<HTMLTextAreaElement>(f.view.el, "What to do").value = "Check the inbox.";
		click(f.view.el, "Save routine");
		await settle();
		expect(status(f.view.el)).toBe("Choose an interval between 5 minutes and 7 days.");
		expect(f.routines.save).not.toHaveBeenCalled();
	});
	it("runs on the member's own account that works while they're away; the picker shows only when none is on", async () => {
		const on = {
			...account,
			connectionId: "10000000-0000-4000-8000-0000000000c1",
			connectionVersion: 4,
			providerAccountReference: "on@example.invalid",
			allowAutonomous: true,
		} as unknown as NativeMemberConnection;
		const claude = {
			...account,
			connectionId: "10000000-0000-4000-8000-0000000000c2",
			provider: "anthropic",
			nativeHarness: "claude-code",
			allowAutonomous: true,
		} as unknown as NativeMemberConnection;
		const f = mountFolder([], { fake: seeded({ text: null }), connections: [claude, account, on] });
		await openEditor(f.view, "New routine");
		expect(f.view.el.querySelector('[aria-label="Model account"]')).toBeNull();
		expect(f.view.el.textContent).toContain("This routine runs on your own account that works while you're away.");
		field(f.view.el, "Routine name").value = "Weekly close";
		field<HTMLTextAreaElement>(f.view.el, "What to do").value = "Close the week.";
		click(f.view.el, "Save routine");
		await vi.waitFor(() => expect(f.fake.commits).toHaveLength(1));
		// The account that is on gets today's idempotent consent and binding; a Claude login never pays.
		expect(f.calls[0]).toEqual([
			CONSENT,
			{ p_profile_id: profileA.profileId, p_connection_id: on.connectionId, p_allow_autonomous: true },
		]);
		f.stop.abort();
		document.body.replaceChildren();

		// None is on: the member chooses, and a Claude login is not offered.
		const g = mount([], true, [claude, account]);
		await openEditor(g.view, "New routine");
		const options = [...g.view.el.querySelectorAll<HTMLOptionElement>('[aria-label="Model account"] option')];
		expect(options.map((option) => option.value)).toEqual([account.connectionId]);
		expect(g.view.el.textContent).not.toContain("This routine runs on your own account");
	});
});

describe("a member edit of an agent's routine", () => {
	// Monday 5 October, 08:30 in Copenhagen: the first run the agent held the routine back to.
	const firstRunAt = "2026-10-05T06:30:00Z";
	const weekly = routineFile({
		trigger: { when: "weekly", days: ["mon", "wed"], time: "08:30", starts: firstRunAt },
		reply: "optional",
	});
	const every = routineFile({
		trigger: { when: "every", minutes: 90, starts: firstRunAt },
		timezone: null,
		reply: "silent",
	});
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
		const input = form.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
		input.value = value;
		input.dispatchEvent(new Event("input"));
	};
	const waiting = (form: Element) => form.querySelector<HTMLLabelElement>(".routine-wait")!;
	/** Edits the routine with this file and answers its text before and after, and the file as written. */
	async function saveEdited(file: Omit<RoutineFile, "kind">, change: (form: HTMLElement) => void) {
		const before = writeRoutineFile(file);
		const f = mountFolder([indexed(before)], { fake: seeded({ text: before }) });
		await openEditor(f.view);
		change(f.view.el);
		click(f.view.el, "Save routine");
		await vi.waitFor(() => expect(f.fake.commits).toHaveLength(1), { timeout: 3000 });
		f.stop.abort();
		document.body.replaceChildren();
		const after = f.fake.text(PATH)!;
		return { before, after, file: parsed(after) };
	}

	it.each([
		["weekly", weekly],
		["every", every],
		["every, without a first-run time", routineFile({ trigger: { when: "every", minutes: 90, starts: null } })],
	] as const)("keeps a %s trigger as the agent set it when only the name changes", async (_, file) => {
		// A weekly routine lost the first-run date the agent chose, so the edit ran it at once.
		const saved = await saveEdited(file, (form) => type(form, "Routine name", "Morning brief, shorter"));
		expect(saved.after).toBe(saved.before.replace("title: Morning brief", "title: Morning brief, shorter"));
	});
	it("moves a held first run with the clock time, so an earlier time still runs on the chosen day", async () => {
		const earlier = await saveEdited(weekly, (form) => {
			expect(waiting(form).hidden).toBe(false);
			expect(waiting(form).textContent).toMatch(/^Wait until Oct 5, 08:30.* before the first run$/);
			type(form, "Time", "08:00");
			expect(waiting(form).textContent).toMatch(/Oct 5, 08:00/);
		});
		// Monday 08:00 in Copenhagen; kept at 08:30, the first run would slip to Wednesday.
		expect(earlier.file.trigger).toEqual({
			when: "weekly",
			days: ["mon", "wed"],
			time: "08:00",
			starts: "2026-10-05T06:00:00Z",
		});
		const elsewhere = await saveEdited(weekly, (form) => type(form, "Time zone", "America/New_York"));
		expect(elsewhere.file).toMatchObject({
			timezone: "America/New_York",
			trigger: { ...weekly.trigger, starts: "2026-10-05T12:30:00Z" },
		});
	});
	it("keeps the agent's instant when the moved time has already passed that day", async () => {
		// 10:00 in Copenhagen on the held day; the agent held the first run until 15:00.
		vi.setSystemTime(new Date("2026-10-05T08:00:00.000Z"));
		const afternoon = routineFile({
			...weekly,
			trigger: { when: "weekly", days: ["mon", "wed"], time: "15:00", starts: "2026-10-05T13:00:00Z" },
		});
		const saved = await saveEdited(afternoon, (form) => {
			type(form, "Time", "09:00");
			expect(waiting(form).textContent).toMatch(/^Wait until 03:00.PM before/);
		});
		// Moved to 09:00 it would lie behind the save and run the routine at once.
		expect(saved.file.trigger).toEqual({ ...afternoon.trigger, time: "09:00" });
	});
	it("leaves a held first run unmoved while the time or zone cannot be read", async () => {
		const saved = await saveEdited(weekly, (form) => {
			type(form, "Time", "");
			expect(waiting(form).textContent).toMatch(/Oct 5, 08:30/);
			type(form, "Time", "08:30");
			// A zone this browser does not know; the cloud decides whether it is one.
			type(form, "Time zone", "Mars/Olympus");
			expect(waiting(form).textContent).toMatch(/Oct 5, 08:30/);
		});
		expect(saved.file).toMatchObject({ timezone: "Mars/Olympus", trigger: weekly.trigger });
	});
	it("lets a member drop a held first run, which removes it", async () => {
		const drop = (form: HTMLElement) => {
			waiting(form).querySelector("input")!.checked = false;
		};
		expect((await saveEdited(weekly, drop)).file.trigger).toEqual({ ...weekly.trigger, starts: null });
		expect((await saveEdited(every, drop)).file.trigger).toEqual({ when: "every", minutes: 90, starts: null });
		const week = routineFile({
			...every,
			trigger: { when: "every", minutes: 10080, starts: "2026-09-27T10:00:00Z" },
		});
		const dropped = await saveEdited(week, drop);
		expect(dropped.file.trigger).toEqual({ when: "every", minutes: 10080, starts: null });
		expect(dropped.after).not.toMatch(/^starts:/m);
	});
	it("starts a new interval one interval from now, and keeps a first run reached or of another kind of schedule", async () => {
		const longer = await saveEdited(every, (form) => type(form, "Interval", "120"));
		expect(longer.file.trigger).toEqual({ when: "every", minutes: 120, starts: "2026-09-25T12:00:00Z" });
		const reached = routineFile({
			...weekly,
			trigger: { when: "weekly", days: ["mon", "wed"], time: "08:30", starts: "2026-09-21T06:30:00Z" },
		});
		const past = await saveEdited(reached, (form) => {
			expect(waiting(form).hidden).toBe(true);
			type(form, "Routine name", "Morning brief, shorter");
		});
		// Kept as it is: the scheduler ignores a weekly start it has passed.
		expect(past.file.trigger).toEqual(reached.trigger);
		const switched = await saveEdited(weekly, (form) => {
			// Unchecked first: a hidden box no longer acts.
			waiting(form).querySelector("input")!.checked = false;
			const when = form.querySelector<HTMLSelectElement>('[aria-label="When it runs"]')!;
			when.value = "interval";
			when.dispatchEvent(new Event("change"));
			expect(waiting(form).hidden).toBe(true);
		});
		// The weekly date does not become the interval's anchor, and the interval starts one interval from now. The zone
		// stays: quiet hours without their own zone take it.
		expect(switched.file).toMatchObject({
			trigger: { when: "every", minutes: 60, starts: "2026-09-25T11:00:00Z" },
			timezone: "Europe/Copenhagen",
			reply: "optional",
		});
		expect(switched.after).not.toMatch(/^(days|time):/m);
	});
	it("offers an interval's own zone for days at a time, and keeps its quiet hours in the zone they go by", async () => {
		// The file keeps a zone that is not the viewer's, and its quiet hours have none of their own.
		const quiet = { start: "22:00", end: "07:00", timezone: "America/New_York" };
		const kept = routineFile({ ...every, timezone: "America/New_York", quiet });
		const toWeekly = (form: HTMLElement) => {
			const when = form.querySelector<HTMLSelectElement>('[aria-label="When it runs"]')!;
			when.value = "weekly";
			when.dispatchEvent(new Event("change"));
		};
		const same = await saveEdited(kept, (form) => {
			expect(form.querySelector<HTMLInputElement>('[aria-label="Time zone"]')!.value).toBe("America/New_York");
			toWeekly(form);
		});
		expect(same.file).toMatchObject({ trigger: { when: "weekly" }, timezone: "America/New_York", quiet });
		expect(same.after).not.toMatch(/^quiet_timezone:/m);
		// The member names another zone: the routine runs by it, and quiet hours stay as they were read.
		const moved = await saveEdited(kept, (form) => {
			toWeekly(form);
			type(form, "Time zone", "Europe/Copenhagen");
		});
		expect(moved.file).toMatchObject({ timezone: "Europe/Copenhagen", quiet });
		expect(moved.after).toMatch(/^quiet_timezone: America\/New_York$/m);
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
	async function draft(view: AgentRoutines) {
		await openEditor(view, "New routine");
		view.el.querySelector<HTMLInputElement>('[aria-label="Routine name"]')!.value = "Weekly close";
		view.el.querySelector<HTMLTextAreaElement>('[aria-label="What to do"]')!.value = "Close the week.";
	}
	const fileRoutine = (update: Partial<CloudRoutine> = {}) =>
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
			...update,
		});
	it("never turns on work while away for a plan: the editor says where to turn it on", async () => {
		const f = mountFolder([], { fake: seeded({ text: null }), connections: [plan(false)] });
		await draft(f.view);
		// A plan not turned on cannot pay, so there is nothing to choose.
		expect(f.view.el.querySelector('[aria-label="Model account"]')).toBeNull();
		expect(f.view.el.textContent).toContain(
			"Turn on “Work while you're away” for this ChatGPT plan in Settings first.",
		);
		click(f.view.el, "Save routine");
		await settle();
		expect(status(f.view.el)).toBe("Turn on “Work while you're away” for this ChatGPT plan in Settings first.");
		expect(f.calls).toEqual([]);
		expect(f.fake.commits).toEqual([]);
		f.stop.abort();
	});
	it("binds a plan its member turned on without asking for consent again", async () => {
		const f = mountFolder([], { fake: seeded({ text: null }), connections: [plan(true)] });
		await draft(f.view);
		expect(f.view.el.textContent).toContain("This routine runs on your own account that works while you're away.");
		click(f.view.el, "Save routine");
		await vi.waitFor(() => expect(f.fake.commits).toHaveLength(1), { timeout: 3000 });
		expect(f.calls.map(([name]) => name)).toEqual([SPONSOR]);
		expect(f.calls[0]![1]).toMatchObject({
			p_provider_connection_id: "10000000-0000-4000-8000-000000000011",
			p_provider_connection_version: 3,
			p_allow_autonomous: true,
		});
		f.stop.abort();
	});
	it("never consents a plan for a resume, and never binds one for a file routine", async () => {
		let f = writer(seeded({ text: routineText({ status: "paused" }) }));
		await expect(f.routines.setEnabled(routine({ status: "paused" }), plan(false), true, "r1")).rejects.toThrow(
			"Turn on “Work while you're away”",
		);
		expect(f.log).toEqual([]);
		f = writer(seeded({ text: routineText({ status: "paused" }) }));
		await expect(f.routines.setEnabled(fileRoutine({ status: "paused" }), plan(true), true, "r2")).rejects.toThrow(
			"can't pay for routines that start on a file change",
		);
		expect(f.log).toEqual([]);
		// A Codex login is consented and bound as before, then the file is written.
		f = writer(seeded({ text: routineText({ status: "paused" }) }));
		await f.routines.setEnabled(routine({ status: "paused" }), account, true, "r3");
		expect(f.log).toEqual([CONSENT, SPONSOR, "commit"]);
	});
	it("pauses with no account, resumes on the first account that can pay, and says what to do when none can", async () => {
		// A Codex login comes before a plan for a file routine.
		const both = mount([fileRoutine({ status: "paused" })], true, [plan(true), account]);
		await settle();
		click(both.view.el, "Morning brief");
		await settle();
		expect(both.routines.setEnabled).toHaveBeenCalledWith(expect.anything(), account, true, expect.any(String));
		both.stop.abort();
		document.body.replaceChildren();
		// A pause needs no login.
		const only = mount([routine()], true, [plan(false)]);
		await settle();
		click(only.view.el, "Morning brief");
		await settle();
		expect(only.routines.setEnabled).toHaveBeenCalledWith(expect.anything(), undefined, false, expect.any(String));
		expect(only.view.el.querySelector(".surface-status")).toBeNull();
		only.stop.abort();
		document.body.replaceChildren();
		for (const [items, connections, said] of [
			[
				[routine({ status: "paused" })],
				[plan(false)],
				"Turn on “Work while you're away” for this ChatGPT plan in Settings first.",
			],
			[
				[fileRoutine({ status: "paused" })],
				[plan(true)],
				"A ChatGPT plan can't pay for routines that start on a file change or a webhook.",
			],
			[
				[routine({ status: "paused" })],
				[],
				"Connect a model account in Settings first; a routine runs on the account of the member who last saved it.",
			],
		] as const) {
			const f = mount([...items], true, [...connections]);
			await settle();
			click(f.view.el, "Morning brief");
			await settle();
			expect(f.routines.setEnabled).not.toHaveBeenCalled();
			// The switch is back where it stood.
			expect(controls(cards(f.view.el)[0]!)).toContain("switch:false");
			expect(f.view.el.querySelector(".surface-status")?.textContent).toBe(said);
			f.stop.abort();
			document.body.replaceChildren();
		}
	});
	it("offers a Codex login, not a plan that is not turned on; a Codex login is consented as before", async () => {
		const f = mountFolder([], { fake: seeded({ text: null }), connections: [plan(false), account] });
		await draft(f.view);
		const picker = f.view.el.querySelector<HTMLSelectElement>('[aria-label="Model account"]')!;
		expect([...picker.options].map((option) => option.value)).toEqual([account.connectionId]);
		click(f.view.el, "Save routine");
		await vi.waitFor(() => expect(f.fake.commits).toHaveLength(1), { timeout: 3000 });
		expect(f.calls[0]).toEqual([
			CONSENT,
			{ p_profile_id: profileA.profileId, p_connection_id: account.connectionId, p_allow_autonomous: true },
		]);
		f.stop.abort();
	});
});

describe("who pays for a routine (20260930064000)", () => {
	const MEMBER = "10000000-0000-4000-8000-000000000041";
	const OTHER_MEMBER = "10000000-0000-4000-8000-000000000042";
	const GET = "qorpera_get_routine_payer";
	const SET = "qorpera_set_routine_login";
	const SINCE = "2026-10-03T08:00:00.123456+00:00";
	/** The cloud's answer of who pays for the routine: the member's own login, which pays. */
	const answer = (update: Record<string, unknown> = {}) => ({
		schema: "qorpera.routine-payer/v1",
		routineId: ROUTINE_ID,
		routineVersion: 2,
		status: "active",
		pauseReason: null,
		connectionId: account.connectionId,
		payer: "member",
		payerUserId: MEMBER,
		savedByUserId: MEMBER,
		canPay: true,
		since: SINCE,
		changedByUserId: null,
		changeReason: null,
		...update,
	});
	const paid = (update: Record<string, unknown> = {}) => parseRoutinePayer(answer(update), ROUTINE_ID);
	/** A routine whose login cannot pay waits for one. */
	const waits = { status: "paused", pauseReason: "needs_model_account", canPay: false };
	const waiting = (): WebRoutine => ({ ...routine({ status: "paused" }), pauseReason: "needs_model_account" });
	const plan = (allowAutonomous: boolean) =>
		({
			...account,
			connectionId: "10000000-0000-4000-8000-000000000011",
			connectionVersion: 3,
			provider: "openai",
			loginKind: "chatgpt_plan",
			allowAutonomous,
		}) as unknown as WebMemberConnection;
	const refused = (code: string, message: string) => new CloudRpcError(SET, { message, code }, 403);
	/** A card's "Who pays", or null when it has none. */
	const whoPays = (card: Element) =>
		[...card.querySelectorAll(".routine-card-fact")]
			.find((item) => item.querySelector("dt")?.textContent === "Who pays")
			?.querySelector("dd") ?? null;
	/** What "Choose a login" says, under its choices. */
	const note = (root: Element) => root.querySelector(".routine-login [role=status]")?.textContent;
	/** Opens the first card and its "Choose a login". */
	async function choose(view: AgentRoutines) {
		await vi.waitFor(() => expect(view.el.textContent).toContain("Choose a login"));
		view.el.querySelector<HTMLButtonElement>(".routine-card-summary")!.click();
		click(view.el, "Choose a login");
		await vi.waitFor(() =>
			expect(view.el.querySelector(".routine-login select, .routine-login [role=status]")).not.toBeNull(),
		);
	}

	it("reads who pays strictly, and nothing else", () => {
		expect(paid()).toEqual({
			routineId: ROUTINE_ID,
			routineVersion: 2,
			status: "active",
			pauseReason: null,
			connectionId: account.connectionId,
			payer: "member",
			payerUserId: MEMBER,
			savedByUserId: MEMBER,
			canPay: true,
			since: SINCE,
			changedByUserId: null,
			changeReason: null,
		});
		// A company account names no member; a routine with no login behind it has no payer.
		expect(
			paid({ payer: "company", payerUserId: null, changedByUserId: OTHER_MEMBER, changeReason: "pick" }),
		).toMatchObject({ payer: "company", payerUserId: null, changedByUserId: OTHER_MEMBER, changeReason: "pick" });
		expect(paid({ connectionId: null, payer: null, payerUserId: null, ...waits })).toMatchObject({
			payer: null,
			canPay: false,
			pauseReason: "needs_model_account",
		});
		for (const bad of [
			null,
			[],
			"qorpera.routine-payer/v1",
			answer({ schema: "qorpera.routine-payer/v2" }),
			answer({ routineId: OTHER_FILE }),
			answer({ routineVersion: 0 }),
			answer({ routineVersion: "2" }),
			answer({ status: "waiting" }),
			answer({ pauseReason: "Needs a login!" }),
			answer({ connectionId: "c1" }),
			answer({ payerUserId: null }),
			answer({ payer: "company" }),
			answer({ payer: "agent" }),
			answer({ connectionId: null }),
			answer({ savedByUserId: null }),
			answer({ canPay: "no" }),
			answer({ since: "yesterday" }),
			answer({ since: null }),
			answer({ changedByUserId: MEMBER }),
			answer({ changedByUserId: MEMBER, changeReason: "swap" }),
			answer({ changedByUserId: "someone", changeReason: "save" }),
		])
			expect(() => parseRoutinePayer(bad, ROUTINE_ID), JSON.stringify(bad)).toThrow("Invalid cloud response");
	});

	it("asks a cloud without the payer calls once, and never again while the page lives", async () => {
		const missing = vi.fn(async (name: string) => {
			throw new CloudRpcError(name, { message: "Could not find the function", code: "PGRST202" }, 404);
		});
		const cloud = { rpc: missing } as unknown as Cloud;
		const make = () =>
			createWebRoutines(
				cloud,
				profileA,
				new AbortController().signal,
				() => {},
				() => folderFake().folder,
			);
		const routines = make();
		expect(await routines.payer(ROUTINE_ID)).toBeNull();
		expect(await routines.payer(OTHER_FILE)).toBeNull();
		// Another client on the same cloud (another conversation's) asks no more; nor does a pick, which binds nothing.
		expect(await make().payer(ROUTINE_ID)).toBeNull();
		expect(await routines.setLogin(ROUTINE_ID, account)).toBeNull();
		expect(missing.mock.calls.map(([name]) => name)).toEqual([GET]);
		// A cloud with the read answers it.
		const f = writer(seeded(), undefined, (name) => (name === GET ? answer() : undefined));
		expect(await f.routines.payer(ROUTINE_ID)).toEqual(paid());
		expect(f.calls).toEqual([[GET, { p_routine_id: ROUTINE_ID }]]);

		// The page reads the first routine alone: on such a cloud the rest are not asked, and no card says who pays.
		const page = mount([routine(), routine({ routineId: OTHER_FILE, title: "Other" })]);
		await vi.waitFor(() => expect(page.routines.payer).toHaveBeenCalledTimes(1));
		await settle();
		expect(page.routines.payer).toHaveBeenCalledTimes(1);
		expect(cards(page.view.el).map(whoPays)).toEqual([null, null]);
		expect(page.view.el.querySelector(".surface-status")).toBeNull();
	});

	it("says who pays for each routine and since when: you, another member or the company", async () => {
		const items = ["51", "52", "53", "54"].map((n, index) =>
			routine({ routineId: `10000000-0000-4000-8000-0000000000${n}`, title: `Routine ${index + 1}` }),
		);
		const answers = new Map<string, WebRoutinePayer>(
			[
				{},
				{ payerUserId: OTHER_MEMBER },
				{ payer: "company", payerUserId: null },
				// A member the team list does not name.
				{ payerUserId: "10000000-0000-4000-8000-000000000043" },
			].map((update, index): [string, WebRoutinePayer] => [
				items[index]!.routineId,
				{ ...paid(update), routineId: items[index]!.routineId },
			]),
		);
		const routines = mocked(items);
		routines.payer.mockImplementation(async (routineId) => answers.get(routineId) ?? null);
		const view = new AgentRoutines(
			() => staff,
			{
				routines,
				accounts: async () => ({ connections: [account] }),
				canManage: () => true,
				memberId: MEMBER,
				memberName: (userId) => (userId === OTHER_MEMBER ? "Anna" : undefined),
			},
			new AbortController().signal,
		);
		document.body.append(view.el);
		await vi.waitFor(() => expect(whoPays(cards(view.el)[0]!)).not.toBeNull());
		const date = fmtDate(SINCE);
		expect(cards(view.el).map((card) => whoPays(card)?.textContent)).toEqual([
			`Paid by you since ${date}`,
			`Paid by Anna since ${date}`,
			`Paid by the company since ${date}`,
			`Paid by a member since ${date}`,
		]);
		// One read per routine for the list read; a login that pays offers no choice.
		expect(routines.payer).toHaveBeenCalledTimes(4);
		expect(view.el.textContent).not.toContain("Choose a login");

		// A read that fails says nothing for its routine, and no error; the others still say who pays.
		const failing = mount(items.slice(0, 2));
		failing.routines.payer.mockImplementation(async (routineId) => {
			if (routineId === items[0]!.routineId) throw new Error("offline");
			return answers.get(routineId) ?? null;
		});
		await vi.waitFor(() => expect(whoPays(cards(failing.view.el)[1]!)).not.toBeNull());
		expect(whoPays(cards(failing.view.el)[0]!)).toBeNull();
		expect(failing.view.el.querySelector(".surface-status")).toBeNull();
	});

	it("chooses a login for a routine whose login can't pay: consent and binding, then the pick, then the list again", async () => {
		const picked = { changedByUserId: MEMBER, changeReason: "pick", since: "2026-10-04T09:00:00.000Z" };
		const f = mountFolder([waiting()], {
			memberId: MEMBER,
			more: (name) => {
				if (name !== SET) throw new Error(`Unexpected call ${name}`);
				return answer(picked);
			},
		});
		// It waits on another login of the member's, which cannot pay.
		f.routines.payer.mockResolvedValue(paid({ ...waits, connectionId: "10000000-0000-4000-8000-0000000000c3" }));
		await choose(f.view);
		expect(whoPays(cards(f.view.el)[0]!)?.textContent).toContain(`Paid by you since ${fmtDate(SINCE)}`);
		const picker = field<HTMLSelectElement>(f.view.el, "Login");
		expect([...picker.options].map((option) => [option.value, option.textContent])).toEqual([
			[account.connectionId, "ChatGPT · owner@example.invalid"],
		]);
		expect(f.view.el.querySelector(".routine-login small")?.textContent).toBe(
			`Choosing a login lets ${staff.displayName} use it for this routine while you are away. Pause the routine to stop it.`,
		);
		// Nothing is asked of the cloud until the member uses the login.
		expect(f.log).toEqual([]);
		f.routines.payer.mockResolvedValue(paid(picked));
		click(f.view.el, "Use this login");
		await vi.waitFor(() => expect(f.log).toEqual([CONSENT, SPONSOR, SET]), { timeout: 3000 });
		expect(f.calls.at(-1)).toEqual([SET, { p_routine_id: ROUTINE_ID, p_connection_id: account.connectionId }]);
		expect(f.routines.setLogin).toHaveBeenCalledWith(ROUTINE_ID, account);
		// The card and the list are read again.
		await vi.waitFor(() => expect(f.routines.list).toHaveBeenCalledTimes(2));
		await vi.waitFor(() =>
			expect(whoPays(cards(f.view.el)[0]!)?.textContent).toBe(
				`Paid by you since ${fmtDate("2026-10-04T09:00:00.000Z")}`,
			),
		);
		expect(f.view.el.querySelector(".routine-login")).toBeNull();
		expect(f.view.el.querySelector(".surface-status")).toBeNull();
		f.stop.abort();
	});

	it("keeps the choice open and says why a login was refused; one the member may not change says so on the list", async () => {
		let refusal: Error = new Error("offline");
		const f = mountFolder([waiting()], {
			more: (name) => {
				if (name !== SET) throw new Error(`Unexpected call ${name}`);
				throw refusal;
			},
		});
		f.routines.payer.mockResolvedValue(paid(waits));
		await choose(f.view);
		for (const [error, said] of [
			[
				refused("22023", "This login cannot pay for this routine"),
				"This login can't pay for work while you're away right now. Choose another one.",
			],
			[
				refused("42501", "A ChatGPT plan cannot pay for a listener"),
				"A ChatGPT plan can't pay for routines that start on a file change or a webhook.",
			],
			[refused("42501", "This login cannot pay for this routine"), "You can only choose one of your own logins."],
			[new Error("offline"), "The login could not be chosen. Try again."],
		] as const) {
			refusal = error;
			click(f.view.el, "Use this login");
			await vi.waitFor(() => expect(note(f.view.el)).toBe(said), { timeout: 3000 });
			// Still open, on the same login.
			expect(field<HTMLSelectElement>(f.view.el, "Login").value).toBe(account.connectionId);
		}
		refusal = refused("42501", "Routine is unavailable");
		click(f.view.el, "Use this login");
		await vi.waitFor(
			() =>
				expect(f.view.el.querySelector(":scope > .surface-status")?.textContent).toBe(
					"You can't change who pays for this routine.",
				),
			{ timeout: 3000 },
		);
		expect(f.view.el.querySelector(".routine-login select")).toBeNull();
		// Each try gave the login its consent and binding first, and the list was read again after each.
		expect(f.log.filter((name) => name === SET)).toHaveLength(5);
		expect(f.log.filter((name) => name === CONSENT)).toHaveLength(5);
		await vi.waitFor(() => expect(f.routines.list).toHaveBeenCalledTimes(6));
		f.stop.abort();
	});

	it("consents a Codex login and binds a plan that is on before the pick, and names each refusal", async () => {
		let reply: unknown = answer({ changedByUserId: MEMBER, changeReason: "pick" });
		const f = writer(seeded(), undefined, (name) => {
			if (name !== SET) throw new Error(`Unexpected call ${name}`);
			if (reply instanceof Error) throw reply;
			return reply;
		});
		expect(await f.routines.setLogin(ROUTINE_ID, account)).toEqual(
			paid({ changedByUserId: MEMBER, changeReason: "pick" }),
		);
		expect(f.calls).toEqual([
			[
				CONSENT,
				{ p_profile_id: profileA.profileId, p_connection_id: account.connectionId, p_allow_autonomous: true },
			],
			[
				SPONSOR,
				expect.objectContaining({
					p_provider_connection_id: account.connectionId,
					p_provider_connection_version: 2,
					p_allow_autonomous: true,
				}),
			],
			[SET, { p_routine_id: ROUTINE_ID, p_connection_id: account.connectionId }],
		]);
		// A ChatGPT plan its member turned on is bound without asking for consent again; one not turned on is never
		// turned on here, and nothing is asked.
		f.calls.length = 0;
		await f.routines.setLogin(ROUTINE_ID, plan(true));
		expect(f.calls.map(([name]) => name)).toEqual([SPONSOR, SET]);
		f.calls.length = 0;
		await expect(f.routines.setLogin(ROUTINE_ID, plan(false))).rejects.toThrow("Turn on “Work while you're away”");
		expect(f.calls).toEqual([]);
		for (const [code, message, reason] of [
			["42501", "Routine is unavailable", "unavailable"],
			["42501", "This login cannot pay for this routine", "not_yours"],
			["22023", "This login cannot pay for this routine", "cannot_pay"],
			["42501", "A ChatGPT plan cannot pay for a listener", "plan_listener"],
		] as const) {
			reply = refused(code, message);
			const error = await f.routines.setLogin(ROUTINE_ID, account).catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(WebRoutineLoginRefusedError);
			expect(error).toMatchObject({ reason });
		}
		// Anything else is no refusal of the login, and comes through as it was; an answer for another routine is not read.
		const other = refused("22023", "Something else");
		reply = other;
		await expect(f.routines.setLogin(ROUTINE_ID, account)).rejects.toBe(other);
		reply = answer({ routineId: OTHER_FILE });
		await expect(f.routines.setLogin(ROUTINE_ID, account)).rejects.toThrow("Invalid cloud response");
	});

	it("turns the switch of a routine whose login can't pay into Choose a login; without that read it resumes", async () => {
		const f = mount([waiting()]);
		f.routines.payer.mockResolvedValue(paid(waits));
		await vi.waitFor(() => expect(whoPays(cards(f.view.el)[0]!)).not.toBeNull());
		const lever = f.view.el.querySelector<HTMLButtonElement>('[role="switch"]')!;
		lever.click();
		// No resume: the card opens on the member's logins, and the switch stays off.
		await vi.waitFor(() =>
			expect(f.view.el.querySelector('.routine-login select[aria-label="Login"]')).not.toBeNull(),
		);
		expect(cards(f.view.el)[0]!.classList.contains("is-open")).toBe(true);
		expect(document.activeElement).toBe(field(f.view.el, "Login"));
		expect(controls(cards(f.view.el)[0]!)).toContain("switch:false");
		expect(f.routines.setEnabled).not.toHaveBeenCalled();
		// Pressed again, it stays on the open choice.
		f.view.el.querySelector<HTMLButtonElement>('[role="switch"]')!.click();
		await settle();
		expect(f.view.el.querySelector(".routine-login select")).not.toBeNull();
		expect(f.routines.setEnabled).not.toHaveBeenCalled();
		f.stop.abort();
		document.body.replaceChildren();
		// A login that pays, a cloud without the read, and a read that failed: the switch resumes as before.
		for (const read of [
			async () => paid({ ...waits, canPay: true }),
			async () => null,
			async (): Promise<WebRoutinePayer | null> => {
				throw new Error("offline");
			},
		]) {
			const g = mount([waiting()]);
			g.routines.payer.mockImplementation(read);
			await vi.waitFor(() => expect(g.routines.payer).toHaveBeenCalled());
			await settle();
			g.view.el.querySelector<HTMLButtonElement>('[role="switch"]')!.click();
			await vi.waitFor(() =>
				expect(g.routines.setEnabled).toHaveBeenCalledWith(expect.anything(), account, true, expect.any(String)),
			);
			expect(g.view.el.querySelector(".routine-login select")).toBeNull();
			g.stop.abort();
			document.body.replaceChildren();
		}
	});

	it("says what to do when no login can pay, and offers the choice only to an owner or admin while it waits", async () => {
		const claude = {
			...account,
			connectionId: "10000000-0000-4000-8000-0000000000c1",
			provider: "anthropic",
			nativeHarness: "claude-code",
		} as unknown as NativeMemberConnection;
		const listener = (): WebRoutine => ({
			...routine({
				status: "paused",
				triggers: [
					parseCloudRoutineTrigger({
						id: "agent",
						kind: "listener",
						source: "company-file",
						path: "finance/invoices",
						match: "subtree",
						timeZone: "Europe/Copenhagen",
					}),
				],
			}),
			pauseReason: "needs_model_account",
		});
		for (const [item, connections, said] of [
			[
				waiting(),
				[claude],
				"Connect a model account in Settings first; a routine runs on the account of the member who last saved it.",
			],
			[waiting(), [plan(false)], "Turn on “Work while you're away” for this ChatGPT plan in Settings first."],
			[listener(), [plan(true)], "A ChatGPT plan can't pay for routines that start on a file change or a webhook."],
		] as const) {
			const f = mount([item], true, [...connections] as unknown as NativeMemberConnection[]);
			f.routines.payer.mockResolvedValue(paid(waits));
			await choose(f.view);
			expect(note(f.view.el)).toBe(said);
			expect(f.view.el.querySelector(".routine-login select")).toBeNull();
			// Cancel puts the button back.
			click(f.view.el, "Cancel");
			expect(f.view.el.querySelector(".routine-login .btn")?.textContent).toBe("Choose a login");
			expect(f.routines.setLogin).not.toHaveBeenCalled();
			f.stop.abort();
			document.body.replaceChildren();
		}
		// A Claude login is never offered; a plan that is on is, for a routine on a schedule, first as the one that works
		// while its member is away.
		const both = mount([waiting()], true, [claude, account, plan(true)] as unknown as NativeMemberConnection[]);
		both.routines.payer.mockResolvedValue(paid(waits));
		await choose(both.view);
		const picker = field<HTMLSelectElement>(both.view.el, "Login");
		expect([...picker.options].map((option) => option.value)).toEqual([
			"10000000-0000-4000-8000-000000000011",
			account.connectionId,
		]);
		expect(picker.value).toBe("10000000-0000-4000-8000-000000000011");
		both.stop.abort();
		document.body.replaceChildren();
		// A member who cannot manage routines, and a routine whose login pays, get no choice.
		for (const [manage, update] of [
			[false, waits],
			[true, {}],
		] as const) {
			const f = mount([waiting()], manage);
			f.routines.payer.mockResolvedValue(paid(update));
			await vi.waitFor(() => expect(whoPays(cards(f.view.el)[0]!)).not.toBeNull());
			expect(whoPays(cards(f.view.el)[0]!)?.textContent).toBe(`Paid by a member since ${fmtDate(SINCE)}`);
			expect(f.view.el.textContent).not.toContain("Choose a login");
			f.stop.abort();
			document.body.replaceChildren();
		}
	});
});
