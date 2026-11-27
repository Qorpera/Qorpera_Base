import type { BindSurfaceRepositoryInput } from "@qorpera/cloud-client/surfaces";
import {
	type CompanyCodeRepositorySummary,
	isSurfaceDefaultBranch,
	isSurfaceRepositoryKey,
	isSurfaceRepositorySubpath,
	normalizeSurfaceRepositorySubpath,
} from "@qorpera/contracts";
import { CloudRpcError } from "../../cloud/client.ts";
import {
	type CompanySiteHostingState,
	cleanSiteSlugInput,
	type DomainCheckReason,
	dnsRecordFound,
	dnsShop,
	domainDnsSetup,
	isApexHostname,
	NATIVE_SITE_HOST,
	parseDomainCheck,
	registrableDomain,
	type SiteCustomDomain,
	type SiteDnsRecord,
	siteDnsRecords,
	type UpdatedSiteSlug,
	validateCustomDomainInput,
	validateSiteSlugInput,
	type WebSiteHosting,
} from "../../cloud/site-hosting.ts";
import { h, icon, replace } from "../../ui/dom.ts";
import { phrase, t } from "../../ui/preferences.ts";
import { pressToCopy, toClipboard } from "./site-shared.ts";
import { APPROVE_ARM_MS, approveLabel } from "./surface-session-drawer.ts";

export interface SurfaceSiteHosting {
	readonly siteId: string;
	readonly client: WebSiteHosting;
}

export interface SurfaceCodeSourceBinding {
	readonly repositoryKey: string | null;
	readonly repositorySubpath: string | null;
	readonly defaultBranch: string;
	readonly listRepositories: (signal?: AbortSignal) => Promise<readonly CompanyCodeRepositorySummary[]>;
	readonly save: (input: BindSurfaceRepositoryInput) => Promise<boolean>;
	readonly lastError?: () => string | undefined;
}

export interface SurfaceAddressSetup {
	readonly container: HTMLElement;
	readonly canManage: () => boolean;
	readonly changed: () => void;
	readonly signal: AbortSignal;
	readonly beforePublic?: () => Promise<boolean>;
	readonly publicChanged?: (isPublic: boolean) => void;
	readonly slugChanged?: (updated: UpdatedSiteSlug) => void;
	readonly codeSource?: () => SurfaceCodeSourceBinding | undefined;
}

export type AddressMark = "unknown" | "private" | "live";

interface Known {
	slug: string;
	isPublic: boolean;
	domains: SiteCustomDomain[];
	readonly hosting: CompanySiteHostingState;
}

type Page =
	| { readonly kind: "main" }
	| { readonly kind: "edit" }
	| { readonly kind: "source" }
	| { readonly kind: "add"; readonly from?: string }
	| { readonly kind: "domain"; readonly hostname: string };

type Shown =
	| { readonly kind: "main" }
	| { readonly kind: "edit" }
	| { readonly kind: "source" }
	| { readonly kind: "add"; readonly from?: string }
	| { readonly kind: "domain"; readonly domain: SiteCustomDomain };

type SlugCheckState =
	| { readonly kind: "idle" }
	| { readonly kind: "checking"; readonly slug: string }
	| { readonly kind: "available"; readonly slug: string }
	| { readonly kind: "unavailable"; readonly slug: string }
	| { readonly kind: "too_short"; readonly slug: string }
	| { readonly kind: "invalid"; readonly slug: string }
	| { readonly kind: "error"; readonly slug: string };

interface Row {
	readonly key: string;
	readonly glyph: string;
	readonly label: string;
	readonly press?: () => void;
	readonly href?: string;
	readonly end?: Node | null;
	readonly quiet?: boolean;
}

export const ADDRESS_POLL_MS = 15_000;
export const ADDRESS_RECHECK_GAP_MS = 60_000;
export const ADDRESS_SLUG_CHECK_MS = 300;
export const ADDRESS_SECURING_MS = 5 * 60_000;
const ADDRESS_DOMAIN_LIMIT = 5;
const COPIED_MS = 1600;
const MAIN = { kind: "main" } as const;

const REFUSALS: Readonly<Record<string, string>> = {
	PUBLIC_SITES_DISABLED: phrase("Sites cannot go live for everyone yet."),
	SITE_CONTAINS_CREDENTIAL_INPUTS: phrase(
		"The site has a place to sign in or type a password, so it cannot go live yet.",
	),
	CUSTOM_DOMAINS_DISABLED: phrase("Your own domain cannot be added yet."),
	SITE_DOMAIN_LIMIT_REACHED: phrase("A site can have five domains at most."),
	DOMAIN_INVALID: phrase("That does not look like a domain."),
	DOMAIN_NOT_VERIFIED: phrase("The domain does not point here yet."),
	SITE_TAKEN_DOWN: phrase("Qorpera took this site down, so this cannot change now."),
	SITE_SLUG_INVALID: phrase("Use 3–48 lowercase letters, numbers, and single hyphens."),
	SITE_SLUG_TAKEN: phrase("That address is already taken."),
	SITE_KIND_UNSUPPORTED: phrase("This address cannot be changed here."),
};
const MANAGERS_ONLY = phrase("Only founders and admins can change this.");
const NOT_GONE_LIVE = phrase("The site did not go live. Try again.");

export function addressRefusal(error: unknown, fallback: string): string {
	if (!(error instanceof CloudRpcError)) return t(fallback);
	const known = REFUSALS[error.message.trim()];
	if (known) return t(known);
	if (error.code === "23505") return t("That domain is already used by another site.");
	if (error.code === "42501") return t(MANAGERS_ONLY);
	return t(fallback);
}

function verified(domain: SiteCustomDomain): boolean {
	return domain.status === "dns_verified" || domain.status === "tls_active";
}

function securing(domain: SiteCustomDomain): boolean {
	if (domain.status !== "dns_verified" || !domain.verifiedAt) return false;
	const at = Date.parse(domain.verifiedAt);
	return Number.isFinite(at) && Date.now() - at < ADDRESS_SECURING_MS;
}

function connected(domain: SiteCustomDomain): boolean {
	return verified(domain) && !securing(domain);
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

function cleanDomain(text: string): string {
	return text
		.trim()
		.toLowerCase()
		.replace(/^https?:\/\//, "")
		.replace(/[/?#].*$/, "")
		.replace(/\.$/, "");
}

function pending(hostname: string): SiteCustomDomain {
	return {
		id: "",
		hostname,
		isApex: isApexHostname(hostname),
		isPrimary: false,
		status: "pending_dns",
		verificationToken: "",
		lastCheckedAt: null,
		verifiedAt: null,
		tlsActiveAt: null,
		lastError: null,
	};
}

function openLine(count: number, shop: string | null, domain: string): string {
	if (shop) {
		if (count === 2) return t("Open the DNS settings at {shop} and create these two records.", { shop });
		if (count === 3) return t("Open the DNS settings at {shop} and create these three records.", { shop });
		return t("Open the DNS settings at {shop} and create these records.", { shop });
	}
	if (count === 2)
		return t("Open the DNS settings where you bought {domain} and create these two records.", { domain });
	if (count === 3)
		return t("Open the DNS settings where you bought {domain} and create these three records.", { domain });
	return t("Open the DNS settings where you bought {domain} and create these records.", { domain });
}

function waitLine(found: number, count: number): string {
	if (found === 0) return t("None found yet. We look again every 30 seconds.");
	if (found === 1 && count === 2) return t("One of two found. We look again every 30 seconds.");
	return t("{found} of {count} found. We look again every 30 seconds.", { found, count });
}

function laterLine(count: number, shop: string | null): string {
	if (shop) {
		if (count === 2)
			return t("Your two lines can go in at {shop} already. We'll find them as soon as the domain is on.", { shop });
		if (count === 3)
			return t("Your three lines can go in at {shop} already. We'll find them as soon as the domain is on.", {
				shop,
			});
		return t("Your lines can go in at {shop} already. We'll find them as soon as the domain is on.", { shop });
	}
	if (count === 2) return t("Your two lines can go in already. We'll find them as soon as the domain is on.");
	if (count === 3) return t("Your three lines can go in already. We'll find them as soon as the domain is on.");
	return t("Your lines can go in already. We'll find them as soon as the domain is on.");
}

function confirmText(hostname: string, shop: string | null): string {
	if (hostname.endsWith(".dk"))
		return t(
			"New .dk domains wait until the owner confirms them. Look for an email from Punktum dk and confirm with MitID. It usually takes a few minutes after that.",
		);
	return shop
		? t(
				"New domains can take a while before they are switched on. Check your email from {shop} for a confirmation step.",
				{
					shop,
				},
			)
		: t(
				"New domains can take a while before they are switched on. Check your email from the shop where you bought it for a confirmation step.",
			);
}

function shopsNote(hostname: string): string {
	return t("Some shops call Hostname “Name” or “Host”. The shop adds “.{domain}” by itself.", {
		domain: registrableDomain(hostname),
	});
}

function filled(template: string, parts: Readonly<Record<string, Node>>): (Node | string)[] {
	return template
		.split(/\{(\w+)\}/)
		.map((piece, index) => (index % 2 === 1 ? (parts[piece]?.cloneNode(true) ?? `{${piece}}`) : piece));
}

function chip(type: string): HTMLElement {
	return h("b", { class: "surface-address-chip" }, type);
}

function pageName(page: Shown): string {
	return page.kind === "domain" ? `domain:${page.domain.hostname}` : page.kind;
}

export class SurfaceAddress {
	readonly #setup: SurfaceAddressSetup;
	readonly #sheet = h("div", { class: "surface-address-sheet", role: "dialog", tabindex: "-1", hidden: true });
	readonly #field = h("input", {
		type: "text",
		class: "surface-address-input",
		maxlength: "253",
		autocomplete: "off",
		autocapitalize: "none",
		spellcheck: "false",
		"data-key": "field",
	});
	readonly #slugField = h("input", {
		type: "text",
		class: "surface-address-slug-input",
		maxlength: "48",
		autocomplete: "off",
		autocapitalize: "none",
		spellcheck: "false",
		"data-key": "slug-field",
	});
	readonly #sourceRepoSelect = h("select", {
		class: "surface-address-select",
		"data-key": "source-repo-select",
	});
	readonly #sourceRepoField = h("input", {
		type: "text",
		class: "surface-address-input",
		maxlength: "140",
		autocomplete: "off",
		autocapitalize: "none",
		spellcheck: "false",
		"data-key": "source-repo",
	});
	readonly #sourceSubpathField = h("input", {
		type: "text",
		class: "surface-address-input",
		maxlength: "240",
		autocomplete: "off",
		autocapitalize: "none",
		spellcheck: "false",
		"data-key": "source-subpath",
	});
	readonly #sourceBranchField = h("input", {
		type: "text",
		class: "surface-address-input",
		maxlength: "128",
		autocomplete: "off",
		autocapitalize: "none",
		spellcheck: "false",
		"data-key": "source-branch",
	});
	#target: SurfaceSiteHosting | undefined;
	#liveUrl = "";
	#syncedLiveUrl = "";
	#known: Known | null | undefined;
	#failed = false;
	#problem: string | undefined;
	#open = false;
	#page: Page = MAIN;
	#armed = false;
	#going = false;
	#savingSlug = false;
	#savingSource = false;
	#sourceRepos: readonly CompanyCodeRepositorySummary[] = [];
	#sourceReposLoaded = false;
	#sourceCustomRepo = false;
	#sourceBranchEdited = false;
	#slugCheck: SlugCheckState = { kind: "idle" };
	#slugTimer: ReturnType<typeof setTimeout> | undefined;
	#slugCheckAbort: AbortController | undefined;
	#slugCheckSeq = 0;
	#armTimer: ReturnType<typeof setTimeout> | undefined;
	#reads = 0;
	#writing = 0;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#closeListeners: AbortController | undefined;
	#painted = "";
	#paintedPage = "";
	readonly #rechecked = new Map<string, number>();
	readonly #madePrimary = new Set<string>();

	constructor(setup: SurfaceAddressSetup) {
		this.#setup = setup;
		this.#field.setAttribute("aria-label", t("Your own domain"));
		this.#field.placeholder = t("yourdomain.com");
		this.#slugField.setAttribute("aria-label", t("Site address"));
		this.#slugField.addEventListener("input", () => this.#onSlugInput());
		this.#sourceRepoSelect.setAttribute("aria-label", t("Repository"));
		this.#sourceRepoSelect.addEventListener("change", () => this.#onSourceRepoSelect());
		this.#sourceRepoField.setAttribute("aria-label", t("Repository key"));
		this.#sourceRepoField.placeholder = t("owner/repository");
		this.#sourceSubpathField.setAttribute("aria-label", t("Subfolder (optional)"));
		this.#sourceSubpathField.placeholder = t("e.g. packages/web");
		this.#sourceBranchField.setAttribute("aria-label", t("Upstream branch"));
		this.#sourceBranchField.placeholder = t("e.g. main");
		this.#sourceBranchField.addEventListener("input", () => {
			this.#sourceBranchEdited = true;
		});
		setup.container.append(this.#sheet);
		setup.signal.addEventListener("abort", () => this.close(), { once: true });
	}

	get isOpen(): boolean {
		return this.#open;
	}

	get isWriting(): boolean {
		return this.#writing > 0 || this.#going || this.#savingSlug || this.#savingSource;
	}

	get readFailed(): boolean {
		return this.#failed;
	}

	sync(shown: boolean, target: SurfaceSiteHosting | undefined, liveUrl: string | null): string {
		const url = shown && liveUrl ? liveUrl : "";
		const next = url ? target : undefined;
		if (
			Boolean(url) !== Boolean(this.#liveUrl) ||
			next?.siteId !== this.#target?.siteId ||
			next?.client !== this.#target?.client
		) {
			this.#shut();
			this.#target = next;
			this.#known = undefined;
			this.#failed = false;
			this.#problem = undefined;
			this.#field.value = "";
			this.#slugField.value = "";
			this.#savingSlug = false;
			this.#savingSource = false;
			this.#sourceRepos = [];
			this.#sourceReposLoaded = false;
			this.#sourceCustomRepo = false;
			this.#sourceBranchEdited = false;
			this.#liveUrl = url;
			this.#syncedLiveUrl = url;
			if (next) void this.#read();
		} else if (url !== this.#syncedLiveUrl) {
			this.#syncedLiveUrl = url;
			this.#liveUrl = url;
		}
		if (this.#open && this.#paintKey() !== this.#painted) this.#paint();
		return url ? JSON.stringify([this.mark(), this.name(), this.#open]) : "";
	}

	mark(): AddressMark {
		const known = this.#known;
		if (known === undefined) return "unknown";
		return known?.isPublic ? "live" : "private";
	}

	name(): string {
		return this.#working()?.hostname ?? hostOf(this.#liveUrl);
	}

	#working(): SiteCustomDomain | undefined {
		const domains = this.#known?.domains ?? [];
		return domains.find((domain) => domain.isPrimary && connected(domain)) ?? domains.find(connected);
	}

	#openUrl(): string {
		const working = this.#working();
		return working ? `https://${working.hostname}/` : this.#liveUrl;
	}

	button(): HTMLButtonElement | null {
		if (!this.#liveUrl) return null;
		const mark = this.mark();
		const title = mark === "private" ? t("Not live yet") : mark === "live" ? t("Live") : this.name();
		return h(
			"button",
			{
				type: "button",
				class: `surface-pill-address is-${mark}`,
				"aria-haspopup": "dialog",
				"aria-expanded": String(this.#open),
				"data-act": "address",
				title,
			},
			h("span", { class: "surface-address-dot", "aria-hidden": "true" }, mark === "private" ? icon("lock") : null),
			h("span", { class: "surface-address-host" }, this.name()),
		);
	}

	toggle(fromKeyboard = false): void {
		if (this.#open) this.close(true);
		else this.open(fromKeyboard);
	}

	open(fromKeyboard = false): void {
		if (this.#open || !this.#liveUrl || this.#setup.signal.aborted) return;
		const takeFocus = fromKeyboard || document.activeElement === this.#addressButton();
		this.#open = true;
		this.#problem = undefined;
		this.#page = MAIN;
		const listeners = new AbortController();
		this.#closeListeners = listeners;
		document.addEventListener(
			"pointerdown",
			(event) => {
				const target = event.target;
				if (!(target instanceof Node)) return;
				if (this.#armed && !(target instanceof Element && target.closest("[data-armed='true']")))
					this.#disarm(true);
				if (this.#sheet.contains(target)) return;
				if (target instanceof Element && target.closest(".surface-pill-address")) return;
				this.close();
			},
			{ capture: true, signal: listeners.signal },
		);
		document.addEventListener(
			"keydown",
			(event) => {
				if (event.key !== "Escape" || event.isComposing) return;
				event.preventDefault();
				event.stopPropagation();
				this.close(true);
			},
			{ capture: true, signal: listeners.signal },
		);
		window.addEventListener("hashchange", () => this.close(), { signal: listeners.signal });
		this.#paint();
		this.#setup.changed();
		if (takeFocus) this.#sheet.focus();
		void this.#read().then(() => this.#recheck());
	}

	close(focusAddress = false): void {
		if (!this.#open) return;
		this.#shut();
		if (!this.#setup.signal.aborted) this.#setup.changed();
		if (focusAddress) this.#addressButton()?.focus();
	}

	#shut(): void {
		if (!this.#open) return;
		this.#open = false;
		this.#closeListeners?.abort();
		this.#closeListeners = undefined;
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#cancelSlugCheck();
		this.#disarm(false);
		this.#sheet.hidden = true;
		this.#sheet.replaceChildren();
		this.#painted = "";
		this.#paintedPage = "";
		this.#page = MAIN;
		this.#problem = undefined;
	}

	#addressButton(): HTMLElement | null {
		return this.#setup.container.querySelector<HTMLElement>(".surface-pill-address");
	}

	async #read(): Promise<void> {
		const target = this.#target;
		if (!target || this.#setup.signal.aborted) return;
		const turn = ++this.#reads;
		let state: CompanySiteHostingState | undefined;
		try {
			state = await target.client.read(this.#setup.signal);
		} catch {
			state = undefined;
		}
		if (this.#setup.signal.aborted || target !== this.#target || turn !== this.#reads) return;
		if (this.#writing > 0) return;
		if (state) {
			const entry = state.sites.get(target.siteId);
			this.#failed = false;
			this.#known = entry
				? { slug: entry.slug, isPublic: entry.isPublic, domains: [...entry.domains], hosting: state }
				: null;
		} else {
			this.#failed = true;
		}
		this.#changed();
		this.#schedule();
		this.#claimPrimary();
	}

	#claimPrimary(): void {
		const known = this.#known;
		if (!known || this.#writing > 0 || !this.#setup.canManage()) return;
		if (known.domains.some((domain) => domain.isPrimary && verified(domain))) return;
		const first = known.domains.find((domain) => domain.id && verified(domain));
		if (!first || this.#madePrimary.has(first.id)) return;
		this.#madePrimary.add(first.id);
		this.#usePrimary(first);
	}

	#copy(label: HTMLElement, text: string, refused: () => void): void {
		void toClipboard(text).then((copied) => {
			if (!copied) return refused();
			const before = label.textContent;
			label.textContent = t("Copied");
			setTimeout(() => {
				if (label.textContent === t("Copied")) label.textContent = before;
			}, COPIED_MS);
		});
	}

	#select(shown: Element | null | undefined): void {
		const selection = window.getSelection();
		if (!shown || !selection) return;
		const range = document.createRange();
		range.selectNodeContents(shown);
		selection.removeAllRanges();
		selection.addRange(range);
	}

	#waitingDomains(): SiteCustomDomain[] {
		return this.#known?.domains.filter((domain) => domain.id && !verified(domain)) ?? [];
	}

	#schedule(): void {
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = undefined;
		if (!this.#open || (this.#waitingDomains().length === 0 && !this.#known?.domains.some(securing))) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.#read();
		}, ADDRESS_POLL_MS);
	}

	#recheck(): void {
		const target = this.#target;
		if (!target || !this.#open || !this.#setup.canManage()) return;
		const now = Date.now();
		for (const domain of this.#waitingDomains()) {
			const last = this.#rechecked.get(domain.id);
			if (last !== undefined && now - last < ADDRESS_RECHECK_GAP_MS) continue;
			this.#rechecked.set(domain.id, now);
			target.client.recheckDomain(domain.id, this.#setup.signal).catch(() => undefined);
		}
	}

	#changed(): void {
		if (this.#open && this.#paintKey() !== this.#painted) this.#paint();
		this.#setup.changed();
	}

	async #write<T>(
		apply: (known: Known) => (known: Known) => void,
		call: (client: WebSiteHosting, siteId: string) => Promise<T>,
		fallback: string | null,
		done?: (known: Known, result: T) => void,
	): Promise<boolean> {
		const target = this.#target;
		const known = this.#known;
		if (!target || !known || !this.#setup.canManage()) return false;
		this.#problem = undefined;
		const undo = apply(known);
		this.#writing++;
		this.#changed();
		let result: { value: T } | undefined;
		let failure: unknown;
		try {
			result = { value: await call(target.client, target.siteId) };
		} catch (error) {
			failure = error;
		}
		this.#writing--;
		if (this.#setup.signal.aborted || target !== this.#target) return false;
		const now = this.#known;
		if (now) {
			if (result) done?.(now, result.value);
			else {
				undo(now);
				if (fallback !== null) this.#problem = addressRefusal(failure, fallback);
			}
		}
		this.#changed();
		if (this.#writing === 0) void this.#read();
		return Boolean(result);
	}

	#setPublic(next: boolean): void {
		void this.#write(
			(known) => {
				known.isPublic = next;
				return (now) => {
					if (now.isPublic === next) now.isPublic = !next;
				};
			},
			(client, siteId) => client.setPublic(siteId, next, this.#setup.signal),
			next ? NOT_GONE_LIVE : phrase("The site is still live. Try again."),
			() => this.#setup.publicChanged?.(next),
		);
	}

	#goLive(): void {
		if (this.#going) return;
		if (!this.#armed) {
			this.#arm();
			return;
		}
		this.#disarm(false);
		const before = this.#setup.beforePublic;
		if (!before) {
			this.#setPublic(true);
			return;
		}
		const target = this.#target;
		this.#going = true;
		this.#problem = undefined;
		this.#swapGo();
		this.#changed();
		void before()
			.catch(() => false)
			.then((ready) => {
				this.#going = false;
				if (this.#setup.signal.aborted || target !== this.#target) return;
				if (ready) {
					this.#setPublic(true);
					return;
				}
				this.#problem = t(NOT_GONE_LIVE);
				this.#changed();
			});
	}

	#arm(): void {
		if (this.#armTimer !== undefined) clearTimeout(this.#armTimer);
		this.#armed = true;
		this.#armTimer = setTimeout(() => this.#disarm(true), APPROVE_ARM_MS);
		this.#swapGo();
	}

	#disarm(swap: boolean): void {
		if (this.#armTimer !== undefined) clearTimeout(this.#armTimer);
		this.#armTimer = undefined;
		if (!this.#armed) return;
		this.#armed = false;
		if (swap) this.#swapGo();
	}

	#swapGo(): void {
		const shown = this.#sheet.querySelector(".surface-address-go");
		if (!shown || !this.#open) return;
		const focused = document.activeElement === shown;
		const next = this.#goButton();
		shown.replaceWith(next);
		this.#painted = this.#paintKey();
		if (focused) (next.disabled ? this.#sheet : next).focus();
	}

	#go(page: Page): void {
		const inside = this.#sheet.contains(document.activeElement);
		const from = this.#page;
		if (from.kind === "edit" && page.kind !== "edit") this.#cancelSlugCheck();
		this.#problem = undefined;
		this.#disarm(false);
		this.#page = page;
		this.#paint();
		if (inside) this.#land(from);
	}

	#land(from: Page): void {
		const page = this.#shown();
		const back =
			page.kind !== "main"
				? null
				: from.kind === "domain"
					? this.#sheet.querySelector<HTMLElement>(`[data-key="domain:${from.hostname}"]`)
					: from.kind === "add"
						? this.#sheet.querySelector<HTMLElement>('[data-key="add"]')
						: from.kind === "edit"
							? this.#sheet.querySelector<HTMLElement>('[data-key="edit-slug"]')
							: from.kind === "source"
								? this.#sheet.querySelector<HTMLElement>('[data-key="code-source"]')
								: null;
		const target =
			page.kind === "add" && this.#field.isConnected
				? this.#field
				: page.kind === "edit" && this.#slugField.isConnected
					? this.#slugField
					: page.kind === "source" && this.#sourceRepoSelect.isConnected
						? this.#sourceRepoSelect
						: page.kind === "source" && this.#sourceRepoField.isConnected
							? this.#sourceRepoField
							: (back ?? this.#sheet.querySelector<HTMLElement>(".surface-address-back"));
		(target ?? this.#sheet).focus();
	}

	#nativeSuffix(): string {
		const host = hostOf(this.#liveUrl);
		if (NATIVE_SITE_HOST.test(host)) return host.slice(host.indexOf("."));
		const hosting = this.#known?.hosting;
		return hosting?.hostsEnabled && hosting.hostsDomain ? `.${hosting.hostsDomain}` : "";
	}

	#currentSlug(): string {
		const match = NATIVE_SITE_HOST.exec(hostOf(this.#liveUrl));
		return match?.[1] ?? this.#known?.slug ?? "";
	}

	#canEditSlug(): boolean {
		return Boolean(
			this.#known?.hosting.hostsEnabled && this.#setup.canManage() && !this.#working() && this.#nativeSuffix(),
		);
	}

	#openEdit(): void {
		if (!this.#canEditSlug()) return;
		this.#cancelSlugCheck();
		this.#slugField.value = this.#currentSlug();
		this.#go({ kind: "edit" });
		if (this.#slugField.isConnected) {
			this.#slugField.focus();
			this.#slugField.select();
		}
	}

	#cancelSlugCheck(): void {
		if (this.#slugTimer !== undefined) clearTimeout(this.#slugTimer);
		this.#slugTimer = undefined;
		this.#slugCheckAbort?.abort();
		this.#slugCheckAbort = undefined;
		this.#slugCheckSeq++;
		this.#slugCheck = { kind: "idle" };
	}

	#onSlugInput(): void {
		if (this.#problem !== undefined) {
			this.#problem = undefined;
			this.#sheet.querySelector(".surface-address-problem")?.remove();
			this.#painted = this.#paintKey();
		}
		this.#cancelSlugCheck();
		const cleaned = cleanSiteSlugInput(this.#slugField.value);
		const current = this.#currentSlug();
		if (!cleaned || cleaned === current) {
			this.#syncSlugUi();
			return;
		}
		const seq = this.#slugCheckSeq;
		this.#syncSlugUi();
		this.#slugTimer = setTimeout(() => {
			this.#slugTimer = undefined;
			if (seq !== this.#slugCheckSeq || !this.#open || this.#page.kind !== "edit") return;
			this.#runSlugCheck(cleaned, seq);
		}, ADDRESS_SLUG_CHECK_MS);
	}

	#runSlugCheck(cleaned: string, seq: number): void {
		const problem = validateSiteSlugInput(cleaned);
		if (problem === "reserved") {
			this.#slugCheck = { kind: "unavailable", slug: cleaned };
			this.#syncSlugUi();
			return;
		}
		if (problem === "too_short" || problem === "invalid") {
			this.#slugCheck = { kind: problem, slug: cleaned };
			this.#syncSlugUi();
			return;
		}
		const target = this.#target;
		if (!target || this.#setup.signal.aborted) return;
		const abort = new AbortController();
		this.#slugCheckAbort = abort;
		this.#slugCheck = { kind: "checking", slug: cleaned };
		this.#syncSlugUi();
		const signal = AbortSignal.any([this.#setup.signal, abort.signal]);
		void target.client
			.checkSlug(target.siteId, cleaned, signal)
			.then(
				(result) => {
					if (
						this.#setup.signal.aborted ||
						abort.signal.aborted ||
						target !== this.#target ||
						seq !== this.#slugCheckSeq ||
						!this.#open ||
						this.#page.kind !== "edit"
					)
						return;
					if (cleanSiteSlugInput(this.#slugField.value) !== cleaned) return;
					if (result.reason === "current") this.#slugCheck = { kind: "idle" };
					else if (result.available) this.#slugCheck = { kind: "available", slug: cleaned };
					else if (result.reason === "invalid") this.#slugCheck = { kind: "invalid", slug: cleaned };
					else this.#slugCheck = { kind: "unavailable", slug: cleaned };
					this.#syncSlugUi();
				},
				(error: unknown) => {
					if (
						this.#setup.signal.aborted ||
						abort.signal.aborted ||
						target !== this.#target ||
						seq !== this.#slugCheckSeq ||
						!this.#open ||
						this.#page.kind !== "edit"
					)
						return;
					if (cleanSiteSlugInput(this.#slugField.value) !== cleaned) return;
					if (error instanceof CloudRpcError && error.message.trim() === "SITE_TAKEN_DOWN") {
						this.#slugCheck = { kind: "idle" };
						this.#problem = addressRefusal(error, phrase("The address could not be changed. Try again."));
						this.#paint();
						return;
					}
					this.#slugCheck = { kind: "error", slug: cleaned };
					this.#syncSlugUi();
				},
			)
			.finally(() => {
				if (this.#slugCheckAbort === abort) this.#slugCheckAbort = undefined;
			});
	}

	#saveSlug(): void {
		if (this.#savingSlug || !this.#target || !this.#known || !this.#setup.canManage()) return;
		const cleaned = cleanSiteSlugInput(this.#slugField.value);
		const current = this.#currentSlug();
		if (!cleaned || cleaned === current) {
			this.#slugField.focus();
			return;
		}
		const problem = validateSiteSlugInput(cleaned);
		if (problem !== undefined) {
			this.#cancelSlugCheck();
			this.#slugCheck = { kind: problem === "reserved" ? "unavailable" : problem, slug: cleaned };
			this.#syncSlugUi();
			this.#slugField.focus();
			return;
		}
		if (this.#slugCheck.kind !== "available" || this.#slugCheck.slug !== cleaned) {
			if (this.#slugTimer !== undefined) {
				clearTimeout(this.#slugTimer);
				this.#slugTimer = undefined;
				this.#runSlugCheck(cleaned, this.#slugCheckSeq);
			}
			this.#slugField.focus();
			return;
		}
		const target = this.#target;
		const inside = this.#sheet.contains(document.activeElement);
		this.#savingSlug = true;
		this.#writing++;
		this.#problem = undefined;
		this.#syncSlugUi();
		this.#setup.changed();
		void target.client.setSlug(target.siteId, cleaned, this.#setup.signal).then(
			(updated) => {
				this.#savingSlug = false;
				this.#writing--;
				if (this.#setup.signal.aborted || target !== this.#target) return;
				if (this.#known) this.#known.slug = updated.slug;
				this.#liveUrl = updated.url;
				this.#cancelSlugCheck();
				this.#page = MAIN;
				this.#setup.slugChanged?.(updated);
				this.#changed();
				if (inside && this.#open) this.#land({ kind: "edit" });
				if (this.#writing === 0) void this.#read();
			},
			(error: unknown) => {
				this.#savingSlug = false;
				this.#writing--;
				if (this.#setup.signal.aborted || target !== this.#target) return;
				if (
					error instanceof CloudRpcError &&
					(error.message.trim() === "SITE_SLUG_TAKEN" || error.code === "23505")
				) {
					this.#slugCheck = { kind: "unavailable", slug: cleaned };
					this.#problem = undefined;
					this.#syncSlugUi();
				} else {
					this.#problem = addressRefusal(error, phrase("The address could not be changed. Try again."));
					this.#paint();
				}
				if (this.#open && this.#slugField.isConnected) this.#slugField.focus();
				this.#setup.changed();
			},
		);
	}

	#slugCanSave(): boolean {
		if (this.#savingSlug) return false;
		const cleaned = cleanSiteSlugInput(this.#slugField.value);
		return (
			Boolean(cleaned) &&
			cleaned !== this.#currentSlug() &&
			this.#slugCheck.kind === "available" &&
			this.#slugCheck.slug === cleaned
		);
	}

	#availabilityElement(): HTMLElement {
		const check = this.#slugCheck;
		let tone = "";
		let label = "";
		if (check.kind === "checking") {
			tone = "is-checking";
			label = t("Checking…");
		} else if (check.kind === "available") {
			tone = "is-available";
			label = t("Available");
		} else if (check.kind === "unavailable") {
			tone = "is-unavailable";
			label = t("Unavailable");
		} else if (check.kind === "too_short") {
			tone = "is-invalid";
			label = t("At least 3 characters.");
		} else if (check.kind === "invalid") {
			tone = "is-invalid";
			label = t("Use lowercase letters, numbers, and single hyphens.");
		} else if (check.kind === "error") {
			tone = "is-invalid";
			label = t("Could not check availability.");
		}
		return h(
			"span",
			{
				class: ["surface-address-availability", tone].filter(Boolean).join(" "),
				role: "status",
				"aria-live": "polite",
				hidden: !label,
			},
			h("span", { class: "surface-address-availability-dot", "aria-hidden": "true" }),
			h("span", { class: "surface-address-availability-text" }, label),
		);
	}

	#syncSlugUi(): void {
		if (!this.#open || this.#page.kind !== "edit") return;
		const status = this.#sheet.querySelector(".surface-address-availability");
		if (status) status.replaceWith(this.#availabilityElement());
		const save = this.#sheet.querySelector<HTMLButtonElement>('[data-key="save-slug"]');
		if (save) {
			save.disabled = !this.#slugCanSave();
			save.textContent = this.#savingSlug ? t("Saving…") : t("Save");
		}
		const box = this.#sheet.querySelector(".surface-address-slug-box");
		if (box) {
			box.classList.toggle("is-available", this.#slugCheck.kind === "available");
			box.classList.toggle("is-unavailable", this.#slugCheck.kind === "unavailable");
		}
	}

	#addDomain(): void {
		const typed = this.#field.value;
		const hostname = cleanDomain(typed);
		if (!hostname) {
			this.#field.focus();
			return;
		}
		if (validateCustomDomainInput(hostname)) {
			this.#problem = t("That does not look like a domain.");
			this.#paint();
			this.#field.focus();
			return;
		}
		if (this.#known?.domains.some((domain) => domain.hostname === hostname)) {
			this.#field.value = "";
			this.#go({ kind: "domain", hostname });
			return;
		}
		const inside = this.#sheet.contains(document.activeElement);
		const from = this.#page;
		this.#field.value = "";
		this.#problem = undefined;
		this.#page = { kind: "domain", hostname };
		void this.#write(
			(known) => {
				known.domains = [...known.domains, pending(hostname)];
				return (now) => {
					now.domains = now.domains.filter((domain) => !(domain.id === "" && domain.hostname === hostname));
					if (!this.#field.value) this.#field.value = typed;
					if (this.#page.kind === "domain" && this.#page.hostname === hostname) this.#page = from;
				};
			},
			(client, siteId) => client.addDomain(siteId, hostname, isApexHostname(hostname), this.#setup.signal),
			phrase("The domain could not be added. Try again."),
			(known, added) => {
				known.domains = known.domains.map((domain) =>
					domain.id === "" && domain.hostname === hostname
						? {
								...domain,
								id: added.id,
								hostname: added.hostname,
								isApex: added.isApex,
								isPrimary: added.isPrimary,
								status: added.status,
								verificationToken: added.verificationToken,
							}
						: domain,
				);
			},
		).then((added) => {
			if (!added && this.#open && this.#field.isConnected) this.#field.focus();
		});
		if (inside && this.#open) this.#land(from);
	}

	#usePrimary(chosen: SiteCustomDomain): void {
		void this.#write(
			(known) => {
				const before = new Map(known.domains.map((domain) => [domain.id, domain.isPrimary]));
				known.domains = known.domains.map((domain) => ({ ...domain, isPrimary: domain.id === chosen.id }));
				return (now) => {
					if (!now.domains.some((domain) => domain.id === chosen.id && domain.isPrimary)) return;
					now.domains = now.domains.map((domain) => ({
						...domain,
						isPrimary: before.get(domain.id) ?? false,
					}));
				};
			},
			(client) => client.setPrimaryDomain(chosen.id, this.#setup.signal),
			null,
		);
	}

	#removeDomain(gone: SiteCustomDomain): void {
		const inside = this.#sheet.contains(document.activeElement);
		void this.#write(
			(known) => {
				const at = known.domains.findIndex((domain) => domain.id === gone.id);
				known.domains = known.domains.filter((domain) => domain.id !== gone.id);
				this.#page = MAIN;
				return (now) => {
					if (now.domains.some((domain) => domain.id === gone.id)) return;
					const domains = [...now.domains];
					domains.splice(Math.max(0, Math.min(at, domains.length)), 0, gone);
					now.domains = domains;
				};
			},
			(client) => client.removeDomain(gone.id, this.#setup.signal),
			phrase("The domain is still there. Try again."),
		);
		if (inside && !this.#sheet.contains(document.activeElement)) this.#sheet.focus();
	}

	#shown(): Shown {
		const page = this.#page;
		const known = this.#known;
		if (page.kind === "source") {
			return this.#setup.canManage() && this.#setup.codeSource?.() ? page : MAIN;
		}
		if (!known) return MAIN;
		if (page.kind === "edit") return this.#canEditSlug() ? page : MAIN;
		if (page.kind === "add")
			return this.#setup.canManage() && known.hosting.domainsEnabled && known.domains.length < ADDRESS_DOMAIN_LIMIT
				? page
				: MAIN;
		if (page.kind === "domain") {
			const domain = known.domains.find((item) => item.hostname === page.hostname);
			if (!domain || (connected(domain) && !this.#setup.canManage())) return MAIN;
			return { kind: "domain", domain };
		}
		return MAIN;
	}

	#paintKey(): string {
		const known = this.#known;
		const source = this.#setup.codeSource?.();
		return JSON.stringify([
			this.#liveUrl,
			this.#setup.canManage(),
			this.#failed,
			this.#problem ?? "",
			this.#page,
			this.#armed,
			this.#going,
			this.#savingSource,
			this.#sourceCustomRepo,
			this.#sourceReposLoaded,
			this.#sourceRepos.map((repo) => [repo.repositoryKey, repo.sourceBranch]),
			source ? [source.repositoryKey ?? "", source.repositorySubpath ?? "", source.defaultBranch] : null,
			known === undefined
				? "unknown"
				: known === null
					? "none"
					: [
							known.slug,
							known.isPublic,
							known.hosting.hostsDomain,
							known.hosting.hostsEnabled,
							known.hosting.publicEnabled,
							known.hosting.domainsEnabled,
							known.hosting.edgeIpv4,
							known.hosting.edgeIpv6,
							known.hosting.edgeCnameTarget,
							known.domains.map((domain) => [
								domain.id,
								domain.hostname,
								domain.status,
								domain.isPrimary,
								domain.isApex,
								domain.verificationToken,
								domain.lastCheckedAt !== null,
								domain.lastError,
								securing(domain),
							]),
						],
		]);
	}

	#paint(): void {
		if (!this.#open) return;
		const key = this.#paintKey();
		const focused = document.activeElement;
		const focusKey =
			focused instanceof HTMLElement && this.#sheet.contains(focused) ? focused.dataset.key : undefined;
		const first = this.#sheet.hidden;
		this.#painted = key;
		const shown = this.#shown();
		if (shown.kind !== "edit" && this.#page.kind === "edit") {
			this.#page = MAIN;
			this.#cancelSlugCheck();
		}
		const name = pageName(shown);
		const turned = this.#paintedPage !== "" && this.#paintedPage !== name;
		const forward = turned && shown.kind !== "main";
		this.#paintedPage = name;
		this.#sheet.setAttribute("aria-label", t("Where the site lives"));
		const page = h(
			"div",
			{
				class: ["surface-address-page", turned && (forward ? "is-forward" : "is-backward")]
					.filter(Boolean)
					.join(" "),
				"data-page": name,
			},
			...(shown.kind === "edit"
				? this.#editPage()
				: shown.kind === "source"
					? this.#sourcePage()
					: shown.kind === "add"
						? this.#addPage(shown.from)
						: shown.kind === "domain"
							? securing(shown.domain)
								? this.#securingPage(shown.domain)
								: verified(shown.domain)
									? this.#managePage(shown.domain)
									: this.#handPage(shown.domain)
							: this.#mainPage()),
		);
		replace(this.#sheet, page);
		this.#sheet.hidden = false;
		this.#sheet.classList.toggle("is-entering", first);
		this.#place();
		if (focusKey) this.#sheet.querySelector<HTMLElement>(`[data-key="${focusKey}"]`)?.focus();
	}

	#place(): void {
		const anchor = this.#addressButton();
		const box = this.#setup.container.getBoundingClientRect();
		const from = anchor?.getBoundingClientRect();
		if (!from || box.width <= 0 || from.width <= 0) {
			this.#sheet.classList.remove("is-placed");
			return;
		}
		const width = this.#sheet.offsetWidth;
		const left = Math.max(12, Math.min(from.left - box.left - 6, box.width - width - 12));
		this.#sheet.style.left = `${Math.round(left)}px`;
		this.#sheet.style.top = `${Math.round(from.bottom - box.top + 10)}px`;
		this.#sheet.classList.add("is-placed");
	}

	#problemLine(): HTMLElement | null {
		return this.#problem ? h("p", { class: "surface-address-problem", role: "alert" }, this.#problem) : null;
	}

	#quietLine(text: string): HTMLElement {
		return h("p", { class: "surface-address-quiet" }, text);
	}

	#mainPage(): (HTMLElement | null)[] {
		const known = this.#known;
		const manage = this.#setup.canManage();
		const name = this.name();
		const cut = NATIVE_SITE_HOST.test(name) ? name.indexOf(".") : name.lastIndexOf(".");
		const shownName = h(
			"div",
			{ class: "surface-address-name" },
			cut > 0 ? name.slice(0, cut) : name,
			cut > 0 ? h("span", null, name.slice(cut)) : null,
		);
		const nameRow = this.#canEditSlug()
			? h(
					"div",
					{ class: "surface-address-name-row" },
					shownName,
					h(
						"button",
						{
							type: "button",
							class: "surface-address-edit",
							"aria-label": t("Edit address"),
							title: t("Edit address"),
							"data-key": "edit-slug",
							onclick: () => this.#openEdit(),
						},
						icon("edit"),
					),
				)
			: shownName;
		const under =
			known === undefined
				? this.#failed
					? this.#quietLine(t("Where the site lives could not be read just now."))
					: null
				: known === null
					? this.#quietLine(t("It can go live once its first version is ready."))
					: !manage
						? this.#quietLine(t(MANAGERS_ONLY))
						: known.isPublic
							? null
							: known.hosting.publicEnabled
								? this.#goButton()
								: this.#quietLine(t(REFUSALS.PUBLIC_SITES_DISABLED!));
		const source = manage ? this.#setup.codeSource?.() : undefined;
		const sourceRow = source ? this.#sourceRow(source) : null;
		const head = h("div", { class: "surface-address-head" }, nameRow, under, this.#problemLine());
		if (!known) return [head, sourceRow ? this.#group(sourceRow) : null];
		const domains = known.domains.map((domain) => this.#domainRow(domain, manage));
		if (domains.length === 0 && manage)
			domains.push(
				known.hosting.domainsEnabled
					? this.#row({
							key: "add",
							glyph: "globe",
							label: t("Use your own domain"),
							press: () => this.#go({ kind: "add" }),
						})
					: h("p", { class: "surface-address-row-note" }, t(REFUSALS.CUSTOM_DOMAINS_DISABLED!)),
			);
		return [
			head,
			known.isPublic ? this.#group(this.#openRow(), this.#copyRow()) : null,
			domains.length > 0 ? this.#group(...domains) : null,
			sourceRow ? this.#group(sourceRow) : null,
			known.isPublic && manage
				? this.#group(
						this.#row({
							key: "not-live",
							glyph: "power",
							label: t("Make it not live"),
							press: () => this.#setPublic(false),
							quiet: true,
						}),
					)
				: null,
		];
	}

	#sourceRow(source: SurfaceCodeSourceBinding): HTMLElement {
		const repo = source.repositoryKey?.trim() || t("Not connected yet");
		const summary = source.repositorySubpath ? `${repo}/${source.repositorySubpath}` : repo;
		return this.#row({
			key: "code-source",
			glyph: "code",
			label: t("Code source"),
			end: h("span", { class: "surface-address-row-end surface-address-source-summary", title: summary }, summary, icon("chevron")),
			press: () => this.#openSource(source),
		});
	}

	#openSource(source: SurfaceCodeSourceBinding): void {
		if (!this.#setup.canManage()) return;
		this.#sourceRepoField.value = source.repositoryKey ?? "";
		this.#sourceSubpathField.value = source.repositorySubpath ?? "";
		this.#sourceBranchField.value = source.defaultBranch || "main";
		this.#sourceBranchEdited = Boolean(source.defaultBranch && source.defaultBranch !== "main");
		this.#syncSourceSelectOptions();
		this.#go({ kind: "source" });
		if (!this.#sourceReposLoaded) {
			const target = this.#target;
			void source
				.listRepositories(this.#setup.signal)
				.then((list) => {
					if (this.#setup.signal.aborted || target !== this.#target) return;
					this.#sourceRepos = list;
					this.#sourceReposLoaded = true;
					this.#syncSourceSelectOptions();
					if (this.#open && this.#page.kind === "source") this.#paint();
				})
				.catch(() => {
					if (this.#setup.signal.aborted || target !== this.#target) return;
					this.#sourceReposLoaded = true;
				});
		}
	}

	#syncSourceSelectOptions(): void {
		const list = this.#sourceRepos;
		if (list.length === 0) {
			this.#sourceCustomRepo = true;
			return;
		}
		const currentKey = this.#sourceRepoField.value.trim().toLowerCase();
		const matched = list.find((item) => item.repositoryKey.toLowerCase() === currentKey);
		this.#sourceRepoSelect.replaceChildren(
			...list.map((item) => {
				const label =
					item.sourceBranch && item.sourceBranch !== "main"
						? `${item.repositoryKey} (${item.sourceBranch})`
						: item.repositoryKey;
				return h("option", { value: item.repositoryKey }, label);
			}),
			h("option", { value: "__custom__" }, t("Other repository…")),
		);
		if (matched) {
			this.#sourceRepoSelect.value = matched.repositoryKey;
			this.#sourceCustomRepo = false;
		} else if (currentKey) {
			this.#sourceRepoSelect.value = "__custom__";
			this.#sourceCustomRepo = true;
		} else {
			this.#sourceRepoSelect.value = list[0]!.repositoryKey;
			this.#sourceCustomRepo = false;
		}
	}

	#onSourceRepoSelect(): void {
		const custom = this.#sourceRepoSelect.value === "__custom__";
		this.#sourceCustomRepo = custom;
		if (!custom) {
			const picked = this.#sourceRepos.find((item) => item.repositoryKey === this.#sourceRepoSelect.value);
			if (picked) {
				this.#sourceRepoField.value = picked.repositoryKey;
				if (!this.#sourceBranchEdited && picked.sourceBranch) {
					this.#sourceBranchField.value = picked.sourceBranch;
				}
			}
		}
		if (this.#open && this.#page.kind === "source") {
			this.#paint();
			if (custom && this.#sourceRepoField.isConnected) this.#sourceRepoField.focus();
		}
	}

	#saveSource(): void {
		const source = this.#setup.codeSource?.();
		if (this.#savingSource || !source || !this.#setup.canManage()) return;
		const rawRepo =
			this.#sourceRepos.length > 0 && !this.#sourceCustomRepo
				? this.#sourceRepoSelect.value
				: this.#sourceRepoField.value.trim();
		const repoKey = rawRepo.toLowerCase();
		if (!isSurfaceRepositoryKey(repoKey)) {
			this.#problem = t("Enter a repository like owner/name.");
			this.#paint();
			(this.#sourceCustomRepo || this.#sourceRepos.length === 0 ? this.#sourceRepoField : this.#sourceRepoSelect).focus();
			return;
		}
		const rawSubpath = this.#sourceSubpathField.value.trim();
		const normalizedSubpath = normalizeSurfaceRepositorySubpath(rawSubpath);
		if (rawSubpath && normalizedSubpath !== null && !isSurfaceRepositorySubpath(normalizedSubpath)) {
			this.#problem = t("Use a relative subfolder like packages/web.");
			this.#paint();
			this.#sourceSubpathField.focus();
			return;
		}
		const branch = this.#sourceBranchField.value.trim() || "main";
		if (!isSurfaceDefaultBranch(branch)) {
			this.#problem = t("Enter a valid branch name.");
			this.#paint();
			this.#sourceBranchField.focus();
			return;
		}
		const target = this.#target;
		const inside = this.#sheet.contains(document.activeElement);
		this.#savingSource = true;
		this.#problem = undefined;
		this.#paint();
		this.#setup.changed();
		void source
			.save({
				repositoryKey: repoKey,
				repositorySubpath: normalizedSubpath,
				defaultBranch: branch,
			})
			.then(
				(ok) => {
					this.#savingSource = false;
					if (this.#setup.signal.aborted || target !== this.#target) return;
					if (ok) {
						this.#page = MAIN;
						this.#changed();
						if (inside && this.#open) this.#land({ kind: "source" });
					} else {
						this.#problem = source.lastError?.() ?? t("That didn't work. Try again.");
						this.#changed();
					}
				},
				() => {
					this.#savingSource = false;
					if (this.#setup.signal.aborted || target !== this.#target) return;
					this.#problem = source.lastError?.() ?? t("That didn't work. Try again.");
					this.#changed();
				},
			);
	}

	#sourcePage(): (HTMLElement | null)[] {
		const hasRepos = this.#sourceRepos.length > 0;
		const showCustom = !hasRepos || this.#sourceCustomRepo;
		return [
			this.#top(t("Code source"), MAIN),
			h(
				"form",
				{
					class: "surface-address-body",
					autocomplete: "off",
					onsubmit: (event: SubmitEvent) => {
						event.preventDefault();
						this.#saveSource();
					},
				},
				hasRepos
					? h("label", { class: "surface-address-field" }, h("span", null, t("Repository")), this.#sourceRepoSelect)
					: null,
				showCustom
					? h("label", { class: "surface-address-field" }, h("span", null, t("Repository key")), this.#sourceRepoField)
					: null,
				h("label", { class: "surface-address-field" }, h("span", null, t("Subfolder (optional)")), this.#sourceSubpathField),
				h("label", { class: "surface-address-field" }, h("span", null, t("Upstream branch")), this.#sourceBranchField),
				h(
					"div",
					{ class: "surface-address-end" },
					h(
						"button",
						{
							type: "submit",
							class: "surface-address-pill",
							"data-key": "save-source",
							disabled: this.#savingSource,
						},
						this.#savingSource ? t("Saving…") : t("Save"),
					),
				),
				this.#problemLine(),
			),
		];
	}

	#goButton(): HTMLButtonElement {
		const armed = this.#armed;
		const going = this.#going;
		return h(
			"button",
			{
				type: "button",
				class: `surface-address-go${armed ? " is-confirming" : ""}${going ? " is-going" : ""}`,
				"data-key": "go",
				disabled: going,
				...(armed ? { "data-armed": "true" } : {}),
				onclick: () => this.#goLive(),
			},
			going ? h("span", { class: "surface-approve-label" }, t("Going live…")) : approveLabel(t("Go live"), armed),
		);
	}

	#openRow(): HTMLElement {
		return this.#row({ key: "open", glyph: "external", label: t("Open the site"), href: this.#openUrl() });
	}

	#copyRow(): HTMLElement {
		const row = this.#row({
			key: "copy",
			glyph: "copy",
			label: t("Copy link"),
			press: () =>
				this.#copy(row.querySelector(".surface-address-row-label")!, this.#openUrl(), () => {
					this.#problem = pressToCopy();
					this.#paint();
					this.#select(this.#sheet.querySelector(".surface-address-name"));
				}),
		});
		return row;
	}

	#domainRow(domain: SiteCustomDomain, manage: boolean): HTMLElement {
		const ready = connected(domain);
		const warn = (text: string) => h("span", { class: "surface-address-row-end is-ask" }, text);
		const end = securing(domain)
			? h("span", { class: "surface-address-row-end" }, t("Making it secure"))
			: ready
				? manage
					? h("span", { class: "surface-address-row-end" }, icon("chevron"))
					: null
				: domain.status === "moved" || domain.status === "failed"
					? warn(t("No longer points here"))
					: warn(t("Add the lines"));
		return this.#row({
			key: `domain:${domain.hostname}`,
			glyph: "globe",
			label: domain.hostname,
			end,
			...(ready && !manage ? {} : { press: () => this.#go({ kind: "domain", hostname: domain.hostname }) }),
		});
	}

	#top(title: string, back: Page): HTMLElement {
		return h(
			"div",
			{ class: "surface-address-top" },
			h(
				"button",
				{
					type: "button",
					class: "surface-address-back",
					"aria-label": t("Back"),
					title: t("Back"),
					"data-key": "back",
					onclick: () => this.#go(back),
				},
				icon("chevron"),
			),
			h("h2", { class: "surface-address-title" }, title),
		);
	}

	#editPage(): (HTMLElement | null)[] {
		const suffix = this.#nativeSuffix();
		const boxClass = [
			"surface-address-slug-box",
			this.#slugCheck.kind === "available" && "is-available",
			this.#slugCheck.kind === "unavailable" && "is-unavailable",
		]
			.filter(Boolean)
			.join(" ");
		return [
			this.#top(t("Edit address"), MAIN),
			h(
				"form",
				{
					class: "surface-address-body",
					autocomplete: "off",
					onsubmit: (event: SubmitEvent) => {
						event.preventDefault();
						this.#saveSlug();
					},
				},
				h(
					"div",
					{
						class: boxClass,
						onclick: () => this.#slugField.focus(),
					},
					this.#slugField,
					h("span", { class: "surface-address-slug-suffix", "aria-hidden": "true" }, suffix),
				),
				h(
					"div",
					{ class: "surface-address-slug-foot" },
					this.#availabilityElement(),
					h(
						"button",
						{
							type: "submit",
							class: "surface-address-pill",
							"data-key": "save-slug",
							disabled: !this.#slugCanSave(),
						},
						this.#savingSlug ? t("Saving…") : t("Save"),
					),
				),
				this.#problemLine(),
			),
		];
	}

	#addPage(from: string | undefined): HTMLElement[] {
		const back: Page = from ? { kind: "domain", hostname: from } : MAIN;
		return [
			this.#top(t("Your own domain"), back),
			h(
				"form",
				{
					class: "surface-address-body",
					autocomplete: "off",
					onsubmit: (event: SubmitEvent) => {
						event.preventDefault();
						this.#addDomain();
					},
				},
				this.#field,
				h(
					"div",
					{ class: "surface-address-end" },
					h("button", { type: "submit", class: "surface-address-pill", "data-key": "connect" }, t("Connect")),
				),
				this.#problemLine(),
			),
		];
	}

	#handPage(domain: SiteCustomDomain): (HTMLElement | null)[] {
		const manage = this.#setup.canManage();
		const known = this.#known!;
		const records = domain.verificationToken
			? siteDnsRecords(domain.hostname, domainDnsSetup(known.hosting, domain))
			: [];
		const count = domain.verificationToken ? records.length : domain.isApex && known.hosting.edgeIpv6 ? 3 : 2;
		const check = parseDomainCheck(domain.lastError);
		const shop = dnsShop(check.nameServers);
		const reason = domain.lastCheckedAt && records.length > 0 ? check.reason : null;
		const body =
			reason === "domain_not_found"
				? this.#notOnline(domain.hostname, records, shop)
				: reason
					? this.#waiting(domain.hostname, records, reason, check.txtOnWrongName)
					: this.#lines(domain.hostname, records, count, shop);
		const rows: HTMLElement[] = [];
		if (records.length > 0 && reason !== "domain_not_found") rows.push(this.#messageRow(domain.hostname, records));
		if (manage && domain.id) rows.push(this.#removeRow(domain));
		return [
			this.#top(domain.hostname, MAIN),
			h("div", { class: "surface-address-body" }, ...body, this.#problemLine()),
			rows.length > 0 ? this.#group(...rows) : null,
		];
	}

	#lines(
		hostname: string,
		records: readonly SiteDnsRecord[],
		count: number,
		shop: string | null,
	): (HTMLElement | null)[] {
		return [
			h("p", { class: "surface-address-line" }, openLine(count, shop, registrableDomain(hostname))),
			records.length > 0
				? h(
						"div",
						{ class: "surface-address-records" },
						...records.map((record, index) => this.#recordBox(record, index, hostname)),
					)
				: null,
			records.length > 0 ? h("p", { class: "surface-address-hint" }, shopsNote(hostname)) : null,
		];
	}

	#waiting(
		hostname: string,
		records: readonly SiteDnsRecord[],
		reason: DomainCheckReason,
		txtOnWrongName: boolean,
	): HTMLElement[] {
		const routing = records.filter((record) => record.type !== "TXT");
		const txt = records.find((record) => record.type === "TXT");
		const routed = routing.length > 0 && dnsRecordFound(routing[0]!, reason);
		const proven = txt !== undefined && dnsRecordFound(txt, reason);
		const items = (routing.length > 0 ? 1 : 0) + (txt ? 1 : 0);
		const foundRow = (shown: readonly SiteDnsRecord[]) =>
			h(
				"div",
				{ class: "surface-address-record is-found", "data-type": shown.map((record) => record.type).join(" ") },
				h("span", { class: "surface-address-mark is-done", "aria-hidden": "true" }, icon("check")),
				...shown.map((record) => chip(record.type)),
				h("span", { class: "surface-address-record-what" }, t("Found")),
			);
		const at = (record: SiteDnsRecord) => records.indexOf(record);
		return [
			h("p", { class: "surface-address-line" }, waitLine((routed ? 1 : 0) + (proven ? 1 : 0), items)),
			h(
				"div",
				{ class: "surface-address-records" },
				...(routed ? [foundRow(routing)] : routing.map((record) => this.#recordBox(record, at(record), hostname))),
				...(txt
					? [
							proven
								? foundRow([txt])
								: txtOnWrongName
									? this.#wrongName(txt, at(txt), hostname)
									: this.#recordBox(txt, at(txt), hostname),
						]
					: []),
			),
		];
	}

	#notOnline(hostname: string, records: readonly SiteDnsRecord[], shop: string | null): HTMLElement[] {
		return [
			h(
				"div",
				{ class: "surface-address-warn" },
				h(
					"p",
					{ class: "surface-address-warn-title" },
					t("{domain} isn't on the internet yet", { domain: hostname }),
				),
				h("p", { class: "surface-address-warn-text" }, confirmText(hostname, shop)),
			),
			h("p", { class: "surface-address-line" }, laterLine(records.length, shop)),
			h(
				"div",
				{ class: "surface-address-records" },
				...records.map((record) =>
					h(
						"div",
						{ class: "surface-address-record is-summary", "data-type": record.type },
						chip(record.type),
						h(
							"span",
							{ class: "surface-address-record-what" },
							`${record.host ? t("Hostname {name}", { name: record.host }) : t("Hostname empty")} · ${record.value}`,
						),
					),
				),
			),
		];
	}

	#securingPage(domain: SiteCustomDomain): (HTMLElement | null)[] {
		const known = this.#known!;
		const count = siteDnsRecords(domain.hostname, domainDnsSetup(known.hosting, domain)).length;
		const step = (state: string, label: string, end?: string) =>
			h(
				"div",
				{ class: `surface-address-step is-${state}` },
				h(
					"span",
					{ class: `surface-address-mark is-${state}`, "aria-hidden": "true" },
					state === "done" ? icon("check") : null,
				),
				h("span", null, label),
				end ? h("span", { class: "surface-address-step-end" }, end) : null,
			);
		return [
			this.#top(domain.hostname, MAIN),
			h(
				"div",
				{ class: "surface-address-body" },
				h(
					"div",
					{ class: "surface-address-steps", role: "status" },
					step("done", count === 2 ? t("Both lines found") : t("All lines found")),
					step("busy", t("Making it secure"), t("about a minute")),
					step("next", t("Open at {domain}", { domain: domain.hostname })),
				),
				h(
					"p",
					{ class: "surface-address-hint" },
					t(
						"You can close this. The website keeps its {address} address until {domain} is ready, then switches by itself.",
						{ address: this.name(), domain: domain.hostname },
					),
				),
				this.#problemLine(),
			),
			this.#setup.canManage() && domain.id ? this.#group(this.#removeRow(domain)) : null,
		];
	}

	#messageRow(hostname: string, records: readonly SiteDnsRecord[]): HTMLElement {
		const message = this.#row({
			key: "message",
			glyph: "mail",
			label: t("Copy as a message for someone else"),
			press: () =>
				this.#copy(
					message.querySelector(".surface-address-row-label")!,
					[
						t("Could you add these lines to the DNS for {domain}? They connect it to our website.", {
							domain: hostname,
						}),
						"",
						...records.flatMap((record) => [
							record.type,
							`${t("Hostname")}: ${record.host || `(${t("leave empty")})`}`,
							`${t("Value")}: ${record.value}`,
							"",
						]),
						shopsNote(hostname),
					].join("\n"),
					() => {
						this.#problem = pressToCopy();
						this.#paint();
						this.#select(this.#sheet.querySelector(".surface-address-records"));
					},
				),
		});
		return message;
	}

	#managePage(domain: SiteCustomDomain): (HTMLElement | null)[] {
		const known = this.#known!;
		const more = known.hosting.domainsEnabled && known.domains.length < ADDRESS_DOMAIN_LIMIT;
		const problem = this.#problemLine();
		return [
			this.#top(domain.hostname, MAIN),
			problem ? h("div", { class: "surface-address-body" }, problem) : null,
			h(
				"div",
				{ class: "surface-address-rows is-first" },
				more
					? this.#row({
							key: "add",
							glyph: "plus",
							label: t("Add another address"),
							press: () => this.#go({ kind: "add", from: domain.hostname }),
						})
					: null,
				domain.id ? this.#removeRow(domain) : null,
			),
		];
	}

	#removeRow(domain: SiteCustomDomain): HTMLElement {
		return this.#row({
			key: "remove",
			glyph: "trash",
			label: t("Remove {domain}", { domain: domain.hostname }),
			press: () => this.#removeDomain(domain),
			quiet: true,
		});
	}

	#group(...rows: (HTMLElement | null)[]): HTMLElement {
		return h("div", { class: "surface-address-rows" }, ...rows);
	}

	#row(row: Row): HTMLElement {
		const attrs = {
			class: `surface-address-row${row.quiet ? " is-quiet" : ""}`,
			"data-key": row.key,
		};
		const parts = [icon(row.glyph), h("span", { class: "surface-address-row-label" }, row.label), row.end ?? null];
		if (row.href) return h("a", { ...attrs, href: row.href, target: "_blank", rel: "noopener noreferrer" }, ...parts);
		if (row.press) return h("button", { ...attrs, type: "button", onclick: row.press }, ...parts);
		return h("div", { ...attrs, class: `${attrs.class} is-still` }, ...parts);
	}

	#recordBox(record: SiteDnsRecord, index: number, hostname: string): HTMLElement {
		const what =
			record.type === "TXT"
				? t("shows the domain is yours")
				: record.type === "AAAA"
					? t("also points {domain} to your website", { domain: hostname })
					: t("points {domain} to your website", { domain: hostname });
		return h(
			"div",
			{ class: "surface-address-record", "data-type": record.type },
			h(
				"div",
				{ class: "surface-address-record-head" },
				chip(record.type),
				h("span", { class: "surface-address-record-what" }, what),
			),
			this.#fields(record, index),
		);
	}

	#wrongName(record: SiteDnsRecord, index: number, hostname: string): HTMLElement {
		return h(
			"div",
			{ class: "surface-address-record is-wrong", "data-type": record.type },
			h(
				"div",
				{ class: "surface-address-record-head" },
				h("span", { class: "surface-address-mark is-wrong", "aria-hidden": "true" }),
				chip(record.type),
				h("span", { class: "surface-address-record-wrong" }, t("Found on the wrong name")),
			),
			h(
				"p",
				{ class: "surface-address-record-note" },
				...filled(t("It's on {domain}. Put it on {name} instead: write {typed} in the Hostname box."), {
					domain: h("b", null, hostname),
					name: h("b", null, record.host),
					typed: h("code", null, record.host),
				}),
			),
			this.#fields(record, index),
		);
	}

	#fields(record: SiteDnsRecord, index: number): HTMLElement {
		return h(
			"div",
			{ class: "surface-address-fields" },
			h("span", { class: "surface-address-field" }, t("Hostname")),
			record.host
				? h("span", { class: "surface-address-value", "data-copy": `record:${index}:host` }, record.host)
				: h("span", { class: "surface-address-empty" }, t("leave empty")),
			record.host ? this.#copyButton(record.host, `record:${index}:host`) : h("span"),
			h("span", { class: "surface-address-field" }, t("Value")),
			h("span", { class: "surface-address-value", "data-copy": `record:${index}:value` }, record.value),
			this.#copyButton(record.value, `record:${index}:value`),
		);
	}

	#copyButton(text: string, key: string): HTMLButtonElement {
		const copy = h(
			"button",
			{
				type: "button",
				class: "surface-address-copy",
				title: t("Copy"),
				"aria-label": t("Copy {value}", { value: text }),
				"data-key": key,
			},
			icon("copy"),
			icon("check"),
		);
		copy.addEventListener("click", () => {
			const done = () => {
				copy.classList.add("is-copied");
				setTimeout(() => copy.classList.remove("is-copied"), COPIED_MS);
			};
			const refused = () => {
				this.#problem = pressToCopy();
				this.#paint();
				this.#select(this.#sheet.querySelector(`[data-copy="${key}"]`));
			};
			try {
				const clipboard = navigator.clipboard as Clipboard | undefined;
				if (!clipboard?.writeText) return refused();
				clipboard.writeText(text).then(done, refused);
			} catch {
				refused();
			}
		});
		return copy;
	}
}
