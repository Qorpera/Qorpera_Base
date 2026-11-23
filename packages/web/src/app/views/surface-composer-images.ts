import { SESSION_IMAGE_TYPES, sessionAttachmentProblem } from "../../cloud/session-attachments.ts";
import { AttachmentTray, attachmentProblemText } from "../../ui/attachments.ts";
import { h, icon } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";

export class SurfaceComposerImages {
	readonly button: HTMLButtonElement;
	readonly tray: AttachmentTray;
	readonly #picker = h("input", {
		type: "file",
		multiple: true,
		hidden: true,
		accept: [...SESSION_IMAGE_TYPES].join(","),
		"aria-label": t("Attach images"),
	}) as HTMLInputElement;
	#files: File[] = [];
	#available = false;
	#shownProblem = "";
	readonly #changed: () => void;

	constructor(zone: HTMLElement, signal: AbortSignal, changed: () => void) {
		this.#changed = changed;
		this.tray = new AttachmentTray(
			[],
			(files) => {
				this.#files = files;
				this.#syncStatus();
				this.#changed();
			},
			"",
		);
		this.button = h(
			"button",
			{
				type: "button",
				class: "surface-attach",
				title: t("Attach images"),
				"aria-label": t("Attach images"),
				hidden: true,
			},
			icon("attach"),
		) as HTMLButtonElement;
		zone.append(this.#picker);
		this.button.addEventListener(
			"click",
			() => {
				if (this.#available) this.#picker.click();
			},
			{ signal },
		);
		this.#picker.addEventListener(
			"change",
			() => {
				this.#add([...(this.#picker.files ?? [])]);
				this.#picker.value = "";
			},
			{ signal },
		);
		zone.addEventListener(
			"paste",
			(event) => {
				const files = [...(event.clipboardData?.files ?? [])];
				if (!files.length || !this.#available) return;
				event.preventDefault();
				this.#add(files);
			},
			{ signal },
		);
		zone.addEventListener(
			"dragover",
			(event) => {
				if (!this.#available || !event.dataTransfer?.types.includes("Files")) return;
				event.preventDefault();
				zone.classList.add("is-dragging");
			},
			{ signal },
		);
		zone.addEventListener("dragleave", () => zone.classList.remove("is-dragging"), { signal });
		zone.addEventListener(
			"drop",
			(event) => {
				zone.classList.remove("is-dragging");
				if (!this.#available || !event.dataTransfer?.files.length) return;
				event.preventDefault();
				this.#add([...event.dataTransfer.files]);
			},
			{ signal },
		);
		signal.addEventListener("abort", () => this.tray.dispose(), { once: true });
	}

	get files(): readonly File[] {
		return this.#files;
	}

	get problem(): string | undefined {
		const problem = this.#files.length ? sessionAttachmentProblem(this.#files) : undefined;
		return problem && attachmentProblemText(problem);
	}

	setAvailable(available: boolean): void {
		this.#available = available;
		this.button.hidden = !available;
		if (!available && this.#files.length) this.set([]);
	}

	set(files: readonly File[]): void {
		this.#files = [...files];
		this.tray.sync(this.#files, false);
		this.#syncStatus();
		this.#changed();
	}

	#add(files: File[]): void {
		if (files.length) this.tray.add(files);
	}

	#syncStatus(): void {
		const problem = this.problem ?? "";
		if (problem) this.tray.status.textContent = problem;
		else if (this.#shownProblem && this.tray.status.textContent === this.#shownProblem)
			this.tray.status.textContent = "";
		this.#shownProblem = problem;
	}
}
