import { describe, expect, it } from "vitest";
import type { CloudCompanyFolderHomeWindow } from "../src/cloud-company-folder-client.ts";
import { type CloudHomeWindowFolder, homeCallHead, openHomeFolderWindow } from "../src/cloud-home-folder-window.ts";

/** The runtime's use of the run's folder window on its home machine (20260930754000, the agent's home slice 3). The
 * relay asks for the window before it starts a session on the home; without one the session is not started and the
 * model is told why in plain words. Around each native call it opens and ends a call on the window, under the call's
 * own receipt id, so what the window saves then is credited to that call. */
const MACHINE = "7e570000-1111-4222-8333-444455556666";
const VIEW = "40bb0001-0000-4a00-8b00-000000000001";
const PASS = "homepass_0123456789-abcdefghijklmnopqrstuvw";
const CALL = "ca110001-0000-4a00-8b00-000000000001";

/** A folder that answers `answer` and records the calls opened and ended on the window. */
function folderThat(answer: CloudCompanyFolderHomeWindow) {
	const opened: { viewId: string; callId: string; commandHead: string }[] = [];
	const ended: { viewId: string; callId: string }[] = [];
	const bound: { viewId: string; sessionId: string }[] = [];
	const folder: CloudHomeWindowFolder = {
		openHomeWindow: async () => answer,
		openHomeCall: async (request) => {
			opened.push(request);
		},
		endHomeCall: async (request) => {
			ended.push(request);
			return true;
		},
		bindHomeWindow: async (request) => {
			bound.push(request);
		},
	};
	return { folder, opened, ended, bound };
}

describe("the run's window on its home", () => {
	it("opens the window and keeps a call on it under the call's own receipt", async () => {
		const { folder, opened, ended, bound } = folderThat({
			state: "open",
			viewId: VIEW,
			pass: PASS,
			machineId: MACHINE,
			placementId: MACHINE,
			bootId: "b0070000-0000-4a00-8b00-000000000001",
		});
		const answer = await openHomeFolderWindow(folder, MACHINE, AbortSignal.timeout(5_000));
		if (!("window" in answer)) throw new Error("no window");
		expect(answer.window.viewId).toBe(VIEW);
		expect(answer.window.pass).toBe(PASS);
		await answer.window.startCall(CALL, "npm test --silent\nand more", AbortSignal.timeout(5_000));
		await answer.window.endCall(CALL, AbortSignal.timeout(5_000));
		expect(opened).toEqual([{ viewId: VIEW, callId: CALL, commandHead: "npm test --silent" }]);
		expect(ended).toEqual([{ viewId: VIEW, callId: CALL }]);
		// The session the relay then opens names this window on its own row (20260930752000).
		const SESSION = "5e550001-0000-4a00-8b00-000000000001";
		await answer.window.bindSession(SESSION, AbortSignal.timeout(5_000));
		expect(bound).toEqual([{ viewId: VIEW, sessionId: SESSION }]);
	});

	it("tells the model in plain words when the home gives no window, and starts no session", async () => {
		for (const [reason, says] of [
			["MACHINE_NOT_FOUND", /no machine of its own/],
			["MACHINE_NOT_RUNNING", /is not running/],
			["MACHINE_HELD_COMPANY_FOLDER", /held the whole company folder/],
		] as const) {
			const { folder } = folderThat({ state: "refused", reason });
			const answer = await openHomeFolderWindow(folder, MACHINE, AbortSignal.timeout(5_000));
			if (!("refused" in answer)) throw new Error("a window where none was given");
			expect(answer.refused).toMatch(says);
			// Plain words: nothing of steps, commands or a terminal, and no id the member cannot place.
			expect(answer.refused).not.toMatch(/window|view|mount|shell command|terminal|[\da-f]{8}/i);
		}
	});

	it("tells the model in plain words when the ask itself does not get through, and raises a pause", async () => {
		// A backend without the migration refuses the call (the function is not there, or the native host does not list
		// it); the session is not started and the words name no window, view or id.
		const refusing = (error: Error): CloudHomeWindowFolder => ({
			openHomeWindow: async () => {
				throw error;
			},
			openHomeCall: async () => undefined,
			endHomeCall: async () => true,
			bindHomeWindow: async () => undefined,
		});
		for (const code of ["42883", "42501", "PGRST202"]) {
			const error = Object.assign(new Error("refused"), { code });
			const answer = await openHomeFolderWindow(refusing(error), MACHINE, AbortSignal.timeout(5_000));
			if (!("refused" in answer)) throw new Error("a window where the ask was refused");
			expect(answer.refused).toMatch(/could not be made ready just now/);
			expect(answer.refused).not.toMatch(/window|view|mount|terminal|[\da-f]{8}/i);
		}
		// A paused company is the run's own refusal, not a missing window.
		const paused = Object.assign(new Error("Company execution is paused"), { code: "55000" });
		await expect(openHomeFolderWindow(refusing(paused), MACHINE, AbortSignal.timeout(5_000))).rejects.toThrow(
			/paused/,
		);
	});

	it("keeps a command head to one line and 300 characters", () => {
		expect(homeCallHead("  ls /company  \nrm -rf x")).toBe("ls /company");
		expect(homeCallHead("")).toBe("a command");
		expect(homeCallHead("\n\n")).toBe("a command");
		expect(homeCallHead("a".repeat(400))).toHaveLength(300);
	});
});
