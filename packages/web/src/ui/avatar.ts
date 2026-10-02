import type { HostedStaffAgent } from "../cloud/types.ts";
import { type Activity, type FigureArtwork, type FigureMotion, mountFigureMotion } from "./figure-motion.ts";
import { phrase, t } from "./preferences.ts";
import { designPx } from "./scale.ts";

/* Agent figures: the approved visual system, vendored under
 * `public/assets/avatars` and loaded by `index.html` before this bundle. This
 * module is the only place that touches those globals.
 *
 * Original artwork uses the Assets Room's 2D Motion Studio. Activity is a
 * presentation option only; the shell defaults to Idle. */

interface MotionAvatar {
	id: string;
	name: string;
	color: string;
	origin: string;
}
interface AvatarGlobals {
	QORPERA_MOTION_MODEL: {
		avatars: MotionAvatar[];
		faces: FigureArtwork["faces"];
		avatarColor(id: string, surface: "light" | "dark", selectedColor?: string): string;
	};
	QORPERA_AVATAR_APPEARANCE: { palette: { name: string; color: string }[] } & Pick<
		FigureArtwork,
		"prepare" | "drawable"
	>;
}

function globals(): AvatarGlobals | undefined {
	const scope = window as unknown as Partial<AvatarGlobals>;
	if (!scope.QORPERA_MOTION_MODEL || !scope.QORPERA_AVATAR_APPEARANCE) {
		return undefined;
	}
	return scope as AvatarGlobals;
}

/** Shared approved artwork for static composites, using the same recolouring
 * and dark-surface shade as individual agent figures. */
export function figureArtwork(): FigureArtwork | undefined {
	const scope = globals();
	if (
		!scope ||
		typeof scope.QORPERA_AVATAR_APPEARANCE.prepare !== "function" ||
		typeof scope.QORPERA_AVATAR_APPEARANCE.drawable !== "function" ||
		typeof scope.QORPERA_MOTION_MODEL.avatarColor !== "function"
	)
		return undefined;
	return {
		faces: scope.QORPERA_MOTION_MODEL.faces,
		prepare: scope.QORPERA_AVATAR_APPEARANCE.prepare,
		drawable: scope.QORPERA_AVATAR_APPEARANCE.drawable,
		colorOnDark: (id, shade) =>
			/^#[\da-f]{6}$/.test(shade) ? scope.QORPERA_MOTION_MODEL.avatarColor(id, "dark", shade) : shade,
	};
}

export const FIGURE_IDS = ["planet", "acorn", "flame", "rocket", "crown", "heart", "ghost"] as const;
export type FigureId = (typeof FIGURE_IDS)[number];

const FIGURE_NAMES: Record<FigureId, string> = {
	planet: phrase("planet"),
	acorn: phrase("acorn"),
	flame: phrase("flame"),
	rocket: phrase("rocket"),
	crown: phrase("crown"),
	heart: phrase("heart"),
	ghost: phrase("ghost"),
};

/** A figure's spoken name in the chosen language. */
export function figureName(figure: FigureId): string {
	return t(FIGURE_NAMES[figure]);
}

/* The desktop's own resolution rules (renderer.js on master), ported so a
 * company's saved appearance means the same thing in every client. */
const FIGURE_BY_TEMPLATE: Record<string, FigureId> = {
	"co-founder": "crown",
	"agent-manager": "crown",
	"financial-officer": "acorn",
	"marketing-lead": "flame",
	"product-manager": "planet",
	"software-developer": "rocket",
	"product-designer": "heart",
	"legal-expert": "ghost",
	"operations-specialist": "acorn",
	"research-lead": "planet",
	"costumer-relationist": "heart",
	"outreaching-conversationalist": "flame",
};
const COLOR_TOKENS: Record<string, string> = {
	"qorpera-charcoal": "#312f2d",
	"qorpera-brown": "#87674c",
	"qorpera-coral": "#ff365e",
	"qorpera-orange": "#f96e2d",
	"qorpera-gold": "#fcb51b",
	"qorpera-green": "#00c878",
	"qorpera-teal": "#00bfb3",
	"qorpera-blue": "#2047bd",
	"qorpera-purple": "#b83ff5",
	"qorpera-pink": "#ff2994",
	"qorpera-gray": "#7c7c7a",
};

/** The hex of an agent colour name (`coral`), as `agent.md` and interface files write it. */
export function colourNameHex(colour: string): string | undefined {
	return COLOR_TOKENS[`qorpera-${colour}`];
}

function isFigure(value: string | undefined): value is FigureId {
	return (FIGURE_IDS as readonly string[]).includes(value ?? "");
}

/** The figure a saved appearance resolves to: the stored one when it is still
 * in the roster, else the template's, else a stable one derived from identity
 * so two clients agree without anybody writing. */
export function figureFor(agent: Pick<HostedStaffAgent, "id" | "displayName" | "appearance" | "templateId">): FigureId {
	if (isFigure(agent.appearance?.creature)) return agent.appearance.creature;
	const byTemplate = agent.templateId ? FIGURE_BY_TEMPLATE[agent.templateId] : undefined;
	if (byTemplate) return byTemplate;
	const identity = agent.id || agent.displayName || "";
	let seed = 0;
	for (const character of identity) seed = (seed * 31 + character.charCodeAt(0)) >>> 0;
	return FIGURE_IDS[seed % FIGURE_IDS.length] ?? "crown";
}

/** The eleven creation colours, in the order the workspace's picker shows
 * them. Empty when the vendored scripts are absent. */
export function PALETTE(): { name: string; color: string }[] {
	return globals()?.QORPERA_AVATAR_APPEARANCE.palette ?? [];
}

/** The palette's names (avatar-appearance.js), so each has its Danish. */
const COLOR_NAMES: readonly string[] = [
	phrase("Charcoal"),
	phrase("Brown"),
	phrase("Coral"),
	phrase("Orange"),
	phrase("Gold"),
	phrase("Green"),
	phrase("Teal"),
	phrase("Blue"),
	phrase("Purple"),
	phrase("Pink"),
	phrase("Gray"),
];

/** A palette colour's spoken name in the chosen language. */
export function colorName(name: string): string {
	return COLOR_NAMES.includes(name) ? t(name) : name;
}

function palette(): string[] {
	return PALETTE().map((entry) => entry.color);
}

/** A figure's own shade, which bypasses recolouring entirely. */
export function nativeColorOf(figure: FigureId): string {
	return nativeColor(figure);
}

function nativeColor(figure: FigureId): string {
	const model = globals()?.QORPERA_MOTION_MODEL.avatars.find((item) => item.id === figure);
	return model?.color ?? "#fcb51b";
}

/** The colour a saved appearance resolves to: a palette token, a palette hex,
 * the nearest palette colour for a retired choice, else the figure's own
 * shade. A retired colour is never written back just by rendering it. */
export function colorFor(
	agent: Pick<HostedStaffAgent, "id" | "displayName" | "appearance" | "templateId">,
	figure = figureFor(agent),
): string {
	const stored = (agent.appearance?.color ?? "").trim().toLowerCase();
	const resolved = (COLOR_TOKENS[stored] ?? stored).toLowerCase();
	if (!/^#[0-9a-f]{6}$/.test(resolved)) return nativeColor(figure);
	const choices = palette();
	if (choices.includes(resolved) || resolved === nativeColor(figure).toLowerCase()) return resolved;
	const channels = (hex: string) => [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
	const target = channels(resolved);
	const distance = (hex: string) =>
		channels(hex).reduce((sum, value, index) => sum + (value - (target[index] ?? 0)) ** 2, 0);
	return [...choices].sort((left, right) => distance(left) - distance(right))[0] ?? nativeColor(figure);
}

/** The colour the cloud seeds every Co-Founder with (the organization kernel
 * migrations). Nobody chose it, and a colour picked in a client is stored as a
 * palette hex, never as this token. */
const COFOUNDER_SEED_COLOR = "qorpera-blue";

/** The colour an agent is drawn in. A Co-Founder that still carries the seeded
 * colour wears its figure's own shade, as in the trailer; once somebody picks a
 * colour it wears that, like every other agent. */
export function agentColor(
	agent: Pick<HostedStaffAgent, "id" | "displayName" | "appearance" | "templateId">,
	figure = figureFor(agent),
): string {
	const stored = (agent.appearance?.color ?? "").trim().toLowerCase();
	if (agent.templateId === "co-founder" && stored === COFOUNDER_SEED_COLOR) return nativeColor(figure);
	return colorFor(agent, figure);
}

/* Views build and insert figures synchronously. Sweep after DOM changes so
 * removed rigs are disposed even if no later figure is mounted. */
interface LiveFigure {
	host: HTMLElement;
	rig: FigureMotion;
}
const live = new Set<LiveFigure>();
let observer: MutationObserver | undefined;

function sweep(): void {
	for (const entry of live) {
		if (entry.host.isConnected) continue;
		entry.rig.dispose();
		live.delete(entry);
	}
	if (!live.size) {
		observer?.disconnect();
		observer = undefined;
	}
}

export interface FigureOptions {
	/** Initial rendered size; resizing is tracked from the actual element. */
	size?: number;
	/** A settled pose with no animation. */
	still?: boolean;
	activity?: Activity;
	identity?: string;
	className?: string;
}

/** One built figure, ready to place. Returns an empty span when the vendored
 * scripts are absent, so a missing asset never takes a view down with it. */
export function figureElement(figure: FigureId, color?: string, options: FigureOptions = {}): HTMLElement {
	const scope = globals();
	const host = document.createElement("span");
	host.className = ["figure", options.className].filter(Boolean).join(" ");
	host.setAttribute("aria-hidden", "true");
	if (options.size) host.style.setProperty("--figure-size", designPx(options.size));
	if (!scope) return host;
	const rig = mountFigureMotion(
		host,
		figure,
		color ?? nativeColor(figure),
		{
			faces: scope.QORPERA_MOTION_MODEL.faces,
			prepare: scope.QORPERA_AVATAR_APPEARANCE.prepare,
			drawable: scope.QORPERA_AVATAR_APPEARANCE.drawable,
			// The model accepts lower-case hex only; anything else keeps its colour.
			colorOnDark: (id, shade) =>
				/^#[\da-f]{6}$/.test(shade) ? scope.QORPERA_MOTION_MODEL.avatarColor(id, "dark", shade) : shade,
		},
		options,
	);
	live.add({ host, rig });
	// Views insert their newly built figures synchronously. Sweep after the
	// DOM commit, never halfway through constructing another view.
	if (!observer) {
		observer = new MutationObserver(sweep);
		observer.observe(document.documentElement, { childList: true, subtree: true });
	}
	queueMicrotask(sweep);
	return host;
}

/** The figure for one agent, resolved from its saved appearance. */
export function agentFigure(
	agent: Pick<HostedStaffAgent, "id" | "displayName" | "appearance" | "templateId"> | undefined,
	fallbackName = "",
	options: FigureOptions = {},
): HTMLElement {
	const subject = agent ?? {
		id: "",
		displayName: fallbackName,
		appearance: { color: "", shape: "" },
	};
	const figure = figureFor(subject);
	return figureElement(figure, agentColor(subject, figure), { identity: subject.id || fallbackName, ...options });
}
