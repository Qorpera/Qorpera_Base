import { reducedMotion } from "../../ui/motion.ts";
import { phrase, t } from "../../ui/preferences.ts";
import { goodWillName } from "./good-will-format.ts";

export const SETTINGS_TABS = [
	{
		id: "general",
		label: phrase("General"),
		icon: "settings",
		keywords:
			"account language region time zone timezone good will goodwill appearance theme light dark composer color colour blue green grey gray interface size big small generelt konto sprog dansk engelsk område tidszone udseende tema lys mørk skrivefelt farve blå grøn grå grænseflade størrelse stor lille",
	},
	{
		id: "company",
		label: phrase("Company"),
		icon: "company",
		keywords:
			"brand rename logo company name people team members invitations staff delete leave good will goodwill tax invoices card payment sales rules agent rules auto-review review approval approve ask first allow automatically safety agents actions permissions mærke omdøb virksomhedsnavn virksomhed personer medlemmer invitationer agenter roller slet forlad skat fakturaer kort betaling salg regler agentregler godkendelse godkend spørg først tillad automatisk sikkerhed handlinger tilladelser",
	},
	{
		id: "leaderboard",
		label: phrase("Leaderboard"),
		icon: "trophy",
		keywords:
			"friends compare ranking awards streak tasks agents companies sales leaderboard venner sammenlign rangliste priser stime opgaver agenter virksomheder salg",
	},
	{
		id: "ai-subscriptions",
		label: phrase("AI subscriptions"),
		icon: "key",
		keywords:
			"ai subscriptions default models conversational coding voice tts effort credits my connections model accounts providers sign in openai chatgpt codex anthropic claude google gemini neon api key usage ai-abonnementer standardmodeller stemme lyd mine forbindelser modelkonti udbydere abonnementer log ind forbrug kredit",
	},
] as const;

export type SettingsCategory = (typeof SETTINGS_TABS)[number]["id"];
export type SettingsTab = SettingsCategory | "my-connections" | "appearance";

export interface SettingsPlace {
	readonly tab: SettingsTab;
	readonly label: string;
	readonly area: string;
	readonly icon: string;
	readonly words: string;
	readonly mark?: string;
}

export function settingsPlaces(deletes: boolean): SettingsPlace[] {
	const general = phrase("General");
	const company = phrase("Company");
	const subscriptions = phrase("AI subscriptions");
	const place = (tab: SettingsCategory, label: string, area: string, words: string, mark?: string): SettingsPlace => ({
		tab,
		label,
		area,
		icon: SETTINGS_TABS.find((one) => one.id === tab)!.icon,
		words,
		...(mark ? { mark } : {}),
	});
	const exit = deletes ? t("Delete company") : t("Leave company");
	return [
		place(
			"general",
			t("Account"),
			general,
			"name email password picture konto navn adgangskode billede",
			t("Account"),
		),
		place(
			"general",
			t("Language & region"),
			general,
			"language region time zone timezone sprog dansk english tidszone område",
			t("Language & region"),
		),
		place(
			"general",
			t("Appearance"),
			general,
			"theme dark light mode colour color composer interface size tema mørk lys farve størrelse",
			t("Appearance"),
		),
		place("general", goodWillName(), general, "goodwill good will tax skat", goodWillName()),
		place("company", t("Brand"), company, "brand rename logo company name mærke omdøb virksomhedsnavn"),
		place(
			"company",
			t("Staff at work"),
			company,
			"members people team invitations invite staff medlemmer personer invitationer inviter",
			t("Staff at work"),
		),
		place(
			"company",
			t("Agent rules"),
			company,
			"rules approve approval ask first allow permissions safety regler godkend tilladelser",
			t("Agent rules"),
		),
		place("company", exit, company, "delete leave remove slet forlad", exit),
		place(
			"company",
			t("Invoices and card"),
			company,
			"invoices card payment billing good will tax fakturaer kort betaling skat",
			goodWillName(),
		),
		place(
			"leaderboard",
			phrase("Leaderboard"),
			t("Settings"),
			"friends compare ranking awards streak venner rangliste",
		),
		place(
			"ai-subscriptions",
			t("Model accounts"),
			subscriptions,
			"chatgpt openai codex claude anthropic gemini google sign in login log ind",
			t("Model accounts"),
		),
		place(
			"ai-subscriptions",
			t("Default models"),
			subscriptions,
			"model effort coding conversational voice tts standardmodeller stemme",
			t("Default models"),
		),
		place("ai-subscriptions", t("Gemini API key"), subscriptions, "google gemini api key nøgle", t("Gemini API key")),
	];
}

export function markSettingsPlace(text: string): void {
	const until = performance.now() + 2500;
	const look = () => {
		const content = document.querySelector<HTMLElement>(".settings-content:not([hidden])");
		const found = [...(content?.querySelectorAll<HTMLElement>("h2, button, summary") ?? [])].find(
			(element) => element.textContent?.trim() === text && !element.closest("[hidden]"),
		);
		if (!found) {
			if (performance.now() < until) requestAnimationFrame(look);
			return;
		}
		const target = found.closest<HTMLElement>(".settings-group") ?? found;
		target.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
		target.classList.remove("is-found");
		void target.offsetWidth;
		target.classList.add("is-found");
		target.addEventListener("animationend", () => target.classList.remove("is-found"), { once: true });
	};
	requestAnimationFrame(look);
}
