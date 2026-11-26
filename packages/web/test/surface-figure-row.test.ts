// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { decorateSurfaceFigures } from "../src/app/views/surface-figure-row.ts";
import { markdown, markdownBubbles } from "../src/ui/markdown.ts";
import { fakeClient, storeWith, summary } from "./surface-fixtures.ts";

const WEBSITE = "e2200000-0000-4000-8000-000000000001";
const STRATEGY = "e2200000-0000-4000-8000-000000000002";

describe("Interface figures in messages", () => {
	it("shows each figure in its interface's look, working while an agent works on it", async () => {
		let surfaces = [
			summary({ id: WEBSITE, slug: "website", title: "Website", runningSessionCount: 0 }),
			summary({
				id: STRATEGY,
				slug: "strategy",
				title: "Strategy",
				archetype: "studio",
				icon: "figure:lighthouse",
				runningSessionCount: 1,
			}),
		];
		const store = storeWith(fakeClient({ listSurfaces: vi.fn(async () => surfaces) }));
		await store.load();
		const prose = markdown(
			"[Our site](surface:website) [Economics](surface:strategy#economics) [Gone](surface:gone)",
		);
		decorateSurfaceFigures(prose, store);
		const figure = (slug: string) =>
			prose.querySelector<HTMLElement>(`.surface-card.is-figure[data-surface-slug="${slug}"]`)!;
		const state = (slug: string) =>
			figure(slug)
				.querySelector(".surface-figure")
				?.className.match(/is-(rest|working)/)?.[1];
		const title = (slug: string) => figure(slug).querySelector(".app-card-title")?.textContent;

		expect(state("website")).toBe("rest");
		expect(title("website")).toBe("Website");
		expect(state("strategy")).toBe("working");
		expect(title("strategy")).toBe("Economics");
		expect(figure("gone").querySelector(".surface-figure")).toBeNull();
		expect(title("gone")).toBe("Gone");

		surfaces = [
			{ ...surfaces[0]!, runningSessionCount: 2 },
			{ ...surfaces[1]!, runningSessionCount: 0 },
		];
		await store.refreshSurfaces();
		decorateSurfaceFigures(prose, store);
		expect(state("website")).toBe("working");
		expect(state("strategy")).toBe("rest");
	});

	it("names an end-row figure by its link's drawn words, not its markdown", () => {
		const parts = markdownBubbles("I rebuilt [**the site**](surface:website) and [`web`](surface:web-app).");
		const row = parts.at(-1)!;
		expect([...row.querySelectorAll(".app-card-title")].map((title) => title.textContent)).toEqual([
			"the site",
			"web",
		]);
	});
});
