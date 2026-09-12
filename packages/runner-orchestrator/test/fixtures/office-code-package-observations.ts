// Build-time Linux proof adapters only. Real filesystem, loader and kernel
// flock remain production code. No production bundle includes this module.
import { appendFile, chown, mkdir, readFile, rename } from "node:fs/promises";

let changed = false;
let historyChanged = false;
export function createCompanyComputerBootConfigurationSystemdManager() {
	return {
		inspect: async () => {
			const fault = await readFile("/tmp/code-package-nas-fault", "utf8").catch(() => "");
			if (fault && !changed) {
				changed = true;
				await rename(fault, `${fault}-displaced`);
				await mkdir(fault, { mode: 0o700 });
				await chown(fault, 1000, 1000);
			}
			const historyFault = await readFile("/tmp/code-package-history-fault", "utf8").catch(() => "");
			if (historyFault && !historyChanged) {
				historyChanged = true;
				await appendFile(historyFault, " ");
			}
			const inactive = {
				invocationId: "",
				activeState: "inactive",
				subState: "dead",
				result: "success",
				mainPid: 0,
				controlPid: 0,
				jobId: 0,
				execMainCode: 0,
				execMainStatus: 0,
			};
			return {
				preparation: inactive,
				service: { ...inactive, controlGroup: "", restarts: 0 },
				cgroupState: "absent",
			};
		},
	};
}
export async function inspectOfficeImageDependencies() {
	return JSON.parse(await readFile("/tmp/code-package-dependencies.json", "utf8"));
}
