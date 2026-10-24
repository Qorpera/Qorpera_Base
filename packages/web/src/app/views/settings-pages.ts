import { CloudRpcError, describeError } from "../../cloud/client.ts";
import type { InterfacePageCalls, InterfacePageName, MemberInterfacePages } from "../../cloud/interface-pages.ts";
import { h, notice, replace } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";

function pageCopy(page: InterfacePageName): { name: string; about: string } {
	if (page === "mailbox")
		return {
			name: t("Mailbox"),
			about: t(
				"The company's mail, for every member. It shows once the company has a mail address (Company connections → Mailboxes).",
			),
		};
	if (page === "bank")
		return {
			name: t("Bank"),
			about: t("The company's bank account: the saldo, and what comes in and goes out each month."),
		};
	return {
		name: t("Members"),
		about: t("Who owns and supervises each agent. It shows once the company has a second member."),
	};
}

/**
 * Settings → Company → Pages (Interfaces C6a; supabase/CLIENT-CONTRACT.md "Pages"): the pages the company's
 * Interfaces tab may show, Mailbox, Members and Bank. Each is off until an owner or admin switches it on; everyone else
 * sees the switches locked. Switching a page off only hides it: what it showed stays as it was.
 */
export class PagesView {
	readonly el = h("section", { class: "settings-group settings-pages", "aria-label": t("Pages") });
	readonly #calls: InterfacePageCalls;
	readonly #role: () => string | undefined;
	/** Told after a switch moved, so the company's Interfaces tab follows at once. */
	readonly #changed: () => void;
	readonly #lifetime = new AbortController();
	#pages: MemberInterfacePages | undefined;
	#missing = false;
	#error: string | undefined;
	/** The page whose switch is moving; the other waits. */
	#working: InterfacePageName | undefined;
	#listedRole: string | undefined;
	/** Counts loads and changes: a load that a newer load or a change overtook is dropped. */
	#generation = 0;

	/** `role` is the member's current role in the company: a change reads the pages again (it decides who may switch). */
	constructor(calls: InterfacePageCalls, signal: AbortSignal, role: () => string | undefined, changed: () => void) {
		this.#calls = calls;
		this.#role = role;
		this.#changed = changed;
		if (signal.aborted) this.#lifetime.abort();
		else signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#lifetime.signal });
		this.#draw();
		void this.#refresh();
	}

	dispose(): void {
		this.#lifetime.abort();
	}

	/** The company changed: read again when the member's role did. The first role to arrive is not a change: the cloud
	 * answered for it already. */
	update(): void {
		const role = this.#role();
		if (role === undefined || role === this.#listedRole) return;
		if (this.#listedRole === undefined) {
			this.#listedRole = role;
			return;
		}
		if (this.#working || this.#missing) return;
		void this.#refresh();
	}

	async #refresh(): Promise<void> {
		const generation = ++this.#generation;
		this.#listedRole = this.#role();
		const current = () => !this.#lifetime.signal.aborted && generation === this.#generation;
		try {
			const pages = await this.#calls.list();
			if (!current()) return;
			this.#pages = pages;
			this.#error = undefined;
		} catch (error) {
			if (!current()) return;
			if (error instanceof CloudRpcError && error.missing) this.#missing = true;
			else this.#error = describeError(error);
		}
		this.#draw();
	}

	async #switch(page: InterfacePageName): Promise<void> {
		const entry = this.#pages?.mayChange ? this.#pages.pages.find((item) => item.page === page) : undefined;
		if (!entry || this.#working) return;
		// A load on its way may not have this change: it is dropped.
		this.#generation++;
		this.#working = page;
		this.#error = undefined;
		this.#draw();
		let failed = false;
		try {
			const pages = await this.#calls.set(page, !entry.on);
			if (!this.#lifetime.signal.aborted) this.#pages = pages;
		} catch {
			failed = true;
		}
		if (this.#lifetime.signal.aborted) return;
		// The switch stays busy until the cloud's state is read back: a failed change may still have landed, and a
		// second press must not repeat the first.
		if (failed) await this.#refresh();
		if (this.#lifetime.signal.aborted) return;
		this.#working = undefined;
		if (failed) this.#error = t("{page} could not be changed. Try again.", { page: pageCopy(page).name });
		this.#draw();
		this.#changed();
	}

	#row(entry: MemberInterfacePages["pages"][number], mayChange: boolean): HTMLElement {
		const copy = pageCopy(entry.page);
		const lever = h("button", {
			type: "button",
			role: "switch",
			class: "routine-switch",
			"aria-checked": String(entry.on),
			"aria-label": copy.name,
			onclick: () => void this.#switch(entry.page),
		});
		lever.dataset.focusKey = entry.page;
		lever.classList.toggle("is-locked", !mayChange);
		if (!mayChange || this.#working) lever.setAttribute("aria-disabled", "true");
		if (this.#working === entry.page) lever.setAttribute("aria-busy", "true");
		return h(
			"div",
			{ class: "settings-preference-row" },
			h("div", { class: "settings-copy" }, h("span", null, copy.name), h("small", null, copy.about)),
			lever,
		);
	}

	#draw(): void {
		if (this.#lifetime.signal.aborted) return;
		const active = document.activeElement;
		const focused = active instanceof HTMLElement && this.el.contains(active) ? active.dataset.focusKey : undefined;
		const pages = this.#pages;
		replace(
			this.el,
			h("h2", null, t("Pages")),
			this.#missing
				? notice("neutral", t("Pages are not available on this cloud yet."))
				: pages
					? [
							h(
								"div",
								{ class: "settings-rows" },
								...pages.pages.map((entry) => this.#row(entry, pages.mayChange)),
							),
							h(
								"p",
								{ class: "settings-help" },
								pages.mayChange
									? t("Switching a page off only hides it. Nothing it showed is removed.")
									: t("Only owners and admins can switch pages on or off."),
							),
						]
					: this.#error
						? null
						: h("p", { class: "settings-help" }, t("Loading…")),
			this.#error ? notice("danger", this.#error) : null,
		);
		if (focused) this.el.querySelector<HTMLElement>(`[data-focus-key="${focused}"]`)?.focus({ preventScroll: true });
	}
}
