import { figureElement, playFigure } from "../../ui/avatar.ts";
import { h } from "../../ui/dom.ts";

const LOOKING_UP = { x: 0.42, y: -0.36 };
const FLIGHT_MS = 900;
const TARGET_WAIT_MS = 5000;
const ARRIVING_MS = 1400;

let stage: HTMLElement | undefined;
let figure: HTMLElement | undefined;
let claimed = false;
let settling = false;
let landing = false;

export function claimStartCrown(): void {
	claimed = true;
	if (stage?.isConnected) return;
	figure = figureElement("crown", undefined, {
		size: 630,
		activity: "Working",
		identity: "start-crown",
		gaze: LOOKING_UP,
	});
	stage = h("div", { class: "start-crown", "aria-hidden": "true" }, figure);
	document.body.append(stage);
}

export function settleStartCrown(): void {
	claimed = false;
	if (settling) return;
	settling = true;
	queueMicrotask(() => {
		settling = false;
		if (!claimed && !landing) removeStage();
	});
}

export function cheerStartCrown(): void {
	playFigure(figure, "cheer");
}

export function landStartCrown(): void {
	if (!stage || !figure || landing) return;
	landing = true;
	const root = document.documentElement;
	root.classList.add("start-arriving");
	setTimeout(() => root.classList.remove("start-arriving"), ARRIVING_MS);
	const flying = figure;
	const began = performance.now();
	const look = () => {
		const target = document.querySelector<HTMLElement>(".cofounder-stand .figure");
		const to = target?.getBoundingClientRect();
		if (!target || !to || to.width === 0) {
			if (performance.now() - began < TARGET_WAIT_MS) requestAnimationFrame(look);
			else land(undefined);
			return;
		}
		const from = flying.getBoundingClientRect();
		const still = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
		if (still || typeof flying.animate !== "function" || from.width === 0) {
			land(undefined);
			return;
		}
		target.classList.add("is-awaited");
		const dx = to.left + to.width / 2 - (from.left + from.width / 2);
		const dy = to.top + to.height / 2 - (from.top + from.height / 2);
		const flight = flying.animate(
			[{ transform: "none" }, { transform: `translate(${dx}px, ${dy}px) scale(${to.width / from.width})` }],
			{ duration: FLIGHT_MS, easing: "cubic-bezier(0.65, 0, 0.35, 1)", fill: "forwards" },
		);
		flight.addEventListener("finish", () => land(target));
		flight.addEventListener("cancel", () => land(target));
	};
	requestAnimationFrame(look);
}

function land(target: HTMLElement | undefined): void {
	target?.classList.remove("is-awaited");
	landing = false;
	removeStage();
}

function removeStage(): void {
	stage?.remove();
	stage = undefined;
	figure = undefined;
}
