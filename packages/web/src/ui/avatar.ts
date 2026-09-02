import type { HostedStaffAgent } from "../cloud/types.ts";

/* Agent figures: the approved visual system, vendored under
 * `public/assets/avatars` and loaded by `index.html` before this bundle. This
 * module is the only place that touches those globals.
 *
 * A figure is built from its baked trace and driven by the shared rig with
 * part motion 0: the body stands still and the life is in its eyes. Nothing
 * follows the pointer, on any surface. */

interface MotionAvatar {
	id: string;
	name: string;
	color: string;
	origin: string;
}
interface VectorRig {
	update(next: { state?: string; size?: number; motion?: number }): void;
	dispose(): void;
}
interface AvatarGlobals {
	QORPERA_MOTION_MODEL: { avatars: MotionAvatar[] };
	QORPERA_AVATAR_APPEARANCE: { palette: { name: string; color: string }[] };
	QORPERA_VECTOR_FIGURES: {
		build(id: string, trace: unknown, options: { color?: string }): HTMLElement;
	};
	QORPERA_VECTOR_RIG: {
		mount(
			host: HTMLElement,
			options: { state?: string; size?: number; interactive?: boolean; motion?: number },
		): VectorRig;
	};
	QORPERA_VECTOR_BAKED: { figures: Record<string, unknown> };
}

function globals(): AvatarGlobals | undefined {
	const scope = window as unknown as Partial<AvatarGlobals>;
	if (
		!scope.QORPERA_MOTION_MODEL ||
		!scope.QORPERA_AVATAR_APPEARANCE ||
		!scope.QORPERA_VECTOR_FIGURES ||
		!scope.QORPERA_VECTOR_RIG ||
		!scope.QORPERA_VECTOR_BAKED
	) {
		return undefined;
	}
	return scope as AvatarGlobals;
}

export const FIGURE_IDS = ["planet", "acorn", "flame", "rocket", "crown", "heart", "ghost"] as const;
export type FigureId = (typeof FIGURE_IDS)[number];

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

function palette(): string[] {
	return globals()?.QORPERA_AVATAR_APPEARANCE.palette.map((entry) => entry.color) ?? [];
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

/* Views re-render by replacing their children, so a rig whose host has left
 * the document would keep its observers alive. Every mount sweeps the ones
 * that went with it.
 *
 * A figure is built detached and inserted by its view a moment later, so
 * "not in the document" cannot mean "gone" until it has been seen there
 * once. Without that gate the next mount disposes the rig that is about to
 * be attached, and every figure ends up frozen. */
interface LiveFigure {
	host: HTMLElement;
	rig: VectorRig;
	attached: boolean;
}
const live = new Set<LiveFigure>();

function sweep(): void {
	for (const entry of live) {
		if (entry.host.isConnected) {
			entry.attached = true;
			continue;
		}
		if (!entry.attached) continue;
		entry.rig.dispose();
		live.delete(entry);
	}
}

export interface FigureOptions {
	/** Rendered size in pixels; the rig scales its amplitudes by it. */
	size?: number;
	/** A still figure: built and coloured, but no rig and so no eye motion. */
	still?: boolean;
	className?: string;
}

/** One built figure, ready to place. Returns an empty span when the vendored
 * scripts are absent, so a missing asset never takes a view down with it. */
export function figureElement(figure: FigureId, color: string, options: FigureOptions = {}): HTMLElement {
	const scope = globals();
	const host = document.createElement("span");
	host.className = ["figure", options.className].filter(Boolean).join(" ");
	host.setAttribute("aria-hidden", "true");
	const trace = scope?.QORPERA_VECTOR_BAKED.figures[figure];
	if (!scope || !trace) return host;
	const built = scope.QORPERA_VECTOR_FIGURES.build(figure, trace, { color });
	host.append(built);
	if (!options.still) {
		sweep();
		const rig = scope.QORPERA_VECTOR_RIG.mount(built, {
			state: "working",
			size: options.size ?? 36,
			interactive: false,
			motion: 0,
		});
		live.add({ host, rig, attached: false });
	}
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
	return figureElement(figure, colorFor(subject, figure), options);
}
