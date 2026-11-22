import type { SurfaceExplorationSet, SurfaceSession } from "@qorpera/contracts";
import { AGENT_COLOUR_HEX } from "../../cloud/agent-colours.ts";
import { AGENT_LOOK, stateLine } from "../../ui/agent-activity.ts";
import { FIGURE_IDS, type FigureId, figureElement } from "../../ui/avatar.ts";
import { h, icon } from "../../ui/dom.ts";
import type { Activity, Ask } from "../../ui/figure-motion.ts";
import { t } from "../../ui/preferences.ts";
import { hasConflictedChange, isRunningSession, sessionHeld } from "../surfaces-store.ts";

// WHY: The Crown is the Co-Founder's alone, so sessions draw only from the staff crew.
const CREW: readonly FigureId[] = FIGURE_IDS.filter((figure) => figure !== "crown");
const CREW_COLOURS: readonly string[] = Object.entries(AGENT_COLOUR_HEX)
	.filter(([name]) => name !== "charcoal")
	.map(([, hex]) => hex);

export type CrewTone = "working" | "waiting" | "attention" | "ready" | "merged";

export interface CrewLook {
	readonly tone: CrewTone;
	readonly activity: Activity;
	readonly ask?: Ask;
	readonly alive: boolean;
	readonly label: string;
}

function seeded(text: string, multiplier: number): number {
	let value = 0;
	for (const character of text) value = (value * multiplier + (character.codePointAt(0) ?? 0)) >>> 0;
	return value;
}

// WHY: Seeded from the session id so a parallel crew never swaps looks between redraws.
export function sessionCrew(sessionId: string): { readonly figure: FigureId; readonly color: string } {
	const figure = CREW[seeded(sessionId, 31) % CREW.length] ?? "planet";
	const color = CREW_COLOURS[seeded(sessionId, 131) % CREW_COLOURS.length] ?? "#3faff3";
	return { figure, color };
}

export function crewLook(session: SurfaceSession): CrewLook {
	if (session.state === "needs_input")
		return { tone: "waiting", activity: "Waiting", ask: "question", alive: true, label: t("Needs you") };
	if (isRunningSession(session)) return { tone: "working", activity: "Working", alive: true, label: t("Working") };
	if (session.state === "failed")
		return { tone: "attention", activity: "Idle", ask: "bang", alive: true, label: t("Failed") };
	if (hasConflictedChange(session))
		return { tone: "attention", activity: "Idle", ask: "bang", alive: true, label: t("Conflict") };
	if (sessionHeld(session) || session.state === "completed")
		return { tone: "merged", activity: "Idle", alive: false, label: t("Merged") };
	return { tone: "ready", activity: "Idle", alive: true, label: t("Ready") };
}

export function explorationCrewLook(variants: readonly SurfaceSession[]): CrewLook {
	if (variants.some((variant) => variant.state === "needs_input"))
		return { tone: "waiting", activity: "Waiting", ask: "question", alive: true, label: t("Needs you") };
	if (variants.some(isRunningSession))
		return { tone: "working", activity: "Working", alive: true, label: t("Working") };
	if (variants.some((variant) => variant.state === "failed"))
		return { tone: "attention", activity: "Idle", ask: "bang", alive: true, label: t("Failed") };
	if (variants.some(hasConflictedChange))
		return { tone: "attention", activity: "Idle", ask: "bang", alive: true, label: t("Conflict") };
	return { tone: "ready", activity: "Idle", alive: true, label: t("Ready") };
}

export function crewWave(): HTMLElement | string {
	return stateLine(AGENT_LOOK.working) ?? t("Working");
}

// WHY: Rails and drawers replace their rows on every redraw; handing back the same figure element keeps
// each agent mid-motion instead of restarting its animation (and its opening blink) each time.
export class CrewFigures {
	#kept = new Map<string, HTMLElement>();
	#used = new Map<string, HTMLElement>();

	take(session: SurfaceSession, size: number, className = ""): HTMLElement {
		const look = crewLook(session);
		const crew = sessionCrew(session.id);
		const key = JSON.stringify([session.id, size, look.tone, look.activity, look.ask ?? "", className]);
		let stand = this.#used.get(key) ?? this.#kept.get(key);
		if (!stand) {
			const figure = figureElement(crew.figure, crew.color, {
				size,
				identity: `surface-session:${session.id}`,
				activity: look.activity,
				alive: look.alive,
				...(look.ask ? { ask: look.ask } : {}),
			});
			stand = h(
				"span",
				{
					class: ["surface-crew", `is-${look.tone}`, className].filter(Boolean).join(" "),
					role: "img",
					"aria-label": look.label,
					"data-figure": crew.figure,
				},
				figure,
				look.tone === "merged"
					? h("span", { class: "surface-crew-pip", "aria-hidden": "true" }, icon("check"))
					: null,
			);
			stand.style.setProperty("--crew-colour", crew.color);
			stand.style.setProperty("--crew-size", `${size}px`);
		}
		this.#used.set(key, stand);
		return stand;
	}

	takeExploration(
		exploration: Pick<SurfaceExplorationSet, "id">,
		variants: readonly SurfaceSession[],
		size: number,
		className = "",
	): HTMLElement {
		const look = explorationCrewLook(variants);
		const crew = sessionCrew(exploration.id);
		const key = JSON.stringify([
			"exploration",
			exploration.id,
			size,
			look.tone,
			look.activity,
			look.ask ?? "",
			className,
		]);
		let stand = this.#used.get(key) ?? this.#kept.get(key);
		if (!stand) {
			const figure = figureElement(crew.figure, crew.color, {
				size,
				identity: `surface-exploration:${exploration.id}`,
				activity: look.activity,
				alive: look.alive,
				...(look.ask ? { ask: look.ask } : {}),
			});
			stand = h(
				"span",
				{
					class: ["surface-crew", `is-${look.tone}`, className].filter(Boolean).join(" "),
					role: "img",
					"aria-label": look.label,
					"data-figure": crew.figure,
				},
				figure,
			);
			stand.style.setProperty("--crew-colour", crew.color);
			stand.style.setProperty("--crew-size", `${size}px`);
		}
		this.#used.set(key, stand);
		return stand;
	}

	takeScheduled(id: string, enabled: boolean, size: number, label: string): HTMLElement {
		const crew = sessionCrew(id);
		const key = JSON.stringify(["scheduled", id, enabled, size]);
		let stand = this.#used.get(key) ?? this.#kept.get(key);
		if (!stand) {
			const figure = figureElement(crew.figure, crew.color, {
				size,
				identity: `scheduled-agent:${id}`,
				activity: "Idle",
				alive: enabled,
			});
			stand = h(
				"span",
				{
					class: `surface-crew ${enabled ? "is-ready" : "is-merged"}`,
					role: "img",
					"aria-label": label,
					"data-figure": crew.figure,
				},
				figure,
			);
			stand.style.setProperty("--crew-colour", crew.color);
			stand.style.setProperty("--crew-size", `${size}px`);
		}
		this.#used.set(key, stand);
		return stand;
	}

	settle(): void {
		this.#kept = this.#used;
		this.#used = new Map();
	}
}
