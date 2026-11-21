import { composeStudioPreview } from "@qorpera/cloud-client/surface-studio-patches";
import type { StudioPatchChange, StudioPatchOp, SurfacePreviewConflict, SurfaceSummary } from "@qorpera/contracts";
import { openContextMenu } from "../../ui/context-menu.ts";
import { h, icon } from "../../ui/dom.ts";
import { interfaceEmblem } from "../../ui/interface-emblem.ts";
import { markdown } from "../../ui/markdown.ts";
import { t } from "../../ui/preferences.ts";
import { formatConflictPaths, isOpenChange, productBuildSurfaces, type SurfacesStore } from "../surfaces-store.ts";
import { surfaceEmblem } from "./surface-rail.ts";

export interface SurfaceStudioOptions {
	readonly store: SurfacesStore;
	readonly surface: SurfaceSummary;
	readonly signal: AbortSignal;
	readonly baseFiles?: Readonly<Record<string, string>>;
	readonly patches?: Readonly<Record<string, readonly StudioPatchOp[]>>;
	readonly loadFiles?: (surface: SurfaceSummary, signal: AbortSignal) => Promise<Readonly<Record<string, string>>>;
	readonly onHandoff?: (targetSurfaceSlug: string) => void;
}

interface ColorToken {
	readonly key: string;
	readonly label: string;
	readonly value: string;
	readonly changed: boolean;
}

interface TypeToken {
	readonly key: string;
	readonly label: string;
	readonly value: string;
	readonly changed: boolean;
}

interface SpecTable {
	readonly title: string;
	readonly columns: readonly string[];
	readonly rows: readonly Record<string, string>[];
}

interface SpecSection {
	readonly path: string;
	readonly title: string;
	readonly changed: boolean;
	readonly entries: readonly { readonly key: string; readonly value: string; readonly changed: boolean }[];
	readonly tables: readonly SpecTable[];
}

interface StudioDoc {
	readonly path: string;
	readonly title: string;
	readonly content: string;
	readonly isMarkdown: boolean;
	readonly changed: boolean;
}

const COLOR_VALUE = /^(?:#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgb|hsl)a?\([^)]+\)|oklch\([^)]+\))$/i;
const COLOR_GROUPS = new Set(["colors", "color", "palette", "swatches", "colorways"]);
const TYPE_GROUPS = new Set(["font", "fonts", "typography", "type", "typeface"]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseJsonObject(text: string | undefined): Record<string, unknown> | undefined {
	if (!text) return undefined;
	try {
		const parsed: unknown = JSON.parse(text);
		return isPlainRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function readableName(raw: string): string {
	const base =
		raw
			.split("/")
			.at(-1)
			?.replace(/\.[a-z0-9]+$/i, "") ?? raw;
	const spaced = base
		.replace(/[-_]+/g, " ")
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.trim();
	if (!spaced) return raw;
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function formatScalar(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (value === null || value === undefined) return "–";
	if (Array.isArray(value)) return value.map(formatScalar).join(", ");
	return JSON.stringify(value);
}

function lookupPath(root: Record<string, unknown> | undefined, segments: readonly string[]): unknown {
	let current: unknown = root;
	for (const segment of segments) {
		if (!isPlainRecord(current)) return undefined;
		current = current[segment];
	}
	return current;
}

function collectColors(
	value: unknown,
	baseRoot: Record<string, unknown> | undefined,
	segments: readonly string[],
	out: ColorToken[],
): void {
	if (typeof value === "string" && COLOR_VALUE.test(value.trim())) {
		const prev = lookupPath(baseRoot, segments);
		const label = segments.slice(-1)[0] ?? "";
		out.push({
			key: segments.join("."),
			label: readableName(label),
			value: value.trim(),
			changed: prev !== value,
		});
		return;
	}
	if (Array.isArray(value)) {
		const prevList = lookupPath(baseRoot, segments);
		for (let index = 0; index < value.length; index++) {
			const item = value[index];
			if (!isPlainRecord(item)) continue;
			const color = [item.hex, item.color, item.value].find(
				(candidate): candidate is string => typeof candidate === "string" && COLOR_VALUE.test(candidate.trim()),
			);
			if (!color) continue;
			const name =
				typeof item.name === "string" ? item.name : typeof item.label === "string" ? item.label : `#${index + 1}`;
			const prevItem = Array.isArray(prevList) ? prevList[index] : undefined;
			const prevColor = isPlainRecord(prevItem) ? (prevItem.hex ?? prevItem.color ?? prevItem.value) : undefined;
			out.push({
				key: `${segments.join(".")}[${index}]`,
				label: name,
				value: color.trim(),
				changed: prevColor !== color,
			});
		}
		return;
	}
	if (!isPlainRecord(value)) return;
	for (const [key, child] of Object.entries(value)) collectColors(child, baseRoot, [...segments, key], out);
}

function collectTypography(
	value: unknown,
	baseRoot: Record<string, unknown> | undefined,
	segments: readonly string[],
	out: TypeToken[],
): void {
	if (typeof value === "string" && value.trim()) {
		const prev = lookupPath(baseRoot, segments);
		out.push({
			key: segments.join("."),
			label: readableName(segments.at(-1) ?? ""),
			value: value.trim(),
			changed: prev !== value,
		});
		return;
	}
	if (!isPlainRecord(value)) return;
	for (const [key, child] of Object.entries(value)) collectTypography(child, baseRoot, [...segments, key], out);
}

function collectSpecs(
	obj: Record<string, unknown>,
	baseObj: Record<string, unknown> | undefined,
	prefix: readonly string[],
	entries: { readonly key: string; readonly value: string; readonly changed: boolean }[],
	tables: SpecTable[],
): void {
	for (const [key, value] of Object.entries(obj)) {
		const segments = [...prefix, key];
		if (prefix.length === 0 && (COLOR_GROUPS.has(key.toLowerCase()) || TYPE_GROUPS.has(key.toLowerCase()))) continue;
		if (typeof value === "string" && COLOR_VALUE.test(value.trim())) continue;
		if (Array.isArray(value) && value.length > 0 && value.every(isPlainRecord)) {
			const columns: string[] = [];
			for (const row of value) for (const col of Object.keys(row)) if (!columns.includes(col)) columns.push(col);
			tables.push({
				title: readableName(key),
				columns,
				rows: value.map((row) =>
					Object.fromEntries(columns.map((col) => [col, formatScalar((row as Record<string, unknown>)[col])])),
				),
			});
			continue;
		}
		if (isPlainRecord(value)) {
			collectSpecs(value, baseObj, segments, entries, tables);
			continue;
		}
		const prev = lookupPath(baseObj, segments);
		entries.push({
			key: segments.map(readableName).join(" · "),
			value: formatScalar(value),
			changed: JSON.stringify(prev) !== JSON.stringify(value),
		});
	}
}

function docPriority(path: string): number {
	const lower = path.toLowerCase();
	if (lower.includes("voice") || lower.includes("brief") || lower.includes("readme")) return 0;
	if (lower.includes("spec") || lower.includes("guide")) return 1;
	return 2;
}

export class SurfaceStudioView {
	readonly el = h("div", { class: "surface-studio" });
	readonly #options: SurfaceStudioOptions;
	readonly #lifetime = new AbortController();
	#baseFiles: Readonly<Record<string, string>>;
	#loading = false;
	#lastConflict: SurfacePreviewConflict | null = null;
	#shown = "";

	constructor(options: SurfaceStudioOptions) {
		this.#options = options;
		this.#baseFiles = options.baseFiles ? { ...options.baseFiles } : {};
		options.signal.addEventListener("abort", () => this.dispose(), { once: true });
		this.el.addEventListener("click", (event) => this.#click(event), { signal: this.#lifetime.signal });
		if (options.loadFiles && !options.baseFiles) void this.#load();
		this.update();
	}

	dispose(): void {
		this.#lifetime.abort();
	}

	async #load(): Promise<void> {
		const loadFiles = this.#options.loadFiles;
		if (!loadFiles) return;
		this.#loading = true;
		this.update();
		try {
			const loaded = await loadFiles(this.#options.surface, this.#lifetime.signal);
			if (this.#lifetime.signal.aborted) return;
			this.#baseFiles = { ...loaded };
		} catch {
			/* WHY: An empty or unreadable studio folder renders the calm starter baseline instead of blocking the surface. */
		} finally {
			if (!this.#lifetime.signal.aborted) {
				this.#loading = false;
				this.update();
			}
		}
	}

	#orderedChanges(): StudioPatchChange[] {
		const store = this.#options.store;
		const state = store.state;
		if (state.mode === "live") return [];
		const workspace = store.workspace(this.#options.surface.id);
		const ordered: StudioPatchChange[] = [];
		for (const session of workspace?.activeSessions ?? []) {
			for (const change of session.changes) {
				if (change.kind !== "folder_patch" || !isOpenChange(change) || !store.isChangeShown(change.id)) continue;
				const ops = this.#options.patches?.[change.id] ?? state.studioPatches[change.id];
				if (ops?.length) ordered.push({ changeId: change.id, ops });
			}
		}
		return ordered;
	}

	#effectiveBaseFiles(surfaceId: string): Readonly<Record<string, string>> {
		const localBase = this.#options.store.state.localStudioBase[surfaceId];
		if (!localBase) return this.#baseFiles;
		return Object.keys(this.#baseFiles).length > 0 ? { ...this.#baseFiles, ...localBase } : localBase;
	}

	update(): void {
		const store = this.#options.store;
		const state = store.state;
		const surface = state.surfaces.find((item) => item.id === this.#options.surface.id) ?? this.#options.surface;
		const baseFiles = this.#effectiveBaseFiles(surface.id);
		const workspace = store.workspace(surface.id);
		const ordered = this.#orderedChanges();
		const targets = productBuildSurfaces(state, surface.id);
		const busyReconcile = Boolean(state.busy[`reconcile:${surface.id}`]);
		const busyHandoff = targets.some((target) => Boolean(state.busy[`handoff:${surface.id}:${target.slug}`]));
		const key = JSON.stringify([
			this.#loading,
			baseFiles,
			ordered,
			surface.title,
			surface.folderRoot,
			workspace?.briefSummary,
			targets.map((target) => [target.slug, target.title]),
			busyReconcile,
			busyHandoff,
		]);
		if (key === this.#shown) return;
		this.#shown = key;

		const composition = composeStudioPreview(baseFiles, ordered);
		this.#lastConflict = composition.status === "conflicted" ? composition.conflictReport : null;
		const files = composition.files;
		const filePaths = Object.keys(files).sort();

		const colors: ColorToken[] = [];
		const typography: TypeToken[] = [];
		const specs: SpecSection[] = [];
		const docs: StudioDoc[] = [];

		for (const path of filePaths) {
			const content = files[path] ?? "";
			const baseContent = baseFiles[path];
			const changed = baseContent !== content;
			if (path.toLowerCase().endsWith(".json")) {
				const parsed = parseJsonObject(content);
				if (parsed) {
					const baseParsed = parseJsonObject(baseContent);
					for (const [k, v] of Object.entries(parsed)) {
						const lower = k.toLowerCase();
						if (COLOR_GROUPS.has(lower)) collectColors(v, baseParsed, [k], colors);
						else if (TYPE_GROUPS.has(lower)) collectTypography(v, baseParsed, [k], typography);
						else if (typeof v === "string" && COLOR_VALUE.test(v.trim()))
							collectColors(v, baseParsed, [k], colors);
					}
					const entries: { readonly key: string; readonly value: string; readonly changed: boolean }[] = [];
					const tables: SpecTable[] = [];
					collectSpecs(parsed, baseParsed, [], entries, tables);
					if (entries.length || tables.length)
						specs.push({ path, title: readableName(path), changed, entries, tables });
					continue;
				}
			}
			docs.push({
				path,
				title: readableName(path),
				content,
				isMarkdown: /\.(?:md|markdown)$/i.test(path),
				changed,
			});
		}
		docs.sort((a, b) => docPriority(a.path) - docPriority(b.path) || a.path.localeCompare(b.path));

		const badgeText =
			composition.status === "conflicted"
				? t("Conflict")
				: composition.appliedChangeIds.length === 1
					? t("1 live change applied")
					: composition.appliedChangeIds.length > 1
						? t("{count} live changes applied", { count: composition.appliedChangeIds.length })
						: t("Base");
		const badgeClass =
			composition.status === "conflicted"
				? "studio-badge is-conflict"
				: composition.appliedChangeIds.length > 0
					? "studio-badge is-live"
					: "studio-badge";

		const children: HTMLElement[] = [
			h(
				"div",
				{ class: "studio-head" },
				h(
					"div",
					{ class: "studio-head-meta" },
					surface.folderRoot ? h("span", { class: "studio-path" }, surface.folderRoot) : null,
					h("span", { class: badgeClass }, badgeText),
				),
				targets.length > 0 && this.#options.onHandoff
					? h(
							"button",
							{
								type: "button",
								class: "btn btn-small studio-sync-btn",
								"data-act": "studio-sync",
								disabled: busyHandoff,
							},
							icon("forward"),
							targets.length === 1 ? t("Sync to {target}", { target: targets[0]!.title }) : t("Sync to…"),
						)
					: null,
			),
		];

		if (composition.status === "conflicted") {
			const paths = formatConflictPaths(composition.conflictReport.paths);
			children.push(
				h(
					"div",
					{ class: "studio-conflict", role: "alert" },
					h("span", { class: "surface-state is-conflicted", "aria-hidden": "true" }),
					h(
						"span",
						{ title: composition.conflictReport.paths.join(", ") },
						t("Studio changes conflict in {paths}", { paths }),
					),
					h(
						"button",
						{
							type: "button",
							class: "btn btn-primary btn-small",
							"data-act": "studio-reconcile",
							disabled: busyReconcile || composition.conflictReport.changeIds.length === 0,
						},
						t("Reconcile"),
					),
				),
			);
		}

		if (filePaths.length === 0) {
			children.push(
				h(
					"div",
					{ class: "studio-empty" },
					this.#loading
						? [h("span", { class: "surface-state is-running" }), h("p", null, t("Opening studio…"))]
						: [
								interfaceEmblem(surfaceEmblem(surface), 42),
								h("h2", null, surface.title),
								workspace?.briefSummary ? h("p", { class: "studio-brief" }, workspace.briefSummary) : null,
								h(
									"p",
									null,
									t("No studio files yet. Describe a change below to create tokens, specs, or guidelines."),
								),
							],
				),
			);
			this.el.replaceChildren(...children);
			return;
		}

		const sections: HTMLElement[] = [];
		if (colors.length) {
			sections.push(
				h(
					"section",
					{ class: "studio-section" },
					h("div", { class: "studio-section-head" }, h("h2", null, t("Palette"))),
					h(
						"div",
						{ class: "studio-swatches" },
						colors.map((swatch) => {
							const chip = h("span", { class: "studio-swatch-chip", "aria-hidden": "true" });
							chip.style.backgroundColor = swatch.value;
							return h(
								"div",
								{
									class: `studio-swatch${swatch.changed ? " is-changed" : ""}`,
									"data-token": swatch.key,
								},
								chip,
								h(
									"div",
									{ class: "studio-swatch-meta" },
									h("strong", null, swatch.label),
									h("code", null, swatch.value),
								),
							);
						}),
					),
				),
			);
		}

		if (typography.length) {
			sections.push(
				h(
					"section",
					{ class: "studio-section" },
					h("div", { class: "studio-section-head" }, h("h2", null, t("Typography"))),
					h(
						"div",
						{ class: "studio-type-list" },
						typography.map((item) => {
							const sample = h("p", { class: "studio-type-sample" }, t("Aa Bb Cc · 123"));
							sample.style.fontFamily = item.value;
							return h(
								"div",
								{ class: `studio-type-row${item.changed ? " is-changed" : ""}`, "data-token": item.key },
								h(
									"div",
									{ class: "studio-type-meta" },
									h("strong", null, item.label),
									h("code", null, item.value),
								),
								sample,
							);
						}),
					),
				),
			);
		}

		for (const spec of specs) {
			sections.push(
				h(
					"section",
					{ class: `studio-section${spec.changed ? " is-changed" : ""}`, "data-file": spec.path },
					h(
						"div",
						{ class: "studio-section-head" },
						h("h2", null, spec.title),
						h("code", { class: "studio-file-tag" }, spec.path),
						spec.changed ? h("span", { class: "studio-changed-pill" }, t("Updated")) : null,
					),
					spec.entries.length
						? h(
								"dl",
								{ class: "studio-kv" },
								spec.entries.flatMap((entry) => [
									h("dt", { class: entry.changed ? "is-changed" : "" }, entry.key),
									h("dd", { class: entry.changed ? "is-changed" : "" }, entry.value),
								]),
							)
						: null,
					...spec.tables.map((table) =>
						h(
							"div",
							{ class: "studio-table-wrap" },
							h("h3", { class: "studio-subhead" }, table.title),
							h(
								"table",
								{ class: "studio-table" },
								h(
									"thead",
									null,
									h(
										"tr",
										null,
										table.columns.map((col) => h("th", null, readableName(col))),
									),
								),
								h(
									"tbody",
									null,
									table.rows.map((row) =>
										h(
											"tr",
											null,
											table.columns.map((col) => h("td", null, row[col] ?? "–")),
										),
									),
								),
							),
						),
					),
				),
			);
		}

		for (const doc of docs) {
			sections.push(
				h(
					"section",
					{ class: `studio-section studio-doc${doc.changed ? " is-changed" : ""}`, "data-file": doc.path },
					h(
						"div",
						{ class: "studio-section-head" },
						h("h2", null, doc.title),
						h("code", { class: "studio-file-tag" }, doc.path),
						doc.changed ? h("span", { class: "studio-changed-pill" }, t("Updated")) : null,
					),
					doc.isMarkdown
						? h("div", { class: "studio-doc-body" }, markdown(doc.content))
						: h("pre", { class: "studio-code" }, doc.content),
				),
			);
		}

		children.push(h("div", { class: "studio-grid" }, sections));
		this.el.replaceChildren(...children);
	}

	#click(event: MouseEvent): void {
		const target = (event.target as Element).closest<HTMLElement>("[data-act]");
		if (!target || !this.el.contains(target)) return;
		const { act } = target.dataset;
		if (act === "studio-reconcile") {
			const ids = this.#lastConflict?.changeIds ?? [];
			if (ids.length) void this.#options.store.reconcileChanges(this.#options.surface.id, ids);
			return;
		}
		if (act === "studio-sync" && this.#options.onHandoff) {
			const targets = productBuildSurfaces(this.#options.store.state, this.#options.surface.id);
			if (targets.length === 1) {
				this.#options.onHandoff(targets[0]!.slug);
				return;
			}
			if (targets.length > 1) {
				const box = target.getBoundingClientRect();
				openContextMenu({
					label: t("Sync to…"),
					x: box.left,
					y: box.bottom + 4,
					opener: target,
					items: targets.map((surface) => ({
						label: surface.title,
						select: () => this.#options.onHandoff?.(surface.slug),
					})),
				});
			}
		}
	}
}
