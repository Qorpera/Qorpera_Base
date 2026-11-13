import type { Cloud } from "./client.ts";
import { array, CloudShapeError, record, timestamp, uuid } from "./parse.ts";

/* Which of the company's agents use their desktop computers now (migration 20260930742000): an agent that looked at or
 * acted on its desktop's screen itself within the database's window, on a machine that runs and no member holds
 * privately. The rail shows such a working agent "using its computer", and its thread shows the computer by itself. A
 * cloud before the migration answers the read as missing (CloudRpcError.missing): the web then shows neither. */

export const SCREENS_IN_USE_SCHEMA = "qorpera.company-screens-in-use/v1";

export interface ScreenInUse {
	staffAgentId: string;
	machineId: string;
	/** When this stretch of the agent's use began: a new one is a new stretch. */
	since: string;
	/** The agent's last screen call the database recorded. */
	usedAt: string;
	/** The end of the database's window after that call: the signal is off from then unless a read says otherwise. */
	until: string;
}

export interface ScreensInUse {
	/** The database's time when it answered, for this page's clock. */
	now: string;
	screens: ScreenInUse[];
}

export function parseScreensInUse(value: unknown, profileId: string): ScreensInUse {
	const input = record(value, "screens in use");
	if (
		input.schema !== SCREENS_IN_USE_SCHEMA ||
		typeof input.profileId !== "string" ||
		input.profileId.toLowerCase() !== profileId.toLowerCase()
	)
		throw new CloudShapeError("screens in use");
	const screens = array(input.screens, "screens in use");
	if (screens.length > 50) throw new CloudShapeError("screens in use");
	return {
		now: timestamp(input.now, "screens in use time"),
		screens: screens.map((value): ScreenInUse => {
			const item = record(value, "screen in use");
			return {
				staffAgentId: uuid(item.staffAgentId, "screen in use agent"),
				machineId: uuid(item.machineId, "screen in use machine"),
				since: timestamp(item.since, "screen in use since"),
				usedAt: timestamp(item.usedAt, "screen in use time"),
				until: timestamp(item.until, "screen in use end"),
			};
		}),
	};
}

export async function listScreensInUse(cloud: Cloud, profileId: string): Promise<ScreensInUse> {
	return parseScreensInUse(
		await cloud.rpc("qorpera_list_company_screens_in_use", { p_profile_id: profileId }),
		profileId,
	);
}
