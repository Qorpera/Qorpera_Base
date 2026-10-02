/**
 * The run box (F3 step 2; deploy/first-node/RUNTIME-FOLDER-SERVICE.md, "Step 2b"): each run on the shared execution
 * host gets a box of its own, with the company folder read-only at `/company`, no network and no credentials. A box
 * host inside it runs the run's commands for the run's native host, over one Unix socket per slot that only the
 * slot's native host account can open. One JSON object per line, either way.
 *
 * Everything the box sends is untrusted: whatever runs in the box can kill the box host or answer in its place. The
 * native host checks every line with `parseRunBoxReply` and never trusts a size it did not check.
 */

import { isUuid, parseClosedRecord, parseInteger, WireValueError } from "./wire-values.ts";

export const RUN_BOX_PROTOCOL = 1;
/** One line, either way. A request is at most a command or input of 64 KiB; a reply at most 64 KiB of output. */
export const RUN_BOX_LINE_LIMIT = 256 * 1024;
/** A command line, and the input written in one call (UTF-16 code units). */
export const RUN_BOX_MAX_TEXT_LENGTH = 65_536;
/** How long one call may wait for output. A command keeps running after it; this is how long one answer waits. */
export const RUN_BOX_MAX_YIELD_MS = 30_000;
/** Output shown in one answer, head and tail together (UTF-8 bytes of the text). */
export const RUN_BOX_MIN_OUTPUT_BYTES = 256;
export const RUN_BOX_MAX_OUTPUT_BYTES = 65_536;
/** The company folder inside the box, and the working directory a command starts in unless it names another. */
export const RUN_BOX_COMPANY = "/company";
/** The highest session number a box hands out. */
export const RUN_BOX_MAX_SESSION = 2 ** 31 - 1;

export type RunBoxRequest =
	/** Start a command. It runs under bash in `workdir` (default `/company`); with `tty` it gets a terminal and keeps
	 * its input open for `write`, otherwise its input is empty. */
	| {
			t: "exec";
			id: string;
			cmd: string;
			workdir: string | null;
			tty: boolean;
			yieldMs: number;
			maxOutputBytes: number;
	  }
	/** Write to a running command's terminal (nothing, to only read), then wait for output. */
	| { t: "write"; id: string; session: number; chars: string; yieldMs: number; maxOutputBytes: number };

/** Output since the previous answer for the same command: all of it, or its head and its tail. */
export interface RunBoxOutput {
	head: string;
	tail: string;
	/** Bytes between head and tail that this answer does not show. */
	skippedBytes: number;
	/** Bytes the command wrote since the previous answer. */
	totalBytes: number;
}

export const RUN_BOX_ERROR_CODES = [
	"INVALID_REQUEST",
	"SESSION_UNKNOWN",
	"STDIN_CLOSED",
	"WORKDIR_UNAVAILABLE",
	"SPAWN_FAILED",
] as const;
export type RunBoxErrorCode = (typeof RUN_BOX_ERROR_CODES)[number];

export type RunBoxReply =
	/** Sent once per connection: the commands still running from earlier connections. */
	| { t: "ready"; protocol: typeof RUN_BOX_PROTOCOL; sessions: number[] }
	/**
	 * `session` names a command that is still running; it is null once the command has ended and all of its output was
	 * given. `logPath` names the command's whole output inside the box, given only when this answer skipped some.
	 */
	| {
			t: "result";
			id: string;
			session: number | null;
			exitCode: number | null;
			signal: string | null;
			output: RunBoxOutput;
			logPath: string | null;
			wallMs: number;
	  }
	| { t: "error"; id: string; code: RunBoxErrorCode; message: string };

const SIGNAL_PATTERN = /^SIG[A-Z0-9]{1,12}$/;
const LOG_PATH_PATTERN = /^\/[A-Za-z0-9._/-]{1,255}$/;

function line(text: string, label: string): Record<string, unknown> {
	if (text.length > RUN_BOX_LINE_LIMIT) throw new WireValueError(label, "is too long");
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new WireValueError(label, "is not JSON");
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new WireValueError(label);
	return value as Record<string, unknown>;
}

function id(value: unknown, label: string): string {
	if (!isUuid(value)) throw new WireValueError(label);
	return value;
}

function text(value: unknown, label: string, maxLength: number): string {
	if (typeof value !== "string" || value.length > maxLength || value.includes("\0")) throw new WireValueError(label);
	return value;
}

function utf8Bytes(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

/** A request, as the box host reads it. */
export function parseRunBoxRequest(encoded: string): RunBoxRequest {
	const value = line(encoded, "Run box request");
	if (value.t === "exec") {
		const input = parseClosedRecord(value, "Run box exec", [
			"t",
			"id",
			"cmd",
			"workdir",
			"tty",
			"yieldMs",
			"maxOutputBytes",
		]);
		const cmd = text(input.cmd, "Run box command", RUN_BOX_MAX_TEXT_LENGTH);
		if (cmd.trim().length === 0) throw new WireValueError("Run box command", "is empty");
		if (input.workdir !== null) text(input.workdir, "Run box working directory", 4096);
		if (typeof input.tty !== "boolean") throw new WireValueError("Run box terminal flag");
		return {
			t: "exec",
			id: id(input.id, "Run box request id"),
			cmd,
			workdir: input.workdir as string | null,
			tty: input.tty,
			yieldMs: parseInteger(input.yieldMs, "Run box yield", 0, RUN_BOX_MAX_YIELD_MS),
			maxOutputBytes: parseInteger(
				input.maxOutputBytes,
				"Run box output budget",
				RUN_BOX_MIN_OUTPUT_BYTES,
				RUN_BOX_MAX_OUTPUT_BYTES,
			),
		};
	}
	if (value.t === "write") {
		const input = parseClosedRecord(value, "Run box write", [
			"t",
			"id",
			"session",
			"chars",
			"yieldMs",
			"maxOutputBytes",
		]);
		return {
			t: "write",
			id: id(input.id, "Run box request id"),
			session: parseInteger(input.session, "Run box session", 1, RUN_BOX_MAX_SESSION),
			chars: text(input.chars, "Run box input", RUN_BOX_MAX_TEXT_LENGTH),
			yieldMs: parseInteger(input.yieldMs, "Run box yield", 0, RUN_BOX_MAX_YIELD_MS),
			maxOutputBytes: parseInteger(
				input.maxOutputBytes,
				"Run box output budget",
				RUN_BOX_MIN_OUTPUT_BYTES,
				RUN_BOX_MAX_OUTPUT_BYTES,
			),
		};
	}
	throw new WireValueError("Run box request", "has an unknown type");
}

/**
 * A line from the box, as the native host reads it. `maxOutputBytes` is the budget the request named: an answer
 * showing more is refused, so a box cannot grow an answer past what was asked.
 */
export function parseRunBoxReply(encoded: string, maxOutputBytes = RUN_BOX_MAX_OUTPUT_BYTES): RunBoxReply {
	const value = line(encoded, "Run box reply");
	if (value.t === "ready") {
		const input = parseClosedRecord(value, "Run box ready", ["t", "protocol", "sessions"]);
		if (input.protocol !== RUN_BOX_PROTOCOL) throw new WireValueError("Run box protocol");
		if (!Array.isArray(input.sessions) || input.sessions.length > 4096) throw new WireValueError("Run box sessions");
		return {
			t: "ready",
			protocol: RUN_BOX_PROTOCOL,
			sessions: input.sessions.map((session) => parseInteger(session, "Run box session", 1, RUN_BOX_MAX_SESSION)),
		};
	}
	if (value.t === "result") {
		const input = parseClosedRecord(value, "Run box result", [
			"t",
			"id",
			"session",
			"exitCode",
			"signal",
			"output",
			"logPath",
			"wallMs",
		]);
		const session =
			input.session === null ? null : parseInteger(input.session, "Run box session", 1, RUN_BOX_MAX_SESSION);
		const exitCode = input.exitCode === null ? null : parseInteger(input.exitCode, "Run box exit code", 0, 255);
		if (input.signal !== null && (typeof input.signal !== "string" || !SIGNAL_PATTERN.test(input.signal)))
			throw new WireValueError("Run box signal");
		// Running: a session and no end. Ended: no session, and an exit code or a signal.
		if (session !== null ? exitCode !== null || input.signal !== null : exitCode === null && input.signal === null)
			throw new WireValueError("Run box result", "is inconsistent");
		const output = parseClosedRecord(input.output, "Run box output", ["head", "tail", "skippedBytes", "totalBytes"]);
		const head = text(output.head, "Run box output head", RUN_BOX_MAX_OUTPUT_BYTES);
		const tail = text(output.tail, "Run box output tail", RUN_BOX_MAX_OUTPUT_BYTES);
		if (utf8Bytes(head) + utf8Bytes(tail) > maxOutputBytes)
			throw new WireValueError("Run box output", "is larger than asked");
		const totalBytes = parseInteger(output.totalBytes, "Run box output size", 0, Number.MAX_SAFE_INTEGER);
		const skippedBytes = parseInteger(output.skippedBytes, "Run box skipped output", 0, totalBytes);
		if (input.logPath !== null && (typeof input.logPath !== "string" || !LOG_PATH_PATTERN.test(input.logPath)))
			throw new WireValueError("Run box log path");
		return {
			t: "result",
			id: id(input.id, "Run box request id"),
			session,
			exitCode,
			signal: input.signal as string | null,
			output: { head, tail, skippedBytes, totalBytes },
			logPath: input.logPath as string | null,
			wallMs: parseInteger(input.wallMs, "Run box wall time", 0, 24 * 60 * 60 * 1000),
		};
	}
	if (value.t === "error") {
		const input = parseClosedRecord(value, "Run box error", ["t", "id", "code", "message"]);
		if (!RUN_BOX_ERROR_CODES.includes(input.code as RunBoxErrorCode)) throw new WireValueError("Run box error code");
		return {
			t: "error",
			id: id(input.id, "Run box request id"),
			code: input.code as RunBoxErrorCode,
			message: text(input.message, "Run box error message", 512),
		};
	}
	throw new WireValueError("Run box reply", "has an unknown type");
}
