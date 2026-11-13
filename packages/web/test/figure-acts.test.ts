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
	const BEAT = 0.46;
	it("stays itself, eyes and all, and brings its three stars out one beat after another", () => {
		for (const t of samples(0, 30, 0.05)) {
			const act = working(t, 3);
			expect(act.symbol).toBeUndefined();
			expect(act.eyes).toBeDefined();
			expect(act.props).toHaveLength(3);
		}
		const out = (t: number) => working(t).props!.filter((star) => star.scale > 0.5).length;
		expect(out(0)).toBe(0);
		expect(out(0.9 * BEAT)).toBe(1);
		expect(out(1.9 * BEAT)).toBe(2);
		expect(out(4 * BEAT)).toBe(3);
	});
	it("keeps the stars in the air: each goes from one shoulder over the top to the other, and up again", () => {
		const path = samples(4 * BEAT, 16 * BEAT, 0.01).map((t) => working(t, 1).props!);
		for (const star of [0, 1, 2]) {
			const xs = path.map((stars) => stars[star]!.x),
				ys = path.map((stars) => stars[star]!.y);
			// Both shoulders, and well over the head in between.
			expect(Math.min(...xs)).toBeLessThan(22);
			expect(Math.max(...xs)).toBeGreaterThan(78);
			expect(Math.min(...ys)).toBeLessThan(2);
			expect(Math.max(...ys)).toBeLessThanOrEqual(36.01);
		}
		// Never two stars in one place: they follow each other a beat apart.
		for (const stars of path)
			for (const [a, b] of [
				[0, 1],
				[1, 2],
				[0, 2],
			] as const)
				expect(Math.hypot(stars[a]!.x - stars[b]!.x, stars[a]!.y - stars[b]!.y)).toBeGreaterThan(8);
		// No star jumps: a hundredth of a second moves it a little.
		path.slice(1).forEach((stars, index) => {
			for (const star of [0, 1, 2]) {
				const before = path[index]![star]!;
				// A bump turns a star round at its shoulder, where it changes side in place.
				expect(Math.hypot(stars[star]!.x - before.x, stars[star]!.y - before.y)).toBeLessThan(4);
			}
		});
	});
	it("bounces from side to side under them and follows them with its eyes", () => {
		const acts = samples(4 * BEAT, 12 * BEAT, 0.01).map((t) => working(t, 5));
		// Leaning left and right, up between the beats.
		expect(Math.min(...acts.map((act) => act.body.turn))).toBeLessThan(-3);
		expect(Math.max(...acts.map((act) => act.body.turn))).toBeGreaterThan(3);
		expect(Math.min(...acts.map((act) => act.body.y))).toBeLessThan(-3);
		// The eyes look up, and to both sides.
		const looks = acts.filter((act) => act.eyes![0].alpha === 1 && act.eyes![0].smile === 0);
		expect(Math.min(...looks.map((act) => act.eyes![0].x))).toBeLessThan(-0.3);
		expect(Math.max(...looks.map((act) => act.eyes![0].x))).toBeGreaterThan(0.3);
		// As a star is at the top (a little over a beat after its bump), the eyes are on it: near the middle, looking
		// up, and going the way the star goes (bumped at an even beat, it goes to the right).
		const star = samples(4, 7, 0.01).map((q) => working(q * BEAT, 1));
		const top = star.reduce((best, act) => (act.props![1]!.y < best.props![1]!.y ? act : best));
		expect(Math.abs(top.eyes![0].x)).toBeLessThan(0.2);
		expect(top.eyes![0].y).toBeLessThan(-0.4);
	});
	it("shows a trick every few seconds: a smile, a look at the member, a twirl, higher throws", () => {
		const seen = new Set<string>();
		for (const seed of [0, 1, 2, 3, 4, 5, 6, 7]) {
			for (const t of samples(0, 24, 0.02)) {
				const act = working(t, seed);
				if (act.eyes![0].smile === 1) seen.add("smile");
				if (act.eyes![0].alpha === 0) seen.add("twirl");
				if (Math.min(...act.props!.map((star) => star.y)) < -4) seen.add("high");
				if (t > 2 && Math.abs(act.eyes![0].y) < 0.02 && act.eyes![0].smile === 0 && act.eyes![0].alpha === 1)
					seen.add("check");
			}
		}
		expect([...seen].sort()).toEqual(["check", "high", "smile", "twirl"]);
		// Agents differ in what they show when.
		const shows = (seed: number) =>
			samples(0, 30, 0.25)
				.map((t) => working(t, seed))
				.map((act) => `${act.eyes![0].smile > 0.5}${act.eyes![0].alpha < 0.5}${Math.round(act.body.y)}`)
				.join();
		expect(new Set([1, 2, 3, 4].map(shows)).size).toBeGreaterThan(1);
	});
	it("catches its stars and becomes its ask for a moment when something also waits on the member", () => {
		const symbols = (ask?: "question" | "bang") =>
			new Set(samples(0, 30, 0.02).map((t) => working(t, 2, ask).symbol ?? "figure"));
		expect(symbols()).toEqual(new Set(["figure"]));
		expect(symbols("question")).toEqual(new Set(["figure", "question"]));
		expect(symbols("bang")).toEqual(new Set(["figure", "bang"]));
		// The stars are away before it changes, and out again after.
		const asks = samples(0, 12, 0.02).find((t) => working(t, 2, "bang").symbol)!;
		expect(working(16 * BEAT - 0.05, 2, "bang").props!.every((star) => star.scale < 0.05)).toBe(true);
		expect(working(asks, 2, "bang").props).toBeUndefined();
		expect(working(11.6 + 3 * BEAT, 2, "bang").props!.some((star) => star.scale > 0.5)).toBe(true);
	});
	it("sets off dust where a twirl lands and stars as it becomes its ask, each once", () => {
		for (const ask of [undefined, "bang"] as const) {
			const whole = workingCues(0, 60, 4, ask);
			let framed = 0;
			for (let frame = 0; frame < 60 * 60; frame++)
				framed += workingCues(frame / 60, (frame + 1) / 60, 4, ask).length;
			expect(framed).toBe(whole.length);
			expect(new Set(whole.map((cue) => cue.effect))).toEqual(new Set(ask ? ["dust", "pop"] : ["dust"]));
		}
		// The dust of a twirl is where the twirl comes down.
		const seed = [0, 1, 2, 3, 4, 5, 6, 7].find((each) => workingCues(0, 8 * BEAT, each).length)!;
		const landing = workingCues(0, 8 * BEAT, seed)[0]!.at;
		expect(working(landing - 0.15, seed).body.y).toBeLessThan(-4);
	});
	it("rests looking up at its three stars for a member who wants no motion", () => {
		const still = workingStill();
		expect(still.body).toBe(REST);
		expect(still.eyes![0].y).toBeLessThan(0);
		expect(still.props!.map((star) => star.scale)).toEqual([1, 1, 1]);
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
