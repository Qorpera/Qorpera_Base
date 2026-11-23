import { CloudRpcError } from "../../cloud/client.ts";
import {
	type CompanySiteHostingState,
	domainDnsSetup,
	isApexHostname,
	type SiteCustomDomain,
	type SiteDnsRecord,
	siteDnsRecords,
	validateCustomDomainInput,
	type WebSiteHosting,
} from "../../cloud/site-hosting.ts";
import { h, icon, replace } from "../../ui/dom.ts";
import { phrase, t } from "../../ui/preferences.ts";
import { pressToCopy, toClipboard } from "./settings-sites.ts";
import { APPROVE_ARM_MS, approveLabel } from "./surface-session-drawer.ts";

export interface SurfaceSiteHosting {
	readonly siteId: string;
	readonly client: WebSiteHosting;
}

export interface SurfaceAddressSetup {
	readonly container: HTMLElement;
	readonly canManage: () => boolean;
	readonly changed: () => void;
	readonly signal: AbortSignal;
	readonly beforePublic?: () => Promise<boolean>;
	readonly publicChanged?: (isPublic: boolean) => void;
}

export type AddressMark = "unknown" | "private" | "live";

interface Known {
	isPublic: boolean;
	domains: SiteCustomDomain[];
	readonly hosting: CompanySiteHostingState;
}

type Page =
	| { readonly kind: "main" }
	| { readonly kind: "add"; readonly from?: string }
	| { readonly kind: "domain"; readonly hostname: string };

type Shown =
	| { readonly kind: "main" }
	| { readonly kind: "add"; readonly from?: string }
	| { readonly kind: "domain"; readonly domain: SiteCustomDomain };

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
};
const MANAGERS_ONLY = phrase("Only founders and admins can change this.");

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

function linesLine(count: number, domain: string): string {
	if (count === 2) return t("Add these two lines where you bought {domain}.", { domain });
	if (count === 3) return t("Add these three lines where you bought {domain}.", { domain });
	return t("Add these lines where you bought {domain}.", { domain });
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
	#target: SurfaceSiteHosting | undefined;
	#liveUrl = "";
	#known: Known | null | undefined;
	#failed = false;
	#problem: string | undefined;
	#open = false;
	#page: Page = MAIN;
	#armed = false;
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
		setup.container.append(this.#sheet);
		setup.signal.addEventListener("abort", () => this.close(), { once: true });
	}

	get isOpen(): boolean {
		return this.#open;
	}

	get isWriting(): boolean {
		return this.#writing > 0;
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
			if (next) void this.#read();
		}
		this.#liveUrl = url;
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
		return domains.find((domain) => domain.isPrimary && verified(domain)) ?? domains.find(verified);
	}

	#openUrl(): string {
		const working = this.#working();
		return working ? `https://${working.hostname}/` : this.#liveUrl;
	}

	button(): HTMLButtonElement | null {
		if (!this.#liveUrl) return null;
		const mark = this.mark();
		const title = mark === "private" ? t("Not live yet") : mark === "live" ? t("Live") : undefined;
		return h(
			"button",
			{
				type: "button",
				class: `surface-pill-address is-${mark}`,
				"aria-haspopup": "dialog",
				"aria-expanded": String(this.#open),
				"data-act": "address",
				...(title ? { title } : {}),
			},
			mark === "unknown" ? null : h("span", { class: "surface-address-dot", "aria-hidden": "true" }),
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
			this.#known = entry ? { isPublic: entry.isPublic, domains: [...entry.domains], hosting: state } : null;
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
		if (!this.#open || this.#waitingDomains().length === 0) return;
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
			async (client, siteId) => {
				const before = next ? this.#setup.beforePublic : undefined;
				if (before && !(await before())) throw new Error("NOT_PUBLISHED");
				return client.setPublic(siteId, next, this.#setup.signal);
			},
			next ? phrase("The site did not go live. Try again.") : phrase("The site is still live. Try again."),
			() => this.#setup.publicChanged?.(next),
		);
	}

	#goLive(): void {
		if (!this.#armed) {
			this.#arm();
			return;
		}
		this.#disarm(false);
		this.#setPublic(true);
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
		if (focused) next.focus();
	}

	#go(page: Page): void {
		const inside = this.#sheet.contains(document.activeElement);
		const from = this.#page;
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
						: null;
		const target =
			page.kind === "add" && this.#field.isConnected
				? this.#field
				: (back ?? this.#sheet.querySelector<HTMLElement>(".surface-address-back"));
		(target ?? this.#sheet).focus();
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
		if (!known) return MAIN;
		if (page.kind === "add")
			return this.#setup.canManage() && known.hosting.domainsEnabled && known.domains.length < ADDRESS_DOMAIN_LIMIT
				? page
				: MAIN;
		if (page.kind === "domain") {
			const domain = known.domains.find((item) => item.hostname === page.hostname);
			if (!domain || (verified(domain) && !this.#setup.canManage())) return MAIN;
			return { kind: "domain", domain };
		}
		return MAIN;
	}

	#paintKey(): string {
		const known = this.#known;
		return JSON.stringify([
			this.#liveUrl,
			this.#setup.canManage(),
			this.#failed,
			this.#problem ?? "",
			this.#page,
			this.#armed,
			known === undefined
				? "unknown"
				: known === null
					? "none"
					: [
							known.isPublic,
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
			...(shown.kind === "add"
				? this.#addPage(shown.from)
				: shown.kind === "domain"
					? verified(shown.domain)
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
		const cut = name.endsWith(".qorpera.com") ? name.length - ".qorpera.com".length : name.lastIndexOf(".");
		const shownName = h(
			"div",
			{ class: "surface-address-name" },
			cut > 0 ? name.slice(0, cut) : name,
			cut > 0 ? h("span", null, name.slice(cut)) : null,
		);
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
		const head = h("div", { class: "surface-address-head" }, shownName, under, this.#problemLine());
		if (!known) return [head];
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

	#goButton(): HTMLButtonElement {
		const armed = this.#armed;
		return h(
			"button",
			{
				type: "button",
				class: `surface-address-go${armed ? " is-confirming" : ""}`,
				"data-key": "go",
				...(armed ? { "data-armed": "true" } : {}),
				onclick: () => this.#goLive(),
			},
			approveLabel(t("Go live"), armed),
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
		const ready = verified(domain);
		const warn = (text: string) => h("span", { class: "surface-address-row-end is-ask" }, text);
		const end = ready
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
		const rows: HTMLElement[] = [];
		if (records.length > 0) {
			const message = this.#row({
				key: "message",
				glyph: "mail",
				label: t("Copy as a message for someone else"),
				quiet: true,
				press: () =>
					this.#copy(
						message.querySelector(".surface-address-row-label")!,
						[
							t("Could you add these lines to the DNS for {domain}? They connect it to our website.", {
								domain: domain.hostname,
							}),
							"",
							...records.map((record) => `${record.type}  ${record.host}  ${record.value}`),
						].join("\n"),
						() => {
							this.#problem = pressToCopy();
							this.#paint();
							this.#select(this.#sheet.querySelector(".surface-address-records"));
						},
					),
			});
			rows.push(message);
		}
		if (manage && domain.id) rows.push(this.#removeRow(domain));
		return [
			this.#top(domain.hostname, MAIN),
			h(
				"div",
				{ class: "surface-address-body" },
				h("p", { class: "surface-address-line" }, linesLine(count, domain.hostname)),
				records.length > 0 ? this.#records(records) : null,
				this.#problemLine(),
			),
			rows.length > 0 ? this.#group(...rows) : null,
		];
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

	#records(records: readonly SiteDnsRecord[]): HTMLElement {
		return h(
			"div",
			{ class: "surface-address-records" },
			...records.map((record, index) => {
				const value = h("span", { class: "surface-address-value" }, record.value);
				const copy = h(
					"button",
					{
						type: "button",
						class: "surface-address-copy",
						title: t("Copy"),
						"aria-label": t("Copy {value}", { value: record.value }),
						"data-key": `record:${index}`,
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
						this.#select(
							[...this.#sheet.querySelectorAll<HTMLElement>(".surface-address-value")].find(
								(item) => item.textContent === record.value,
							),
						);
					};
					try {
						const clipboard = navigator.clipboard as Clipboard | undefined;
						if (!clipboard?.writeText) return refused();
						clipboard.writeText(record.value).then(done, refused);
					} catch {
						refused();
					}
				});
				return h(
					"div",
					{ class: "surface-address-record" },
					h("b", null, record.type),
					h("span", { class: "surface-address-record-host" }, record.host),
					value,
					copy,
				);
			}),
		);
	}
}
