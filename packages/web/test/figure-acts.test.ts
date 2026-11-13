import { describe, expect, it } from "vitest";
import {
	calling,
	callingCues,
	callingStill,
	HOP_LAND,
	hop,
	hoppingDots,
	idleLife,
	lean,
	MOMENT_LENGTH,
	moment,
	momentCues,
	nextIdle,
	REST,
	raisedHand,
	whirl,
} from "../src/ui/figure-acts.ts";

describe("a hop", () => {
	it("starts and ends at rest, rises in the air and gives when it lands", () => {
		expect(hop(0, 20)).toBe(REST);
		expect(hop(1, 20)).toBe(REST);
		// A crouch before it leaves the ground: shorter and wider, still down.
		const crouch = hop(0.13, 20);
		expect(crouch.y).toBe(0);
		expect(crouch.scaleY).toBeLessThan(1);
		expect(crouch.scaleX).toBeGreaterThan(1);
		// The top of the jump, at its full height and its own shape.
		const top = hop(0.45, 20);
		expect(top.y).toBeCloseTo(-20, 5);
		expect(top.scaleY).toBeCloseTo(1, 5);
		// Stretched as it falls, squashed just after it lands.
		expect(hop(0.66, 20).scaleY).toBeGreaterThan(1);
		const landed = hop(HOP_LAND + 0.03, 20);
		expect(landed.y).toBe(0);
		expect(landed.scaleY).toBeLessThan(1);
	});
	it("never moves by less than it can show: every pose keeps its volume close", () => {
		for (let u = 0.01; u < 1; u += 0.01) {
			const pose = hop(u, 15);
			expect(pose.scaleX * pose.scaleY).toBeGreaterThan(0.93);
			expect(pose.scaleX * pose.scaleY).toBeLessThan(1.07);
		}
	});
});

describe("a figure that needs the member", () => {
	it("jumps as its hand comes up, with wide eyes", () => {
		expect(calling(0).hand?.show).toBe(0);
		expect(calling(0.35).body.y).toBeLessThan(-10);
		expect(calling(0.35).hand!.show).toBeGreaterThan(0.5);
		const settled = calling(2.9);
		expect(settled.body).toEqual(REST);
		expect(settled.hand!.show).toBeCloseTo(1, 3);
		expect(settled.eyes![0].height).toBeGreaterThan(1);
		expect(settled.eyes![0].smile).toBe(0);
	});
	it("waves while it asks and only sways between asks", () => {
		const waving = Array.from({ length: 40 }, (_, index) => Math.abs(calling(0.5 + index * 0.02).hand!.wave));
		const resting = Array.from({ length: 40 }, (_, index) => Math.abs(calling(2.5 + index * 0.02).hand!.wave));
		expect(Math.max(...waving)).toBeGreaterThan(15);
		expect(Math.max(...resting)).toBeLessThan(5);
	});
	it("asks again every few seconds, in a way its seed picks, and blinks", () => {
		// Seed 0 hops at the first ask and wiggles at the second; seed 1 the other way round.
		expect(calling(3.4 + 0.25, 0).body.y).toBeLessThan(-5);
		expect(calling(3.4 + 0.25, 1).body.y).toBe(0);
		expect(Math.abs(calling(3.4 + 0.3, 1).body.turn)).toBeGreaterThan(2);
		expect(calling(1.4).eyes![0].height).toBeLessThan(0.3);
	});
	it("sets off dust where it lands and a ring as the hand starts to wave", () => {
		const entrance = callingCues(0, 2);
		expect(entrance.map((cue) => cue.effect)).toEqual(["dust", "dust", "ring"]);
		expect(callingCues(2, 3)).toEqual([]);
		const firstAsk = callingCues(3.3, 4.5, 0).map((cue) => cue.effect);
		expect(firstAsk).toEqual(["ring", "dust", "dust"]);
		// A wiggle does not land.
		expect(callingCues(3.3, 4.5, 1).map((cue) => cue.effect)).toEqual(["ring"]);
		// Each goes off once, however the frames fall.
		expect(callingCues(0, 0.5).length + callingCues(0.5, 2).length).toBe(3);
	});
	it("rests with its hand up for a member who wants no motion", () => {
		const still = callingStill();
		expect(still.body).toBe(REST);
		expect(still.hand).toEqual({ show: 1, wave: 0 });
	});
});

describe("a raised hand beside a busy figure", () => {
	it("springs up, then waves every few seconds", () => {
		expect(raisedHand(0).show).toBe(0);
		expect(raisedHand(3).show).toBeCloseTo(1, 3);
		const wave = (from: number) =>
			Math.max(...Array.from({ length: 50 }, (_, i) => Math.abs(raisedHand(from + i * 0.02).wave)));
		expect(wave(6.8)).toBeGreaterThan(12);
		expect(wave(3)).toBeLessThan(5);
	});
});

describe("a working turn", () => {
	it("jumps and goes thin in the air, tipping with its sense", () => {
		expect(whirl(0, 1)).toEqual(REST);
		const up = whirl(0.45, 1);
		expect(up.y).toBeLessThan(-10);
		expect(up.scaleX).toBeLessThan(0.8);
		expect(whirl(0.33, 1).turn).toBeCloseTo(-whirl(0.33, -1).turn, 5);
		expect(whirl(0.33, 1).turn).not.toBe(0);
	});
	it("leans the way the eyes look, to a limit", () => {
		expect(lean({ x: 0, y: 0 }).turn).toBe(0);
		expect(lean({ x: -7, y: 0 }).turn).toBeLessThan(0);
		expect(lean({ x: 100, y: 0 }).turn).toBe(lean({ x: 14, y: 0 }).turn);
	});
});

describe("the writing dots", () => {
	const studio = [29, 50, 71].map((x) => ({ x, y: 50, r: 7, alpha: 1 }));
	it("hop one after the other and keep their places", () => {
		const at = (t: number) => hoppingDots(studio, t);
		expect(at(0).map((dot) => dot.y)).toEqual([50, 50, 50]);
		// The first is up while the others wait.
		const first = at(0.42 + 0.28);
		expect(first[0]!.y).toBeLessThan(40);
		expect(first[2]!.y).toBe(50);
		expect(first[0]!.alpha).toBeGreaterThan(first[2]!.alpha);
		// Then the last, with the first back down.
		const last = at(0.42 + 0.34 + 0.28);
		expect(last[2]!.y).toBeLessThan(40);
		expect(last[0]!.y).toBeCloseTo(50, 0);
		expect(at(3).map((dot) => dot.x)).toEqual([29, 50, 71]);
	});
	it("stay away while the studio has not brought them out", () => {
		expect(hoppingDots([{ x: 50, y: 50, r: 0, alpha: 1 }], 1)[0]!.r).toBe(0);
	});
});

describe("moments", () => {
	it("cheers with a jump, a smile and sparkles, and ends at rest", () => {
		expect(moment("cheer", 0.35).body.y).toBeLessThan(-10);
		expect(moment("cheer", 0.6).eyes![0].smile).toBe(1);
		expect(moment("cheer", MOMENT_LENGTH.cheer).body).toEqual(REST);
		expect(moment("cheer", MOMENT_LENGTH.cheer).eyes![0].smile).toBe(0);
		expect(momentCues("cheer", 0, MOMENT_LENGTH.cheer).map((cue) => cue.effect)).toEqual(["sparkles", "dust"]);
	});
	it("keeps the eyes for the small ones and ends each at rest", () => {
		for (const kind of ["perk", "stretch", "sway", "skip"] as const) {
			expect(moment(kind, MOMENT_LENGTH[kind] / 2).eyes).toBeUndefined();
			expect(moment(kind, MOMENT_LENGTH[kind] / 2).body).not.toEqual(REST);
			const end = moment(kind, MOMENT_LENGTH[kind]).body;
			expect(Math.abs(end.y) + Math.abs(end.turn) + Math.abs(end.scaleY - 1)).toBeLessThan(0.02);
			expect(momentCues(kind, 0, 5)).toEqual([]);
		}
	});
});

describe("an idle figure's life", () => {
	it("draws the same moves from the same seed, some seconds apart", () => {
		const one = idleLife(7),
			two = idleLife(7);
		const kinds = new Set<string>();
		for (let index = 0; index < 60; index++) {
			const drawn = nextIdle(one);
			expect(drawn).toEqual(nextIdle(two));
			expect(drawn.wait).toBeGreaterThanOrEqual(7);
			expect(drawn.wait).toBeLessThanOrEqual(20);
			kinds.add(drawn.kind);
		}
		expect([...kinds].sort()).toEqual(["look", "skip", "stretch", "sway"]);
	});
});
