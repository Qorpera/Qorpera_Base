import { relative } from "node:path";

export const TEST_FILE_SECONDS: Readonly<Record<string, number>> = {
	"test/cloud-native-company-runtime.test.ts": 28,
	"test/cloud-action-review.test.ts": 22,
	"test/cloud-machine-command-http.test.ts": 20,
	"test/cloud-codex-tool-session.test.ts": 20,
	"test/cloud-coding-guest-agent.test.ts": 18,
	"test/cloud-surface-tools.test.ts": 16,
	"test/cloud-machine-tools.test.ts": 16,
	"test/cloud-native-company-context.test.ts": 14,
	"test/cloud-company-folder-client.test.ts": 14,
	"test/cloud-code-tools.test.ts": 12,
	"test/cloud-run-log.test.ts": 12,
	"test/cloud-wake-bus.test.ts": 12,
	"test/cloud-native-coding-runtime.test.ts": 12,
	"test/cloud-claude-box-start.test.ts": 12,
	"test/cloud-native-transport.test.ts": 12,
	"test/shared-vault-secrets.test.ts": 12,
	"test/cloud-agent-instruction-rules.test.ts": 10,
	"test/cloud-app-kits.test.ts": 10,
	"test/cloud-folder-file-tools.test.ts": 10,
	"test/cloud-surface-session-runner.test.ts": 9,
	"test/cloud-site-tools.test.ts": 9,
	"test/cloud-native-tool-operations.test.ts": 9,
	"test/cloud-machine-guest.test.ts": 8,
	"test/cloud-code-checks.test.ts": 8,
	"test/cloud-coding-repository-fetch.test.ts": 8,
};
const UNLISTED_SECONDS = 0.5;
export const fileSeconds = (path: string): number => TEST_FILE_SECONDS[path] ?? UNLISTED_SECONDS;
export const slowestFirst = (a: string, b: string): number =>
	fileSeconds(b) - fileSeconds(a) || (a < b ? -1 : a > b ? 1 : 0);

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

export function slowestSpecsFirst<T extends { moduleId: string }>(specs: readonly T[], root: string): T[] {
	return [...specs].sort((a, b) => fileSeconds(relative(root, b.moduleId)) - fileSeconds(relative(root, a.moduleId)));
}
