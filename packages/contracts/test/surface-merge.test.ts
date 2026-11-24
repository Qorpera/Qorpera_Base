import { describe, expect, it } from "vitest";
import {
	composeReconciledFolderChanges,
	mergeJsonThreeWay,
	mergeStudioTextContent,
	mergeTextThreeWay,
} from "../src/surface-merge.ts";

describe("surface-merge", () => {
	it("merges non-overlapping text edits cleanly", () => {
		const base = "# Brand\n\nPrimary: #0055ff\n\n## Voice\nClear and direct.\n\n## Notes\nInitial.\n";
		const ours = "# Brand\n\nPrimary: #3388ff\n\n## Voice\nClear and direct.\n\n## Notes\nInitial.\n";
		const theirs =
			"# Brand\n\nPrimary: #0055ff\n\n## Voice\nClear and direct.\n\n## Notes\nInitial.\n\n## Journey\nBuyer and seller flow.\n";

		const result = mergeTextThreeWay(base, ours, theirs);
		expect(result).toEqual({
			ok: true,
			content:
				"# Brand\n\nPrimary: #3388ff\n\n## Voice\nClear and direct.\n\n## Notes\nInitial.\n\n## Journey\nBuyer and seller flow.\n",
		});
	});

	it("returns ok=true when both sides make the exact same edit", () => {
		const base = "line 1\nline 2\nline 3\n";
		const edited = "line 1\nupdated\nline 3\n";
		expect(mergeTextThreeWay(base, edited, edited)).toEqual({ ok: true, content: edited });
	});

	it("merges disjoint edits on consecutive lines cleanly", () => {
		const base = "--blue: #0055ff;\n--red: #ff0000;\n--ink: #111111;\n";
		const ours = "--blue: #3388ff;\n--red: #ff0000;\n--ink: #111111;\n";
		const theirs = "--blue: #0055ff;\n--red: #ee2222;\n--ink: #111111;\n";
		expect(mergeTextThreeWay(base, ours, theirs)).toEqual({
			ok: true,
			content: "--blue: #3388ff;\n--red: #ee2222;\n--ink: #111111;\n",
		});
	});

	it("reports conflict when both sides edit the same line differently", () => {
		const base = "accent: #0055ff\n";
		const ours = "accent: #3388ff\n";
		const theirs = "accent: #ff4444\n";
		expect(mergeTextThreeWay(base, ours, theirs)).toEqual({ ok: false });
	});

	it("reports conflict when both sides insert differently at the same offset", () => {
		const base = "header\n";
		const ours = "header\nsection A\n";
		const theirs = "header\nsection B\n";
		expect(mergeTextThreeWay(base, ours, theirs)).toEqual({ ok: false });
	});

	it("merges disjoint JSON object keys three-way even when formatted differently", () => {
		const base = JSON.stringify({ colors: { blue: "#0055ff", ink: "#111" }, font: "Inter" });
		const ours = JSON.stringify({ colors: { blue: "#3388ff", ink: "#111" }, font: "Inter" }, null, 2);
		const theirs = JSON.stringify({
			colors: { blue: "#0055ff", ink: "#111", surface: "#090909" },
			font: "Inter",
			journey: "journey.svg",
		});
		const merged = mergeJsonThreeWay(base, ours, theirs);
		expect(merged.ok).toBe(true);
		if (merged.ok) {
			expect(JSON.parse(merged.content)).toEqual({
				colors: { blue: "#3388ff", ink: "#111", surface: "#090909" },
				font: "Inter",
				journey: "journey.svg",
			});
		}
	});

	it("conflicts on same JSON leaf key edited to different values", () => {
		const base = JSON.stringify({ colors: { blue: "#0055ff" } });
		const ours = JSON.stringify({ colors: { blue: "#3388ff" } });
		const theirs = JSON.stringify({ colors: { blue: "#22aaff" } });
		expect(mergeJsonThreeWay(base, ours, theirs)).toEqual({ ok: false });
	});

	it("handles delete vs unchanged and delete vs edit via mergeStudioTextContent", () => {
		expect(mergeStudioTextContent("identity/old.md", "v1\n", null, "v1\n")).toEqual({ ok: true, content: null });
		expect(mergeStudioTextContent("identity/old.md", "v1\n", "v2\n", null)).toEqual({ ok: false });
		expect(mergeStudioTextContent("identity/new.md", null, "a\n", "b\n")).toEqual({ ok: false });
		expect(mergeStudioTextContent("identity/new.md", null, "same\n", "same\n")).toEqual({
			ok: true,
			content: "same\n",
		});
	});

	it("preserves untouched JSON formatting and number spellings via line merge and refuses unsafe >2^53 integers on structural fallback", () => {
		const baseFormatted = '{\n  "version": 1.10,\n  "bigId": 9007199254740993,\n  "a": 1,\n  "b": 2\n}\n';
		const oursFormatted = '{\n  "version": 1.10,\n  "bigId": 9007199254740993,\n  "a": 10,\n  "b": 2\n}\n';
		const theirsFormatted = '{\n  "version": 1.10,\n  "bigId": 9007199254740993,\n  "a": 1,\n  "b": 20\n}\n';
		const mergedFormatted = mergeJsonThreeWay(baseFormatted, oursFormatted, theirsFormatted);
		expect(mergedFormatted).toEqual({
			ok: true,
			content: '{\n  "version": 1.10,\n  "bigId": 9007199254740993,\n  "a": 10,\n  "b": 20\n}\n',
		});

		const baseInline = '{"bigId":9007199254740993,"a":1,"b":2}';
		const oursInline = '{"bigId":9007199254740993,"a":10,"b":2}';
		const theirsInline = '{"bigId":9007199254740993,"a":1,"b":20}';
		expect(mergeJsonThreeWay(baseInline, oursInline, theirsInline)).toEqual({ ok: false });
		expect(mergeStudioTextContent("tokens.json", baseInline, oursInline, theirsInline)).toEqual({ ok: false });
	});

	it("preserves non-conflicting ops and rejects reconciled manifests missing required conflict paths", () => {
		const changeA = {
			changeId: "a",
			ops: [
				{ op: "write_text" as const, path: "identity/report.md", content: "A report" },
				{ op: "write_text" as const, path: "identity/diagram.svg", content: "<svg/>" },
			],
		};
		const changeB = {
			changeId: "b",
			ops: [{ op: "write_text" as const, path: "identity/report.md", content: "B report" }],
		};

		const incomplete = composeReconciledFolderChanges(
			[changeA, changeB],
			[{ op: "write_text", path: "identity/notes.md", content: "wrong file" }],
			{ folderRoot: "identity", conflictPaths: ["identity/report.md"] },
		);
		expect(incomplete).toEqual({ ok: false, missingPaths: ["identity/report.md"] });

		const complete = composeReconciledFolderChanges(
			[changeA, changeB],
			[{ op: "write_text", path: "report.md", content: "Combined report" }],
			{ folderRoot: "identity", conflictPaths: ["identity/report.md"] },
		);
		expect(complete.ok).toBe(true);
		if (complete.ok) {
			expect(complete.preservedChanges).toEqual([
				{
					changeId: "a",
					ops: [{ op: "write_text", path: "identity/diagram.svg", content: "<svg/>" }],
				},
			]);
			expect(complete.reconciledOps).toEqual([{ op: "write_text", path: "report.md", content: "Combined report" }]);
		}
	});
});
