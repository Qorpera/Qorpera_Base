import type { CloudApi } from "../../cloud/api.ts";
import { CloudRpcError, describeError } from "../../cloud/client.ts";
import type { HostedAccountMatch, HostedFriend, HostedIncomingProfileInvitation } from "../../cloud/types.ts";
import { button, companyLogo, fmtDate, h, notice, personAvatar, replace } from "../../ui/dom.ts";
import { presentationLocale, presentationTimeZone, t, uiText } from "../../ui/preferences.ts";
import { listSkeleton } from "../../ui/skeleton.ts";
import { Store } from "../state.ts";
import type { HubController } from "./hub.ts";
import { roleLabel } from "./team.ts";

/* Friends: the account's address book, and the company invitations waiting
 * for it. A company invitation can only reach someone this account is already
 * friends with (the desktop enforces the same rule), so this tab is where that
 * list is grown. Five RPCs, nothing else: qorpera_list_friends,
 * _find_account_by_email, _send_friend_request, _respond_friend_request,
 * _remove_friend. A typed address shows a person to add only when an account
 * has confirmed that address; any other address finds nobody. Invitations
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
	/** What the typed address found, while the field holds a whole address that is
	 * no friend's: `account` is undefined while it is being checked, null when no
	 * account holds the address. */
	lookup?: AddressLookup;
	/** This cloud cannot look addresses up yet: any address may be sent a request,
	 * and the cloud refuses one no account holds. */
	lookupMissing?: boolean;
}

export interface AddressLookup {
	address: string;
	account?: HostedAccountMatch | null;
	failed?: string;
}

/** How long typing pauses before a whole address is looked up. */
const LOOKUP_DELAY_MS = 250;
/** How long "no account holds it" is trusted: its owner may confirm the address meanwhile. */
const NO_ACCOUNT_KEPT_MS = 60_000;

export class FriendsController {
	readonly store = new Store<FriendsState>({ loading: true, friends: [] });
	readonly #api: CloudApi;
	#disposed = false;
	/** Addresses already looked up, what each found, and when. */
	readonly #found = new Map<string, { account: HostedAccountMatch | null; at: number }>();
	/** Lookups on their way, so an address typed again waits for the same answer. */
	readonly #asking = new Map<string, Promise<HostedAccountMatch | null>>();
	#lookupTimer: ReturnType<typeof setTimeout> | undefined;
	#lookupTurn = 0;

	constructor(api: CloudApi) {
		this.#api = api;
	}

	dispose(): void {
		this.#disposed = true;
		clearTimeout(this.#lookupTimer);
		this.store.dispose();
	}

	/** Takes what is typed in the field. A whole address that is no friend's is
	 * looked up once typing pauses; only the answer for what the field holds now
	 * is shown. */
	type(query: string): void {
		void this.#take(query, false);
	}

	/** Looks the typed address up at once (Enter before the answer came, or Try
	 * again after a failure); resolves when its answer is shown. */
	lookUpNow(): Promise<void> {
		return this.#take(this.store.get().query ?? "", true);
	}

	#take(query: string, now: boolean): Promise<void> {
		if (this.#disposed) return Promise.resolve();
		clearTimeout(this.#lookupTimer);
		const turn = ++this.#lookupTurn;
		const state = this.store.get();
		const address = query.trim().toLowerCase();
		if (!EMAIL.test(address) || state.lookupMissing || isFriend(state, address)) {
			this.store.set({ query, lookup: undefined });
			return Promise.resolve();
		}
		const answer = this.#found.get(address);
		if (answer && (answer.account || Date.now() - answer.at < NO_ACCOUNT_KEPT_MS)) {
			this.store.set({ query, lookup: { address, account: answer.account } });
			return Promise.resolve();
		}
		this.store.set({ query, lookup: { address } });
		if (now || this.#asking.has(address)) return this.#lookUp(address, turn);
		this.#lookupTimer = setTimeout(() => void this.#lookUp(address, turn), LOOKUP_DELAY_MS);
		return Promise.resolve();
	}

	async #lookUp(address: string, turn: number): Promise<void> {
		let asking = this.#asking.get(address);
		if (!asking) {
			asking = this.#api.findAccountByEmail(address);
			this.#asking.set(address, asking);
			// Answers are kept; failures are not, so the address is asked again.
			void asking
				.then(
					(account) => void this.#found.set(address, { account, at: Date.now() }),
					() => {},
				)
				.finally(() => this.#asking.delete(address));
		}
		try {
			const account = await asking;
			if (!this.#disposed && turn === this.#lookupTurn) this.store.set({ lookup: { address, account } });
		} catch (error) {
			if (this.#disposed || turn !== this.#lookupTurn) return;
			if (error instanceof CloudRpcError && error.missing)
				this.store.set({ lookupMissing: true, lookup: undefined });
			else this.store.set({ lookup: { address, failed: describeError(error) } });
		}
	}

	async refresh(): Promise<void> {
		if (this.#disposed) return;
		this.store.set({ loading: true, error: undefined });
		try {
			this.store.set({ friends: await this.#api.listFriends(), loading: false, loaded: true });
		} catch (error) {
			this.store.set({ loading: false, error: describeError(error) });
			return;
		}
		// The typed address may have become a friend's, or stopped being one; a failed lookup is asked again.
		const { query = "", lookup } = this.store.get();
		const address = query.trim().toLowerCase();
		if (lookup?.address !== address || lookup.failed || isFriend(this.store.get(), address)) this.type(query);
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

function isFriend(state: FriendsState, address: string): boolean {
	return state.friends.some((friend) => friend.email.toLowerCase() === address);
}

function personRow(
	friend: Pick<HostedFriend, "userId" | "email" | "displayName">,
	meta: string,
	...actions: HTMLElement[]
): HTMLElement {
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

/** What the field holds, what it found when it holds an address, and whether a
 * friend request can go to it: only to an account the lookup found, unless this
 * cloud cannot look addresses up yet. */
function typed(state: FriendsState): { query: string; lookup?: AddressLookup; invitable: boolean } {
	const query = (state.query ?? "").trim().toLowerCase();
	if (!EMAIL.test(query) || isFriend(state, query)) return { query, invitable: false };
	if (state.lookupMissing) return { query, invitable: true };
	const lookup = state.lookup?.address === query ? state.lookup : { address: query };
	return { query, lookup, invitable: Boolean(lookup.account && !lookup.account.self) };
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
		input.addEventListener("input", () => friends.type(input.value));
		const sendTyped = () => {
			const { query, invitable } = typed(friends.store.get());
			if (!invitable) return;
			void friends.request(query).then(() => {
				if (friends.store.get().error) return;
				input.value = "";
				friends.type("");
			});
		};
		const send = (event: Event) => {
			event.preventDefault();
			sendTyped();
		};
		const submit = h("button", { type: "submit", class: "btn btn-primary" }, t("Send request"));
		// Enter before the address has its answer, while Send request is still off: look
		// it up at once, and send if it finds someone and the field still holds it.
		input.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" || event.isComposing || !submit.disabled) return;
			const { query, lookup } = typed(friends.store.get());
			if (!lookup || lookup.account !== undefined) return;
			event.preventDefault();
			void friends.lookUpNow().then(() => {
				if (typed(friends.store.get()).query === query) sendTyped();
			});
		});
		const title = h("h1");
		const notices = h("div");
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
	const { query, lookup, invitable } = typed(state);
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
	// A typed address shows the account that holds it, and nothing when none does.
	const found = lookup?.account && !lookup.account.self ? lookup.account : undefined;
	const checking = Boolean(lookup && lookup.account === undefined && !lookup.failed);
	const outcome =
		lookup?.account === null
			? t("No Qorpera account uses {email}.", { email: query })
			: lookup?.account?.self
				? t("That is your own address.")
				: null;
	const listed = incoming.length + outgoing.length + accepted.length > 0;
	const loading = !listed && state.loading && !state.loaded;
	const empty =
		listed || loading || lookup
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
		[found, checking && query, outcome, lookup?.failed],
	]);
	if (shown === parts.shown) return;
	parts.shown = shown;
	replace(
		parts.results,
		found ? group(t("Add a friend"), [personRow(found, "")]) : null,
		checking ? listSkeleton(t("Looking up {email}", { email: query }), 1) : null,
		lookup?.failed
			? notice(
					"danger",
					lookup.failed,
					" ",
					button(t("Try again"), () => void friends.lookUpNow(), { small: true }),
				)
			: null,
		outcome ? h("p", { class: "panel-empty muted" }, outcome) : null,
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
