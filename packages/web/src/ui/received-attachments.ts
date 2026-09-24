import type { WorkspaceActions } from "../app/workspace-actions.ts";
import type { TranscriptMessage } from "../cloud/transcript.ts";
import { SurfaceDialog } from "./dialog.ts";
import { fmtBytes, h, icon, replace } from "./dom.ts";
import { t } from "./preferences.ts";

const SAFE_IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Metadata is public projection data; previews require an explicit bytes port.
 * URL fields, embedded HTML and SVG never become live transcript resources. */
export class ReceivedAttachments {
	readonly el = h("div", { class: "received-attachments", "aria-label": t("Message attachments") });
	readonly #lifetime = new AbortController();
	readonly #urls = new Set<string>();
	#preview: SurfaceDialog | undefined;
	constructor(message: TranscriptMessage, load?: WorkspaceActions["previewAttachment"]) {
		const attachments =
			message.attachments ??
			Array.from({ length: message.attachmentCount }, () => ({
				kind: "file" as const,
				name: t("Attachment"),
				mediaType: undefined,
				bytes: undefined,
			}));
		attachments.forEach((attachment, index) => {
			let pending = false;
			let url: string | undefined;
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
					class: `received-file ${attachment.kind === "image" ? "received-image" : ""}`,
					"aria-label": t("Preview {name}", { name: attachment.name }),
					onclick: async () => {
						if (pending) return;
						this.#preview?.close(false);
						const preview = new SurfaceDialog(t("Attachment preview"), "file-preview-dialog", () => {
							if (this.#preview === preview) this.#preview = undefined;
						});
						this.#preview = preview;
						const body = h(
							"div",
							{ class: "file-preview-placeholder", role: "status" },
							icon(attachment.kind === "image" ? "image" : "file"),
							h("p", null, load ? t("Loading preview…") : t("Preview is not available yet.")),
						);
						preview.content.append(
							h("h2", null, attachment.name),
							body,
							attachment.bytes !== undefined
								? h("p", { class: "muted" }, fmtBytes(attachment.bytes))
								: h("p", { class: "muted" }, t("File size unavailable")),
						);
						preview.open();
						if (!load) return;
						pending = true;
						try {
							if (!url) {
								const blob = await load(message.id, index, this.#lifetime.signal);
								if (this.#lifetime.signal.aborted) return;
								if (!blob.size || blob.size > 25 * 1024 * 1024 || !SAFE_IMAGES.has(blob.type)) {
									status.textContent = t("Preview unavailable");
									if (this.#preview === preview)
										replace(body, icon("file"), h("p", null, t("Preview is not available for this file.")));
									return;
								}
								url = URL.createObjectURL(blob);
								this.#urls.add(url);
							}
							const thumbnail = h("img", { src: url, alt: "" });
							thumbnail.onerror = () => {
								status.textContent = t("Preview failed · retry");
								if (url) {
									URL.revokeObjectURL(url);
									this.#urls.delete(url);
									url = undefined;
								}
								replace(visual, icon("image"));
							};
							replace(visual, thumbnail);
							status.textContent = t("Open preview");
							if (this.#preview === preview) {
								const image = h("img", { src: url, alt: attachment.name });
								image.onerror = () =>
									replace(body, icon("image"), h("p", null, t("This image could not be displayed.")));
								replace(body, image);
							}
						} catch {
							if (!this.#lifetime.signal.aborted) {
								status.textContent = t("Preview failed · retry");
								if (this.#preview === preview)
									replace(
										body,
										icon("file"),
										h("p", null, t("The preview could not be loaded. Close and reopen it to retry.")),
									);
							}
						} finally {
							pending = false;
						}
					},
				},
				visual,
				h(
					"span",
					{ class: "received-file-copy" },
					h("strong", null, attachment.name),
					attachment.bytes !== undefined ? h("small", null, fmtBytes(attachment.bytes)) : null,
					status,
				),
			);
			this.el.append(card);
		});
	}
	dispose(): void {
		this.#lifetime.abort();
		this.#preview?.close(false);
		for (const url of this.#urls) URL.revokeObjectURL(url);
		this.#urls.clear();
	}
}
