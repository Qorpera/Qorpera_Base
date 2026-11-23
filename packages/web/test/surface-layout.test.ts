// @vitest-environment jsdom
import type { StudioBinaryRef, StudioPatchOp, SurfaceSummary } from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SurfaceStudioView } from "../src/app/views/surface-studio-view.ts";
import { PAGE_CONTENT, PAGE_FRAME_URL, PAGE_READY } from "../src/ui/page-frame.ts";
import { setLanguagePreference } from "../src/ui/preferences.ts";
import {
	CHANGES,
	change,
	fakeClient,
	folderContents,
	session,
	storeWith,
	summary,
	workspace,
} from "./surface-fixtures.ts";

const PRODUCT_ID = "22222222-2222-4222-8222-222222222240";
const IDENTITY_ID = "22222222-2222-4222-8222-222222222242";
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
		expect(lists[1]!.querySelector(".studio-subhead")?.textContent).toBe("Certifications");
		expect(lists[1]!.querySelector(".studio-table td")?.textContent).toBe("CE");

		tab("files");
		const page = view.el.querySelector('.studio-html-card[data-file="surfaces/lamp/pages/sheet.html"]');
		expect(page?.querySelector("h2")?.textContent).toBe("Spec sheet");
		expect(page?.querySelector("iframe.studio-html-frame")).not.toBeNull();
		expect(view.el.querySelector(".studio-home-empty")).toBeNull();
		view.dispose();
		store.dispose();
	});

	it("gives a list of the rest no empty home, and a named list one", async () => {
		const { view, tab, store } = await open({});
		tab("specs");
		const lists = [...view.el.querySelectorAll('[data-block="spec_list"]')];
		expect(lists.map((list) => list.querySelector("h2")?.textContent)).toEqual(["Specs"]);
		expect(lists[0]!.querySelector(".studio-kv.is-empty")).not.toBeNull();
		view.dispose();
		store.dispose();
	});

	it("shows only figures short enough to read as one, so fewer when values are long", async () => {
		const { view, store } = await open({
			[`${ROOT}/specs.json`]: JSON.stringify({
				overview: {
					product: "Thetaband Gen 1",
					status: "Prototype v2 (BrainBit evaluering)",
					electronics: "BrainBit 4-ch dry EEG",
					weight: "48 g",
					battery: "8 timer meditation",
					retailPrice: "1.995 kr. inkl. moms",
				},
			}),
		});
		expect([...view.el.querySelectorAll(".studio-fact")].map((fact) => fact.textContent)).toEqual([
			"ProductThetaband Gen 1",
			"Weight48 g",
			"Battery8 timer meditation",
		]);
		view.dispose();
		store.dispose();
	});

	it("finds the dots under colors and the vendors under suppliers", async () => {
		const { view, tab, store } = await open({
			[`${ROOT}/specs.json`]: JSON.stringify({ colors: [{ name: "Moss", hex: "#5b6b3a" }] }),
			[`${ROOT}/vendors.json`]: JSON.stringify({ suppliers: [{ vendor: "Nordic Knit", component: "Shade" }] }),
		});
		expect(
			[...view.el.querySelectorAll('[data-act="studio-colorway"]')].map((dot) => dot.getAttribute("aria-label")),
		).toEqual(["Moss"]);
		tab("vendors");
		expect(view.el.querySelector(".studio-vendor-card .studio-vendor-top")?.textContent).toBe("Nordic Knit");
		view.dispose();
		store.dispose();
	});

	it("shows a .json file no block reads as a card on Specs, never one another block draws", async () => {
		const { view, tab, store } = await open({
			...productFiles(),
			[`${ROOT}/object.json`]: JSON.stringify({ model: "lamp.glb" }),
			[`${ROOT}/parts/shade/object.json`]: JSON.stringify({ model: "shade.glb", parts: [{ name: "Shade" }] }),
			[`${ROOT}/pricing.json`]: JSON.stringify({ retail: "900 kr.", tiers: [{ name: "Early", price: "750 kr." }] }),
			[`${ROOT}/sales.report.json`]: REPORT,
		});
		tab("specs");
		const cards = [...view.el.querySelectorAll<HTMLElement>(".studio-grid > section[data-file]")];
		expect(cards.map((card) => card.dataset.file)).toEqual([`${ROOT}/pricing.json`]);
		expect(cards[0]!.querySelector("h2")?.textContent).toBe("Pricing");
		expect(cards[0]!.querySelector(".studio-kv dt")?.textContent).toBe("Retail");
		expect(cards[0]!.querySelector(".studio-table td")?.textContent).toBe("Early");
		tab("files");
		expect(view.el.querySelector('[data-file$=".json"]')).toBeNull();
		view.dispose();
		store.dispose();

		const own = await open({
			[`${ROOT}/notes.json`]: JSON.stringify({ owner: "Ida" }),
			[`${ROOT}/specs.json`]: JSON.stringify({ overview: { weight: "48 g" } }),
			[`${ROOT}/layout.json`]: JSON.stringify({
				schema: "qorpera.surface-layout/v1",
				tabs: [
					{
						id: "all",
						title: "All",
						blocks: [
							{ type: "spec_list", from: "specs.json#/overview" },
							{ type: "files", match: ["**/*.json"] },
						],
					},
				],
			}),
		});
		expect(
			[...own.view.el.querySelectorAll<HTMLElement>(".studio-grid > section[data-file]")].map(
				(card) => card.dataset.file,
			),
		).toEqual([`${ROOT}/notes.json`]);
		own.view.dispose();
		own.store.dispose();
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
		expect(quiet).toHaveLength(1);
		expect(quiet[0]!.textContent).toBe("");
		const palette = view.el.querySelector('[data-block="palette"]')!;
		expect([...palette.querySelectorAll(".studio-swatch strong")].map((name) => name.textContent)).toEqual([
			"Ash",
			"Clay",
		]);
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

	it("draws any interface with its own layout.json from it, and one without from its starter", async () => {
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
		expect(without.tabs()).toEqual(["Overview", "Reports"]);
		expect(without.view.el.querySelector(".studio-product-head h2")?.textContent).toBe("Notes");
		expect(without.view.el.querySelector('[data-file="surfaces/lamp/brief.md"]')).not.toBeNull();
		without.view.dispose();
		without.store.dispose();
	});
});

function identityStudio(): SurfaceSummary {
	return summary({
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
}

const SEEDED_TOKENS = {
	brand: "Lumen",
	colors: { primary: "#18181b", accent: "#2563eb", surface: "#ffffff", muted: "#f4f4f5" },
	typography: { heading: "Inter", body: "Inter", mono: "JetBrains Mono" },
	voice: { summary: "Light for long evenings." },
};

function seededIdentity(): Record<string, string> {
	return {
		"identity/brief.md": "# Lumen — Identity\n\n## Voice & Tone\n- Clear, grounded, and direct.\n",
		"identity/tokens.json": JSON.stringify(SEEDED_TOKENS),
		"identity/tokens.css": ":root { --q-color-accent: #2563eb; }\n",
	};
}

const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4"/></svg>';

function fullIdentity(): Record<string, string> {
	return {
		...seededIdentity(),
		"identity/tokens.json": JSON.stringify({
			...SEEDED_TOKENS,
			radius: { card: "14px", pill: "999px" },
			spacing: { gutter: "24px" },
		}),
		"identity/company.json": JSON.stringify({
			name: "Lumen Lamps",
			mission: "Make evening light calm.",
			ambition: ["A lamp in every Nordic home", "No screens after dark"],
			strategy: [
				{ title: "Wool first", detail: "Every shade is knitted." },
				{ title: "Sell direct", detail: "No retailers before 2028." },
			],
		}),
		"identity/logo.svg": LOGO,
		"identity/wordmark.svg": LOGO,
		"identity/concepts/glow.svg": LOGO,
		"identity/design-system.json": JSON.stringify({
			system: { posture: "Calm Nordic craft", motion: "Quiet spring" },
			consumers: [{ surface: "Website", status: "Synced" }],
		}),
		"identity/motion.json": JSON.stringify({ spring: "220 ms" }),
		"identity/voice.md": "# Voice\nCalm and concrete.\n",
		"identity/notes/naming.md": "# Naming\nShort Danish words.\n",
		"identity/philosophy.report.json": JSON.stringify({
			slug: "philosophy",
			headline: "Why we make light slowly",
			sections: [],
		}),
		"identity/site/index.html": "<!doctype html><html><head><title>Look book</title></head><body>Hi</body></html>",
	};
}

describe("Identity on the layout renderer", () => {
	it("draws every home of the starter when the folder is empty, with no whole-page empty state", async () => {
		const { view, tab, tabs, store } = await open({}, { surface: identityStudio() });
		expect(tabs()).toEqual(["Overview", "Strategy", "Philosophy", "Voice", "Design system", "Files"]);
		expect([...view.el.querySelectorAll(".studio-tab.is-empty")].map((item) => item.textContent)).toEqual([
			"Strategy",
			"Philosophy",
			"Voice",
			"Design system",
			"Files",
		]);
		expect(view.el.querySelector(".studio-empty")).toBeNull();
		const marks = [...view.el.querySelectorAll('[data-block="brand_mark"]')];
		expect(marks.map((mark) => mark.querySelector("h2")?.textContent)).toEqual(["Logo", "Wordmark"]);
		for (const mark of marks) {
			expect(mark.querySelectorAll(".studio-mark-grounds.is-empty .studio-mark-ground")).toHaveLength(2);
			expect(mark.querySelector("img")).toBeNull();
		}
		expect(view.el.querySelector(".studio-product-head h2")?.textContent).toBe("Identity");
		const mission = view.el.querySelector('[data-block="cards"]')!;
		expect(mission.querySelector("h2")?.textContent).toBe("Mission & Ambition");
		expect(
			[...mission.querySelectorAll(".studio-named-card.is-empty strong")].map((title) => title.textContent),
		).toEqual(["Mission", "Ambition"]);
		expect(mission.querySelectorAll(".studio-card-lines.is-empty .studio-pale-bar")).toHaveLength(4);
		expect(view.el.querySelectorAll('[data-block="palette"] .studio-swatches.is-empty .studio-swatch')).toHaveLength(
			4,
		);
		expect(
			view.el.querySelectorAll('[data-block="type_specimen"] .studio-type-list.is-empty .studio-type-row'),
		).toHaveLength(3);
		tab("strategy");
		expect(view.el.querySelectorAll(".studio-vendor-card.is-empty")).toHaveLength(2);
		tab("philosophy");
		expect(view.el.querySelector(".studio-home-empty")?.textContent).toBe("Reports and posts live here.");
		tab("system");
		expect(view.el.querySelectorAll('[data-block="spec_list"]')).toHaveLength(1);
		expect(view.el.querySelector('[data-block="spec_list"] h2')?.textContent).toBe("Design system");
		expect(view.el.querySelectorAll(".studio-kv.is-empty")).toHaveLength(1);
		view.dispose();
		store.dispose();
	});

	it("shows what the seed writes: the name, the line, the palette, the type and the brief", async () => {
		const { view, tab, store } = await open(seededIdentity(), { surface: identityStudio() });
		expect(view.el.querySelector(".studio-product-head h2")?.textContent).toBe("Lumen");
		expect(view.el.querySelector(".studio-product-line")?.textContent).toBe("Light for long evenings.");
		expect(
			[...view.el.querySelectorAll('[data-block="palette"] .studio-swatch strong')].map((name) => name.textContent),
		).toEqual(["Primary", "Accent", "Surface", "Muted"]);
		expect(
			[...view.el.querySelectorAll('[data-block="type_specimen"] .studio-type-meta')].map((row) => row.textContent),
		).toEqual(["HeadingInter", "BodyInter", "MonoJetBrains Mono"]);
		expect(view.el.querySelectorAll(".is-changed")).toHaveLength(0);
		tab("voice");
		expect(view.el.querySelector('[data-file="identity/brief.md"]')?.textContent).toContain("Clear, grounded");
		tab("system");
		expect(view.el.querySelectorAll('[data-block="spec_list"]')).toHaveLength(1);
		expect(view.el.querySelector('[data-block="spec_list"] h2')?.textContent).toBe("Design system");
		tab("files");
		expect(view.el.querySelector(".studio-home-empty")?.textContent).toBe(
			"Working files. Models, pictures and notes live here.",
		);
		view.dispose();
		store.dispose();
	});

	it("carries over the fuller folder: marks, cards, tokens, design system, other files and pages", async () => {
		const { view, tab, tabs, store } = await open(fullIdentity(), { surface: identityStudio() });
		expect(tabs()).toHaveLength(6);
		expect(view.el.querySelectorAll(".studio-tab.is-empty")).toHaveLength(0);
		expect(view.el.querySelectorAll('[data-block="brand_mark"] img.studio-mark-img')).toHaveLength(4);
		expect(view.el.querySelector(".studio-product-head h2")?.textContent).toBe("Lumen Lamps");
		const cards = [...view.el.querySelectorAll(".studio-named-card")];
		expect(cards[0]?.querySelector(".studio-card-text")?.textContent).toBe("Make evening light calm.");
		expect([...cards[1]!.querySelectorAll(".studio-card-lines li")].map((line) => line.textContent)).toEqual([
			"A lamp in every Nordic home",
			"No screens after dark",
		]);
		tab("strategy");
		expect([...view.el.querySelectorAll(".studio-vendor-card strong")].map((title) => title.textContent)).toEqual([
			"Wool first",
			"Sell direct",
		]);
		tab("philosophy");
		expect(view.el.querySelector(".report-headline")?.textContent).toBe("Why we make light slowly");
		tab("voice");
		expect(view.el.querySelector('[data-file="identity/voice.md"]')).not.toBeNull();
		expect(view.el.querySelector('[data-file="identity/notes/naming.md"]')).toBeNull();
		tab("system");
		const lists = [...view.el.querySelectorAll('[data-block="spec_list"]')];
		expect(lists.map((list) => list.querySelector("h2")?.textContent)).toEqual(["Tokens", "Design system"]);
		expect([...lists[0]!.querySelectorAll(".studio-kv dt")].map((key) => key.textContent)).toEqual([
			"Radius · Card",
			"Radius · Pill",
			"Spacing · Gutter",
		]);
		expect([...lists[1]!.querySelectorAll(".studio-kv dd")].map((value) => value.textContent)).toEqual([
			"Calm Nordic craft",
			"Quiet spring",
		]);
		expect(lists[1]!.querySelector(".studio-table td")?.textContent).toBe("Website");
		const data = [...view.el.querySelectorAll("section[data-file]")].map((card) => card.getAttribute("data-file"));
		expect(data).toEqual(["identity/motion.json"]);
		tab("files");
		expect(view.el.querySelector('[data-file="identity/concepts/glow.svg"]')).not.toBeNull();
		expect(view.el.querySelector('[data-file="identity/notes/naming.md"]')).not.toBeNull();
		expect(view.el.querySelector('.studio-html-card[data-file="identity/site/index.html"] iframe')).not.toBeNull();
		for (const path of ["logo.svg", "wordmark.svg", "voice.md", "brief.md", "tokens.css", "tokens.json"]) {
			expect(view.el.querySelector(`[data-file="identity/${path}"]`)).toBeNull();
		}
		view.dispose();
		store.dispose();
	});

	it("marks the named cards and the marks a waiting change touched, and nothing once it is hidden", async () => {
		const { view, store, surface } = await open(fullIdentity(), {
			surface: identityStudio(),
			ops: [
				{ op: "merge_json", path: "company.json", patch: { mission: "Make evening light calmer." } },
				{ op: "write_text", path: "wordmark.svg", content: LOGO.replace('r="4"', 'r="3"') },
			],
		});
		const cards = [...view.el.querySelectorAll(".studio-named-card")];
		expect(cards.map((card) => card.classList.contains("is-changed"))).toEqual([true, false]);
		expect(cards[0]?.querySelector(".studio-card-text")?.textContent).toBe("Make evening light calmer.");
		expect(view.el.querySelector('[data-block="cards"] .studio-changed-pill')).not.toBeNull();
		expect(
			[...view.el.querySelectorAll('[data-block="brand_mark"]')].map((mark) =>
				mark.classList.contains("is-changed"),
			),
		).toEqual([false, true]);
		expect(view.el.querySelector(".studio-product-head h2.is-changed")).toBeNull();
		await store.toggleChange(surface.id, CHANGES[0]);
		view.update();
		expect(view.el.querySelectorAll(".is-changed")).toHaveLength(0);
		expect(view.el.querySelector(".studio-card-text")?.textContent).toBe("Make evening light calm.");
		view.dispose();
		store.dispose();
	});

	it("honours a company's own layout.json on Identity, with a picture file for the logo", async () => {
		const identity = identityStudio();
		const ref: StudioBinaryRef = {
			manifestSha256: "c".repeat(64),
			fileSha256: "d".repeat(64),
			bytes: 3,
			mediaType: "image/png",
		};
		const readCloudBinary = vi.fn(async () => new Uint8Array([1, 2, 3]));
		const createObjectURL = vi.fn(() => "blob:logo");
		const revokeObjectURL = vi.fn();
		Object.assign(URL, { createObjectURL, revokeObjectURL });
		const store = storeWith(
			fakeClient({
				listSurfaces: vi.fn(async () => [identity]),
				getSurfaceWorkspace: vi.fn(async () => workspace([], { surface: identity })),
			}),
			{
				loadCloudFiles: vi.fn(async () =>
					folderContents(
						{
							...seededIdentity(),
							"identity/layout.json": JSON.stringify({
								schema: "qorpera.surface-layout/v1",
								tabs: [
									{
										id: "look",
										title: "Look",
										blocks: [
											{ type: "brand_mark", from: "logo.png", grounds: ["dark"], heading: "Mark" },
											{ type: "palette", from: "tokens.json#/colors" },
										],
									},
								],
							}),
						},
						{ "identity/logo.png": ref },
					),
				),
				readCloudBinary,
			},
		);
		await store.load();
		await store.refreshCloudFiles(identity);
		const lifetime = new AbortController();
		const view = new SurfaceStudioView({ store, surface: identity, signal: lifetime.signal });
		document.body.append(view.el);
		expect(view.el.querySelector(".studio-tabs")).toBeNull();
		const mark = view.el.querySelector('[data-block="brand_mark"]')!;
		expect(mark.querySelector("h2")?.textContent).toBe("Mark");
		expect(
			[...mark.querySelectorAll<HTMLElement>(".studio-mark-ground")].map((ground) => ground.dataset.ground),
		).toEqual(["dark"]);
		await vi.waitFor(() => expect(mark.querySelector("img")?.getAttribute("src")).toBe("blob:logo"));
		expect(readCloudBinary).toHaveBeenCalledWith(ref, expect.anything());
		expect(view.el.querySelectorAll('[data-block="palette"] .studio-swatch')).toHaveLength(4);
		lifetime.abort();
		await vi.waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:logo"));
		Reflect.deleteProperty(URL, "createObjectURL");
		Reflect.deleteProperty(URL, "revokeObjectURL");
		store.dispose();
	});

	it("reads /identity files on another interface from the company's Identity, changes included", async () => {
		const identity = identityStudio();
		const lamp = studio();
		const identityChange = change(CHANGES[1], 1, "staged", {
			surfaceId: identity.id,
			kind: "folder_patch",
			affectedPaths: ["tokens.json"],
		});
		const store = storeWith(
			fakeClient({
				listSurfaces: vi.fn(async () => [lamp, identity]),
				getSurfaceWorkspace: vi.fn(async (id: string) =>
					id === identity.id
						? workspace([session(["staged"], { surfaceId: identity.id, changes: [identityChange] })], {
								surface: identity,
							})
						: workspace([], { surface: lamp }),
				),
			}),
			{
				loadCloudFiles: vi.fn(async (surface: SurfaceSummary) =>
					folderContents(surface.id === identity.id ? fullIdentity() : {}),
				),
			},
		);
		await store.load();
		await store.refreshCloudFiles(identity);
		await store.openSurface("identity");
		await store.openSurface("lamp");
		const view = new SurfaceStudioView({
			store,
			surface: lamp,
			signal: new AbortController().signal,
			baseFiles: {
				...productFiles(),
				[`${ROOT}/layout.json`]: JSON.stringify({
					schema: "qorpera.surface-layout/v1",
					tabs: [
						{
							id: "brand",
							title: "Brand",
							blocks: [
								{ type: "brand_mark", from: "/identity/logo.svg", heading: "Logo" },
								{ type: "palette", from: "/identity/tokens.json#/colors", heading: "Palette" },
								{ type: "files", match: ["/identity/voice.md"] },
							],
						},
					],
				}),
			},
		});
		document.body.append(view.el);
		const swatch = (token: string) => view.el.querySelector(`[data-block="palette"] [data-token="${token}"]`);
		expect(view.el.querySelectorAll('[data-block="brand_mark"] img')).toHaveLength(2);
		expect(view.el.querySelector('[data-file="identity/voice.md"]')?.textContent).toContain("Calm and concrete.");
		expect(swatch("colors.accent")?.querySelector("code")?.textContent).toBe("#2563eb");
		expect(view.el.querySelectorAll(".is-changed")).toHaveLength(0);

		store.setStudioPatch(CHANGES[1], [
			{ op: "merge_json", path: "tokens.json", patch: { colors: { accent: "#c9643b" } } },
		]);
		view.update();
		expect(swatch("colors.accent")?.querySelector("code")?.textContent).toBe("#c9643b");
		expect(swatch("colors.accent")?.classList.contains("is-changed")).toBe(true);
		expect(swatch("colors.primary")?.classList.contains("is-changed")).toBe(false);
		view.dispose();
		store.dispose();
	});
});

function customStudio(): SurfaceSummary {
	return studio({
		id: "22222222-2222-4222-8222-222222222243",
		slug: "notes",
		title: "Notes",
		kind: "custom",
		icon: "star",
	});
}

describe("Custom interfaces on the layout renderer", () => {
	it("draws a fresh custom interface's homes: its title, the pale line, the files line and a pale Reports tab", async () => {
		const { view, tab, tabs, store } = await open({}, { surface: customStudio() });
		expect(tabs()).toEqual(["Overview", "Reports"]);
		expect([...view.el.querySelectorAll(".studio-tab.is-empty")].map((item) => item.textContent)).toEqual([
			"Reports",
		]);
		expect(view.el.querySelector(".studio-empty")).toBeNull();
		expect(view.el.querySelector(".studio-product-head h2")?.textContent).toBe("Notes");
		expect(view.el.querySelector(".studio-product-line.is-empty")?.textContent).toBe("One line about what it is");
		expect(view.el.querySelector(".studio-section-head h2")?.textContent).toBe("Files");
		expect(view.el.querySelector(".studio-home-empty")?.textContent).toBe(
			"Working files. Models, pictures and notes live here.",
		);
		tab("reports");
		expect(view.el.querySelector(".studio-home-empty")?.textContent).toBe("Reports and posts live here.");
		view.dispose();
		store.dispose();

		setLanguagePreference("da");
		const danish = await open({}, { surface: customStudio() });
		expect(danish.tabs()).toEqual(["Overblik", "Rapporter"]);
		expect(danish.view.el.querySelector(".studio-section-head h2")?.textContent).toBe("Filer");
		danish.view.dispose();
		danish.store.dispose();
	});

	it("keeps what the old page drew: documents, an SVG, a page, a JSON file's values and its reports", async () => {
		const { view, tab, store } = await open(
			{
				[`${ROOT}/brief.md`]: "# Notes\nWhat we learned.\n",
				[`${ROOT}/log.txt`]: "Day one: calm.",
				[`${ROOT}/mark.svg`]:
					'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="4" height="4"/></svg>',
				[`${ROOT}/pages/sheet.html`]:
					'<!doctype html><html><head><title>Sheet</title><link rel="stylesheet" href="sheet.css"></head><body>Hi</body></html>',
				[`${ROOT}/pages/sheet.css`]: "body { margin: 0; }",
				[`${ROOT}/data.json`]: JSON.stringify({
					colors: { accent: "#c9643b" },
					typography: { display: "Newsreader, Georgia, serif" },
					font: "Inter, system-ui, sans-serif",
					overview: { weight: "44 g" },
					vendors: [{ vendor: "Nordic Knit", region: "DK" }],
				}),
				[`${ROOT}/why.report.json`]: REPORT,
			},
			{ surface: customStudio() },
		);
		expect(view.el.querySelector('[data-file="surfaces/lamp/brief.md"]')?.textContent).toContain("What we learned.");
		expect(view.el.querySelector('[data-file="surfaces/lamp/log.txt"]')?.textContent).toContain("Day one: calm.");
		expect(view.el.querySelector('.studio-svg-card[data-file="surfaces/lamp/mark.svg"] img')).not.toBeNull();
		const page = view.el.querySelector('.studio-html-card[data-file="surfaces/lamp/pages/sheet.html"]')!;
		expect(page.querySelector("h2")?.textContent).toBe("Sheet");
		expect(page.querySelector("iframe.studio-html-frame")?.getAttribute("sandbox")).toBe("allow-scripts");
		const data = view.el.querySelector('[data-file="surfaces/lamp/data.json"]')!;
		expect(data.querySelector('[data-token="colors.accent"] code')?.textContent).toBe("#c9643b");
		expect(data.querySelector('[data-token="typography.display"] code')?.textContent).toBe("Newsreader");
		expect(data.querySelector('[data-token="font"] .studio-type-meta')?.textContent).toBe("FontInter");
		expect([...data.querySelectorAll(".studio-kv dt")].map((item) => item.textContent)).toEqual([
			"Overview · Weight",
		]);
		expect(data.querySelector(".studio-subhead")?.textContent).toBe("Vendors");
		expect(data.querySelector(".studio-table td")?.textContent).toBe("Nordic Knit");
		expect(view.el.querySelector('[data-file="surfaces/lamp/why.report.json"]')).toBeNull();
		expect(view.el.querySelector('[data-file="surfaces/lamp/pages/sheet.css"]')).toBeNull();
		tab("reports");
		expect(view.el.querySelector(".report-headline")?.textContent).toBe("Why wool");
		view.dispose();
		store.dispose();
	});

	it("marks a JSON file's card when a waiting change touches it, and not once the change is hidden", async () => {
		const { view, store, surface } = await open(
			{ [`${ROOT}/data.json`]: JSON.stringify({ colors: { accent: "#c9643b", paper: "#ffffff" } }) },
			{
				surface: customStudio(),
				ops: [{ op: "merge_json", path: "data.json", patch: { colors: { accent: "#1f5e5b" } } }],
			},
		);
		const card = () => view.el.querySelector('[data-file="surfaces/lamp/data.json"]')!;
		expect(card().classList.contains("is-changed")).toBe(true);
		expect(card().querySelector('[data-token="colors.accent"]')?.classList.contains("is-changed")).toBe(true);
		expect(card().querySelector('[data-token="colors.paper"]')?.classList.contains("is-changed")).toBe(false);
		await store.toggleChange(surface.id, CHANGES[0]);
		view.update();
		expect(card().classList.contains("is-changed")).toBe(false);
		expect(card().querySelector('[data-token="colors.accent"] code')?.textContent).toBe("#c9643b");
		view.dispose();
		store.dispose();
	});
});

const COUNTDOWN_HTML =
	'<!doctype html><html><head><title>Countdown</title><link rel="stylesheet" href="style.css"><script type="module" src="./app.js"></script></head><body><p id="left">12 days</p></body></html>';

function moduleFiles(): Record<string, string> {
	return {
		[`${ROOT}/brief.md`]: "# Notes\nWhat we learned.\n",
		[`${ROOT}/modules/countdown/index.html`]: COUNTDOWN_HTML,
		[`${ROOT}/modules/countdown/style.css`]: "#left { font-size: 40px; }",
		[`${ROOT}/modules/countdown/app.js`]: 'document.getElementById("left").dataset.ready = "yes";',
		[`${ROOT}/modules/countdown/notes.md`]: "# Countdown notes\n",
		[`${ROOT}/modules/price/index.html`]: "<!doctype html><title>Price</title><body>900 kr.</body>",
		[`${ROOT}/layout.json`]: JSON.stringify({
			schema: "qorpera.surface-layout/v1",
			tabs: [
				{
					id: "overview",
					title: "Overview",
					blocks: [
						{ type: "title" },
						{ type: "module", id: "countdown", from: "modules/countdown", heading: "Countdown" },
						{
							type: "row",
							blocks: [
								{ type: "files", heading: "Notes" },
								{ type: "module", from: "modules/price", height: 480 },
							],
						},
					],
				},
				{ id: "app", title: "App", blocks: [{ type: "module", from: "modules/countdown" }] },
				{ id: "later", title: "Later", blocks: [{ type: "module", from: "modules/later", heading: "Later" }] },
			],
		}),
	};
}

function handedHtml(frame: HTMLIFrameElement): string {
	const post = vi.spyOn(frame.contentWindow as Window, "postMessage").mockImplementation(() => {});
	const ready = new MessageEvent("message", { data: { type: PAGE_READY } });
	Object.defineProperty(ready, "source", { value: frame.contentWindow });
	window.dispatchEvent(ready);
	const [message] = post.mock.calls.at(-1) as unknown as [{ type: string; html: string }];
	expect(message.type).toBe(PAGE_CONTENT);
	return message.html;
}

function sayHeight(frame: HTMLIFrameElement, height: unknown, source: Window | null = frame.contentWindow): void {
	const event = new MessageEvent("message", { data: { type: "qorpera-module-height", height } });
	Object.defineProperty(event, "source", { value: source });
	window.dispatchEvent(event);
}

describe("The module block", () => {
	it("draws its folder's app in the page frame, as a section, inside a row and alone on a tab", async () => {
		const { view, tab, tabs, store } = await open(moduleFiles(), { surface: customStudio() });
		expect(tabs()).toEqual(["Overview", "App", "Later"]);
		expect([...view.el.querySelectorAll(".studio-tab.is-empty")].map((item) => item.textContent)).toEqual(["Later"]);
		const countdown = view.el.querySelector<HTMLElement>('[data-block="module"][data-module="modules/countdown"]')!;
		expect(countdown.classList.contains("is-alone")).toBe(false);
		expect(countdown.querySelector("h2")?.textContent).toBe("Countdown");
		const frame = countdown.querySelector<HTMLIFrameElement>("iframe.studio-module-frame")!;
		expect(frame.getAttribute("src")).toBe(PAGE_FRAME_URL);
		expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
		const html = handedHtml(frame);
		expect(html).toContain("12 days");
		expect(html).toContain("#left { font-size: 40px; }");
		expect(html).toContain('<script type="module">document.getElementById("left").dataset.ready = "yes";</script>');
		expect(html).not.toContain('src="./app.js"');
		expect(html).toContain("qorpera-module-height");

		sayHeight(frame, 2400);
		expect(frame.style.height).toBe("1600px");
		sayHeight(frame, 40.2);
		expect(frame.style.height).toBe("120px");
		sayHeight(frame, 512.3);
		expect(frame.style.height).toBe("513px");
		sayHeight(frame, "tall");
		sayHeight(frame, 900, window);
		expect(frame.style.height).toBe("513px");

		const cell = view.el.querySelectorAll(".studio-row-cell")[1]!;
		const price = cell.querySelector<HTMLIFrameElement>('[data-module="modules/price"] iframe.studio-module-frame')!;
		expect(price.style.height).toBe("480px");
		expect(handedHtml(price)).not.toContain("qorpera-module-height");
		const notes = view.el.querySelector(".studio-row-cell")!;
		expect(notes.querySelector('[data-file="surfaces/lamp/brief.md"]')).not.toBeNull();
		expect(view.el.querySelector('[data-file^="surfaces/lamp/modules/"]')).toBeNull();

		tab("app");
		const alone = view.el.querySelector<HTMLElement>('[data-block="module"]')!;
		expect(alone.classList.contains("is-alone")).toBe(true);
		expect(alone.querySelector("h2")).toBeNull();
		expect(handedHtml(alone.querySelector<HTMLIFrameElement>("iframe")!)).not.toContain("qorpera-module-height");

		tab("later");
		const empty = view.el.querySelector<HTMLElement>('[data-block="module"]')!;
		expect(empty.querySelector("iframe")).toBeNull();
		expect(empty.querySelector(".studio-module-frame.is-empty")).not.toBeNull();
		expect(empty.textContent).toBe("Later");
		view.dispose();
		store.dispose();
	});

	it("marks the module a waiting change touched, anywhere in its folder, and nothing once it is hidden", async () => {
		const { view, store, surface } = await open(moduleFiles(), {
			surface: customStudio(),
			ops: [{ op: "write_text", path: "modules/countdown/app.js", content: "window.left = 11;" }],
		});
		const countdown = () => view.el.querySelector<HTMLElement>('[data-module="modules/countdown"]')!;
		expect(countdown().classList.contains("is-changed")).toBe(true);
		expect(countdown().querySelector(".studio-changed-pill")?.textContent).toBe("Updated");
		expect(handedHtml(countdown().querySelector("iframe")!)).toContain("window.left = 11;");
		expect(view.el.querySelector('[data-module="modules/price"]')?.classList.contains("is-changed")).toBe(false);
		await store.toggleChange(surface.id, CHANGES[0]);
		view.update();
		expect(countdown().classList.contains("is-changed")).toBe(false);
		expect(countdown().querySelector(".studio-changed-pill")).toBeNull();
		expect(handedHtml(countdown().querySelector("iframe")!)).toContain('dataset.ready = "yes"');
		view.dispose();
		store.dispose();
	});

	it("fills its empty home once a waiting change writes its index.html", async () => {
		const { view, tab, store } = await open(moduleFiles(), {
			surface: customStudio(),
			ops: [{ op: "write_text", path: "modules/later/index.html", content: "<!doctype html><body>Soon</body>" }],
		});
		tab("later");
		const later = view.el.querySelector<HTMLElement>('[data-block="module"]')!;
		expect(later.classList.contains("is-changed")).toBe(true);
		expect(handedHtml(later.querySelector("iframe")!)).toContain("Soon");
		view.dispose();
		store.dispose();
	});

	it("works on a Product page as its own tab", async () => {
		const { view, tab, tabs, store } = await open({
			...productFiles(),
			[`${ROOT}/modules/configurator/index.html`]: "<!doctype html><title>Pick</title><body>Pick a colour</body>",
			[`${ROOT}/layout.json`]: JSON.stringify({
				schema: "qorpera.surface-layout/v1",
				tabs: [
					{
						id: "overview",
						title: "Overview",
						blocks: [{ type: "stage_3d", id: "stage" }, { type: "title" }],
					},
					{
						id: "configure",
						title: "Configure",
						blocks: [{ type: "module", from: "modules/configurator", height: 600 }],
					},
					{ id: "files", title: "Files", blocks: [{ type: "files" }] },
				],
			}),
		});
		expect(tabs()).toEqual(["Overview", "Configure", "Files"]);
		tab("configure");
		const module = view.el.querySelector<HTMLElement>('[data-block="module"]')!;
		expect(module.classList.contains("is-alone")).toBe(true);
		const frame = module.querySelector<HTMLIFrameElement>("iframe.studio-module-frame")!;
		expect(frame.style.minHeight).toBe("600px");
		expect(handedHtml(frame)).toContain("Pick a colour");
		tab("files");
		expect(view.el.querySelector('[data-file="surfaces/lamp/brief.md"]')).not.toBeNull();
		expect(view.el.querySelector('[data-file="surfaces/lamp/modules/configurator/index.html"]')).toBeNull();
		view.dispose();
		store.dispose();
	});
});
