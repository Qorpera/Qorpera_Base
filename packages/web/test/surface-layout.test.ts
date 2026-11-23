// @vitest-environment jsdom
import type { StudioPatchOp, SurfaceSummary } from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SurfaceStudioView } from "../src/app/views/surface-studio-view.ts";
import { setLanguagePreference } from "../src/ui/preferences.ts";
import { CHANGES, change, fakeClient, session, storeWith, summary, workspace } from "./surface-fixtures.ts";

const PRODUCT_ID = "22222222-2222-4222-8222-222222222240";
const ROOT = "surfaces/lamp";

afterEach(() => {
	setLanguagePreference("en");
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

function studio(overrides: Partial<SurfaceSummary> = {}): SurfaceSummary {
	return summary({
		id: PRODUCT_ID,
		slug: "lamp",
		title: "Lamp",
		archetype: "studio",
		kind: "product",
		sourceKind: "folder",
		repositoryKey: null,
		folderRoot: ROOT,
		siteSlug: null,
		previewMode: "studio_overlay",
		liveUrl: null,
		...overrides,
	});
}

async function open(
	baseFiles: Readonly<Record<string, string>>,
	options: { readonly ops?: readonly StudioPatchOp[]; readonly surface?: SurfaceSummary } = {},
) {
	const surface = options.surface ?? studio();
	const changes = options.ops
		? [change(CHANGES[0], 1, "staged", { surfaceId: surface.id, kind: "folder_patch", affectedPaths: [] })]
		: [];
	const store = storeWith(
		fakeClient({
			listSurfaces: vi.fn(async () => [surface]),
			getSurfaceWorkspace: vi.fn(async () =>
				workspace(changes.length ? [session(["staged"], { surfaceId: surface.id, changes })] : [], { surface }),
			),
		}),
	);
	await store.load();
	await store.openSurface(surface.slug);
	if (options.ops) store.setStudioPatch(CHANGES[0], options.ops);
	const view = new SurfaceStudioView({ store, surface, signal: new AbortController().signal, baseFiles });
	document.body.append(view.el);
	const tab = (id: string) =>
		view.el.querySelector<HTMLButtonElement>(`[data-act="studio-tab"][data-tab="${id}"]`)!.click();
	const tabs = () => [...view.el.querySelectorAll<HTMLButtonElement>(".studio-tab")].map((item) => item.textContent);
	return { store, surface, view, tab, tabs };
}

const SPECS = {
	overview: { tagline: "A lamp that dims itself.", battery: "14 h", weight: "48 g", price: "900 kr." },
	colorways: [
		{ name: "Ash", hex: "#dddddd" },
		{ name: "Clay", hex: "#b8684c" },
	],
	bom: [{ part: "Shade", supplier: "Nordic Knit", unitCost: "64 kr." }],
};

const VENDORS = {
	production: { targetBatch: "500" },
	vendors: [
		{ vendor: "Nordic Knit", component: "Shade", region: "DK", moq: "300", unitPrice: "64 kr.", status: "Chosen" },
		{ vendor: "Shenzhen Cell", component: "Battery", region: "CN" },
	],
};

const REPORT = JSON.stringify({ slug: "why-wool", headline: "Why wool", subtitle: "Warm light.", sections: [] });

function productFiles(): Record<string, string> {
	return {
		[`${ROOT}/specs.json`]: JSON.stringify(SPECS),
		[`${ROOT}/vendors.json`]: JSON.stringify(VENDORS),
		[`${ROOT}/why.report.json`]: REPORT,
		[`${ROOT}/brief.md`]: "# Lamp\nCalm evening light.\n",
		[`${ROOT}/mark.svg`]:
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="4" height="4"/></svg>',
	};
}

describe("Product studio on the layout renderer", () => {
	it("fills every block of the starter from the folder's files", async () => {
		const { view, tab, tabs, store } = await open(productFiles());
		expect(tabs()).toEqual(["Overview", "Specs", "Vendors", "Reports", "Files"]);
		expect(view.el.querySelectorAll(".studio-tab.is-empty")).toHaveLength(0);
		const product = view.el.querySelector(".studio-product")!;
		expect([...product.children].map((child) => child.className)).toEqual([
			"studio-stage is-empty",
			"studio-product-head",
			"studio-facts",
		]);
		expect(product.querySelector(".studio-product-head h2")?.textContent).toBe("Lamp");
		expect(product.querySelector(".studio-product-line")?.textContent).toBe("A lamp that dims itself.");
		expect(product.querySelectorAll(".studio-product-head .studio-dots .studio-dot")).toHaveLength(2);
		expect([...product.querySelectorAll(".studio-fact")].map((fact) => fact.textContent)).toEqual([
			"Battery14 h",
			"Weight48 g",
			"Price900 kr.",
		]);

		tab("specs");
		const specList = view.el.querySelector('[data-block="spec_list"]')!;
		expect(specList.querySelector("h2")?.textContent).toBe("Specs");
		expect(specList.querySelector(".studio-file-tag")?.textContent).toBe(`${ROOT}/specs.json`);
		expect([...specList.querySelectorAll(".studio-kv dt")].map((item) => item.textContent)).toEqual([
			"Tagline",
			"Battery",
			"Weight",
			"Price",
		]);
		expect(view.el.querySelectorAll('[data-block="spec_list"]')).toHaveLength(1);
		const table = view.el.querySelector('[data-block="table"]')!;
		expect(table.querySelector("h2")?.textContent).toBe("Parts");
		expect([...table.querySelectorAll("th")].map((cell) => cell.textContent)).toEqual([
			"Part",
			"Supplier",
			"Unit Cost",
		]);
		expect(table.querySelector("td")?.textContent).toBe("Shade");

		tab("vendors");
		expect(view.el.querySelector('[data-block="spec_list"] h2')?.textContent).toBe("Production plan");
		const cards = [...view.el.querySelectorAll<HTMLElement>(".studio-vendor-card")];
		expect(cards).toHaveLength(2);
		expect(cards[0]!.querySelector(".studio-vendor-top")?.textContent).toBe("Nordic KnitChosen");
		expect(cards[0]!.querySelector(".studio-vendor-comp")?.textContent).toBe("Shade");
		expect([...cards[0]!.querySelectorAll(".studio-vendor-meta span")].map((chip) => chip.textContent)).toEqual([
			"64 kr.",
			"MOQ 300",
			"DK",
		]);

		tab("reports");
		expect(view.el.querySelector(".report-headline")?.textContent).toBe("Why wool");

		tab("files");
		expect(view.el.querySelector('[data-file="surfaces/lamp/brief.md"]')?.textContent).toContain(
			"Calm evening light.",
		);
		expect(view.el.querySelector('[data-file="surfaces/lamp/mark.svg"]')).not.toBeNull();
		view.dispose();
		store.dispose();
	});

	it("marks only what a waiting change touched, block by block, and nothing once it is hidden", async () => {
		const files = {
			...productFiles(),
			[`${ROOT}/specs.json`]: JSON.stringify({
				...SPECS,
				model: { kind: "device", dimensions: "20 cm", layers: [] },
			}),
		};
		const { view, tab, store, surface } = await open(files, {
			ops: [
				{
					op: "merge_json",
					path: "specs.json",
					patch: {
						model: { dimensions: "22 cm" },
						overview: { tagline: "A lamp that dims itself at dusk.", weight: "44 g" },
						colorways: [
							{ name: "Ash", hex: "#dddddd" },
							{ name: "Clay", hex: "#a0522d" },
						],
						bom: [{ part: "Shade", supplier: "Nordic Knit", unitCost: "60 kr." }],
					},
				},
				{
					op: "merge_json",
					path: "vendors.json",
					patch: {
						vendors: [
							{ ...VENDORS.vendors[0], moq: "200" },
							{ vendor: "Shenzhen Cell", component: "Battery", region: "CN" },
						],
					},
				},
				{ op: "merge_json", path: "why.report.json", patch: { subtitle: "Warmer light." } },
				{ op: "write_text", path: "brief.md", content: "# Lamp\nWarm evening light.\n" },
			],
		});
		const changedFacts = () =>
			[...view.el.querySelectorAll(".studio-fact.is-changed dt")].map((item) => item.textContent);
		expect(view.el.querySelector(".studio-product-line.is-changed")?.textContent).toBe(
			"A lamp that dims itself at dusk.",
		);
		expect(view.el.querySelector(".studio-product-head h2.is-changed")).toBeNull();
		expect([...view.el.querySelectorAll(".studio-dot")].map((dot) => dot.classList.contains("is-changed"))).toEqual([
			false,
			true,
		]);
		expect(changedFacts()).toEqual(["Weight"]);
		expect(view.el.querySelector(".studio-stage .studio-3d")?.classList.contains("is-changed")).toBe(true);

		tab("specs");
		const specList = view.el.querySelector('[data-block="spec_list"]')!;
		expect(specList.classList.contains("is-changed")).toBe(true);
		expect(specList.querySelector(".studio-changed-pill")?.textContent).toBe("Updated");
		expect([...specList.querySelectorAll(".studio-diff-prev")].map((item) => item.textContent)).toEqual([
			"A lamp that dims itself.",
			"48 g",
		]);
		expect([...specList.querySelectorAll(".studio-diff-next")].map((item) => item.textContent)).toEqual([
			"A lamp that dims itself at dusk.",
			"44 g",
		]);
		expect(view.el.querySelector('[data-block="table"]')?.classList.contains("is-changed")).toBe(true);

		tab("vendors");
		expect(view.el.querySelector('[data-block="spec_list"]')?.classList.contains("is-changed")).toBe(false);
		expect(
			[...view.el.querySelectorAll(".studio-vendor-card")].map((card) => card.classList.contains("is-changed")),
		).toEqual([true, false]);

		tab("reports");
		expect(view.el.querySelector(".report-dek.is-changed")?.textContent).toContain("Warmer light.");

		tab("files");
		expect(view.el.querySelector('[data-file="surfaces/lamp/brief.md"]')?.classList.contains("is-changed")).toBe(
			true,
		);

		await store.toggleChange(surface.id, CHANGES[0]);
		view.update();
		expect(view.el.querySelectorAll(".is-changed")).toHaveLength(0);
		tab("overview");
		expect(view.el.querySelectorAll(".is-changed")).toHaveLength(0);
		expect(changedFacts()).toEqual([]);
		view.dispose();
		store.dispose();
	});

	it("carries over today's line, the rest of specs.json and the folder's own pages", async () => {
		const { view, tab, store } = await open({
			[`${ROOT}/specs.json`]: JSON.stringify({
				tagline: "A lamp that dims itself.",
				overview: { battery: "14 h" },
				bom: [{ part: "Shade" }],
				colorways: [{ name: "Ash", hex: "#dddddd" }],
				warranty: "2 years",
				dimensions: { height: "32 cm", shade: { width: "18 cm" } },
				certifications: [{ name: "CE" }],
			}),
			[`${ROOT}/pages/sheet.html`]:
				"<!doctype html><html><head><title>Spec sheet</title></head><body><h1>Lamp</h1></body></html>",
		});
		expect(view.el.querySelector(".studio-product-line")?.textContent).toBe("A lamp that dims itself.");

		tab("specs");
		const lists = [...view.el.querySelectorAll('[data-block="spec_list"]')];
		expect(lists.map((list) => list.querySelector("h2")?.textContent)).toEqual(["Specs", "Other details"]);
		expect([...lists[1]!.querySelectorAll(".studio-kv dt")].map((item) => item.textContent)).toEqual([
			"Warranty",
			"Dimensions · Height",
			"Dimensions · Shade · Width",
		]);
		expect(lists[1]!.textContent).not.toContain("A lamp that dims itself.");
		expect(lists[1]!.querySelector(".studio-table")).toBeNull();

		tab("files");
		const page = view.el.querySelector('.studio-html-card[data-file="surfaces/lamp/pages/sheet.html"]');
		expect(page?.querySelector("h2")?.textContent).toBe("Spec sheet");
		expect(page?.querySelector("iframe.studio-html-frame")).not.toBeNull();
		expect(view.el.querySelector(".studio-home-empty")).toBeNull();
		view.dispose();
		store.dispose();
	});

	it("draws the layout across time slices like the page did", async () => {
		const surface = studio();
		const store = storeWith(fakeClient({ listSurfaces: vi.fn(async () => [surface]) }));
		await store.load();
		const view = new SurfaceStudioView({
			store,
			surface,
			signal: new AbortController().signal,
			baseFiles: productFiles(),
			timeSlice: true,
		});
		document.body.append(view.el);
		expect(view.el.querySelector(".skeleton-surface-studio")).not.toBeNull();
		await vi.waitFor(() => expect(view.el.querySelector(".studio-product .studio-facts")).not.toBeNull());
		expect(view.el.querySelector(".skeleton-surface-studio")).toBeNull();
		expect(view.el.querySelectorAll(".studio-tab")).toHaveLength(5);
		view.dispose();
		store.dispose();
	});

	it("tints the model with the dots that name its stage, and keeps the pick across tabs", async () => {
		const { view, tab, store } = await open({
			[`${ROOT}/specs.json`]: JSON.stringify({
				...SPECS,
				model: { kind: "device", dimensions: "20 cm", layers: ["Shade", "Base"] },
			}),
		});
		const colour = () => view.el.querySelector<HTMLElement>(".studio-stage .studio-3d")?.dataset.colorway;
		expect(colour()).toBe("Ash");
		view.el.querySelectorAll<HTMLButtonElement>('[data-act="studio-colorway"]')[1]!.click();
		expect(colour()).toBe("Clay");
		tab("files");
		tab("overview");
		expect(colour()).toBe("Clay");
		expect(
			[...view.el.querySelectorAll('[data-act="studio-colorway"]')].map((dot) => dot.getAttribute("aria-checked")),
		).toEqual(["false", "true"]);
		view.dispose();
		store.dispose();
	});

	it("passes the starter's words through Danish and keeps a company's own words as written", async () => {
		setLanguagePreference("da");
		const starter = await open(productFiles());
		expect(starter.tabs()).toEqual(["Overblik", "Specifikationer", "Leverandører", "Rapporter", "Filer"]);
		starter.tab("specs");
		expect(starter.view.el.querySelector('[data-block="table"] h2')?.textContent).toBe("Dele");
		starter.view.dispose();
		starter.store.dispose();

		const own = await open({
			[`${ROOT}/layout.json`]: JSON.stringify({
				schema: "qorpera.surface-layout/v1",
				tabs: [
					{ id: "look", title: "Look", blocks: [{ type: "title" }] },
					{ id: "parts", title: "Parts", blocks: [{ type: "table", from: "specs.json#/bom", heading: "Parts" }] },
				],
			}),
		});
		expect(own.tabs()).toEqual(["Look", "Parts"]);
		own.tab("parts");
		expect(own.view.el.querySelector('[data-block="table"] h2')?.textContent).toBe("Parts");
		own.view.dispose();
		own.store.dispose();
	});
});

describe("A folder's own layout.json", () => {
	const OWN_LAYOUT = {
		schema: "qorpera.surface-layout/v1",
		tabs: [
			{
				id: "overview",
				title: "Overview",
				blocks: [
					{ type: "title", line: { value: "Light for long evenings." } },
					{
						type: "facts",
						items: [
							{ label: "Battery", from: "specs.json#/overview/battery" },
							{ label: "Lumen", from: "specs.json#/overview/lumen" },
						],
					},
					{
						type: "row",
						blocks: [
							{ type: "spec_list", from: "specs.json#/overview", heading: "At a glance" },
							{ type: "cards", from: "vendors.json#/vendors", title: "vendor", lines: ["component"] },
						],
					},
					{ type: "palette", from: "specs.json#/colorways" },
					{ type: "sparkline", from: "specs.json#/sales" },
				],
			},
			{ id: "specs", title: "Specs", blocks: [{ type: "table", from: "specs.json#/bom" }] },
			{
				id: "vendors",
				title: "Vendors",
				blocks: [{ type: "cards", from: "vendors.json#/vendors", title: "vendor" }],
			},
			{ id: "reports", title: "Reports", blocks: [{ type: "report", match: "*.report.json" }] },
			{ id: "files", title: "Files", blocks: [{ type: "files", match: ["*.md"] }] },
			{
				id: "launch",
				title: "Launch plan",
				blocks: [{ type: "files", match: ["launch/*.md", "/notes/launch.md"], heading: "Launch" }],
			},
		],
	};

	it("reshapes the page: a sixth tab, no stage, a row of two blocks and quiet homes for blocks it cannot draw", async () => {
		const { view, tab, tabs, store } = await open({
			...productFiles(),
			[`${ROOT}/layout.json`]: JSON.stringify(OWN_LAYOUT),
			[`${ROOT}/launch/plan.md`]: "# Launch\nPre-orders open in March.\n",
			"notes/launch.md": "# Notes\nAsk the shop about May.\n",
		});
		expect(tabs()).toEqual(["Overview", "Specs", "Vendors", "Reports", "Files", "Launch plan"]);
		expect(view.el.querySelector(".studio-stage")).toBeNull();
		expect(view.el.querySelector(".studio-product-line")?.textContent).toBe("Light for long evenings.");
		expect([...view.el.querySelectorAll(".studio-fact")].map((fact) => fact.textContent)).toEqual([
			"Battery14 h",
			"Lumen?",
		]);
		const row = view.el.querySelector<HTMLElement>(".studio-row")!;
		expect(row.style.getPropertyValue("--studio-row-columns")).toBe("2");
		const cells = [...row.querySelectorAll(".studio-row-cell")];
		expect(cells).toHaveLength(2);
		expect(cells[0]!.querySelector('[data-block="spec_list"] h2')?.textContent).toBe("At a glance");
		expect(cells[1]!.querySelectorAll(".studio-vendor-card")).toHaveLength(2);
		const quiet = [...view.el.querySelectorAll(".studio-home-quiet")];
		expect(quiet).toHaveLength(2);
		expect(quiet.map((home) => home.textContent)).toEqual(["", ""]);
		expect(view.el.textContent).not.toContain("sparkline");

		tab("launch");
		expect(view.el.querySelector(".studio-section-head h2")?.textContent).toBe("Launch");
		expect(view.el.querySelector('[data-file="surfaces/lamp/launch/plan.md"]')?.textContent).toContain("March");
		expect(view.el.querySelector('[data-file="notes/launch.md"]')?.textContent).toContain("Ask the shop");
		expect(view.el.querySelector('[data-file="surfaces/lamp/brief.md"]')).toBeNull();
		tab("files");
		expect(view.el.querySelector('[data-file="surfaces/lamp/brief.md"]')).not.toBeNull();
		expect(view.el.querySelector('[data-file="surfaces/lamp/launch/plan.md"]')).toBeNull();
		view.dispose();
		store.dispose();
	});

	it("draws a waiting change to layout.json as the new shape, and the old shape once it is hidden", async () => {
		const { view, tabs, store, surface } = await open(productFiles(), {
			ops: [{ op: "write_text", path: "layout.json", content: JSON.stringify(OWN_LAYOUT) }],
		});
		expect(tabs()).toHaveLength(6);
		await store.toggleChange(surface.id, CHANGES[0]);
		view.update();
		expect(tabs()).toEqual(["Overview", "Specs", "Vendors", "Reports", "Files"]);
		view.dispose();
		store.dispose();
	});

	it("falls back to the starter when layout.json does not parse, and says nothing technical", async () => {
		for (const broken of ["{not json", JSON.stringify({ schema: "something/else", tabs: [] })]) {
			const { view, tabs, store } = await open({ ...productFiles(), [`${ROOT}/layout.json`]: broken });
			expect(tabs()).toEqual(["Overview", "Specs", "Vendors", "Reports", "Files"]);
			expect(view.el.querySelector(".studio-home-quiet")).toBeNull();
			expect(view.el.textContent).not.toMatch(/layout|JSON|schema/);
			view.dispose();
			store.dispose();
		}
	});

	it("moves any interface with its own layout.json onto the renderer, and leaves the others as they were", async () => {
		const notes = studio({
			id: "22222222-2222-4222-8222-222222222241",
			slug: "notes",
			title: "Notes",
			kind: "custom",
		});
		const ownFiles = {
			[`${ROOT}/layout.json`]: JSON.stringify({
				schema: "qorpera.surface-layout/v1",
				tabs: [{ id: "overview", title: "Overview", blocks: [{ type: "title" }, { type: "files" }] }],
			}),
			[`${ROOT}/brief.md`]: "# Notes\nWhat we learned.\n",
		};
		const withLayout = await open(ownFiles, { surface: notes });
		expect(withLayout.view.el.querySelector(".studio-tabs")).toBeNull();
		expect(withLayout.view.el.querySelector(".studio-product-head h2")?.textContent).toBe("Notes");
		expect(withLayout.view.el.querySelector('[data-file="surfaces/lamp/brief.md"]')).not.toBeNull();
		withLayout.view.dispose();
		withLayout.store.dispose();

		const without = await open({ [`${ROOT}/brief.md`]: "# Notes\nWhat we learned.\n" }, { surface: notes });
		expect(without.view.el.querySelector(".studio-product")).toBeNull();
		expect(without.view.el.querySelector('[data-file="surfaces/lamp/brief.md"]')).not.toBeNull();
		without.view.dispose();
		without.store.dispose();
	});
});
