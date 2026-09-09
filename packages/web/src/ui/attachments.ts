import { SurfaceDialog } from "./dialog.ts";
import { fmtBytes, h, icon, replace } from "./dom.ts";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

/** Selected bytes remain local. This component has no upload or send path. */
export class AttachmentTray {
	readonly el = h("div", { class: "attachment-tray", "aria-label": "Selected attachments" });
	readonly status = h("div", { class: "attachment-status", role: "status" });
	readonly #change: (files: File[]) => void;
	#files: File[];
	#urls: string[] = [];
	#preview: SurfaceDialog | undefined;
	#locked = false;
	constructor(files: File[], change: (files: File[]) => void) {
		this.#files = [...files];
		this.#change = change;
		this.#render();
	}
	get count(): number {
		return this.#files.length;
	}
	add(files: File[]): void {
		if (this.#locked) return;
		let error = "";
		const next = [...this.#files];
		for (const file of files) {
			if (!file.size) {
				error = "Empty files cannot be attached.";
				continue;
			}
			if (file.size > MAX_FILE_BYTES) {
				error = "Each file must be 10 MB or smaller.";
				continue;
			}
			if (next.length >= 8 || next.reduce((total, item) => total + item.size, file.size) > MAX_TOTAL_BYTES) {
				error = "Choose up to 8 files, totaling no more than 25 MB.";
				continue;
			}
			next.push(file);
		}
		this.#files = next;
		this.#render();
		if (error) this.status.textContent = error;
		this.#change([...next]);
	}
	sync(files: readonly File[], locked: boolean, message?: string): void {
		if (files.length !== this.#files.length || files.some((file, index) => file !== this.#files[index])) {
			this.#files = [...files];
			this.#render();
		}
		this.#locked = locked;
		for (const remove of this.el.querySelectorAll<HTMLButtonElement>(".attachment-remove")) remove.disabled = locked;
		if (message !== undefined) this.status.textContent = this.count ? message : "";
	}
	dispose(): void {
		this.#preview?.close(false);
		for (const url of this.#urls) URL.revokeObjectURL(url);
		this.#urls = [];
	}
	#render(): void {
		this.dispose();
		replace(
			this.el,
			...this.#files.map((file, index) => {
				const isImage = IMAGE_TYPES.has(file.type);
				const url = isImage ? URL.createObjectURL(file) : undefined;
				if (url) this.#urls.push(url);
				const preview = h(
					"button",
					{
						type: "button",
						class: "attachment-preview",
						"aria-label": `Preview ${file.name}`,
						onclick: () => {
							this.#preview = new SurfaceDialog("File preview", "file-preview-dialog", () => {
								this.#preview = undefined;
							});
							this.#preview.content.append(
								h("h2", null, file.name),
								url
									? h("img", { src: url, alt: file.name })
									: h(
											"div",
											{ class: "file-preview-placeholder" },
											icon("file"),
											h("p", null, "Preview is not available for this file type."),
										),
								h("p", { class: "muted" }, `${fmtBytes(file.size)} · Selected on this device`),
							);
							this.#preview.open();
						},
					},
					url ? h("img", { src: url, alt: "" }) : icon("file"),
					h("span", null, file.name),
				);
				return h(
					"div",
					{ class: "attachment-chip" },
					preview,
					h(
						"button",
						{
							type: "button",
							class: "attachment-remove icon-button",
							"aria-label": `Remove ${file.name}`,
							onclick: () => {
								if (this.#locked) return;
								this.#files = this.#files.filter((_, itemIndex) => itemIndex !== index);
								this.#render();
								this.#change([...this.#files]);
								this.el.querySelector<HTMLButtonElement>("button")?.focus();
							},
						},
						icon("close"),
					),
				);
			}),
		);
		this.el.hidden = this.#files.length === 0;
		this.status.textContent = this.#files.length
			? "Attachments stay on this device. Sending attachments is not available yet."
			: "";
	}
}
