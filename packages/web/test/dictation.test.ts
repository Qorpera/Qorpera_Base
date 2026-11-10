// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dictation } from "../src/ui/dictation.ts";

/** The browser's speech recognition, driven by the test: `hear` hands it what it heard so far. */
class FakeRecognition {
	static last: FakeRecognition | undefined;
	lang = "";
	continuous = false;
	interimResults = false;
	onresult: ((event: { results: { transcript: string }[][] }) => void) | null = null;
	onerror: ((event: { error: string }) => void) | null = null;
	onend: (() => void) | null = null;
	started = false;
	aborted = false;
	constructor() {
		FakeRecognition.last = this;
	}
	start() {
		this.started = true;
	}
	stop() {
		this.onend?.();
	}
	abort() {
		this.aborted = true;
	}
	hear(...pieces: string[]) {
		this.onresult?.({ results: pieces.map((transcript) => [{ transcript }]) });
	}
}

let lifetime: AbortController;
beforeEach(() => {
	FakeRecognition.last = undefined;
	lifetime = new AbortController();
});
afterEach(() => {
	lifetime.abort();
	document.body.replaceChildren();
	vi.unstubAllGlobals();
	localStorage.clear();
});

function setup(value = "") {
	const input = document.createElement("textarea");
	input.value = value;
	input.setSelectionRange(value.length, value.length);
	document.body.append(input);
	const writes: string[] = [];
	const dictation = new Dictation(
		input,
		(start, end, text) => {
			input.setRangeText(text, start, end, "end");
			input.dispatchEvent(new Event("input", { bubbles: true }));
			writes.push(input.value);
		},
		lifetime.signal,
	);
	document.body.append(dictation.button, dictation.status);
	return { input, dictation, writes };
}

describe("dictation", () => {
	it("has no microphone where the browser cannot turn speech into text", () => {
		const { dictation } = setup();
		expect(dictation.button.hidden).toBe(true);
	});

	it("writes what is heard at the caret, rewrites it as the browser hears better, and stops on a second click", () => {
		vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
		localStorage.setItem("qorpera.web.language", "da");
		const { input, dictation, writes } = setup("Hej");
		expect(dictation.button.hidden).toBe(false);
		expect(dictation.button.getAttribute("aria-label")).toBe("Indtal");
		dictation.button.click();
		const recognition = FakeRecognition.last!;
		expect(recognition.started).toBe(true);
		expect(recognition.lang).toBe("da-DK");
		expect(recognition.continuous && recognition.interimResults).toBe(true);
		expect(dictation.listening).toBe(true);
		expect(dictation.button.classList.contains("is-listening")).toBe(true);
		expect(dictation.button.getAttribute("aria-label")).toBe("Stop indtaling");
		recognition.hear("med");
		recognition.hear("med dig");
		recognition.hear("med dig,", " hvordan går det");
		expect(writes).toEqual(["Hej med", "Hej med dig", "Hej med dig, hvordan går det"]);
		expect(input.value).toBe("Hej med dig, hvordan går det");
		dictation.button.click();
		expect(dictation.listening).toBe(false);
		expect(dictation.button.getAttribute("aria-label")).toBe("Indtal");
	});

	it("stops listening when the member types, and never writes over a field that changed", () => {
		vi.stubGlobal("SpeechRecognition", FakeRecognition);
		const { input, dictation } = setup();
		dictation.button.click();
		const recognition = FakeRecognition.last!;
		recognition.hear("hello");
		expect(input.value).toBe("hello");
		input.value = "hello!";
		input.dispatchEvent(new Event("input", { bubbles: true }));
		expect(dictation.listening).toBe(false);

		dictation.button.click();
		const again = FakeRecognition.last!;
		again.hear("there");
		expect(input.value).toBe("hello! there");
		// A send emptied the field: what is heard next is dropped and the listening ends.
		input.value = "";
		again.hear("there friend");
		expect(input.value).toBe("");
		expect(again.aborted).toBe(true);
		expect(dictation.listening).toBe(false);
	});

	it("says why the microphone could not listen, and is switched off with the field", () => {
		vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
		const { dictation } = setup();
		dictation.button.click();
		FakeRecognition.last!.onerror?.({ error: "not-allowed" });
		FakeRecognition.last!.onend?.();
		expect(dictation.status.hidden).toBe(false);
		expect(dictation.status.textContent).toBe(
			"Qorpera may not use the microphone. Allow it in the browser's settings for this site.",
		);
		dictation.button.click();
		expect(dictation.status.hidden).toBe(true);
		dictation.disabled = true;
		expect(FakeRecognition.last!.aborted).toBe(true);
		expect(dictation.button.disabled).toBe(true);
		expect(dictation.listening).toBe(false);
	});
});
