import { describeError } from "../../cloud/client.ts";
import type { WebMemberFolder } from "../../cloud/company-folder-writes.ts";
import { companyLogos } from "../../ui/company-logos.ts";
import { companyLogo, h, icon, notice, replace } from "../../ui/dom.ts";
import { choosePictureCrop } from "../../ui/picture-cropper.ts";
import { PictureFileError } from "../../ui/picture-file.ts";
import { phrase, t, uiText } from "../../ui/preferences.ts";

/* Settings → Company → Brand (Jonas, 9 Nov 2026): the company's official name and logo. The logo is the company folder's
 * QorperaOS/brand/logo.svg, which the company's Branding & Identity agent draws and keeps up to date; an owner or admin
 * chooses another the way they choose their own picture (fitted to a rounded square), or removes it. The name is the
 * first line of the company's vision and is shown, not changed here: renaming is deferred (Jonas, 9 Nov 2026), since a
 * new name also has to reach the business registry, mail and the rest. Colours, fonts and the brand guide live beside
 * the logo in the brand folder; this section shows only the official name and logo. */

export interface CompanyBrandOptions {
	readonly profileId: string;
	readonly name: () => string;
	/** Owners and admins change the logo; everyone sees it. */
	readonly canManage: () => boolean;
	/** The company folder as the member, for each change (it re-checks the member's authority). */
	readonly folder: () => WebMemberFolder;
	readonly signal: AbortSignal;
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
				h("div", { class: "settings-brand-copy" }, this.#nameSlot),
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
		replace(this.#nameSlot, h("strong", null, this.#options.name()));
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
