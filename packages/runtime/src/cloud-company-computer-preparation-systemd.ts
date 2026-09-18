import type {
	CompanyComputerPreparationManager,
	CompanyComputerPreparationUnitState,
} from "./cloud-company-computer-preparation-control.ts";
import {
	assertCompanyComputerSystemdImage,
	base,
	checkLoaded,
	integer,
	office,
	preparation,
	properties,
	systemctl,
	unit,
} from "./cloud-company-computer-systemd.ts";

export function parseCompanyComputerPreparationUnitState(text: string): CompanyComputerPreparationUnitState {
	const service = properties(text, preparation);
	checkLoaded(service, unit);
	if (
		service.Type !== "oneshot" ||
		service.RemainAfterExit !== "yes" ||
		(service.InvocationID !== "" && !/^(?!0{32}$)[0-9a-f]{32}$/.test(service.InvocationID)) ||
		!/^[a-z-]+$/.test(service.ActiveState) ||
		!/^[a-z-]+$/.test(service.SubState) ||
		!/^[a-z-]+$/.test(service.Result)
	)
		throw new Error("OFFICE_SYSTEMD_STATE_UNCONFIRMED");
	return {
		invocationId: service.InvocationID,
		activeState: service.ActiveState,
		subState: service.SubState,
		result: service.Result,
		mainPid: integer(service.MainPID),
		controlPid: integer(service.ControlPID),
		jobId: service.Job === "" ? 0 : integer(service.Job),
		execMainCode: integer(service.ExecMainCode, 6),
		execMainStatus: integer(service.ExecMainStatus, 255),
	};
}

export function parseCompanyComputerPreparationSystemdState(
	text: string,
	officeText: string,
): CompanyComputerPreparationUnitState {
	const ordinary = properties(officeText, base);
	checkLoaded(ordinary, office);
	if (
		ordinary.ActiveState !== "inactive" ||
		ordinary.SubState !== "dead" ||
		ordinary.MainPID !== "0" ||
		ordinary.ControlPID !== "0" ||
		ordinary.Job !== ""
	)
		throw new Error("OFFICE_ORDINARY_SERVICE_NOT_STOPPED");
	return parseCompanyComputerPreparationUnitState(text);
}

export function createCompanyComputerPreparationSystemdManager(): CompanyComputerPreparationManager {
	return {
		async inspect(signal) {
			await assertCompanyComputerSystemdImage();
			signal.throwIfAborted();
			const ordinary = await systemctl(["show", "--all", `--property=${base.join(",")}`, office], 5000, signal);
			const observed = await systemctl(["show", "--all", `--property=${preparation.join(",")}`, unit], 5000, signal);
			return parseCompanyComputerPreparationSystemdState(observed, ordinary);
		},
		async start(signal) {
			await assertCompanyComputerSystemdImage();
			await systemctl(["start", unit], 320000, signal);
		},
	};
}
