import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { CodeHostCommand, CodeHostShell } from "../../src/code-host-jobs.ts";

/** The stand-in for LXD exec: the same command as a local process, stdout capped, the end of stderr kept. */
export function localShell(log: CodeHostCommand[]): CodeHostShell {
	return {
		run: (command, signal) =>
			new Promise((resolve, reject) => {
				log.push(command);
				const child = spawn(command.argv[0], command.argv.slice(1), {
					cwd: command.cwd,
					env: { ...command.env },
					stdio: ["pipe", "pipe", "pipe"],
					signal,
				});
				const out: Buffer[] = [];
				let size = 0,
					stderr = "";
				child.stdout.on("data", (chunk: Buffer) => {
					size += chunk.length;
					if (size > command.maximumOutputBytes) {
						child.kill("SIGKILL");
						reject(new Error("CODE_HOST_OUTPUT_TOO_LARGE"));
					} else out.push(chunk);
				});
				child.stderr.on("data", (chunk: Buffer) => {
					stderr = (stderr + chunk.toString("utf8")).slice(-4000);
				});
				child.on("error", reject);
				child.on("close", (status) => resolve({ status: status ?? 128, stdout: Buffer.concat(out), stderr }));
				child.stdin.on("error", () => {});
				if (command.stdin === undefined) child.stdin.end();
				else if (command.stdin instanceof Uint8Array) child.stdin.end(command.stdin);
				else pipeline(Readable.from(command.stdin), child.stdin).catch(() => {});
			}),
	};
}
