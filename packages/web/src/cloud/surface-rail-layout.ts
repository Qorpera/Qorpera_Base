import { parseRecord } from "@qorpera/contracts";

export const SURFACE_RAIL_SCHEMA = "qorpera.member-surface-rail/v1";
export const SURFACE_SECTION_NAME_LIMIT = 40;
const MAX_SECTIONS = 50;
const MAX_IDS = 500;
const SURFACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECTION_ID = /^[a-z0-9-]{1,40}$/;

export const LOOSE_ZONE = "surfaces";
export const SECTION_ZONE = "surface-section:";

export interface SurfaceRailSection {
	readonly id: string;
	readonly name: string;
	readonly surfaces: readonly string[];
}

export interface SurfaceRailLayout {
	readonly schema: typeof SURFACE_RAIL_SCHEMA;
	readonly order: readonly string[];
	readonly sections: readonly SurfaceRailSection[];
}

export interface SurfaceRailLayoutRead {
	readonly layout: SurfaceRailLayout;
	readonly updatedAt: string | null;
}

export const EMPTY_SURFACE_RAIL: SurfaceRailLayout = { schema: SURFACE_RAIL_SCHEMA, order: [], sections: [] };

export function sectionNameOk(name: string): boolean {
	return (
		name.length >= 1 &&
		name.length <= SURFACE_SECTION_NAME_LIMIT &&
		name === name.trim() &&
		![...name].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
	);
}

export function parseSurfaceRailLayout(value: unknown): SurfaceRailLayout {
	const input = parseRecord(value, "interfaces layout");
	if (input.schema !== SURFACE_RAIL_SCHEMA) throw new Error("Invalid interfaces layout");
	const seen = new Set<string>();
	const ids = (list: unknown): string[] =>
		(Array.isArray(list) ? list : []).filter((id): id is string => {
			if (typeof id !== "string" || !SURFACE_ID.test(id) || seen.has(id) || seen.size >= MAX_IDS) return false;
			seen.add(id);
			return true;
		});
	const order = ids(input.order);
	const sectionIds = new Set<string>();
	const sections: SurfaceRailSection[] = [];
	for (const raw of Array.isArray(input.sections) ? input.sections : []) {
		if (!raw || typeof raw !== "object" || sections.length >= MAX_SECTIONS) continue;
		const { id, name, surfaces } = raw as Record<string, unknown>;
		if (typeof id !== "string" || !SECTION_ID.test(id) || sectionIds.has(id)) continue;
		if (typeof name !== "string" || !sectionNameOk(name)) continue;
		sectionIds.add(id);
		sections.push({ id, name, surfaces: ids(surfaces) });
	}
	return { schema: SURFACE_RAIL_SCHEMA, order, sections };
}

export function parseSurfaceRailLayoutRead(value: unknown): SurfaceRailLayoutRead {
	const input = parseRecord(value, "interfaces layout");
	if (input.schema !== "qorpera.member-surface-rail-read/v1") throw new Error("Invalid interfaces layout");
	return {
		layout: parseSurfaceRailLayout(input.layout),
		updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : null,
	};
}

export interface ArrangedSection<T> {
	readonly id: string;
	readonly name: string;
	readonly surfaces: readonly T[];
}

export interface ArrangedRail<T> {
	readonly loose: readonly T[];
	readonly sections: readonly ArrangedSection<T>[];
}

export function defaultSurfaceOrder<T>(surfaces: readonly T[], isInbox: (surface: T) => boolean): T[] {
	return [...surfaces.filter(isInbox), ...surfaces.filter((surface) => !isInbox(surface))];
}

export function arrangeSurfaces<T extends { readonly id: string }>(
	surfaces: readonly T[],
	layout: SurfaceRailLayout | undefined,
): ArrangedRail<T> {
	const byId = new Map(surfaces.map((surface) => [surface.id, surface]));
	const placed = new Set<string>();
	const take = (ids: readonly string[]): T[] =>
		ids.flatMap((id) => {
			const surface = byId.get(id);
			if (!surface || placed.has(id)) return [];
			placed.add(id);
			return [surface];
		});
	const order = take(layout?.order ?? []);
	const sections = (layout?.sections ?? []).map((section) => ({
		id: section.id,
		name: section.name,
		surfaces: take(section.surfaces),
	}));
	return { loose: [...order, ...surfaces.filter((surface) => !placed.has(surface.id))], sections };
}

export function layoutOf(rail: ArrangedRail<{ readonly id: string }>): SurfaceRailLayout {
	return {
		schema: SURFACE_RAIL_SCHEMA,
		order: rail.loose.map((surface) => surface.id),
		sections: rail.sections.map((section) => ({
			id: section.id,
			name: section.name,
			surfaces: section.surfaces.map((surface) => surface.id),
		})),
	};
}

export function moveSurface(
	rail: ArrangedRail<{ readonly id: string }>,
	surfaceId: string,
	zone: string,
	seen: readonly string[],
): SurfaceRailLayout | undefined {
	const layout = layoutOf(rail);
	const without = (ids: readonly string[]) => ids.filter((id) => id !== surfaceId);
	const into = (ids: readonly string[]) => {
		const next = without(ids);
		const following = seen.slice(seen.indexOf(surfaceId) + 1).find((id) => next.includes(id));
		next.splice(following ? next.indexOf(following) : next.length, 0, surfaceId);
		return next;
	};
	if (zone === LOOSE_ZONE)
		return {
			...layout,
			order: into(layout.order),
			sections: layout.sections.map((section) => ({ ...section, surfaces: without(section.surfaces) })),
		};
	if (!zone.startsWith(SECTION_ZONE)) return undefined;
	const sectionId = zone.slice(SECTION_ZONE.length);
	if (!layout.sections.some((section) => section.id === sectionId)) return undefined;
	return {
		...layout,
		order: without(layout.order),
		sections: layout.sections.map((section) => ({
			...section,
			surfaces: section.id === sectionId ? into(section.surfaces) : without(section.surfaces),
		})),
	};
}

export function moveSurfaceTo(
	rail: ArrangedRail<{ readonly id: string }>,
	surfaceId: string,
	sectionId: string | undefined,
): SurfaceRailLayout | undefined {
	return moveSurface(rail, surfaceId, sectionId ? `${SECTION_ZONE}${sectionId}` : LOOSE_ZONE, []);
}

export function nudgeSurface(
	rail: ArrangedRail<{ readonly id: string }>,
	surfaceId: string,
	delta: -1 | 1,
): SurfaceRailLayout | undefined {
	const layout = layoutOf(rail);
	const step = (ids: readonly string[]) => {
		const at = ids.indexOf(surfaceId);
		if (at < 0 || at + delta < 0 || at + delta >= ids.length) return undefined;
		const next = [...ids];
		next.splice(at, 1);
		next.splice(at + delta, 0, surfaceId);
		return next;
	};
	const order = step(layout.order);
	if (order) return { ...layout, order };
	for (const section of layout.sections) {
		const surfaces = step(section.surfaces);
		if (surfaces)
			return {
				...layout,
				sections: layout.sections.map((item) => (item.id === section.id ? { ...item, surfaces } : item)),
			};
	}
	return undefined;
}

export function addSection(
	rail: ArrangedRail<{ readonly id: string }>,
	sectionId: string,
	name: string,
	surfaceId?: string,
): SurfaceRailLayout {
	const layout = layoutOf(rail);
	const without = (ids: readonly string[]) => ids.filter((id) => id !== surfaceId);
	return {
		...layout,
		order: without(layout.order),
		sections: [
			...layout.sections.map((section) => ({ ...section, surfaces: without(section.surfaces) })),
			{ id: sectionId, name, surfaces: surfaceId ? [surfaceId] : [] },
		],
	};
}

export function renameSection(
	rail: ArrangedRail<{ readonly id: string }>,
	sectionId: string,
	name: string,
): SurfaceRailLayout {
	const layout = layoutOf(rail);
	return {
		...layout,
		sections: layout.sections.map((section) => (section.id === sectionId ? { ...section, name } : section)),
	};
}

export function removeSection(rail: ArrangedRail<{ readonly id: string }>, sectionId: string): SurfaceRailLayout {
	const layout = layoutOf(rail);
	const gone = layout.sections.find((section) => section.id === sectionId);
	return {
		...layout,
		order: [...layout.order, ...(gone?.surfaces ?? [])],
		sections: layout.sections.filter((section) => section.id !== sectionId),
	};
}

export function nudgeSection(
	rail: ArrangedRail<{ readonly id: string }>,
	sectionId: string,
	delta: -1 | 1,
): SurfaceRailLayout | undefined {
	const layout = layoutOf(rail);
	const at = layout.sections.findIndex((section) => section.id === sectionId);
	if (at < 0 || at + delta < 0 || at + delta >= layout.sections.length) return undefined;
	const sections = [...layout.sections];
	const [moved] = sections.splice(at, 1);
	sections.splice(at + delta, 0, moved!);
	return { ...layout, sections };
}

export function newSurfaceSectionId(): string {
	return `s-${crypto.randomUUID().slice(0, 8)}`;
}

export function isEmptySurfaceRail(layout: SurfaceRailLayout): boolean {
	return !layout.order.length && !layout.sections.length;
}
