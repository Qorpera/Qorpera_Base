import { t } from "./preferences.ts";

/** An open card whose work a member stopped (contract 14.6). It stays open; whoever may answer it learns that an
 * answer starts new work instead of carrying on the stopped work. */
export function stoppedCardNote(canAnswer: boolean): string {
	return canAnswer
		? t("A member stopped the work that raised this card. Answering it starts new work.")
		: t("A member stopped the work that raised this card.");
}
