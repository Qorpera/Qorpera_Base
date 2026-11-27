import {
	SURFACE_KINDS as STORED_KINDS,
	type SurfaceLookKind,
	type SurfaceSummary,
	surfaceLookKind,
} from "@qorpera/contracts";
import type { Emblem } from "../ui/interface-emblem.ts";
import { phrase, t } from "../ui/preferences.ts";
import { type SurfaceFigureId, surfaceFigureFromIcon } from "../ui/surface-figure.ts";

export type SurfaceKind = SurfaceLookKind;
export const SURFACE_KINDS: readonly SurfaceKind[] = STORED_KINDS.filter(
	(kind): kind is SurfaceKind => kind !== "members",
);

export interface SurfaceLook {
	readonly kind: SurfaceKind;
	readonly accent?: string;
}

interface KindSpec {
	readonly emblem: Emblem;
	readonly figure: SurfaceFigureId;
	readonly tint: string;
	readonly subtitle: string;
}

const KIND_SPECS: Readonly<Record<SurfaceKind, KindSpec>> = {
	identity: {
		emblem: "spark",
		figure: "seal",
		tint: "#d76f45",
		subtitle: phrase("Brand, voice, design & philosophy"),
	},
	strategy: {
		emblem: "map",
		figure: "lighthouse",
		tint: "#0f766e",
		subtitle: phrase("Grand plan, bets, economics & hypotheses"),
	},
	website: { emblem: "globe", figure: "browser", tint: "#2a9ae0", subtitle: phrase("Marketing site") },
	web_app: { emblem: "spark", figure: "pointer", tint: "#5a5fe0", subtitle: phrase("Interactive web app") },
	mobile_app: { emblem: "phone", figure: "phone", tint: "#8b5cf6", subtitle: phrase("iOS & Android app") },
	desktop_app: { emblem: "window", figure: "monitor", tint: "#5d7896", subtitle: phrase("Desktop app") },
	database: { emblem: "database", figure: "can", tint: "#0e9c93", subtitle: phrase("Tables & queries") },
	dashboard: { emblem: "chart", figure: "bars", tint: "#12a467", subtitle: phrase("KPIs & cashflow") },
	brand: { emblem: "spark", figure: "palette", tint: "#d76f45", subtitle: phrase("Colors, type & voice") },
	product: { emblem: "box", figure: "parcel", tint: "#ec7a2c", subtitle: phrase("Specs, colorways & BOM") },
	report: { emblem: "book", figure: "book", tint: "#4a55a2", subtitle: phrase("Essays, analysis & charts") },
	custom: { emblem: "star", figure: "gem", tint: "#6c839b", subtitle: phrase("Custom surface") },
	inbox: { emblem: "mail", figure: "envelope", tint: "#2f63d8", subtitle: phrase("Mail & follow-ups") },
	money: { emblem: "bank", figure: "money", tint: "#0fa958", subtitle: phrase("Balances & invoices") },
	data: { emblem: "database", figure: "can", tint: "#0e9c93", subtitle: phrase("Tables & queries") },
	files: { emblem: "drawers", figure: "folder", tint: "#d4950f", subtitle: phrase("Company files") },
};

const EMBLEM_FIGURES: Readonly<Record<string, SurfaceFigureId>> = {
	globe: "browser",
	page: "book",
	book: "book",
	spark: "palette",
	phone: "phone",
	window: "monitor",
	code: "pointer",
	database: "can",
	chart: "bars",
	pulse: "bars",
	box: "parcel",
	truck: "parcel",
	cart: "shop",
	mail: "envelope",
	chat: "envelope",
	bank: "money",
	coin: "money",
	members: "people",
	drawers: "folder",
	star: "gem",
	heart: "gem",
	map: "house",
	pin: "house",
	calendar: "book",
};

export function surfaceLookOf(
	surface: Pick<SurfaceSummary, "id" | "slug" | "icon" | "archetype" | "kind" | "accentHex">,
	looks: Readonly<Record<string, SurfaceLook>> = {},
): SurfaceLook {
	const local = looks[surface.id];
	if (local) return local;
	return {
		kind: surfaceLookKind(surface),
		...(surface.accentHex ? { accent: surface.accentHex } : {}),
	};
}

export function surfaceTint(look: SurfaceLook): string {
	return KIND_SPECS[look.kind].tint;
}

export function surfaceKindFigure(kind: SurfaceKind): SurfaceFigureId {
	return KIND_SPECS[kind].figure;
}

export function surfaceFigureOf(surface: Pick<SurfaceSummary, "icon">, look: SurfaceLook): SurfaceFigureId {
	const chosen = surfaceFigureFromIcon(surface.icon);
	if (chosen) return chosen;
	if (look.kind === "custom") return EMBLEM_FIGURES[surface.icon] ?? KIND_SPECS.custom.figure;
	return KIND_SPECS[look.kind].figure;
}

export function surfaceKindSubtitle(kind: SurfaceKind): string {
	return t(KIND_SPECS[kind].subtitle);
}

export function surfaceSubtitleOf(surface: Pick<SurfaceSummary, "archetype">, look: Pick<SurfaceLook, "kind">): string {
	if (look.kind === "dashboard" && surface.archetype === "studio") return t("Sales, money & visitors");
	return surfaceKindSubtitle(look.kind);
}

export function isOpsKind(kind: SurfaceKind): boolean {
	return kind === "inbox" || kind === "money" || kind === "data" || kind === "files";
}

export function isAppWorkbenchSurface(
	surface: Pick<SurfaceSummary, "id" | "sourceKind">,
	look: Pick<SurfaceLook, "kind">,
): boolean {
	return (
		!surface.id.startsWith("local-") &&
		surface.sourceKind === "code_repo" &&
		(look.kind === "web_app" || look.kind === "mobile_app" || look.kind === "desktop_app")
	);
}

export function supportsViewportSplit(
	surface: Pick<SurfaceSummary, "archetype">,
	look: Pick<SurfaceLook, "kind">,
): boolean {
	if (surface.archetype !== "live_build") return false;
	return look.kind === "website" || look.kind === "web_app" || look.kind === "custom";
}

export function opsComposerPlaceholder(kind: SurfaceKind): string {
	switch (kind) {
		case "inbox":
			return t("Ask an agent to draft, follow up, or summarize mail…");
		case "money":
			return t("Ask an agent to prepare payments, categorize, or check cashflow…");
		case "data":
			return t("Ask an agent to query, add rows, or update tables…");
		case "files":
			return t("Ask an agent to organize, summarize, or create files…");
		default:
			return t("Ask an agent to handle a task here…");
	}
}

export function isThetabandCompany(companyName: string): boolean {
	return /\bthetaband\b/i.test(companyName);
}

export function slugifySurfaceTitle(title: string, taken: ReadonlySet<string>): string {
	const raw = title
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 34);
	const base = raw && /^[a-z0-9]/.test(raw) ? raw : "surface";
	if (!taken.has(base)) return base;
	let index = 2;
	while (taken.has(`${base}-${index}`)) index += 1;
	return `${base}-${index}`;
}
