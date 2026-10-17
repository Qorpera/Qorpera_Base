import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { leaveCleanStop, takeCleanStop } from "../src/folder-service/clean-stop.ts";

/** The note a clean stop of the folder service leaves its next run (F3 5g-5): the machines it vouched for, taken and
 * removed at the next start, before anything is served. */
const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const FIRST = "c0d1e5e5-0001-4a00-8b00-0000000000a1";
const SECOND = "c0d1e5e5-0002-4a00-8b00-0000000000a2";
const NOTE = "clean-stop.json";
const SCHEMA = "qorpera.folder-service-clean-stop/v1";

function runtime(): { directory: string; lines: string[]; log: (line: string) => void } {
	const directory = mkdtempSync(join(tmpdir(), "qorpera-folder-clean-stop-"));
	directories.push(directory);
	const lines: string[] = [];
	return { directory, lines, log: (line) => lines.push(line) };
}

describe("the clean-stop note", () => {
	it("is left whole by a clean stop, and taken and removed at the next start: a crash after leaves none", () => {
		const { directory, lines, log } = runtime();
		leaveCleanStop(directory, [FIRST, SECOND, FIRST], new Date("2026-10-17T12:00:00.000Z"));
		const path = join(directory, NOTE);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			schema: SCHEMA,
			stoppedAt: "2026-10-17T12:00:00.000Z",
			machines: [FIRST, SECOND],
		});
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(existsSync(join(directory, `${NOTE}.writing`))).toBe(false);
		expect(takeCleanStop(directory, log)).toEqual([FIRST, SECOND]);
		expect(existsSync(path)).toBe(false);
		expect(lines).toEqual(["folder-service: the last run stopped cleanly; it vouched for 2 machines"]);
		// The run after a crash of that one finds none: it vouches for no machine.
		expect(takeCleanStop(directory, log)).toEqual([]);
		expect(lines.at(-1)).toBe(
			"folder-service: the last run left no clean stop: every machine is lost until it restarts",
		);
		// A clean stop that vouched for none leaves a note all the same.
		leaveCleanStop(directory, []);
		expect(takeCleanStop(directory, log)).toEqual([]);
		expect(lines.at(-1)).toBe("folder-service: the last run stopped cleanly; it vouched for 0 machines");
	});

	it("vouches for no machine from a note this service did not write, and removes it, with a half-written one", () => {
		const note = (value: unknown) => `${JSON.stringify(value)}\n`;
		const good = { schema: SCHEMA, stoppedAt: "2026-10-17T12:00:00.000Z", machines: [FIRST] };
		for (const text of [
			"{",
			note([FIRST]),
			note(null),
			note({ ...good, schema: "qorpera.folder-service-clean-stop/v2" }),
			note({ ...good, extra: true }),
			note({ schema: SCHEMA, machines: [FIRST] }),
			note({ ...good, stoppedAt: 0 }),
			note({ ...good, machines: FIRST }),
			note({ ...good, machines: [FIRST, "machine-1"] }),
			note({ ...good, machines: [FIRST.toUpperCase()] }),
		]) {
			const { directory, lines, log } = runtime();
			writeFileSync(join(directory, NOTE), text);
			writeFileSync(join(directory, `${NOTE}.writing`), note(good));
			expect(takeCleanStop(directory, log), text).toEqual([]);
			expect(lines).toEqual([
				"folder-service: the clean-stop note is not one this service wrote",
				"folder-service: the last run left no clean stop: every machine is lost until it restarts",
			]);
			expect(existsSync(join(directory, NOTE))).toBe(false);
			expect(existsSync(join(directory, `${NOTE}.writing`))).toBe(false);
		}
	});

	it("does not read a note larger than any this service writes", () => {
		const { directory, lines, log } = runtime();
		writeFileSync(join(directory, NOTE), " ".repeat(4 * 1024 * 1024 + 1));
		expect(takeCleanStop(directory, log)).toEqual([]);
		expect(lines).toEqual([
			"folder-service: the clean-stop note is over 4194304 bytes",
			"folder-service: the last run left no clean stop: every machine is lost until it restarts",
		]);
		expect(existsSync(join(directory, NOTE))).toBe(false);
	});

	it("stops the service at its start when the note cannot be removed", () => {
		const { directory, log } = runtime();
		const missing = join(directory, "gone");
		expect(() => takeCleanStop(missing, log)).toThrow(`The clean-stop note in ${missing} cannot be removed`);
		expect(() => leaveCleanStop(missing, [FIRST])).toThrow();
	});
});
