import { h } from "./dom.ts";
import { t } from "./preferences.ts";

/** A decoded picture: what a canvas draws. */
export type MachineScreenPicture = CanvasImageSource & {
	readonly width: number;
	readonly height: number;
	close?(): void;
};

export interface MachineScreenViewOptions {
	/** The panel's body: the view sits over its state text while it shows a picture. */
	readonly mount: HTMLElement;
	readonly title: string;
	/** The view entered (full size in the thread, or full screen) or went back to the preview. */
	readonly onExpandedChange: (expanded: boolean) => void;
	/** Decodes a picture (default createImageBitmap, off the main thread). */
	readonly decode?: (png: Blob) => Promise<MachineScreenPicture>;
}

/**
 * The picture of an agent's desktop (migration 20260930712000), in the frame the old screen viewer drew
 * (member-web/ui/screens.css: overlay, frame, titlebar, heading, stage, Enter and Back, and the `.computer-panel` rules
 * around it), so it looks, enters and goes back exactly as before. A canvas shows each picture once it is decoded, so
 * the last one stays up until the next is ready. It shows; it takes no input (stage 1b adds a member's take-over).
 */
export class MachineScreenView {
	readonly el: HTMLElement;
	readonly #options: MachineScreenViewOptions;
	readonly #heading = h("span");
	readonly #hint = h("small");
	/** Says when the browser refused full screen, so the entered frame is not taken for it. Empty until then. */
	readonly #note = h("small", { class: "screen-viewer-note", role: "status", "aria-live": "polite" });
	readonly #back = h("button", {
		type: "button",
		class: "screen-viewer-back",
		hidden: true,
		"aria-label": t("Back to thread"),
		title: t("Back to thread"),
	});
	readonly #enter = h("button", { type: "button", class: "screen-viewer-enter", disabled: true }, t("Enter"));
	readonly #canvas = h("canvas", { class: "machine-screen-canvas", role: "img" });
	/** "Live" while the pictures come, "Updating…" while the last one is held. */
	readonly #mark = h("span", { class: "machine-screen-mark", hidden: true });
	readonly #switcherSlot = h("span", { class: "machine-screen-switcher-slot" });
	readonly #stop = new AbortController();
	#entered = false;
	#shown = false;
	/** Each picture's turn: one decoded after a newer one began is dropped. */
	#turn = 0;
	#fullscreenAttempt = 0;
	#ownedFullscreen = false;

	constructor(options: MachineScreenViewOptions) {
		this.#options = options;
		const headingWrap = h("span", { class: "screen-viewer-heading" }, this.#heading, this.#hint, this.#note);
		const controls = h("div", { class: "screen-viewer-controls" }, this.#back);
		const titlebar = h("div", { class: "screen-viewer-titlebar" }, headingWrap, this.#switcherSlot, controls);
		const stage = h("div", { class: "screen-viewer-stage" }, this.#canvas, this.#mark);
		const frame = h("div", { class: "screen-viewer-frame" }, titlebar, stage, this.#enter);
		this.el = h(
			"div",
			{
				class: "screen-viewer-overlay screen-viewer-embedded machine-screen",
				role: "region",
				tabindex: "-1",
				hidden: true,
			},
			frame,
		);
		this.setTitle(options.title);
		options.mount.append(this.el);
		const signal = this.#stop.signal;
		this.#enter.addEventListener("click", () => this.#enterView(), { signal });
		this.#back.addEventListener("click", () => this.back(), { signal });
		document.addEventListener(
			"fullscreenchange",
			() => {
				const active = document.fullscreenElement === this.el;
				if (active) this.#note.textContent = "";
				if (this.#ownedFullscreen && !active) this.back();
				this.#ownedFullscreen = active;
			},
			{ signal },
		);
	}

	get entered(): boolean {
		return this.#entered;
	}

	/** Whether a picture is up. */
	get shown(): boolean {
		return this.#shown;
	}

	setTitle(title: string): void {
		this.el.setAttribute("aria-label", title);
		this.#canvas.setAttribute("aria-label", title);
		this.#heading.textContent = title;
	}

	/** The machine switcher, in the titlebar beside the title while entered (the panel keeps its own on the preview). */
	setSwitcher(switcher: HTMLElement | null): void {
		this.#switcherSlot.replaceChildren(...(switcher ? [switcher] : []));
	}

	/** Shows a picture once it is decoded; a newer picture that began meanwhile wins. Resolves false when this one was
	 * dropped or could not be decoded. */
	async show(png: Blob): Promise<boolean> {
		const turn = ++this.#turn;
		let picture: MachineScreenPicture;
		try {
			picture = await (this.#options.decode ?? ((blob: Blob) => createImageBitmap(blob)))(png);
		} catch {
			return false;
		}
		if (turn !== this.#turn || this.#stop.signal.aborted) {
			picture.close?.();
			return false;
		}
		if (this.#canvas.width !== picture.width) this.#canvas.width = picture.width;
		if (this.#canvas.height !== picture.height) this.#canvas.height = picture.height;
		this.#canvas.getContext("2d")?.drawImage(picture, 0, 0);
		picture.close?.();
		this.#shown = true;
		this.el.hidden = false;
		this.#enter.disabled = false;
		this.live();
		return true;
	}

	/** The picture up is the screen as it is now (the member had it already). */
	live(): void {
		if (!this.#shown) return;
		this.#mark.hidden = false;
		this.#mark.classList.remove("is-updating");
		this.#mark.textContent = t("Live");
		this.#hint.textContent = t("Live");
	}

	/** The last picture stays, marked as being updated (the company folder has not released the next one yet). */
	updating(): void {
		if (!this.#shown) return;
		this.#mark.hidden = false;
		this.#mark.classList.add("is-updating");
		this.#mark.textContent = t("Updating…");
		this.#hint.textContent = t("Updating…");
	}

	/** No picture any more: the view goes away, and the panel's state text shows. */
	clear(): void {
		this.#turn++;
		this.back();
		this.#shown = false;
		this.el.hidden = true;
		this.#enter.disabled = true;
		this.#mark.hidden = true;
		this.#hint.textContent = "";
		this.#canvas.getContext("2d")?.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
	}

	/** Back to the preview, from the entered frame or full screen. */
	back(): void {
		if (!this.#entered) return;
		this.#fullscreenAttempt++;
		const focused = this.el.contains(document.activeElement);
		this.#setEntered(false);
		if (focused) this.el.focus();
		if (document.fullscreenElement === this.el) void document.exitFullscreen().catch(() => undefined);
	}

	dispose(): void {
		this.back();
		this.#stop.abort();
		this.#turn++;
		this.el.remove();
	}

	#setEntered(value: boolean): void {
		if (this.#entered === value) return;
		this.#entered = value;
		this.el.classList.toggle("screen-viewer-entered", value);
		this.#back.hidden = !value;
		this.#enter.hidden = value;
		if (!value) this.#note.textContent = "";
		this.#options.onExpandedChange(value);
	}

	/** Entering takes the browser full screen, with the frame around the picture; "Back to thread" is the way out, and
	 * leaving full screen any other way (Escape, the system) goes back too. Refused, the entered frame stays in the
	 * thread and says so. */
	#enterView(): void {
		if (this.#entered || this.#enter.disabled) return;
		this.#setEntered(true);
		this.#back.focus();
		const supports =
			document.fullscreenEnabled !== false &&
			typeof this.el.requestFullscreen === "function" &&
			typeof document.exitFullscreen === "function";
		if (!supports) return;
		const attempt = ++this.#fullscreenAttempt;
		const refused = () => {
			if (attempt === this.#fullscreenAttempt && this.#entered && document.fullscreenElement !== this.el)
				this.#note.textContent = t("Full screen unavailable");
		};
		const slow = setTimeout(refused, 2000);
		// Asked before any await, so the click's user activation holds.
		void this.el
			.requestFullscreen()
			.then(() => {
				if (!this.#entered && document.fullscreenElement === this.el) return document.exitFullscreen();
				return undefined;
			})
			.catch(() => setTimeout(refused, 0))
			.finally(() => clearTimeout(slow));
	}
}
