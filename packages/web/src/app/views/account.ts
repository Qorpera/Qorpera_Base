import type { HostedAccountEntitlement } from "../../cloud/types.ts";
import { button, h, notice, replace } from "../../ui/dom.ts";
import { languagePreference, setLanguagePreference, uiText } from "../../ui/preferences.ts";
import { type AuthController, displayName } from "../auth.ts";
import { accountPicture } from "./account-picture.ts";
import { composerColorChoices, themeChoices } from "./appearance.ts";

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
	const language = h(
		"select",
		{ "aria-label": "Language" },
		h("option", { value: "system" }, "System default"),
		h("option", { value: "en" }, "English"),
		h("option", { value: "da" }, "Dansk"),
	);
	language.value = languagePreference();
	language.onchange = () => {
		if (!setLanguagePreference(language.value)) {
			language.value = languagePreference();
			setState({ error: "Your browser could not save the language preference." });
		}
	};
	const theme = themeChoices(() => setState({ error: "Your browser could not save the theme preference." }));
	const composerColor = composerColorChoices(() =>
		setState({ error: "Your browser could not save the composer color preference." }),
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
					accountPicture(user, (error) => setState({ error })),
					h(
						"div",
						{ class: "settings-copy" },
						h("strong", null, user?.email || displayName(user)),
						h("small", null, `Signed in with ${user?.app_metadata?.provider ?? "email"}`),
					),
					button(uiText("Sign out"), () => void auth.signOut()),
				),
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
					"label",
					{ class: "settings-preference-row" },
					h(
						"span",
						{ class: "settings-copy" },
						uiText("Language"),
						h("small", null, uiText("System default follows your browser’s language.")),
					),
					language,
				),
				h("p", { class: "settings-help" }, uiText("Some screens are still shown in English.")),
			),
		),
	);
}
