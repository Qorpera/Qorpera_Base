import type { CloudMemberFolderClient } from "@qorpera/cloud-client/cloud-member-folder";
import { parseTomlSubset } from "@qorpera/cloud-client/toml-subset";
import { COMPANY_BRAND_FOLDER } from "../cloud/company-logos.ts";

/* The base style of an interface app (deploy/first-node/RUNTIME-INTERFACE-APPS.md §2; Jonas, 10 November 2026: six of
 * seven agent-made apps were one generic green report, because each agent made up a look of its own). Every app's page
 * starts from one small stylesheet, put first in its head when the page is put together (app/interface-apps.ts
 * `assembleApp`):
 * - It is injected, not only offered as variables: a page with no styles of its own must already read well, and
 *   variables alone style nothing.
 * - It sits in a cascade layer (`@layer qorpera-base`), and a page's own styles are in none, so any rule the page writes
 *   wins over it, whatever its selector and wherever it stands. An agent overrides a default by writing the property;
 *   nothing has to be undone.
 * - It sets only what a page that says nothing gets wrong: the font, the colours, the page's margin, headings, tables,
 *   links, code. The page's margin is the one property that also holds the text column to a readable width, so a page
 *   that sets its own `body { margin }` takes the whole width back with that one rule.
 * - The company's colours come from `QorperaOS/brand/brand.toml`, which a page cannot read itself (the bridge keeps
 *   QorperaOS/ out). Only colours written as hex are taken, and only where text stays readable on them.
 * - The scheme is the app's own light or dark when the page says it supports both, the web's own way
 *   (`<meta name="color-scheme" content="light dark">`); a page that does not say stays light, as a browser shows a
 *   page that does not say. A page with colours of its own that assumed a light page would otherwise turn unreadable.
 * A concept of the company's product gets none of this: its design is the product's own. */

export type AppScheme = "light" | "dark";

/** What the app gives a page to start from: its own scheme now, and the company's colours (null for none). */
export interface AppLook {
	readonly scheme: AppScheme;
	readonly brand: AppBrand | null;
}

/** A brand's colours for one scheme, each `#rrggbb` or null. */
export interface AppBrandColours {
	readonly accent: string | null;
	readonly background: string | null;
	readonly text: string | null;
}

/** A company's colours, as its brand.toml gives them: at the top for a light page, under `[dark]` for a dark one. */
export interface AppBrand {
	readonly light: AppBrandColours;
	readonly dark: AppBrandColours;
}

/** Where the company keeps its colours, beside its logo. */
export const APP_BRAND_PATH = `${COMPANY_BRAND_FOLDER}/brand.toml`;
const BRAND_MAX_BYTES = 4 * 1024;

/** Qorpera's own look, for a company with no colours yet: the web app's page, text, link and status colours. */
const PLAIN = {
	light: { background: "#ffffff", text: "#161615", accent: "#305fbe" },
	dark: { background: "#1f2120", text: "#f4f3f0", accent: "#6ea4ff" },
} as const;
const STATUS = {
	light: { good: "#0f7a5a", warn: "#9a6300", bad: "#b33a2f" },
	dark: { good: "#5ed6a9", warn: "#f2c35d", bad: "#ff9084" },
} as const;

/** A colour as `#rrggbb`, from `#rgb` or `#rrggbb` in any case; null for anything else, so nothing but a colour ever
 * reaches the stylesheet. */
function hexColour(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const hex = value.trim().toLowerCase();
	if (/^#[0-9a-f]{6}$/.test(hex)) return hex;
	return /^#[0-9a-f]{3}$/.test(hex) ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : null;
}

function brandColours(table: unknown): AppBrandColours {
	const values = typeof table === "object" && table !== null && !Array.isArray(table) ? table : {};
	const of = (key: string) => hexColour((values as Record<string, unknown>)[key]);
	return { accent: of("accent"), background: of("background"), text: of("text") };
}

/** Reads a brand.toml: `accent`, `background` and `text` at the top, and again under `[dark]`. Anything else in the file
 * is left alone (it may hold more of the brand later); a file that is not TOML gives no brand. */
export function parseAppBrand(text: string): AppBrand | null {
	try {
		const value = parseTomlSubset(text).value;
		return { light: brandColours(value), dark: brandColours(value.dark) };
	} catch {
		return null;
	}
}

/** The company's colours as the member's own folder holds them, or null when it holds none that read. A read that fails
 * throws: the panel then keeps the colours it had (views/app-panel.ts), so a page is not shown afresh without them. */
export async function readAppBrand(
	folder: Pick<CloudMemberFolderClient, "read" | "readFile">,
	signal: AbortSignal,
): Promise<AppBrand | null> {
	const entry = (await folder.read(APP_BRAND_PATH, signal)).entry;
	if (entry?.kind !== "file" || !entry.file || entry.file.bytes > BRAND_MAX_BYTES) return null;
	// The entry was read live just now: its bytes may come from the member's file cache.
	const bytes = await folder.readFile(entry.file, signal, BRAND_MAX_BYTES, { cached: true });
	try {
		return parseAppBrand(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		return null;
	}
}

/** A colour's relative luminance, and two colours' contrast, as WCAG 2 counts them. */
function luminance(hex: string): number {
	const channel = (at: number) => {
		const value = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
		return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}
function contrast(a: string, b: string): number {
	const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y) as [number, number];
	return (high + 0.05) / (low + 0.05);
}

/** The scheme a page is shown in: the app's own when the page says it supports light and dark, dark for a page that
 * says dark alone, and light otherwise. */
export function appScheme(page: Document, host: AppScheme): AppScheme {
	const said = (page.querySelector('meta[name="color-scheme" i]')?.getAttribute("content") ?? "")
		.toLowerCase()
		.split(/[\t\n\f\r ]+/);
	if (!said.includes("dark")) return "light";
	return said.includes("light") ? host : "dark";
}

/** The colours of a page in `scheme`. The company's background and text are taken together, and only when the text
 * reads on the background (4.5 to 1); its accent only when it shows on the background (3 to 1), in a dark page the
 * dark one first, then the light one. Whatever is left out is Qorpera's own. */
export function appColours(scheme: AppScheme, brand: AppBrand | null) {
	const plain = PLAIN[scheme];
	const own = brand?.[scheme];
	let background: string = own?.background ?? plain.background;
	let text: string = own?.text ?? plain.text;
	if (contrast(text, background) < 4.5) ({ background, text } = plain);
	// A company's background may be dark in a light page: controls, scroll bars, Qorpera's own accent and the status
	// colours follow the background, not the scheme.
	const shade: AppScheme = luminance(background) < 0.18 ? "dark" : "light";
	const accent =
		[own?.accent, scheme === "dark" ? brand?.light.accent : null, PLAIN[shade].accent].find(
			(colour): colour is string => typeof colour === "string" && contrast(colour, background) >= 3,
		) ?? text;
	return {
		background,
		text,
		accent,
		onAccent: contrast("#ffffff", accent) >= contrast("#161615", accent) ? "#ffffff" : "#161615",
		shade,
		...STATUS[shade],
	};
}

/** The base stylesheet of a page in `scheme`, with the company's colours. Every value in it is a fixed text or a
 * checked hex colour. */
export function appBaseStyle(scheme: AppScheme, brand: AppBrand | null): string {
	const c = appColours(scheme, brand);
	return `@layer qorpera-base {
:root {
	color-scheme: ${c.shade};
	--q-bg: ${c.background};
	--q-text: ${c.text};
	--q-accent: ${c.accent};
	--q-on-accent: ${c.onAccent};
	--q-muted: color-mix(in srgb, var(--q-text) 68%, var(--q-bg));
	--q-line: color-mix(in srgb, var(--q-text) 14%, var(--q-bg));
	--q-surface: color-mix(in srgb, var(--q-text) 5%, var(--q-bg));
	--q-accent-soft: color-mix(in srgb, var(--q-accent) 14%, var(--q-bg));
	--q-good: ${c.good};
	--q-warn: ${c.warn};
	--q-bad: ${c.bad};
	--q-font: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
	--q-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
	--q-radius: 10px;
}
html { background: var(--q-bg); color: var(--q-text); font: 100%/1.55 var(--q-font); -webkit-text-size-adjust: 100%; text-size-adjust: 100%; -webkit-font-smoothing: antialiased; }
body { margin: clamp(20px, 4vw, 44px) max(clamp(16px, 4vw, 44px), calc((100% - 800px) / 2)); overflow-wrap: break-word; }
h1, h2, h3, h4 { line-height: 1.2; font-weight: 650; text-wrap: balance; }
h1 { font-size: 1.75rem; letter-spacing: -0.015em; }
h2 { font-size: 1.25rem; letter-spacing: -0.01em; }
h3 { font-size: 1.0625rem; }
h4 { font-size: 1rem; }
a { color: var(--q-accent); text-underline-offset: 0.15em; }
hr { margin: 1.75em 0; border: 0; border-top: 1px solid var(--q-line); }
img, video, svg { max-width: 100%; }
:is(img, video)[width][height] { height: auto; }
table:not([width]) { width: 100%; }
table { border-collapse: collapse; font-size: 0.9375rem; font-variant-numeric: tabular-nums; }
caption { padding-bottom: 0.5em; color: var(--q-muted); font-size: 0.875rem; text-align: start; }
th, td { padding: 0.55em 0.9em 0.55em 0; border-bottom: 1px solid var(--q-line); vertical-align: top; }
:is(th, td):last-child { padding-right: 0; }
th { color: var(--q-muted); font-size: 0.8125rem; font-weight: 600; }
th:not([align]) { text-align: start; }
code, kbd, samp, pre { font-family: var(--q-mono); font-size: 0.875em; }
pre { padding: 0.9em 1em; border-radius: var(--q-radius); background: var(--q-surface); overflow: auto; }
blockquote { margin-inline: 0; padding-left: 1em; border-left: 3px solid var(--q-line); color: var(--q-muted); }
button, input, select, textarea { font: inherit; }
:focus-visible { outline: 2px solid var(--q-accent); outline-offset: 2px; }
}`;
}
