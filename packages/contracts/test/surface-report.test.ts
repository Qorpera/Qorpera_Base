import { describe, expect, it } from "vitest";
import { parseSurfaceReportEvidence, SURFACE_REPORT_FORMAT, SURFACE_REPORT_RESEARCH_KEYS } from "../src/index.ts";

const NOW = new Date("2026-11-28T09:00:00Z");

const OLD_POST = {
	category: "Analysis",
	headline: "Where 299 kr goes",
	subtitle: "One candle, from wax to VAT.",
	author: "Strategy",
	date: "2026-11-20",
	readingTime: "3 min",
	keyMetrics: [{ label: "Left after costs", value: "74 kr" }],
	sections: [
		{
			id: "costs",
			heading: "What one candle costs",
			paragraphs: ["Wax and wick come to 41 kr. Shipping [2024 prices] adds 39 kr."],
			blocks: [{ kind: "bar_chart", heading: "Costs", items: [{ label: "Wax", value: 41 }] }],
		},
	],
};

const SOURCES = [
	{
		n: 1,
		title: "White label",
		publisher: "Northband",
		url: "https://northband.example/white-label/",
		opened: "2026-11-27",
		backs: "Built under another brand from 50 units, with up to three months of production. Price on request.",
		kind: "Maker's own page",
		checked: "2026-11-28",
	},
	{
		n: 2,
		title: "Headband in its own store",
		publisher: "Northband",
		url: "https://store.northband.example/products/headband",
		opened: "2026-11-27",
		backs: "USD 449.65 on sale. Sensors at O1, O2, T3 and T4.",
		kind: "Maker's own page",
		checked: "2026-11-28",
	},
	{
		n: 4,
		title: "Reference rates of 26 Nov 2026",
		publisher: "European Central Bank",
		url: "https://rates.example/latest?from=USD&to=DKK",
		opened: "2026-11-27",
		backs: "One dollar is 6.8097 kr.",
		checked: "2026-11-27",
	},
];

const RESEARCH_POST = {
	category: "Research",
	headline: "Nothing on sale does what our band must",
	subtitle: "We checked 30 devices a two-person company can order today. Three come close.",
	author: "Strategy",
	date: "2026-11-28",
	readingTime: "5 min",
	question: "Can we buy the electronics for the band today instead of building them?",
	theme: "Hardware",
	cover: { src: "research/covers/sensor-places.svg", alt: "A head from above with four sensor places marked" },
	shortAnswer: [
		"Nothing on sale matches both our sensor places and a live contact check.",
		"One maker offers to build under our name, from 50 units, and its price is on request. [1]",
		"A single unit costs 3,062 kr today, more than the 2,396 kr one sale leaves. [2, 4]",
	],
	changes: [
		{ page: "Money", line: "Electronics for one band", now: "Not quoted yet, until a maker answers. [1]" },
		{ page: "Plan", line: "Step 1", now: "Buys one test unit to try the app on real hardware." },
	],
	sources: SOURCES,
	method: [
		"One research run on 27 Nov 2026. Every price was read that day on the page named in the sources and kept in the currency shown.",
		"A maker's own page counts as firm. A reseller's page is marked as a reseller.",
	],
	notFound: [
		{
			what: "What the maker charges for 50 units under our name",
			note: "On request only. A written quote closes it.",
		},
		{ what: "A contact check while recording, on any four-sensor device" },
	],
	related: ["research/our-name-makes-us-the-maker.report.json", "/product/sleeve-prices.report.json"],
	sections: [
		{
			id: "close",
			heading: "Three that come close",
			paragraphs: [
				"The maker's headband reads at the back of the head and above the ears, not on the forehead. [2]",
				"Its offer starts at 50 units with up to three months of production. [1]",
			],
			blocks: [
				{
					kind: "table",
					heading: "One unit today",
					caption: "Prices as each page showed them, in kroner at the rate of 26 Nov 2026. [4]",
					columns: ["Device", "Price"],
					rows: [["Headband", "3,062 kr"]],
				},
			],
		},
	],
};

const post = (changes: Record<string, unknown>) => ({ ...RESEARCH_POST, ...changes });
const withSource = (index: number, changes: Record<string, unknown>) =>
	post({ sources: SOURCES.map((source, at) => (at === index ? { ...source, ...changes } : source)) });
const read = (value: Record<string, unknown>) => () =>
	parseSurfaceReportEvidence(value, { path: "research/nothing-on-sale.report.json", now: NOW });

describe("the evidence a report file can carry", () => {
	it("reads a post that uses every part, and a post from before the parts as one with none", () => {
		expect(read(RESEARCH_POST)()).toEqual({
			question: RESEARCH_POST.question,
			theme: "Hardware",
			cover: RESEARCH_POST.cover,
			shortAnswer: RESEARCH_POST.shortAnswer,
			changes: RESEARCH_POST.changes,
			sources: SOURCES,
			method: RESEARCH_POST.method,
			notFound: RESEARCH_POST.notFound,
			related: RESEARCH_POST.related,
		});
		expect(read(OLD_POST)()).toEqual({});
		expect(read({ ...OLD_POST, theme: " Money ", related: [] })()).toEqual({ theme: "Money", related: [] });
	});

	it("names every part it reads in the format agents are given", () => {
		for (const key of Object.keys(read(RESEARCH_POST)())) expect(SURFACE_REPORT_FORMAT, key).toContain(`"${key}"`);
		for (const key of Object.keys(SOURCES[0] as object)) expect(SURFACE_REPORT_FORMAT, key).toContain(`"${key}"`);
		for (const key of SURFACE_REPORT_RESEARCH_KEYS) expect(RESEARCH_POST, key).toHaveProperty(key);
		expect(SURFACE_REPORT_FORMAT).toContain('A report file (*.report.json) is {"category"');
	});

	it("holds a research post to one question and to the parts that answer it", () => {
		expect(read(post({ question: "What does it cost? And who sells it?" }))).toThrow(
			"question must be one question, ending in its only ?",
		);
		expect(read(post({ question: "What it costs" }))).toThrow("question must be one question");
		for (const key of ["theme", "shortAnswer", "sources", "method", "notFound"])
			expect(read(post({ [key]: undefined })), key).toThrow(
				`${key} is missing: a post that names its "question" is a research post and needs it`,
			);
		expect(
			read(post({ sources: [], notFound: [], shortAnswer: ["Nothing was found."], changes: [], sections: [] })),
		).toThrow("sources is empty and so is notFound");
		expect(
			read(post({ sources: [], shortAnswer: ["Nobody publishes a price."], changes: [], sections: [] })),
		).not.toThrow();
		expect(read(post({ shortAnswer: [] }))).toThrow("shortAnswer must not be empty");
		expect(read(post({ shortAnswer: ["a", "b", "c", "d", "e", "f"] }))).toThrow(
			"shortAnswer has more than 5 entries",
		);
		expect(read(post({ shortAnswer: ["x".repeat(241)] }))).toThrow("shortAnswer[0] is longer than 240 chars");
		expect(read(post({ shortAnswer: ["One.\nTwo."] }))).toThrow("shortAnswer[0] must be one line");
		expect(read(post({ method: [] }))).toThrow("method must not be empty");
		expect(read(post({ method: "By reading." }))).toThrow("method must be an array");
		expect(read(post({ notFound: [{ note: "Nowhere." }] }))).toThrow("notFound[0].what must be a non-empty string");
		expect(read(post({ changes: [{ page: "Money", now: "Open." }] }))).toThrow(
			"changes[0].line must be a non-empty string",
		);
		expect(read(post({ theme: "x".repeat(61) }))).toThrow("theme is longer than 60 chars");
	});

	it("refuses a source a second reader has not opened again", () => {
		expect(read(withSource(1, { checked: undefined }))).toThrow(
			'sources[1] has no "checked" day: a second reader opens every source again before a post is staged, and only their result sets it (read_skill research-check)',
		);
		expect(read(withSource(0, { checked: "2026-11-26" }))).toThrow(
			"sources[0].checked is before the day the source was opened",
		);
		expect(read(withSource(0, { checked: "2026-11-30" }))).toThrow(
			"sources[0].checked is a day that has not come yet",
		);
		expect(read(withSource(0, { checked: "2026-11-29" }))).not.toThrow();
		expect(read(withSource(0, { checked: "28 Nov 2026" }))).toThrow(
			"sources[0].checked must be a day written YYYY-MM-DD",
		);
		expect(read(withSource(0, { opened: "2026-02-30" }))).toThrow("sources[0].opened is not a real day");
	});

	it("holds every source to a number of its own, a link and the line it backs", () => {
		expect(read(withSource(1, { n: 1 }))).toThrow("sources[1].n repeats 1; every source has its own number");
		expect(read(withSource(1, { n: 0 }))).toThrow("sources[1].n must be a whole number from 1 to 999");
		expect(read(withSource(1, { n: "2" }))).toThrow("sources[1].n must be a whole number from 1 to 999");
		for (const url of [
			"northband.example/white-label",
			"ftp://northband.example/a",
			"https://localhost/a",
			"https://a b.example/",
		])
			expect(read(withSource(0, { url })), url).toThrow(
				"sources[0].url must be the http or https link the source was opened at",
			);
		for (const key of ["title", "publisher", "backs"])
			expect(read(withSource(2, { [key]: " " })), key).toThrow(`sources[2].${key} must be a non-empty string`);
		expect(read(withSource(2, { kind: "" }))).toThrow("sources[2].kind must be a non-empty string");
		expect(read(post({ sources: {} }))).toThrow("sources must be an array");
	});

	it("refuses a source mark that names no source, wherever it stands", () => {
		expect(read(post({ shortAnswer: ["One maker builds under our name. [3]"] }))).toThrow(
			"shortAnswer[0] marks source [3], which is not in sources",
		);
		expect(read(post({ shortAnswer: ["A unit costs 3,062 kr. [2, 9]"] }))).toThrow(
			"shortAnswer[0] marks source [9], which is not in sources",
		);
		expect(read(post({ sections: [{ id: "a", heading: "A", paragraphs: ["Fine. [1]", "Not fine. [7]"] }] }))).toThrow(
			"sections[0].paragraphs[1] marks source [7], which is not in sources",
		);
		expect(
			read(
				post({
					sections: [{ id: "a", heading: "A", blocks: [{ kind: "quote", text: "Price on request. [5]" }] }],
				}),
			),
		).toThrow("sections[0].blocks[0].text marks source [5], which is not in sources");
		expect(read(post({ method: ["Read on one day. [8]"] }))).toThrow("method[0] marks source [8]");
		expect(
			read(post({ sections: [{ id: "a", heading: "A", paragraphs: ["In [2024] it rose, see [1]."] }] })),
		).not.toThrow();
	});

	it("holds a cover to a picture in the folder and related posts to other posts", () => {
		expect(read(post({ cover: { src: "covers/a.png", alt: "A head" } }))).not.toThrow();
		expect(read(post({ cover: { src: "covers/a.json", alt: "A head" } }))).toThrow(
			"cover.src must be a picture file (png, jpg, webp, gif, avif or svg)",
		);
		expect(read(post({ cover: { src: "../a.png", alt: "A head" } }))).toThrow("cover.src may not use . or ..");
		expect(read(post({ cover: { src: "covers/a.png" } }))).toThrow("cover.alt must be a non-empty string");
		expect(read(post({ cover: "covers/a.png" }))).toThrow('cover must be {"src","alt"}');
		expect(read(post({ related: ["research/Nothing-on-sale.report.json"] }))).toThrow(
			"related[0] is this post itself",
		);
		expect(read(post({ related: ["a.report.json", "/a.report.json"] }))).toThrow(
			"related[1] repeats a post already listed",
		);
		expect(read(post({ related: ["notes/a.md"] }))).toThrow("related[0] must be the path of another *.report.json");
		expect(read(post({ related: Array.from({ length: 9 }, (_, at) => `p${at}.report.json`) }))).toThrow(
			"related has more than 8 entries",
		);
	});
});
