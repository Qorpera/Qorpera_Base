import type { WorkspaceActions } from "../app/workspace-actions.ts";
import type { TranscriptAttachment, TranscriptMessage } from "../cloud/transcript.ts";
import { SurfaceDialog } from "./dialog.ts";
import { fmtBytes, h, icon, replace } from "./dom.ts";
import { matchesKey } from "./keys.ts";
import { t } from "./preferences.ts";

const SAFE_IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** One file's card and what is known about its bytes. */
interface Slot {
	index: number;
	attachment: TranscriptAttachment;
	card: HTMLButtonElement;
	visual: HTMLElement;
	status: HTMLElement;
	/** A safe image's object URL, once its bytes are here. */
	url?: string;
	/** The bytes on their way: shared by the thread's thumbnail and an open preview. */
	loading?: Promise<string | undefined>;
	/** The card has been on screen, so its thumbnail is wanted. */
	seen: boolean;
	/** The thread is waiting on the bytes to place the thumbnail (a read the viewer began included). */
	placing: boolean;
	/** The thumbnail failed; a click retries it. */
	failed: boolean;
}

/** Metadata is public projection data; bytes come only through the explicit bytes port.
 * URL fields, embedded HTML and SVG never become live transcript resources. An image with a
 * canonical reference shows itself in the thread once its card comes on screen; other files
 * show a card and load only when asked. */
export class ReceivedAttachments {
	readonly el = h("div", { class: "received-attachments", "aria-label": t("Message attachments") });
	readonly #lifetime = new AbortController();
	readonly #urls = new Set<string>();
	readonly #slots: Slot[] = [];
	readonly #load: WorkspaceActions["previewAttachment"];
	#visibility: IntersectionObserver | undefined;
	#preview: SurfaceDialog | undefined;
	/** The message the files belong to; bytes are asked for by the message's current id. */
	#message: TranscriptMessage;
	constructor(message: TranscriptMessage, load?: WorkspaceActions["previewAttachment"]) {
		this.#message = message;
		this.#load = load;
		const attachments =
			message.attachments ??
			Array.from({ length: message.attachmentCount }, () => ({
				kind: "file" as const,
				name: t("Attachment"),
				mediaType: undefined,
				bytes: undefined,
			}));
		attachments.forEach((attachment, index) => {
			const thumbnail = this.#showsThumbnail(attachment);
			const visual = h(
				"span",
				{ class: "received-file-visual" },
				icon(attachment.kind === "image" ? "image" : "file"),
			);
			const status = h("small", null, load ? t("Click to preview") : t("Preview unavailable"));
			const card = h(
				"button",
				{
					type: "button",
					class: `received-file${attachment.kind === "image" ? " received-image" : ""}${thumbnail ? " awaits-thumbnail" : ""}`,
					"aria-label": t("Preview {name}", { name: attachment.name }),
				},
				visual,
				h(
					"span",
					{ class: "received-file-copy" },
					h("strong", null, attachment.name),
					attachment.bytes !== undefined ? h("small", null, fmtBytes(attachment.bytes)) : null,
					status,
				),
			) as HTMLButtonElement;
			const slot: Slot = { index, attachment, card, visual, status, seen: false, placing: false, failed: false };
			card.onclick = () => void this.#open(slot);
			this.#slots.push(slot);
			this.el.append(card);
			if (thumbnail) this.#watch(slot);
		});
	}
	/** The same files under the message's next id: the browser's copy of a sent message becomes
	 * the cloud's waiting input and then the transcript's message, and the files stay as shown. */
	follow(message: TranscriptMessage): void {
		this.#message = message;
		for (const slot of this.#slots) if (slot.seen) this.#thumbnail(slot);
	}
	dispose(): void {
		this.#lifetime.abort();
		this.#visibility?.disconnect();
		this.#visibility = undefined;
		this.#preview?.close(false);
		for (const url of this.#urls) URL.revokeObjectURL(url);
		this.#urls.clear();
	}

	/** Only a canonical image reference can be read; anything else stays a card. */
	#showsThumbnail(attachment: TranscriptAttachment): boolean {
		return Boolean(this.#load && attachment.kind === "image" && attachment.reference);
	}

	/** Thumbnails load as their cards come on screen, so a long thread doesn't read every image at once. */
	#watch(slot: Slot): void {
		if (typeof IntersectionObserver === "undefined") {
			slot.seen = true;
			this.#thumbnail(slot);
			return;
		}
		this.#visibility ??= new IntersectionObserver(
			(records) => {
				for (const record of records) {
					if (!record.isIntersecting) continue;
					this.#visibility?.unobserve(record.target);
					const seen = this.#slots.find((item) => item.card === record.target);
					if (!seen) continue;
					seen.seen = true;
					this.#thumbnail(seen);
				}
			},
			{ rootMargin: "400px 0px" },
		);
		this.#visibility.observe(slot.card);
	}

	/** Shows the image in the thread. A message that is still being sent has no readable bytes yet;
	 * follow() tries again once the cloud has it. */
	#thumbnail(slot: Slot): void {
		if (
			slot.card.classList.contains("has-thumbnail") ||
			slot.placing ||
			slot.failed ||
			this.#message.pending ||
			!this.#showsThumbnail(slot.attachment)
		)
			return;
		// A read already under way (the viewer reading ahead) is joined, not skipped.
		slot.placing = true;
		this.#fetch(slot)
			.then(
				(url) => {
					if (slot.card.classList.contains("has-thumbnail")) return;
					if (!url) this.#settle(slot, t("Preview unavailable"));
					else this.#place(slot, url);
				},
				() => {
					if (this.#lifetime.signal.aborted) return;
					slot.failed = true;
					this.#settle(slot, t("Preview failed · retry"));
				},
			)
			.finally(() => {
				slot.placing = false;
			});
	}

	/** The safe image's object URL, or undefined for bytes that may not be shown. */
	#fetch(slot: Slot): Promise<string | undefined> {
		if (slot.url) return Promise.resolve(slot.url);
		const load = this.#load;
		if (!load) return Promise.resolve(undefined);
		slot.loading ??= (async () => {
			try {
				const blob = await load(this.#message.id, slot.index, this.#lifetime.signal);
				this.#lifetime.signal.throwIfAborted();
				if (!blob.size || blob.size > 25 * 1024 * 1024 || !SAFE_IMAGES.has(blob.type)) return undefined;
				const url = URL.createObjectURL(blob);
				this.#urls.add(url);
				slot.url = url;
				return url;
			} finally {
				slot.loading = undefined;
			}
		})();
		return slot.loading;
	}

	/** The card goes back to its name and a status line. */
	#settle(slot: Slot, status: string): void {
		slot.card.classList.remove("awaits-thumbnail", "has-thumbnail");
		replace(slot.visual, icon(slot.attachment.kind === "image" ? "image" : "file"));
		slot.status.textContent = status;
	}

	#place(slot: Slot, url: string): void {
		const image = h("img", { src: url, alt: "" });
		image.onerror = () => {
			if (slot.url) {
				URL.revokeObjectURL(slot.url);
				this.#urls.delete(slot.url);
				slot.url = undefined;
			}
			slot.failed = true;
			this.#settle(slot, t("Preview failed · retry"));
		};
		replace(slot.visual, image);
		slot.status.textContent = t("Open preview");
		if (this.#showsThumbnail(slot.attachment)) {
			slot.card.classList.remove("awaits-thumbnail");
			slot.card.classList.add("has-thumbnail");
		}
	}

	/** The message's images, one at a time over the dimmed thread, with no frame around them: the arrows, the arrow
	 * keys or a swipe go to the next or the one before. */
	#view(start: Slot): void {
		const images = this.#slots.filter((slot) => slot.attachment.kind === "image");
		let at = Math.max(0, images.indexOf(start));
		this.#preview?.close(false);
		const viewer = new SurfaceDialog(t("Image viewer"), "image-viewer-dialog", () => {
			if (this.#preview === viewer) this.#preview = undefined;
		});
		this.#preview = viewer;
		const stage = h("div", { class: "image-viewer-stage" });
		const count = h("p", { class: "image-viewer-count", "aria-live": "polite" });
		const step = (by: number) => {
			const next = at + by;
			if (next < 0 || next >= images.length) return;
			at = next;
			show(by);
		};
		const previous = h(
			"button",
			{
				type: "button",
				class: "image-viewer-nav is-previous",
				"aria-label": t("Previous image"),
				onclick: () => step(-1),
			},
			icon("chevron"),
		) as HTMLButtonElement;
		const next = h(
			"button",
			{ type: "button", class: "image-viewer-nav is-next", "aria-label": t("Next image"), onclick: () => step(1) },
			icon("chevron"),
		) as HTMLButtonElement;
		let shown = 0;
		const show = (from = 0) => {
			const slot = images[at]!;
			const ticket = ++shown;
			previous.hidden = next.hidden = images.length < 2;
			previous.disabled = at === 0;
			next.disabled = at === images.length - 1;
			count.textContent =
				images.length > 1 ? t("{index} of {count}", { index: String(at + 1), count: String(images.length) }) : "";
			viewer.el.setAttribute("aria-label", slot.attachment.name);
			replace(stage, h("p", { class: "image-viewer-note", role: "status" }, t("Loading preview…")));
			slot.failed = false;
			this.#fetch(slot).then(
				(url) => {
					if (ticket !== shown || this.#preview !== viewer) return;
					if (!url) {
						this.#settle(slot, t("Preview unavailable"));
						replace(stage, h("p", { class: "image-viewer-note" }, t("Preview is not available for this file.")));
						return;
					}
					if (!slot.card.classList.contains("has-thumbnail")) this.#place(slot, url);
					const image = h("img", {
						src: url,
						alt: slot.attachment.name,
						draggable: "false",
						class: from ? (from > 0 ? "is-from-next" : "is-from-previous") : "",
					});
					// Only the picture still shown may say it failed: one stepped away from can report late.
					image.onerror = () => {
						if (ticket === shown && this.#preview === viewer)
							replace(stage, h("p", { class: "image-viewer-note" }, t("This image could not be displayed.")));
					};
					replace(stage, image);
				},
				() => {
					if (this.#lifetime.signal.aborted) return;
					slot.failed = true;
					this.#settle(slot, t("Preview failed · retry"));
					if (ticket === shown && this.#preview === viewer)
						replace(
							stage,
							h(
								"p",
								{ class: "image-viewer-note" },
								t("The preview could not be loaded. Close and reopen it to retry."),
							),
						);
				},
			);
			// The ones beside it come along, so the next step shows at once.
			for (const near of [images[at - 1], images[at + 1]])
				if (near && !near.url && !near.loading) this.#fetch(near).catch(() => {});
		};
		viewer.el.addEventListener("keydown", (event) => {
			if (event.altKey || event.ctrlKey || event.metaKey) return;
			if (matchesKey(event, "left")) {
				event.preventDefault();
				step(-1);
			} else if (matchesKey(event, "right")) {
				event.preventDefault();
				step(1);
			}
		});
		// A swipe follows the finger and goes on past a third of the way or with a flick; anything shorter springs
		// back. A tap beside the picture closes the viewer.
		let drag: { id: number; x: number; y: number; at: number; dx: number } | undefined;
		stage.addEventListener("pointerdown", (event) => {
			if (event.button !== 0) return;
			drag = { id: event.pointerId, x: event.clientX, y: event.clientY, at: event.timeStamp, dx: 0 };
		});
		stage.addEventListener("pointermove", (event) => {
			if (!drag || drag.id !== event.pointerId) return;
			const dx = event.clientX - drag.x;
			if (!drag.dx && Math.abs(dx) < 8) return;
			if (!drag.dx) stage.setPointerCapture?.(event.pointerId);
			drag.dx = dx;
			// Past either end the picture holds back.
			const end = (dx > 0 && at === 0) || (dx < 0 && at === images.length - 1);
			stage.style.setProperty("--image-viewer-drag", `${end ? dx / 4 : dx}px`);
			stage.classList.add("is-dragging");
		});
		const release = (event: PointerEvent) => {
			if (!drag || drag.id !== event.pointerId) return;
			const { dx, at: began, x, y } = drag;
			drag = undefined;
			stage.classList.remove("is-dragging");
			stage.style.removeProperty("--image-viewer-drag");
			if (event.type === "pointercancel") return;
			if (dx) {
				const flick = Math.abs(dx) > 30 && event.timeStamp - began < 250;
				if (Math.abs(dx) > stage.clientWidth / 3 || flick) step(dx < 0 ? 1 : -1);
				return;
			}
			const moved = Math.hypot(event.clientX - x, event.clientY - y) > 8;
			if (!moved && event.target === stage) viewer.close();
		};
		stage.addEventListener("pointerup", release);
		stage.addEventListener("pointercancel", release);
		viewer.content.append(stage, previous, next, count);
		viewer.open();
		show();
	}

	async #open(slot: Slot): Promise<void> {
		const { attachment } = slot;
		if (attachment.kind === "image" && this.#load) {
			this.#view(slot);
			return;
		}
		this.#preview?.close(false);
		const preview = new SurfaceDialog(t("Attachment preview"), "file-preview-dialog", () => {
			if (this.#preview === preview) this.#preview = undefined;
		});
		this.#preview = preview;
		const body = h(
			"div",
			{ class: "file-preview-placeholder", role: "status" },
			icon(attachment.kind === "image" ? "image" : "file"),
			h("p", null, this.#load ? t("Loading preview…") : t("Preview is not available yet.")),
		);
		preview.content.append(
			h("h2", null, attachment.name),
			body,
			attachment.bytes !== undefined
				? h("p", { class: "muted" }, fmtBytes(attachment.bytes))
				: h("p", { class: "muted" }, t("File size unavailable")),
		);
		preview.open();
		if (!this.#load) return;
		slot.failed = false;
		try {
			const url = await this.#fetch(slot);
			if (this.#lifetime.signal.aborted) return;
			if (!url) {
				this.#settle(slot, t("Preview unavailable"));
				if (this.#preview === preview)
					replace(body, icon("file"), h("p", null, t("Preview is not available for this file.")));
				return;
			}
			if (!slot.card.classList.contains("has-thumbnail")) this.#place(slot, url);
			if (this.#preview === preview) {
				const image = h("img", { src: url, alt: attachment.name });
				image.onerror = () => replace(body, icon("image"), h("p", null, t("This image could not be displayed.")));
				replace(body, image);
			}
		} catch {
			if (!this.#lifetime.signal.aborted) {
				slot.failed = true;
				this.#settle(slot, t("Preview failed · retry"));
				if (this.#preview === preview)
					replace(
						body,
						icon("file"),
						h("p", null, t("The preview could not be loaded. Close and reopen it to retry.")),
					);
			}
		}
	}
}
