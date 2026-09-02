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

export function renderFriends(friends: FriendsController, container: HTMLElement): void {
	const state = friends.store.get();
	const busy = (friend: HostedFriend) => state.busy === friend.userId;
	const incoming = state.friends.filter((friend) => friend.status === "pending" && friend.direction === "incoming");
	const outgoing = state.friends.filter((friend) => friend.status === "pending" && friend.direction === "outgoing");
	const accepted = state.friends.filter((friend) => friend.status === "accepted");
	const emailInput = h("input", {
		type: "email",
		placeholder: "name@company.com",
		autocomplete: "email",
		required: true,
		disabled: state.sending === true,
		"aria-label": "Email address",
	});
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
				"form",
				{
					class: "person-add",
					onsubmit: (event: Event) => {
						event.preventDefault();
						const address = emailInput.value;
						void friends.request(address).then(() => {
							emailInput.value = "";
						});
					},
				},
				emailInput,
				h(
					"button",
					{ type: "submit", class: "hub-create-submit", disabled: state.sending === true },
					state.sending ? "Sending…" : "Send request",
				),
			),
			state.loading && !state.friends.length ? spinner("Loading friends") : null,
			incoming.length
				? h(
						"div",
						{ class: "person-section" },
						h("h2", null, "Requests for you"),
						h(
							"div",
							{ class: "person-list" },
							...incoming.map((friend) =>
								personRow(
									friend,
									`asked ${fmtDate(friend.since)}`,
									button("Decline", () => void friends.respond(friend, false), { disabled: busy(friend) }),
									button("Accept", () => void friends.respond(friend, true), {
										primary: true,
										disabled: busy(friend),
									}),
								),
							),
						),
					)
				: null,
			outgoing.length
				? h(
						"div",
						{ class: "person-section" },
						h("h2", null, "Sent"),
						h(
							"div",
							{ class: "person-list" },
							...outgoing.map((friend) =>
								personRow(
									friend,
									`sent ${fmtDate(friend.since)}`,
									button("Cancel", () => void friends.remove(friend), { disabled: busy(friend) }),
								),
							),
						),
					)
				: null,
			h(
				"div",
				{ class: "person-section" },
				h("h2", null, `Friends${accepted.length ? ` (${accepted.length})` : ""}`),
				accepted.length
					? h(
							"div",
							{ class: "person-list" },
							...accepted.map((friend) =>
								personRow(
									friend,
									`since ${fmtDate(friend.since)}`,
									button("Remove", () => void friends.remove(friend), { disabled: busy(friend) }),
								),
							),
						)
					: state.loading
						? null
						: h("p", { class: "muted" }, "Nobody yet. Add someone by their Qorpera email address."),
			),
		),
	);
}
