import { spawnSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY = fileURLToPath(new URL("../../../..", import.meta.url));

/** Every pinned office control LXD runs with recorded output, and the one
 * fixed line each writes on any failure. */
export const COMPANY_COMPUTER_CONTROLS = [
	["preparation", "Office preparation control could not confirm the protected request and current unit completion."],
	[
		"configuration",
		"Office configuration installation could not confirm protected preparation, configuration and credentials.",
	],
	[
		"boot-configuration",
		"Office boot configuration could not confirm retained history, workbench custody and credentials.",
	],
	[
		"boot-service-start",
		"Office retained-boot service start could not confirm protected configuration and the current invocation.",
	],
	[
		"boot-service-restart",
		"Office retained-boot service restart could not confirm protected configuration and the current invocation.",
	],
	[
		"service-start",
		"Office service start could not confirm protected configuration and the current service invocation.",
	],
	["service-stop", "Office service stop could not confirm the retained request and complete process-group cleanup."],
	["service-restart", "Office service restart could not confirm the retained predecessor and new service invocation."],
	[
		"reset-configuration",
		"Office reset configuration could not confirm restored provenance, workbench custody and credentials.",
	],
	[
		"reset-service-start",
		"Office reset service start could not confirm the restored configuration and the current invocation.",
	],
	[
		"reset-service-restart",
		"Office recreated-root service restart could not confirm protected configuration and the current invocation.",
	],
	["install", "OFFICE_SOFTWARE_CONTROL_UNCONFIRMED"],
	["measure", "OFFICE_SOFTWARE_MEASUREMENT_UNCONFIRMED"],
] as const;

export interface PackagedCompanyComputerControl {
	readonly purpose: (typeof COMPANY_COMPUTER_CONTROLS)[number][0];
	readonly failure: string;
	/** Packaged bundle on this host. */
	readonly file: string;
	/** Where the provider runs it inside the guest. */
	readonly guestPath: string;
}

const softwareFiles = { install: "software-control.mjs", measure: "software-measurement-control.mjs" } as const;

/** Builds the controls with the release packaging scripts, not a test build. */
export async function packageCompanyComputerControls(directory: string): Promise<PackagedCompanyComputerControl[]> {
	for (const [script, output] of [
		["scripts/package-company-computer.mjs", "office"],
		["scripts/package-office-service-software-control.mjs", "software"],
	]) {
		const built = spawnSync(process.execPath, [script, "--out", join(directory, output)], {
			cwd: REPOSITORY,
			encoding: "utf8",
			timeout: 120000,
		});
		if (built.status !== 0) throw new Error(`${script} failed: ${built.stderr}`);
	}
	const packaged = [
		...(await readdir(join(directory, "office"))).filter((name) => name.endsWith("-control.mjs")),
		...(await readdir(join(directory, "software"))).filter((name) => name.endsWith(".mjs")),
	].sort();
	const controls = COMPANY_COMPUTER_CONTROLS.map(([purpose, failure]) => {
		const file = purpose === "install" || purpose === "measure" ? softwareFiles[purpose] : undefined;
		return file
			? {
					purpose,
					failure,
					file: join(directory, "software", file),
					guestPath: `/run/qorpera-office-preparation/${file}`,
				}
			: {
					purpose,
					failure,
					file: join(directory, "office", `qorpera-company-computer-${purpose}-control.mjs`),
					guestPath: `/opt/qorpera-office/qorpera-company-computer-${purpose}-control.mjs`,
				};
	});
	const listed = controls.map((control) => control.file.split("/").at(-1)).sort();
	if (packaged.join() !== listed.join()) throw new Error(`Packaged controls differ: ${packaged.join()}`);
	return controls;
}

export const CONTROL_FAULT_SECRET = "protected-request-and-credential-bytes";

/** Test-only faults prepended to a packaged control. The recorded (outer)
 * process takes its fault from QORPERA_TEST_OUTER_FAULT and raises it once the
 * entry is running. The locked child always starts with an empty environment,
 * so it takes its fault from /tmp/qorpera-test-child-fault, writes the secret
 * to every stream and descriptor before anything else runs, and exits. */
const prologue = `{
	const secret = ${JSON.stringify(CONTROL_FAULT_SECRET)};
	const fs = process.getBuiltinModule("node:fs");
	const noise = () => {
		for (const write of [console.log, console.error, (m) => process.stdout.write(m), (m) => process.stderr.write(m), (m) => process.emitWarning(m)]) write(secret);
	};
	if (process.argv[2] === "--locked") {
		let fault = "";
		try {
			fault = fs.readFileSync("/tmp/qorpera-test-child-fault", "utf8");
		} catch {}
		if (fault) {
			noise();
			fs.writeSync(1, secret);
			fs.writeSync(2, secret);
			fs.writeFileSync("/tmp/qorpera-test-child-ran", fault);
			if (fault === "success") process.exit(0);
			if (fault === "refusal") process.exit(1);
			throw new Error(secret);
		}
	} else if (process.env.QORPERA_TEST_OUTER_FAULT) {
		const fault = process.env.QORPERA_TEST_OUTER_FAULT;
		setImmediate(() => {
			noise();
			if (fault === "uncaught") throw new Error(secret);
			if (fault === "unhandled") Promise.reject(new Error(secret));
		});
	}
}
`;
export async function withControlFaults(source: string, destination: string): Promise<void> {
	await writeFile(destination, prologue + (await readFile(source, "utf8")), { mode: 0o444 });
}
