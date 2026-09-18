import {
	type CompanyComputerBootServiceStartCompletion,
	type CompanyComputerBootServiceStartRequest,
	parseCompanyComputerBootServiceInspection,
	parseCompanyComputerBootServiceStartCompletion,
	parseCompanyComputerBootServiceStartRequest,
} from "@qorpera/contracts";
import type { LxdOfficeBootServiceStartClient } from "./lxd-client.ts";
import type { LxdOfficeGuestBinding } from "./lxd-office-guest.ts";
import { LxdOfficeTypedInspectionControl } from "./lxd-office-typed-inspection.ts";
export class LxdOfficeBootServiceInspectionControl extends LxdOfficeTypedInspectionControl<
	CompanyComputerBootServiceStartRequest,
	CompanyComputerBootServiceStartCompletion
> {
	constructor(
		root: string,
		binding: LxdOfficeGuestBinding,
		client: Pick<
			LxdOfficeBootServiceStartClient,
			"submitOfficeBootServiceInspection" | "inspectOfficeBootServiceStart" | "readInstanceFile"
		>,
	) {
		super(
			root,
			binding,
			{
				submit: (...args) => client.submitOfficeBootServiceInspection(...args),
				inspect: (...args) => client.inspectOfficeBootServiceStart(...args),
				readInstanceFile: (...args) => client.readInstanceFile(...args),
			},
			{
				purpose: "boot-service",
				parseRequest: parseCompanyComputerBootServiceStartRequest,
				parseCompletion: parseCompanyComputerBootServiceStartCompletion,
				parseInspection: parseCompanyComputerBootServiceInspection,
			},
		);
	}
}
