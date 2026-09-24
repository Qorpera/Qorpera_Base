import {
	installCloudCodingGuestConfiguration,
	prepareCloudCodingGuestSession,
} from "./cloud-coding-configuration-install.ts";
import { detachCloudCodingGuestSession } from "./cloud-coding-session-guest.ts";
import { initializeCloudCodingGuestStorage } from "./cloud-coding-storage-guest.ts";

// Keep CLI behavior out of the library: it is also bundled into the command and
// Git entrypoints, whose import.meta.url becomes their containing bundle URL.
// Every action is one session's: `<action> <workerId>`.
const [action, workerId] = process.argv.slice(2);
const actions: Record<string, (workerId: string) => Promise<void>> = {
	prepare: prepareCloudCodingGuestSession,
	install: (id) => installCloudCodingGuestConfiguration(id),
	initialize: initializeCloudCodingGuestStorage,
	detach: (id) => detachCloudCodingGuestSession(id),
};
if (process.argv.length !== 4 || !Object.hasOwn(actions, action)) {
	process.stderr.write("CODING_GUEST_STORAGE_ARGUMENTS_INVALID\n");
	process.exitCode = 1;
} else
	actions[action](workerId).catch(() => {
		process.stderr.write("CODING_GUEST_STORAGE_REFUSED\n");
		process.exitCode = 1;
	});
