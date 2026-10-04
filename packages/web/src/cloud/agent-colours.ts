import { AGENT_COLOURS, type AgentColour } from "@qorpera/cloud-client/company-state-shared";

/** The agent colours' hex, the palette the figure picker offers. The roster stores an `agent.md` colour as the web's
 * `qorpera-<colour>` token (RUNTIME-COMPANY-STATE-FILES.md, "agent.md"). */
export const AGENT_COLOUR_HEX: Readonly<Record<AgentColour, string>> = Object.freeze({
	charcoal: "#312f2d",
	brown: "#87674c",
	coral: "#ff365e",
	orange: "#f96e2d",
	gold: "#fcb51b",
	green: "#00c878",
	teal: "#00bfb3",
	blue: "#2047bd",
	purple: "#b83ff5",
	pink: "#ff2994",
	gray: "#7c7c7a",
});

/** An `agent.md` colour for a colour the web holds: a `qorpera-<colour>` token or a palette colour's hex gives its
 * name; anything else (a figure's own shade) is null, which `agent.md` writes as no colour. */
export function agentFileColour(color: string): AgentColour | null {
	const value = color.trim().toLowerCase();
	return AGENT_COLOURS.find((colour) => value === `qorpera-${colour}` || value === AGENT_COLOUR_HEX[colour]) ?? null;
}
