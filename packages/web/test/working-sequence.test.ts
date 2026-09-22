import { describe, expect, it } from "vitest";
import { recordedClips } from "../public/assets/avatars/status-2d-v1/recorded-clips.mjs";
import {
	createWorkingSchedule,
	eyeCentre,
	FPS,
	SLIDE_FRAMES,
	stepKey,
	type WorkingStep,
	workingStep,
} from "../src/ui/working-sequence.ts";

/** The eye pair's centre on screen, in source pixels, after the step's field transform. */
function shown(step: WorkingStep): { x: number; y: number } | undefined {
	const centre = eyeCentre(recordedClips[step.clip].frames[step.frame]!);
	if (!centre) return undefined;
	const { mirror, tilt, x, y } = step.eyes;
	const dx = (centre.x + x - 80) * (mirror ? -1 : 1),
		dy = centre.y + y - 80;
	const a = (tilt * Math.PI) / 180;
	return { x: 80 + dx * Math.cos(a) - dy * Math.sin(a), y: 80 + dx * Math.sin(a) + dy * Math.cos(a) };
}
function steps(seed: number, seconds: number): WorkingStep[] {
	const schedule = createWorkingSchedule(seed);
	return Array.from({ length: seconds * FPS }, (_, n) => workingStep(schedule, n / FPS));
}

describe("Working sequencer", () => {
	it("opens with the studio's first frames, unchanged, so Idle flows into Working", () => {
		for (const seed of [1, 2, 3]) {
			// Frames 0–79: the opening glance up to where the first spin's exit begins.
			const first = steps(seed, 80 / FPS);
			first.forEach((step, n) => {
				expect(step.clip).toBe("Working");
				expect(step.frame).toBe(n);
				expect(step.eyes).toEqual({ mirror: false, tilt: 0, x: 0, y: 0 });
			});
		}
	});
	it("never lets the eyes jump: the old restart moved them about a third of the body at once", () => {
		for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
			const run = steps(seed, 120);
			let largest = 0;
			for (let n = 1; n < run.length; n++) {
				const a = shown(run[n - 1]!),
					b = shown(run[n]!);
				if (a && b) largest = Math.max(largest, Math.hypot(a.x - b.x, a.y - b.y));
			}
			// The recording's own fastest visible eye motion is about 13 source pixels a
			// frame; the swing into a spin adds a little. The old restart moved them 47.
			expect(largest).toBeLessThan(22);
		}
	});
	it("plays past the old loop boundary without returning to the opening", () => {
		const run = steps(11, 60);
		const at = run[Math.round((650 / 60) * FPS)]!;
		expect(at.frame).not.toBe(0);
		for (let n = 215; n < run.length; n++) expect(run[n]!.clip === "Waiting" || run[n]!.frame >= 80).toBe(true);
	});
	it("mirrors the eye field only while the eyes are hidden and swings it smoothly around a turn", () => {
		for (const seed of [1, 2, 3, 4]) {
			const run = steps(seed, 120);
			let turns = 0;
			const passes = new Set<string>();
			for (let n = 1; n < run.length; n++) {
				const before = run[n - 1]!,
					after = run[n]!;
				if (before.eyes.mirror !== after.eyes.mirror) {
					turns++;
					expect(shown(before)).toBeUndefined();
					expect(shown(after)).toBeUndefined();
				}
				if (shown(before) && shown(after)) expect(Math.abs(after.eyes.tilt - before.eyes.tilt)).toBeLessThan(12);
				const stripes = (step: WorkingStep) =>
					step.clip === "Working" && recordedClips.Working.frames[step.frame]!.runs.length > 0;
				if (stripes(before) && stripes(after)) expect(after.strokes).toEqual(before.strokes);
				if (stripes(after)) passes.add(`${after.strokes.mirror}:${after.strokes.tilt}`);
			}
			// About half the turns flip the mirror; every pass has stripes of its own.
			expect(turns).toBeGreaterThan(2);
			expect(passes.size).toBeGreaterThan(8);
		}
	});
	it("spins the eyes with the stripes: the exit angle is the stripes' angle, in either sense", () => {
		const schedule = createWorkingSchedule(5);
		workingStep(schedule, 120);
		const turns = schedule.segments.filter((segment) => segment.turn);
		expect(turns.length).toBeGreaterThan(8);
		const senses = new Set<number>();
		for (const segment of turns) {
			const { turn, spin, strokes } = segment;
			expect(strokes).toEqual({ mirror: turn!.mirror, tilt: turn!.angle });
			const exit = workingStep(schedule, (segment.start + spin!.exit[1] - segment.from) / FPS);
			expect(exit.eyes.tilt).toBeCloseTo(turn!.angle);
			expect(exit.eyes.mirror).toBe(turn!.fromMirror);
			const swing = turn!.angle - turn!.fromTilt;
			expect(Math.abs(swing)).toBeGreaterThanOrEqual(15);
			expect(Math.abs(swing)).toBeLessThanOrEqual(70);
			expect(Math.sign(swing)).toBe(turn!.mirror ? -1 : 1);
			senses.add(Math.sign(swing));
			const settled = workingStep(schedule, (segment.start + spin!.entry[1] - segment.from) / FPS);
			expect(settled.eyes.mirror).toBe(turn!.mirror);
			expect(settled.eyes.tilt).toBeCloseTo(turn!.tilt);
		}
		expect(senses.size).toBe(2);
	});
	it("varies mirror, tilt and stripe direction across agents and over time", () => {
		const mirrors = new Set<boolean>(),
			tilts = new Set<number>(),
			directions = new Set<number>();
		for (const seed of [1, 2, 3, 4, 5, 6])
			for (const step of steps(seed, 90)) {
				mirrors.add(step.eyes.mirror);
				tilts.add(Math.round(step.eyes.tilt));
				directions.add(Math.round(step.strokes.tilt / 30));
			}
		expect(mirrors.size).toBe(2);
		expect(tilts.size).toBeGreaterThan(6);
		expect(directions.size).toBeGreaterThan(3);
	});
	it("is the same sequence for the same seed and differs between seeds", () => {
		const a = steps(9, 40).map(stepKey),
			b = steps(9, 40).map(stepKey),
			c = steps(10, 40).map(stepKey);
		expect(a).toEqual(b);
		expect(a).not.toEqual(c);
	});
	it("eases a join's offset away over the slide window", () => {
		const schedule = createWorkingSchedule(3);
		workingStep(schedule, 60);
		const joined = schedule.segments.find((segment) => Math.hypot(segment.slide.x, segment.slide.y) > 1)!;
		expect(joined).toBeDefined();
		const at = (k: number) => workingStep(schedule, (joined.start + k) / FPS).eyes;
		expect(Math.hypot(at(0).x, at(0).y)).toBeCloseTo(Math.hypot(joined.slide.x, joined.slide.y));
		expect(Math.hypot(at(SLIDE_FRAMES).x, at(SLIDE_FRAMES).y)).toBe(0);
	});
});
