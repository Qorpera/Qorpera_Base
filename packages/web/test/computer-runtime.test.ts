// @vitest-environment jsdom
import type {
	CompanyComputerMemberStatus,
	CompanyComputerMemberView,
} from "@qorpera/cloud-client/cloud-company-computer-views";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputerPanel, ComputerPanels } from "../src/app/views/computer.ts";
import { WebCompanyComputer } from "../src/cloud/computer.ts";
import { DEFAULT_CLOUD_CONFIG, parseCloudConfig } from "../src/cloud/deployment-config.ts";
import * as viewer from "../src/ui/computer-viewer.ts";
import { deferred, fixture, id, profileA, settle, staff, userA, userB } from "./fixtures.ts";

const scope = {
	companyId: profileA.profileId,
	environmentId: profileA.environmentId,
	companyComputerId: id(30),
	logicalComputerId: id(31),
};
const binding = {
	...scope,
	computerGeneration: 1,
	screenId: id(32),
	screenGeneration: 1,
	screenOrdinal: 1,
	staffAgentId: staff.id,
};
const catalog = {
	companyId: profileA.profileId,
	environmentId: profileA.environmentId,
	scope,
	canManage: true,
	staff: [{ staffAgentId: staff.id, name: staff.displayName }],
	nextAfter: null,
};
const start = { scope, computerGeneration: 1, officeState: "active", intent: null };
const status: CompanyComputerMemberStatus = {
	scope,
	computerGeneration: 1,
	state: "active",
	maintenance: null,
	privacyState: "shared",
	privacyVersion: 0,
	screens: [{ binding, epoch: 0, drainPending: false, driver: "idle", takeoverMemberId: null }],
	viewers: [],
};
const intent = {
	schema: "qorpera.office-start-intent/v1" as const,
	intentId: id(71),
	companyComputerId: scope.companyComputerId,
	computerGeneration: 1,
	state: "requested" as const,
};
// The renderer chunk is never really loaded here. Most tests stand in for loadComputerViewer; the
// one that runs the real loader meets a download that stalls.
vi.mock("../src/ui/screen-viewer.mjs", () => new Promise<object>(() => {}));
const START_WRITES = /\/(?:qorpera_request_runtime_office_start|qorpera_cancel_runtime_office_start)$/;
const cleanup: (() => void)[] = [];
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	// The renderer chunk (noVNC) is not fetched here; openComputerViewer stands in for it.
	vi.spyOn(viewer, "loadComputerViewer").mockResolvedValue();
});
afterEach(() => {
	for (const close of cleanup.splice(0)) close();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	localStorage.clear();
	document.body.replaceChildren();
});
function setup(overrides: Record<string, unknown> = {}, memberRole: typeof profileA.role = profileA.role) {
	const f = fixture(),
		stop = new AbortController();
	f.cloud.config.officeViewerOrigin = "wss://viewer.example.invalid";
	const replies: Record<string, unknown> = {
		qorpera_member_office_catalog: catalog,
		qorpera_runtime_office_start_status: start,
		qorpera_runtime_office_member_status: status,
		qorpera_open_runtime_office_screen: { state: "open" },
		...overrides,
	};
	const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const method = String(input).split("/").at(-1)!;
		expect(init?.redirect).toBe("error");
		// A backend without several computers per company: the panel falls back to the catalog.
		if (method === "qorpera_member_agent_office" && !(method in replies))
			return Response.json({ code: "PGRST202" }, { status: 404 });
		if (!(method in replies)) throw new Error("Unexpected network request");
		const reply = replies[method];
		return Response.json(
			typeof reply === "function" ? reply(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>) : reply,
		);
	});
	vi.stubGlobal("fetch", fetch);
	const computer = new WebCompanyComputer(f.cloud, { ...profileA, role: memberRole }, userA.id, stop.signal, () => {});
	cleanup.push(() => stop.abort());
	return { ...f, stop, computer, fetch, replies };
}
function panel(computer: WebCompanyComputer, signal?: AbortSignal) {
	const value = new ComputerPanel(staff, computer, signal);
	value.attach(document.body, () => value.dispose());
	cleanup.push(() => value.dispose());
	return value;
}
/** Allow the automatic open flow to reach its next waiting state. */
async function opened(computer: WebCompanyComputer, signal?: AbortSignal) {
	const value = panel(computer, signal);
	await settle();
	await settle();
	await settle();
	return value;
}
function action(root: HTMLElement, label: string) {
	const result = [...root.querySelectorAll("button")].find((button) => button.textContent === label);
	if (!result) throw new Error(`Missing ${label}: ${root.textContent}`);
	return result;
}
function methods(f: ReturnType<typeof setup>) {
	return f.fetch.mock.calls.map(([url]) => String(url).split("/").at(-1));
}
function statusLine(p: ComputerPanel) {
	return p.el.querySelector("[role=status]")?.textContent;
}
/** One 3000 ms poll of the open flow. */
async function poll() {
	await vi.advanceTimersByTimeAsync(3000);
	await settle();
}
function spyStart(f: ReturnType<typeof setup>) {
	const startClient = f.computer.client.start(scope);
	vi.spyOn(f.computer.client, "start").mockReturnValue(startClient);
	return startClient;
}
function spyViewer(close = vi.fn(async () => {})) {
	return vi.spyOn(viewer, "openComputerViewer").mockReturnValue({ close });
}

describe("the agent's own machines, when the company has no desktop machine", () => {
	const noDesktop = {
		companyId: profileA.profileId,
		environmentId: profileA.environmentId,
		staffAgentId: staff.id,
		canManage: true,
		computers: 0,
		placement: "none",
		computer: null,
	};
	let next = 100;
	const command = (head: string, state = "succeeded", exitCode: number | null = 0) => ({
		commandId: id(next++),
		command: head,
		startedAt: "2026-11-09T10:00:00Z",
		endedAt: state === "running" ? null : "2026-11-09T10:00:05Z",
		state,
		exitCode,
	});
	const machine = (name: string, overrides: Record<string, unknown> = {}) => ({
		machineId: id(next++),
		name,
		purpose: `Purpose of ${name}`,
		state: "stopped",
		cpus: 2,
		memoryGiB: 4,
		diskGiB: 20,
		image: "ubuntu",
		lifetime: "task",
		startedBy: { staffAgentId: staff.id, runId: id(next++), name: staff.displayName },
		node: null,
		queuePosition: null,
		waitingFor: null,
		runningSince: null,
		stoppedBy: null,
		commandsRunning: 0,
		lastError: null,
		createdAt: "2026-11-09T09:00:00Z",
		updatedAt: "2026-11-09T09:00:00Z",
		commands: [],
		...overrides,
	});
	const list = (...machines: unknown[]) => ({ schema: "qorpera.company-machines/v1", machines });
	const shown = (p: ComputerPanel) =>
		[...p.el.querySelectorAll<HTMLElement>(".computer-machine")].map((row) => ({
			name: row.querySelector(".computer-machine-name")?.textContent,
			state: row.querySelector(".computer-machine-state")?.textContent,
			commands: [...row.querySelectorAll(".computer-machine-commands code")].map((code) => code.textContent),
		}));

	it("lists the machines the agent started, active ones first, and starts nothing", async () => {
		const f = setup({
			qorpera_member_agent_office: noDesktop,
			qorpera_list_company_machines: list(
				machine("asleep-one"),
				machine("someone-elses", {
					state: "running",
					startedBy: { staffAgentId: id(99), runId: null, name: "Other" },
				}),
				machine("removed", { state: "deleted" }),
				machine("busy", {
					state: "running",
					commandsRunning: 1,
					commands: [
						command("python3 - <<'PY'\n  print(1)\nPY", "running", null),
						command("ls", "failed", 2),
						command("pwd"),
						command("whoami"),
					],
				}),
				machine("queued", { state: "waiting", waitingFor: "COMPUTER_HOURS_EXHAUSTED" }),
			),
		});
		const p = await opened(f.computer);
		expect(shown(p)).toEqual([
			{
				name: "busy",
				state: "Working",
				commands: ["python3 - <<'PY' print(1) PY", "ls", "pwd"],
			},
			{ name: "queued", state: "Waiting for computer hours", commands: [] },
			{ name: "asleep-one", state: "Asleep", commands: [] },
		]);
		expect(p.el.querySelector(".computer-machine-purpose")?.textContent).toBe("Purpose of busy");
		expect(p.el.querySelector(".computer-loading")?.hasAttribute("hidden")).toBe(true);
		expect(methods(f)).toEqual(["qorpera_member_agent_office", "qorpera_list_company_machines"]);
		expect(JSON.parse(String(f.fetch.mock.calls[1]![1]?.body))).toEqual({ p_profile_id: profileA.profileId });
	});
	it("keeps the list current while it is shown, and reads nothing while no thread shows it", async () => {
		let state = "starting";
		const f = setup({
			qorpera_member_agent_office: noDesktop,
			qorpera_list_company_machines: () => list(machine("job", { machineId: id(60), state })),
		});
		const p = await opened(f.computer);
		expect(shown(p)[0]?.state).toBe("Starting");
		state = "running";
		await vi.advanceTimersByTimeAsync(5000);
		await settle();
		expect(shown(p)[0]?.state).toBe("Running");
		p.detach();
		const reads = methods(f).length;
		await vi.advanceTimersByTimeAsync(15000);
		await settle();
		expect(methods(f).length).toBe(reads);
		p.attach(document.body, () => p.dispose());
		state = "stopping";
		await vi.advanceTimersByTimeAsync(5000);
		await settle();
		expect(shown(p)[0]?.state).toBe("Going to sleep");
	});
	it("keeps the last list when a later read fails, and offers Try again when the first one does", async () => {
		const f = setup({ qorpera_member_agent_office: noDesktop });
		const p = await opened(f.computer);
		expect(statusLine(p)).toBe("The computer could not be reached. Try again.");
		f.replies.qorpera_list_company_machines = list(machine("job"));
		action(p.el, "Try again").click();
		await settle();
		await settle();
		expect(shown(p).map((row) => row.name)).toEqual(["job"]);
		f.replies.qorpera_list_company_machines = { schema: "something-else" };
		await vi.advanceTimersByTimeAsync(5000);
		await settle();
		expect(shown(p).map((row) => row.name)).toEqual(["job"]);
		expect(p.el.querySelector(".computer-loading")?.hasAttribute("hidden")).toBe(true);
	});
});

describe("several computers per company", () => {
	const scope2 = { ...scope, companyComputerId: id(40), logicalComputerId: id(41) };
	const binding2 = { ...binding, ...scope2, screenId: id(42) };
	const placed = (computer: unknown, overrides: Record<string, unknown> = {}) => ({
		companyId: profileA.profileId,
		environmentId: profileA.environmentId,
		staffAgentId: staff.id,
		canManage: true,
		computers: 2,
		placement: "screen",
		computer,
		...overrides,
	});
	const sameScope = (body: Record<string, unknown>, value: typeof scope) =>
		JSON.stringify(body.p_scope) === JSON.stringify(value);
	it("opens the agent's screen on the computer it is on, named by number", async () => {
		const f = setup({
				qorpera_member_agent_office: placed({ scope: scope2, number: 2, waiting: null }),
				qorpera_runtime_office_start_status: { ...start, scope: scope2 },
				qorpera_runtime_office_member_status: {
					...status,
					scope: scope2,
					screens: [{ ...status.screens[0], binding: binding2 }],
				},
			}),
			open = spyViewer();
		await opened(f.computer);
		expect(open).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ binding: binding2, title: `${staff.displayName} · Computer · Machine 2` }),
		);
		expect(methods(f)).toEqual([
			"qorpera_member_agent_office",
			"qorpera_runtime_office_start_status",
			"qorpera_runtime_office_member_status",
		]);
		for (const [, init] of f.fetch.mock.calls.slice(1))
			expect(JSON.parse(String(init?.body)).p_scope).toEqual(scope2);
	});
	it("keeps the plain title while the company has one computer", async () => {
		const f = setup({ qorpera_member_agent_office: placed({ scope, number: 1, waiting: null }, { computers: 1 }) }),
			open = spyViewer();
		await opened(f.computer);
		expect(open).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ binding, title: `${staff.displayName} · Computer` }),
		);
	});
	it("follows the agent to its other computer instead of opening a second screen", async () => {
		let asked = 0;
		const f = setup({
				qorpera_member_agent_office: () =>
					asked++ === 0
						? placed({ scope, number: 1, waiting: null }, { placement: "room" })
						: placed({ scope: scope2, number: 2, waiting: null }),
				qorpera_runtime_office_start_status: (body: Record<string, unknown>) => ({
					...start,
					scope: sameScope(body, scope) ? scope : scope2,
				}),
				qorpera_runtime_office_member_status: (body: Record<string, unknown>) =>
					sameScope(body, scope)
						? { ...status, screens: [] }
						: { ...status, scope: scope2, screens: [{ ...status.screens[0], binding: binding2 }] },
				qorpera_open_runtime_office_screen: { state: "refused", reason: "AGENT_ON_OTHER_COMPUTER" },
			}),
			open = spyViewer();
		await opened(f.computer);
		await vi.advanceTimersByTimeAsync(1000);
		await settle();
		await settle();
		await settle();
		expect(open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ binding: binding2 }));
		expect(methods(f)).toEqual([
			"qorpera_member_agent_office",
			"qorpera_runtime_office_start_status",
			"qorpera_runtime_office_member_status",
			"qorpera_open_runtime_office_screen",
			"qorpera_member_agent_office",
			"qorpera_runtime_office_start_status",
			"qorpera_runtime_office_member_status",
		]);
	});
	it("says why a new computer is not up yet", async () => {
		const f = setup({
			qorpera_member_agent_office: placed({ scope: scope2, number: 2, waiting: "room" }, { placement: "starting" }),
			qorpera_runtime_office_start_status: {
				...start,
				scope: scope2,
				officeState: "provisioning",
				intent: { ...intent, companyComputerId: scope2.companyComputerId },
			},
		});
		const p = await opened(f.computer);
		expect(statusLine(p)).toBe("Waiting for room on our servers. It starts as soon as there is room.");
		await poll();
		expect(statusLine(p)).toBe("Waiting for room on our servers. It starts as soon as there is room.");
		expect(methods(f).some((method) => START_WRITES.test(`/${method}`))).toBe(false);
	});
	it("says a sleeping computer waits for computer hours, and wakes it once hours are added", async () => {
		const maintenance = {
			reason: "idle",
			state: "resumed",
			transitionId: id(74),
			requestedAt: "2026-09-19T12:00:00Z",
			resumedAt: "2026-09-19T12:01:00Z",
			activatedAt: null,
		};
		const f = setup({
			qorpera_member_agent_office: placed({ scope, number: 1, waiting: "hours" }, { placement: "starting" }),
			qorpera_runtime_office_start_status: { ...start, officeState: "maintenance", maintenance, intent },
		});
		const startClient = spyStart(f);
		const request = vi.spyOn(startClient, "request").mockResolvedValue(intent);
		const open = spyViewer();
		const p = await opened(f.computer);
		await poll();
		// The wake is still asked for: it waits for hours instead of "starting" for good.
		expect(request).toHaveBeenCalledOnce();
		expect(statusLine(p)).toBe("Out of computer hours. The machine starts by itself once hours are added.");
		f.replies.qorpera_member_agent_office = placed({ scope, number: 1, waiting: null }, { placement: "starting" });
		for (let n = 0; n < 4; n++) await poll();
		expect(statusLine(p)).toBe("Starting the machine…");
		f.replies.qorpera_runtime_office_start_status = start;
		await poll();
		expect(request).toHaveBeenCalledOnce();
		expect(open).toHaveBeenCalledOnce();
	});
	it("moves to a computer that has room while its sleeping one wakes", async () => {
		const maintenance = {
			reason: "idle",
			state: "resumed",
			transitionId: id(75),
			requestedAt: "2026-09-19T12:00:00Z",
			resumedAt: "2026-09-19T12:01:00Z",
			activatedAt: null,
		};
		let asked = 0;
		const f = setup({
				qorpera_member_agent_office: () =>
					asked++ < 2
						? placed({ scope: scope2, number: 2, waiting: null }, { placement: "starting" })
						: placed({ scope, number: 1, waiting: null }, { placement: "room" }),
				qorpera_runtime_office_start_status: (body: Record<string, unknown>) =>
					sameScope(body, scope)
						? start
						: {
								...start,
								scope: scope2,
								officeState: "maintenance",
								maintenance,
								intent: { ...intent, companyComputerId: scope2.companyComputerId },
							},
				qorpera_request_runtime_office_start: { ...intent, companyComputerId: scope2.companyComputerId },
			}),
			open = spyViewer();
		await opened(f.computer);
		for (let n = 0; n < 12 && !open.mock.calls.length; n++) await poll();
		expect(open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ binding }));
	});
	it("moves to a computer that has room while the new one still waits for its server", async () => {
		let asked = 0;
		const f = setup({
				qorpera_member_agent_office: () =>
					asked++ < 2
						? placed({ scope: scope2, number: 2, waiting: "setup" }, { placement: "starting" })
						: placed({ scope, number: 1, waiting: null }, { placement: "room" }),
				qorpera_runtime_office_start_status: (body: Record<string, unknown>) =>
					sameScope(body, scope)
						? start
						: {
								...start,
								scope: scope2,
								officeState: "provisioning",
								intent: { ...intent, companyComputerId: scope2.companyComputerId },
							},
			}),
			open = spyViewer();
		const p = await opened(f.computer);
		expect(statusLine(p)).toBe("Setting up another machine. This can take a while.");
		for (let n = 0; n < 12 && !open.mock.calls.length; n++) await poll();
		expect(open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ binding }));
	});
	it("moves a member without owner rights to a machine that gets room", async () => {
		let asked = 0;
		const f = setup({
				qorpera_member_agent_office: () =>
					asked++ < 2
						? placed({ scope: scope2, number: 2, waiting: null }, { placement: "unstarted", canManage: false })
						: placed({ scope, number: 1, waiting: null }, { placement: "room", canManage: false }),
				qorpera_runtime_office_start_status: (body: Record<string, unknown>) =>
					sameScope(body, scope) ? start : { ...start, scope: scope2, officeState: "provisioning", intent: null },
			}),
			open = spyViewer();
		const p = await opened(f.computer);
		expect(statusLine(p)).toBe("The machine is off. An owner or admin can start it.");
		for (let n = 0; n < 12 && !open.mock.calls.length; n++) await poll();
		expect(open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ binding }));
		expect(methods(f).some((method) => START_WRITES.test(`/${method}`))).toBe(false);
	});
	it("says it sets up the computer, not another one, for a company's first", async () => {
		const f = setup({
			qorpera_member_agent_office: placed(
				{ scope, number: 1, waiting: "setup" },
				{ placement: "unstarted", computers: 1 },
			),
			qorpera_runtime_office_start_status: { ...start, officeState: "provisioning", intent },
		});
		const p = await opened(f.computer);
		expect(statusLine(p)).toBe("Setting up the machine. This can take a while.");
	});
	it("tells members when the agent's computer access was revoked everywhere", async () => {
		const f = setup({ qorpera_member_agent_office: placed(null, { placement: "denied" }) });
		const p = await opened(f.computer);
		expect(statusLine(p)).toBe(`${staff.displayName} does not have access to the computer.`);
	});
	it("stops following an agent that keeps moving and offers to try again", async () => {
		const f = setup({
				qorpera_member_agent_office: placed({ scope, number: 1, waiting: null }, { placement: "room" }),
				qorpera_runtime_office_member_status: { ...status, screens: [] },
				qorpera_open_runtime_office_screen: { state: "refused", reason: "AGENT_ON_OTHER_COMPUTER" },
			}),
			open = spyViewer();
		const p = await opened(f.computer);
		for (let n = 0; n < 4; n++) {
			await vi.advanceTimersByTimeAsync(1000);
			await settle();
		}
		expect(statusLine(p)).toBe("The machine is not ready yet.");
		expect(action(p.el, "Try again").hidden).toBe(false);
		expect(open).not.toHaveBeenCalled();
		expect(methods(f).filter((method) => method === "qorpera_member_agent_office")).toHaveLength(3);
	});
	it("tells a member without owner rights that every computer is in use", async () => {
		const f = setup({
			qorpera_member_agent_office: placed(null, { placement: "new", canManage: false }),
		});
		const p = await opened(f.computer);
		expect(statusLine(p)).toBe("All computers are in use. An owner or admin can start another machine.");
		expect(action(p.el, "Try again").hidden).toBe(false);
		expect(methods(f)).toEqual(["qorpera_member_agent_office"]);
	});
});

describe("automatic computer popover", () => {
	it("shows loading immediately and opens the agent screen without a second action", async () => {
		const f = setup(),
			open = spyViewer(),
			p = panel(f.computer);
		expect(p.el.querySelector(".computer-loading")).not.toBeNull();
		expect(p.el.querySelector(".computer-loading-spinner")).not.toBeNull();
		expect(p.el.querySelector("header, select, .computer-preview, .figure")).toBeNull();
		expect(p.el.textContent).not.toContain("Open computer");
		// The X top right is there from the start: a preview stuck on "Connecting…" can be put away too.
		expect(p.el.querySelector("button.computer-close[aria-label='Close computer']")).not.toBeNull();
		expect(p.el.tabIndex).toBe(0);
		await settle();
		await settle();
		await settle();
		expect(open).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				binding,
				mount: p.el.querySelector(".computer-panel-body"),
				autofocus: false,
				canControl: true,
				sharedControl: true,
			}),
		);
		expect(methods(f)).toEqual([
			"qorpera_member_agent_office",
			"qorpera_member_office_catalog",
			"qorpera_runtime_office_start_status",
			"qorpera_runtime_office_member_status",
		]);
		expect(methods(f).some((method) => START_WRITES.test(`/${method}`))).toBe(false);
		expect(p.el.querySelector<HTMLElement>(".computer-loading")?.hidden).toBe(true);
		open.mock.calls[0]![0].onClosed();
		expect(p.el.isConnected).toBe(false);
	});
	it("forgets a press's pointer focus when a thread detaches the panel", () => {
		const f = setup(),
			p = panel(f.computer);
		document.body.append(p.el);
		// jsdom has no pointer capture; the drag code takes it on every press.
		p.el.setPointerCapture = vi.fn();
		p.el.hasPointerCapture = vi.fn(() => false);
		p.el.releasePointerCapture = vi.fn();
		p.el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, isPrimary: true, button: 0 }));
		expect(document.activeElement).toBe(p.el);
		expect(p.el.classList.contains("is-pointer-focus")).toBe(true);
		// Removal takes focus without a focusout in every browser; the mark must not outlive the thread.
		p.detach();
		expect(p.el.classList.contains("is-pointer-focus")).toBe(false);
	});
	it("closes for good from the X top right, and not before a thread holds it", async () => {
		const f = setup(),
			open = spyViewer(),
			p = panel(f.computer);
		await settle();
		await settle();
		await settle();
		expect(open).toHaveBeenCalledOnce();
		const close = vi.fn();
		p.detach();
		p.el.querySelector<HTMLButtonElement>(".computer-close")!.click();
		expect(close).not.toHaveBeenCalled();
		const body = document.createElement("div");
		document.body.append(body);
		p.attach(body, close);
		p.el.querySelector<HTMLButtonElement>(".computer-close")!.click();
		expect(close).toHaveBeenCalledOnce();
		body.remove();
	});
	it("fetches the screen renderer while it finds the machine, and only when there is one", async () => {
		const load = vi.mocked(viewer.loadComputerViewer);
		const unavailable = new ComputerPanel(staff);
		cleanup.push(() => unavailable.dispose());
		expect(load).not.toHaveBeenCalled();
		const f = setup(),
			open = spyViewer();
		panel(f.computer);
		// Beside the first read about the machine, not after the screen is up.
		expect(load).toHaveBeenCalledOnce();
		expect(open).not.toHaveBeenCalled();
		await settle();
		await settle();
		await settle();
		expect(open).toHaveBeenCalledOnce();
	});
	it("asks for a reload, and starts, wakes or opens nothing, when this page cannot load the screen renderer", async () => {
		// A deploy renamed the renderer chunk while the tab was open: the failed load stays failed.
		vi.mocked(viewer.loadComputerViewer).mockRejectedValue(
			new viewer.ComputerViewerUnavailable(new TypeError("Failed to fetch dynamically imported module")),
		);
		const reload = vi.spyOn(viewer, "reloadPage").mockImplementation(() => {});
		const f = setup({
			qorpera_runtime_office_start_status: { ...start, officeState: "provisioning" },
			qorpera_request_runtime_office_start: intent,
		});
		const open = spyViewer();
		const p = await opened(f.computer);
		await poll();
		expect(statusLine(p)).toBe("The computer screen could not be loaded in this tab. Reload the page to open it.");
		// Only where the agent's screen is was read; nothing was asked of the machine.
		expect(methods(f)).toEqual(["qorpera_member_agent_office", "qorpera_member_office_catalog"]);
		expect(open).not.toHaveBeenCalled();
		expect(p.el.querySelector<HTMLElement>(".computer-loading-spinner")?.hidden).toBe(true);
		// Try again could never help: the page has to fetch the renderer anew.
		const offered = [...p.el.querySelectorAll<HTMLButtonElement>(".computer-loading button")].filter(
			(button) => !button.hidden,
		);
		expect(offered.map((button) => button.textContent)).toEqual(["Reload page"]);
		offered[0]!.click();
		expect(reload).toHaveBeenCalledOnce();
	});
	it("ends a renderer download that stalls in the same reload state, asking nothing of the machine", async () => {
		vi.mocked(viewer.loadComputerViewer).mockRestore();
		const f = setup({
			qorpera_runtime_office_start_status: { ...start, officeState: "provisioning" },
			qorpera_request_runtime_office_start: intent,
		});
		const open = spyViewer();
		const p = await opened(f.computer);
		// Found the machine; waits for the renderer before starting it.
		expect(statusLine(p)).toBe("Connecting…");
		await vi.advanceTimersByTimeAsync(viewer.RENDERER_DEADLINE_MS - 1);
		await settle();
		expect(statusLine(p)).toBe("Connecting…");
		await vi.advanceTimersByTimeAsync(1);
		await settle();
		expect(statusLine(p)).toBe("The computer screen could not be loaded in this tab. Reload the page to open it.");
		expect(action(p.el, "Reload page").hidden).toBe(false);
		expect(methods(f)).toEqual(["qorpera_member_agent_office", "qorpera_member_office_catalog"]);
		expect(open).not.toHaveBeenCalled();
	});
	it("keeps unavailable and missing computers inside the popover without starting a runtime", async () => {
		const unavailable = new ComputerPanel(staff);
		cleanup.push(() => unavailable.dispose());
		expect(statusLine(unavailable)).toBe("Computer access is not available yet.");
		const f = setup({
			qorpera_member_office_catalog: { ...catalog, scope: null },
			qorpera_list_company_machines: { schema: "qorpera.company-machines/v1", machines: [] },
		});
		const p = await opened(f.computer);
		expect(statusLine(p)).toBe("Fixture agent has not started a machine yet. Agents start one when a task needs it.");
		expect(methods(f)).toEqual([
			"qorpera_member_agent_office",
			"qorpera_member_office_catalog",
			"qorpera_list_company_machines",
		]);
		expect(p.el.textContent).not.toContain("Open computer");
	});
	it("offers retry after a failed read and opens automatically after retry succeeds", async () => {
		const f = setup(),
			open = spyViewer();
		delete f.replies.qorpera_runtime_office_start_status;
		const p = await opened(f.computer);
		expect(statusLine(p)).toBe("The computer could not be reached. Try again.");
		const retry = action(p.el, "Try again");
		expect(retry.hidden).toBe(false);
		expect(open).not.toHaveBeenCalled();
		f.replies.qorpera_runtime_office_start_status = start;
		retry.focus();
		retry.click();
		expect(document.activeElement).toBe(p.el);
		retry.click();
		await settle();
		await settle();
		await settle();
		expect(open).toHaveBeenCalledTimes(1);
	});
	it("does not interrupt typing when delayed discovery completes", async () => {
		const f = setup(),
			pending = deferred<CompanyComputerMemberStatus>(),
			open = spyViewer();
		const views = f.computer.views(scope);
		vi.spyOn(views, "status").mockReturnValue(pending.promise);
		vi.spyOn(f.computer, "views").mockReturnValue(views);
		await opened(f.computer);
		const composer = document.createElement("textarea");
		document.body.append(composer);
		composer.focus();
		composer.value = "Keep writing while the screen opens";
		composer.setSelectionRange(5, 12);
		pending.resolve(status);
		await settle();
		await settle();
		expect(open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ autofocus: false }));
		expect(document.activeElement).toBe(composer);
		expect(composer.selectionStart).toBe(5);
		expect(composer.selectionEnd).toBe(12);
	});
	it("closing with Escape cancels polling without cancelling the runtime", async () => {
		const f = setup({ qorpera_runtime_office_start_status: { ...start, officeState: "maintenance" } });
		const startClient = spyStart(f),
			cancel = vi.spyOn(startClient, "cancel");
		const p = await opened(f.computer);
		expect(statusLine(p)).toBe("The machine is restarting. It comes back on its own.");
		p.focus();
		expect(document.activeElement).toBe(p.el);
		p.el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		await settle();
		expect(p.el.isConnected).toBe(false);
		const requests = methods(f);
		await poll();
		await poll();
		expect(methods(f)).toEqual(requests);
		expect(cancel).not.toHaveBeenCalled();
	});
	it("captures fallback Escape before the remote canvas while forwarding other keys", async () => {
		const f = setup(),
			close = vi.fn(async () => {}),
			open = spyViewer(close),
			p = await opened(f.computer);
		const options = open.mock.calls[0]![0];
		expect(options.onExpandedChange).toBeTypeOf("function");
		const back = document.createElement("button");
		back.className = "screen-viewer-back";
		const returnToPreview = vi.fn(() => options.onExpandedChange?.(false));
		back.addEventListener("click", returnToPreview);
		const screen = document.createElement("canvas");
		const remoteKey = vi.fn((event: KeyboardEvent) => {
			// noVNC consumes keyboard input at the canvas instead of letting it bubble.
			event.preventDefault();
			event.stopPropagation();
		});
		screen.addEventListener("keydown", remoteKey);
		p.el.querySelector(".computer-panel-body")!.append(back, screen);
		options.onExpandedChange?.(true);
		expect(p.el.classList.contains("is-entered")).toBe(true);
		const typing = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true });
		screen.dispatchEvent(typing);
		expect(remoteKey).toHaveBeenCalledExactlyOnceWith(typing);
		expect(returnToPreview).not.toHaveBeenCalled();
		const dismiss = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
		screen.dispatchEvent(dismiss);
		expect(dismiss.defaultPrevented).toBe(true);
		expect(remoteKey).toHaveBeenCalledTimes(1);
		expect(returnToPreview).toHaveBeenCalledOnce();
		expect(p.el.classList.contains("is-entered")).toBe(false);
		expect(p.el.isConnected).toBe(true);
		expect(close).not.toHaveBeenCalled();
		expect(open).toHaveBeenCalledTimes(1);
	});
	it("lets Escape leave fullscreen before a later Escape closes the computer", async () => {
		const f = setup(),
			close = vi.fn(async () => {}),
			open = spyViewer(close),
			p = await opened(f.computer);
		const screen = document.createElement("canvas");
		const remoteKey = vi.fn((event: KeyboardEvent) => event.stopPropagation());
		screen.addEventListener("keydown", remoteKey);
		p.el.querySelector(".computer-panel-body")!.append(screen);
		let fullscreenElement: Element | null = screen;
		const original = Object.getOwnPropertyDescriptor(document, "fullscreenElement");
		Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreenElement });
		try {
			const fullscreenEscape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
			screen.dispatchEvent(fullscreenEscape);
			expect(fullscreenEscape.defaultPrevented).toBe(false);
			expect(remoteKey).toHaveBeenCalledExactlyOnceWith(fullscreenEscape);
			expect(p.el.isConnected).toBe(true);
			expect(open).toHaveBeenCalledTimes(1);
			expect(close).not.toHaveBeenCalled();
			fullscreenElement = null;
			const dismiss = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
			screen.dispatchEvent(dismiss);
			await settle();
			expect(dismiss.defaultPrevented).toBe(true);
			expect(remoteKey).toHaveBeenCalledTimes(1);
			expect(p.el.isConnected).toBe(false);
			expect(close).toHaveBeenCalledOnce();
		} finally {
			if (original) Object.defineProperty(document, "fullscreenElement", original);
			else Reflect.deleteProperty(document, "fullscreenElement");
		}
	});
	it("makes covered conversation controls inert only while entered and restores them on Back or disposal", async () => {
		const f = setup(),
			open = spyViewer(),
			p = await opened(f.computer);
		const thread = document.createElement("section"),
			conversation = document.createElement("div"),
			header = document.createElement("header"),
			messages = document.createElement("div"),
			status = document.createElement("div"),
			composer = document.createElement("footer");
		conversation.className = "thread-conversation";
		header.className = "thread-header";
		composer.className = "composer";
		header.inert = false;
		messages.inert = false;
		status.inert = true;
		composer.inert = false;
		composer.append(document.createElement("textarea"));
		conversation.append(header, messages, status, composer);
		thread.append(conversation, p.el);
		document.body.append(thread);
		const options = open.mock.calls[0]![0];
		expect(composer.inert).toBe(false);
		options.onExpandedChange?.(true);
		expect(header.inert).toBe(false);
		expect(messages.inert).toBe(true);
		expect(composer.inert).toBe(true);
		options.onExpandedChange?.(true);
		options.onExpandedChange?.(false);
		expect(messages.inert).toBe(false);
		expect(composer.inert).toBe(false);
		expect(status.inert).toBe(true);
		options.onExpandedChange?.(true);
		p.dispose();
		expect(header.inert).toBe(false);
		expect(messages.inert).toBe(false);
		expect(composer.inert).toBe(false);
		expect(status.inert).toBe(true);
	});
	it("removes keyboard dismissal when the panel is disposed", async () => {
		const f = setup(),
			close = vi.fn(),
			p = new ComputerPanel(staff, f.computer);
		p.attach(document.body, close);
		p.dispose();
		const dismiss = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
		p.el.dispatchEvent(dismiss);
		expect(dismiss.defaultPrevented).toBe(false);
		expect(close).not.toHaveBeenCalled();
	});
	it("keeps the screen connected while the member is in another thread and shows it again on return", async () => {
		const f = setup(),
			closeViewer = vi.fn(async () => {}),
			open = spyViewer(closeViewer),
			panels = new ComputerPanels(f.computer, f.stop.signal),
			first = document.createElement("div"),
			second = document.createElement("div");
		document.body.append(first, second);
		const p = panels.open(staff)!;
		const closeFirst = vi.fn();
		p.attach(first, closeFirst);
		await settle();
		await settle();
		await settle();
		expect(open).toHaveBeenCalledOnce();
		expect(p.el.parentElement).toBe(first);
		const requests = f.fetch.mock.calls.length;
		// Leaving the thread hands the panel back; nothing is released, and it will not slide in again.
		expect(p.el.style.animation).toBe("");
		p.detach();
		expect(p.attached).toBe(false);
		expect(p.el.style.animation).toBe("none");
		expect(closeViewer).not.toHaveBeenCalled();
		expect(panels.get(staff.id)).toBe(p);
		await poll();
		expect(f.fetch.mock.calls.length).toBe(requests);
		// The next thread of this agent gets the same panel, same viewer: no new open flow.
		expect(panels.open(staff)).toBe(p);
		const closeSecond = vi.fn();
		p.attach(second, closeSecond);
		expect(p.el.parentElement).toBe(second);
		expect(open).toHaveBeenCalledOnce();
		expect(f.fetch.mock.calls.length).toBe(requests);
		expect(closeSecond).not.toHaveBeenCalled();
		// Closing through the registry ends the connection and forgets the panel.
		panels.close(staff.id);
		expect(closeViewer).toHaveBeenCalledOnce();
		expect(p.el.isConnected).toBe(false);
		expect(panels.get(staff.id)).toBeUndefined();
		const reopened = panels.open(staff);
		expect(reopened).not.toBe(p);
		panels.dispose();
	});
	it("routes the viewer's own close to the thread showing the panel now, not the one that was left", async () => {
		const f = setup(),
			open = spyViewer(),
			panels = new ComputerPanels(f.computer, f.stop.signal),
			p = panels.open(staff)!,
			closeFirst = vi.fn(),
			closeSecond = vi.fn();
		p.attach(document.body, closeFirst);
		await settle();
		await settle();
		await settle();
		expect(open).toHaveBeenCalledOnce();
		p.detach();
		// Closed by the renderer while no thread shows it: nobody is told, nothing breaks.
		const second = document.createElement("div");
		document.body.append(second);
		p.attach(second, closeSecond);
		open.mock.calls[0]![0].onClosed();
		expect(closeFirst).not.toHaveBeenCalled();
		expect(closeSecond).toHaveBeenCalledOnce();
		panels.dispose();
	});
	it("returns an entered screen to a preview when its thread is left, and frees the thread it covered", async () => {
		const f = setup(),
			open = spyViewer(),
			p = await opened(f.computer),
			options = open.mock.calls[0]![0];
		const thread = document.createElement("div");
		thread.className = "thread-conversation";
		const composer = document.createElement("div");
		composer.inert = false;
		thread.append(composer);
		document.body.append(thread);
		options.onExpandedChange?.(true);
		expect(composer.inert).toBe(true);
		expect(p.el.classList.contains("is-entered")).toBe(true);
		p.detach();
		expect(composer.inert).toBe(false);
		expect(p.el.classList.contains("is-entered")).toBe(false);
	});
	it("ends every open computer when the company is left", async () => {
		const f = setup(),
			closeViewer = vi.fn(async () => {}),
			stop = new AbortController(),
			panels = new ComputerPanels(f.computer, stop.signal);
		spyViewer(closeViewer);
		const p = panels.open(staff)!;
		p.attach(document.body, () => panels.close(staff.id));
		await settle();
		await settle();
		await settle();
		p.detach();
		stop.abort();
		expect(closeViewer).toHaveBeenCalledOnce();
		expect(panels.get(staff.id)).toBeUndefined();
		// A registry whose company is gone opens nothing more.
		expect(panels.open(staff)).toBeUndefined();
	});
	it("gives the viewer a rename that lands while it is opening", async () => {
		const f = setup(),
			close = vi.fn(async () => {});
		let p: ComputerPanel | undefined;
		const open = vi.spyOn(viewer, "openComputerViewer").mockImplementation((options) => {
			// The rename lands after the title was handed over and before the heading exists.
			p?.retitle("Renamed");
			const overlay = document.createElement("div");
			overlay.className = "screen-viewer-overlay";
			overlay.setAttribute("aria-label", options.title);
			const heading = document.createElement("span");
			heading.className = "screen-viewer-heading";
			heading.append(document.createElement("span"));
			heading.firstElementChild!.textContent = options.title;
			overlay.append(heading);
			options.mount?.append(overlay);
			return { close };
		});
		p = panel(f.computer);
		await settle();
		await settle();
		await settle();
		expect(open).toHaveBeenCalledOnce();
		expect(open.mock.calls[0]![0].title).toBe(`${staff.displayName} · Computer`);
		const overlay = p.el.querySelector(".screen-viewer-overlay")!;
		expect(overlay.getAttribute("aria-label")).toBe("Renamed · Computer");
		expect(overlay.querySelector(".screen-viewer-heading > span")?.textContent).toBe("Renamed · Computer");
	});
	it("applies a rename made while no thread showed the panel when it is handed out again", async () => {
		const f = setup(),
			open = spyViewer(),
			panels = new ComputerPanels(f.computer, f.stop.signal),
			p = panels.open(staff)!;
		p.attach(document.body, () => {});
		await settle();
		await settle();
		await settle();
		expect(open).toHaveBeenCalledOnce();
		const overlay = document.createElement("div");
		overlay.className = "screen-viewer-overlay";
		overlay.setAttribute("aria-label", `${staff.displayName} · Computer`);
		p.el.querySelector(".computer-panel-body")!.append(overlay);
		p.detach();
		expect(panels.open({ ...staff, displayName: "Renamed" })).toBe(p);
		expect(overlay.getAttribute("aria-label")).toBe("Renamed · Computer");
		expect(open).toHaveBeenCalledOnce();
		panels.dispose();
	});
	it("follows a rename in place: same viewer, new title", async () => {
		const f = setup(),
			open = spyViewer(),
			p = await opened(f.computer);
		expect(open.mock.calls[0]![0].title).toBe(`${staff.displayName} · Computer`);
		const overlay = document.createElement("div");
		overlay.className = "screen-viewer-overlay";
		overlay.setAttribute("aria-label", `${staff.displayName} · Computer`);
		const heading = document.createElement("span");
		heading.className = "screen-viewer-heading";
		heading.append(document.createElement("span"), document.createElement("small"));
		heading.firstElementChild!.textContent = `${staff.displayName} · Computer`;
		overlay.append(heading);
		p.el.querySelector(".computer-panel-body")!.append(overlay);
		p.retitle("Renamed");
		expect(open).toHaveBeenCalledOnce();
		expect(overlay.getAttribute("aria-label")).toBe("Renamed · Computer");
		expect(heading.firstElementChild!.textContent).toBe("Renamed · Computer");
		expect(heading.lastElementChild!.textContent).toBe("");
	});
});

describe("web runtime member boundary", () => {
	it("explains read-only access without requesting an idle wake", async () => {
		const f = setup(
			{
				qorpera_member_office_catalog: { ...catalog, canManage: false },
				qorpera_runtime_office_start_status: {
					...start,
					officeState: "maintenance",
					intent,
					maintenance: {
						reason: "idle",
						state: "requested",
						transitionId: id(76),
						requestedAt: "2026-09-19T12:00:00Z",
						resumedAt: null,
						activatedAt: null,
					},
				},
			},
			"viewer",
		);
		const request = vi.spyOn(spyStart(f), "request");
		const open = spyViewer();
		const p = await opened(f.computer);
		await poll();
		expect(statusLine(p)).toBe("You have read-only access. A company member with write access can wake the machine.");
		expect(request).not.toHaveBeenCalled();
		f.replies.qorpera_runtime_office_start_status = start;
		await poll();
		expect(open).toHaveBeenCalledWith(expect.objectContaining({ canControl: false }));
	});
	it.each([false, true])("wakes idle before screen discovery (screen request raced=%s)", async (duringScreenOpen) => {
		const f = setup();
		const startClient = spyStart(f);
		const request = vi.spyOn(startClient, "request").mockResolvedValue(intent);
		const views = f.computer.views(scope);
		vi.spyOn(f.computer, "views").mockReturnValue(views);
		const enterIdle = () => {
			f.replies.qorpera_runtime_office_start_status = {
				...start,
				officeState: "maintenance",
				intent,
				maintenance: {
					reason: "idle",
					state: "requested",
					transitionId: id(77),
					requestedAt: "2026-09-19T12:00:00Z",
					resumedAt: null,
					activatedAt: null,
				},
			};
			f.replies.qorpera_runtime_office_member_status = { ...status, state: "maintenance", screens: [] };
		};
		if (duringScreenOpen) {
			f.replies.qorpera_runtime_office_member_status = { ...status, screens: [] };
			vi.spyOn(views, "openScreen").mockImplementationOnce(async () => {
				enterIdle();
				return { state: "refused", reason: "COMPUTER_NOT_ACTIVE" };
			});
		} else
			vi.spyOn(views, "status").mockImplementationOnce(async () => {
				enterIdle();
				return { ...status, state: "maintenance", screens: [] };
			});
		const open = spyViewer();
		const p = await opened(f.computer);
		await poll();
		expect(request).toHaveBeenCalledOnce();
		expect(statusLine(p)).toBe("Starting the machine…");
		f.replies.qorpera_runtime_office_start_status = start;
		f.replies.qorpera_runtime_office_member_status = status;
		await poll();
		await poll();
		expect(open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ binding, sharedControl: true }));
	});
	it.each([false, true])(
		"automatically wakes idle maintenance when the panel opens (manager=%s)",
		async (canManage) => {
			const maintenance = {
				reason: "idle",
				state: "requested",
				transitionId: id(73),
				requestedAt: "2026-09-19T12:00:00Z",
				resumedAt: null,
				activatedAt: null,
			};
			const f = setup({
				qorpera_member_office_catalog: { ...catalog, canManage },
				qorpera_runtime_office_start_status: { ...start, officeState: "maintenance", maintenance, intent },
			});
			const startClient = spyStart(f);
			const request = vi.spyOn(startClient, "request").mockResolvedValue(intent);
			const open = spyViewer();
			const p = await opened(f.computer);
			await poll();
			expect(request).toHaveBeenCalledOnce();
			expect(statusLine(p)).toBe("Starting the machine…");
			await poll();
			expect(request).toHaveBeenCalledOnce();
			f.replies.qorpera_runtime_office_start_status = start;
			await poll();
			expect(open).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ sharedControl: true, canControl: canManage }),
			);
		},
	);
	it("wakes an office that idles between discovery and viewer connection", async () => {
		const f = setup();
		const startClient = spyStart(f);
		const request = vi.spyOn(startClient, "request").mockResolvedValue(intent);
		const views = f.computer.views(scope);
		const held = { connectionId: id(85), close: vi.fn(async () => {}) } as never;
		const connect = vi
			.spyOn(views, "connectScreen")
			.mockRejectedValueOnce(new Error("Office entered idle maintenance"))
			.mockResolvedValue(held);
		vi.spyOn(f.computer, "views").mockReturnValue(views);
		const open = spyViewer();
		await opened(f.computer);
		f.replies.qorpera_runtime_office_start_status = {
			...start,
			officeState: "maintenance",
			intent,
			maintenance: {
				reason: "idle",
				state: "requested",
				transitionId: id(74),
				requestedAt: "2026-09-19T12:00:00Z",
				resumedAt: null,
				activatedAt: null,
			},
		};
		const connection = open.mock.calls[0]![0].requestConnection({ binding, mode: "shared", signal: f.stop.signal });
		await settle();
		for (let i = 0; i < 10; i++) await poll();
		expect(request).toHaveBeenCalledOnce();
		expect(connect).toHaveBeenCalledOnce();
		f.replies.qorpera_runtime_office_start_status = start;
		await poll();
		await poll();
		await expect(connection).resolves.toBe(held);
		expect(connect).toHaveBeenCalledTimes(2);
	});
	describe("closing before the computer is up", () => {
		const idle = (transitionId: string) => ({
			...start,
			officeState: "maintenance",
			intent,
			maintenance: {
				reason: "idle",
				state: "requested",
				transitionId,
				requestedAt: "2026-09-19T12:00:00Z",
				resumedAt: null,
				activatedAt: null,
			},
		});
		const WITHDRAW = "qorpera_withdraw_runtime_office_wake";
		const bodies = (f: ReturnType<typeof setup>, method: string) =>
			f.fetch.mock.calls
				.filter(([url]) => String(url).endsWith(`/${method}`))
				.map(([, init]) => JSON.parse(String(init?.body)));
		it("withdraws the idle wake this panel asked for, and never cancels the computer", async () => {
			const f = setup({
				qorpera_runtime_office_start_status: idle(id(78)),
				qorpera_request_runtime_office_start: intent,
				[WITHDRAW]: { state: "withdrawn" },
			});
			const cancel = vi.spyOn(spyStart(f), "cancel");
			const p = await opened(f.computer);
			expect(statusLine(p)).toBe("Starting the machine…");
			expect(bodies(f, WITHDRAW)).toEqual([]);
			p.el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
			await settle();
			await settle();
			const [requested] = bodies(f, "qorpera_request_runtime_office_start");
			expect(bodies(f, WITHDRAW)).toEqual([
				{ p_scope: scope, p_computer_generation: 1, p_request_id: requested.p_request_id },
			]);
			await poll();
			expect(bodies(f, WITHDRAW)).toHaveLength(1);
			expect(cancel).not.toHaveBeenCalled();
		});
		it("lets a wake request in flight finish, then withdraws it", async () => {
			const f = setup({ qorpera_runtime_office_start_status: idle(id(79)) });
			const startClient = spyStart(f);
			const reply = deferred<typeof intent>();
			const request = vi.spyOn(startClient, "request").mockReturnValue(reply.promise);
			const withdraw = vi.spyOn(startClient, "withdraw").mockResolvedValue("withdrawn");
			const p = await opened(f.computer);
			expect(request).toHaveBeenCalledOnce();
			p.dispose();
			await settle();
			expect(request.mock.calls[0]![2].aborted).toBe(false);
			expect(withdraw).not.toHaveBeenCalled();
			reply.resolve(intent);
			await settle();
			expect(withdraw).toHaveBeenCalledExactlyOnceWith(1, request.mock.calls[0]![1], expect.any(AbortSignal));
		});
		it.each([false, true])("withdraws only a wake whose screen never connected (connected=%s)", async (connected) => {
			const f = setup({ qorpera_runtime_office_start_status: idle(id(80)) });
			const startClient = spyStart(f);
			vi.spyOn(startClient, "request").mockResolvedValue(intent);
			const withdraw = vi.spyOn(startClient, "withdraw").mockResolvedValue("withdrawn");
			const views = f.computer.views(scope);
			const held = { connectionId: id(86), close: vi.fn(async () => {}) } as never;
			vi.spyOn(views, "connectScreen").mockResolvedValue(held);
			vi.spyOn(f.computer, "views").mockReturnValue(views);
			const open = spyViewer();
			const p = await opened(f.computer);
			f.replies.qorpera_runtime_office_start_status = start;
			await poll();
			expect(open).toHaveBeenCalledOnce();
			if (connected)
				await expect(
					open.mock.calls[0]![0].requestConnection({ binding, mode: "shared", signal: f.stop.signal }),
				).resolves.toBe(held);
			p.dispose();
			await settle();
			expect(withdraw).toHaveBeenCalledTimes(connected ? 0 : 1);
		});
		it("sends nothing once the company is left", async () => {
			const f = setup({
				qorpera_runtime_office_start_status: idle(id(81)),
				qorpera_request_runtime_office_start: intent,
				[WITHDRAW]: { state: "withdrawn" },
			});
			const p = await opened(f.computer, f.stop.signal);
			expect(bodies(f, "qorpera_request_runtime_office_start")).toHaveLength(1);
			f.stop.abort();
			await settle();
			await settle();
			expect(p.el.isConnected).toBe(false);
			expect(bodies(f, WITHDRAW)).toEqual([]);
		});
		it("sends nothing when the company is left while the wake request is still out", async () => {
			const f = setup({
				qorpera_runtime_office_start_status: idle(id(82)),
				[WITHDRAW]: { state: "withdrawn" },
			});
			const reply = deferred<typeof intent>();
			vi.spyOn(spyStart(f), "request").mockReturnValue(reply.promise);
			await opened(f.computer, f.stop.signal);
			f.stop.abort();
			reply.resolve(intent);
			await settle();
			await settle();
			expect(bodies(f, WITHDRAW)).toEqual([]);
		});
		it("withdraws a wake whose reply was lost", async () => {
			const f = setup({ qorpera_runtime_office_start_status: idle(id(83)) });
			const startClient = spyStart(f);
			const request = vi.spyOn(startClient, "request").mockRejectedValue(new Error("Response lost"));
			const withdraw = vi.spyOn(startClient, "withdraw").mockResolvedValue("withdrawn");
			const p = await opened(f.computer);
			expect(statusLine(p)).toBe("The computer could not be reached. Try again.");
			p.dispose();
			await settle();
			expect(withdraw).toHaveBeenCalledExactlyOnceWith(1, request.mock.calls[0]![1], expect.any(AbortSignal));
		});
		it("withdraws a wake asked for while reconnecting a screen", async () => {
			const f = setup();
			const startClient = spyStart(f);
			const request = vi.spyOn(startClient, "request").mockResolvedValue(intent);
			const withdraw = vi.spyOn(startClient, "withdraw").mockResolvedValue("withdrawn");
			const views = f.computer.views(scope);
			vi.spyOn(views, "connectScreen").mockRejectedValue(new Error("Office entered idle maintenance"));
			vi.spyOn(f.computer, "views").mockReturnValue(views);
			const open = spyViewer();
			const p = await opened(f.computer);
			f.replies.qorpera_runtime_office_start_status = idle(id(84));
			const connection = open.mock.calls[0]![0].requestConnection({
				binding,
				mode: "shared",
				signal: f.stop.signal,
			});
			const refused = expect(connection).rejects.toThrow();
			await settle();
			await poll();
			expect(request).toHaveBeenCalledOnce();
			p.dispose();
			await refused;
			await settle();
			expect(withdraw).toHaveBeenCalledExactlyOnceWith(1, request.mock.calls[0]![1], expect.any(AbortSignal));
		});
		it("never withdraws a first start", async () => {
			const f = setup({
				qorpera_runtime_office_start_status: { ...start, officeState: "provisioning" },
				qorpera_request_runtime_office_start: intent,
			});
			const p = await opened(f.computer);
			expect(bodies(f, "qorpera_request_runtime_office_start")).toHaveLength(1);
			p.dispose();
			await settle();
			await settle();
			expect(bodies(f, WITHDRAW)).toEqual([]);
		});
	});

	it.each(["provisioning", "recovering"])("does not duplicate an existing %s start", async (officeState) => {
		for (const state of ["requested", "reserved"] as const) {
			const f = setup({
				qorpera_runtime_office_start_status: { ...start, officeState, intent: { ...intent, state } },
			});
			const startClient = spyStart(f),
				request = vi.spyOn(startClient, "request"),
				cancel = vi.spyOn(startClient, "cancel");
			const p = await opened(f.computer);
			expect(statusLine(p)).toBe("Starting the machine…");
			await poll();
			await poll();
			p.dispose();
			await settle();
			expect(request).not.toHaveBeenCalled();
			expect(cancel).not.toHaveBeenCalled();
		}
	});
	it.each(["provisioning", "recovering"])(
		"reuses one start identity after an ambiguous %s request",
		async (officeState) => {
			const f = setup({ qorpera_runtime_office_start_status: { ...start, officeState } });
			const startClient = spyStart(f);
			const request = vi.spyOn(startClient, "request").mockRejectedValue(new Error("Response lost"));
			const cancel = vi.spyOn(startClient, "cancel");
			const p = await opened(f.computer);
			expect(request).toHaveBeenCalledTimes(1);
			expect(request).toHaveBeenCalledWith(1, expect.any(String), expect.any(AbortSignal));
			expect(statusLine(p)).toBe("The computer could not be reached. Try again.");
			await poll();
			expect(request).toHaveBeenCalledTimes(1);
			const retry = action(p.el, "Try again");
			retry.click();
			retry.click();
			await settle();
			await settle();
			expect(request).toHaveBeenCalledTimes(2);
			expect(request.mock.calls[1]![1]).toBe(request.mock.calls[0]![1]);
			p.dispose();
			await settle();
			expect(cancel).not.toHaveBeenCalled();
		},
	);
	it("starts once, waits for an active runtime, then connects this agent's screen", async () => {
		const f = setup({ qorpera_runtime_office_start_status: { ...start, officeState: "provisioning" } });
		const request = vi.spyOn(spyStart(f), "request").mockResolvedValue(intent),
			open = spyViewer();
		const p = await opened(f.computer);
		expect(statusLine(p)).toBe("Starting the machine…");
		await poll();
		await poll();
		expect(request).toHaveBeenCalledTimes(1);
		expect(open).not.toHaveBeenCalled();
		f.replies.qorpera_runtime_office_start_status = start;
		await poll();
		expect(request).toHaveBeenCalledTimes(1);
		expect(open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ binding }));
	});
	it.each([
		["provisioning", true],
		["recovering", true],
		["active", false],
		["maintenance", false],
		["retired", false],
	] as const)(
		"starts a %s runtime only when member capability and current intent allow it",
		async (officeState, eligibleState) => {
			for (const canManage of [true, false]) {
				for (const intentState of [null, "requested", "reserved", "cancelled"] as const) {
					const f = setup({
						qorpera_member_office_catalog: { ...catalog, canManage },
						qorpera_runtime_office_start_status: {
							...start,
							officeState,
							intent: intentState === null ? null : { ...intent, state: intentState },
						},
						qorpera_request_runtime_office_start: intent,
					});
					const open = spyViewer(),
						p = await opened(f.computer);
					await poll();
					const writes = methods(f).filter((method) => START_WRITES.test(`/${method}`));
					expect(writes).toEqual(
						canManage && eligibleState && intentState === null ? ["qorpera_request_runtime_office_start"] : [],
					);
					if (officeState === "active") {
						expect(open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ canControl: canManage }));
					} else {
						expect(open).not.toHaveBeenCalled();
						expect(statusLine(p)).toBe(
							officeState === "maintenance"
								? "The machine is restarting. It comes back on its own."
								: officeState === "retired"
									? "This machine has been retired."
									: canManage
										? "Starting the machine…"
										: "The machine is off. An owner or admin can start it.",
						);
					}
					if (officeState === "retired") {
						const requests = methods(f);
						await poll();
						expect(methods(f)).toEqual(requests);
					}
					p.dispose();
					f.stop.abort();
					open.mockRestore();
				}
			}
		},
	);
	it("opens a missing screen once and only selects this agent's first available screen", async () => {
		const other = { ...status.screens[0]!, binding: { ...binding, staffAgentId: id(99) } };
		const f = setup({ qorpera_runtime_office_member_status: { ...status, screens: [other] } }),
			open = spyViewer();
		await opened(f.computer);
		await poll();
		await poll();
		const opens = f.fetch.mock.calls.filter(([url]) => String(url).endsWith("qorpera_open_runtime_office_screen"));
		expect(opens).toHaveLength(1);
		expect(JSON.parse(opens[0]![1]!.body as string)).toMatchObject({ p_staff_agent_id: staff.id });
		expect(open).not.toHaveBeenCalled();
		const mine = (screenOrdinal: number, drainPending = false) => ({
			...status.screens[0]!,
			drainPending,
			binding: { ...binding, screenId: id(32 + screenOrdinal), screenOrdinal },
		});
		f.replies.qorpera_runtime_office_member_status = { ...status, screens: [other, mine(2, true), mine(4), mine(3)] };
		await poll();
		expect(open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ binding: mine(3).binding }));
	});
	it.each([
		["SCREEN_CAPACITY_EXHAUSTED", "All computers on this machine are in use. Try again when one is free."],
		["AGENT_HAS_NO_COMPUTER_ACCESS", `${staff.displayName} does not have access to the computer.`],
	])("shows the %s refusal without repeatedly requesting access", async (reason, text) => {
		const f = setup({
				qorpera_runtime_office_member_status: { ...status, screens: [] },
				qorpera_open_runtime_office_screen: { state: "refused", reason },
			}),
			open = spyViewer(),
			p = await opened(f.computer);
		expect(statusLine(p)).toBe(text);
		const requests = methods(f);
		await poll();
		await poll();
		expect(methods(f)).toEqual(requests);
		expect(open).not.toHaveBeenCalled();
	});
	it.each(["private", "entering", "leaving"] as const)(
		"waits while privacy is %s before shared viewing",
		async (privacyState) => {
			const f = setup({ qorpera_runtime_office_member_status: { ...status, privacyState } }),
				open = spyViewer();
			const views = f.computer.views(scope),
				connect = vi.spyOn(views, "connectScreen");
			vi.spyOn(f.computer, "views").mockReturnValue(views);
			const p = await opened(f.computer);
			await poll();
			expect(statusLine(p)).toBe("The machine is private right now. Shared viewing returns when that ends.");
			expect(open).not.toHaveBeenCalled();
			expect(connect).not.toHaveBeenCalled();
			f.replies.qorpera_runtime_office_member_status = status;
			await poll();
			expect(open).toHaveBeenCalledTimes(1);
		},
	);
	it("reports missing viewer configuration before screen discovery", async () => {
		const f = setup(),
			open = spyViewer();
		delete f.cloud.config.officeViewerOrigin;
		const p = await opened(f.computer);
		expect(statusLine(p)).toBe("Computer viewing is not set up here.");
		expect(open).not.toHaveBeenCalled();
		expect(methods(f)).not.toContain("qorpera_runtime_office_member_status");
	});
	it("retries connection admission and stops retrying when the viewer closes", async () => {
		const f = setup(),
			open = spyViewer();
		const views = f.computer.views(scope),
			connect = vi.spyOn(views, "connectScreen");
		vi.spyOn(f.computer, "views").mockReturnValue(views);
		const p = await opened(f.computer);
		const held = { connectionId: "held", close: vi.fn(async () => {}) } as unknown as CompanyComputerMemberView;
		connect
			.mockRejectedValueOnce(new Error("Starting"))
			.mockRejectedValueOnce(new Error("Starting"))
			.mockResolvedValue(held);
		const input = { binding, mode: "shared" as const, signal: new AbortController().signal };
		const connection = open.mock.calls[0]![0].requestConnection(input);
		await poll();
		await poll();
		await expect(connection).resolves.toBe(held);
		expect(connect).toHaveBeenCalledTimes(3);
		expect(connect).toHaveBeenLastCalledWith(expect.objectContaining({ binding, mode: "shared" }));
		const closing = new AbortController();
		connect.mockReset();
		connect.mockRejectedValue(new Error("Starting"));
		const stopped = open.mock.calls[0]![0].requestConnection({ ...input, signal: closing.signal });
		const refused = expect(stopped).rejects.toThrow();
		await settle();
		closing.abort();
		await refused;
		expect(connect).toHaveBeenCalledTimes(1);
		p.dispose();
		expect(open.mock.results[0]!.value.close).toHaveBeenCalled();
	});
	it("drops delayed screen discovery after the popover closes", async () => {
		const f = setup(),
			pending = deferred<CompanyComputerMemberStatus>(),
			open = spyViewer();
		const views = f.computer.views(scope);
		vi.spyOn(views, "status").mockReturnValue(pending.promise);
		vi.spyOn(f.computer, "views").mockReturnValue(views);
		const p = await opened(f.computer);
		p.el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		pending.resolve(status);
		await settle();
		await poll();
		expect(open).not.toHaveBeenCalled();
		expect(p.el.isConnected).toBe(false);
	});
	it("does not render discovery that arrives after disposal", async () => {
		const f = setup(),
			pending = deferred<Response>();
		f.fetch.mockReturnValueOnce(pending.promise);
		const p = panel(f.computer);
		await settle();
		p.dispose();
		pending.resolve(Response.json(catalog));
		await settle();
		await settle();
		expect(p.el.textContent).toBe("");
		expect(f.fetch).toHaveBeenCalledTimes(1);
	});
	it("releases a connection returned after company teardown", async () => {
		const f = setup(),
			pending = deferred<CompanyComputerMemberView>(),
			open = spyViewer();
		const views = f.computer.views(scope);
		vi.spyOn(views, "connectScreen").mockReturnValue(pending.promise);
		vi.spyOn(f.computer, "views").mockReturnValue(views);
		await opened(f.computer, f.stop.signal);
		const connecting = open.mock.calls[0]![0].requestConnection({
			binding,
			mode: "watch",
			signal: new AbortController().signal,
		});
		const close = vi.fn(async () => {});
		f.stop.abort();
		pending.resolve({
			connectionId: id(44),
			binding,
			mode: "watch",
			close,
			channel: {
				readyState: 1,
				protocol: "",
				binaryType: "arraybuffer",
				onopen: null,
				onmessage: null,
				onerror: null,
				onclose: null,
				send() {},
				close() {},
			},
		});
		await expect(connecting).rejects.toThrow();
		expect(close).toHaveBeenCalledTimes(1);
	});
	it("uses current member credentials and selected environment", async () => {
		const f = setup();
		await f.computer.client.catalog(f.stop.signal);
		const request = f.fetch.mock.calls[0]![1]!;
		expect(JSON.parse(request.body as string)).toEqual({ p_environment_id: profileA.environmentId, p_after: null });
		expect(new Headers(request.headers).get("authorization")).toBe("Bearer fixture-token");
	});
	it("does not send another account's token", async () => {
		const f = setup();
		f.auth(userB);
		await expect(f.computer.client.catalog(f.stop.signal)).rejects.toThrow();
		expect(f.fetch).not.toHaveBeenCalled();
	});
	it("refuses credentials refreshed after company teardown", async () => {
		const f = setup(),
			original = await f.cloud.supabase.auth.getSession();
		const pending = deferred<typeof original>();
		vi.mocked(f.cloud.supabase.auth.getSession).mockReturnValueOnce(pending.promise);
		const request = f.computer.client.catalog(new AbortController().signal);
		f.stop.abort();
		pending.resolve(original);
		await expect(request).rejects.toThrow();
		expect(f.fetch).not.toHaveBeenCalled();
	});
	it("does not infer a viewer endpoint from the object gateway", () => {
		const f = setup();
		delete f.cloud.config.officeViewerOrigin;
		expect(() => f.computer.views(scope)).toThrow("not configured");
	});
});

describe("trusted viewer configuration", () => {
	it.each([
		"ws://viewer.invalid",
		"wss://user:password@viewer.invalid",
		"wss://viewer.invalid/path",
		"wss://viewer.invalid/?ticket=secret",
		"wss://viewer.invalid/#secret",
	])("rejects %s", (officeViewerOrigin) => {
		expect(() => parseCloudConfig({ ...DEFAULT_CLOUD_CONFIG, officeViewerOrigin })).toThrow("exact secure origin");
	});
	it("preserves a configured secure origin", () => {
		expect(
			parseCloudConfig({ ...DEFAULT_CLOUD_CONFIG, officeViewerOrigin: "wss://viewer.invalid/" }).officeViewerOrigin,
		).toBe("wss://viewer.invalid");
	});
});
