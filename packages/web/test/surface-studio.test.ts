// @vitest-environment jsdom
import type { SurfaceSummary } from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SurfaceReportView } from "../src/app/views/surface-report-view.ts";
import { prepareStudioHtmlPreview, SurfaceStudioView } from "../src/app/views/surface-studio-view.ts";
import { PAGE_FRAME_URL } from "../src/ui/page-frame.ts";
import { deferred } from "./fixtures.ts";
import { CHANGES, change, fakeClient, SESSION, session, storeWith, summary, workspace } from "./surface-fixtures.ts";

const BRAND_ID = "22222222-2222-4222-8222-222222222229";
const HEADBAND_ID = "22222222-2222-4222-8222-222222222230";
const IDENTITY_ID = "22222222-2222-4222-8222-222222222231";

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
		expect(view.el.querySelector(".studio-badge")).toBeNull();
		expect(view.el.querySelector(".studio-head")).toBeNull();
		expect(view.el.querySelector(".studio-path")).toBeNull();
		expect(view.el.querySelector('[data-file="brand/voice.md"]')?.textContent).toContain("Calm and direct.");
		expect(view.el.querySelector(".studio-sync-btn")).toBeNull();

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
		expect(populated.el.querySelector('[data-token="colorways[0]"]')?.getAttribute("aria-label")).toBe("Sandstone");
		expect(populated.el.querySelector(".studio-fact")?.textContent).toBe("Weight42g");
		populated.el.querySelector<HTMLButtonElement>('[data-act="studio-tab"][data-tab="specs"]')!.click();
		expect(populated.el.querySelector(".studio-kv dd")?.textContent).toBe("42g");
		expect(populated.el.querySelector(".studio-table td")?.textContent).toBe("EEG Sensor");
		populated.dispose();

		const empty = new SurfaceStudioView({
			store,
			surface: headband,
			signal: new AbortController().signal,
			baseFiles: {},
		});
		expect(empty.el.querySelector(".studio-empty")).toBeNull();
		expect(empty.el.querySelector(".studio-product-head h2")?.textContent).toBe("Headband");
		empty.dispose();

		const brand = new SurfaceStudioView({
			store,
			surface: brandSummary(),
			signal: new AbortController().signal,
			baseFiles: {},
		});
		expect(brand.el.querySelector(".studio-empty")?.textContent).toContain("No studio files yet.");
		brand.dispose();
		store.dispose();
	});

	it("keeps HTML, CSS, and SVG code out of Voice & Files, renders HTML live under Page, and renders SVG brand marks visually", async () => {
		const identity = summary({
			id: IDENTITY_ID,
			slug: "identity",
			title: "Identity",
			archetype: "studio",
			kind: "identity",
			isGlobal: true,
			icon: "spark",
			sourceKind: "folder",
			repositoryKey: null,
			folderRoot: "identity",
			siteSlug: null,
			previewMode: "studio_overlay",
			liveUrl: null,
		});
		const c1 = change(CHANGES[0], 1, "staged", {
			surfaceId: IDENTITY_ID,
			kind: "folder_patch",
			title: "Fælles farver og typografi",
			affectedPaths: ["tokens.json", "index.html", "logo.svg"],
		});
		const idSession = session(["staged"], { surfaceId: IDENTITY_ID, changes: [c1] });
		const client = fakeClient({
			listSurfaces: vi.fn(async () => [summary(), identity]),
			getSurfaceWorkspace: vi.fn(async () => workspace([idSession], { surface: identity })),
		});
		const store = storeWith(client);
		await store.load();
		await store.openSurface("identity");
		const htmlDoc =
			'<!doctype html><html lang="da"><head><title>Visuelt grundlag</title><link rel="stylesheet" href="./tokens.css"></head><body><h1>Visuelt grundlag</h1></body></html>';
		const logoSvg =
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>';
		store.setStudioPatch(CHANGES[0], [
			{
				op: "merge_json",
				path: "tokens.json",
				patch: {
					colors: { accent: "#c9643b" },
					typography: { body: "Inter, system-ui, sans-serif" },
				},
			},
			{ op: "write_text", path: "index.html", content: htmlDoc },
			{ op: "write_text", path: "logo.svg", content: logoSvg },
		]);

		const view = new SurfaceStudioView({
			store,
			surface: identity,
			signal: new AbortController().signal,
			baseFiles: {
				"identity/tokens.json": JSON.stringify({ colors: { primary: "#18181b", accent: "#2563eb" } }),
				"identity/tokens.css": ":root { --q-color-accent: #2563eb; }\n",
			},
		});
		document.body.append(view.el);

		const tabsWithoutVoice = [...view.el.querySelectorAll<HTMLButtonElement>(".studio-tab")].map(
			(tab) => tab.textContent,
		);
		expect(tabsWithoutVoice).toEqual(["Overview", "Design System", "Page"]);
		expect(view.el.querySelector('[data-token="colors.accent"] code')?.textContent).toBe("#c9643b");
		expect(view.el.querySelector('[data-token="colors.primary"] code')?.textContent).toBe("#18181b");
		const svgImg = view.el.querySelector<HTMLImageElement>('[data-file="identity/logo.svg"] img.studio-svg-img');
		expect(svgImg?.getAttribute("src")).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);

		view.el.querySelector<HTMLButtonElement>('[data-act="studio-tab"][data-tab="pages"]')!.click();
		const htmlCard = view.el.querySelector('[data-file="identity/index.html"]')!;
		expect(htmlCard.querySelector("h2")?.textContent).toBe("Visuelt grundlag");
		expect(htmlCard.querySelector("pre")).toBeNull();
		const iframe = htmlCard.querySelector<HTMLIFrameElement>("iframe.studio-html-frame");
		expect(iframe?.getAttribute("src")).toBe(PAGE_FRAME_URL);
		expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");

		store.setMode("compare");
		view.update();
		expect(
			view.el.querySelector('[data-compare-file="identity/index.html"] iframe.studio-html-frame'),
		).not.toBeNull();
		expect(view.el.querySelector('[data-compare-file="identity/index.html"] pre')).toBeNull();
		expect(view.el.querySelector('[data-compare-file="identity/logo.svg"] img.studio-svg-img')).not.toBeNull();
		expect(view.el.querySelector('[data-compare-file="identity/tokens.css"]')).toBeNull();
		view.dispose();

		store.setMode("preview");
		const withVoice = new SurfaceStudioView({
			store,
			surface: identity,
			signal: new AbortController().signal,
			baseFiles: {
				"identity/tokens.json": JSON.stringify({ colors: { primary: "#18181b" } }),
				"identity/tokens.css": ":root { --q-color-primary: #18181b; }\n",
				"identity/voice.md": "# Voice\nCalm, direct, grounded.\n",
			},
		});
		document.body.append(withVoice.el);
		const tabsWithVoice = [...withVoice.el.querySelectorAll<HTMLButtonElement>(".studio-tab")].map(
			(tab) => tab.textContent,
		);
		expect(tabsWithVoice).toEqual(["Overview", "Design System", "Voice & Files", "Page"]);
		withVoice.el.querySelector<HTMLButtonElement>('[data-act="studio-tab"][data-tab="files"]')!.click();
		expect(withVoice.el.querySelector('[data-file="identity/voice.md"]')?.textContent).toContain(
			"Calm, direct, grounded.",
		);
		expect(withVoice.el.querySelector('[data-file="identity/index.html"]')).toBeNull();
		expect(withVoice.el.querySelector('[data-file="identity/tokens.css"]')).toBeNull();
		expect(withVoice.el.querySelector('[data-file="identity/logo.svg"]')).toBeNull();
		expect(withVoice.el.querySelector("pre")).toBeNull();

		withVoice.dispose();
		store.dispose();
	});

	it("inlines compiled identity tokens.css and sibling SVG assets when preparing studio HTML previews", () => {
		const html =
			'<!doctype html><html><head><link rel="stylesheet" href="./tokens.css"><link rel="stylesheet" href="./extra.css"><link rel="stylesheet" href="https://evil.example/x.css"><link rel="stylesheet" href="../outside.css"></head><body><img src="./logo.svg"></body></html>';
		const prepared = prepareStudioHtmlPreview(
			html,
			"identity/index.html",
			{
				"identity/extra.css": "body { margin: 0; } /* </style><script>alert(1)</script> */",
				"outside.css": "body { color: red; }",
				"identity/logo.svg": '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
			},
			":root { --q-color-accent: #c9643b; }",
		);
		expect(prepared).not.toBeNull();
		expect(prepared).toContain("--q-color-accent: #c9643b;");
		expect(prepared).toContain("body { margin: 0; }");
		expect(prepared).toContain("<\\/style");
		expect(prepared).not.toContain("color: red");
		expect(prepared).toContain("data:image/svg+xml;charset=utf-8,");
		expect(prepared).not.toContain('href="./tokens.css"');
	});

	it("marks HTML pages Updated when inlined CSS changes and lists unrendered changed paths in Compare without code", async () => {
		const identity = summary({
			id: IDENTITY_ID,
			slug: "identity",
			title: "Identity",
			archetype: "studio",
			kind: "identity",
			isGlobal: true,
			icon: "spark",
			sourceKind: "folder",
			repositoryKey: null,
			folderRoot: "identity",
			siteSlug: null,
			previewMode: "studio_overlay",
			liveUrl: null,
		});
		const c1 = change(CHANGES[0], 1, "staged", {
			surfaceId: IDENTITY_ID,
			kind: "folder_patch",
			title: "Update styles and config",
			affectedPaths: ["extra.css", "config.yaml", "broken.json"],
		});
		const idSession = session(["staged"], { surfaceId: IDENTITY_ID, changes: [c1] });
		const store = storeWith(
			fakeClient({
				listSurfaces: vi.fn(async () => [summary(), identity]),
				getSurfaceWorkspace: vi.fn(async () => workspace([idSession], { surface: identity })),
			}),
		);
		await store.load();
		await store.openSurface("identity");
		store.setStudioPatch(CHANGES[0], [
			{ op: "write_text", path: "extra.css", content: "body { background: #111; }" },
			{ op: "write_text", path: "config.yaml", content: "theme: evening\n" },
			{ op: "write_text", path: "broken.json", content: "{not valid json" },
		]);

		const view = new SurfaceStudioView({
			store,
			surface: identity,
			signal: new AbortController().signal,
			baseFiles: {
				"identity/index.html":
					'<!doctype html><html><head><title>Preview</title><link rel="stylesheet" href="./extra.css"></head><body>Hi</body></html>',
				"identity/extra.css": "body { background: #fff; }",
				"identity/config.yaml": "theme: day\n",
			},
		});
		document.body.append(view.el);

		view.el.querySelector<HTMLButtonElement>('[data-act="studio-tab"][data-tab="pages"]')!.click();
		const pageCard = view.el.querySelector('[data-file="identity/index.html"]')!;
		expect(pageCard.classList.contains("is-changed")).toBe(true);
		expect(pageCard.querySelector(".studio-changed-pill")?.textContent).toBe("Updated");

		store.setMode("compare");
		view.update();
		expect(view.el.querySelector(".studio-compare-empty")).toBeNull();
		expect(
			view.el.querySelector('[data-compare-file="identity/index.html"] iframe.studio-html-frame'),
		).not.toBeNull();
		const otherCard = view.el.querySelector('[data-compare-other="true"]')!;
		expect(otherCard.querySelector('[data-compare-file="identity/config.yaml"]')).not.toBeNull();
		expect(otherCard.querySelector('[data-compare-file="identity/broken.json"]')).not.toBeNull();
		expect(otherCard.textContent).not.toContain("theme: evening");
		expect(otherCard.textContent).not.toContain("{not valid json");
		expect(view.el.querySelector("pre")).toBeNull();

		view.dispose();
		store.dispose();
	});

	it("renders an updating animation while merging, reloading cloud files, and publishing, then settles cleanly with fresh Base files", async () => {
		const brand = brandSummary();
		const patchManifest = [
			{ op: "merge_json" as const, path: "tokens.json", patch: { colors: { accent: "#2b6cb0" } } },
		];
		const stagedChange = change(CHANGES[0], 1, "staged", {
			surfaceId: BRAND_ID,
			kind: "folder_patch",
			affectedPaths: ["brand/tokens.json"],
			patchManifest,
		});
		const mergingChange = change(CHANGES[0], 1, "merging", {
			surfaceId: BRAND_ID,
			kind: "folder_patch",
			affectedPaths: ["brand/tokens.json"],
			patchManifest,
		});
		const mergedChange = change(CHANGES[0], 1, "merged", {
			surfaceId: BRAND_ID,
			kind: "folder_patch",
			affectedPaths: ["brand/tokens.json"],
			patchManifest,
		});
		const stagedSession = session(["staged"], { surfaceId: BRAND_ID, changes: [stagedChange] });
		const mergingSession = session(["merging"], { surfaceId: BRAND_ID, changes: [mergingChange] });
		const mergedSession = session(["merged"], { surfaceId: BRAND_ID, state: "completed", changes: [mergedChange] });

		const postMergeLoad = deferred<Record<string, string>>();
		const postPublishLoad = deferred<Record<string, string>>();
		let loadCall = 0;
		const loadCloudFiles = vi.fn(async () => {
			loadCall += 1;
			if (loadCall === 1) {
				return {
					"brand/tokens.json": JSON.stringify({ colors: { accent: "#d76f45" } }),
					"brand/old-notes.md": "Stale note",
				};
			}
			if (loadCall === 2) return await postMergeLoad.promise;
			return await postPublishLoad.promise;
		});
		const loadFiles = vi.fn(async () => ({ "brand/old-notes.md": "Should not duplicate" }));
		const client = fakeClient({
			listSurfaces: vi.fn(async () => [brand]),
			getSurfaceWorkspace: vi
				.fn()
				.mockResolvedValueOnce(workspace([stagedSession], { surface: brand }))
				.mockResolvedValue(
					workspace([], {
						surface: { ...brand, hasUnpublishedChanges: true, unpublishedChangeCount: 1 },
						recentHistory: [mergedSession],
					}),
				),
			approveSessionAll: vi.fn(async () => mergingSession),
			publishSurface: vi.fn(async () => ({
				...brand,
				hasUnpublishedChanges: false,
				unpublishedChangeCount: 0,
			})),
		});

		const store = storeWith(client, { loadCloudFiles });
		await store.load();
		await store.openSurface("brand");
		await Promise.resolve();

		const view = new SurfaceStudioView({
			store,
			surface: brand,
			signal: new AbortController().signal,
			loadFiles,
		});
		document.body.append(view.el);
		expect(loadFiles).not.toHaveBeenCalled();
		expect(view.el.classList.contains("is-updating")).toBe(false);
		expect(view.el.querySelector(".studio-updating-pill")).toBeNull();

		await store.approveAll(SESSION);
		view.update();
		expect(view.el.classList.contains("is-updating")).toBe(true);
		expect(view.el.getAttribute("aria-busy")).toBe("true");
		expect(view.el.querySelector(".studio-updating-pill")?.textContent).toBe("Applying…");
		expect(view.el.querySelector('[data-token="colors.accent"] code')?.textContent).toBe("#2b6cb0");

		await store.refreshWorkspace(BRAND_ID);
		view.update();
		expect(view.el.classList.contains("is-updating")).toBe(true);
		expect(view.el.querySelector(".studio-updating-pill")?.textContent).toBe("Updating…");
		expect(view.el.querySelector(".studio-head")).not.toBeNull();
		expect(view.el.querySelector('[data-token="colors.accent"] code')?.textContent).toBe("#2b6cb0");

		postMergeLoad.resolve({
			"brand/tokens.json": JSON.stringify({ colors: { accent: "#2b6cb0" } }),
		});
		await Promise.resolve();
		await Promise.resolve();
		view.update();
		expect(view.el.classList.contains("is-updating")).toBe(false);
		expect(view.el.classList.contains("is-settled")).toBe(true);
		expect(view.el.querySelector(".studio-badge")).toBeNull();
		expect(view.el.querySelector(".studio-head")).toBeNull();
		expect(view.el.querySelector('[data-token="colors.accent"] code')?.textContent).toBe("#2b6cb0");
		expect(view.el.querySelector('[data-file="brand/old-notes.md"]')).toBeNull();

		await store.publish(BRAND_ID);
		view.update();
		expect(view.el.classList.contains("is-updating")).toBe(true);
		postPublishLoad.resolve({
			"brand/tokens.json": JSON.stringify({ colors: { accent: "#2b6cb0" } }),
		});
		await Promise.resolve();
		await Promise.resolve();
		view.update();
		expect(view.el.classList.contains("is-updating")).toBe(false);

		view.dispose();
		store.dispose();
	});

	it("passes async-loaded baseFiles to embedded report views and clamps degenerate chart bounds safely", async () => {
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

		const reportJson = JSON.stringify({
			slug: "vendor-deep-dive",
			headline: "Vendor Deep Dive",
			sections: [
				{
					id: "s1",
					heading: "Metrics",
					paragraphs: ["Overview"],
					blocks: [
						{
							kind: "bar_chart",
							heading: "Zero Max Bars",
							max: 0,
							items: [
								{ label: "A", value: 10 },
								{ label: "B", value: Number.NaN },
							],
						},
						{
							kind: "line_chart",
							heading: "Degenerate Curve",
							xLabels: ["Q1", "Q2", "Q3"],
							series: [{ name: "Cost", values: [12, 18, 25] }],
						},
					],
				},
			],
		});
		const view = new SurfaceStudioView({
			store,
			surface: headband,
			signal: new AbortController().signal,
			loadFiles: async () => ({
				"hardware/headband/specs.json": JSON.stringify({ weight: "42g" }),
				"hardware/headband/vendor.report.json": reportJson,
			}),
		});
		document.body.append(view.el);
		await new Promise((resolve) => setTimeout(resolve, 0));

		view.el.querySelector<HTMLButtonElement>('[data-act="studio-tab"][data-tab="analysis"]')!.click();
		expect(view.el.querySelector(".report-article")?.textContent).toContain("Vendor Deep Dive");
		const fills = [...view.el.querySelectorAll<HTMLElement>(".report-bar-fill")].map((el) => el.style.width);
		expect(fills).toEqual(["100%", "4%"]);
		const pathD = view.el.querySelector("svg.report-line-svg path")?.getAttribute("d") ?? "";
		expect(pathD).not.toContain("NaN");
		view.dispose();
		store.dispose();
	});

	it("keeps Product Studio tabbed on SVG and markdown drafts and shows its isolated specs path", async () => {
		const thetabands = summary({
			id: HEADBAND_ID,
			slug: "thetabands",
			title: "Thetabands",
			archetype: "studio",
			kind: "product",
			icon: "figure:headband",
			sourceKind: "folder",
			repositoryKey: null,
			folderRoot: "surfaces/thetabands",
			siteSlug: null,
			previewMode: "studio_overlay",
			liveUrl: null,
		});
		const website = summary({
			id: IDENTITY_ID,
			slug: "website",
			title: "Hjemmeside",
			archetype: "live_build",
			kind: "website",
		});
		const store = storeWith(fakeClient({ listSurfaces: vi.fn(async () => [website, thetabands]) }));
		await store.load();

		const view = new SurfaceStudioView({
			store,
			surface: thetabands,
			signal: new AbortController().signal,
			baseFiles: {
				"surfaces/thetabands/concepts.svg":
					'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"><rect width="120" height="40"/></svg>',
				"surfaces/thetabands/brief.md": "# Thetabands\nInitial concept notes.\n",
			},
		});
		document.body.append(view.el);

		const tabs = [...view.el.querySelectorAll<HTMLButtonElement>(".studio-tab")];
		expect(tabs.map((tab) => tab.textContent)).toEqual(["Overview", "Specs", "Vendors", "Reports", "Files"]);
		expect(tabs.filter((tab) => tab.classList.contains("is-empty")).map((tab) => tab.dataset.tab)).toEqual([
			"specs",
			"vendors",
			"analysis",
		]);
		expect(view.el.querySelector(".studio-product-head h2")?.textContent).toBe("Thetabands");
		expect(view.el.querySelector('[data-file="surfaces/thetabands/concepts.svg"]')).toBeNull();
		expect(view.el.querySelector('[data-file="surfaces/thetabands/brief.md"]')).toBeNull();
		const usedBy = view.el.querySelector<HTMLElement>('.studio-reach [data-link-dir="out"]')!;
		expect(usedBy.textContent).toContain("Used by");
		expect(usedBy.textContent).toContain("Hjemmeside");
		expect(view.el.querySelector(".studio-reach")?.textContent).not.toContain("specs.json");

		view.el.querySelector<HTMLButtonElement>('[data-act="studio-tab"][data-tab="files"]')!.click();
		expect(view.el.querySelector('[data-file="surfaces/thetabands/brief.md"]')?.textContent).toContain(
			"Initial concept notes.",
		);
		expect(view.el.querySelector('[data-file="surfaces/thetabands/concepts.svg"]')).not.toBeNull();
		view.dispose();
		store.dispose();
	});

	it("keeps every Product Studio home in place before any file exists", async () => {
		const thetabands = summary({
			id: HEADBAND_ID,
			slug: "thetabands",
			title: "Thetabands",
			archetype: "studio",
			kind: "product",
			sourceKind: "folder",
			repositoryKey: null,
			folderRoot: "surfaces/thetabands",
			siteSlug: null,
			previewMode: "studio_overlay",
			liveUrl: null,
		});
		const store = storeWith(fakeClient({ listSurfaces: vi.fn(async () => [thetabands]) }));
		await store.load();

		const view = new SurfaceStudioView({
			store,
			surface: thetabands,
			signal: new AbortController().signal,
			baseFiles: {},
		});
		expect(view.el.querySelector(".studio-empty")).toBeNull();
		expect([...view.el.querySelectorAll(".studio-tab")].map((tab) => tab.textContent)).toEqual([
			"Overview",
			"Specs",
			"Vendors",
			"Reports",
			"Files",
		]);
		expect(view.el.querySelector(".studio-stage .studio-stage-floor")).not.toBeNull();
		expect(view.el.querySelector(".studio-product-head h2")?.textContent).toBe("Thetabands");
		expect(view.el.querySelector(".studio-product-line.is-empty")).not.toBeNull();
		expect(view.el.querySelectorAll(".studio-dots.is-empty .studio-dot")).toHaveLength(4);
		expect([...view.el.querySelectorAll(".studio-facts.is-empty dd")].map((value) => value.textContent)).toEqual([
			"?",
			"?",
			"?",
			"?",
		]);

		view.el.querySelector<HTMLButtonElement>('[data-act="studio-tab"][data-tab="vendors"]')!.click();
		expect(view.el.querySelector(".studio-home-empty")?.textContent).toBe("Who can make it, side by side.");
		view.dispose();
		store.dispose();
	});

	it("draws a Product Studio as one column: the model, its name and line, colour dots and four figures", async () => {
		const thetabands = summary({
			id: HEADBAND_ID,
			slug: "thetabands",
			title: "Thetabands",
			archetype: "studio",
			kind: "product",
			sourceKind: "folder",
			repositoryKey: null,
			folderRoot: "surfaces/thetabands",
			siteSlug: null,
			previewMode: "studio_overlay",
			liveUrl: null,
		});
		const store = storeWith(fakeClient({ listSurfaces: vi.fn(async () => [thetabands]) }));
		await store.load();

		const view = new SurfaceStudioView({
			store,
			surface: thetabands,
			signal: new AbortController().signal,
			baseFiles: {
				"surfaces/thetabands/specs.json": JSON.stringify({
					model: { kind: "headband", dimensions: "168 x 38 mm", layers: ["Cover", "Board"] },
					overview: {
						tagline: "Calm, measured.",
						sensors: "4 dry EEG",
						materials: "Moulded PC-ABS with a soft-touch coat and a woven strap",
						battery: "14 h",
						weight: "44 g",
						price: "1.995 kr.",
						charging: "USB-C",
					},
					colorways: [
						{ name: "Lavendel", hex: "#c3bbea" },
						{ name: "Skifer", hex: "#4a5963" },
					],
				}),
			},
		});
		expect(view.el.querySelector(".studio-stage .studio-3d-canvas")).not.toBeNull();
		expect(view.el.querySelector(".studio-product-line")?.textContent).toBe("Calm, measured.");
		expect([...view.el.querySelectorAll(".studio-fact")].map((fact) => fact.textContent)).toEqual([
			"Sensors4 dry EEG",
			"Battery14 h",
			"Weight44 g",
			"Price1.995 kr.",
		]);
		expect(view.el.querySelector(".studio-kv")).toBeNull();
		expect(view.el.querySelector(".studio-swatches")).toBeNull();

		const dots = () => [...view.el.querySelectorAll<HTMLButtonElement>('[data-act="studio-colorway"]')];
		const checked = () => dots().map((dot) => dot.getAttribute("aria-checked"));
		const modelColour = () => view.el.querySelector<HTMLElement>(".studio-3d")?.dataset.colorway;
		expect(dots().map((dot) => dot.getAttribute("aria-label"))).toEqual(["Lavendel", "Skifer"]);
		expect(checked()).toEqual(["true", "false"]);
		expect(modelColour()).toBe("Lavendel");
		dots()[1]!.click();
		expect(checked()).toEqual(["false", "true"]);
		expect(modelColour()).toBe("Skifer");

		view.el.querySelector<HTMLButtonElement>('[data-act="studio-tab"][data-tab="specs"]')!.click();
		expect(view.el.querySelector(".studio-kv")?.textContent).toContain("Moulded PC-ABS");
		view.el.querySelector<HTMLButtonElement>('[data-act="studio-tab"][data-tab="overview"]')!.click();
		expect(checked()).toEqual(["false", "true"]);
		expect(modelColour()).toBe("Skifer");
		view.dispose();
		store.dispose();
	});

	it("shows the shared product Feeds link only on the primary Product Studio when multiple exist", async () => {
		const thetabands = summary({
			id: HEADBAND_ID,
			slug: "thetabands",
			title: "Thetabands",
			archetype: "studio",
			kind: "product",
			sortOrder: 10,
			sourceKind: "folder",
			repositoryKey: null,
			folderRoot: "surfaces/thetabands",
			siteSlug: null,
			previewMode: "studio_overlay",
			liveUrl: null,
		});
		const travelCase = summary({
			id: BRAND_ID,
			slug: "travel-case",
			title: "Travel Case",
			archetype: "studio",
			kind: "product",
			sortOrder: 20,
			sourceKind: "folder",
			repositoryKey: null,
			folderRoot: "surfaces/travel-case",
			siteSlug: null,
			previewMode: "studio_overlay",
			liveUrl: null,
		});
		const website = summary({
			id: IDENTITY_ID,
			slug: "website",
			title: "Hjemmeside",
			archetype: "live_build",
			kind: "website",
		});
		const store = storeWith(fakeClient({ listSurfaces: vi.fn(async () => [website, travelCase, thetabands]) }));
		await store.load();

		const primaryView = new SurfaceStudioView({
			store,
			surface: thetabands,
			signal: new AbortController().signal,
			baseFiles: { "surfaces/thetabands/specs.json": JSON.stringify({ weight: "42g" }) },
		});
		expect(primaryView.el.querySelector('[data-link-dir="out"] [data-slug="website"]')).not.toBeNull();
		primaryView.dispose();

		const secondaryView = new SurfaceStudioView({
			store,
			surface: travelCase,
			signal: new AbortController().signal,
			baseFiles: { "surfaces/travel-case/specs.json": JSON.stringify({ weight: "95g" }) },
		});
		expect(secondaryView.el.querySelector('[data-link-dir="out"]')).toBeNull();
		secondaryView.dispose();
		store.dispose();
	});

	it("shows a studio loading skeleton while cloud files load and keeps studio DOM and HTML frames intact across unrelated workspace refreshes", async () => {
		const brand = summary({
			id: BRAND_ID,
			slug: "brand",
			title: "Brand",
			archetype: "studio",
			folderRoot: "brand",
			siteSlug: null,
			liveUrl: null,
		});
		const website = summary();
		const filesDeferred = deferred<Record<string, string>>();
		const loadCloudFiles = vi.fn((_surface: SurfaceSummary) => filesDeferred.promise);
		const client = fakeClient({
			listSurfaces: vi.fn(async () => [website, brand]),
			getSurfaceWorkspace: vi.fn(async (id: string) =>
				workspace([], { surface: id === brand.id ? { ...brand } : { ...website } }),
			),
		});
		const store = storeWith(client, { loadCloudFiles });
		await store.load();

		const view = new SurfaceStudioView({
			store,
			surface: brand,
			signal: new AbortController().signal,
		});
		document.body.append(view.el);
		expect(view.el.querySelector(".skeleton-surface-studio")).not.toBeNull();
		expect(view.el.querySelector(".studio-empty")).toBeNull();
		expect(view.el.querySelector(".studio-head")).toBeNull();

		filesDeferred.resolve({
			"brand/tokens.json": JSON.stringify({ colors: { accent: "#2563eb" } }),
			"brand/voice.md": "# Voice\nCalm and clear.\n",
			"brand/index.html":
				"<!doctype html><html><head><title>Brand Sheet</title></head><body><h1>Brand</h1></body></html>",
		});
		await Promise.resolve();
		await Promise.resolve();
		view.update();
		expect(view.el.querySelector(".skeleton-surface-studio")).toBeNull();
		expect(view.el.querySelector('[data-token="colors.accent"]')).not.toBeNull();

		view.el.querySelector<HTMLButtonElement>('[data-act="studio-tab"][data-tab="pages"]')?.click();
		const frameBefore = view.el.querySelector<HTMLIFrameElement>("iframe.studio-html-frame");
		expect(frameBefore).not.toBeNull();

		await store.openSurface("website");
		await store.refreshWorkspace(brand.id);
		view.update();
		expect(view.el.querySelector<HTMLIFrameElement>("iframe.studio-html-frame")).toBe(frameBefore);
		expect(loadCloudFiles.mock.calls.filter(([surface]) => surface.id === brand.id)).toHaveLength(1);

		view.dispose();
		store.dispose();
	});

	it("streams studio sections and HTML frames across slices and aborts cleanly on deactivate", async () => {
		const product = summary({
			id: BRAND_ID,
			slug: "thetabands",
			title: "Thetabands",
			archetype: "studio",
			folderRoot: "product",
			siteSlug: null,
			liveUrl: null,
		});
		const client = fakeClient({
			listSurfaces: vi.fn(async () => [summary(), product]),
			getSurfaceWorkspace: vi.fn(async () => workspace([], { surface: product })),
		});
		const store = storeWith(client);
		await store.load();
		await store.openSurface("thetabands");

		const files: Record<string, string> = {
			"product/spec.json": JSON.stringify({ model: "Theta-1", weight: "18g" }),
			"product/brief.md": "# Brief\nCalm acoustic wristband.\n",
			"product/a.html":
				"<!doctype html><html><head><title>Theta &amp; Sound &#8212; Hero</title></head><body><h1>Hero</h1></body></html>",
			"product/b.html":
				"<!doctype html><html><head><title>Checkout</title></head><body><h1>Checkout</h1></body></html>",
		};

		const aborted = new SurfaceStudioView({
			store,
			surface: product,
			signal: new AbortController().signal,
			baseFiles: files,
			timeSlice: true,
		});
		document.body.append(aborted.el);
		expect(aborted.el.querySelector(".skeleton-surface-studio")).not.toBeNull();
		expect(aborted.el.querySelectorAll("iframe.studio-html-frame")).toHaveLength(0);
		aborted.deactivate();
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(aborted.el.querySelectorAll("iframe.studio-html-frame")).toHaveLength(0);
		expect(aborted.el.querySelector(".studio-grid")).toBeNull();
		aborted.dispose();

		const view = new SurfaceStudioView({
			store,
			surface: product,
			signal: new AbortController().signal,
			baseFiles: files,
			timeSlice: true,
		});
		document.body.append(view.el);
		expect(view.el.querySelector(".skeleton-surface-studio")).not.toBeNull();
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(view.el.querySelector(".skeleton-surface-studio")).toBeNull();
		const htmlCards = [...view.el.querySelectorAll<HTMLElement>(".studio-html-card")];
		expect(htmlCards).toHaveLength(2);
		expect(htmlCards[0]?.querySelector("h2")?.textContent).toBe("Theta & Sound — Hero");
		expect(view.el.querySelectorAll("iframe.studio-html-frame")).toHaveLength(2);
		view.dispose();
		store.dispose();
	});

	it("caps oversized spec tables and plain-text documents with on-demand expand buttons", async () => {
		const product = summary({
			id: BRAND_ID,
			slug: "thetabands",
			title: "Thetabands",
			archetype: "studio",
			folderRoot: "product",
			siteSlug: null,
			liveUrl: null,
		});
		const client = fakeClient({
			listSurfaces: vi.fn(async () => [summary(), product]),
			getSurfaceWorkspace: vi.fn(async () => workspace([], { surface: product })),
		});
		const store = storeWith(client);
		await store.load();
		await store.openSurface("thetabands");

		const bom = Array.from({ length: 135 }, (_, i) => ({ part: `P-${i + 1}`, cost: `$${i + 1}` }));
		const bigText = `${"alpha-line\n".repeat(3_600)}TAIL-MARKER`;
		const view = new SurfaceStudioView({
			store,
			surface: product,
			signal: new AbortController().signal,
			baseFiles: {
				"product/spec.json": JSON.stringify({ bom }),
				"product/build.txt": bigText,
			},
		});
		document.body.append(view.el);

		const tableWrap = view.el.querySelector(".studio-table-wrap")!;
		expect(tableWrap.querySelectorAll("tbody tr")).toHaveLength(100);
		const rowsBtn = tableWrap.querySelector<HTMLButtonElement>(".studio-more-btn")!;
		expect(rowsBtn.textContent).toBe("Show all 135 rows");
		rowsBtn.click();
		expect(tableWrap.querySelectorAll("tbody tr")).toHaveLength(135);
		expect(tableWrap.querySelector(".studio-more-btn")).toBeNull();

		const docCard = view.el.querySelector<HTMLElement>('.studio-doc[data-file="product/build.txt"]')!;
		const textBody = docCard.querySelector<HTMLElement>(".studio-plain-text")!;
		expect(textBody.textContent?.length).toBeLessThan(bigText.length);
		expect(textBody.textContent).not.toContain("TAIL-MARKER");
		const fileBtn = docCard.querySelector<HTMLButtonElement>(".studio-more-btn")!;
		expect(fileBtn.textContent).toBe("Show full file");
		fileBtn.click();
		expect(textBody.textContent).toContain("TAIL-MARKER");
		expect(textBody.textContent?.length).toBe(bigText.length);
		expect(docCard.querySelector(".studio-more-btn")).toBeNull();

		view.dispose();
		store.dispose();
	});
});

describe("SurfaceReportView", () => {
	it("shows its pill only while live changes are applied", async () => {
		const report = summary({
			id: BRAND_ID,
			slug: "brand",
			title: "Brand",
			archetype: "studio",
			icon: "book",
			sourceKind: "folder",
			repositoryKey: null,
			folderRoot: "brand",
			siteSlug: null,
			previewMode: "studio_overlay",
			liveUrl: null,
		});
		const c1 = change(CHANGES[0], 1, "staged", {
			surfaceId: BRAND_ID,
			kind: "folder_patch",
			title: "Sharper headline",
			affectedPaths: ["brand/q3.report.json"],
		});
		const reportSession = session(["staged"], { surfaceId: BRAND_ID, changes: [c1] });
		const client = fakeClient({
			listSurfaces: vi.fn(async () => [summary(), report]),
			getSurfaceWorkspace: vi.fn(async () => workspace([reportSession], { surface: report })),
			setPreviewSelection: vi.fn(async () => workspace([], { surface: report }).previewState),
		});
		const store = storeWith(client);
		await store.load();
		await store.openSurface("brand");
		store.setStudioPatch(CHANGES[0], [
			{ op: "merge_json", path: "brand/q3.report.json", patch: { headline: "Q3, sharper" } },
		]);

		const view = new SurfaceReportView({
			store,
			surface: report,
			signal: new AbortController().signal,
			baseFiles: { "brand/q3.report.json": JSON.stringify({ headline: "Q3", sections: [] }) },
		});
		document.body.append(view.el);
		expect(view.el.querySelector(".studio-badge")?.textContent).toBe("1 live change applied");

		await store.toggleChange(BRAND_ID, CHANGES[0]);
		view.update();
		expect(view.el.querySelector(".studio-badge")).toBeNull();
		expect(view.el.querySelector(".report-chrome")).not.toBeNull();
		view.dispose();
		store.dispose();
	});

	it("streams report sections across slices and cancels cleanly on deactivate", async () => {
		const report = summary({
			id: BRAND_ID,
			slug: "brand",
			title: "Brand",
			archetype: "studio",
			icon: "book",
			sourceKind: "folder",
			repositoryKey: null,
			folderRoot: "brand",
			siteSlug: null,
			previewMode: "studio_overlay",
			liveUrl: null,
		});
		const client = fakeClient({
			listSurfaces: vi.fn(async () => [summary(), report]),
			getSurfaceWorkspace: vi.fn(async () => workspace([], { surface: report })),
		});
		const store = storeWith(client);
		await store.load();
		await store.openSurface("brand");

		const reportJson = JSON.stringify({
			headline: "Architecture Analysis",
			sections: [
				{ id: "s1", heading: "One", paragraphs: ["First section."] },
				{ id: "s2", heading: "Two", paragraphs: ["Second section."] },
				{ id: "s3", heading: "Three", paragraphs: ["Third section."] },
				{ id: "s4", heading: "Four", paragraphs: ["Fourth section."] },
			],
		});

		const cancelled = new SurfaceReportView({
			store,
			surface: report,
			signal: new AbortController().signal,
			baseFiles: { "brand/arch.report.json": reportJson },
			timeSlice: true,
		});
		document.body.append(cancelled.el);
		expect(cancelled.el.querySelector(".skeleton-surface-report")).not.toBeNull();
		cancelled.deactivate();
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(cancelled.el.querySelectorAll(".report-section")).toHaveLength(0);
		cancelled.dispose();

		const view = new SurfaceReportView({
			store,
			surface: report,
			signal: new AbortController().signal,
			baseFiles: { "brand/arch.report.json": reportJson },
			timeSlice: true,
		});
		document.body.append(view.el);
		expect(view.el.querySelector(".skeleton-surface-report")).not.toBeNull();
		await new Promise((resolve) => setTimeout(resolve, 35));
		expect(view.el.querySelector(".skeleton-surface-report")).toBeNull();
		expect(view.el.querySelectorAll(".report-section")).toHaveLength(4);
		view.dispose();
		store.dispose();
	});
});
