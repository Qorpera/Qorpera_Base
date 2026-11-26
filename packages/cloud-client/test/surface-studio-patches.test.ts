import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { composeStudioPreview, detectLineageReconciliationTarget } from "../src/surface-studio-patches.ts";

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

	describe("preview lineage chain detection and subset reconciliation overlays", () => {
		it("supports every toggle subset of C1 -> C2 + C3 without letting standalone R(C2) override active C1 + C2", () => {
			const c1 = randomUUID();
			const c2 = randomUUID();
			const c3 = randomUUID();
			const recChainId = randomUUID();
			const recPairId = randomUUID();
			const recStandaloneId = randomUUID();

			const base = {
				"identity/tokens.json": `${JSON.stringify({ accent: "#222222", primary: "#111111" }, null, 2)}\n`,
			};
			const afterC1 = `${JSON.stringify({ accent: "#0070f3", primary: "#111111" }, null, 2)}\n`;
			const afterC1C2 = `${JSON.stringify({ accent: "#0070f3", primary: "#ffffff" }, null, 2)}\n`;

			const change1 = {
				changeId: c1,
				baseFiles: { "identity/tokens.json": base["identity/tokens.json"] },
				ops: [{ op: "write_text" as const, path: "identity/tokens.json", content: afterC1 }],
			};
			const change2 = {
				changeId: c2,
				previewBaseChangeIds: [c1],
				baseFiles: { "identity/tokens.json": afterC1 },
				ops: [
					{ op: "write_text" as const, path: "identity/tokens.json", content: afterC1C2 },
					{ op: "write_text" as const, path: "identity/promo.md", content: "# Electric Blue Promo\n" },
				],
			};
			const change3 = {
				changeId: c3,
				baseFiles: { "identity/tokens.json": base["identity/tokens.json"] },
				ops: [
					{
						op: "write_text" as const,
						path: "identity/tokens.json",
						content: `${JSON.stringify({ accent: "#ff5500", primary: "#111111" }, null, 2)}\n`,
					},
					{ op: "write_text" as const, path: "identity/banner.md", content: "# Sunset Banner\n" },
				],
			};

			const descriptors = [
				{ id: c1, affectedPaths: ["tokens.json"] },
				{ id: c2, affectedPaths: ["identity/tokens.json", "promo.md"], previewBaseChangeIds: [c1] },
				{ id: c3, affectedPaths: ["identity/tokens.json", "banner.md"] },
			];

			expect(detectLineageReconciliationTarget(descriptors, [c1], "identity")).toBeNull();
			expect(detectLineageReconciliationTarget(descriptors, [c1, c2], "identity")).toBeNull();
			expect(detectLineageReconciliationTarget(descriptors, [c3], "identity")).toBeNull();
			expect(detectLineageReconciliationTarget(descriptors, [c1, c3], "identity")).toBeNull();
			expect(detectLineageReconciliationTarget(descriptors, [c2], "identity")).toEqual({
				kind: "missing_base",
				changeIds: [c2],
				conflictPaths: ["promo.md", "tokens.json"],
			});
			expect(detectLineageReconciliationTarget(descriptors, [c1, c2, c3], "identity")).toEqual({
				kind: "chain",
				changeIds: [c1, c2, c3],
				conflictPaths: ["tokens.json"],
			});

			const reconciliations = [
				{
					id: recStandaloneId,
					status: "ready" as const,
					selectedChangeIds: [c2],
					conflictPaths: ["tokens.json", "promo.md"],
					patchManifest: [
						{
							op: "write_text" as const,
							path: "identity/tokens.json",
							content: `${JSON.stringify({ accent: "#222222", primary: "#ffffff" }, null, 2)}\n`,
						},
						{ op: "write_text" as const, path: "identity/promo.md", content: "# Launch Promo\n" },
					],
					errorDetail: null,
				},
				{
					id: recPairId,
					status: "ready" as const,
					selectedChangeIds: [c1, c3],
					conflictPaths: ["tokens.json"],
					patchManifest: [
						{
							op: "write_text" as const,
							path: "identity/tokens.json",
							content: `${JSON.stringify({ accent: "#ff5500", primary: "#111111" }, null, 2)}\n`,
						},
					],
					errorDetail: null,
				},
				{
					id: recChainId,
					status: "ready" as const,
					selectedChangeIds: [c1, c2, c3],
					conflictPaths: ["tokens.json"],
					patchManifest: [
						{
							op: "write_text" as const,
							path: "identity/tokens.json",
							content: `${JSON.stringify({ accent: "#ff5500", primary: "#ffffff" }, null, 2)}\n`,
						},
						{ op: "write_text" as const, path: "identity/promo.md", content: "# Sunset Orange Promo\n" },
					],
					errorDetail: null,
				},
			];

			const c1Only = composeStudioPreview(base, [change1], "identity", {}, { reconciliations });
			expect(c1Only.status).toBe("ready");
			expect(JSON.parse(c1Only.files["identity/tokens.json"]!).accent).toBe("#0070f3");

			const c1c2 = composeStudioPreview(base, [change1, change2], "identity", {}, { reconciliations });
			expect(c1c2.status).toBe("ready");
			expect(JSON.parse(c1c2.files["identity/tokens.json"]!)).toEqual({ accent: "#0070f3", primary: "#ffffff" });
			expect(c1c2.files["identity/promo.md"]).toBe("# Electric Blue Promo\n");

			const c2OnlyNoRec = composeStudioPreview(base, [change2], "identity");
			expect(c2OnlyNoRec.status).toBe("ready");
			expect(JSON.parse(c2OnlyNoRec.files["identity/tokens.json"]!)).toEqual({
				accent: "#222222",
				primary: "#ffffff",
			});

			const c2OnlyWithRec = composeStudioPreview(base, [change2], "identity", {}, { reconciliations });
			expect(c2OnlyWithRec.status).toBe("ready");
			expect(c2OnlyWithRec.files["identity/promo.md"]).toBe("# Launch Promo\n");

			const c1c3 = composeStudioPreview(base, [change1, change3], "identity", {}, { reconciliations });
			expect(c1c3.status).toBe("ready");
			expect(JSON.parse(c1c3.files["identity/tokens.json"]!).accent).toBe("#ff5500");
			expect(c1c3.files["identity/banner.md"]).toBe("# Sunset Banner\n");

			const c1c2c3 = composeStudioPreview(base, [change1, change2, change3], "identity", {}, { reconciliations });
			expect(c1c2c3.status).toBe("ready");
			expect(JSON.parse(c1c2c3.files["identity/tokens.json"]!)).toEqual({ accent: "#ff5500", primary: "#ffffff" });
			expect(c1c2c3.files["identity/promo.md"]).toBe("# Sunset Orange Promo\n");
			expect(c1c2c3.files["identity/banner.md"]).toBe("# Sunset Banner\n");
		});

		it("does not flag chain reconciliation when C3 already built on C2 and updated C2 files directly", () => {
			const c1 = randomUUID();
			const c2 = randomUUID();
			const c3 = randomUUID();
			const descriptors = [
				{ id: c1, affectedPaths: ["tokens.json"] },
				{ id: c2, affectedPaths: ["promo.md"], previewBaseChangeIds: [c1] },
				{ id: c3, affectedPaths: ["tokens.json", "promo.md"], previewBaseChangeIds: [c1, c2] },
			];
			expect(detectLineageReconciliationTarget(descriptors, [c1, c2, c3], "identity")).toBeNull();
		});

		it("includes selected preview ancestors of the modifying change so client matches SQL chain reconciliation sets", () => {
			const cA = randomUUID();
			const c1 = randomUUID();
			const c2 = randomUUID();
			const c3 = randomUUID();
			const descriptors = [
				{ id: cA, affectedPaths: ["voice.md"] },
				{ id: c1, affectedPaths: ["tokens.json"] },
				{ id: c2, affectedPaths: ["promo.md"], previewBaseChangeIds: [c1] },
				{ id: c3, affectedPaths: ["tokens.json"], previewBaseChangeIds: [cA, c1, c2] },
			];
			expect(detectLineageReconciliationTarget(descriptors, [cA, c1, c2, c3], "identity")).toEqual({
				kind: "chain",
				changeIds: [cA, c1, c2, c3],
				conflictPaths: ["tokens.json"],
			});

			const base = { "identity/tokens.json": '{"accent":"#222"}\n', "identity/voice.md": "Base\n" };
			const composed = composeStudioPreview(
				base,
				[
					{ changeId: cA, ops: [{ op: "write_text", path: "voice.md", content: "Voice A\n" }] },
					{ changeId: c1, ops: [{ op: "write_text", path: "tokens.json", content: '{"accent":"#0070f3"}\n' }] },
					{
						changeId: c2,
						previewBaseChangeIds: [c1],
						ops: [{ op: "write_text", path: "promo.md", content: "# Blue Promo\n" }],
					},
					{
						changeId: c3,
						previewBaseChangeIds: [cA, c1, c2],
						ops: [{ op: "write_text", path: "tokens.json", content: '{"accent":"#ff5500"}\n' }],
					},
				],
				"identity",
				{},
				{
					reconciliations: [
						{
							id: randomUUID(),
							status: "ready",
							selectedChangeIds: [cA, c1, c2, c3],
							conflictPaths: ["tokens.json"],
							patchManifest: [
								{ op: "write_text", path: "tokens.json", content: '{"accent":"#ff5500"}\n' },
								{ op: "write_text", path: "promo.md", content: "# Sunset Promo\n" },
							],
							errorDetail: null,
						},
					],
				},
			);
			expect(composed.status).toBe("ready");
			expect(composed.files["identity/voice.md"]).toBe("Voice A\n");
			expect(composed.files["identity/tokens.json"]).toBe('{"accent":"#ff5500"}\n');
			expect(composed.files["identity/promo.md"]).toBe("# Sunset Promo\n");
		});

		it("applies multiple disjoint ready reconciliations together without dropping smaller subsets", () => {
			const cTok1 = randomUUID();
			const cTok2 = randomUUID();
			const cMark1 = randomUUID();
			const cMark2 = randomUUID();
			const cMark3 = randomUUID();
			const base = {};
			const ordered = [
				{
					changeId: cTok1,
					ops: [
						{ op: "write_text" as const, path: "tokens.json", content: '{"accent":"#111"}\n' },
						{ op: "write_text" as const, path: "brief.md", content: "# Nordic Brief\n" },
					],
				},
				{
					changeId: cMark1,
					ops: [
						{ op: "write_text" as const, path: "layout.json", content: '{"v":1}\n' },
						{ op: "write_text" as const, path: "wordmark.svg", content: "<svg>1</svg>\n" },
					],
				},
				{
					changeId: cTok2,
					ops: [{ op: "write_text" as const, path: "tokens.json", content: '{"accent":"#222"}\n' }],
				},
				{
					changeId: cMark2,
					ops: [{ op: "write_text" as const, path: "layout.json", content: '{"v":2}\n' }],
				},
				{
					changeId: cMark3,
					ops: [{ op: "write_text" as const, path: "wordmark.svg", content: "<svg>3</svg>\n" }],
				},
			];
			const reconciliations = [
				{
					id: randomUUID(),
					status: "ready" as const,
					selectedChangeIds: [cMark1, cMark2, cMark3],
					conflictPaths: ["identity/layout.json", "identity/wordmark.svg"],
					patchManifest: [
						{ op: "write_text" as const, path: "layout.json", content: '{"v":2,"merged":true}\n' },
						{ op: "write_text" as const, path: "wordmark.svg", content: "<svg>merged</svg>\n" },
					],
					errorDetail: null,
				},
				{
					id: randomUUID(),
					status: "ready" as const,
					selectedChangeIds: [cTok1, cTok2],
					conflictPaths: ["identity/tokens.json"],
					patchManifest: [
						{ op: "write_text" as const, path: "tokens.json", content: '{"accent":"#222","merged":true}\n' },
					],
					errorDetail: null,
				},
			];
			const composed = composeStudioPreview(base, ordered, "identity", {}, { reconciliations });
			expect(composed.status).toBe("ready");
			expect(composed.files["identity/brief.md"]).toBe("# Nordic Brief\n");
			expect(composed.files["identity/tokens.json"]).toBe('{"accent":"#222","merged":true}\n');
			expect(composed.files["identity/layout.json"]).toBe('{"v":2,"merged":true}\n');
			expect(composed.files["identity/wordmark.svg"]).toBe("<svg>merged</svg>\n");

			const overlapping = composeStudioPreview(
				base,
				ordered,
				"identity",
				{},
				{
					reconciliations: [
						...reconciliations,
						{
							id: randomUUID(),
							status: "ready" as const,
							selectedChangeIds: [cTok1, cMark1],
							conflictPaths: ["identity/tokens.json"],
							patchManifest: [{ op: "write_text" as const, path: "tokens.json", content: '{"wrong":true}\n' }],
							errorDetail: null,
						},
					],
				},
			);
			expect(overlapping.status).toBe("ready");
			expect(overlapping.files["identity/tokens.json"]).toBe('{"accent":"#222","merged":true}\n');
		});
	});
});
