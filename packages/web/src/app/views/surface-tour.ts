import {
	parseStudioTourDocument,
	resolveTourSay,
	STUDIO_TOUR_PATH,
	type StudioBinaryRef,
	type StudioTourAction,
	type StudioTourBeat,
	type StudioTourDocument,
} from "@qorpera/contracts";
import { h, icon } from "../../ui/dom.ts";
import { presentationLocale, t } from "../../ui/preferences.ts";
import type { StudioBinaryReader } from "./surface-studio-stage.ts";
import { captionHash, parseVoiceClips, type VoiceClipMeta, voiceClipMime } from "./surface-voice-clips.ts";

export interface StudioTourOptions {
	readonly root: HTMLElement;
	readonly signal: AbortSignal;
	readonly readBinary: StudioBinaryReader;
	readonly switchTab: (tab: string) => void;
	readonly currentTab: () => string;
}

const WORDS_PER_SEC = 2.6;
const BEAT_BREATH_MS = 1100;
const MIN_BEAT_MS = 2600;

function cleanFolder(folderRoot: string | null | undefined): string {
	return folderRoot?.trim().replace(/^\/+|\/+$/g, "") ?? "";
}

function joinFolder(root: string, rel: string): string {
	return root ? `${root}/${rel}` : rel;
}

function escapeAttr(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function findFocusTarget(root: HTMLElement, focus: string | undefined): HTMLElement | null {
	if (!focus) return null;
	const safe = escapeAttr(focus);
	const exact = root.querySelector<HTMLElement>(`[data-tour-id="${safe}"]`);
	if (exact) return exact;
	const colon = focus.indexOf(":");
	if (colon > 0) {
		const kind = focus.slice(0, colon);
		const id = escapeAttr(focus.slice(colon + 1));
		if (kind === "block") {
			return (
				root.querySelector<HTMLElement>(`[data-block-id="${id}"]`) ??
				root.querySelector<HTMLElement>(`[data-block="${id}"]`)
			);
		}
		if (kind === "play") return root.querySelector<HTMLElement>(`[data-play="${id}"]`);
		if (kind === "rival") return root.querySelector<HTMLElement>(`[data-player="${id}"]`);
		if (kind === "hypothesis") return root.querySelector<HTMLElement>(`[data-hypothesis="${id}"]`);
	}
	return root.querySelector<HTMLElement>(`[data-block="${safe}"]`);
}

function runAction(root: HTMLElement, action: StudioTourAction | undefined): void {
	if (!action) return;
	if (action.scenario) {
		const target =
			action.scenario === "base"
				? root.querySelector<HTMLButtonElement>(".studio-econ-scenario.is-base")
				: root.querySelector<HTMLButtonElement>(
						`.studio-econ-scenario[data-scenario="${escapeAttr(action.scenario)}"]`,
					);
		target?.click();
	}
	if (action.view) {
		root.querySelector<HTMLButtonElement>(`[data-econ-view="${escapeAttr(action.view)}"]`)?.click();
	}
	if (action.select) {
		const safe = escapeAttr(action.select);
		const rival = root.querySelector<HTMLButtonElement>(`.studio-land-chip[data-player="${safe}"]`);
		if (rival) rival.click();
		else {
			const hyp = root.querySelector<HTMLButtonElement>(`.studio-hyp-head[data-hypothesis-toggle="${safe}"]`);
			if (hyp && hyp.getAttribute("aria-expanded") !== "true") hyp.click();
		}
	}
	if (action.expand) {
		const safe = escapeAttr(action.expand);
		const playBtn = root.querySelector<HTMLButtonElement>(`[data-play="${safe}"] .studio-play-toggle`);
		if (playBtn && playBtn.getAttribute("aria-expanded") !== "true") playBtn.click();
		const hypBtn = root.querySelector<HTMLButtonElement>(`.studio-hyp-head[data-hypothesis-toggle="${safe}"]`);
		if (hypBtn && hypBtn.getAttribute("aria-expanded") !== "true") hypBtn.click();
	}
}

function readingDurationMs(text: string): number {
	const words = text.trim() ? text.trim().split(/\s+/).length : 0;
	return Math.max(MIN_BEAT_MS, Math.round((words / WORDS_PER_SEC) * 1000) + BEAT_BREATH_MS);
}

export class StudioTourController {
	readonly el = h("aside", { class: "studio-tour", hidden: true, "aria-label": t("Guided walkthrough") });
	readonly #options: StudioTourOptions;
	#doc: StudioTourDocument | null = null;
	#clips = new Map<string, VoiceClipMeta>();
	#binaries: Readonly<Record<string, StudioBinaryRef>> = {};
	#folderRoot = "";
	#signature = "";
	#open = false;
	#playing = false;
	#muted = false;
	#index = 0;
	#beatSeq = 0;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#audio: HTMLAudioElement | null = null;
	#audioUrl: string | null = null;
	#focusedEl: HTMLElement | null = null;
	#ancestors: HTMLElement[] = [];

	constructor(options: StudioTourOptions) {
		this.#options = options;
		options.signal.addEventListener("abort", () => this.dispose(), { once: true });
		window.addEventListener(
			"keydown",
			(event) => {
				if (event.key === "Escape" && this.#open) {
					event.preventDefault();
					this.stop();
				}
			},
			{ signal: options.signal },
		);
	}

	sync(
		files: Readonly<Record<string, string>>,
		binaries: Readonly<Record<string, StudioBinaryRef>>,
		folderRoot: string | null | undefined,
	): void {
		const root = cleanFolder(folderRoot);
		const tourPath = joinFolder(root, STUDIO_TOUR_PATH);
		const clipsPath = joinFolder(root, "voice/clips.json");
		const rawTour = files[tourPath];
		const rawClips = files[clipsPath];
		const sig = `${root}\0${rawTour ?? ""}\0${rawClips ?? ""}`;
		this.#folderRoot = root;
		this.#binaries = binaries;
		if (sig === this.#signature) return;
		this.#signature = sig;
		const parsed = rawTour ? parseStudioTourDocument(rawTour) : null;
		this.#doc = parsed;
		this.#clips = parseVoiceClips(rawClips);
		if (!parsed) {
			this.stop();
			this.el.hidden = true;
			this.el.replaceChildren();
			return;
		}
		if (this.#index >= parsed.beats.length) this.#index = 0;
		this.el.hidden = false;
		this.#render();
	}

	start(at = 0): void {
		if (!this.#doc || this.#doc.beats.length === 0) return;
		this.#primeAudio();
		this.#open = true;
		this.#playing = true;
		this.#index = Math.max(0, Math.min(this.#doc.beats.length - 1, at));
		this.#render();
		void this.#enterBeat(this.#index);
	}

	pause(): void {
		this.#playing = false;
		this.#stopMedia();
		this.#render();
	}

	resume(): void {
		if (!this.#doc) return;
		this.#primeAudio();
		this.#open = true;
		this.#playing = true;
		this.#render();
		void this.#enterBeat(this.#index);
	}

	step(delta: number): void {
		if (!this.#doc || this.#doc.beats.length === 0) return;
		const next = this.#index + delta;
		if (next < 0) {
			this.#index = 0;
		} else if (next >= this.#doc.beats.length) {
			this.stop();
			return;
		} else {
			this.#index = next;
		}
		if (this.#playing) this.#primeAudio();
		this.#open = true;
		this.#render();
		void this.#enterBeat(this.#index);
	}

	jump(index: number): void {
		if (!this.#doc) return;
		if (this.#playing) this.#primeAudio();
		this.#open = true;
		this.#index = Math.max(0, Math.min(this.#doc.beats.length - 1, index));
		this.#render();
		void this.#enterBeat(this.#index);
	}

	stop(): void {
		this.#beatSeq += 1;
		this.#open = false;
		this.#playing = false;
		this.#stopMedia();
		this.#clearFocus();
		this.#render();
	}

	deactivate(): void {
		this.stop();
	}

	dispose(): void {
		this.stop();
		this.#audio = null;
		this.el.remove();
	}

	#primeAudio(): void {
		if (this.#clips.size === 0 || this.#muted || typeof Audio !== "function") return;
		if (!this.#audio) this.#audio = new Audio();
		this.#audio.preload = "auto";
	}

	#clearAudio(): void {
		if (this.#audio) {
			this.#audio.onended = null;
			this.#audio.onerror = null;
			this.#audio.pause();
			this.#audio.removeAttribute("src");
		}
		if (this.#audioUrl) {
			URL.revokeObjectURL(this.#audioUrl);
			this.#audioUrl = null;
		}
	}

	#stopMedia(): void {
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		this.#clearAudio();
	}

	#clearFocus(): void {
		const root = this.#options.root;
		root.classList.remove("is-tour-active", "is-tour-spotlight", "is-tour-pulse", "is-tour-glow");
		if (this.#focusedEl) {
			this.#focusedEl.classList.remove(
				"is-tour-focus",
				"is-tour-effect-spotlight",
				"is-tour-effect-pulse",
				"is-tour-effect-glow",
				"is-tour-effect-pan",
			);
			this.#focusedEl = null;
		}
		for (const ancestor of this.#ancestors) ancestor.classList.remove("has-tour-focus");
		this.#ancestors = [];
	}

	#applyFocus(beat: StudioTourBeat): void {
		this.#clearFocus();
		const root = this.#options.root;
		const target = findFocusTarget(root, beat.focus);
		if (!target) return;
		root.classList.add("is-tour-active");
		if (beat.effect === "spotlight") root.classList.add("is-tour-spotlight");
		else if (beat.effect === "pulse") root.classList.add("is-tour-pulse");
		else if (beat.effect === "glow") root.classList.add("is-tour-glow");
		target.classList.add("is-tour-focus", `is-tour-effect-${beat.effect}`);
		this.#focusedEl = target;
		let parent = target.parentElement;
		while (parent && parent !== root) {
			parent.classList.add("has-tour-focus");
			this.#ancestors.push(parent);
			parent = parent.parentElement;
		}
		if (typeof target.scrollIntoView === "function") {
			const tall = target.getBoundingClientRect().height > window.innerHeight * 0.48;
			target.scrollIntoView({ behavior: "smooth", block: tall ? "start" : "center", inline: "nearest" });
		}
	}

	async #enterBeat(index: number): Promise<void> {
		const doc = this.#doc;
		const beat = doc?.beats[index];
		if (!doc || !beat) return;
		const seq = ++this.#beatSeq;
		this.#stopMedia();
		if (beat.tab && this.#options.currentTab() !== beat.tab) {
			this.#options.switchTab(beat.tab);
			await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
			if (seq !== this.#beatSeq || this.#options.signal.aborted) return;
		}
		runAction(this.#options.root, beat.action);
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		if (seq !== this.#beatSeq || this.#options.signal.aborted) return;
		this.#applyFocus(beat);
		this.#render();
		if (!this.#playing) return;
		const locale = presentationLocale();
		const spoken = resolveTourSay(beat.say, locale);
		await this.#speakOrWait(spoken, seq);
	}

	async #speakOrWait(text: string, seq: number): Promise<void> {
		let advanced = false;
		const advance = () => {
			if (advanced || seq !== this.#beatSeq || !this.#playing || this.#options.signal.aborted) return;
			advanced = true;
			this.#timer = undefined;
			if (!this.#doc || this.#index + 1 >= this.#doc.beats.length) {
				this.pause();
				return;
			}
			this.#index += 1;
			this.#render();
			void this.#enterBeat(this.#index);
		};
		const schedule = (delayMs: number) => {
			if (advanced || seq !== this.#beatSeq || !this.#playing || this.#options.signal.aborted) return;
			if (this.#timer) clearTimeout(this.#timer);
			this.#timer = setTimeout(advance, delayMs);
		};

		if (!this.#muted) {
			const clip = this.#clips.get(captionHash(text));
			const binPath = clip ? joinFolder(this.#folderRoot, `voice/${clip.file}`) : "";
			const ref = binPath ? this.#binaries[binPath] : undefined;
			if (clip && ref) {
				try {
					const bytes = await this.#options.readBinary(ref, this.#options.signal);
					if (seq !== this.#beatSeq || !this.#playing || this.#options.signal.aborted) return;
					this.#clearAudio();
					const blob = new Blob([bytes.slice()], { type: voiceClipMime(clip.file, ref.mediaType) });
					const url = URL.createObjectURL(blob);
					const audio = this.#audio ?? new Audio();
					this.#audioUrl = url;
					this.#audio = audio;
					audio.src = url;
					audio.onended = () => {
						schedule(500);
					};
					audio.onerror = () => {
						this.#clearAudio();
						schedule(readingDurationMs(text));
					};
					await audio.play();
					return;
				} catch {
					this.#clearAudio();
					if (seq !== this.#beatSeq || !this.#playing) return;
				}
			}
		}

		schedule(readingDurationMs(text));
	}

	#render(): void {
		const doc = this.#doc;
		if (!doc || doc.beats.length === 0) {
			this.el.hidden = true;
			this.el.replaceChildren();
			return;
		}
		this.el.hidden = false;
		this.el.classList.toggle("is-open", this.#open);
		this.el.classList.toggle("is-playing", this.#playing);
		if (!this.#open) {
			const launch = h(
				"button",
				{
					type: "button",
					class: "studio-tour-launch",
					"data-tour-act": "start",
					onclick: () => this.start(0),
				},
				h("span", { class: "studio-tour-wave", "aria-hidden": "true" }, h("i"), h("i"), h("i")),
				h("span", { class: "studio-tour-launch-label" }, doc.title ?? t("Walk me through this")),
				h("span", { class: "studio-tour-launch-meta" }, t("{count} steps", { count: String(doc.beats.length) })),
			);
			this.el.replaceChildren(launch);
			return;
		}
		const beat = doc.beats[this.#index] ?? doc.beats[0]!;
		const caption = resolveTourSay(beat.say, presentationLocale());
		const dots = h(
			"div",
			{ class: "studio-tour-dots", role: "tablist", "aria-label": t("Walkthrough steps") },
			doc.beats.map((item, idx) =>
				h("button", {
					type: "button",
					role: "tab",
					class: `studio-tour-dot${idx === this.#index ? " is-on" : ""}${idx < this.#index ? " is-done" : ""}`,
					"aria-selected": String(idx === this.#index),
					"aria-label": item.label ?? t("Step {number}", { number: String(idx + 1) }),
					title: item.label ?? t("Step {number}", { number: String(idx + 1) }),
					onclick: () => this.jump(idx),
				}),
			),
		);
		const playBtn = h(
			"button",
			{
				type: "button",
				class: "studio-tour-btn is-main",
				"aria-label": this.#playing ? t("Pause walkthrough") : t("Play walkthrough"),
				onclick: () => (this.#playing ? this.pause() : this.resume()),
			},
			this.#playing ? "❚❚" : "▶",
		);
		const prevBtn = h(
			"button",
			{
				type: "button",
				class: "studio-tour-btn",
				disabled: this.#index === 0,
				"aria-label": t("Previous step"),
				onclick: () => this.step(-1),
			},
			"‹",
		);
		const nextBtn = h(
			"button",
			{
				type: "button",
				class: "studio-tour-btn",
				"aria-label": this.#index + 1 >= doc.beats.length ? t("Finish walkthrough") : t("Next step"),
				onclick: () => this.step(1),
			},
			"›",
		);
		const hasVoiceClips = this.#clips.size > 0;
		const muteBtn = hasVoiceClips
			? h(
					"button",
					{
						type: "button",
						class: `studio-tour-btn${this.#muted ? " is-muted" : ""}`,
						"aria-label": this.#muted ? t("Unmute voice") : t("Mute voice"),
						"aria-pressed": String(this.#muted),
						title: this.#muted ? t("Unmute voice") : t("Mute voice"),
						onclick: () => {
							this.#muted = !this.#muted;
							if (!this.#muted) this.#primeAudio();
							this.#stopMedia();
							this.#render();
							if (this.#playing && this.#doc) {
								const currentBeat = this.#doc.beats[this.#index];
								if (currentBeat) {
									const seq = ++this.#beatSeq;
									void this.#speakOrWait(resolveTourSay(currentBeat.say, presentationLocale()), seq);
								}
							}
						},
					},
					this.#muted ? t("Silent") : t("Voice"),
				)
			: h("span", { class: "studio-tour-mode" }, t("Captions"));
		const closeBtn = h(
			"button",
			{
				type: "button",
				class: "studio-tour-btn is-close",
				"aria-label": t("Close walkthrough"),
				onclick: () => this.stop(),
			},
			icon("close"),
		);
		const stepTag = h(
			"span",
			{ class: "studio-tour-step" },
			beat.label
				? `${this.#index + 1}/${doc.beats.length} · ${beat.label}`
				: `${this.#index + 1}/${doc.beats.length}`,
		);
		const bar = h(
			"div",
			{ class: "studio-tour-bar" },
			h(
				"div",
				{ class: "studio-tour-top" },
				h(
					"span",
					{ class: `studio-tour-wave${this.#playing ? " is-live" : ""}`, "aria-hidden": "true" },
					h("i"),
					h("i"),
					h("i"),
				),
				stepTag,
				dots,
				h("div", { class: "studio-tour-controls" }, prevBtn, playBtn, nextBtn, muteBtn, closeBtn),
			),
			h("p", { class: "studio-tour-caption", role: "status", "aria-live": "polite" }, caption),
		);
		this.el.replaceChildren(bar);
	}
}
