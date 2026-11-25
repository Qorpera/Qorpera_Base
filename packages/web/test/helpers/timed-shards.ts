import { relative } from "node:path";

export const TEST_FILE_SECONDS: Readonly<Record<string, number>> = {
	"test/computer-runtime.test.ts": 17.7,
	"test/mailbox.test.ts": 12.4,
	"test/agent-routines.test.ts": 10.9,
	"test/app-panel-actions.test.ts": 10.4,
	"test/app-panel.test.ts": 6.2,
	"test/application-lifecycle.test.ts": 5.4,
	"test/computer-explorer.test.ts": 5.4,
	"test/native-account-refresh.test.ts": 4.8,
	"test/conversation-ui.test.ts": 4.6,
	"test/session-execution-ui.test.ts": 3.9,
	"test/interface-mail.test.ts": 3.7,
	"test/app-kit-engines.test.ts": 3.6,
	"test/settings-connections.test.ts": 3.6,
	"test/surface-ux.test.ts": 3.5,
	"test/settings-lifecycle.test.ts": 3.4,
	"test/desktop-holds-explorer.test.ts": 2.7,
	"test/message-quotes.test.ts": 2.6,
	"test/surface-layout.test.ts": 2.6,
	"test/decisions-conversation.test.ts": 2.1,
	"test/surface-studio.test.ts": 1.8,
	"test/rail-sidebar.test.ts": 1.8,
	"test/interaction-card.test.ts": 1.7,
	"test/interface-apps.test.ts": 1.6,
	"test/surfaces-store.test.ts": 1.5,
	"test/surface-views.test.ts": 1.3,
	"test/member-contacts.test.ts": 1.3,
	"test/session-attachments-ui.test.ts": 1.3,
	"test/company-folder.test.ts": 1.2,
	"test/interfaces.test.ts": 1.1,
	"test/member-pictures.test.ts": 1.1,
	"test/code-download.test.ts": 1.0,
	"test/agent-details.test.ts": 1.0,
	"test/figure-motion.test.ts": 1.0,
	"test/language-time-zone.test.ts": 1.0,
	"test/shared-drafts.test.ts": 1.0,
	"test/settings-hooks.test.ts": 1.0,
	"test/code-import.test.ts": 1.0,
	"test/whats-new.test.ts": 1.0,
	"test/agent-at-computer.test.ts": 0.9,
	"test/company-founding.test.ts": 0.9,
};
const UNLISTED_SECONDS = 0.25;
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
		for (let k = 1; k < count; k++) if (loads[k]! < loads[least]!) least = k;
		loads[least] = loads[least]! + fileSeconds(path);
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
