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
import { badge, button, fmtBytes, h, notice, replace } from "../../ui/dom.ts";
import { clearSubmittedDraft, preserveFormDrafts } from "../../ui/forms.ts";
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
		{ "data-draft": "feedback-category" },
		...["bug", "bad-result", "good-result", "feature-request", "performance", "other"].map((category) =>
			h("option", { value: category }, category),
		),
	);
	const feedbackDetails = h("textarea", {
		rows: 3,
		placeholder: "What happened, what you expected.",
		"data-draft": "feedback-details",
	});
	replace(
		container,
		h(
			"section",
			{ class: "page account", "data-form-owner": owner },
			h("h1", null, "Account"),
			state.error ? notice("danger", state.error) : null,
			state.message ? notice("ok", state.message) : null,
			h(
				"div",
				{ class: "card" },
				h(
					"div",
					{ class: "card-body" },
					h("strong", null, displayName(user)),
					h("div", { class: "muted" }, user?.email ?? ""),
					h("div", { class: "muted small" }, `Signed in with ${user?.app_metadata?.provider ?? "email"}`),
				),
				button("Sign out", () => void auth.signOut()),
			),
			h("h2", null, "Entitlement"),
			state.entitlement
				? h(
						"div",
						{ class: "summary-grid" },
						h(
							"div",
							{ class: "summary" },
							h("div", { class: "muted small" }, "Plan"),
							h("div", null, badge(state.entitlement.planKey, "accent")),
						),
						h(
							"div",
							{ class: "summary" },
							h("div", { class: "muted small" }, "Billing"),
							h("div", null, state.entitlement.billingMode),
						),
						h(
							"div",
							{ class: "summary" },
							h("div", { class: "muted small" }, "Features"),
							h("div", null, state.entitlement.featureSet),
						),
						h(
							"div",
							{ class: "summary" },
							h("div", { class: "muted small" }, "Storage"),
							h(
								"div",
								null,
								state.entitlement.storageAllocationBytes
									? fmtBytes(state.entitlement.storageAllocationBytes)
									: state.entitlement.storageAllocation,
							),
						),
					)
				: h("div", { class: "muted" }, state.loaded ? "Entitlement unavailable." : "Loading…"),
			h("h2", null, "Feedback"),
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
				h("div", { class: "row" }, h("button", { type: "submit", class: "btn" }, "Send feedback")),
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
