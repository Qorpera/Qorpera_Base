// @vitest-environment jsdom

import type { MemberAgentMachine } from "@qorpera/cloud-client/cloud-member-company-computer";
import { isUuid } from "@qorpera/contracts";
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
	START_AGAIN_MS,
	WANT_ON_MS,
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
		others: [],
		...change,
	};
}
/** One look's answer from the bridge: a picture (its etag), the member's own picture again, or a refusal's code. */
type Answer = { picture: number } | "unchanged" | { code: string } | { status: number };
/** One action's answer: its exit, or a refusal's code. */
type ActAnswer =
	| { exitCode: number | null }
	| { code: string }
	| { hold: Promise<void>; exitCode: number }
	| { hold: Promise<void>; code: string };

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
		/** What the member's starts of the desktop answer, in turn (then started), and a gate each waits on. */
		startAnswers: [] as ({ outcome: "started" | "running" } | { code: string })[],
		startGate: undefined as Promise<void> | undefined,
		/** A gate the next look waits on before it is answered (review r1 F3 of #1681): a look in flight. */
		lookGate: undefined as Promise<void> | undefined,
		/** The start explorer's own answer to a start (the machine, and the request's signal), and its screens: per machine,
		 * off, or on with the picture of that number. */
		startHook: undefined as ((machineId: string, signal: AbortSignal | undefined) => Promise<Response>) | undefined,
		screens: undefined as Map<string, "off" | number> | undefined,
		/** What a take-over answers: held until when, or why not. */
		take: { state: "ok", until: "2026-11-10T20:00:00.000Z" } as Record<string, unknown>,
		/** What the heartbeat answers. */
		keep: { state: "ok", until: "2026-11-10T20:01:00.000Z" } as Record<string, unknown>,
		/** What a look answers once the queue is empty. */
		fallback: "unchanged" as Answer,
		listFails: 0,
		/** Hand-backs that fail (503) before one goes through, and a gate each waits on (review r1 F4). */
		handBackFails: 0,
		/** What a member's start of a computer for the agent answers, in turn (then a new machine 9), and a gate it waits on
		 * (20260930730000). A computer started joins the agent's list as the database's next read shows it. */
		computerAnswers: [] as (
			| { started: MemberAgentMachine }
			| { existing: MemberAgentMachine }
			| { refused: string }
			| { status: number }
		)[],
		computerGate: undefined as Promise<void> | undefined,
		handBackGate: undefined as Promise<void> | undefined,
		/** Gates the next hand-backs wait on, one each, in turn (review r3 F7). */
		handBackGates: [] as Promise<void>[],
		/** Gates the next hand-backs' answers wait on, one each, after the database's effect and its answer (review r8). */
		handBackAnswerGates: [] as Promise<void>[],
		/** A gate a take-over's answer waits on (review r1 F5), and one the next list read waits on (F6). */
		takeGate: undefined as Promise<void> | undefined,
		listGate: undefined as Promise<void> | undefined,
		/** A gate the next list read's answer waits on, with the machines as they were when it was asked (review r7). */
		listSnapshotGate: undefined as Promise<void> | undefined,
		/** A gate every list read waits on while it is set, answering the machines as they are then (review r8). */
		listHold: undefined as Promise<void> | undefined,
		/** Gates the next list reads wait on, one each, answering the machines as they were when asked (review r9). */
		listSnapshotGates: [] as Promise<void>[],
		/** A take-over whose answer is lost (review r2 F5): the database committed it first, or it reaches the database
		 * only later, when the test says (`lateCommit`: whether it held anything). */
		takeLost: undefined as "committed" | "late" | undefined,
		lateCommit: undefined as (() => boolean) | undefined,
		/** The member's hand-back epoch per machine, as the database keeps it (review r5); 0 when absent. */
		epochs: new Map<string, number>(),
		/** The lease generation per machine (F26): every seating, and every lease's end, moves it; 0 when absent. */
		seats: new Map<string, number>(),
		/** Actions are checked as the database checks them when they reach it, after their gate (F24, F26): run only for
		 * the member's own hold taken under the epoch named, in the seat named; otherwise DESKTOP_CONTROL_ENDED. */
		actAsDatabase: false,
	};
	const epochOf = (machineId: unknown) => state.epochs.get(String(machineId)) ?? 0;
	/** As the database: the next seat of a machine, moved now. */
	const seatAnew = (machineId: unknown) => {
		const next = (state.seats.get(String(machineId)) ?? 0) + 1;
		state.seats.set(String(machineId), next);
		return next;
	};
	const looks: { url: string; etag: string | null }[] = [];
	const starts: string[] = [];
	const acts: {
		url: string;
		action: Record<string, unknown>;
		/** The epoch and the seat of the private hold it was captured under; null for a shared action (20260930734000). */
		epoch: number | null;
		seat: number | null;
		signal: AbortSignal | undefined;
		/** Whether it ran, when the database checks it (actAsDatabase). */
		ran?: boolean;
	}[] = [];
	const rpcs: { method: string; body: Record<string, unknown> }[] = [];
	const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		expect(init?.redirect).toBe("error");
		const headers = new Headers(init?.headers);
		expect(headers.get("authorization")).toBe("Bearer fixture-token");
		if (url.startsWith(`${bridge}/v1/member-machine-screens/`) && url.endsWith("/start")) {
			// A member's start of the desktop (20260930714000): `{}`, and what the test says comes of it.
			expect(init?.method).toBe("POST");
			expect(init?.body).toBe("{}");
			starts.push(url.slice(bridge.length));
			if (state.startHook)
				return state.startHook(url.slice(bridge.length).split("/")[4] as string, init?.signal ?? undefined);
			const answer = state.startAnswers.shift() ?? { outcome: "started" };
			if (state.startGate) await state.startGate;
			if ("code" in answer) return Response.json({ code: answer.code }, { status: 409 });
			return Response.json({ schema: "qorpera.member-machine-start/v1", outcome: answer.outcome });
		}
		if (url.startsWith(`${bridge}/v1/member-machine-screens/`) && url.endsWith("/act")) {
			expect(init?.method).toBe("POST");
			expect(headers.get("content-type")).toBe("application/json");
			const body = JSON.parse(String(init?.body)) as {
				action: Record<string, unknown>;
				epoch?: number;
				seat?: number;
			};
			// The action, and the epoch and the seat of the hold it was captured under (F24, F26); a shared one alone
			// (20260930734000).
			const shared = !("epoch" in body);
			expect(Object.keys(body)).toEqual(shared ? ["action"] : ["action", "epoch", "seat"]);
			const sent: (typeof acts)[number] = {
				url: url.slice(bridge.length),
				action: body.action,
				epoch: body.epoch ?? null,
				seat: body.seat ?? null,
				signal: init?.signal ?? undefined,
			};
			acts.push(sent);
			const answer = state.actAnswers.shift() ?? { exitCode: 0 };
			if ("hold" in answer) await answer.hold;
			if ("code" in answer) return Response.json({ code: answer.code }, { status: 409 });
			if (state.actAsDatabase) {
				// As the database, when the action reaches it: only under the hold it names.
				const row = state.machines.find((one) => url.includes(`/${one.machineId}/act`));
				// A shared action runs only while no one types privately (20260930734000).
				sent.ran = shared
					? !row?.control
					: row?.control?.mine === true && row.control.epoch === body.epoch && row.control.seat === body.seat;
				if (!sent.ran)
					return Response.json(
						{ code: shared ? "DESKTOP_MEMBER_IN_CONTROL" : "DESKTOP_CONTROL_ENDED" },
						{ status: 409 },
					);
			}
			return Response.json({ schema: "qorpera.member-machine-act/v1", exitCode: answer.exitCode });
		}
		if (url.startsWith(`${bridge}/v1/member-machine-screens/`)) {
			expect(init?.method).toBe("GET");
			expect(init?.cache).toBe("no-store");
			const asked = headers.get("if-none-match");
			looks.push({ url: url.slice(bridge.length), etag: asked ? asked.slice(1, -1) : null });
			if (state.lookGate) {
				const gate = state.lookGate;
				state.lookGate = undefined;
				await gate;
			}
			const screen = state.screens?.get(url.slice(bridge.length).split("/")[4] as string);
			const answer =
				screen === undefined
					? (state.answers.shift() ?? state.fallback)
					: screen === "off"
						? ({ code: "DESKTOP_NOT_RUNNING" } as const)
						: asked === `"${etag(screen)}"`
							? "unchanged"
							: { picture: screen };
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
			if (state.listHold) await state.listHold;
			if (state.listFails > 0) {
				state.listFails--;
				return new Response("{}", { status: 503 });
			}
			const snapshot = state.listSnapshotGate ?? state.listSnapshotGates.shift();
			if (snapshot) {
				state.listSnapshotGate = undefined;
				const asked = state.machines.map((row) => ({ ...row, epoch: epochOf(row.machineId) }));
				await snapshot;
				return Response.json({
					schema: "qorpera.agent-machines/v1",
					profileId: profileA.profileId,
					staffAgentId: staff.id,
					canWake: state.canWake,
					canTakeOver: state.canTakeOver,
					machines: asked,
				});
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
		if (method === "qorpera_member_start_agent_computer") {
			if (state.computerGate) await state.computerGate;
			const answer = state.computerAnswers.shift() ?? { started: machine(9, { state: "waiting" }) };
			const schema = "qorpera.member-agent-computer/v1";
			if ("status" in answer) return new Response("{}", { status: answer.status });
			if ("refused" in answer) return Response.json({ schema, state: "refused", reason: answer.refused });
			const made = "started" in answer ? answer.started : answer.existing;
			if ("started" in answer) state.machines = [...state.machines, made];
			return Response.json({
				schema,
				state: "started" in answer ? "started" : "existing",
				machine: { machineId: made.machineId, name: made.name, state: made.state },
			});
		}
		if (method === "qorpera_member_take_machine_desktop") {
			if (state.takeGate) await state.takeGate;
			const epoch = Number(body.p_epoch);
			const press = String(body.p_press);
			expect(press).toMatch(/^[0-9a-f-]{36}$/);
			let seat = 0;
			// As the database: a take-over is accepted only at the member's current epoch, when it arrives; it seats the
			// member anew (F26: a new seat, its own live lease too), and the list then says the member holds it, taken under
			// that epoch, in that seat, by that press.
			const commit = () => {
				if (epoch !== epochOf(body.p_machine_id) || state.take.state !== "ok") return false;
				seat = seatAnew(body.p_machine_id);
				state.machines = state.machines.map((row) =>
					row.machineId === body.p_machine_id
						? {
								...row,
								control: { mine: true, name: "Owner", until: String(state.take.until), epoch, seat, press },
							}
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
			return Response.json({
				schema: "qorpera.member-machine-desktop/v1",
				...state.take,
				...(state.take.state === "ok" ? { seat } : {}),
			});
		}
		if (method === "qorpera_member_keep_machine_desktop") {
			// As the database: only a lease of the member's taken under that epoch, in that seat, is renewed (F26).
			const row = state.machines.find((machine) => machine.machineId === body.p_machine_id);
			if (row?.control?.mine !== true || row.control.epoch !== body.p_epoch || row.control.seat !== body.p_seat)
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
			// As the database (F27, F28): EXACT (a seat) ends the member's lease under that epoch in that seat, and moves the
			// epoch when it is the current one and nothing of the member's is left live; VOID (no seat) at the current epoch
			// moves it and ends the member's lease under it, whichever seat; at an older one nothing changes. It answers the
			// current epoch, whether the member holds the machine now, and its seat.
			expect(Object.keys(body).sort()).toEqual(["p_epoch", "p_machine_id", "p_profile_id", "p_reason", "p_seat"]);
			const row = state.machines.find((machine) => machine.machineId === body.p_machine_id);
			const mine = row?.control?.mine === true;
			const under = mine && row?.control?.epoch === body.p_epoch;
			const current = body.p_epoch === epochOf(body.p_machine_id);
			const exact = body.p_seat !== null;
			const moves = exact ? current && !(mine && !(under && row?.control?.seat === body.p_seat)) : current;
			const named = exact ? (under && row?.control?.seat === body.p_seat) || (moves && under) : moves && under;
			const handedBack = named;
			if (named) {
				seatAnew(body.p_machine_id);
				state.machines = state.machines.map((machine) =>
					machine.machineId === body.p_machine_id ? { ...machine, control: null } : machine,
				);
			}
			if (moves) state.epochs.set(String(body.p_machine_id), epochOf(body.p_machine_id) + 1);
			const now = state.machines.find((machine) => machine.machineId === body.p_machine_id);
			const holding = now?.control?.mine === true;
			const answer = {
				schema: "qorpera.member-machine-desktop/v1",
				state: "ok",
				handedBack,
				epoch: epochOf(body.p_machine_id),
				holding,
				seat: holding ? (now?.control?.seat ?? null) : null,
			};
			const delivered = state.handBackAnswerGates.shift();
			if (delivered) await delivered;
			return Response.json(answer);
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
		starts,
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
	const button = controls(p)?.querySelector<HTMLButtonElement>(".machine-screen-control-button");
	return button && !button.hidden ? button : null;
}
/** The member presses the window's control. Type privately is in the large view alone (20260930734000): a member in the
 * preview opens it first with a click on the picture; Done and Try again are in both. */
function pressControl(p: ComputerPanel) {
	const view = p.el.querySelector<HTMLElement>(".machine-screen");
	if (!controlButton(p) && view && !view.hidden) press(view, 10, 10);
	controlButton(p)!.click();
}
function handBackButton(p: ComputerPanel) {
	return controls(p)?.querySelector<HTMLButtonElement>(".machine-screen-control-hand-back") ?? null;
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
	pressControl(p);
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
		// The preview is watched only (20260930734000): no control on it, and the picture takes no input there.
		expect(controls(p)).toBeNull();
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
		expect(status(p)).toBe("The computer is on, but its screen is off.");
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
		expect(status(p)).toBe("The computer is on, but its screen is off.");
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
		// A member who may start one is offered it (20260930730000); the viewer's words are in that test.
		expect(status(p)).toBe(`${staff.displayName} has no computer yet.`);
		expect(detail(p)).toBeNull();
		expect(action(p)?.textContent).toBe("Start one");
		expect(none.looks).toEqual([]);
		expect(screen(p)?.hidden).toBe(true);
		// One window at a time here: both would read through the one stubbed fetch.
		p.dispose();
		const headless = setup({ machines: [machine(1, { desktopCapable: false })] });
		const q = panel(headless);
		await flush();
		expect(status(q)).toBe(`${staff.displayName} is working on a machine without a screen.`);
		expect(detail(q)).toBeNull();
		expect(action(q)?.textContent).toBe("Start one");
		expect(headless.looks).toEqual([]);
		// The list is read again every 15 s while the window is shown: a desktop that comes is shown.
		headless.state.machines = [machine(1, { desktopCapable: false }), machine(2)];
		headless.state.answers.push({ picture: 2 });
		await advance(MACHINES_EVERY_MS);
		expect(headless.looks[0]?.url).toContain(machine(2).machineId);
		expect(mark(q)).toBe("Live");
	});

	it("turns the screen on with one press when it is off, looks at once, and tells a viewer who may (20260930714000)", async () => {
		const s = setup();
		s.state.answers.push({ code: "DESKTOP_NOT_RUNNING" });
		const p = panel(s);
		await flush();
		expect(status(p)).toBe("The computer is on, but its screen is off.");
		expect(detail(p)).toBeNull();
		expect(action(p)?.textContent).toBe("Turn it on");
		const gate = (() => {
			let open = () => {};
			const closed = new Promise<void>((resolve) => {
				open = resolve;
			});
			return { closed, open: () => open() };
		})();
		s.state.startGate = gate.closed;
		action(p)!.click();
		await flush();
		expect(s.starts).toEqual([`/v1/member-machine-screens/${profileA.profileId}/${machine(1).machineId}/start`]);
		expect(status(p)).toBe("The screen is turning on…");
		expect(action(p)).toBeNull();
		// Started: the window looks at once, and the picture shows.
		s.state.answers.push({ picture: 1 });
		const before = s.looks.length;
		gate.open();
		await flush();
		await advance(LOOK_EVERY_MS);
		expect(s.looks.length).toBeGreaterThan(before);
		expect(mark(p)).toBe("Live");
		expect(s.starts).toHaveLength(1);
		// One window at a time here: both would read through the one stubbed fetch.
		p.dispose();
		// A viewer may not.
		const viewer = setup({ canWake: false, role: "viewer" });
		viewer.state.answers.push({ code: "DESKTOP_NOT_RUNNING" });
		const q = panel(viewer);
		await flush();
		expect(status(q)).toBe("The computer is on, but its screen is off.");
		expect(detail(q)).toBe("Someone with edit access can turn it on.");
		expect(action(q)).toBeNull();
	});

	it("wakes a sleeping computer and turns its screen on with the same press, once it runs (20260930714000)", async () => {
		const s = setup({ machines: [machine(1, { state: "stopped" })] });
		const p = panel(s);
		await flush();
		expect(action(p)?.textContent).toBe("Wake it");
		s.state.machines = [machine(1, { state: "starting" })];
		action(p)!.click();
		await flush();
		expect(s.rpcs.filter((call) => call.method === "qorpera_member_manage_company_machine")).toHaveLength(1);
		expect(status(p)).toBe("The computer is starting…");
		expect(s.starts).toEqual([]);
		// It runs, with its screen off: the screen is turned on by itself, no second press.
		s.state.machines = [machine(1)];
		s.state.answers.push({ code: "DESKTOP_NOT_RUNNING" }, { picture: 1 });
		s.hint("machines");
		await advance(LOOK_EVERY_MS);
		await advance(LOOK_EVERY_MS);
		expect(s.starts).toHaveLength(1);
		await advance(LOOK_EVERY_MS);
		expect(mark(p)).toBe("Live");
		// The wish is met: the screen going off later shows the ordinary state and its button.
		s.state.answers.push({ code: "DESKTOP_NOT_RUNNING" });
		await advance(LOOK_EVERY_MS * 4);
		expect(status(p)).toBe("The computer is on, but its screen is off.");
		expect(action(p)?.textContent).toBe("Turn it on");
		expect(s.starts).toHaveLength(1);
	});

	it("says a computer is too small for a screen, and a start that failed with Try again, until pressed again (20260930714000)", async () => {
		const s = setup();
		s.state.fallback = { code: "DESKTOP_NOT_RUNNING" };
		const p = panel(s);
		await flush();
		s.state.startAnswers.push({ code: "DESKTOP_MACHINE_TOO_SMALL" });
		action(p)!.click();
		await flush();
		expect(status(p)).toBe("This computer is too small for a screen.");
		expect(action(p)).toBeNull();
		// The looks that find its screen off say it still, and nothing is started by itself.
		await advance(SCREEN_OFF_EVERY_MS * 3);
		expect(status(p)).toBe("This computer is too small for a screen.");
		expect(s.starts).toHaveLength(1);
		p.dispose();
		const t = setup();
		t.state.fallback = { code: "DESKTOP_NOT_RUNNING" };
		const q = panel(t);
		await flush();
		t.state.startAnswers.push({ code: "DESKTOP_DID_NOT_START" });
		action(q)!.click();
		await flush();
		expect(status(q)).toBe("The screen could not be turned on. Try again.");
		expect(action(q)?.textContent).toBe("Try again");
		await advance(SCREEN_OFF_EVERY_MS * 3);
		expect(status(q)).toBe("The screen could not be turned on. Try again.");
		expect(t.starts).toHaveLength(1);
		// Try again: started, and the look after it finds the screen off all the same: failed, not started again.
		action(q)!.click();
		await flush();
		expect(t.starts).toHaveLength(2);
		await advance(START_AGAIN_MS * 3);
		expect(status(q)).toBe("The screen could not be turned on. Try again.");
		expect(t.starts).toHaveLength(2);
		// A start that does not reach the executor fails the same way.
		q.dispose();
		const u = setup();
		u.state.fallback = { code: "DESKTOP_NOT_RUNNING" };
		const r = panel(u);
		await flush();
		u.state.startAnswers.push({ code: "NOT_A_CODE" });
		action(r)!.click();
		await flush();
		expect(status(r)).toBe("The screen could not be turned on. Try again.");
	});

	it("turns the screen on for the member who holds the desktop, and keeps Hand back reachable without a picture (review r1 F1 of #1681)", async () => {
		const { s, p } = await holding();
		const handBack = () => {
			const button = p.el.querySelector<HTMLButtonElement>(".computer-loading .computer-loading-hand-back");
			return button?.hidden ? null : button;
		};
		expect(controlButton(p)?.textContent).toBe("Done");
		expect(handBack()).toBeNull();
		// The desktop the member holds is off (it stopped itself, or never ran: a take-over does not check it).
		s.state.fallback = { code: "DESKTOP_NOT_RUNNING" };
		await advance(LOOK_EVERY_MS * 3);
		expect(status(p)).toBe("The computer is on, but its screen is off.");
		expect(action(p)?.textContent).toBe("Turn it on");
		expect(handBack()?.textContent).toBe("Done");
		// Turn it on goes through for the holder: the start runs, and the picture comes.
		s.state.fallback = { picture: 3 };
		action(p)!.click();
		await flush();
		await advance(LOOK_EVERY_MS);
		expect(s.starts).toHaveLength(1);
		expect(mark(p)).toBe("Live");
		expect(handBack()).toBeNull();
		expect(controlButton(p)?.textContent).toBe("Done");
		// Any other state without a picture under the page's own hold: Hand back alone.
		s.state.fallback = { code: "SCREEN_HIDDEN" };
		await advance(LOOK_EVERY_MS * 3);
		expect(status(p)).toBe("The screen is hidden because it may show files you can't open.");
		expect(action(p)).toBeNull();
		expect(handBack()?.textContent).toBe("Done");
		handBack()!.click();
		await flush();
		expect(calls(s, "qorpera_member_hand_back_machine_desktop")).toHaveLength(1);
		await advance(LOOK_EVERY_MS);
		expect(handBack()).toBeNull();
	});

	it("says a hand-back without a picture where the picture would be: asking, failed with Try again, then confirmed (review r2 F1 of #1681)", async () => {
		const { s, p } = await holding();
		const standIn = () => {
			const button = p.el.querySelector<HTMLButtonElement>(".computer-loading .computer-loading-hand-back");
			return button?.hidden ? null : button;
		};
		const standInWords = () => {
			const words = p.el.querySelector<HTMLElement>(".computer-loading .computer-loading-control");
			return words?.hidden ? null : words?.textContent;
		};
		const backs = () => calls(s, "qorpera_member_hand_back_machine_desktop").length;
		// The member holds the desktop and its screen is off: no picture, so no controls under it.
		s.state.fallback = { code: "DESKTOP_NOT_RUNNING" };
		await advance(LOOK_EVERY_MS * 3);
		expect(status(p)).toBe("The computer is on, but its screen is off.");
		expect(controls(p)).toBeNull();
		expect(standInWords()).toBe(
			`Typing privately. ${staff.displayName} gets no pictures of the screen until you're done.`,
		);
		expect(standIn()?.textContent).toBe("Done");
		// Hand back is slow, then answered 503: the window says so where the picture would be, as the controls would.
		let open = () => {};
		s.state.handBackGate = new Promise<void>((resolve) => {
			open = resolve;
		});
		s.state.handBackFails = 1;
		standIn()!.click();
		await flush();
		expect(standInWords()).toBe("Ending private typing…");
		expect(standIn()?.textContent).toBe("Done");
		expect(standIn()?.disabled).toBe(true);
		s.state.handBackGate = undefined;
		open();
		await flush();
		expect(backs()).toBe(1);
		expect(standInWords()).toBe("Private typing could not be ended yet. It ends by itself within 5 minutes.");
		expect(standIn()?.textContent).toBe("Try again");
		expect(standIn()?.disabled).toBe(false);
		expect(status(p)).toBe("The computer is on, but its screen is off.");
		// Try again asks at once, and the database answers: given back, nothing more to say.
		standIn()!.click();
		await flush();
		expect(backs()).toBe(2);
		expect(standIn()).toBeNull();
		expect(standInWords()).toBeNull();
		expect(p.holding).toBe(false);
		await advance(30_000);
		expect(backs()).toBe(2);
	});

	it("starts no second time for a look that began before a slow start answered (review r1 F3 of #1681)", async () => {
		const s = setup();
		s.state.fallback = { code: "DESKTOP_NOT_RUNNING" };
		const p = panel(s);
		await flush();
		let open = () => {};
		s.state.startGate = new Promise<void>((resolve) => {
			open = resolve;
		});
		action(p)!.click();
		await flush();
		expect(s.starts).toHaveLength(1);
		// The start takes longer than START_AGAIN_MS; the looks meanwhile start nothing.
		await advance(START_AGAIN_MS + 1000);
		expect(s.starts).toHaveLength(1);
		// A look is on its way when the start answers: it began before the answer and comes back after it, screen off.
		let release = () => {};
		s.state.lookGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		await advance(1000);
		const asked = s.looks.length;
		// Time passes while it waits; then the start answers that it started, then the look comes back with the screen off
		// (it began before the answer); the looks after it see the drawn desktop.
		await advance(100);
		s.state.answers.push({ code: "DESKTOP_NOT_RUNNING" });
		s.state.fallback = { picture: 4 };
		open();
		await flush();
		release();
		await flush();
		expect(s.starts).toHaveLength(1);
		await advance(1000);
		expect(s.looks.length).toBeGreaterThan(asked);
		expect(s.starts).toHaveLength(1);
		expect(mark(p)).toBe("Live");
	});

	it("drops the wish when the member chooses another machine or closes the window, and after 3 minutes (20260930714000)", async () => {
		// Wake it on the first desktop, then the member chooses the second while it wakes, and comes back once it runs: its
		// screen is off, and nothing turned it on.
		const s = setup({ machines: [machine(1, { state: "stopped" }), machine(2)] });
		const p = panel(s);
		await flush();
		expect(action(p)?.textContent).toBe("Wake it");
		s.state.machines = [machine(1, { state: "starting" }), machine(2)];
		action(p)!.click();
		await flush();
		expect(status(p)).toBe("The computer is starting…");
		const choose = (row: number) => {
			p.el.querySelector<HTMLButtonElement>(":scope > .computer-switcher")!.click();
			[...openMenu()!.el.querySelectorAll<HTMLElement>("[role^=menuitem]")][row]!.click();
		};
		s.state.answers.push({ picture: 2 });
		choose(1);
		await flush();
		expect(mark(p)).toBe("Live");
		s.state.machines = [machine(1), machine(2)];
		s.state.fallback = { code: "DESKTOP_NOT_RUNNING" };
		choose(0);
		s.hint("machines");
		await flush();
		await advance(LOOK_EVERY_MS);
		expect(status(p)).toBe("The computer is on, but its screen is off.");
		expect(action(p)?.textContent).toBe("Turn it on");
		expect(s.starts).toEqual([]);
		p.dispose();
		// Closed while the machine wakes: nothing is started.
		const t = setup({ machines: [machine(1, { state: "stopped" })] });
		const q = panel(t);
		await flush();
		t.state.machines = [machine(1, { state: "starting" })];
		action(q)!.click();
		await flush();
		q.dispose();
		t.state.machines = [machine(1)];
		t.state.fallback = { code: "DESKTOP_NOT_RUNNING" };
		t.hint("machines");
		await advance(MACHINES_EVERY_MS);
		expect(t.starts).toEqual([]);
		expect(t.looks).toEqual([]);
		// Closed while the start is on its way: its answer touches nothing, and nothing more is started.
		const v = setup();
		v.state.fallback = { code: "DESKTOP_NOT_RUNNING" };
		const w = panel(v);
		await flush();
		let open = () => {};
		v.state.startGate = new Promise<void>((resolve) => {
			open = resolve;
		});
		action(w)!.click();
		await flush();
		expect(v.starts).toHaveLength(1);
		const looked = v.looks.length;
		w.dispose();
		open();
		await advance(MACHINES_EVERY_MS);
		expect(v.starts).toHaveLength(1);
		expect(v.looks).toHaveLength(looked);
		// After 3 minutes the wish is gone: the screen that is off shows its button again, and nothing was started.
		const u = setup({ machines: [machine(1, { state: "stopped" })] });
		const r = panel(u);
		await flush();
		u.state.machines = [machine(1, { state: "starting" })];
		action(r)!.click();
		await flush();
		await advance(WANT_ON_MS);
		u.state.machines = [machine(1)];
		u.state.fallback = { code: "DESKTOP_NOT_RUNNING" };
		u.hint("machines");
		await advance(LOOK_EVERY_MS * 2);
		expect(u.starts).toEqual([]);
		expect(status(r)).toBe("The computer is on, but its screen is off.");
		expect(action(r)?.textContent).toBe("Turn it on");
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
		expect(status(p)).toBe("The computer is on, but its screen is off.");
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

describe("a member's start of a computer for an agent that has none (20260930730000)", () => {
	const starts = (s: Setup) => calls(s, "qorpera_member_start_agent_computer");

	it("offers Start one where the agent has no computer or only machines without a screen, tells a viewer who may, and starts nothing on open", async () => {
		const none = setup({ machines: [] });
		const p = panel(none);
		await flush();
		await advance(MACHINES_EVERY_MS * 2);
		expect(status(p)).toBe(`${staff.displayName} has no computer yet.`);
		expect(action(p)?.textContent).toBe("Start one");
		// A computer costs hours: opening the window, and every list read after, starts none.
		expect(starts(none)).toEqual([]);
		p.dispose();
		const viewer = setup({ machines: [], canWake: false });
		const q = panel(viewer);
		await flush();
		expect(status(q)).toBe(`${staff.displayName} is not using a computer right now.`);
		expect(detail(q)).toBe(
			`${staff.displayName} gets one when a task needs a screen. Someone with edit access can start one.`,
		);
		expect(action(q)).toBeNull();
		q.dispose();
		const headless = setup({ machines: [machine(1, { desktopCapable: false })], canWake: false });
		const r = panel(headless);
		await flush();
		expect(status(r)).toBe(`${staff.displayName} is working on a machine without a screen.`);
		expect(detail(r)).toBe("Someone with edit access can start one.");
		expect(action(r)).toBeNull();
		expect(starts(headless)).toEqual([]);
	});

	it("makes the computer with one press and carries it through to a live picture", async () => {
		const s = setup({ machines: [machine(1, { desktopCapable: false })] });
		const p = panel(s);
		await flush();
		let open = () => {};
		s.state.computerGate = new Promise<void>((resolve) => {
			open = resolve;
		});
		action(p)!.click();
		await flush();
		// On its way: said, and no second press.
		expect(status(p)).toBe("The computer is starting…");
		expect(action(p)).toBeNull();
		expect(starts(s)).toHaveLength(1);
		expect(starts(s)[0]?.body).toEqual({ p_profile_id: profileA.profileId, p_staff_agent_id: staff.id });
		// Made: it waits in line for room, as any wanted machine, and the window says so.
		s.state.computerAnswers.push({ started: machine(9, { state: "waiting", waitingFor: "room" }) });
		s.state.computerGate = undefined;
		open();
		await flush();
		await advance(LOOK_EVERY_MS);
		expect(status(p)).toBe("The computer is starting…");
		expect(detail(p)).toBe("Waiting for room on our servers. It starts as soon as there is room.");
		// It runs, its screen off: the window turns the screen on by itself, and the picture comes. No second press.
		s.state.machines = [machine(1, { desktopCapable: false }), machine(9)];
		s.state.answers.push({ code: "DESKTOP_NOT_RUNNING" }, { picture: 1 });
		s.hint("machines");
		await advance(LOOK_EVERY_MS);
		await advance(LOOK_EVERY_MS);
		expect(s.starts).toHaveLength(1);
		expect(s.starts).toEqual([`/v1/member-machine-screens/${profileA.profileId}/${machine(9).machineId}/start`]);
		await advance(LOOK_EVERY_MS);
		expect(mark(p)).toBe("Live");
		expect(starts(s)).toHaveLength(1);
	});

	it("wakes the agent's own computer when the database answers it, and turns its screen on", async () => {
		const s = setup({ machines: [] });
		const p = panel(s);
		await flush();
		s.state.computerAnswers.push({ existing: machine(3, { state: "stopped" }) });
		s.state.machines = [machine(3, { state: "stopped" })];
		action(p)!.click();
		await flush();
		expect(calls(s, "qorpera_member_manage_company_machine").map((call) => call.body)).toEqual([
			{ p_profile_id: profileA.profileId, p_machine_id: machine(3).machineId, p_action: "start" },
		]);
		s.state.machines = [machine(3)];
		s.state.answers.push({ code: "DESKTOP_NOT_RUNNING" }, { picture: 2 });
		s.hint("machines");
		await advance(LOOK_EVERY_MS);
		await advance(LOOK_EVERY_MS);
		await advance(LOOK_EVERY_MS);
		expect(s.starts).toHaveLength(1);
		expect(mark(p)).toBe("Live");
	});

	it("says why no computer was made in plain words, with Try again where trying again can help", async () => {
		const cases: [{ refused: string } | { status: number }, string, string | null][] = [
			[{ refused: "MACHINES_UNAVAILABLE" }, "No server can run a computer right now. Try again later.", "Try again"],
			[{ refused: "MACHINE_TOO_LARGE" }, "No server is large enough for a computer with a screen.", null],
			[
				{ refused: "START_TOO_SOON" },
				`A computer was started for ${staff.displayName} a moment ago. Try again in a minute.`,
				"Try again",
			],
			[
				{ refused: "AGENT_UNAVAILABLE" },
				`${staff.displayName} is no longer on the team, so it gets no computer.`,
				null,
			],
			[{ status: 503 }, "The computer could not be started. Try again.", "Try again"],
		];
		for (const [answer, words, button] of cases) {
			const s = setup({ machines: [] });
			const p = panel(s);
			await flush();
			s.state.computerAnswers.push(answer);
			action(p)!.click();
			await flush();
			expect(status(p)).toBe(words);
			expect(action(p)?.textContent ?? null).toBe(button);
			// Said until the member presses again: list reads do not take it away, and nothing is made by itself.
			await advance(MACHINES_EVERY_MS * 2);
			expect(status(p)).toBe(words);
			expect(starts(s)).toHaveLength(1);
			if (button) {
				// Try again asks again; this time it is made.
				action(p)!.click();
				await flush();
				expect(starts(s)).toHaveLength(2);
				await advance(LOOK_EVERY_MS);
				expect(status(p)).toBe("The computer is starting…");
			}
			p.dispose();
		}
		// Out of computer hours is no refusal: the computer is made and waits, and the window says so.
		const s = setup({ machines: [] });
		const p = panel(s);
		await flush();
		s.state.computerAnswers.push({ started: machine(9, { state: "waiting", waitingFor: "hours" }) });
		action(p)!.click();
		await flush();
		await advance(LOOK_EVERY_MS);
		expect(status(p)).toBe("The computer is starting…");
		expect(detail(p)).toBe("Out of computer hours. The machine starts by itself once hours are added.");
	});

	it("ends the wish at a close, or after its time, and never turns a screen on after", async () => {
		// Closed while the computer is made: nothing more.
		const s = setup({ machines: [] });
		const p = panel(s);
		await flush();
		let open = () => {};
		s.state.computerGate = new Promise<void>((resolve) => {
			open = resolve;
		});
		action(p)!.click();
		await flush();
		p.dispose();
		s.state.computerGate = undefined;
		open();
		await flush();
		await advance(LOOK_EVERY_MS * 4);
		expect(s.starts).toEqual([]);
		// The wish's time runs out while it waits for room: once it runs, its screen is off and Turn it on is offered.
		const t = setup({ machines: [] });
		const q = panel(t);
		await flush();
		t.state.computerAnswers.push({ started: machine(9, { state: "waiting", waitingFor: "room" }) });
		action(q)!.click();
		await flush();
		await advance(WANT_ON_MS);
		t.state.machines = [machine(9)];
		t.state.fallback = { code: "DESKTOP_NOT_RUNNING" };
		t.hint("machines");
		await advance(LOOK_EVERY_MS * 3);
		expect(t.starts).toEqual([]);
		expect(status(q)).toBe("The computer is on, but its screen is off.");
		expect(action(q)?.textContent).toBe("Turn it on");
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
	/** The view's state, the picture's role and whether it takes keys (v234 in production: input only in the large view). */
	const entered = (p: ComputerPanel) =>
		p.el.querySelector(".machine-screen")?.classList.contains("screen-viewer-entered");
	const words = (p: ComputerPanel) => controls(p)?.querySelector(".machine-screen-control-text")?.textContent;

	it("takes input only in the large view: a click on the preview's picture enters the frame in the thread, never full screen, and Type privately there holds it (v234, 20260930734000)", async () => {
		const full = vi.fn(async () => {});
		Object.defineProperty(HTMLElement.prototype, "requestFullscreen", { configurable: true, value: full });
		cleanup.push(() => {
			delete (HTMLElement.prototype as { requestFullscreen?: unknown }).requestFullscreen;
		});
		const s = setup();
		s.state.answers.push({ picture: 1 });
		const p = panel(s);
		await flush();
		vi.spyOn(canvas(p), "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 800, 500));
		// The preview, before the take-over: a picture to watch, no input, no control.
		expect(entered(p)).toBe(false);
		expect(canvas(p).getAttribute("role")).toBe("img");
		expect(controls(p)).toBeNull();
		pressControl(p);
		await flush();
		// Held: the window entered the frame in the thread by itself, asked for no full screen, and the picture has the keys.
		expect(p.holding).toBe(true);
		expect(entered(p)).toBe(true);
		expect(p.el.classList.contains("is-entered")).toBe(true);
		expect(full).not.toHaveBeenCalled();
		expect(canvas(p).getAttribute("role")).toBe("application");
		expect(document.activeElement).toBe(canvas(p));
		expect(words(p)).toBe(`Typing privately. ${staff.displayName} gets no pictures of the screen until you're done.`);
		press(canvas(p), 400, 250);
		await advance(DOUBLE_CLICK_MS);
		expect(s.acts.map((act) => act.action)).toEqual([{ type: "click", x: 800, y: 500 }]);
		key(canvas(p), "Enter");
		await flush();
		expect(s.acts.at(-1)?.action).toEqual({ type: "key", keys: ["Return"] });
	});

	it("watches only in the preview while the page holds the desktop: no key reaches the computer, a click on the picture opens the large view, and the words say to choose Enter (v234, 20260930734000)", async () => {
		const { s, p } = await holding();
		expect(entered(p)).toBe(true);
		// Back to the thread: the preview, still held.
		p.el.querySelector<HTMLButtonElement>(".screen-viewer-back")!.click();
		await flush();
		expect(entered(p)).toBe(false);
		expect(p.holding).toBe(true);
		expect(canvas(p).getAttribute("role")).toBe("img");
		expect(canvas(p).hasAttribute("tabindex")).toBe(false);
		expect(words(p)).toBe("Typing privately. Choose Enter to click and type.");
		expect(controlButton(p)?.textContent).toBe("Done");
		// A key on the picture and a key on the window: nothing goes to the computer.
		key(canvas(p), "a");
		key(p.el, "Enter");
		await advance(DOUBLE_CLICK_MS + TYPE_BATCH_MS);
		expect(s.acts).toEqual([]);
		// It stays in the preview while held: a new picture does not enter by itself again.
		s.state.answers.push({ picture: 2 });
		await advance(LOOK_EVERY_MS);
		expect(entered(p)).toBe(false);
		// A click on the picture: the large view (20260930734000), nothing of the click sent, and the picture takes input
		// again.
		press(canvas(p), 400, 250);
		await advance(DOUBLE_CLICK_MS);
		expect(s.acts).toEqual([]);
		expect(entered(p)).toBe(true);
		expect(canvas(p).getAttribute("role")).toBe("application");
		expect(words(p)).toBe(`Typing privately. ${staff.displayName} gets no pictures of the screen until you're done.`);
		press(canvas(p), 400, 250);
		await advance(DOUBLE_CLICK_MS);
		expect(s.acts.map((act) => act.action)).toEqual([{ type: "click", x: 800, y: 500 }]);
		// Done from the large view: the private hold ends, and the computer is shared again (20260930734000): the picture
		// takes input with no hold.
		pressControl(p);
		await flush();
		expect(p.holding).toBe(false);
		expect(canvas(p).getAttribute("role")).toBe("application");
		press(canvas(p), 400, 250);
		await advance(DOUBLE_CLICK_MS);
		expect(s.acts.at(-1)).toMatchObject({ action: { type: "click", x: 800, y: 500 }, epoch: null, seat: null });
	});

	/** A thread for the window: its conversation's header stays reachable, a message and the composer are covered while
	 * the window is entered. */
	function thread() {
		const element = document.createElement("div");
		const conversation = document.createElement("div");
		conversation.className = "thread-conversation";
		const header = document.createElement("div");
		header.className = "thread-header";
		const message = document.createElement("div");
		const composer = document.createElement("textarea");
		conversation.append(header, message, composer);
		element.append(conversation);
		document.body.append(element);
		cleanup.push(() => element.remove());
		return { element, header, message, composer };
	}

	it("enters nothing for a take-over answered after the window left its thread, and comes back in the preview (review r1 F1 of #1685)", async () => {
		const s = setup();
		s.state.answers.push({ picture: 1 });
		const place = thread();
		const close = vi.fn();
		const p = new ComputerPanel(staff, s.computer, s.stop.signal, { hints: s.hints, decode: s.decode });
		cleanup.push(() => p.dispose());
		p.attach(place.element, close);
		await flush();
		// Take over with a picture showing; the member leaves the thread before it answers.
		let open = () => {};
		s.state.takeGate = new Promise<void>((resolve) => {
			open = resolve;
		});
		pressControl(p);
		await flush();
		expect(p.holding).toBe(false);
		p.detach();
		open();
		await flush();
		// It succeeded out of the thread: held, and nothing entered.
		expect(p.holding).toBe(true);
		expect(entered(p)).toBe(false);
		expect(p.el.classList.contains("is-entered")).toBe(false);
		// Back in the thread: the preview, with the hold and the words that say how to use it; the thread is reachable.
		p.attach(place.element, close);
		await advance(LOOK_EVERY_MS);
		expect(entered(p)).toBe(false);
		expect(p.el.classList.contains("is-entered")).toBe(false);
		expect(place.message.inert).not.toBe(true);
		expect(place.composer.inert).not.toBe(true);
		expect(canvas(p).getAttribute("role")).toBe("img");
		expect(words(p)).toBe("Typing privately. Choose Enter to click and type.");
	});

	it("cancels an entry still pending when the window leaves its thread (review r1 F1 of #1685)", async () => {
		const s = setup();
		s.state.fallback = { code: "DESKTOP_NOT_RUNNING" };
		const place = thread();
		const close = vi.fn();
		const p = new ComputerPanel(staff, s.computer, s.stop.signal, { hints: s.hints, decode: s.decode });
		cleanup.push(() => p.dispose());
		p.attach(place.element, close);
		await flush();
		// Held while the screen is off: the entry waits for a picture; the member leaves the thread meanwhile.
		p.takeOver();
		await flush();
		expect(p.holding).toBe(true);
		p.detach();
		s.state.fallback = { picture: 2 };
		p.attach(place.element, close);
		await advance(LOOK_EVERY_MS * 3);
		// The picture came back in the thread: the preview, nothing covered.
		expect(mark(p)).toBe("Live");
		expect(entered(p)).toBe(false);
		expect(place.message.inert).not.toBe(true);
		expect(words(p)).toBe("Typing privately. Choose Enter to click and type.");
	});

	it("covers the thread when a window comes back to it entered, whoever entered it (review r1 F1 of #1685)", async () => {
		const s = setup();
		s.state.answers.push({ picture: 1 });
		const place = thread();
		const close = vi.fn();
		const p = new ComputerPanel(staff, s.computer, s.stop.signal, { hints: s.hints, decode: s.decode });
		cleanup.push(() => p.dispose());
		p.attach(place.element, close);
		await flush();
		// Entered in the thread: the conversation under it is covered, its header is not.
		p.el.querySelector<HTMLButtonElement>(".screen-viewer-enter")!.click();
		expect(place.message.inert).toBe(true);
		expect(place.composer.inert).toBe(true);
		expect(place.header.inert).not.toBe(true);
		// Leaving the thread takes it back to the preview and uncovers the thread.
		p.detach();
		expect(p.el.classList.contains("is-entered")).toBe(false);
		expect(place.message.inert).not.toBe(true);
		// Entered while out of a thread (only a script can press Enter there; the window enters nothing by itself), it
		// covers the thread it comes back to, as entering does.
		p.el.querySelector<HTMLButtonElement>(".screen-viewer-enter")!.click();
		expect(p.el.classList.contains("is-entered")).toBe(true);
		p.attach(place.element, close);
		expect(place.message.inert).toBe(true);
		expect(place.composer.inert).toBe(true);
		expect(place.header.inert).not.toBe(true);
		// And Back uncovers it.
		p.el.querySelector<HTMLButtonElement>(".screen-viewer-back")!.click();
		expect(place.message.inert).not.toBe(true);
		expect(place.composer.inert).not.toBe(true);
	});

	it("enters once a picture shows when the take-over came before it, as the agent's take-over card's does (v234)", async () => {
		const s = setup();
		s.state.fallback = { code: "DESKTOP_NOT_RUNNING" };
		const p = panel(s);
		await flush();
		// The card's Take over: the window takes the desktop over while its screen is off.
		p.takeOver();
		await flush();
		expect(p.holding).toBe(true);
		expect(entered(p)).toBe(false);
		// The picture comes: the window enters by itself, and the picture takes input.
		s.state.fallback = { picture: 3 };
		await advance(LOOK_EVERY_MS * 3);
		expect(entered(p)).toBe(true);
		expect(canvas(p).getAttribute("role")).toBe("application");
		// Handed back before any picture: nothing is entered later.
		const second = setup();
		second.state.fallback = { code: "DESKTOP_NOT_RUNNING" };
		const other = panel(second);
		await flush();
		other.takeOver();
		await flush();
		expect(await other.handBack()).toBe(true);
		second.state.fallback = { picture: 4 };
		await advance(LOOK_EVERY_MS * 3);
		expect(entered(other)).toBe(false);
		expect(canvas(other).getAttribute("role")).toBe("img");
	});

	it("takes the desktop over, says what it means, renews it every minute and hands it back", async () => {
		const { s, p } = await holding();
		// The take-over is sent at the member's hand-back epoch the list said (review r5), with a press id of its own (F26).
		const press = calls(s, "qorpera_member_take_machine_desktop")[0]?.body.p_press;
		expect(isUuid(press)).toBe(true);
		expect(calls(s, "qorpera_member_take_machine_desktop")).toEqual([
			{
				method: "qorpera_member_take_machine_desktop",
				body: { p_profile_id: profileA.profileId, p_machine_id: machine(1).machineId, p_epoch: 0, p_press: press },
			},
		]);
		expect(p.holding).toBe(true);
		// The words never say the agent cannot see: it gets no pictures (the agent is root on that machine).
		expect(controls(p)?.textContent).toContain(
			`Typing privately. ${staff.displayName} gets no pictures of the screen until you're done.`,
		);
		expect(controls(p)?.textContent).not.toMatch(/cannot see/);
		expect(controlButton(p)?.textContent).toBe("Done");
		// The picture takes the keyboard.
		expect(canvas(p).getAttribute("tabindex")).toBe("0");
		expect(canvas(p).getAttribute("role")).toBe("application");
		expect(document.activeElement).toBe(canvas(p));
		// Renewed every minute while the window shows it.
		await advance(KEEP_EVERY_MS - 1);
		expect(calls(s, "qorpera_member_keep_machine_desktop")).toHaveLength(0);
		await advance(1);
		// Each heartbeat names the hold's seat, the take-over's answer (F26).
		expect(calls(s, "qorpera_member_keep_machine_desktop")).toEqual([
			{
				method: "qorpera_member_keep_machine_desktop",
				body: { p_profile_id: profileA.profileId, p_machine_id: machine(1).machineId, p_epoch: 0, p_seat: 1 },
			},
		]);
		await advance(KEEP_EVERY_MS);
		expect(calls(s, "qorpera_member_keep_machine_desktop")).toHaveLength(2);
		// Hand back: the database has it back, the picture takes no input, Take over again.
		pressControl(p);
		await flush();
		// Every take-over was answered, so Hand back is EXACT (F27, F28): by the seat the list shows the member holding,
		// here this page's own.
		expect(calls(s, "qorpera_member_hand_back_machine_desktop").map((call) => call.body)).toEqual([
			{
				p_profile_id: profileA.profileId,
				p_machine_id: machine(1).machineId,
				p_reason: "handed_back",
				p_epoch: 0,
				p_seat: 1,
			},
		]);
		expect(p.holding).toBe(false);
		expect(controlButton(p)?.textContent).toBe("Type privately");
		// Shared again (20260930734000): the picture keeps the keyboard, with no hold and no heartbeat.
		expect(canvas(p).getAttribute("tabindex")).toBe("0");
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

	it("sends the member's input in the order they made it across kinds: what is gathered of one kind goes when another begins (v233 release review r1, F31)", async () => {
		const { s, p } = await holding();
		const target = canvas(p);
		const wheel = (deltaY = 100) =>
			target.dispatchEvent(
				new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 400, clientY: 100, deltaY }),
			);
		/** The actions sent since `from`, by their verbs. */
		const sent = (from: number) => s.acts.slice(from).map((act) => act.action.type);
		// A click, then a wheel turn 20 ms later: the click waits for a second no more, and goes before the scroll.
		let from = s.acts.length;
		press(target, 400, 250);
		await advance(20);
		wheel();
		await advance(DOUBLE_CLICK_MS);
		expect(sent(from)).toEqual(["click", "scroll"]);
		// A wheel turn, then a click 20 ms later: the scroll first.
		from = s.acts.length;
		wheel();
		await advance(20);
		press(target, 400, 250);
		await advance(DOUBLE_CLICK_MS);
		expect(sent(from)).toEqual(["scroll", "click"]);
		// A wheel turn, then a key: the scroll first.
		from = s.acts.length;
		wheel();
		await advance(20);
		key(target, "Enter");
		await advance(DOUBLE_CLICK_MS);
		expect(sent(from)).toEqual(["scroll", "key"]);
		// Text, then a wheel turn: the text first; a wheel turn, then text: the scroll first.
		from = s.acts.length;
		key(target, "a");
		await advance(20);
		wheel();
		await advance(20);
		key(target, "b");
		await advance(TYPE_BATCH_MS + DOUBLE_CLICK_MS);
		expect(sent(from)).toEqual(["type", "scroll", "type"]);
		expect(s.acts.slice(from).map((act) => act.action.text ?? null)).toEqual(["a", null, "b"]);
		// A wheel turn, then a drag and a right click: the scroll first.
		from = s.acts.length;
		wheel();
		await advance(20);
		press(target, 50, 50, {}, [300, 200]);
		press(target, 10, 20, { button: 2 });
		await advance(DOUBLE_CLICK_MS);
		expect(sent(from)).toEqual(["scroll", "drag", "click"]);
		// A click, then typed text and a paste: the click first.
		from = s.acts.length;
		press(target, 400, 250);
		await advance(20);
		key(target, "c");
		await advance(20);
		const clip = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
		Object.defineProperty(clip, "clipboardData", { value: { getData: () => "d" } });
		target.dispatchEvent(clip);
		await advance(TYPE_BATCH_MS + DOUBLE_CLICK_MS);
		expect(s.acts.slice(from).map((act) => [act.action.type, act.action.text ?? null])).toEqual([
			["click", null],
			["type", "c"],
			["type", "d"],
		]);
		// A double click still is one, with nothing between its two presses.
		from = s.acts.length;
		press(target, 100, 50);
		press(target, 101, 50);
		await advance(DOUBLE_CLICK_MS);
		expect(sent(from)).toEqual(["double"]);
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
		pressControl(p);
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
		expect(controls(p)?.textContent ?? "").not.toContain("Waiting for");
		// Busy past 15 s: the action is dropped, the window says so (20260930734000: never silently), and the next goes.
		s.state.actAnswers.push(...Array.from({ length: 20 }, () => ({ code: "DESKTOP_BUSY" })));
		press(canvas(p), 20, 20, { button: 2 });
		await advance(16_000);
		expect(controls(p)?.textContent ?? "").not.toContain("Waiting for");
		expect(controls(p)?.textContent).toContain(
			"The computer was busy, so your last input did not go through. Try again.",
		);
		s.state.actAnswers.splice(0);
		const before = s.acts.length;
		press(canvas(p), 30, 30, { button: 2 });
		await flush();
		expect(s.acts.slice(before).map((act) => act.action)).toEqual([{ type: "click", x: 60, y: 60, button: "right" }]);
		expect(controls(p)?.textContent ?? "").not.toContain("did not go through");
	});

	it("lets go when the hold ended under it: an action told so, or the heartbeat told so", async () => {
		const { s, p } = await holding();
		// As the database: the hold ran out, so the list says no one holds it.
		s.state.actAnswers.push({ code: "DESKTOP_CONTROL_ENDED" });
		s.state.machines = [machine(1)];
		press(canvas(p), 10, 10, { button: 2 });
		await flush();
		expect(p.holding).toBe(false);
		expect(controlButton(p)?.textContent).toBe("Type privately");
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
		expect(controlButton(second.p)?.textContent).toBe("Type privately");
	});

	it("shows who holds the desktop to another member, not the screen, until they give it back or their time runs out", async () => {
		const until = new Date(Date.now() + 120_000).toISOString();
		const s = setup({
			machines: [machine(1, { control: { mine: false, name: "Ada", until, epoch: null, seat: null, press: null } })],
		});
		const p = panel(s);
		await flush();
		expect(status(p)).toBe("Ada is typing privately. The screen is hidden until they're done.");
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
		s.state.machines = [
			machine(1, { control: { mine: false, name: "Ada", until, epoch: null, seat: null, press: null } }),
		];
		s.state.answers.push({ code: "DESKTOP_MEMBER_IN_CONTROL" });
		await advance(LOOK_EVERY_MS);
		await flush();
		expect(status(p)).toBe("Ada is typing privately. The screen is hidden until they're done.");
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
		s.state.machines = [
			machine(1, { control: { mine: false, name: "Ada", until, epoch: null, seat: null, press: null } }),
		];
		pressControl(p);
		await flush();
		await flush();
		expect(p.holding).toBe(false);
		expect(status(p)).toBe("Ada is typing privately. The screen is hidden until they're done.");
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

	it("shows a hold the list says is the member's from elsewhere (the page was loaded again) and never uses it; Take over makes it this window's at its epoch, given back as the page goes (r14)", async () => {
		const until = new Date(Date.now() + 120_000).toISOString();
		// The page was loaded again: the list says the member holds it, taken under their epoch 3, which this page never knew.
		const s = setup({
			machines: [machine(1, { control: { mine: true, name: "Owner", until, epoch: 3, seat: 7, press: id(97) } })],
		});
		s.state.epochs.set(machine(1).machineId, 3);
		s.state.answers.push({ picture: 1 });
		const p = panel(s);
		await flush();
		// Shown as the member's own, from another window: the picture, Take over and Hand back; no input, no heartbeat.
		expect(p.holding).toBe(false);
		expect(controls(p)?.textContent).toContain("You are typing privately in another window.");
		expect(controlButton(p)?.textContent).toBe("Type privately");
		expect(handBackButton(p)?.hidden).toBe(false);
		expect(canvas(p).hasAttribute("tabindex")).toBe(false);
		key(canvas(p), "Enter");
		await advance(KEEP_EVERY_MS * 2);
		expect(s.acts).toEqual([]);
		expect(calls(s, "qorpera_member_keep_machine_desktop")).toHaveLength(0);
		// Take over: sent at that epoch (the database renews the member's own lease for this page), held and renewed here.
		pressControl(p);
		await flush();
		expect(calls(s, "qorpera_member_take_machine_desktop").map((call) => call.body.p_epoch)).toEqual([3]);
		expect(p.holding).toBe(true);
		expect(controlButton(p)?.textContent).toBe("Done");
		expect(handBackButton(p)?.hidden).toBe(true);
		await advance(KEEP_EVERY_MS);
		expect(calls(s, "qorpera_member_keep_machine_desktop").map((call) => call.body.p_epoch)).toEqual([3]);
		window.dispatchEvent(new Event("pagehide"));
		const left = s.fetch.mock.calls.find(
			([url, init]) => String(url).endsWith("/qorpera_member_hand_back_machine_desktop") && init?.keepalive === true,
		);
		expect(left?.[1]).toMatchObject({ method: "POST", keepalive: true });
		// Its take-over was answered: EXACT, by the seat it got (F27, F28).
		expect(JSON.parse(String(left?.[1]?.body))).toEqual({
			p_profile_id: profileA.profileId,
			p_machine_id: machine(1).machineId,
			p_reason: "closed",
			p_epoch: 3,
			p_seat: 1,
		});
		// The page may come back from the browser's cache: the hold is given back as ever too, not only by the keepalive.
		await flush();
		expect(p.holding).toBe(false);
		expect(
			calls(s, "qorpera_member_hand_back_machine_desktop").filter((call) => call.body.p_epoch === 3),
		).toHaveLength(2);
	});

	it("hands a hold from elsewhere back at the list's epoch with the window's Hand back, never using it (r14)", async () => {
		const until = new Date(Date.now() + 120_000).toISOString();
		const s = setup({
			machines: [machine(1, { control: { mine: true, name: "Owner", until, epoch: 3, seat: 7, press: id(97) } })],
		});
		s.state.epochs.set(machine(1).machineId, 3);
		s.state.answers.push({ picture: 1 });
		const p = panel(s);
		await flush();
		handBackButton(p)!.click();
		await flush();
		expect(calls(s, "qorpera_member_hand_back_machine_desktop").map((call) => call.body.p_epoch)).toEqual([3]);
		expect(s.state.machines[0]?.control).toBeNull();
		expect(p.holding).toBe(false);
		await advance(KEEP_EVERY_MS * 2);
		expect(calls(s, "qorpera_member_keep_machine_desktop")).toHaveLength(0);
		expect(calls(s, "qorpera_member_take_machine_desktop")).toHaveLength(0);
		expect(controls(p)?.textContent ?? "").not.toContain("in another window");
	});

	it("hands a hold from elsewhere back from the click though the list read after it fails, and says so until confirmed (r15 F23)", async () => {
		const until = new Date(Date.now() + 120_000).toISOString();
		const s = setup({
			machines: [machine(1, { control: { mine: true, name: "Owner", until, epoch: 3, seat: 7, press: id(97) } })],
		});
		s.state.epochs.set(machine(1).machineId, 3);
		s.state.answers.push({ picture: 1 });
		const p = panel(s);
		await flush();
		expect(controls(p)?.textContent).toContain("You are typing privately in another window.");
		// Hand back, with the list reads after it failing: the hand-back at the shown epoch goes at once and is answered.
		s.state.listFails = 2;
		handBackButton(p)!.click();
		await flush();
		expect(calls(s, "qorpera_member_hand_back_machine_desktop").map((call) => call.body.p_epoch)).toEqual([3]);
		expect(s.state.machines[0]?.control).toBeNull();
		// The confirming read failed: the window says the computer could not be given back yet, with Try again.
		expect(controls(p)?.textContent).toContain("Private typing could not be ended yet.");
		expect(controlButton(p)?.textContent).toBe("Try again");
		expect(p.holding).toBe(false);
		expect(calls(s, "qorpera_member_keep_machine_desktop")).toHaveLength(0);
		// Try again: the list reads, nothing of the member's is held: done, and the words go.
		pressControl(p);
		await flush();
		expect(controls(p)?.textContent ?? "").not.toContain("could not be ended");
		// Back to a shared computer, in the preview, once a list read shows it: watched only, no control on it
		// (20260930734000).
		await advance(MACHINES_EVERY_MS);
		expect(controls(p)).toBeNull();
		expect(calls(s, "qorpera_member_take_machine_desktop")).toHaveLength(0);
	});

	it("never uses a hold of another tab's that the first list shows after pagehide: in another window, no input, no heartbeat; a press takes it over (r14 F21)", async () => {
		const until = new Date(Date.now() + 120_000).toISOString();
		// Another tab of the member's holds the desktop; this window's first list read is on its way.
		const s = setup({
			machines: [machine(1, { control: { mine: true, name: "Owner", until, epoch: 0, seat: 7, press: id(97) } })],
		});
		let arrive!: () => void;
		s.state.listGate = new Promise<void>((resolve) => {
			arrive = resolve;
		});
		s.state.answers.push({ picture: 1 });
		const p = panel(s);
		await flush();
		// The page is hidden and comes back; then the list arrives.
		window.dispatchEvent(new Event("pagehide"));
		await flush();
		arrive();
		await flush();
		await advance(LOOK_EVERY_MS);
		expect(p.holding).toBe(false);
		expect(controls(p)?.textContent).toContain("You are typing privately in another window.");
		key(canvas(p), "Enter");
		await advance(KEEP_EVERY_MS * 2);
		expect(s.acts).toEqual([]);
		expect(calls(s, "qorpera_member_keep_machine_desktop")).toHaveLength(0);
		expect(calls(s, "qorpera_member_take_machine_desktop")).toHaveLength(0);
		// A press takes it over (the member's own lease, renewed for this page), and then it is used and renewed.
		pressControl(p);
		await flush();
		expect(calls(s, "qorpera_member_take_machine_desktop").map((call) => call.body.p_epoch)).toEqual([0]);
		expect(p.holding).toBe(true);
		await advance(KEEP_EVERY_MS);
		expect(calls(s, "qorpera_member_keep_machine_desktop").map((call) => call.body.p_epoch)).toEqual([0]);
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
		expect(
			await t.screens.act(machine(1).machineId, { type: "type", text: "Åse" }, { epoch: 5, seat: 8 }, signal),
		).toEqual({
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
		// With the epoch and the seat of the hold the input was captured under (F24, F26).
		expect(JSON.parse(String(init?.body))).toEqual({ action: { type: "type", text: "Åse" }, epoch: 5, seat: 8 });
		const busy = transport(() => Response.json({ code: "DESKTOP_BUSY" }, { status: 409 }));
		expect(
			await busy.screens.act(machine(1).machineId, { type: "key", keys: ["Return"] }, { epoch: 0, seat: 0 }, signal),
		).toEqual({
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
				transport(answer).screens.act(
					machine(1).machineId,
					{ type: "key", keys: ["Return"] },
					{ epoch: 0, seat: 1 },
					signal,
				),
			).rejects.toThrow();
		await expect(
			transport(() => Response.json({})).screens.act(
				"machine",
				{ type: "key", keys: ["a"] },
				{ epoch: 0, seat: 1 },
				signal,
			),
		).rejects.toThrow();
		// An epoch or a seat that is not a safe whole number, 0 or more, is never sent.
		for (const hold of [-1, 1.5, Number.NaN].flatMap((bad) => [
			{ epoch: bad, seat: 1 },
			{ epoch: 1, seat: bad },
		]))
			await expect(
				transport(() => Response.json({})).screens.act(
					machine(1).machineId,
					{ type: "key", keys: ["a"] },
					hold,
					signal,
				),
			).rejects.toThrow();
	});
	it("posts a shared action alone, with no hold, and takes the shared begin's refusals (20260930734000)", async () => {
		const t = transport(() => Response.json({ schema: "qorpera.member-machine-act/v1", exitCode: 0 }));
		expect(await t.screens.act(machine(1).machineId, { type: "type", text: "Åse" }, null, signal)).toEqual({
			kind: "done",
			exitCode: 0,
		});
		expect(JSON.parse(String(t.fetch.mock.calls[0]![1]?.body))).toEqual({ action: { type: "type", text: "Åse" } });
		for (const code of ["DESKTOP_MEMBER_IN_CONTROL", "DESKTOP_ACTIONS_TOO_FAST", "DESKTOP_MACHINE_TOO_SMALL"])
			expect(
				await transport(() => Response.json({ code }, { status: 409 })).screens.act(
					machine(1).machineId,
					{ type: "key", keys: ["Return"] },
					null,
					signal,
				),
			).toEqual({ kind: "refused", code });
	});
});

describe("a member shares the agent's computer (20260930734000)", () => {
	const entered = (p: ComputerPanel) =>
		p.el.querySelector(".machine-screen")?.classList.contains("screen-viewer-entered");
	const words = (p: ComputerPanel) => controls(p)?.querySelector(".machine-screen-control-text")?.textContent ?? "";
	const who = (p: ComputerPanel) => controls(p)?.querySelector(".machine-screen-control-who")?.textContent ?? "";
	/** A window showing machine 1's picture (1600 x 1000 in an 800 x 500 box), in the preview. */
	async function shown(s: Setup = setup()) {
		s.state.answers.push({ picture: 1 });
		const p = panel(s);
		await flush();
		vi.spyOn(canvas(p), "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 800, 500));
		canvas(p).width = 1600;
		canvas(p).height = 1000;
		return { s, p };
	}

	it("opens the large view with a click on the preview's picture, and takes the member's input there at once, with no hold", async () => {
		const full = vi.fn(async () => {});
		Object.defineProperty(HTMLElement.prototype, "requestFullscreen", { configurable: true, value: full });
		cleanup.push(() => {
			delete (HTMLElement.prototype as { requestFullscreen?: unknown }).requestFullscreen;
		});
		const { s, p } = await shown();
		// The preview: watched only, no Take over on it, no input.
		expect(controls(p)).toBeNull();
		key(canvas(p), "a");
		await advance(TYPE_BATCH_MS);
		expect(s.acts).toEqual([]);
		// A press that moves drags the window: it opens nothing.
		press(canvas(p), 100, 100, {}, [140, 130]);
		await flush();
		expect(entered(p)).toBe(false);
		// A click on the picture: the large view in the thread (never full screen), and nothing of the click is sent.
		press(canvas(p), 400, 250);
		await advance(DOUBLE_CLICK_MS);
		expect(entered(p)).toBe(true);
		expect(full).not.toHaveBeenCalled();
		expect(s.acts).toEqual([]);
		expect(canvas(p).getAttribute("role")).toBe("application");
		// The member acts at once: clicks, keys and text go with no hold, and no take-over is asked.
		press(canvas(p), 400, 250);
		await advance(DOUBLE_CLICK_MS);
		for (const value of ["H", "e", "j"]) key(canvas(p), value);
		await advance(TYPE_BATCH_MS);
		key(canvas(p), "Enter");
		await flush();
		expect(s.acts.map((act) => [act.action, act.epoch, act.seat])).toEqual([
			[{ type: "click", x: 800, y: 500 }, null, null],
			[{ type: "type", text: "Hej" }, null, null],
			[{ type: "key", keys: ["Return"] }, null, null],
		]);
		expect(calls(s, "qorpera_member_take_machine_desktop")).toEqual([]);
		expect(calls(s, "qorpera_member_keep_machine_desktop")).toEqual([]);
		// Back to the thread: watched only again.
		p.el.querySelector<HTMLButtonElement>(".screen-viewer-back")!.click();
		await flush();
		key(canvas(p), "x");
		await advance(TYPE_BATCH_MS);
		expect(s.acts).toHaveLength(3);
		expect(canvas(p).getAttribute("role")).toBe("img");
	});

	it("says once, the first time, that the member and the agent share the computer, and offers Type privately with a lock", async () => {
		const { p } = await shown();
		press(canvas(p), 400, 250);
		await flush();
		expect(words(p)).toBe(`You and ${staff.displayName} share this computer: you can both click and type.`);
		const lock = controlButton(p)!;
		expect(lock.textContent).toBe("Type privately");
		expect(lock.querySelector("svg.icon")).not.toBeNull();
		expect(lock.classList.contains("is-secondary")).toBe(true);
		expect(lock.title).toBe(`For passwords: ${staff.displayName} gets no pictures of the screen until you're done.`);
		// It stays while the large view is open, and goes for good once it is left.
		await advance(LOOK_EVERY_MS * 2);
		expect(words(p)).toContain("share this computer");
		p.el.querySelector<HTMLButtonElement>(".screen-viewer-back")!.click();
		await flush();
		press(canvas(p), 400, 250);
		await flush();
		expect(entered(p)).toBe(true);
		expect(words(p)).toBe("");
		expect(controlButton(p)?.textContent).toBe("Type privately");
		// Another window in this browser says it no more either.
		p.dispose();
		const again = await shown();
		press(canvas(again.p), 400, 250);
		await flush();
		expect(entered(again.p)).toBe(true);
		expect(words(again.p)).toBe("");
	});

	it("names who else used the computer in the last minute, in the preview too; a viewer watches and is told so", async () => {
		const s = setup({ machines: [machine(1, { others: ["Ada"] })] });
		const { p } = await shown(s);
		expect(controls(p)).not.toBeNull();
		expect(who(p)).toBe("Ada is using it too.");
		expect(controlButton(p)).toBeNull();
		s.state.machines = [machine(1, { others: ["Ada", "Bo", "Cy"] })];
		s.hint("machines");
		await flush();
		expect(who(p)).toBe("Ada, Bo and Cy are using it too.");
		s.state.machines = [machine(1)];
		s.hint("machines");
		await flush();
		expect(controls(p)).toBeNull();
		p.dispose();
		// A viewer: the picture, who else, and in the large view that they watch; no input, no lock.
		const viewer = setup({ role: "viewer", canTakeOver: false, machines: [machine(1, { others: ["Ada"] })] });
		const { p: watching } = await shown(viewer);
		press(canvas(watching), 400, 250);
		await flush();
		expect(entered(watching)).toBe(true);
		expect(words(watching)).toBe("You can watch. Someone with edit access can use the computer.");
		expect(who(watching)).toBe("Ada is using it too.");
		expect(controlButton(watching)).toBeNull();
		expect(canvas(watching).getAttribute("role")).toBe("img");
		press(canvas(watching), 400, 250);
		key(canvas(watching), "a");
		await advance(DOUBLE_CLICK_MS + TYPE_BATCH_MS);
		expect(viewer.acts).toEqual([]);
	});

	it("types privately with the lock: the hold, the words, Done, and shared input again after it; what was typed under it never goes out shared", async () => {
		const { s, p } = await shown();
		press(canvas(p), 400, 250);
		await flush();
		// A shared click first.
		press(canvas(p), 100, 100);
		await advance(DOUBLE_CLICK_MS);
		expect(s.acts.map((act) => act.seat)).toEqual([null]);
		// Type privately: no input goes while it is on its way; then the private hold takes it.
		let open = () => {};
		s.state.takeGate = new Promise<void>((resolve) => {
			open = resolve;
		});
		controlButton(p)!.click();
		await flush();
		expect(controlButton(p)?.disabled).toBe(true);
		expect(canvas(p).getAttribute("role")).toBe("img");
		key(canvas(p), "z");
		await advance(TYPE_BATCH_MS);
		expect(s.acts).toHaveLength(1);
		open();
		await flush();
		expect(p.holding).toBe(true);
		expect(words(p)).toBe(`Typing privately. ${staff.displayName} gets no pictures of the screen until you're done.`);
		expect(words(p)).not.toMatch(/can't see|cannot see/);
		expect(controlButton(p)?.textContent).toBe("Done");
		expect(controlButton(p)?.classList.contains("is-secondary")).toBe(false);
		// The password, under the hold: with its epoch and seat. Done comes before its batch goes: it goes nowhere.
		for (const value of ["p", "w"]) key(canvas(p), value);
		await advance(TYPE_BATCH_MS);
		expect(s.acts.at(-1)).toMatchObject({ action: { type: "type", text: "pw" }, epoch: 0, seat: 1 });
		key(canvas(p), "d");
		pressControl(p);
		await advance(TYPE_BATCH_MS);
		await flush();
		expect(p.holding).toBe(false);
		expect(s.acts.filter((act) => act.action.type === "type").map((act) => act.action.text)).toEqual(["pw"]);
		// Shared again: the lock is offered, and input goes with no hold.
		expect(controlButton(p)?.textContent).toBe("Type privately");
		press(canvas(p), 100, 100);
		await advance(DOUBLE_CLICK_MS);
		expect(s.acts.at(-1)).toMatchObject({ action: { type: "click", x: 200, y: 200 }, epoch: null, seat: null });
	});

	it("waits for a busy desktop, says when input did not go through, and stops when someone types privately", async () => {
		const { s, p } = await shown();
		press(canvas(p), 400, 250);
		await flush();
		// The agent's step holds the desktop: the member's click waits for it, then goes.
		s.state.actAnswers.push({ code: "DESKTOP_BUSY" }, { code: "DESKTOP_ACTIONS_TOO_FAST" });
		press(canvas(p), 10, 10, { button: 2 });
		await flush();
		expect(controls(p)?.textContent).toContain(`Waiting for ${staff.displayName} to finish a step…`);
		await advance(1000);
		await advance(1000);
		expect(s.acts).toHaveLength(3);
		expect(controls(p)?.textContent ?? "").not.toContain("Waiting for");
		// Busy past 15 s: dropped, and said.
		s.state.actAnswers.push(...Array.from({ length: 20 }, () => ({ code: "DESKTOP_BUSY" })));
		press(canvas(p), 20, 20, { button: 2 });
		await advance(16_000);
		expect(controls(p)?.textContent).toContain(
			"The computer was busy, so your last input did not go through. Try again.",
		);
		s.state.actAnswers.splice(0);
		// Ada types privately: the shared action is refused, the list says who, and the screen is hidden.
		const until = new Date(Date.now() + 120_000).toISOString();
		s.state.machines = [
			machine(1, { control: { mine: false, name: "Ada", until, epoch: null, seat: null, press: null } }),
		];
		s.state.actAsDatabase = true;
		s.state.fallback = { code: "DESKTOP_MEMBER_IN_CONTROL" };
		press(canvas(p), 30, 30, { button: 2 });
		await flush();
		await advance(LOOK_EVERY_MS);
		expect(s.acts.at(-1)?.ran).toBe(false);
		expect(status(p)).toBe("Ada is typing privately. The screen is hidden until they're done.");
		expect(screen(p)?.hidden).toBe(true);
		// She is done: the computer is shared again.
		s.state.machines = [machine(1)];
		s.state.fallback = { picture: 4 };
		s.hint("machines");
		await advance(LOOK_EVERY_MS);
		expect(mark(p)).toBe("Live");
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
		expect(words(p)).toBe("Private typing could not be ended yet. It ends by itself within 5 minutes.");
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
		expect(controlButton(p)?.textContent).toBe("Type privately");
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
		pressControl(p);
		await flush();
		expect(count()).toBe(3);
		expect(words(p)).toBe("Private typing could not be ended yet. It ends by itself within 5 minutes.");
		pressControl(p);
		await flush();
		expect(count()).toBe(4);
		expect(controlButton(p)?.textContent).toBe("Type privately");
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
		expect(words(p)).toBe("Ending private typing…");
		expect(controlButton(p)?.disabled).toBe(true);
		slow.open();
		await back;
		expect(done).toBe(true);
		expect(controlButton(p)?.textContent).toBe("Type privately");
	});

	it("calls off a take-over still on its way: the hand-back names it at once, and the take-over is refused when it arrives", async () => {
		const s = setup();
		s.state.answers.push({ picture: 1 });
		const p = panel(s);
		await flush();
		const late = gate();
		s.state.takeGate = late.closed;
		pressControl(p);
		await flush();
		expect(takeEpochs(s)).toEqual([0]);
		// I'm done while the take-over is on its way: VOID at its epoch goes at once (F27), and its answer is the
		// confirmation (review r5): nothing waits for the take-over.
		expect(await p.handBack()).toBe(true);
		expect(calls(s, "qorpera_member_hand_back_machine_desktop").map((call) => call.body)).toEqual([
			{
				p_profile_id: profileA.profileId,
				p_machine_id: machine(1).machineId,
				p_reason: "handed_back",
				p_epoch: 0,
				p_seat: null,
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
		pressControl(p);
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
				p_seat: null,
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
		pressControl(p);
		await flush();
	}
	const handBacks = (s: Setup) => calls(s, "qorpera_member_hand_back_machine_desktop");
	const keeps = (s: Setup) => calls(s, "qorpera_member_keep_machine_desktop");
	const until = () => new Date(Date.now() + 120_000).toISOString();
	/** The member's hold from elsewhere (another tab), in its own seat and by its own press (F26). */
	const held = (epoch: number, seat = 100 + epoch) => ({
		mine: true,
		name: "Owner",
		until: until(),
		epoch,
		seat,
		press: id(700 + seat),
	});

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
		expect(controls(p)?.textContent).toContain("Private typing could not start. Try again.");
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
		pressControl(p);
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
		// No hand-back was asked: the next list read says the member holds it at that epoch; the take-over was this page's,
		// so the window uses it (review r14: only a press on this page's own).
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

	it("sends what is typed under a new hold of the same machine while an older hold's action is unanswered, once and in order; that answer touches nothing (r17 F25)", async () => {
		const { s, p } = await company();
		await takeOver(p);
		expect(p.holding).toBe(true);
		// Action A under the first hold (epoch 0); its answer is held back.
		const late = gate();
		s.state.actAnswers.push({ hold: late.closed, exitCode: 0 });
		key(canvas(p), "Enter");
		await flush();
		expect(s.acts.map((act) => act.epoch)).toEqual([0]);
		// Hand back (A's request is cut off on the page), take the same machine over again (epoch 1), and type B.
		expect(await p.handBack()).toBe(true);
		expect(s.acts[0]?.signal?.aborted).toBe(true);
		await takeOver(p);
		expect(p.holding).toBe(true);
		key(canvas(p), "Tab");
		await flush();
		// B goes at once, under the new hold, though A is still unanswered.
		expect(s.acts.map((act) => act.epoch)).toEqual([0, 1]);
		// A's answer comes (it ran): nothing of the new hold changes, B is not sent again, and C goes after it.
		late.open();
		await flush();
		expect(p.holding).toBe(true);
		expect(s.acts.map((act) => act.epoch)).toEqual([0, 1]);
		key(canvas(p), "End");
		await flush();
		expect(s.acts.map((act) => act.epoch)).toEqual([0, 1, 1]);
		expect(s.acts.slice(1).map((act) => act.action)).toEqual([
			{ type: "key", keys: ["Tab"] },
			{ type: "key", keys: ["End"] },
		]);
	});

	it("lets an older hold's refused action end nothing of the new hold: input and heartbeats go on, nothing more is owed (r17 F25)", async () => {
		const { s, panels, p } = await company();
		await takeOver(p);
		const late = gate();
		s.state.actAnswers.push({ hold: late.closed, code: "DESKTOP_CONTROL_ENDED" });
		key(canvas(p), "Enter");
		await flush();
		expect(await p.handBack()).toBe(true);
		await takeOver(p);
		key(canvas(p), "Tab");
		await flush();
		expect(s.acts.map((act) => act.epoch)).toEqual([0, 1]);
		// A's refusal comes (its hold ended): the new hold goes on.
		late.open();
		await flush();
		expect(p.holding).toBe(true);
		expect(controls(p)?.textContent ?? "").not.toContain("could not");
		key(canvas(p), "End");
		await flush();
		expect(s.acts.map((act) => act.epoch)).toEqual([0, 1, 1]);
		await advance(KEEP_EVERY_MS);
		expect(keeps(s).map((call) => call.body.p_epoch)).toEqual([1]);
		expect(p.holding).toBe(true);
		// What is owed is the new hold alone: I'm done hands back at 1, once.
		expect(await panels.releaseAgent(staff.id)).toBe(true);
		expect(backEpochs(s)).toEqual([0, 1]);
	});

	it("refuses, by its seat, an action of a hold whose lease ran out once this page took the desktop over again at the same epoch; its answer touches nothing (r18 F26)", async () => {
		const { s, p } = await company();
		s.state.actAsDatabase = true;
		await takeOver(p);
		expect(p.holding).toBe(true);
		// Action A under the first hold (epoch 0, seat 1); it reaches the database only later.
		const late = gate();
		s.state.actAnswers.push({ hold: late.closed, exitCode: 0 });
		key(canvas(p), "Enter");
		await flush();
		expect(s.acts.map((act) => [act.epoch, act.seat])).toEqual([[0, 1]]);
		// The lease runs out (no heartbeat reached it for 5 minutes): the database holds nothing now; the epoch stays.
		s.state.machines = [machine(1)];
		// The window's heartbeat hears it ended and lets go; A's request is cut off on the page, and may still arrive.
		await advance(KEEP_EVERY_MS);
		expect(p.holding).toBe(false);
		expect(s.acts[0]?.signal?.aborted).toBe(true);
		// Taken over again on this page, with no hand-back between: the same epoch, a new seat.
		await takeOver(p);
		expect(takeEpochs(s)).toEqual([0, 0]);
		expect(p.holding).toBe(true);
		expect(s.state.machines[0]?.control?.seat).toBe(2);
		// A arrives now, naming seat 1: refused, so it runs nowhere, and the new hold is as it was.
		late.open();
		await flush();
		expect(s.acts[0]?.ran).toBe(false);
		expect(p.holding).toBe(true);
		// What is typed now goes under seat 2, and runs; the heartbeats named seat 1, then seat 2.
		key(canvas(p), "Tab");
		await flush();
		expect(s.acts.map((act) => [act.epoch, act.seat, act.ran])).toEqual([
			[0, 1, false],
			[0, 2, true],
		]);
		await advance(KEEP_EVERY_MS);
		expect(keeps(s).map((call) => [call.body.p_epoch, call.body.p_seat])).toEqual([
			[0, 1],
			[0, 2],
		]);
		expect(p.holding).toBe(true);
	});

	it("lets go of a hold another tab of the member's took over at the same epoch: this tab's heartbeat and its input name its seat and are refused, and closing this tab ends nothing of the other's (r18 F26)", async () => {
		const { s, panels, p } = await company();
		s.state.actAsDatabase = true;
		await takeOver(p);
		// Another tab of the member's takes the desktop over: their own live lease, the same epoch, a new seat.
		s.state.machines = [machine(1, { control: held(0, 2) })];
		s.state.seats.set(machine(1).machineId, 2);
		// Just before this tab's heartbeat, A goes under seat 1 (it reaches the database only later); B waits behind it.
		await advance(KEEP_EVERY_MS - 5000);
		const late = gate();
		s.state.actAnswers.push({ hold: late.closed, exitCode: 0 });
		key(canvas(p), "Enter");
		key(canvas(p), "Tab");
		await flush();
		expect(s.acts.map((act) => act.seat)).toEqual([1]);
		// This tab's heartbeat names seat 1: ended, renewing nothing; the window lets go, so B never leaves the page.
		await advance(5000);
		expect(keeps(s).map((call) => [call.body.p_epoch, call.body.p_seat])).toEqual([[0, 1]]);
		expect(p.holding).toBe(false);
		// A arrives now, naming seat 1: refused.
		late.open();
		await flush();
		expect(s.acts.map((act) => [act.seat, act.ran])).toEqual([[1, false]]);
		// The window shows the other tab's hold as the member's in another window: no input, no heartbeat.
		expect(controls(p)?.textContent).toContain("You are typing privately in another window.");
		key(canvas(p), "End");
		await advance(KEEP_EVERY_MS * 2);
		expect(s.acts).toHaveLength(1);
		expect(keeps(s)).toHaveLength(1);
		// This (stale) tab's window closes: every take-over of its was answered, and the seat its own got ended (the
		// heartbeat said so), so nothing is owed and nothing is sent; the other tab's hold lives on at the same epoch.
		panels.close(staff.id);
		await flush();
		expect(handBacks(s)).toEqual([]);
		expect(s.state.machines[0]?.control?.seat).toBe(2);
		expect(s.state.epochs.get(machine(1).machineId) ?? 0).toBe(0);
	});

	it("voids a take-over still on its way when its window closes while another tab holds at that epoch: the other hold ends, the late take-over is refused, nothing outlives the window (r19 F27)", async () => {
		const { s, panels, p } = await company();
		// This window's take-over at epoch 0 is on its way, held up.
		const late = gate();
		s.state.takeGate = late.closed;
		await takeOver(p);
		expect(takeEpochs(s)).toEqual([0]);
		// Another tab of the member's is seated at epoch 0 meanwhile.
		s.state.machines = [machine(1, { control: held(0, 2) })];
		s.state.seats.set(machine(1).machineId, 2);
		// The window closes: its take-over has no answer, so its hand-back is VOID: the epoch moves on and the member's
		// hold under 0 ends, whichever seat (the other tab's: it hears so at its next heartbeat or action).
		panels.close(staff.id);
		await flush();
		expect(handBacks(s).map((call) => [call.body.p_epoch, call.body.p_seat])).toEqual([[0, null]]);
		expect(s.state.machines[0]?.control).toBeNull();
		expect(s.state.epochs.get(machine(1).machineId)).toBe(1);
		// The take-over arrives now: refused at the old epoch, and nothing of the member's is live.
		late.open();
		await flush();
		expect(s.state.machines[0]?.control).toBeNull();
		expect(handBacks(s)).toHaveLength(1);
		// The page owes nothing more: I'm done answers at once.
		expect(await panels.releaseAgent(staff.id)).toBe(true);
	});

	it.each(["close", "switch", "leave"] as const)(
		"voids a take-over whose answer was lost before the next press goes, and leaves nothing held after a %s (r19 F28)",
		async (release) => {
			const { s, panels, p } = await company(setup({ machines: [machine(1), machine(2)] }));
			// Take-over A reaches the database and holds (seat 1), but its answer is lost.
			s.state.takeLost = "committed";
			await takeOver(p);
			expect(p.holding).toBe(false);
			expect(s.state.machines[0]?.control?.seat).toBe(1);
			// The next press: VOID at A's epoch goes first and is answered (A's hold ends, the epoch moves), and only then
			// take-over B, at the new epoch.
			await takeOver(p);
			const order = s.rpcs
				.filter((call) => call.method !== "qorpera_list_agent_machines")
				.map((call) => [call.method.replace("qorpera_member_", ""), call.body.p_epoch, call.body.p_seat ?? null]);
			expect(order.slice(0, 3)).toEqual([
				["take_machine_desktop", 0, null],
				["hand_back_machine_desktop", 0, null],
				["take_machine_desktop", 1, null],
			]);
			expect(p.holding).toBe(true);
			expect(s.state.machines[0]?.control?.seat).toBe(3);
			// The release: EXACT by B's seat (every take-over answered); nothing stays held.
			if (release === "close") panels.close(staff.id);
			else if (release === "leave") s.stop.abort();
			else {
				s.state.answers.push({ picture: 2 });
				p.el.querySelector<HTMLButtonElement>(":scope > .computer-switcher")!.click();
				[...openMenu()!.el.querySelectorAll<HTMLElement>("[role^=menuitem]")][1]!.click();
			}
			await flush();
			expect(handBacks(s).map((call) => [call.body.p_epoch, call.body.p_seat])).toEqual([
				[0, null],
				[1, 3],
			]);
			expect(s.state.machines[0]?.control).toBeNull();
		},
	);

	it.each(["close", "switch", "leave"] as const)(
		"voids again when the take-over after a lost answer fails unsent, and leaves nothing held after a %s (r19 F28)",
		async (release) => {
			const { s, panels, p } = await company(setup({ machines: [machine(1), machine(2)] }));
			s.state.takeLost = "committed";
			await takeOver(p);
			expect(s.state.machines[0]?.control?.seat).toBe(1);
			// The next press: VOID at 0 first, then take-over B at 1, which never reaches the database (its answer is lost).
			s.state.takeLost = "late";
			await takeOver(p);
			expect(takeEpochs(s)).toEqual([0, 1]);
			expect(s.state.machines[0]?.control).toBeNull();
			expect(p.holding).toBe(false);
			// The release: B has no answer, so VOID at 1.
			if (release === "close") panels.close(staff.id);
			else if (release === "leave") s.stop.abort();
			else {
				s.state.answers.push({ picture: 2 });
				p.el.querySelector<HTMLButtonElement>(":scope > .computer-switcher")!.click();
				[...openMenu()!.el.querySelectorAll<HTMLElement>("[role^=menuitem]")][1]!.click();
			}
			await flush();
			expect(handBacks(s).map((call) => [call.body.p_epoch, call.body.p_seat])).toEqual([
				[0, null],
				[1, null],
			]);
			expect(s.state.epochs.get(machine(1).machineId)).toBe(2);
			// B reaches the database only now: refused at the old epoch; nothing of the member's is live.
			expect(s.state.lateCommit?.()).toBe(false);
			expect(s.state.machines[0]?.control).toBeNull();
		},
	);

	it("names the seat the list gave on the window's Hand back of a hold in another window, and ends it (r18 F26)", async () => {
		const { s, p } = await company();
		await takeOver(p);
		// Another tab takes it over (seat 2); this tab's heartbeat hears it ended.
		s.state.machines = [machine(1, { control: held(0, 2) })];
		s.state.seats.set(machine(1).machineId, 2);
		await advance(KEEP_EVERY_MS);
		expect(p.holding).toBe(false);
		expect(controls(p)?.textContent).toContain("You are typing privately in another window.");
		// Hand back on that hold: by seat 2, so it ends and the epoch moves on.
		handBackButton(p)!.click();
		await flush();
		expect(handBacks(s).map((call) => [call.body.p_epoch, call.body.p_seat])).toEqual([[0, 2]]);
		expect(s.state.machines[0]?.control).toBeNull();
		expect(s.state.epochs.get(machine(1).machineId)).toBe(1);
	});

	it("says nothing of a take-over queued behind a hand-back that pagehide called off, when that hand-back then fails (r14 F22)", async () => {
		const { s, p } = await company();
		await takeOver(p);
		expect(p.holding).toBe(true);
		// Hand back: its hand-back waits. The agent's card asks for a take-over meanwhile: queued behind it.
		const back = gate();
		s.state.handBackGate = back.closed;
		void p.handBack();
		await flush();
		p.takeOver();
		await flush();
		expect(takeEpochs(s)).toEqual([0]);
		// The page is hidden (calling the queued take-over off); then the hand-backs fail.
		window.dispatchEvent(new Event("pagehide"));
		await flush();
		s.state.handBackFails = 20;
		s.state.handBackGate = undefined;
		back.open();
		await flush();
		await advance(2000);
		// Nothing was sent and nothing is said of that take-over.
		expect(takeEpochs(s)).toEqual([0]);
		expect(p.holding).toBe(false);
		expect(controls(p)?.textContent ?? "").not.toContain("could not start");
	});

	it("takes nothing over after pagehide for a press made before it, when the same window goes on: no take-over, no heartbeat, Take over offered (r13 F20)", async () => {
		const { s, p } = await company();
		// Take over, sent at 0; its answer is delayed.
		const late = gate();
		s.state.takeGate = late.closed;
		await takeOver(p);
		expect(takeEpochs(s)).toEqual([0]);
		s.state.takeGate = undefined;
		// The page is put in the browser's cache: the hand-back at 0 goes (with the keepalive one) and is answered.
		window.dispatchEvent(new Event("pagehide"));
		await flush();
		expect(backEpochs(s)).toEqual([0, 0]);
		// The page comes back and the same window goes on (its loop runs, a list read, looks) before the take-over answers:
		// nothing is taken over again.
		s.hint("machines");
		await advance(LOOK_EVERY_MS);
		await advance(MACHINES_EVERY_MS);
		expect(takeEpochs(s)).toEqual([0]);
		// The take-over sent before arrives at last: refused; nothing held, no heartbeat, nothing said; Take over offered.
		late.open();
		await flush();
		await advance(KEEP_EVERY_MS * 2);
		expect(takeEpochs(s)).toEqual([0]);
		expect(p.holding).toBe(false);
		expect(keeps(s)).toHaveLength(0);
		expect(s.state.machines[0]?.control).toBeNull();
		expect(controlButton(p)?.textContent).toBe("Type privately");
		expect(controlButton(p)?.disabled).toBe(false);
		// Only a new press takes it over, at the epoch the hand-back answered.
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

	it("voids a lost take-over before the next press goes, so a later refusal changes nothing and the late one is refused (r6 F12, r19 R2)", async () => {
		const { s, panels, p } = await company();
		// Take-over A: its answer is lost, and it reaches the database only later.
		s.state.takeLost = "late";
		await takeOver(p);
		expect(p.holding).toBe(false);
		// Another member takes the desktop; the member presses again: VOID at A's epoch first, then take-over B at the
		// epoch it answered, refused for the other member's hold.
		s.state.machines = [
			machine(1, { control: { mine: false, name: "Ada", until: until(), epoch: null, seat: null, press: null } }),
		];
		s.state.take = { state: "refused", reason: "DESKTOP_MEMBER_IN_CONTROL", memberName: "Ada" };
		p.takeOver();
		await flush();
		expect(backEpochs(s)).toEqual([0]);
		expect(takeEpochs(s)).toEqual([0, 1]);
		// I'm done: nothing is owed any more (A was voided, B answered), so it answers with no more hand-backs.
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
		// Another tab moved the epoch on before the press: VOID at the old epoch changes nothing and names the new one, and
		// take-over B holds there; I'm done gives it back by its seat.
		["called off at a newer epoch", undefined, false],
	] as const)(
		"voids a lost take-over before the next press goes, whatever that press's answer says: %s (r6 F12, r19 R2)",
		async (_name, refusal, refused) => {
			const { s, panels, p } = await company();
			s.state.takeLost = "late";
			await takeOver(p);
			if (refusal) s.state.take = { ...refusal };
			else s.state.epochs.set(machine(1).machineId, 1);
			p.takeOver();
			await flush();
			expect(backEpochs(s)).toEqual([0]);
			expect(takeEpochs(s)).toEqual([0, 1]);
			expect(await panels.releaseAgent(staff.id)).toBe(true);
			expect(backEpochs(s)).toEqual(refused ? [0] : [0, 1]);
			// Either way the take-over sent first can never hold the desktop now.
			s.state.take = { state: "ok", until: "2026-11-10T20:00:00.000Z" };
			expect(s.state.lateCommit?.()).toBe(false);
			expect(s.state.machines[0]?.control).toBeNull();
		},
	);

	it("owes nothing of a hold whose heartbeat said it ended, its take-over answered: I'm done answers with no hand-back (r6, r19 R5)", async () => {
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
		// That seat is gone for good, and nothing of this page's is on its way: nothing is owed, nothing is sent.
		expect(await panels.releaseAgent(staff.id)).toBe(true);
		expect(backEpochs(s)).toEqual([]);
	});

	it("still voids on I'm done when the lease ended by itself but a later take-over's answer was lost (r6, r19 R5)", async () => {
		const { s, panels, p } = await company();
		await takeOver(p);
		s.state.keep = { state: "ended" };
		s.state.machines = [machine(1)];
		await advance(KEEP_EVERY_MS);
		expect(p.holding).toBe(false);
		// The member presses again; its answer is lost and it reaches the database only later.
		s.state.takeLost = "late";
		await takeOver(p);
		expect(takeEpochs(s)).toEqual([0, 0]);
		expect(await panels.releaseAgent(staff.id)).toBe(true);
		expect(handBacks(s).map((call) => [call.body.p_epoch, call.body.p_seat])).toEqual([[0, null]]);
		expect(s.state.lateCommit?.()).toBe(false);
		expect(s.state.machines[0]?.control).toBeNull();
	});

	it.each([
		["the window closes", false],
		["the window switches to another machine", true],
	] as const)(
		"keeps owing a hold an answer named at a newer epoch across a release that cannot clear it, when %s (r7 F13)",
		async (_name, switching) => {
			const { s, panels, p } = await company(setup({ machines: [machine(1), machine(2)] }));
			await takeOver(p);
			expect(p.holding).toBe(true);
			// I'm done gives the machine back at its epoch; the hand-back waits.
			const back = gate();
			s.state.handBackGates = [back.closed];
			let done: boolean | undefined;
			const answered = panels.releaseAgent(staff.id).then((value) => {
				done = value;
			});
			await flush();
			expect(backEpochs(s)).toEqual([0]);
			// Another tab of the member's hands it back and takes it again at epoch 1; then the page's hand-back is answered:
			// nothing changed, and the member holds it now, at epoch 1.
			s.state.epochs.set(machine(1).machineId, 1);
			s.state.machines = [machine(1, { control: held(1) }), machine(2)];
			const read = gate();
			s.state.listHold = read.closed;
			back.open();
			await flush();
			// The window closes, or switches to the other machine, while I'm done reads the list: neither erases what that
			// answer said.
			if (switching) {
				s.state.answers.push({ picture: 2 });
				p.el.querySelector<HTMLButtonElement>(":scope > .computer-switcher")!.click();
				[...openMenu()!.el.querySelectorAll<HTMLElement>("[role^=menuitem]")][1]!.click();
			} else panels.close(staff.id);
			await flush();
			expect(done).toBeUndefined();
			read.open();
			await answered;
			expect(done).toBe(true);
			expect(backEpochs(s)).toEqual([0, 1]);
			expect(s.state.machines[0]?.control).toBeNull();
		},
	);

	it("finishes I'm done only on a read after its hand-backs were answered: a hold another tab took at the new epoch is handed back (r8 F15)", async () => {
		const { s, panels, p } = await company();
		await takeOver(p);
		expect(p.holding).toBe(true);
		// The window's list read and I'm done's hand-back start together; the database gives the desktop back (epoch 1,
		// nothing held) but that answer is delivered later.
		const read = gate(),
			delivered = gate();
		s.state.listGate = read.closed;
		s.hint("machines");
		await flush();
		s.state.handBackAnswerGates = [delivered.closed];
		let done: boolean | undefined;
		const answered = panels.releaseAgent(staff.id).then((value) => {
			done = value;
		});
		await flush();
		expect(backEpochs(s)).toEqual([0]);
		expect(s.state.epochs.get(machine(1).machineId)).toBe(1);
		// Another tab takes it at epoch 1. The hand-back's answer comes first, then the window's list (which shows that hold).
		s.state.machines = [machine(1, { control: held(1) })];
		delivered.open();
		await flush();
		read.open();
		await answered;
		// I'm done handed that hold back at epoch 1, and answered only after a later read showed nothing.
		expect(done).toBe(true);
		expect(backEpochs(s)).toEqual([0, 1]);
		expect(s.state.machines[0]?.control).toBeNull();
	});

	it("certifies I'm done by no stale read: an empty read below the epoch the page knows counts for nothing, and a hold a window saw is owed (r9 F16)", async () => {
		const { s, panels, p } = await company();
		await takeOver(p);
		expect(p.holding).toBe(true);
		// The window closes: its hand-back at 0 is answered (epoch 1).
		panels.close(staff.id);
		await flush();
		expect(backEpochs(s)).toEqual([0]);
		expect(s.state.epochs.get(machine(1).machineId)).toBe(1);
		// I'm done: its read is captured now, empty at epoch 1, and held back.
		const stale = gate();
		s.state.listSnapshotGates = [stale.closed];
		let done: boolean | undefined;
		const answered = panels.releaseAgent(staff.id).then((value) => {
			done = value;
		});
		await flush();
		// Another tab moves the epoch to 2 and takes the desktop. A window, opened again, lists that hold first: it may not
		// take it up (this page gave the machine back), but it is owed.
		s.state.epochs.set(machine(1).machineId, 2);
		s.state.machines = [machine(1, { control: held(2) })];
		s.state.answers.push({ picture: 1 });
		const again = panels.open(staff)!;
		again.attach(document.body, () => panels.close(staff.id));
		await flush();
		expect(again.holding).toBe(false);
		expect(done).toBeUndefined();
		// The stale empty read arrives: it counts for nothing. I'm done hands back at 2, and answers after a read that
		// counts shows nothing.
		stale.open();
		await answered;
		expect(done).toBe(true);
		expect(backEpochs(s)).toEqual([0, 2]);
		expect(s.state.machines[0]?.control).toBeNull();
	});

	it("discharges nothing on an answer at the same epoch: a hold seen at 1 stays owed after a hand-back answers 1, not held (r10 F17)", async () => {
		const { s, panels, p } = await company();
		expect(p.holding).toBe(false);
		// The page knows epoch 0; the database is at 1 (another tab gave it back), and nothing is held.
		s.state.epochs.set(machine(1).machineId, 1);
		// I'm done: its read is captured empty at epoch 1, and held back.
		const read = gate();
		s.state.listSnapshotGates = [read.closed];
		let done: boolean | undefined;
		const answered = panels.releaseAgent(staff.id).then((value) => {
			done = value;
		});
		await flush();
		// A take-over at 0 is sent, and its answer lost.
		s.state.takeLost = "late";
		p.takeOver();
		await flush();
		expect(takeEpochs(s)).toEqual([0]);
		// The window closes: the hand-back at 0 finds epoch 1, nothing held; its answer is held back.
		const back = gate();
		s.state.handBackAnswerGates = [back.closed];
		panels.close(staff.id);
		await flush();
		expect(backEpochs(s)).toEqual([0]);
		// Another tab takes at epoch 1. The window, opened again, lists that hold (owed: the machine was given back); it
		// closes again.
		s.state.machines = [machine(1, { control: held(1) })];
		s.state.answers.push({ picture: 1 });
		const again = panels.open(staff)!;
		again.attach(document.body, () => panels.close(staff.id));
		await flush();
		expect(again.holding).toBe(false);
		panels.close(staff.id);
		await flush();
		// The hand-back's answer (epoch 1, nothing held) and then the empty read at epoch 1 arrive: neither discharges the
		// hold seen at 1. I'm done hands it back at 1 and answers after that.
		back.open();
		await flush();
		read.open();
		await answered;
		expect(done).toBe(true);
		expect(backEpochs(s)).toEqual([0, 1]);
		expect(s.state.machines[0]?.control).toBeNull();
		// The take-over sent at 0 reaches the database now: refused.
		expect(s.state.lateCommit?.()).toBe(false);
	});

	it("tells the member when another tab's hand-back overtook their take-over, reads the list again, and sends the next press at the new epoch (r11 F18)", async () => {
		const { s, p } = await company();
		expect(controls(p)?.textContent ?? "").not.toContain("could not start");
		// Take over, sent at 0; before it reaches the database another tab gives the desktop back (epoch 0 to 1).
		const late = gate();
		s.state.takeGate = late.closed;
		p.takeOver();
		await flush();
		expect(takeEpochs(s)).toEqual([0]);
		s.state.takeGate = undefined;
		s.state.epochs.set(machine(1).machineId, 1);
		const read = lists(s);
		late.open();
		await flush();
		// Refused (TAKE_CALLED_OFF, epoch 1): the member is told, and the list is read again.
		expect(p.holding).toBe(false);
		expect(controls(p)?.textContent).toContain("Private typing could not start. Try again.");
		expect(lists(s)).toBeGreaterThan(read);
		// No take-over on its own; the member's next press goes out at the epoch the refusal named, and holds.
		expect(takeEpochs(s)).toEqual([0]);
		await takeOver(p);
		expect(takeEpochs(s)).toEqual([0, 1]);
		expect(p.holding).toBe(true);
	});

	it("takes the machine chosen now over when the card asks while the window's older take-over, called off by a switch, is still on its way; that one's answer touches nothing (r12 F19)", async () => {
		const { s, p } = await company(setup({ machines: [machine(1), machine(2)] }));
		const pick = (n: number) => {
			p.el.querySelector<HTMLButtonElement>(":scope > .computer-switcher")!.click();
			[...openMenu()!.el.querySelectorAll<HTMLElement>("[role^=menuitem]")][n]!.click();
		};
		const taken = () => calls(s, "qorpera_member_take_machine_desktop").map((call) => call.body.p_machine_id);
		// Take over the first machine; its answer is delayed.
		const late = gate();
		s.state.takeGate = late.closed;
		await takeOver(p);
		expect(taken()).toEqual([machine(1).machineId]);
		s.state.takeGate = undefined;
		// The member switches to the second machine (the first one's take-over is called off: its hand-back goes).
		s.state.answers.push({ picture: 2 });
		pick(1);
		await flush();
		expect(handBacks(s).map((call) => [call.body.p_machine_id, call.body.p_epoch])).toEqual([
			[machine(1).machineId, 0],
		]);
		// The same window's button offers Take over for the second machine; the agent's card asks before the first answers.
		expect(controlButton(p)?.disabled).toBe(false);
		p.takeOver();
		await flush();
		expect(taken()).toEqual([machine(1).machineId, machine(2).machineId]);
		expect(p.holding).toBe(true);
		// The first machine's take-over answers at last (refused: its hand-back came first). The window's hold of the
		// second stays, renewed, and nothing is said.
		late.open();
		await flush();
		expect(p.holding).toBe(true);
		expect(controls(p)?.textContent ?? "").not.toContain("could not start");
		await advance(KEEP_EVERY_MS);
		expect(keeps(s).map((call) => call.body.p_machine_id)).toContain(machine(2).machineId);
		expect(s.state.machines[0]?.control).toBeNull();
	});

	it("starts a new take-over on a press after a release called the one on its way off, and says nothing of that one (r11)", async () => {
		const { s, panels, p } = await company();
		// A take-over at 0 on its way.
		const late = gate();
		s.state.takeGate = late.closed;
		p.takeOver();
		await flush();
		expect(takeEpochs(s)).toEqual([0]);
		s.state.takeGate = undefined;
		// The window closes (it calls that take-over off); its hand-back at 0 fails, to be asked again after a wait.
		s.state.handBackFails = 1;
		panels.close(staff.id);
		await flush();
		expect(backEpochs(s)).toEqual([0]);
		// Opened again, the agent's take-over card asks for a take-over (the window's own button says Try again until the
		// hand-back is answered): a new take-over, which asks the hand-back again first and goes out at the epoch it
		// answers (never joined to the one called off).
		s.state.answers.push({ picture: 1 });
		const again = panels.open(staff)!;
		again.attach(document.body, () => panels.close(staff.id));
		await flush();
		again.takeOver();
		await flush();
		expect(backEpochs(s)).toEqual([0, 0]);
		expect(takeEpochs(s)).toEqual([0, 1]);
		expect(again.holding).toBe(true);
		// The take-over called off arrives at last: refused at 0, said to no one; the new hold stands.
		late.open();
		await flush();
		expect(again.holding).toBe(true);
		expect(controls(again)?.textContent ?? "").not.toContain("could not start");
	});

	it("lets a list with a lower epoch than the page knows end and take up nothing (r8 F15)", async () => {
		const { s, p } = await company();
		// A read of the window's is captured while another tab holds the desktop at epoch 0, and delayed.
		s.state.machines = [machine(1, { control: held(0) })];
		const stale = gate();
		s.state.listSnapshotGate = stale.closed;
		s.hint("machines");
		await flush();
		// That tab gives it back (epoch 1). The member's Take over, sent at 0, is refused with epoch 1.
		s.state.epochs.set(machine(1).machineId, 1);
		s.state.machines = [machine(1)];
		p.takeOver();
		await flush();
		expect(takeEpochs(s)).toEqual([0]);
		expect(p.holding).toBe(false);
		// The old read arrives: its epoch is below what the page knows; nothing is taken up.
		stale.open();
		await flush();
		expect(p.holding).toBe(false);
		// Taken over at the epoch the refusal named, held; a read with a lower epoch ends nothing.
		await takeOver(p);
		expect(takeEpochs(s)).toEqual([0, 1]);
		expect(p.holding).toBe(true);
		s.state.machines = [machine(1)];
		s.state.epochs.set(machine(1).machineId, 0);
		s.hint("machines");
		await advance(LOOK_EVERY_MS);
		expect(p.holding).toBe(true);
	});

	it("says no on I'm done while each answer names a newer epoch still held, a few rounds, and keeps the card open (r7 F13)", async () => {
		const { s, panels } = await company();
		panels.close(staff.id);
		await flush();
		// Another tab holds it, and takes it again after every hand-back.
		s.state.epochs.set(machine(1).machineId, 1);
		s.state.machines = [machine(1, { control: held(1) })];
		const retake = () => {
			const next = (s.state.epochs.get(machine(1).machineId) ?? 0) + 1;
			s.state.epochs.set(machine(1).machineId, next);
			s.state.machines = [machine(1, { control: held(next) })];
		};
		const gates = Array.from({ length: 8 }, () => gate());
		s.state.handBackGates = gates.map((one) => one.closed);
		let done: boolean | undefined;
		const answered = panels.releaseAgent(staff.id).then((value) => {
			done = value;
		});
		for (const one of gates) {
			await flush();
			if (done !== undefined) break;
			retake();
			one.open();
		}
		await answered;
		expect(done).toBe(false);
		expect(backEpochs(s).length).toBeGreaterThan(1);
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
			p_seat: 1,
		});
	});
});

/**
 * A member's start of a desktop, explored (20260930714000): random schedules on one page and the next of presses of the
 * window's own button, switches, closes, screens going off and coming on by the agent, machines sleeping and waking,
 * hints and time, with the starts' answers (started, running, too soon, too small, failed, not running) held back a few
 * steps or given at once. When a start leaves the page:
 * (S1) it follows a press on that page for that machine (Turn it on, Try again or Wake it) that no switch away from it,
 *      no picture of it shown, and no 3 minutes followed;
 * (S2) no other start of that page is on its way.
 * A failure prints the seed and its steps.
 */
async function exploreStarts(seed: number): Promise<{ log: string[]; broken?: string }> {
	let a = seed >>> 0;
	const random = () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const pick = <T>(values: readonly T[]) => values[Math.floor(random() * values.length)] as T;
	const ids = [machine(1).machineId, machine(2).machineId] as const;
	const s = setup({ machines: [machine(1), machine(2, { state: random() < 0.5 ? "stopped" : "running" })] });
	const screens = new Map<string, "off" | number>([
		[ids[0], "off"],
		[ids[1], "off"],
	]);
	s.state.screens = screens;
	const log: string[] = [];
	const violations: string[] = [];
	let step = 0;
	let tick = 0;
	let page = 0;
	/** Presses that may start a desktop, and per machine the last switch away from it or picture of it (ticks). */
	const presses: { page: number; machine: string; tick: number; at: number }[] = [];
	const ended = new Map<string, number>();
	const onTheWay: { page: number; signal: AbortSignal | undefined }[] = [];
	const heldBack: { due: number; resolve: () => void }[] = [];
	const running = (machineId: string) =>
		s.state.machines.find((one) => one.machineId === machineId)?.state === "running";
	s.state.startHook = async (machineId, signal) => {
		const mine = page;
		if (
			!presses.some(
				(one) =>
					one.page === mine &&
					one.machine === machineId &&
					one.tick > (ended.get(machineId) ?? -1) &&
					Date.now() - one.at < WANT_ON_MS,
			)
		)
			violations.push(
				`S1: a start of ${machineId.slice(-2)} left page ${mine} at step ${step} with no press for it standing`,
			);
		if (onTheWay.some((one) => one.page === mine && !one.signal?.aborted))
			violations.push(`S2: a second start of page ${mine} left at step ${step}`);
		const entry = { page: mine, signal };
		onTheWay.push(entry);
		const outcome = pick([
			"started",
			"started",
			"running",
			"TOO_SOON",
			"TOO_SMALL",
			"DID_NOT_START",
			"lost",
		] as const);
		log.push(`${step}: a start of ${machineId.slice(-2)} leaves page ${mine} (${outcome})`);
		if (random() < 0.5)
			await new Promise<void>((resolve) => heldBack.push({ due: step + 1 + Math.floor(random() * 4), resolve }));
		onTheWay.splice(onTheWay.indexOf(entry), 1);
		if (!running(machineId)) return Response.json({ code: "MACHINE_NOT_RUNNING" }, { status: 409 });
		if (outcome === "lost") throw new TypeError("Failed to fetch");
		if (outcome === "started" || outcome === "running") {
			if (screens.get(machineId) === "off") screens.set(machineId, ids.indexOf(machineId) + 1);
			return Response.json({ schema: "qorpera.member-machine-start/v1", outcome });
		}
		const code = {
			TOO_SOON: "DESKTOP_START_TOO_SOON",
			TOO_SMALL: "DESKTOP_MACHINE_TOO_SMALL",
			DID_NOT_START: "DESKTOP_DID_NOT_START",
		}[outcome];
		return Response.json({ code }, { status: 409 });
	};
	let p = panel(s);
	await flush();
	const shown = () => {
		const name = p.el.querySelector(":scope > .computer-switcher .computer-switcher-name")?.textContent;
		return name === "desk-1" ? ids[0] : name === "desk-2" ? ids[1] : undefined;
	};
	const loading = () => p.el.querySelector<HTMLElement>(".computer-loading")!;
	for (step = 1; step <= 60; step++) {
		const kind = pick([
			"press",
			"press",
			"press",
			"switch",
			"close",
			"screen off",
			"agent on",
			"sleeps",
			"wakes",
			"hint",
			"time",
			"time",
		] as const);
		if (kind === "press") {
			const button = action(p);
			const state = loading().dataset.state ?? "";
			const machineId = shown();
			if (!button || loading().hidden) continue;
			if (machineId && (state === "off" || state === "startFailed" || state === "asleep"))
				presses.push({ page, machine: machineId, tick: ++tick, at: Date.now() });
			log.push(`${step}: the window's ${button.textContent} (${state}, ${machineId?.slice(-2)})`);
			button.click();
		} else if (kind === "switch") {
			const machineId = shown();
			const switcher = p.el.querySelector<HTMLButtonElement>(":scope > .computer-switcher");
			if (!machineId || !switcher || switcher.hidden) continue;
			switcher.click();
			const other = ids[0] === machineId ? 1 : 0;
			ended.set(machineId, ++tick);
			[...openMenu()!.el.querySelectorAll<HTMLElement>("[role^=menuitem]")][other]!.click();
			log.push(`${step}: switch from ${machineId.slice(-2)}`);
		} else if (kind === "close") {
			p.dispose();
			page++;
			p = panel(s);
			log.push(`${step}: close, and open page ${page}`);
		} else if (kind === "screen off" || kind === "agent on") {
			const machineId = pick(ids);
			if (!running(machineId)) continue;
			screens.set(machineId, kind === "screen off" ? "off" : ids.indexOf(machineId) + 1);
			log.push(
				`${step}: ${machineId.slice(-2)}'s screen ${kind === "screen off" ? "goes off" : "is turned on by the agent"}`,
			);
		} else if (kind === "sleeps" || kind === "wakes") {
			const machineId = pick(ids);
			s.state.machines = s.state.machines.map((one) =>
				one.machineId === machineId
					? { ...one, state: (kind === "sleeps" ? "stopped" : "running") as MemberAgentMachine["state"] }
					: one,
			);
			screens.set(machineId, "off");
			log.push(`${step}: ${machineId.slice(-2)} ${kind}`);
		} else if (kind === "hint") s.hint("machines");
		else
			await vi.advanceTimersByTimeAsync(
				pick([LOOK_EVERY_MS, START_AGAIN_MS, SCREEN_OFF_EVERY_MS, MACHINES_EVERY_MS, 60_000, WANT_ON_MS]),
			);
		for (const one of heldBack.filter((entry) => entry.due <= step)) {
			heldBack.splice(heldBack.indexOf(one), 1);
			one.resolve();
		}
		await flush();
		// A picture of the machine shown: the wish for it is met.
		const machineId = shown();
		if (machineId && mark(p) === "Live") ended.set(machineId, ++tick);
		if (violations.length) return { log, broken: violations[0] };
	}
	for (const one of heldBack.splice(0)) one.resolve();
	await advance(MACHINES_EVERY_MS);
	p.dispose();
	return { log, ...(violations.length ? { broken: violations[0] } : {}) };
}

describe("a member's start of a desktop, explored (20260930714000)", () => {
	// 80 seeds take about 5 s on the loaded test machine (12 Nov 2026, master and this branch alike), at vitest's default.
	it("sends a start only after a press on the page for that machine, until its picture, a switch away or 3 minutes, one at a time", async () => {
		for (let seed = 1; seed <= 80; seed++) {
			const { log, broken } = await exploreStarts(seed);
			if (broken) throw new Error(`seed ${seed}: ${broken}\n${log.join("\n")}`);
			for (const close of cleanup.splice(0)) close();
		}
	}, 30_000);
});
