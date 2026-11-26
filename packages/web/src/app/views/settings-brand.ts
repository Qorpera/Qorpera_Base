import type { CloudMemberFolderUnit } from "@qorpera/cloud-client/cloud-member-folder";
import { osPath, writeVisionFile } from "@qorpera/cloud-client/company-state-files";
import { describeError } from "../../cloud/client.ts";
import {
	parseStateFile,
	rewriteStateFile,
	WebCompanyFolderRejectedError,
	type WebMemberFolder,
	withProblems,
} from "../../cloud/company-folder-writes.ts";
import { companyLogos } from "../../ui/company-logos.ts";
import { companyNameText, isUnnamed } from "../../ui/company-name.ts";
import { button, companyLogo, h, icon, notice, replace } from "../../ui/dom.ts";
import { choosePictureCrop } from "../../ui/picture-cropper.ts";
import { PictureFileError } from "../../ui/picture-file.ts";
import { phrase, t, uiText } from "../../ui/preferences.ts";

export const VISION_PATH = osPath("vision/vision.md");
export const IDENTITY_COMPANY_JSON_PATH = "identity/company.json";
export const IDENTITY_TOKENS_JSON_PATH = "identity/tokens.json";
export const IDENTITY_BRIEF_PATH = "identity/brief.md";
export const COMPANY_NAME_LIMIT = 120;

const CANONICAL_IDENTITY_MAX_BYTES = 262_144;
const RENAME_RETRIES = 3;

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

export function renamedCanonicalJson(text: string, key: "name" | "brand", nextName: string): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const record = parsed as Record<string, unknown>;
	if (typeof record[key] !== "string" || record[key] === nextName) return null;
	const trailing = text.endsWith("\n") ? "\n" : "";
	return `${JSON.stringify({ ...record, [key]: nextName }, null, 2)}${trailing}`;
}

export function renamedIdentityBrief(text: string, oldName: string, nextName: string): string | null {
	const normalizedOld = oldName.replace(/\s+/g, " ").trim();
	if (!normalizedOld) return null;
	const lines = text.split("\n");
	const bare = (line: string) => line.replace(/^\uFEFF/, "").replace(/\r$/, "");
	const first = lines.findIndex((line) => bare(line).trim() !== "");
	if (first < 0) return null;
	const match = /^# +(.+?)\s*$/.exec(bare(lines[first]!));
	if (!match) return null;
	const heading = match[1]!;
	const normalizedHeading = heading.replace(/\s+/g, " ");
	const lowerHeading = normalizedHeading.toLowerCase();
	const lowerOld = normalizedOld.toLowerCase();
	let updatedHeading: string | null = null;
	if (lowerHeading === lowerOld) {
		updatedHeading = nextName;
	} else if (lowerHeading.startsWith(lowerOld)) {
		const rest = normalizedHeading.slice(normalizedOld.length);
		if (/^\s*[—–:\-|·]\s+\S/.test(rest)) updatedHeading = `${nextName}${rest}`;
	}
	if (!updatedHeading || updatedHeading === heading) return null;
	const bom = lines[first]!.startsWith("\uFEFF") ? "\uFEFF" : "";
	const cr = lines[first]!.endsWith("\r") ? "\r" : "";
	lines[first] = `${bom}# ${updatedHeading}${cr}`;
	return lines.join("\n");
}

async function readOptionalText(
	folder: WebMemberFolder,
	path: string,
	signal: AbortSignal,
): Promise<{ version: string; text: string } | null> {
	try {
		const read = await folder.read(path, signal);
		if (!read.entry || read.entry.kind !== "file" || !read.entry.file) return null;
		if (read.entry.file.bytes > CANONICAL_IDENTITY_MAX_BYTES) return null;
		const bytes = await folder.readFile(read.entry.file, signal, CANONICAL_IDENTITY_MAX_BYTES, { cached: true });
		return {
			version: read.entry.version,
			text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
		};
	} catch (error) {
		if (signal.aborted) throw error;
		return null;
	}
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
	readonly logoChanged?: () => void;
}

export class CompanyBrandView {
	readonly el: HTMLElement;
	readonly #options: CompanyBrandOptions;
	readonly #logoSlot = h("span", { class: "settings-brand-logo-slot" });
	readonly #logoButton: HTMLButtonElement;
	readonly #input: HTMLInputElement;
	readonly #nameSlot = h("div", { class: "settings-brand-name" });
	readonly #error = h("div", { class: "settings-brand-error" });
	readonly #status = h("p", { class: "settings-brand-status muted small", role: "status", hidden: true });
	readonly #menu: HTMLElement;
	#busy = false;
	#editing = false;
	#holdRename: ((held: boolean) => void) | undefined;
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
			this.#status,
		);
		const unsubscribeLogo = companyLogos()?.subscribe?.(options.profileId, () => this.update());
		if (unsubscribeLogo) {
			if (options.signal.aborted) unsubscribeLogo();
			else options.signal.addEventListener("abort", unsubscribeLogo, { once: true });
		}
		this.update();
	}

	/** Draws the logo, the name and what the member may change, again. */
	update(): void {
		if (this.#options.signal.aborted) return;
		const manage = this.#options.canManage();
		const unnamed = isUnnamed(this.#options.name());
		if (!this.#logoSlot.firstChild || this.#logoSlot.dataset.unnamed !== String(unnamed)) {
			this.#logoSlot.dataset.unnamed = String(unnamed);
			replace(this.#logoSlot, companyLogo(this.#options.profileId, "settings-brand-figure", unnamed));
		}
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
		if (this.#editing) {
			this.#holdRename?.(this.#busy);
			return;
		}
		const current = this.#options.name();
		if (this.#savedName === current) this.#savedName = undefined;
		replace(
			this.#nameSlot,
			h("strong", null, companyNameText(this.#savedName ?? current)),
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
		const store = companyLogos();
		if (!store) return false;
		return store.hasLogo
			? store.hasLogo(this.#options.profileId)
			: Boolean(store.logo(this.#options.profileId)?.objectName);
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
			this.#options.logoChanged?.();
		}, phrase("The logo could not be saved."));
	}

	async #remove(): Promise<void> {
		this.#setMenu(false);
		const store = companyLogos();
		if (!store) return;
		await this.#run(async () => {
			await store.remove(this.#options.profileId, this.#options.folder, this.#options.signal);
			this.#options.logoChanged?.();
		}, phrase("The logo could not be removed."));
	}

	#startRename(): void {
		this.#editing = true;
		const input = h("input", {
			type: "text",
			class: "settings-brand-name-input",
			value: this.#savedName ?? (isUnnamed(this.#options.name()) ? "" : this.#options.name()),
			placeholder: t("Company name"),
			maxlength: String(COMPANY_NAME_LIMIT),
			autocomplete: "off",
			"aria-label": t("Company name"),
		});
		const controls: (HTMLInputElement | HTMLButtonElement)[] = [input];
		this.#holdRename = (held) => {
			for (const control of controls) control.disabled = held;
		};
		const save = () => void this.#rename(input.value, () => input.focus());
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
		this.#holdRename(this.#busy);
		input.focus();
		input.select();
	}

	async #rename(raw: string, retry: () => void): Promise<void> {
		if (this.#busy) return;
		const name = raw.replace(/\s+/g, " ").trim();
		if (!name || name === (this.#savedName ?? this.#options.name())) {
			this.#editing = false;
			this.update();
			return;
		}
		const signal = this.#options.signal;
		const failure = t("The name could not be saved.");
		await this.#run(async () => {
			try {
				await this.#commitRename(name, failure, signal);
			} catch (error) {
				if (signal.aborted) throw error;
				throw new Error(renameFailure(error));
			}
			this.#savedName = name;
			this.#editing = false;
			this.#options.renamed(name);
			this.#status.textContent = t("Name updated. Your Co-Founder is updating the rest of the company.");
			this.#status.hidden = false;
		}, phrase("The name could not be saved."));
		if (this.#editing && !signal.aborted) retry();
	}

	async #commitRename(name: string, failure: string, signal: AbortSignal): Promise<void> {
		const folder = this.#options.folder();
		let oldName = this.#savedName ?? this.#options.name();
		await rewriteStateFile(
			folder,
			{
				locate: async () => VISION_PATH,
				rewrite: (text) => {
					const currentVision = parseStateFile(VISION_PATH, text);
					if (currentVision.ok && currentVision.file.kind === "vision") oldName = currentVision.file.name;
					return renamedVision(text, name);
				},
				key: () => `web:company-rename:${crypto.randomUUID()}`,
				gone: t("The company's vision could not be read."),
				failure,
			},
			signal,
			() => signal.throwIfAborted(),
		);
		await this.#syncCanonicalIdentityFiles(folder, oldName, name, signal);
	}

	async #syncCanonicalIdentityFiles(
		folder: WebMemberFolder,
		oldName: string,
		name: string,
		signal: AbortSignal,
	): Promise<void> {
		type CanonicalPath =
			| typeof IDENTITY_COMPANY_JSON_PATH
			| typeof IDENTITY_TOKENS_JSON_PATH
			| typeof IDENTITY_BRIEF_PATH;
		let pending: CanonicalPath[] = [IDENTITY_COMPANY_JSON_PATH, IDENTITY_TOKENS_JSON_PATH, IDENTITY_BRIEF_PATH];
		for (let attempt = 0; attempt <= RENAME_RETRIES && pending.length > 0; attempt++) {
			if (signal.aborted) return;
			let reads: ({ version: string; text: string } | null)[];
			try {
				reads = await Promise.all(pending.map((path) => readOptionalText(folder, path, signal)));
			} catch {
				return;
			}
			if (signal.aborted) return;
			const units: CloudMemberFolderUnit[] = [];
			const unitPaths: CanonicalPath[] = [];
			for (let i = 0; i < pending.length; i++) {
				const path = pending[i]!;
				const current = reads[i];
				if (!current) continue;
				let nextText: string | null;
				switch (path) {
					case IDENTITY_COMPANY_JSON_PATH:
						nextText = renamedCanonicalJson(current.text, "name", name);
						break;
					case IDENTITY_TOKENS_JSON_PATH:
						nextText = renamedCanonicalJson(current.text, "brand", name);
						break;
					case IDENTITY_BRIEF_PATH:
						nextText = renamedIdentityBrief(current.text, oldName, name);
						break;
				}
				if (nextText === null) continue;
				units.push({ op: "write", path, text: nextText, expectedVersion: current.version });
				unitPaths.push(path);
			}
			if (units.length === 0) return;
			let answer: Awaited<ReturnType<WebMemberFolder["commit"]>>;
			try {
				answer = await folder.commit(`web:company-rename-identity:${crypto.randomUUID()}`, units, signal);
			} catch {
				return;
			}
			if (signal.aborted) return;
			const retry: CanonicalPath[] = [];
			for (let i = 0; i < unitPaths.length; i++) {
				const result = answer.units[i];
				if (result?.outcome === "conflict" && result.reason === "version_changed") {
					retry.push(unitPaths[i]!);
				}
			}
			pending = retry;
		}
	}

	async #run(action: () => Promise<void>, failure: string): Promise<void> {
		this.#busy = true;
		replace(this.#error);
		this.#status.hidden = true;
		this.#status.textContent = "";
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
