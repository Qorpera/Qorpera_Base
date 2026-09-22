import {
	DEFAULT_CLOUD_CONFIG,
	readCloudConfigOverride,
	WEB_CLIENT_MODE,
	WEB_CLIENT_VERSION,
	writeCloudConfigOverride,
} from "../../cloud/config.ts";
import type { HostedAccountEntitlement } from "../../cloud/types.ts";
import { button, h, notice, replace } from "../../ui/dom.ts";
import { preserveFormDrafts } from "../../ui/forms.ts";
import { languagePreference, setLanguagePreference, uiText } from "../../ui/preferences.ts";
import { type AuthController, displayName } from "../auth.ts";
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
	const owner = `account:${user?.id}`;
	const restoreDrafts = preserveFormDrafts(container, owner);
	const override = readCloudConfigOverride();
	const projectInput = h("input", {
		type: "url",
		placeholder: DEFAULT_CLOUD_CONFIG.projectUrl,
		value: override?.projectUrl ?? "",
		"data-draft": "project-url",
	});
	const keyInput = h("input", {
		type: "text",
		placeholder: "sb_publishable_…",
		value: override?.publishableKey ?? "",
		"data-draft": "project-key",
	});
	const gatewayInput = h("input", {
		type: "url",
		placeholder: DEFAULT_CLOUD_CONFIG.objectGatewayUrl,
		value: override?.objectGatewayUrl ?? "",
		"data-draft": "gateway-url",
	});
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
			{ class: "page account", "data-form-owner": owner },
			h("h1", null, uiText("General")),
			state.error ? notice("danger", state.error) : null,
			state.message ? notice("ok", state.message) : null,
			h(
				"section",
				{ class: "settings-group" },
				h("h2", null, uiText("Account")),
				h(
					"div",
					{ class: "settings-card" },
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
			h(
				"section",
				{ class: "settings-group" },
				h("h2", null, uiText("Companies")),
				h(
					"a",
					{ class: "settings-card settings-link", href: "#/" },
					h(
						"span",
						{ class: "settings-copy" },
						h("strong", null, uiText("All companies")),
						h("small", null, uiText("Open or create a company")),
					),
					h("span", { "aria-hidden": "true" }, "›"),
				),
			),
			h(
				"details",
				{ class: "advanced" },
				h("summary", null, "Cloud endpoint (advanced)"),
				h(
					"p",
					{ class: "muted small" },
					h("a", { href: "#/cloud-check" }, "Cloud check"),
					" checks member RPC signatures. It does not verify Realtime or object gateway access.",
				),
				h(
					"p",
					{ class: "muted small" },
					`Web client ${WEB_CLIENT_VERSION} (${WEB_CLIENT_MODE}). Point this browser at an isolated preview project instead of production. Only public values: project URL, publishable key, object gateway. Reloads the app.`,
				),
				h("label", null, "Project URL", projectInput),
				h("label", null, "Publishable key", keyInput),
				h("label", null, "Object gateway URL", gatewayInput),
				h(
					"div",
					{ class: "row" },
					button("Use these endpoints", () => {
						writeCloudConfigOverride({
							projectUrl: projectInput.value.trim(),
							publishableKey: keyInput.value.trim(),
							objectGatewayUrl: gatewayInput.value.trim(),
						});
						location.reload();
					}),
					override
						? button("Back to production", () => {
								writeCloudConfigOverride(undefined);
								location.reload();
							})
						: null,
				),
			),
		),
	);
	restoreDrafts();
}
