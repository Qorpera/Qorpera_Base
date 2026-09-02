import type { CloudApi } from "../../cloud/api.ts";
import { describeError } from "../../cloud/client.ts";
import type { HostedFriend } from "../../cloud/types.ts";
import { button, fmtDate, h, initials, notice, replace, spinner } from "../../ui/dom.ts";
import { Store } from "../state.ts";

/* Friends: the account's address book. A company invitation can only reach
 * someone this account is already friends with (the desktop enforces the same
 * rule), so this page is where that list is grown. Four RPCs, nothing else:
 * qorpera_list_friends, _send_friend_request, _respond_friend_request,
 * _remove_friend. */

export interface FriendsState {
	loading: boolean;
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

	constructor(api: CloudApi) {
		this.#api = api;
	}

	async refresh(): Promise<void> {
		this.store.set({ loading: true, error: undefined });
		try {
			this.store.set({ friends: await this.#api.listFriends(), loading: false });
		} catch (error) {
			this.store.set({ loading: false, error: describeError(error) });
		}
	}

	async request(email: string): Promise<void> {
		const address = email.trim().toLowerCase();
		if (!address) return;
		this.store.set({ sending: true, error: undefined, message: undefined });
		try {
			await this.#api.sendFriendRequest(address);
			await this.refresh();
			this.store.set({ message: `Request sent to ${address}.` });
		} catch (error) {
			this.store.set({ error: describeError(error) });
		} finally {
			this.store.set({ sending: false });
		}
	}

	async respond(friend: HostedFriend, accept: boolean): Promise<void> {
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
		h("span", { class: "person-chip", "aria-hidden": "true" }, initials(friend.displayName)),
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

function group(title: string, rows: HTMLElement[]): HTMLElement | null {
	return rows.length
		? h("div", { class: "panel-group" }, h("div", { class: "panel-group-title" }, title), ...rows)
		: null;
}

/* One field does both jobs, as the desktop's invite popup does: it filters the
 * list, and when it holds an address it sends a friend request. The element
 * outlives re-renders so typing never loses the caret. */
let searchField: HTMLInputElement | undefined;

function field(friends: FriendsController): HTMLInputElement {
	if (!searchField) {
		searchField = h("input", {
			type: "text",
			placeholder: "Search friends, or type an email to add someone",
			autocomplete: "off",
			spellcheck: "false",
			"aria-label": "Search friends, or type an email to add someone",
			oninput: () => friends.store.set({ query: searchField?.value ?? "" }),
		});
	}
	return searchField;
}

export function renderFriends(friends: FriendsController, container: HTMLElement): void {
	const state = friends.store.get();
	const busy = (friend: HostedFriend) => state.busy === friend.userId;
	const query = (state.query ?? "").trim().toLowerCase();
	const matches = (friend: HostedFriend) =>
		!query || friend.displayName.toLowerCase().includes(query) || friend.email.toLowerCase().includes(query);
	const shown = state.friends.filter(matches);
	const incoming = shown.filter((friend) => friend.status === "pending" && friend.direction === "incoming");
	const outgoing = shown.filter((friend) => friend.status === "pending" && friend.direction === "outgoing");
	const accepted = shown.filter((friend) => friend.status === "accepted");
	const search = field(friends);
	const invitable = EMAIL.test(query) && !state.friends.some((friend) => friend.email.toLowerCase() === query);
	const send = () => {
		if (!invitable) return;
		void friends.request(query).then(() => {
			search.value = "";
			friends.store.set({ query: "" });
		});
	};
	const groups = [
		group(
			"Requests for you",
			incoming.map((friend) =>
				personRow(
					friend,
					`asked ${fmtDate(friend.since)}`,
					button("Decline", () => void friends.respond(friend, false), { disabled: busy(friend) }),
					button("Accept", () => void friends.respond(friend, true), { primary: true, disabled: busy(friend) }),
				),
			),
		),
		group(
			"Sent",
			outgoing.map((friend) =>
				personRow(
					friend,
					`sent ${fmtDate(friend.since)}`,
					button("Cancel", () => void friends.remove(friend), { disabled: busy(friend) }),
				),
			),
		),
		group(
			`Friends${accepted.length ? ` (${accepted.length})` : ""}`,
			accepted.map((friend) =>
				personRow(
					friend,
					`since ${fmtDate(friend.since)}`,
					button("Remove", () => void friends.remove(friend), { disabled: busy(friend) }),
				),
			),
		),
	].filter(Boolean) as HTMLElement[];
	const empty = state.loading
		? spinner("Loading friends")
		: h(
				"p",
				{ class: "panel-empty muted" },
				query
					? invitable
						? `Nobody here by that address. Send ${query} a friend request.`
						: "Nobody here by that name."
					: "Nobody yet. Add someone by their Qorpera email address.",
			);
	replace(
		container,
		h(
			"section",
			{ class: "page account-page" },
			h("h1", null, "Friends"),
			h(
				"p",
				{ class: "page-lead" },
				"People you can invite into a company. An invitation only reaches an account you are already friends with.",
			),
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
						{ type: "submit", class: "hub-create-submit", disabled: !invitable || state.sending === true },
						state.sending ? "Sending…" : "Send request",
					),
				),
				...(groups.length ? groups : [empty]),
			),
		),
	);
}
