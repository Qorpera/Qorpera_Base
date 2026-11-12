import type { AppIcon } from "@qorpera/cloud-client/app-icons";
import { AGENT_COLOURS, type AgentColour } from "@qorpera/cloud-client/company-state-shared";
import { INTERFACE_EMBLEMS } from "@qorpera/cloud-client/interfaces";
import { AGENT_COLOUR_HEX } from "../cloud/agent-colours.ts";
import { colorName } from "./avatar.ts";
import { h, icon, replace } from "./dom.ts";
import { appIconEmblem, type Emblem, interfaceEmblem } from "./interface-emblem.ts";
import { matchesKey } from "./keys.ts";
import { phrase, t } from "./preferences.ts";

/* Icon and colour (Jonas, 12 Nov 2026: "change the icons of the interfaces and have a generate icon button too", then
 * "still missing a selection of colors from a pallette though"; design page 6gSTTCcz3D8AjBpV3GmrH6): the panel an app's
 * menu opens in the apps drawer. Its colour row is the figure picker's (ui/figure-picker.ts); under it the app's own
 * icons, which its agent drew, then the 24 built-in ones, each in the colour the app is drawn in; Generate icon asks
 * the agent for three more. Everything the member picks is theirs alone (the drawer writes it). */

/** The palette's colours as the figure picker names them (avatar-appearance.js): coral is Red, teal Sky, gray Slate. */
export const COLOUR_LABELS: Readonly<Record<AgentColour, string>> = {
	charcoal: "Charcoal",
	brown: "Brown",
	coral: "Red",
	orange: "Orange",
	gold: "Gold",
	green: "Green",
	teal: "Sky",
	blue: "Blue",
	purple: "Purple",
	pink: "Pink",
	gray: "Slate",
};

export interface AppLookState {
	readonly title: string;
	/** The colour the app's emblems are drawn in now, as a CSS colour (undefined: the text's). */
	readonly ink: string | undefined;
	readonly colour: {
		/** The member's own colour, or null for the drawer's own. */
		readonly chosen: AgentColour | null;
		/** Set for an app in a group: the colour row sets the group's (its name). */
		readonly group?: string;
		readonly choose: (colour: AgentColour | null) => void;
	};
	/** The icons; a group has none (it keeps its stacked cards). */
	readonly emblem?: {
		/** The app's own icon, what Default draws. */
		readonly own: Emblem;
		/** The member's own choice: a built-in name or `custom:<id>`; null for the app's own. */
		readonly chosen: string | null;
		readonly choose: (choice: string | null) => void;
	};
	/** An agent's app: its own icons, and Generate icon. A built-in page has neither. */
	readonly made?: {
		readonly icons: readonly { readonly id: string; readonly icon: AppIcon }[];
		readonly drawing: boolean;
		/** Who draws them: the app's agent, or the Co-Founder. */
		readonly agent: string;
		/** Asks for three; answers why it could not, or null. */
		readonly generate: () => Promise<string | null>;
	};
}

/** The panel, drawn again whenever `subscribe` says something changed, until `dispose`. */
export function appLookPanel(
	read: () => AppLookState | undefined,
	subscribe: (redraw: () => void) => () => void,
): { el: HTMLElement; dispose: () => void } {
	const el = h("div", { class: "app-look" });
	let problem: string | null = null;
	let asking = false;
	const draw = () => {
		const state = read();
		if (!state) return;
		const focused = el.contains(document.activeElement) ? document.activeElement?.getAttribute("aria-label") : null;
		const choice = (label: string, chosen: boolean, picture: SVGSVGElement, choose: () => void) =>
			h(
				"button",
				{
					type: "button",
					class: "app-look-icon",
					role: "radio",
					"aria-checked": String(chosen),
					"aria-label": label,
					title: label,
					tabindex: chosen ? "0" : "-1",
					onclick: choose,
				},
				picture,
			);
		const { colour, emblem, made } = state;
		const builtIn = (name: string) =>
			choice(
				t(EMBLEM_LABELS[name] ?? name),
				(emblem?.chosen ?? emblem?.own) === name,
				interfaceEmblem(name as Emblem, 28),
				() => emblem?.choose(name === emblem?.own ? null : name),
			);
		replace(
			el,
			h("div", { class: "app-look-title" }, state.title),
			h(
				"div",
				{ class: "app-look-label" },
				colour.group ? t("Colour · {group}", { group: colour.group }) : t("Colour"),
			),
			h(
				"div",
				{ class: "color-grid app-look-colours", role: "radiogroup", "aria-label": t("Colour") },
				h("button", {
					type: "button",
					class: "color-choice is-default",
					role: "radio",
					"aria-checked": String(!colour.chosen),
					"aria-label": t("Default"),
					title: t("Default"),
					tabindex: colour.chosen ? "-1" : "0",
					onclick: () => colour.choose(null),
				}),
				...AGENT_COLOURS.map((name) =>
					h("button", {
						type: "button",
						class: "color-choice",
						role: "radio",
						"aria-checked": String(colour.chosen === name),
						"aria-label": colorName(COLOUR_LABELS[name]),
						title: colorName(COLOUR_LABELS[name]),
						tabindex: colour.chosen === name ? "0" : "-1",
						dataset: { color: AGENT_COLOUR_HEX[name] },
						onclick: () => colour.choose(name),
					}),
				),
			),
			colour.group
				? h(
						"p",
						{ class: "app-look-note" },
						t("Apps in {group} take its colour, so this changes all of them.", { group: colour.group }),
					)
				: null,
			...(emblem
				? [
						made ? h("div", { class: "app-look-label" }, t("Made for this app")) : null,
						made
							? h(
									"div",
									{ class: "app-look-icons", role: "radiogroup", "aria-label": t("Made for this app") },
									...(made.drawing
										? [0, 1, 2].map(() => h("span", { class: "app-look-drawing", "aria-hidden": "true" }))
										: []),
									...made.icons.map(({ id, icon: drawn }) =>
										choice(
											id.replace(/-/g, " "),
											emblem.chosen === `custom:${id}`,
											appIconEmblem(drawn, 28),
											() => emblem.choose(`custom:${id}`),
										),
									),
									!made.drawing && !made.icons.length
										? h("span", { class: "app-look-empty" }, t("None yet."))
										: null,
								)
							: null,
						h("div", { class: "app-look-label" }, t("All icons")),
						h(
							"div",
							{ class: "app-look-icons", role: "radiogroup", "aria-label": t("All icons") },
							...(INTERFACE_EMBLEMS.includes(emblem.own as (typeof INTERFACE_EMBLEMS)[number])
								? INTERFACE_EMBLEMS
								: [emblem.own, ...INTERFACE_EMBLEMS]
							).map(builtIn),
						),
					]
				: []),
			made
				? h(
						"button",
						{
							type: "button",
							class: "app-look-generate",
							disabled: made.drawing || asking,
							onclick: async () => {
								asking = true;
								problem = null;
								draw();
								problem = await made.generate();
								asking = false;
								draw();
							},
						},
						icon("sparkle"),
						h(
							"span",
							{ class: "app-look-generate-text" },
							h("b", {}, made.drawing ? t("{agent} is drawing…", { agent: made.agent }) : t("Generate icon")),
							h(
								"small",
								{},
								made.drawing
									? t("3 icons from its name and what it shows. You can close this.")
									: t("{agent} draws 3 from its name and what it shows", { agent: made.agent }),
							),
						),
					)
				: null,
			problem ? h("p", { class: "app-look-problem", role: "alert" }, problem) : null,
			emblem?.chosen
				? h(
						"button",
						{ type: "button", class: "app-look-own", onclick: () => emblem.choose(null) },
						t("Back to the app's own icon"),
					)
				: null,
		);
		if (state.ink) el.style.setProperty("--app-colour", state.ink);
		else el.style.removeProperty("--app-colour");
		for (const swatch of el.querySelectorAll<HTMLElement>("[data-color]"))
			swatch.style.setProperty("--choice-color", swatch.dataset.color ?? "");
		if (focused)
			[...el.querySelectorAll<HTMLButtonElement>("button")]
				.find((b) => b.getAttribute("aria-label") === focused)
				?.focus();
	};
	// Arrow keys move along a row of choices and pick, as in the figure picker.
	el.addEventListener("keydown", (event) => {
		if (!(["left", "right", "first", "last"] as const).some((action) => matchesKey(event, action))) return;
		const group = (event.target as Element).closest("[role=radiogroup]");
		const buttons = [...(group?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
		const index = buttons.indexOf(event.target as HTMLButtonElement);
		if (index < 0) return;
		event.preventDefault();
		event.stopPropagation();
		const next = matchesKey(event, "first")
			? 0
			: matchesKey(event, "last")
				? buttons.length - 1
				: (index + (matchesKey(event, "left") ? -1 : 1) + buttons.length) % buttons.length;
		buttons[next]?.focus();
		buttons[next]?.click();
	});
	draw();
	const stop = subscribe(draw);
	return { el, dispose: stop };
}

/** The built-in icons' names, said in the member's language. */
const EMBLEM_LABELS: Readonly<Record<string, string>> = {
	pulse: phrase("Pulse"),
	mail: phrase("Mail"),
	members: phrase("People"),
	coin: phrase("Coin"),
	board: phrase("Board"),
	queue: phrase("Queue"),
	calendar: phrase("Calendar"),
	hire: phrase("Hire"),
	chart: phrase("Chart"),
	page: phrase("Page"),
	map: phrase("Map"),
	mountain: phrase("Mountain"),
	tent: phrase("Tent"),
	pin: phrase("Pin"),
	cart: phrase("Cart"),
	box: phrase("Box"),
	truck: phrase("Truck"),
	chat: phrase("Chat"),
	star: phrase("Star"),
	heart: phrase("Heart"),
	book: phrase("Book"),
	camera: phrase("Camera"),
	code: phrase("Code"),
	rocket: phrase("Rocket"),
	bank: phrase("Bank"),
	globe: phrase("Globe"),
	spark: phrase("Spark"),
};
