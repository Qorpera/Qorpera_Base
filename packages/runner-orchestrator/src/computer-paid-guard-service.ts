import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { PaidComputerGuard, PaidComputerGuardJournal } from "./computer-paid-guard.ts";
import { servePaidComputerGuard } from "./computer-paid-guard-ipc.ts";
import { LxdPaidComputerGuardPhysical, readPaidComputerHostClock } from "./computer-paid-guard-lxd.ts";
import { LxdUnixClient } from "./lxd-client.ts";

const execute = promisify(execFile);
/** Separate service/process group, no network or database credentials, no NAS.
 * Systemd restarts a stalled event loop independently of the provider. Each
 * provider account has its own private socket and persistent guard journal. */
export async function runPaidComputerGuardMain(
	scope: "coding" | "native" | "office" = "coding",
	lxdSocketPath = "/var/snap/lxd/common/lxd/unix.socket",
): Promise<void> {
	if (
		!["coding", "native", "office"].includes(scope) ||
		resolve(lxdSocketPath) !== lxdSocketPath ||
		/[\x00-\x20]/.test(lxdSocketPath)
	)
		throw new Error("PAID_GUARD_CONFIG_INVALID");
	const name = scope === "coding" ? "qorpera-paid-computer-guard" : `qorpera-${scope}-computer-guard`;
	if (process.platform !== "linux" || !process.getuid?.() || !process.geteuid?.() || !process.env.NOTIFY_SOCKET)
		throw new Error("PAID_GUARD_SUPERVISOR_REQUIRED");
	const stop = new AbortController();
	const shutdown = () => stop.abort(new Error("PAID_GUARD_SHUTDOWN"));
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
	let startupProgressAt = performance.now();
	let ready = false,
		notifying = false;
	const notify = async () => {
		if (notifying || (!ready && performance.now() - startupProgressAt > 10000)) return;
		notifying = true;
		try {
			await execute("/usr/bin/systemd-notify", [ready ? "WATCHDOG=1" : "EXTEND_TIMEOUT_USEC=20000000"], {
				timeout: 2000,
				maxBuffer: 4096,
			});
		} catch {
			stop.abort(new Error("PAID_GUARD_SUPERVISOR_UNCONFIRMED"));
		} finally {
			notifying = false;
		}
	};
	const timer = setInterval(() => {
		void notify();
	}, 3000);
	try {
		await servePaidComputerGuard({
			guard: new PaidComputerGuard(
				new PaidComputerGuardJournal(`/var/lib/${name}`),
				new LxdPaidComputerGuardPhysical(new LxdUnixClient(lxdSocketPath), readPaidComputerHostClock),
				readPaidComputerHostClock,
			),
			socketPath: `/run/${name}/control.sock`,
			signal: stop.signal,
			startupProgress: () => {
				startupProgressAt = performance.now();
			},
			report: (state) => {
				if (state === "ready")
					void execute("/usr/bin/systemd-notify", ["--ready"], { timeout: 2000, maxBuffer: 4096 })
						.then(() => {
							ready = true;
						})
						.catch(() => stop.abort(new Error("PAID_GUARD_SUPERVISOR_UNCONFIRMED")));
				else console.error("PAID_GUARD_STOP_UNCONFIRMED");
			},
		});
		if (stop.signal.reason instanceof Error && stop.signal.reason.message !== "PAID_GUARD_SHUTDOWN")
			throw stop.signal.reason;
	} finally {
		clearInterval(timer);
		process.off("SIGTERM", shutdown);
		process.off("SIGINT", shutdown);
	}
}
