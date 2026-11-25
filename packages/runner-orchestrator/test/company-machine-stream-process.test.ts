import { afterEach, describe, expect, it, vi } from "vitest";
import { STREAM_SIZE } from "../src/company-machine-stream.ts";
import {
	DESKTOP_STREAM_MEMBERS,
	DESKTOP_STREAM_MESSAGE_BYTES,
	type DesktopStreamTurn,
	InstanceDesktop,
} from "../src/company-machine-stream-process.ts";
import { message } from "./fixtures/desktop-stream-plan.ts";
import {
	type CleanupList,
	fixture,
	frameOf,
	gate,
	instances as instancesWith,
	LOOP_CLOCK_MS,
	mainLoopWhile,
	played as playedWith,
	rawRect,
	sinkOf,
	sleep,
	spec,
	tcpDesktop as tcpDesktopWith,
	update,
	withinBudget,
} from "./helpers/desktop-stream-test-helpers.ts";

// A desktop's live picture watched in a process of its own (the lead's decision after review r11 of #1746): the
// executor's side speaks frames with an instance it never trusts, and holds it back by not reading. Here each
// connection starts the instance program as a child process with the connection as its standard input, as systemd's
// `qorpera-desktop-stream.socket` (Accept=yes) starts `qorpera-desktop-stream@.service`; the cgroup limits are the
// kernel's and are proved on a real systemd (POINTER-PROGRESS.md).

const cleanups: CleanupList = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const instances = (program: string) => instancesWith(cleanups, program);
const played = (reads: boolean) => playedWith(cleanups, reads);
const tcpDesktop = (width = 64, height = 40) => tcpDesktopWith(cleanups, width, height);

describe("a desktop watched in a process of its own (the lead's decision after review r11 of #1746)", () => {
	it("lets go to a member only what changed before that member's cycle began, through the instance", async () => {
		const desktop = await tcpDesktop();
		const { watched, started } = await instances(fixture(""));
		const { desktop: watching } = watched(`tcp:${desktop.port}`);
		const sink = sinkOf();
		const { release, asked } = gate();
		const stop = new AbortController();
		const ending = watching.watch(release, sink, stop.signal);
		await vi.waitFor(() => expect(asked).toHaveLength(1));
		asked[0]!.resolve("ok");
		await vi.waitFor(() => expect(sink.types()).toEqual([STREAM_SIZE]));
		await desktop.send(update(rawRect(0, 0, 64, 40, [255, 0, 0])));
		await vi.waitFor(() => expect(asked).toHaveLength(2));
		// While that cycle runs, an area turns green: it changed after the cycle began, and is not let go with it.
		await desktop.send(update(rawRect(4, 4, 8, 8, [0, 255, 0])));
		await sleep(50);
		asked[1]!.resolve("ok");
		await vi.waitFor(() => expect(sink.areas()).toEqual([["0,0 64x40 #ff0000"]]));
		await vi.waitFor(() => expect(asked).toHaveLength(3));
		asked[2]!.resolve("ok");
		await vi.waitFor(() => expect(sink.areas()).toEqual([["0,0 64x40 #ff0000"], ["4,4 8x8 #00ff00"]]));
		// The member closes it: closed at once, and the last member takes the instance with it, its process gone.
		const closedAt = performance.now();
		stop.abort();
		expect(await ending).toBe("closed");
		expect(watching.ended).toBe("idle");
		const exited = await started[0]!.exited;
		expect(exited.code).toBe(0);
		expect(exited.at - closedAt).toBeLessThan(1000);
	});

	it("ends a member on its release check's refusal, and every member with the relay's end", async () => {
		const desktop = await tcpDesktop();
		const { watched } = await instances(fixture(""));
		const { desktop: watching } = watched(`tcp:${desktop.port}`);
		const refused = gate();
		const kept = gate();
		const one = watching.watch(refused.release, sinkOf(), new AbortController().signal);
		const two = watching.watch(kept.release, sinkOf(), new AbortController().signal);
		await vi.waitFor(() => expect(refused.asked).toHaveLength(1));
		refused.asked[0]!.resolve({ end: "DESKTOP_HELD_SINCE" });
		expect(await one).toBe("DESKTOP_HELD_SINCE");
		expect(watching.ended).toBeNull();
		await vi.waitFor(() => expect(kept.asked).toHaveLength(1));
		kept.asked[0]!.resolve("ok");
		await desktop.end();
		expect(await two).toBe("DESKTOP_ENDED");
		expect(watching.cause).toMatch(/^its relay ended DESKTOP_ENDED/);
	});

	it("is refused cleanly by an instance of another program version", async () => {
		const { watched, started } = await instances(fixture(""));
		const { desktop } = watched("tcp:1", { version: "another-version" });
		expect(await desktop.watch(async () => "ok", sinkOf(), new AbortController().signal)).toBe("STREAM_UNAVAILABLE");
		expect(desktop.cause).toBe("its relay ended STREAM_UNAVAILABLE (another program version)");
		expect((await started[0]!.exited).code).toBe(0);
	});

	it("takes at most DESKTOP_STREAM_MEMBERS members a desktop, and refuses one more STREAM_BUSY", async () => {
		const desktop = await tcpDesktop();
		const { watched } = await instances(fixture(""));
		const { desktop: watching } = watched(`tcp:${desktop.port}`);
		const never = () => new Promise<"ok">(() => {});
		for (let n = 0; n < DESKTOP_STREAM_MEMBERS; n++)
			void watching.watch(never, sinkOf(), new AbortController().signal);
		expect(await watching.watch(never, sinkOf(), new AbortController().signal)).toBe("STREAM_BUSY");
		expect(watching.ended).toBeNull();
	});

	for (const [mode, cause] of [
		["flood", "a send without a released cycle"],
		["oversized", "a frame too large"],
		["unknown", "a frame of no known type"],
		["stranger", "a frame for no member it was given"],
		["die", "its process ended"],
	] as const)
		it(`ends an instance that does what a correct one never does (${mode}), and every member's stream with it`, async () => {
			const { watched } = await instances(fixture("-hostile"));
			const { desktop, endings } = watched(mode);
			const sink = sinkOf();
			const one = desktop.watch(async () => "ok", sink, new AbortController().signal);
			const two = desktop.watch(async () => "ok", sinkOf(), new AbortController().signal);
			expect(await Promise.all([one, two])).toEqual(["STREAM_UNAVAILABLE", "STREAM_UNAVAILABLE"]);
			expect(sink.send).not.toHaveBeenCalled();
			expect(desktop.cause).toBe(cause);
			expect(endings()).toBe(1);
		});

	it("ends an instance that stops answering while main reads", async () => {
		const { watched } = await instances(fixture("-hostile"));
		const { desktop } = watched("silent", { pingEveryMs: 50, pongWithinMs: 400 });
		const began = Date.now();
		expect(await desktop.watch(async () => "ok", sinkOf(), new AbortController().signal)).toBe("STREAM_UNAVAILABLE");
		expect(Date.now() - began).toBeLessThan(5000);
		expect(desktop.cause).toBe("no answer to its pings");
	});

	it("ends an instance that sends pongs nobody asked for: no frame is free", async () => {
		const { watched } = await instances(fixture("-hostile"));
		const { desktop } = watched("chatter", { pingEveryMs: 100, pongWithinMs: 1500 });
		const result = await mainLoopWhile(async () => {
			expect(await desktop.watch(async () => "ok", sinkOf(), new AbortController().signal)).toBe(
				"STREAM_UNAVAILABLE",
			);
		});
		expect(desktop.cause).toBe("a pong it was not asked for");
		expect(result.longest).toBeLessThan(LOOP_CLOCK_MS);
	});

	for (const [mode, messages] of [
		["overcycle", 3],
		["overbytes", 35],
	] as const)
		it(`lets one ok through for one cycle only, by count and by bytes, and ends an instance that sends on (${mode})`, async () => {
			const { watched } = await instances(fixture("-hostile"));
			const { desktop } = watched(mode);
			const sink = sinkOf();
			const result = await mainLoopWhile(async () => {
				expect(await desktop.watch(async () => "ok", sink, new AbortController().signal)).toBe(
					"STREAM_UNAVAILABLE",
				);
			});
			// What one cycle can send at most went through (CYCLE_MESSAGES, CYCLE_BYTES); the next ended it.
			expect(sink.send).toHaveBeenCalledTimes(messages);
			expect(desktop.cause).toBe("more for one ok than one cycle can send");
			expect(result.longest).toBeLessThan(LOOP_CLOCK_MS);
		}, 30_000);

	it("lets a member go on main's side with what a correct instance can still have on its way, and nothing more", async () => {
		const desktop = await tcpDesktop();
		const { watched } = await instances(fixture(""));
		const { desktop: watching } = watched(`tcp:${desktop.port}`);
		const stays = sinkOf();
		const leaving = new AbortController();
		const kept = gate();
		void watching.watch(async () => "ok", stays, new AbortController().signal);
		// The leaving member's cycle is under way when it leaves: its verdict never comes, its DONE does.
		const left = watching.watch(kept.release, sinkOf(), leaving.signal);
		await vi.waitFor(() => expect(kept.asked).toHaveLength(1));
		leaving.abort();
		expect(await left).toBe("closed");
		await desktop.send(update(rawRect(0, 0, 64, 40, [1, 2, 3])));
		await vi.waitFor(() => expect(stays.areas().length).toBeGreaterThan(0));
		expect(watching.ended).toBeNull();
	});

	for (const [mode, cause] of [
		["lingerer", "more of a member than could be on its way after it left"],
		["doubledone", "a frame for a member already done"],
	] as const)
		it(`ends an instance that goes on with a member it was told to let go of (${mode})`, async () => {
			const { watched } = await instances(fixture("-hostile"));
			const { desktop } = watched(mode);
			const stays = desktop.watch(async () => "pending", sinkOf(), new AbortController().signal);
			const leaving = new AbortController();
			const asked = gate();
			const left = desktop.watch(asked.release, sinkOf(), leaving.signal);
			await vi.waitFor(() => expect(asked.asked).toHaveLength(1));
			leaving.abort();
			expect(await left).toBe("closed");
			expect(await stays).toBe("STREAM_UNAVAILABLE");
			expect(desktop.cause).toBe(cause);
		});

	it("refuses a newcomer STREAM_BUSY, and ends nothing, while as many members let go of as may wait for their DONE have not had it", async () => {
		const { watched } = await instances(fixture("-hostile"));
		const { desktop } = watched("nodone");
		void desktop.watch(async () => "pending", sinkOf(), new AbortController().signal);
		const answers: string[] = [];
		for (let n = 0; n < 16; n++) {
			const leaving = new AbortController();
			const left = desktop.watch(async () => "pending", sinkOf(), leaving.signal);
			await sleep(10);
			leaving.abort();
			answers.push(await left);
		}
		expect(answers).toEqual(Array.from({ length: 16 }, () => "closed"));
		// Sixteen let go of and no DONE yet (a correct instance whose loop is held could be there): a delay, not an end.
		expect(await desktop.watch(async () => "pending", sinkOf(), new AbortController().signal)).toBe("STREAM_BUSY");
		expect(desktop.ended).toBeNull();
	});

	it("ends an instance that does not read what it is sent, past MAX_UNREAD_BYTES waiting in main", async () => {
		// The instance played by the test, on a socket it never reads: whatever main writes waits.
		const instance = await played(false);
		const desktop = new InstanceDesktop(instance.path, spec("deaf"), () => {}, {
			version: "test-version",
			maxUnreadBytes: 1024,
			releaseGapMs: 0,
		});
		cleanups.push(() => desktop.close());
		let asked = 0;
		const ending = desktop.watch(
			async () => {
				asked++;
				return "pending";
			},
			sinkOf(),
			new AbortController().signal,
		);
		await instance.write(frameOf(16, 0));
		// It asks and asks, never reading the verdicts: each is written, and waits (in the kernel's buffer, then in main).
		for (let n = 0; n < 20_000 && desktop.ended === null; n++) {
			const before = asked;
			await instance.write(frameOf(17, 1));
			while (asked === before && desktop.ended === null) await new Promise((resolve) => setImmediate(resolve));
		}
		expect(await ending).toBe("STREAM_UNAVAILABLE");
		expect(desktop.cause).toBe("it does not read what it is sent");
	}, 60_000);

	it("never ends an instance for main's own lateness: a pong already in the socket is read first", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		try {
			let clock = 0;
			const ticks = (ms: number) => {
				clock += ms;
				vi.advanceTimersByTime(ms);
			};
			const late = await played(true);
			const desktop = new InstanceDesktop(late.path, spec("late"), () => {}, {
				version: "test-version",
				now: () => clock,
			});
			cleanups.push(() => desktop.close());
			void desktop.watch(async () => "pending", sinkOf(), new AbortController().signal);
			await late.write(frameOf(16, 0));
			await sleep(50);
			// The first ping at 5 s; then main's own loop is held 20 s, and its next tick comes 15 s late, with the pong
			// waiting in the socket.
			ticks(5000);
			clock += 15_000;
			ticks(5000);
			expect(desktop.ended).toBeNull();
			await late.write(frameOf(21, 0));
			await sleep(50);
			ticks(5000);
			expect(desktop.ended).toBeNull();
			// And one that does not answer while main reads on time is ended at 15 s.
			const silent = await played(true);
			const quiet = new InstanceDesktop(silent.path, spec("quiet"), () => {}, {
				version: "test-version",
				now: () => clock,
			});
			cleanups.push(() => quiet.close());
			void quiet.watch(async () => "pending", sinkOf(), new AbortController().signal);
			await silent.write(frameOf(16, 0));
			await sleep(50);
			for (let n = 0; n < 4; n++) ticks(5000);
			expect(quiet.ended).toBeNull();
			ticks(5000);
			expect(quiet.cause).toBe("no answer to its pings");
		} finally {
			vi.useRealTimers();
		}
	});

	it("takes a largest message a byte a write through to a sink within every turn's budget, holding one payload, the loop free (the reviewer's scenario)", async () => {
		const turns: DesktopStreamTurn[] = [];
		const { watched } = await instances(fixture("-pieces"));
		const { desktop } = watched("fragment", { observe: (turn) => turns.push(turn) });
		const sink = sinkOf();
		const result = await mainLoopWhile(async () => {
			void desktop.watch(async () => "ok", sink, new AbortController().signal);
			await vi.waitFor(() => expect(sink.messages).toHaveLength(1), { timeout: 60_000, interval: 50 });
		});
		expect(sink.messages[0]!.equals(message(1, 0, DESKTOP_STREAM_MESSAGE_BYTES))).toBe(true);
		withinBudget(turns);
		expect(result.longest).toBeLessThan(LOOP_CLOCK_MS);
		expect(desktop.ended).toBeNull();
	}, 90_000);
});
