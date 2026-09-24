import type { HostedAccountEntitlement } from "../../cloud/types.ts";
import { button, h, notice, replace } from "../../ui/dom.ts";
import { type PickerOption, PreferencePicker } from "../../ui/preference-picker.ts";
import {
	languagePreference,
	phrase,
	presentationLocale,
	setLanguagePreference,
	setTimeZonePreference,
	systemTimeZone,
	t,
	timeZonePreference,
	uiText,
} from "../../ui/preferences.ts";
import { timeZoneCity, timeZoneEntries } from "../../ui/time-zones.ts";
import { type AuthController, displayName } from "../auth.ts";
import { accountPicture } from "./account-picture.ts";
import { composerColorChoices, themeChoices } from "./appearance.ts";

/** Each language by its own name; the list shows it again in the interface's. */
const LANGUAGES = [
	{ value: "en", label: "English", english: phrase("English"), keywords: "en" },
	{ value: "da", label: "Dansk", english: phrase("Danish"), keywords: "da danish dansk" },
] as const;

function languageOptions(): PickerOption[] {
	const locale = presentationLocale();
	return [
		{ value: "system", label: t("Follow system") },
		...LANGUAGES.map((language) => ({
			value: language.value,
			label: language.label,
			detail: t(language.english),
			keywords: `${language.english} ${language.keywords}`,
		})).sort((a, b) => a.detail.localeCompare(b.detail, locale)),
	];
}

function timeZoneOptions(): PickerOption[] {
	const system = systemTimeZone();
	const chosen = timeZonePreference();
	return [
		{ value: "system", label: t("Follow system"), detail: timeZoneCity(system), keywords: system },
		...timeZoneEntries(presentationLocale(), chosen === "system" ? [system] : [system, chosen]).map((zone) => ({
			value: zone.id,
			label: zone.city,
			detail: zone.offset,
			keywords: zone.names.join(" "),
			title: [zone.id, ...zone.names].join(" · "),
		})),
	];
}

let renders = 0;

interface Pickers {
	labels: { language: string; timeZone: string };
	language: PreferencePicker;
	timeZone: PreferencePicker;
}

/** One pair of pickers per panel, kept across its re-renders (the account's
 * entitlement arriving, an error notice): an open list and the focus in it
 * survive, and no listeners are left behind. */
const panelPickers = new WeakMap<HTMLElement, Pickers>();

function pickersFor(container: HTMLElement, setState: (next: AccountViewState) => void): Pickers {
	const kept = panelPickers.get(container);
	if (kept) {
		kept.language.refresh();
		kept.timeZone.refresh();
		return kept;
	}
	const labels = { language: `settings-language-${++renders}`, timeZone: `settings-time-zone-${renders}` };
	const pickers: Pickers = {
		labels,
		language: new PreferencePicker({
			labelId: labels.language,
			searchLabel: phrase("Search language"),
			options: languageOptions,
			value: languagePreference,
			display: (value) => LANGUAGES.find((candidate) => candidate.value === value)?.label ?? uiText("Follow system"),
			choose: (value) => {
				if (!setLanguagePreference(value))
					setState({ error: t("Your browser could not save the language preference.") });
			},
		}),
		timeZone: new PreferencePicker({
			labelId: labels.timeZone,
			searchLabel: phrase("Search time zone"),
			options: timeZoneOptions,
			value: timeZonePreference,
			display: (value) => (value === "system" ? uiText("Follow system") : timeZoneCity(value)),
			choose: (value) => {
				if (!setTimeZonePreference(value))
					setState({ error: t("Your browser could not save the time zone preference.") });
			},
		}),
	};
	panelPickers.set(container, pickers);
	return pickers;
}

export interface AccountViewState {
	loading?: boolean;
	loaded?: boolean;
	entitlement?: HostedAccountEntitlement;
	error?: string;
	message?: string;
}

export function renderAccount(
	auth: AuthController,
	container: HTMLElement,
	state: AccountViewState,
	setState: (next: AccountViewState) => void,
): void {
	const user = auth.store.get().user;
	const picture = accountPicture(user);
	const provider: string = user?.app_metadata?.provider ?? "email";
	const { labels, language, timeZone } = pickersFor(container, setState);
	const focused =
		document.activeElement instanceof HTMLElement && container.contains(document.activeElement)
			? document.activeElement
			: null;
	const theme = themeChoices(() => setState({ error: t("Your browser could not save the theme preference.") }));
	const composerColor = composerColorChoices(() =>
		setState({ error: t("Your browser could not save the composer color preference.") }),
	);
	replace(
		container,
		h(
			"section",
			{ class: "page account" },
			h("h1", null, uiText("General")),
			state.error ? notice("danger", state.error) : null,
			state.message ? notice("ok", state.message) : null,
			h(
				"section",
				{ class: "settings-group" },
				h("h2", null, uiText("Account")),
				h(
					"div",
					{ class: "settings-card settings-account" },
					picture.picture,
					h(
						"div",
						{ class: "settings-copy" },
						h("strong", null, user?.email || displayName(user)),
						h(
							"small",
							null,
							provider === "email" ? t("Signed in with email") : t("Signed in with {provider}", { provider }),
						),
					),
					button(uiText("Sign out"), () => void auth.signOut()),
				),
				picture.error,
			),
			h(
				"section",
				{ class: "settings-group" },
				h("h2", null, uiText("Appearance")),
				h(
					"div",
					{ class: "settings-preference" },
					h(
						"span",
						{ class: "settings-copy" },
						uiText("Theme"),
						h("small", null, uiText("System follows your device’s appearance.")),
					),
					theme,
				),
				h(
					"div",
					{ class: "settings-preference" },
					h(
						"span",
						{ class: "settings-copy" },
						uiText("Composer color"),
						h("small", null, uiText("Send button, your message bubbles, and selected agent cards.")),
					),
					composerColor,
				),
			),
			h(
				"section",
				{ class: "settings-group" },
				h("h2", null, uiText("Language & region")),
				h(
					"div",
					{ class: "settings-rows" },
					h(
						"div",
						{ class: "settings-preference-row" },
						h(
							"label",
							{ class: "settings-copy", for: language.buttonId },
							h("span", { id: labels.language }, uiText("Language")),
						),
						language.el,
					),
					h(
						"div",
						{ class: "settings-preference-row" },
						h(
							"label",
							{ class: "settings-copy", for: timeZone.buttonId },
							h("span", { id: labels.timeZone }, uiText("Time zone")),
							h("small", null, uiText("Message times and new routines use this zone.")),
						),
						timeZone.el,
					),
				),
			),
		),
	);
	// The kept pickers moved into the new tree; give back the focus the move took.
	if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
}
