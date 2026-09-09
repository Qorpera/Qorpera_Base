import type { CloudApi } from "../../cloud/api.ts";
import { describeError } from "../../cloud/client.ts";
import type { HostedFriend, HostedProfileRole } from "../../cloud/types.ts";
import { button, confirmDialog, h, notice, personAvatar, replace, spinner } from "../../ui/dom.ts";
import { preserveFormDrafts } from "../../ui/forms.ts";
import type { CompanyController } from "../company.ts";

const ROLES: Exclude<HostedProfileRole, "owner">[] = ["viewer", "contributor", "admin"];

export function renderTeam(
	api: CloudApi,
	company: CompanyController,
	container: HTMLElement,
	feedback: { message?: string; error?: string },
	setFeedback: (next: { message?: string; error?: string }) => void,
	options: {
		friends?: HostedFriend[];
		signal?: AbortSignal;
		embedded?: boolean;
		onCompanyRemoved: (profileId: string) => void;
	},
): void {
	const state = company.store.get();
	const team = state.team;
	const profile = company.profile;
	const owner = `team:${profile.profileId}:${company.userId}`;
	const restore = preserveFormDrafts(container, owner);
	const openDetails = [...container.querySelectorAll("details[open]")].map(
		(details) => details.querySelector("summary")?.textContent,
	);
	const signal = options.signal ? AbortSignal.any([company.signal, options.signal]) : company.signal;
	const route = location.hash;
	const current = () => !signal.aborted && location.hash === route;
	const run = async (action: () => Promise<unknown>, message?: string) => {
		if (!current()) return;
		try {
			await action();
			if (!current()) return;
			await company.refreshTeam();
			if (current()) setFeedback({ message });
		} catch (error) {
			if (current()) setFeedback({ error: describeError(error) });
		}
	};
	const content = h(
		"section",
		{ class: "page team", "data-form-owner": owner },
		options.embedded ? null : h("h1", null, "Team"),
		feedback.error ? notice("danger", feedback.error) : null,
		feedback.message ? notice("ok", feedback.message) : null,
		state.error && !state.accessLost
			? notice(
					"danger",
					state.error,
					button(
						"Retry company",
						() => {
							if (current() && !company.store.get().loading) void company.refreshAll();
						},
						{ disabled: state.loading },
					),
				)
			: null,
	);
	if (!team) {
		if (state.accessLost) content.append(notice("danger", "Your access to this company was revoked."));
		else if (!state.error) content.append(spinner("Loading team"));
	} else {
		const people = h("div", { class: "company-people", "aria-label": "Company members" });
		for (const member of team.members) {
			const editable =
				team.capabilities.manageMembers &&
				member.role !== "owner" &&
				(team.role === "owner" || member.role !== "admin") &&
				member.userId !== company.userId;
			const select = h(
				"select",
				{ "aria-label": `Role for ${member.displayName}`, disabled: !editable },
				...ROLES.filter((role) => role !== "admin" || team.role === "owner").map((role) =>
					h("option", { value: role, selected: role === member.role }, role),
				),
			);
			select.onchange = () => {
				const role = select.value as HostedProfileRole;
				select.disabled = true;
				void run(
					() => api.updateMemberRole(profile.profileId, member.userId, role),
					`${member.displayName} is now ${role}.`,
				);
			};
			people.append(
				h(
					"div",
					{ class: "company-person", title: `${member.email} · ${member.role}` },
					personAvatar(member.displayName, member.userId),
					h(
						"div",
						{ class: "settings-copy" },
						h("strong", null, member.displayName),
						h("small", null, member.role === "owner" ? "Started it" : "Building"),
					),
					editable
						? h(
								"div",
								{ class: "person-actions" },
								select,
								button(
									"Remove",
									() =>
										void (async () => {
											if (
												await confirmDialog(
													`Remove ${member.displayName} from ${profile.profileName}?`,
													"Remove",
													true,
													undefined,
													signal,
												)
											)
												await run(
													() => api.removeMember(profile.profileId, member.userId),
													`${member.displayName} was removed.`,
												);
										})(),
									{ small: true, danger: true },
								),
							)
						: null,
				),
			);
		}
		for (const invitation of team.invitations) {
			people.append(
				h(
					"div",
					{ class: "company-person", title: invitation.delivery?.lastError ?? invitation.role },
					personAvatar(invitation.email, invitation.email),
					h(
						"div",
						{ class: "settings-copy" },
						h("strong", null, invitation.email),
						h("small", null, invitation.delivery?.status === "failed" ? "Invited · email failed" : "Invited"),
					),
					team.capabilities.manageMembers
						? h(
								"div",
								{ class: "person-actions" },
								invitation.delivery?.status === "failed"
									? button(
											"Retry email",
											() =>
												void run(
													() => api.retryInvitationDelivery(profile.profileId, invitation.id),
													"Delivery retry queued.",
												),
											{ small: true },
										)
									: null,
								button(
									"Cancel",
									() =>
										void run(
											() => api.cancelInvitation(profile.profileId, invitation.id),
											"Invitation cancelled.",
										),
									{ small: true },
								),
							)
						: null,
				),
			);
		}
		content.append(people);
		if (team.capabilities.manageMembers) {
			const picker = h(
				"details",
				{ class: "company-invite" },
				h(
					"summary",
					null,
					h("span", { class: "person-avatar invite-plus", "aria-hidden": "true" }, "+"),
					h(
						"span",
						{ class: "settings-copy" },
						h("strong", null, "Invite a friend"),
						h("small", null, "Pick from your friends or add someone first"),
					),
				),
			);
			const choices = options.friends?.filter(
				(friend) =>
					friend.status === "accepted" &&
					!team.members.some((member) => member.userId === friend.userId) &&
					!team.invitations.some((invitation) => invitation.email.toLowerCase() === friend.email.toLowerCase()),
			);
			const invitee = h("input", {
				type: "email",
				placeholder: "Friend’s email",
				"aria-label": "Friend’s email",
				required: true,
				"data-draft": "invite-email",
			});
			const search = h("input", {
				type: "search",
				placeholder: "Search friends",
				"aria-label": "Search friends to invite",
				"data-draft": "invite-search",
			});
			const results = h("div", { class: "invite-results", "aria-label": "Friends to invite" });
			const drawFriends = () => {
				const query = search.value.trim().toLowerCase();
				const matching = choices?.filter((friend) =>
					`${friend.displayName} ${friend.email}`.toLowerCase().includes(query),
				);
				replace(
					results,
					...(matching ?? []).map((friend) =>
						h(
							"button",
							{
								type: "button",
								class: "invite-friend",
								onclick: () => {
									invitee.value = friend.email;
									invitee.focus();
								},
							},
							personAvatar(friend.displayName, friend.userId),
							h(
								"span",
								{ class: "settings-copy" },
								h("strong", null, friend.displayName),
								h("small", null, friend.email),
							),
						),
					),
					!matching?.length
						? h(
								"p",
								{ class: "muted small" },
								choices
									? "No matching friends."
									: "Your friends could not be loaded. Enter an existing friend’s email below.",
							)
						: null,
				);
			};
			search.oninput = drawFriends;
			queueMicrotask(drawFriends);
			const role = h(
				"select",
				{ "aria-label": "Invitation role", "data-draft": "invite-role" },
				...ROLES.filter((value) => value !== "admin" || team.role === "owner").map((value) =>
					h("option", { value, selected: value === "contributor" }, value),
				),
			);
			const submit = h("button", { type: "submit", class: "btn" }, "Invite");
			picker.append(
				h(
					"div",
					{ class: "invite-picker" },
					search,
					results,
					h(
						"form",
						{
							class: "row",
							onsubmit: (event: Event) => {
								event.preventDefault();
								if (!invitee.value || submit.disabled) return;
								submit.disabled = true;
								void run(
									() =>
										api.inviteMember(
											profile.profileId,
											invitee.value,
											role.value as Exclude<HostedProfileRole, "owner">,
										),
									"Invitation created.",
								);
							},
						},
						invitee,
						role,
						submit,
					),
					h("a", { href: "#/friends" }, "Add a friend"),
				),
			);
			content.append(picker);
		}
		content.append(
			h(
				"details",
				{ class: "advanced company-danger" },
				h("summary", null, "Manage company"),
				button(
					team.role === "owner" ? "Delete company" : "Leave company",
					() =>
						void (async () => {
							const deleting = team.role === "owner";
							const confirmed = await confirmDialog(
								deleting
									? `Delete ${profile.profileName} for every member? Type the company name to confirm.`
									: `Leave ${profile.profileName}? You lose access until someone invites you again.`,
								deleting ? "Delete company" : "Leave",
								true,
								deleting ? profile.profileName : undefined,
								signal,
							);
							if (!confirmed || !current()) return;
							try {
								if (deleting) await api.deleteProfile(profile.profileId);
								else await api.leaveProfile(profile.profileId);
								// Membership revocation may stop this company before the RPC returns.
								options.onCompanyRemoved(profile.profileId);
							} catch (error) {
								if (current()) setFeedback({ error: describeError(error) });
							}
						})(),
					{ danger: true },
				),
			),
		);
	}
	replace(container, content);
	for (const details of container.querySelectorAll("details"))
		details.open = openDetails.includes(details.querySelector("summary")?.textContent);
	restore();
}
