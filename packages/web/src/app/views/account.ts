import type { CloudApi } from "../../cloud/api.ts";
import { describeError } from "../../cloud/client.ts";
import {
	DEFAULT_CLOUD_CONFIG,
	readCloudConfigOverride,
	WEB_CLIENT_MODE,
	WEB_CLIENT_VERSION,
	writeCloudConfigOverride,
} from "../../cloud/config.ts";
import type { HostedAccountEntitlement } from "../../cloud/types.ts";
import { button, fmtBytes, h, notice, replace } from "../../ui/dom.ts";
import { clearSubmittedDraft, preserveFormDrafts } from "../../ui/forms.ts";
import { languagePreference, setLanguagePreference, uiText } from "../../ui/preferences.ts";
import { type AuthController, displayName } from "../auth.ts";

export interface AccountViewState {
	loading?: boolean;
	loaded?: boolean;
	entitlement?: HostedAccountEntitlement;
	error?: string;
	message?: string;
}

export function renderAccount(
	auth: AuthController,
	api: CloudApi,
	container: HTMLElement,
	state: AccountViewState,
	setState: (next: AccountViewState) => void,
): void {
	const user = auth.store.get().user;
	const owner = `account:${user?.id}`;
	const restoreDrafts = preserveFormDrafts(container, owner);
	const feedbackOpen = container.querySelector<HTMLDetailsElement>(".settings-feedback")?.open ?? false;
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
	const feedbackCategory = h(
		"select",
		{ "data-draft": "feedback-category", "aria-label": "Feedback category" },
		...["bug", "bad-result", "good-result", "feature-request", "performance", "other"].map((category) =>
			h("option", { value: category }, category),
		),
	);
	const feedbackDetails = h("textarea", {
		rows: 3,
		placeholder: "What happened, what you expected.",
		"data-draft": "feedback-details",
		"aria-label": "Feedback details",
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
	const entitlement = state.entitlement;
	const planName = entitlement
		? ({ internal: "Complimentary", freemium: "Freemium", pro: "Pro", team: "Team" }[entitlement.planKey] ??
			entitlement.planKey.replaceAll("_", " "))
		: state.loaded
			? "Plan unavailable"
			: "Loading…";
	const planDetail = entitlement
		? entitlement.storageAllocationBytes !== undefined
			? `${fmtBytes(entitlement.storageAllocationBytes)} company storage included`
			: entitlement.planKey === "internal"
				? "No active subscription"
				: "Storage allocation unavailable"
		: "";
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
				h("h2", null, uiText("Plan & billing")),
				h(
					"div",
					{ class: "settings-card settings-plan" },
					h(
						"div",
						{ class: "settings-copy" },
						h("small", { class: "settings-eyebrow" }, uiText("Current plan")),
						h("strong", null, planName),
						planDetail ? h("small", null, planDetail) : null,
					),
				),
			),
			h(
				"section",
				{ class: "settings-group" },
				h("h2", null, uiText("Appearance")),
				h(
					"label",
					{ class: "settings-preference-row" },
					uiText("Theme"),
					h("select", { "aria-label": "Theme" }, h("option", { value: "light" }, "Light")),
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
				{ class: "settings-feedback", open: feedbackOpen },
				h("summary", null, uiText("Share feedback")),
				h(
					"form",
					{
						class: "stack",
						onsubmit: (event: Event) => {
							event.preventDefault();
							const submitted = feedbackDetails.value;
							void api
								.submitFeedback(crypto.randomUUID(), feedbackCategory.value, feedbackDetails.value.trim())
								.then(() => {
									clearSubmittedDraft(container, owner, "feedback-details", submitted);
									setState({ message: "Your feedback reached the cloud.", error: undefined });
								})
								.catch((error) => setState({ error: describeError(error) }));
						},
					},
					h("div", { class: "row" }, feedbackCategory),
					feedbackDetails,
					h("div", { class: "row" }, h("button", { type: "submit", class: "btn" }, uiText("Send feedback"))),
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
