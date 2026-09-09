import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertCompanyComputerImageArtifact } from "./cloud-company-computer-linux-host.ts";
import {
	controlCompanyComputerPreparation,
	openCompanyComputerPreparationLock,
	parseCompanyComputerPreparationCommand,
} from "./cloud-company-computer-preparation-control.ts";
import { createCompanyComputerPreparationSystemdManager } from "./cloud-company-computer-preparation-systemd.ts";

const executable = "/opt/qorpera-office/qorpera-company-computer-preparation-control.mjs";

/** Open an existing protected lock before invoking flock through its inherited
 * descriptor. flock cannot silently create a missing lock at this path. The
 * no-fork child rechecks actual kernel ownership before any guest mutation. */
export async function lockedCompanyComputerControlChild(
	command: ReturnType<typeof parseCompanyComputerPreparationCommand>,
	signal: AbortSignal,
	controlExecutable = executable,
	inspectionId?: string,
): Promise<void> {
	if (
		![
			executable,
			"/opt/qorpera-office/qorpera-company-computer-configuration-control.mjs",
			"/opt/qorpera-office/qorpera-company-computer-boot-configuration-control.mjs",
			"/opt/qorpera-office/qorpera-company-computer-boot-service-start-control.mjs",
			"/opt/qorpera-office/qorpera-company-computer-boot-service-restart-control.mjs",
			"/opt/qorpera-office/qorpera-company-computer-service-start-control.mjs",
			"/opt/qorpera-office/qorpera-company-computer-service-stop-control.mjs",
			"/opt/qorpera-office/qorpera-company-computer-service-restart-control.mjs",
		].includes(controlExecutable)
	)
		throw new Error("OFFICE_CONTROL_EXECUTABLE_UNCONFIRMED");
	if (inspectionId !== undefined) {
		if (
			![
				"/opt/qorpera-office/qorpera-company-computer-service-start-control.mjs",
				"/opt/qorpera-office/qorpera-company-computer-boot-service-start-control.mjs",
				"/opt/qorpera-office/qorpera-company-computer-boot-service-restart-control.mjs",
				"/opt/qorpera-office/qorpera-company-computer-service-stop-control.mjs",
				"/opt/qorpera-office/qorpera-company-computer-service-restart-control.mjs",
			].includes(controlExecutable) ||
			inspectionId === command.commandId
		)
			throw new Error("OFFICE_CONTROL_EXECUTABLE_UNCONFIRMED");
		parseCompanyComputerPreparationCommand({ ...command, commandId: inspectionId });
	}
	for (const path of [controlExecutable, "/usr/bin/flock", "/usr/bin/node"])
		await assertCompanyComputerImageArtifact(path);
	const lock = await openCompanyComputerPreparationLock();
	try {
		signal.throwIfAborted();
		await new Promise<void>((done, reject) => {
			const child = spawn(
				"/usr/bin/flock",
				[
					"--exclusive",
					"--nonblock",
					"--no-fork",
					"/proc/self/fd/3",
					"/usr/bin/node",
					controlExecutable,
					"--locked",
					command.commandId,
					command.requestSha256,
					command.bootId,
					...(inspectionId === undefined ? [] : [inspectionId]),
				],
				{
					cwd: "/",
					// Supply the empty environment directly. An external env(1)
					// launcher adds no isolation and may be a distribution symlink.
					env: {},
					detached: true,
					stdio: ["ignore", "ignore", "ignore", lock.fd],
				},
			);
			let stopped = false;
			const stop = () => {
				stopped = true;
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
				reject(new Error("OFFICE_PREPARATION_CONTROL_UNCONFIRMED"));
			});
			child.once("close", (code) => {
				signal.removeEventListener("abort", stop);
				if (stopped || signal.aborted || code !== 0) reject(new Error("OFFICE_PREPARATION_CONTROL_UNCONFIRMED"));
				else done();
			});
		});
	} finally {
		await lock.close();
	}
}

export async function runCompanyComputerPreparationControlMain(args: readonly string[]): Promise<void> {
	const locked = args[0] === "--locked";
	const values = locked ? args.slice(1) : args;
	if (values.length !== 3) throw new Error("INVALID_OFFICE_PREPARATION_COMMAND");
	const command = parseCompanyComputerPreparationCommand({
		commandId: values[0],
		requestSha256: values[1],
		bootId: values[2],
	});
	const stop = new AbortController();
	const shutdown = () => stop.abort();
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(350000)]);
	try {
		if (locked)
			await controlCompanyComputerPreparation(command, createCompanyComputerPreparationSystemdManager(), signal);
		else await lockedCompanyComputerControlChild(command, signal);
	} finally {
		stop.abort();
		process.removeListener("SIGINT", shutdown);
		process.removeListener("SIGTERM", shutdown);
	}
}

if (
	process.argv[1] &&
	["cloud-company-computer-preparation-control-main.ts", "qorpera-company-computer-preparation-control.mjs"].includes(
		basename(process.argv[1]),
	) &&
	realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
) {
	if (process.argv.length === 3 && process.argv[2] === "--help")
		console.log(
			"Protected office preparation control. Requires the pinned image, existing kernel lock and exact provider command; never activates an office.",
		);
	else
		runCompanyComputerPreparationControlMain(process.argv.slice(2)).catch(() => {
			console.error(
				"Office preparation control could not confirm the protected request and current unit completion.",
			);
			process.exitCode = 1;
		});
}
