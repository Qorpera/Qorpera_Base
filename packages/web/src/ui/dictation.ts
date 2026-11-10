import { h, icon } from "./dom.ts";
import { languagePreference, t } from "./preferences.ts";

/** The parts of the browser's speech recognition this file uses (Web Speech API; Safari and Chrome name it
 * webkitSpeechRecognition, Firefox has none). */
interface SpeechAlternative {
	readonly transcript: string;
}
interface SpeechResultList {
	readonly length: number;
	readonly [index: number]: { readonly length: number; readonly [index: number]: SpeechAlternative };
}
interface Recognition {
	lang: string;
	continuous: boolean;
	interimResults: boolean;
	onresult: ((event: { readonly results: SpeechResultList }) => void) | null;
	onerror: ((event: { readonly error: string }) => void) | null;
	onend: (() => void) | null;
	start(): void;
	stop(): void;
	abort(): void;
}
type RecognitionClass = new () => Recognition;

function recognitionClass(): RecognitionClass | undefined {
	const scope = window as unknown as {
		SpeechRecognition?: RecognitionClass;
		webkitSpeechRecognition?: RecognitionClass;
	};
	return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
}

/** What the member speaks: the language they chose for Qorpera, else the browser's own. */
function spokenLanguage(): string {
	const chosen = languagePreference();
	return chosen === "da" ? "da-DK" : chosen === "en" ? "en-US" : navigator.language || "en-US";
}

/** Speech to text for a composer: the microphone button, and the words written into the field while they are spoken.
 * The words go in at the caret and are rewritten as the browser hears better; typing, a send or any other change to
 * those words ends the listening at once and keeps what is there. A caret the member moved away from the spoken words
 * stays where they put it. `write` makes the change as the field's own code edit
 * (the composer's history and drafts follow it). */
export class Dictation {
	readonly button: HTMLButtonElement;
	/** Why the microphone could not listen, said under the composer until it listens again. */
	readonly status = h("p", { class: "composer-dictation-note", role: "status", hidden: true });
	readonly #input: HTMLTextAreaElement;
	readonly #write: (start: number, end: number, text: string) => void;
	readonly #Recognition = recognitionClass();
	#recognition: Recognition | undefined;
	/** Where the spoken words start in the field, and what of them stands there now. */
	#start = 0;
	#written = "";
	#writing = false;

	constructor(
		input: HTMLTextAreaElement,
		write: (start: number, end: number, text: string) => void,
		signal: AbortSignal,
	) {
		this.#input = input;
		this.#write = write;
		this.button = h(
			"button",
			{
				type: "button",
				class: "composer-mic icon-button",
				"aria-pressed": "false",
				hidden: !this.#Recognition,
				onclick: () => (this.#recognition ? this.stop() : this.#listen()),
			},
			icon("mic"),
		);
		this.#label();
		input.addEventListener(
			"input",
			() => {
				// At once: a result still on its way would be written after what the member typed.
				if (!this.#writing) this.cancel();
			},
			{ signal },
		);
		signal.addEventListener("abort", () => this.cancel());
	}

	get listening(): boolean {
		return this.#recognition !== undefined;
	}

	/** Stops listening; words still being heard are written when the browser has them. */
	stop(): void {
		this.#recognition?.stop();
	}

	/** Stops listening at once and writes nothing more (a send, a closed conversation). */
	cancel(): void {
		const recognition = this.#recognition;
		if (!recognition) return;
		recognition.onresult = null;
		recognition.onerror = null;
		recognition.onend = null;
		recognition.abort();
		this.#ended();
	}

	set disabled(value: boolean) {
		this.button.disabled = value;
		if (value) this.cancel();
	}

	#listen(): void {
		const Recognition = this.#Recognition;
		if (!Recognition || this.#input.disabled) return;
		const recognition = new Recognition();
		recognition.lang = spokenLanguage();
		recognition.continuous = true;
		recognition.interimResults = true;
		const before = this.#input.value.slice(0, this.#input.selectionStart);
		const space = before && !/\s$/.test(before) ? " " : "";
		this.#start = this.#input.selectionStart;
		this.#written = "";
		recognition.onresult = (event) => {
			let heard = "";
			for (let index = 0; index < event.results.length; index++)
				heard += event.results[index]?.[0]?.transcript ?? "";
			heard = heard.trim();
			const end = this.#start + this.#written.length;
			// Something else changed the spoken words (a send, a draft put back): stop and write nothing over it.
			if (this.#input.value.slice(this.#start, end) !== this.#written) {
				this.cancel();
				return;
			}
			const text = heard ? space + heard : "";
			if (text === this.#written) return;
			const input = this.#input;
			const caret = { start: input.selectionStart, end: input.selectionEnd };
			const following = caret.start === end && caret.end === end;
			this.#writing = true;
			try {
				this.#write(this.#start, end, text);
			} finally {
				this.#writing = false;
			}
			this.#written = text;
			// The write leaves the caret after the spoken words; a caret elsewhere goes back, moved by the words' change.
			if (!following) {
				const shift = (at: number) =>
					at <= this.#start
						? at
						: at >= end
							? at + text.length - (end - this.#start)
							: this.#start + Math.min(at - this.#start, text.length);
				input.setSelectionRange(shift(caret.start), shift(caret.end));
			}
		};
		recognition.onerror = (event) => {
			if (event.error === "no-speech" || event.error === "aborted") return;
			this.status.textContent =
				event.error === "not-allowed" || event.error === "service-not-allowed"
					? t("Qorpera may not use the microphone. Allow it in the browser's settings for this site.")
					: event.error === "audio-capture"
						? t("No microphone was found.")
						: t("Speech could not be turned into text. Try again.");
			this.status.hidden = false;
		};
		recognition.onend = () => this.#ended();
		this.#recognition = recognition;
		this.status.hidden = true;
		try {
			recognition.start();
		} catch {
			this.#ended();
			return;
		}
		this.button.classList.add("is-listening");
		this.button.setAttribute("aria-pressed", "true");
		this.#label();
		this.#input.focus();
	}

	#ended(): void {
		this.#recognition = undefined;
		this.button.classList.remove("is-listening");
		this.button.setAttribute("aria-pressed", "false");
		this.#label();
	}

	#label(): void {
		const label = this.#recognition ? t("Stop dictation") : t("Dictate");
		this.button.title = label;
		this.button.setAttribute("aria-label", label);
	}
}
