/**
 * One idle rule for every machine (the 2026-10-03 amendment "one idle rule for every machine", item 1): a program keeps
 * its machine awake while it is busy, and a program that only waits does not. Every machine kind measures its programs
 * (a Company Computer's shell, an agent's machine command, a coding session) with these two signals over one sample of
 * about 30 seconds; the thresholds live here so they are tuned in one place.
 */

/**
 * Busy by processor: at least 5% of one core over the sample, whatever the machine's size (busy is what a program
 * does). A waiting dev server, idle database or watcher stays far below it; a build, test run or crawl far above.
 */
export const IDLE_RULE_BUSY_CORE_SHARE = 0.05;

/**
 * Busy by data moved: at least 512 KiB read or written in a 30-second sample, about 17 KB a second, counted as the
 * bytes the program's processes pass to read and write calls on files, pipes and terminals (a download writes what it
 * receives; a socket's send and recv alone do not count). A slow download, an
 * npm install waiting on the network or an upload is working even when it uses little processor; a waiting server,
 * a prompt waiting on a person or a browser tab on a loaded page moves about nothing (the coordinator, 4 October 2026).
 */
export const IDLE_RULE_BUSY_BYTES_PER_SAMPLE = 512 * 1024;
/** The sample the byte threshold is stated for; a longer or shorter sample scales it. */
export const IDLE_RULE_SAMPLE_SECONDS = 30;

/** One sample of a program: its processor time and the bytes it moved so far, and when (milliseconds). */
export interface IdleRuleSample {
	readonly cpuSeconds: number;
	readonly ioBytes: number;
	readonly at: number;
}

/**
 * Whether a program was busy between two samples of the same running program. No time between them, or a clock that
 * went back, is never busy; counters that went down (a process left the program) count as nothing.
 */
export function idleRuleBusy(before: IdleRuleSample, after: IdleRuleSample): boolean {
	const seconds = (after.at - before.at) / 1000;
	if (!(seconds > 0)) return false;
	return (
		after.cpuSeconds - before.cpuSeconds >= IDLE_RULE_BUSY_CORE_SHARE * seconds ||
		// Multiplied out, so whole bytes and milliseconds compare exactly.
		(after.ioBytes - before.ioBytes) * IDLE_RULE_SAMPLE_SECONDS >= IDLE_RULE_BUSY_BYTES_PER_SAMPLE * seconds
	);
}

/** The bytes a process passed to read and write calls so far (/proc/<pid>/io rchar + wchar); 0 when unreadable. */
export function idleRuleProcessIoBytes(io: string): number {
	const read = Number(/^rchar: ([0-9]+)$/m.exec(io)?.[1] ?? 0);
	const written = Number(/^wchar: ([0-9]+)$/m.exec(io)?.[1] ?? 0);
	return Number.isSafeInteger(read) && Number.isSafeInteger(written) ? read + written : 0;
}

/**
 * On an agent's machine, work outside its commands (containers, programs left behind) is busy while the whole
 * machine's processors, beyond what its commands and its own control used, are at least 2% busy over the sample:
 * a busy container counts, the machine's own quiet background does not.
 */
export const IDLE_RULE_OUTSIDE_BUSY_MACHINE_SHARE = 0.02;

/** One sample of a whole machine: processor time (seconds, all processors) busy, in total, and its own units' use. */
export interface IdleRuleMachineSample {
	readonly busySeconds: number;
	readonly totalSeconds: number;
	readonly ownSeconds: number;
}

/**
 * Whether work outside a machine's commands was busy between two samples of the same boot. Counters that went down
 * (a unit's group was stopped and started again) make the sample count as nothing.
 */
export function idleRuleOutsideBusy(before: IdleRuleMachineSample, after: IdleRuleMachineSample): boolean {
	const total = after.totalSeconds - before.totalSeconds,
		busy = after.busySeconds - before.busySeconds,
		own = after.ownSeconds - before.ownSeconds;
	if (!(total > 0) || busy < 0 || own < 0) return false;
	return busy - own >= IDLE_RULE_OUTSIDE_BUSY_MACHINE_SHARE * total;
}
