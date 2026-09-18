import { createCompanyComputerPreparationSystemdManager } from "../../../runtime/src/cloud-company-computer-preparation-systemd.ts";

const observed = await createCompanyComputerPreparationSystemdManager().inspect(AbortSignal.timeout(10000));
if (
	observed.activeState !== "inactive" ||
	observed.subState !== "dead" ||
	observed.mainPid !== 0 ||
	observed.controlPid !== 0 ||
	observed.jobId !== 0
)
	throw new Error("OFFICE_IMAGE_PREPARATION_NOT_INACTIVE");
console.log("OFFICE_IMAGE_PREPARATION_CONSUMER_ACCEPTED");
