#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { userInfo } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RUN_BOX_COMPANY } from "@qorpera/contracts";
import { RunBoxHost } from "./run-box-host.ts";

/** Entry point of `qorpera-shared-box@.service`: the run box host, inside the box, on the socket its socket unit
 * passes (descriptor 3). It reads no configuration and no credential; HOME and PATH come from the unit. */

const SYSTEMD_LISTEN_FD = 3;

async function main(): Promise<void> {
	if (process.env.LISTEN_PID !== String(process.pid) || process.env.LISTEN_FDS !== "1")
		throw new Error("The run box host is started by its socket unit (qorpera-shared-box@.socket)");
	const home = process.env.HOME;
	if (!home || !isAbsolute(home)) throw new Error("HOME must be absolute");
	await mkdir(home, { recursive: true, mode: 0o700 });
	const user = userInfo().username;
	// Commands get this and nothing else of the unit's environment.
	const environment: Record<string, string> = {
		HOME: home,
		USER: user,
		LOGNAME: user,
		PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
		LANG: process.env.LANG ?? "C.UTF-8",
		TMPDIR: process.env.TMPDIR ?? "/tmp",
		SHELL: "/bin/bash",
		NO_COLOR: "1",
		PAGER: "cat",
		GIT_PAGER: "cat",
	};
	const host = new RunBoxHost({ home: resolve(home), company: RUN_BOX_COMPANY, environment });
	const server = createServer({ allowHalfOpen: false });
	host.serve(server);
	await new Promise<void>((done, fail) => {
		server.once("error", fail);
		server.listen({ fd: SYSTEMD_LISTEN_FD }, done);
	});
	const stop = (): void => {
		host.close();
		server.close();
		process.exit(0);
	};
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
}

const executablePath = process.argv[1];
if (executablePath && realpathSync(resolve(executablePath)) === realpathSync(fileURLToPath(import.meta.url))) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
