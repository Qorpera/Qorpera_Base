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
import { pressToCopy } from "./settings-sites.ts";

export interface SurfaceSiteHosting {
	readonly siteId: string;
	readonly client: WebSiteHosting;
}

export interface SurfaceAddressSetup {
	readonly container: HTMLElement;
	readonly canManage: () => boolean;
	readonly changed: () => void;
	readonly signal: AbortSignal;
}

export type AddressMark = "unknown" | "private" | "live" | "waiting";

interface Known {
	isPublic: boolean;
	domains: SiteCustomDomain[];
	readonly hosting: CompanySiteHostingState;
}

export const ADDRESS_POLL_MS = 15_000;
export const ADDRESS_RECHECK_GAP_MS = 60_000;
const COPIED_MS = 1600;

const REFUSALS: Readonly<Record<string, string>> = {
	PUBLIC_SITES_DISABLED: phrase("Sites cannot go live for everyone yet."),
	SITE_CONTAINS_CREDENTIAL_INPUTS: phrase(
		"The site has a place to sign in or type a password, so it stays with only you for now.",
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

function linesLabel(count: number): string {
	if (count === 2) return t("Show the two lines to paste where you bought it");
	if (count === 3) return t("Show the three lines to paste where you bought it");
	return t("Show the lines to paste where you bought it");
}

export class SurfaceAddress {
	readonly #setup: SurfaceAddressSetup;
	readonly #sheet = h("div", { class: "surface-address-sheet", role: "dialog", hidden: true });
	readonly #field = h("input", {
		type: "text",
		class: "surface-address-input",
		maxlength: "253",
		autocomplete: "off",
		autocapitalize: "none",
		spellcheck: "false",
	});
	#target: SurfaceSiteHosting | undefined;
	#liveUrl = "";
	#known: Known | null | undefined;
	#failed = false;
	#problem: string | undefined;
	#open = false;
	#linesShown = new Set<string>();
	#reads = 0;
	#writing = 0;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#closeListeners: AbortController | undefined;
	#painted = "";
	readonly #rechecked = new Map<string, number>();

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
			this.#linesShown.clear();
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
		if (known === null || !known.isPublic) return "private";
		if (known.domains.length > 0 && !known.domains.some(verified)) return "waiting";
		return "live";
	}

	name(): string {
		const known = this.#known;
		if (known?.isPublic && known.domains.length > 0) {
			const shown =
				known.domains.find((domain) => domain.isPrimary && verified(domain)) ??
				known.domains.find(verified) ??
				known.domains[0]!;
			return shown.hostname;
		}
		return hostOf(this.#liveUrl);
	}

	#openUrl(): string {
		const primary = this.#known?.domains.find((domain) => domain.isPrimary && verified(domain));
		return primary ? `https://${primary.hostname}/` : this.#liveUrl;
	}

	button(): HTMLButtonElement | null {
		if (!this.#liveUrl) return null;
		const mark = this.mark();
		const title =
			mark === "private"
				? t("Only your team can open it")
				: mark === "waiting"
					? t("Waiting for your domain")
					: mark === "live"
						? t("Anyone can open it")
						: undefined;
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
			mark === "private"
				? h("span", { class: "surface-address-lock" }, icon("lock"))
				: mark === "unknown"
					? null
					: h("span", { class: "surface-address-dot", "aria-hidden": "true" }),
			h("span", { class: "surface-address-host" }, this.name()),
		);
	}

	toggle(): void {
		if (this.#open) this.close(true);
		else this.open();
	}

	open(): void {
		if (this.#open || !this.#liveUrl || this.#setup.signal.aborted) return;
		this.#open = true;
		this.#problem = undefined;
		const listeners = new AbortController();
		this.#closeListeners = listeners;
		document.addEventListener(
			"pointerdown",
			(event) => {
				const target = event.target;
				if (!(target instanceof Node)) return;
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
		this.#sheet.hidden = true;
		this.#sheet.replaceChildren();
		this.#painted = "";
		this.#linesShown.clear();
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
	}

	#waitingDomains(): SiteCustomDomain[] {
		return (this.#known?.domains ?? []).filter((domain) => domain.id && !verified(domain));
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
		if (this.#open) this.#paint();
		this.#setup.changed();
	}

	async #write<T>(
		apply: (known: Known) => (known: Known) => void,
		call: (client: WebSiteHosting, siteId: string) => Promise<T>,
		fallback: string,
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
				this.#problem = addressRefusal(failure, fallback);
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
			next ? phrase("The site did not go live. Try again.") : phrase("The site is still live. Try again."),
		);
	}

	#addDomain(): void {
		const typed = this.#field.value;
		const hostname = cleanDomain(typed);
		if (!hostname) return;
		if (validateCustomDomainInput(hostname)) {
			this.#problem = t("That does not look like a domain.");
			this.#paint();
			this.#field.focus();
			return;
		}
		if (this.#known?.domains.some((domain) => domain.hostname === hostname)) {
			this.#field.value = "";
			this.#paint();
			return;
		}
		this.#field.value = "";
		void this.#write(
			(known) => {
				known.domains = [...known.domains, pending(hostname)];
				return (now) => {
					now.domains = now.domains.filter((domain) => !(domain.id === "" && domain.hostname === hostname));
					if (!this.#field.value) this.#field.value = typed;
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
			phrase("The address did not change. Try again."),
		);
	}

	#removeDomain(gone: SiteCustomDomain): void {
		void this.#write(
			(known) => {
				const at = known.domains.findIndex((domain) => domain.id === gone.id);
				known.domains = known.domains.filter((domain) => domain.id !== gone.id);
				this.#linesShown.delete(gone.id);
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
	}

	#paintKey(): string {
		const known = this.#known;
		return JSON.stringify([
			this.#liveUrl,
			this.#setup.canManage(),
			this.#failed,
			this.#problem ?? "",
			[...this.#linesShown],
			known === undefined
				? "unknown"
				: known === null
					? "none"
					: [
							known.isPublic,
							known.hosting.publicEnabled,
							known.hosting.domainsEnabled,
							known.domains.map((domain) => [domain.id, domain.hostname, domain.status, domain.isPrimary]),
						],
		]);
	}

	#paint(): void {
		if (!this.#open) return;
		const key = this.#paintKey();
		const focused = document.activeElement;
		const keepFocus = focused === this.#field;
		const first = this.#sheet.hidden;
		this.#painted = key;
		const name = this.name();
		const cut = name.endsWith(".qorpera.com") ? name.length - ".qorpera.com".length : name.lastIndexOf(".");
		this.#sheet.setAttribute("aria-label", t("Where the site lives"));
		replace(
			this.#sheet,
			h(
				"div",
				{ class: "surface-address-name" },
				cut > 0 ? name.slice(0, cut) : name,
				cut > 0 ? h("span", null, name.slice(cut)) : null,
			),
			h(
				"a",
				{
					class: "surface-address-open",
					href: this.#openUrl(),
					target: "_blank",
					rel: "noopener noreferrer",
				},
				t("Open the site"),
				icon("external"),
			),
			this.#stops(),
			...this.#body(),
			this.#problem ? h("p", { class: "surface-address-problem", role: "alert" }, this.#problem) : null,
		);
		this.#sheet.hidden = false;
		this.#sheet.classList.toggle("is-entering", first);
		this.#place();
		if (keepFocus && this.#field.isConnected) this.#field.focus();
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

	#stops(): HTMLElement {
		const known = this.#known;
		const mark = this.mark();
		const stop = known?.isPublic ? (known.domains.length > 0 ? 2 : 1) : 0;
		const labels = [t("Only you"), t("Live"), t("Your domain")];
		return h(
			"ol",
			{ class: "surface-address-stops" },
			...labels.map((label, index) => {
				const now = known !== undefined && index === stop;
				const done = known !== undefined && (index < stop || (now && stop > 0 && mark !== "waiting"));
				return h(
					"li",
					{
						class: [now && "is-now", done && "is-done", now && mark === "waiting" && "is-waiting"]
							.filter(Boolean)
							.join(" "),
						...(now ? { "aria-current": "step" } : {}),
					},
					h("span", { class: "surface-address-step", "aria-hidden": "true" }),
					label,
				);
			}),
		);
	}

	#body(): (HTMLElement | null)[] {
		const known = this.#known;
		const manage = this.#setup.canManage();
		const line = (text: string) => h("p", { class: "surface-address-line" }, text);
		if (known === undefined)
			return [this.#failed ? line(t("Where the site lives could not be read just now.")) : null];
		const readOnly = manage ? null : h("p", { class: "surface-address-quiet" }, t(MANAGERS_ONLY));
		if (known === null)
			return [line(t("It can go live once its first version is ready. Until then only your team can open it."))];
		const parts: (HTMLElement | null)[] = [];
		if (!known.isPublic) {
			parts.push(line(t("Only you and your team can open it.")));
			if (manage && known.hosting.publicEnabled)
				parts.push(this.#pill(t("Put it live"), () => this.#setPublic(true), "surface-address-go"));
			else if (!known.hosting.publicEnabled) parts.push(line(t(REFUSALS.PUBLIC_SITES_DISABLED!)));
		} else if (known.domains.length === 0) {
			parts.push(line(t("Anyone can open it. What you approve goes live here.")));
			if (manage && known.hosting.domainsEnabled) parts.push(this.#form());
			else if (manage) parts.push(line(t(REFUSALS.CUSTOM_DOMAINS_DISABLED!)));
		}
		for (const domain of known.domains) parts.push(...this.#domain(domain, manage, known));
		if (known.isPublic && manage)
			parts.push(this.#quiet(t("Back to only you"), () => this.#setPublic(false), "surface-address-private"));
		parts.push(readOnly);
		return parts;
	}

	#form(): HTMLElement {
		return h(
			"form",
			{
				class: "surface-address-form",
				autocomplete: "off",
				onsubmit: (event: SubmitEvent) => {
					event.preventDefault();
					this.#addDomain();
				},
			},
			this.#field,
			h("button", { type: "submit", class: "surface-address-pill is-dark" }, t("Use it")),
		);
	}

	#domain(domain: SiteCustomDomain, manage: boolean, known: Known): HTMLElement[] {
		const name = domain.hostname;
		const parts: HTMLElement[] = [];
		const block = (text: string) => h("p", { class: "surface-address-line", dataset: { domain: name } }, text);
		if (verified(domain)) {
			parts.push(
				block(
					domain.isPrimary
						? domain.status === "tls_active"
							? t("Live at {domain}, with the lock.", { domain: name })
							: t("Live at {domain}. The lock follows in a few minutes.", { domain: name })
						: t("{domain} points here.", { domain: name }),
				),
			);
			if (manage && !domain.isPrimary)
				parts.push(this.#pill(t("Use this address"), () => this.#usePrimary(domain), "surface-address-use"));
		} else {
			parts.push(
				block(
					domain.status === "moved"
						? t("{domain} no longer points here.", { domain: name })
						: t("Waiting for {domain} to point here.", { domain: name }),
				),
			);
			if (manage && domain.id) {
				const records = siteDnsRecords(domain.hostname, domainDnsSetup(known.hosting, domain));
				const shown = this.#linesShown.has(domain.id);
				parts.push(
					this.#quiet(
						shown ? t("Hide the lines") : linesLabel(records.length),
						() => {
							if (this.#linesShown.has(domain.id)) this.#linesShown.delete(domain.id);
							else this.#linesShown.add(domain.id);
							this.#paint();
						},
						"surface-address-show",
					),
				);
				if (shown) parts.push(this.#records(records));
			}
		}
		if (manage && domain.id)
			parts.push(
				this.#quiet(
					t("Remove {domain}", { domain: name }),
					() => this.#removeDomain(domain),
					"surface-address-remove",
				),
			);
		return parts;
	}

	#records(records: readonly SiteDnsRecord[]): HTMLElement {
		return h(
			"div",
			{ class: "surface-address-records" },
			...records.map((record) => {
				const value = h("span", { class: "surface-address-value" }, record.value);
				const copy = h(
					"button",
					{
						type: "button",
						class: "surface-address-copy",
						title: t("Copy"),
						"aria-label": t("Copy {value}", { value: record.value }),
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
						const shown = [...this.#sheet.querySelectorAll<HTMLElement>(".surface-address-value")].find(
							(item) => item.textContent === record.value,
						);
						const selection = window.getSelection();
						if (!shown || !selection) return;
						const range = document.createRange();
						range.selectNodeContents(shown);
						selection.removeAllRanges();
						selection.addRange(range);
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

	#pill(label: string, press: () => void, kind: string): HTMLButtonElement {
		return h("button", { type: "button", class: `surface-address-pill is-dark ${kind}`, onclick: press }, label);
	}

	#quiet(label: string, press: () => void, kind: string): HTMLButtonElement {
		return h("button", { type: "button", class: `surface-address-quiet-button ${kind}`, onclick: press }, label);
	}
}
