import { createHash } from "node:crypto";
import {
	COMPANY_COMPUTER_CONFIGURATION_FILES,
	type CompanyComputerPreparationCommand,
	type CompanyComputerPreparationRequest,
	type CompanyComputerResetConfigurationCompletion,
	type CompanyComputerResetPlan,
	parseCompanyComputerConfigurationRequest,
	parseCompanyComputerResetConfigurationRequest,
} from "@qorpera/contracts";
import type { LxdOfficeGuestBinding } from "./lxd-office-guest.ts";
import { createLxdOfficeConfigurationPayload } from "./lxd-office-service-bootstrap.ts";

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
/** Resolve fresh credentials through the existing protected authority path
 * for the permanent original preparation, then rebind only the boot
 * attestation to the recreated root. The original public receipt stays the
 * attested receipt; no secret is read from any root and no historical private
 * key is reused. Caller must wipe the returned bytes. */
export async function createLxdOfficeResetConfigurationPayload(
	path: string,
	binding: LxdOfficeGuestBinding,
	plan: CompanyComputerResetPlan,
	preparation: {
		request: CompanyComputerPreparationRequest;
		command: CompanyComputerPreparationCommand;
		bytes: Buffer;
		adoptionReceiptSha256: string;
	},
	bootId: string,
	signal: AbortSignal,
	ports: Parameters<typeof createLxdOfficeConfigurationPayload>[5] = {},
) {
	const source = await createLxdOfficeConfigurationPayload(
		path,
		binding,
		preparation.request,
		preparation.command,
		signal,
		ports,
	);
	try {
		const {
			schema: _schema,
			preparation: _preparation,
			...material
		} = parseCompanyComputerConfigurationRequest(
			JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(source.bytes)),
		);
		const configuration = JSON.parse(material.configuration) as {
			linux: { attestation: { bootId: string; adoptionReceiptSha256: string } };
		};
		if (
			hash(preparation.bytes) !== preparation.command.requestSha256 ||
			configuration.linux.attestation.bootId !== preparation.request.bootId ||
			configuration.linux.attestation.adoptionReceiptSha256 !== preparation.adoptionReceiptSha256 ||
			bootId === preparation.request.bootId ||
			bootId === plan.predecessor.startup.bootId
		)
			throw new Error("reset configuration source differs");
		configuration.linux.attestation.bootId = bootId;
		const body = parseCompanyComputerResetConfigurationRequest({
			schema: "qorpera.office-reset-configuration-request/v1",
			resetId: plan.resetId,
			rootIncarnationId: plan.rootIncarnationId,
			activationId: plan.successorActivationId,
			predecessor: plan.predecessor,
			originPreparation: preparation.bytes.toString("utf8"),
			originPreparationSha256: preparation.command.requestSha256,
			adoptionReceiptSha256: preparation.adoptionReceiptSha256,
			material: { ...material, configuration: JSON.stringify(configuration) },
		});
		const files = Object.fromEntries(
			Object.entries(COMPANY_COMPUTER_CONFIGURATION_FILES).map(([key, file]) => {
				const value = body.material[key as keyof typeof COMPANY_COMPUTER_CONFIGURATION_FILES];
				return [file, { bytes: Buffer.byteLength(value), sha256: hash(value) }];
			}),
		) as CompanyComputerResetConfigurationCompletion["files"];
		signal.throwIfAborted();
		return {
			plan: source.plan,
			bytes: Buffer.from(JSON.stringify(body)),
			files,
			serviceBootstrapSha256: source.planBytesSha256,
		};
	} finally {
		source.bytes.fill(0);
	}
}
