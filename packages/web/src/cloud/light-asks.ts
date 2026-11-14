/* Light asks (deploy/first-node/RUNTIME-LIGHT-ASK.md, migration 20260930761000; Jonas, 14 Nov 2026, on a group just made
 * in the apps drawer: "when a new group is created, I would like to run a light call, having an agent name it"). One
 * small question a member's own action raises, answered by one call to the small model with no tools; nothing shows in
 * a conversation. The web sends a kind and that kind's input, never a prompt, and reads the answer back. The member's
 * own login pays. Everything here is pure: the cloud's answer as the web reads it, and the first kind's input. */

import { parseRecord, UUID_PATTERN } from "@qorpera/contracts";
import { APP_GROUP_NAME_LIMIT } from "./app-groups.ts";

export const LIGHT_ASK_SCHEMA = "qorpera.light-ask/v1";

export interface LightAsk {
	readonly id: string;
	readonly kind: string;
	/** `waiting` until the run stored its answer; `failed` with `problem` when there will be none. */
	readonly state: "waiting" | "answered" | "failed";
	readonly answer: string | null;
	readonly problem: string | null;
}

/** The cloud's `qorpera.light-ask/v1`. Anything else is refused: an ask the web cannot read is no ask. */
export function parseLightAsk(value: unknown): LightAsk {
	const input = parseRecord(value, "light ask");
	const { id, kind, state } = input;
	const answer = input.answer ?? null;
	const problem = input.problem ?? null;
	if (
		input.schema !== LIGHT_ASK_SCHEMA ||
		typeof id !== "string" ||
		!UUID_PATTERN.test(id) ||
		typeof kind !== "string" ||
		(state !== "waiting" && state !== "answered" && state !== "failed") ||
		(answer !== null && typeof answer !== "string") ||
		(problem !== null && typeof problem !== "string") ||
		(state === "answered") !== (typeof answer === "string" && answer.length > 0)
	)
		throw new Error("Invalid light ask");
	return { id, kind, state, answer, problem };
}

/** The first kind: the name of a new group of apps. */
export const NAME_APP_GROUP = "name-app-group";
export interface NameAppGroupInput {
	readonly apps: readonly { readonly name: string; readonly about?: string }[];
	readonly language: "da" | "en";
}

const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/g;
/** One line of at most `limit` characters, or nothing: control characters are spaces, runs of spaces one. */
function oneLine(value: string | null | undefined, limit: number): string | undefined {
	const text = (value ?? "").replace(CONTROL, " ").replace(/\s+/g, " ").trim();
	return text ? [...text].slice(0, limit).join("").trim() : undefined;
}

/** `name-app-group`'s input as the cloud takes it (`qorpera_light_ask_input_valid`): 2 to 12 apps, each a name of at
 * most 80 characters and, when it has one, a line about it of at most 200. Undefined when the apps do not make one. */
export function nameAppGroupInput(
	apps: readonly { readonly name: string; readonly about?: string | null }[],
	language: "da" | "en",
): NameAppGroupInput | undefined {
	const listed: { name: string; about?: string }[] = [];
	for (const app of apps.slice(0, 12)) {
		const name = oneLine(app.name, 80);
		if (!name) return undefined;
		const about = oneLine(app.about, 200);
		listed.push(about ? { name, about } : { name });
	}
	return listed.length >= 2 ? { apps: listed, language } : undefined;
}

/** An answer as a group's name, as the drawer keeps one (1 to 40 characters, one line); undefined when it is none. */
export function appGroupNameFromAnswer(answer: string | null): string | undefined {
	const name = oneLine(answer, APP_GROUP_NAME_LIMIT + 1);
	return name && [...name].length <= APP_GROUP_NAME_LIMIT ? name : undefined;
}
