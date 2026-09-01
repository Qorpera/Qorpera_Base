import type { CloudApi } from "../../cloud/api.ts";
import { describeError } from "../../cloud/client.ts";
import type { HostedIncomingProfileInvitation, HostedProfile } from "../../cloud/types.ts";
import { badge, button, fmtDate, h, notice, replace, spinner } from "../../ui/dom.ts";
import { navigate } from "../router.ts";
import { Store } from "../state.ts";

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

export function renderHub(hub: HubController, container: HTMLElement): void {
	const state = hub.store.get();
	const nameInput = h("input", {
		type: "text",
		placeholder: "Company name",
		maxlength: 120,
		required: true,
		disabled: Boolean(state.creating),
	});
	const createForm = h(
		"form",
		{
			class: "row",
			onsubmit: (event: Event) => {
				event.preventDefault();
				void hub.createCompany(nameInput.value);
			},
		},
		nameInput,
		h("button", { type: "submit", class: "btn btn-primary", disabled: Boolean(state.creating) }, "New company"),
	);
	replace(
		container,
		h(
			"section",
			{ class: "hub" },
			h("header", { class: "hub-header" }, h("h1", null, "Companies"), createForm),
			state.error ? notice("danger", state.error) : null,
			state.creating
				? notice(
						"accent",
						`Creating “${state.creating.name}”… (${state.creating.state}). The cloud seeds the Company File and the Co-Founder.`,
					)
				: null,
			state.invitations.length
				? h(
						"div",
						{ class: "card-list" },
						h("h2", null, "Invitations"),
						...state.invitations.map((invitation) =>
							h(
								"div",
								{ class: "card invitation" },
								h(
									"div",
									{ class: "card-body" },
									h("strong", null, invitation.profileName),
									h(
										"div",
										{ class: "muted" },
										`Invited as ${invitation.role} · expires ${fmtDate(invitation.expiresAt)}`,
									),
								),
								h(
									"div",
									{ class: "card-actions" },
									button("Decline", () => void hub.respondInvitation(invitation, false), {
										disabled: state.busyInvitation === invitation.id,
									}),
									button("Accept", () => void hub.respondInvitation(invitation, true), {
										primary: true,
										disabled: state.busyInvitation === invitation.id,
									}),
								),
							),
						),
					)
				: null,
			state.loading
				? spinner("Loading companies")
				: state.profiles.length
					? h(
							"div",
							{ class: "company-grid" },
							...state.profiles.map((profile) =>
								h(
									"a",
									{ class: "company-card", href: `#/c/${profile.profileId}` },
									h(
										"span",
										{ class: "company-mark", "aria-hidden": "true" },
										profile.profileName.slice(0, 1).toUpperCase(),
									),
									h("span", { class: "company-name" }, profile.profileName),
									h(
										"span",
										{ class: "muted small" },
										badge(profile.role, "neutral"),
										` · since ${fmtDate(profile.createdAt)}`,
									),
								),
							),
						)
					: notice(
							"neutral",
							"You are not a member of any cloud company yet. Create one, or accept an invitation.",
						),
		),
	);
}
