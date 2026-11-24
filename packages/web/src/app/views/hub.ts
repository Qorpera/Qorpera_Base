import type { CloudApi } from "../../cloud/api.ts";
import { CloudRpcError, connectionLost, describeError } from "../../cloud/client.ts";
import {
	CompanyFoundingApi,
	FOUNDING_NAME_MAX_CHARACTERS,
	type FoundingTableEntry,
} from "../../cloud/company-founding.ts";
import { UUID_PATTERN } from "../../cloud/parse.ts";
import type {
	HostedFriend,
	HostedIncomingProfileInvitation,
	HostedProfile,
	HostedProfileRole,
} from "../../cloud/types.ts";
import {
	companyDisplayName,
	companyInSentence,
	companyNameText,
	isUnnamed,
	UNNAMED_COMPANY,
} from "../../ui/company-name.ts";
import { menuPoint, openContextMenu } from "../../ui/context-menu.ts";
import { button, companyLogo, confirmDialog, h, icon, notice, personAvatar, replace } from "../../ui/dom.ts";
import { phrase, t } from "../../ui/preferences.ts";
import { companyCardsSkeleton } from "../../ui/skeleton.ts";
import { lobbyError, setFoundingIntent } from "../founding-intent.ts";
import { Reconnect } from "../reconnect.ts";
import { navigate } from "../router.ts";
import { Store } from "../state.ts";
import { renderNewCompany, type Viewer } from "./new-company.ts";

/* The company hub: a simple company selector (Jonas, 22 October 2026, hub round 3). One tile per
 * company, founding table and invitation, each its figure and its name and nothing more, and a "New
 * company" tile. A member with no company yet gets the new-company box itself (views/new-company.ts).
 * A new company always starts at a founding table (qorpera_open_company_founding); while the cloud has
 * switched the lobby off, creating a company is paused. There is no local company list — the cloud is
 * the only registry. */

const RENAME_SETTLE_WAITS_MS = [1500, 2500, 4000, 8000, 15000, 30000];

/** A role as the hub names it; the English is the role's own word. */
const ROLE_LABELS: Record<HostedProfileRole, string> = {
	owner: phrase("founder"),
	admin: phrase("admin"),
	contributor: phrase("contributor"),
	viewer: phrase("spectator"),
};

export interface Guests {
	founders?: readonly string[];
	spectators?: readonly string[];
}

/** What the new-company box asked for: open the table and start from there, or invite friends first. */
export type CreationIntent = "start" | "friends";

export interface CreationOptions {
	/** The idea: the table's first text, which the founders write on together. */
	vision?: string;
	intent?: CreationIntent;
	founders?: readonly string[];
	spectators?: readonly string[];
}

/** A table being opened, kept across a reload so a retry reuses its creation id. */
interface Creation extends CreationOptions {
	name: string;
	clientCreationId: string;
}

export interface HubState {
	loading: boolean;
	/** The company list has been read at least once. */
	loaded?: boolean;
	profiles: HostedProfile[];
	invitations: HostedIncomingProfileInvitation[];
	/** Founding tables you sit at or are invited to. */
	tables: FoundingTableEntry[];
	/** Who invited you to each table you are invited to, by table, when its seats could be read. */
	inviters?: Record<string, string>;
	/** New companies can start at a founding table now; undefined until the cloud has said. */
	foundingAvailable?: boolean;
	busyTable?: string;
	error?: string;
	connectionLost?: boolean;
	creating?: Creation;
	creationRetry?: Creation;
	busyInvitation?: string;
}

export class HubController {
	readonly store = new Store<HubState>({ loading: true, profiles: [], invitations: [], tables: [] });
	/** Told the idea a table just opened with (the new-company box empties itself). */
	onTableOpened: ((idea: string) => void) | undefined;
	readonly #api: CloudApi;
	readonly #founding: CompanyFoundingApi;
	readonly #userId?: string;
	readonly #creationKey?: string;
	#disposed = false;
	readonly #abort = new AbortController();
	readonly #reconnect = new Reconnect(async () => {
		await this.refresh();
		return !this.store.get().connectionLost;
	}, this.#abort.signal);
	#refresh: Promise<void> | undefined;
	#membershipRevision = 0;
	#creation: Creation | undefined;
	readonly #renames = new Map<string, { name: string; stale: Set<string>; staleKnown: boolean }>();

	constructor(api: CloudApi, userId?: string) {
		this.#api = api;
		this.#founding = new CompanyFoundingApi(api.cloud);
		this.#userId = userId;
		this.#creationKey = userId ? `qorpera-web-creation/v1/${api.cloud.config.projectUrl}/${userId}` : undefined;
		try {
			const saved: unknown = JSON.parse(
				this.#creationKey ? (sessionStorage.getItem(this.#creationKey) ?? "null") : "null",
			);
			// Only a table's creation is kept; one the old "create at once" form left is dropped.
			if (
				saved &&
				typeof saved === "object" &&
				"name" in saved &&
				"clientCreationId" in saved &&
				"table" in saved &&
				saved.table === true &&
				typeof saved.name === "string" &&
				typeof saved.clientCreationId === "string" &&
				UUID_PATTERN.test(saved.clientCreationId)
			) {
				const vision = "vision" in saved && typeof saved.vision === "string" ? saved.vision : undefined;
				const intent =
					"intent" in saved && (saved.intent === "start" || saved.intent === "friends") ? saved.intent : undefined;
				const founders = "founders" in saved ? texts(saved.founders) : [];
				const spectators = "spectators" in saved ? texts(saved.spectators) : [];
				this.#creation = {
					name: saved.name.trim(),
					clientCreationId: saved.clientCreationId,
					...(vision ? { vision } : {}),
					...(intent ? { intent } : {}),
					...(founders.length ? { founders } : {}),
					...(spectators.length ? { spectators } : {}),
				};
				this.store.set({ creationRetry: this.#creation });
			} else if (saved !== null && this.#creationKey) sessionStorage.removeItem(this.#creationKey);
		} catch {
			/* A blocked storage API must not block the company hub. */
		}
	}

	dispose(): void {
		this.#disposed = true;
		this.#abort.abort();
		this.store.dispose();
	}

	refresh(): Promise<void> {
		if (this.#disposed) return Promise.resolve();
		this.#refresh ??= this.#load().finally(() => {
			this.#refresh = undefined;
		});
		return this.#refresh;
	}

	/** A read that starts after any read already out, so it sees what changed meanwhile (a company just made). */
	async refreshAfter(): Promise<void> {
		if (this.#disposed) return;
		await this.#refresh;
		await this.refresh();
	}

	renamed(profileId: string, name: string): void {
		if (this.#disposed) return;
		const earlier = this.#renames.get(profileId);
		const shown = this.store.get().profiles.find((profile) => profile.profileId === profileId)?.profileName;
		const stale = new Set(earlier?.stale);
		if (earlier) stale.add(earlier.name);
		else if (shown !== undefined) stale.add(shown);
		stale.delete(name);
		this.#renames.set(profileId, { name, stale, staleKnown: earlier?.staleKnown ?? shown !== undefined });
		this.store.set(({ profiles }) => ({ profiles: this.#withRenames(profiles) }));
		void this.#settleRename(profileId, name);
	}

	#withRenames(profiles: HostedProfile[]): HostedProfile[] {
		if (!this.#renames.size) return profiles;
		return profiles.map((profile) => {
			const rename = this.#renames.get(profile.profileId);
			if (!rename) return profile;
			if (profile.profileName === rename.name) {
				this.#renames.delete(profile.profileId);
				return profile;
			}
			if (!rename.staleKnown) {
				rename.stale.add(profile.profileName);
				rename.staleKnown = true;
			}
			if (!rename.stale.has(profile.profileName)) {
				this.#renames.delete(profile.profileId);
				return profile;
			}
			return { ...profile, profileName: rename.name };
		});
	}

	async #settleRename(profileId: string, name: string): Promise<void> {
		for (const wait of RENAME_SETTLE_WAITS_MS) {
			await new Promise((resolve) => setTimeout(resolve, wait));
			if (this.#disposed || this.#renames.get(profileId)?.name !== name) return;
			await this.refreshAfter();
			if (this.#renames.get(profileId)?.name !== name) return;
		}
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

	/** Right-click on a company tile: a founder deletes the company, anyone else leaves it, as the
	 * company's own settings do (views/team.ts). The cloud decides; a refusal shows on the hub. */
	async removeCompany(profile: HostedProfile): Promise<void> {
		if (this.#disposed) return;
		const deleting = profile.role === "owner";
		const company = companyInSentence(profile.profileName);
		const confirmed = await confirmDialog(
			deleting
				? t("Delete {company}? Type the company name to confirm.", { company })
				: t("Leave {company}? You lose access until someone invites you again.", { company }),
			deleting ? t("Delete company") : t("Leave"),
			true,
			deleting ? companyDisplayName(profile.profileName) : undefined,
		);
		if (!confirmed || this.#disposed) return;
		this.store.set({ error: undefined });
		try {
			if (deleting) await this.#api.deleteProfile(profile.profileId);
			else await this.#api.leaveProfile(profile.profileId);
		} catch (error) {
			if (!this.#disposed) this.store.set({ error: describeError(error) });
			return;
		}
		await this.companyRemoved(profile.profileId);
	}

	async #load(): Promise<void> {
		this.store.set({ loading: true, error: undefined });
		const revision = this.#membershipRevision;
		try {
			const [profiles, invitations, founding] = await Promise.all([
				this.#api.listProfiles(this.#abort.signal),
				this.#api.listIncomingInvitations(),
				this.#readFounding(),
			]);
			if (revision === this.#membershipRevision)
				this.store.set({
					profiles: this.#withRenames(profiles),
					invitations,
					...founding,
					loading: false,
					loaded: true,
					connectionLost: undefined,
				});
		} catch (error) {
			if (this.#disposed || revision !== this.#membershipRevision) return;
			if (!connectionLost(error)) {
				this.store.set({ loading: false, connectionLost: undefined, error: describeError(error) });
				return;
			}
			this.store.set({ loading: false, connectionLost: true });
			this.#reconnect.lost();
		}
	}

	/** Tables never hold up the company list. A cloud without the founding lobby ("no such function")
	 * creates no company here; any other failure keeps what the hub knew. */
	async #readFounding(): Promise<Pick<HubState, "tables" | "foundingAvailable" | "inviters">> {
		try {
			const [available, tables] = await Promise.all([
				this.#api.companyFoundingAvailable(),
				this.#api.listCompanyFoundings(),
			]);
			return { foundingAvailable: available, tables, inviters: await this.#readInviters(tables) };
		} catch (error) {
			if (error instanceof CloudRpcError && error.missing) return { foundingAvailable: false, tables: [] };
			// Unknown stays unknown: "New company" asks again before it creates anything.
			const { foundingAvailable, tables, inviters } = this.store.get();
			return { foundingAvailable, tables, inviters };
		}
	}

	/** The list names who invited you; the table's seats say which account, so the tile can show their
	 * picture. A table that cannot be read keeps the name alone. */
	async #readInviters(tables: FoundingTableEntry[]): Promise<Record<string, string>> {
		const known = this.store.get().inviters ?? {};
		const inviters: Record<string, string> = {};
		await Promise.all(
			tables
				.filter((table) => table.myState === "invited")
				.map(async (table) => {
					if (known[table.profileId]) {
						inviters[table.profileId] = known[table.profileId]!;
						return;
					}
					try {
						const read = await this.#founding.read(table.profileId);
						const by = read.seats.find((seat) => seat.userId === this.#userId)?.invitedByUserId;
						if (by) inviters[table.profileId] = by;
					} catch {
						/* The tile shows the inviter's name without a picture. */
					}
				}),
		);
		return inviters;
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

	startFromIdea(idea: string, intent: CreationIntent, name = "", guests: Guests = {}): Promise<boolean> {
		const vision = idea.trim();
		const typed = name
			.replace(/\p{Cc}/gu, " ")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, FOUNDING_NAME_MAX_CHARACTERS)
			.trim();
		return this.createCompany(typed, {
			...(vision ? { vision } : {}),
			intent,
			...(guests.founders?.length ? { founders: guests.founders } : {}),
			...(guests.spectators?.length ? { spectators: guests.spectators } : {}),
		});
	}

	async friends(): Promise<HostedFriend[]> {
		return (await this.#api.listFriends()).filter((friend) => friend.status === "accepted");
	}

	async createCompany(name: string, options: CreationOptions = {}): Promise<boolean> {
		if (this.#disposed || this.store.get().creating) return false;
		const trimmed = name.trim();
		if (this.#creation && this.#creation.name !== trimmed) {
			this.store.set({ error: t("Resume the pending company creation before starting another.") });
			return false;
		}
		const route = location.hash;
		const wanted: CreationOptions = {
			...(options.vision ? { vision: options.vision } : {}),
			...(options.intent ? { intent: options.intent } : {}),
			...(options.founders?.length ? { founders: options.founders } : {}),
			...(options.spectators?.length ? { spectators: options.spectators } : {}),
		};
		this.store.set({ creating: { name: trimmed, clientCreationId: "", ...wanted }, error: undefined });
		// Asked every time, never taken from an older read: the cloud may have switched the lobby on or off since.
		let available: boolean;
		try {
			available = await this.#api.companyFoundingAvailable();
		} catch (error) {
			if (this.#disposed) return false;
			available = false;
			if (!(error instanceof CloudRpcError && error.missing)) {
				this.store.set({ creating: undefined, error: describeError(error) });
				return false;
			}
		}
		if (this.#disposed) return false;
		this.store.set({ foundingAvailable: available });
		if (!available) {
			this.store.set({ creating: undefined, error: t("Creating a company is paused. Try again later.") });
			return false;
		}
		const clientCreationId = this.#creation?.clientCreationId ?? crypto.randomUUID();
		this.#creation = { ...this.#creation, ...wanted, name: trimmed, clientCreationId };
		try {
			if (this.#creationKey)
				sessionStorage.setItem(this.#creationKey, JSON.stringify({ ...this.#creation, table: true }));
		} catch {
			/* Keep the in-memory operation when storage is unavailable. */
		}
		this.store.set({ creating: this.#creation });
		return this.#openTable(this.#creation, route);
	}

	/** The table is the company being founded: open it with the idea, then the founders go on there. */
	async #openTable(creation: Creation, route: string): Promise<boolean> {
		try {
			const table = await this.#founding.open(creation.clientCreationId, creation.name);
			if (this.#disposed) return false;
			let pending: string | undefined;
			if (creation.vision && !table.vision) {
				try {
					await this.#founding.update(table.profileId, table.revision, table.companyName, creation.vision);
				} catch {
					// The table's page saves it on its first read.
					pending = creation.vision;
				}
			}
			this.#creation = undefined;
			try {
				if (this.#creationKey) sessionStorage.removeItem(this.#creationKey);
			} catch {
				/* The table is also recoverable from the cloud list. */
			}
			this.store.set({ creating: undefined, creationRetry: undefined });
			void this.refresh();
			// The box empties its fields for the next company, also after a name-only Invite friends.
			this.onTableOpened?.(creation.vision ?? "");
			// The arrow alone starts the company at once; its page shows the start, not a table (Jonas, 9 Nov 2026).
			setFoundingIntent(table.profileId, {
				...(creation.intent === "friends" ? { friends: true } : {}),
				...(creation.intent === "start" ? { start: true } : {}),
				...(pending ? { vision: pending } : {}),
				...(creation.founders?.length ? { founders: [...creation.founders] } : {}),
				...(creation.spectators?.length ? { spectators: [...creation.spectators] } : {}),
			});
			if (location.hash === route) navigate({ name: "found", profileId: table.profileId });
			return true;
		} catch (error) {
			this.store.set({ creating: undefined, creationRetry: this.#creation, error: lobbyError(error) });
			return false;
		}
	}
}

/** One tile: the company's figure on its stage and its name, as the round 3 selector draws it. */
function tile(
	tag: "a" | "button",
	attrs: Record<string, unknown>,
	profileId: string,
	name: string,
	extra?: HTMLElement,
): HTMLElement {
	return h(
		tag,
		attrs,
		h("span", { class: "company-stage" }, companyLogo(profileId, "", isUnnamed(name)), extra ?? null),
		companyNameText(name, "company-name"),
	);
}

/** An invitation shows who asked you, as their picture on the tile. */
function inviterBadge(name: string, identity: string): HTMLElement {
	const avatar = personAvatar(name, identity);
	avatar.classList.add("company-inviter");
	return avatar;
}

function tableTile(hub: HubController, table: FoundingTableEntry): HTMLElement {
	const href = `#/found/${table.profileId}`;
	if (table.myState === "invited") {
		const inviter = hub.store.get().inviters?.[table.profileId];
		const by = table.invitedByDisplayName;
		return tile(
			"a",
			{
				class: "company-card company-card-invite",
				href,
				"aria-label": by
					? t("{company}: {name} invited you to start it together", {
							company: companyDisplayName(table.companyName),
							name: by,
						})
					: t("{company}: you are invited to start it together", {
							company: companyDisplayName(table.companyName),
						}),
			},
			table.profileId,
			table.companyName,
			by ? inviterBadge(by, inviter ?? by) : undefined,
		);
	}
	return tile(
		"a",
		{
			class: "company-card company-card-table",
			href,
			"aria-label": t("{company}: your table, not started yet", { company: companyDisplayName(table.companyName) }),
		},
		table.profileId,
		table.companyName,
	);
}

function invitationTile(hub: HubController, invitation: HostedIncomingProfileInvitation, busy: boolean): HTMLElement {
	const role = t(ROLE_LABELS[invitation.role]);
	const shown = companyDisplayName(invitation.profileName);
	const company = companyInSentence(invitation.profileName);
	return h(
		"div",
		{ class: "company-tile-invitation" },
		tile(
			"button",
			{
				type: "button",
				class: "company-card company-card-invite",
				disabled: busy,
				"aria-label": t("{company}: you are invited as {role}", { company: shown, role }),
				onclick: () =>
					void confirmDialog(t("Join {company} as {role}?", { company, role }), t("Join")).then((yes) => {
						if (yes) void hub.respondInvitation(invitation, true);
					}),
			},
			// A company invitation does not name who sent it; the dashed stage says it is one.
			invitation.profileId,
			invitation.profileName,
		),
		h(
			"button",
			{
				type: "button",
				class: "company-decline",
				disabled: busy,
				"aria-label": t("Decline the invitation to {company}", { company }),
				title: t("Decline"),
				onclick: () =>
					void confirmDialog(t("Decline the invitation to {company}?", { company }), t("Decline"), true).then(
						(yes) => {
							if (yes) void hub.respondInvitation(invitation, false);
						},
					),
			},
			icon("close"),
		),
	);
}

/** Invitations for a member with no company yet, under the new-company box: Join or look first. */
function welcomeInvitations(hub: HubController): HTMLElement[] {
	const state = hub.store.get();
	return [
		...state.tables
			.filter((table) => table.myState === "invited")
			.map((table) =>
				h(
					"a",
					{ class: "hero-invitation", href: `#/found/${table.profileId}` },
					table.invitedByDisplayName
						? inviterBadge(
								table.invitedByDisplayName,
								state.inviters?.[table.profileId] ?? table.invitedByDisplayName,
							)
						: companyLogo(table.profileId, "hero-invitation-logo", isUnnamed(table.companyName)),
					h(
						"span",
						null,
						table.invitedByDisplayName
							? t("{name} saved you a seat at {company}.", {
									name: table.invitedByDisplayName,
									company: companyInSentence(table.companyName),
								})
							: t("You have a seat at {company}.", { company: companyInSentence(table.companyName) }),
					),
					h("span", { class: "btn btn-small" }, t("See the table")),
				),
			),
		...state.invitations.map((invitation) =>
			h(
				"div",
				{ class: "hero-invitation" },
				companyLogo(invitation.profileId, "hero-invitation-logo", isUnnamed(invitation.profileName)),
				h(
					"span",
					null,
					t("You are invited to {company} as {role}.", {
						company: companyInSentence(invitation.profileName),
						role: t(ROLE_LABELS[invitation.role]),
					}),
				),
				button(t("Decline"), () => void hub.respondInvitation(invitation, false), {
					small: true,
					disabled: state.busyInvitation === invitation.id,
				}),
				button(t("Join"), () => void hub.respondInvitation(invitation, true), {
					small: true,
					primary: true,
					disabled: state.busyInvitation === invitation.id,
				}),
			),
		),
	];
}

/** A company tile's right-click menu: Delete company for a founder, Leave company for anyone else.
 * Shift with a mouse right-click keeps the browser's own menu (Open in new tab, Copy link). */
function openCompanyMenu(hub: HubController, event: MouseEvent): void {
	if (event.shiftKey && (event.clientX || event.clientY)) return;
	const card = (event.target as Element).closest<HTMLElement>("[data-profile-id]");
	const profile = hub.store.get().profiles.find((item) => item.profileId === card?.dataset.profileId);
	if (!card || !profile) return;
	event.preventDefault();
	const deleting = profile.role === "owner";
	const point = menuPoint(event, card);
	openContextMenu({
		label: companyDisplayName(profile.profileName),
		x: point.x,
		y: point.y,
		opener: card,
		findOpener: () => document.querySelector<HTMLElement>(`.company-card[data-profile-id="${profile.profileId}"]`),
		items: [
			{
				label: deleting ? t("Delete company") : t("Leave company"),
				icon: deleting ? "trash" : "signout",
				danger: true,
				select: () => void hub.removeCompany(profile),
			},
		],
	});
}

export function renderHub(hub: HubController, container: HTMLElement, viewer?: Viewer): void {
	const state = hub.store.get();
	// Placeholders stand in only for the first read; a refresh keeps what the page shows.
	const firstRead = (state.loading || state.connectionLost === true) && !state.loaded;
	// A member with no company and no table of their own starts one: the new-company box is the hub.
	const welcome =
		!firstRead && state.profiles.length === 0 && !state.tables.some((table) => table.myState === "joined");
	if (welcome) {
		renderNewCompany(hub, container, viewer, { welcome: true, invitations: welcomeInvitations(hub) });
		return;
	}
	const first = viewer?.name.trim().split(/\s+/)[0];
	const tiles = [
		...state.profiles.map((profile) =>
			tile(
				"a",
				{ class: "company-card", href: `#/c/${profile.profileId}`, "data-profile-id": profile.profileId },
				profile.profileId,
				profile.profileName,
			),
		),
		...state.tables.filter((table) => table.myState === "joined").map((table) => tableTile(hub, table)),
		...state.tables.filter((table) => table.myState === "invited").map((table) => tableTile(hub, table)),
		...state.invitations.map((invitation) => invitationTile(hub, invitation, state.busyInvitation === invitation.id)),
		h(
			"a",
			{ class: "company-card company-card-new", href: "#/new" },
			h("span", { class: "company-stage" }, h("span", { class: "company-new-mark" }, icon("plus"))),
			h("span", { class: "company-name" }, t("New company")),
		),
	];
	replace(
		container,
		h(
			"section",
			{ class: "hub" },
			h(
				"div",
				{ class: "hub-inner hub-pick" },
				h("h1", { class: "hub-title" }, first ? t("Welcome back, {name}.", { name: first }) : t("Your companies")),
				h("p", { class: "hub-lead" }, t("Pick a company.")),
				state.connectionLost ? notice("neutral", t("Can't reach Qorpera. Trying again…")) : null,
				state.error ? notice("danger", state.error) : null,
				state.creationRetry && !state.creating
					? button(
							t("Resume creating {name}", {
								name: companyInSentence(state.creationRetry.name || UNNAMED_COMPANY),
							}),
							() => void hub.createCompany(state.creationRetry!.name, state.creationRetry),
						)
					: null,
				firstRead
					? companyCardsSkeleton()
					: h(
							"nav",
							{
								class: "company-grid",
								"aria-label": t("Your companies"),
								oncontextmenu: (event: MouseEvent) => openCompanyMenu(hub, event),
							},
							...tiles,
						),
			),
		),
	);
}

function texts(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
		: [];
}
