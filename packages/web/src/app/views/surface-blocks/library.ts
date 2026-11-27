import type { SurfaceLibraryBlock } from "@qorpera/contracts";
import { h } from "../../../ui/dom.ts";
import { t } from "../../../ui/preferences.ts";
import type { SurfacesStore } from "../../surfaces-store.ts";
import { SVG_FILE_RE, svgDataUrl } from "./artifacts.ts";
import { type SurfacePictures, svgText } from "./brand-mark.ts";
import { homeEmpty, type SurfaceBlockContext, type SurfaceBlockPrepared } from "./context.ts";
import { buildLibraryModel, type LibraryModel, type LibraryPost, type LibraryTheme } from "./library-model.ts";
import { buildPostPage, postDay, postPageClick, sourcesLabel } from "./post-page.ts";

const REPORT_FILE_RE = /\.report\.json$/i;

type LibraryPlace =
	| { readonly page: "front" }
	| { readonly page: "theme"; readonly key: string }
	| { readonly page: "post"; readonly path: string };

interface LibraryShown {
	readonly model: LibraryModel;
	readonly ctx: SurfaceBlockContext;
	readonly kicker: string;
	readonly signature: readonly (string | undefined)[];
}

export interface SurfaceLibrariesOptions {
	readonly store: SurfacesStore;
	readonly pictures: SurfacePictures;
	readonly signal: AbortSignal;
}

function postsLabel(count: number): string {
	return count === 1 ? t("1 post") : t("{count} posts", { count });
}

class LibraryView {
	readonly el = h("section", { class: "lib", "data-block": "library" });
	readonly #options: SurfaceLibrariesOptions;
	#shown: LibraryShown | undefined;
	#place: LibraryPlace = { page: "front" };
	#featured = 0;
	#storeSlug: string | undefined;
	#page: AbortController | null = null;

	constructor(options: SurfaceLibrariesOptions) {
		this.#options = options;
		this.el.addEventListener("click", (event) => this.#click(event), { signal: options.signal });
	}

	show(shown: LibraryShown, wanted: string | undefined): boolean {
		const before = this.#shown;
		this.#shown = shown;
		const { posts } = shown.model;
		const place = this.#place;
		const slug = this.#options.store.state.activeReportSlug;
		const asked = wanted === undefined ? undefined : posts.find((item) => item.path === wanted);
		let moved = false;
		if (asked) {
			this.#storeSlug = asked.doc.slug;
			this.#place = { page: "post", path: asked.path };
			moved = true;
		} else if (slug !== this.#storeSlug) {
			this.#storeSlug = slug;
			const open = place.page === "post" ? posts.find((item) => item.path === place.path) : undefined;
			const post = slug && open?.doc.slug !== slug ? posts.find((item) => item.doc.slug === slug) : undefined;
			if (post) {
				this.#place = { page: "post", path: post.path };
				moved = true;
			}
		}
		const same =
			before !== undefined &&
			before.kicker === shown.kicker &&
			before.signature.length === shown.signature.length &&
			before.signature.every((part, index) => part === shown.signature[index]);
		if (!same || moved || this.el.childElementCount === 0) this.#render();
		return asked !== undefined;
	}

	open(path: string): boolean {
		const post = this.#shown?.model.posts.find((item) => item.path === path);
		if (!post) return false;
		this.#place = { page: "post", path };
		this.#storeSlug = post.doc.slug;
		this.#render();
		return true;
	}

	deactivate(): void {
		this.#page?.abort();
		this.#page = null;
		this.el.replaceChildren();
	}

	#go(place: LibraryPlace): void {
		const shown = this.#shown;
		if (!shown) return;
		this.#place = place;
		const slug =
			place.page === "post" ? shown.model.posts.find((item) => item.path === place.path)?.doc.slug : undefined;
		this.#storeSlug = slug;
		this.#options.store.selectReport(slug);
		this.#render();
		const top = this.el.getBoundingClientRect().top;
		if (top < 0 || top > window.innerHeight * 0.5) this.el.scrollIntoView?.({ block: "start", behavior: "smooth" });
	}

	#click(event: MouseEvent): void {
		const target = (event.target as Element).closest<HTMLElement>("[data-act]");
		if (!target || !this.el.contains(target)) return;
		if (postPageClick(target, this.el)) return;
		const { act } = target.dataset;
		if (act === "library-front") this.#go({ page: "front" });
		else if (act === "library-theme" && target.dataset.theme) this.#go({ page: "theme", key: target.dataset.theme });
		else if (act === "library-post" && target.dataset.path) this.#go({ page: "post", path: target.dataset.path });
		else if (act === "library-featured") {
			const count = this.#shown?.model.featured.length ?? 0;
			if (count === 0) return;
			this.#featured = (this.#featured + Number(target.dataset.step) + count) % count;
			this.#render();
		}
	}

	#render(): void {
		const shown = this.#shown;
		if (!shown) return;
		this.#page?.abort();
		this.#page = null;
		const { model } = shown;
		const place = this.#place;
		const theme = place.page === "theme" ? model.themes.find((item) => item.key === place.key) : undefined;
		const post = place.page === "post" ? model.posts.find((item) => item.path === place.path) : undefined;
		if (post) {
			this.el.dataset.at = "post";
			this.el.replaceChildren(this.#postPage(shown, post));
			return;
		}
		if (theme) {
			this.el.dataset.at = "theme";
			this.el.replaceChildren(...this.#themePage(shown, theme));
			return;
		}
		this.#place = { page: "front" };
		this.el.dataset.at = "front";
		this.el.replaceChildren(...this.#front(shown));
	}

	#cover(shown: LibraryShown, post: LibraryPost): HTMLElement {
		const cover = post.cover;
		if (cover) {
			const svg = SVG_FILE_RE.test(cover.path) ? svgText(shown.ctx.text(cover.path).value) : undefined;
			if (svg) return h("img", { src: svgDataUrl(svg), alt: cover.alt });
			const binary = shown.ctx.binary(cover.path).value;
			if (binary) return this.#options.pictures.binaryImage(binary, cover.alt, "");
		}
		return h("span", { class: "lib-cover-none", "aria-hidden": "true" }, post.number);
	}

	#card(shown: LibraryShown, post: LibraryPost): HTMLElement {
		const where = post.themeName ?? post.doc.category;
		const meta = [post.doc.date ? postDay(post.doc.date) : "", where].filter(Boolean).join(" · ");
		const rests = [post.sourceCount > 0 ? sourcesLabel(post.sourceCount) : "", post.basis ?? ""]
			.filter(Boolean)
			.join(" · ");
		return h(
			"button",
			{ type: "button", class: "lib-card", "data-act": "library-post", "data-path": post.path },
			h(
				"span",
				{ class: "lib-card-meta" },
				h("i", null, post.number),
				meta,
				post.doc.changed ? h("span", { class: "studio-changed-pill" }, t("Updated")) : null,
			),
			h("span", { class: "lib-card-art" }, this.#cover(shown, post)),
			h("span", { class: "lib-card-title" }, post.doc.headline),
			rests ? h("span", { class: "lib-card-src" }, rests) : null,
		);
	}

	#grid(shown: LibraryShown, posts: readonly LibraryPost[]): HTMLElement[] {
		return [
			h(
				"div",
				{ class: "lib-gridhead" },
				h("b", null, postsLabel(posts.length)),
				h("span", null, t("Newest first")),
			),
			h(
				"div",
				{ class: "lib-grid" },
				posts.map((post) => this.#card(shown, post)),
			),
		];
	}

	#themeIcon(shown: LibraryShown, theme: LibraryTheme): HTMLElement | null {
		const svg = theme.icon ? svgText(shown.ctx.text(theme.icon).value) : undefined;
		if (!svg) return null;
		const icon = h("span", { class: "lib-theme-icon", "aria-hidden": "true" });
		icon.style.setProperty("--lib-icon", `url("${svgDataUrl(svg)}")`);
		return icon;
	}

	#band(shown: LibraryShown): HTMLElement | null {
		const featured = shown.model.featured;
		if (featured.length === 0) return null;
		if (this.#featured >= featured.length) this.#featured = 0;
		const post = featured[this.#featured] as LibraryPost;
		const two = (n: number) => String(n).padStart(2, "0");
		return h(
			"div",
			{ class: "lib-feat" },
			h(
				"div",
				{ class: "lib-feat-text" },
				h(
					"div",
					{ class: "lib-feat-meta" },
					post.themeName ? h("span", null, post.themeName) : null,
					post.doc.date ? h("span", null, postDay(post.doc.date)) : null,
				),
				h("h3", null, post.doc.headline),
				post.doc.subtitle ? h("p", null, post.doc.subtitle) : null,
				h(
					"button",
					{ type: "button", class: "lib-feat-open", "data-act": "library-post", "data-path": post.path },
					t("Read the post"),
				),
				featured.length > 1
					? h(
							"div",
							{ class: "lib-feat-nav" },
							h(
								"button",
								{
									type: "button",
									"data-act": "library-featured",
									"data-step": "-1",
									"aria-label": t("Previous"),
								},
								"←",
							),
							h("span", null, `${two(this.#featured + 1)} / ${two(featured.length)}`),
							h(
								"button",
								{ type: "button", "data-act": "library-featured", "data-step": "1", "aria-label": t("Next") },
								"→",
							),
						)
					: null,
			),
			h("div", { class: "lib-feat-art" }, this.#cover(shown, post)),
		);
	}

	#front(shown: LibraryShown): HTMLElement[] {
		const { model } = shown;
		if (model.posts.length === 0 && model.themes.length === 0) {
			return [h("div", { class: "lib-kicker" }, shown.kicker), homeEmpty(t("Research posts live here."))];
		}
		const answered = model.themes.filter((theme) => theme.posts.length > 0).length;
		const count = [
			postsLabel(model.posts.length),
			model.sourceCount > 0 ? sourcesLabel(model.sourceCount) : "",
			model.themes.length > 0
				? t("{answered} of {total} themes answered", { answered, total: model.themes.length })
				: "",
		]
			.filter(Boolean)
			.join(" · ");
		const band = this.#band(shown);
		return [
			h("div", { class: "lib-kicker" }, shown.kicker),
			...(model.line ? [h("p", { class: "lib-state" }, model.line)] : []),
			h("p", { class: "lib-count" }, count),
			...(model.themes.length
				? [
						h(
							"div",
							{ class: "lib-themes" },
							model.themes.map((theme) =>
								h(
									"button",
									{
										type: "button",
										class: `lib-theme${theme.posts.length ? "" : " is-empty"}`,
										"data-act": "library-theme",
										"data-theme": theme.key,
									},
									h(
										"span",
										{ class: "lib-theme-top" },
										this.#themeIcon(shown, theme),
										h("span", { class: "lib-theme-name" }, theme.name),
									),
									h(
										"span",
										{ class: "lib-theme-n" },
										theme.posts.length ? postsLabel(theme.posts.length) : t("No post yet"),
									),
									theme.question ? h("span", { class: "lib-theme-q" }, theme.question) : null,
								),
							),
						),
					]
				: []),
			...(band ? [band] : []),
			...(model.posts.length ? this.#grid(shown, model.posts) : []),
		];
	}

	#open(theme: LibraryTheme): HTMLElement {
		return h(
			"div",
			null,
			h("div", { class: "lib-th-colhead" }, t("Still open")),
			h(
				"div",
				{ class: "lib-th-open" },
				theme.open.map((item) =>
					h("div", { class: "lib-th-q" }, h("b", null, item.what), item.note ? h("span", null, item.note) : null),
				),
			),
		);
	}

	#themePage(shown: LibraryShown, theme: LibraryTheme): HTMLElement[] {
		const head = [
			h("button", { type: "button", class: "lib-back", "data-act": "library-front" }, `← ${shown.kicker}`),
			h(
				"p",
				{ class: "lib-th-state" },
				h("b", null, theme.name),
				this.#themeIcon(shown, theme),
				theme.lead ? ` ${theme.lead}` : null,
			),
		];
		if (theme.posts.length === 0) {
			return [
				...head,
				h("div", { class: "lib-th-empty" }, h("b", null, t("No post yet")), theme.question ?? null),
				...(theme.open.length ? [h("div", { class: "lib-th-cols is-single" }, this.#open(theme))] : []),
			];
		}
		const claims = theme.posts.flatMap((post) =>
			(post.claims.length ? post.claims : [post.doc.headline]).map((claim) => ({ claim, post })),
		);
		return [
			...head,
			h(
				"div",
				{ class: `lib-th-cols${theme.open.length ? "" : " is-single"}` },
				h(
					"div",
					null,
					h("div", { class: "lib-th-colhead" }, t("What we know so far")),
					h(
						"div",
						{ class: "lib-th-know" },
						claims.map(({ claim, post }) =>
							h(
								"button",
								{ type: "button", class: "lib-th-claim", "data-act": "library-post", "data-path": post.path },
								h("strong", null, claim),
								h(
									"span",
									null,
									[
										t("Post {n}", { n: post.number }),
										post.sourceCount > 0 ? sourcesLabel(post.sourceCount) : "",
										post.basis ?? "",
										post.checked ? t("checked {day}", { day: postDay(post.checked) }) : "",
									]
										.filter(Boolean)
										.join(" · "),
								),
							),
						),
					),
				),
				theme.open.length ? this.#open(theme) : null,
			),
			...this.#grid(shown, theme.posts),
		];
	}

	#postPage(shown: LibraryShown, post: LibraryPost): HTMLElement {
		const life = new AbortController();
		this.#page = life;
		this.#options.signal.addEventListener("abort", () => life.abort(), { once: true, signal: life.signal });
		const theme = post.themeKey ? shown.model.themes.find((item) => item.key === post.themeKey) : undefined;
		const themeAttrs = theme ? { "data-act": "library-theme", "data-theme": theme.key } : undefined;
		const page = buildPostPage({
			doc: post.doc,
			signal: life.signal,
			number: post.number,
			back: theme
				? { label: `← ${theme.name}`, attrs: { "data-act": "library-theme", "data-theme": theme.key } }
				: { label: `← ${shown.kicker}`, attrs: { "data-act": "library-front" } },
			...(themeAttrs ? { themeAttrs } : {}),
			...(post.basis ? { basis: post.basis } : {}),
			related: post.related.flatMap((path) => {
				const other = shown.model.posts.find((item) => item.path === path);
				if (!other) return [];
				return [
					{
						title: other.doc.headline,
						meta: [other.themeName ?? other.doc.category, other.number].filter(Boolean).join(" · "),
						attrs: { "data-act": "library-post", "data-path": other.path },
					},
				];
			}),
		});
		for (const build of page.sectionTasks) page.article.append(build());
		return page.root;
	}
}

export class SurfaceLibraries {
	readonly #options: SurfaceLibrariesOptions;
	readonly #views = new Map<string, LibraryView>();
	readonly #models = new WeakMap<SurfaceBlockContext, Map<string, LibraryModel>>();
	#wanted: string | undefined;

	constructor(options: SurfaceLibrariesOptions) {
		this.#options = options;
	}

	#model(block: SurfaceLibraryBlock, ctx: SurfaceBlockContext, apart: readonly string[]): LibraryModel {
		let known = this.#models.get(ctx);
		if (!known) {
			known = new Map();
			this.#models.set(ctx, known);
		}
		const key = `${JSON.stringify(block.from)}|${block.match}|${apart.join(",")}`;
		let model = known.get(key);
		if (!model) {
			model = buildLibraryModel({
				paths: ctx
					.matching([block.match])
					.map((file) => file.path)
					.filter((path) => REPORT_FILE_RE.test(path) && !apart.some((folder) => path.startsWith(`${folder}/`))),
				text: ctx.text,
				file: ctx.read(block.from).value,
				resolve: ctx.companyPath,
			});
			known.set(key, model);
		}
		return model;
	}

	claimed(block: SurfaceLibraryBlock, ctx: SurfaceBlockContext, apart: readonly string[]): readonly string[] {
		const model = this.#model(block, ctx, apart);
		return [...model.posts.map((post) => post.path), ...model.pictures];
	}

	holds(block: SurfaceLibraryBlock, ctx: SurfaceBlockContext, apart: readonly string[]): (path: string) => boolean {
		const paths = new Set(this.#model(block, ctx, apart).posts.map((post) => post.path));
		return (path) => paths.has(path);
	}

	prepare(
		key: string,
		block: SurfaceLibraryBlock,
		ctx: SurfaceBlockContext,
		apart: readonly string[],
		alone: boolean,
	): SurfaceBlockPrepared {
		const model = this.#model(block, ctx, apart);
		const filled = model.posts.length > 0;
		if (!filled && model.themes.length === 0 && !alone && !block.heading) return { filled: false, pieces: [] };
		const kicker = block.heading ? ctx.words(block.heading) : t("Research");
		const signature = [
			model.line,
			JSON.stringify(model.themes.map((theme) => [theme.key, theme.name, theme.question, theme.lead, theme.open])),
			model.featured.map((post) => post.path).join("\n"),
			...model.posts.flatMap((post) => {
				const text = ctx.text(post.path);
				return [post.path, text.value, text.base];
			}),
			...model.pictures.flatMap((path) => [path, ctx.text(path).value, ctx.binary(path).value?.fileSha256]),
		];
		return {
			filled,
			pieces: [
				{
					build: () => {
						let view = this.#views.get(key);
						if (!view) {
							view = new LibraryView(this.#options);
							this.#views.set(key, view);
						}
						if (view.show({ model, ctx, kicker, signature }, this.#wanted)) this.#wanted = undefined;
						return view.el;
					},
				},
			],
		};
	}

	open(path: string): void {
		let opened = false;
		for (const view of this.#views.values()) opened = view.open(path) || opened;
		this.#wanted = opened ? undefined : path;
	}

	keep(keys: ReadonlySet<string>): void {
		for (const [key, view] of this.#views) {
			if (keys.has(key)) continue;
			view.deactivate();
			this.#views.delete(key);
		}
	}

	deactivate(): void {
		this.#wanted = undefined;
		for (const view of this.#views.values()) view.deactivate();
	}
}
