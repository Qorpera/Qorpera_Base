import type {
	CloudMemberDatabase,
	CloudMemberDataColumn,
	CloudMemberDataDescription,
	CloudMemberDataNamed,
	CloudMemberDataPage,
	CloudMemberDataRow,
	CloudMemberDataTable,
	CloudMemberDataWatched,
} from "@qorpera/cloud-client/cloud-member-data";
import { button, h, icon, replace } from "../../ui/dom.ts";
import { interfaceEmblem } from "../../ui/interface-emblem.ts";
import { presentationLocale, t } from "../../ui/preferences.ts";
import type { CompanyController } from "../company.ts";
import type { CompanyDatabases, CompanyDataCalls } from "../company-data.ts";
import type { DataAskPlace, DataAskSend } from "../data-ask.ts";
import { takeWantedDataList } from "../data-page.ts";
import { DataAskBox } from "./data-ask.ts";
import { DataParams } from "./data-params.ts";

const PAGE_ROWS = 100;
const WATCH_GAP_MS = 500;
const WATCH_RETRY_MS = [2000, 5000, 10_000] as const;
const SAVED_MS = 1600;

type Kind = "boolean" | "number" | "date" | "time" | "json" | "text";

interface Tab {
	readonly kind: "table" | "question";
	readonly name: string;
}

interface Row {
	readonly values: readonly unknown[];
	readonly seen: string | null;
}

interface ListRead {
	readonly id: string;
	readonly database: string;
	readonly tab: Tab;
	readonly order: string | undefined;
	readonly desc: boolean;
	readonly params: Readonly<Record<string, string>>;
	columns: readonly string[];
	key: readonly string[];
	rows: Row[];
	next: readonly unknown[] | undefined;
	more: boolean;
	etag: string | undefined;
	pages: number;
	loading: boolean;
	failed: boolean;
	tooLarge: boolean;
	readonly stop: AbortController;
}

interface OpenRow {
	readonly database: string;
	readonly table: string;
	columns: readonly string[];
	key: readonly string[];
	row: Row | null;
	readonly draft: Map<string, string>;
	notice: { readonly text: string; readonly tone: "note" | "danger" } | undefined;
	readonly notes: Map<string, string>;
	readonly saved: Set<string>;
	readonly saving: Map<string, number>;
	readonly pending: Map<string, { value: unknown; writes: number }>;
	gone: boolean;
	queue: Promise<void>;
	asking: boolean;
	askNote: string | undefined;
}

export function humanName(name: string): string {
	const words = name.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
	return words ? words.charAt(0).toLocaleUpperCase() + words.slice(1) : name;
}

export function columnKind(type: string): Kind {
	const base = type.toLowerCase();
	if (base === "boolean") return "boolean";
	if (/^(smallint|integer|bigint|real|double precision|numeric|decimal|money)(\([0-9, ]*\))?$/.test(base))
		return "number";
	if (base === "date") return "date";
	if (/^(timestamp|time)\b/.test(base)) return "time";
	if (base === "json" || base === "jsonb") return "json";
	return "text";
}

export function shownValue(value: unknown, kind: Kind): string {
	if (value === null || value === undefined) return "";
	const locale = presentationLocale() === "da" ? "da-DK" : "en-GB";
	if (typeof value === "boolean") return value ? t("Yes") : t("No");
	if (typeof value === "number") return new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(value);
	if (typeof value !== "string") return JSON.stringify(value);
	if (kind === "json") return JSON.stringify(value);
	if (kind === "date") {
		const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
		if (day)
			return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).toLocaleDateString(locale, {
				day: "numeric",
				month: "short",
				year: "numeric",
			});
	}
	if (kind === "time" && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(value)) {
		const at = new Date(value.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
		if (Number.isFinite(at.getTime()))
			return at.toLocaleString(locale, {
				day: "numeric",
				month: "short",
				year: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			});
	}
	return value;
}

function editText(value: unknown, kind: Kind): string {
	if (kind === "json" && value !== null && value !== undefined) return JSON.stringify(value);
	return typedText(value);
}

function typedText(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return JSON.stringify(value);
}

function sentValue(text: string, kind: Kind): { ok: true; value: unknown } | { ok: false; note: string } {
	if (kind === "json") {
		if (text.trim() === "") return { ok: true, value: null };
		try {
			return { ok: true, value: JSON.parse(text) };
		} catch {
			return { ok: false, note: t("That isn't valid JSON.") };
		}
	}
	if (kind === "text") return { ok: true, value: text === "" ? null : text };
	const trimmed = text.trim();
	return { ok: true, value: trimmed === "" ? null : trimmed };
}

export function refusalWords(error: unknown): string {
	const refused = error as { status?: unknown; code?: unknown; message?: unknown };
	const status = refused?.status;
	if (status === 400) {
		const message = typeof refused.message === "string" ? refused.message : "";
		switch (refused.code) {
			case "23502": {
				const column = /column "([^"]+)"/.exec(message)?.[1];
				return column
					? t("Fill in {column} too.", { column: humanName(column) })
					: t("Fill in the empty fields too.");
			}
			case "23505":
				return t("Another row has this already.");
			case "23514":
				return t("That value isn't allowed here.");
			case "23503":
				return t("That names a row that isn't there.");
			case "22001":
				return t("That is too long for this field.");
			case "22P02":
			case "22003":
			case "22007":
			case "22008":
				return t("That doesn't fit this field.");
			default:
				return t("That couldn't be saved.");
		}
	}
	if (status === 401) return t("Sign in again to change rows.");
	if (status === 403) return t("You can't change this table.");
	if (status === 404) return t("This table is gone.");
	if (status === 507) return t("The company's data is full. Removing rows still works.");
	return t("Not saved. Try again.");
}

function bytesText(bytes: number): string {
	const locale = presentationLocale() === "da" ? "da-DK" : "en-GB";
	const units = ["B", "KB", "MB", "GB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1000 && unit < units.length - 1) {
		value /= 1000;
		unit++;
	}
	const shown = new Intl.NumberFormat(locale, { maximumFractionDigits: value < 10 && unit > 0 ? 1 : 0 }).format(value);
	return `${shown} ${units[unit]}`;
}

function tableOf(database: CloudMemberDatabase | undefined, name: string): CloudMemberDataTable | undefined {
	return database?.tables?.find((table) => table.name === name);
}

function questionTabs(database: CloudMemberDatabase): Tab[] {
	return database.questions
		.filter((question) => question.parameters !== null)
		.map((question) => ({ kind: "question", name: question.name }));
}

function tabsOf(database: CloudMemberDatabase): Tab[] {
	return [
		...(database.tables ?? []).map((table): Tab => ({ kind: "table", name: table.name })),
		...questionTabs(database),
	];
}

const keyOf = (columns: readonly string[], key: readonly string[], values: readonly unknown[]) =>
	JSON.stringify(key.map((name) => values[columns.indexOf(name)] ?? null));

function shownColumns(columns: readonly string[], key: readonly string[]): string[] {
	if (columns.length < 2 || !key.includes(columns[0] ?? "")) return [...columns];
	return [...columns.filter((name) => !key.includes(name)), ...columns.filter((name) => key.includes(name))];
}

const sleep = (ms: number, signal: AbortSignal) =>
	new Promise<void>((resolve) => {
		if (signal.aborted) return resolve();
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done, { once: true });
	});

const shown = () =>
	new Promise<void>((resolve) => {
		if (document.visibilityState !== "hidden") return resolve();
		const seen = () => {
			if (document.visibilityState === "hidden") return;
			document.removeEventListener("visibilitychange", seen);
			resolve();
		};
		document.addEventListener("visibilitychange", seen);
	});

class DataListView {
	readonly el = h("section", { class: "page data-page" });
	readonly company: CompanyController;
	readonly #databases: CompanyDatabases;
	readonly #bar = h("section", { class: "app-ask data-ask", role: "group", hidden: true });
	readonly #top = h("div", { class: "data-top" });
	readonly #body = h("div", { class: "data-body" });
	readonly #params = new DataParams();
	readonly #ask: DataAskBox;
	readonly #values = new Map<string, Record<string, string>>();
	readonly #lifetime = new AbortController();
	#described: CloudMemberDataDescription | null | undefined;
	#database: string | undefined;
	#tab: Tab | undefined;
	readonly #orders = new Map<string, { column: string; desc: boolean }>();
	#list: ListRead | undefined;
	#open: OpenRow | undefined;
	#rowEl: HTMLElement | undefined;
	readonly #inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>();
	#observer: IntersectionObserver | undefined;
	readonly #counted = new Map<string, number>();

	constructor(company: CompanyController, databases: CompanyDatabases, send: DataAskSend | undefined) {
		this.company = company;
		this.#databases = databases;
		this.#ask = new DataAskBox(company, send);
		replace(this.el, this.#bar, this.#top, this.#params.el, this.#body, this.#ask.el);
		company.signal.addEventListener("abort", () => this.dispose(), { once: true });
		databases.signal.addEventListener("abort", () => this.dispose(), { once: true });
		this.el.addEventListener("keydown", (event) => {
			if (event.key === "Escape" && this.#open?.asking) {
				event.preventDefault();
				this.#notNow();
			}
		});
		void databases.refresh();
	}

	get databases(): CompanyDatabases {
		return this.#databases;
	}

	dispose(): void {
		this.#lifetime.abort();
		this.#list?.stop.abort();
		this.#observer?.disconnect();
	}

	#calls(): CompanyDataCalls {
		return this.#databases.calls();
	}

	update(described: CloudMemberDataDescription | null | undefined): void {
		const fresh = described !== this.#described;
		if (!fresh && this.#top.childElementCount > 0) return;
		this.#described = described;
		if (fresh) this.#counted.clear();
		const databases = described?.databases ?? [];
		const wanted = described ? takeWantedDataList(this.company.profile.profileId) : undefined;
		if (wanted !== undefined) this.#want(databases, wanted);
		if (!databases.some((one) => one.database === this.#database)) this.#database = databases[0]?.database;
		const database = this.#current();
		const tabs = database ? tabsOf(database) : [];
		if (!tabs.some((tab) => tab.kind === this.#tab?.kind && tab.name === this.#tab?.name)) this.#tab = tabs[0];
		this.#ensureList();
		this.#draw();
	}

	#want(databases: readonly CloudMemberDatabase[], at: string): void {
		const cut = at.search(/[.:]/);
		const database = databases.find((one) => one.database === (cut < 0 ? at : at.slice(0, cut)));
		if (!database) return;
		this.#database = database.database;
		this.#close();
		if (cut < 0) return;
		const kind = at[cut] === "." ? "table" : "question";
		const name = at.slice(cut + 1);
		const tab = tabsOf(database).find((one) => one.kind === kind && one.name === name);
		if (tab) this.#tab = tab;
	}

	#question(): CloudMemberDataNamed | undefined {
		const tab = this.#tab;
		return tab?.kind === "question" ? this.#current()?.questions.find((one) => one.name === tab.name) : undefined;
	}

	#asks(): string[] {
		return (this.#question()?.parameters ?? []).filter((name) => name !== "viewer");
	}

	#given(): Record<string, string> {
		const tab = this.#tab;
		if (!this.#database || tab?.kind !== "question") return {};
		const values = this.#values.get(`${this.#database}/${tab.name}`) ?? {};
		return Object.fromEntries(this.#asks().map((name) => [name, values[name] ?? ""]));
	}

	#filled(): boolean {
		return Object.values(this.#given()).every((value) => value !== "");
	}

	#give(name: string, value: string): void {
		const tab = this.#tab;
		if (!this.#database || tab?.kind !== "question") return;
		const place = `${this.#database}/${tab.name}`;
		const values = { ...(this.#values.get(place) ?? {}) };
		if ((values[name] ?? "") === value.trim()) return;
		values[name] = value.trim();
		this.#values.set(place, values);
		this.#ensureList();
		this.#draw();
	}

	#place(): DataAskPlace | undefined {
		const database = this.#current();
		const tab = this.#tab;
		if (!database || !tab || this.#open) return undefined;
		return {
			database: database.database,
			databaseName: database.name ?? humanName(database.database),
			kind: tab.kind,
			name: tab.name,
			title: humanName(tab.name),
			values: Object.values(this.#given()).filter((value) => value !== ""),
		};
	}

	#current(): CloudMemberDatabase | undefined {
		return this.#described?.databases.find((one) => one.database === this.#database);
	}

	#table(): CloudMemberDataTable | undefined {
		return this.#tab?.kind === "table" ? tableOf(this.#current(), this.#tab.name) : undefined;
	}

	#writable(): boolean {
		const table = this.#table();
		const state = this.company.store.get();
		return (
			this.#current()?.write === true &&
			table?.kind === "table" &&
			table.key.length > 0 &&
			state.team?.capabilities.write !== false &&
			!state.accessLost
		);
	}

	#columnOf(name: string): CloudMemberDataColumn | undefined {
		return this.#table()?.columns.find((column) => column.name === name);
	}

	#kindOf(name: string): Kind {
		const column = this.#columnOf(name);
		return column ? columnKind(column.type) : "text";
	}

	#listId(): string | undefined {
		if (!this.#database || !this.#tab) return undefined;
		if (!this.#filled()) return undefined;
		const order = this.#orders.get(`${this.#database}/${this.#tab.name}`);
		return JSON.stringify([
			this.#database,
			this.#tab.kind,
			this.#tab.name,
			order?.column ?? null,
			order?.desc ?? false,
			this.#given(),
		]);
	}

	#ensureList(): void {
		const id = this.#listId();
		if (this.#list?.id === id) return;
		const before = this.#list;
		before?.stop.abort();
		this.#list = undefined;
		if (!id || !this.#database || !this.#tab) return;
		const order = this.#orders.get(`${this.#database}/${this.#tab.name}`);
		const read: ListRead = {
			id,
			database: this.#database,
			tab: this.#tab,
			order: order?.column,
			desc: order?.desc ?? false,
			params: this.#given(),
			...(before &&
			before.database === this.#database &&
			before.tab.kind === this.#tab.kind &&
			before.tab.name === this.#tab.name
				? { columns: before.columns, key: before.key, rows: before.rows }
				: { columns: [], key: [], rows: [] }),
			next: undefined,
			more: false,
			etag: undefined,
			pages: 0,
			loading: true,
			failed: false,
			tooLarge: false,
			stop: new AbortController(),
		};
		this.#list = read;
		void this.#first(read);
	}

	#asked(read: ListRead) {
		return {
			database: read.database,
			table: read.tab.name,
			...(read.order ? { order: read.order, desc: read.desc } : {}),
			limit: PAGE_ROWS,
		};
	}

	async #first(read: ListRead): Promise<void> {
		const signal = AbortSignal.any([read.stop.signal, this.#lifetime.signal]);
		try {
			if (read.tab.kind === "question") {
				const answer = await this.#calls().query(
					{ database: read.database, question: read.tab.name, params: read.params },
					signal,
				);
				if (signal.aborted) return;
				read.columns = answer.columns;
				read.key = [];
				read.rows = answer.rows.map((values) => ({ values, seen: null }));
				read.more = answer.more;
				read.etag = answer.etag;
			} else {
				const page = await this.#calls().rows(this.#asked(read), signal);
				if (signal.aborted) return;
				this.#take(read, [page]);
			}
			read.failed = false;
		} catch {
			if (signal.aborted) return;
			read.failed = true;
		}
		read.loading = false;
		if (this.#list === read) this.#drawBody();
		if (!read.failed) void this.#watch(read, signal);
	}

	#take(read: ListRead, pages: readonly CloudMemberDataPage[]): void {
		const [first] = pages;
		if (!first) return;
		read.columns = first.columns;
		read.key = first.key;
		read.rows = pages.flatMap((page) =>
			page.rows.filter(hasValues).map((row) => ({ values: row.values, seen: row.seen })),
		);
		const last = pages.at(-1);
		read.next = last?.next;
		read.more = last?.more ?? false;
		read.tooLarge = pages.some((page) => page.tooLarge === true);
		read.etag = first.etag;
		read.pages = pages.length;
	}

	async #more(read: ListRead): Promise<void> {
		if (read.loading || !read.next || read.tab.kind !== "table") return;
		read.loading = true;
		this.#drawBody();
		const signal = AbortSignal.any([read.stop.signal, this.#lifetime.signal]);
		const from = read.etag;
		try {
			const page = await this.#calls().rows({ ...this.#asked(read), after: read.next }, signal);
			if (signal.aborted) return;
			if (read.etag !== from) {
				read.loading = false;
				return;
			}
			read.rows = [
				...read.rows,
				...page.rows.filter(hasValues).map((row) => ({ values: row.values, seen: row.seen })),
			];
			read.next = page.next;
			read.more = page.more;
			read.tooLarge ||= page.tooLarge === true;
			read.pages++;
			read.failed = false;
		} catch {
			if (signal.aborted) return;
			read.failed = true;
		}
		read.loading = false;
		if (this.#list === read) this.#drawBody();
	}

	async #watch(read: ListRead, signal: AbortSignal): Promise<void> {
		let failures = 0;
		while (!signal.aborted) {
			await shown();
			if (signal.aborted) return;
			const watched: CloudMemberDataWatched =
				read.tab.kind === "question"
					? { database: read.database, question: read.tab.name, params: read.params, etag: read.etag ?? "" }
					: { ...this.#asked(read), etag: read.etag ?? "" };
			const call = new AbortController();
			const hidden = () => document.visibilityState === "hidden" && call.abort();
			document.addEventListener("visibilitychange", hidden);
			try {
				const answer = await this.#calls().watchTables([watched], AbortSignal.any([signal, call.signal]));
				failures = 0;
				if ("changed" in answer && !signal.aborted) {
					const changed = answer.changed[0]?.answer;
					if (changed && "key" in changed) await this.#again(read, changed, signal);
					else if (changed) {
						read.columns = changed.columns;
						read.rows = changed.rows.map((values) => ({ values, seen: null }));
						read.more = changed.more;
						read.etag = changed.etag;
					}
					if (!signal.aborted && this.#list === read) {
						this.#drawBody();
						this.#follow(read);
					}
				}
			} catch {
				if (signal.aborted) return;
				if (!call.signal.aborted) {
					await sleep(WATCH_RETRY_MS[Math.min(failures, WATCH_RETRY_MS.length - 1)] ?? 10_000, signal);
					failures++;
				}
			} finally {
				document.removeEventListener("visibilitychange", hidden);
			}
			await sleep(WATCH_GAP_MS, signal);
		}
	}

	async #again(read: ListRead, first: CloudMemberDataPage, signal: AbortSignal): Promise<void> {
		const pages = [first];
		let next = first.next;
		while (pages.length < read.pages && next && !signal.aborted) {
			try {
				const page = await this.#calls().rows({ ...this.#asked(read), after: next }, signal);
				pages.push(page);
				next = page.next;
			} catch {
				break;
			}
		}
		if (!signal.aborted) this.#take(read, pages);
	}

	#follow(read: ListRead): void {
		const open = this.#open;
		if (!open?.row || open.key.length === 0 || open.database !== read.database || open.table !== read.tab.name)
			return;
		const mine = keyOf(open.columns, open.key, open.row.values);
		const now = read.rows.find((row) => keyOf(read.columns, read.key, row.values) === mine);
		if (now && now.seen !== open.row.seen) {
			open.row = now;
			this.#syncRow();
		}
	}

	#choose(tab: Tab): void {
		if (this.#tab?.kind === tab.kind && this.#tab.name === tab.name && !this.#open) return;
		this.#tab = tab;
		this.#close();
		this.#ensureList();
		this.#draw();
	}

	#chooseDatabase(database: string): void {
		if (database === this.#database) return;
		this.#database = database;
		const current = this.#current();
		this.#tab = current ? tabsOf(current)[0] : undefined;
		this.#close();
		this.#ensureList();
		this.#draw();
	}

	#sort(column: string): void {
		if (!this.#database || !this.#tab || this.#tab.kind !== "table") return;
		const place = `${this.#database}/${this.#tab.name}`;
		const now = this.#orders.get(place);
		this.#orders.set(place, { column, desc: now?.column === column ? !now.desc : false });
		this.#ensureList();
		this.#drawBody();
	}

	#draw(): void {
		const focus = this.#focusKey();
		this.#drawTop();
		this.#drawBody();
		this.#refocus(focus);
	}

	#focusKey(): string | undefined {
		const active = document.activeElement;
		return active instanceof HTMLElement && this.el.contains(active) ? active.dataset.focusKey : undefined;
	}

	#refocus(key: string | undefined): void {
		if (key === undefined) return;
		[...this.el.querySelectorAll<HTMLElement>("[data-focus-key]")]
			.find((control) => control.dataset.focusKey === key)
			?.focus({ preventScroll: true });
	}

	#drawTop(): void {
		const described = this.#described;
		const databases = described?.databases ?? [];
		const database = this.#current();
		const question = this.#question();
		this.#params.show(
			this.#open || !this.#database || !question ? undefined : `${this.#database}/${question.name}`,
			this.#asks(),
			this.#given(),
			humanName,
			(name, value) => this.#give(name, value),
		);
		this.#ask.update(this.#place());
		if (this.#open || !database) {
			replace(this.#top);
			this.#top.hidden = true;
			return;
		}
		this.#top.hidden = false;
		const tables = (database.tables ?? []).map((table): Tab => ({ kind: "table", name: table.name }));
		const questions = questionTabs(database);
		const tab = (one: Tab) =>
			h(
				"button",
				{
					type: "button",
					role: "tab",
					class: one.kind === "question" ? "data-tab is-question" : "data-tab",
					"aria-selected": String(this.#tab?.kind === one.kind && this.#tab.name === one.name),
					dataset: { focusKey: `tab:${one.kind}:${one.name}` },
					onclick: () => this.#choose(one),
				},
				humanName(one.name),
			);
		const add =
			this.#writable() && this.#tab?.kind === "table"
				? button(t("New row"), () => this.#startDraft(), { primary: true })
				: null;
		replace(
			this.#top,
			databases.length > 1
				? h(
						"div",
						{ class: "data-databases", role: "group", "aria-label": t("Databases") },
						...databases.map((one) =>
							h(
								"button",
								{
									type: "button",
									class: "data-database",
									"aria-pressed": String(one.database === this.#database),
									onclick: () => this.#chooseDatabase(one.database),
								},
								one.name ?? humanName(one.database),
							),
						),
					)
				: null,
			h(
				"div",
				{ class: "data-head" },
				h(
					"div",
					{ class: "data-tabs", role: "tablist", "aria-label": database.name ?? humanName(database.database) },
					...tables.map(tab),
					tables.length > 0 && questions.length > 0
						? h("span", { class: "data-tabs-rule", "aria-hidden": "true" })
						: null,
					...questions.map(tab),
				),
				add,
			),
		);
		const strip = this.#top.querySelector<HTMLElement>(".data-tabs");
		if (!strip) return;
		const cut = () => {
			strip.classList.toggle("is-cut", strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1);
			strip.classList.toggle("is-cut-start", strip.scrollLeft > 1);
		};
		strip.addEventListener("scroll", cut, { passive: true });
		requestAnimationFrame(() => {
			strip
				.querySelector<HTMLElement>(".data-tab[aria-selected='true']")
				?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
			cut();
		});
	}

	#drawBody(): void {
		if (this.#open) return;
		const focus = this.#focusKey();
		this.#observer?.disconnect();
		const scroller = this.#body.querySelector<HTMLElement>(".data-scroll");
		const keep = scroller?.dataset.list === this.#list?.id ? (scroller?.scrollTop ?? 0) : 0;
		replace(this.#body, this.#bodyContent());
		const next = this.#body.querySelector<HTMLElement>(".data-scroll");
		if (next && keep > 0) next.scrollTop = keep;
		const sentinel = this.#body.querySelector<HTMLElement>(".data-more");
		const read = this.#list;
		if (sentinel && read && typeof IntersectionObserver === "function") {
			this.#observer = new IntersectionObserver(
				(entries) => {
					if (entries.some((entry) => entry.isIntersecting)) void this.#more(read);
				},
				{ root: next, rootMargin: "0px 0px 400px 0px" },
			);
			this.#observer.observe(sentinel);
		}
		this.#refocus(focus);
	}

	#bodyContent(): HTMLElement {
		const described = this.#described;
		if (described === undefined) return this.#skeleton();
		const database = this.#current();
		if (!described || !database)
			return this.#empty(t("No company data yet"), t("When an agent makes a database, its tables show here."));
		if (!database.list && questionTabs(database).length === 0)
			return this.#empty(
				database.name ?? humanName(database.database),
				t("Only those who may change this database see its tables."),
			);
		if (!this.#tab) return this.#empty(t("No tables yet"), t("Its tables show here once an agent makes them."));
		if (!this.#filled())
			return this.#empty(
				this.#question()?.words ?? humanName(this.#tab.name),
				t("Fill in {names} to see the list.", {
					names: new Intl.ListFormat(presentationLocale() === "da" ? "da" : "en", { type: "conjunction" }).format(
						this.#asks()
							.filter((name) => this.#given()[name] === "")
							.map(humanName),
					),
				}),
			);
		const read = this.#list;
		if (!read || (read.loading && read.pages === 0 && read.rows.length === 0 && read.columns.length === 0))
			return this.#skeleton();
		if (read.failed && read.columns.length === 0)
			return h(
				"div",
				{ class: "data-empty", role: "alert" },
				h("h1", null, t("This list can't be read just now")),
				button(t("Try again"), () => {
					this.#list = undefined;
					this.#ensureList();
					this.#drawBody();
				}),
			);
		return h("div", { class: "data-scroll", dataset: { list: read.id } }, this.#listEl(read), this.#foot(read));
	}

	#skeleton(): HTMLElement {
		const line = () => h("span", { class: "skeleton skeleton-line" });
		return h(
			"div",
			{ class: "skeleton-group data-skeleton", role: "status" },
			h("span", { class: "visually-hidden" }, t("Loading the list")),
			...Array.from({ length: 7 }, () => h("div", { class: "data-skeleton-row" }, line(), line(), line())),
		);
	}

	#empty(title: string, words: string): HTMLElement {
		return h("div", { class: "data-empty" }, h("h1", null, title), h("p", null, words));
	}

	#listEl(read: ListRead): HTMLElement {
		const columns = shownColumns(read.columns, read.key);
		const kinds = columns.map(
			(name) =>
				(read.tab.kind === "question"
					? answerKind(read.rows.map((row) => row.values[read.columns.indexOf(name)]))
					: undefined) ?? this.#kindOf(name),
		);
		const template = columns
			.map((_, index) =>
				index === 0
					? "minmax(11em, 1.8fr)"
					: kinds[index] === "number"
						? "minmax(5em, 0.5fr)"
						: kinds[index] === "boolean"
							? "minmax(4em, 0.5fr)"
							: kinds[index] === "date" || kinds[index] === "time"
								? "minmax(7em, 0.8fr)"
								: "minmax(6em, 1fr)",
			)
			.join(" ");
		const sorted = read.tab.kind === "table";
		const head = h(
			"div",
			{ class: "data-row data-row-head" },
			...columns.map((name, index) => {
				const on = read.order === name;
				const label = humanName(name);
				return h(
					"span",
					{ class: `data-cell${kinds[index] === "number" ? " is-number" : ""}` },
					sorted
						? h(
								"button",
								{
									type: "button",
									class: on ? "data-sort is-on" : "data-sort",
									"aria-pressed": String(on),
									dataset: { focusKey: `sort:${name}` },
									onclick: () => this.#sort(name),
								},
								label,
								on
									? h(
											"span",
											{ class: read.desc ? "data-sort-mark is-desc" : "data-sort-mark" },
											icon("chevron-down"),
										)
									: null,
							)
						: label,
				);
			}),
		);
		const opens = read.tab.kind === "table";
		const rows = read.rows.map((row) => {
			const cells = columns.map((name, index) => {
				const value = row.values[read.columns.indexOf(name)];
				const text = shownValue(value, kinds[index] ?? "text");
				return h(
					"span",
					{
						class: `data-cell${index === 0 ? " is-lead" : ""}${kinds[index] === "number" ? " is-number" : ""}`,
					},
					text,
				);
			});
			return opens
				? h(
						"button",
						{
							type: "button",
							class: "data-row",
							dataset: { key: keyOf(read.columns, read.key, row.values) },
							onclick: () => this.#openRow(read, row),
						},
						...cells,
					)
				: h("div", { class: "data-row" }, ...cells);
		});
		const none = read.rows.length === 0 && !read.loading && !read.tooLarge;
		return h(
			"div",
			{ class: "data-list", style: `--data-columns: ${template}` },
			head,
			...rows,
			none ? h("p", { class: "data-none" }, t("No rows yet")) : null,
			read.next && read.tab.kind === "table"
				? h(
						"div",
						{ class: "data-more" },
						read.loading
							? h(
									"span",
									{ class: "skeleton-group data-more-rows", role: "status" },
									h("span", { class: "visually-hidden" }, t("Loading the list")),
									...Array.from({ length: 3 }, () =>
										h(
											"span",
											{ class: "data-skeleton-row" },
											h("span", { class: "skeleton skeleton-line" }),
											h("span", { class: "skeleton skeleton-line" }),
											h("span", { class: "skeleton skeleton-line" }),
										),
									),
								)
							: typeof IntersectionObserver === "function" && !read.failed
								? null
								: button(read.failed ? t("Try again") : t("Show more"), () => void this.#more(read), {
										small: true,
									}),
					)
				: null,
		);
	}

	#foot(read: ListRead): HTMLElement {
		const table = this.#table();
		const described = this.#described;
		const counted =
			table?.rows === undefined
				? undefined
				: Math.max(0, table.rows + (this.#counted.get(`${read.database}/${read.tab.name}`) ?? 0));
		const count =
			counted !== undefined
				? t("{count} rows", { count: new Intl.NumberFormat(presentationLocale()).format(counted) })
				: table?.rowsAbout !== undefined
					? t("About {count} rows", { count: new Intl.NumberFormat(presentationLocale()).format(table.rowsAbout) })
					: read.more
						? t("The first {count} rows", { count: read.rows.length })
						: t("{count} rows", { count: read.rows.length });
		const keyless = table?.kind === "table" && table.key.length === 0;
		const only =
			read.tab.kind === "question"
				? t("A kept question, read only")
				: table?.kind === "view"
					? t("A view, read only")
					: keyless
						? t("No key, read only")
						: this.#current()?.write !== true || this.company.store.get().team?.capabilities.write === false
							? t("Read only for you")
							: null;
		const firstOnly =
			(keyless || table?.kind === "view") && read.more
				? t("The first {count} rows", { count: read.rows.length })
				: null;
		return h(
			"div",
			{ class: "data-foot" },
			h("span", null, firstOnly ?? count),
			only ? h("span", { class: "data-foot-only" }, only) : null,
			read.tooLarge ? h("span", null, t("Some rows are too large to show here")) : null,
			h("span", { class: "data-foot-grow" }),
			described && described.limitBytes > 0
				? h(
						"span",
						null,
						t("{used} of {limit}", {
							used: bytesText(described.companyBytes),
							limit: bytesText(described.limitBytes),
						}),
					)
				: null,
		);
	}

	#openRow(read: ListRead, row: Row): void {
		if (read.tab.kind !== "table") return;
		this.#open = {
			database: read.database,
			table: read.tab.name,
			columns: read.columns,
			key: read.key,
			row,
			draft: new Map(),
			notice: undefined,
			notes: new Map(),
			saved: new Set(),
			saving: new Map(),
			pending: new Map(),
			gone: false,
			queue: Promise.resolve(),
			asking: false,
			askNote: undefined,
		};
		this.#buildRow();
	}

	#startDraft(): void {
		const read = this.#list;
		const table = this.#table();
		if (!read || !table || read.tab.kind !== "table" || !this.#writable()) return;
		this.#open = {
			database: read.database,
			table: read.tab.name,
			columns: table.columns.map((column) => column.name),
			key: table.key,
			row: null,
			draft: new Map(),
			notice: undefined,
			notes: new Map(),
			saved: new Set(),
			saving: new Map(),
			pending: new Map(),
			gone: false,
			queue: Promise.resolve(),
			asking: false,
			askNote: undefined,
		};
		if (!table.columns.some((column) => column.settable)) void this.#add(this.#open);
		this.#buildRow();
	}

	#close(): void {
		if (!this.#open) return;
		this.#open = undefined;
		this.#rowEl = undefined;
		this.#inputs.clear();
		this.#hideBar();
		this.#drawTop();
		this.#drawBody();
	}

	#title(open: OpenRow): string {
		if (!open.row) return t("New row");
		const lead = shownColumns(open.columns, open.key)[0];
		const value = lead === undefined ? null : open.row.values[open.columns.indexOf(lead)];
		const text = lead === undefined ? "" : shownValue(value, this.#kindOf(lead));
		return text || humanName(open.table);
	}

	#editable(open: OpenRow, column: string): boolean {
		return !open.gone && this.#writable() && this.#columnOf(column)?.settable === true;
	}

	#buildRow(): void {
		const open = this.#open;
		if (!open) return;
		this.#inputs.clear();
		this.#drawTop();
		const fields = shownColumns(open.columns, open.key).filter(
			(name) => open.row !== null || this.#columnOf(name)?.settable === true,
		);
		const back = h(
			"button",
			{ type: "button", class: "data-back", onclick: () => this.#close() },
			icon("back"),
			humanName(open.table),
		);
		const list = h(
			"div",
			{ class: "data-fields" },
			...fields.map((name) => {
				const kind = this.#kindOf(name);
				const id = `data-field-${name.replace(/[^A-Za-z0-9_-]/g, "_")}`;
				const label = h("label", { class: "data-field-label", for: id }, humanName(name));
				const control = this.#control(open, name, kind, id);
				return h(
					"div",
					{ class: "data-field", dataset: { column: name } },
					label,
					control,
					h("p", { class: "data-field-note", hidden: true }),
				);
			}),
		);
		const remove =
			open.row && this.#writable()
				? h(
						"button",
						{ type: "button", class: "data-remove", onclick: () => this.#askRemove() },
						icon("trash"),
						t("Remove row"),
					)
				: null;
		this.#rowEl = h(
			"div",
			{ class: "data-scroll data-row-page" },
			h(
				"div",
				{ class: "data-thing" },
				back,
				h("p", { class: "data-notice", hidden: true }),
				h("h1", { class: "data-thing-title" }, this.#title(open)),
				list,
				remove,
			),
		);
		replace(this.#body, this.#rowEl);
		this.#syncRow();
	}

	#control(
		open: OpenRow,
		name: string,
		kind: Kind,
		id: string,
	): HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement | HTMLElement {
		if (!this.#editable(open, name)) {
			const value = open.row ? open.row.values[open.columns.indexOf(name)] : null;
			return h("p", { class: "data-field-value", id }, shownValue(value, kind) || "—");
		}
		if (kind === "boolean") {
			const toggle = h("button", {
				type: "button",
				class: "data-field-toggle",
				id,
				role: "switch",
				onclick: () => {
					const now = this.#valueOf(open, name);
					void this.#commit(open, name, now !== true, kind);
				},
			});
			this.#inputs.set(name, toggle);
			return toggle;
		}
		const multi = kind === "json" || (kind === "text" && editText(this.#valueOf(open, name), kind).length > 60);
		const field = multi
			? h("textarea", { class: "data-field-input", id, rows: "2", spellcheck: "false" })
			: h("input", {
					class: "data-field-input",
					id,
					type: "text",
					...(kind === "number" ? { inputmode: "decimal" } : {}),
					autocomplete: "off",
				});
		field.placeholder = t("Empty");
		if (kind === "date")
			field.addEventListener("focus", () => {
				if (field.dataset.dirty !== "1")
					field.value = open.row ? editText(this.#valueOf(open, name), kind) : (open.draft.get(name) ?? "");
			});
		const commit = () => {
			if (field.dataset.dirty !== "1") return;
			delete field.dataset.dirty;
			const sent = sentValue(field.value, kind);
			if (!sent.ok) {
				open.notes.set(name, sent.note);
				this.#syncRow();
				return;
			}
			void this.#commit(open, name, sent.value, kind);
		};
		field.addEventListener("blur", () => {
			commit();
			if (kind === "date") queueMicrotask(() => this.#syncRow());
		});
		field.addEventListener("input", () => {
			field.dataset.dirty = "1";
			if (!open.row) open.draft.set(name, field.value);
		});
		field.addEventListener("keydown", (pressed) => {
			const event = pressed as KeyboardEvent;
			if (event.key === "Enter" && !(field instanceof HTMLTextAreaElement && event.shiftKey)) {
				event.preventDefault();
				field.blur();
			}
			if (event.key === "Escape") {
				event.preventDefault();
				delete field.dataset.dirty;
				field.value = open.row
					? editText(open.row.values[open.columns.indexOf(name)], kind)
					: (open.draft.get(name) ?? "");
				field.blur();
			}
		});
		field.addEventListener("change", commit);
		this.#inputs.set(name, field);
		return field;
	}

	#valueOf(open: OpenRow, name: string): unknown {
		if (!open.row) {
			const typed = open.draft.get(name);
			if (typed === undefined || typed === "") return null;
			return this.#kindOf(name) === "boolean" ? typed === "true" : typed;
		}
		const pending = open.pending.get(name);
		if (pending) return pending.value;
		return open.row.values[open.columns.indexOf(name)] ?? null;
	}

	#commit(open: OpenRow, name: string, value: unknown, kind: Kind): Promise<void> {
		open.notes.delete(name);
		if (!open.row) {
			open.draft.set(name, kind === "boolean" ? String(value) : editText(value, kind));
			this.#syncRow();
			return this.#queue(open, () => this.#add(open));
		}
		if (JSON.stringify(this.#valueOf(open, name)) === JSON.stringify(value)) {
			this.#syncRow();
			return Promise.resolve();
		}
		if (kind === "boolean") open.pending.set(name, { value, writes: (open.pending.get(name)?.writes ?? 0) + 1 });
		saving(open, name, 1);
		this.#syncRow();
		return this.#queue(open, () => this.#change(open, { [name]: value })).finally(() => {
			const pending = open.pending.get(name);
			if (pending && --pending.writes === 0) open.pending.delete(name);
			saving(open, name, -1);
			if (this.#open === open) this.#syncRow();
		});
	}

	#queue(open: OpenRow, work: () => Promise<void>): Promise<void> {
		const next = open.queue.then(work, work);
		open.queue = next.catch(() => {});
		return next;
	}

	#draftValues(open: OpenRow): Record<string, unknown> {
		const values: Record<string, unknown> = {};
		for (const [name, text] of open.draft) {
			const kind = this.#kindOf(name);
			if (kind === "boolean") {
				if (text === "true" || text === "false") values[name] = text === "true";
				continue;
			}
			const sent = sentValue(text, kind);
			if (sent.ok && sent.value !== null) values[name] = sent.value;
		}
		return values;
	}

	async #add(open: OpenRow): Promise<void> {
		if (open.row || this.#open !== open) return;
		const sent = new Map(open.draft);
		const values = this.#draftValues(open);
		if (Object.keys(values).length === 0 && this.#table()?.columns.some((column) => column.settable)) return;
		try {
			const added = await this.#calls().edit(
				{ database: open.database, table: open.table, op: "add", values },
				this.#lifetime.signal,
			);
			if (!added.row?.values) return;
			open.columns = added.columns;
			open.key = added.key;
			open.row = { values: added.row.values, seen: added.row.seen };
			open.notice = undefined;
			for (const name of Object.keys(values)) open.saved.add(name);
			const typing = this.#typing();
			const focused = document.activeElement;
			if (typing && focused instanceof HTMLElement) delete focused.dataset.dirty;
			const later = new Map(
				[...open.draft].filter(([name, text]) => sent.get(name) !== text && name !== typing?.name),
			);
			open.draft.clear();
			for (const [name, text] of later) open.draft.set(name, text);
			const rest = this.#draftValues(open);
			open.draft.clear();
			this.#list?.rows.unshift(open.row);
			this.#bumpCount(1);
			if (this.#open === open) {
				this.#buildRow();
				this.#retype(typing);
			}
			this.#flashSaved(open);
			const filled = Object.keys(rest);
			if (filled.length === 0) return;
			for (const name of filled) saving(open, name, 1);
			this.#syncRow();
			try {
				await this.#change(open, rest);
			} finally {
				for (const name of filled) saving(open, name, -1);
				if (this.#open === open) this.#syncRow();
			}
		} catch (error) {
			if (this.#lifetime.signal.aborted) return;
			const column = /column "([^"]+)"/.exec((error as Error)?.message ?? "")?.[1];
			const missing =
				(error as { code?: unknown }).code === "23502" && column && this.#inputs.has(column) ? column : undefined;
			open.notes.set(missing ?? [...open.draft.keys()].at(-1) ?? "", refusalWords(error));
			if (this.#open === open) this.#syncRow();
		}
	}

	#typing(): { name: string; value: string; start: number | null; end: number | null } | undefined {
		const active = document.activeElement;
		if (!(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) return undefined;
		if (active.dataset.dirty !== "1") return undefined;
		const name = [...this.#inputs].find(([, input]) => input === active)?.[0];
		return name === undefined
			? undefined
			: { name, value: active.value, start: active.selectionStart, end: active.selectionEnd };
	}

	#retype(typing: { name: string; value: string; start: number | null; end: number | null } | undefined): void {
		if (!typing) return;
		const input = this.#inputs.get(typing.name);
		if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) return;
		input.value = typing.value;
		input.dataset.dirty = "1";
		input.focus({ preventScroll: true });
		if (typing.start !== null) input.setSelectionRange(typing.start, typing.end ?? typing.start);
	}

	async #change(open: OpenRow, values: Record<string, unknown>): Promise<void> {
		const row = open.row;
		const names = Object.keys(values);
		const name = names[0] ?? null;
		if (!row?.seen || open.gone || name === null) return;
		const key = Object.fromEntries(
			open.key.map((column) => [column, row.values[open.columns.indexOf(column)] ?? null]),
		);
		try {
			const changed = await this.#calls().edit(
				{
					database: open.database,
					table: open.table,
					op: "change",
					key,
					seen: row.seen,
					values,
				},
				this.#lifetime.signal,
			);
			if (!changed.row?.values) return;
			const now = { values: changed.row.values, seen: changed.row.seen };
			this.#replaceRow(open, row, now);
			open.row = now;
			open.notice = undefined;
			for (const one of names) if ((open.saving.get(one) ?? 0) <= 1) open.saved.add(one);
			if (this.#open === open) {
				this.#syncRow();
				this.#flashSaved(open);
			}
		} catch (error) {
			if (this.#lifetime.signal.aborted) return;
			this.#refused(open, row, error, name);
		}
	}

	#refused(open: OpenRow, row: Row, error: unknown, name: string | null): void {
		const status = (error as { status?: unknown }).status;
		const now = (error as { row?: CloudMemberDataRow | null }).row;
		if (status === 409 && now === null) {
			open.gone = true;
			open.notice = { text: t("This row was removed just now."), tone: "note" };
			this.#dropRow(open, row);
			if (this.#open === open) this.#buildRow();
			return;
		}
		if (status === 409 && now?.values) {
			const current = { values: now.values, seen: now.seen };
			this.#replaceRow(open, row, current);
			open.row = current;
			open.notice = { text: t("Someone changed this row just now. This is how it is now."), tone: "note" };
			for (const input of this.#inputs.values()) delete input.dataset.dirty;
			if (this.#open === open) this.#syncRow();
			return;
		}
		if (status === 403) void this.#databases.refresh();
		if (name === null) open.askNote = refusalWords(error);
		else open.notes.set(name, refusalWords(error));
		if (this.#open === open) {
			this.#syncRow();
			if (name === null) this.#showBar(open);
		}
	}

	#replaceRow(open: OpenRow, before: Row, after: Row): void {
		const read = this.#list;
		if (!read || read.database !== open.database || read.tab.name !== open.table) return;
		const place = read.rows.indexOf(before);
		const found =
			place >= 0
				? place
				: read.rows.findIndex(
						(row) => keyOf(read.columns, read.key, row.values) === keyOf(open.columns, open.key, before.values),
					);
		if (found >= 0) read.rows[found] = after;
	}

	#dropRow(open: OpenRow, row: Row): void {
		const read = this.#list;
		if (!read || read.database !== open.database || read.tab.name !== open.table) return;
		const mine = keyOf(open.columns, open.key, row.values);
		const before = read.rows.length;
		read.rows = read.rows.filter((one) => keyOf(read.columns, read.key, one.values) !== mine);
		if (read.rows.length < before) this.#bumpCount(-1);
	}

	#bumpCount(by: number): void {
		const place = `${this.#database}/${this.#tab?.name}`;
		this.#counted.set(place, (this.#counted.get(place) ?? 0) + by);
	}

	#flashSaved(open: OpenRow): void {
		const names = [...open.saved];
		setTimeout(() => {
			for (const name of names) open.saved.delete(name);
			if (this.#open === open) this.#syncRow();
		}, SAVED_MS);
	}

	#syncRow(): void {
		const open = this.#open;
		const page = this.#rowEl;
		if (!open || !page) return;
		const title = page.querySelector(".data-thing-title");
		if (title) title.textContent = this.#title(open);
		const notice = page.querySelector<HTMLElement>(".data-notice");
		if (notice) {
			notice.hidden = !open.notice;
			notice.textContent = open.notice?.text ?? "";
			notice.className = `data-notice${open.notice?.tone === "danger" ? " is-danger" : ""}`;
			notice.setAttribute("role", open.notice ? "status" : "presentation");
		}
		for (const field of page.querySelectorAll<HTMLElement>(".data-field")) {
			const name = field.dataset.column ?? "";
			const kind = this.#kindOf(name);
			const value = this.#valueOf(open, name);
			const input = this.#inputs.get(name);
			if (input instanceof HTMLButtonElement) {
				input.setAttribute("aria-checked", String(value === true));
				input.textContent = value === null ? t("Empty") : value === true ? t("Yes") : t("No");
				input.classList.toggle("is-on", value === true);
				input.classList.toggle("is-empty", value === null);
			} else if (input && document.activeElement !== input && input.dataset.dirty !== "1") {
				const typed = open.row ? editText(value, kind) : (open.draft.get(name) ?? "");
				const text = kind === "date" ? shownValue(typed === "" ? null : typed, "date") : typed;
				if (input.value !== text) input.value = text;
			} else if (!input) {
				const shownText = field.querySelector(".data-field-value");
				if (shownText) shownText.textContent = shownValue(value, kind) || "—";
			}
			field.classList.toggle("is-saved", open.saved.has(name));
			field.classList.toggle("is-saving", open.saving.has(name));
			const note = field.querySelector<HTMLElement>(".data-field-note");
			if (note) {
				const said = open.notes.get(name);
				note.hidden = said === undefined;
				note.textContent = said ?? "";
				note.setAttribute("role", said === undefined ? "presentation" : "alert");
			}
		}
		const unplaced = open.notes.get("");
		if (unplaced !== undefined && notice) {
			notice.hidden = false;
			notice.textContent = unplaced;
			notice.className = "data-notice is-danger";
		}
	}

	#askRemove(): void {
		const open = this.#open;
		if (!open?.row || open.gone) return;
		open.asking = true;
		open.askNote = undefined;
		this.#showBar(open);
	}

	#showBar(open: OpenRow): void {
		const later = h(
			"button",
			{ type: "button", class: "app-ask-button", onclick: () => this.#notNow() },
			t("Not now"),
		);
		const yes = h(
			"button",
			{
				type: "button",
				class: "app-ask-button is-yes is-awake",
				onclick: () => void this.#remove(open, yes, later),
			},
			t("Remove"),
		);
		const titleId = "data-ask-title";
		this.#bar.setAttribute("aria-labelledby", titleId);
		replace(
			this.#bar,
			h("span", { class: "app-ask-figure" }, interfaceEmblem("drawers", 26)),
			h(
				"div",
				{ class: "app-ask-copy" },
				h("strong", { class: "app-ask-title", id: titleId }, t("Remove {name}?", { name: this.#title(open) })),
				h(
					"p",
					{
						class: open.askNote ? "app-ask-note is-failed" : "app-ask-held",
						role: open.askNote ? "alert" : "presentation",
					},
					open.askNote ?? t("It goes for good."),
				),
			),
			h("div", { class: "app-ask-buttons" }, later, yes),
		);
		this.#bar.hidden = false;
		later.focus({ preventScroll: true });
	}

	#hideBar(): void {
		this.#bar.hidden = true;
		replace(this.#bar);
	}

	#notNow(): void {
		const open = this.#open;
		if (open) {
			open.asking = false;
			open.askNote = undefined;
		}
		this.#hideBar();
	}

	async #remove(open: OpenRow, yes: HTMLButtonElement, later: HTMLButtonElement): Promise<void> {
		const row = open.row;
		if (!row?.seen || yes.disabled) return;
		yes.disabled = true;
		later.disabled = true;
		const key = Object.fromEntries(
			open.key.map((column) => [column, row.values[open.columns.indexOf(column)] ?? null]),
		);
		try {
			await this.#queue(open, async () => {
				await this.#calls().edit(
					{
						database: open.database,
						table: open.table,
						op: "remove",
						key,
						seen: open.row?.seen ?? row.seen ?? "",
					},
					this.#lifetime.signal,
				);
			});
			this.#dropRow(open, row);
			if (this.#open === open) this.#close();
		} catch (error) {
			if (this.#lifetime.signal.aborted) return;
			open.asking = false;
			const status = (error as { status?: unknown }).status;
			if (status === 409) {
				this.#hideBar();
				this.#refused(open, row, error, null);
				return;
			}
			open.asking = true;
			this.#refused(open, row, error, null);
		}
	}
}

function saving(open: OpenRow, name: string, by: number): void {
	const now = (open.saving.get(name) ?? 0) + by;
	if (now > 0) open.saving.set(name, now);
	else open.saving.delete(name);
}

function answerKind(values: readonly unknown[]): Kind | undefined {
	const given = values.filter((value) => value !== null && value !== undefined);
	if (given.length === 0) return undefined;
	if (given.every((value) => typeof value === "number")) return "number";
	if (given.every((value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value))) return "date";
	return undefined;
}

function hasValues(row: CloudMemberDataRow): row is CloudMemberDataRow & { values: readonly unknown[] } {
	return row.values !== null;
}

const views = new WeakMap<HTMLElement, DataListView>();

export function renderData(
	container: HTMLElement,
	company: CompanyController,
	databases: CompanyDatabases,
	send?: DataAskSend,
): void {
	let view = views.get(container);
	if (!view || view.el.parentElement !== container || view.company !== company || view.databases !== databases) {
		view?.dispose();
		view = new DataListView(company, databases, send);
		views.set(container, view);
		replace(container, view.el);
	}
	view.update(company.store.get().companyData);
}
