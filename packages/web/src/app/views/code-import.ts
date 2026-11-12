import { CloudRpcError } from "../../cloud/client.ts";
import type {
	CodeBringing,
	CodeDownloadCalls,
	CodeImportAnswer,
	CodeImported,
	CodeRepositories,
} from "../../cloud/code-downloads.ts";
import { button, h, icon, replace } from "../../ui/dom.ts";
import { leave } from "../../ui/motion.ts";
import { presentationLocale, t, timeZoneOption } from "../../ui/preferences.ts";

/* "Bring code in" in Storage (own code storage, step 6; migration 20260930736000). In the company's code folder and in
 * each owner's folder under it, an owner or admin brings a GitHub project in: one question, its GitHub address, and the
 * project lands at code/<owner>/<name>, its owner and name in lower case. On the folder of a GitHub copy the button
 * brings that copy's project in, after one question. One line under the top line says what the folder is or how the
 * import stands: being brought in, step by step (read from the company's code list, again every few seconds while one
 * runs, so it outlives a reload); brought in, in its folder; or not brought in, and why. A question whose answer never
 * came claims no outcome: the page reads the list until it shows one. Nothing of it shows on a cloud whose list has no
 * `bringing` key. The member's words name no path, branch, commit, code or request. */

/** The company's code list, as "Download the code" reads and keeps it (code-download.ts). */
export interface CodeListSource {
	readonly list: CodeRepositories | undefined;
	/** How long ago it was read, in milliseconds. */
	readonly age: number;
	/** The reads asked so far, and which of them the list is from. */
	readonly reads: number;
	readonly readNumber: number;
	/** False once the cloud is known not to have the calls. */
	readonly offered: boolean;
	/** Reads it again; whether it was read, undefined when no read was asked. */
	refresh(): Promise<boolean | undefined>;
	/** Told after each read. */
	onRead: (() => void) | undefined;
}

/** What the import needs from the folder browser it sits in. */
export interface CodeImportHost {
	/** Ends with the browser. */
	readonly signal: AbortSignal;
	/** Throws once the company, the member or their rights are no longer the ones the browser opened with. */
	live(): void;
	calls(): CodeDownloadCalls;
	readonly code: CodeListSource;
	/** Opens a folder of the company's in Storage. */
	open(path: string): void;
}

/** A GitHub project and where it lands. */
export interface CodeImportTarget {
	/** The place, code/<owner>/<name>, in lower case. */
	readonly owner: string;
	readonly name: string;
	/** The project as GitHub spells it: Owner/Name. */
	readonly github: string;
	/** How the member reads its name: GitHub's spelling of it. */
	readonly label: string;
}

/** An import this page follows: one it asked for, or one the list showed being brought in. */
interface Followed extends Omit<CodeImportTarget, "github"> {
	readonly github: string | null;
	/** `sending`: the ask is out. `started`: on its way (the list showed it, or the answer said so). `unknown`: the
	 * answer never came, and no read since says how it stands. `unsure`: a read since shows nothing of it. `unreachable`:
	 * the reads since failed too. `in`: brought in. `refused`: not brought in. */
	state: "sending" | "started" | "unknown" | "unsure" | "unreachable" | "in" | "refused";
	/** Why it was not brought in: a code or a refusal, as it came. */
	why: string;
	/** A read showed it being brought in. */
	seen: boolean;
	/** Reads in a row that failed while the answer is unknown. */
	failed: number;
	/** When it was asked (or first seen). */
	readonly at: number;
	/** When the answer went missing, and the reads asked by then: only a list from a later read tells. */
	missing: number;
	after: number;
}

/** How often the list is read again while code is being brought in, or an answer is missing. */
const POLL_MS = 5000;
/** The code's folders read the list again on the way in after this long. */
const FRESH_MS = 60_000;
/** How long an ask the list does not show yet, or one whose answer went missing, is followed. */
const FOLLOW_MS = 2 * 60_000;
/** Reads in a row that fail before the page says Qorpera could not be reached. */
const UNREACHABLE_READS = Math.round(FOLLOW_MS / POLL_MS);
/** Refusals that say nothing was written: the function refused before it wrote, or does not exist. */
const NOTHING_WRITTEN = new Set(["PGRST202", "42501", "P0002", "22023", "55P03", "57014"]);

/** GitHub's own rules for an owner and a project's name (qorpera_coding_repository_valid, host github.com), and the
 * rule for the name of a place kept in Qorpera (host qorpera), which the name must also meet in lower case. */
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;
const PLACE_OWNER = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
const PLACE_NAME = /^[a-z0-9_](?:[a-z0-9_.-]{0,98}[a-z0-9_-])?$/;

/** The GitHub project an address names, in the forms a person pastes: github.com/acme/shop with or without https://
 * or www., with .git or a trailing slash, a page of the project (…/tree/main), git's own git@github.com:acme/shop.git,
 * or acme/shop alone. Null for anything else. */
export function githubAddress(text: string): CodeImportTarget | null {
	const value = text.trim();
	const hosted =
		/^(?:ssh:\/\/)?git@github\.com[:/](.*)$/i.exec(value) ??
		/^(?:(?:https?|git):\/\/)?(?:www\.)?github\.com\/(.*)$/i.exec(value);
	const parts = (hosted ? (hosted[1] ?? "") : value).replace(/[?#].*$/s, "").split("/");
	while (parts.length > 2 && parts.at(-1) === "") parts.pop();
	// A page of the project only after github.com: "acme/shop/tree" alone is no address.
	if (parts.length < 2 || (!hosted && parts.length > 2 && parts.slice(2).some(Boolean))) return null;
	const owner = parts[0] ?? "";
	const name = (parts[1] ?? "").replace(/\.git$/i, "");
	if (!GITHUB_OWNER.test(owner) || !GITHUB_NAME.test(name) || !PLACE_NAME.test(name.toLowerCase())) return null;
	return { owner: owner.toLowerCase(), name: name.toLowerCase(), github: `${owner}/${name}`, label: name };
}

/** The project's name in GitHub's spelling, from Owner/Name. */
const projectOf = (github: string) => github.slice(github.indexOf("/") + 1);

/** The line while code is brought in: where it is, in a member's words. */
export function importStepWords(bringing: Pick<CodeBringing, "github" | "step" | "waiting">, name: string): string {
	if (bringing.waiting)
		return t("Bringing in {name}: Waiting for the agents to finish what they are doing…", { name });
	switch (bringing.step ?? (bringing.github ? "fetch" : "read")) {
		case "fetch":
			return t("Bringing in {name}: Getting it from GitHub…", { name });
		case "read":
			return t("Bringing in {name}: Reading the file…", { name });
		case "look":
			return t("Bringing in {name}: Checking it…", { name });
		default:
			return t("Bringing in {name}: Putting it in place…", { name });
	}
}

/** Why code was not brought in, from the outcome's code or the ask's refusal. One that this version does not know gets
 * the last plain line, never its code. */
export function importWhy(reason: string): string {
	const code = reason.split(":")[0] ?? "";
	switch (code) {
		case "IMPORT_TOO_LARGE":
			return t("it is larger than 1 GB, the most Qorpera brings in");
		case "IMPORT_SOURCE_REFUSED":
			return t(
				"GitHub did not let Qorpera read it; check the address, and that the company's GitHub connection can see it",
			);
		case "IMPORT_SOURCE_MOVED":
			return t("GitHub says it has moved; use its new address");
		case "IMPORT_USES_LFS":
			return t("it keeps large files outside the code, and Qorpera can't bring those in yet");
		case "IMPORT_USES_SUBMODULES":
			return t("it is made of other projects, and Qorpera can't bring those in yet");
		case "kept_here":
		case "already_here":
			return t("a project with that name is already kept here");
		case "busy":
			return t("other code is being brought in right now; try again when it is done");
		case "sessions_open":
			return t("agents are still working on it on GitHub; try again when they are done");
	}
	// git's check: an error is damage (IMPORT_HISTORY_DAMAGED, alone or with git's message id after it), and a warning
	// is named by its own message id (codeImportHistoryCode in the runner orchestrator's code-import.ts).
	if (code === "IMPORT_HISTORY_DAMAGED" || code.startsWith("IMPORT_HISTORY_DAMAGED_"))
		return t("its history has damage Qorpera can't take in");
	if (code.startsWith("IMPORT_HISTORY_")) return t("its history has old git objects Qorpera can't take in yet");
	if (/^(?:IMPORT_TOO_MANY_|IMPORT_NAMES?_|CODE_HOST_NAMES_)/.test(code) || code === "IMPORT_BRANCH_NAME")
		return t("it has more files, or names, than Qorpera can keep");
	return t("it could not be brought in just now; try again");
}

/** A brought-in repository's line in its folder: from where and when, and what came with it. */
export function importDoneWords(imported: CodeImported): string {
	const locale = presentationLocale();
	const date = new Date(imported.at).toLocaleDateString(locale, {
		day: "numeric",
		month: "long",
		year: "numeric",
		...timeZoneOption(),
	});
	const words = [
		imported.from === "github"
			? t("Brought in from GitHub on {date}.", { date })
			: t("Brought in from a file on {date}.", { date }),
	];
	if (imported.earlierChanges === 1) words.push(t("1 earlier change came with it."));
	else if (imported.earlierChanges !== null)
		words.push(
			t("{count} earlier changes came with it.", {
				count: new Intl.NumberFormat(locale).format(imported.earlierChanges),
			}),
		);
	if (imported.from === "github") words.push(t("The copy on GitHub stays as it is."));
	return words.join(" ");
}

/** Where a folder stands among the company's code: its top, an owner's folder, or a place and what is below it. */
type Where = { readonly kind: "code" } | { readonly kind: "owner" } | { readonly kind: "place"; readonly key: string };

function whereOf(dir: string): Where | null {
	const [top, owner, name] = dir.split("/");
	if (top !== "code") return null;
	if (owner === undefined) return { kind: "code" };
	// code/_incoming, code/_set-aside: the platform's, not an owner's.
	if (!PLACE_OWNER.test(owner)) return null;
	return name === undefined ? { kind: "owner" } : { kind: "place", key: `${owner}/${name}` };
}

const keyOf = (thing: { readonly owner: string; readonly name: string }) => `${thing.owner}/${thing.name}`;

/** What the line says, and the one small button beside it some states have. */
interface Line {
	readonly text: string;
	readonly action?: HTMLElement | undefined;
}

let questions = 0;

export class CodeImport {
	/** For the folder's top line, beside "Download the code": hidden where nothing can be brought in. */
	readonly button: HTMLButtonElement;
	/** What the folder is, or how an import stands: a line of its own under the top line. */
	readonly line = h("div", { class: "storage-code-line storage-import-line", role: "status" });
	readonly #label = h("span");
	readonly #host: CodeImportHost;
	/** Null once the cloud is known not to have the call. */
	#calls: CodeDownloadCalls | null | undefined;
	#dir: string | undefined;
	#where: Where | null = null;
	#followed: Followed | null = null;
	#poll: ReturnType<typeof setTimeout> | undefined;
	/** A question is open over the page. */
	#asking = false;

	constructor(host: CodeImportHost) {
		this.#host = host;
		this.button = h(
			"button",
			{
				type: "button",
				class: "storage-code-button storage-import-button",
				"aria-haspopup": "dialog",
				hidden: true,
				onclick: () => this.#press(),
			},
			icon("plus"),
			this.#label,
		);
		host.code.onRead = () => {
			this.#settle();
			this.#draw();
			this.#schedule();
		};
		host.signal.addEventListener("abort", () => clearTimeout(this.#poll), { once: true });
	}

	/** The folder now open. The code's own folders read the list on the way in, once a minute, unless a read showed
	 * that this cloud cannot bring code in; a place's folder is read by "Download the code". */
	enter(dir: string): void {
		const moved = dir !== this.#dir;
		this.#dir = dir;
		this.#where = whereOf(dir);
		const where = this.#where;
		// Brought in, and its folder open now: its own line says so from here.
		if (moved && this.#followed?.state === "in" && where?.kind === "place" && where.key === keyOf(this.#followed))
			this.#followed = null;
		this.#draw();
		const { code } = this.#host;
		if (where && where.kind !== "place" && code.offered && (!code.list || code.list.imports) && code.age > FRESH_MS)
			void this.#refresh();
		this.#schedule();
	}

	/** Reads the list now. A read that failed while an answer is missing counts toward saying Qorpera could not be
	 * reached. */
	async #refresh(): Promise<void> {
		const read = await this.#host.code.refresh();
		const followed = this.#followed;
		if (this.#host.signal.aborted || read !== false || followed?.state !== "unknown") return;
		if (++followed.failed >= UNREACHABLE_READS) followed.state = "unreachable";
		this.#draw();
		this.#schedule();
	}

	/** Reads the list again in a few seconds while code is being brought in or the page waits to know how an ask went,
	 * and only while the member is in the code's folders. */
	#schedule(): void {
		clearTimeout(this.#poll);
		this.#poll = undefined;
		const imports = this.#host.code.list?.imports;
		const followed = this.#followed;
		if (this.#host.signal.aborted || !this.#where || !imports) return;
		const recent = followed !== null && Date.now() - Math.max(followed.at, followed.missing) < FOLLOW_MS;
		const waiting =
			imports.bringing.length > 0 ||
			followed?.state === "unknown" ||
			(followed?.state === "started" && (followed.seen || recent)) ||
			(followed?.state === "unsure" && recent);
		if (waiting) this.#poll = setTimeout(() => void this.#refresh(), POLL_MS);
	}

	/** What the list read last says of the import this page follows; and what it follows next, when one is being
	 * brought in. Only a read after a missing answer tells how that ask went. */
	#settle(): void {
		const { code } = this.#host;
		const list = code.list;
		const imports = list?.imports;
		if (!list || !imports) return;
		const followed = this.#followed;
		if (followed && followed.state !== "sending" && followed.state !== "in" && followed.state !== "refused") {
			const key = keyOf(followed);
			const bringing = imports.bringing.some((each) => keyOf(each) === key);
			const kept = list.repositories.some((each) => keyOf(each) === key);
			const told = followed.state === "started" || code.readNumber > followed.after;
			if (!told) {
				// A read from before the answer went missing says nothing of it.
			} else if (bringing) {
				followed.state = "started";
				followed.seen = true;
			} else if (kept) followed.state = "in";
			else if (followed.state === "started" && followed.seen) {
				// It ended, and is not in: the last that was not brought in is this one, if it is here at all.
				const last = imports.last;
				if (last && keyOf(last) === key) {
					followed.state = "refused";
					followed.why = last.reason;
				} else this.#followed = null;
			} else if (followed.state === "started") {
				if (Date.now() - followed.at >= FOLLOW_MS) this.#followed = null;
			} else followed.state = "unsure";
		}
		const next = imports.bringing[0];
		if (!this.#followed && next)
			this.#followed = {
				owner: next.owner,
				name: next.name,
				github: next.github,
				label: next.github ? projectOf(next.github) : next.name,
				state: "started",
				why: "",
				seen: true,
				failed: 0,
				at: Date.now(),
				missing: 0,
				after: 0,
			};
	}

	#draw(): void {
		const { code } = this.#host;
		const where = this.#where;
		const list = code.list;
		const imports = list?.imports;
		const manage = list?.canDownload === true && imports !== undefined && this.#calls !== null && code.offered;
		const place = where?.kind === "place" ? where.key : null;
		// The code's top and each owner's folder say how any import stands; a place says its own.
		const here = (thing: { readonly owner: string; readonly name: string }) =>
			(where !== null && where.kind !== "place") || keyOf(thing) === place;
		const kept = place ? list?.repositories.find((each) => keyOf(each) === place) : undefined;
		const copy = place && !kept ? list?.githubCopies.find((each) => keyOf(each) === place) : undefined;
		const bringing = imports?.bringing[0];
		const followed = this.#followed;
		let line: Line | null = null;
		if (followed && imports && here(followed)) line = this.#followedLine(followed, bringing, manage);
		if (!line && bringing && here(bringing))
			line = { text: importStepWords(bringing, bringing.github ? projectOf(bringing.github) : bringing.name) };
		if (!line && kept?.imported) line = { text: importDoneWords(kept.imported) };
		const last = imports?.last;
		if (
			!line &&
			manage &&
			last &&
			here(last) &&
			!list?.repositories.some((each) => keyOf(each) === keyOf(last)) &&
			!imports?.bringing.some((each) => keyOf(each) === keyOf(last))
		)
			line = {
				text: t("{name} was not brought in: {why}", {
					name: last.github ? projectOf(last.github) : last.name,
					why: importWhy(last.reason),
				}),
			};
		if (!line && copy) line = { text: t("Copy of the GitHub project {name}", { name: projectOf(copy.github) }) };
		replace(this.line, line ? h("span", null, line.text) : null, line?.action ?? null);
		// The button: in the code's own folders, bring code in; on a copy's folder, bring that copy's project in. It rests
		// while code is being brought in, or while an ask has no answer yet.
		const busy =
			Boolean(bringing) ||
			followed?.state === "sending" ||
			followed?.state === "unknown" ||
			(followed?.state === "started" && !followed.seen);
		const label = !manage
			? null
			: where && where.kind !== "place"
				? t("Bring code in")
				: copy && !(bringing && keyOf(bringing) === place)
					? t("Bring it into Qorpera")
					: null;
		this.button.hidden = label === null;
		if (label !== null) this.#label.textContent = label;
		if (busy) this.button.setAttribute("aria-disabled", "true");
		else this.button.removeAttribute("aria-disabled");
	}

	/** The line of the import this page follows, where it may be said. */
	#followedLine(followed: Followed, bringing: CodeBringing | undefined, manage: boolean): Line | null {
		const name = followed.label;
		switch (followed.state) {
			case "sending":
				return null;
			case "started":
				return {
					text: importStepWords(
						bringing && keyOf(bringing) === keyOf(followed)
							? bringing
							: { github: followed.github, step: null, waiting: false },
						name,
					),
				};
			case "unknown":
				return { text: t("Checking whether {name} started…", { name }) };
			case "unsure": {
				const { github } = followed;
				// Asked again, an import already open for it is answered: it is brought in once.
				return {
					text: t("{name} may not have started.", { name }),
					action:
						manage && github
							? button(t("Try again"), () => void this.#bringIn({ ...followed, github }), { small: true })
							: undefined,
				};
			}
			case "unreachable":
				return {
					text: t(
						"Qorpera could not be reached, so it is not known whether {name} started. Open this folder again in a moment.",
						{ name },
					),
				};
			case "refused":
				return manage
					? { text: t("{name} was not brought in: {why}", { name, why: importWhy(followed.why) }) }
					: null;
			case "in":
				// In its own folder the done line says it.
				return this.#where?.kind === "place"
					? null
					: {
							text: t("{name} is brought in.", { name }),
							action: button(t("Open"), () => this.#host.open(`code/${followed.owner}/${followed.name}`), {
								small: true,
							}),
						};
		}
	}

	#press(): void {
		if (this.button.getAttribute("aria-disabled") === "true" || this.#asking) return;
		const where = this.#where;
		if (where?.kind === "place") {
			const copy = this.#host.code.list?.githubCopies.find((each) => keyOf(each) === where.key);
			if (!copy) return;
			const label = projectOf(copy.github);
			this.#question(
				t("Bring {name} into Qorpera?", { name: label }),
				[
					t("Qorpera copies it with its history. Nothing changes on GitHub."),
					t("What this folder holds now is kept aside, not deleted."),
				],
				t("Bring it into Qorpera"),
				{ owner: copy.owner, name: copy.name, github: copy.github, label },
			);
		} else if (where)
			this.#question(
				t("Where is the code?"),
				[t("Qorpera copies it with its history. Nothing changes on GitHub.")],
				t("Bring it in"),
			);
	}

	/** The question, in the look of the Sites page's own (styles/sites.css): with no target, one field for the GitHub
	 * address. It stays while the ask is out, and says there why it was refused, keeping what was typed. */
	#question(title: string, lines: readonly string[], confirm: string, target?: CodeImportTarget): void {
		const signal = this.#host.signal;
		if (signal.aborted) return;
		this.#asking = true;
		const titleId = `code-import-title-${++questions}`;
		let busy = false;
		let closed = false;
		const input = target
			? null
			: h("input", {
					type: "text",
					class: "sites-question-input",
					autocomplete: "off",
					autocapitalize: "none",
					spellcheck: "false",
					inputmode: "url",
					placeholder: t("A GitHub address, like github.com/acme/shop"),
					"aria-labelledby": titleId,
				});
		const problem = h("p", { class: "sites-question-problem", role: "alert" });
		const go = button(confirm, () => {}, { primary: true });
		go.type = "submit";
		const cancel = button(t("Cancel"), () => close());
		const close = () => {
			if (closed) return;
			closed = true;
			this.#asking = false;
			leave(backdrop, "is-leaving", () => backdrop.remove());
			window.removeEventListener("hashchange", close);
			signal.removeEventListener("abort", close);
			if (!this.button.hidden && this.button.isConnected) this.button.focus();
		};
		const submit = async () => {
			if (busy || closed) return;
			const asked = target ?? githubAddress(input?.value ?? "");
			if (!asked) {
				problem.textContent = t("That is not a GitHub address.");
				input?.focus();
				return;
			}
			busy = true;
			problem.textContent = "";
			for (const control of [input, go, cancel]) if (control) control.disabled = true;
			go.textContent = t("Working…");
			const refused = await this.#bringIn(asked);
			if (closed || signal.aborted) return;
			if (refused === undefined) return close();
			busy = false;
			for (const control of [input, go, cancel]) if (control) control.disabled = false;
			go.textContent = confirm;
			problem.textContent = t("{name} was not brought in: {why}", { name: asked.label, why: importWhy(refused) });
			(input ?? go).focus();
		};
		const form = h(
			"form",
			{
				class: "modal sites-question code-import-question",
				role: "dialog",
				"aria-modal": "true",
				"aria-labelledby": titleId,
				onsubmit: (event: SubmitEvent) => {
					event.preventDefault();
					void submit();
				},
			},
			h("h2", { id: titleId }, title),
			h("p", null, lines.join(" ")),
			input,
			problem,
			h("div", { class: "modal-actions" }, cancel, go),
		);
		const backdrop = h(
			"div",
			{ class: "modal-backdrop", onclick: (event: MouseEvent) => event.target === backdrop && !busy && close() },
			form,
		);
		backdrop.addEventListener("keydown", (event) => {
			if (event.key === "Escape" && !event.isComposing) {
				event.preventDefault();
				event.stopPropagation();
				if (!busy) close();
			}
			if (event.key !== "Tab") return;
			const fields = [...backdrop.querySelectorAll<HTMLElement>("input:not(:disabled), button:not(:disabled)")];
			const first = fields[0];
			const final = fields[fields.length - 1];
			if (event.shiftKey ? document.activeElement === first : document.activeElement === final) {
				event.preventDefault();
				(event.shiftKey ? final : first)?.focus();
			}
		});
		document.body.append(backdrop);
		window.addEventListener("hashchange", close);
		signal.addEventListener("abort", close, { once: true });
		(input ?? go).focus();
	}

	/** Asks for the import. Answers why it was refused when the answer says nothing was started; undefined when it is on
	 * its way, or when how it went is not known yet (then the list tells). */
	async #bringIn(target: CodeImportTarget): Promise<string | undefined> {
		const signal = this.#host.signal;
		this.#calls ??= this.#host.calls();
		const calls = this.#calls;
		const followed: Followed = {
			...target,
			state: "sending",
			why: "",
			seen: false,
			failed: 0,
			at: Date.now(),
			missing: 0,
			after: 0,
		};
		this.#followed = followed;
		this.#draw();
		let answer: CodeImportAnswer | undefined;
		let failure: unknown;
		try {
			answer = await calls.bringIn(target.owner, target.name, target.github, signal);
			this.#host.live();
		} catch (error) {
			failure = error;
		}
		if (signal.aborted || this.#followed !== followed) return undefined;
		if (answer?.state === "queued") followed.state = "started";
		else if (answer?.state === "refused") {
			followed.state = "refused";
			followed.why = answer.reason;
		} else if (!answer && failure instanceof CloudRpcError && NOTHING_WRITTEN.has(failure.code ?? "")) {
			// The database refused before it wrote, or has no such call: nothing was started.
			if (failure.missing) this.#calls = null;
			followed.state = "refused";
			followed.why = "failed";
		} else {
			// No answer, one that is not as expected, or one this version does not know: only the list can tell.
			followed.state = "unknown";
			followed.missing = Date.now();
			followed.after = this.#host.code.reads;
		}
		this.#draw();
		if (followed.state === "refused") return followed.why;
		void this.#refresh();
		return undefined;
	}
}
