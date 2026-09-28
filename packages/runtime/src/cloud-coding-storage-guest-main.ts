import {
	installCloudCodingGuestConfiguration,
	prepareCloudCodingGuestSession,
} from "./cloud-coding-configuration-install.ts";
import { codingErrorCode } from "./cloud-coding-error-code.ts";
import { observeCloudCodingGuest } from "./cloud-coding-guest-observation.ts";
import { detachCloudCodingGuestSession } from "./cloud-coding-session-guest.ts";
import { initializeCloudCodingGuestStorage } from "./cloud-coding-storage-guest.ts";
import { assertGuestImageSelfUpdateMasked } from "./lxd-guest-image-updates.ts";

/** One session's actions: `<action> <workerId>`. */
const SESSION_ACTIONS: Record<string, (workerId: string) => Promise<void>> = {
	prepare: prepareCloudCodingGuestSession,
	install: (workerId) => installCloudCodingGuestConfiguration(workerId),
	initialize: (workerId) => initializeCloudCodingGuestStorage(workerId),
	detach: (workerId) => detachCloudCodingGuestSession(workerId),
};

// Keep CLI behavior out of the library: it is also bundled into the command and
// Git entrypoints, whose import.meta.url becomes their containing bundle URL.
const [action, workerId] = process.argv.slice(2);
const run =
	// The executor's readiness probe names no session: it refuses unless the
	// image cannot update itself.
	action === "image" && process.argv.length === 3
		? () => assertGuestImageSelfUpdateMasked()
		: // The executor's keeper: what runs in each attached session, published for readback.
			action === "observe" && process.argv.length === 3
			? async () => {
					await observeCloudCodingGuest();
				}
			: Object.hasOwn(SESSION_ACTIONS, action) && process.argv.length === 4
				? () => SESSION_ACTIONS[action](workerId)
				: undefined;
if (!run) {
	process.stderr.write("CODING_GUEST_STORAGE_ARGUMENTS_INVALID\n");
	process.exitCode = 1;
}
// Only a fixed code follows, e.g. the unit an image refusal names.
else
	run().catch((error: unknown) => {
		process.stderr.write(`CODING_GUEST_STORAGE_REFUSED ${codingErrorCode(error)}\n`);
		process.exitCode = 1;
	});
