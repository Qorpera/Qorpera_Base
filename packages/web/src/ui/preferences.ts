/** Browser presentation preferences contain no account or company state. */
export type LanguagePreference = "system" | "en" | "da";
export type ThemePreference = "system" | "light" | "dark";
export type ComposerColorPreference = "blue" | "green" | "grey";
const LANGUAGE_KEY = "qorpera.web.language";
const THEME_KEY = "qorpera.web.theme";
const COMPOSER_COLOR_KEY = "qorpera.web.composer-color";
const SYSTEM_DARK = "(prefers-color-scheme: dark)";
const DANISH: Record<string, string> = {
	General: "Generelt",
	Company: "Virksomhed",
	Connections: "Forbindelser",
	Policy: "Retningslinjer",
	Account: "Konto",
	"Plan & usage": "Abonnement og forbrug",
	Plan: "Abonnement",
	Usage: "Forbrug",
	"Current plan": "Nuværende abonnement",
	"Company storage": "Virksomhedens lager",
	"Free trial": "Gratis prøveperiode",
	Basis: "Basis",
	Standard: "Standard",
	"Dedicated computer": "Dedikeret computer",
	Upgrade: "Opgrader",
	"Change plan": "Skift abonnement",
	"Coming soon": "Kommer snart",
	"/month": "/md",
	"For the daily work.": "Til det daglige arbejde.",
	"More storage and extra computer use.": "Mere lagerplads og ekstra computerbrug.",
	"Your own computer all month.": "Din egen computer hele måneden.",
	"Everything in Basis, plus": "Alt i Basis, plus",
	"Everything in Standard, plus": "Alt i Standard, plus",
	"100 GB storage included": "100 GB lagerplads inkluderet",
	"A worker computer for every agent, 74 hours": "En medarbejder-computer til hver agent over 74 timer",
	"Connect from computer and phone": "Forbind til computer og mobil",
	"Work in the cloud while your computer is off": "Arbejd i skyen, selvom computeren er slukket",
	"250 GB storage included": "250 GB lagerplads inkluderet",
	"More than 3.5× extra computer use": "Mere end 3,5× ekstra computerbrug",
	"Priority access at peak hours": "Prioriteret adgang i myldretiden",
	"500 GB storage included": "500 GB lagerplads inkluderet",
	"A dedicated computer all month": "Dedikeret computer hele måneden",
	"Early access to new features": "Tidlig adgang til nye funktioner",
	About: "Ca.",
	"off usage": "rabat på forbrug",
	h: "t",
	used: "brugt",
	of: "af",
	"a month": "om måneden",
	with: "med",
	Resets: "Nulstilles",
	Retry: "Prøv igen",
	"Loading storage…": "Henter lager…",
	"Storage information unavailable": "Oplysninger om lager er ikke tilgængelige",
	"Plan unavailable": "Abonnement ikke tilgængeligt",
	"Loading…": "Henter…",
	"company storage included": "virksomhedslager inkluderet",
	"No active subscription": "Intet aktivt abonnement",
	"Storage allocation unavailable": "Lagertildeling ikke tilgængelig",
	"Plan changes are not open yet.": "Skift af abonnement er ikke åbnet endnu.",
	"Every plan starts with a free trial, no card needed. Prices are ex. VAT.":
		"Alle planer starter med en gratis prøveperiode uden betalingskort. Priserne er ekskl. moms.",
	"Computer hours": "Computertimer",
	"Not measured yet": "Ikke målt endnu",
	"Included in your free trial": "Inkluderet i prøveperioden",
	"Your own computer, all month": "Din egen computer, hele måneden",
	Billing: "Betaling",
	Price: "Pris",
	Free: "Gratis",
	"ex. VAT": "ekskl. moms",
	"Not available yet": "Ikke tilgængelig endnu",
	"Next payment": "Næste betaling",
	"None during your free trial": "Ingen i prøveperioden",
	"Not scheduled yet": "Ikke planlagt endnu",
	"Payment method": "Betalingsmetode",
	"No card on file": "Intet kort tilføjet",
	"Add card": "Tilføj kort",
	Invoices: "Fakturaer",
	"No invoices yet": "Ingen fakturaer endnu",
	"Choose a company to see its storage.": "Vælg en virksomhed for at se dens lager.",
	Appearance: "Udseende",
	Theme: "Tema",
	"Composer color": "Skrivefeltets farve",
	"Send button, your message bubbles, and selected agent cards.":
		"Send-knappen, dine beskedbobler og valgte agentkort.",
	Blue: "Blå",
	Green: "Grøn",
	Grey: "Grå",
	Light: "Lys",
	Dark: "Mørk",
	"System follows your device’s appearance.": "System følger din enheds udseende.",
	"Language & region": "Sprog og område",
	Language: "Sprog",
	"System default": "Systemstandard",
	English: "Engelsk",
	"Sign out": "Log ud",
	Feedback: "Feedback",
	"Share feedback": "Del feedback",
	"Send feedback": "Send feedback",
	"Search settings": "Søg i indstillinger",
	"Staff at work": "Agenter på arbejde",
	"Company File": "Company File",
	Organization: "Organisation",
	Approvals: "Godkendelser",
	"Account and settings": "Konto og indstillinger",
	Friends: "Venner",
	Invitations: "Invitationer",
	"New conversation": "Ny samtale",
	"New agent": "Ny agent",
	"Suggested agents": "Foreslåede agenter",
	Open: "Åbn",
	Cancel: "Annuller",
	Back: "Tilbage",
	"System default follows your browser’s language.": "Systemstandarden følger sproget i din browser.",
	"Some screens are still shown in English.": "Nogle skærme vises stadig på engelsk.",
};

export function languagePreference(): LanguagePreference {
	try {
		const value = localStorage.getItem(LANGUAGE_KEY);
		return value === "en" || value === "da" ? value : "system";
	} catch {
		return "system";
	}
}

export function presentationLocale(): "da" | "en" {
	const preference = languagePreference();
	return preference === "system" ? (navigator.language.toLowerCase().startsWith("da") ? "da" : "en") : preference;
}

/** Translate only explicitly marked interface labels, never company content. */
export function uiText(source: string): HTMLSpanElement {
	const element = document.createElement("span");
	element.dataset.uiText = source;
	element.textContent = presentationLocale() === "da" ? (DANISH[source] ?? source) : source;
	return element;
}

export function applyLanguage(): void {
	const locale = presentationLocale();
	document.documentElement.lang = locale;
	for (const element of document.querySelectorAll<HTMLElement>("[data-ui-text]")) {
		const source = element.dataset.uiText!;
		element.textContent = locale === "da" ? (DANISH[source] ?? source) : source;
	}
}

export function setLanguagePreference(value: string): boolean {
	if (value !== "system" && value !== "en" && value !== "da") return false;
	try {
		localStorage.setItem(LANGUAGE_KEY, value);
	} catch {
		return false;
	}
	applyLanguage();
	window.dispatchEvent(new Event("qorpera-language-change"));
	return true;
}

export function composerColorPreference(): ComposerColorPreference {
	try {
		const value = localStorage.getItem(COMPOSER_COLOR_KEY);
		return value === "green" || value === "grey" ? value : "blue";
	} catch {
		return "blue";
	}
}

export function applyComposerColor(): void {
	document.documentElement.dataset.composerColor = composerColorPreference();
}

export function setComposerColorPreference(value: string): boolean {
	if (value !== "blue" && value !== "green" && value !== "grey") return false;
	try {
		localStorage.setItem(COMPOSER_COLOR_KEY, value);
	} catch {
		return false;
	}
	applyComposerColor();
	return true;
}

export function themePreference(): ThemePreference {
	try {
		const value = localStorage.getItem(THEME_KEY);
		return value === "light" || value === "dark" ? value : "system";
	} catch {
		return "system";
	}
}

/** The theme on screen: the stored choice, else the device's appearance. */
export function presentationTheme(): "light" | "dark" {
	const preference = themePreference();
	return preference === "system" ? (window.matchMedia(SYSTEM_DARK).matches ? "dark" : "light") : preference;
}

/** Runs before the first paint (theme.ts) and again on every change. Colours
 * come from the stylesheet; the figure painter repaints on
 * `qorpera-theme-change`. */
export function applyTheme(): void {
	const theme = presentationTheme();
	if (document.documentElement.dataset.theme === theme) return;
	document.documentElement.dataset.theme = theme;
	window.dispatchEvent(new Event("qorpera-theme-change"));
}

export function setThemePreference(value: string): boolean {
	if (value !== "system" && value !== "light" && value !== "dark") return false;
	try {
		localStorage.setItem(THEME_KEY, value);
	} catch {
		return false;
	}
	applyTheme();
	return true;
}

/** Follow the device's appearance and choices made in other tabs. */
export function watchTheme(): () => void {
	const system = window.matchMedia(SYSTEM_DARK);
	const onStorage = (event: StorageEvent) => {
		if (event.key === THEME_KEY || event.key === null) applyTheme();
		if (event.key === COMPOSER_COLOR_KEY || event.key === null) applyComposerColor();
	};
	applyTheme();
	applyComposerColor();
	system.addEventListener("change", applyTheme);
	window.addEventListener("storage", onStorage);
	return () => {
		system.removeEventListener("change", applyTheme);
		window.removeEventListener("storage", onStorage);
	};
}
