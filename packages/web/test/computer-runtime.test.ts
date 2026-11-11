// @vitest-environment jsdom

import type { MemberAgentMachine } from "@qorpera/cloud-client/cloud-member-company-computer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ComputerPanel,
	ComputerPanels,
	KEEP_EVERY_MS,
	LOOK_EVERY_MS,
	MACHINES_EVERY_MS,
	type MachineHints,
	PAUSE_AFTER_MS,
	SCREEN_OFF_EVERY_MS,
} from "../src/app/views/computer.ts";
import { WebCompanyComputer } from "../src/cloud/computer.ts";
import { DEFAULT_CLOUD_CONFIG, parseCloudConfig } from "../src/cloud/deployment-config.ts";
import { createWebMachineScreens } from "../src/cloud/machine-screens.ts";
import type { RealtimeResource } from "../src/cloud/realtime.ts";
import { openMenu } from "../src/ui/context-menu.ts";
import { DOUBLE_CLICK_MS, machineTexts, TYPE_BATCH_MS } from "../src/ui/machine-screen-view.ts";
import { fixture, id, profileA, settle, staff, userA, userB } from "./fixtures.ts";

/* An agent's computer window (migration 20260930712000; lanes/desktop-computers-20261110/LIVE-VIEW-PLAN.md, stage 1a):
 * the agent's machines, a picture of the chosen desktop through the member bridge, and every state the window says in
 * words. Stage 1b (20260930713000): a member takes the desktop over, acts on it through the picture and hands it back. */

const gateway = "https://gateway.example.invalid";
const bridge = "https://fixture.invalid/functions/v1/member-company-gateway";
const etag = (n: number) => String(n).repeat(64).slice(0, 64);
function machine(n: number, change: Partial<MemberAgentMachine> = {}): MemberAgentMachine {
	return {
		machineId: id(40 + n),
		name: `desk-${n}`,
		purpose: "Walks through the concepts app the way a friend would.",
		state: "running",
		lifetime: "task",
		desktopCapable: true,
		startedByAgent: true,
		screenUsedAt: "2026-11-10T14:25:45Z",
		screenAgentName: staff.displayName,
		waitingFor: null,
		control: null,
		epoch: 0,
		...change,
	};
}
/** One look's answer from the bridge: a picture (its etag), the member's own picture again, or a refusal's code. */
type Answer = { picture: number } | "unchanged" | { code: string } | { status: number };
/** One action's answer: its exit, or a refusal's code. */
type ActAnswer = { exitCode: number | null } | { code: string } | { hold: Promise<void>; exitCode: number };

const cleanup: (() => void)[] = [];
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	// jsdom has no canvas: the panel draws nothing here, and its decoder stands in for the browser's.
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => {
	for (const close of cleanup.splice(0)) close();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	localStorage.clear();
	document.body.replaceChildren();
});

function setup(
	options: {
		machines?: MemberAgentMachine[];
		canWake?: boolean;
		canTakeOver?: boolean;
		role?: typeof profileA.role;
	} = {},
) {
	const f = fixture(),
		stop = new AbortController();
	Object.assign(f.cloud.config, { objectGatewayUrl: gateway, memberCompanyGatewayUrl: bridge });
	const state = {
		machines: options.machines ?? [machine(1)],
		canWake: options.canWake ?? true,
		canTakeOver: options.canTakeOver ?? true,
		answers: [] as Answer[],
		/** What the member's actions answer, in turn (then done, exit 0). */
		actAnswers: [] as ActAnswer[],
		/** What a take-over answers: held until when, or why not. */
		take: { state: "ok", until: "2026-11-10T20:00:00.000Z" } as Record<string, unknown>,
		/** What the heartbeat answers. */
		keep: { state: "ok", until: "2026-11-10T20:01:00.000Z" } as Record<string, unknown>,
		/** What a look answers once the queue is empty. */
		fallback: "unchanged" as Answer,
		listFails: 0,
		/** Hand-backs that fail (503) before one goes through, and a gate each waits on (review r1 F4). */
		handBackFails: 0,
		handBackGate: undefined as Promise<void> | undefined,
		/** Gates the next hand-backs wait on, one each, in turn (review r3 F7). */
		handBackGates: [] as Promise<void>[],
		/** A gate a take-over's answer waits on (review r1 F5), and one the next list read waits on (F6). */
		takeGate: undefined as Promise<void> | undefined,
		listGate: undefined as Promise<void> | undefined,
		/** A take-over whose answer is lost (review r2 F5): the database committed it first, or it reaches the database
		 * only later, when the test says (`lateCommit`: whether it held anything). */
		takeLost: undefined as "committed" | "late" | undefined,
		lateCommit: undefined as (() => boolean) | undefined,
		/** The member's hand-back epoch per machine, as the database keeps it (review r5); 0 when absent. */
		epochs: new Map<string, number>(),
	};
	const epochOf = (machineId: unknown) => state.epochs.get(String(machineId)) ?? 0;
	const looks: { url: string; etag: string | null }[] = [];
	const acts: { url: string; action: Record<string, unknown> }[] = [];
	const rpcs: { method: string; body: Record<string, unknown> }[] = [];
	const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		expect(init?.redirect).toBe("error");
		const headers = new Headers(init?.headers);
		expect(headers.get("authorization")).toBe("Bearer fixture-token");
		if (url.startsWith(`${bridge}/v1/member-machine-screens/`) && url.endsWith("/act")) {
			expect(init?.method).toBe("POST");
			expect(headers.get("content-type")).toBe("application/json");
			const body = JSON.parse(String(init?.body)) as { action: Record<string, unknown> };
			expect(Object.keys(body)).toEqual(["action"]);
			acts.push({ url: url.slice(bridge.length), action: body.action });
			const answer = state.actAnswers.shift() ?? { exitCode: 0 };
			if ("hold" in answer) await answer.hold;
			if ("code" in answer) return Response.json({ code: answer.code }, { status: 409 });
			return Response.json({ schema: "qorpera.member-machine-act/v1", exitCode: answer.exitCode });
		}
		if (url.startsWith(`${bridge}/v1/member-machine-screens/`)) {
			expect(init?.method).toBe("GET");
			expect(init?.cache).toBe("no-store");
			const asked = headers.get("if-none-match");
			looks.push({ url: url.slice(bridge.length), etag: asked ? asked.slice(1, -1) : null });
			const answer = state.answers.shift() ?? state.fallback;
			if (answer === "unchanged") return new Response(null, { status: 304, headers: { etag: asked ?? '""' } });
			if ("picture" in answer)
				return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, answer.picture]), {
					status: 200,
					headers: { "content-type": "image/png", etag: `"${etag(answer.picture)}"` },
				});
			if ("code" in answer) return Response.json({ code: answer.code }, { status: 409 });
			return new Response("{}", { status: answer.status });
		}
		const method = url.split("/").at(-1)!;
		const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
		rpcs.push({ method, body });
		if (method === "qorpera_list_agent_machines") {
			if (state.listGate) {
				const gate = state.listGate;
				state.listGate = undefined;
				// The machines as they are when the read is answered.
				await gate;
			}
			if (state.listFails > 0) {
				state.listFails--;
				return new Response("{}", { status: 503 });
			}
			return Response.json({
				schema: "qorpera.agent-machines/v1",
				profileId: profileA.profileId,
				staffAgentId: staff.id,
				canWake: state.canWake,
				canTakeOver: state.canTakeOver,
				// As the database: the member's own epoch per machine.
				machines: state.machines.map((row) => ({ ...row, epoch: epochOf(row.machineId) })),
			});
		}
		if (method === "qorpera_member_manage_company_machine")
			return Response.json({ machineId: body.p_machine_id, state: "waiting" });
		if (method === "qorpera_member_take_machine_desktop") {
			if (state.takeGate) await state.takeGate;
			const epoch = Number(body.p_epoch);
			// As the database: a take-over is accepted only at the member's current epoch, when it arrives; the list then
			// says the member holds it, taken under that epoch.
			const commit = () => {
				if (epoch !== epochOf(body.p_machine_id) || state.take.state !== "ok") return false;
				state.machines = state.machines.map((row) =>
					row.machineId === body.p_machine_id
						? { ...row, control: { mine: true, name: "Owner", until: String(state.take.until), epoch } }
						: row,
				);
				return true;
			};
			const lost = state.takeLost;
			state.takeLost = undefined;
			if (lost === "late") {
				state.lateCommit = commit;
				throw new TypeError("Failed to fetch");
			}
			if (epoch !== epochOf(body.p_machine_id))
				return Response.json({
					schema: "qorpera.member-machine-desktop/v1",
					state: "refused",
					reason: "TAKE_CALLED_OFF",
					epoch: epochOf(body.p_machine_id),
				});
			commit();
			if (lost === "committed") throw new TypeError("Failed to fetch");
			return Response.json({ schema: "qorpera.member-machine-desktop/v1", ...state.take });
		}
		if (method === "qorpera_member_keep_machine_desktop") {
			// As the database: only a lease of the member's taken under that epoch is renewed.
			const row = state.machines.find((machine) => machine.machineId === body.p_machine_id);
			if (row?.control?.mine !== true || row.control.epoch !== body.p_epoch)
				return Response.json({ schema: "qorpera.member-machine-desktop/v1", state: "ended" });
			return Response.json({ schema: "qorpera.member-machine-desktop/v1", ...state.keep });
		}
		if (method === "qorpera_member_hand_back_machine_desktop") {
			if (state.handBackGate) await state.handBackGate;
			const gate = state.handBackGates.shift();
			if (gate) await gate;
			if (state.handBackFails > 0) {
				state.handBackFails--;
				return new Response("{}", { status: 503 });
			}
			// As the database: at the current epoch it moves on, and the member's lease taken under it ends; at an older one
			// nothing changes. It answers the current epoch and whether the member holds the machine now.
			const row = state.machines.find((machine) => machine.machineId === body.p_machine_id);
			let handedBack = false;
			if (body.p_epoch === epochOf(body.p_machine_id)) {
				state.epochs.set(String(body.p_machine_id), epochOf(body.p_machine_id) + 1);
				if (row?.control?.mine === true && row.control.epoch === body.p_epoch) {
					handedBack = true;
					state.machines = state.machines.map((machine) =>
						machine.machineId === body.p_machine_id ? { ...machine, control: null } : machine,
					);
				}
			}
			const now = state.machines.find((machine) => machine.machineId === body.p_machine_id);
			return Response.json({
				schema: "qorpera.member-machine-desktop/v1",
				state: "ok",
				handedBack,
				epoch: epochOf(body.p_machine_id),
				holding: now?.control?.mine === true,
			});
		}
		throw new Error(`Unexpected network request ${url}`);
	});
	vi.stubGlobal("fetch", fetch);
	const computer = new WebCompanyComputer(
		f.cloud,
		{ ...profileA, role: options.role ?? profileA.role },
		userA.id,
		stop.signal,
		() => {},
	);
	cleanup.push(() => stop.abort());
	let hint: ((resource: RealtimeResource) => void) | undefined;
	const hints: MachineHints = (listener) => {
		hint = listener;
		return () => {
			hint = undefined;
		};
	};
	const decode = vi.fn(async () => ({ width: 1600, height: 1000, close() {} }) as unknown as ImageBitmap);
	return {
		...f,
		stop,
		computer,
		fetch,
		state,
		looks,
		acts,
		rpcs,
		hints,
		decode,
		hint: (resource: RealtimeResource) => hint?.(resource),
	};
}
type Setup = ReturnType<typeof setup>;
/** A window opened on its own: its ledger of holds is its own, and ends with the company (the setup's signal). */
function panel(s: Setup, attach = true) {
	const value = new ComputerPanel(staff, s.computer, s.stop.signal, { hints: s.hints, decode: s.decode });
	if (attach) value.attach(document.body, () => value.dispose());
	cleanup.push(() => value.dispose());
	return value;
}
/** Lets the loop reach its next wait: a response's body is read on the event loop's own turns. */
async function flush() {
	for (let n = 0; n < 6; n++) {
		await settle();
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}
async function advance(ms: number) {
	await vi.advanceTimersByTimeAsync(ms);
	await flush();
}
function status(p: ComputerPanel) {
	return p.el.querySelector(".computer-loading [role=status]")?.textContent;
}
function detail(p: ComputerPanel) {
	const line = p.el.querySelector<HTMLElement>(".computer-loading-detail");
	return line?.hidden ? null : line?.textContent;
}
function action(p: ComputerPanel) {
	const button = p.el.querySelector<HTMLButtonElement>(".computer-loading .computer-retry");
	return button?.hidden ? null : button;
}
function screen(p: ComputerPanel) {
	return p.el.querySelector<HTMLElement>(".machine-screen");
}
function mark(p: ComputerPanel) {
	const value = p.el.querySelector<HTMLElement>(".machine-screen-mark");
	return value?.hidden ? null : value?.textContent;
}
function lists(s: Setup) {
	return s.rpcs.filter((call) => call.method === "qorpera_list_agent_machines").length;
}
function calls(s: Setup, method: string) {
	return s.rpcs.filter((call) => call.method === method);
}
/** The epochs the take-overs were sent at, and the hand-backs, in turn (review r5). */
function takeEpochs(s: Setup) {
	return calls(s, "qorpera_member_take_machine_desktop").map((call) => call.body.p_epoch);
}
function backEpochs(s: Setup) {
	return calls(s, "qorpera_member_hand_back_machine_desktop").map((call) => call.body.p_epoch);
}
function controls(p: ComputerPanel) {
	const value = p.el.querySelector<HTMLElement>(".machine-screen-control");
	return value?.hidden ? null : value;
}
function controlButton(p: ComputerPanel) {
	return controls(p)?.querySelector<HTMLButtonElement>(".machine-screen-control-button") ?? null;
}
function canvas(p: ComputerPanel) {
	return p.el.querySelector<HTMLCanvasElement>(".machine-screen-canvas")!;
}
/** The time between looks, `count` times, to `step` ms. */
async function gaps(s: Setup, count: number, step = 50) {
	const found: number[] = [];
	for (let n = 0; n < count; n++) {
		const before = s.looks.length;
		let waited = 0;
		while (s.looks.length === before && waited < 10_000) {
			await advance(step);
			waited += step;
		}
		found.push(waited);
	}
	return found;
}
/** A panel whose member holds the desktop of machine 1, its picture (1600 x 1000) drawn in an 800 x 500 box. */
async function holding(s: Setup = setup()) {
	s.state.answers.push({ picture: 1 });
	const p = panel(s);
	await flush();
	vi.spyOn(canvas(p), "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 800, 500));
	canvas(p).width = 1600;
	canvas(p).height = 1000;
	controlButton(p)!.click();
	await flush();
	return { s, p };
}
const pointer = (type: string, x: number, y: number, init: PointerEventInit = {}) =>
	new PointerEvent(type, {
		bubbles: true,
		cancelable: true,
		clientX: x,
		clientY: y,
		button: 0,
		pointerId: 1,
		...init,
	});
function press(target: HTMLElement, x: number, y: number, init: PointerEventInit = {}, to?: [number, number]) {
	target.dispatchEvent(pointer("pointerdown", x, y, init));
	if (to) target.dispatchEvent(pointer("pointermove", to[0], to[1], init));
	target.dispatchEvent(pointer("pointerup", to?.[0] ?? x, to?.[1] ?? y, init));
}
function key(target: HTMLElement, value: string, init: KeyboardEventInit = {}) {
	const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...init });
	target.dispatchEvent(event);
	return event;
}

describe("an agent's computer window", () => {
	it("shows the running desktop the agent uses, live, through the member bridge with the member's word", async () => {
		const s = setup();
		s.state.answers.push({ picture: 1 });
		const p = panel(s);
		// The X top right is there from the start, and the window says it connects.
		expect(p.el.querySelector("button.computer-close[aria-label='Close computer']")).not.toBeNull();
		expect(status(p)).toBe("Connecting…");
		await flush();
		expect(s.rpcs[0]).toEqual({
			method: "qorpera_list_agent_machines",
			body: { p_profile_id: profileA.profileId, p_staff_agent_id: staff.id },
		});
		// The first look says the member watches; the bridge carries it; no etag yet.
		expect(s.looks).toEqual([
			{ url: `/v1/member-machine-screens/${profileA.profileId}/${machine(1).machineId}/watching`, etag: null },
		]);
		expect(s.decode).toHaveBeenCalledOnce();
		expect(screen(p)?.hidden).toBe(false);
		expect(mark(p)).toBe("Live");
		expect(p.el.querySelector(".screen-viewer-enter")?.hasAttribute("disabled")).toBe(false);
		expect(screen(p)?.getAttribute("aria-label")).toBe(`${staff.displayName} · Computer`);
		// About a second after the last look began, the next asks with the picture the member has; it is the same.
		await advance(LOOK_EVERY_MS - 1);
		expect(s.looks).toHaveLength(1);
		await advance(1);
		expect(s.looks[1]).toEqual({
			url: `/v1/member-machine-screens/${profileA.profileId}/${machine(1).machineId}`,
			etag: etag(1),
		});
		expect(s.decode).toHaveBeenCalledOnce();
		expect(mark(p)).toBe("Live");
		// An owner may take it over (20260930713000); the picture takes no input until they do.
		expect(controlButton(p)?.textContent).toBe("Take over");
		expect(canvas(p).hasAttribute("tabindex")).toBe(false);
		expect(canvas(p).getAttribute("role")).toBe("img");
	});

	it("hides its state text while a picture shows, and says it again once the picture goes (production, 10 Nov)", async () => {
		const s = setup();
		s.state.answers.push({ code: "DESKTOP_NOT_RUNNING" });
		const p = panel(s);
		await flush();
		const loading = p.el.querySelector<HTMLElement>(".computer-loading")!;
		expect(loading.hidden).toBe(false);
		expect(status(p)).toBe(
			`The computer is on, but its screen is off. It turns on when ${staff.displayName} uses it.`,
		);
		s.state.answers.push({ picture: 1 });
		await advance(SCREEN_OFF_EVERY_MS);
		// The picture is up: its old sentence is not under it for a screen reader to read.
		expect(mark(p)).toBe("Live");
		expect(loading.hidden).toBe(true);
		s.state.answers.push({ code: "SCREEN_HELD" });
		await advance(LOOK_EVERY_MS);
		expect(mark(p)).toBe("Updating…");
		expect(loading.hidden).toBe(true);
		s.state.answers.push({ code: "DESKTOP_NOT_RUNNING" });
		await advance(2000);
		expect(screen(p)?.hidden).toBe(true);
		expect(loading.hidden).toBe(false);
		expect(status(p)).toBe(
			`The computer is on, but its screen is off. It turns on when ${staff.displayName} uses it.`,
		);
	});

	it("looks every 450 ms while the picture changes, every second after three unchanged, then every 2 s and 3 s", async () => {
		const s = setup();
		s.state.answers.push({ picture: 1 });
		const p = panel(s);
		await flush();
		// A look takes about 0.2 s: the next begins 450 ms after the last began (the database takes one per 400 ms).
		expect(LOOK_EVERY_MS).toBe(450);
		expect(await gaps(s, 3)).toEqual([450, 450, 450]);
		// After three unchanged, every second; after six, every 2 s; after thirteen, every 3 s.
		expect(await gaps(s, 3)).toEqual([1000, 1000, 1000]);
		expect(await gaps(s, 7)).toEqual([2000, 2000, 2000, 2000, 2000, 2000, 2000]);
		expect(await gaps(s, 2)).toEqual([3000, 3000]);
		// A click in the window: the next look within 450 ms of the last, and fast again.
		p.el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
		await flush();
		expect((await gaps(s, 1))[0]).toBeLessThanOrEqual(450);
		expect(await gaps(s, 3)).toEqual([450, 450, 1000]);
		// A machines hint: the list read again at once, and fast looks.
		const listed = lists(s);
		s.hint("machines");
		await flush();
		expect(lists(s)).toBe(listed + 1);
		expect(await gaps(s, 2)).toEqual([450, 450]);
		// Another resource's hint is not the window's.
		s.hint("sessions");
		await flush();
		expect(lists(s)).toBe(listed + 1);
		// A changed picture: fast again.
		s.state.answers.push("unchanged", "unchanged", "unchanged", { picture: 2 });
		await gaps(s, 4);
		expect(await gaps(s, 2)).toEqual([450, 450]);
		expect(s.decode).toHaveBeenCalledTimes(2);
	});

	it("says when the agent has no computer, or only machines without a screen", async () => {
		const none = setup({ machines: [] });
		const p = panel(none);
		await flush();
		expect(status(p)).toBe(`${staff.displayName} is not using a computer right now.`);
		expect(detail(p)).toBe(`${staff.displayName} gets one when a task needs a screen.`);
		expect(none.looks).toEqual([]);
		expect(screen(p)?.hidden).toBe(true);
		// One window at a time here: both would read through the one stubbed fetch.
		p.dispose();
		const headless = setup({ machines: [machine(1, { desktopCapable: false })] });
		const q = panel(headless);
		await flush();
		expect(status(q)).toBe(`${staff.displayName} is working on a machine without a screen.`);
		expect(detail(q)).toBeNull();
		expect(headless.looks).toEqual([]);
		// The list is read again every 15 s while the window is shown: a desktop that comes is shown.
		headless.state.machines = [machine(1, { desktopCapable: false }), machine(2)];
		headless.state.answers.push({ picture: 2 });
		await advance(MACHINES_EVERY_MS);
		expect(headless.looks[0]?.url).toContain(machine(2).machineId);
		expect(mark(q)).toBe("Live");
	});

	it("wakes a sleeping computer for those who may, and tells a viewer who may", async () => {
		const s = setup({ machines: [machine(1, { state: "stopped" })] });
		const p = panel(s);
		await flush();
		expect(status(p)).toBe("The computer is asleep.");
		expect(action(p)?.textContent).toBe("Wake it");
		expect(s.looks).toEqual([]);
		s.state.machines = [machine(1, { state: "waiting", waitingFor: "room" })];
		action(p)!.click();
		await flush();
		expect(s.rpcs.find((call) => call.method === "qorpera_member_manage_company_machine")?.body).toEqual({
			p_profile_id: profileA.profileId,
			p_machine_id: machine(1).machineId,
			p_action: "start",
		});
		expect(status(p)).toBe("The computer is starting…");
		expect(detail(p)).toBe("Waiting for room on our servers. It starts as soon as there is room.");
		s.state.machines = [machine(1, { state: "waiting", waitingFor: "hours" })];
		await advance(MACHINES_EVERY_MS);
		expect(detail(p)).toBe("Out of computer hours. The machine starts by itself once hours are added.");
		s.state.machines = [machine(1, { state: "starting" })];
		await advance(MACHINES_EVERY_MS);
		expect(status(p)).toBe("The computer is starting…");
		expect(detail(p)).toBeNull();
		// A viewer watches, and cannot wake.
		const viewer = setup({ machines: [machine(1, { state: "stopping" })], canWake: false, role: "viewer" });
		const q = panel(viewer);
		await flush();
		expect(status(q)).toBe("The computer is asleep.");
		expect(detail(q)).toBe("Someone with edit access can wake it.");
		expect(action(q)).toBeNull();
	});

	it("says the screen is off, hides it from a member who may not see what it shows, and keeps the last picture while it is held", async () => {
		const s = setup();
		s.state.answers.push({ code: "DESKTOP_NOT_RUNNING" });
		const p = panel(s);
		await flush();
		expect(status(p)).toBe(
			`The computer is on, but its screen is off. It turns on when ${staff.displayName} uses it.`,
		);
		expect(screen(p)?.hidden).toBe(true);
		// Looked at again every 5 s: the agent turned it on.
		s.state.answers.push({ picture: 1 });
		await advance(SCREEN_OFF_EVERY_MS - 1);
		expect(s.looks).toHaveLength(1);
		await advance(1);
		expect(mark(p)).toBe("Live");
		// The company folder has not released the next one: the last stays, marked.
		s.state.answers.push({ code: "SCREEN_HELD" });
		await advance(LOOK_EVERY_MS);
		expect(screen(p)?.hidden).toBe(false);
		expect(mark(p)).toBe("Updating…");
		s.state.answers.push("unchanged");
		await advance(2000);
		expect(mark(p)).toBe("Live");
		// The screen may show a file this member may not open: no picture at all, and nothing of it kept.
		s.state.answers.push({ code: "SCREEN_HIDDEN" });
		await advance(LOOK_EVERY_MS);
		expect(screen(p)?.hidden).toBe(true);
		expect(status(p)).toBe("The screen is hidden because it may show files you can't open.");
		s.state.answers.push({ picture: 3 });
		await advance(SCREEN_OFF_EVERY_MS);
		expect(s.looks.at(-1)?.etag).toBeNull();
		expect(mark(p)).toBe("Live");
		// A disk the member may not see says the same.
		s.state.answers.push({ code: "MACHINE_NEEDS_COMPANY_VIEW" });
		await advance(LOOK_EVERY_MS);
		expect(status(p)).toBe("The screen is hidden because it may show files you can't open.");
		// An image that cannot take pictures yet.
		s.state.answers.push({ code: "MACHINE_IMAGE_WITHOUT_SCREEN" });
		await advance(SCREEN_OFF_EVERY_MS);
		expect(status(p)).toBe("This computer cannot show its screen yet. It can after it has slept.");
	});

	it("reads the list again when the machine stopped under a look, and after a refused look too soon, looks again", async () => {
		const s = setup();
		s.state.answers.push({ picture: 1 }, { code: "MACHINE_NOT_RUNNING" });
		const p = panel(s);
		await flush();
		const listed = lists(s);
		s.state.machines = [machine(1, { state: "stopped" })];
		await advance(LOOK_EVERY_MS);
		expect(lists(s)).toBe(listed + 1);
		expect(status(p)).toBe("The computer is asleep.");
		expect(screen(p)?.hidden).toBe(true);
		const t = setup();
		t.state.answers.push({ code: "SCREEN_TOO_SOON" }, { picture: 1 });
		const q = panel(t);
		await flush();
		await advance(LOOK_EVERY_MS);
		expect(mark(q)).toBe("Live");
	});

	it("looks only while a thread shows it and its tab is visible", async () => {
		const s = setup();
		s.state.answers.push({ picture: 1 });
		const p = panel(s, false);
		await advance(5000);
		expect(s.looks).toEqual([]);
		expect(lists(s)).toBe(0);
		p.attach(document.body, () => p.dispose());
		await flush();
		expect(s.looks).toHaveLength(1);
		p.detach();
		await advance(60_000);
		expect(s.looks).toHaveLength(1);
		p.attach(document.body, () => p.dispose());
		await flush();
		expect(s.looks).toHaveLength(2);
		let visibility: DocumentVisibilityState = "hidden";
		Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
		cleanup.push(() => Reflect.deleteProperty(document, "visibilityState"));
		await advance(LOOK_EVERY_MS);
		const seen = s.looks.length;
		await advance(60_000);
		expect(s.looks).toHaveLength(seen);
		visibility = "visible";
		document.dispatchEvent(new Event("visibilitychange"));
		await flush();
		expect(s.looks).toHaveLength(seen + 1);
	});

	it("pauses after 30 minutes without a touch on the page, and goes on with the member's word when they keep watching", async () => {
		const s = setup();
		s.state.answers.push({ picture: 1 });
		const p = panel(s);
		await flush();
		// A touch within 30 minutes keeps it going; every 5 minutes the touch says again that the member watches.
		vi.setSystemTime(Date.now() + PAUSE_AFTER_MS - 60_000);
		const before = s.looks.length;
		document.dispatchEvent(new PointerEvent("pointermove"));
		await advance(3000);
		const said = s.looks.slice(before).map((look) => look.url.endsWith("/watching"));
		expect(said[0]).toBe(true);
		expect(said.length).toBeGreaterThan(1);
		expect(said.slice(1).every((watching) => !watching)).toBe(true);
		expect(action(p)).toBeNull();
		// Then 30 minutes without one: paused, and no looks.
		vi.setSystemTime(Date.now() + PAUSE_AFTER_MS);
		await advance(3000);
		expect(status(p)).toBe("Paused to save power. Still watching?");
		expect(screen(p)?.hidden).toBe(true);
		const seen = s.looks.length;
		await advance(60_000);
		expect(s.looks).toHaveLength(seen);
		expect(action(p)?.textContent).toBe("Keep watching");
		action(p)!.click();
		await flush();
		expect(s.looks).toHaveLength(seen + 1);
		expect(s.looks.at(-1)).toMatchObject({ url: expect.stringMatching(/\/watching$/), etag: null });
		// Paused again: a thread showing the window again is the member's word too.
		vi.setSystemTime(Date.now() + PAUSE_AFTER_MS);
		await advance(3000);
		expect(status(p)).toBe("Paused to save power. Still watching?");
		const paused = s.looks.length;
		p.detach();
		p.attach(document.body, () => p.dispose());
		await flush();
		expect(s.looks).toHaveLength(paused + 1);
		expect(s.looks.at(-1)?.url).toMatch(/\/watching$/);
	});

	it("switches between the agent's desktops from its menu, and keeps headless machines out of it", async () => {
		const s = setup({
			machines: [machine(1), machine(2, { state: "stopped" }), machine(3, { desktopCapable: false })],
		});
		s.state.answers.push({ picture: 1 });
		const p = panel(s);
		await flush();
		const switcher = p.el.querySelector<HTMLButtonElement>(":scope > .computer-switcher")!;
		expect(switcher.hidden).toBe(false);
		expect(switcher.textContent).toBe("desk-1");
		expect(switcher.getAttribute("aria-label")).toBe("Choose a computer");
		switcher.click();
		const menu = openMenu()!.el;
		expect([...menu.querySelectorAll("[role^=menuitem]")].map((row) => row.textContent)).toEqual([
			expect.stringContaining("desk-1"),
			expect.stringContaining("desk-2"),
		]);
		expect(menu.querySelector("[aria-checked=true]")?.textContent).toContain("desk-1");
		[...menu.querySelectorAll<HTMLElement>("[role^=menuitem]")][1]!.click();
		await flush();
		expect(status(p)).toBe("The computer is asleep.");
		expect(screen(p)?.hidden).toBe(true);
		expect(switcher.textContent).toBe("desk-2");
		// One desktop: no switcher.
		const one = setup({ machines: [machine(1), machine(3, { desktopCapable: false })] });
		const q = panel(one);
		await flush();
		expect(q.el.querySelector<HTMLButtonElement>(":scope > .computer-switcher")!.hidden).toBe(true);
	});

	it("says the member watches each machine they switch to, and not only the first (review r1 F2)", async () => {
		const s = setup({ machines: [machine(1), machine(2)] });
		s.state.answers.push({ picture: 1 });
		const p = panel(s);
		await flush();
		const watching = (n: number) => new RegExp(`/${machine(n).machineId}/watching$`);
		expect(s.looks[0]?.url).toMatch(watching(1));
		await advance(LOOK_EVERY_MS);
		expect(s.looks[1]?.url).toMatch(new RegExp(`/${machine(1).machineId}$`));
		// Within five minutes of the word for the first machine, the member chooses the second: its first look says it.
		const choose = (row: number) => {
			p.el.querySelector<HTMLButtonElement>(":scope > .computer-switcher")!.click();
			[...openMenu()!.el.querySelectorAll<HTMLElement>("[role^=menuitem]")][row]!.click();
		};
		s.state.answers.push({ picture: 2 });
		choose(1);
		await flush();
		expect(s.looks.at(-1)?.url).toMatch(watching(2));
		await advance(LOOK_EVERY_MS);
		expect(s.looks.at(-1)?.url).toMatch(new RegExp(`/${machine(2).machineId}$`));
		// And back again: the first machine hears it once more.
		s.state.answers.push({ picture: 1 });
		choose(0);
		await flush();
		expect(s.looks.at(-1)?.url).toMatch(watching(1));
	});

	it("opens the switcher's menu inside the full-screen frame, where the browser shows it (review r1 F3)", async () => {
		const s = setup({ machines: [machine(1), machine(2)] });
		s.state.answers.push({ picture: 1 });
		const p = panel(s);
		await flush();
		// On the preview, the menu is the page's, as every menu.
		p.el.querySelector<HTMLButtonElement>(":scope > .computer-switcher")!.click();
		expect(openMenu()!.el.parentElement).toBe(document.body);
		openMenu()!.close();
		const overlay = p.el.querySelector<HTMLElement>(".machine-screen")!;
		p.el.querySelector<HTMLButtonElement>(".screen-viewer-enter")!.click();
		const inFrame = overlay.querySelector<HTMLButtonElement>(".computer-switcher")!;
		expect(inFrame.hidden).toBe(false);
		expect(inFrame.textContent).toBe("desk-1");
		// Full screen: the browser shows only the full-screen element, so the menu goes inside it.
		Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => overlay });
		cleanup.push(() => Reflect.deleteProperty(document, "fullscreenElement"));
		inFrame.click();
		const menu = openMenu()!.el;
		expect(menu.parentElement).toBe(overlay);
		expect([...menu.querySelectorAll("[role^=menuitem]")].map((row) => row.textContent)).toEqual([
			expect.stringContaining("desk-1"),
			expect.stringContaining("desk-2"),
		]);
		s.state.answers.push({ picture: 2 });
		[...menu.querySelectorAll<HTMLElement>("[role^=menuitem]")][1]!.click();
		// The member stays in the entered frame: the last picture stays, marked, until the next machine's comes.
		await flush();
		expect(s.looks.at(-1)?.url).toContain(machine(2).machineId);
		expect(p.el.classList.contains("is-entered")).toBe(true);
		expect(mark(p)).toBe("Live");
		expect(inFrame.textContent).toBe("desk-2");
		// The browser refused full screen: the entered frame stays in the page, and so does the menu.
		Reflect.deleteProperty(document, "fullscreenElement");
		inFrame.click();
		expect(openMenu()!.el.parentElement).toBe(document.body);
		openMenu()!.close();
	});

	it("says it cannot reach the computer after two failed reads, and tries again", async () => {
		const s = setup();
		s.state.listFails = 2;
		s.state.answers.push({ picture: 1 });
		const p = panel(s);
		await flush();
		expect(status(p)).toBe("Connecting…");
		await advance(2000);
		expect(status(p)).toBe("The computer could not be reached. Try again.");
		action(p)!.click();
		await flush();
		expect(mark(p)).toBe("Live");
		// A failed look keeps the last picture, marked, and backs off.
		s.state.answers.push({ status: 503 });
		await advance(LOOK_EVERY_MS);
		expect(mark(p)).toBe("Updating…");
		const seen = s.looks.length;
		await advance(1999);
		expect(s.looks).toHaveLength(seen);
		s.state.answers.push({ picture: 2 });
		await advance(1);
		expect(mark(p)).toBe("Live");
	});

	it("enters and goes back as the old viewer did, and Escape goes back before it closes", async () => {
		const s = setup();
		s.state.answers.push({ picture: 1 });
		const thread = document.createElement("div");
		const conversation = document.createElement("div");
		conversation.className = "thread-conversation";
		const header = document.createElement("div");
		header.className = "thread-header";
		const message = document.createElement("div");
		conversation.append(header, message);
		thread.append(conversation);
		document.body.append(thread);
		const close = vi.fn();
		const p = new ComputerPanel(staff, s.computer, s.stop.signal, { hints: s.hints, decode: s.decode });
		cleanup.push(() => p.dispose());
		p.attach(thread, close);
		await flush();
		p.el.querySelector<HTMLButtonElement>(".screen-viewer-enter")!.click();
		expect(p.el.classList.contains("is-entered")).toBe(true);
		expect(message.inert).toBe(true);
		expect(header.inert).not.toBe(true);
		const back = p.el.querySelector<HTMLButtonElement>(".screen-viewer-back")!;
		expect(back.hidden).toBe(false);
		expect(back.getAttribute("aria-label")).toBe("Back to thread");
		p.el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(p.el.classList.contains("is-entered")).toBe(false);
		expect(message.inert).not.toBe(true);
		expect(close).not.toHaveBeenCalled();
		p.el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(close).toHaveBeenCalledOnce();
	});

	it("closes for good from the X top right, follows a rename, and ends with the company", async () => {
		const s = setup();
		s.state.answers.push({ picture: 1 });
		const panels = new ComputerPanels(s.computer, s.stop.signal, { hints: s.hints });
		const p = panels.open(staff)!;
		const close = vi.fn();
		p.el.querySelector<HTMLButtonElement>(".computer-close")!.click();
		expect(close).not.toHaveBeenCalled();
		p.attach(document.body, close);
		await flush();
		p.el.querySelector<HTMLButtonElement>(".computer-close")!.click();
		expect(close).toHaveBeenCalledOnce();
		expect(panels.open({ ...staff, displayName: "Renamed" })).toBe(p);
		expect(p.el.querySelector(".machine-screen")?.getAttribute("aria-label")).toBe("Renamed · Computer");
		s.stop.abort();
		await flush();
		expect(panels.get(staff.id)).toBeUndefined();
		expect(panels.open(staff)).toBeUndefined();
	});

	it("forgets a press's pointer focus when a thread detaches the panel", () => {
		const s = setup();
		const p = panel(s);
		p.el.setPointerCapture = vi.fn();
		p.el.hasPointerCapture = vi.fn(() => false);
		p.el.releasePointerCapture = vi.fn();
		p.el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, isPrimary: true, button: 0 }));
		expect(p.el.classList.contains("is-pointer-focus")).toBe(true);
		p.detach();
		expect(p.el.classList.contains("is-pointer-focus")).toBe(false);
	});

	it("says computer access is not available without a transport, and asks nothing", () => {
		const p = new ComputerPanel(staff);
		cleanup.push(() => p.dispose());
		p.attach(document.body, () => {});
		expect(status(p)).toBe("Computer access is not available yet.");
	});
});

describe("a member's look through the member bridge", () => {
	function transport(answer: () => Response, route = (url: string) => url.replace(gateway, bridge)) {
		const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => answer());
		const screens = createWebMachineScreens({
			companyId: profileA.profileId,
			objectGatewayUrl: gateway,
			route,
			accessToken: async () => "member-token",
			fetch: fetch as typeof globalThis.fetch,
		});
		return { fetch, screens };
	}
	const signal = new AbortController().signal;
	const picture = () =>
		new Response(new Uint8Array([0x89, 0x50]), {
			status: 200,
			headers: { "content-type": "image/png", etag: `"${etag(7)}"` },
		});

	it("asks with the member's token and etag alone, through the bridge, and takes a picture, 304 or a refusal", async () => {
		const t = transport(picture);
		const look = await t.screens.look(machine(1).machineId, { etag: etag(1), watching: true }, signal);
		expect(look).toMatchObject({ kind: "picture", etag: etag(7) });
		expect(look.kind === "picture" && look.png.type).toBe("image/png");
		const [url, init] = t.fetch.mock.calls[0]!;
		expect(url).toBe(`${bridge}/v1/member-machine-screens/${profileA.profileId}/${machine(1).machineId}/watching`);
		expect(init).toMatchObject({
			method: "GET",
			headers: { authorization: "Bearer member-token", "if-none-match": `"${etag(1)}"` },
			redirect: "error",
			cache: "no-store",
			credentials: "omit",
		});
		const same = transport(() => new Response(null, { status: 304, headers: { etag: `"${etag(1)}"` } }));
		expect(await same.screens.look(machine(1).machineId, { etag: etag(1), watching: false }, signal)).toEqual({
			kind: "unchanged",
		});
		expect(same.fetch.mock.calls[0]![0]).not.toMatch(/watching/);
		const refused = transport(() => Response.json({ code: "SCREEN_HIDDEN" }, { status: 409 }));
		expect(await refused.screens.look(machine(1).machineId, { etag: null, watching: false }, signal)).toEqual({
			kind: "refused",
			code: "SCREEN_HIDDEN",
		});
		const plain = transport(
			() => picture(),
			(url) => url,
		);
		await plain.screens.look(machine(1).machineId, { etag: null, watching: false }, signal);
		expect(plain.fetch.mock.calls[0]![0]).toBe(
			`${gateway}/v1/member-machine-screens/${profileA.profileId}/${machine(1).machineId}`,
		);
		expect(new Headers(plain.fetch.mock.calls[0]![1]!.headers as HeadersInit).has("if-none-match")).toBe(false);
	});

	it("takes no answer that is not one", async () => {
		for (const answer of [
			() => new Response(null, { status: 304, headers: { etag: `"${etag(2)}"` } }),
			() => Response.json({ code: "SOMETHING_ELSE" }, { status: 409 }),
			() => new Response("x", { status: 200, headers: { "content-type": "text/html", etag: `"${etag(7)}"` } }),
			() => new Response("x", { status: 200, headers: { "content-type": "image/png", etag: etag(7) } }),
			() => new Response("x", { status: 200, headers: { "content-type": "image/png" } }),
			() => new Response("{}", { status: 401 }),
		]) {
			const t = transport(answer);
			await expect(
				t.screens.look(machine(1).machineId, { etag: etag(1), watching: false }, signal),
			).rejects.toThrow();
		}
		await expect(transport(picture).screens.look("machine", { etag: null, watching: false }, signal)).rejects.toThrow(
			"Invalid machine screen",
		);
	});

	it("does not send another account's token", async () => {
		const s = setup();
		s.auth(userB);
		await expect(
			s.computer.screens.look(machine(1).machineId, { etag: null, watching: false }, s.stop.signal),
		).rejects.toThrow();
		await expect(s.computer.agentMachines(staff.id, s.stop.signal)).rejects.toThrow();
		expect(s.fetch).not.toHaveBeenCalled();
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

describe("a member's take-over of the desktop (20260930713000)", () => {
	it("takes the desktop over, says what it means, renews it every minute and hands it back", async () => {
		const { s, p } = await holding();
		// The take-over is sent at the member's hand-back epoch the list said (review r5).
		expect(calls(s, "qorpera_member_take_machine_desktop")).toEqual([
			{
				method: "qorpera_member_take_machine_desktop",
				body: { p_profile_id: profileA.profileId, p_machine_id: machine(1).machineId, p_epoch: 0 },
			},
		]);
		expect(p.holding).toBe(true);
		// The words never say the agent cannot see: it gets no pictures (the agent is root on that machine).
		expect(controls(p)?.textContent).toContain(
			`You are using the computer. ${staff.displayName} gets no pictures of the screen while you use it.`,
		);
		expect(controls(p)?.textContent).not.toMatch(/cannot see/);
		expect(controlButton(p)?.textContent).toBe("Hand back");
		// The picture takes the keyboard.
		expect(canvas(p).getAttribute("tabindex")).toBe("0");
		expect(canvas(p).getAttribute("role")).toBe("application");
		expect(document.activeElement).toBe(canvas(p));
		// Renewed every minute while the window shows it.
		await advance(KEEP_EVERY_MS - 1);
		expect(calls(s, "qorpera_member_keep_machine_desktop")).toHaveLength(0);
		await advance(1);
		expect(calls(s, "qorpera_member_keep_machine_desktop")).toEqual([
			{
				method: "qorpera_member_keep_machine_desktop",
				body: { p_profile_id: profileA.profileId, p_machine_id: machine(1).machineId, p_epoch: 0 },
			},
		]);
		await advance(KEEP_EVERY_MS);
		expect(calls(s, "qorpera_member_keep_machine_desktop")).toHaveLength(2);
		// Hand back: the database has it back, the picture takes no input, Take over again.
		controlButton(p)!.click();
		await flush();
		expect(calls(s, "qorpera_member_hand_back_machine_desktop").map((call) => call.body)).toEqual([
			{
				p_profile_id: profileA.profileId,
				p_machine_id: machine(1).machineId,
				p_reason: "handed_back",
				p_epoch: 0,
			},
		]);
		expect(p.holding).toBe(false);
		expect(controlButton(p)?.textContent).toBe("Take over");
		expect(canvas(p).hasAttribute("tabindex")).toBe(false);
		await advance(KEEP_EVERY_MS * 2);
		expect(calls(s, "qorpera_member_keep_machine_desktop")).toHaveLength(2);
	});

	it("sends clicks, double and right clicks, drags and the wheel at the screen's own pixels, one at a time", async () => {
		const { s, p } = await holding();
		const target = canvas(p);
		// A press in the middle of an 800 x 500 box showing 1600 x 1000: the screen's (800, 500), once no second comes.
		press(target, 400, 250);
		await advance(DOUBLE_CLICK_MS - 1);
		expect(s.acts).toEqual([]);
		await advance(1);
		expect(s.acts.map((act) => act.action)).toEqual([{ type: "click", x: 800, y: 500 }]);
		expect(s.acts[0]!.url).toBe(`/v1/member-machine-screens/${profileA.profileId}/${machine(1).machineId}/act`);
		// Two presses close together: one double click.
		press(target, 100, 50);
		press(target, 101, 50);
		await advance(DOUBLE_CLICK_MS);
		expect(s.acts.at(-1)!.action).toEqual({ type: "double", x: 200, y: 100 });
		// A right press, at once; a middle one too.
		press(target, 10, 20, { button: 2 });
		await flush();
		expect(s.acts.at(-1)!.action).toEqual({ type: "click", x: 20, y: 40, button: "right" });
		const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
		target.dispatchEvent(menu);
		expect(menu.defaultPrevented).toBe(true);
		// A drag from where it began to where it ends.
		press(target, 50, 50, {}, [300, 200]);
		await flush();
		expect(s.acts.at(-1)!.action).toEqual({ type: "drag", x: 100, y: 100, toX: 600, toY: 400 });
		// The wheel: turns within 100 ms are one scroll, at the pointer.
		const before = s.acts.length;
		for (const deltaY of [100, 100, 120])
			target.dispatchEvent(
				new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 400, clientY: 100, deltaY }),
			);
		await advance(100);
		expect(s.acts.slice(before).map((act) => act.action)).toEqual([
			{ type: "scroll", direction: "down", steps: 3, x: 800, y: 200 },
		]);
		target.dispatchEvent(
			new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 0, clientY: 0, deltaY: -40 }),
		);
		await advance(100);
		expect(s.acts.at(-1)!.action).toEqual({ type: "scroll", direction: "up", steps: 1, x: 0, y: 0 });
		// A press does not drag the panel: the computer's.
		expect(p.el.classList.contains("is-dragging")).toBe(false);
	});

	it("maps a press by the picture as drawn, letterboxed, and takes none outside it", async () => {
		const { s, p } = await holding();
		// 1000 x 500 box: the 1600 x 1000 picture drawn at half size, 100 px in from each side.
		vi.spyOn(canvas(p), "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 500));
		press(canvas(p), 100, 0, { button: 2 });
		press(canvas(p), 899, 499, { button: 2 });
		press(canvas(p), 50, 250, { button: 2 });
		press(canvas(p), 950, 250, { button: 2 });
		await flush();
		await flush();
		expect(s.acts.map((act) => act.action)).toEqual([
			{ type: "click", x: 0, y: 0, button: "right" },
			{ type: "click", x: 1598, y: 998, button: "right" },
		]);
	});

	it("gathers typed text into one action, sends keys by their names in order, pastes the member's clipboard, and keeps Escape", async () => {
		const close = vi.fn();
		const s = setup();
		s.state.answers.push({ picture: 1 });
		const p = new ComputerPanel(staff, s.computer, s.stop.signal, { hints: s.hints, decode: s.decode });
		cleanup.push(() => p.dispose());
		p.attach(document.body, close);
		await flush();
		controlButton(p)!.click();
		await flush();
		const target = canvas(p);
		for (const value of ["H", "e", "j", " ", "Å", "s", "e"]) key(target, value);
		await advance(TYPE_BATCH_MS - 1);
		expect(s.acts).toEqual([]);
		await advance(1);
		expect(s.acts.map((act) => act.action)).toEqual([{ type: "type", text: "Hej Åse" }]);
		// Text first, then the key that follows it; a shortcut by its key's place; modifiers alone are nothing.
		key(target, "x");
		const enter = key(target, "Enter");
		expect(enter.defaultPrevented).toBe(true);
		key(target, "Shift", { shiftKey: true });
		key(target, "L", { code: "KeyL", ctrlKey: true, shiftKey: true });
		key(target, "Tab", { shiftKey: true });
		key(target, "ArrowLeft");
		await flush();
		await flush();
		expect(s.acts.slice(1).map((act) => act.action)).toEqual([
			{ type: "type", text: "x" },
			{ type: "key", keys: ["Return"] },
			{ type: "key", keys: ["ctrl+shift+l"] },
			{ type: "key", keys: ["shift+Tab"] },
			{ type: "key", keys: ["Left"] },
		]);
		// Escape is the computer's while it has the keyboard: the window stays.
		key(target, "Escape");
		await flush();
		expect(s.acts.at(-1)!.action).toEqual({ type: "key", keys: ["Escape"] });
		expect(close).not.toHaveBeenCalled();
		// shift+Escape is the way out: to the controls, and nothing is sent.
		const sent = s.acts.length;
		key(target, "Escape", { shiftKey: true });
		await flush();
		expect(s.acts).toHaveLength(sent);
		expect(document.activeElement).toBe(controlButton(p));
		// ctrl+v is the member's own paste: what is on their clipboard is typed.
		const paste = key(target, "v", { code: "KeyV", ctrlKey: true });
		expect(paste.defaultPrevented).toBe(false);
		const clip = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
		Object.defineProperty(clip, "clipboardData", { value: { getData: () => "pässword\r\n" } });
		target.dispatchEvent(clip);
		await flush();
		expect(s.acts.at(-1)!.action).toEqual({ type: "type", text: "pässword\n" });
	});

	it("cuts a long text into actions of 500 characters, without control characters", () => {
		expect(machineTexts("a\u0007b\r\nc\td")).toEqual(["ab\nc\td"]);
		expect(machineTexts("x".repeat(1201)).map((part) => part.length)).toEqual([500, 500, 201]);
		expect(machineTexts("")).toEqual([]);
	});

	it("sends one action at a time, typed texts that wait together as one, and looks again fast after each", async () => {
		const { s, p } = await holding();
		let release = () => {};
		const hold = new Promise<void>((resolve) => {
			release = resolve;
		});
		s.state.actAnswers.push({ hold, exitCode: 0 });
		press(canvas(p), 10, 10, { button: 2 });
		await flush();
		expect(s.acts).toHaveLength(1);
		for (const value of ["a", "b"]) key(canvas(p), value);
		await advance(TYPE_BATCH_MS);
		for (const value of ["c", "d"]) key(canvas(p), value);
		await advance(TYPE_BATCH_MS);
		// The first is still on its way: nothing else went.
		expect(s.acts).toHaveLength(1);
		const looked = s.looks.length;
		release();
		await flush();
		await flush();
		expect(s.acts.map((act) => act.action)).toEqual([
			{ type: "click", x: 20, y: 20, button: "right" },
			{ type: "type", text: "abcd" },
		]);
		// The screen changed (or may have): the next look within 450 ms.
		await advance(LOOK_EVERY_MS);
		expect(s.looks.length).toBeGreaterThan(looked);
	});

	it("waits for an agent's step that holds the desktop, says so, and then acts", async () => {
		const { s, p } = await holding();
		s.state.actAnswers.push({ code: "DESKTOP_BUSY" }, { code: "DESKTOP_BUSY" });
		press(canvas(p), 10, 10, { button: 2 });
		await flush();
		expect(controls(p)?.textContent).toContain(`Waiting for ${staff.displayName} to finish a step…`);
		await advance(1000);
		await advance(1000);
		expect(s.acts).toHaveLength(3);
		expect(controls(p)?.textContent).not.toContain("Waiting for");
		// Busy past 15 s: the action is dropped, and the next goes.
		s.state.actAnswers.push(...Array.from({ length: 20 }, () => ({ code: "DESKTOP_BUSY" })));
		press(canvas(p), 20, 20, { button: 2 });
		await advance(16_000);
		expect(controls(p)?.textContent).not.toContain("Waiting for");
		s.state.actAnswers.splice(0);
		const before = s.acts.length;
		press(canvas(p), 30, 30, { button: 2 });
		await flush();
		expect(s.acts.slice(before).map((act) => act.action)).toEqual([{ type: "click", x: 60, y: 60, button: "right" }]);
	});

	it("lets go when the hold ended under it: an action told so, or the heartbeat told so", async () => {
		const { s, p } = await holding();
		// As the database: the hold ran out, so the list says no one holds it.
		s.state.actAnswers.push({ code: "DESKTOP_CONTROL_ENDED" });
		s.state.machines = [machine(1)];
		press(canvas(p), 10, 10, { button: 2 });
		await flush();
		expect(p.holding).toBe(false);
		expect(controlButton(p)?.textContent).toBe("Take over");
		// One window at a time: each setup stubs the one fetch.
		p.dispose();
		const second = await holding();
		// The heartbeat hears it ended (the database's list says so too, from then on).
		await advance(KEEP_EVERY_MS - 100);
		expect(second.p.holding).toBe(true);
		second.s.state.keep = { state: "ended" };
		second.s.state.machines = [machine(1)];
		await advance(100);
		expect(calls(second.s, "qorpera_member_keep_machine_desktop")).toHaveLength(1);
		expect(second.p.holding).toBe(false);
		expect(controlButton(second.p)?.textContent).toBe("Take over");
	});

	it("shows who holds the desktop to another member, not the screen, until they give it back or their time runs out", async () => {
		const until = new Date(Date.now() + 120_000).toISOString();
		const s = setup({ machines: [machine(1, { control: { mine: false, name: "Ada", until, epoch: null } })] });
		const p = panel(s);
		await flush();
		expect(status(p)).toBe("Ada is using the computer. The screen is hidden meanwhile.");
		expect(screen(p)?.hidden).toBe(true);
		expect(controls(p)).toBeNull();
		expect(s.looks).toEqual([]);
		// Given back: the hint reads the list again, and the screen shows.
		s.state.machines = [machine(1)];
		s.state.answers.push({ picture: 1 });
		s.hint("machines");
		await flush();
		expect(mark(p)).toBe("Live");
		// Taken over by Ada while this member watches: a refused look reads the list, which says who.
		s.state.machines = [machine(1, { control: { mine: false, name: "Ada", until, epoch: null } })];
		s.state.answers.push({ code: "DESKTOP_MEMBER_IN_CONTROL" });
		await advance(LOOK_EVERY_MS);
		await flush();
		expect(status(p)).toBe("Ada is using the computer. The screen is hidden meanwhile.");
		// Her time runs out with no hint: the list is read again at its end.
		const listed = lists(s);
		s.state.machines = [machine(1)];
		s.state.answers.push({ picture: 2 });
		await advance(Date.parse(until) - Date.now() + 500);
		expect(lists(s)).toBeGreaterThan(listed);
		expect(mark(p)).toBe("Live");
	});

	it("offers a viewer no take-over, and a database before it neither", async () => {
		// One window at a time: each setup stubs the one fetch.
		for (const options of [{ role: "viewer", canTakeOver: false }, { canTakeOver: false }] as const) {
			const s = setup(options);
			s.state.answers.push({ picture: 1 });
			const p = panel(s);
			await flush();
			expect(mark(p)).toBe("Live");
			expect(controls(p)).toBeNull();
			p.takeOver();
			await flush();
			expect(calls(s, "qorpera_member_take_machine_desktop")).toEqual([]);
			p.dispose();
		}
	});

	it("tells a member who may not take over now why: another holds it", async () => {
		const s = setup();
		s.state.answers.push({ picture: 1 });
		s.state.take = { state: "refused", reason: "DESKTOP_MEMBER_IN_CONTROL", memberName: "Ada" };
		const p = panel(s);
		await flush();
		const until = new Date(Date.now() + 120_000).toISOString();
		s.state.machines = [machine(1, { control: { mine: false, name: "Ada", until, epoch: null } })];
		controlButton(p)!.click();
		await flush();
		await flush();
		expect(p.holding).toBe(false);
		expect(status(p)).toBe("Ada is using the computer. The screen is hidden meanwhile.");
	});

	it("takes over from the agent's card once the window has the desktop, and hands back when the window closes", async () => {
		const s = setup();
		s.state.answers.push({ picture: 1 });
		const p = panel(s);
		// The card's Take over comes before the window read anything.
		p.takeOver();
		await flush();
		expect(calls(s, "qorpera_member_take_machine_desktop")).toHaveLength(1);
		expect(p.holding).toBe(true);
		p.dispose();
		await flush();
		expect(calls(s, "qorpera_member_hand_back_machine_desktop").map((call) => call.body.p_reason)).toEqual([
			"closed",
		]);
	});

	it("resumes a hold the list says is the member's (the page was loaded again), and hands it back as the page goes", async () => {
		const until = new Date(Date.now() + 120_000).toISOString();
		// The page was loaded again: the list says the member holds it, taken under their epoch 3, which this page never knew.
		const s = setup({ machines: [machine(1, { control: { mine: true, name: "Owner", until, epoch: 3 } })] });
		s.state.epochs.set(machine(1).machineId, 3);
		s.state.answers.push({ picture: 1 });
		const p = panel(s);
		await flush();
		expect(p.holding).toBe(true);
		expect(controlButton(p)?.textContent).toBe("Hand back");
		// Its heartbeat names that epoch.
		await advance(KEEP_EVERY_MS);
		expect(calls(s, "qorpera_member_keep_machine_desktop").map((call) => call.body.p_epoch)).toEqual([3]);
		window.dispatchEvent(new Event("pagehide"));
		const left = s.fetch.mock.calls.find(
			([url, init]) => String(url).endsWith("/qorpera_member_hand_back_machine_desktop") && init?.keepalive === true,
		);
		expect(left?.[1]).toMatchObject({ method: "POST", keepalive: true });
		expect(JSON.parse(String(left?.[1]?.body))).toEqual({
			p_profile_id: profileA.profileId,
			p_machine_id: machine(1).machineId,
			p_reason: "closed",
			p_epoch: 3,
		});
		// The page may come back from the browser's cache: the hold is given back as ever too, not only by the keepalive.
		await flush();
		expect(p.holding).toBe(false);
		expect(
			calls(s, "qorpera_member_hand_back_machine_desktop").filter((call) => call.body.p_epoch === 3),
		).toHaveLength(2);
	});

	it("gives a held desktop back when the member chooses another machine", async () => {
		const s = setup({ machines: [machine(1), machine(2)] });
		const { p } = await holding(s);
		expect(p.holding).toBe(true);
		s.state.answers.push({ picture: 2 });
		p.el.querySelector<HTMLButtonElement>(":scope > .computer-switcher")!.click();
		[...openMenu()!.el.querySelectorAll<HTMLElement>("[role^=menuitem]")][1]!.click();
		await flush();
		expect(calls(s, "qorpera_member_hand_back_machine_desktop").map((call) => call.body.p_machine_id)).toEqual([
			machine(1).machineId,
		]);
		expect(p.holding).toBe(false);
	});
});

describe("a member's action through the member bridge (20260930713000)", () => {
	const signal = new AbortController().signal;
	function transport(answer: () => Response) {
		const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => answer());
		const screens = createWebMachineScreens({
			companyId: profileA.profileId,
			objectGatewayUrl: gateway,
			route: (url) => url.replace(gateway, bridge),
			accessToken: async () => "member-token",
			fetch: fetch as typeof globalThis.fetch,
		});
		return { fetch, screens };
	}
	it("posts the action as JSON with the member's token, and takes its exit or refusal", async () => {
		const t = transport(() => Response.json({ schema: "qorpera.member-machine-act/v1", exitCode: 0 }));
		expect(await t.screens.act(machine(1).machineId, { type: "type", text: "Åse" }, signal)).toEqual({
			kind: "done",
			exitCode: 0,
		});
		const [url, init] = t.fetch.mock.calls[0]!;
		expect(url).toBe(`${bridge}/v1/member-machine-screens/${profileA.profileId}/${machine(1).machineId}/act`);
		expect(init).toMatchObject({
			method: "POST",
			headers: { authorization: "Bearer member-token", "content-type": "application/json" },
			redirect: "error",
			cache: "no-store",
			credentials: "omit",
		});
		expect(JSON.parse(String(init?.body))).toEqual({ action: { type: "type", text: "Åse" } });
		const busy = transport(() => Response.json({ code: "DESKTOP_BUSY" }, { status: 409 }));
		expect(await busy.screens.act(machine(1).machineId, { type: "key", keys: ["Return"] }, signal)).toEqual({
			kind: "refused",
			code: "DESKTOP_BUSY",
		});
		for (const answer of [
			() => Response.json({ code: "SOMETHING_ELSE" }, { status: 409 }),
			() => Response.json({ schema: "qorpera.member-machine-act/v1", exitCode: 256 }),
			() => Response.json({ exitCode: 0 }),
			() => new Response("{}", { status: 503 }),
		])
			await expect(
				transport(answer).screens.act(machine(1).machineId, { type: "key", keys: ["Return"] }, signal),
			).rejects.toThrow();
		await expect(
			transport(() => Response.json({})).screens.act("machine", { type: "key", keys: ["a"] }, signal),
		).rejects.toThrow();
	});
});

describe("a member's hand-back of the desktop (review r1 F4, F5, F6)", () => {
	/** A gate the test opens. */
	function gate() {
		let open = () => {};
		const closed = new Promise<void>((resolve) => {
			open = resolve;
		});
		return { closed, open: () => open() };
	}
	const words = (p: ComputerPanel) => controls(p)?.querySelector(".machine-screen-control-text")?.textContent;

	it("is done only once the database confirms it: a failed one says so, never renews, never takes the hold up again, and asks again", async () => {
		const { s, p } = await holding();
		s.state.handBackFails = 1;
		expect(await p.handBack()).toBe(false);
		expect(p.holding).toBe(false);
		expect(words(p)).toBe("The computer could not be given back yet. It goes back by itself within 5 minutes.");
		expect(controlButton(p)?.textContent).toBe("Try again");
		// The picture takes no input meanwhile.
		expect(canvas(p).hasAttribute("tabindex")).toBe(false);
		// A list read that still shows the hold (the database has it yet) neither takes it up again nor renews it.
		const asked = calls(s, "qorpera_member_hand_back_machine_desktop").length;
		s.hint("machines");
		await flush();
		expect(p.holding).toBe(false);
		expect(controlButton(p)?.textContent).toBe("Try again");
		// The hand-back is asked again after its wait, at the same epoch, and this time it is answered.
		await advance(2000);
		expect(calls(s, "qorpera_member_hand_back_machine_desktop").length).toBe(asked + 1);
		expect(backEpochs(s)).toEqual([0, 0]);
		expect(controlButton(p)?.textContent).toBe("Take over");
		await advance(KEEP_EVERY_MS * 2);
		expect(calls(s, "qorpera_member_keep_machine_desktop")).toHaveLength(0);
		expect(p.holding).toBe(false);
	});

	it("asks a failed hand-back again with growing waits while the window lives, and Try again asks at once", async () => {
		const { s, p } = await holding();
		s.state.handBackFails = 3;
		expect(await p.handBack()).toBe(false);
		const count = () => calls(s, "qorpera_member_hand_back_machine_desktop").length;
		expect(count()).toBe(1);
		await advance(1999);
		expect(count()).toBe(1);
		await advance(1);
		expect(count()).toBe(2);
		// The second failed: Try again asks at once, and this time it goes through.
		controlButton(p)!.click();
		await flush();
		expect(count()).toBe(3);
		expect(words(p)).toBe("The computer could not be given back yet. It goes back by itself within 5 minutes.");
		controlButton(p)!.click();
		await flush();
		expect(count()).toBe(4);
		expect(controlButton(p)?.textContent).toBe("Take over");
		await advance(30_000);
		expect(count()).toBe(4);
	});

	it("waits for a slow hand-back, saying it gives the computer back, before it is done", async () => {
		const { s, p } = await holding();
		const slow = gate();
		s.state.handBackGate = slow.closed;
		let done: boolean | undefined;
		const back = p.handBack().then((value) => {
			done = value;
		});
		await flush();
		expect(done).toBeUndefined();
		expect(words(p)).toBe("Giving the computer back…");
		expect(controlButton(p)?.disabled).toBe(true);
		slow.open();
		await back;
		expect(done).toBe(true);
		expect(controlButton(p)?.textContent).toBe("Take over");
	});

	it("calls off a take-over still on its way: the hand-back names it at once, and the take-over is refused when it arrives", async () => {
		const s = setup();
		s.state.answers.push({ picture: 1 });
		const p = panel(s);
		await flush();
		const late = gate();
		s.state.takeGate = late.closed;
		controlButton(p)!.click();
		await flush();
		expect(takeEpochs(s)).toEqual([0]);
		// I'm done while the take-over is on its way: the hand-back at its epoch goes at once, and its answer is the
		// confirmation (review r5): nothing waits for the take-over.
		expect(await p.handBack()).toBe(true);
		expect(calls(s, "qorpera_member_hand_back_machine_desktop").map((call) => call.body)).toEqual([
			{
				p_profile_id: profileA.profileId,
				p_machine_id: machine(1).machineId,
				p_reason: "handed_back",
				p_epoch: 0,
			},
		]);
		// The take-over reaches the database after that: refused, so nothing is held, and the window takes nothing up.
		late.open();
		await flush();
		expect(s.state.machines[0]?.control).toBeNull();
		expect(p.holding).toBe(false);
		await advance(KEEP_EVERY_MS * 2);
		expect(calls(s, "qorpera_member_keep_machine_desktop")).toHaveLength(0);
		expect(calls(s, "qorpera_member_hand_back_machine_desktop")).toHaveLength(1);
		expect(p.holding).toBe(false);
	});

	it("gives a take-over that comes back after the window closed back as it comes", async () => {
		const s = setup();
		s.state.answers.push({ picture: 1 });
		const p = panel(s);
		await flush();
		const late = gate();
		s.state.takeGate = late.closed;
		controlButton(p)!.click();
		await flush();
		p.dispose();
		late.open();
		await flush();
		expect(calls(s, "qorpera_member_hand_back_machine_desktop").map((call) => call.body)).toEqual([
			{
				p_profile_id: profileA.profileId,
				p_machine_id: machine(1).machineId,
				p_reason: "closed",
				p_epoch: 0,
			},
		]);
		expect(s.state.machines[0]?.control).toBeNull();
	});

	it("gives the held machine back when the member switches during a list read that is still on its way", async () => {
		const s = setup({ machines: [machine(1), machine(2)] });
		const { p } = await holding(s);
		expect(p.holding).toBe(true);
		// A read of the list begins and waits; meanwhile the member picks the other machine.
		const slowList = gate();
		s.state.listGate = slowList.closed;
		s.hint("machines");
		await flush();
		s.state.answers.push({ picture: 2 });
		p.el.querySelector<HTMLButtonElement>(":scope > .computer-switcher")!.click();
		[...openMenu()!.el.querySelectorAll<HTMLElement>("[role^=menuitem]")][1]!.click();
		slowList.open();
		await flush();
		await flush();
		expect(calls(s, "qorpera_member_hand_back_machine_desktop").map((call) => call.body.p_machine_id)).toEqual([
			machine(1).machineId,
		]);
		expect(p.holding).toBe(false);
	});
});

describe("the company's ledger of the desktops a member may hold, by hand-back epoch (reviews r2 to r5)", () => {
	/** A gate the test opens. */
	function gate() {
		let open = () => {};
		const closed = new Promise<void>((resolve) => {
			open = resolve;
		});
		return { closed, open: () => open() };
	}
	/** The company's computer windows, the agent's open in a thread with a picture up. */
	async function company(s: Setup = setup()) {
		s.state.answers.push({ picture: 1 });
		const panels = new ComputerPanels(s.computer, s.stop.signal, { hints: s.hints, decode: s.decode });
		const p = panels.open(staff)!;
		p.attach(document.body, () => panels.close(staff.id));
		cleanup.push(() => panels.dispose());
		await flush();
		return { s, panels, p };
	}
	async function takeOver(p: ComputerPanel) {
		controlButton(p)!.click();
		await flush();
	}
	const handBacks = (s: Setup) => calls(s, "qorpera_member_hand_back_machine_desktop");
	const keeps = (s: Setup) => calls(s, "qorpera_member_keep_machine_desktop");
	const until = () => new Date(Date.now() + 120_000).toISOString();
	const held = (epoch: number) => ({ mine: true, name: "Owner", until: until(), epoch });

	it("keeps a closed window's failed hand-back: I'm done does not answer until it is answered", async () => {
		const { s, panels, p } = await company();
		await takeOver(p);
		expect(p.holding).toBe(true);
		s.state.handBackFails = 2;
		// The member closes the window; its hand-back fails, and the window is gone.
		p.el.querySelector<HTMLButtonElement>(".computer-close")!.click();
		await flush();
		expect(panels.get(staff.id)).toBeUndefined();
		expect(handBacks(s).map((call) => call.body.p_reason)).toEqual(["closed"]);
		// I'm done on the card: no window, but the ledger still has the machine; it asks again, fails, and says no.
		expect(await panels.releaseAgent(staff.id)).toBe(false);
		expect(handBacks(s)).toHaveLength(2);
		// It asks again by itself after its wait, window or not; this time it is answered, and that is the confirmation.
		await advance(4000);
		expect(backEpochs(s)).toEqual([0, 0, 0]);
		expect(s.state.epochs.get(machine(1).machineId)).toBe(1);
		// Now I'm done answers, and asks nothing more.
		expect(await panels.releaseAgent(staff.id)).toBe(true);
		expect(handBacks(s)).toHaveLength(3);
		await advance(30_000);
		expect(handBacks(s)).toHaveLength(3);
	});

	it("keeps I'm done waiting for a closed window's slow hand-back, then answers", async () => {
		const { s, panels, p } = await company();
		await takeOver(p);
		const slow = gate();
		s.state.handBackGate = slow.closed;
		panels.close(staff.id);
		await flush();
		let done: boolean | undefined;
		const back = panels.releaseAgent(staff.id).then((value) => {
			done = value;
		});
		await flush();
		expect(done).toBeUndefined();
		// The window's one hand-back: I'm done waits for it rather than asking another.
		expect(handBacks(s).map((call) => call.body.p_reason)).toEqual(["closed"]);
		slow.open();
		await back;
		expect(done).toBe(true);
		expect(handBacks(s)).toHaveLength(1);
	});

	it("hands back a take-over whose answer was lost at its epoch, and waits for that answer alone; a newer epoch's hold of another tab is never taken up", async () => {
		const { s, panels, p } = await company();
		// The database gives the desktop, but its answer never comes back.
		s.state.takeLost = "committed";
		await takeOver(p);
		expect(takeEpochs(s)).toEqual([0]);
		expect(p.holding).toBe(false);
		expect(controls(p)?.textContent).toContain("The computer could not be taken over. Try again.");
		// I'm done: the machine may be held, so the hand-back at its epoch goes, and the card waits for its answer.
		const slow = gate();
		s.state.handBackGate = slow.closed;
		let done: boolean | undefined;
		const back = panels.releaseAgent(staff.id).then((value) => {
			done = value;
		});
		await flush();
		expect(handBacks(s).map((call) => [call.body.p_machine_id, call.body.p_epoch])).toEqual([
			[machine(1).machineId, 0],
		]);
		expect(done).toBeUndefined();
		s.state.handBackGate = undefined;
		slow.open();
		await back;
		// The answer is the confirmation.
		expect(done).toBe(true);
		expect(s.state.machines[0]?.control).toBeNull();
		// Another tab of the member's takes it over at the new epoch: on a machine this page gave back, never taken up.
		s.state.machines = [machine(1, { control: held(1) })];
		s.hint("machines");
		await advance(LOOK_EVERY_MS);
		expect(p.holding).toBe(false);
		await advance(KEEP_EVERY_MS * 2);
		expect(keeps(s)).toHaveLength(0);
		expect(handBacks(s)).toHaveLength(1);
	});

	it("refuses a lost take-over that reaches the database after I'm done answered, whenever it arrives (r3 F5, r5)", async () => {
		const { s, panels, p } = await company();
		// The answer is lost, and the take-over reaches the database only after the hand-back was answered (after the card
		// answered): with the window closed, nothing would look again.
		s.state.takeLost = "late";
		await takeOver(p);
		expect(p.holding).toBe(false);
		panels.close(staff.id);
		await flush();
		expect(await panels.releaseAgent(staff.id)).toBe(true);
		// By the time the card answered, a hand-back at the take-over's epoch had been answered.
		expect(backEpochs(s)).toEqual([0]);
		expect(takeEpochs(s)).toEqual([0]);
		// The take-over arrives now (and after many more epochs): refused, holding nothing.
		expect(s.state.lateCommit?.()).toBe(false);
		s.state.epochs.set(machine(1).machineId, 40);
		expect(s.state.lateCommit?.()).toBe(false);
		expect(s.state.machines[0]?.control).toBeNull();
		await advance(KEEP_EVERY_MS * 2);
		expect(keeps(s)).toHaveLength(0);
		expect(handBacks(s)).toHaveLength(1);
	});

	it("never sends a take-over queued behind a hand-back once it is called off: close, Take over again while the hand-back waits, close again, I'm done (r3 F7)", async () => {
		const { s, panels, p } = await company();
		await takeOver(p);
		expect(p.holding).toBe(true);
		// The window closes; its hand-back waits.
		const one = gate();
		s.state.handBackGates = [one.closed];
		panels.close(staff.id);
		await flush();
		expect(backEpochs(s)).toEqual([0]);
		// The card's Take over opens the window again and takes over while that hand-back waits: it waits too.
		s.state.answers.push({ picture: 1 });
		const again = panels.open(staff)!;
		again.attach(document.body, () => panels.close(staff.id));
		again.takeOver();
		await flush();
		expect(takeEpochs(s)).toEqual([0]);
		// The window closes again, and I'm done comes, while the hand-back still waits.
		panels.close(staff.id);
		await flush();
		let done: boolean | undefined;
		const back = panels.releaseAgent(staff.id).then((value) => {
			done = value;
		});
		await flush();
		expect(done).toBeUndefined();
		one.open();
		await back;
		expect(done).toBe(true);
		// The queued take-over was never sent, one hand-back covered everything, and no lease is left.
		expect(takeEpochs(s)).toEqual([0]);
		expect(backEpochs(s)).toEqual([0]);
		expect(s.state.machines[0]?.control).toBeNull();
		await advance(KEEP_EVERY_MS * 2);
		expect(takeEpochs(s)).toEqual([0]);
		expect(keeps(s)).toHaveLength(0);
	});

	it("gives back a machine whose take-over answer was lost when the member switches to another (r3 F8)", async () => {
		const { s, p } = await company(setup({ machines: [machine(1), machine(2)] }));
		s.state.takeLost = "committed";
		await takeOver(p);
		expect(p.holding).toBe(false);
		expect(s.state.machines[0]?.control?.epoch).toBe(0);
		// Neither held nor on its way in the window: the switch still gives the first machine back, at its epoch.
		s.state.answers.push({ picture: 2 });
		p.el.querySelector<HTMLButtonElement>(":scope > .computer-switcher")!.click();
		[...openMenu()!.el.querySelectorAll<HTMLElement>("[role^=menuitem]")][1]!.click();
		await flush();
		expect(handBacks(s).map((call) => [call.body.p_machine_id, call.body.p_epoch])).toEqual([
			[machine(1).machineId, 0],
		]);
		expect(s.state.machines[0]?.control).toBeNull();
		expect(p.holding).toBe(false);
	});

	it("keeps a release pending when the take-over it called off comes back refused first (r4 F9)", async () => {
		const { s, panels, p } = await company();
		const late = gate();
		s.state.takeGate = late.closed;
		await takeOver(p);
		expect(takeEpochs(s)).toEqual([0]);
		// I'm done while the take-over is on its way; its hand-back fails.
		s.state.handBackFails = 1;
		expect(await panels.releaseAgent(staff.id)).toBe(false);
		expect(handBacks(s)).toHaveLength(1);
		// The take-over comes back refused (another member took the desktop meanwhile) before a hand-back was answered: the
		// release stays, and I'm done answers only after one is.
		s.state.take = { state: "refused", reason: "DESKTOP_MEMBER_IN_CONTROL", memberName: "Ada" };
		late.open();
		await flush();
		expect(await panels.releaseAgent(staff.id)).toBe(true);
		expect(backEpochs(s)).toEqual([0, 0]);
	});

	it("gives back a machine taken over while the window's loop waited, when the member switches back (r4 F8)", async () => {
		const { s, p } = await company(setup({ machines: [machine(1), machine(2)] }));
		const pick = (n: number) => {
			p.el.querySelector<HTMLButtonElement>(":scope > .computer-switcher")!.click();
			[...openMenu()!.el.querySelectorAll<HTMLElement>("[role^=menuitem]")][n]!.click();
		};
		// The window's loop waits on a list read.
		const slowList = gate();
		s.state.listGate = slowList.closed;
		s.hint("machines");
		await flush();
		// Meanwhile the member picks the second machine and presses Take over (its answer is lost), then picks the first
		// again: the loop never saw the second.
		pick(1);
		s.state.takeLost = "committed";
		controlButton(p)!.click();
		await flush();
		expect(calls(s, "qorpera_member_take_machine_desktop").map((call) => call.body.p_machine_id)).toEqual([
			machine(2).machineId,
		]);
		pick(0);
		await flush();
		expect(handBacks(s).map((call) => [call.body.p_machine_id, call.body.p_epoch])).toEqual([
			[machine(2).machineId, 0],
		]);
		slowList.open();
		await flush();
		expect(s.state.machines[1]?.control).toBeNull();
		expect(p.holding).toBe(false);
		// The take-over pressed for the second machine is not carried over to the first.
		expect(takeEpochs(s)).toHaveLength(1);
	});

	it("hands back on I'm done what the member's list shows held from elsewhere, and again at the epoch an answer says still holds (r4 F9, r5)", async () => {
		const { s, panels } = await company();
		panels.close(staff.id);
		await flush();
		// Another tab of the member's holds the desktop at their epoch 2: I'm done hands it back at that epoch, read from
		// the list at the time.
		s.state.epochs.set(machine(1).machineId, 2);
		s.state.machines = [machine(1, { control: held(2) })];
		expect(await panels.releaseAgent(staff.id)).toBe(true);
		expect(backEpochs(s)).toEqual([2]);
		expect(s.state.machines[0]?.control).toBeNull();
		// That tab hands back and takes it again between the list read and this page's hand-back: the answer says the
		// member holds it now, at a newer epoch, so it is handed back again at that one.
		s.state.machines = [machine(1, { control: held(3) })];
		const slow = gate();
		s.state.handBackGates = [slow.closed];
		let done: boolean | undefined;
		const back = panels.releaseAgent(staff.id).then((value) => {
			done = value;
		});
		await flush();
		expect(backEpochs(s).at(-1)).toBe(3);
		s.state.epochs.set(machine(1).machineId, 4);
		s.state.machines = [machine(1, { control: held(4) })];
		slow.open();
		await back;
		expect(done).toBe(true);
		expect(backEpochs(s).slice(-2)).toEqual([3, 4]);
		expect(s.state.machines[0]?.control).toBeNull();
		// Without its list, I'm done cannot know what is held elsewhere, and says no.
		s.state.listFails = 1;
		expect(await panels.releaseAgent(staff.id)).toBe(false);
		expect(await panels.releaseAgent(staff.id)).toBe(true);
	});

	it("marks I'm done's release at once: a take-over that completes while the list read stalls gets no input and no heartbeat (r5 F11)", async () => {
		const { s, panels, p } = await company();
		const late = gate();
		s.state.takeGate = late.closed;
		await takeOver(p);
		expect(takeEpochs(s)).toEqual([0]);
		// I'm done while the take-over is on its way, and the list read it makes stalls; the hand-back is sent before it.
		const slowList = gate(),
			slowBack = gate();
		s.state.listGate = slowList.closed;
		s.state.handBackGates = [slowBack.closed];
		let done: boolean | undefined;
		const back = panels.releaseAgent(staff.id).then((value) => {
			done = value;
		});
		await flush();
		expect(backEpochs(s)).toEqual([0]);
		// The take-over reaches the database first and gets the desktop: its answer is ignored, nothing is given input.
		late.open();
		await flush();
		expect(s.state.machines[0]?.control?.mine).toBe(true);
		expect(p.holding).toBe(false);
		expect(canvas(p).hasAttribute("tabindex")).toBe(false);
		await advance(1000);
		expect(keeps(s)).toHaveLength(0);
		expect(done).toBeUndefined();
		// The hand-back at that epoch ends it; the list answers; I'm done answers.
		slowBack.open();
		slowList.open();
		await back;
		expect(done).toBe(true);
		expect(s.state.machines[0]?.control).toBeNull();
		expect(p.holding).toBe(false);
		// No heartbeat was ever sent for it.
		await advance(KEEP_EVERY_MS * 2);
		expect(keeps(s)).toHaveLength(0);
	});

	it("takes over again at the epoch the hand-back answered, and takes up a lost answer's hold the list shows at its epoch", async () => {
		const { s, panels, p } = await company();
		s.state.takeLost = "committed";
		await takeOver(p);
		expect(p.holding).toBe(false);
		// No hand-back was asked: the next list read says the member holds it at that epoch, and the window takes it up.
		s.hint("machines");
		await advance(LOOK_EVERY_MS);
		expect(p.holding).toBe(true);
		// Given back, then taken over again on purpose: sent at the new epoch, held and renewed at it.
		expect(await panels.releaseAgent(staff.id)).toBe(true);
		expect(p.holding).toBe(false);
		await takeOver(p);
		expect(takeEpochs(s)).toEqual([0, 1]);
		expect(p.holding).toBe(true);
		await advance(KEEP_EVERY_MS);
		expect(keeps(s).map((call) => call.body.p_epoch)).toEqual([1]);
	});

	it("lets go of a hold when another tab of the member's moved the epoch on, and takes over at the new one", async () => {
		const { s, p } = await company();
		await takeOver(p);
		expect(p.holding).toBe(true);
		// Another tab hands the desktop back: the epoch moves on and the lease ends.
		s.state.epochs.set(machine(1).machineId, 1);
		s.state.machines = [machine(1)];
		s.hint("machines");
		await advance(LOOK_EVERY_MS);
		expect(p.holding).toBe(false);
		await takeOver(p);
		expect(takeEpochs(s)).toEqual([0, 1]);
		expect(p.holding).toBe(true);
	});

	it("keeps a take-over on its way through pagehide until a hand-back at its epoch is answered, should the page come back from the cache", async () => {
		const { s, panels, p } = await company();
		const late = gate();
		s.state.takeGate = late.closed;
		await takeOver(p);
		expect(takeEpochs(s)).toEqual([0]);
		// The page is put in the browser's cache: the keepalive hand-back and the ordinary one both fail.
		s.state.handBackFails = 2;
		window.dispatchEvent(new Event("pagehide"));
		await flush();
		expect(handBacks(s)).toHaveLength(2);
		// It comes back: I'm done still hands back at the take-over's epoch and waits for the answer.
		expect(await panels.releaseAgent(staff.id)).toBe(true);
		expect(backEpochs(s)).toEqual([0, 0, 0]);
		// The take-over arrives after that: refused, nothing held.
		late.open();
		await flush();
		expect(s.state.machines[0]?.control).toBeNull();
		expect(p.holding).toBe(false);
	});

	it("hands back a lost take-over's epoch on I'm done though a later take-over at it was refused, so the late one is refused (r6 F12)", async () => {
		const { s, panels, p } = await company();
		// Take-over A: its answer is lost, and it reaches the database only later.
		s.state.takeLost = "late";
		await takeOver(p);
		expect(p.holding).toBe(false);
		// Another member takes the desktop; the member's take-over B, at the same epoch, is refused for it.
		s.state.machines = [machine(1, { control: { mine: false, name: "Ada", until: until(), epoch: null } })];
		s.state.take = { state: "refused", reason: "DESKTOP_MEMBER_IN_CONTROL", memberName: "Ada" };
		p.takeOver();
		await flush();
		expect(takeEpochs(s)).toEqual([0, 0]);
		// I'm done: a hand-back at that epoch is sent and answered before the card answers.
		let done: boolean | undefined;
		const back = panels.releaseAgent(staff.id).then((value) => {
			done = value;
		});
		await back;
		expect(done).toBe(true);
		expect(backEpochs(s)).toEqual([0]);
		// The other member gives it back; then A arrives: refused, holding nothing.
		s.state.machines = [machine(1)];
		s.state.take = { state: "ok", until: "2026-11-10T20:00:00.000Z" };
		expect(s.state.lateCommit?.()).toBe(false);
		expect(s.state.machines[0]?.control).toBeNull();
	});

	it.each([
		["another member in control", { state: "refused", reason: "DESKTOP_MEMBER_IN_CONTROL", memberName: "Ada" }, true],
		["too small", { state: "refused", reason: "DESKTOP_MACHINE_TOO_SMALL" }, true],
		["not running", { state: "refused", reason: "MACHINE_NOT_RUNNING" }, true],
		["needs a company view", { state: "refused", reason: "MACHINE_NEEDS_COMPANY_VIEW" }, true],
		["called off at the same epoch", { state: "refused", reason: "TAKE_CALLED_OFF", epoch: 0 }, true],
		// A TAKE_CALLED_OFF that names a newer epoch shows the old one fenced already: nothing is owed.
		["called off at a newer epoch", undefined, false],
	] as const)(
		"keeps owing a hand-back for a sent take-over's epoch whatever a later take-over's refusal says: %s (r6 F12)",
		async (_name, refusal, owed) => {
			const { s, panels, p } = await company();
			s.state.takeLost = "late";
			await takeOver(p);
			if (refusal) s.state.take = { ...refusal };
			else s.state.epochs.set(machine(1).machineId, 1);
			p.takeOver();
			await flush();
			expect(takeEpochs(s)).toEqual([0, 0]);
			expect(await panels.releaseAgent(staff.id)).toBe(true);
			expect(backEpochs(s)).toEqual(owed ? [0] : []);
			// Either way the take-over sent first can never hold the desktop now.
			s.state.take = { state: "ok", until: "2026-11-10T20:00:00.000Z" };
			expect(s.state.lateCommit?.()).toBe(false);
			expect(s.state.machines[0]?.control).toBeNull();
		},
	);

	it("keeps owing a hand-back for a sent take-over's epoch after its lease ended by itself, and after a list read that no longer shows it (r6)", async () => {
		const { s, panels, p } = await company();
		await takeOver(p);
		expect(p.holding).toBe(true);
		// The lease ends by itself (the database says so to the heartbeat, and the list shows it no more).
		s.state.keep = { state: "ended" };
		s.state.machines = [machine(1)];
		await advance(KEEP_EVERY_MS);
		expect(p.holding).toBe(false);
		s.hint("machines");
		await advance(LOOK_EVERY_MS);
		// I'm done still hands back at that epoch, and answers after that answer.
		expect(await panels.releaseAgent(staff.id)).toBe(true);
		expect(backEpochs(s)).toEqual([0]);
		// Once answered, nothing more is owed.
		expect(await panels.releaseAgent(staff.id)).toBe(true);
		expect(backEpochs(s)).toEqual([0]);
	});

	it("asks every hold back, best effort, as the company's page is left", async () => {
		const { s, p } = await company();
		await takeOver(p);
		expect(p.holding).toBe(true);
		s.stop.abort();
		await flush();
		const left = s.fetch.mock.calls.filter(([url]) =>
			String(url).endsWith("/qorpera_member_hand_back_machine_desktop"),
		);
		expect(left).toHaveLength(1);
		expect(left[0]?.[1]).toMatchObject({ method: "POST", keepalive: true });
		expect(JSON.parse(String(left[0]?.[1]?.body))).toEqual({
			p_profile_id: profileA.profileId,
			p_machine_id: machine(1).machineId,
			p_reason: "closed",
			p_epoch: 0,
		});
	});
});
