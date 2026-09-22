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

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The desktop's status caption: "Nova is working" letter by letter, so the
 * ink wave can run across it. Assistive technology reads one sentence; the
 * letters are hidden from it. */
export function statusCaption(lead: string, detail: string): HTMLElement {
	const caption = document.createElement("span");
	caption.className = "status-caption";
	caption.setAttribute("aria-hidden", "true");
	let index = 0;
	for (const [className, text] of [
		["status-caption-name", lead],
		["status-caption-detail", detail],
	] as const) {
		const part = document.createElement("span");
		part.className = className;
		for (const piece of text.split(/(\s+)/u)) {
			if (!piece) continue;
			if (/^\s+$/u.test(piece)) {
				part.append(piece);
				index += piece.length;
				continue;
			}
			const word = document.createElement("span");
			word.className = "status-wave-word";
			for (const { segment } of graphemes.segment(piece)) {
				const letter = document.createElement("span");
				letter.className = "status-wave-letter";
				letter.textContent = segment;
				letter.style.setProperty("--wave-delay", `${((index++ * 37.5) % 1400) - 1400}ms`);
				word.append(letter);
			}
			part.append(word);
		}
		caption.append(part);
	}
	return caption;
}
