import {
	type CompanyComputerResetServiceRestartCompletion,
	type CompanyComputerResetServiceRestartRequest,
	parseCompanyComputerResetServiceRestartCompletion,
	parseCompanyComputerResetServiceRestartInspection,
	parseCompanyComputerResetServiceRestartRequest,
} from "@qorpera/contracts";
import type { LxdOfficeResetServiceRestartClient } from "./lxd-client.ts";
import type { LxdOfficeGuestBinding } from "./lxd-office-guest.ts";
import { LxdOfficeTypedInspectionControl } from "./lxd-office-typed-inspection.ts";
export class LxdOfficeResetServiceRestartInspectionControl extends LxdOfficeTypedInspectionControl<
	CompanyComputerResetServiceRestartRequest,
	CompanyComputerResetServiceRestartCompletion
> {
	constructor(
		root: string,
		binding: LxdOfficeGuestBinding,
		client: Pick<
			LxdOfficeResetServiceRestartClient,
			"submitOfficeResetServiceRestartInspection" | "inspectOfficeResetServiceRestart" | "readInstanceFile"
		>,
	) {
		super(
			root,
			binding,
			{
				submit: (...args) => client.submitOfficeResetServiceRestartInspection(...args),
				inspect: (...args) => client.inspectOfficeResetServiceRestart(...args),
				readInstanceFile: (...args) => client.readInstanceFile(...args),
			},
			{
				purpose: "reset-service-restart",
				parseRequest: parseCompanyComputerResetServiceRestartRequest,
				parseCompletion: parseCompanyComputerResetServiceRestartCompletion,
				parseInspection: parseCompanyComputerResetServiceRestartInspection,
			},
		);
	}
}
