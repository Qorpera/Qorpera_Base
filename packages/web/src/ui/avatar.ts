import {
	drawnStaffCharacter,
	STAFF_CHARACTER_BY_TEMPLATE,
	STAFF_CHARACTER_IDS,
	type StaffCharacterId,
} from "@qorpera/cloud-client/staff-characters";
import { AGENT_COLOUR_HEX } from "../cloud/agent-colours.ts";
import type { HostedStaffAgent } from "../cloud/types.ts";
import {
	type Activity,
	type FigureArtwork,
	type FigureMotion,
	type Moment,
	mountFigureMotion,
} from "./figure-motion.ts";
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

/** The figures on offer, in the shared order (cloud-client staff-characters): the runtime walks the same list. */
export const FIGURE_IDS = STAFF_CHARACTER_IDS;
export type FigureId = StaffCharacterId;

const FIGURE_NAMES: Record<FigureId, string> = {
	planet: phrase("planet"),
	acorn: phrase("acorn"),
	flame: phrase("flame"),
	rocket: phrase("rocket"),
	crown: phrase("crown"),
	heart: phrase("heart"),
	star: phrase("star"),
	cloud: phrase("cloud"),
	bolt: phrase("bolt"),
	mushroom: phrase("mushroom"),
	moon: phrase("moon"),
	puzzle: phrase("puzzle"),
};

/** A figure's spoken name in the chosen language. */
export function figureName(figure: FigureId): string {
	return t(FIGURE_NAMES[figure]);
}

/* The shared resolution rules (cloud-client staff-characters), so a company's
 * saved appearance means the same thing in every client and on the agent's
 * desktop. The founding agent's template is not a hireable one. */
const FIGURE_BY_TEMPLATE: Record<string, FigureId> = { "co-founder": "crown", ...STAFF_CHARACTER_BY_TEMPLATE };
const COLOR_TOKENS: Record<string, string> = Object.fromEntries(
	Object.entries(AGENT_COLOUR_HEX).map(([colour, hex]) => [`qorpera-${colour}`, hex]),
);

/** The hex of an agent colour name (`coral`), as `agent.md` and interface files write it. */
export function colourNameHex(colour: string): string | undefined {
	return COLOR_TOKENS[`qorpera-${colour}`];
}

/** The figure a saved appearance resolves to: the stored one when it is still
 * in the roster (a retired one's replacement: a saved ghost is drawn as the
 * moon), else the template's, else a stable one derived from identity so two
 * clients agree without anybody writing. */
export function figureFor(agent: Pick<HostedStaffAgent, "id" | "displayName" | "appearance" | "templateId">): FigureId {
	const saved = drawnStaffCharacter(agent.appearance?.creature);
	if (saved) return saved;
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
	phrase("Red"),
	phrase("Orange"),
	phrase("Gold"),
	phrase("Green"),
	phrase("Sky"),
	phrase("Blue"),
	phrase("Purple"),
	phrase("Pink"),
	phrase("Slate"),
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

/** The colour an agent is drawn in, the Co-Founder's too: a palette token, a
 * palette hex, the nearest palette colour for a retired choice, else the
 * figure's own shade (an agent whose file names no colour is `native`). A
 * retired colour is never written back just by rendering it. */
export function agentColor(
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
	/** The raised hand beside the figure (`raisedHand`), which the figure waves and takes along. */
	hand?: HTMLElement;
	/** Left alone, the figure still blinks, looks around and moves now and then. */
	alive?: boolean;
}

/** A short act on a figure built here (`figureElement`'s host): "cheer" when its work is done, "perk" under
 * the pointer. Nothing happens on any other element, or for a member who wants no motion. */
export function playFigure(host: Element | null | undefined, kind: Moment): void {
	if (!host) return;
	for (const entry of live) if (entry.host === host) entry.rig.play(kind);
}

const SVG = "http://www.w3.org/2000/svg";
/* An open hand as one solid shape, fingers fanned: the palm, four fingers and the thumb, in a 24-unit box
 * whose wrist is at the bottom. Each part: x, y, width, height, corner radius, and its turn about the palm. */
const HAND_PARTS: readonly [number, number, number, number, number, number][] = [
	[6.3, 10.4, 11.6, 11.4, 5.2, 0],
	[6.5, 3.4, 3.3, 11.5, 1.65, -15],
	[9.7, 1.9, 3.3, 12.5, 1.65, -5],
	[12.9, 2.5, 3.3, 12, 1.65, 5],
	[15.9, 4.8, 3.1, 10, 1.55, 15],
	[2.2, 11.6, 3.5, 8.6, 1.75, -42],
];

/** The raised hand of a figure whose work waits on the member (styles/app.css `.rail-hand`): the same shape
 * twice, a ring in the colour under it and the hand over that, so it reads as cut out of the row. Hand it
 * to the figure (`FigureOptions.hand`) and the figure waves it. */
export function raisedHand(): HTMLElement {
	const hand = document.createElement("span");
	hand.className = "rail-hand";
	hand.setAttribute("aria-hidden", "true");
	const art = document.createElementNS(SVG, "svg");
	art.setAttribute("viewBox", "0 0 24 24");
	for (const layer of ["hand-ring", "hand-fill"]) {
		const group = document.createElementNS(SVG, "g");
		group.setAttribute("class", layer);
		for (const [x, y, width, height, radius, turn] of HAND_PARTS) {
			const part = document.createElementNS(SVG, "rect");
			part.setAttribute("x", String(x));
			part.setAttribute("y", String(y));
			part.setAttribute("width", String(width));
			part.setAttribute("height", String(height));
			part.setAttribute("rx", String(radius));
			if (turn) part.setAttribute("transform", `rotate(${turn} 12 17)`);
			group.append(part);
		}
		art.append(group);
	}
	hand.append(art);
	return hand;
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
