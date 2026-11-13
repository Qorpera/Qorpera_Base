// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MemberAgentMachine } from "@qorpera/cloud-client/cloud-member-company-computer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKDROP_SOURCES, desktopBackdrops } from "../scripts/desktop-backdrops.mjs";
import { ComputerPanel } from "../src/app/views/computer.ts";
import { WebCompanyComputer } from "../src/cloud/computer.ts";
import { ComputerScene, desktopClock, hourColours, lidColour } from "../src/ui/computer-scene.ts";
import { fixture, id, profileA, settle, staff, userA } from "./fixtures.ts";

/* The desktop the member is about to see while an agent's computer sleeps or starts (COMPUTER-OPEN-BRIEF, 13 Nov 2026):
 * drawn from the machine's own sources, so the first picture lands on the same scene. */

const web = join(import.meta.dirname, "..");
const repo = join(web, "../..");

describe("the machine's own backdrop, as the web draws it", () => {
	it("keeps the web's copies of the figures equal to the machine's backdrop sources", () => {
		const sources = desktopBackdrops();
		expect(Object.keys(sources).sort()).toEqual([
			"acorn",
			"bolt",
			"cloud",
			"crown",
			"flame",
			"heart",
			"moon",
			"mushroom",
			"neutral",
			"planet",
			"puzzle",
			"rocket",
			"star",
		]);
		for (const [figure, backdrop] of Object.entries(sources)) {
			const copy = JSON.parse(readFileSync(join(web, `public/assets/desktop/backdrops/${figure}.json`), "utf8"));
			expect(copy, `${figure}: run node packages/web/scripts/desktop-backdrops.mjs`).toEqual(backdrop);
			expect(backdrop.paths.length).toBeGreaterThan(0);
		}
		// The machine's own table of which file draws which figure (scripts/machine-desktop-art.mjs).
		const art = readFileSync(join(repo, "scripts/machine-desktop-art.mjs"), "utf8");
		for (const [figure, source] of Object.entries(BACKDROP_SOURCES)) {
			if (figure === "neutral") continue;
			const file = source.match(/\/([a-z]+)\.html$/)?.[1];
			expect(art).toMatch(new RegExp(`\\b${figure}: "${file}"`));
		}
	});

	it("paints each hour's ground as the machine paints its bare screen", () => {
		const look = readFileSync(join(repo, "deploy/machine/desktop-look"), "utf8");
		const table =
			look
				.match(/GROUND=\(([\s\S]*?)\)/)?.[1]
				?.trim()
				.split(/\s+/) ?? [];
		expect(table).toHaveLength(24);
		const probe = document.createElement("span");
		document.body.append(probe);
		const rgb = (colour: string) => {
			// jsdom keeps hsl() as written: convert it here.
			const [h, s, l] = (colour.match(/hsl\((\S+) (\S+)% (\S+)%\)/)?.slice(1) ?? []).map(Number) as [
				number,
				number,
				number,
			];
			const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
			const f = (n: number) => {
				const k = (n + h / 30) % 12;
				return Math.round(255 * (l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
			};
			return [f(0), f(8), f(4)];
		};
		table.forEach((hex, hour) => {
			const [r, g, b] = rgb(hourColours(hour).ground);
			const want = [0, 2, 4].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
			expect(Math.abs((r as number) - (want[0] as number))).toBeLessThanOrEqual(1);
			expect(Math.abs((g as number) - (want[1] as number))).toBeLessThanOrEqual(1);
			expect(Math.abs((b as number) - (want[2] as number))).toBeLessThanOrEqual(1);
		});
	});

	it("reads the hour and the dock's clocks in the company's zone, else in UTC as the machine does", () => {
		const now = new Date("2026-11-13T02:07:00Z");
		expect(desktopClock(now, "Europe/Copenhagen")).toEqual({ hour: 3, date: "Fri 13 Nov", time: "03:07" });
		expect(desktopClock(now, null)).toEqual({ hour: 2, date: "Fri 13 Nov", time: "02:07" });
		expect(desktopClock(now, "Not/AZone")).toEqual({ hour: 2, date: "Fri 13 Nov", time: "02:07" });
	});

	it("shuts the eyes in a dark tone of a light figure's own colour, and in white on the others", () => {
		expect(lidColour("#fcb51b")).not.toBe("#ffffff");
		expect(lidColour("#3faff3")).not.toBe("#ffffff");
		expect(lidColour("#2047bd")).toBe("#ffffff");
		expect(lidColour("#e22538")).toBe("#ffffff");
		expect(lidColour("not a colour")).toBe("#ffffff");
	});
});

describe("the scene in the window", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
		vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		document.body.replaceChildren();
	});

	function machine(change: Partial<MemberAgentMachine>): MemberAgentMachine {
		return {
			machineId: id(41),
			name: "desk-1",
			purpose: "",
			state: "running",
			lifetime: "task",
			desktopCapable: true,
			startedByAgent: true,
			screenUsedAt: null,
			screenAgentName: null,
			waitingFor: null,
			control: null,
			epoch: 0,
			others: [],
			generation: 0,
			...change,
		};
	}
	/** A window over a list that the test changes. */
	function windowOn(machines: MemberAgentMachine[]) {
		const f = fixture();
		const stop = new AbortController();
		const list = { machines };
		vi.spyOn(WebCompanyComputer.prototype, "agentMachines").mockImplementation(async () => ({
			canWake: true,
			canTakeOver: true,
			machines: list.machines,
		}));
		vi.spyOn(WebCompanyComputer.prototype, "wakeMachine").mockResolvedValue(undefined);
		const computer = new WebCompanyComputer(f.cloud, profileA, userA.id, stop.signal, () => {});
		const panel = new ComputerPanel(staff, computer, stop.signal, { timeZone: () => "Europe/Copenhagen" });
		panel.attach(document.body, () => panel.dispose());
		return { panel, list, stop };
	}
	const scene = (panel: ComputerPanel) => panel.el.querySelector<HTMLElement>(".computer-scene");
	const words = (panel: ComputerPanel) => panel.el.querySelector<HTMLElement>(".computer-loading");
	async function flush() {
		for (let n = 0; n < 6; n++) {
			await settle();
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
	}

	it("draws the sleeping and the starting computer, with the window's words kept for screen readers", async () => {
		const w = windowOn([machine({ state: "stopped" })]);
		await flush();
		expect(scene(w.panel)?.hidden).toBe(false);
		expect(scene(w.panel)?.dataset.phase).toBe("asleep");
		expect(scene(w.panel)?.getAttribute("aria-hidden")).toBe("true");
		expect(words(w.panel)?.classList.contains("is-scene")).toBe(true);
		expect(words(w.panel)?.querySelector("[role=status]")?.textContent).toBe("The computer is asleep.");
		expect(w.panel.el.querySelector(".computer-loading-spinner")?.hasAttribute("hidden")).toBe(true);
		// Waiting for room: the dock says the short form in a small window, the full sentence stays in the words.
		w.list.machines = [machine({ state: "waiting", waitingFor: "room" })];
		w.panel.ask();
		await flush();
		expect(scene(w.panel)?.dataset.phase).toBe("waking");
		expect(scene(w.panel)?.querySelector(".computer-scene-line.is-short")?.textContent).toBe(
			"Waiting for room on our servers…",
		);
		expect(words(w.panel)?.querySelector(".computer-loading-detail")?.textContent).toBe(
			"Waiting for room on our servers. It starts as soon as there is room.",
		);
		// Placed and booting, as the list says: the step the scene shows next.
		w.list.machines = [machine({ state: "starting" })];
		await vi.advanceTimersByTimeAsync(15_000);
		await flush();
		expect(scene(w.panel)?.dataset.phase).toBe("starting");
		w.stop.abort();
	});

	it("draws no scene for states it does not show, and the plain words come back", async () => {
		const w = windowOn([machine({ desktopCapable: false })]);
		await flush();
		expect(scene(w.panel)?.hidden).toBe(true);
		expect(words(w.panel)?.classList.contains("is-scene")).toBe(false);
		w.stop.abort();
	});

	it("draws the neutral desktop on a computer another agent started", () => {
		const scene = new ComputerScene({ figure: "neutral", color: "#123456", timeZone: "UTC" });
		document.body.append(scene.el);
		scene.set("asleep");
		expect(scene.el.querySelector(".computer-scene-body.is-neutral")).not.toBeNull();
		expect(scene.el.querySelectorAll(".computer-scene-eye")).toHaveLength(0);
		expect(scene.el.querySelectorAll(".computer-scene-dock-icon")).toHaveLength(3);
		scene.dispose();
		expect(scene.el.hidden).toBe(true);
	});
});
