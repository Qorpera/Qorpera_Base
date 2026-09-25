import { AGENTS } from "./agents.ts";
import { COMPANY } from "./company.ts";
import { CONVERSATION } from "./conversation.ts";
import { FOUNDING } from "./founding.ts";
import { SETTINGS } from "./settings.ts";
import { SHARED } from "./shared.ts";
import { WORKSPACE } from "./workspace.ts";

/** Every area's Danish text, by area, for the checks in test/translations.test.ts. */
export const DANISH_PARTS = { SHARED, SETTINGS, CONVERSATION, WORKSPACE, AGENTS, COMPANY, FOUNDING } as const;

export const DANISH: Readonly<Record<string, string>> = Object.assign({}, ...Object.values(DANISH_PARTS));
