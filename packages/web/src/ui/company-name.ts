import { h } from "./dom.ts";
import { t } from "./preferences.ts";

export const UNNAMED_COMPANY = "No name yet";

export function isUnnamed(name: string | null | undefined): boolean {
	return name === UNNAMED_COMPANY;
}

export function companyDisplayName(name: string): string {
	return isUnnamed(name) ? t("No name yet") : name;
}

export function companyInSentence(name: string, start = false): string {
	if (!isUnnamed(name)) return name;
	return start ? t("The company") : t("the company");
}

export function companyNameText(name: string, className = "", tag: "span" | "h1" = "span"): HTMLElement {
	const unnamed = isUnnamed(name);
	return h(
		tag,
		{ class: [className, unnamed ? "company-unnamed" : ""].filter(Boolean).join(" ") || null },
		companyDisplayName(name),
	);
}

export function showCompanyName(element: HTMLElement, name: string): void {
	const shown = companyDisplayName(name);
	if (element.textContent !== shown) element.textContent = shown;
	element.classList.toggle("company-unnamed", isUnnamed(name));
}
