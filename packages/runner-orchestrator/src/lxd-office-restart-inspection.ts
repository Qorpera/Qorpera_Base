import {
	type CompanyComputerPreparationCommand,
	type CompanyComputerServiceRestartRequest,
	type CompanyComputerServiceStartCompletion,
	parseCompanyComputerServiceRestartCompletion,
	parseCompanyComputerServiceRestartRequest,
} from "@qorpera/contracts";
import type { LxdOfficeServiceRestartClient } from "./lxd-client.ts";
import type { LxdOfficeGuestBinding } from "./lxd-office-guest.ts";
import { LxdOfficeServiceInspectionControl } from "./lxd-office-service-inspection.ts";

/** Reuse the finite durable inspection/deadline protocol, selecting only the
 * fixed restart helper and its root inspection file. No start method is exposed
 * to this adapter. The completed restart packet is validated before inspection. */
export class LxdOfficeRestartInspectionControl {
	readonly #inspection: LxdOfficeServiceInspectionControl;
	constructor(
		root: string,
		binding: LxdOfficeGuestBinding,
		client: Pick<
			LxdOfficeServiceRestartClient,
			"submitOfficeServiceRestartInspection" | "inspectOfficeServiceRestart" | "readInstanceFile"
		>,
	) {
		this.#inspection = new LxdOfficeServiceInspectionControl(root, binding, {
			submitOfficeServiceInspection: (...args) => client.submitOfficeServiceRestartInspection(...args),
			inspectOfficeServiceStart: (...args) => client.inspectOfficeServiceRestart(...args),
			readInstanceFile: (project, name, path, limit, signal) => {
				const match = /^\/run\/qorpera-office-preparation\/service-inspection-([0-9a-f-]{36})\.json$/.exec(path);
				if (!match) throw new Error("OFFICE_RESTART_INSPECTION_PATH");
				return client.readInstanceFile(
					project,
					name,
					`/run/qorpera-office-preparation/service-restart-inspection-${match[1]}.json`,
					limit,
					signal,
				);
			},
		});
	}
	inspectAndUse<T>(
		command: CompanyComputerPreparationCommand,
		value: CompanyComputerServiceRestartRequest,
		completionValue: CompanyComputerServiceStartCompletion,
		authorize: (signal: AbortSignal) => Promise<AbortSignal>,
		use: (
			completion: Readonly<CompanyComputerServiceStartCompletion>,
			signal: AbortSignal,
			assertFresh: () => void,
			deadline: number,
		) => Promise<T>,
		signal: AbortSignal,
		settle = false,
	): Promise<T> {
		const request = parseCompanyComputerServiceRestartRequest(value);
		const completion = parseCompanyComputerServiceRestartCompletion(completionValue, command, request);
		return this.#inspection.inspectAndUse(command, request.start, completion, authorize, use, signal, settle);
	}
}
