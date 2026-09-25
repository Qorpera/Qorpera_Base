import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PaidComputerGuard, PaidComputerGuardJournal } from "../../packages/runner-orchestrator/src/computer-paid-guard.ts";
import { servePaidComputerGuard } from "../../packages/runner-orchestrator/src/computer-paid-guard-ipc.ts";
import { LxdPaidComputerGuardPhysical, readPaidComputerHostClock } from "../../packages/runner-orchestrator/src/computer-paid-guard-lxd.ts";
import { LxdUnixClient } from "../../packages/runner-orchestrator/src/lxd-client.ts";

const execute = promisify(execFile);
/** Separate service/process group, no network or database credentials, no NAS.
 * Systemd restarts a stalled event loop independently of the coding executor. */
export async function runPaidComputerGuardMain(): Promise<void> {
	if (process.platform !== "linux" || !process.getuid?.() || !process.geteuid?.() || !process.env.NOTIFY_SOCKET)
		throw new Error("PAID_GUARD_SUPERVISOR_REQUIRED");
	const stop = new AbortController();
	const shutdown = () => stop.abort(new Error("PAID_GUARD_SHUTDOWN"));
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
	let ready = false, notifying = false;
	const notify = async () => {
		if (!ready || notifying) return;
		notifying = true;
		try { await execute("/usr/bin/systemd-notify", ["WATCHDOG=1"], { timeout: 2000, maxBuffer: 4096 }); }
		catch { stop.abort(new Error("PAID_GUARD_SUPERVISOR_UNCONFIRMED")); }
		finally { notifying = false; }
	};
	const timer = setInterval(() => { void notify(); }, 3000);
	try {
		await servePaidComputerGuard({
			guard: new PaidComputerGuard(new PaidComputerGuardJournal("/var/lib/qorpera-paid-computer-guard"),
				new LxdPaidComputerGuardPhysical(new LxdUnixClient(), readPaidComputerHostClock), readPaidComputerHostClock),
			socketPath: "/run/qorpera-paid-computer-guard/control.sock", signal: stop.signal,
			report: (state) => {
				if (state === "ready") void execute("/usr/bin/systemd-notify", ["--ready"], { timeout: 2000, maxBuffer: 4096 })
					.then(() => { ready = true; }).catch(() => stop.abort(new Error("PAID_GUARD_SUPERVISOR_UNCONFIRMED")));
				else console.error("PAID_GUARD_STOP_UNCONFIRMED");
			},
		});
		if (stop.signal.reason instanceof Error && stop.signal.reason.message !== "PAID_GUARD_SHUTDOWN") throw stop.signal.reason;
	} finally {
		clearInterval(timer);
		process.off("SIGTERM", shutdown);
		process.off("SIGINT", shutdown);
	}
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
	runPaidComputerGuardMain().catch(() => { console.error("PAID_GUARD_START_FAILED"); process.exitCode = 1; });
