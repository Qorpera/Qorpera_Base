import type { CloudCompanyFolderHomeWindow } from "./cloud-company-folder-client.ts";

/** What the window needs of the folder client (`CloudCompanyFolderClient`): the three calls of 20260930754000. */
export interface CloudHomeWindowFolder {
	openHomeWindow(machineId: string, signal: AbortSignal): Promise<CloudCompanyFolderHomeWindow>;
	openHomeCall(request: { viewId: string; callId: string; commandHead: string }, signal: AbortSignal): Promise<void>;
	endHomeCall(request: { viewId: string; callId: string }, signal: AbortSignal): Promise<boolean>;
	bindHomeWindow(request: { viewId: string; sessionId: string }, signal: AbortSignal): Promise<void>;
}

/**
 * The runtime's use of the run's folder window on its home machine (20260930754000, the agent's home slice 3;
 * lanes/agent-box-20261113/HOME-PLAN.md).
 *
 * A home is a company machine on which the model works with its own shell and file tools. The home mounts this window,
 * not the company folder: the window belongs to exactly one run, so everything the home lists and reads is decided for
 * that run's own read rights in the folder service, every read it makes is recorded as that run's read, and every change
 * it saves is the run's. Around each native call the relay opens a call on the window, so a change made while the call
 * runs is credited to that call and carries the call's own receipt, as a write through `machine_run` does.
 *
 * If the window cannot be made, the session is not started: `open` answers with plain words for the model instead of a
 * window, and the relay says them and goes on without the home's own shell.
 */
export class CloudHomeFolderWindow {
	readonly #folder: CloudHomeWindowFolder;
	readonly viewId: string;
	readonly pass: string;
	readonly machineId: string;
	readonly placementId: string;
	readonly bootId: string;

	constructor(folder: CloudHomeWindowFolder, window: Extract<CloudCompanyFolderHomeWindow, { state: "open" }>) {
		this.#folder = folder;
		this.viewId = window.viewId;
		this.pass = window.pass;
		this.machineId = window.machineId;
		this.placementId = window.placementId;
		this.bootId = window.bootId;
	}

	/** Names this window on the home session's row once the relay has the session (20260930752000), so what arrives
	 * from that session can be read back to the window it was opened for. Said again it changes nothing. */
	async bindSession(sessionId: string, signal: AbortSignal): Promise<void> {
		await this.#folder.bindHomeWindow({ viewId: this.viewId, sessionId }, signal);
	}

	/** The call's own receipt is open on the window: what the window saves until `endCall` is credited to it. The call id
	 * is the receipt's id, which the relay began for this call. */
	async startCall(callId: string, commandHead: string, signal: AbortSignal): Promise<void> {
		await this.#folder.openHomeCall({ viewId: this.viewId, callId, commandHead: homeCallHead(commandHead) }, signal);
	}

	/** The call ended: what the window saves from now on no longer carries it. */
	async endCall(callId: string, signal: AbortSignal): Promise<void> {
		await this.#folder.endHomeCall({ viewId: this.viewId, callId }, signal);
	}
}

/** What the model is told when its home gives no window, in plain words: no steps, no commands, no terminal. */
const NO_WINDOW_WORDS = {
	MACHINE_NOT_FOUND:
		"This agent has no machine of its own right now, so it cannot work with its own shell and files. Start a machine first.",
	MACHINE_NOT_RUNNING:
		"The agent's machine is not running, so it cannot work with its own shell and files. Start or wake the machine and try again.",
	MACHINE_HELD_COMPANY_FOLDER:
		"This machine has held the whole company folder before, so it cannot show only what this piece of work may read. A fresh machine is needed for the agent's own shell and files.",
	MACHINE_HOLDS_OTHER_WORK:
		"This machine still holds work that this piece of work may not read, so it cannot be used for the agent's own shell and files. A fresh machine is needed.",
} as const satisfies Record<Extract<CloudCompanyFolderHomeWindow, { state: "refused" }>["reason"], string>;

/** What the model is told when the ask itself did not get through: the backend does not carry the window's calls yet
 * (a release rolls the migration before the runtime), the run's turn ended, or the folder could not answer. The
 * session is not started either way, which is what matters to the work. */
const NO_ASK_WORDS =
	"The agent's own shell and files could not be made ready just now, so this work goes on without them.";

/** A paused company is the run's own refusal, not a missing window: it is raised, so the run's pause handling sees it
 * as it does everywhere else. */
const PAUSED = "55000";

/** A command head the folder keeps with a call: the first line, at most 300 characters, as a machine command's is. */
export function homeCallHead(command: string): string {
	const line = command.split("\n", 1)[0]?.trim() ?? "";
	return (line.length === 0 ? "a command" : line).slice(0, 300);
}

/** Opens the run's window on its home machine before a session starts there. Either the window, or the plain words the
 * model is told; the relay starts no session without a window. */
export async function openHomeFolderWindow(
	folder: CloudHomeWindowFolder,
	machineId: string,
	signal: AbortSignal,
): Promise<{ window: CloudHomeFolderWindow } | { refused: string }> {
	let answer: CloudCompanyFolderHomeWindow;
	try {
		answer = await folder.openHomeWindow(machineId, signal);
	} catch (error) {
		// A backend without the migration refuses the call itself (the function is not there, or the native host does
		// not list it); so does a run whose turn ended. None of them is a reason to start a session.
		if (signal.aborted || (error as { code?: string })?.code === PAUSED) throw error;
		return { refused: NO_ASK_WORDS };
	}
	if (answer.state === "refused") return { refused: NO_WINDOW_WORDS[answer.reason] };
	return { window: new CloudHomeFolderWindow(folder, answer) };
}
