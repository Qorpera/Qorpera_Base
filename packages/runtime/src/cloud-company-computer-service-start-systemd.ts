import type { CompanyComputerPreparationUnitState } from "./cloud-company-computer-preparation-control.ts";
import { parseCompanyComputerPreparationUnitState } from "./cloud-company-computer-preparation-systemd.ts";
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

export interface CompanyComputerServiceUnitState extends CompanyComputerPreparationUnitState {
	controlGroup: string;
	restarts: number;
}
/** Trusted fixed-unit systemd port; injection is only for isolated tests. */
export interface CompanyComputerServiceStartManager {
	inspect(
		signal: AbortSignal,
	): Promise<{ preparation: CompanyComputerPreparationUnitState; service: CompanyComputerServiceUnitState }>;
	start(signal: AbortSignal): Promise<void>;
}
const fields = [
	...base,
	"Type",
	"RemainAfterExit",
	"InvocationID",
	"Result",
	"ExecMainCode",
	"ExecMainStatus",
	"ControlGroup",
	"NRestarts",
	"Restart",
	"User",
	"Group",
];
export function parseCompanyComputerServiceSystemdState(text: string): CompanyComputerServiceUnitState {
	const value = properties(text, fields);
	checkLoaded(value, office);
	if (
		value.Type !== "exec" ||
		value.RemainAfterExit !== "no" ||
		value.Restart !== "on-failure" ||
		value.User !== "qorpera-office" ||
		value.Group !== "qorpera-office" ||
		(value.InvocationID !== "" && !/^(?!0{32}$)[0-9a-f]{32}$/.test(value.InvocationID)) ||
		(value.ControlGroup !== "" && value.ControlGroup !== `/system.slice/${office}`) ||
		![value.ActiveState, value.SubState, value.Result].every((item) => /^[a-z-]+$/.test(item))
	)
		throw new Error("OFFICE_SYSTEMD_STATE_UNCONFIRMED");
	return {
		invocationId: value.InvocationID,
		activeState: value.ActiveState,
		subState: value.SubState,
		result: value.Result,
		mainPid: integer(value.MainPID),
		controlPid: integer(value.ControlPID),
		jobId: value.Job === "" ? 0 : integer(value.Job),
		execMainCode: integer(value.ExecMainCode, 6),
		execMainStatus: integer(value.ExecMainStatus, 255),
		controlGroup: value.ControlGroup,
		restarts: integer(value.NRestarts),
	};
}
export function createCompanyComputerServiceStartSystemdManager(): CompanyComputerServiceStartManager {
	return {
		async inspect(signal) {
			await assertCompanyComputerSystemdImage();
			signal.throwIfAborted();
			const prepared = await systemctl(["show", "--all", `--property=${preparation.join(",")}`, unit], 5000, signal);
			const service = await systemctl(["show", "--all", `--property=${fields.join(",")}`, office], 5000, signal);
			return {
				preparation: parseCompanyComputerPreparationUnitState(prepared),
				service: parseCompanyComputerServiceSystemdState(service),
			};
		},
		async start(signal) {
			await assertCompanyComputerSystemdImage();
			// A crashed predecessor leaves the unit failed and, with Restart=on-failure,
			// systemd's own registry-refused restarts may have exhausted the start
			// limit; the governed successor start clears both before starting. A unit
			// that never ran in this boot is not loaded, and reset-failed refuses it,
			// so the reset is issued only for an actually failed unit.
			const state = (await systemctl(["show", "--property=ActiveState", "--value", office], 5000, signal)).trim();
			if (state === "failed") await systemctl(["reset-failed", office], 10000, signal);
			await systemctl(["start", office], 30000, signal);
		},
	};
}

export async function readCompanyComputerServiceSystemdState(
	signal: AbortSignal,
): Promise<CompanyComputerServiceUnitState> {
	await assertCompanyComputerSystemdImage();
	return parseCompanyComputerServiceSystemdState(
		await systemctl(["show", "--all", `--property=${fields.join(",")}`, office], 5000, signal),
	);
}
