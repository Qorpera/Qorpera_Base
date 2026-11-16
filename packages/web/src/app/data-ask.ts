import type { HostedStaffAgent } from "../cloud/types.ts";
import { APP_NOTE_ABOUT_MAX, APP_NOTE_AT, appNoteAbout, pageNoteLine } from "../cloud/wall-reply.ts";
import type { CompanyController } from "./company.ts";
import { DATA_PAGE } from "./data-page.ts";
import { noteReceiver, type TellNote, type TellResult } from "./tell-agent.ts";

export type DataAskSend = (agentId: string, note: TellNote) => Promise<TellResult>;

export interface DataAskPlace {
	readonly database: string;
	readonly databaseName: string;
	readonly kind: "table" | "question";
	readonly name: string;
	readonly title: string;
	readonly values: readonly string[];
}

export function dataAskLine(place: DataAskPlace): string {
	const thing = `${place.database}${place.kind === "table" ? "." : ":"}${place.name}`;
	const at = APP_NOTE_AT.test(thing) ? thing : APP_NOTE_AT.test(place.database) ? place.database : null;
	const about = appNoteAbout([place.databaseName, place.title, ...place.values].join(" · "));
	const letters = [...about];
	const cut =
		letters.length > APP_NOTE_ABOUT_MAX
			? `${letters
					.slice(0, APP_NOTE_ABOUT_MAX - 1)
					.join("")
					.trimEnd()}…`
			: about;
	return pageNoteLine(DATA_PAGE, at, cut || place.database);
}

export function dataAskReceiver(company: CompanyController): HostedStaffAgent | undefined {
	const found = noteReceiver(company, null);
	return "agent" in found ? found.agent : undefined;
}
