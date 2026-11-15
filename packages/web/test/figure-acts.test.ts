import { describe, expect, it } from "vitest";
import {
	asking,
	askingCues,
	askingStill,
	BECOME,
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
	working,
	workingCues,
	workingStill,
	writingAsk,
	writingAskCues,
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
	it("jumps, spins once round in the air and comes down as its symbol", () => {
		// Itself as it leaves the ground, with wide eyes.
		const start = asking(0.05, "question");
		expect(start.symbol).toBeUndefined();
		expect(start.eyes![0].height).toBeGreaterThan(1);
		// In the air it turns: edge on (thin), its back (no eyes), edge on again, where it is swapped.
		const air = samples(0.2, 0.64, 0.005).map((t) => asking(t, "question"));
		expect(Math.min(...air.map((act) => act.body.y))).toBeLessThan(-20);
		expect(air.filter((act) => act.body.scaleX < 0.2).length).toBeGreaterThan(1);
		expect(air.some((act) => !act.symbol && act.eyes![0].alpha === 0)).toBe(true);
		// The swap happens while it is thin, so it is never seen.
		const swap = air.findIndex((act) => act.symbol);
		expect(air[swap]!.body.scaleX).toBeLessThan(0.25);
		expect(air.slice(swap).every((act) => act.symbol === "question")).toBe(true);
		// Down as the symbol, upright and its own size.
		expect(asking(BECOME + 0.3, "question")).toEqual({ body: REST, symbol: "question" });
		expect(asking(BECOME + 0.3, "bang").symbol).toBe("bang");
	});
	it("keeps asking as the symbol: it hops or shakes every couple of seconds", () => {
		for (const kind of ["question", "bang"] as const) {
			for (const seed of [0, 1]) {
				const hold = samples(BECOME + 0.5, BECOME + 6.3, 0.01).map((t) => asking(t, kind, seed));
				expect(hold.every((act) => act.symbol === kind)).toBe(true);
				// Some hops (off the ground) and some shaking or rocking (sideways or turned) in one hold.
				expect(hold.some((act) => act.body.y < -5)).toBe(true);
				expect(hold.some((act) => Math.abs(act.body.x) > 2 || Math.abs(act.body.turn) > 8)).toBe(true);
				// And it stands still in between.
				expect(hold.filter((act) => act.body === REST).length).toBeGreaterThan(100);
			}
		}
		// A "!" shakes from side to side; a "?" rocks on its dot.
		const shake = (kind: "question" | "bang") =>
			samples(BECOME, BECOME + 6.3, 0.01).map((t) => asking(t, kind, 1).body);
		expect(shake("bang").some((body) => Math.abs(body.x) > 2)).toBe(true);
		expect(shake("bang").every((body) => body.turn === 0)).toBe(true);
		expect(shake("question").some((body) => Math.abs(body.turn) > 8)).toBe(true);
	});
	it("turns back into the figure now and then, which looks to both sides, and becomes the symbol again", () => {
		const period = BECOME + 6.4 + 0.72 + 1.7;
		const peek = samples(period - 1.6, period - 0.1, 0.01).map((t) => asking(t, "bang"));
		expect(peek.every((act) => !act.symbol)).toBe(true);
		expect(Math.min(...peek.map((act) => act.eyes![0].x))).toBeLessThan(-0.3);
		expect(Math.max(...peek.map((act) => act.eyes![0].x))).toBeGreaterThan(0.3);
		expect(asking(period + BECOME + 0.3, "bang").symbol).toBe("bang");
	});
	it("sets off small stars as it becomes the symbol, and dust wherever it lands", () => {
		expect(askingCues(0, BECOME).map((cue) => cue.effect)).toEqual(["pop", "dust"]);
		const hold = askingCues(BECOME, BECOME + 6.4, 0).map((cue) => cue.effect);
		expect(hold.length).toBeGreaterThan(0);
		expect(new Set(hold)).toEqual(new Set(["dust"]));
		// Each goes off once, frame by frame, over two whole rounds.
		const whole = askingCues(0, 20, 3).length;
		let framed = 0;
		for (let frame = 0; frame < 20 * 60; frame++) framed += askingCues(frame / 60, (frame + 1) / 60, 3).length;
		expect(framed).toBe(whole);
	});
	it("rests as the symbol for a member who wants no motion", () => {
		expect(askingStill("question")).toEqual({ body: REST, symbol: "question" });
	});
});

describe("a working figure", () => {
	it("stays itself at rest and hands its loop the time it has worked", () => {
		for (const t of samples(0, 60, 0.05)) {
			const act = working(t);
			expect(act.symbol).toBeUndefined();
			expect(act.body).toBe(REST);
			expect(act.work).toBeCloseTo(t, 9);
		}
	});
	it("becomes its ask for a moment when something also waits on the member, and its loop carries on after", () => {
		const symbols = (ask?: "question" | "bang") =>
			new Set(samples(0, 40, 0.02).map((t) => working(t, ask).symbol ?? "figure"));
		expect(symbols()).toEqual(new Set(["figure"]));
		expect(symbols("question")).toEqual(new Set(["figure", "question"]));
		expect(symbols("bang")).toEqual(new Set(["figure", "bang"]));
		let last = 0;
		for (const t of samples(0, 40, 0.02)) {
			const { work } = working(t, "bang");
			if (work === undefined) continue;
			expect(work).toBeGreaterThanOrEqual(last);
			expect(work - last).toBeLessThan(0.05);
			last = work;
		}
		expect(last).toBeGreaterThan(25);
	});
	it("sets off stars as it becomes its ask and dust where it lands, each once, and nothing while it only works", () => {
		expect(workingCues(0, 120)).toEqual([]);
		const whole = workingCues(0, 120, "bang");
		let framed = 0;
		for (let frame = 0; frame < 120 * 60; frame++) framed += workingCues(frame / 60, (frame + 1) / 60, "bang").length;
		expect(framed).toBe(whole.length);
		const effects = new Set(whole.map((cue) => cue.effect));
		expect(effects).toEqual(new Set(["pop", "dust"]));
	});
	it("rests with its eyes open for a member who wants no motion", () => {
		const still = workingStill();
		expect(still.body).toBe(REST);
		expect(still.eyes).toEqual(openEyes());
		expect(still.work).toBeUndefined();
	});
});

describe("a writing figure whose work also waits on the member", () => {
	const period = 5.2 + BECOME + 2.4 + 0.72;
	it("writes as its dots, and every few seconds becomes its ask for a moment", () => {
		// No symbol while the dots write: the studio's pose draws them.
		for (const t of samples(0, 5.19, 0.05)) expect(writingAsk(t, "question")).toEqual({ body: REST });
		// Then the dots jump (thin at the swap) and the ask stands, hops, and goes.
		const change = samples(5.2, 5.2 + BECOME, 0.005).map((t) => writingAsk(t, "question"));
		expect(Math.min(...change.map((act) => act.body.y))).toBeLessThan(-15);
		expect(change.find((act) => act.symbol)!.body.scaleX).toBeLessThan(0.25);
		const hold = samples(5.2 + BECOME + 0.01, 5.2 + BECOME + 2.39, 0.01).map((t) => writingAsk(t, "bang"));
		expect(hold.every((act) => act.symbol === "bang")).toBe(true);
		expect(hold.some((act) => act.body.y < -5)).toBe(true);
		// Back to the dots, and again a round later.
		expect(writingAsk(period - 0.01, "bang").symbol).toBeUndefined();
		expect(writingAsk(period + 5.2 + BECOME + 0.5, "bang").symbol).toBe("bang");
		// The ask shows for over a quarter of the time.
		const shown = samples(0, period * 4, 0.02).filter((t) => writingAsk(t, "question").symbol).length;
		expect(shown / (period * 4 * 50)).toBeGreaterThan(0.25);
	});
	it("sets off stars as the dots become the ask, and dust where it lands, each once", () => {
		expect(writingAskCues(0, 5.2)).toEqual([]);
		expect(writingAskCues(5.2, period).map((cue) => cue.effect)).toEqual(["pop", "dust", "dust", "dust", "dust"]);
		let framed = 0;
		for (let frame = 0; frame < 30 * 60; frame++) framed += writingAskCues(frame / 60, (frame + 1) / 60).length;
		expect(framed).toBe(writingAskCues(0, 30).length);
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
		for (const kind of ["stretch", "sway", "skip"] as const) {
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
