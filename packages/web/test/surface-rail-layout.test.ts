// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { SurfaceRail } from "../src/app/views/surface-rail.ts";
import {
	addSection,
	arrangeSurfaces,
	defaultSurfaceOrder,
	LOOSE_ZONE,
	layoutOf,
	moveSurface,
	nudgeSection,
	nudgeSurface,
	parseSurfaceRailLayout,
	parseSurfaceRailLayoutRead,
	removeSection,
	renameSection,
	SECTION_ZONE,
	SURFACE_RAIL_SCHEMA,
	type SurfaceRailLayout,
} from "../src/cloud/surface-rail-layout.ts";
import { COMPANY, fakeClient, storeWith, summary } from "./surface-fixtures.ts";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const items = [A, B, C, D].map((id) => ({ id }));
const ids = (list: readonly { id: string }[]) => list.map((item) => item.id);
const layout = (order: string[], sections: { id: string; name: string; surfaces: string[] }[] = []) =>
	({ schema: SURFACE_RAIL_SCHEMA, order, sections }) satisfies SurfaceRailLayout;

afterEach(() => {
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe("the member's order of interfaces", () => {
	it("puts Inbox first by default and keeps the rest in the company's order", () => {
		const order = defaultSurfaceOrder(["website", "money", "inbox", "files"], (slug) => slug === "inbox");
		expect(order).toEqual(["inbox", "website", "money", "files"]);
	});

	it("arranges by the document; one it does not name stands after the loose ones, and a gone id is left out", () => {
		const rail = arrangeSurfaces(
			items,
			layout([C, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", A], [{ id: "s-1", name: "Later", surfaces: [D] }]),
		);
		expect(ids(rail.loose)).toEqual([C, A, B]);
		expect(rail.sections.map((section) => [section.name, ids(section.surfaces)])).toEqual([["Later", [D]]]);
		expect(ids(arrangeSurfaces(items, undefined).loose)).toEqual([A, B, C, D]);
	});

	it("moves an interface where it was dropped, among the loose ones or into a section", () => {
		const rail = arrangeSurfaces(items, layout([], [{ id: "s-1", name: "Products", surfaces: [] }]));
		const up = moveSurface(rail, D, LOOSE_ZONE, [A, D, B, C]);
		expect(up?.order).toEqual([A, D, B, C]);
		const into = moveSurface(arrangeSurfaces(items, up), B, `${SECTION_ZONE}s-1`, [B]);
		expect(into?.order).toEqual([A, D, C]);
		expect(into?.sections[0]?.surfaces).toEqual([B]);
		expect(moveSurface(rail, A, `${SECTION_ZONE}gone`, [A])).toBeUndefined();
		expect(moveSurface(rail, A, "unassigned", [A])).toBeUndefined();
	});

	it("nudges an interface and a section one place, and stops at the edges", () => {
		const rail = arrangeSurfaces(
			items,
			layout(
				[A, B],
				[
					{ id: "s-1", name: "One", surfaces: [C] },
					{ id: "s-2", name: "Two", surfaces: [D] },
				],
			),
		);
		expect(nudgeSurface(rail, B, -1)?.order).toEqual([B, A]);
		expect(nudgeSurface(rail, A, -1)).toBeUndefined();
		expect(nudgeSurface(rail, C, 1)).toBeUndefined();
		expect(nudgeSection(rail, "s-2", -1)?.sections.map((section) => section.id)).toEqual(["s-2", "s-1"]);
		expect(nudgeSection(rail, "s-2", 1)).toBeUndefined();
	});

	it("adds, renames and removes the member's own sections; a removed section's interfaces go to the end", () => {
		const rail = arrangeSurfaces(items, undefined);
		const added = addSection(rail, "s-new", "Products", C);
		expect(added.order).toEqual([A, B, D]);
		expect(added.sections).toEqual([{ id: "s-new", name: "Products", surfaces: [C] }]);
		const renamed = renameSection(arrangeSurfaces(items, added), "s-new", "Apps");
		expect(renamed.sections[0]?.name).toBe("Apps");
		const removed = removeSection(arrangeSurfaces(items, renamed), "s-new");
		expect(removed).toEqual(layout([A, B, D, C]));
		expect(layoutOf(arrangeSurfaces(items, removed))).toEqual(removed);
	});

	it("reads only what the cloud would keep", () => {
		const read = parseSurfaceRailLayoutRead({
			schema: "qorpera.member-surface-rail-read/v1",
			updatedAt: "2026-11-23T01:00:00Z",
			layout: {
				schema: SURFACE_RAIL_SCHEMA,
				order: [A, A, "inbox", 3],
				sections: [
					{ id: "s-1", name: "Ok", surfaces: [A, B] },
					{ id: "s-1", name: "Twice", surfaces: [C] },
					{ id: "Bad Id", name: "No", surfaces: [] },
					{ id: "s-2", name: " padded", surfaces: [] },
				],
			},
		});
		expect(read.updatedAt).toBe("2026-11-23T01:00:00Z");
		expect(read.layout).toEqual(layout([A], [{ id: "s-1", name: "Ok", surfaces: [B] }]));
		expect(() => parseSurfaceRailLayout({ schema: "other" })).toThrow();
	});
});

describe("the rail's interfaces, arranged by the member", () => {
	const inbox = summary({
		id: A,
		slug: "inbox",
		title: "Inbox",
		group: "operations",
		archetype: "ops",
		icon: "mail",
		siteSlug: null,
		activeSessionCount: 0,
	});
	const website = summary({ id: B, activeSessionCount: 0 });
	const money = summary({
		id: C,
		slug: "money",
		title: "Money",
		group: "operations",
		archetype: "ops",
		icon: "bank",
		siteSlug: null,
		activeSessionCount: 0,
	});

	async function railWith(start: SurfaceRailLayout | undefined, arrangeable = true) {
		const store = storeWith(fakeClient({ listSurfaces: vi.fn(async () => [website, money, inbox]) }));
		await store.load();
		let current = start;
		const change = vi.fn((next: SurfaceRailLayout) => {
			current = next;
		});
		const refuse = vi.fn();
		const rail = new SurfaceRail(store, COMPANY, new AbortController().signal, {
			layout: () => current,
			canArrange: () => arrangeable,
			change,
			refuse,
		});
		document.body.append(rail.el);
		rail.update(undefined);
		const names = () => [...rail.el.querySelectorAll(".rail-surface-name")].map((node) => node.textContent);
		return { store, rail, change, refuse, names };
	}

	it("draws Inbox first with no section titles until the member makes one", async () => {
		const { store, rail, names } = await railWith(undefined);
		expect(names()).toEqual(["Inbox", "Website", "Money"]);
		expect(rail.el.querySelectorAll(".rail-surface-title")).toHaveLength(0);
		expect(rail.el.querySelector(`[data-drop-zone="${LOOSE_ZONE}"]`)).not.toBeNull();
		expect(
			[...rail.el.querySelectorAll<HTMLElement>("[data-surface-id]")].map((item) => item.dataset.surfaceId),
		).toEqual([A, B, C]);
		store.dispose();
	});

	it("draws the member's order and sections, and writes a drop back whole", async () => {
		const { store, rail, change, names } = await railWith(
			layout([C, A], [{ id: "s-1", name: "Building", surfaces: [B] }]),
		);
		expect(names()).toEqual(["Money", "Inbox", "Website"]);
		const title = rail.el.querySelector<HTMLElement>(".rail-surface-title");
		expect(title?.textContent).toBe("Building");
		expect(title?.closest<HTMLElement>("[data-drop-zone]")?.dataset.dropZone).toBe(`${SECTION_ZONE}s-1`);
		expect(rail.canDrag(A)).toBe(true);
		expect(rail.accepts(`${SECTION_ZONE}s-1`, A)).toBe(true);
		expect(rail.accepts("unassigned", A)).toBe(false);
		rail.drop(A, `${SECTION_ZONE}s-1`, [A, B]);
		expect(change).toHaveBeenLastCalledWith(layout([C], [{ id: "s-1", name: "Building", surfaces: [A, B] }]));
		rail.update(undefined);
		expect(names()).toEqual(["Money", "Inbox", "Website"]);
		expect(
			[...rail.el.querySelectorAll<HTMLElement>(`[data-drop-zone="${SECTION_ZONE}s-1"] [data-surface-id]`)].map(
				(item) => item.dataset.surfaceId,
			),
		).toEqual([A, B]);
		store.dispose();
	});

	it("moves the focused interface with Alt and an arrow", async () => {
		const { store, rail, change } = await railWith(undefined);
		const website = rail.el.querySelector<HTMLElement>(`[data-surface-id="${B}"] .rail-surface`)!;
		website.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true }));
		expect(change).toHaveBeenLastCalledWith(layout([B, A, C]));
		store.dispose();
	});

	it("moves nothing before the member's own order is read", async () => {
		const { store, rail, change } = await railWith(undefined, false);
		expect(rail.canDrag(A)).toBe(false);
		rail.drop(A, LOOSE_ZONE, [B, A, C]);
		expect(change).not.toHaveBeenCalled();
		store.dispose();
	});
});
