import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { composeStudioPreview } from "../src/surface-studio-patches.ts";

describe("studio surface folder_patch overlay engine", () => {
	it("merges non-overlapping JSON token changes and text edits in memory", () => {
		const c1 = randomUUID();
		const c2 = randomUUID();
		const result = composeStudioPreview(
			{
				"brand/tokens.json": JSON.stringify({ colors: { accent: "#d76f45", paper: "#ffffff" }, font: "SF" }),
				"brand/voice.md": "Calm and direct.\n",
			},
			[
				{
					changeId: c1,
					ops: [{ op: "merge_json", path: "brand/tokens.json", patch: { colors: { accent: "#c9643b" } } }],
				},
				{
					changeId: c2,
					ops: [
						{ op: "merge_json", path: "brand/tokens.json", patch: { colors: { paper: "#f8f6f2" } } },
						{ op: "write_text", path: "brand/voice.md", content: "Warm, quiet, Danish craft.\n" },
					],
				},
			],
		);

		expect(result.status).toBe("ready");
		if (result.status !== "ready") throw new Error("expected ready studio preview");
		expect(result.appliedChangeIds).toEqual([c1, c2]);
		expect(JSON.parse(result.files["brand/tokens.json"]!)).toEqual({
			colors: { accent: "#c9643b", paper: "#f8f6f2" },
			font: "SF",
		});
		expect(result.files["brand/voice.md"]).toBe("Warm, quiet, Danish craft.\n");
	});

	it("detects overlapping JSON token key conflicts while preserving the last clean snapshot", () => {
		const c1 = randomUUID();
		const c2 = randomUUID();
		const result = composeStudioPreview({ "brand/tokens.json": JSON.stringify({ colors: { accent: "#d76f45" } }) }, [
			{
				changeId: c1,
				ops: [{ op: "merge_json", path: "brand/tokens.json", patch: { colors: { accent: "#c9643b" } } }],
			},
			{
				changeId: c2,
				ops: [{ op: "merge_json", path: "brand/tokens.json", patch: { colors: { accent: "#1f5e5b" } } }],
			},
		]);

		expect(result.status).toBe("conflicted");
		if (result.status !== "conflicted") throw new Error("expected studio conflict");
		expect(result.appliedChangeIds).toEqual([c1]);
		expect(result.conflictReport).toEqual({
			changeIds: [c1, c2],
			paths: ["brand/tokens.json"],
		});
		expect(JSON.parse(result.files["brand/tokens.json"]!)).toEqual({
			colors: { accent: "#c9643b" },
		});
	});
});
