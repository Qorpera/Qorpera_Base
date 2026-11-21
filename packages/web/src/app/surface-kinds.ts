import type { SurfaceSummary } from "@qorpera/contracts";
import type { Emblem } from "../ui/interface-emblem.ts";
import { phrase, t } from "../ui/preferences.ts";

export const SURFACE_KINDS = [
	"website",
	"web_app",
	"mobile_app",
	"desktop_app",
	"database",
	"dashboard",
	"brand",
	"product",
	"report",
	"custom",
	"inbox",
	"money",
	"members",
	"data",
	"files",
] as const;
export type SurfaceKind = (typeof SURFACE_KINDS)[number];

export interface SurfaceLook {
	readonly kind: SurfaceKind;
	readonly accent?: string;
}

interface KindSpec {
	readonly emblem: Emblem;
	readonly tint: string;
	readonly subtitle: string;
}

const KIND_SPECS: Readonly<Record<SurfaceKind, KindSpec>> = {
	website: { emblem: "globe", tint: "#2a9ae0", subtitle: phrase("Marketing site") },
	web_app: { emblem: "spark", tint: "#5a5fe0", subtitle: phrase("Interactive web app") },
	mobile_app: { emblem: "phone", tint: "#8b5cf6", subtitle: phrase("iOS & Android app") },
	desktop_app: { emblem: "window", tint: "#5d7896", subtitle: phrase("Desktop app") },
	database: { emblem: "database", tint: "#0e9c93", subtitle: phrase("Tables & queries") },
	dashboard: { emblem: "chart", tint: "#12a467", subtitle: phrase("KPIs & cashflow") },
	brand: { emblem: "spark", tint: "#d76f45", subtitle: phrase("Colors, type & voice") },
	product: { emblem: "box", tint: "#ec7a2c", subtitle: phrase("Specs, colorways & BOM") },
	report: { emblem: "book", tint: "#4a55a2", subtitle: phrase("Essays, analysis & charts") },
	custom: { emblem: "star", tint: "#6c839b", subtitle: phrase("Custom surface") },
	inbox: { emblem: "mail", tint: "#2f63d8", subtitle: phrase("Mail & follow-ups") },
	money: { emblem: "bank", tint: "#0fa958", subtitle: phrase("Balances & invoices") },
	members: { emblem: "members", tint: "#a145f7", subtitle: phrase("Team & roles") },
	data: { emblem: "database", tint: "#0e9c93", subtitle: phrase("Tables & queries") },
	files: { emblem: "drawers", tint: "#d4950f", subtitle: phrase("Company files") },
};

export const SURFACE_ACCENTS: readonly { readonly name: string; readonly hex: string }[] = [
	{ name: phrase("Sky"), hex: "#2a9ae0" },
	{ name: phrase("Blue"), hex: "#2f63d8" },
	{ name: phrase("Purple"), hex: "#8b5cf6" },
	{ name: phrase("Pink"), hex: "#e0559b" },
	{ name: phrase("Red"), hex: "#dc3545" },
	{ name: phrase("Orange"), hex: "#ec7a2c" },
	{ name: phrase("Gold"), hex: "#d4950f" },
	{ name: phrase("Green"), hex: "#12a467" },
	{ name: phrase("Slate"), hex: "#6c839b" },
];

export const SURFACE_CUSTOM_EMBLEMS: readonly Emblem[] = [
	"star",
	"rocket",
	"box",
	"cart",
	"truck",
	"heart",
	"book",
	"chat",
	"calendar",
	"map",
	"pulse",
	"code",
];

const KNOWN_EMBLEMS: ReadonlySet<string> = new Set<string>([
	...SURFACE_CUSTOM_EMBLEMS,
	"globe",
	"spark",
	"phone",
	"window",
	"database",
	"chart",
	"mail",
	"bank",
	"coin",
	"members",
	"drawers",
	"board",
	"page",
	"queue",
	"hire",
	"mountain",
	"tent",
	"pin",
	"camera",
]);

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
	surface: Pick<SurfaceSummary, "id" | "slug" | "icon" | "archetype">,
	looks: Readonly<Record<string, SurfaceLook>> = {},
): SurfaceLook {
	return looks[surface.id] ?? { kind: inferSurfaceKind(surface) };
}

export function surfaceKindEmblem(kind: SurfaceKind): Emblem {
	return KIND_SPECS[kind].emblem;
}

export function surfaceKindTint(kind: SurfaceKind): string {
	return KIND_SPECS[kind].tint;
}

export function surfaceTint(look: SurfaceLook): string {
	return look.accent && /^#[0-9a-f]{6}$/i.test(look.accent) ? look.accent : KIND_SPECS[look.kind].tint;
}

export function surfaceTileEmblem(surface: Pick<SurfaceSummary, "icon">, look: SurfaceLook): Emblem {
	if (look.kind === "custom" && KNOWN_EMBLEMS.has(surface.icon)) return surface.icon as Emblem;
	return KIND_SPECS[look.kind].emblem;
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
