import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

/* machine_screen's helper on a company machine (20260930708000; Jonas, 10 November 2026: agents ask for a desktop
 * computer and must see and drive it). The coding executor runs this fixed program, shipped in the machine image beside
 * the guest helper (never anything the agent wrote), as root on the boot the database named, with the request on
 * stdin: one desktop action or none, a settle time and whether to look. It drives the desktop only through the image's
 * own `/usr/local/bin/desktop` with a fixed argv (never a shell), acts at most once per receipt on this boot (a marker
 * under /run, which a restart empties as it empties the desktop), waits, takes a screenshot into a private folder,
 * reads it and deletes it, and prints one header line (JSON) and then the PNG's bytes. Nothing is written anywhere
 * else: the picture never touches the disk outside /run, and never the company folder.
 * The program itself is cloud-machine-screen-main.ts, which only the guest package bundles: this module is imported by
 * the runtime too (the action's shape and the refusal codes), so it must never run anything when loaded. */

export const MACHINE_SCREEN_REQUEST_SCHEMA = "qorpera.machine-screen-request/v1";
export const MACHINE_SCREEN_HEADER_SCHEMA = "qorpera.machine-screen/v1";
export const MACHINE_SCREEN_REFUSAL_SCHEMA = "qorpera.machine-screen-refusal/v1";
/** The helper's exit when the request's action was taken on this boot before: it never acts twice. */
export const MACHINE_SCREEN_ACTION_TAKEN_EXIT = 96;
/** Why the helper did nothing; each also reaches the agent (cloud-machine-tools.ts says what to do). */
export const MACHINE_SCREEN_REFUSALS = [
	/** The machine is smaller than a desktop needs (`desktop start` exits 3). */
	"DESKTOP_MACHINE_TOO_SMALL",
	/** `desktop start` failed or ran out of time. */
	"DESKTOP_DID_NOT_START",
	/** An action on a stopped desktop: the agent looks first (a look starts it), never acts on a screen it has not seen. */
	"DESKTOP_NOT_RUNNING",
	/** The request on stdin is not one. */
	"SCREEN_REQUEST_INVALID",
] as const;
export type MachineScreenRefusalCode = (typeof MACHINE_SCREEN_REFUSALS)[number];

/** The verbs, as `desktop` names them; the reviewed ones need an intent. */
export const MACHINE_SCREEN_VERBS = ["click", "double", "move", "drag", "type", "key", "scroll", "open"] as const;
export type MachineScreenVerb = (typeof MACHINE_SCREEN_VERBS)[number];
export const MACHINE_SCREEN_REVIEWED_VERBS: readonly MachineScreenVerb[] = [
	"click",
	"double",
	"drag",
	"type",
	"key",
	"open",
];
/** Screen pixels: a screen of at most 3840 x 2160 (`desktop size`). */
export const MACHINE_SCREEN_MAX_WIDTH = 3840;
export const MACHINE_SCREEN_MAX_HEIGHT = 2160;
export const MACHINE_SCREEN_MAX_SETTLE_MS = 5000;
export const MACHINE_SCREEN_MAX_TEXT = 500;
export const MACHINE_SCREEN_MAX_TARGET = 2000;
/** At most this many window titles, each at most this many characters. */
export const MACHINE_SCREEN_MAX_WINDOWS = 16;
export const MACHINE_SCREEN_MAX_TITLE = 120;
/** The action's error: the last line of `desktop`'s stderr, at most this many bytes. */
export const MACHINE_SCREEN_MAX_ERROR_BYTES = 300;
/** A PNG the helper prints is at most this large; the executor reads 64 KiB more for the header. */
export const MACHINE_SCREEN_MAX_PNG_BYTES = 8 * 1024 * 1024;

export type MachineScreenAction =
	| { readonly type: "click"; readonly x: number; readonly y: number; readonly button?: "left" | "middle" | "right" }
	| { readonly type: "double" | "move"; readonly x: number; readonly y: number }
	| { readonly type: "drag"; readonly x: number; readonly y: number; readonly toX: number; readonly toY: number }
	| { readonly type: "type"; readonly text: string }
	| { readonly type: "key"; readonly keys: readonly string[] }
	| {
			readonly type: "scroll";
			readonly direction: "up" | "down";
			readonly steps?: number;
			readonly x?: number;
			readonly y?: number;
	  }
	| { readonly type: "open"; readonly target: string };

const KEYS: Readonly<Record<MachineScreenVerb, readonly string[]>> = {
	click: ["type", "x", "y", "button"],
	double: ["type", "x", "y"],
	move: ["type", "x", "y"],
	drag: ["type", "x", "y", "toX", "toY"],
	type: ["type", "text"],
	key: ["type", "keys"],
	scroll: ["type", "direction", "steps", "x", "y"],
	open: ["type", "target"],
};
const KEY_NAME = /^[A-Za-z0-9_][A-Za-z0-9_+]{0,39}$/;
/** Control characters as the database's `[[:cntrl:]]` sees them, line and paragraph separators too. */
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const CONTROLS = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
const URL_TARGET = /^(https?|file):\/\/[!-~]+$/;
const PATH_TARGET = /^\/[^\p{Cc}\p{Zl}\p{Zp}]*$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Whether the text holds a control character other than a line break or a tab (which `desktop type` pastes). */
export function machineScreenTextControlled(text: string): boolean {
	return CONTROL.test(text.replace(/[\n\t]/g, ""));
}

function pixel(value: unknown, field: string, limit: number): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value >= limit)
		throw new Error(`machine_screen's ${field} is a whole number of screen pixels from 0 to ${limit - 1}`);
	return value;
}

/**
 * One action as machine_screen takes it, the same check the database makes (qorpera_valid_machine_screen_call): one
 * verb with exactly its own fields, positions in whole screen pixels. The tool, the executor and the helper all check
 * it, so what is reviewed is what runs. Throws a message the agent can act on.
 */
export function parseMachineScreenAction(value: unknown): MachineScreenAction {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("machine_screen's action is an object with a type");
	const input = value as Record<string, unknown>;
	const type = input.type;
	if (typeof type !== "string" || !(MACHINE_SCREEN_VERBS as readonly string[]).includes(type))
		throw new Error(`machine_screen's action type is one of ${MACHINE_SCREEN_VERBS.join(", ")}`);
	const verb = type as MachineScreenVerb;
	const extra = Object.keys(input).filter((key) => !KEYS[verb].includes(key));
	if (extra.length) throw new Error(`machine_screen's ${verb} takes only ${KEYS[verb].join(", ")}`);
	const at = (x: unknown, y: unknown, names: readonly [string, string] = ["x", "y"]) => ({
		x: pixel(x, names[0], MACHINE_SCREEN_MAX_WIDTH),
		y: pixel(y, names[1], MACHINE_SCREEN_MAX_HEIGHT),
	});
	switch (verb) {
		case "click": {
			const { x, y } = at(input.x, input.y);
			if (input.button !== undefined && !["left", "middle", "right"].includes(input.button as string))
				throw new Error("machine_screen's click button is left, middle or right");
			return Object.freeze({
				type: "click",
				x,
				y,
				...(input.button !== undefined ? { button: input.button as "left" | "middle" | "right" } : {}),
			});
		}
		case "double":
		case "move":
			return Object.freeze({ type: verb, ...at(input.x, input.y) });
		case "drag": {
			const from = at(input.x, input.y);
			const to = at(input.toX, input.toY, ["toX", "toY"]);
			return Object.freeze({ type: "drag", x: from.x, y: from.y, toX: to.x, toY: to.y });
		}
		case "type": {
			const text = input.text;
			if (typeof text !== "string" || [...text].length < 1 || [...text].length > MACHINE_SCREEN_MAX_TEXT)
				throw new Error(`machine_screen's type text is 1 to ${MACHINE_SCREEN_MAX_TEXT} characters`);
			if (machineScreenTextControlled(text))
				throw new Error("machine_screen's type text holds no control character but a line break or a tab");
			return Object.freeze({ type: "type", text });
		}
		case "key": {
			const keys = input.keys;
			if (
				!Array.isArray(keys) ||
				keys.length < 1 ||
				keys.length > 16 ||
				keys.some((key) => typeof key !== "string" || !KEY_NAME.test(key))
			)
				throw new Error(
					"machine_screen's key keys are 1 to 16 key names such as Return, Tab, Escape, ctrl+l or ctrl+shift+t",
				);
			return Object.freeze({ type: "key", keys: Object.freeze([...(keys as string[])]) });
		}
		case "scroll": {
			if (input.direction !== "up" && input.direction !== "down")
				throw new Error("machine_screen's scroll direction is up or down");
			if (
				input.steps !== undefined &&
				(typeof input.steps !== "number" || !Number.isInteger(input.steps) || input.steps < 1 || input.steps > 30)
			)
				throw new Error("machine_screen's scroll steps are 1 to 30");
			if ((input.x === undefined) !== (input.y === undefined))
				throw new Error("machine_screen's scroll takes x and y together, or neither");
			return Object.freeze({
				type: "scroll",
				direction: input.direction,
				...(input.steps !== undefined ? { steps: input.steps as number } : {}),
				...(input.x !== undefined ? at(input.x, input.y) : {}),
			});
		}
		case "open": {
			const target = input.target;
			if (
				typeof target !== "string" ||
				[...target].length > MACHINE_SCREEN_MAX_TARGET ||
				!(URL_TARGET.test(target) || PATH_TARGET.test(target))
			)
				throw new Error(
					`machine_screen's open target is an http(s) or file URL (no spaces) or an absolute path, at most ${MACHINE_SCREEN_MAX_TARGET} characters`,
				);
			return Object.freeze({ type: "open", target });
		}
	}
}

/** The settle time a call waits by default: none for a look, longer for an opening page than for another action. */
export function machineScreenDefaultSettleMs(action: MachineScreenAction | null): number {
	return action === null ? 0 : action.type === "open" ? 2500 : 500;
}

/** The `desktop` commands that perform one action, each a fixed argv: a scroll at a place moves there first. */
export function machineScreenDesktopArgs(action: MachineScreenAction): readonly (readonly string[])[] {
	switch (action.type) {
		case "click":
			return [["click", String(action.x), String(action.y), action.button ?? "left"]];
		case "double":
		case "move":
			return [[action.type, String(action.x), String(action.y)]];
		case "drag":
			return [["drag", String(action.x), String(action.y), String(action.toX), String(action.toY)]];
		case "type":
			return [["type", action.text]];
		case "key":
			return [["key", ...action.keys]];
		case "scroll":
			return [
				...(action.x !== undefined && action.y !== undefined ? [["move", String(action.x), String(action.y)]] : []),
				["scroll", action.direction, String(action.steps ?? 3)],
			];
		case "open":
			return [["open", action.target]];
	}
}

/** The request on stdin: an action with its receipt, or a look (neither); the settle time; whether to look. */
export interface MachineScreenRequest {
	readonly receiptId: string | null;
	readonly action: MachineScreenAction | null;
	readonly settleMs: number;
	readonly look: boolean;
}

/** The request the executor gives the helper, or a refusal's reason. */
export function parseMachineScreenRequest(value: unknown): MachineScreenRequest {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("SCREEN_REQUEST_INVALID");
	const input = value as Record<string, unknown>;
	if (
		Object.keys(input).sort().join() !== "action,look,receiptId,schema,settleMs" ||
		input.schema !== MACHINE_SCREEN_REQUEST_SCHEMA ||
		(input.receiptId === null) !== (input.action === null) ||
		(input.receiptId !== null && (typeof input.receiptId !== "string" || !UUID.test(input.receiptId))) ||
		typeof input.settleMs !== "number" ||
		!Number.isInteger(input.settleMs) ||
		input.settleMs < 0 ||
		input.settleMs > MACHINE_SCREEN_MAX_SETTLE_MS ||
		typeof input.look !== "boolean"
	)
		throw new Error("SCREEN_REQUEST_INVALID");
	let action: MachineScreenAction | null = null;
	try {
		if (input.action !== null) action = parseMachineScreenAction(input.action);
	} catch {
		throw new Error("SCREEN_REQUEST_INVALID");
	}
	return Object.freeze({
		receiptId: input.receiptId as string | null,
		action,
		settleMs: input.settleMs,
		look: input.look,
	});
}

/** The header line before the PNG: what the action did, what shows, and how many bytes of PNG follow (0: none). */
export interface MachineScreenHeader {
	readonly schema: typeof MACHINE_SCREEN_HEADER_SCHEMA;
	/** The desktop was not running and this look started it. */
	readonly started: boolean;
	readonly action: {
		readonly type: MachineScreenVerb;
		/** null: killed at its deadline. */
		readonly exitCode: number | null;
		readonly error?: string;
	} | null;
	readonly activeWindow: string | null;
	readonly windows: readonly string[];
	readonly moreWindows: number;
	readonly png: number;
}
/** A title or an error as a header carries it: at most `chars` characters (and `bytes` bytes), no control character. */
function headerText(value: unknown, chars: number, bytes = Number.POSITIVE_INFINITY): value is string {
	return (
		typeof value === "string" &&
		[...value].length <= chars &&
		Buffer.byteLength(value) <= bytes &&
		!CONTROL.test(value)
	);
}
/** A header as the helper prints it and the executor passes it on: exactly its fields, each within its bound. */
export function parseMachineScreenHeader(value: unknown): MachineScreenHeader {
	const invalid = () => new Error("Machine screen header invalid");
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
	const header = value as Record<string, unknown>;
	if (
		Object.keys(header).sort().join() !== "action,activeWindow,moreWindows,png,schema,started,windows" ||
		header.schema !== MACHINE_SCREEN_HEADER_SCHEMA ||
		typeof header.started !== "boolean" ||
		(header.activeWindow !== null && !headerText(header.activeWindow, MACHINE_SCREEN_MAX_TITLE)) ||
		!Array.isArray(header.windows) ||
		header.windows.length > MACHINE_SCREEN_MAX_WINDOWS ||
		header.windows.some((entry) => !headerText(entry, MACHINE_SCREEN_MAX_TITLE)) ||
		!Number.isSafeInteger(header.moreWindows) ||
		(header.moreWindows as number) < 0 ||
		(header.moreWindows as number) > 100000 ||
		!Number.isSafeInteger(header.png) ||
		(header.png as number) < 0 ||
		(header.png as number) > MACHINE_SCREEN_MAX_PNG_BYTES
	)
		throw invalid();
	let action: MachineScreenHeader["action"] = null;
	if (header.action !== null) {
		const done = header.action;
		if (!done || typeof done !== "object" || Array.isArray(done)) throw invalid();
		const { type, exitCode, error, ...rest } = done as Record<string, unknown>;
		if (
			Object.keys(rest).length ||
			!(MACHINE_SCREEN_VERBS as readonly unknown[]).includes(type) ||
			(exitCode !== null &&
				(!Number.isSafeInteger(exitCode) || (exitCode as number) < 0 || (exitCode as number) > 255)) ||
			(error !== undefined &&
				(!headerText(error, MACHINE_SCREEN_MAX_ERROR_BYTES, MACHINE_SCREEN_MAX_ERROR_BYTES) || !error))
		)
			throw invalid();
		action = Object.freeze({
			type: type as MachineScreenVerb,
			exitCode: exitCode as number | null,
			...(error !== undefined ? { error: error as string } : {}),
		});
	}
	return Object.freeze({
		schema: MACHINE_SCREEN_HEADER_SCHEMA,
		started: header.started,
		action,
		activeWindow: header.activeWindow as string | null,
		windows: Object.freeze([...(header.windows as string[])]),
		moreWindows: header.moreWindows as number,
		png: header.png as number,
	});
}
export type MachineScreenOutput =
	| { readonly kind: "screen"; readonly header: MachineScreenHeader; readonly png: Buffer | null }
	| { readonly kind: "refused"; readonly code: MachineScreenRefusalCode }
	| { readonly kind: "taken" };

/** One program the helper runs: its exit (null: killed at its deadline), its stdout, the end of its stderr. */
export interface MachineScreenRun {
	readonly code: number | null;
	readonly stdout: Buffer;
	readonly stderr: string;
}
export interface MachineScreenPorts {
	/** Runs `file` with this argv (never a shell), killed with its whole process group after `timeoutMs`. */
	run(file: string, args: readonly string[], timeoutMs: number): Promise<MachineScreenRun>;
	/** Makes the receipt's marker for this boot; false when it was made before (the action was taken). */
	mark(receiptId: string): Promise<boolean>;
	/** A screenshot's bytes, or null when none could be taken. */
	shoot(timeoutMs: number): Promise<Buffer | null>;
	/** Puts off the desktop's own idle stop (desktop-session). */
	touch(): Promise<void>;
	sleep(ms: number): Promise<void>;
}

const DESKTOP = "/usr/local/bin/desktop";
/** Each step's own deadline. A look on a stopped desktop is the status, the start, the settle and the shot; an action is
 * the status, the action, the settle and the shot: 21 s at most either way, inside the executor's 22 s
 * (company-machine-host.ts, SCREEN_MS). The windows are listed beside the shot. */
export const MACHINE_SCREEN_STEP_MS = Object.freeze({ status: 3000, start: 10000, action: 10000, shot: 3000 });

/** The last line of a program's stderr, at most MACHINE_SCREEN_MAX_ERROR_BYTES bytes, whole characters. */
function lastLine(stderr: string): string | undefined {
	const line = stderr
		.split("\n")
		.map((entry) => entry.replace(CONTROLS, " ").trim())
		.filter(Boolean)
		.pop();
	if (!line) return undefined;
	let cut = line;
	while (Buffer.byteLength(cut) > MACHINE_SCREEN_MAX_ERROR_BYTES) cut = [...cut].slice(0, -1).join("");
	return cut;
}
/** A title as the header carries it: control characters gone, at most MACHINE_SCREEN_MAX_TITLE characters. */
function title(text: string): string {
	const clean = text.replace(CONTROLS, " ").trim();
	const chars = [...clean];
	return chars.length > MACHINE_SCREEN_MAX_TITLE ? chars.slice(0, MACHINE_SCREEN_MAX_TITLE).join("") : clean;
}

/** The desktop's windows (`wmctrl -l`: id, desktop, host, title), its own panel and background (desktop -1) left out. */
function windows(listing: MachineScreenRun): { windows: string[]; more: number } {
	if (listing.code !== 0) return { windows: [], more: 0 };
	const titles: string[] = [];
	for (const line of listing.stdout.toString("utf8").split("\n")) {
		const parts = /^(\S+)\s+(-?\d+)\s+\S+\s?(.*)$/.exec(line);
		if (!parts || parts[2] === "-1") continue;
		const shown = title(parts[3] ?? "");
		if (shown) titles.push(shown);
	}
	return {
		windows: titles.slice(0, MACHINE_SCREEN_MAX_WINDOWS),
		more: Math.max(0, titles.length - MACHINE_SCREEN_MAX_WINDOWS),
	};
}

/**
 * One request: the desktop started for a look (an action on a stopped desktop is refused), the action taken once per
 * receipt and boot, the settle, the screenshot and the windows. The answer is the header and the PNG, a refusal, or
 * "taken" (the receipt's action ran on this boot before, so nothing runs again).
 */
export async function machineScreen(input: unknown, ports: MachineScreenPorts): Promise<MachineScreenOutput> {
	let request: MachineScreenRequest;
	try {
		request = parseMachineScreenRequest(input);
	} catch {
		return { kind: "refused", code: "SCREEN_REQUEST_INVALID" };
	}
	const status = await ports.run(DESKTOP, ["status"], MACHINE_SCREEN_STEP_MS.status);
	const running = status.code === 0 && status.stdout.toString("utf8").startsWith("running");
	let started = false;
	if (!running) {
		if (request.action) return { kind: "refused", code: "DESKTOP_NOT_RUNNING" };
		const start = await ports.run(DESKTOP, ["start"], MACHINE_SCREEN_STEP_MS.start);
		if (start.code === 3) return { kind: "refused", code: "DESKTOP_MACHINE_TOO_SMALL" };
		if (start.code !== 0) return { kind: "refused", code: "DESKTOP_DID_NOT_START" };
		started = true;
	}
	let action: MachineScreenHeader["action"] = null;
	if (request.action && request.receiptId) {
		// Never twice: the marker is made before the action, so an action cut short is not taken again either.
		if (!(await ports.mark(request.receiptId))) return { kind: "taken" };
		// One deadline for the action's commands together (a scroll at a place is a move, then the scroll).
		const until = Date.now() + MACHINE_SCREEN_STEP_MS.action;
		let last: MachineScreenRun = { code: 0, stdout: Buffer.alloc(0), stderr: "" };
		for (const args of machineScreenDesktopArgs(request.action)) {
			last = await ports.run(DESKTOP, args, Math.max(1, until - Date.now()));
			if (last.code !== 0) break;
		}
		const error = last.code === 0 ? undefined : lastLine(last.stderr);
		action = {
			type: request.action.type,
			exitCode: last.code,
			...(error !== undefined ? { error } : {}),
		};
	}
	if (request.settleMs > 0) await ports.sleep(request.settleMs);
	const [png, listing, active] = await Promise.all([
		request.look ? ports.shoot(MACHINE_SCREEN_STEP_MS.shot) : Promise.resolve(null),
		ports.run("/usr/bin/wmctrl", ["-l"], MACHINE_SCREEN_STEP_MS.shot),
		ports.run("/usr/bin/xdotool", ["getactivewindow", "getwindowname"], MACHINE_SCREEN_STEP_MS.shot),
	]);
	await ports.touch();
	const shown = windows(listing);
	const activeTitle = active.code === 0 ? title(active.stdout.toString("utf8")) : "";
	const kept = png && png.length <= MACHINE_SCREEN_MAX_PNG_BYTES ? png : null;
	return {
		kind: "screen",
		header: {
			schema: MACHINE_SCREEN_HEADER_SCHEMA,
			started,
			action,
			activeWindow: activeTitle || null,
			windows: shown.windows,
			moreWindows: shown.more,
			png: kept ? kept.length : 0,
		},
		png: kept,
	};
}

/** The display the desktop runs on (deploy/machine/desktop-session). */
const ENVIRONMENT = Object.freeze({
	DISPLAY: ":1",
	PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
	HOME: "/root",
	LANG: "C.UTF-8",
	USER: "root",
});
/** The helper's own folder under /run: the receipts' markers and the screenshot on its way, root's alone. */
const FOLDER = "/run/qorpera-screen";
/** The desktop's idle clock (desktop-session). */
const LAST_USE = "/run/qorpera-desktop/last-use";
/** How much of a program's stdout and stderr is kept: a status and a window list are short. */
const OUTPUT_BYTES = 65536;

/** Runs one program with a fixed argv in a process group of its own, so a deadline kills what it started (an xdotool
 * still typing) with it. */
function run(file: string, args: readonly string[], timeoutMs: number): Promise<MachineScreenRun> {
	return new Promise((settle) => {
		const child = spawn(file, args, {
			env: { ...ENVIRONMENT },
			cwd: "/",
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		const stdout: Buffer[] = [];
		let stdoutBytes = 0;
		let stderr = "";
		let killed = false;
		const timer = setTimeout(() => {
			killed = true;
			try {
				if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
			} catch {
				// Gone already.
			}
		}, timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => {
			if (stdoutBytes < OUTPUT_BYTES) stdout.push(chunk.subarray(0, OUTPUT_BYTES - stdoutBytes));
			stdoutBytes += chunk.length;
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString("utf8")).slice(-4096);
		});
		let settled = false;
		const done = (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			settle({ code: killed ? null : code, stdout: Buffer.concat(stdout), stderr });
		};
		child.once("error", () => done(127));
		child.once("close", (code) => done(code));
	});
}

/** The helper's ports on a machine: `desktop`, scrot, the markers and the idle clock as the image has them. */
export function machineScreenPorts(): MachineScreenPorts {
	return {
		run,
		async mark(receiptId) {
			await mkdir(`${FOLDER}/acted`, { recursive: true, mode: 0o700 });
			try {
				await mkdir(`${FOLDER}/acted/${receiptId}`, { mode: 0o700 });
				return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
				throw error;
			}
		},
		async shoot(timeoutMs) {
			await mkdir(`${FOLDER}/shots`, { recursive: true, mode: 0o700 });
			const file = `${FOLDER}/shots/${randomUUID()}.png`;
			try {
				const shot = await run("/usr/bin/scrot", ["--overwrite", "--silent", file], timeoutMs);
				if (shot.code !== 0) return null;
				return await readFile(file);
			} catch {
				return null;
			} finally {
				await rm(file, { force: true });
			}
		},
		async touch() {
			const now = new Date();
			try {
				await utimes(LAST_USE, now, now);
			} catch {
				// A desktop that stopped has no clock to put off.
				try {
					await writeFile(LAST_USE, "", { flag: "wx" });
				} catch {
					// Its folder went with it.
				}
			}
		},
		sleep: (ms) => sleep(ms),
	};
}

/** Reads the request off `stdin`, at most 16 KiB, or null. */
async function readRequest(stdin: AsyncIterable<Buffer | string>): Promise<unknown> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of stdin) {
		const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		bytes += buffer.length;
		if (bytes > 16384) return null;
		chunks.push(buffer);
	}
	try {
		return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks)));
	} catch {
		return null;
	}
}

/**
 * The program: the request from stdin; the header line and the PNG on stdout, or a refusal's line; exit 0. An action
 * already taken on this boot prints nothing and exits MACHINE_SCREEN_ACTION_TAKEN_EXIT (96). Arguments are refused. A
 * failure prints a fixed word on stderr and exits 1; the executor shows neither.
 */
export async function runMachineScreenCli(options: {
	argv: readonly string[];
	stdin: AsyncIterable<Buffer | string>;
	stdout: { write(bytes: string | Uint8Array): unknown };
	ports?: MachineScreenPorts;
}): Promise<number> {
	const output =
		options.argv.length > 0
			? ({ kind: "refused", code: "SCREEN_REQUEST_INVALID" } as const)
			: await machineScreen(await readRequest(options.stdin), options.ports ?? machineScreenPorts());
	if (output.kind === "taken") return MACHINE_SCREEN_ACTION_TAKEN_EXIT;
	if (output.kind === "refused") {
		options.stdout.write(`${JSON.stringify({ schema: MACHINE_SCREEN_REFUSAL_SCHEMA, code: output.code })}\n`);
		return 0;
	}
	options.stdout.write(
		output.png
			? Buffer.concat([Buffer.from(`${JSON.stringify(output.header)}\n`, "utf8"), output.png])
			: `${JSON.stringify(output.header)}\n`,
	);
	return 0;
}
