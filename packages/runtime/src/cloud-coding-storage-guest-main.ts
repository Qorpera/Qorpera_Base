import { installCloudCodingGuestConfiguration } from "./cloud-coding-configuration-install.ts";
import { initializeCloudCodingGuestStorage } from "./cloud-coding-storage-guest.ts";

// Keep CLI behavior out of the library: it is also bundled into the command and
// Git entrypoints, whose import.meta.url becomes their containing bundle URL.
if (process.argv.length !== 3 || !["initialize", "install"].includes(process.argv[2])) {
	process.stderr.write("CODING_GUEST_STORAGE_ARGUMENTS_INVALID\n");
	process.exitCode = 1;
} else
	(process.argv[2] === "install" ? installCloudCodingGuestConfiguration() : initializeCloudCodingGuestStorage()).catch(
		() => {
			process.stderr.write("CODING_GUEST_STORAGE_REFUSED\n");
			process.exitCode = 1;
		},
	);
