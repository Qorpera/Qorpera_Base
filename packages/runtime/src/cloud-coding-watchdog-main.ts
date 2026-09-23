import { runCodingGuestWatchdog } from "./cloud-coding-watchdog.ts";

try {
	await runCodingGuestWatchdog();
} catch {
	process.stderr.write("CODING_GUEST_WATCHDOG_STOP_UNCONFIRMED\n");
	process.exitCode = 1;
}
