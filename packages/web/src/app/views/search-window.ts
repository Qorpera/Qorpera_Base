import { type ContextMenu, type MenuEntry, openContextMenu } from "../../ui/context-menu.ts";
import { fmtTime, formatPresentationDate, h, icon, replace } from "../../ui/dom.ts";
import { HoverGlide } from "../../ui/hover-glide.ts";
import { presentationLocale, t } from "../../ui/preferences.ts";
import { uiScale } from "../../ui/scale.ts";

export type SearchKind = "people" | "apps" | "files" | "settings";
export type SearchMark = "needs-you" | "working" | "image" | "document" | "folder";
export type SearchSort = "match" | "latest" | "name";

export interface SearchHit {
	readonly key: string;
	readonly kind: SearchKind;
	readonly title: string;
	readonly detail: string;
	readonly words?: string;
	readonly at?: string;
	readonly marks?: readonly SearchMark[];
	readonly lead: () => Element;
	readonly open: () => void;
}

export interface SearchFiles {
	search(query: string, limit: number, signal: AbortSignal): Promise<{ hits: SearchHit[]; more: boolean }>;
	recent(signal: AbortSignal): Promise<SearchHit[]>;
}

export interface SearchSources {
	readonly profileId: string;
	readonly companyName: string;
	hits(): readonly SearchHit[];
	revive?(key: string): SearchHit | undefined;
	readonly files?: SearchFiles;
}

const KINDS: readonly SearchKind[] = ["people", "apps", "files", "settings"];
const MARK_KIND: Record<SearchMark, SearchKind> = {
	"needs-you": "people",
	working: "people",
	image: "files",
	document: "files",
	folder: "files",
};
const MARKS = Object.keys(MARK_KIND) as SearchMark[];
const RECENT_KEY = "qorpera.search-recent";
const RECENT_MAX = 6;
const RECENT_FILES = 4;
const RECENT_SHOWN = 8;
const SHOWN_PER_KIND = 4;
const SHOWN_NARROWED = 50;
const FILE_DELAY_MS = 120;
const MINUTE = 60_000;

const kindLabel = (kind: SearchKind | null): string =>
	kind
		? {
				people: t("Agents and people"),
				apps: t("Apps"),
				files: t("Files"),
				settings: t("Settings"),
			}[kind]
		: t("All");

const fieldLabel = (kind: SearchKind | null): string =>
	kind
		? {
				people: t("Search agents and people"),
				apps: t("Search apps"),
				files: t("Search files"),
				settings: t("Search settings"),
			}[kind]
		: t("Search agents, files and settings");

const markLabel = (mark: SearchMark): string =>
	({
		"needs-you": t("Needs you"),
		working: t("Working"),
		image: t("Images"),
		document: t("Documents"),
		folder: t("Folders"),
	})[mark];

const sortLabel = (sort: SearchSort): string =>
	({ match: t("Best match"), latest: t("Latest"), name: t("Name") })[sort];

export function searchWords(query: string): string[] {
	return query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
}

export function rankHits(hits: readonly SearchHit[], words: readonly string[]): SearchHit[] {
	const scored: { hit: SearchHit; score: number }[] = [];
	for (const hit of hits) {
		const title = hit.title.toLocaleLowerCase();
		const all = `${title} ${hit.detail.toLocaleLowerCase()} ${hit.words?.toLocaleLowerCase() ?? ""}`;
		if (!words.every((word) => all.includes(word))) continue;
		const score = words.reduce((sum, word) => sum + (title.startsWith(word) ? 3 : title.includes(word) ? 2 : 1), 0);
		scored.push({ hit, score });
	}
	return scored.sort((a, b) => b.score - a.score || a.hit.title.length - b.hit.title.length).map(({ hit }) => hit);
}

function stamp(hit: SearchHit): number {
	return (hit.at ? Date.parse(hit.at) : 0) || 0;
}

export function sortHits(hits: readonly SearchHit[], sort: SearchSort): SearchHit[] {
	if (sort === "match") return [...hits];
	if (sort === "latest") return [...hits].sort((a, b) => stamp(b) - stamp(a));
	const collator = new Intl.Collator(presentationLocale(), { numeric: true, sensitivity: "base" });
	return [...hits].sort((a, b) => collator.compare(a.title, b.title));
}

export function shortAge(iso: string | undefined, now = Date.now()): string {
	const at = iso ? Date.parse(iso) : Number.NaN;
	if (Number.isNaN(at)) return "";
	const minutes = Math.max(0, Math.floor((now - at) / MINUTE));
	if (minutes < 1) return t("now");
	const unit = (value: number, name: "minute" | "hour" | "day" | "week") =>
		new Intl.NumberFormat(presentationLocale(), { style: "unit", unit: name, unitDisplay: "narrow" }).format(value);
	if (minutes < 60) return unit(minutes, "minute");
	if (minutes < 24 * 60) return unit(Math.floor(minutes / 60), "hour");
	const days = Math.floor(minutes / (24 * 60));
	if (days < 7) return unit(days, "day");
	if (days < 8 * 7) return unit(Math.floor(days / 7), "week");
	return formatPresentationDate(new Date(at), days < 300 ? "short-date" : "full-date");
}

function storedRecent(profileId: string): string[] {
	try {
		const value: unknown = JSON.parse(localStorage.getItem(`${RECENT_KEY}:${profileId}`) ?? "[]");
		return Array.isArray(value) ? value.filter((key): key is string => typeof key === "string") : [];
	} catch {
		return [];
	}
}

function rememberRecent(profileId: string, key: string): void {
	try {
		const keys = [key, ...storedRecent(profileId).filter((kept) => kept !== key)].slice(0, RECENT_MAX);
		localStorage.setItem(`${RECENT_KEY}:${profileId}`, JSON.stringify(keys));
	} catch {}
}

function marked(text: string, words: readonly string[]): Node[] {
	const lower = text.toLocaleLowerCase();
	const spans: [number, number][] = [];
	for (const word of words) {
		const at = lower.indexOf(word);
		if (at >= 0) spans.push([at, at + word.length]);
	}
	spans.sort((a, b) => a[0] - b[0]);
	const nodes: Node[] = [];
	let from = 0;
	for (const [start, end] of spans) {
		if (start < from) continue;
		if (start > from) nodes.push(document.createTextNode(text.slice(from, start)));
		nodes.push(h("mark", null, text.slice(start, end)));
		from = end;
	}
	if (from < text.length) nodes.push(document.createTextNode(text.slice(from)));
	return nodes;
}

interface FileAnswer {
	readonly query: string;
	readonly limit: number;
	readonly hits: readonly SearchHit[];
	readonly failed: boolean;
}

interface Group {
	readonly label?: string;
	readonly hits: readonly SearchHit[];
	readonly note?: string;
}

export class SearchWindow {
	readonly el: HTMLDialogElement;
	readonly #input = h("input", {
		type: "text",
		class: "search-window-input",
		autocomplete: "off",
		spellcheck: "false",
		role: "combobox",
		"aria-expanded": "true",
		"aria-controls": "search-window-results",
		"aria-autocomplete": "list",
	});
	readonly #pickName = h("span");
	readonly #pick = h(
		"button",
		{ type: "button", class: "search-window-pick", "aria-haspopup": "menu" },
		this.#pickName,
		icon("chevron-down"),
	);
	readonly #filter = h(
		"button",
		{ type: "button", class: "search-window-filter", "aria-haspopup": "menu" },
		icon("filter"),
	);
	readonly #list = h("div", { class: "search-window-list", id: "search-window-results", role: "listbox" });
	readonly #results = h("div", { class: "search-window-results" }, this.#list);
	readonly #glide = new HoverGlide(this.#results, {
		tintClass: "hover-glide-tint",
		item: () => undefined,
		picks: true,
	});
	#sources: SearchSources | undefined;
	#only: SearchKind | null = null;
	#sort: SearchSort | null = null;
	#mark: SearchMark | null = null;
	#picked = 0;
	#shown: SearchHit[] = [];
	#files: FileAnswer | null = null;
	#recentFiles: SearchHit[] = [];
	#fileSearch: AbortController | null = null;
	#fileTimer: ReturnType<typeof setTimeout> | undefined;
	#opener: HTMLElement | null = null;
	#menu: ContextMenu | undefined;
	#shut: { press: Event; button: HTMLElement } | undefined;
	#pointer: { x: number; y: number } | undefined;

	constructor() {
		this.#list.setAttribute("aria-label", t("Results"));
		const close = h(
			"button",
			{ type: "button", class: "search-window-close", "aria-label": t("Close search") },
			icon("close"),
		);
		close.addEventListener("click", () => this.close());
		this.el = h(
			"dialog",
			{ class: "search-window", "aria-label": t("Search"), "aria-modal": "true" },
			h(
				"div",
				{ class: "search-window-box" },
				h("div", { class: "search-window-field" }, this.#pick, this.#input, this.#filter, close),
				this.#results,
			),
		);
		this.el.addEventListener("cancel", (event) => {
			event.preventDefault();
			if (this.#only || this.#mark) {
				this.#only = null;
				this.#mark = null;
				this.#redraw();
			} else this.close();
		});
		this.el.addEventListener("mousedown", (event) => {
			if (event.target === this.el) this.close();
		});
		this.el.addEventListener("close", () => this.#settle());
		this.#input.addEventListener("input", () => {
			this.#redraw();
			this.#askFiles();
		});
		this.#input.addEventListener("keydown", (event) => this.#key(event));
		this.#opens(this.#pick, () => this.#openMenu(this.#pick, t("Search only"), this.#kindEntries()));
		this.#opens(this.#filter, () => this.#openMenu(this.#filter, t("Sort and filter"), this.#filterEntries(), true));
		this.el.addEventListener("pointermove", (event) => this.#point(event));
		if (typeof ResizeObserver === "function")
			new ResizeObserver(() => {
				if (this.el.open) this.#light(false);
			}).observe(this.#list);
		this.#results.addEventListener("mousedown", (event) => event.preventDefault());
		this.#results.addEventListener("click", (event) => {
			const hit = this.#shown[this.#indexOf(event.target)];
			if (hit) this.#go(hit);
		});
	}

	get isOpen(): boolean {
		return this.el.open;
	}

	open(sources: SearchSources, opener: HTMLElement | null = null): void {
		const changed = this.#sources?.profileId !== sources.profileId;
		this.#sources = sources;
		this.#opener = opener;
		if (changed) {
			this.#files = null;
			this.#recentFiles = [];
		}
		if (!this.el.isConnected) document.body.append(this.el);
		this.#input.value = "";
		this.#only = null;
		this.#sort = null;
		this.#mark = null;
		this.#pointer = undefined;
		if (!this.el.open) this.el.showModal();
		this.#redraw();
		this.#input.focus();
		this.#loadRecentFiles();
	}

	close(): void {
		if (this.el.open) this.el.close();
	}

	reset(): void {
		this.close();
		this.#settle();
	}

	#settle(): void {
		this.#menu?.close();
		this.#fileSearch?.abort();
		this.#fileSearch = null;
		clearTimeout(this.#fileTimer);
		const opener = this.#opener;
		this.#opener = null;
		this.#sources = undefined;
		this.#files = null;
		this.#recentFiles = [];
		this.#shown = [];
		this.#list.replaceChildren();
		this.#glide.moveTo(undefined);
		if (opener?.isConnected) opener.focus({ preventScroll: true });
	}

	#redraw(): void {
		this.#picked = 0;
		this.#results.scrollTop = 0;
		this.#draw();
	}

	#narrow(kind: SearchKind | null): void {
		this.#only = kind;
		if (kind && this.#mark && MARK_KIND[this.#mark] !== kind) this.#mark = null;
		this.#redraw();
		if (this.#manyFiles()) this.#askFiles();
	}

	#key(event: KeyboardEvent): void {
		if (event.isComposing) return;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const step = event.key === "ArrowDown" ? 1 : -1;
			this.#picked = Math.max(0, Math.min(this.#shown.length - 1, this.#picked + step));
			this.#light();
		} else if (event.key === "Enter") {
			event.preventDefault();
			const hit = this.#shown[this.#picked];
			if (hit) this.#go(hit);
		} else if (event.key === "Tab" && this.#input.value.trim()) {
			event.preventDefault();
			const order: (SearchKind | null)[] = [null, ...KINDS];
			const at = order.indexOf(this.#only);
			this.#narrow(order[(at + (event.shiftKey ? order.length - 1 : 1)) % order.length] ?? null);
		}
	}

	#indexOf(target: EventTarget | null): number {
		const row = target instanceof Element ? target.closest<HTMLElement>(".search-window-hit") : null;
		return row ? Number(row.dataset.index) : -1;
	}

	#point(event: PointerEvent): void {
		const still = this.#pointer?.x === event.clientX && this.#pointer.y === event.clientY;
		this.#pointer = { x: event.clientX, y: event.clientY };
		if (still || event.pointerType === "touch") return;
		const index = this.#indexOf(event.target);
		if (index < 0 || index === this.#picked) return;
		this.#picked = index;
		this.#light(false);
	}

	#go(hit: SearchHit): void {
		if (this.#sources) rememberRecent(this.#sources.profileId, hit.key);
		this.#opener = null;
		this.close();
		hit.open();
	}

	#opens(button: HTMLElement, open: () => void): void {
		button.addEventListener("pointerdown", (event) => {
			const shutIt = this.#shut?.press === event && this.#shut.button === button;
			if (event.button === 0 && !shutIt) open();
		});
		button.addEventListener("mousedown", (event) => event.preventDefault());
		button.addEventListener("click", (event) => {
			if (event.detail === 0) open();
		});
	}

	#openMenu(button: HTMLElement, label: string, items: MenuEntry[], end = false): void {
		const rect = button.getBoundingClientRect();
		const menu = openContextMenu({
			label,
			x: rect.left,
			y: rect.bottom + 6 * uiScale(),
			items,
			opener: button,
			container: this.el,
			onClose: (press) => {
				this.#shut = press ? { press, button } : undefined;
				if (this.#menu === menu) this.#menu = undefined;
				if (this.el.open) this.#input.focus({ preventScroll: true });
			},
		});
		this.#menu = menu;
		if (end) menu.el.style.left = `${Math.max(8 * uiScale(), rect.right - menu.el.offsetWidth)}px`;
	}

	#kindEntries(): MenuEntry[] {
		return ([null, ...KINDS] as (SearchKind | null)[]).map((kind) => ({
			label: kindLabel(kind),
			checked: this.#only === kind,
			select: () => this.#narrow(kind),
		}));
	}

	#filterEntries(): MenuEntry[] {
		const typing = searchWords(this.#input.value).length > 0;
		const sorts: SearchSort[] = typing ? ["match", "latest", "name"] : ["latest", "name"];
		const sort = this.#sortNow(typing);
		const entries: MenuEntry[] = [{ kind: "caption", label: t("Sort") }];
		for (const one of sorts)
			entries.push({
				label: sortLabel(one),
				checked: sort === one,
				select: () => {
					this.#sort = one;
					this.#redraw();
				},
			});
		const marks = MARKS.filter((mark) => !this.#only || MARK_KIND[mark] === this.#only);
		if (!marks.length) return entries;
		entries.push({ kind: "separator" }, { kind: "caption", label: t("Show") });
		for (const mark of [null, ...marks])
			entries.push({
				label: mark ? markLabel(mark) : t("Everything"),
				checked: this.#mark === mark,
				select: () => {
					this.#mark = mark;
					this.#redraw();
					if (this.#manyFiles()) this.#askFiles();
				},
			});
		return entries;
	}

	#sortNow(typing: boolean): SearchSort {
		if (this.#sort === "match" && !typing) return "latest";
		return this.#sort ?? (typing ? "match" : "latest");
	}

	#manyFiles(): boolean {
		return this.#only === "files" || (this.#mark !== null && MARK_KIND[this.#mark] === "files");
	}

	#loadRecentFiles(): void {
		const files = this.#sources?.files;
		if (!files) return;
		const sources = this.#sources;
		const stop = new AbortController();
		this.el.addEventListener("close", () => stop.abort(), { once: true });
		files.recent(stop.signal).then(
			(hits) => {
				if (stop.signal.aborted || this.#sources !== sources) return;
				this.#recentFiles = hits;
				if (!this.#input.value.trim()) this.#draw();
			},
			() => undefined,
		);
	}

	#askFiles(): void {
		clearTimeout(this.#fileTimer);
		this.#fileSearch?.abort();
		this.#fileSearch = null;
		const files = this.#sources?.files;
		const query = this.#input.value.trim();
		if (!files || !searchWords(query).length) return;
		const limit = this.#manyFiles() ? SHOWN_NARROWED : SHOWN_PER_KIND;
		if (this.#files && !this.#files.failed && this.#files.query === query && this.#files.limit >= limit) return;
		this.#fileTimer = setTimeout(() => {
			const stop = new AbortController();
			this.#fileSearch = stop;
			files.search(query, limit, stop.signal).then(
				({ hits }) => {
					if (stop.signal.aborted) return;
					this.#files = { query, limit, hits, failed: false };
					this.#draw();
				},
				() => {
					if (stop.signal.aborted) return;
					this.#files = { query, limit, hits: [], failed: true };
					this.#draw();
				},
			);
		}, FILE_DELAY_MS);
	}

	#recentHits(all: readonly SearchHit[]): SearchHit[] {
		const byKey = new Map(all.map((hit) => [hit.key, hit]));
		const sources = this.#sources!;
		const kept = storedRecent(sources.profileId)
			.map((key) => byKey.get(key) ?? sources.revive?.(key))
			.filter((hit): hit is SearchHit => Boolean(hit));
		const keys = new Set(kept.map((hit) => hit.key));
		const files = this.#recentFiles.filter((hit) => !keys.has(hit.key)).slice(0, RECENT_FILES);
		return [...kept, ...files].slice(0, RECENT_SHOWN);
	}

	#groups(query: string, words: readonly string[]): Group[] {
		const all = this.#sources!.hits();
		const typing = words.length > 0;
		const mark = this.#mark;
		const narrowed = this.#only !== null || mark !== null;
		if (!typing && !narrowed) {
			const recent = this.#recentHits(all);
			const hits = this.#sort ? sortHits(recent, this.#sortNow(false)) : recent;
			return hits.length ? [{ label: t("Recent"), hits }] : [];
		}
		const sort = this.#sortNow(typing);
		const cap = narrowed ? SHOWN_NARROWED : SHOWN_PER_KIND;
		const ranked = typing ? rankHits(all, words) : all;
		const groups: Group[] = [];
		for (const kind of KINDS) {
			if (this.#only && this.#only !== kind) continue;
			if (mark && MARK_KIND[mark] !== kind) continue;
			const label = this.#only ? {} : { label: kindLabel(kind) };
			let pool: readonly SearchHit[];
			if (kind !== "files") pool = ranked.filter((hit) => hit.kind === kind);
			else if (!typing) pool = this.#recentFiles;
			else {
				const answer = this.#files && this.#files.query === query ? this.#files : null;
				if (answer?.failed) {
					groups.push({ ...label, hits: [], note: t("Files could not be searched just now.") });
					continue;
				}
				pool = answer?.hits ?? [];
			}
			const hits = sortHits(
				pool.filter((hit) => !mark || hit.marks?.includes(mark)),
				sort,
			).slice(0, cap);
			if (hits.length) groups.push({ ...label, hits });
		}
		return groups;
	}

	#draw(): void {
		const sources = this.#sources;
		if (!sources) return;
		const query = this.#input.value.trim();
		const words = searchWords(query);
		this.#drawField(words.length > 0);
		const groups = this.#groups(query, words);
		this.#shown = groups.flatMap((group) => group.hits);
		this.#picked = Math.min(this.#picked, Math.max(0, this.#shown.length - 1));
		if (!groups.length) {
			const narrowed = this.#only !== null || this.#mark !== null;
			replace(
				this.#list,
				h(
					"p",
					{ class: "search-window-empty" },
					words.length
						? t("Nothing in {company} matches “{query}”.", { company: sources.companyName, query })
						: narrowed
							? t("Nothing here yet.")
							: t("Type to find agents, apps, files and settings."),
				),
			);
			this.#light();
			return;
		}
		const now = Date.now();
		let index = 0;
		const nodes: HTMLElement[] = [];
		for (const group of groups) {
			if (group.label) nodes.push(h("div", { class: "search-window-group", role: "presentation" }, group.label));
			if (group.note) nodes.push(h("p", { class: "search-window-note" }, group.note));
			for (const hit of group.hits) nodes.push(this.#row(hit, index++, words, now));
		}
		replace(this.#list, ...nodes);
		this.#light();
	}

	#drawField(typing: boolean): void {
		const label = fieldLabel(this.#only);
		this.#input.placeholder = label;
		this.#input.setAttribute("aria-label", label);
		this.#pickName.textContent = kindLabel(this.#only);
		this.#pick.setAttribute("aria-label", `${t("Search only")}: ${kindLabel(this.#only)}`);
		const sorted = this.#sort !== null && this.#sortNow(typing) !== (typing ? "match" : "latest");
		const narrowed = sorted || this.#mark !== null;
		this.#filter.classList.toggle("is-on", narrowed);
		const state = [sorted ? sortLabel(this.#sortNow(typing)) : "", this.#mark ? markLabel(this.#mark) : ""].filter(
			Boolean,
		);
		const name = state.length ? `${t("Sort and filter")}: ${state.join(", ")}` : t("Sort and filter");
		this.#filter.setAttribute("aria-label", name);
		this.#filter.title = name;
	}

	#row(hit: SearchHit, index: number, words: readonly string[], now: number): HTMLElement {
		const age = shortAge(hit.at, now);
		return h(
			"div",
			{
				class: "search-window-hit",
				role: "option",
				id: `search-window-hit-${index}`,
				"aria-selected": "false",
				"data-index": String(index),
			},
			h("span", { class: `search-window-lead is-${hit.kind}`, "aria-hidden": "true" }, hit.lead()),
			h("span", { class: "search-window-title" }, ...marked(hit.title, words)),
			hit.detail ? h("span", { class: "search-window-detail" }, hit.detail) : null,
			age && hit.at
				? h("time", { class: "search-window-time", datetime: hit.at, title: fmtTime(hit.at) }, age)
				: null,
		);
	}

	#light(scroll = true): void {
		const rows = this.#list.querySelectorAll<HTMLElement>(".search-window-hit");
		for (const [index, row] of rows.entries()) row.setAttribute("aria-selected", String(index === this.#picked));
		const picked = rows[this.#picked];
		if (picked) {
			this.#input.setAttribute("aria-activedescendant", picked.id);
			if (scroll) picked.scrollIntoView({ block: "nearest" });
		} else this.#input.removeAttribute("aria-activedescendant");
		this.#glide.moveTo(picked);
	}
}
