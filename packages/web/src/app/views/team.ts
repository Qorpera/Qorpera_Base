import type { CloudApi } from "../../cloud/api.ts";
import { describeError } from "../../cloud/client.ts";
import type { HostedProfileRole } from "../../cloud/types.ts";
import { badge, button, confirmDialog, fmtDate, h, notice, replace, spinner } from "../../ui/dom.ts";
import type { CompanyController } from "../company.ts";
import { navigate } from "../router.ts";

/* Membership (CLIENT-CONTRACT.md §2 "Accounts, profiles, membership"):
 * members and roles, invitations with delivery state, leave/delete. Roles are
 * cloud state; RLS is the second boundary, so a denied action shows as such. */

const ASSIGNABLE_ROLES: Exclude<HostedProfileRole, "owner">[] = ["viewer", "contributor", "admin"];

export function renderTeam(
	api: CloudApi,
	company: CompanyController,
	container: HTMLElement,
	feedback: { message?: string; error?: string },
	setFeedback: (next: { message?: string; error?: string }) => void,
): void {
	const state = company.store.get();
	const team = state.team;
	const profile = company.profile;
	const run = async (action: () => Promise<void>, done?: string) => {
		try {
			await action();
			await company.refreshTeam();
			setFeedback(done ? { message: done } : {});
		} catch (error) {
			setFeedback({ error: describeError(error) });
		}
	};
	const emailInput = h("input", { type: "email", placeholder: "colleague@company.com", required: true });
	const roleSelect = h(
		"select",
		null,
		...ASSIGNABLE_ROLES.map((role) => h("option", { value: role, selected: role === "contributor" }, role)),
	);
	const inviteForm = h(
		"form",
		{
			class: "row",
			onsubmit: (event: Event) => {
				event.preventDefault();
				const role = roleSelect.value as Exclude<HostedProfileRole, "owner">;
				void run(async () => {
					await api.inviteMember(profile.profileId, emailInput.value, role);
					emailInput.value = "";
				}, "Invitation created. Delivery runs in the cloud.");
			},
		},
		emailInput,
		roleSelect,
		h("button", { type: "submit", class: "btn btn-primary" }, "Invite"),
	);
	const children: (HTMLElement | null)[] = [h("h1", null, "Team")];
	if (feedback.error) children.push(notice("danger", feedback.error));
	if (feedback.message) children.push(notice("ok", feedback.message));
	if (!team) {
		children.push(
			state.accessLost ? notice("danger", "Your access to this company was revoked.") : spinner("Loading team"),
		);
	} else {
		children.push(
			h(
				"div",
				{ class: "muted" },
				`You are ${team.role === "owner" || team.role === "admin" ? "an" : "a"} ${team.role}. `,
				team.capabilities.authorize
					? "You can authorize and manage members."
					: team.capabilities.write
						? "You can read, write and converse."
						: "You can read.",
			),
			h("h2", null, `Members (${team.members.length})`),
			h(
				"table",
				{ class: "table" },
				h(
					"thead",
					null,
					h(
						"tr",
						null,
						h("th", null, "Member"),
						h("th", null, "Email"),
						h("th", null, "Role"),
						h("th", null, "Joined"),
						team.capabilities.manageMembers ? h("th", null, "") : null,
					),
				),
				h(
					"tbody",
					null,
					...team.members.map((member) => {
						const isSelf = member.userId === company.userId;
						const editable = team.capabilities.manageMembers && member.role !== "owner" && !isSelf;
						const select = h(
							"select",
							{
								disabled: !editable,
								onchange: () =>
									void run(
										() =>
											api.updateMemberRole(
												profile.profileId,
												member.userId,
												select.value as HostedProfileRole,
											),
										`${member.displayName} is now ${select.value}.`,
									),
							},
							...(["viewer", "contributor", "admin", "owner"] as const).map((role) =>
								h(
									"option",
									{
										value: role,
										selected: role === member.role,
										disabled: role === "owner" && member.role !== "owner",
									},
									role,
								),
							),
						);
						return h(
							"tr",
							null,
							h("td", null, member.displayName, isSelf ? [" ", badge("you", "accent")] : null),
							h("td", null, member.email),
							h("td", null, editable ? select : badge(member.role, "neutral")),
							h("td", null, fmtDate(member.joinedAt)),
							team.capabilities.manageMembers
								? h(
										"td",
										null,
										editable
											? button(
													"Remove",
													() =>
														void (async () => {
															if (
																await confirmDialog(
																	`Remove ${member.displayName} from ${profile.profileName}?`,
																	"Remove",
																	true,
																)
															)
																await run(
																	() => api.removeMember(profile.profileId, member.userId),
																	`${member.displayName} was removed.`,
																);
														})(),
													{ small: true, danger: true },
												)
											: null,
									)
								: null,
						);
					}),
				),
			),
			h("h2", null, `Invitations (${team.invitations.length})`),
			team.invitations.length
				? h(
						"table",
						{ class: "table" },
						h(
							"thead",
							null,
							h(
								"tr",
								null,
								h("th", null, "Email"),
								h("th", null, "Role"),
								h("th", null, "Delivery"),
								h("th", null, "Expires"),
								team.capabilities.manageMembers ? h("th", null, "") : null,
							),
						),
						h(
							"tbody",
							null,
							...team.invitations.map((invitation) =>
								h(
									"tr",
									null,
									h("td", null, invitation.email),
									h("td", null, badge(invitation.role, "neutral")),
									h(
										"td",
										null,
										invitation.delivery
											? [
													badge(
														invitation.delivery.status,
														invitation.delivery.status === "sent" ||
															invitation.delivery.status === "delivered"
															? "ok"
															: invitation.delivery.status === "failed"
																? "danger"
																: "neutral",
													),
													invitation.delivery.lastError
														? h("div", { class: "muted small" }, invitation.delivery.lastError)
														: null,
												]
											: "—",
									),
									h("td", null, fmtDate(invitation.expiresAt)),
									team.capabilities.manageMembers
										? h(
												"td",
												null,
												button(
													"Retry email",
													() =>
														void run(
															() => api.retryInvitationDelivery(profile.profileId, invitation.id),
															"Delivery retry queued.",
														),
													{ small: true },
												),
												" ",
												button(
													"Cancel",
													() =>
														void run(
															() => api.cancelInvitation(profile.profileId, invitation.id),
															"Invitation cancelled.",
														),
													{ small: true, danger: true },
												),
											)
										: null,
								),
							),
						),
					)
				: h("div", { class: "empty" }, "No pending invitations."),
			team.capabilities.manageMembers ? h("div", null, h("h3", null, "Invite a member"), inviteForm) : null,
			h("h2", null, "Danger zone"),
			h(
				"div",
				{ class: "row" },
				team.role !== "owner"
					? button(
							"Leave company",
							() =>
								void (async () => {
									if (
										await confirmDialog(
											`Leave ${profile.profileName}? You lose access until someone invites you again.`,
											"Leave",
											true,
										)
									) {
										try {
											await api.leaveProfile(profile.profileId);
											navigate({ name: "hub" });
										} catch (error) {
											setFeedback({ error: describeError(error) });
										}
									}
								})(),
							{ danger: true },
						)
					: button(
							"Delete company",
							() =>
								void (async () => {
									if (
										await confirmDialog(
											`Delete ${profile.profileName} for every member? This removes the cloud company. Type the company name to confirm.`,
											"Delete company",
											true,
											profile.profileName,
										)
									) {
										try {
											await api.deleteProfile(profile.profileId);
											navigate({ name: "hub" });
										} catch (error) {
											setFeedback({ error: describeError(error) });
										}
									}
								})(),
							{ danger: true },
						),
			),
		);
	}
	replace(container, h("section", { class: "page team" }, ...children));
}
