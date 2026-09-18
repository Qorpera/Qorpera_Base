import { type ChildProcess, spawn } from "node:child_process";
import type { FileHandle } from "node:fs/promises";
import type { Duplex } from "node:stream";

/** Bubblewrap's monitor can fork before its PID-1 child has armed PDEATHSIG.
 * Killing the monitor in that window can orphan a namespace. A trusted gate
 * runs under Tini as PID 1, after bwrap has installed PDEATHSIG. Until that gate
 * reports ready, stop closes the permission pipe instead of killing the monitor.
 * EOF cannot execute the requested program. Once armed, SIGKILL terminates the
 * namespace's PID 1 and therefore all descendants, including setsid daemons.
 * The caller must still await child.close; a stuck setup is an unknown drain.
 * Whole-service crash recovery additionally requires systemd KillMode=control-group.
 */
export function spawnCompanyComputerLinuxProcess(options: {
	args: readonly string[];
	command: readonly string[];
	files: readonly FileHandle[];
	/** Chromium's broker-only DevTools pipes occupy descriptors 3 and 4. */
	pipeCount?: 2;
	/** Dedicated measured Bubblewrap copy permits Chromium's nested sandbox on AppArmor hosts. */
	browserSandbox?: { appArmor: boolean };
	stdin: "pipe" | "ignore";
}): { child: ChildProcess; started: Promise<void>; stop(): void } {
	const pipeCount = options.pipeCount ?? 0;
	const permissionFd = 3 + pipeCount + options.files.length;
	const readyFd = permissionFd + 1;
	const profileGate = options.browserSandbox?.appArmor
		? `IFS= read -r profile </proc/self/attr/current || exit 126; [[ "$profile" == 'qorpera-office-browser-bwrap (enforce)' ]] || exit 126; `
		: "";
	const gate = `${profileGate}printf 'ready\\n' >&${readyFd}; exec ${readyFd}>&-; IFS= read -r permission <&${permissionFd} || exit 125; exec ${permissionFd}<&-; [[ "$permission" == start ]] || exit 125; exec "$@"`;
	const child = spawn(
		options.browserSandbox ? "/usr/local/lib/qorpera/qorpera-browser-bwrap" : "/usr/bin/bwrap",
		[
			"--as-pid-1",
			...options.args,
			"--",
			"/usr/bin/tini",
			"-p",
			"SIGKILL",
			"--",
			"/usr/bin/bash",
			"--noprofile",
			"--norc",
			"-c",
			gate,
			"qorpera-office-launch",
			...options.command,
		],
		{
			cwd: "/",
			env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
			detached: true,
			stdio: [
				options.stdin,
				"pipe",
				"pipe",
				...Array.from({ length: pipeCount }, () => "pipe" as const),
				...options.files.map((file) => file.fd),
				"pipe",
				"pipe",
			],
		},
	);
	const permission = child.stdio[permissionFd] as Duplex;
	const ready = child.stdio[readyFd] as Duplex;
	let armed = false;
	let cancelled = false;
	let exited = false;
	let bytes = Buffer.alloc(0);
	let resolveStarted: () => void = () => undefined;
	let rejectStarted: (error: Error) => void = () => undefined;
	const started = new Promise<void>((resolve, reject) => {
		resolveStarted = resolve;
		rejectStarted = reject;
	});
	void started.catch(() => undefined);
	const stop = (): void => {
		cancelled = true;
		permission.end();
		if (armed && !exited) child.kill("SIGKILL");
	};
	permission.on("error", () => undefined);
	ready.on("error", () => {
		stop();
		rejectStarted(new Error("OFFICE_PROCESS_GATE_FAILED"));
	});
	const timeout = setTimeout(() => {
		stop();
		rejectStarted(new Error("OFFICE_PROCESS_GATE_TIMEOUT"));
	}, 5000);
	ready.on("data", (part: Buffer) => {
		if (bytes.length + part.length > 6) {
			stop();
			rejectStarted(new Error("OFFICE_PROCESS_GATE_FAILED"));
			return;
		}
		bytes = Buffer.concat([bytes, part]);
		if (bytes.length === 6) {
			clearTimeout(timeout);
			if (bytes.toString("ascii") !== "ready\n") {
				stop();
				rejectStarted(new Error("OFFICE_PROCESS_GATE_FAILED"));
				return;
			}
			armed = true;
			if (cancelled) {
				stop();
				rejectStarted(new Error("OFFICE_PROCESS_GATE_CANCELLED"));
			} else {
				permission.end("start\n");
				resolveStarted();
			}
		}
	});
	child.once("error", () => {
		clearTimeout(timeout);
		rejectStarted(new Error("OFFICE_PROCESS_START_FAILED"));
	});
	child.once("close", () => {
		exited = true;
		clearTimeout(timeout);
		permission.destroy();
		ready.destroy();
		if (!armed) rejectStarted(new Error("OFFICE_PROCESS_EXITED_BEFORE_START"));
	});
	return { child, started, stop };
}
