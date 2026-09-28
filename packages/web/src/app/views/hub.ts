import type { CloudApi } from "../../cloud/api.ts";
import { CloudRpcError, describeError } from "../../cloud/client.ts";
import { CompanyFoundingApi, type FoundingTableEntry } from "../../cloud/company-founding.ts";
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
 * invitations, founding tables, and creation of a new company. Once the cloud
 * creates companies on the company folder, "New company" opens a founding
 * table (qorpera_open_company_founding); until then it creates the company at
 * once (qorpera_create_cloud_company). There is no local company list — the
 * cloud is the only registry. */

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
	/** Founding tables you sit at or are invited to. */
	tables: FoundingTableEntry[];
	/** New companies start at a founding table; undefined until the cloud has said. */
	foundingAvailable?: boolean;
	busyTable?: string;
	error?: string;
	creating?: { name: string; clientCreationId: string; state: string; table?: boolean };
	creationRetry?: { name: string; clientCreationId: string };
	busyInvitation?: string;
	/** The "New company" tile is open for typing. */
	composing?: boolean;
}

export class HubController {
	readonly store = new Store<HubState>({ loading: true, profiles: [], invitations: [], tables: [] });
	readonly #api: CloudApi;
	readonly #founding: CompanyFoundingApi;
	readonly #creationKey?: string;
	#disposed = false;
	#refresh: Promise<void> | undefined;
	#membershipRevision = 0;
	#creation: { name: string; clientCreationId: string; table?: boolean } | undefined;

	constructor(api: CloudApi, userId?: string) {
		this.#api = api;
		this.#founding = new CompanyFoundingApi(api.cloud);
		this.#creationKey = userId ? `qorpera-web-creation/v1/${api.cloud.config.projectUrl}/${userId}` : undefined;
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
				this.#creation = {
					name: saved.name,
					clientCreationId: saved.clientCreationId,
					...("table" in saved && saved.table === true ? { table: true } : {}),
				};
				this.store.set({ creationRetry: this.#creation });
			}
		} catch {
			/* A blocked storage API must not block the company hub. */
		}
	}

	dispose(): void {
		this.#disposed = true;
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
		try {
			const [profiles, invitations, founding] = await Promise.all([
				this.#api.listProfiles(),
				this.#api.listIncomingInvitations(),
				this.#readFounding(),
			]);
			if (revision === this.#membershipRevision)
				this.store.set({ profiles, invitations, ...founding, loading: false, loaded: true });
		} catch (error) {
			if (revision === this.#membershipRevision) this.store.set({ loading: false, error: describeError(error) });
		}
	}

	/** Tables never hold up the company list. A cloud without the founding lobby yet ("no such
	 * function") keeps the old "New company" form; any other failure keeps what the hub knew. */
	async #readFounding(): Promise<Pick<HubState, "tables" | "foundingAvailable">> {
		try {
			const [available, tables] = await Promise.all([
				this.#api.companyFoundingAvailable(),
				this.#api.listCompanyFoundings(),
			]);
			return { foundingAvailable: available, tables };
		} catch (error) {
			if (error instanceof CloudRpcError && error.missing) return { foundingAvailable: false, tables: [] };
			// Unknown stays unknown: "New company" asks again before it creates anything.
			const { foundingAvailable, tables } = this.store.get();
			return { foundingAvailable, tables };
		}
	}

	/** Joining takes you to the table; declining just removes the invitation. */
	async respondTable(table: FoundingTableEntry, accept: boolean): Promise<void> {
		if (this.#disposed || this.store.get().busyTable) return;
		const route = location.hash;
		this.store.set({ busyTable: table.profileId, error: undefined });
		try {
			await this.#founding.respond(table.profileId, accept);
			await this.refresh();
			if (accept && !this.#disposed && location.hash === route)
				navigate({ name: "found", profileId: table.profileId });
		} catch (error) {
			this.store.set({ error: describeError(error) });
		} finally {
			this.store.set({ busyTable: undefined });
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
		this.store.set({ creating: { name: trimmed, clientCreationId: "", state: "requested" }, error: undefined });
		// Whether a new company starts at a table must be known, never guessed: a failed read would
		// otherwise create the company at once once tables are on.
		let table = this.store.get().foundingAvailable;
		if (table === undefined) {
			try {
				table = await this.#api.companyFoundingAvailable();
				this.store.set({ foundingAvailable: table });
			} catch (error) {
				if (!(error instanceof CloudRpcError && error.missing)) {
					this.store.set({ creating: undefined, error: describeError(error) });
					return;
				}
				table = false;
			}
			if (this.#disposed) return;
		}
		// A pending creation of the other kind is a different ledger: start this one afresh.
		const clientCreationId =
			this.#creation && (this.#creation.table ?? false) === table
				? this.#creation.clientCreationId
				: crypto.randomUUID();
		this.#creation = { name: trimmed, clientCreationId, table };
		try {
			if (this.#creationKey) sessionStorage.setItem(this.#creationKey, JSON.stringify(this.#creation));
		} catch {
			/* Keep the in-memory operation when storage is unavailable. */
		}
		this.store.set({ creating: { name: trimmed, clientCreationId, state: "requested", table } });
		if (table) {
			await this.#openTable(trimmed, clientCreationId, route);
			return;
		}
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
				this.store.set({
					creating: { name: trimmed, clientCreationId, state: result.bootstrapState, table: false },
				});
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
				navigate({ name: "company", profileId: result.profile.profileId, section: "meet" });
		} catch (error) {
			this.store.set({ creating: undefined, creationRetry: this.#creation, error: describeError(error) });
		}
	}

	/** The table is the company being founded: open it, then invite co-founders there. */
	async #openTable(name: string, clientCreationId: string, route: string): Promise<void> {
		try {
			const table = await this.#founding.open(clientCreationId, name);
			if (this.#disposed) return;
			this.#creation = undefined;
			try {
				if (this.#creationKey) sessionStorage.removeItem(this.#creationKey);
			} catch {
				/* The table is also recoverable from the cloud list. */
			}
			this.store.set({ creating: undefined, creationRetry: undefined, composing: false });
			void this.refresh();
			if (location.hash === route) navigate({ name: "found", profileId: table.profileId });
		} catch (error) {
			this.store.set({ creating: undefined, creationRetry: this.#creation, error: describeError(error) });
		}
	}
}

function tableCard(hub: HubController, table: FoundingTableEntry, busy: boolean): HTMLElement {
	if (table.myState === "invited")
		return h(
			"div",
			{ class: "invite-card" },
			h(
				"div",
				{ class: "invite-copy" },
				h("strong", null, table.companyName),
				h(
					"span",
					{ class: "muted small" },
					table.invitedByDisplayName
						? t("{name} invited you to start it together", { name: table.invitedByDisplayName })
						: t("You are invited to start it together"),
				),
			),
			h(
				"div",
				{ class: "invite-actions" },
				h("a", { class: "btn", href: `#/found/${table.profileId}` }, t("See the table")),
				button(t("Decline"), () => void hub.respondTable(table, false), { disabled: busy }),
				button(t("Join"), () => void hub.respondTable(table, true), { primary: true, disabled: busy }),
			),
		);
	return h(
		"a",
		{ class: "invite-card founding-table-card", href: `#/found/${table.profileId}` },
		h(
			"div",
			{ class: "invite-copy" },
			h("strong", null, table.companyName),
			h(
				"span",
				{ class: "muted small" },
				table.phase === "started"
					? t("Starting…")
					: table.joined === 1
						? t("Your table · just you so far")
						: t("Your table · {count} founders", { count: table.joined }),
			),
		),
		h("span", { class: "invite-actions" }, t("Open")),
	);
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
	const welcome =
		!firstRead && state.profiles.length === 0 && !state.tables.some((table) => table.myState === "joined");
	const invited = state.invitations.length > 0 || state.tables.some((table) => table.myState === "invited");
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
			state.creating?.table
				? spinner(t("Opening a table for {name}", { name: state.creating.name }))
				: spinner(state.creating ? t("Creating {name}", { name: state.creating.name }) : t("Creating the company")),
			// Only a company created at once is seeded now; a table is not, and neither is known yet.
			state.creating?.table === false
				? h("span", { class: "muted small" }, t("Seeding its Company File and Co-Founder."))
				: null,
		);
	const invitations = [
		...state.tables
			.filter((table) => table.myState === "invited")
			.map((table) => tableCard(hub, table, state.busyTable === table.profileId)),
		...state.invitations.map((invitation) => invitationCard(hub, invitation, state.busyInvitation === invitation.id)),
	];
	const myTables = state.tables
		.filter((table) => table.myState === "joined")
		.map((table) => tableCard(hub, table, state.busyTable === table.profileId));
	const founding = state.foundingAvailable === true;

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
							: founding
								? t(
										"Give it a name. Your co-founders join you at its table, and it starts when everyone is ready.",
									)
								: t(
										"Give it a name. Qorpera creates its Company File and a Co-Founder who begins work straight away.",
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
								h(
									"button",
									{ type: "submit", class: "hub-create-submit" },
									founding ? t("Open a table") : t("Create company"),
								),
							),
					state.error ? notice("danger", state.error) : null,
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
						h(
							"button",
							{ type: "submit", class: "hub-create-submit" },
							founding ? t("Open a table") : t("Create"),
						),
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
					h(
						"span",
						{ class: "muted small" },
						founding
							? t("Opens a table for you and your co-founders")
							: t("Seeds a Company File and a Co-Founder"),
					),
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
				myTables.length > 0
					? h(
							"div",
							{ class: "hub-section" },
							h("h2", null, t("Tables")),
							h("div", { class: "invite-list" }, ...myTables),
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
