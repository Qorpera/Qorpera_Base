import { writeVisionFile } from "@qorpera/cloud-client/company-state-files";
import { describeError } from "../../cloud/client.ts";
import type { WebMemberFolder } from "../../cloud/company-folder-writes.ts";
import { companyLogos } from "../../ui/company-logos.ts";
import { button, companyLogo, h, icon, notice, replace } from "../../ui/dom.ts";
import { choosePictureCrop } from "../../ui/picture-cropper.ts";
import { PictureFileError } from "../../ui/picture-file.ts";
import { phrase, t, uiText } from "../../ui/preferences.ts";

/* Settings → Company → Brand (Jonas, 9 Nov 2026): the company's official name and logo. The logo is the company folder's
 * QorperaOS/brand/logo.svg, which the company's Branding & Identity agent draws and keeps up to date; an owner or admin
 * chooses another the way they choose their own picture (fitted to a rounded square), or removes it. The name is the
 * first line of the company's vision, QorperaOS/vision/vision.md, which renaming rewrites. Colours, fonts and the brand
 * guide live in the brand folder, which a button opens in Storage. */

export const VISION_PATH = "QorperaOS/vision/vision.md";

export interface CompanyBrandOptions {
	readonly profileId: string;
	readonly name: () => string;
	/** Owners and admins change the name and the logo; everyone sees them. */
	readonly canManage: () => boolean;
	/** The company folder as the member, for each change (it re-checks the member's authority). */
	readonly folder: () => WebMemberFolder;
	readonly signal: AbortSignal;
	/** Opens the brand folder in Storage. */
	readonly openBrandFiles: () => void;
	/** Told after a rename was saved, with the new name. */
	readonly renamed: (name: string) => void;
}

/** The vision's text with `name` as its first line, `# <name>`; a vision without a heading gets one. */
export function renamedVision(text: string, name: string): string {
	const lines = text.split("\n");
	const first = lines.findIndex((line) => line.trim() !== "");
	// The shared writer's heading, so a name ending in `#` reads back whole (`# Acme # #`).
	const heading = writeVisionFile(name, "").split("\n")[0]!;
	if (first >= 0 && /^#\s/.test(lines[first]!.trim())) lines[first] = heading;
	else lines.unshift(heading, "");
	return lines.join("\n");
}

export class CompanyBrandView {
	readonly el: HTMLElement;
	readonly #options: CompanyBrandOptions;
	readonly #logoSlot = h("span", { class: "settings-brand-logo-slot" });
	readonly #logoButton: HTMLButtonElement;
	readonly #input: HTMLInputElement;
	readonly #nameSlot = h("div", { class: "settings-brand-name" });
	readonly #error = h("div", { class: "settings-brand-error" });
	readonly #menu: HTMLElement;
	#busy = false;
	#editing = false;
	/** The name just saved, shown until the company's own name follows (the cloud converges it from the vision). */
	#savedName: string | undefined;

	constructor(options: CompanyBrandOptions) {
		this.#options = options;
		this.#input = h("input", {
			type: "file",
			accept: "image/*",
			hidden: true,
			tabindex: "-1",
			"aria-hidden": "true",
		});
		this.#input.onchange = () => void this.#picked();
		this.#logoButton = h(
			"button",
			{ type: "button", class: "settings-brand-logo", "aria-haspopup": "menu", "aria-expanded": "false" },
			this.#logoSlot,
			h("span", { class: "account-picture-badge", "aria-hidden": "true" }, icon("camera")),
		);
		const choose = h(
			"button",
			{ type: "button", role: "menuitem", class: "account-picture-item", onclick: () => this.#choose() },
			icon("image"),
			h("span", null, uiText(phrase("Choose a new logo"))),
		);
		const remove = h(
			"button",
			{
				type: "button",
				role: "menuitem",
				class: "account-picture-item account-picture-remove",
				onclick: () => void this.#remove(),
			},
			icon("close"),
			h("span", null, uiText(phrase("Remove logo"))),
		);
		this.#menu = h(
			"div",
			{ class: "account-picture-menu", role: "menu", "aria-label": t("Company logo"), hidden: true },
			choose,
			remove,
		);
		this.#logoButton.onclick = () => {
			if (this.#busy) return;
			if (this.#hasLogo()) this.#setMenu(this.#menu.hidden);
			else this.#choose();
		};
		this.#menu.onkeydown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			this.#setMenu(false);
			this.#logoButton.focus();
		};
		this.el = h(
			"section",
			{ class: "settings-group settings-brand", "aria-label": t("Brand") },
			h("h2", null, uiText(phrase("Brand"))),
			h(
				"div",
				{ class: "settings-brand-row" },
				h("div", { class: "account-picture settings-brand-picture" }, this.#logoButton, this.#menu, this.#input),
				h(
					"div",
					{ class: "settings-brand-copy" },
					this.#nameSlot,
					h(
						"p",
						{ class: "settings-brand-note" },
						t(
							"Your Branding & Identity agent keeps the brand up to date. Its colours, fonts and brand guide live in the company file.",
						),
					),
					button(t("Open brand files"), () => options.openBrandFiles(), { small: true }),
				),
			),
			this.#error,
		);
		this.update();
	}

	/** Draws the logo, the name and what the member may change, again. */
	update(): void {
		if (this.#options.signal.aborted) return;
		const manage = this.#options.canManage();
		if (!this.#logoSlot.firstChild)
			replace(this.#logoSlot, companyLogo(this.#options.profileId, "settings-brand-figure"));
		this.#logoButton.disabled = !manage || this.#busy;
		this.#logoButton.classList.toggle("is-changeable", manage);
		this.#logoButton.toggleAttribute("aria-busy", this.#busy);
		const label = manage
			? this.#hasLogo()
				? t("Change the company logo")
				: t("Add a company logo")
			: t("Company logo");
		this.#logoButton.setAttribute("aria-label", label);
		this.#logoButton.title = manage ? label : "";
		if (!manage) this.#setMenu(false);
		if (this.#editing) return;
		const current = this.#options.name();
		if (this.#savedName === current) this.#savedName = undefined;
		replace(
			this.#nameSlot,
			h("strong", null, this.#savedName ?? current),
			manage ? button(t("Rename"), () => this.#startRename(), { small: true, disabled: this.#busy }) : null,
		);
	}

	#hasLogo(): boolean {
		return Boolean(companyLogos()?.logo(this.#options.profileId)?.objectName);
	}

	#setMenu(open: boolean): void {
		this.#menu.hidden = !open;
		this.#logoButton.setAttribute("aria-expanded", String(open));
		if (open) this.#menu.querySelector<HTMLElement>("[role=menuitem]")?.focus();
	}

	#choose(): void {
		this.#setMenu(false);
		this.#input.click();
	}

	async #picked(): Promise<void> {
		const file = this.#input.files?.[0];
		this.#input.value = "";
		const store = companyLogos();
		if (!file || !store || this.#busy) return;
		await this.#run(async () => {
			const crop = await choosePictureCrop(file, this.#options.signal, undefined, "square");
			if (!crop || this.#options.signal.aborted) return;
			await store.choose(this.#options.profileId, file, crop, this.#options.folder, this.#options.signal);
		}, phrase("The logo could not be saved."));
	}

	async #remove(): Promise<void> {
		this.#setMenu(false);
		const store = companyLogos();
		if (!store) return;
		await this.#run(
			() => store.remove(this.#options.profileId, this.#options.folder, this.#options.signal),
			phrase("The logo could not be removed."),
		);
	}

	#startRename(): void {
		this.#editing = true;
		const input = h("input", {
			type: "text",
			class: "settings-brand-name-input",
			value: this.#savedName ?? this.#options.name(),
			maxlength: "120",
			"aria-label": t("Company name"),
		});
		const save = () => void this.#rename(input.value);
		const cancel = () => {
			this.#editing = false;
			this.update();
		};
		input.onkeydown = (event: KeyboardEvent) => {
			if (event.isComposing) return;
			if (event.key === "Enter") {
				event.preventDefault();
				save();
			} else if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				cancel();
			}
		};
		replace(
			this.#nameSlot,
			input,
			button(t("Save"), save, { small: true, primary: true }),
			button(t("Cancel"), cancel, { small: true }),
		);
		input.focus();
		input.select();
	}

	async #rename(raw: string): Promise<void> {
		const name = raw.replace(/\s+/g, " ").trim();
		if (!name || name === this.#options.name()) {
			this.#editing = false;
			this.update();
			return;
		}
		await this.#run(async () => {
			const folder = this.#options.folder();
			const read = await folder.read(VISION_PATH, this.#options.signal);
			const file = read.entry?.file;
			if (!file || !read.entry?.version) throw new Error(t("The company's vision could not be read."));
			const text = new TextDecoder().decode(await folder.readFile(file, this.#options.signal));
			const answer = await folder.commit(
				`company-rename-${crypto.randomUUID()}`,
				[{ op: "write", path: VISION_PATH, text: renamedVision(text, name), expectedVersion: read.entry.version }],
				this.#options.signal,
			);
			if (answer.units.some((unit) => unit.outcome !== "saved"))
				throw new Error(t("The name could not be saved. Try again."));
			this.#savedName = name;
			this.#editing = false;
			this.#options.renamed(name);
		}, phrase("The name could not be saved."));
	}

	async #run(action: () => Promise<void>, failure: string): Promise<void> {
		this.#busy = true;
		replace(this.#error);
		this.update();
		try {
			await action();
		} catch (error) {
			if (this.#options.signal.aborted) return;
			replace(
				this.#error,
				notice(
					"danger",
					uiText(failure),
					" ",
					error instanceof PictureFileError ? uiText(error.message) : describeError(error),
				),
			);
		} finally {
			this.#busy = false;
			if (!this.#options.signal.aborted) this.update();
		}
	}
}
