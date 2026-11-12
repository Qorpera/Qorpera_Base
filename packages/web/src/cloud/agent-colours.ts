import { AGENT_COLOURS, type AgentColour } from "@qorpera/cloud-client/company-state-shared";

/** The agent colours' hex, the palette the figure picker offers. The roster stores an `agent.md` colour as the web's
 * `qorpera-<colour>` token (RUNTIME-COMPANY-STATE-FILES.md, "agent.md"). A name is a place in the palette, kept when
 * its colour is repainted: since November 10, 2026 coral is drawn as Red, teal as Sky and gray as Slate (the names the
 * picker shows, avatar-appearance.js), and green, purple and pink moved apart. */
export const AGENT_COLOUR_HEX: Readonly<Record<AgentColour, string>> = Object.freeze({
	charcoal: "#312f2d",
	brown: "#87674c",
	coral: "#e22538",
	orange: "#f96e2d",
	gold: "#fcb51b",
	green: "#0fbd59",
	teal: "#3faff3",
	blue: "#2047bd",
	purple: "#a145f7",
	pink: "#fa59ac",
	gray: "#6c839b",
});

/** An `agent.md` colour for a colour the web holds: a `qorpera-<colour>` token or a palette colour's hex gives its
 * name. The chosen figure's own shade (`native`) is null, which `agent.md` writes as no colour, so the agent follows
 * its figure's shade when the figure changes; nine figures' own shades are palette colours as well (all but the
 * planet's, the flame's and the heart's). Anything else is null too. */
export function agentFileColour(color: string, native?: string): AgentColour | null {
	const value = color.trim().toLowerCase();
	if (native !== undefined && value === native.trim().toLowerCase()) return null;
	return AGENT_COLOURS.find((colour) => value === `qorpera-${colour}` || value === AGENT_COLOUR_HEX[colour]) ?? null;
}
