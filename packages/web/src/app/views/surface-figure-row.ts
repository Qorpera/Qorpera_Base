import type { SurfaceSummary } from "@qorpera/contracts";
import type { SurfacesStore } from "../surfaces-store.ts";
import { surfaceTile } from "./surface-rail.ts";

export function decorateSurfaceFigure(
	figure: HTMLElement,
	store: SurfacesStore,
	bySlug: ReadonlyMap<string, SurfaceSummary>,
): void {
	const slug = figure.dataset.surfaceSlug?.toLowerCase();
	const surface = slug ? bySlug.get(slug) : undefined;
	if (!surface) return;
	const look = store.lookOf(surface);
	const tab = figure.dataset.surfaceTab ?? "";
	const state = surface.runningSessionCount > 0 ? "working" : "rest";
	const shown = JSON.stringify([surface.id, surface.title, surface.icon, look.kind, tab, state]);
	if (figure.dataset.shown === shown) return;
	figure.dataset.shown = shown;
	figure.querySelector(".app-card-emblem")?.replaceChildren(surfaceTile(surface, look, "is-rail", state));
	const title = figure.querySelector<HTMLElement>(".app-card-title");
	if (title && !tab) title.textContent = surface.title;
}

export function surfacesBySlug(store: SurfacesStore): Map<string, SurfaceSummary> {
	return new Map(store.state.surfaces.map((surface) => [surface.slug.toLowerCase(), surface]));
}

export function decorateSurfaceFigures(root: ParentNode, store: SurfacesStore): void {
	const figures = root.querySelectorAll<HTMLElement>(".surface-card.is-figure[data-surface-slug]");
	if (!figures.length) return;
	const bySlug = surfacesBySlug(store);
	for (const figure of figures) decorateSurfaceFigure(figure, store, bySlug);
}
