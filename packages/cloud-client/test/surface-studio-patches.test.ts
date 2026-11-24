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

	it("resolves folder-relative patch paths via resolveStudioFolderPath and rejects unsafe segments like ./", () => {
		const c1 = randomUUID();
		const c2 = randomUUID();
		const merged = composeStudioPreview(
			{
				"identity/tokens.json": JSON.stringify({ colors: { primary: "#18181b", accent: "#2563eb" } }),
				"identity/voice.md": "Base voice.\n",
				"QorperaOS/surfaces/identity/notes/note.md": "Loaded note.\n",
			},
			[
				{
					changeId: c1,
					ops: [
						{ op: "merge_json", path: "tokens.json", patch: { colors: { accent: "#c9643b" } } },
						{ op: "write_text", path: "voice.md", content: "Warm Danish voice.\n" },
						{ op: "write_text", path: "QorperaOS/surfaces/identity/notes/note.md", content: "Under root.\n" },
					],
				},
			],
			"identity",
		);
		expect(merged.status).toBe("ready");
		expect(Object.keys(merged.files).sort()).toEqual([
			"QorperaOS/surfaces/identity/notes/note.md",
			"identity/QorperaOS/surfaces/identity/notes/note.md",
			"identity/tokens.json",
			"identity/voice.md",
		]);
		expect(JSON.parse(merged.files["identity/tokens.json"]!)).toEqual({
			colors: { primary: "#18181b", accent: "#c9643b" },
		});
		expect(merged.files["identity/voice.md"]).toBe("Warm Danish voice.\n");
		expect(merged.files["QorperaOS/surfaces/identity/notes/note.md"]).toBe("Loaded note.\n");
		expect(merged.files["identity/QorperaOS/surfaces/identity/notes/note.md"]).toBe("Under root.\n");

		const dotSegment = composeStudioPreview(
			{ "identity/voice.md": "Base voice.\n" },
			[{ changeId: c1, ops: [{ op: "write_text", path: "./voice.md", content: "Bad segment.\n" }] }],
			"identity",
		);
		expect(dotSegment.status).toBe("conflicted");
		if (dotSegment.status !== "conflicted") throw new Error("expected unsafe path conflict");
		expect(dotSegment.conflictReport.paths).toEqual(["./voice.md"]);

		const conflicted = composeStudioPreview(
			{ "identity/tokens.json": JSON.stringify({ colors: { accent: "#2563eb" } }) },
			[
				{
					changeId: c1,
					ops: [{ op: "merge_json", path: "tokens.json", patch: { colors: { accent: "#c9643b" } } }],
				},
				{
					changeId: c2,
					ops: [{ op: "merge_json", path: "identity/tokens.json", patch: { colors: { accent: "#1f5e5b" } } }],
				},
			],
			"identity",
		);
		expect(conflicted.status).toBe("conflicted");
		if (conflicted.status !== "conflicted") throw new Error("expected studio conflict");
		expect(conflicted.conflictReport.paths).toEqual(["identity/tokens.json"]);
	});

	describe("write_file binaries", () => {
		const model = {
			manifestSha256: "1".repeat(64),
			fileSha256: "2".repeat(64),
			bytes: 2048,
			mediaType: "model/gltf-binary",
		};
		const photo = {
			manifestSha256: "3".repeat(64),
			fileSha256: "4".repeat(64),
			bytes: 512,
			mediaType: "image/webp",
		};

		it("shows a write_file in binaries and drops it when the change is toggled off", () => {
			const c1 = randomUUID();
			const base = { "product/spec.md": "Spec.\n" };
			const on = composeStudioPreview(
				base,
				[{ changeId: c1, ops: [{ op: "write_file", path: "model.glb", file: model }] }],
				"product",
			);
			expect(on.status).toBe("ready");
			expect(on.binaries).toEqual({ "product/model.glb": model });
			expect(on.files).toEqual(base);

			const off = composeStudioPreview(base, [], "product");
			expect(off.binaries).toEqual({});
			expect(off.files).toEqual(base);
		});

		it("lets a later delete or write_text in the same change replace a write_file", () => {
			const c1 = randomUUID();
			const deleted = composeStudioPreview({}, [
				{
					changeId: c1,
					ops: [
						{ op: "write_file", path: "product/model.glb", file: model },
						{ op: "delete", path: "product/model.glb" },
					],
				},
			]);
			expect(deleted.status).toBe("ready");
			expect(deleted.binaries).toEqual({});
			expect(deleted.files).toEqual({});

			const text = composeStudioPreview({}, [
				{
					changeId: c1,
					ops: [
						{ op: "write_file", path: "product/notes.txt", file: photo },
						{ op: "write_text", path: "product/notes.txt", content: "Now text.\n" },
					],
				},
			]);
			expect(text.binaries).toEqual({});
			expect(text.files).toEqual({ "product/notes.txt": "Now text.\n" });

			const binary = composeStudioPreview({ "product/hero.webp": "placeholder" }, [
				{ changeId: c1, ops: [{ op: "write_file", path: "product/hero.webp", file: photo }] },
			]);
			expect(binary.binaries).toEqual({ "product/hero.webp": photo });
			expect(binary.files).toEqual({});
		});

		it("treats two changes writing one path like two whole-file writes", () => {
			const c1 = randomUUID();
			const c2 = randomUUID();
			const result = composeStudioPreview({}, [
				{ changeId: c1, ops: [{ op: "write_file", path: "product/model.glb", file: model }] },
				{ changeId: c2, ops: [{ op: "write_file", path: "product/model.glb", file: { ...model, bytes: 4096 } }] },
			]);
			expect(result.status).toBe("conflicted");
			if (result.status !== "conflicted") throw new Error("expected studio conflict");
			expect(result.appliedChangeIds).toEqual([c1]);
			expect(result.conflictReport).toEqual({ changeIds: [c1, c2], paths: ["product/model.glb"] });
			expect(result.binaries).toEqual({ "product/model.glb": model });
		});

		it("conflicts on merge_json against a binary path", () => {
			const c1 = randomUUID();
			const c2 = randomUUID();
			const sameChange = composeStudioPreview({}, [
				{
					changeId: c1,
					ops: [
						{ op: "write_file", path: "product/model.glb", file: model },
						{ op: "merge_json", path: "product/model.glb", patch: { scale: 2 } },
					],
				},
			]);
			expect(sameChange.status).toBe("conflicted");
			if (sameChange.status !== "conflicted") throw new Error("expected studio conflict");
			expect(sameChange.conflictReport).toEqual({ changeIds: [c1], paths: ["product/model.glb"] });
			expect(sameChange.binaries).toEqual({});

			const onBase = composeStudioPreview(
				{},
				[{ changeId: c2, ops: [{ op: "merge_json", path: "product/model.glb", patch: { scale: 2 } }] }],
				null,
				{ "product/model.glb": model },
			);
			expect(onBase.status).toBe("conflicted");
			if (onBase.status !== "conflicted") throw new Error("expected studio conflict");
			expect(onBase.conflictReport.paths).toEqual(["product/model.glb"]);
			expect(onBase.binaries).toEqual({ "product/model.glb": model });
			expect(onBase.files).toEqual({});
		});

		it("passes base binaries through and lets a change replace or delete them", () => {
			const c1 = randomUUID();
			const baseBinaries = { "product/model.glb": model, "product/hero.webp": photo };
			const untouched = composeStudioPreview({ "product/spec.md": "Spec.\n" }, [], "product", baseBinaries);
			expect(untouched.binaries).toEqual(baseBinaries);

			const changed = composeStudioPreview(
				{},
				[
					{
						changeId: c1,
						ops: [
							{ op: "write_file", path: "model.glb", file: { ...model, fileSha256: "5".repeat(64) } },
							{ op: "delete", path: "hero.webp" },
						],
					},
				],
				"product",
				baseBinaries,
			);
			expect(changed.status).toBe("ready");
			expect(changed.binaries).toEqual({ "product/model.glb": { ...model, fileSha256: "5".repeat(64) } });
			expect(baseBinaries).toEqual({ "product/model.glb": model, "product/hero.webp": photo });

			const toText = composeStudioPreview(
				{},
				[{ changeId: c1, ops: [{ op: "write_text", path: "hero.webp", content: "text" }] }],
				"product",
				baseBinaries,
			);
			expect(toText.binaries).toEqual({ "product/model.glb": model });
			expect(toText.files).toEqual({ "product/hero.webp": "text" });
		});
	});

	describe("three-way merge and cached reconciliation overlays", () => {
		it("merges non-overlapping write_text edits on the same file across multiple changes", () => {
			const c1 = randomUUID();
			const c2 = randomUUID();
			const c3 = randomUUID();
			const base = {
				"identity/guide.md": "# Brand\n\nBlue: #0055ff\n\n## Voice\nDirect.\n\n## Footer\nEnd.\n",
			};
			const composed = composeStudioPreview(base, [
				{
					changeId: c1,
					ops: [
						{
							op: "write_text",
							path: "identity/guide.md",
							content: "# Brand\n\nBlue: #3388ff\n\n## Voice\nDirect.\n\n## Footer\nEnd.\n",
						},
					],
				},
				{
					changeId: c2,
					ops: [
						{
							op: "write_text",
							path: "identity/guide.md",
							content: "# Brand\n\nBlue: #0055ff\n\n## Voice\nDirect and warm.\n\n## Footer\nEnd.\n",
						},
					],
				},
				{
					changeId: c3,
					ops: [
						{
							op: "write_text",
							path: "identity/guide.md",
							content:
								"# Brand\n\nBlue: #0055ff\n\n## Voice\nDirect.\n\n## Footer\nEnd.\n\n## Journey\nBuyer flow.\n",
						},
					],
				},
			]);

			expect(composed.status).toBe("ready");
			expect(composed.appliedChangeIds).toEqual([c1, c2, c3]);
			expect(composed.files["identity/guide.md"]).toBe(
				"# Brand\n\nBlue: #3388ff\n\n## Voice\nDirect and warm.\n\n## Footer\nEnd.\n\n## Journey\nBuyer flow.\n",
			);
		});

		it("merges write_text and merge_json on disjoint keys of the same JSON file", () => {
			const c1 = randomUUID();
			const c2 = randomUUID();
			const base = {
				"identity/tokens.json": `${JSON.stringify({ colors: { blue: "#0055ff", ink: "#111" } }, null, 2)}\n`,
			};
			const composed = composeStudioPreview(base, [
				{
					changeId: c1,
					ops: [
						{
							op: "write_text",
							path: "identity/tokens.json",
							content: `${JSON.stringify({ colors: { blue: "#3388ff", ink: "#111" } }, null, 2)}\n`,
						},
					],
				},
				{
					changeId: c2,
					ops: [{ op: "merge_json", path: "identity/tokens.json", patch: { colors: { surface: "#080808" } } }],
				},
			]);

			expect(composed.status).toBe("ready");
			expect(JSON.parse(composed.files["identity/tokens.json"]!)).toEqual({
				colors: { blue: "#3388ff", ink: "#111", surface: "#080808" },
			});
		});

		it("slots in a cached reconciliation overlay for the conflicting cluster while composing unrelated changes", () => {
			const c1 = randomUUID();
			const c2 = randomUUID();
			const c3 = randomUUID();
			const recId = randomUUID();
			const base = {
				"identity/guide.md": "Accent: #0055ff\n",
				"identity/voice.md": "Plain.\n",
			};
			const change1 = {
				changeId: c1,
				ops: [{ op: "write_text" as const, path: "identity/guide.md", content: "Accent: #3388ff\n" }],
			};
			const change2 = {
				changeId: c2,
				ops: [
					{ op: "write_text" as const, path: "identity/guide.md", content: "Accent: #4499ff\nJourney: added\n" },
				],
			};
			const change3 = {
				changeId: c3,
				ops: [{ op: "write_text" as const, path: "identity/voice.md", content: "Sharp and calm.\n" }],
			};

			const withoutCache = composeStudioPreview(base, [change1, change3, change2]);
			expect(withoutCache.status).toBe("conflicted");
			if (withoutCache.status !== "conflicted") throw new Error("expected conflict");
			expect(withoutCache.conflictReport.changeIds).toEqual([c1, c2]);

			const reconciliations = [
				{
					id: recId,
					status: "ready" as const,
					selectedChangeIds: [c1, c2],
					patchManifest: [
						{
							op: "write_text" as const,
							path: "identity/guide.md",
							content: "Accent: #4499ff\nJourney: added\n",
						},
					],
					errorDetail: null,
				},
			];

			const withCache = composeStudioPreview(base, [change1, change3, change2], null, {}, { reconciliations });
			expect(withCache.status).toBe("ready");
			expect(withCache.appliedChangeIds).toEqual([c3, c1, c2]);
			expect(withCache.files["identity/guide.md"]).toBe("Accent: #4499ff\nJourney: added\n");
			expect(withCache.files["identity/voice.md"]).toBe("Sharp and calm.\n");

			const onlyChange2 = composeStudioPreview(base, [change2], null, {}, { reconciliations });
			expect(onlyChange2.status).toBe("ready");
			expect(onlyChange2.files["identity/guide.md"]).toBe("Accent: #4499ff\nJourney: added\n");
		});

		it("three-way merges a staged change using its recorded baseFiles after another change already landed", () => {
			const c2 = randomUUID();
			const baseAtStage = "# Brand\n\nBlue: #0055ff\n\n## Journey\nNone.\n";
			const liveAfterC1 = "# Brand\n\nBlue: #0055ff\n\n## Journey\nBuyer and seller flow.\n";
			const c2Content = "# Brand\n\nBlue: #3388ff\n\n## Journey\nNone.\n";

			const composed = composeStudioPreview({ "identity/guide.md": liveAfterC1 }, [
				{
					changeId: c2,
					baseFiles: { "identity/guide.md": baseAtStage },
					ops: [{ op: "write_text", path: "identity/guide.md", content: c2Content }],
				},
			]);

			expect(composed.status).toBe("ready");
			expect(composed.files["identity/guide.md"]).toBe(
				"# Brand\n\nBlue: #3388ff\n\n## Journey\nBuyer and seller flow.\n",
			);
		});

		it("preserves non-conflicting files and binary write_file ops when applying a reconciled overlay and rejects incomplete overlays", () => {
			const c1 = randomUUID();
			const c2 = randomUUID();
			const recId = randomUUID();
			const modelRef = {
				manifestSha256: "a".repeat(64),
				fileSha256: "b".repeat(64),
				bytes: 128,
				mediaType: "model/gltf-binary" as const,
			};
			const base = { "identity/report.md": "Initial\n" };
			const change1 = {
				changeId: c1,
				ops: [
					{ op: "write_text" as const, path: "identity/report.md", content: "Version 1\n" },
					{ op: "write_text" as const, path: "identity/journey.svg", content: "<svg>journey</svg>" },
					{ op: "write_file" as const, path: "identity/model.glb", file: modelRef },
				],
			};
			const change2 = {
				changeId: c2,
				ops: [{ op: "write_text" as const, path: "identity/report.md", content: "Version 2\n" }],
			};

			const withScopedOverlay = composeStudioPreview(
				base,
				[change1, change2],
				"identity",
				{},
				{
					reconciliations: [
						{
							id: recId,
							status: "ready",
							selectedChangeIds: [c1, c2],
							conflictPaths: ["identity/report.md"],
							patchManifest: [{ op: "write_text", path: "identity/report.md", content: "Combined\n" }],
							errorDetail: null,
						},
					],
				},
			);
			expect(withScopedOverlay.status).toBe("ready");
			expect(withScopedOverlay.files["identity/report.md"]).toBe("Combined\n");
			expect(withScopedOverlay.files["identity/journey.svg"]).toBe("<svg>journey</svg>");
			expect(withScopedOverlay.binaries["identity/model.glb"]).toEqual(modelRef);
			expect(withScopedOverlay.appliedChangeIds).toEqual([c1, c2]);

			const withIncompleteOverlay = composeStudioPreview(
				base,
				[change1, change2],
				"identity",
				{},
				{
					reconciliations: [
						{
							id: recId,
							status: "ready",
							selectedChangeIds: [c1, c2],
							conflictPaths: ["identity/report.md"],
							patchManifest: [{ op: "write_text", path: "identity/other.md", content: "Wrong\n" }],
							errorDetail: null,
						},
					],
				},
			);
			expect(withIncompleteOverlay.status).toBe("conflicted");
		});
	});
});
