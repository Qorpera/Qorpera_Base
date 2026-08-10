import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setTheme, stopThemeWatcher } from "../../../src/modes/interactive/theme/theme.ts";

interface ActiveHandle {
	constructor?: { name?: string };
	emit?: (event: string, error: Error) => boolean;
	listenerCount?: (event: string) => number;
}

/**
 * Regression test for https://github.com/earendil-works/pi-mono/issues/2791
 *
 * fs.watch() returns an FSWatcher (EventEmitter). If the watcher emits an
 * 'error' event after creation and no error handler is attached, Node.js
 * treats it as an uncaught exception and terminates the process.
 *
 * We test this in-process by:
 * 1. Sets up a custom theme with the watcher enabled
 * 2. Finds the FSWatcher via process._getActiveHandles()
 * 3. Emits a synthetic 'error' event on it
 * 4. Verifying the watcher has an error handler
 * 5. Emitting the error and verifying it is handled without throwing
 */
describe("issue #2791 fs.watch error event crashes process", () => {
	let tempRoot: string;
	let originalAgentDir: string | undefined;

	beforeEach(() => {
		originalAgentDir = process.env.QORPERA_CODING_AGENT_DIR;
		tempRoot = mkdtempSync(join(tmpdir(), "pi-2791-"));
		const agentDir = join(tempRoot, "agent");
		const themesDir = join(agentDir, "themes");
		mkdirSync(themesDir, { recursive: true });

		// Copy dark.json as "custom-test" theme
		const darkThemePath = join(__dirname, "../../../src/modes/interactive/theme/dark.json");
		const darkTheme = JSON.parse(readFileSync(darkThemePath, "utf-8"));
		darkTheme.name = "custom-test";
		writeFileSync(join(themesDir, "custom-test.json"), JSON.stringify(darkTheme, null, 2));
	});

	afterEach(() => {
		stopThemeWatcher();
		if (originalAgentDir === undefined) delete process.env.QORPERA_CODING_AGENT_DIR;
		else process.env.QORPERA_CODING_AGENT_DIR = originalAgentDir;
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it("process should survive an error event on the theme FSWatcher", () => {
		process.env.QORPERA_CODING_AGENT_DIR = join(tempRoot, "agent");
		expect(setTheme("custom-test", true)).toEqual({ success: true });

		const handles = (process as unknown as { _getActiveHandles: () => ActiveHandle[] })._getActiveHandles();
		const fsWatcher = handles.find((handle) => handle.constructor?.name === "FSWatcher");
		expect(fsWatcher, "no FSWatcher found among active handles").toBeDefined();
		expect(fsWatcher?.listenerCount?.("error")).toBeGreaterThan(0);
		expect(() => fsWatcher?.emit?.("error", new Error("simulated OS watcher failure"))).not.toThrow();
	});
});
