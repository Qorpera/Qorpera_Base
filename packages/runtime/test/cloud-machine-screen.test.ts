import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	MACHINE_SCREEN_ACTION_TAKEN_EXIT,
	MACHINE_SCREEN_KILL_MS,
	MACHINE_SCREEN_STEP_MS,
	MACHINE_SCREEN_XDOTOOL_COMMANDS,
	type MachineScreenPorts,
	type MachineScreenRun,
	machineScreen,
	machineScreenActionCommand,
	machineScreenDesktopArgs,
	parseMachineScreenAction,
	parseMachineScreenHeader,
	runMachineScreenCli,
} from "@qorpera/runtime/cloud-machine-screen";
import { describe, expect, it, vi } from "vitest";

// 20260930708000: machine_screen's helper on a company machine takes at most one desktop action through `desktop`
// (a fixed argv, never a shell), at most once per receipt on a boot, waits, takes a screenshot and prints one header
// line and the PNG. The desktop and scrot are mocked here; deploy/machine/build-machine-image.sh checks the real ones
// on the image.

const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000640000003e8", "hex");
const DESKTOP = "/usr/local/bin/desktop";
const SYSTEMD_RUN = "/usr/bin/systemd-run";
/** The desktop command a transient unit's argv runs (after `--` and the desktop's path), and its RuntimeMaxSec. */
const unit = (args: readonly string[]) => {
	const end = args.indexOf("--");
	const limit = args.find((arg) => arg.startsWith("RuntimeMaxSec="))?.slice("RuntimeMaxSec=".length);
	return { options: args.slice(0, end), command: args.slice(end + 1), limit };
};
const done = (code: number | null = 0, stdout = "", stderr = ""): MachineScreenRun => ({
	code,
	stdout: Buffer.from(stdout),
	stderr,
});

/** A machine whose desktop runs (or not), whose `desktop` commands answer `answers` by verb, and whose markers are kept
 * in memory as /run keeps them for a boot. Every call is recorded. */
function machine(
	options: {
		running?: boolean;
		start?: MachineScreenRun;
		answers?: Record<string, MachineScreenRun>;
		/** Runs while a `desktop` action command runs: the tests move the clock in it. */
		during?: (args: readonly string[]) => void;
		windows?: string;
		active?: MachineScreenRun;
		shot?: Buffer | null;
	} = {},
) {
	let running = options.running ?? true;
	const marks = new Set<string>();
	const runs: { file: string; args: readonly string[]; timeoutMs: number }[] = [];
	const sleeps: number[] = [];
	const shots: number[] = [];
	let touched = 0;
	const ports: MachineScreenPorts = {
		run: vi.fn(async (file: string, args: readonly string[], timeoutMs: number) => {
			runs.push({ file, args: [...args], timeoutMs });
			// An action's command runs as a transient unit: `systemd-run ... -p RuntimeMaxSec=<s> ... -- desktop <args>`.
			if (file === SYSTEMD_RUN) {
				const { command } = unit(args);
				if (command[0] !== DESKTOP) return done(125);
				options.during?.(command.slice(1));
				return options.answers?.[command[1] as string] ?? done();
			}
			if (file === DESKTOP && args[0] === "status")
				return done(0, running ? "running (1600x1000)\n0x01 0 m Inbox\n" : "stopped\n");
			if (file === DESKTOP && args[0] === "start") {
				const start = options.start ?? done(0, "desktop running on display :1 (1600x1000)\n");
				if (start.code === 0) running = true;
				return start;
			}
			if (file === DESKTOP) return done(126, "", "an action ran without its own deadline");
			if (file === "/usr/bin/wmctrl")
				return done(
					0,
					options.windows ??
						"0x01200003 -1 machine xfce4-panel\n0x01200004 -1 machine Desktop\n0x02000003  0 machine Sign in - Chromium\n",
				);
			if (file === "/usr/bin/xdotool") return options.active ?? done(0, "Sign in - Chromium\n");
			return done(127);
		}),
		mark: vi.fn(async (receiptId: string) => {
			if (marks.has(receiptId)) return false;
			marks.add(receiptId);
			return true;
		}),
		shoot: vi.fn(async (timeoutMs: number) => {
			shots.push(timeoutMs);
			return options.shot === undefined ? PNG : options.shot;
		}),
		touch: vi.fn(async () => {
			touched++;
		}),
		sleep: vi.fn(async (ms: number) => {
			sleeps.push(ms);
		}),
	};
	return {
		ports,
		runs,
		sleeps,
		shots,
		marks,
		get touched() {
			return touched;
		},
		/** The `desktop` commands that act, each in its unit: its argv, the unit's limit and the helper's backstop. */
		actions: () =>
			runs
				.filter((call) => call.file === SYSTEMD_RUN)
				.map((call) => ({
					args: unit(call.args).command.slice(1),
					seconds: unit(call.args).limit as string,
					timeoutMs: call.timeoutMs,
				})),
	};
}
const request = (fields: Record<string, unknown> = {}) => ({
	schema: "qorpera.machine-screen-request/v1",
	receiptId: null,
	action: null,
	settleMs: 500,
	look: true,
	...fields,
});
const action = (value: Record<string, unknown>, fields: Record<string, unknown> = {}) =>
	request({ receiptId: randomUUID(), action: value, ...fields });

describe("machine_screen's action shape", () => {
	it("takes each verb with exactly its own fields, in whole screen pixels", () => {
		for (const value of [
			{ type: "click", x: 0, y: 2159 },
			{ type: "click", x: 3839, y: 0, button: "right" },
			{ type: "double", x: 1, y: 1 },
			{ type: "move", x: 1, y: 1 },
			{ type: "drag", x: 1, y: 2, toX: 3, toY: 4 },
			{ type: "type", text: "Ærø\nline two\twith a tab" },
			{ type: "type", text: "a".repeat(500) },
			{ type: "key", keys: ["ctrl+l", "Return", "F5", "shift+Insert"] },
			{ type: "scroll", direction: "up" },
			{ type: "scroll", direction: "down", steps: 30, x: 5, y: 6 },
			{ type: "open", target: "https://example.test/sign-in?next=%2F" },
			{ type: "open", target: "file:///home/desktop/a%20b.pdf" },
			{ type: "open", target: "/company/site/index.html" },
			{ type: "open", target: "/home/desktop/Mit dokument.pdf" },
		])
			expect(parseMachineScreenAction(value), JSON.stringify(value)).toEqual(value);
	});

	it("refuses every other shape with words the agent can act on", () => {
		for (const [value, words] of [
			[null, "an object with a type"],
			[{ x: 1, y: 1 }, "one of click"],
			[{ type: "fly", x: 1, y: 1 }, "one of click"],
			[{ type: "click", x: 3840, y: 0 }, "x is a whole number of screen pixels from 0 to 3839"],
			[{ type: "click", x: 0, y: 2160 }, "y is a whole number of screen pixels from 0 to 2159"],
			[{ type: "click", x: -1, y: 0 }, "x is"],
			[{ type: "click", x: 1.5, y: 0 }, "x is"],
			[{ type: "click", x: "1", y: 0 }, "x is"],
			[{ type: "click", x: 1 }, "y is"],
			[{ type: "click", x: 1, y: 1, button: "back" }, "left, middle or right"],
			[{ type: "click", x: 1, y: 1, text: "a" }, "takes only type, x, y, button"],
			[{ type: "double", x: 1, y: 1, button: "left" }, "takes only"],
			[{ type: "drag", x: 1, y: 2, toX: 3 }, "toY is"],
			[{ type: "type", text: "" }, "1 to 500 characters"],
			[{ type: "type", text: "a".repeat(501) }, "1 to 500 characters"],
			[{ type: "type", text: "a\u0007b" }, "no control character"],
			[{ type: "type", text: `a${String.fromCharCode(0x2028)}b` }, "no control character"],
			[{ type: "key", keys: [] }, "1 to 16 key names"],
			[{ type: "key", keys: "Return" }, "1 to 16 key names"],
			[{ type: "key", keys: ["-x"] }, "1 to 16 key names"],
			[{ type: "key", keys: ["ctrl l"] }, "1 to 16 key names"],
			[{ type: "key", keys: Array.from({ length: 17 }, () => "a") }, "1 to 16 key names"],
			[{ type: "scroll", direction: "left" }, "up or down"],
			[{ type: "scroll", direction: "up", steps: 0 }, "1 to 30"],
			[{ type: "scroll", direction: "up", steps: 31 }, "1 to 30"],
			[{ type: "scroll", direction: "up", x: 4 }, "x and y together"],
			[{ type: "open", target: "-x" }, "an http(s) or file URL"],
			[{ type: "open", target: "javascript:alert(1)" }, "an http(s) or file URL"],
			[{ type: "open", target: "https://example.test/a b" }, "an http(s) or file URL"],
			[{ type: "open", target: "relative/path" }, "an http(s) or file URL"],
			[{ type: "open", target: `/${"a".repeat(2000)}` }, "at most 2000 characters"],
		] as const)
			expect(() => parseMachineScreenAction(value), JSON.stringify(value)).toThrow(words);
	});

	it("takes no xdotool command word as a key, in any case, as the database's call check (review r1 F2)", () => {
		// `xdotool key --delay 40 -- exec id` ran id as root on a real machine: xdotool runs a command that follows its keys.
		for (const keys of [["exec", "id"], ["EXEC", "id"], ["Return", "Sleep", "1"], ["windowKill"], ["type"], ["Help"]])
			expect(() => parseMachineScreenAction({ type: "key", keys }), keys.join()).toThrow("it is an xdotool command");
		// A key that only contains one is no command, and real keys stay keys.
		for (const keys of [["ctrl+exec"], ["Return"], ["ctrl+l", "Tab", "shift+Insert", "F5", "Escape"]])
			expect(parseMachineScreenAction({ type: "key", keys })).toEqual({ type: "key", keys });
		// xdotool 3.20160805.1's own list, the one the image installs, and the database's (20260930708000) the same.
		expect(MACHINE_SCREEN_XDOTOOL_COMMANDS).toHaveLength(44);
		expect(MACHINE_SCREEN_XDOTOOL_COMMANDS).toContain("exec");
		const migration = readFileSync(
			new URL("../../../supabase/migrations/20260930708000_machine_screen.sql", import.meta.url),
			"utf8",
		);
		const listed = /\n\tv_xdotool constant text\[\] := array\[([^\]]+)\];\n/.exec(migration)?.[1] ?? "";
		const words = [...listed.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
		expect([...words].sort()).toEqual([...MACHINE_SCREEN_XDOTOOL_COMMANDS].sort());
		expect(migration).toContain("or lower(key.value #>> '{}') = any (v_xdotool))");
	});

	it("drives `desktop` with a fixed argv per verb, the text as one argument", () => {
		expect(machineScreenDesktopArgs({ type: "click", x: 812, y: 443 })).toEqual([["click", "812", "443", "left"]]);
		expect(machineScreenDesktopArgs({ type: "click", x: 1, y: 2, button: "right" })).toEqual([
			["click", "1", "2", "right"],
		]);
		expect(machineScreenDesktopArgs({ type: "double", x: 1, y: 2 })).toEqual([["double", "1", "2"]]);
		expect(machineScreenDesktopArgs({ type: "move", x: 1, y: 2 })).toEqual([["move", "1", "2"]]);
		expect(machineScreenDesktopArgs({ type: "drag", x: 1, y: 2, toX: 3, toY: 4 })).toEqual([
			["drag", "1", "2", "3", "4"],
		]);
		// What `desktop` reads as its own words (--shot FILE) stays inside the one text argument.
		expect(machineScreenDesktopArgs({ type: "type", text: "a --shot /company/x.png; rm -rf /" })).toEqual([
			["type", "a --shot /company/x.png; rm -rf /"],
		]);
		expect(machineScreenDesktopArgs({ type: "key", keys: ["ctrl+l", "Return"] })).toEqual([
			["key", "ctrl+l", "Return"],
		]);
		expect(machineScreenDesktopArgs({ type: "scroll", direction: "down" })).toEqual([["scroll", "down", "3"]]);
		expect(machineScreenDesktopArgs({ type: "scroll", direction: "up", steps: 5, x: 7, y: 8 })).toEqual([
			["scroll", "up", "5", "7", "8"],
		]);
		expect(machineScreenDesktopArgs({ type: "open", target: "https://example.test/" })).toEqual([
			["open", "https://example.test/"],
		]);
	});
});

describe("machine_screen's helper", () => {
	it("starts a stopped desktop for a look, and shows the screen and its windows", async () => {
		const m = machine({ running: false });
		const output = await machineScreen(request(), m.ports);
		expect(output).toEqual({
			kind: "screen",
			header: {
				schema: "qorpera.machine-screen/v1",
				started: true,
				action: null,
				activeWindow: "Sign in - Chromium",
				// The desktop's own panel and background (desktop -1) are not windows of its programs.
				windows: ["Sign in - Chromium"],
				moreWindows: 0,
				png: PNG.length,
			},
			png: PNG,
		});
		expect(m.runs.filter((call) => call.file === DESKTOP).map((call) => call.args)).toEqual([["status"], ["start"]]);
		expect(m.runs.find((call) => call.args[0] === "start")?.timeoutMs).toBe(MACHINE_SCREEN_STEP_MS.start);
		expect(m.sleeps).toEqual([500]);
		expect(m.ports.mark).not.toHaveBeenCalled();
		expect(m.touched).toBe(1);
	});

	it("refuses an action on a stopped desktop before it marks or acts, and a machine too small for one", async () => {
		const stopped = machine({ running: false });
		expect(await machineScreen(action({ type: "click", x: 1, y: 1 }), stopped.ports)).toEqual({
			kind: "refused",
			code: "DESKTOP_NOT_RUNNING",
		});
		expect(stopped.runs.map((call) => call.args)).toEqual([["status"]]);
		expect(stopped.ports.mark).not.toHaveBeenCalled();
		const small = machine({ running: false, start: done(3, "", "this machine is too small for a desktop") });
		expect(await machineScreen(request(), small.ports)).toEqual({
			kind: "refused",
			code: "DESKTOP_MACHINE_TOO_SMALL",
		});
		for (const start of [done(1), done(null)]) {
			const failed = machine({ running: false, start });
			expect(await machineScreen(request(), failed.ports)).toEqual({
				kind: "refused",
				code: "DESKTOP_DID_NOT_START",
			});
			expect(failed.ports.shoot).not.toHaveBeenCalled();
		}
	});

	it("acts once per receipt, waits, and shows the screen after it", async () => {
		const m = machine();
		const click = action({ type: "click", x: 812, y: 443 }, { settleMs: 1200 });
		const output = await machineScreen(click, m.ports);
		expect(output).toMatchObject({
			kind: "screen",
			header: { started: false, action: { type: "click", exitCode: 0 }, png: PNG.length },
		});
		expect(m.actions()).toEqual([
			{
				args: ["click", "812", "443", "left"],
				seconds: expect.stringMatching(/^\d+\.\d{3}$/),
				timeoutMs: expect.any(Number),
			},
		]);
		// Its deadline is its own unit's, at most the action's; the helper's own kill comes a second after it.
		const [first] = m.actions();
		expect(Number(first!.seconds)).toBeGreaterThan(0);
		expect(Number(first!.seconds) * 1000).toBeLessThanOrEqual(MACHINE_SCREEN_STEP_MS.action);
		expect(first!.timeoutMs).toBe(Number(first!.seconds) * 1000 + MACHINE_SCREEN_KILL_MS);
		expect(unit(m.runs.find((call) => call.file === SYSTEMD_RUN)!.args).options).toEqual([
			"--quiet",
			"--wait",
			"--pipe",
			"--collect",
			"--expand-environment=no",
			"--slice=qorpera-machine.slice",
			"-p",
			`RuntimeMaxSec=${first!.seconds}`,
			"-p",
			"KillMode=control-group",
			"-p",
			"KillSignal=SIGKILL",
			"--setenv=DISPLAY=:1",
			"--setenv=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
			"--setenv=HOME=/root",
			"--setenv=LANG=C.UTF-8",
			"--setenv=USER=root",
		]);
		expect(m.sleeps).toEqual([1200]);
		// The same receipt again on this boot: nothing runs, nothing shows.
		expect(await machineScreen(click, m.ports)).toEqual({ kind: "taken" });
		expect(m.actions()).toHaveLength(1);
		expect(m.ports.shoot).toHaveBeenCalledTimes(1);
		// The marker is made before the action, so an action cut short is never taken again either.
		expect((m.ports.mark as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan(
			(m.ports.run as ReturnType<typeof vi.fn>).mock.invocationCallOrder[1]!,
		);
		const scroll = machine();
		await machineScreen(action({ type: "scroll", direction: "down", steps: 4, x: 10, y: 20 }), scroll.ports);
		expect(scroll.actions().map((call) => call.args)).toEqual([["scroll", "down", "4", "10", "20"]]);
	});

	it("tells a failed action's exit and the last line of its error, and still shows the screen", async () => {
		const m = machine({
			answers: {
				click: done(1, "", `xdotool: warning\n${"é".repeat(400)}\n`),
				scroll: done(2, "", "not a pixel position: 99999\n"),
			},
		});
		const failed = await machineScreen(action({ type: "click", x: 1, y: 1 }), m.ports);
		if (failed.kind !== "screen") throw new Error("no screen");
		expect(failed.header.action?.exitCode).toBe(1);
		expect(Buffer.byteLength(failed.header.action?.error ?? "")).toBeLessThanOrEqual(300);
		expect(failed.header.action?.error).toMatch(/^é+$/);
		expect(failed.png).toEqual(PNG);
		const scroll = await machineScreen(action({ type: "scroll", direction: "up", x: 1, y: 1 }), m.ports);
		expect(scroll).toMatchObject({
			header: { action: { type: "scroll", exitCode: 2, error: "not a pixel position: 99999" } },
		});
		expect(m.actions().map((call) => call.args[0])).toEqual(["click", "scroll"]);
		// Killed by the helper's own backstop: no exit, and no error of a killed command.
		const killed = machine({ answers: { type: done(null, "", "Killed") } });
		const output = await machineScreen(action({ type: "type", text: "hello" }), killed.ports);
		if (output.kind !== "screen") throw new Error("no screen");
		expect(output.header.action).toEqual({ type: "type", exitCode: null });
	});

	it("passes typed text to its unit as one argument, never expanded or read as an option (review r2 F4)", async () => {
		const text = `$HOME \${PATH} %n %% -x`;
		expect(machineScreenActionCommand("9.000", ["type", text]).args.slice(-4)).toEqual(["--", DESKTOP, "type", text]);
		const options = unit(machineScreenActionCommand("9.000", ["type", text]).args).options;
		expect(options).toContain("--expand-environment=no");
		expect(options.filter((option) => option.includes(text))).toEqual([]);
		const m = machine();
		await machineScreen(action({ type: "type", text: `-x ${text}` }), m.ports);
		expect(unit(m.runs.find((call) => call.file === SYSTEMD_RUN)!.args).command).toEqual([
			DESKTOP,
			"type",
			`-x ${text}`,
		]);
	});

	it("tells a command its unit's limit ended from one that failed, by the time it took (review r2 F4)", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.setSystemTime(1_800_000_000_000);
			// systemd-run answers 1 for both: a failure at or after the limit is the limit's, a sooner one is the command's.
			const limited = machine({
				answers: { type: done(1, "", "Job for run-u7.service failed") },
				during: () => vi.setSystemTime(Date.now() + 10_000),
			});
			const ended = await machineScreen(action({ type: "type", text: "hello" }), limited.ports);
			if (ended.kind !== "screen") throw new Error("no screen");
			expect(ended.header.action).toEqual({ type: "type", exitCode: null });
			const failed = machine({ answers: { type: done(1, "", "the desktop is not running: desktop start") } });
			const plain = await machineScreen(action({ type: "type", text: "hello" }), failed.ports);
			if (plain.kind !== "screen") throw new Error("no screen");
			expect(plain.header.action).toEqual({
				type: "type",
				exitCode: 1,
				error: "the desktop is not running: desktop start",
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("gives an action's commands one deadline kept by their units, the time left to each (review r2 F4)", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.setSystemTime(1_800_000_000_000);
			const single = machine();
			await machineScreen(action({ type: "scroll", direction: "down", x: 1, y: 2 }), single.ports);
			expect(single.actions().map((call) => [call.args, call.seconds, call.timeoutMs])).toEqual([
				[["scroll", "down", "3", "1", "2"], "10.000", 11000],
			]);
			const spent = machine({
				answers: { scroll: done(1, "", "Job for run-u9.service failed") },
				during: (args) => {
					if (args[0] === "scroll") vi.setSystemTime(Date.now() + 10000);
				},
			});
			expect(
				await machineScreen(action({ type: "scroll", direction: "up", x: 1, y: 2 }), spent.ports),
			).toMatchObject({
				header: { action: { type: "scroll", exitCode: null } },
			});
			expect(spent.actions().map((call) => call.args[0])).toEqual(["scroll"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("bounds the titles it tells, and shows no picture when not asked or when none was taken", async () => {
		const many = Array.from({ length: 20 }, (_, n) => `0x0${n} 0 m Window ${n}`).join("\n");
		const m = machine({ windows: `${many}\n0x99 0 m ${"t".repeat(130)}\n0x98 0 m a\u0007b`, active: done(1) });
		const output = await machineScreen(request({ look: false, settleMs: 0 }), m.ports);
		expect(output).toMatchObject({
			kind: "screen",
			header: { activeWindow: null, moreWindows: 6, png: 0 },
			png: null,
		});
		if (output.kind !== "screen") throw new Error("no screen");
		expect(output.header.windows).toHaveLength(16);
		expect(m.ports.shoot).not.toHaveBeenCalled();
		expect(m.sleeps).toEqual([]);
		const long = machine({ windows: `0x99 0 m ${"t".repeat(130)}\n0x98 0 m a\u0007b\n` });
		const titled = await machineScreen(request(), long.ports);
		if (titled.kind !== "screen") throw new Error("no screen");
		expect(titled.header.windows).toEqual(["t".repeat(120), "a b"]);
		// The header the helper prints is one the executor and the gateway take.
		expect(parseMachineScreenHeader(JSON.parse(JSON.stringify(titled.header)))).toEqual(titled.header);
		const blind = machine({ shot: null });
		expect(await machineScreen(request(), blind.ports)).toMatchObject({ header: { png: 0 }, png: null });
	});

	it("refuses a request that is not the executor's", async () => {
		const m = machine();
		for (const value of [
			null,
			"look",
			request({ schema: "qorpera.machine-screen-request/v2" }),
			request({ extra: true }),
			request({ receiptId: randomUUID() }),
			action({ type: "click", x: 1, y: 1 }, { receiptId: null }),
			action({ type: "click", x: 1, y: 1 }, { receiptId: "../../etc" }),
			action({ type: "click", x: 1, y: 3000 }),
			request({ settleMs: 5001 }),
			request({ settleMs: 1.5 }),
			request({ look: "yes" }),
		])
			expect(await machineScreen(value, m.ports), JSON.stringify(value)).toEqual({
				kind: "refused",
				code: "SCREEN_REQUEST_INVALID",
			});
		expect(m.runs).toEqual([]);
	});
});

describe("machine_screen's helper as a program", () => {
	async function cli(input: unknown, ports: MachineScreenPorts, argv: string[] = []) {
		const written: Buffer[] = [];
		const code = await runMachineScreenCli({
			argv,
			stdin: (async function* () {
				yield Buffer.from(JSON.stringify(input));
			})(),
			stdout: { write: (bytes: string | Uint8Array) => written.push(Buffer.from(bytes)) },
			ports,
		});
		return { code, stdout: Buffer.concat(written) };
	}

	it("prints one header line, then the PNG's bytes", async () => {
		const { code, stdout } = await cli(request(), machine().ports);
		expect(code).toBe(0);
		const end = stdout.indexOf(10);
		const header = JSON.parse(stdout.subarray(0, end).toString("utf8"));
		expect(header).toMatchObject({ schema: "qorpera.machine-screen/v1", png: PNG.length });
		expect(stdout.subarray(end + 1)).toEqual(PNG);
	});

	it("exits 96 with nothing printed for an action taken before, and prints a refusal's line", async () => {
		const m = machine();
		const click = action({ type: "click", x: 1, y: 1 });
		expect((await cli(click, m.ports)).code).toBe(0);
		expect(await cli(click, m.ports)).toEqual({ code: MACHINE_SCREEN_ACTION_TAKEN_EXIT, stdout: Buffer.alloc(0) });
		expect(MACHINE_SCREEN_ACTION_TAKEN_EXIT).toBe(96);
		const refused = await cli(click, machine({ running: false }).ports);
		expect(refused.code).toBe(0);
		expect(JSON.parse(refused.stdout.toString("utf8"))).toEqual({
			schema: "qorpera.machine-screen-refusal/v1",
			code: "DESKTOP_NOT_RUNNING",
		});
		// Arguments are never the helper's: refused, and nothing runs.
		const argued = machine();
		expect(JSON.parse((await cli(request(), argued.ports, ["--look"])).stdout.toString("utf8")).code).toBe(
			"SCREEN_REQUEST_INVALID",
		);
		expect(argued.runs).toEqual([]);
	});
});
