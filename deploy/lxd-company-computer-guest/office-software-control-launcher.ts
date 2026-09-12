import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertCompanyComputerImageArtifact } from "../../packages/runtime/src/cloud-company-computer-linux-host.ts";
import {
	openCompanyComputerPreparationLock,
	readCompanyComputerPreparationProtected,
	OFFICE_PREPARATION_CONTROL_ROOT as root,
} from "../../packages/runtime/src/cloud-company-computer-preparation-control.ts";

/** Deployment-only fixed temporary tools. The provider pins each tool digest
 * independently of the unchanged historical office image. */
export const OFFICE_SOFTWARE_TOOLS = Object.freeze({
	install: `${root}/software-control.mjs`,
	measure: `${root}/software-measurement-control.mjs`,
});
/** Execution bounds only. Provider/SQL original challenge deadlines remain
 * authoritative; neither tool can extend a challenge by running longer. */
export const OFFICE_SOFTWARE_TOOL_TIMEOUT_MS = Object.freeze({ install: 60000, measure: 5000 });

/** Hash and exact source location are checked in both the parent and the
 * locked child; only the child that owns the actual preparation flock works.
 * The child runs with an empty environment and ignored stdio, so no protected
 * request, credential or evidence byte can reach an exec output stream. */
export async function runPinnedOfficeSoftwareTool(
	purpose: keyof typeof OFFICE_SOFTWARE_TOOLS,
	args: readonly string[],
	input: { locked: boolean; toolSha256: string },
	moduleUrl: string,
	work: (signal: AbortSignal) => Promise<unknown>,
): Promise<void> {
	if (!Object.hasOwn(OFFICE_SOFTWARE_TOOLS, purpose) || !/^[0-9a-f]{64}$/.test(input.toolSha256))
		throw new Error("OFFICE_SOFTWARE_CONTROL_TOOL");
	const path = OFFICE_SOFTWARE_TOOLS[purpose];
	const stopped = new AbortController(),
		shutdown = () => stopped.abort();
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	const signal = AbortSignal.any([stopped.signal, AbortSignal.timeout(OFFICE_SOFTWARE_TOOL_TIMEOUT_MS[purpose])]);
	try {
		const tool = await readCompanyComputerPreparationProtected(path, 16 * 1024 ** 2, 0o400);
		if (
			createHash("sha256").update(tool).digest("hex") !== input.toolSha256 ||
			realpathSync(fileURLToPath(moduleUrl)) !== path
		)
			throw new Error("OFFICE_SOFTWARE_CONTROL_TOOL");
		if (input.locked) {
			await work(signal);
			return;
		}
		for (const executable of ["/usr/bin/node", "/usr/bin/flock"]) await assertCompanyComputerImageArtifact(executable);
		const lock = await openCompanyComputerPreparationLock();
		try {
			await new Promise<void>((done, reject) => {
				const child = spawn(
					"/usr/bin/flock",
					["--exclusive", "--nonblock", "--no-fork", "/proc/self/fd/3", "/usr/bin/node", path, "--locked", ...args],
					{ cwd: "/", env: {}, stdio: ["ignore", "ignore", "ignore", lock.fd], detached: true },
				);
				const stop = () => {
					if (child.pid) {
						try {
							process.kill(-child.pid, "SIGKILL");
						} catch {
							child.kill("SIGKILL");
						}
					}
				};
				signal.addEventListener("abort", stop, { once: true });
				if (signal.aborted) stop();
				child.once("error", () => {
					signal.removeEventListener("abort", stop);
					reject(new Error("OFFICE_SOFTWARE_CONTROL_CHILD"));
				});
				child.once("close", (code) => {
					signal.removeEventListener("abort", stop);
					if (code !== 0 || signal.aborted) reject(new Error("OFFICE_SOFTWARE_CONTROL_CHILD"));
					else done();
				});
			});
		} finally {
			await lock.close();
		}
	} finally {
		stopped.abort();
		process.removeListener("SIGINT", shutdown);
		process.removeListener("SIGTERM", shutdown);
	}
}
