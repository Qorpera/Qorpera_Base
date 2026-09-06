/** Browser presentation preferences contain no account or company state. */
export type LanguagePreference = "system" | "en" | "da";
const LANGUAGE_KEY = "qorpera.web.language";
const DANISH: Record<string, string> = {
	General: "Generelt",
	Company: "Virksomhed",
	Connections: "Forbindelser",
	Policy: "Retningslinjer",
	Account: "Konto",
	"Plan & billing": "Abonnement og betaling",
	"Current plan": "Nuværende abonnement",
	Appearance: "Udseende",
	Theme: "Tema",
	Light: "Lys",
	"Language & region": "Sprog og område",
	Language: "Sprog",
	"System default": "Systemstandard",
	English: "Engelsk",
	"Sign out": "Log ud",
	Companies: "Virksomheder",
	"All companies": "Alle virksomheder",
	"Open or create a company": "Åbn eller opret en virksomhed",
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
