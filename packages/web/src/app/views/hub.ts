import type { CloudApi } from "../../cloud/api.ts";
import { describeError } from "../../cloud/client.ts";
import { CompanyFoundingApi, type FoundingInvitation } from "../../cloud/company-founding.ts";
import { UUID_PATTERN } from "../../cloud/parse.ts";
import type { HostedIncomingProfileInvitation, HostedProfile, HostedProfileRole } from "../../cloud/types.ts";
import { button, companyLogo, fmtDate, h, notice, replace, spinner } from "../../ui/dom.ts";
import { preserveFormDrafts } from "../../ui/forms.ts";
import { phrase, t } from "../../ui/preferences.ts";
import { companyCardsSkeleton } from "../../ui/skeleton.ts";
import { navigate } from "../router.ts";
import { Store } from "../state.ts";
import { mountCrown } from "./crown.ts";

/* The company hub: every cloud company the member belongs to, pending
 * invitations, and creation of a new company (qorpera_create_cloud_company).
 * There is no local company list — the cloud is the only registry. */

/** A role as the hub names it; the English is the role's own word. */
const ROLE_LABELS: Record<HostedProfileRole, string> = {
	owner: phrase("owner"),
	admin: phrase("admin"),
	contributor: phrase("contributor"),
	viewer: phrase("viewer"),
};

export interface HubState {
	loading: boolean;
	/** The company list has been read at least once. */
	loaded?: boolean;
	profiles: HostedProfile[];
	invitations: HostedIncomingProfileInvitation[];
	foundingInvitations?: FoundingInvitation[];
	foundingInvitationsError?: string;
	error?: string;
	creating?: { name: string; clientCreationId: string; state: string };
	creationRetry?: { name: string; clientCreationId: string };
	busyInvitation?: string;
	/** The "New company" tile is open for typing. */
	composing?: boolean;
}

export class HubController {
	readonly store = new Store<HubState>({ loading: true, profiles: [], invitations: [] });
	readonly #api: CloudApi;
	readonly #creationKey?: string;
	#disposed = false;
	#refresh: Promise<void> | undefined;
	#membershipRevision = 0;
	#creation: { name: string; clientCreationId: string } | undefined;
	readonly #lifetime = new AbortController();
	#watch: ReturnType<typeof setInterval> | undefined;

	constructor(api: CloudApi, userId?: string) {
		this.#api = api;
		this.#creationKey = userId ? `qorpera-web-creation/v1/${api.cloud.config.projectUrl}/${userId}` : undefined;
		if (userId) {
			const refresh = () => {
				if (!document.hidden && (location.hash === "#/" || !location.hash)) void this.refresh();
			};
			window.addEventListener("focus", refresh, { signal: this.#lifetime.signal });
			document.addEventListener("visibilitychange", refresh, { signal: this.#lifetime.signal });
			this.#watch = setInterval(refresh, 5000);
		}
		try {
			const saved: unknown = JSON.parse(
				this.#creationKey ? (sessionStorage.getItem(this.#creationKey) ?? "null") : "null",
			);
			if (
				saved &&
				typeof saved === "object" &&
				"name" in saved &&
				"clientCreationId" in saved &&
				typeof saved.name === "string" &&
				saved.name.trim() &&
				typeof saved.clientCreationId === "string" &&
				UUID_PATTERN.test(saved.clientCreationId)
			) {
				this.#creation = { name: saved.name, clientCreationId: saved.clientCreationId };
				this.store.set({ creationRetry: this.#creation });
			}
		} catch {
			/* A blocked storage API must not block the company hub. */
		}
	}

	dispose(): void {
		this.#disposed = true;
		this.#lifetime.abort();
		clearInterval(this.#watch);
		this.store.dispose();
	}

	refresh(): Promise<void> {
		if (this.#disposed) return Promise.resolve();
		this.#refresh ??= this.#load().finally(() => {
			this.#refresh = undefined;
		});
		return this.#refresh;
	}

	async companyRemoved(profileId: string): Promise<void> {
		if (this.#disposed) return;
		this.#membershipRevision++;
		this.store.set(({ profiles }) => ({
			profiles: profiles.filter((profile) => profile.profileId !== profileId),
		}));
		// Finish an older request before starting the authoritative post-removal read.
		await this.#refresh;
		await this.refresh();
	}

	async #load(): Promise<void> {
		this.store.set({ loading: true, error: undefined });
		const revision = this.#membershipRevision;
		const foundingInvitations = this.#api.listFoundingInvitations().then(
			(invitations) => {
				if (revision === this.#membershipRevision)
					this.store.set({ foundingInvitations: invitations, foundingInvitationsError: undefined });
			},
			(error: unknown) => {
				if (revision === this.#membershipRevision)
					this.store.set({ foundingInvitationsError: describeError(error) });
			},
		);
		try {
			const [profiles, invitations] = await Promise.all([
				this.#api.listProfiles(),
				this.#api.listIncomingInvitations(),
			]);
			if (revision === this.#membershipRevision)
				this.store.set({ profiles, invitations, loading: false, loaded: true });
		} catch (error) {
			if (revision === this.#membershipRevision) this.store.set({ loading: false, error: describeError(error) });
		}
		await foundingInvitations;
	}

	async respondFoundingInvitation(invitation: FoundingInvitation, accept: boolean): Promise<void> {
		if (this.#disposed || this.store.get().busyInvitation) return;
		const route = location.hash;
		this.store.set({ busyInvitation: invitation.profileId, error: undefined });
		try {
			await new CompanyFoundingApi(this.#api.cloud).respond(invitation.profileId, accept);
			await this.refresh();
			if (accept && !this.#disposed && location.hash === route)
				navigate({ name: "company", profileId: invitation.profileId, section: "founding" });
		} catch (error) {
			this.store.set({ error: describeError(error) });
		} finally {
			this.store.set({ busyInvitation: undefined });
		}
	}

	async respondInvitation(invitation: HostedIncomingProfileInvitation, accept: boolean): Promise<void> {
		if (this.#disposed || this.store.get().busyInvitation) return;
		const route = location.hash;
		this.store.set({ busyInvitation: invitation.id, error: undefined });
		try {
			if (accept) await this.#api.acceptInvitation(invitation.id);
			else await this.#api.declineInvitation(invitation.id);
			await this.refresh();
			if (accept && !this.#disposed && location.hash === route)
				navigate({ name: "company", profileId: invitation.profileId, section: "home" });
		} catch (error) {
			this.store.set({ error: describeError(error) });
		} finally {
			this.store.set({ busyInvitation: undefined });
		}
	}

	async createCompany(name: string): Promise<void> {
		if (this.#disposed || this.store.get().creating) return;
		const trimmed = name.trim();
		if (!trimmed) return;
		if (this.#creation && this.#creation.name !== trimmed) {
			this.store.set({ error: t("Resume the pending company creation before starting another.") });
			return;
		}
		const route = location.hash;
		const clientCreationId = this.#creation?.clientCreationId ?? crypto.randomUUID();
		this.#creation = { name: trimmed, clientCreationId };
		try {
			if (this.#creationKey) sessionStorage.setItem(this.#creationKey, JSON.stringify(this.#creation));
		} catch {
			/* Keep the in-memory operation when storage is unavailable. */
		}
		this.store.set({ creating: { name: trimmed, clientCreationId, state: "requested" }, error: undefined });
		try {
			let result = await this.#api.createCompany(clientCreationId, trimmed);
			if (this.#disposed) return;
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
				if (this.#disposed) return;
				result = await this.#api.createCompany(clientCreationId, trimmed);
				if (this.#disposed) return;
			}
			if (result.bootstrapState === "blocked")
				throw new Error(t("The cloud could not provision the company's Company File."));
			if (result.bootstrapState === "queued" || result.bootstrapState === "leased")
				throw new Error(t("The company is still being created. Resume to check its progress."));
			this.#creation = undefined;
			try {
				if (this.#creationKey) sessionStorage.removeItem(this.#creationKey);
			} catch {
				/* The admitted company is also recoverable from the cloud list. */
			}
			this.store.set({ creating: undefined, creationRetry: undefined });
			await this.refresh();
			if (!this.#disposed && location.hash === route)
				navigate({ name: "company", profileId: result.profile.profileId, section: "founding" });
		} catch (error) {
			this.store.set({ creating: undefined, creationRetry: this.#creation, error: describeError(error) });
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
				t("Invited as {role} · expires {date}", {
					role: t(ROLE_LABELS[invitation.role]),
					date: fmtDate(invitation.expiresAt),
				}),
			),
		),
		h(
			"div",
			{ class: "invite-actions" },
			button(t("Decline"), () => void hub.respondInvitation(invitation, false), { disabled: busy }),
			button(t("Accept"), () => void hub.respondInvitation(invitation, true), { primary: true, disabled: busy }),
		),
	);
}

function companyCard(profile: HostedProfile): HTMLElement {
	return h(
		"a",
		{ class: "company-card", href: `#/c/${profile.profileId}` },
		companyLogo(profile.profileId),
		h("span", { class: "company-name" }, profile.profileName),
		h(
			"span",
			{ class: "company-meta" },
			t("{role} · since {date}", { role: t(ROLE_LABELS[profile.role]), date: fmtDate(profile.createdAt) }),
		),
	);
}

export function renderHub(hub: HubController, container: HTMLElement): void {
	const restoreDrafts = preserveFormDrafts(container, "hub");
	const state = hub.store.get();
	const busy = Boolean(state.creating);
	// Placeholders stand in only for the first read; a refresh keeps what the page shows.
	const firstRead = state.loading && !state.loaded;
	// The welcome state is the first thing a new member sees: no companies, and
	// nothing still loading that could turn into one.
	const welcome = !firstRead && state.profiles.length === 0;
	const invited = state.invitations.length > 0 || Boolean(state.foundingInvitations?.length);
	const nameInput = h("input", {
		id: "newCompanyName",
		"data-draft": "company-name",
		type: "text",
		placeholder: t("Company name"),
		maxlength: 120,
		required: true,
		disabled: busy,
		"aria-label": t("Company name"),
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
			spinner(state.creating ? t("Creating {name}", { name: state.creating.name }) : t("Creating the company")),
			h("span", { class: "muted small" }, t("Seeding its Company File and Co-Founder.")),
		);
	const invitations = state.invitations.map((invitation) =>
		invitationCard(hub, invitation, state.busyInvitation === invitation.id),
	);
	for (const invitation of state.foundingInvitations ?? [])
		invitations.push(
			h(
				"div",
				{ class: "invite-card" },
				h(
					"div",
					{ class: "invite-copy" },
					h("strong", null, invitation.companyName),
					h(
						"span",
						{ class: "muted small" },
						t("{name} invited you to join as a co-founder.", { name: invitation.invitedByDisplayName }),
					),
				),
				h(
					"div",
					{ class: "invite-actions" },
					button(t("Decline"), () => void hub.respondFoundingInvitation(invitation, false), {
						disabled: Boolean(state.busyInvitation),
					}),
					button(t("Join setup"), () => void hub.respondFoundingInvitation(invitation, true), {
						primary: true,
						disabled: Boolean(state.busyInvitation),
					}),
				),
			),
		);

	if (welcome) {
		// The character persists across re-renders so its motion is never
		// restarted by a status change.
		let art = container.querySelector<HTMLElement>(".hub-art");
		if (!art) {
			art = h("div", { class: "hub-art", "aria-hidden": "true" });
			const stage = h("div", { class: "crown-stage" });
			art.append(stage);
			mountCrown(stage, { mirrored: false });
		}
		replace(
			container,
			h(
				"section",
				{ class: "hub", "data-form-owner": "hub" },
				h(
					"div",
					{ class: "hub-inner hub-welcome" },
					art,
					h("h1", null, invited ? t("You have been invited") : t("Start your first company")),
					h(
						"p",
						{ class: "hub-lead" },
						invited
							? t("Join a company you have been invited to, or start one of your own.")
							: t(
									"Give it a name, bring your co-founders, and set up the company before its Co-Founder starts work.",
								),
					),
					invited ? h("div", { class: "invite-list" }, ...invitations) : null,
					invited ? h("div", { class: "hub-or", "aria-hidden": "true" }, h("span", null, t("or"))) : null,
					busy
						? progress()
						: h(
								"form",
								{ class: "hub-create", onsubmit: onSubmit },
								nameInput,
								h("button", { type: "submit", class: "hub-create-submit" }, t("Create company")),
							),
					state.error ? notice("danger", state.error) : null,
					state.foundingInvitationsError ? notice("danger", state.foundingInvitationsError) : null,
					state.creationRetry && !busy
						? button(
								t("Resume creating {name}", { name: state.creationRetry.name }),
								() => void hub.createCompany(state.creationRetry!.name),
							)
						: null,
					invited || busy
						? null
						: h(
								"p",
								{ class: "hub-note" },
								t("Invited to a company? It appears here the moment someone adds you."),
							),
				),
			),
		);
		restoreDrafts();
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
					h("label", { class: "muted small", for: "newCompanyName" }, t("New company")),
					nameInput,
					h(
						"div",
						{ class: "row" },
						h("button", { type: "submit", class: "hub-create-submit" }, t("Create")),
						button(t("Cancel"), () => hub.store.set({ composing: false })),
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
					h("span", { class: "company-name" }, t("New company")),
					h("span", { class: "muted small" }, t("Seeds a Company File and a Co-Founder")),
				);
	replace(
		container,
		h(
			"section",
			{ class: "hub", "data-form-owner": "hub" },
			h(
				"div",
				{ class: "hub-inner" },
				state.error ? notice("danger", state.error) : null,
				state.foundingInvitationsError ? notice("danger", state.foundingInvitationsError) : null,
				state.creationRetry && !busy
					? button(
							t("Resume creating {name}", { name: state.creationRetry.name }),
							() => void hub.createCompany(state.creationRetry!.name),
						)
					: null,
				invited
					? h(
							"div",
							{ class: "hub-section" },
							h("h2", null, t("Invitations")),
							h("div", { class: "invite-list" }, ...invitations),
						)
					: null,
				firstRead
					? companyCardsSkeleton()
					: h("div", { class: "company-grid" }, ...state.profiles.map(companyCard), newTile),
			),
		),
	);
	if (state.composing && !busy) nameInput.focus();
	restoreDrafts();
}
