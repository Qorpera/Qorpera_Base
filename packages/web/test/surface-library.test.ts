// @vitest-environment jsdom
import { type StudioPatchOp, SURFACE_LAYOUT_SCHEMA, type SurfaceSummary } from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SurfaceStudioView } from "../src/app/views/surface-studio-view.ts";
import { setLanguagePreference } from "../src/ui/preferences.ts";
import { CHANGES, change, fakeClient, session, storeWith, summary, workspace } from "./surface-fixtures.ts";

const ROOT = "surfaces/strategy";
const HW_PATH = `${ROOT}/research/2-nothing-on-sale.report.json`;
const MAKER_PATH = `${ROOT}/research/4-maker.report.json`;
const PREPAY_PATH = `${ROOT}/research/3-prepay.report.json`;
const OLD_PATH = `${ROOT}/plan/where-299-kr-goes.report.json`;
const COVER =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 680 400"><rect width="680" height="400" fill="#F2EDFD"/></svg>';
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 26 26"><circle cx="13" cy="13" r="9"/></svg>';

afterEach(() => {
	setLanguagePreference("en");
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

function source(n: number, publisher: string, title: string, backs: string) {
	return {
		n,
		title,
		publisher,
		url: `https://example.com/source-${n}`,
		opened: "2026-01-10",
		backs,
		kind: "Maker's own page",
		checked: "2026-01-12",
	};
}

const HARDWARE = {
	category: "Research",
	headline: "Nothing on sale does what our band must",
	subtitle: "We checked 30 devices. Three come close.",
	author: "Strategy",
	date: "2026-01-10",
	readingTime: "5 min",
	question: "Can we buy the electronics for the band today?",
	theme: "Hardware",
	cover: { src: "research/covers/nothing-on-sale.svg", alt: "A head from above" },
	shortAnswer: ["Nothing on sale matches both needs. [1]", "One maker builds under our name, from 50 units. [1, 2]"],
	changes: [{ page: "Money", line: "Electronics for one band", now: "Stays open until a maker answers." }],
	sources: [
		source(1, "BrainBit", "White label", "Built under another brand from 50 units."),
		source(2, "g.tec", "Core-4 product page", "EUR 390 before VAT."),
	],
	method: ["One research run. Every price was read on the maker's own page. [2]"],
	notFound: [{ what: "What a maker charges for 50 units", note: "A written quote closes it." }],
	related: ["research/4-maker.report.json", "research/gone.report.json"],
	sections: [
		{
			id: "needs",
			heading: "What the band needs",
			paragraphs: ["Four dry sensors, two on the forehead. [1]", "A raw signal at 250 readings a second."],
			blocks: [
				{
					kind: "table",
					heading: "Where the sensors sit",
					caption: "Places as each maker states them. [2]",
					columns: ["Device", "Places"],
					rows: [["Core-4", "Top-back"]],
				},
			],
		},
	],
};

const MAKER = {
	headline: "Our name on the device makes us its maker",
	subtitle: "EU rules treat whoever brands a radio device as its manufacturer.",
	date: "2026-01-12",
	readingTime: "1 min",
	question: "Does our name on the device make us its maker?",
	theme: "hardware",
	shortAnswer: ["Our name on the device makes us its legal maker. [1]"],
	sources: [source(1, "EUR-Lex", "Radio Equipment Directive", "Sold under its own name.")],
	method: ["Read in the consolidated text."],
	notFound: [{ what: "What a maker charges for 50 units" }, { what: "The cost of the cybersecurity check" }],
	sections: [],
};

const PREPAY = {
	headline: "A Danish web shop may not take the money before it ships",
	subtitle: "Payment is drawn when the goods are handed to the carrier.",
	date: "2026-01-11",
	question: "May we be paid before it ships?",
	theme: "Selling",
	shortAnswer: ["A Danish web shop may not draw the money before the goods are sent. [1]"],
	sources: [source(1, "Forbrugerombudsmanden", "Prepayments", "Goods are handed over before money is drawn.")],
	method: ["Read on the regulator's own page."],
	notFound: [],
	sections: [],
};

const OLD = {
	category: "Deep dive",
	headline: "Where 299 kr goes",
	subtitle: "One candle, from the shelf price to what is left.",
	author: "Strategy",
	date: "2026-01-05",
	readingTime: "3 min",
	keyMetrics: [{ label: "Left", value: "112 kr", delta: "37%" }],
	sections: [
		{
			id: "split",
			kicker: "The split",
			heading: "Four places the money goes",
			paragraphs: ["A quarter is VAT. Step [1] of the split."],
			blocks: [{ kind: "callout", tone: "decision", heading: "Sell in pairs", body: "A pair leaves more." }],
		},
	],
};

const LIBRARY = {
	line: "What we have found out about building the band, and what we still have to.",
	themes: [
		{
			name: "Hardware",
			question: "What can the band be built on?",
			lead: "looks at what can be ordered today.",
			icon: "research/icons/hardware.svg",
			open: [{ what: "Whether Muse grants a licence to sell", note: "An application closes it." }],
		},
		{ name: "Selling", question: "How may we be paid before it ships?" },
		{ name: "Hair", question: "Does it read through hair?" },
	],
	featured: ["research/4-maker.report.json", "research/2-nothing-on-sale.report.json"],
};

function researchFiles(): Record<string, string> {
	return {
		[`${ROOT}/research.json`]: JSON.stringify(LIBRARY),
		[`${ROOT}/research/icons/hardware.svg`]: ICON,
		[`${ROOT}/research/covers/nothing-on-sale.svg`]: COVER,
		[HW_PATH]: JSON.stringify(HARDWARE),
		[MAKER_PATH]: JSON.stringify(MAKER),
		[PREPAY_PATH]: JSON.stringify(PREPAY),
		[OLD_PATH]: JSON.stringify(OLD),
	};
}

function strategy(overrides: Partial<SurfaceSummary> = {}): SurfaceSummary {
	return summary({
		id: "22222222-2222-4222-8222-222222222250",
		slug: "strategy",
		title: "Strategy",
		archetype: "studio",
		kind: "strategy",
		icon: "figure:lighthouse",
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
	options: { readonly ops?: readonly StudioPatchOp[]; readonly surface?: SurfaceSummary; readonly tab?: string } = {},
) {
	const surface = options.surface ?? strategy();
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
	const view = new SurfaceStudioView({
		store,
		surface,
		signal: new AbortController().signal,
		baseFiles,
		timeSlice: false,
	});
	document.body.append(view.el);
	const find = <E extends HTMLElement = HTMLElement>(selector: string) => view.el.querySelector<E>(selector);
	const all = (selector: string) => [...view.el.querySelectorAll<HTMLElement>(selector)];
	const texts = (selector: string) =>
		all(selector).map((item) => (item.textContent ?? "").replace(/\s+/g, " ").trim());
	const press = (selector: string) => {
		const target = find(selector);
		if (!target) throw new Error(`nothing matches ${selector}`);
		target.click();
	};
	const tab = (id: string) => press(`[data-act="studio-tab"][data-tab="${id}"]`);
	const done = () => {
		view.dispose();
		store.dispose();
	};
	if (options.tab !== "") tab(options.tab ?? "research");
	return { store, surface, view, find, all, texts, press, tab, done };
}

const card = (path: string) => `.lib-card[data-path="${path}"]`;

describe("The Research tab's library", () => {
	it("is the Strategy starter's last tab and draws an empty home before any post exists", async () => {
		const empty = await open({});
		expect(empty.texts(".studio-tab")).toEqual([
			"Grand plan",
			"Economics",
			"Market",
			"Hypotheses",
			"Breakdowns",
			"Research",
		]);
		expect(empty.find(".studio-tab.is-on")?.classList.contains("is-empty")).toBe(true);
		expect(empty.texts(".lib > *")).toEqual(["Research", "Research posts live here."]);
		empty.done();

		setLanguagePreference("da");
		const danish = await open({});
		expect(danish.texts(".lib > *")).toEqual(["Research", "Research-indlæg ligger her."]);
		danish.done();
	});

	it("draws the front: the line, the count, themes with their posts, the featured posts and every post newest first", async () => {
		const { texts, find, all, press, done } = await open(researchFiles());
		expect(find(".lib")?.dataset.at).toBe("front");
		expect(texts(".lib-state")).toEqual([LIBRARY.line]);
		expect(texts(".lib-count")).toEqual(["4 posts · 4 sources · 2 of 3 themes answered"]);
		expect(
			all(".lib-theme").map((theme) => [
				theme.querySelector(".lib-theme-name")?.textContent,
				theme.querySelector(".lib-theme-n")?.textContent,
				theme.querySelector(".lib-theme-q")?.textContent,
				theme.classList.contains("is-empty"),
				theme.querySelector(".lib-theme-icon") !== null,
			]),
		).toEqual([
			["Hardware", "2 posts", "What can the band be built on?", false, true],
			["Selling", "1 post", "How may we be paid before it ships?", false, false],
			["Hair", "No post yet", "Does it read through hair?", true, false],
		]);

		expect(texts(".lib-feat h3")).toEqual([MAKER.headline]);
		expect(texts(".lib-feat-nav span")).toEqual(["01 / 02"]);
		expect(find(".lib-feat-art .lib-cover-none")?.textContent).toBe("004");
		press('[data-act="library-featured"][data-step="1"]');
		expect(texts(".lib-feat h3")).toEqual([HARDWARE.headline]);
		expect(texts(".lib-feat-meta span")).toEqual(["Hardware", "Jan 10, 2026"]);
		expect(find<HTMLImageElement>(".lib-feat-art img")?.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
		press('[data-act="library-featured"][data-step="1"]');
		expect(texts(".lib-feat h3")).toEqual([MAKER.headline]);

		expect(texts(".lib-gridhead")).toEqual(["4 postsNewest first"]);
		expect(texts(".lib-card-meta")).toEqual([
			"004Jan 12, 2026 · Hardware",
			"003Jan 11, 2026 · Selling",
			"002Jan 10, 2026 · Hardware",
			"001Jan 5, 2026 · Deep dive",
		]);
		expect(texts(".lib-card-title")).toEqual([MAKER.headline, PREPAY.headline, HARDWARE.headline, OLD.headline]);
		expect(find(`${card(HW_PATH)} .lib-card-art img`)?.getAttribute("alt")).toBe("A head from above");
		expect(find(`${card(OLD_PATH)} .lib-card-art .lib-cover-none`)?.textContent).toBe("001");
		expect(texts(`${card(HW_PATH)} .lib-card-src`)).toEqual(["2 sources · Maker's own page"]);
		expect(find(`${card(OLD_PATH)} .lib-card-src`)).toBeNull();
		done();
	});

	it("shows themes from the posts alone when no library file names them, and themes alone before any post", async () => {
		const files = researchFiles();
		delete files[`${ROOT}/research.json`];
		const derived = await open(files);
		expect(derived.find(".lib-state")).toBeNull();
		expect(derived.texts(".lib-count")).toEqual(["4 posts · 4 sources · 2 of 2 themes answered"]);
		expect(derived.texts(".lib-theme-name")).toEqual(["Hardware", "Selling"]);
		expect(derived.texts(".lib-feat h3")).toEqual([MAKER.headline]);
		expect(derived.find(".lib-feat-nav")).toBeNull();
		derived.done();

		const named = await open({ [`${ROOT}/research.json`]: JSON.stringify(LIBRARY) });
		expect(named.find(".studio-tab.is-on")?.classList.contains("is-empty")).toBe(true);
		expect(named.texts(".lib-count")).toEqual(["0 posts · 0 of 3 themes answered"]);
		expect(named.all(".lib-theme.is-empty")).toHaveLength(3);
		expect(named.find(".lib-feat")).toBeNull();
		expect(named.find(".lib-grid")).toBeNull();
		named.done();
	});

	it("opens a theme: what is known leads to its post, beside what is still open and what would close it", async () => {
		const { texts, find, press, store, done } = await open(researchFiles());
		press('.lib-theme[data-theme="hardware"]');
		expect(find(".lib")?.dataset.at).toBe("theme");
		expect(texts(".lib-th-state")).toEqual(["Hardware looks at what can be ordered today."]);
		expect(find(".lib-th-state .lib-theme-icon")).not.toBeNull();
		expect(texts(".lib-th-colhead")).toEqual(["What we know so far", "Still open"]);
		expect(texts(".lib-th-claim strong")).toEqual([
			"Our name on the device makes us its legal maker.",
			"Nothing on sale matches both needs.",
			"One maker builds under our name, from 50 units.",
		]);
		expect(texts(".lib-th-claim span")[1]).toBe("Post 002 · 2 sources · Maker's own page · checked Jan 12, 2026");
		expect(texts(".lib-th-q")).toEqual([
			"Whether Muse grants a licence to sell" + "An application closes it.",
			"What a maker charges for 50 units" + "A written quote closes it.",
			"The cost of the cybersecurity check",
		]);
		expect(texts(".lib-card-title")).toEqual([MAKER.headline, HARDWARE.headline]);

		press(".lib-th-claim:nth-child(2)");
		expect(texts(".po-title")).toEqual([HARDWARE.headline]);
		expect(store.state.activeReportSlug).toBe("2-nothing-on-sale");
		press(".lib-back");
		expect(find(".lib")?.dataset.at).toBe("theme");
		expect(store.state.activeReportSlug).toBeUndefined();
		press(".lib-back");
		expect(find(".lib")?.dataset.at).toBe("front");

		press('.lib-theme[data-theme="hair"]');
		expect(texts(".lib-th-empty")).toEqual(["No post yet" + "Does it read through hair?"]);
		expect(find(".lib-th-cols")).toBeNull();
		expect(find(".lib-grid")).toBeNull();
		done();
	});

	it("opens a post: the short answer first, marks that open their source, then the evidence, with a rail", async () => {
		const { texts, find, all, press, done } = await open(researchFiles());
		press(card(HW_PATH));
		expect(find(".lib")?.dataset.at).toBe("post");
		expect(texts(".lib-back")).toEqual(["← Hardware"]);
		expect(texts(".po-kick > *")).toEqual(["Hardware", "Post 002", "Jan 10, 2026", "5 min"]);
		expect(texts(".po-dek")).toEqual([HARDWARE.subtitle]);
		expect(all("[data-post-section]").map((part) => part.dataset.postSection)).toEqual([
			"short",
			"s-0",
			"changes",
			"method",
			"missing",
			"sources",
		]);
		expect(texts(".po-sec > h2")).toEqual([
			"The short answer",
			"What the band needs",
			"What this changes for us",
			"How we found this",
			"What we could not find",
			"Sources",
		]);
		expect(texts(".po-toc button")).toEqual([
			"01The short answer",
			"02What the band needs",
			"03What this changes for us",
			"04How we found this",
			"05What we could not find",
			"06Sources",
		]);
		expect(texts(".po-short li")).toEqual([
			"Nothing on sale matches both needs.1",
			"One maker builds under our name, from 50 units.12",
		]);
		expect(texts('[data-post-section="s-0"] .po-prose p')).toEqual([
			"Four dry sensors, two on the forehead.1",
			"A raw signal at 250 readings a second.",
		]);
		expect(find(".po-fig .po-tray .report-table")).not.toBeNull();
		expect(texts(".po-fig > figcaption")).toEqual(["Places as each maker states them.2"]);
		expect(texts(".po-change div")).toEqual(["Money" + "Stays open until a maker answers."]);
		expect(texts(".po-miss li")).toEqual(["What a maker charges for 50 units" + "A written quote closes it."]);
		expect(texts(".po-srcs li")[0]).toBe(
			"1BrainBit. White label. Maker's own page, opened Jan 10, 2026.https://example.com/source-1",
		);
		expect(find(".po-srcs .po-src")).toBeNull();
		expect(texts(".po-meta div")).toEqual([
			"Published" + "Jan 10, 2026",
			"Theme" + "Hardware",
			"Sources" + "2",
			"Rests on" + "Maker's own page",
			"Checked" + "Jan 12, 2026",
		]);

		const mark = find('.po-short .po-src[data-src="2"]')!;
		mark.click();
		expect(mark.classList.contains("is-on")).toBe(true);
		expect(texts(".po-srcpop > *")).toEqual([
			"Source 2 · Maker's own page",
			"g.tec · Core-4 product page",
			"EUR 390 before VAT.",
			"Opened Jan 10, 2026",
			"https://example.com/source-2",
		]);
		expect(find<HTMLAnchorElement>(".po-srcpop a")?.getAttribute("rel")).toBe("noopener noreferrer");
		press('.po-prose .po-src[data-src="1"]');
		expect(all(".po-srcpop")).toHaveLength(1);
		expect(texts(".po-srcpop b")).toEqual(["BrainBit · White label"]);
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		expect(find(".po-srcpop")).toBeNull();
		expect(find(".po-src.is-on")).toBeNull();
		mark.click();
		document.body.click();
		expect(find(".po-srcpop")).toBeNull();

		expect(texts(".po-rel-card")).toEqual([`Hardware · 004${MAKER.headline}`]);
		press(".po-rel-card");
		expect(texts(".po-title")).toEqual([MAKER.headline]);
		expect(find(".po-rel")).toBeNull();
		press(".po-kick-theme");
		expect(find(".lib")?.dataset.at).toBe("theme");
		done();
	});

	it("still opens a post in the old format, with its figures and body and none of the evidence parts", async () => {
		const { texts, find, press, done } = await open(researchFiles());
		press(card(OLD_PATH));
		expect(texts(".lib-back")).toEqual(["← Research"]);
		expect(texts(".po-kick > *")).toEqual(["Deep dive", "Post 001", "Jan 5, 2026", "3 min"]);
		expect(find("button.po-kick-theme")).toBeNull();
		expect(texts(".po-title")).toEqual([OLD.headline]);
		expect(texts(".report-metric")).toEqual(["Left112 kr37%"]);
		expect(texts(".po-sec > h2")).toEqual(["Four places the money goes"]);
		expect(texts(".po-sec > .report-kicker")).toEqual(["The split"]);
		expect(texts(".po-prose p")).toEqual(["A quarter is VAT. Step [1] of the split."]);
		expect(find(".po-sec .report-callout")).not.toBeNull();
		expect(find(".po-src")).toBeNull();
		expect(find(".po-tocwrap")).toBeNull();
		expect(texts(".po-meta div")).toEqual(["Published" + "Jan 5, 2026", "Written by" + "Strategy"]);
		press(".lib-back");
		expect(find(".lib")?.dataset.at).toBe("front");
		done();
	});

	it("marks the post a waiting change touched and the parts it changed, and nothing once it is hidden", async () => {
		const next = {
			...HARDWARE,
			shortAnswer: [...HARDWARE.shortAnswer, "Seven of eight devices cost more than one sale leaves. [2]"],
			sections: [{ ...HARDWARE.sections[0], paragraphs: ["Four dry sensors. [1]"] }],
		};
		const { texts, find, press, store, surface, view, done } = await open(researchFiles(), {
			ops: [{ op: "write_text", path: "research/2-nothing-on-sale.report.json", content: JSON.stringify(next) }],
		});
		expect(texts(".lib-card .studio-changed-pill")).toEqual(["Updated"]);
		expect(find(`${card(HW_PATH)} .studio-changed-pill`)).not.toBeNull();
		press(card(HW_PATH));
		expect(texts(".po-kick .studio-changed-pill")).toEqual(["Updated"]);
		expect(texts(".po-sec.is-changed > h2")).toEqual([
			"The short answer" + "Updated",
			"What the band needs" + "Updated",
		]);
		expect(texts(".po-short li")).toHaveLength(3);

		await store.toggleChange(surface.id, CHANGES[0]);
		view.update();
		expect(find(".lib")?.dataset.at).toBe("post");
		expect(find(".studio-changed-pill")).toBeNull();
		expect(texts(".po-short li")).toHaveLength(2);
		done();
	});

	it("claims its files, takes a heading from its own layout, and lands on a post opened from a change", async () => {
		const layout = {
			schema: SURFACE_LAYOUT_SCHEMA,
			tabs: [
				{ id: "overview", title: "Overview", blocks: [{ type: "artifacts", heading: "Artifacts" }] },
				{ id: "findings", title: "Findings", blocks: [{ type: "library", heading: "What we know" }] },
			],
		};
		const files = {
			...researchFiles(),
			[`${ROOT}/layout.json`]: JSON.stringify(layout),
			[`${ROOT}/notes.md`]: "# Notes\n",
		};
		const { texts, find, all, store, surface, view, done } = await open(files, { tab: "" });
		expect(all("[data-file]").map((item) => item.dataset.file)).toEqual([`${ROOT}/notes.md`]);

		await store.openChangeDeliverable(surface.id, CHANGES[0], "3-prepay", PREPAY_PATH);
		await vi.waitFor(() =>
			expect(view.el.querySelector<HTMLElement>(".studio-tab.is-on")?.dataset.tab).toBe("findings"),
		);
		await vi.waitFor(() => expect(find(".lib")?.dataset.at).toBe("post"));
		expect(texts(".po-title")).toEqual([PREPAY.headline]);
		expect(texts(".lib-back")).toEqual(["← Selling"]);
		find<HTMLButtonElement>(".lib-back")!.click();
		find<HTMLButtonElement>(".lib-back")!.click();
		expect(texts(".lib-kicker")).toEqual(["What we know"]);
		done();
	});
	it("lands on the post a change names by its path, also when two posts share a file name", async () => {
		const planPath = `${ROOT}/plan/summary.report.json`;
		const marketPath = `${ROOT}/market/summary.report.json`;
		const { texts, find, store, surface, view, done } = await open(
			{
				[planPath]: JSON.stringify({ headline: "Plan summary", date: "2026-01-02", sections: [] }),
				[marketPath]: JSON.stringify({ headline: "Market summary", date: "2026-01-03", sections: [] }),
			},
			{ tab: "" },
		);
		const onTab = () => view.el.querySelector<HTMLElement>(".studio-tab.is-on")?.dataset.tab;
		expect(onTab()).toBe("plan");

		await store.openChangeDeliverable(surface.id, CHANGES[0], "summary", planPath);
		await vi.waitFor(() => expect(onTab()).toBe("research"));
		expect(texts(".po-title")).toEqual(["Plan summary"]);
		view.update();
		expect(texts(".po-title")).toEqual(["Plan summary"]);

		await store.openChangeDeliverable(surface.id, CHANGES[0], "summary", marketPath);
		await vi.waitFor(() => expect(texts(".po-title")).toEqual(["Market summary"]));
		find<HTMLButtonElement>(".lib-back")!.click();
		expect(texts(".lib-card-title")).toEqual(["Market summary", "Plan summary"]);
		done();
	});
});

describe("A research post in a report block", () => {
	it("is drawn as the post page, while a post in the old format keeps the look it had", async () => {
		const custom = strategy({
			id: "22222222-2222-4222-8222-222222222251",
			slug: "notes",
			title: "Notes",
			kind: "custom",
			icon: "star",
		});
		const { texts, find, all, press, done } = await open(
			{ [HW_PATH]: JSON.stringify(HARDWARE), [MAKER_PATH]: JSON.stringify(MAKER), [OLD_PATH]: JSON.stringify(OLD) },
			{ surface: custom, tab: "reports" },
		);
		expect(texts(".report-switch-pill")).toEqual([OLD.headline, HARDWARE.headline, MAKER.headline]);
		expect(texts(".report-headline")).toEqual([OLD.headline]);
		expect(find(".po-page")).toBeNull();

		press('.report-switch-pill[data-slug="2-nothing-on-sale"]');
		expect(find(".report-headline")).toBeNull();
		expect(texts(".po-title")).toEqual([HARDWARE.headline]);
		expect(texts(".po-kick > *")).toEqual(["Hardware", "Jan 10, 2026", "5 min"]);
		expect(find(".lib-back")).toBeNull();
		expect(all("[data-post-section]").map((part) => part.dataset.postSection)).toEqual([
			"short",
			"s-0",
			"changes",
			"method",
			"missing",
			"sources",
		]);
		press('.po-short .po-src[data-src="1"]');
		expect(texts(".po-srcpop b")).toEqual(["BrainBit · White label"]);
		press(".po-rel-card");
		expect(find(".po-srcpop")).toBeNull();
		expect(texts(".po-title")).toEqual([MAKER.headline]);
		expect(find('.report-switch-pill[data-slug="4-maker"]')?.getAttribute("aria-selected")).toBe("true");
		done();
	});
});
