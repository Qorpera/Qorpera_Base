// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { type MeetState, renderMeet } from "../src/app/views/meet.ts";
import type { HostedStaffAgent } from "../src/cloud/types.ts";
import { agentFigure } from "../src/ui/avatar.ts";
import { FigurePicker } from "../src/ui/figure-picker.ts";
import { fixture, profileA, staff, stubFigureMotion, team, userA } from "./fixtures.ts";

const NATIVE = { crown: "#fcb51b", planet: "#5ec0b5", heart: "#fb672a", rocket: "#f96e2d" };
const TEAL = "#00bfb3";
const GOLD = NATIVE.crown;
const ORANGE = NATIVE.rocket;
let drawn: ReturnType<typeof stubFigureMotion>;
const cleanup: (() => void)[] = [];
beforeEach(() => {
	drawn = stubFigureMotion();
	vi.stubGlobal("QORPERA_MOTION_MODEL", {
		avatars: Object.entries(NATIVE).map(([id, color]) => ({ id, color })),
		faces: {},
	});
	vi.stubGlobal("QORPERA_AVATAR_APPEARANCE", {
		palette: [
			{ name: "Teal", color: TEAL },
			{ name: "Blue", color: "#2047bd" },
			{ name: "Gold", color: GOLD },
			{ name: "Orange", color: ORANGE },
		],
	});
});
afterEach(() => {
	for (const step of cleanup.splice(0)) step();
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

/** The colour a built figure was drawn in. */
const colorOf = (host: Element | null) => drawn.mock.calls.find(([element]) => element === host)?.[2];
const agent = (color: string, templateId: string, creature?: string): HostedStaffAgent => ({
	...staff,
	templateId,
	appearance: { color, shape: "round", ...(creature ? { creature } : {}) },
});

describe("agent colour", () => {
	it("draws the Co-Founder like any agent: in its own shade without a colour, and any chosen colour as chosen", () => {
		// The founding seed: a file with no colour (the index's `native`) and a creature the roster no longer has.
		expect(colorOf(agentFigure(agent("native", "co-founder", "brain")))).toBe(NATIVE.crown);
		expect(colorOf(agentFigure(agent(TEAL, "co-founder")))).toBe(TEAL);
		// Blue chosen in a file is blue, the Co-Founder's too.
		expect(colorOf(agentFigure(agent("qorpera-blue", "co-founder")))).toBe("#2047bd");
		expect(colorOf(agentFigure(agent("qorpera-blue", "software-developer")))).toBe("#2047bd");
	});

	it("lets a figure in its own shade bring the new figure's shade, and keeps a chosen colour", () => {
		for (const [start, heart] of [
			[NATIVE.planet, NATIVE.heart],
			[TEAL, TEAL],
		] as const) {
			const change = vi.fn();
			const picker = new FigurePicker({ figure: "planet", color: start }, change, { keepColor: true });
			document.body.append(picker.el);
			const choice = picker.el.querySelector<HTMLButtonElement>('[aria-label="heart"]')!;
			expect(colorOf(choice.querySelector(".figure"))).toBe(heart);
			choice.click();
			expect(change).toHaveBeenLastCalledWith({ figure: "heart", color: heart });
		}
	});

	it("keeps a chosen colour through a figure whose own shade it is, until Reset", () => {
		const change = vi.fn();
		const picker = new FigurePicker({ figure: "heart", color: ORANGE }, change, { keepColor: true });
		document.body.append(picker.el);
		const pick = (label: string) => picker.el.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click();
		// Orange is the rocket's own shade; passing through it keeps the choice.
		for (const figure of ["crown", "rocket", "crown"] as const) {
			pick(figure);
			expect(change).toHaveBeenLastCalledWith({ figure, color: ORANGE });
		}
		// Reset brings the own shade back, and it follows the figure again.
		picker.reset();
		expect(change).toHaveBeenLastCalledWith({ figure: "crown", color: NATIVE.crown });
		pick("planet");
		expect(change).toHaveBeenLastCalledWith({ figure: "planet", color: NATIVE.planet });
		// A colour picked now is kept, even one that is some figure's own shade.
		pick("Gold");
		pick("heart");
		expect(change).toHaveBeenLastCalledWith({ figure: "heart", color: GOLD });
		// Opening afresh decides again from what is saved.
		picker.update({ figure: "planet", color: TEAL }, true);
		pick("crown");
		expect(change).toHaveBeenLastCalledWith({ figure: "crown", color: TEAL });
		picker.update({ figure: "planet", color: NATIVE.planet }, true);
		pick("heart");
		expect(change).toHaveBeenLastCalledWith({ figure: "heart", color: NATIVE.heart });
	});

	it("decides again when the look changes elsewhere while the picker is open", () => {
		const change = vi.fn();
		const picker = new FigurePicker({ figure: "heart", color: TEAL }, change, { keepColor: true });
		document.body.append(picker.el);
		const pick = (label: string) => picker.el.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click();
		// Another member resets the agent to its own shade.
		picker.update({ figure: "heart", color: NATIVE.heart });
		pick("crown");
		expect(change).toHaveBeenLastCalledWith({ figure: "crown", color: NATIVE.crown });
		// And later gives it a colour.
		picker.update({ figure: "crown", color: TEAL });
		pick("planet");
		expect(change).toHaveBeenLastCalledWith({ figure: "planet", color: TEAL });
	});
});

describe("first-run page", () => {
	function meet(cofounder: HostedStaffAgent) {
		const f = fixture();
		const company = new CompanyController(f.api, profileA, userA.id);
		company.store.set({ team, staff: [cofounder], loading: false });
		cleanup.push(() => company.stop());
		const save = vi.fn(async () => {});
		const container = document.createElement("div");
		document.body.append(container);
		let state: MeetState = {};
		const render = () =>
			renderMeet(company, save, container, state, (next) => {
				state = next;
				render();
			});
		render();
		const named = (label: string) =>
			[...container.querySelectorAll<HTMLButtonElement>("button")].find(
				(item) => item.getAttribute("aria-label") === label || item.textContent === label,
			)!;
		return { save, named };
	}

	it("keeps a colour chosen in the details until a figure is picked here", () => {
		const cofounder = agent(TEAL, "co-founder", "crown");
		const kept = meet(cofounder);
		kept.named("Save appearance and continue").click();
		expect(kept.save).toHaveBeenCalledWith(cofounder, "crown", TEAL);
		document.body.replaceChildren();
		const again = meet(cofounder);
		// Clicking the figure already shown is no new choice.
		again.named("crown").click();
		again.named("Save appearance and continue").click();
		expect(again.save).toHaveBeenCalledWith(cofounder, "crown", TEAL);
		document.body.replaceChildren();
		const picked = meet(cofounder);
		picked.named("rocket").click();
		picked.named("Save appearance and continue").click();
		expect(picked.save).toHaveBeenCalledWith(cofounder, "rocket", NATIVE.rocket);
	});
});
