import {
	type CompanyComputerResetServiceStartCompletion,
	type CompanyComputerResetServiceStartRequest,
	parseCompanyComputerResetServiceInspection,
	parseCompanyComputerResetServiceStartCompletion,
	parseCompanyComputerResetServiceStartRequest,
} from "@qorpera/contracts";
import type { LxdOfficeResetSuccessorClient } from "./lxd-client.ts";
import type { LxdOfficeGuestBinding } from "./lxd-office-guest.ts";
import { LxdOfficeTypedInspectionControl } from "./lxd-office-typed-inspection.ts";
/** Fresh nonce inspection of the reset successor's ordinary invocation. */
export class LxdOfficeResetServiceInspectionControl extends LxdOfficeTypedInspectionControl<
	CompanyComputerResetServiceStartRequest,
	CompanyComputerResetServiceStartCompletion
> {
	constructor(
		root: string,
		binding: LxdOfficeGuestBinding,
		client: Pick<
			LxdOfficeResetSuccessorClient,
			"submitOfficeResetServiceInspection" | "inspectOfficeResetServiceStart" | "readInstanceFile"
		>,
	) {
		super(
			root,
			binding,
			{
				submit: (...args) => client.submitOfficeResetServiceInspection(...args),
				inspect: (...args) => client.inspectOfficeResetServiceStart(...args),
				readInstanceFile: (...args) => client.readInstanceFile(...args),
			},
			{
				purpose: "reset-service",
				parseRequest: parseCompanyComputerResetServiceStartRequest,
				parseCompletion: parseCompanyComputerResetServiceStartCompletion,
				parseInspection: parseCompanyComputerResetServiceInspection,
			},
		);
	}
}
