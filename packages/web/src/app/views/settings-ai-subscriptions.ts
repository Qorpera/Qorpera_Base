import type { WebDefaultModels } from "../../cloud/default-models.ts";
import type { WebGeminiKey } from "../../cloud/gemini-key.ts";
import type { WebNativeSubscription } from "../../cloud/native-subscription.ts";
import type { HostedProfile } from "../../cloud/types.ts";
import { button, h, notice, replace } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";
import { type ConnectionsClient, ConnectionsView, type ProviderSignIns } from "./settings-connections.ts";
import { DefaultModelsView } from "./settings-default-models.ts";
import { GeminiKeyView } from "./settings-gemini-key.ts";

/** One of the member's companies, as AI subscriptions with no company open reach it. */
export interface AccountSubscriptionsCompany {
	/** Reads (and Sign out everywhere) for this page. */
	client: ConnectionsClient;
	/** The member's sign-ins in this company, shared with its own AI subscriptions page. */
	signIns: ProviderSignIns;
	/** Starts a sign-in that outlives this page. */
	begin: WebNativeSubscription["beginProviderLogin"];
	defaultModels?: WebDefaultModels;
	gemini?: WebGeminiKey;
}

/** AI subscriptions with no company open: the member's account logins (20260930548000), one ChatGPT sign-in used in
 * all their companies. A sign-in always begins in a company; the cloud makes a Codex sign-in that a member begins in a
 * company the shared vault serves an account sign-in, and links it into every other company of theirs. So the page
 * signs in through the first such company by company id (the order the cloud links them in): the result is the same
 * account login whichever company it is. */
export class AccountSubscriptionsView {
	readonly el = h("div");
	readonly #profiles: readonly HostedProfile[];
	readonly #open: (profile: HostedProfile) => AccountSubscriptionsCompany;
	readonly #lifetime = new AbortController();
	#defaultModels: DefaultModelsView | undefined;
	#connections: ConnectionsView | undefined;
	#geminiKey: GeminiKeyView | undefined;

	constructor(
		profiles: readonly HostedProfile[],
		open: (profile: HostedProfile) => AccountSubscriptionsCompany,
		signal: AbortSignal,
	) {
		this.#profiles = profiles;
		this.#open = open;
		if (signal.aborted) this.#lifetime.abort();
		else signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#lifetime.signal });
		void this.#start();
	}

	dispose(): void {
		this.#lifetime.abort();
		this.#defaultModels?.dispose();
		this.#defaultModels = undefined;
		this.#connections?.dispose();
		this.#connections = undefined;
		this.#geminiKey?.dispose();
		this.#geminiKey = undefined;
		this.el.replaceChildren();
		this.el.remove();
	}

	async #start(): Promise<void> {
		const signal = this.#lifetime.signal;
		if (signal.aborted) return;
		const companies = [...this.#profiles].sort((a, b) =>
			a.profileId < b.profileId ? -1 : a.profileId > b.profileId ? 1 : 0,
		);
		if (!companies.length) {
			replace(
				this.el,
				notice("neutral", t("Create or join a company first. Then you can add a ChatGPT subscription here.")),
			);
			return;
		}
		replace(this.el, h("p", { class: "connection-empty muted", role: "status" }, t("Checking…")));
		let failed = false;
		for (const profile of companies) {
			const company = this.#open(profile);
			let usable: boolean;
			try {
				usable = (await company.client.listAccountLogins?.(signal))?.enabled === true;
				// A sign-in begins only for an active identity of the member (a new one is made where there is none).
				// One who left the company once keeps a retired identity there, and no account login is linked there.
				const identity = usable ? (await company.client.listConnections(signal)).computeIdentity : undefined;
				if (identity && identity.status !== "active") usable = false;
			} catch {
				if (signal.aborted) return;
				failed = true;
				continue;
			}
			if (signal.aborted) return;
			if (!usable) continue;
			this.#defaultModels = company.defaultModels
				? new DefaultModelsView(company.defaultModels, signal)
				: undefined;
			const refreshDefaults = () => void this.#defaultModels?.refresh();
			this.#connections = new ConnectionsView(
				company.client,
				signal,
				company.signIns,
				company.begin,
				["openai"],
				undefined,
				undefined,
				{ companyName: profile.profileName },
				refreshDefaults,
			);
			this.#geminiKey = company.gemini ? new GeminiKeyView(company.gemini, signal, refreshDefaults) : undefined;
			replace(this.el, this.#defaultModels?.el, this.#connections.el, this.#geminiKey?.el);
			return;
		}
		replace(
			this.el,
			failed
				? h(
						"div",
						null,
						notice("danger", t("Your AI subscriptions could not be read.")),
						button(t("Try again"), () => void this.#start()),
					)
				: notice(
						"neutral",
						t("Your companies can't share an AI subscription yet. Open a company to add one there."),
					),
		);
	}
}
