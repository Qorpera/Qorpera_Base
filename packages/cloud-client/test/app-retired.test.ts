import { describe, expect, it } from "vitest";
import {
	APP_RETIRED_HEADING,
	APP_RETIRED_MAX_LINES,
	APP_RETIRED_PATH,
	bringBackApp,
	isAppRetiredPath,
	parseRetiredApps,
	retireApp,
} from "../src/app-retired.ts";
import { appPath } from "../src/interface-apps.ts";

const MEMBER = "6f1d2c3b-4a5e-4f60-8172-93a4b5c6d7e8";
const OTHER = "0b0c3f1e-5a7d-4c2e-9f10-1a2b3c4d5e6f";
const FILE = `# Retired interfaces
- old-plan | ${MEMBER} | 2026-11-15T09:30:00Z
- sales-week | ${OTHER} | 2026-11-14T18:02:11.250Z
`;

describe("apps/retired.md", () => {
	it("reads one retired interface a line: its folder name, who retired it and when", () => {
		expect(APP_RETIRED_PATH).toBe("apps/retired.md");
		expect(parseRetiredApps(FILE)).toEqual([
			{ name: "old-plan", by: MEMBER, at: "2026-11-15T09:30:00Z" },
			{ name: "sales-week", by: OTHER, at: "2026-11-14T18:02:11.250Z" },
		]);
		// It is no app's folder: nothing that lists apps/ takes it for one.
		expect(appPath(APP_RETIRED_PATH)).toBeNull();
		expect(isAppRetiredPath("Apps/Retired.MD")).toBe(true);
		expect(isAppRetiredPath("apps/retired")).toBe(false);
		expect(isAppRetiredPath("apps/old-plan/retired.md")).toBe(false);
	});

	it("reads no file, or an empty one, as none retired", () => {
		expect(parseRetiredApps(null)).toEqual([]);
		expect(parseRetiredApps("")).toEqual([]);
		expect(parseRetiredApps(`${APP_RETIRED_HEADING}\n`)).toEqual([]);
	});

	it("skips a line it cannot read and keeps reading, and the first line of a name wins", () => {
		const text = [
			"# Retired interfaces",
			"Some words a member wrote.",
			`- Bad_Name | ${MEMBER} | 2026-11-15T09:30:00Z`,
			"- no-member | someone | 2026-11-15T09:30:00Z",
			`- no-time | ${MEMBER} | yesterday`,
			`- bad-day | ${MEMBER} | 2026-13-45T09:30:00Z`,
			`- two | parts | ${MEMBER}`,
			"- old-plan",
			`  - old-plan | ${MEMBER.toUpperCase()} | 2026-11-15T09:30:00Z\r`,
			`- old-plan | ${OTHER} | 2026-11-16T10:00:00Z`,
			`* starred | ${MEMBER} | 2026-11-15T09:30:00Z`,
		].join("\n");
		expect(parseRetiredApps(text)).toEqual([{ name: "old-plan", by: MEMBER, at: "2026-11-15T09:30:00Z" }]);
	});

	it(`reads at most the first ${APP_RETIRED_MAX_LINES} lines`, () => {
		const lines = Array.from({ length: 250 }, (_, i) => `- app-${i} | ${MEMBER} | 2026-11-15T09:30:00Z`);
		const read = parseRetiredApps(lines.join("\n"));
		expect(read).toHaveLength(APP_RETIRED_MAX_LINES);
		expect(read.at(-1)?.name).toBe(`app-${APP_RETIRED_MAX_LINES - 1}`);
	});

	it("retires an app with a line at the end, every other byte as written", () => {
		expect(retireApp(null, "old-plan", MEMBER, "2026-11-15T09:30:00Z")).toBe(
			`# Retired interfaces\n- old-plan | ${MEMBER} | 2026-11-15T09:30:00Z\n`,
		);
		expect(retireApp("", "old-plan", MEMBER.toUpperCase(), "2026-11-15T09:30:00Z")).toBe(
			`# Retired interfaces\n- old-plan | ${MEMBER} | 2026-11-15T09:30:00Z\n`,
		);
		const kept = "# Retired\r\nA note.\r\n- x | not a line\r\n";
		const next = retireApp(kept, "board", OTHER, "2026-11-15T10:00:00.000Z");
		expect(next).toBe(`${kept}- board | ${OTHER} | 2026-11-15T10:00:00.000Z\n`);
		expect(retireApp("# Retired", "board", OTHER, "2026-11-15T10:00:00Z")).toBe(
			`# Retired\n- board | ${OTHER} | 2026-11-15T10:00:00Z\n`,
		);
		expect(parseRetiredApps(next).map((app) => app.name)).toEqual(["board"]);
	});

	it("answers the text unchanged for an app already retired, and null when the line would not be read", () => {
		expect(retireApp(FILE, "old-plan", OTHER, "2026-11-16T09:30:00Z")).toBe(FILE);
		const full = `${Array.from({ length: APP_RETIRED_MAX_LINES }, (_, i) => `- app-${i} | ${MEMBER} | 2026-11-15T09:30:00Z`).join("\n")}\n`;
		expect(retireApp(full, "one-more", MEMBER, "2026-11-15T09:30:00Z")).toBeNull();
		expect(() => retireApp(null, "Bad_Name", MEMBER, "2026-11-15T09:30:00Z")).toThrow();
		expect(() => retireApp(null, "board", "someone", "2026-11-15T09:30:00Z")).toThrow();
		expect(() => retireApp(null, "board", MEMBER, "now")).toThrow();
	});

	it("brings an app back by taking its lines out, every other byte as written", () => {
		expect(bringBackApp(FILE, "old-plan")).toBe(
			`# Retired interfaces\n- sales-week | ${OTHER} | 2026-11-14T18:02:11.250Z\n`,
		);
		expect(bringBackApp(bringBackApp(FILE, "old-plan"), "sales-week")).toBe("# Retired interfaces\n");
		// Every line of the name goes, so no later one makes it retired again.
		const twice = `${FILE}- old-plan | ${OTHER} | 2026-11-16T10:00:00Z`;
		expect(parseRetiredApps(bringBackApp(twice, "old-plan")).map((app) => app.name)).toEqual(["sales-week"]);
		// Its last line goes with no line break after it: the one before keeps its own.
		expect(bringBackApp(twice, "old-plan")).toBe(
			`# Retired interfaces\n- sales-week | ${OTHER} | 2026-11-14T18:02:11.250Z`,
		);
		// Carriage returns stay.
		const crlf = FILE.replaceAll("\n", "\r\n");
		expect(bringBackApp(crlf, "sales-week")).toBe(
			`# Retired interfaces\r\n- old-plan | ${MEMBER} | 2026-11-15T09:30:00Z\r\n`,
		);
	});

	it("answers the text unchanged for an app that is not retired", () => {
		expect(bringBackApp(FILE, "board")).toBe(FILE);
		expect(bringBackApp("", "board")).toBe("");
		expect(bringBackApp("- old-plan\n", "old-plan")).toBe("- old-plan\n");
	});

	it("brings back what it retired, to the same text", () => {
		const next = retireApp(FILE, "board", MEMBER, "2026-11-15T11:00:00Z");
		expect(next).not.toBeNull();
		expect(bringBackApp(next as string, "board")).toBe(FILE);
	});
});
