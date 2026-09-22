import type { AgentState } from "../app/company.ts";
import type { Activity } from "./figure-motion.ts";

export interface AgentLook {
	figure: Activity;
	line?: string;
	/** The rest of the sentence after the agent's name: "Nova is working". */
	detail?: string;
	note?: string;
	disc?: "working" | "failed";
}

/** One visual vocabulary for the sidebar and the conversation. Thinking is
 * the motion studio's name for the agent-coloured, unframed writing dots. */
export const AGENT_LOOK: Record<AgentState, AgentLook> = {
	idle: { figure: "Idle" },
	working: { figure: "Working", line: "Working", detail: " is working", disc: "working" },
	writing: { figure: "Thinking", line: "Writing", detail: " is writing", disc: "working" },
	decision: { figure: "Waiting", line: "Needs you" },
	failed: { figure: "Idle", note: "A run did not finish", disc: "failed" },
};

/* Graphemes when the browser can split them; code points otherwise, so a
 * browser without Intl.Segmenter still boots and waves (a combining mark
 * then animates a beat after its base letter, which is harmless). */
const graphemes =
	typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : undefined;
function letters(word: string): string[] {
	return graphemes ? Array.from(graphemes.segment(word), ({ segment }) => segment) : Array.from(word);
}
const WAVE_PERIOD = 1400;
const LETTER_STEP = 37.5;
/* One clock for every wave on the page: a letter's delay is its place in the
 * sentence minus how far the shared cycle has run, so the thread caption and
 * the rail card move together however far apart they were built. */
const epoch = Date.now();

/** Appends `text` as words of letters carrying the desktop's wave delays;
 * returns the next letter index so a caption can run on across its parts. */
function waveInto(container: HTMLElement, text: string, index: number): number {
	const phase = (Date.now() - epoch) % WAVE_PERIOD;
	for (const piece of text.split(/(\s+)/u)) {
		if (!piece) continue;
		if (/^\s+$/u.test(piece)) {
			container.append(piece);
			index += piece.length;
			continue;
		}
		const word = document.createElement("span");
		word.className = "status-wave-word";
		for (const segment of letters(piece)) {
			const letter = document.createElement("span");
			letter.className = "status-wave-letter";
			letter.textContent = segment;
			letter.style.setProperty("--wave-delay", `${((index++ * LETTER_STEP) % WAVE_PERIOD) - WAVE_PERIOD - phase}ms`);
			word.append(letter);
		}
		container.append(word);
	}
	return index;
}

/** The rail card's second line: the live state with the wave running, a
 * still state ("Needs you"), or the role. Live is what carries `detail`. */
export function stateLine(look: AgentLook, role: string): HTMLElement | string {
	if (!look.line) return role;
	if (!look.detail) return look.line;
	const line = document.createElement("span");
	line.className = "status-wave";
	waveInto(line, look.line, 0);
	return line;
}

/** The desktop's status caption: "Nova is working" letter by letter, so the
 * ink wave can run across it. Assistive technology reads one sentence; the
 * letters are hidden from it. The letters are built when the caption is
 * shown (see syncCaption), so nothing animates while it is hidden. */
export function statusCaption(lead: string, detail: string): HTMLElement {
	const caption = document.createElement("span");
	caption.className = "status-caption";
	caption.setAttribute("aria-hidden", "true");
	for (const [className, text] of [
		["status-caption-name", lead],
		["status-caption-detail", detail],
	] as const) {
		const part = document.createElement("span");
		part.className = className;
		part.dataset.text = text;
		caption.append(part);
	}
	syncCaption(caption);
	return caption;
}

/** Rebuilds the caption's letters from the shared clock, so a caption shown
 * after any pause starts in step with the rail instead of where it left off. */
export function syncCaption(caption: HTMLElement): void {
	let index = 0;
	for (const part of caption.children) {
		if (!(part instanceof HTMLElement)) continue;
		part.replaceChildren();
		index = waveInto(part, part.dataset.text ?? "", index);
	}
}
