import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isUuid } from "@qorpera/contracts";
import {
	type CodingValueMachineIdentity,
	codingValueMatches,
	codingValuePattern,
	sealCodingValueMachineCapture,
} from "./cloud-coding-value-capture-box.ts";

/* save_coding_value's helper on a company machine (20260930705000; Jonas, 9 November 2026: "Save from the machine").
 * The agent made a key on a service's site in the machine's browser and pressed the site's Copy, so the key is on the
 * desktop's clipboard. The coding executor runs this fixed program, shipped in the machine image beside the guest
 * helper (never anything the agent wrote), as root on the boot the database named, with the call's target on stdin:
 * the service's pattern, the value's capture key and what the box is bound to (qorpera_authorize_machine_coding_value).
 * It reads the clipboard of display :1 into memory (xsel, no file), takes the one whole key of the service in it,
 * seals it to the capture key (the coding value box's machine kind, cloud-coding-value-capture-box.ts), clears both
 * the clipboard and the primary selection on every path, and prints one JSON line: the sealed box, or a refusal code.
 * It never prints, logs or writes the value, nor anything of the clipboard: a refusal names only why.
 * The program itself is cloud-machine-coding-value-main.ts, which only the guest package bundles: this module is
 * imported by the runtime too (its refusal codes), so it must never run anything when loaded. */

export const MACHINE_CODING_VALUE_TARGET_SCHEMA = "qorpera.coding-value-machine-target/v1";
export const MACHINE_CODING_VALUE_BOX_SCHEMA = "qorpera.machine-coding-value-box/v1";
export const MACHINE_CODING_VALUE_REFUSAL_SCHEMA = "qorpera.machine-coding-value-refusal/v1";
/** The answer of `--clear-only`, the executor's own clear after a save that did not end cleanly. */
export const MACHINE_CODING_VALUE_CLEARED_SCHEMA = "qorpera.machine-coding-value-cleared/v1";
/** Why the helper sealed nothing; each also reaches the agent (cloud-machine-tools.ts says what to do). */
export const MACHINE_CODING_VALUE_REFUSALS = [
	/** No desktop runs on the machine, so there is no clipboard. */
	"DESKTOP_NOT_RUNNING",
	/** The clipboard holds nothing (or only white space). */
	"CLIPBOARD_EMPTY",
	/** Nothing on the clipboard is a whole key of the service. */
	"CLIPBOARD_NOT_A_KEY",
	/** The clipboard holds more than one key of the service: which one is meant is not known. */
	"CLIPBOARD_MORE_THAN_ONE_KEY",
	/** The clipboard could not be read (its owner did not answer). */
	"CLIPBOARD_UNREADABLE",
	/** The machine restarted since the executor read where it runs. */
	"MACHINE_BOOT_CHANGED",
	/** The target on stdin is not one. */
	"CODING_VALUE_TARGET_INVALID",
] as const;
export type MachineCodingValueRefusalCode = (typeof MACHINE_CODING_VALUE_REFUSALS)[number];

export type MachineCodingValueOutput =
	| { readonly schema: typeof MACHINE_CODING_VALUE_BOX_SCHEMA; readonly box: Readonly<Record<string, string>> }
	| { readonly schema: typeof MACHINE_CODING_VALUE_REFUSAL_SCHEMA; readonly code: MachineCodingValueRefusalCode };

/** At most this much of the clipboard is read; a key is far shorter, so more is never one. */
export const MACHINE_CLIPBOARD_MAX_BYTES = 65_536;
/** The target on stdin is small: a pattern of 512 characters at most and a few ids. */
const TARGET_MAX_BYTES = 8192;

/** The desktop's selections, as the helper uses them. A read answers the selection's bytes, or why there are none. */
export interface MachineClipboard {
	read(): Promise<Buffer | "no-display" | "unreadable" | "too-large">;
	/** Clears one selection; never throws (a failure leaves nothing more to do). */
	clear(selection: "clipboard" | "primary"): Promise<void>;
}

export interface MachineCodingValuePorts {
	readonly clipboard: MachineClipboard;
	/** The kernel's boot id (/proc/sys/kernel/random/boot_id). */
	bootId(): Promise<string>;
	now(): number;
}

const TARGET_KEYS = [
	"bootId",
	"capturePublicKey",
	"companyId",
	"companyMachineId",
	"placementId",
	"receiptId",
	"schema",
	"service",
	"valuePattern",
	"variable",
].join();

interface Target {
	readonly identity: CodingValueMachineIdentity;
	readonly pattern: RegExp;
	readonly capturePublicKey: string;
}

/** The executor's target, or null: every field the database answers, and nothing else. */
function target(value: unknown): Target | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const input = value as Record<string, unknown>;
	if (Object.keys(input).sort().join() !== TARGET_KEYS || input.schema !== MACHINE_CODING_VALUE_TARGET_SCHEMA)
		return null;
	const ids = [input.companyId, input.companyMachineId, input.placementId, input.bootId, input.receiptId];
	if (
		!ids.every((id) => isUuid(id)) ||
		typeof input.service !== "string" ||
		typeof input.variable !== "string" ||
		typeof input.capturePublicKey !== "string"
	)
		return null;
	try {
		return {
			identity: {
				companyId: input.companyId as string,
				companyMachineId: input.companyMachineId as string,
				placementId: input.placementId as string,
				bootId: input.bootId as string,
				receiptId: input.receiptId as string,
				service: input.service,
				variable: input.variable,
			},
			pattern: codingValuePattern(input.valuePattern),
			capturePublicKey: input.capturePublicKey,
		};
	} catch {
		return null;
	}
}

function refused(code: MachineCodingValueRefusalCode): MachineCodingValueOutput {
	return { schema: MACHINE_CODING_VALUE_REFUSAL_SCHEMA, code };
}

/** The one whole key of the service on the clipboard: all of it, trimmed, or else the one word of it that is one. */
function onlyKey(text: string, pattern: RegExp): string | "none" | "many" {
	const trimmed = text.trim();
	if (codingValueMatches(trimmed, pattern)) return trimmed;
	const keys = new Set(trimmed.split(/\s+/).filter((word) => codingValueMatches(word, pattern)));
	if (keys.size === 0) return "none";
	if (keys.size > 1) return "many";
	return [...keys][0] as string;
}

/**
 * One save: the target checked, the clipboard read, the one key of the service in it sealed for exactly this call on
 * this boot; and both selections cleared on every path, the refusals and any failure too. The answer holds the box or
 * a refusal code, never anything read off the clipboard.
 */
export async function saveCodingValueFromClipboard(
	input: unknown,
	ports: MachineCodingValuePorts,
): Promise<MachineCodingValueOutput> {
	let read: Buffer | undefined;
	try {
		const checked = target(input);
		if (!checked) return refused("CODING_VALUE_TARGET_INVALID");
		if ((await ports.bootId()).trim() !== checked.identity.bootId) return refused("MACHINE_BOOT_CHANGED");
		const clipboard = await ports.clipboard.read();
		if (clipboard === "no-display") return refused("DESKTOP_NOT_RUNNING");
		if (clipboard === "unreadable") return refused("CLIPBOARD_UNREADABLE");
		if (clipboard === "too-large") return refused("CLIPBOARD_NOT_A_KEY");
		read = clipboard;
		const text = read.toString("utf8");
		if (!text.trim()) return refused("CLIPBOARD_EMPTY");
		const key = onlyKey(text, checked.pattern);
		if (key === "none") return refused("CLIPBOARD_NOT_A_KEY");
		if (key === "many") return refused("CLIPBOARD_MORE_THAN_ONE_KEY");
		return {
			schema: MACHINE_CODING_VALUE_BOX_SCHEMA,
			box: sealCodingValueMachineCapture(
				key,
				checked.pattern,
				checked.capturePublicKey,
				checked.identity,
				ports.now(),
			),
		};
	} finally {
		read?.fill(0);
		// The key leaves the machine's clipboard whatever came of it: a refused one is made again or copied again.
		await clearBoth(ports.clipboard);
	}
}

/** Both selections cleared side by side, so the clear takes one xsel's time at most. */
function clearBoth(clipboard: MachineClipboard): Promise<unknown> {
	return Promise.all([clipboard.clear("clipboard"), clipboard.clear("primary")]);
}

/** The display the desktop runs on (deploy/machine/desktop-session), and its socket. */
const DISPLAY = ":1";
const DISPLAY_SOCKET = "/tmp/.X11-unix/X1";
const XSEL = "/usr/bin/xsel";
/**
 * How long one xsel may take, then it is killed: a selection's owner that never answers is given up (the read asks
 * xsel itself to give up a second sooner). A save is one read, then both clears side by side: two xsels' time, well
 * inside the 20 s the executor gives the helper (company-machine-host.ts), so its clear always runs before that.
 */
export const MACHINE_XSEL_MS = 4_000;

/** xsel with these arguments against the desktop's display, as root (the session lets root in, xhost localuser:root):
 * its stdout in memory, up to `maxBytes`; nothing on the disk, no log (xsel logs only when it serves a selection it
 * owns, which these arguments never do; its log file is /dev/null all the same). */
function xsel(
	binary: string,
	args: readonly string[],
	maxBytes: number,
	timeoutMs: number,
): Promise<{ ok: boolean; stdout: Buffer; over: boolean }> {
	return new Promise((settle) => {
		const child = spawn(binary, ["--logfile", "/dev/null", ...args], {
			env: { DISPLAY, PATH: "/usr/bin:/bin" },
			stdio: ["ignore", "pipe", "ignore"],
			timeout: timeoutMs,
			killSignal: "SIGKILL",
		});
		const chunks: Buffer[] = [];
		let bytes = 0;
		let over = false;
		let settled = false;
		child.stdout.on("data", (chunk: Buffer) => {
			if (!over) {
				bytes += chunk.length;
				if (bytes > maxBytes) {
					over = true;
					for (const held of chunks) held.fill(0);
					chunks.length = 0;
					child.kill("SIGKILL");
				} else chunks.push(Buffer.from(chunk));
			}
			chunk.fill(0);
		});
		const done = (ok: boolean) => {
			if (settled) return;
			settled = true;
			const stdout = Buffer.concat(chunks);
			for (const held of chunks) held.fill(0);
			settle({ ok: ok && !over, stdout, over });
		};
		child.once("error", () => done(false));
		child.once("close", (code) => done(code === 0));
	});
}

/** The desktop's clipboard on this machine, through xsel; the program and the display's socket are fixed (the
 * options are the tests' own: a stand-in xsel, a socket and a shorter time). */
export function xselClipboard(
	options: { readonly xsel?: string; readonly socket?: string; readonly timeoutMs?: number } = {},
): MachineClipboard {
	const binary = options.xsel ?? XSEL;
	const socket = options.socket ?? DISPLAY_SOCKET;
	const timeoutMs = options.timeoutMs ?? MACHINE_XSEL_MS;
	// xsel's own wait for the selection's owner ends a second before the kill.
	const selectionTimeout = String(Math.max(100, timeoutMs - 1000));
	return {
		async read() {
			if (!existsSync(socket)) return "no-display";
			const answer = await xsel(
				binary,
				["--clipboard", "--output", "--selectionTimeout", selectionTimeout],
				MACHINE_CLIPBOARD_MAX_BYTES,
				timeoutMs,
			);
			if (answer.over) return "too-large";
			if (!answer.ok) {
				answer.stdout.fill(0);
				return existsSync(socket) ? "unreadable" : "no-display";
			}
			return answer.stdout;
		},
		async clear(selection) {
			if (!existsSync(socket)) return;
			await xsel(binary, [`--${selection}`, "--clear"], 0, timeoutMs);
		},
	};
}

/** Reads the target off `stdin`, up to its bound, or null. */
async function readTarget(stdin: AsyncIterable<Buffer | string>): Promise<unknown> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of stdin) {
		const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		bytes += buffer.length;
		if (bytes > TARGET_MAX_BYTES) return null;
		chunks.push(buffer);
	}
	try {
		return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks)));
	} catch {
		return null;
	}
}

/**
 * The program. With no arguments: the target from stdin, one JSON line on stdout (the box, or a refusal), exit 0.
 * With `--clear-only` (the executor's own clear after a save that did not end cleanly): both selections cleared, stdin
 * unread, one line saying so. Any other arguments: both selections cleared and the target refused. A failure prints a
 * fixed word on stderr and exits 1; the executor never shows either.
 */
export async function runMachineCodingValueCli(options: {
	argv: readonly string[];
	stdin: AsyncIterable<Buffer | string>;
	stdout: { write(text: string): unknown };
	ports?: MachineCodingValuePorts;
}): Promise<number> {
	const ports = options.ports ?? {
		clipboard: xselClipboard(),
		bootId: () => readFile("/proc/sys/kernel/random/boot_id", "utf8"),
		now: Date.now,
	};
	let output: Record<string, unknown>;
	if (options.argv.length === 1 && options.argv[0] === "--clear-only") {
		await clearBoth(ports.clipboard);
		output = { schema: MACHINE_CODING_VALUE_CLEARED_SCHEMA };
	} else if (options.argv.length > 0) {
		await clearBoth(ports.clipboard);
		output = refused("CODING_VALUE_TARGET_INVALID");
	} else output = await saveCodingValueFromClipboard(await readTarget(options.stdin), ports);
	options.stdout.write(`${JSON.stringify(output)}\n`);
	return 0;
}
