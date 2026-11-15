import { Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { desktopStreamProgramVersion, runDesktopStreamInstance } from "../../src/company-machine-stream-process.ts";

// The real instance whose version is its own file's sha-256, as the executor's file is, and whose relay fails as LXD's
// does for a machine that is not there: what the units' smoke (deploy/coding-worker/desktop-stream-smoke.mjs) meets.
runDesktopStreamInstance({
	connection: new Socket({ fd: 0, readable: true, writable: true }),
	version: desktopStreamProgramVersion(fileURLToPath(import.meta.url)),
	openRelay: () => async () => {
		throw new Error("Instance not found");
	},
});
