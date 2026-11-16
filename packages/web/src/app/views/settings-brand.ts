import { osPath, writeVisionFile } from "@qorpera/cloud-client/company-state-files";
import { describeError } from "../../cloud/client.ts";
import {
	rewriteStateFile,
	WebCompanyFolderRejectedError,
	type WebMemberFolder,
	withProblems,
} from "../../cloud/company-folder-writes.ts";
import { companyLogos } from "../../ui/company-logos.ts";
import { button, companyLogo, h, icon, notice, replace } from "../../ui/dom.ts";
import { choosePictureCrop } from "../../ui/picture-cropper.ts";
import { PictureFileError } from "../../ui/picture-file.ts";
import { phrase, t, uiText } from "../../ui/preferences.ts";

export const VISION_PATH = osPath("vision/vision.md");
export const COMPANY_NAME_LIMIT = 120;

export function renamedVision(text: string, name: string): string {
	const lines = text.split("\n");
	const bare = (line: string) => line.replace(/^\uFEFF/, "").replace(/\r$/, "");
	const heading = writeVisionFile(name, "").split("\n")[0]!;
	const first = lines.findIndex((line) => bare(line).trim() !== "");
	if (first >= 0 && /^# +/.test(bare(lines[first]!))) {
		const bom = lines[first]!.startsWith("\uFEFF") ? "\uFEFF" : "";
		lines[first] = `${bom}${heading}${lines[first]!.endsWith("\r") ? "\r" : ""}`;
	} else lines.unshift(heading, "");
	return lines.join("\n");
}

export function renameFailure(error: unknown): string {
	if (!(error instanceof WebCompanyFolderRejectedError)) return describeError(error);
	if (error.outcome === "denied") return t("Only someone who may change the company's files can rename it.");
	if (error.problems.length) return withProblems(t("The name was not accepted."), error.problems);
	if (error.outcome === "conflict") return t("The vision kept changing while it was saved. Try again.");
	return t("Try again.");
}

export interface CompanyBrandOptions {
	readonly profileId: string;
	readonly name: () => string;
	readonly canManage: () => boolean;
	/** The company folder as the member, for each change (it re-checks the member's authority). */
	readonly folder: () => WebMemberFolder;
	readonly signal: AbortSignal;
	readonly renamed: (name: string) => void;
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
		if (this.#editing) return;
		const current = this.#options.name();
		if (this.#savedName === current) this.#savedName = undefined;
		replace(
			this.#nameSlot,
			h("strong", null, this.#savedName ?? current),
			manage
				? h(
						"button",
						{
							type: "button",
							class: "icon-button settings-brand-rename",
							"aria-label": t("Rename the company"),
							title: t("Rename the company"),
							disabled: this.#busy,
							onclick: () => this.#startRename(),
						},
						icon("edit"),
					)
				: null,
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
			maxlength: String(COMPANY_NAME_LIMIT),
			autocomplete: "off",
			"aria-label": t("Company name"),
		});
		const controls: (HTMLInputElement | HTMLButtonElement)[] = [input];
		const hold = (held: boolean) => {
			for (const control of controls) control.disabled = held;
		};
		const save = () => void this.#rename(input.value, hold, () => input.focus());
		const cancel = () => {
			if (this.#busy) return;
			this.#editing = false;
			this.update();
			this.#nameSlot.querySelector<HTMLElement>(".settings-brand-rename")?.focus();
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
		controls.push(
			button(t("Save"), save, { small: true, primary: true }),
			button(t("Cancel"), cancel, { small: true }),
		);
		replace(this.#nameSlot, ...controls);
		input.focus();
		input.select();
	}

	async #rename(raw: string, hold: (held: boolean) => void, retry: () => void): Promise<void> {
		if (this.#busy) return;
		const name = raw.replace(/\s+/g, " ").trim();
		if (!name || name === (this.#savedName ?? this.#options.name())) {
			this.#editing = false;
			this.update();
			return;
		}
		const signal = this.#options.signal;
		hold(true);
		await this.#run(async () => {
			try {
				await rewriteStateFile(
					this.#options.folder(),
					{
						locate: async () => VISION_PATH,
						rewrite: (text) => renamedVision(text, name),
						key: () => `web:company-rename:${crypto.randomUUID()}`,
						gone: t("The company's vision could not be read."),
						failure: t("The name could not be saved."),
					},
					signal,
					() => signal.throwIfAborted(),
				);
			} catch (error) {
				if (signal.aborted) throw error;
				throw new Error(renameFailure(error));
			}
			this.#savedName = name;
			this.#editing = false;
			this.#options.renamed(name);
		}, phrase("The name could not be saved."));
		if (this.#editing && !signal.aborted) {
			hold(false);
			retry();
		}
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
