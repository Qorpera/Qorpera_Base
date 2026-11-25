import type { SurfaceEpistemicTier } from "@qorpera/contracts";
import { h, icon } from "../../../ui/dom.ts";
import { presentationLocale, t } from "../../../ui/preferences.ts";
import type { SurfaceBlockContext } from "./context.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

type SvgChild = Node | string | null | undefined | false;

export function svgEl<K extends keyof SVGElementTagNameMap>(
	tag: K,
	attrs: Readonly<Record<string, string | number | undefined>> = {},
	...children: SvgChild[]
): SVGElementTagNameMap[K] {
	const element = document.createElementNS(SVG_NS, tag);
	for (const [key, value] of Object.entries(attrs)) {
		if (value !== undefined) element.setAttribute(key, String(value));
	}
	for (const child of children) {
		if (child === null || child === undefined || child === false) continue;
		element.append(child);
	}
	return element;
}

export function tierLabel(tier: SurfaceEpistemicTier): string {
	switch (tier) {
		case "verified":
			return t("Verified");
		case "benchmark":
			return t("Benchmark");
		default:
			return t("Hypothesis");
	}
}

export function tierBadge(tier: SurfaceEpistemicTier | undefined, source?: string): HTMLElement | null {
	if (!tier) return null;
	return h(
		"span",
		{ class: `studio-tier is-${tier}`, ...(source ? { title: source } : {}) },
		h("i", { class: "studio-tier-dot", "aria-hidden": "true" }),
		tierLabel(tier),
	);
}

export function kicker(text: string): HTMLElement {
	return h("span", { class: "studio-kicker" }, text);
}

export interface StrategyAsk {
	readonly prompt: string;
	readonly title: string;
}

export function askButton(
	ctx: SurfaceBlockContext,
	label: string,
	compose: () => StrategyAsk,
	extraClass = "",
): HTMLButtonElement | null {
	const ask = ctx.askSurface;
	if (!ask) return null;
	const button: HTMLButtonElement = h(
		"button",
		{
			type: "button",
			class: `studio-ask-btn${extraClass ? ` ${extraClass}` : ""}`,
			onclick: () => {
				if (button.disabled) return;
				button.disabled = true;
				button.classList.add("is-busy");
				const settle = () => {
					button.disabled = false;
					button.classList.remove("is-busy");
				};
				const { prompt, title } = compose();
				void ask(prompt, title).then(settle, settle);
			},
		},
		icon("sparkle"),
		h("span", null, label),
	);
	return button;
}

export function strategyEmpty(kind: string, title: string, line: string, action: HTMLElement | null): HTMLElement {
	return h(
		"div",
		{ class: `studio-strategy-empty is-${kind}` },
		h("span", { class: "studio-strategy-empty-mark", "aria-hidden": "true" }),
		h("strong", null, title),
		h("p", null, line),
		action,
	);
}

function numberLocale(): string {
	return presentationLocale() === "da" ? "da-DK" : "en-US";
}

export function plainNumber(value: number, digits: number, compact = false): string {
	const big = compact && Math.abs(value) >= 10_000;
	return new Intl.NumberFormat(numberLocale(), {
		maximumFractionDigits: big ? 1 : digits,
		...(big ? { notation: "compact" as const } : {}),
	}).format(value);
}

export function currencyAmount(value: number, code: string | undefined, compact = false): string {
	const digits = Math.abs(value) < 10 && !Number.isInteger(value) ? 2 : 0;
	if (code && /^[A-Z]{3}$/.test(code)) {
		const big = compact && Math.abs(value) >= 10_000;
		try {
			return new Intl.NumberFormat(numberLocale(), {
				style: "currency",
				currency: code,
				currencyDisplay: "code",
				maximumFractionDigits: big ? 1 : digits,
				minimumFractionDigits: 0,
				...(big ? { notation: "compact" as const } : {}),
			}).format(value);
		} catch {
			return `${plainNumber(value, digits, compact)} ${code}`;
		}
	}
	const text = plainNumber(value, digits, compact);
	return code ? `${text} ${code}` : text;
}

export function percentAmount(value: number): string {
	return new Intl.NumberFormat(numberLocale(), { style: "percent", maximumFractionDigits: 1 }).format(value / 100);
}
