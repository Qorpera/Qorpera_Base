// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { SurfaceStudioView } from "../src/app/views/surface-studio-view.ts";
import { CHANGES, change, fakeClient, SESSION, session, storeWith, summary, workspace } from "./surface-fixtures.ts";

const BRAND_ID = "22222222-2222-4222-8222-222222222229";
const HEADBAND_ID = "22222222-2222-4222-8222-222222222230";

function brandSummary() {
	return summary({
		id: BRAND_ID,
		slug: "brand",
		title: "Brand",
		archetype: "studio",
		icon: "spark",
		sourceKind: "folder",
		repositoryKey: null,
		folderRoot: "brand",
		siteSlug: null,
		previewMode: "studio_overlay",
		liveUrl: null,
	});
}

afterEach(() => {
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe("SurfaceStudioView", () => {
	it("composes toggled folder_patch ChangeUnits live over Brand palette, typography, and voice docs", async () => {
		const brand = brandSummary();
		const c1 = change(CHANGES[0], 1, "staged", {
			surfaceId: BRAND_ID,
			kind: "folder_patch",
			title: "Warmer accent",
			affectedPaths: ["brand/tokens.json"],
		});
		const c2 = change(CHANGES[1], 2, "staged", {
			surfaceId: BRAND_ID,
			kind: "folder_patch",
			title: "Danish craft voice",
			affectedPaths: ["brand/tokens.json", "brand/voice.md"],
		});
		const brandSession = session(["staged", "staged"], { surfaceId: BRAND_ID, changes: [c1, c2] });
		const client = fakeClient({
			listSurfaces: vi.fn(async () => [summary(), brand]),
			getSurfaceWorkspace: vi.fn(async () => workspace([brandSession], { surface: brand })),
			setPreviewSelection: vi.fn(async () => workspace([], { surface: brand }).previewState),
		});
		const store = storeWith(client);
		await store.load();
		await store.openSurface("brand");
		store.setStudioPatch(CHANGES[0], [
			{ op: "merge_json", path: "brand/tokens.json", patch: { colors: { accent: "#c9643b" } } },
		]);
		store.setStudioPatch(CHANGES[1], [
			{
				op: "merge_json",
				path: "brand/tokens.json",
				patch: { typography: { display: "Newsreader, Georgia, serif" } },
			},
			{ op: "write_text", path: "brand/voice.md", content: "Warm, quiet, Danish craft.\n" },
		]);

		const onHandoff = vi.fn();
		const view = new SurfaceStudioView({
			store,
			surface: brand,
			signal: new AbortController().signal,
			baseFiles: {
				"brand/tokens.json": JSON.stringify({
					colors: { accent: "#d76f45", paper: "#ffffff" },
					typography: { display: "Georgia, serif" },
				}),
				"brand/voice.md": "Calm and direct.\n",
			},
			onHandoff,
		});
		document.body.append(view.el);

		expect(view.el.querySelector(".studio-badge")?.textContent).toBe("2 live changes applied");
		expect(view.el.querySelector('[data-token="colors.accent"] code')?.textContent).toBe("#c9643b");
		expect(view.el.querySelector('[data-token="colors.accent"]')?.classList.contains("is-changed")).toBe(true);
		expect(view.el.querySelector('[data-token="colors.paper"]')?.classList.contains("is-changed")).toBe(false);
		expect(view.el.querySelector('[data-token="typography.display"] code')?.textContent).toBe(
			"Newsreader, Georgia, serif",
		);
		expect(view.el.querySelector('[data-file="brand/voice.md"]')?.textContent).toContain(
			"Warm, quiet, Danish craft.",
		);

		await store.toggleChange(BRAND_ID, CHANGES[0]);
		view.update();
		expect(view.el.querySelector(".studio-badge")?.textContent).toBe("1 live change applied");
		expect(view.el.querySelector('[data-token="colors.accent"] code')?.textContent).toBe("#d76f45");
		expect(view.el.querySelector('[data-token="colors.accent"]')?.classList.contains("is-changed")).toBe(false);
		expect(view.el.querySelector('[data-file="brand/voice.md"]')?.textContent).toContain(
			"Warm, quiet, Danish craft.",
		);

		store.setMode("live");
		view.update();
		expect(view.el.querySelector(".studio-badge")?.textContent).toBe("Base");
		expect(view.el.querySelector('[data-file="brand/voice.md"]')?.textContent).toContain("Calm and direct.");

		const syncBtn = view.el.querySelector<HTMLButtonElement>(".studio-sync-btn")!;
		expect(syncBtn.textContent).toContain("Sync to Website");
		syncBtn.click();
		expect(onHandoff).toHaveBeenCalledWith("website");

		view.dispose();
		store.dispose();
	});

	it("surfaces overlapping folder_patch conflicts inline with 1-click Reconcile while preserving the last clean snapshot", async () => {
		const brand = brandSummary();
		const c1 = change(CHANGES[0], 1, "staged", { surfaceId: BRAND_ID, kind: "folder_patch" });
		const c2 = change(CHANGES[1], 2, "staged", { surfaceId: BRAND_ID, kind: "folder_patch" });
		const reconcileChanges = vi.fn(async () =>
			session(["staged", "staged"], { id: SESSION, surfaceId: BRAND_ID, state: "reconciling" }),
		);
		const client = fakeClient({
			listSurfaces: vi.fn(async () => [summary(), brand]),
			getSurfaceWorkspace: vi.fn(async () =>
				workspace([session(["staged", "staged"], { surfaceId: BRAND_ID, changes: [c1, c2] })], { surface: brand }),
			),
			reconcileChanges,
		});
		const store = storeWith(client);
		await store.load();
		await store.openSurface("brand");
		store.setStudioPatch(CHANGES[0], [
			{ op: "merge_json", path: "brand/tokens.json", patch: { colors: { accent: "#c9643b" } } },
		]);
		store.setStudioPatch(CHANGES[1], [
			{ op: "merge_json", path: "brand/tokens.json", patch: { colors: { accent: "#1f5e5b" } } },
		]);

		const view = new SurfaceStudioView({
			store,
			surface: brand,
			signal: new AbortController().signal,
			baseFiles: { "brand/tokens.json": JSON.stringify({ colors: { accent: "#d76f45" } }) },
		});
		document.body.append(view.el);

		const conflict = view.el.querySelector(".studio-conflict")!;
		expect(conflict.textContent).toContain("brand/tokens.json");
		expect(view.el.querySelector('[data-token="colors.accent"] code')?.textContent).toBe("#c9643b");
		conflict.querySelector<HTMLButtonElement>('[data-act="studio-reconcile"]')!.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(reconcileChanges).toHaveBeenCalledWith(BRAND_ID, [CHANGES[0], CHANGES[1]]);

		view.dispose();
		store.dispose();
	});

	it("renders hardware specs and BOM tables cleanly, and falls back gracefully when a studio folder is empty", async () => {
		const headband = summary({
			id: HEADBAND_ID,
			slug: "headband",
			title: "Headband",
			archetype: "studio",
			folderRoot: "hardware/headband",
			siteSlug: null,
			liveUrl: null,
		});
		const store = storeWith(fakeClient({ listSurfaces: vi.fn(async () => [headband]) }));
		await store.load();

		const populated = new SurfaceStudioView({
			store,
			surface: headband,
			signal: new AbortController().signal,
			baseFiles: {
				"hardware/headband/specs.json": JSON.stringify({
					weight: "42g",
					colorways: [{ name: "Sandstone", hex: "#e8e2d5" }],
					bom: [{ part: "EEG Sensor", supplier: "Nordic", unitCost: "$14" }],
				}),
			},
		});
		expect(populated.el.querySelector('[data-token="colorways[0]"] strong')?.textContent).toBe("Sandstone");
		expect(populated.el.querySelector(".studio-kv dd")?.textContent).toBe("42g");
		expect(populated.el.querySelector(".studio-table td")?.textContent).toBe("EEG Sensor");
		populated.dispose();

		const empty = new SurfaceStudioView({
			store,
			surface: headband,
			signal: new AbortController().signal,
			baseFiles: {},
		});
		expect(empty.el.querySelector(".studio-empty")?.textContent).toContain("No studio files yet.");
		empty.dispose();
		store.dispose();
	});
});
