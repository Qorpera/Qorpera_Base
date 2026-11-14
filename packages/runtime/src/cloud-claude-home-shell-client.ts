// Claude Code's CLAUDE_CODE_SHELL_PREFIX inside the box (slice C2; P4's `home-shell.py`). Claude Code runs
// `<prefix> '<the full shell invocation>'` for each Bash command. This sends the invocation, the working folder and the
// variables named below to the run's host over the box's one shell socket, writes the home's output to its own
// stdout and stderr, and exits with the home's exit code. When Claude Code stops the command it kills this process;
// the socket drops and the host ends the command's process group on the home.
//
// It holds nothing of the run: no descriptor beyond 0-2 reaches it (P4), and it reads no variable but the named ones.
// Node built-ins only, so the box runs this one file as it is.

import { writeSync } from "node:fs";
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

function main(): void {
	const cmd = process.argv[2] ?? "";
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
