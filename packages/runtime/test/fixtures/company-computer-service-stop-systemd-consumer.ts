import { createCompanyComputerServiceStopSystemdManager } from "../../src/cloud-company-computer-service-stop-systemd.ts";

try {
	const result = await createCompanyComputerServiceStopSystemdManager().inspect(AbortSignal.timeout(15000));
	console.log(JSON.stringify(result));
} catch {
	console.error("OFFICE_STOP_OBSERVATION_UNCONFIRMED");
	process.exitCode = 1;
}
