import { lstat } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import {
	askCompanyComputerFolderHelper,
	COMPANY_COMPUTER_FOLDER_BOUNDARY_MAXIMUM_MS,
	COMPANY_COMPUTER_FOLDER_HELPER_SOCKET,
	type CompanyComputerFolderAnswer,
} from "./cloud-company-computer-folder-helper-client.ts";

const LIST_WAIT_MS = 10000;
/** What a boundary leaves of the time for the helper's unmount after it (a mount unit's stop takes at most 20 s,
 * mostly far less) and for a drop. */
const UNMOUNT_MS = 10000;
/** The least a boundary is asked with: the helper takes at least a second. */
const BOUNDARY_LEAST_MS = 1000;

/**
 * The stop control's step "The office's stop publishes the mounts left" (RUNTIME-FOLDER-COMPANY-MACHINES.md): once the
 * office service's cgroup is empty, before the stop writes its completion, every mount the folder helper still holds
 * gets its boundary and goes (`unmount`), all at once, by `until` (performance.now()). A command's boundary is its
 * final one: its processes are gone. A desktop's is not: the view's reads stay the core's to settle.
 *
 * No answer, a refusal a retry gets past (QRC01, the run check), or one with no reason that leaves a change waiting
 * (the core did not answer the commit, or a path still waits) throws once every mount was asked: the stop has no
 * completion, the provider dispatches it again, and the next run, finding its claim retained, asks again with nearly
 * all its time. Every other answer is final for its mount (rule 4's refusal, the company's pause, `denied`), whose
 * changes are refused and whose report says why; a mount it left goes without a boundary (`drop`). The helper logs
 * each boundary's report as it answers (`companyComputerFolderAnswerLogged`: the refusal, the commit and how many paths
 * had each outcome, never a path or a reason), and its journal outlives the office service: that is a stop's report
 * ("The report"). The stop control writes nothing, since its locked child runs with no output. An image without the
 * helper has no socket and no mount: every mount is made through it.
 */
export async function publishCompanyComputerFoldersLeft(
	signal: AbortSignal,
	until: number,
	options: {
		/** The helper's socket; the image's by default. */
		socket?: string;
		/** Test seam for the helper. */
		ask?: typeof askCompanyComputerFolderHelper;
	} = {},
): Promise<void> {
	const socket = options.socket ?? COMPANY_COMPUTER_FOLDER_HELPER_SOCKET,
		ask = options.ask ?? askCompanyComputerFolderHelper;
	signal.throwIfAborted();
	try {
		if (!(await lstat(socket)).isSocket()) throw new Error("OFFICE_FOLDER_HELPER_UNCONFIRMED");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
		throw error;
	}
	const left = () => Math.floor(until - performance.now());
	if (left() < UNMOUNT_MS + BOUNDARY_LEAST_MS) throw new Error("OFFICE_FOLDERS_LEFT_LATE");
	const listed = await ask({ op: "list" }, { socket, timeoutMs: Math.min(LIST_WAIT_MS, left()), signal });
	if (listed?.answer !== "list") throw new Error("OFFICE_FOLDERS_LEFT_UNLISTED");
	const settled = await Promise.allSettled(
		listed.mounts.map(async ({ name }) => {
			const timeoutMs = Math.min(COMPANY_COMPUTER_FOLDER_BOUNDARY_MAXIMUM_MS, left() - UNMOUNT_MS);
			if (timeoutMs < BOUNDARY_LEAST_MS) throw new Error("OFFICE_FOLDERS_LEFT_LATE");
			const final = name.startsWith("command-");
			const answer = await ask({ op: "unmount", name, final, timeoutMs }, { socket, timeoutMs: left(), signal });
			if (!isFinal(answer, final)) throw new Error("OFFICE_FOLDERS_LEFT_UNANSWERED");
			if (answer.answer === "unknown" || answer.unmounted) return;
			const dropped = (await ask({ op: "drop", name }, { socket, timeoutMs: Math.max(1, left()), signal }))?.answer;
			if (dropped !== "dropped" && dropped !== "unknown") throw new Error("OFFICE_FOLDERS_LEFT_KEPT");
		}),
	);
	signal.throwIfAborted();
	if (settled.some((result) => result.status === "rejected")) throw new Error("OFFICE_FOLDERS_LEFT_UNPUBLISHED");
}

/** Whether the helper's answer is final for the mount: every one but no answer, `unanswered` (QRC01 among them), the
 * run check's refusal, and a refusal with no reason that leaves a change waiting: a command's final the view did not
 * close, or another boundary that kept a path. `unknown`: the mount is gone already. */
function isFinal(
	answer: CompanyComputerFolderAnswer<"unmount"> | undefined,
	final: boolean,
): answer is Exclude<CompanyComputerFolderAnswer<"unmount">, { answer: "invalid" }> {
	if (answer === undefined || answer.answer === "invalid" || answer.answer === "unanswered") return false;
	if (answer.answer !== "refused") return true;
	const { report } = answer;
	if (report.refused === "run_ended") return false;
	if (report.refused !== undefined || report.closed) return true;
	return !final && !report.paths.some((entry) => entry.kept);
}
