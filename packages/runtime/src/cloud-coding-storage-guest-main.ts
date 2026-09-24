import { installCloudCodingGuestConfiguration } from "./cloud-coding-configuration-install.ts";
import { initializeCloudCodingGuestStorage } from "./cloud-coding-storage-guest.ts";
import { assertGuestImageSelfUpdateMasked } from "./lxd-guest-image-updates.ts";

const ACTIONS = {
	initialize: initializeCloudCodingGuestStorage,
	install: installCloudCodingGuestConfiguration,
	// The executor's readiness probe: refuses unless the image cannot update itself.
	image: () => assertGuestImageSelfUpdateMasked(),
} as const;

// Keep CLI behavior out of the library: it is also bundled into the command and
// Git entrypoints, whose import.meta.url becomes their containing bundle URL.
const action = process.argv[2];
if (process.argv.length !== 3 || !Object.hasOwn(ACTIONS, action)) {
	process.stderr.write("CODING_GUEST_STORAGE_ARGUMENTS_INVALID\n");
	process.exitCode = 1;
} else
	ACTIONS[action as keyof typeof ACTIONS]().catch(() => {
		process.stderr.write("CODING_GUEST_STORAGE_REFUSED\n");
		process.exitCode = 1;
	});
