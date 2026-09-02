import type { CloudApi } from "../../cloud/api.ts";
import { describeError } from "../../cloud/client.ts";
import type { HostedIncomingProfileInvitation, HostedProfile } from "../../cloud/types.ts";
import { badge, button, companyImage, fmtDate, h, notice, replace, spinner } from "../../ui/dom.ts";
import { navigate } from "../router.ts";
import { Store } from "../state.ts";
import { mountCrown } from "./crown.ts";

/* The company hub: every cloud company the member belongs to, pending
 * invitations, and creation of a new company (qorpera_create_cloud_company).
 * There is no local company list — the cloud is the only registry. */

export interface HubState {
	loading: boolean;
	profiles: HostedProfile[];
	invitations: HostedIncomingProfileInvitation[];
	error?: string;
	creating?: { name: string; clientCreationId: string; state: string };
	busyInvitation?: string;
	/** The "New company" tile is open for typing. */
	composing?: boolean;
}

export class HubController {
	readonly store = new Store<HubState>({ loading: true, profiles: [], invitations: [] });
	readonly #api: CloudApi;

	constructor(api: CloudApi) {
		this.#api = api;
	}

	async refresh(): Promise<void> {
		this.store.set({ loading: true, error: undefined });
		try {
			const [profiles, invitations] = await Promise.all([
				this.#api.listProfiles(),
				this.#api.listIncomingInvitations(),
			]);
			this.store.set({ profiles, invitations, loading: false });
		} catch (error) {
			this.store.set({ loading: false, error: describeError(error) });
		}
	}

	async respondInvitation(invitation: HostedIncomingProfileInvitation, accept: boolean): Promise<void> {
		this.store.set({ busyInvitation: invitation.id, error: undefined });
		try {
			if (accept) await this.#api.acceptInvitation(invitation.id);
			else await this.#api.declineInvitation(invitation.id);
			await this.refresh();
			if (accept) navigate({ name: "company", profileId: invitation.profileId, section: "home" });
		} catch (error) {
			this.store.set({ error: describeError(error) });
		} finally {
			this.store.set({ busyInvitation: undefined });
		}
	}

	async createCompany(name: string): Promise<void> {
		const trimmed = name.trim();
		if (!trimmed) return;
		const clientCreationId = crypto.randomUUID();
		this.store.set({ creating: { name: trimmed, clientCreationId, state: "requested" }, error: undefined });
		try {
			let result = await this.#api.createCompany(clientCreationId, trimmed);
			const started = Date.now();
			// Clouds with the Order 0 bootstrap ledger report queued/leased until
			// the Company File and Co-Founder are seeded; re-calling with the same
			// client creation id is idempotent and returns progress.
			while (
				(result.bootstrapState === "queued" || result.bootstrapState === "leased") &&
				Date.now() - started < 90_000
			) {
				this.store.set({ creating: { name: trimmed, clientCreationId, state: result.bootstrapState } });
				await new Promise((resolve) => setTimeout(resolve, 2000));
				result = await this.#api.createCompany(clientCreationId, trimmed);
			}
			if (result.bootstrapState === "blocked")
				throw new Error("The cloud could not provision the company's Company File.");
			this.store.set({ creating: undefined });
			await this.refresh();
			navigate({ name: "company", profileId: result.profile.profileId, section: "home" });
		} catch (error) {
			this.store.set({ creating: undefined, error: describeError(error) });
		}
	}
}

function invitationCard(hub: HubController, invitation: HostedIncomingProfileInvitation, busy: boolean): HTMLElement {
	return h(
		"div",
		{ class: "invite-card" },
		h(
			"div",
			{ class: "invite-copy" },
			h("strong", null, invitation.profileName),
			h(
				"span",
				{ class: "muted small" },
				`Invited as ${invitation.role} · expires ${fmtDate(invitation.expiresAt)}`,
			),
		),
		h(
			"div",
			{ class: "invite-actions" },
			button("Decline", () => void hub.respondInvitation(invitation, false), { disabled: busy }),
			button("Accept", () => void hub.respondInvitation(invitation, true), { primary: true, disabled: busy }),
		),
	);
}

function companyCard(profile: HostedProfile): HTMLElement {
	return h(
		"a",
		{ class: "company-card", href: `#/c/${profile.profileId}` },
		companyImage(profile.profileName),
		h("span", { class: "company-name" }, profile.profileName),
		h(
			"span",
			{ class: "company-meta" },
			badge(profile.role, "neutral"),
			h("span", { class: "muted small" }, `since ${fmtDate(profile.createdAt)}`),
		),
	);
}

export function renderHub(hub: HubController, container: HTMLElement): void {
	const state = hub.store.get();
	const busy = Boolean(state.creating);
	// The welcome state is the first thing a new member sees: no companies, and
	// nothing still loading that could turn into one.
	const welcome = !state.loading && state.profiles.length === 0;
	const invited = state.invitations.length > 0;
	const nameInput = h("input", {
		id: "newCompanyName",
		type: "text",
		placeholder: "Company name",
		maxlength: 120,
		required: true,
		disabled: busy,
		"aria-label": "Company name",
		autocomplete: "organization",
	});
	const onSubmit = (event: Event) => {
		event.preventDefault();
		void hub.createCompany(nameInput.value);
	};
	const progress = () =>
		h(
			"div",
			{ class: "hub-progress" },
			spinner(`Creating ${state.creating?.name ?? "the company"}`),
			h("span", { class: "muted small" }, "Seeding its Company File and Co-Founder."),
		);
	const invitations = state.invitations.map((invitation) =>
		invitationCard(hub, invitation, state.busyInvitation === invitation.id),
	);

	if (welcome) {
		// The character persists across re-renders so its motion is never
		// restarted by a status change.
		let art = container.querySelector<HTMLElement>(".hub-art");
		if (!art) {
			art = h("div", { class: "hub-art", "aria-hidden": "true" });
			const stage = h("div", { class: "crown-stage" });
			art.append(stage);
			mountCrown(stage, { watch: () => container.querySelectorAll("input"), mirrored: false });
		}
		replace(
			container,
			h(
				"section",
				{ class: "hub" },
				h(
					"div",
					{ class: "hub-inner hub-welcome" },
					art,
					h("h1", null, invited ? "You have been invited" : "Start your first company"),
					h(
						"p",
						{ class: "hub-lead" },
						invited
							? "Join a company you have been invited to, or start one of your own."
							: "Give it a name. Qorpera creates its Company File and a Co-Founder who begins work straight away.",
					),
					invited ? h("div", { class: "invite-list" }, ...invitations) : null,
					invited ? h("div", { class: "hub-or", "aria-hidden": "true" }, h("span", null, "or")) : null,
					busy
						? progress()
						: h(
								"form",
								{ class: "hub-create", onsubmit: onSubmit },
								nameInput,
								h("button", { type: "submit", class: "hub-create-submit" }, "Create company"),
							),
					state.error ? notice("danger", state.error) : null,
					invited || busy
						? null
						: h("p", { class: "hub-note" }, "Invited to a company? It appears here the moment someone adds you."),
				),
			),
		);
		return;
	}

	// The selector: one card per company, and a tile that opens into the
	// create form in place, so the page never needs a form in its header.
	const newTile = busy
		? h("div", { class: "company-card company-card-compose" }, progress())
		: state.composing
			? h(
					"form",
					{ class: "company-card company-card-compose", onsubmit: onSubmit },
					h("label", { class: "muted small", for: "newCompanyName" }, "New company"),
					nameInput,
					h(
						"div",
						{ class: "row" },
						h("button", { type: "submit", class: "hub-create-submit" }, "Create"),
						button("Cancel", () => hub.store.set({ composing: false })),
					),
				)
			: h(
					"button",
					{
						type: "button",
						class: "company-card company-card-new",
						onclick: () => hub.store.set({ composing: true }),
					},
					h("span", { class: "company-new-mark", "aria-hidden": "true" }, "+"),
					h("span", { class: "company-name" }, "New company"),
					h("span", { class: "muted small" }, "Seeds a Company File and a Co-Founder"),
				);
	replace(
		container,
		h(
			"section",
			{ class: "hub" },
			h(
				"div",
				{ class: "hub-inner" },
				h(
					"header",
					{ class: "hub-header" },
					h("h1", null, "Companies"),
					h("p", null, state.loading ? "Loading your companies…" : "Open a company, or start a new one."),
				),
				state.error ? notice("danger", state.error) : null,
				invited
					? h(
							"div",
							{ class: "hub-section" },
							h("h2", null, "Invitations"),
							h("div", { class: "invite-list" }, ...invitations),
						)
					: null,
				state.loading
					? spinner("Loading companies")
					: h("div", { class: "company-grid" }, ...state.profiles.map(companyCard), newTile),
			),
		),
	);
	if (state.composing && !busy) nameInput.focus();
}
