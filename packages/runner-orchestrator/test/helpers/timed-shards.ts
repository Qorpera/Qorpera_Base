import { relative } from "node:path";

/** Seconds each slow test file of this package took on a quiet test machine (the whole package in one vitest, 4 workers,
 * node02, 7-8 Nov; the deadline files and company-machine-host as they are since perf T10). `--shard=k/n` splits the
 * files by these (timedShare, vitest.config.ts) and each vitest starts its slowest files first. A file not named here
 * counts as UNLISTED_SECONDS (the 131 such files took 21 s together). A wrong or missing entry costs balance only: shares
 * 1/n to n/n still run every file exactly once. */
export const TEST_FILE_SECONDS: Readonly<Record<string, number>> = {
	"test/lxd-office-boot-successor-worker.test.ts": 55,
	"test/lxd-office-boot-activation-worker.test.ts": 35,
	"test/company-machine-host.test.ts": 31,
	"test/lxd-office-boot-configuration-worker.test.ts": 30,
	"test/lxd-office-later-boot-worker.test.ts": 28,
	"test/lxd-office-boot-stop-worker.test.ts": 27,
	"test/lxd-office-reset-successor-lane.test.ts": 27,
	"test/lxd-office-power-off-worker.test.ts": 27,
	"test/lxd-office-reset-worker.test.ts": 24,
	"test/lxd-office-resume-worker.test.ts": 24,
	"test/lxd-office-successor-worker.test.ts": 22,
	"test/lxd-office-service-stop-worker.test.ts": 18,
	"test/coding-executor-host.test.ts": 17,
	"test/lxd-office-stop-retries.test.ts": 17,
	"test/lxd-office-activation-worker.test.ts": 16,
	"test/lxd-login-gateway.test.ts": 16,
	"test/lxd-office-configuration-worker.test.ts": 16,
	"test/lxd-office-retirement-worker.test.ts": 14,
	"test/lxd-office-boot-activation-evidence.test.ts": 13,
	"test/orchestrator-wake.test.ts": 12,
	"test/lxd-provider-concurrency.test.ts": 9,
	"test/lxd-office-idle-policy.test.ts": 9,
	"test/orchestrator.test.ts": 7,
	"test/lxd-office-service-bootstrap-revisions.test.ts": 7,
	"test/lxd-office-preparation-recovery-history.test.ts": 5,
	"test/lxd-office-provider-tls.test.ts": 5,
	"test/lxd-office-preparation-worker.test.ts": 5,
	"test/company-machine-host-storage.test.ts": 4,
	"test/lxd-office-host-reboot.test.ts": 4,
	"test/coding-git.test.ts": 4,
	"test/code-host-jobs.test.ts": 3,
	"test/lxd-office-lifecycle.test.ts": 3,
	"test/code-host.test.ts": 3,
	"test/lxd-office-preparation-execution.test.ts": 2,
	"test/lxd-office-preparation-transport.test.ts": 2,
	"test/code-host-repositories.test.ts": 2,
	"test/code-host-seed.test.ts": 2,
	"test/coding-machine.test.ts": 2,
	"test/lxd-provider.test.ts": 2,
	"test/lxd-exec-pipe.test.ts": 2,
};
const UNLISTED_SECONDS = 0.2;
export const fileSeconds = (path: string): number => TEST_FILE_SECONDS[path] ?? UNLISTED_SECONDS;
/** The slowest first, then by path. */
export const slowestFirst = (a: string, b: string): number =>
	fileSeconds(b) - fileSeconds(a) || (a < b ? -1 : a > b ? 1 : 0);

/** The `index`-th of `count` shares (from 1) of `paths`, by time: the slowest first, each to the share with the least time
 * so far (on a tie, the lower share). The same paths give the same split in any order and on every machine, so shares 1
 * to `count` run each path exactly once, and no share has more than the slowest file above another's. */
export function timedShare(paths: readonly string[], index: number, count: number): string[] {
	if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(index) || index < 1 || index > count)
		throw new Error(`Invalid shard ${index}/${count}`);
	if (new Set(paths).size !== paths.length) throw new Error("A test file is listed twice");
	const loads = new Array<number>(count).fill(0);
	const share: string[] = [];
	for (const path of [...paths].sort(slowestFirst)) {
		let least = 0;
		for (let k = 1; k < count; k++) if (loads[k] < loads[least]) least = k;
		loads[least] += fileSeconds(path);
		if (least === index - 1) share.push(path);
	}
	return share;
}

/** The `index`-th of `count` shares of vitest's test files (each with its absolute `moduleId`), by timedShare of their
 * paths from `root`: what vitest.config.ts gives vitest for `--shard`. */
export function timedSpecs<T extends { moduleId: string }>(
	specs: readonly T[],
	root: string,
	index: number,
	count: number,
): T[] {
	const share = new Set(
		timedShare(
			specs.map((spec) => relative(root, spec.moduleId)),
			index,
			count,
		),
	);
	return specs.filter((spec) => share.has(relative(root, spec.moduleId)));
}

/** `specs` with the slowest files first, in their given order otherwise (vitest's own: by size when it has no timings). */
export function slowestSpecsFirst<T extends { moduleId: string }>(specs: readonly T[], root: string): T[] {
	return [...specs].sort((a, b) => fileSeconds(relative(root, b.moduleId)) - fileSeconds(relative(root, a.moduleId)));
}
