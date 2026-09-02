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
import { type AuthController, displayName } from "../auth.ts";

export interface AccountViewState {
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
	if (!state.entitlement && !state.error) {
		void api
			.getAccountEntitlement()
			.then((entitlement) => setState({ ...state, entitlement }))
			.catch((error) => setState({ ...state, error: describeError(error) }));
	}
	const override = readCloudConfigOverride();
	const projectInput = h("input", {
		type: "url",
		placeholder: DEFAULT_CLOUD_CONFIG.projectUrl,
		value: override?.projectUrl ?? "",
	});
	const keyInput = h("input", {
		type: "text",
		placeholder: "sb_publishable_…",
		value: override?.publishableKey ?? "",
	});
	const gatewayInput = h("input", {
		type: "url",
		placeholder: DEFAULT_CLOUD_CONFIG.objectGatewayUrl,
		value: override?.objectGatewayUrl ?? "",
	});
	const feedbackCategory = h(
		"select",
		null,
		...["bug", "bad-result", "good-result", "feature-request", "performance", "other"].map((category) =>
			h("option", { value: category }, category),
		),
	);
	const feedbackDetails = h("textarea", { rows: 3, placeholder: "What happened, what you expected." });
	replace(
		container,
		h(
			"section",
			{ class: "page account" },
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
				: h("div", { class: "muted" }, "Loading…"),
			h("h2", null, "Feedback"),
			h(
				"form",
				{
					class: "stack",
					onsubmit: (event: Event) => {
						event.preventDefault();
						void api
							.submitFeedback(crypto.randomUUID(), feedbackCategory.value, feedbackDetails.value.trim())
							.then(() => {
								feedbackDetails.value = "";
								setState({ ...state, message: "Thanks. Your feedback reached the cloud.", error: undefined });
							})
							.catch((error) => setState({ ...state, error: describeError(error) }));
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
					" reports which member RPCs, Realtime topics and gateway routes this browser can reach.",
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
}
