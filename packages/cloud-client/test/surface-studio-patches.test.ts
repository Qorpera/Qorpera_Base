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
});
