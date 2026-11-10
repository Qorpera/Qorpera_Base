// @vitest-environment jsdom
import type { MemberAgentMachine } from "@qorpera/cloud-client/cloud-member-company-computer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ComputerPanel,
	ComputerPanels,
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
import { fixture, id, profileA, settle, staff, userA, userB } from "./fixtures.ts";

/* An agent's computer window (migration 20260930712000; lanes/desktop-computers-20261110/LIVE-VIEW-PLAN.md, stage 1a):
 * the agent's machines, a picture of the chosen desktop about once a second through the member bridge, and every state
 * the window says in words. */

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
		...change,
	};
}
/** One look's answer from the bridge: a picture (its etag), the member's own picture again, or a refusal's code. */
type Answer = { picture: number } | "unchanged" | { code: string } | { status: number };

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

function setup(options: { machines?: MemberAgentMachine[]; canWake?: boolean; role?: typeof profileA.role } = {}) {
	const f = fixture(),
		stop = new AbortController();
	Object.assign(f.cloud.config, { objectGatewayUrl: gateway, memberCompanyGatewayUrl: bridge });
	const state = {
		machines: options.machines ?? [machine(1)],
		canWake: options.canWake ?? true,
		answers: [] as Answer[],
		/** What a look answers once the queue is empty. */
		fallback: "unchanged" as Answer,
		listFails: 0,
	};
	const looks: { url: string; etag: string | null }[] = [];
	const rpcs: { method: string; body: Record<string, unknown> }[] = [];
	const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		expect(init?.redirect).toBe("error");
		const headers = new Headers(init?.headers);
		expect(headers.get("authorization")).toBe("Bearer fixture-token");
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
			if (state.listFails > 0) {
				state.listFails--;
				return new Response("{}", { status: 503 });
			}
			return Response.json({
				schema: "qorpera.agent-machines/v1",
				profileId: profileA.profileId,
				staffAgentId: staff.id,
				canWake: state.canWake,
				machines: state.machines,
			});
		}
		if (method === "qorpera_member_manage_company_machine")
			return Response.json({ machineId: body.p_machine_id, state: "waiting" });
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
		rpcs,
		hints,
		decode,
		hint: (resource: RealtimeResource) => hint?.(resource),
	};
}
type Setup = ReturnType<typeof setup>;
function panel(s: Setup, attach = true) {
	const value = new ComputerPanel(staff, s.computer, undefined, { hints: s.hints, decode: s.decode });
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
		// No take-over in this stage.
		expect(p.el.textContent).not.toMatch(/Take over|Take control/);
		expect(p.el.querySelector(".screen-viewer-takeover")).toBeNull();
	});

	it("slows to 2 s after three unchanged pictures and 3 s after ten; a change, a click or a machines hint brings back 1 s", async () => {
		const s = setup();
		s.state.answers.push({ picture: 1 });
		const p = panel(s);
		await flush();
		const gaps = async (count: number) => {
			const found: number[] = [];
			for (let n = 0; n < count; n++) {
				const before = s.looks.length;
				let waited = 0;
				while (s.looks.length === before && waited < 10_000) {
					await advance(250);
					waited += 250;
				}
				found.push(waited);
			}
			return found;
		};
		// Looks 2-4 come a second apart (each answers unchanged); after the third unchanged, every 2 s.
		expect(await gaps(3)).toEqual([1000, 1000, 1000]);
		expect(await gaps(7)).toEqual([2000, 2000, 2000, 2000, 2000, 2000, 2000]);
		expect(await gaps(2)).toEqual([3000, 3000]);
		// A click in the window: the next look within a second of the last.
		p.el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
		await flush();
		expect((await gaps(1))[0]).toBeLessThanOrEqual(1000);
		expect(await gaps(3)).toEqual([1000, 1000, 2000]);
		// A machines hint: the list read again at once, and looks every second.
		const listed = lists(s);
		s.hint("machines");
		await flush();
		expect(lists(s)).toBe(listed + 1);
		expect(await gaps(2)).toEqual([1000, 1000]);
		// Another resource's hint is not the window's.
		s.hint("sessions");
		await flush();
		expect(lists(s)).toBe(listed + 1);
		// A changed picture: every second again.
		s.state.answers.push("unchanged", "unchanged", "unchanged", { picture: 2 });
		await gaps(4);
		expect(await gaps(2)).toEqual([1000, 1000]);
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
		expect(s.looks.slice(before).map((look) => look.url.endsWith("/watching"))).toEqual([true, false, false]);
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
		const p = new ComputerPanel(staff, s.computer, undefined, { hints: s.hints, decode: s.decode });
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
