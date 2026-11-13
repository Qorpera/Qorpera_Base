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
	const folder: CloudHomeWindowFolder = {
		openHomeWindow: async () => answer,
		openHomeCall: async (request) => {
			opened.push(request);
		},
		endHomeCall: async (request) => {
			ended.push(request);
			return true;
		},
	};
	return { folder, opened, ended };
}

describe("the run's window on its home", () => {
	it("opens the window and keeps a call on it under the call's own receipt", async () => {
		const { folder, opened, ended } = folderThat({
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

	it("keeps a command head to one line and 300 characters", () => {
		expect(homeCallHead("  ls /company  \nrm -rf x")).toBe("ls /company");
		expect(homeCallHead("")).toBe("a command");
		expect(homeCallHead("\n\n")).toBe("a command");
		expect(homeCallHead("a".repeat(400))).toHaveLength(300);
	});
});
