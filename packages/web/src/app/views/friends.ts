import type { CloudApi } from "../../cloud/api.ts";
import { describeError } from "../../cloud/client.ts";
import type { HostedFriend, HostedIncomingProfileInvitation } from "../../cloud/types.ts";
import { button, companyLogo, fmtDate, h, notice, personAvatar, replace } from "../../ui/dom.ts";
import { presentationLocale, presentationTimeZone, t, uiText } from "../../ui/preferences.ts";
import { listSkeleton } from "../../ui/skeleton.ts";
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

/** What the field holds, and whether it is an address a friend request can go to. */
function typed(state: FriendsState): { query: string; invitable: boolean } {
	const query = (state.query ?? "").trim().toLowerCase();
	return {
		query,
		invitable: EMAIL.test(query) && !state.friends.some((friend) => friend.email.toLowerCase() === query),
	};
}

/* One field does both jobs, as the desktop's invite popup does: it filters the
 * list, and when it holds an address it sends a friend request. The tab's parts
 * are built once per friends list: the heading, the notices, the field with its
 * button, and the results. A store update changes what they show in place, so
 * the field is never moved (a dead-key or IME composition and the caret
 * survive), and the results are rebuilt only when what they show has changed. */
interface FriendsParts {
	readonly page: HTMLElement;
	readonly title: HTMLElement;
	readonly notices: HTMLElement;
	readonly submit: HTMLButtonElement;
	readonly results: HTMLElement;
	/** The language the heading and the dates were drawn in. */
	locale: string;
	/** What the notices and the results last showed; a draw that changes neither leaves them alone. */
	said: string;
	shown: string;
}
const tabParts = new WeakMap<FriendsController, FriendsParts>();

function partsFor(friends: FriendsController): FriendsParts {
	let parts = tabParts.get(friends);
	if (!parts) {
		const input = h("input", {
			type: "text",
			placeholder: t("Search friends, or type an email to add someone"),
			autocomplete: "off",
			spellcheck: "false",
			"aria-label": t("Search friends, or type an email to add someone"),
		});
		// Every keystroke filters, composed text included; drawing never moves the field.
		input.addEventListener("input", () => friends.store.set({ query: input.value }));
		const send = (event: Event) => {
			event.preventDefault();
			const { query, invitable } = typed(friends.store.get());
			if (!invitable) return;
			void friends.request(query).then(() => {
				if (friends.store.get().error) return;
				input.value = "";
				friends.store.set({ query: "" });
			});
		};
		const title = h("h1");
		const notices = h("div");
		const submit = h("button", { type: "submit", class: "btn btn-primary" }, t("Send request"));
		const results = h("div");
		parts = {
			page: h(
				"section",
				{ class: "page friends" },
				title,
				h(
					"p",
					{ class: "settings-lead" },
					t("Invite friends into your companies. Invitations to join other companies show up here too."),
				),
				notices,
				h("div", { class: "panel" }, h("form", { class: "panel-search", onsubmit: send }, input, submit), results),
			),
			title,
			notices,
			submit,
			results,
			locale: "",
			said: "",
			shown: "",
		};
		tabParts.set(friends, parts);
	}
	return parts;
}

export function renderFriends(friends: FriendsController, hub: HubController, container: HTMLElement): void {
	const parts = partsFor(friends);
	// A tab shown again draws its results again: figures such as the company logos
	// stop while off the page, and the theme or size may have changed meanwhile.
	if (!parts.page.isConnected) parts.shown = "";
	if (parts.page.parentElement !== container) replace(container, parts.page);
	const state = friends.store.get();
	const companies = hub.store.get();
	const busy = (friend: HostedFriend) => state.busy === friend.userId;
	const { query, invitable } = typed(state);
	const matches = (...texts: string[]) => !query || texts.some((text) => text.toLowerCase().includes(query));
	const matching = state.friends.filter((friend) => matches(friend.displayName, friend.email));
	const incoming = matching.filter((friend) => friend.status === "pending" && friend.direction === "incoming");
	const outgoing = matching.filter((friend) => friend.status === "pending" && friend.direction === "outgoing");
	const accepted = matching.filter((friend) => friend.status === "accepted");
	const invitations = companies.invitations.filter((invitation) => matches(invitation.profileName));
	parts.submit.disabled = !invitable || state.sending === true;
	const label = state.sending ? t("Sending…") : t("Send request");
	if (parts.submit.textContent !== label) parts.submit.textContent = label;
	// The heading and dates are redrawn for a language chosen while this tab was hidden.
	const locale = presentationLocale();
	if (locale !== parts.locale) {
		parts.locale = locale;
		replace(parts.title, uiText("Friends"));
	}
	const companyError = companies.invitations.length ? companies.error : undefined;
	const said = JSON.stringify([companyError, state.error, state.message]);
	if (said !== parts.said) {
		parts.said = said;
		replace(
			parts.notices,
			companyError ? notice("danger", companyError) : null,
			state.error ? notice("danger", state.error) : null,
			state.message ? notice("ok", state.message) : null,
		);
	}
	const listed = incoming.length + outgoing.length + accepted.length > 0;
	const loading = !listed && state.loading && !state.loaded;
	const empty =
		listed || loading
			? null
			: query
				? invitable
					? t("Nobody here by that address. Send {email} a friend request.", { email: query })
					: t("Nobody here by that name.")
				: t("No friends yet. Add someone by their Qorpera email address.");
	// The dates follow a time zone chosen while this tab was hidden, too.
	const shown = JSON.stringify([
		locale,
		presentationTimeZone(),
		invitations.map((invitation) => [invitation, companies.busyInvitation === invitation.id]),
		[incoming, outgoing, accepted].map((list) => list.map((friend) => [friend, busy(friend)])),
		loading,
		empty,
	]);
	if (shown === parts.shown) return;
	parts.shown = shown;
	replace(
		parts.results,
		group(
			t("Company invitations"),
			invitations.map((invitation) => invitationRow(hub, invitation, companies.busyInvitation === invitation.id)),
		),
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
		loading ? listSkeleton(t("Loading friends")) : null,
		empty ? h("p", { class: "panel-empty muted" }, empty) : null,
	);
}
