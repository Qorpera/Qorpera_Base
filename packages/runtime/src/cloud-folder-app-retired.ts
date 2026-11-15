import {
	APP_RETIRED_MAX_BYTES,
	APP_RETIRED_PATH,
	isAppRetiredPath,
	parseRetiredApps,
	type RetiredApp,
} from "@qorpera/cloud-client/app-retired";
import { companyPathKey } from "@qorpera/cloud-client/company-state-shared";
import { APPS_FOLDER, appPath } from "@qorpera/cloud-client/interface-apps";
import type { CloudCompanyFolderClient, CloudCompanyFolderFileEntry } from "./cloud-company-folder-client.ts";
import { CloudCompanyPathNotText } from "./cloud-company-path-gateway.ts";
import { unavailable } from "./cloud-folder-file-tools.ts";
import { CloudToolRefusal } from "./cloud-native-tool-boundary.ts";

/*
 * Retired interfaces (the founder, 15 November 2026: a member right-clicks an interface to "stop maintaining it, and
 * hide it"): a member retires an agent's interface app from their own sidebar, which writes its line into
 * `apps/retired.md` (the format is the cloud client's `app-retired.ts`, which the web reads too). The interface is then
 * the members' alone: no agent changes it, posts it or writes into its folder, and no agent writes the file, until a
 * member brings it back (deploy/first-node/RUNTIME-INTERFACE-APPS.md §3e).
 *
 * The file is read here as the run's own read of the folder, as `organize_apps` reads `apps/groups.md`: a tool that
 * answers releases it with its other reads, and a refusal shows only the app's name and the day it was retired.
 */

export interface RetiredAppsRead {
	/** The file as read, for the answer's release; null when there is none, or it is not text a reader takes. */
	readonly entry: CloudCompanyFolderFileEntry | null;
	/** The retired interfaces, by folder name. */
	readonly apps: ReadonlyMap<string, RetiredApp>;
}

/** The members' list of retired interfaces, as the run reads it. A file that is not text, or larger than a reader
 * takes, retires nothing. `what` is what a failed read says was not done ("saved", "written"). */
export async function readRetiredApps(
	folder: CloudCompanyFolderClient,
	signal: AbortSignal,
	what: string,
): Promise<RetiredAppsRead> {
	let found: { entry: CloudCompanyFolderFileEntry; text: string } | null = null;
	try {
		found = await folder.readText(APP_RETIRED_PATH, APP_RETIRED_MAX_BYTES, signal);
	} catch (error) {
		if (!(error instanceof CloudCompanyPathNotText)) return unavailable(error, what);
	}
	return {
		entry: found?.entry ?? null,
		apps: new Map(parseRetiredApps(found?.text ?? null).map((app) => [app.name, app])),
	};
}

const MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

/** The refusal of any agent's change of a retired interface (the lead of lanes/company-reading-20261114 wrote it). */
export function appRetiredRefusal(app: RetiredApp): CloudToolRefusal {
	const at = new Date(app.at);
	const day = `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}`;
	return new CloudToolRefusal(
		`APP_RETIRED: a member retired the interface ${app.name} on ${day}. Leave it: do not change it, post it or remake it under another name, and conclude any routine you keep only for it. A member brings it back from their own sidebar; tell whoever asked for the change.`,
	);
}

/** The refusal of any agent's change of the file itself. */
export const APP_RETIRED_MEMBERS_ONLY = `APP_RETIRED_MEMBERS_ONLY: nothing was changed; ${APP_RETIRED_PATH} lists the interfaces members retired, and only a member retires an interface or brings one back, from their own sidebar. Leave the file as it is.`;

/** Refuses the retired app `name`, when it is one. Answers the read, so a tool that goes on releases it. */
export async function refuseRetiredApp(
	folder: CloudCompanyFolderClient,
	name: string,
	signal: AbortSignal,
	what: string,
): Promise<RetiredAppsRead> {
	const read = await readRetiredApps(folder, signal, what);
	const retired = read.apps.get(name);
	if (retired) throw appRetiredRefusal(retired);
	return read;
}

/**
 * The file tools' check of a change at `path` (a write, an edit, a new folder, a move's either end, a deletion): the
 * file itself is the members' alone; a path in a retired app's folder, the folder itself included, is refused as the
 * app is. With `moved`, the path is the source of a move: moving the apps folder would take the file with it, so that
 * is the members' alone too while the file is there.
 */
export async function refuseRetiredPath(
	folder: CloudCompanyFolderClient,
	path: string,
	signal: AbortSignal,
	what: string,
	moved = false,
): Promise<void> {
	if (isAppRetiredPath(path)) throw new CloudToolRefusal(APP_RETIRED_MEMBERS_ONLY);
	if (moved && companyPathKey(path) === companyPathKey(APPS_FOLDER)) {
		if ((await readRetiredApps(folder, signal, what)).entry !== null)
			throw new CloudToolRefusal(APP_RETIRED_MEMBERS_ONLY);
		return;
	}
	const app = appPath(path);
	if (app) await refuseRetiredApp(folder, app.name, signal, what);
}
