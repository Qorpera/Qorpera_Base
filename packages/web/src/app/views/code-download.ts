import type { CloudMemberFolderClient } from "@qorpera/cloud-client/cloud-member-folder";
import { CloudRpcError } from "../../cloud/client.ts";
import type {
	CodeDownload as CodeDownloadAnswer,
	CodeDownloadCalls,
	CodeDownloadKind,
	CodeRepositories,
} from "../../cloud/code-downloads.ts";
import { openContextMenu } from "../../ui/context-menu.ts";
import { button, h, icon, replace } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";
import { uiScale } from "../../ui/scale.ts";

/* "Download the code" in Storage (own code storage, step 2b). On a folder of a repository kept in Qorpera
 * (code/<owner>/<name> and below), an owner or admin gets a button in the folder's top line. Its menu offers the files
 * as they are now, or the files with their full history for a developer. The code host then makes one file of it in
 * the company folder; the web waits for it, reads it piece by piece and hands it to the browser. One line under the
 * top line says what is happening and how it ended: once the file is handed over, that it is ready and the browser
 * saves it (the page cannot know when the browser has). The member's words never name git's own. The company's code
 * list read here is the import's too (code-import.ts): it draws from what each read brings. */

type Folder = Pick<CloudMemberFolderClient, "read" | "readFilePieces">;

/** What the button needs from the folder browser it sits in. */
export interface CodeDownloadHost {
	/** Ends with the browser. */
	readonly signal: AbortSignal;
	/** Throws once the company, the member or their rights are no longer the ones the browser opened with. */
	live(): void;
	calls(): CodeDownloadCalls;
	folder(): Folder;
	/** Hands the browser a file, as the pieces it was read in. */
	offer(name: string, pieces: readonly Blob[], bytes: number): void;
	wholeFolder?(): void;
	folderBusy?(): boolean;
	drawn?(): void;
}

interface Repository {
	readonly owner: string;
	readonly name: string;
}

/** How often the web asks whether the file is made, and for how long. */
const POLL_MS = 2000;
const WAIT_MS = 10 * 60_000;
/** A lost answer is asked for again this many times in a row before the wait gives up. */
const LOST_ANSWERS = 3;
/** A folder under code/ that is not among the company's repositories is asked about again after this long. */
const MISSED_MS = 60_000;

/** A download that is no longer being made. */
type Settled = Exclude<CodeDownloadAnswer, { state: "queued" | "running" }>;

/** The repository a folder belongs to: code/<owner>/<name>, or anything below it. */
function repositoryOf(dir: string): Repository | null {
	const [top, owner, name] = dir.split("/");
	return top === "code" && owner && name ? { owner, name } : null;
}

const keyOf = (repository: Repository) => `${repository.owner}/${repository.name}`;

/** Waits, unless the signal ends first. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const stop = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", stop);
			resolve();
		}, ms);
		signal.addEventListener("abort", stop, { once: true });
	});
}

export class CodeDownload {
	/** The button, for the folder's top line. Hidden wherever there is nothing to download. */
	readonly button: HTMLButtonElement;
	/** What the download is doing, or how it ended: a line of its own under the top line. */
	readonly line = h("div", { class: "storage-code-line", role: "status" });
	readonly #host: CodeDownloadHost;
	/** Null once the cloud is known not to have the calls: nothing is offered, and nothing is asked again. */
	#calls: CodeDownloadCalls | null | undefined;
	#list: CodeRepositories | undefined;
	#listing = false;
	/** When the list was last read. */
	#readAt = Number.NEGATIVE_INFINITY;
	/** Reads asked so far, and which of them the list is from. */
	#reads = 0;
	#readNumber = 0;
	/** When a repository's folder was last asked about and was not among the company's, by owner/name. */
	readonly #missed = new Map<string, number>();
	/** Told after each read of the list, whoever asked for it. */
	onRead: (() => void) | undefined;
	#dir: string | undefined;
	/** The repository whose folder is open, if one is. */
	#here: Repository | null = null;
	/** The download being made or read; one at a time. */
	#job: AbortController | null = null;
	/** How the last download ended and whose it was. It is said where the member is then, and stays until they open
	 * a folder outside that repository or start another. */
	#ended: { readonly key: string; readonly text: string } | null = null;

	constructor(host: CodeDownloadHost) {
		this.#host = host;
		this.button = h(
			"button",
			{
				type: "button",
				class: "storage-code-button",
				"aria-haspopup": "menu",
				"aria-expanded": "false",
				hidden: true,
			},
			icon("download"),
			h("span", null, t("Download the code")),
			icon("chevron-down"),
		);
		// A press on the button while its menu is open only shuts the menu: the menu names the press that shut it, and
		// the click that press ends in opens nothing. A click from the keyboard has no press before it.
		let shutBy: Event | undefined;
		let shuts = false;
		this.button.addEventListener("pointerdown", (event) => {
			shuts = event === shutBy;
		});
		this.button.addEventListener("click", (event) => {
			const shut = shuts && event.detail > 0;
			shuts = false;
			const here = this.#here;
			if (shut || !here || this.#busy()) return;
			const box = this.button.getBoundingClientRect();
			openContextMenu({
				label: t("Download the code"),
				x: box.left,
				y: box.bottom + 4 * uiScale(),
				opener: this.button,
				onClose: (press) => {
					shutBy = press;
					this.button.setAttribute("aria-expanded", "false");
				},
				items: [
					{
						label: t("The files"),
						hint: t("Everything as it is now, in one file"),
						icon: "file",
						select: () => void this.#download(here, "files"),
					},
					{
						label: t("With full history"),
						hint: t("For a developer"),
						icon: "clock",
						select: () => void this.#download(here, "history"),
					},
					...(this.#host.wholeFolder
						? [
								{
									label: t("The whole folder"),
									hint: t("Everything in this folder, in one file"),
									icon: "folder",
									select: () => this.#wholeFolder(),
								},
							]
						: []),
				],
			});
			this.button.setAttribute("aria-expanded", "true");
		});
	}

	/** The folder now open. On a repository's folder the company's repositories are asked for, once, and the button
	 * shows when this one is among them and the member may download it. */
	enter(dir: string): void {
		const here = repositoryOf(dir);
		// The same folder read again (a sync) moves nothing: what was said stays.
		const moved = dir !== this.#dir;
		this.#dir = dir;
		this.#here = here;
		if (moved && this.#ended && (!here || keyOf(here) !== this.#ended.key)) this.#ended = null;
		this.#draw();
		if (here) void this.#ask(here);
	}

	/** The company's code as last read; undefined before a read answered. */
	get list(): CodeRepositories | undefined {
		return this.#list;
	}

	/** How long ago the list was last read, in milliseconds. */
	get age(): number {
		return Date.now() - this.#readAt;
	}

	/** The reads asked so far; `readNumber` above a count taken before tells that the list is from a later read. */
	get reads(): number {
		return this.#reads;
	}

	/** Which read the list is from: 0 before any answered. */
	get readNumber(): number {
		return this.#readNumber;
	}

	/** False once the cloud is known not to have the calls. */
	get offered(): boolean {
		return this.#calls !== null;
	}

	/** Reads the list again now, for the import, unless a read is out (its end tells the same). Answers whether it was
	 * read; undefined when none was asked. */
	async refresh(): Promise<boolean | undefined> {
		if (this.#calls === null || this.#listing || this.#host.signal.aborted) return undefined;
		const read = (await this.#read()) !== undefined;
		if (this.#host.signal.aborted) return read;
		this.#draw();
		this.onRead?.();
		return read;
	}

	/** One read of the list; undefined when it was not read. A cloud from before the calls offers nothing, for good;
	 * anything else is asked again later. */
	async #read(): Promise<CodeRepositories | undefined> {
		this.#listing = true;
		// A read tells what was so when it was asked: its age counts from then.
		const asked = Date.now();
		const number = ++this.#reads;
		try {
			this.#calls ??= this.#host.calls();
			const list = await this.#calls.list(this.#host.signal);
			this.#host.live();
			this.#list = list;
			this.#readAt = asked;
			this.#readNumber = number;
			return list;
		} catch (error) {
			if (error instanceof CloudRpcError && error.missing) this.#calls = null;
			return undefined;
		} finally {
			this.#listing = false;
		}
	}

	/** Reads the company's repositories, unless they are known to hold this one or were asked a moment ago. */
	async #ask(here: Repository): Promise<void> {
		if (this.#calls === null || this.#listing || this.#host.signal.aborted) return;
		const key = keyOf(here);
		if (this.#list?.repositories.some((repository) => keyOf(repository) === key)) return;
		if (Date.now() - (this.#missed.get(key) ?? Number.NEGATIVE_INFINITY) < MISSED_MS) return;
		const list = await this.#read();
		if (list && !list.repositories.some((repository) => keyOf(repository) === key)) this.#missed.set(key, Date.now());
		if (this.#host.signal.aborted) return;
		this.#draw();
		this.onRead?.();
		// Another repository's folder was opened while this one was asked about.
		if (this.#here && keyOf(this.#here) !== key) void this.#ask(this.#here);
	}

	redraw(): void {
		this.#draw();
	}

	#busy(): boolean {
		return this.#job !== null || this.#host.folderBusy?.() === true;
	}

	#wholeFolder(): void {
		if (this.#busy()) return;
		this.#ended = null;
		this.#draw();
		this.#host.wholeFolder?.();
	}

	#draw(): void {
		const here = this.#here;
		const key = here ? keyOf(here) : null;
		this.button.hidden = !(
			key !== null &&
			this.#calls != null &&
			this.#list?.canDownload === true &&
			this.#list.repositories.some((repository) => keyOf(repository) === key)
		);
		// Not `disabled`: the button keeps the focus the menu handed back to it while the download runs.
		if (this.#busy()) this.button.setAttribute("aria-disabled", "true");
		else this.button.removeAttribute("aria-disabled");
		if (!this.#job) replace(this.line, this.#ended ? h("span", null, this.#ended.text) : null);
		this.#host.drawn?.();
	}

	/** The line while a download runs: what is being done, and Cancel. Answers how to say how far a large file is,
	 * which changes nothing else in the line. */
	#working(words: string): (part: number) => void {
		const percent = h("span", { class: "storage-code-percent", "aria-hidden": "true" });
		replace(
			this.line,
			h("span", { class: "spinner-dot", "aria-hidden": "true" }),
			h("span", null, words),
			percent,
			button(t("Cancel"), () => this.#job?.abort(), { small: true }),
		);
		return (part) => {
			percent.textContent = t("{percent}%", { percent: Math.round(part * 100) });
		};
	}

	async #download(repository: Repository, kind: CodeDownloadKind): Promise<void> {
		const calls = this.#calls;
		if (this.#job || !calls || this.#host.signal.aborted) return;
		const job = new AbortController();
		this.#job = job;
		this.#ended = null;
		this.#draw();
		const signal = AbortSignal.any([this.#host.signal, job.signal]);
		let text = "";
		try {
			text = await this.#make(calls, repository, kind, signal);
		} catch (error) {
			// Cancelled, or the browser is gone: nothing is said.
			if (!signal.aborted) {
				if (error instanceof CloudRpcError && error.missing) this.#calls = null;
				else text = t("The code could not be made ready just now. Try again.");
			}
		}
		this.#job = null;
		if (this.#host.signal.aborted) return;
		this.#ended = text ? { key: keyOf(repository), text } : null;
		this.#draw();
	}

	/** How a download stands once it is no longer being made, asked every two seconds from its first answer on. Null
	 * when it is still being made after ten minutes. */
	async #settled(calls: CodeDownloadCalls, first: CodeDownloadAnswer, signal: AbortSignal): Promise<Settled | null> {
		this.#host.live();
		const until = Date.now() + WAIT_MS;
		let answer = first;
		let lost = 0;
		for (;;) {
			if (answer.state !== "queued" && answer.state !== "running") return answer;
			if (Date.now() >= until) return null;
			await pause(POLL_MS, signal);
			try {
				answer = await calls.read(answer.requestId, signal);
				lost = 0;
			} catch (error) {
				// A lost answer does not end the wait. A refusal does, and so does a request that is not there.
				const refused = error instanceof CloudRpcError && (error.missing || error.denied || error.code === "P0002");
				if (signal.aborted || refused || ++lost === LOST_ANSWERS) throw error;
			}
			this.#host.live();
		}
	}

	/** Asks for the file, waits while it is made, reads it and hands it to the browser. Answers what to say then. */
	async #make(
		calls: CodeDownloadCalls,
		repository: Repository,
		kind: CodeDownloadKind,
		signal: AbortSignal,
	): Promise<string> {
		this.#working(t("Getting the code ready…"));
		const answer = await this.#settled(
			calls,
			await calls.request(repository.owner, repository.name, kind, signal),
			signal,
		);
		if (answer === null) return t("The code is not ready yet. Try again in a little while.");
		if (answer.state !== "ready") {
			if (answer.reason === "too_large")
				return t("This code is too large to download here (over 200 MB). Write to Qorpera and we will send it.");
			if (answer.reason === "busy")
				return t("The agents are working on the code right now. Try again in a little while.");
			if (answer.reason === "too_many")
				return t("The code has been downloaded many times today. Try again tomorrow.");
			return t("The code could not be made ready just now. Try again.");
		}
		// The file stands in the repository's own downloads folder, under the name the browser gets.
		const folder = `code/${repository.owner}/${repository.name}/downloads/`;
		const name = answer.path.slice(folder.length);
		if (!answer.path.startsWith(folder) || !name || name.includes("/")) throw new Error("Invalid code download");
		const files = this.#host.folder();
		const read = await files.read(answer.path, signal);
		this.#host.live();
		const file = read.entry?.file;
		if (!file) return t("The code could not be made ready just now. Try again.");
		const far = this.#working(t("Downloading the code…"));
		const pieces: Blob[] = [];
		try {
			await files.readFilePieces(file, signal, (piece, index, count) => {
				pieces.push(new Blob([piece as BlobPart]));
				// A small file arrives all at once; a large one says how far it is.
				if (count > 2) far((index + 1) / count);
			});
			this.#host.live();
			this.#host.offer(name, pieces, file.bytes);
		} catch (error) {
			if (signal.aborted) throw error;
			return t("The code could not be downloaded just now. Try again.");
		}
		return t("{name} is ready: your browser saves it in your downloads.", { name });
	}
}
