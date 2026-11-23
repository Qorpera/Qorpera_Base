import { h, icon, replace } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";

export type SearchKind = "people" | "apps" | "files" | "settings";

export interface SearchHit {
	readonly key: string;
	readonly kind: SearchKind;
	readonly title: string;
	readonly detail: string;
	readonly words?: string;
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
const RECENT_KEY = "qorpera.search-recent";
const RECENT_MAX = 6;
const SHOWN_PER_KIND = 4;
const SHOWN_NARROWED = 20;
const FILE_DELAY_MS = 120;

const kindLabel = (kind: SearchKind): string =>
	({
		people: t("Agents and people"),
		apps: t("Apps"),
		files: t("Files"),
		settings: t("Settings"),
	})[kind];

const openLabel = (kind: SearchKind): string =>
	({
		people: t("Open conversation"),
		apps: t("Open app"),
		files: t("Show in Company File"),
		settings: t("Open in Settings"),
	})[kind];

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
	readonly hits: readonly SearchHit[];
	readonly failed: boolean;
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
	readonly #chips = h("div", { class: "search-window-kinds", role: "group" });
	readonly #results = h("div", { class: "search-window-results", id: "search-window-results", role: "listbox" });
	#sources: SearchSources | undefined;
	#only: SearchKind | null = null;
	#picked = 0;
	#shown: SearchHit[] = [];
	#files: FileAnswer | null = null;
	#recentFiles: SearchHit[] = [];
	#fileSearch: AbortController | null = null;
	#fileTimer: ReturnType<typeof setTimeout> | undefined;
	#opener: HTMLElement | null = null;

	constructor() {
		const label = t("Search agents, files and settings");
		this.#input.placeholder = label;
		this.#input.setAttribute("aria-label", label);
		this.#chips.setAttribute("aria-label", t("Search only"));
		this.#results.setAttribute("aria-label", t("Results"));
		const keys = h(
			"div",
			{ class: "search-window-keys", "aria-hidden": "true" },
			h("span", null, h("kbd", null, "↑"), h("kbd", null, "↓"), t("move")),
			h("span", null, h("kbd", null, "↵"), t("open")),
			h("span", null, h("kbd", null, t("tab")), t("one kind")),
			h("span", null, h("kbd", null, t("esc")), t("close")),
		);
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
				h("div", { class: "search-window-field" }, icon("search"), this.#input, close),
				this.#chips,
				this.#results,
				keys,
			),
		);
		this.el.addEventListener("cancel", (event) => {
			event.preventDefault();
			if (this.#only) {
				this.#only = null;
				this.#picked = 0;
				this.#draw();
			} else this.close();
		});
		this.el.addEventListener("mousedown", (event) => {
			if (event.target === this.el) this.close();
		});
		this.el.addEventListener("close", () => this.#settle());
		this.#input.addEventListener("input", () => {
			this.#picked = 0;
			if (!this.#input.value.trim()) this.#only = null;
			this.#results.scrollTop = 0;
			this.#draw();
			this.#askFiles();
		});
		this.#input.addEventListener("keydown", (event) => this.#key(event));
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
		this.#picked = 0;
		this.#draw();
		if (!this.el.open) this.el.showModal();
		this.#input.focus();
		this.#loadRecentFiles();
	}

	close(): void {
		if (this.el.open) this.el.close();
	}

	#settle(): void {
		this.#fileSearch?.abort();
		this.#fileSearch = null;
		clearTimeout(this.#fileTimer);
		const opener = this.#opener;
		this.#opener = null;
		if (opener?.isConnected) opener.focus({ preventScroll: true });
	}

	#key(event: KeyboardEvent): void {
		if (event.isComposing) return;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const step = event.key === "ArrowDown" ? 1 : -1;
			this.#picked = Math.max(0, Math.min(this.#shown.length - 1, this.#picked + step));
			this.#mark();
		} else if (event.key === "Enter") {
			event.preventDefault();
			const hit = this.#shown[this.#picked];
			if (hit) this.#go(hit);
		} else if (event.key === "Tab" && this.#input.value.trim()) {
			event.preventDefault();
			const order: (SearchKind | null)[] = [null, ...KINDS];
			const at = order.indexOf(this.#only);
			this.#only = order[(at + (event.shiftKey ? order.length - 1 : 1)) % order.length] ?? null;
			this.#picked = 0;
			this.#results.scrollTop = 0;
			this.#draw();
			if (this.#only === "files") this.#askFiles();
		}
	}

	#go(hit: SearchHit): void {
		if (this.#sources) rememberRecent(this.#sources.profileId, hit.key);
		this.#opener = null;
		this.close();
		hit.open();
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
		this.#fileTimer = setTimeout(() => {
			const stop = new AbortController();
			this.#fileSearch = stop;
			const limit = this.#only === "files" ? SHOWN_NARROWED : SHOWN_PER_KIND;
			files.search(query, limit, stop.signal).then(
				({ hits }) => {
					if (stop.signal.aborted) return;
					this.#files = { query, hits, failed: false };
					this.#draw();
				},
				() => {
					if (stop.signal.aborted) return;
					this.#files = { query, hits: [], failed: true };
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
		return [...kept, ...this.#recentFiles.filter((hit) => !keys.has(hit.key))].slice(0, 8);
	}

	#draw(): void {
		const sources = this.#sources;
		if (!sources) return;
		const query = this.#input.value.trim();
		const words = searchWords(query);
		this.#drawChips(words.length > 0);
		const all = sources.hits();
		const groups: { label: string; hits: readonly SearchHit[]; note?: string }[] = [];
		if (!words.length) {
			const recent = this.#recentHits(all);
			if (recent.length) groups.push({ label: t("Recent"), hits: recent });
		} else {
			const ranked = rankHits(all, words);
			const cap = this.#only ? SHOWN_NARROWED : SHOWN_PER_KIND;
			for (const kind of KINDS) {
				if (this.#only && this.#only !== kind) continue;
				if (kind === "files") {
					const answer = this.#files && this.#files.query === query ? this.#files : null;
					if (answer?.failed)
						groups.push({ label: kindLabel(kind), hits: [], note: t("Files could not be searched just now.") });
					else if (answer?.hits.length) groups.push({ label: kindLabel(kind), hits: answer.hits.slice(0, cap) });
					continue;
				}
				const hits = ranked.filter((hit) => hit.kind === kind).slice(0, cap);
				if (hits.length) groups.push({ label: kindLabel(kind), hits });
			}
		}
		this.#shown = groups.flatMap((group) => group.hits);
		this.#picked = Math.min(this.#picked, Math.max(0, this.#shown.length - 1));
		if (!groups.length) {
			replace(
				this.#results,
				h(
					"p",
					{ class: "search-window-empty" },
					words.length
						? t("Nothing in {company} matches “{query}”.", { company: sources.companyName, query })
						: t("Type to find agents, apps, files and settings."),
				),
			);
			this.#input.removeAttribute("aria-activedescendant");
			return;
		}
		let index = 0;
		const nodes: HTMLElement[] = [];
		for (const group of groups) {
			nodes.push(h("div", { class: "search-window-group", role: "presentation" }, group.label));
			if (group.note) nodes.push(h("p", { class: "search-window-note" }, group.note));
			for (const hit of group.hits) nodes.push(this.#row(hit, index++, words));
		}
		replace(this.#results, ...nodes);
		this.#mark();
	}

	#drawChips(shown: boolean): void {
		this.#chips.hidden = !shown;
		if (!shown) return;
		const chips = ([null, ...KINDS] as (SearchKind | null)[]).map((kind) => {
			const chip = h(
				"button",
				{
					type: "button",
					class: "search-window-kind",
					"aria-pressed": String(this.#only === kind),
					tabindex: "-1",
				},
				kind ? kindLabel(kind) : t("All"),
			);
			chip.addEventListener("mousedown", (event) => event.preventDefault());
			chip.addEventListener("click", () => {
				this.#only = kind;
				this.#picked = 0;
				this.#results.scrollTop = 0;
				this.#draw();
				if (kind === "files") this.#askFiles();
			});
			return chip;
		});
		replace(this.#chips, ...chips);
	}

	#row(hit: SearchHit, index: number, words: readonly string[]): HTMLElement {
		const row = h(
			"div",
			{ class: "search-window-hit", role: "option", id: `search-window-hit-${index}`, "aria-selected": "false" },
			h("span", { class: `search-window-lead is-${hit.kind}`, "aria-hidden": "true" }, hit.lead()),
			h(
				"span",
				{ class: "search-window-text" },
				h("span", { class: "search-window-title" }, ...marked(hit.title, words)),
				h("span", { class: "search-window-detail" }, hit.detail),
			),
			h("span", { class: "search-window-go", "aria-hidden": "true" }, `${openLabel(hit.kind)} ↵`),
		);
		row.addEventListener("mousemove", () => {
			if (this.#picked === index) return;
			this.#picked = index;
			this.#mark(false);
		});
		row.addEventListener("mousedown", (event) => event.preventDefault());
		row.addEventListener("click", () => this.#go(hit));
		return row;
	}

	#mark(scroll = true): void {
		const rows = this.#results.querySelectorAll<HTMLElement>(".search-window-hit");
		for (const [index, row] of rows.entries()) row.setAttribute("aria-selected", String(index === this.#picked));
		const picked = rows[this.#picked];
		if (picked) {
			this.#input.setAttribute("aria-activedescendant", picked.id);
			if (scroll) picked.scrollIntoView({ block: "nearest" });
		} else this.#input.removeAttribute("aria-activedescendant");
	}
}
