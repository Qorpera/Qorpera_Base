import type { SurfaceKind } from "./surfaces.ts";

export const IDENTITY_TOKENS_JSON_PATH = "identity/tokens.json";
export const IDENTITY_TOKENS_CSS_PATH = "identity/tokens.css";
export const IDENTITY_BRIEF_PATH = "identity/brief.md";
export const IDENTITY_VOICE_PATH = "identity/voice.md";
export const IDENTITY_LOGO_PATH = "identity/logo.svg";
export const IDENTITY_COMPANY_PATH = "identity/company.json";
export const PRODUCT_SPECS_PATH = "product/specs.json";
export const PRODUCT_CATALOG_PATH = "product/catalog.json";

export const IDENTITY_SHARED_ASSET_PATHS = [
	IDENTITY_TOKENS_JSON_PATH,
	IDENTITY_TOKENS_CSS_PATH,
	IDENTITY_BRIEF_PATH,
	IDENTITY_VOICE_PATH,
	IDENTITY_LOGO_PATH,
	IDENTITY_COMPANY_PATH,
] as const;

export interface SharedProductAssetCandidates {
	readonly specsPaths: readonly string[];
	readonly catalogPaths: readonly string[];
}

export function sharedProductAssetCandidates(
	productFolderRoots?: readonly string[] | null,
): SharedProductAssetCandidates {
	for (const raw of productFolderRoots ?? []) {
		const cleaned = raw.trim().replace(/^\/+|\/+$/g, "");
		if (!cleaned) continue;
		return {
			specsPaths: [`${cleaned}/specs.json`],
			catalogPaths: [`${cleaned}/catalog.json`],
		};
	}
	return {
		specsPaths: [PRODUCT_SPECS_PATH],
		catalogPaths: [PRODUCT_CATALOG_PATH],
	};
}

export const SURFACE_SHARED_DIR = "public/qorpera-shared";
export const SURFACE_IDENTITY_CSS_MOUNT_PATH = "qorpera-identity.css";

export interface SharedSurfaceAssetLink {
	readonly id: string;
	readonly label: string;
	readonly sourcePaths: readonly string[];
	readonly producedBy: readonly SurfaceKind[];
	readonly consumedBy: readonly SurfaceKind[];
	readonly liveSyncMode: "css_variables" | "shared_json" | "prompt_context";
}

export const SHARED_SURFACE_ASSET_LINKS: readonly SharedSurfaceAssetLink[] = [
	{
		id: "visual-identity",
		label: "Visual tokens (colors, typography, radius)",
		sourcePaths: [IDENTITY_TOKENS_JSON_PATH, IDENTITY_TOKENS_CSS_PATH, IDENTITY_LOGO_PATH],
		producedBy: ["identity"],
		consumedBy: ["website", "web_app", "mobile_app", "product"],
		liveSyncMode: "css_variables",
	},
	{
		id: "product-catalog",
		label: "Product specs, variants & pricing",
		sourcePaths: [PRODUCT_SPECS_PATH, PRODUCT_CATALOG_PATH],
		producedBy: ["product"],
		consumedBy: ["website", "web_app", "mobile_app", "money", "inbox"],
		liveSyncMode: "shared_json",
	},
	{
		id: "company-profile",
		label: "Company details, contact & links",
		sourcePaths: [IDENTITY_COMPANY_PATH],
		producedBy: ["identity", "members", "inbox"],
		consumedBy: ["website", "web_app", "money", "inbox"],
		liveSyncMode: "shared_json",
	},
	{
		id: "brand-voice",
		label: "Brand philosophy & tone of voice",
		sourcePaths: [IDENTITY_BRIEF_PATH, IDENTITY_VOICE_PATH],
		producedBy: ["identity"],
		consumedBy: ["website", "web_app", "mobile_app", "product", "inbox"],
		liveSyncMode: "prompt_context",
	},
];

const TOKEN_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/;
const SAFE_COLOR_RE =
	/^(?:#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|(?:rgb|rgba|hsl|hsla|oklch)\([0-9.,%\s/a-zA-Z-]{1,64}\))$/;
const SAFE_FONT_RE = /^[A-Za-z0-9\s,'"-]{1,120}$/;
const SAFE_LENGTH_RE = /^(?:0|[0-9]{1,4}(?:\.[0-9]{1,3})?(?:px|rem|em|%|vw|vh))$/;
const CSS_DANGEROUS_RE = /[;{}<>\\]|url\s*\(|expression\s*\(|@import|\/\*|\*\//i;

function toKebab(key: string): string {
	return key
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.replace(/[^a-zA-Z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.toLowerCase();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeColor(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed || CSS_DANGEROUS_RE.test(trimmed)) return null;
	return SAFE_COLOR_RE.test(trimmed) ? trimmed : null;
}

function sanitizeFont(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed || CSS_DANGEROUS_RE.test(trimmed) || !SAFE_FONT_RE.test(trimmed)) return null;
	if (trimmed.includes(",")) return trimmed;
	const quoted = /\s/.test(trimmed) && !/^["'].*["']$/.test(trimmed) ? `"${trimmed.replace(/"/g, "")}"` : trimmed;
	return `${quoted}, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
}

function sanitizeLength(value: unknown): string | null {
	if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 9999) {
		return `${value}px`;
	}
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed || CSS_DANGEROUS_RE.test(trimmed)) return null;
	return SAFE_LENGTH_RE.test(trimmed) ? trimmed : null;
}

function collectColors(source: Record<string, unknown>, prefix: string, out: Map<string, string>, depth = 0): void {
	if (depth > 2) return;
	for (const [rawKey, value] of Object.entries(source)) {
		if (!TOKEN_KEY_RE.test(rawKey)) continue;
		const key = prefix ? `${prefix}-${toKebab(rawKey)}` : toKebab(rawKey);
		if (!key) continue;
		if (typeof value === "string") {
			const safe = sanitizeColor(value);
			if (safe) out.set(key, safe);
		} else if (isPlainRecord(value)) {
			if (typeof value.hex === "string") {
				const safe = sanitizeColor(value.hex);
				if (safe) out.set(key, safe);
			} else if (typeof value.value === "string") {
				const safe = sanitizeColor(value.value);
				if (safe) out.set(key, safe);
			} else {
				collectColors(value, key, out, depth + 1);
			}
		}
	}
}

export interface CompiledIdentityTokens {
	readonly css: string;
	readonly vars: Readonly<Record<string, string>>;
}

// WHY: Compiles identity/tokens.json into XSS-safe CSS custom properties so Website, Web App, and Studio surfaces style live from Company Files.
export function compileIdentityTokens(tokensJsonText: string): CompiledIdentityTokens {
	let parsed: unknown;
	try {
		parsed = JSON.parse(tokensJsonText);
	} catch {
		return { css: ":root {\n}\n", vars: {} };
	}
	if (!isPlainRecord(parsed)) {
		return { css: ":root {\n}\n", vars: {} };
	}

	const vars = new Map<string, string>();
	const colors = new Map<string, string>();
	for (const group of ["colors", "palette", "color"]) {
		const raw = parsed[group];
		if (isPlainRecord(raw)) collectColors(raw, "", colors);
	}
	for (const [key, value] of Object.entries(parsed)) {
		if (typeof value === "string" && TOKEN_KEY_RE.test(key)) {
			const safe = sanitizeColor(value);
			if (safe && !colors.has(toKebab(key))) colors.set(toKebab(key), safe);
		}
	}

	for (const [key, value] of [...colors.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		vars.set(`--q-color-${key}`, value);
	}
	const primary = colors.get("primary") ?? colors.get("ink") ?? colors.get("text");
	const accent = colors.get("accent") ?? colors.get("brand");
	const surface = colors.get("surface") ?? colors.get("background") ?? colors.get("bg");
	const muted = colors.get("muted") ?? colors.get("subtle");
	if (primary) vars.set("--brand-primary", primary);
	if (accent) vars.set("--brand-accent", accent);
	if (surface) vars.set("--brand-surface", surface);
	if (muted) vars.set("--brand-muted", muted);

	const typography = isPlainRecord(parsed.typography)
		? parsed.typography
		: isPlainRecord(parsed.fonts)
			? parsed.fonts
			: null;
	if (typography) {
		for (const [rawKey, rawValue] of Object.entries(typography)) {
			if (!TOKEN_KEY_RE.test(rawKey)) continue;
			const key = toKebab(rawKey);
			const fontCandidate =
				typeof rawValue === "string"
					? rawValue
					: isPlainRecord(rawValue) && typeof rawValue.family === "string"
						? rawValue.family
						: null;
			const safe = sanitizeFont(fontCandidate);
			if (!safe) continue;
			vars.set(`--q-font-${key}`, safe);
			if (key === "heading" || key === "display") vars.set("--font-heading", safe);
			if (key === "body" || key === "sans") vars.set("--font-body", safe);
			if (key === "mono" || key === "code") vars.set("--font-mono", safe);
		}
	}

	for (const [group, cssPrefix] of [
		["radius", "--q-radius-"],
		["radii", "--q-radius-"],
		["spacing", "--q-space-"],
		["space", "--q-space-"],
	] as const) {
		const raw = parsed[group];
		if (!isPlainRecord(raw)) continue;
		for (const [rawKey, rawValue] of Object.entries(raw)) {
			if (!TOKEN_KEY_RE.test(rawKey)) continue;
			const safe = sanitizeLength(rawValue);
			if (safe) vars.set(`${cssPrefix}${toKebab(rawKey)}`, safe);
		}
	}

	const entries = [...vars.entries()].sort(([a], [b]) => a.localeCompare(b));
	const lines = entries.map(([name, value]) => `\t${name}: ${value};`);
	const css = lines.length > 0 ? `:root {\n${lines.join("\n")}\n}\n` : ":root {\n}\n";
	return { css, vars: Object.fromEntries(entries) };
}

export function compileIdentityTokensCss(tokensJsonText: string): string {
	return compileIdentityTokens(tokensJsonText).css;
}

export function sharedAssetsConsumedBy(kind: SurfaceKind): readonly SharedSurfaceAssetLink[] {
	return SHARED_SURFACE_ASSET_LINKS.filter((link) => link.consumedBy.includes(kind));
}

export function sharedAssetsProducedBy(kind: SurfaceKind): readonly SharedSurfaceAssetLink[] {
	return SHARED_SURFACE_ASSET_LINKS.filter((link) => link.producedBy.includes(kind));
}
