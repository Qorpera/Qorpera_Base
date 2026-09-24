import type { CloudApi } from "../../cloud/api.ts";
import { describeError } from "../../cloud/client.ts";
import type { HostedFriend, HostedIncomingProfileInvitation } from "../../cloud/types.ts";
import { button, companyLogo, fmtDate, h, notice, personAvatar, replace, spinner } from "../../ui/dom.ts";
import { t, uiText } from "../../ui/preferences.ts";
import { Store } from "../state.ts";
import type { HubController } from "./hub.ts";
import { roleLabel } from "./team.ts";

/* Friends: the account's address book, and the company invitations waiting
 * for it. A company invitation can only reach someone this account is already
 * friends with (the desktop enforces the same rule), so this tab is where that
 * list is grown. Four RPCs, nothing else: qorpera_list_friends,
 * _send_friend_request, _respond_friend_request, _remove_friend. Invitations
 * are the hub's state (qorpera_list_profile_invitations); accepting one opens
 * the company. */

export interface FriendsState {
	loading: boolean;
	/** The list has been read once, so an empty list means no friends. */
	loaded?: boolean;
	friends: HostedFriend[];
	error?: string;
	message?: string;
	busy?: string;
	sending?: boolean;
	/** What is typed in the one field: a filter, or an address to invite. */
	query?: string;
}

export class FriendsController {
	readonly store = new Store<FriendsState>({ loading: true, friends: [] });
	readonly #api: CloudApi;
	#disposed = false;

	constructor(api: CloudApi) {
		this.#api = api;
	}

	dispose(): void {
		this.#disposed = true;
		this.store.dispose();
	}

	async refresh(): Promise<void> {
		if (this.#disposed) return;
		this.store.set({ loading: true, error: undefined });
		try {
			this.store.set({ friends: await this.#api.listFriends(), loading: false, loaded: true });
		} catch (error) {
			this.store.set({ loading: false, error: describeError(error) });
		}
	}

	async request(email: string): Promise<void> {
		if (this.#disposed || this.store.get().sending) return;
		const address = email.trim().toLowerCase();
		if (!address) return;
		this.store.set({ sending: true, error: undefined, message: undefined });
		try {
			await this.#api.sendFriendRequest(address);
			await this.refresh();
			this.store.set({ message: t("Request sent to {email}.", { email: address }) });
		} catch (error) {
			this.store.set({ error: describeError(error) });
		} finally {
			this.store.set({ sending: false });
		}
	}

	async respond(friend: HostedFriend, accept: boolean): Promise<void> {
		if (this.#disposed) return;
		this.store.set({ busy: friend.userId, error: undefined, message: undefined });
		try {
			await this.#api.respondFriendRequest(friend.userId, accept);
			await this.refresh();
		} catch (error) {
			this.store.set({ error: describeError(error) });
		} finally {
			this.store.set({ busy: undefined });
		}
	}

	async remove(friend: HostedFriend): Promise<void> {
		if (this.#disposed) return;
		this.store.set({ busy: friend.userId, error: undefined, message: undefined });
		try {
			await this.#api.removeFriend(friend.userId);
			await this.refresh();
		} catch (error) {
			this.store.set({ error: describeError(error) });
		} finally {
			this.store.set({ busy: undefined });
		}
	}
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function personRow(friend: HostedFriend, meta: string, ...actions: HTMLElement[]): HTMLElement {
	return h(
		"div",
		{ class: "person-row" },
		personAvatar(friend.displayName, friend.userId),
		h(
			"div",
			{ class: "person-copy" },
			h("strong", null, friend.displayName),
			h("span", { class: "muted small" }, friend.email),
		),
		h("span", { class: "muted small person-meta" }, meta),
		h("div", { class: "person-actions" }, ...actions),
	);
}

function invitationRow(hub: HubController, invitation: HostedIncomingProfileInvitation, busy: boolean): HTMLElement {
	return h(
		"div",
		{ class: "person-row" },
		companyLogo(invitation.profileId, "person-company"),
		h(
			"div",
			{ class: "person-copy" },
			h("strong", null, invitation.profileName),
			h(
				"span",
				{ class: "muted small" },
				t("Invited as {role} · expires {date}", {
					role: roleLabel(invitation.role),
					date: fmtDate(invitation.expiresAt),
				}),
			),
		),
		h(
			"div",
			{ class: "person-actions" },
			button(t("Decline"), () => void hub.respondInvitation(invitation, false), { disabled: busy }),
			button(t("Accept"), () => void hub.respondInvitation(invitation, true), { primary: true, disabled: busy }),
		),
	);
}

function group(title: string, rows: HTMLElement[]): HTMLElement | null {
	return rows.length
		? h("div", { class: "panel-group" }, h("div", { class: "panel-group-title" }, title), ...rows)
		: null;
}

/* One field does both jobs, as the desktop's invite popup does: it filters the
 * list, and when it holds an address it sends a friend request. The element
 * outlives re-renders so typing never loses the caret. */
const fields = new WeakMap<FriendsController, HTMLInputElement>();

function field(friends: FriendsController): HTMLInputElement {
	let searchField = fields.get(friends);
	if (!searchField) {
		searchField = h("input", {
			type: "text",
			placeholder: t("Search friends, or type an email to add someone"),
			autocomplete: "off",
			spellcheck: "false",
			"aria-label": t("Search friends, or type an email to add someone"),
			oninput: () => friends.store.set({ query: searchField?.value ?? "" }),
		});
		fields.set(friends, searchField);
	}
	return searchField;
}

export function renderFriends(friends: FriendsController, hub: HubController, container: HTMLElement): void {
	const state = friends.store.get();
	const companies = hub.store.get();
	const busy = (friend: HostedFriend) => state.busy === friend.userId;
	const query = (state.query ?? "").trim().toLowerCase();
	const matches = (...texts: string[]) => !query || texts.some((text) => text.toLowerCase().includes(query));
	const shown = state.friends.filter((friend) => matches(friend.displayName, friend.email));
	const incoming = shown.filter((friend) => friend.status === "pending" && friend.direction === "incoming");
	const outgoing = shown.filter((friend) => friend.status === "pending" && friend.direction === "outgoing");
	const accepted = shown.filter((friend) => friend.status === "accepted");
	const search = field(friends);
	const invitable = EMAIL.test(query) && !state.friends.some((friend) => friend.email.toLowerCase() === query);
	const send = () => {
		if (!invitable) return;
		void friends.request(query).then(() => {
			if (friends.store.get().error) return;
			search.value = "";
			friends.store.set({ query: "" });
		});
	};
	const invitations = group(
		t("Company invitations"),
		companies.invitations
			.filter((invitation) => matches(invitation.profileName))
			.map((invitation) => invitationRow(hub, invitation, companies.busyInvitation === invitation.id)),
	);
	const groups = [
		group(
			t("Requests for you"),
			incoming.map((friend) =>
				personRow(
					friend,
					t("asked {date}", { date: fmtDate(friend.since) }),
					button(t("Decline"), () => void friends.respond(friend, false), { disabled: busy(friend) }),
					button(t("Accept"), () => void friends.respond(friend, true), { primary: true, disabled: busy(friend) }),
				),
			),
		),
		group(
			t("Sent"),
			outgoing.map((friend) =>
				personRow(
					friend,
					t("sent {date}", { date: fmtDate(friend.since) }),
					button(t("Cancel"), () => void friends.remove(friend), { disabled: busy(friend) }),
				),
			),
		),
		group(
			accepted.length ? t("Friends ({count})", { count: accepted.length }) : t("Friends"),
			accepted.map((friend) =>
				personRow(
					friend,
					t("since {date}", { date: fmtDate(friend.since) }),
					button(t("Remove"), () => void friends.remove(friend), { disabled: busy(friend) }),
				),
			),
		),
	].filter(Boolean) as HTMLElement[];
	const empty = groups.length
		? null
		: state.loading && !state.loaded
			? spinner(t("Loading friends"))
			: h(
					"p",
					{ class: "panel-empty muted" },
					query
						? invitable
							? t("Nobody here by that address. Send {email} a friend request.", { email: query })
							: t("Nobody here by that name.")
						: t("No friends yet. Add someone by their Qorpera email address."),
				);
	// Replacing the container detaches the field, and a detached element loses
	// focus, so the caret is put back exactly where the typist left it.
	const typing = document.activeElement === search;
	const caret: [number, number] = [search.selectionStart ?? 0, search.selectionEnd ?? 0];
	replace(
		container,
		h(
			"section",
			{ class: "page friends" },
			h("h1", null, uiText("Friends")),
			h(
				"p",
				{ class: "settings-lead" },
				t("Invite friends into your companies. Invitations to join other companies show up here too."),
			),
			companies.error && companies.invitations.length ? notice("danger", companies.error) : null,
			state.error ? notice("danger", state.error) : null,
			state.message ? notice("ok", state.message) : null,
			h(
				"div",
				{ class: "panel" },
				h(
					"form",
					{
						class: "panel-search",
						onsubmit: (event: Event) => {
							event.preventDefault();
							send();
						},
					},
					search,
					h(
						"button",
						{ type: "submit", class: "btn btn-primary", disabled: !invitable || state.sending === true },
						state.sending ? t("Sending…") : t("Send request"),
					),
				),
				invitations,
				...groups,
				empty,
			),
		),
	);
	if (typing) {
		search.focus();
		search.setSelectionRange(caret[0], caret[1]);
	}
}
