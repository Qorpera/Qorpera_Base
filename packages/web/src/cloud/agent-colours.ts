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
 * name. The chosen figure's own shade (`native`) is null, which `agent.md` writes as no colour, so the agent follows
 * its figure's shade when the figure changes; four figures' own shades are palette colours as well (the rocket's
 * orange, the crown's gold, the acorn's brown and the ghost's charcoal). Anything else is null too. */
export function agentFileColour(color: string, native?: string): AgentColour | null {
	const value = color.trim().toLowerCase();
	if (native !== undefined && value === native.trim().toLowerCase()) return null;
	return AGENT_COLOURS.find((colour) => value === `qorpera-${colour}` || value === AGENT_COLOUR_HEX[colour]) ?? null;
}
