import { PROGRAM_KINDS, type ProgramKind } from "@qorpera/cloud-client/app-program";
import { fmtBytes, h, replace } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";
import {
	type DropProblem,
	type DroppedFile,
	PROGRAM_ADD_MAX_BYTES,
	ProgramAdd,
	type ProgramAddFolder,
	type ProgramAddRefusal,
	type ProgramTarget,
	programFolderName,
	programNameOf,
	readDrop,
	refusalOf,
	sameKind,
} from "../program-add.ts";
import { isPhoneSystem, memberSystem, PROGRAM_KIND_NAMES } from "../program-download.ts";

export interface ProgramAddHost {
	readonly writer: () => ProgramAddFolder;
	readonly userId: string;
	readonly canWrite: () => boolean;
	readonly companyName: () => string;
	readonly appNames: () => readonly string[];
	readonly opened: (folder: string) => void;
	readonly cofounder?: () => HTMLElement | null;
	readonly system?: ProgramKind | null;
}

export type ProgramDropTarget =
	| { readonly kind: "new" }
	| { readonly kind: "version"; readonly folder: string; readonly name: string };

const initialOf = (name: string) => [...name.trim()][0]?.toUpperCase() ?? "?";

export function hasFiles(event: DragEvent): boolean {
	return [...(event.dataTransfer?.types ?? [])].includes("Files");
}

export class ProgramDrop {
	readonly el = h("div", { class: "program-drop" });
	readonly #host: ProgramAddHost;
	readonly #target: ProgramDropTarget;
	readonly #done: (folder: string) => void;
	readonly #phone: boolean;
	readonly #input: HTMLInputElement;
	#files: DroppedFile[] = [];
	#add: { readonly add: ProgramAdd; readonly target: ProgramTarget } | undefined;
	#run: AbortController | undefined;
	#going = false;
	#disposed = false;

	readonly #onGoing: ((going: boolean) => void) | undefined;

	constructor(
		host: ProgramAddHost,
		target: ProgramDropTarget,
		done: (folder: string) => void,
		onGoing?: (going: boolean) => void,
	) {
		this.#host = host;
		this.#target = target;
		this.#done = done;
		this.#onGoing = onGoing;
		this.#phone = isPhoneSystem(host.system !== undefined ? host.system : memberSystem(navigator));
		this.#input = h("input", {
			type: "file",
			multiple: true,
			hidden: true,
			tabindex: "-1",
			onchange: () => {
				const files = [...(this.#input.files ?? [])];
				this.#input.value = "";
				this.take(files);
			},
		});
		this.el.addEventListener("dragover", (event) => {
			if (!hasFiles(event) || this.#going) return;
			event.preventDefault();
			this.el.classList.add("is-over");
		});
		this.el.addEventListener("dragleave", (event) => {
			if (!this.el.contains(event.relatedTarget as Node | null)) this.el.classList.remove("is-over");
		});
		this.el.addEventListener("drop", (event) => {
			if (!hasFiles(event)) return;
			event.preventDefault();
			event.stopPropagation();
			this.el.classList.remove("is-over");
			if (!this.#going) this.take([...(event.dataTransfer?.files ?? [])]);
		});
		this.#idle();
	}

	get going(): boolean {
		return this.#going;
	}

	take(files: readonly File[]): void {
		if (this.#going || this.#disposed) return;
		const read = readDrop(files);
		if ("problem" in read) {
			if (read.problem !== "none") this.#idle(this.#problem(read));
			return;
		}
		this.#files = read.files;
		this.#next();
	}

	dispose(): void {
		this.#disposed = true;
		this.#stop();
		this.el.remove();
	}

	#problem(read: DropProblem): string {
		switch (read.problem) {
			case "many":
				return t("Drop at most five files, one for each kind.");
			case "empty":
				return t("{name} is empty.", { name: read.name });
			case "large":
				return t("{size}: too large. The most is {most}.", {
					size: fmtBytes(read.bytes),
					most: fmtBytes(PROGRAM_ADD_MAX_BYTES),
				});
			case "name":
				return t("{name} can't be used as it is named. Rename the file and drop it again.", { name: read.name });
			case "twice":
				return t("Two files for {kind}: drop one for each kind.", { kind: PROGRAM_KIND_NAMES[read.kind] });
			default:
				return "";
		}
	}

	#choose(): void {
		this.#input.click();
	}

	#idle(problem?: string): void {
		this.#going = false;
		this.#onGoing?.(false);
		this.el.classList.remove("is-going", "is-asking");
		this.el.classList.toggle("is-phone", this.#phone);
		const line = problem ? h("p", { class: "program-drop-problem", role: "status" }, problem) : null;
		replace(
			this.el,
			this.#phone
				? h(
						"button",
						{ type: "button", class: "program-drop-area", onclick: () => this.#choose() },
						h("span", { class: "program-drop-line" }, t("Choose a program")),
						line,
					)
				: h(
						"div",
						{ class: "program-drop-area" },
						h("p", { class: "program-drop-line" }, t("Drop a program here")),
						h(
							"button",
							{ type: "button", class: "program-drop-choose", onclick: () => this.#choose() },
							t("or choose a file"),
						),
						line,
					),
			this.#input,
		);
	}

	#tile(name: string, file: string, bytes: number, share: number | null): HTMLElement {
		return h(
			"div",
			{
				class: "program-tile program-drop-tile",
				...(share === null ? {} : { style: `--share: ${share}%` }),
			},
			h(
				"span",
				{ class: "program-tile-mark", "aria-hidden": "true" },
				h("span", { class: "program-tile-initial" }, initialOf(name)),
			),
			h("span", { class: "program-tile-file" }, h("strong", null, file), h("small", null, fmtBytes(bytes))),
		);
	}

	#programName(): string {
		return this.#target.kind === "version" ? this.#target.name : programNameOf(this.#files[0]?.file.name ?? "");
	}

	#next(): void {
		const unknown = this.#files.find((each) => each.kind === null);
		if (!unknown) {
			void this.#start();
			return;
		}
		this.el.classList.add("is-asking");
		this.el.classList.remove("is-going");
		const answer = (kind: ProgramKind) => {
			const files = this.#files.map((each) => (each === unknown ? { file: each.file, kind } : each));
			const twice = sameKind(files);
			if (twice) {
				this.#files = [];
				this.#idle(t("Two files for {kind}: drop one for each kind.", { kind: PROGRAM_KIND_NAMES[twice] }));
				return;
			}
			this.#files = files;
			this.#next();
		};
		replace(
			this.el,
			h(
				"div",
				{ class: "program-drop-question" },
				this.#tile(this.#programName(), unknown.file.name, unknown.file.size, null),
				h("p", { class: "program-drop-ask", id: "program-drop-ask" }, t("What is it for?")),
				h(
					"div",
					{ class: "program-kinds", role: "group", "aria-labelledby": "program-drop-ask" },
					PROGRAM_KINDS.map((kind) =>
						h(
							"button",
							{
								type: "button",
								class: "program-kind is-choice",
								"data-kind": kind,
								onclick: () => answer(kind),
							},
							PROGRAM_KIND_NAMES[kind],
						),
					),
				),
				h(
					"button",
					{
						type: "button",
						class: "program-back-button",
						onclick: () => {
							this.#files = [];
							this.#idle();
						},
					},
					t("Not this one"),
				),
			),
		);
		this.el.querySelector<HTMLButtonElement>(".program-kind")?.focus({ preventScroll: true });
	}

	async #start(): Promise<void> {
		const files = this.#files.map((each) => ({ file: each.file, kind: each.kind as ProgramKind }));
		if (!this.#add) {
			const name = this.#programName();
			const target: ProgramTarget =
				this.#target.kind === "version"
					? { folder: this.#target.folder, name, isNew: false }
					: { folder: programFolderName(name, new Set(this.#host.appNames())), name, isNew: true };
			this.#add = { add: new ProgramAdd(this.#host.writer, target), target };
		}
		const { add, target } = this.#add;
		const run = new AbortController();
		this.#run = run;
		this.#going = true;
		this.#onGoing?.(true);
		this.el.classList.add("is-going");
		this.el.classList.remove("is-asking", "is-over");
		const first = files[0]!.file;
		const label =
			files.length > 1 ? t("{name} and {count} more", { name: first.name, count: files.length - 1 }) : first.name;
		const total = files.reduce((sum, each) => sum + each.file.size, 0);
		const tile = this.#tile(target.name, label, total, 0);
		const line = h("span", { class: "program-drop-progress" });
		const stop = h(
			"button",
			{ type: "button", class: "program-back-button", onclick: () => this.#stop(true) },
			t("Stop"),
		);
		const say = (share: number) => {
			tile.style.setProperty("--share", `${share}%`);
			line.textContent = t("Putting {name} in place… {percent}%", { name: first.name, percent: share });
		};
		say(0);
		replace(
			this.el,
			h(
				"div",
				{ class: "program-drop-going" },
				tile,
				h("p", { class: "program-drop-status", role: "status" }, line, stop),
			),
		);
		try {
			await add.run({
				target,
				files,
				userId: this.#host.userId,
				signal: run.signal,
				taken: this.#host.appNames(),
				onSettling: () => stop.remove(),
				onProgress: (sent, of) => {
					if (!run.signal.aborted) say(of > 0 ? Math.min(99, Math.floor((sent / of) * 100)) : 0);
				},
			});
			if (run.signal.aborted) return;
			say(100);
			this.#going = false;
			this.#add = undefined;
			this.#files = [];
			this.#done(add.folder);
		} catch (error) {
			if (run.signal.aborted || this.#disposed) return;
			this.#failed(refusalOf(error));
		}
	}

	#failed(refusal: ProgramAddRefusal): void {
		this.#going = false;
		this.#onGoing?.(false);
		const words: Record<ProgramAddRefusal["reason"], string> = {
			full: t("This program holds as many versions as it can."),
			denied: t("You can't add programs in this company."),
			paused: t("The company is paused. Add the program when it runs again."),
			busy: t("Another program of yours is still going up. Try again in a moment."),
			taken: t("Someone added to this program at the same moment. Try again."),
			exists: t("That version already has this file."),
			same: t("This is the version that is already here."),
			refused: refusal.why
				? t("The company folder refused this file: {reason}.", { reason: refusal.why })
				: t("The company folder refused this file."),
			unusable: t("This file can't be put in place as it is named. Rename it and drop it again."),
			gone: t("This program's program.json can't be read."),
			offline: t("The connection dropped."),
		};
		const again = ["busy", "taken", "offline"].includes(refusal.reason);
		const line = h(
			"p",
			{ class: "program-drop-status is-said", role: "status" },
			h("span", null, words[refusal.reason]),
			again
				? h(
						"button",
						{ type: "button", class: "program-back-button", onclick: () => void this.#start() },
						t("Try again"),
					)
				: null,
			h("button", { type: "button", class: "program-back-button", onclick: () => this.#stop(true) }, t("Cancel")),
		);
		const tile = this.el.querySelector(".program-drop-tile");
		replace(this.el, h("div", { class: "program-drop-going" }, tile, line));
		this.el.classList.add("is-going");
	}

	#stop(again = false): void {
		this.#run?.abort();
		this.#run = undefined;
		const add = this.#add?.add;
		this.#add = undefined;
		this.#files = [];
		this.#going = false;
		void add?.discard();
		if (again && !this.#disposed) this.#idle();
	}
}

export class NewProgramPage {
	readonly el: HTMLElement;
	readonly #drop: ProgramDrop;

	constructor(host: ProgramAddHost) {
		const company = host.companyName();
		const say = h(
			"div",
			{ class: "text" },
			t("Made something yourself? Drop it here and everyone in {company} can get it.", { company }),
		);
		this.#drop = new ProgramDrop(
			host,
			{ kind: "new" },
			(folder) => host.opened(folder),
			(going) => {
				say.textContent = going
					? t("Putting it in place for everyone in {company}.", { company })
					: t("Made something yourself? Drop it here and everyone in {company} can get it.", { company });
			},
		);
		const figure = host.cofounder?.() ?? null;
		this.el = h(
			"div",
			{ class: "program-page is-new" },
			h("header", { class: "program-head" }, h("h1", { class: "program-name is-muted" }, t("New program"))),
			h(
				"div",
				{ class: "program-field is-adding" },
				this.#drop.el,
				figure ? h("div", { class: "program-say" }, figure, h("div", { class: "bubble" }, say)) : null,
			),
		);
	}

	dispose(): void {
		this.#drop.dispose();
		this.el.remove();
	}
}
