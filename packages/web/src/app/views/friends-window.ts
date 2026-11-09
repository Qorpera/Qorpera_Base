import type { CloudApi } from "../../cloud/api.ts";
import { h, icon } from "../../ui/dom.ts";
import { matchesKey } from "../../ui/keys.ts";
import { t } from "../../ui/preferences.ts";
import { FriendsController, renderFriends } from "./friends.ts";
import type { HubController } from "./hub.ts";

/** How often an open window reads the list again, so "last online" stays true. */
const REFRESH_MS = 60_000;

/* Friends as a window of its own, outside Settings (Jonas, 9 Nov 2026): opened from the friends button beside the
 * account, and from the account menu. It holds the same list Settings had: the search field that adds someone by
 * email, company invitations, requests, and the friends with when each was last online. */
export class FriendsWindow {
	readonly el: HTMLDialogElement;
	readonly #friends: FriendsController;
	/** The list is this window's own, not Settings' it opened over. */
	readonly #ownsFriends: boolean;
	readonly #hub: HubController;
	readonly #body = h("div", { class: "friends-window-body" });
	readonly #lifetime = new AbortController();
	#timer: ReturnType<typeof setInterval> | undefined;

	/** `friends`: the list of Settings this window opens over, so a change made here (even one still on its way when
	 * the window closes) shows there too; without it the window keeps a list of its own. */
	constructor(api: CloudApi, hub: HubController, close: () => void, friends?: FriendsController) {
		this.#friends = friends ?? new FriendsController(api);
		this.#ownsFriends = !friends;
		this.#hub = hub;
		this.el = h(
			"dialog",
			{ class: "friends-window", "aria-label": t("Friends"), "aria-modal": "true" },
			h(
				"button",
				{ type: "button", class: "friends-window-close", "aria-label": t("Close friends"), onclick: () => close() },
				icon("close"),
			),
			this.#body,
		);
		this.el.addEventListener("cancel", (event) => {
			event.preventDefault();
			close();
		});
		this.el.addEventListener("click", (event) => {
			if (event.target === this.el) close();
		});
		this.el.addEventListener("keydown", (event) => {
			if (event.isComposing || !matchesKey(event, "dismiss")) return;
			event.preventDefault();
			event.stopPropagation();
			close();
		});
		const signal = this.#lifetime.signal;
		signal.addEventListener(
			"abort",
			this.#friends.store.subscribe(() => this.#draw()),
		);
		signal.addEventListener(
			"abort",
			hub.store.subscribe(() => this.#draw()),
		);
		this.#draw();
		void this.#friends.refresh();
		this.#timer = setInterval(() => {
			if (document.visibilityState === "visible" && !this.#friends.store.get().loading) void this.#friends.refresh();
		}, REFRESH_MS);
	}

	get friends(): FriendsController {
		return this.#friends;
	}

	open(): void {
		this.el.showModal();
		this.#body.querySelector<HTMLInputElement>(".panel-search input")?.focus();
	}

	#draw(): void {
		if (this.#lifetime.signal.aborted) return;
		renderFriends(this.#friends, this.#hub, this.#body);
	}

	dispose(): void {
		if (this.#lifetime.signal.aborted) return;
		this.#lifetime.abort();
		clearInterval(this.#timer);
		if (this.#ownsFriends) this.#friends.dispose();
		if (this.el.open) this.el.close();
		this.el.remove();
	}
}
