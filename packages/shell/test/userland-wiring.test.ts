import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const userland = join(import.meta.dirname, "..", "userland");
const rendererSource = readFileSync(join(userland, "renderer.js"), "utf-8");
const indexSource = readFileSync(join(userland, "index.html"), "utf-8");

describe("userland wiring", () => {
	it("only calls toast helpers that renderer.js actually defines", () => {
		// showControllerToast survived its own deletion as 19 call sites: every
		// settings error path threw ReferenceError inside an async onclick and
		// the failure vanished. Invitations went missing exactly this way.
		const called = new Set([...rendererSource.matchAll(/\b(show\w*Toast)\(/g)].map((match) => match[1]));
		expect(called.size).toBeGreaterThan(0);
		for (const name of called) {
			expect(rendererSource, `${name} is called but never defined`).toContain(`function ${name}(`);
		}
	});

	it("keeps settings tab buttons and SETTINGS_TABS in sync", () => {
		const registered = rendererSource.match(/const SETTINGS_TABS = new Set\(\[(.*?)\]\)/);
		expect(registered).not.toBeNull();
		const tabs = [...(registered?.[1] ?? "").matchAll(/"(\w+)"/g)].map((match) => match[1]);
		const buttons = [...indexSource.matchAll(/data-tab="(\w+)"/g)].map((match) => match[1]);
		expect(new Set(buttons)).toEqual(new Set(tabs));
		// Every button's click handler must open its own tab.
		for (const tab of buttons) {
			expect(indexSource).toContain(`onclick="openSettings('${tab}')"`);
		}
	});

	it("ranks leaderboards by fields the read model actually emits", () => {
		// Renaming a field in the read model would leave the board silently
		// rendering zeros, because a missing property sorts and formats fine.
		const readModel = readFileSync(
			join(import.meta.dirname, "..", "..", "coding-agent", "src", "core", "leaderboard-summary.ts"),
			"utf-8",
		);
		const staffFields = readModel
			.slice(readModel.indexOf("interface LeaderboardStaffActivity"))
			.slice(0, readModel.slice(readModel.indexOf("interface LeaderboardStaffActivity")).indexOf("}"));
		const metrics = [...rendererSource.matchAll(/\{ id: "(\w+)", label: "[^"]+", format:/g)].map((match) => match[1]);
		expect(metrics).toEqual(["tasksDone", "requests", "activeMs"]);
		for (const metric of metrics) {
			expect(staffFields, `${metric} is ranked but not emitted per staff member`).toContain(`${metric}:`);
		}
		// The board reads these off each row and off the company totals.
		for (const field of ["sessions:", "staffAgentId:"]) expect(staffFields).toContain(field);
		expect(readModel).toContain("totals: { activeMs: number; tasksDone: number; requests: number }");
		expect(rendererSource).toContain("/api/leaderboard?");
	});
});
