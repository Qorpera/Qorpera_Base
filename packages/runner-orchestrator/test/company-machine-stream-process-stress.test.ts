import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STREAM_RECTS, STREAM_SIZE } from "../src/company-machine-stream.ts";
import {
	DESKTOP_STREAM_DRIP_MS,
	DESKTOP_STREAM_GUARD_MS,
	DESKTOP_STREAM_SECOND_BYTES,
	DESKTOP_STREAM_SECOND_UNITS,
	type DesktopStreamTurn,
} from "../src/company-machine-stream-process.ts";
import {
	type CleanupList,
	fixture,
	instances as instancesWith,
	LOOP_CLOCK_MS,
	mainLoopWhile,
	noiseRect,
	rawRect,
	sinkOf,
	sleep,
	tcpDesktop as tcpDesktopWith,
	update,
	withinBudget,
} from "./helpers/desktop-stream-test-helpers.ts";

const cleanups: CleanupList = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const instances = (program: string) => instancesWith(cleanups, program);
const tcpDesktop = (width = 64, height = 40) => tcpDesktopWith(cleanups, width, height);

describe("a desktop watched in a process of its own — seeded and stress guards", () => {
	for (const seed of [11, 4242, 90_210])
		it(`stands guard over main's side: the REAL DesktopStream of a seeded desktop, its frames in random pieces with long runs of 1-byte pieces, through main's rules (seed ${seed})`, async () => {
			const turns: DesktopStreamTurn[] = [];
			const dir = mkdtempSync(join(tmpdir(), "desktop-stream-real-"));
			cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
			const file = join(dir, "sent");
			writeFileSync(file, "");
			const { watched } = await instances(fixture("-real"));
			const { desktop } = watched(`${seed}:${file}`, { observe: (turn) => turns.push(turn) });
			const sinks = [sinkOf(), sinkOf(), sinkOf()];
			const result = await mainLoopWhile(async () => {
				for (const sink of sinks) void desktop.watch(async () => "ok", sink, new AbortController().signal);
				let last = -1;
				for (;;) {
					await sleep(1000);
					const written = readFileSync(file, "utf8").split("\n").filter(Boolean).length;
					const arrived = sinks.reduce((sum, sink) => sum + sink.messages.length, 0);
					if (written === arrived && written === last) break;
					last = written;
				}
			});
			const sent = readFileSync(file, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => line.split(" "));
			expect(sent.length).toBeGreaterThan(20);
			sinks.forEach((sink, n) => {
				const mine = sent.filter(([member]) => Number(member) === n + 1);
				expect(sink.messages.map((one) => createHash("sha256").update(one).digest("hex"))).toEqual(
					mine.map(([, hash]) => hash),
				);
			});
			withinBudget(turns);
			expect(result.longest).toBeLessThan(LOOP_CLOCK_MS);
			expect(desktop.ended).toBeNull();
		}, 120_000);

	it("takes no more than its budget of bytes a second from an instance offering every large send one ok allows, the loop free, nothing ended", async () => {
		const turns: DesktopStreamTurn[] = [];
		const { watched } = await instances(fixture("-pieces"));
		const { desktop } = watched("bigflood", { observe: (turn) => turns.push(turn) });
		const sinks = Array.from({ length: 4 }, () => sinkOf());
		const began = performance.now();
		const result = await mainLoopWhile(async () => {
			for (const sink of sinks) void desktop.watch(async () => "ok", sink, new AbortController().signal);
			await sleep(3000);
		});
		const seconds = (performance.now() - began) / 1000;
		const bytes = turns.reduce((sum, turn) => sum + turn.bytes, 0);
		expect(bytes).toBeLessThanOrEqual((Math.ceil(seconds) + 1) * DESKTOP_STREAM_SECOND_BYTES);
		expect(bytes).toBeGreaterThan(DESKTOP_STREAM_SECOND_BYTES);
		expect(turns.reduce((sum, turn) => sum + turn.units, 0)).toBeLessThanOrEqual(
			(Math.ceil(seconds) + 1) * DESKTOP_STREAM_SECOND_UNITS,
		);
		withinBudget(turns);
		expect(result.longest).toBeLessThan(LOOP_CLOCK_MS);
		expect(desktop.ended).toBeNull();
	}, 30_000);

	it("lets one ok through for one cycle at every send: three small messages pass, a fourth ends the instance", async () => {
		const { watched } = await instances(fixture("-pieces"));
		const { desktop: allowed } = watched("smallflood");
		const sinks = Array.from({ length: 8 }, () => sinkOf());
		for (const sink of sinks) void allowed.watch(async () => "ok", sink, new AbortController().signal);
		await sleep(1500);
		expect(allowed.ended).toBeNull();
		expect(sinks.reduce((sum, sink) => sum + sink.messages.length, 0)).toBeGreaterThan(100);
		allowed.close();
		const { desktop: fourth } = watched("fourth");
		const sink = sinkOf();
		expect(await fourth.watch(async () => "ok", sink, new AbortController().signal)).toBe("STREAM_UNAVAILABLE");
		expect(sink.messages).toHaveLength(3);
		expect(fourth.cause).toBe("more for one ok than one cycle can send");
	});

	it("lets the real stream's largest cycles through, by bytes and by areas", async () => {
		const desktop = await tcpDesktop(3840, 2160);
		const { watched } = await instances(fixture(""));
		const { desktop: watching } = watched(`tcp:${desktop.port}`);
		const sink = sinkOf();
		let gate: Promise<void> | null = null;
		let open = () => {};
		const close = () => {
			gate = new Promise<void>((resolve) => {
				open = resolve;
			});
		};
		const release = async () => {
			if (gate) await gate;
			return "ok" as const;
		};
		const settled = async () => {
			let last = -1;
			while (sink.messages.length !== last) {
				last = sink.messages.length;
				await sleep(700);
			}
		};
		close();
		const ending = watching.watch(release, sink, new AbortController().signal);
		await desktop.send(update(...Array.from({ length: 30 }, (_, band) => noiseRect(0, band * 72, 3840, 72))));
		await sleep(1500);
		gate = null;
		open();
		await settled();
		const large = sink.messages.length;
		expect({ cause: watching.cause, end: await Promise.race([ending, sleep(10).then(() => "")]) }).toEqual({
			cause: null,
			end: "",
		});
		expect(large).toBeGreaterThan(20);
		close();
		await sleep(200);
		for (let n = 0; n < 2000; n++)
			await desktop.send(update(rawRect(n % 3840, Math.floor(n / 3840), 1, 1, [n & 0xff, 1, 2])));
		await sleep(1500);
		gate = null;
		open();
		await settled();
		expect(sink.messages.length).toBeGreaterThan(large);
		expect(watching.ended).toBeNull();
	}, 60_000);

	it("keeps nothing alive for a stalled member but what its own sink holds: small messages between another member's large ones", async () => {
		const kept: Buffer[] = [];
		let keptBytes = 0;
		const stalled = {
			send: async (message: Buffer) => {
				kept.push(message);
				keptBytes += message.byteLength;
				if (kept.length > 16 || keptBytes > 2 * 1024 * 1024) await new Promise<void>(() => {});
			},
		};
		setFlagsFromString("--expose-gc");
		const collect = runInNewContext("gc") as () => void;
		const memory = () => {
			collect();
			const usage = process.memoryUsage();
			return usage.heapUsed + usage.external;
		};
		const { watched } = await instances(fixture("-pieces"));
		const { desktop } = watched("pinner");
		let taken = 0;
		const fast = {
			send: async () => {
				taken++;
			},
		};
		void desktop.watch(async () => "ok", stalled, new AbortController().signal);
		void desktop.watch(async () => "ok", fast, new AbortController().signal);
		await sleep(1000);
		const before = memory();
		await sleep(4_000);
		const after = memory();
		expect(taken).toBeGreaterThan(50);
		expect(kept.length).toBeLessThanOrEqual(17);
		expect(after - before).toBeLessThan(32 * 1024 * 1024);
		expect(desktop.ended).toBeNull();
	}, 60_000);

	it("changes nothing when the wall clock steps back an hour", async () => {
		const desktop = await tcpDesktop();
		const { watched } = await instances(fixture(""));
		const { desktop: watching } = watched(`tcp:${desktop.port}`);
		const sink = sinkOf();
		void watching.watch(async () => "ok", sink, new AbortController().signal);
		await vi.waitFor(() => expect(sink.types()).toContain(STREAM_SIZE));
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.setSystemTime(Date.now() - 3_600_000);
			for (let n = 0; n < 20; n++) {
				await desktop.send(update(rawRect(0, 0, 8, 8, [n, 0, 0])));
				await sleep(40);
			}
			await vi.waitFor(() => expect(sink.areas().length).toBeGreaterThan(10), { timeout: 5000 });
			expect(watching.ended).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("reads a drip a few times a second at most: a byte a write costs main no more than 1000 / DESKTOP_STREAM_DRIP_MS reads a second", async () => {
		const turns: DesktopStreamTurn[] = [];
		const { watched } = await instances(fixture("-pieces"));
		const { desktop } = watched("drip", { observe: (turn) => turns.push(turn) });
		void desktop.watch(async () => "ok", sinkOf(), new AbortController().signal);
		await sleep(500);
		const from = turns.length;
		const began = performance.now();
		await sleep(2000);
		const seconds = (performance.now() - began) / 1000;
		const reads = turns.slice(from).reduce((sum, turn) => sum + turn.reads, 0);
		expect(reads).toBeGreaterThan(50);
		expect(reads / seconds).toBeLessThanOrEqual(1000 / DESKTOP_STREAM_DRIP_MS + 20);
		expect(desktop.ended).toBeNull();
	}, 30_000);

	it("smokes the units as the release does: another version refused, its own taken and ended by its relay; a unit of another file named", async () => {
		const smoke = new URL("../../../deploy/coding-worker/desktop-stream-smoke.mjs", import.meta.url).pathname;
		const { path } = await instances(fixture("-versioned"));
		const run = (program: string, socket = path) =>
			new Promise<{ stdout: string; status: number | null }>((resolve) => {
				const child = spawn(process.execPath, [smoke, socket, program], { stdio: ["ignore", "pipe", "inherit"] });
				let stdout = "";
				child.stdout.on("data", (piece: Buffer) => {
					stdout += piece.toString("utf8");
				});
				child.on("close", (status) => resolve({ stdout, status }));
			});
		const ok = await run(fixture("-versioned"));
		expect(ok.stdout.trim().split("\n")).toEqual([
			"step 1: another version refused: ENDED STREAM_UNAVAILABLE (another program version), closed",
			"step 2: its own version taken: READY",
			"step 2: its relay to a machine that is not there ended it: ENDED STREAM_UNAVAILABLE (Instance not found), closed",
			"STREAM UNITS SMOKE OK",
		]);
		expect(ok.status).toBe(0);
		const other = await run(fixture(""));
		expect(other.stdout.trim().split("\n").at(-1)).toBe(
			`STREAM UNITS SMOKE FAILED: step 2: the instance runs another program than ${fixture("")}: the stream unit's ExecStart and the executor's must name one file`,
		);
		expect(other.status).toBe(1);
		const nowhere = await run(fixture("-versioned"), `${path}.missing`);
		expect(nowhere.stdout.trim()).toBe(`STREAM UNITS SMOKE FAILED: cannot reach ${path}.missing: ENOENT`);
		expect(nowhere.status).toBe(1);
	}, 60_000);

	it("holds back, never ends, an instance whose releases come early (two clocks): each is asked no sooner than 25 ms after the last", async () => {
		const { watched } = await instances(fixture("-hostile"));
		const { desktop } = watched("eager");
		const asked: number[] = [];
		void desktop.watch(
			async () => {
				asked.push(performance.now());
				return "pending";
			},
			sinkOf(),
			new AbortController().signal,
		);
		await sleep(1000);
		expect(desktop.ended).toBeNull();
		expect(asked.length).toBeGreaterThan(15);
		expect(asked.length).toBeLessThanOrEqual(41);
		const gaps = asked.slice(1).map((at, n) => at - (asked[n] as number));
		expect(Math.min(...gaps)).toBeGreaterThanOrEqual(24);
	});

	it("keeps the executor's loop free while a desktop sends a whole 3840 x 2160 screen one byte at a time (the reviewer's scenario)", async () => {
		const { watched } = await instances(fixture(""));
		const { desktop } = watched("bytes");
		const sink = sinkOf();
		const stop = new AbortController();
		let ending: Promise<string> = Promise.resolve("");
		const result = await mainLoopWhile(async () => {
			ending = desktop.watch(async () => "ok", sink, stop.signal);
			await sleep(4000);
		});
		expect(desktop.ended).toBeNull();
		expect(sink.types()).toEqual([STREAM_SIZE]);
		expect(result.longest).toBeLessThan(LOOP_CLOCK_MS);
		expect(result.heapGrowth).toBeLessThan(16 * 1024 * 1024);
		stop.abort();
		expect(await ending).toBe("closed");
	}, 30_000);

	it("leaves nothing on a member's signal from one release cycle to the next, however many there are", async () => {
		const desktop = await tcpDesktop();
		const dir = mkdtempSync(join(tmpdir(), "desktop-stream-held-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const file = join(dir, "held");
		const { watched } = await instances(fixture(""));
		const { desktop: watching } = watched(`tcp:${desktop.port}:${file}`);
		const sink = sinkOf();
		const stop = new AbortController();
		const ending = watching.watch(async () => "ok", sink, stop.signal);
		await vi.waitFor(() => expect(sink.types()).toContain(STREAM_SIZE));
		await sleep(300);
		const before = Number(readFileSync(file, "utf8"));
		for (let n = 0; n < 120; n++) {
			await desktop.send(update(rawRect(0, 0, 8, 8, [n, 0, 0])));
			await sleep(25);
		}
		await sleep(300);
		expect(sink.types().filter((type) => type === STREAM_RECTS).length).toBeGreaterThan(40);
		expect(Number(readFileSync(file, "utf8")) - before).toBeLessThan(5);
		stop.abort();
		expect(await ending).toBe("closed");
	}, 30_000);

	it("an instance stuck in its own loop is ended by its guard once its connection is closed, whatever that loop does", async () => {
		const { watched, started } = await instances(fixture(""));
		const { desktop } = watched("spin", { pingEveryMs: 100, pongWithinMs: 1000 });
		expect(await desktop.watch(async () => "ok", sinkOf(), new AbortController().signal)).toBe("STREAM_UNAVAILABLE");
		expect(desktop.cause).toBe("no answer to its pings");
		const closedAt = performance.now();
		const exited = await started[0]!.exited;
		expect(exited.signal).toBe("SIGKILL");
		expect(exited.at - closedAt).toBeLessThan(2 * DESKTOP_STREAM_GUARD_MS);
	}, 30_000);
});
