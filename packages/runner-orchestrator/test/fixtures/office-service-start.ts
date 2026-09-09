import { createHash } from "node:crypto";
import {
	COMPANY_COMPUTER_CONFIGURATION_FILES,
	type CompanyComputerConfigurationCompletion,
	type CompanyComputerServiceStartCompletion,
	parseCompanyComputerServiceStartRequest,
} from "@qorpera/contracts";
export const serviceStartId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export function officeServiceStartFixture() {
	const id = serviceStartId;
	const configuration: CompanyComputerConfigurationCompletion = {
		schema: "qorpera.office-configuration-completion/v1",
		command: { commandId: id(2), bootId: id(1), requestSha256: "a".repeat(64) },
		preparation: { commandId: id(3), bootId: id(1), requestSha256: "b".repeat(64) },
		preparationCompletionSha256: "c".repeat(64),
		adoptionReceiptSha256: "d".repeat(64),
		files: Object.fromEntries(
			Object.values(COMPANY_COMPUTER_CONFIGURATION_FILES).map((file) => [
				file,
				{
					bytes: 64,
					sha256: "e".repeat(64),
				},
			]),
		) as CompanyComputerConfigurationCompletion["files"],
	};
	const request = parseCompanyComputerServiceStartRequest({
		schema: "qorpera.office-service-start-request/v1",
		configuration,
		configurationCompletionSha256: "f".repeat(64),
		attestation: {
			schema: "qorpera.office-activation-attestation/v1",
			activationId: id(4),
			bootId: id(1),
			preparationObservationSha256: "1".repeat(64),
			configurationObservationSha256: "2".repeat(64),
			configurationSha256: "e".repeat(64),
			adoptionReceiptSha256: "d".repeat(64),
			nativePort: 4011,
			viewerPort: 4012,
		},
	});
	const command = {
		commandId: id(5),
		bootId: id(1),
		requestSha256: createHash("sha256").update(JSON.stringify(request)).digest("hex"),
	};
	const completion: CompanyComputerServiceStartCompletion = {
		schema: "qorpera.office-service-start-completion/v1",
		command,
		activationId: id(4),
		configurationCompletionSha256: "f".repeat(64),
		configurationSha256: "e".repeat(64),
		serviceInvocationId: "a".repeat(32),
		mainPid: 500,
		controlGroup: "/system.slice/qorpera-company-computer.service",
	};
	return { request, command, completion };
}
