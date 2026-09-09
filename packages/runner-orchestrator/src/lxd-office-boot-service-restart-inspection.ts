import {
	type CompanyComputerBootServiceRestartCompletion,
	type CompanyComputerBootServiceRestartRequest,
	parseCompanyComputerBootServiceRestartCompletion,
	parseCompanyComputerBootServiceRestartInspection,
	parseCompanyComputerBootServiceRestartRequest,
} from "@qorpera/contracts";
import type { LxdOfficeBootServiceRestartClient } from "./lxd-client.ts";
import type { LxdOfficeGuestBinding } from "./lxd-office-guest.ts";
import { LxdOfficeTypedInspectionControl } from "./lxd-office-typed-inspection.ts";
export class LxdOfficeBootServiceRestartInspectionControl extends LxdOfficeTypedInspectionControl<
	CompanyComputerBootServiceRestartRequest,
	CompanyComputerBootServiceRestartCompletion
> {
	constructor(
		root: string,
		binding: LxdOfficeGuestBinding,
		client: Pick<
			LxdOfficeBootServiceRestartClient,
			"submitOfficeBootServiceRestartInspection" | "inspectOfficeBootServiceRestart" | "readInstanceFile"
		>,
	) {
		super(
			root,
			binding,
			{
				submit: (...args) => client.submitOfficeBootServiceRestartInspection(...args),
				inspect: (...args) => client.inspectOfficeBootServiceRestart(...args),
				readInstanceFile: (...args) => client.readInstanceFile(...args),
			},
			{
				purpose: "boot-service-restart",
				parseRequest: parseCompanyComputerBootServiceRestartRequest,
				parseCompletion: parseCompanyComputerBootServiceRestartCompletion,
				parseInspection: parseCompanyComputerBootServiceRestartInspection,
			},
		);
	}
}
