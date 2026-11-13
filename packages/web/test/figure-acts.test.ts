import { describe, expect, it } from "vitest";
import {
	calling,
	callingCues,
	callingStill,
	HOP_LAND,
	hop,
	hoppingDots,
	IDLE_OPENING,
	idleLife,
	idleOpening,
	MOMENT_LENGTH,
	type Moment,
	moment,
	momentCues,
	nextIdle,
	openEyes,
	REST,
	waitingMark,
	working,
	workingCues,
	workingStill,
} from "../src/ui/figure-acts.ts";

const samples = (from: number, to: number, step = 0.02) =>
	Array.from({ length: Math.round((to - from) / step) }, (_, index) => from + index * step);

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
	it("keeps its volume close in every pose", () => {
		for (const u of samples(0.01, 1, 0.01)) {
			const pose = hop(u, 15);
			expect(pose.scaleX * pose.scaleY).toBeGreaterThan(0.93);
			expect(pose.scaleX * pose.scaleY).toBeLessThan(1.07);
		}
	});
});

describe("a figure that needs the member", () => {
	it("jumps as its mark comes up, with wide eyes", () => {
		expect(calling(0).mark?.show).toBe(0);
		expect(calling(0.35).body.y).toBeLessThan(-10);
		expect(calling(0.35).mark!.show).toBeGreaterThan(0.5);
		const settled = calling(2.9);
		expect(settled.body).toEqual(REST);
		expect(settled.mark!.show).toBeCloseTo(1, 3);
		expect(settled.eyes![0].height).toBeGreaterThan(1);
		expect(settled.eyes![0].smile).toBe(0);
	});
	it("shakes its mark while it asks and only sways it between asks", () => {
		expect(Math.max(...samples(0.5, 1.3).map((t) => Math.abs(calling(t).mark!.wave)))).toBeGreaterThan(15);
		expect(Math.max(...samples(2.5, 3.3).map((t) => Math.abs(calling(t).mark!.wave)))).toBeLessThan(5);
	});
	it("asks again every few seconds, in a way its seed picks, and blinks", () => {
		// Seed 0 hops at the first ask and wiggles at the second; seed 1 the other way round.
		expect(calling(3.4 + 0.25, 0).body.y).toBeLessThan(-5);
		expect(calling(3.4 + 0.25, 1).body.y).toBe(0);
		expect(Math.abs(calling(3.4 + 0.3, 1).body.turn)).toBeGreaterThan(2);
		expect(calling(1.4).eyes![0].height).toBeLessThan(0.3);
	});
	it("sets off dust where it lands and rays as the mark starts to shake", () => {
		expect(callingCues(0, 2).map((cue) => cue.effect)).toEqual(["dust", "dust", "rays"]);
		expect(callingCues(2, 3)).toEqual([]);
		expect(callingCues(3.3, 4.5, 0).map((cue) => cue.effect)).toEqual(["rays", "dust", "dust"]);
		// A wiggle does not land.
		expect(callingCues(3.3, 4.5, 1).map((cue) => cue.effect)).toEqual(["rays"]);
		// Each goes off once, however the frames fall.
		expect(callingCues(0, 0.5).length + callingCues(0.5, 2).length).toBe(3);
	});
	it("rests with its mark up for a member who wants no motion", () => {
		const still = callingStill();
		expect(still.body).toBe(REST);
		expect(still.mark).toEqual({ show: 1, wave: 0 });
	});
	it("keeps the mark of a busy figure up, shaking it every few seconds", () => {
		expect(waitingMark(0).show).toBe(0);
		expect(waitingMark(3).show).toBeCloseTo(1, 3);
		expect(Math.max(...samples(6.8, 7.8).map((t) => Math.abs(waitingMark(t).wave)))).toBeGreaterThan(12);
		expect(Math.max(...samples(3, 4).map((t) => Math.abs(waitingMark(t).wave)))).toBeLessThan(5);
	});
});

describe("a working figure", () => {
	it("opens tapping along a line: eyes on its work, stepping across it, a tap at each step", () => {
		// Its eyes are down on the work and a little narrowed, at the left of the line and then the right.
		const start = working(0.19),
			end = working(1.2);
		expect(start.eyes![0].y).toBeGreaterThan(0);
		expect(start.eyes![0].height).toBeLessThan(1);
		expect(start.eyes![0].x).toBeLessThan(-0.3);
		expect(end.eyes![0].x).toBeGreaterThan(0.3);
		// Four taps: off the ground four times in the line.
		let taps = 0,
			up = false;
		for (const t of samples(0, 1.9, 0.01)) {
			const now = working(t).body.y < -1;
			if (now && !up) taps++;
			up = now;
		}
		expect(taps).toBe(4);
		// A bit flies off at each.
		expect(workingCues(0, 1.9).map((cue) => cue.effect)).toEqual(["bits", "bits", "bits", "bits"]);
	});
	it("starts and ends every bar on the same pose, so the bars join", () => {
		for (const seed of [0, 1, 2, 3]) {
			let last = working(0, seed);
			for (const t of samples(0.01, 60, 0.01)) {
				const now = working(t, seed);
				// No pose jumps from one hundredth of a second to the next.
				expect(Math.abs(now.body.y - last.body.y)).toBeLessThan(3);
				expect(Math.abs(now.eyes![0].x - last.eyes![0].x)).toBeLessThan(0.2);
				expect(Math.abs(now.eyes![0].height - last.eyes![0].height)).toBeLessThan(0.35);
				last = now;
			}
		}
	});
	it("does more than tap: it sets its eyes, looks away to think, gets an idea, and never smiles at its work", () => {
		const seen = { set: false, away: false, wide: false };
		const effects = new Set<string>();
		for (const seed of [0, 1, 2]) {
			for (const t of samples(0, 60)) {
				const [left, right] = working(t, seed).eyes!;
				if (left.rotation > 8 && right.rotation < -8) seen.set = true;
				if (left.y < -0.3) seen.away = true;
				if (left.height > 1.1) seen.wide = true;
				expect(left.smile).toBe(0);
			}
			for (const cue of workingCues(0, 60, seed)) effects.add(cue.effect);
		}
		expect(seen).toEqual({ set: true, away: true, wide: true });
		expect([...effects].sort()).toEqual(["bits", "idea"]);
	});
	it("sets each effect off once, frame by frame, and differs from agent to agent", () => {
		const whole = workingCues(0, 30, 5).length;
		let framed = 0;
		for (let frame = 0; frame < 30 * 60; frame++) framed += workingCues(frame / 60, (frame + 1) / 60, 5).length;
		expect(framed).toBe(whole);
		expect(whole).toBeGreaterThan(20);
		const kinds = (seed: number) => samples(0, 40, 0.5).map((t) => working(t, seed).eyes![0].rotation > 4);
		expect(kinds(1)).not.toEqual(kinds(2));
	});
	it("rests with its eyes on its work for a member who wants no motion", () => {
		expect(workingStill().body).toBe(REST);
		expect(workingStill().eyes![0].y).toBeGreaterThan(0);
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

describe("an idle figure", () => {
	it("opens with a blink into a glance up and ends on its own eyes", () => {
		expect(idleOpening(0)[0].height).toBeLessThan(0.2);
		expect(idleOpening(0.9)[0].y).toBeLessThan(-0.3);
		const settled = idleOpening(IDLE_OPENING)[0],
			own = openEyes()[0];
		for (const key of ["x", "y", "width", "height", "rotation", "alpha", "smile"] as const)
			expect(settled[key]).toBeCloseTo(own[key], 6);
	});
	it("draws the same moves from the same seed, some seconds apart, the eyes' more often than the body's", () => {
		const one = idleLife(7),
			two = idleLife(7);
		const kinds = new Map<Moment, number>();
		for (let index = 0; index < 400; index++) {
			const drawn = nextIdle(one);
			expect(drawn).toEqual(nextIdle(two));
			expect(drawn.wait).toBeGreaterThanOrEqual(4);
			expect(drawn.wait).toBeLessThanOrEqual(13);
			kinds.set(drawn.kind, (kinds.get(drawn.kind) ?? 0) + 1);
		}
		expect([...kinds.keys()].sort()).toEqual([
			"blink",
			"blinks",
			"left",
			"right",
			"skip",
			"smile",
			"stretch",
			"sway",
			"up",
		]);
		expect(kinds.get("blink")!).toBeGreaterThan(kinds.get("skip")!);
	});
});

describe("moments", () => {
	it("cheers long: two jumps, a twirl once round, a rock, smiling, with stars the whole way", () => {
		expect(moment("cheer", 0.35).body.y).toBeLessThan(-10);
		// The twirl: higher than the jumps, edge on and then its back, where it has no eyes.
		const twirl = samples(1.24, 2.1, 0.01).map((t) => moment("cheer", t));
		expect(Math.min(...twirl.map((act) => act.body.y))).toBeLessThan(-22);
		expect(Math.min(...twirl.map((act) => act.body.scaleX))).toBeLessThan(0.25);
		expect(Math.min(...twirl.map((act) => act.eyes![0].alpha))).toBe(0);
		// Facing again when it lands, still smiling, rocking.
		expect(moment("cheer", 2.2).eyes![0]).toMatchObject({ alpha: 1, smile: 1 });
		expect(Math.max(...samples(2.2, 3).map((t) => Math.abs(moment("cheer", t).body.turn)))).toBeGreaterThan(4);
		// Over: at rest, eyes open.
		const end = moment("cheer", MOMENT_LENGTH.cheer);
		expect(end.body).toEqual(REST);
		expect(end.eyes![0]).toMatchObject({ smile: 0, height: 1, alpha: 1 });
		expect(momentCues("cheer", 0, MOMENT_LENGTH.cheer).map((cue) => cue.effect)).toEqual([
			"sparkles",
			"dust",
			"shower",
			"dust",
			"twinkle",
			"twinkle",
			"twinkle",
		]);
	});
	it("cheers short: two jumps, a smile and one burst", () => {
		expect(moment("hooray", 0.35).body.y).toBeLessThan(-10);
		expect(moment("hooray", 0.6).eyes![0].smile).toBe(1);
		expect(moment("hooray", MOMENT_LENGTH.hooray).body).toEqual(REST);
		expect(momentCues("hooray", 0, MOMENT_LENGTH.hooray).map((cue) => cue.effect)).toEqual(["sparkles", "dust"]);
	});
	it("ends every moment where the figure rests, and sets nothing off for the small ones", () => {
		for (const kind of Object.keys(MOMENT_LENGTH) as Moment[]) {
			const end = moment(kind, MOMENT_LENGTH[kind]);
			expect(
				Math.abs(end.body.x) + Math.abs(end.body.y) + Math.abs(end.body.turn) + Math.abs(end.body.scaleY - 1),
			).toBeLessThan(0.02);
			if (end.eyes)
				for (const [key, rest] of [
					["x", 0],
					["y", 0],
					["smile", 0],
					["alpha", 1],
					["height", 1],
				] as const)
					expect(end.eyes[0][key]).toBeCloseTo(rest, 2);
			if (kind !== "cheer" && kind !== "hooray") expect(momentCues(kind, 0, 9)).toEqual([]);
		}
	});
	it("moves the body for the body's moments and the eyes for the eyes'", () => {
		for (const kind of ["perk", "stretch", "sway", "skip"] as const) {
			expect(moment(kind, MOMENT_LENGTH[kind] / 2).eyes).toBeUndefined();
			expect(moment(kind, MOMENT_LENGTH[kind] / 2).body).not.toEqual(REST);
		}
		expect(moment("blink", 0.08).eyes![0].height).toBeLessThan(0.3);
		expect(moment("left", 0.5).eyes![0].x).toBeLessThan(-0.3);
		expect(moment("right", 0.5).eyes![0].x).toBeGreaterThan(0.3);
		expect(moment("up", 0.5).eyes![0].y).toBeLessThan(-0.3);
		expect(moment("smile", 0.6).eyes![0].smile).toBe(1);
	});
});
