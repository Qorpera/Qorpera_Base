// W1c-3: a run's work log, its step lines and its work composer (RUNTIME-AGENT-MEMORY-TREE.md §4.5, §5.7, §7.5), as
// production opens them before the run's first provider request. Where the log is decides:
// - no log yet: an original attempt starts one; a resumed attempt whose earlier attempts made none (none of their steps
//   landed) goes on without one, as they did;
// - a log: only a resumed attempt continues it (W5b-2, `openCloudRunResume`); an original attempt refuses it;
// - off (the run's recorded memory mode is Agent notebooks, 20260930508000, a permanent gate; or the run has no
//   conversation tree): no log;
// - gone (a log made once and no longer there): CloudRunLogGone, so the run ends as it does when its log goes mid-run,
//   rather than go on unlogged past its earlier steps.
import type { CloudNativeContextComposition, CloudNativeContextRequest } from "./cloud-native-context-composition.ts";
import { CloudRunLog, type CloudRunLogFolder, type CloudRunLogPlace, CloudRunLogUnavailable } from "./cloud-run-log.ts";
import { type CloudRunResumePort, openCloudRunResume } from "./cloud-run-resume.ts";
import { CloudRunStepLines, type CloudRunStepLinesOptions } from "./memory-tree/step-lines.ts";

export interface CloudRunLogOpened {
	readonly log: CloudRunLog;
	readonly lines: CloudRunStepLines;
	/** The run's work composer (§5.7): one per run, its requests one at a time. */
	readonly composeContext: (
		request: CloudNativeContextRequest,
		signal: AbortSignal,
	) => Promise<CloudNativeContextComposition>;
}

/** Null when the run keeps no log. Await it before the run's first provider request or step. */
export async function openCloudRunLog(options: {
	readonly resume: CloudRunResumePort;
	readonly folder: CloudRunLogFolder;
	readonly log: Omit<
		ConstructorParameters<typeof CloudRunLog>[0],
		"folder" | "conversationId" | "parent" | "continues" | "narrow" | "firstStep"
	>;
	readonly lines: Omit<CloudRunStepLinesOptions, "log" | "firstStep" | "signal">;
}): Promise<CloudRunLogOpened | null> {
	const { resume, folder } = options;
	const { runId, signal } = options.log;
	if (resume.runId !== runId) throw new CloudRunLogUnavailable("resume_run_mismatch");
	signal.throwIfAborted();
	let place: CloudRunLogPlace;
	try {
		place = await folder.locate(runId, signal);
	} catch (error) {
		if (error instanceof CloudRunLogUnavailable && error.reason === "off") return null;
		throw error;
	}
	if (place.exists) {
		const resumed = await openCloudRunResume(options);
		// An original attempt never writes over a log: it would number its steps from 0 again.
		if (resumed === null) throw new CloudRunLogUnavailable("log_exists");
		return { log: resumed.log, lines: resumed.lines, composeContext: resumed.composeContext };
	}
	if ((await resume.context(signal)) !== null) return null;
	if (!place.origin) throw new CloudRunLogUnavailable("origin_unavailable");
	const origin = place.origin;
	const log = new CloudRunLog({
		...options.log,
		folder,
		conversationId: origin.conversation,
		...(origin.parent === null ? {} : { parent: { runId: origin.parent, step: origin.step! } }),
		...(origin.continues === null ? {} : { continues: origin.continues }),
		narrow: origin.narrow,
	});
	const lines = new CloudRunStepLines({ ...options.lines, log, signal });
	return { log, lines, composeContext: lines.composeContext() };
}
