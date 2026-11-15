import { describe, expect, it } from "vitest";
import {
	beatAt,
	FIGURE_EFFECTS,
	loopLength,
	type Shape,
	THREAD_SLOT,
	threadPath,
	workFrame,
} from "../src/ui/figure-work.ts";

const FIGURES = [
	"planet",
	"acorn",
	"flame",
	"rocket",
	"crown",
	"heart",
	"star",
	"cloud",
	"bolt",
	"mushroom",
	"moon",
	"puzzle",
];
const samples = (from: number, to: number, step: number) =>
	Array.from({ length: Math.round((to - from) / step) }, (_, index) => from + index * step);

function disc(): Shape {
	const inside = (x: number, y: number) => (x - 50) ** 2 + (y - 55) ** 2 < 35 ** 2;
	const prof = Array.from({ length: 100 }, (_, x) => {
		let y = 0;
		while (y < 100 && !inside(x, y)) y++;
		return y;
	});
	const lprof = Array.from({ length: 100 }, (_, y) => {
		let x = 0;
		while (x < 100 && !inside(x, y)) x++;
		return x;
	});
	const edge: [number, number][] = samples(0, Math.PI * 2, 0.05).map((a) => [
		Math.round(50 + 34 * Math.cos(a)),
		Math.round(55 + 34 * Math.sin(a)),
	]);
	return {
		box: { top: 20, bot: 90, lef: 15, rig: 85, cx: 50, cy: 55, w: 70, h: 70 },
		prof,
		lprof,
		edge,
		look: { x: 56, y: 55 },
		spacing: 13,
		eyeHeight: 14,
		top: { x: 50, y: 20 },
		low: { x: 50, y: 90 },
	};
}

describe("the working loop", () => {
	it("passes the thread alone every few seconds for a figure with no effect of its own", () => {
		for (const figure of ["planet", "crown", "mushroom", "puzzle"]) {
			expect(FIGURE_EFFECTS[figure]).toBeUndefined();
			const kinds = new Set(samples(0, 60, 0.1).map((t) => beatAt(figure, t).kind));
			expect(kinds).toEqual(new Set(["thread"]));
			expect(loopLength(figure)).toBeGreaterThan(7);
			expect(loopLength(figure)).toBeLessThan(10);
		}
	});
	it("takes turns between the thread and the figure's own effect, every few seconds", () => {
		for (const figure of ["acorn", "rocket", "heart", "star", "cloud", "bolt", "moon"]) {
			const order: string[] = [];
			for (const t of samples(0, 3 * loopLength(figure), 0.05)) {
				const beat = beatAt(figure, t);
				const name = `${beat.kind}:${beat.index}`;
				if (order.at(-1) !== name) order.push(name);
			}
			expect(order.slice(0, 4)).toEqual(["thread:0", "effect:1", "thread:0", "effect:1"]);
		}
		const flame = new Set(samples(0, loopLength("flame"), 0.05).map((t) => beatAt("flame", t).index));
		expect(flame).toEqual(new Set([0, 1, 2, 3]));
		expect(beatAt("acorn", THREAD_SLOT + 2.1).kind).toBe("effect");
	});
	it("never passes the thread the same way twice running, and swings it over the head every third pass", () => {
		const shape = disc();
		const pathOf = (k: number) => threadPath(shape, k).at(0.4);
		for (let k = 0; k < 30; k++) expect(pathOf(k)).not.toEqual(pathOf(k + 1));
		const over = threadPath(shape, 2).at;
		const early = over(-1.4 + 0.3),
			late = over(-1.4 + 6.5);
		expect(Math.abs(late.y - early.y) + Math.abs(late.x - early.x)).toBeGreaterThan(5);
	});
	it("keeps every figure in its place, except the rocket, which lifts, tilts to the right and comes back down", () => {
		const shape = disc();
		for (const figure of FIGURES) {
			let lifted = 0,
				tilted = 0;
			for (const t of samples(0, 2 * loopLength(figure), 0.05)) {
				const frame = workFrame(t, figure, shape, "#f96e2d", 7);
				for (const value of [
					frame.body.x,
					frame.body.y,
					frame.body.turn,
					frame.eyes[0].x,
					frame.eyes[0].y,
					frame.eyes[0].height,
				])
					expect(Number.isFinite(value)).toBe(true);
				lifted = Math.min(lifted, frame.body.y);
				tilted = Math.max(tilted, frame.body.turn);
				expect(frame.body.turn).toBeGreaterThanOrEqual(0);
			}
			if (figure === "rocket") {
				expect(lifted).toBeLessThan(-6);
				expect(tilted).toBeGreaterThan(8);
			} else {
				expect(lifted).toBe(0);
				expect(tilted).toBe(0);
			}
		}
	});
	it("follows the thread with its eyes, and glances and blinks between passes", () => {
		const shape = disc();
		const eyes = samples(0, 2 * loopLength("planet"), 0.02).map(
			(t) => workFrame(t, "planet", shape, "#3faff3", 3).eyes[0],
		);
		const xs = eyes.map((eye) => eye.x);
		expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0.25);
		expect(Math.min(...eyes.map((eye) => eye.height))).toBeLessThan(0.3);
	});
	it("draws something in the air during every effect and during a pass", () => {
		const shape = disc();
		for (const figure of FIGURES) {
			let drawn = 0;
			for (const t of samples(0, loopLength(figure), 0.1)) {
				const frame = workFrame(t, figure, shape, "#a145f7", 0);
				drawn += frame.behind.length + frame.front.length;
			}
			expect(drawn).toBeGreaterThan(0);
		}
	});
});
