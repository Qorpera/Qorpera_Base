import { SURFACE_KINDS, type SurfaceKind, type SurfaceSummary } from "@qorpera/contracts";
import type { Emblem } from "../ui/interface-emblem.ts";
import { phrase, t } from "../ui/preferences.ts";
import { type SurfaceFigureId, surfaceFigureFromIcon } from "../ui/surface-figure.ts";

export { SURFACE_KINDS, type SurfaceKind };

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
	members: { emblem: "members", figure: "people", tint: "#a145f7", subtitle: phrase("Team & roles") },
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

export function inferSurfaceKind(surface: Pick<SurfaceSummary, "slug" | "icon" | "archetype">): SurfaceKind {
	const { slug, icon } = surface;
	if (surface.archetype === "ops") {
		if (slug === "inbox" || slug === "mail" || icon === "mail") return "inbox";
		if (slug === "money" || slug === "bank" || icon === "coin" || icon === "bank") return "money";
		if (slug === "members" || slug === "team" || icon === "members") return "members";
		if (slug === "data" || slug === "databases" || icon === "database") return "data";
		if (slug === "files" || icon === "drawers") return "files";
		return "custom";
	}
	if (surface.archetype === "studio") {
		if (/identity|manifesto/.test(slug)) return "identity";
		if (icon === "book" || /report|journal|essay|analysis|blog|research|philosophy/.test(slug)) return "report";
		if (icon === "database" || /(^|-)(data|database|tables|crm)(-|$)/.test(slug)) return "database";
		if (icon === "box" || icon === "board" || /product|hardware|spec|headband/.test(slug)) return "product";
		if (icon === "spark" || /brand/.test(slug)) return "brand";
		return "custom";
	}
	if (icon === "phone" || /mobile|ios|android/.test(slug)) return "mobile_app";
	if (icon === "window" || /desktop/.test(slug)) return "desktop_app";
	if (icon === "chart" || /dashboard|finance|kpi|metrics/.test(slug)) return "dashboard";
	if (icon === "spark" || /(^|-)(app|portal)(-|$)/.test(slug)) return "web_app";
	if (!icon || icon === "globe" || icon === "page") return "website";
	return "custom";
}

export function surfaceLookOf(
	surface: Pick<SurfaceSummary, "id" | "slug" | "icon" | "archetype" | "kind" | "accentHex">,
	looks: Readonly<Record<string, SurfaceLook>> = {},
): SurfaceLook {
	const local = looks[surface.id];
	if (local) return local;
	const kind = surface.kind && surface.kind !== "custom" ? surface.kind : inferSurfaceKind(surface);
	return {
		kind,
		...(surface.accentHex ? { accent: surface.accentHex } : {}),
	};
}

export function surfaceKindEmblem(kind: SurfaceKind): Emblem {
	return KIND_SPECS[kind].emblem;
}

export function surfaceKindTint(kind: SurfaceKind): string {
	return KIND_SPECS[kind].tint;
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

export function isOpsKind(kind: SurfaceKind): boolean {
	return kind === "inbox" || kind === "money" || kind === "members" || kind === "data" || kind === "files";
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
		case "members":
			return t("Ask an agent to invite, update roles, or onboard people…");
		default:
			return t("Ask an agent to handle a task here…");
	}
}
