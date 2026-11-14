// Claude Code's CLAUDE_CODE_SHELL_PREFIX inside the box (slice C2; P4's `home-shell.py`). Claude Code runs
// `<prefix> '<the full shell invocation>'` for each Bash command. This sends the invocation, the working folder and the
// variables named below to the run's host over the box's one shell socket, writes the home's output to its own
// stdout and stderr, and exits with the home's exit code. When Claude Code stops the command it kills this process;
// the socket drops and the host ends the command's process group on the home.
//
// Started as `rg` (`--rg`, the box's PATH has it first), it is the bridge Claude Code's Grep and Glob run ripgrep
// through: the home's own `rg` with the same arguments, each one quoted, in the same folder, its output and exit code
// passed back as they are. So a search is one command on the home's own disk, as a Bash command is, never a walk of
// the mount.
//
// It holds nothing of the run: no descriptor beyond 0-2 reaches it (P4), and it reads no variable but the named ones.
// Node built-ins only, so the box runs this one file as it is.

import { readlinkSync, writeSync } from "node:fs";
import { connect } from "node:net";
import { constants } from "node:os";

const SOCKET = "/run/qorpera-home/shell.sock";
const FORWARDED = [
	"CLAUDECODE",
	"CLAUDE_CODE_ENTRYPOINT",
	"CLAUDE_CODE_SESSION_ID",
	"GIT_EDITOR",
	"TMPDIR",
	"TERM",
	"COLUMNS",
] as const;

function write(fd: number, bytes: Buffer): void {
	for (let done = 0; done < bytes.length; ) done += writeSync(fd, bytes, done);
}

/** The home's folders the box sees at the same paths through its mount (cloud-claude-box.ts). */
const HOME_FOLDERS = ["/company/", "/var/lib/qorpera-agent/", "/tmp/"];

/**
 * One argument of ripgrep's as the home must see it. For a single file Claude Code opens the file itself and hands
 * ripgrep the open descriptor's path (`/dev/fd/N`); that descriptor is the box's, so the home is given the file it
 * names instead, and only when that file is one of the home's own folders seen through the mount. Anything else (a
 * file of the box's, `/proc`) stays a descriptor path the home does not have: ripgrep there fails, and nothing of the
 * box is searched or crosses.
 */
function homeArgument(arg: string): string {
	if (!/^\/(?:dev\/fd|proc\/self\/fd)\/\d{1,6}$/.test(arg)) return arg;
	try {
		const target = readlinkSync(arg.startsWith("/dev/fd/") ? `/proc/self/fd/${arg.slice(8)}` : arg);
		return HOME_FOLDERS.some((folder) => target.startsWith(folder)) && !target.includes("\0") ? target : arg;
	} catch {
		return arg;
	}
}

function main(): void {
	const cmd =
		process.argv[2] === "--rg"
			? `exec rg ${process.argv
					.slice(3)
					.map((arg) => `'${homeArgument(arg).replaceAll("'", "'\\''")}'`)
					.join(" ")}`
			: (process.argv[2] ?? "");
	const env: Record<string, string> = {};
	for (const name of FORWARDED) {
		const text = process.env[name];
		if (text !== undefined) env[name] = text;
	}
	let cwd = "/company";
	try {
		cwd = process.cwd();
	} catch {
		// The folder went away on the home; the command runs in /company.
	}
	for (const signal of ["SIGTERM", "SIGINT", "SIGHUP", "SIGPIPE"] as const)
		process.on(signal, () => process.exit(128 + constants.signals[signal]));
	const socket = connect(SOCKET);
	let rest = "";
	let code = 255;
	socket.on("error", () => {
		write(2, Buffer.from("HOME_UNAVAILABLE: this agent's machine could not be reached.\n"));
		process.exit(255);
	});
	socket.on("connect", () => socket.write(`${JSON.stringify({ cmd, cwd, env })}\n`));
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		rest += chunk;
		let end = rest.indexOf("\n");
		while (end >= 0) {
			const line = rest.slice(0, end);
			rest = rest.slice(end + 1);
			end = rest.indexOf("\n");
			let message: { o?: string; e?: string; x?: number };
			try {
				message = JSON.parse(line) as typeof message;
			} catch {
				continue;
			}
			if (typeof message.o === "string") write(1, Buffer.from(message.o, "base64"));
			else if (typeof message.e === "string") write(2, Buffer.from(message.e, "base64"));
			else if (typeof message.x === "number") {
				code = Number.isInteger(message.x) && message.x >= 0 && message.x < 256 ? message.x : 255;
				process.exit(code);
			}
		}
	});
	socket.on("close", () => process.exit(code));
}

main();
