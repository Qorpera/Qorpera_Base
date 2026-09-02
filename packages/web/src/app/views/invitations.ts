import { button, companyAvatar, fmtDate, h, notice, replace, spinner } from "../../ui/dom.ts";
import type { HubController } from "./hub.ts";

/* Invitations: every company waiting for this account. The same cloud state
 * the hub reads (qorpera_list_profile_invitations), given its own page so the
 * account menu can carry a count. Accepting opens the company. */

export function renderInvitations(hub: HubController, container: HTMLElement): void {
	const state = hub.store.get();
	replace(
		container,
		h(
			"section",
			{ class: "page account-page" },
			h("h1", null, "Invitations"),
			h("p", { class: "page-lead" }, "Companies that invited you. Accepting adds you with the role you were given."),
			state.error ? notice("danger", state.error) : null,
			state.loading && !state.invitations.length
				? spinner("Loading invitations")
				: state.invitations.length
					? h(
							"div",
							{ class: "person-list" },
							...state.invitations.map((invitation) =>
								h(
									"div",
									{ class: "person-row" },
									companyAvatar(invitation.profileId, "person-company"),
									h(
										"div",
										{ class: "person-copy" },
										h("strong", null, invitation.profileName),
										h(
											"span",
											{ class: "muted small" },
											`As ${invitation.role} · expires ${fmtDate(invitation.expiresAt)}`,
										),
									),
									h(
										"div",
										{ class: "person-actions" },
										button("Decline", () => void hub.respondInvitation(invitation, false), {
											disabled: state.busyInvitation === invitation.id,
										}),
										button("Accept", () => void hub.respondInvitation(invitation, true), {
											primary: true,
											disabled: state.busyInvitation === invitation.id,
										}),
									),
								),
							),
						)
					: h(
							"p",
							{ class: "muted" },
							"Nothing waiting. An invitation appears here the moment someone adds you to their company.",
						),
		),
	);
}
