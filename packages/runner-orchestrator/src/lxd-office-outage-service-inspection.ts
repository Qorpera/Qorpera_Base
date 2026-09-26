import {
	type CompanyComputerOutageServiceStartCompletion,
	type CompanyComputerOutageServiceStartRequest,
	parseCompanyComputerOutageServiceInspection,
	parseCompanyComputerOutageServiceStartCompletion,
	parseCompanyComputerOutageServiceStartRequest,
} from "@qorpera/contracts";
import type { LxdOfficeOutageServiceStartClient } from "./lxd-client.ts";
import type { LxdOfficeGuestBinding } from "./lxd-office-guest.ts";
import { LxdOfficeTypedInspectionControl } from "./lxd-office-typed-inspection.ts";

export class LxdOfficeOutageServiceInspectionControl extends LxdOfficeTypedInspectionControl<
	CompanyComputerOutageServiceStartRequest,
	CompanyComputerOutageServiceStartCompletion
> {
	constructor(
		root: string,
		binding: LxdOfficeGuestBinding,
		client: Pick<
			LxdOfficeOutageServiceStartClient,
			"submitOfficeOutageServiceInspection" | "inspectOfficeOutageServiceStart" | "readInstanceFile"
		>,
	) {
		super(
			root,
			binding,
			{
				submit: (...args) => client.submitOfficeOutageServiceInspection(...args),
				inspect: (...args) => client.inspectOfficeOutageServiceStart(...args),
				readInstanceFile: (...args) => client.readInstanceFile(...args),
			},
			{
				purpose: "outage-service",
				parseRequest: parseCompanyComputerOutageServiceStartRequest,
				parseCompletion: parseCompanyComputerOutageServiceStartCompletion,
				parseInspection: parseCompanyComputerOutageServiceInspection,
			},
		);
	}
}
