import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseCompanyComputerLifecycleRequest } from "@qorpera/contracts";
import {
	isRuntimePaidComputerMachine,
	parsePaidComputerGuardRecord,
	parsePaidComputerPrestartRecord,
} from "./computer-paid-guard.ts";
import { type LxdOfficeGuestBinding, lxdOfficeGuestPlan } from "./lxd-office-guest.ts";
import type { LxdOfficeHostRebootRegistry } from "./lxd-office-host-reboot.ts";
import { officeRecord } from "./lxd-office-image-provenance.ts";
import { code, publish, readRecord } from "./lxd-office-journal-files.ts";
import { assertLxdOfficePhysicalBinding, type LxdOfficePhysicalPolicy } from "./lxd-office-physical-policy.ts";
import type { RuntimeComputerController } from "./runtime-computer-controller.ts";

export const OFFICE_COMPUTER_OUTAGE_RPC = "qorpera_register_runtime_office_computer_outage";

/** A stopped paid guard proves loss of VM execution, never graceful guest
 * cleanup. Keep a separate immutable request/receipt and leave the office held.
 * Both active and maintenance reconciliation must retry a lost committed reply. */
export async function reconcileLxdOfficeComputerOutage(
	policy: LxdOfficePhysicalPolicy,
	binding: LxdOfficeGuestBinding,
	controller: Pick<RuntimeComputerController, "guardRecord" | "prestartStatus">,
	control: { call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> },
	registry: Pick<LxdOfficeHostRebootRegistry, "call">,
	signal: AbortSignal,
): Promise<boolean> {
	assertLxdOfficePhysicalBinding(policy, binding);
	const value = await controller.guardRecord(binding.allocationId, signal);
	if (!value) return false;
	const guard = parsePaidComputerGuardRecord(value);
	if (
		guard.phase !== "stopped" ||
		!guard.startDispatched ||
		!guard.startSettled ||
		!guard.startSucceeded ||
		guard.permit.schema !== "qorpera.computer-usage-permit/v2"
	)
		return false;
	const plan = lxdOfficeGuestPlan(binding),
		machine = guard.machine;
	if (
		!isRuntimePaidComputerMachine(machine) ||
		machine.providerKind !== "office" ||
		machine.allocationId !== binding.allocationId ||
		machine.instanceSha256 !== plan.instanceSha256 ||
		machine.hostMachineIdSha256 !== policy.host.machineIdSha256 ||
		!isDeepStrictEqual(machine.physicalTarget, {
			kind: "lxd",
			project: binding.project,
			instanceName: plan.request.name,
			profiles: plan.request.profiles,
			config: plan.request.config,
			devices: plan.request.devices,
		})
	)
		throw new Error("OFFICE_COMPUTER_OUTAGE_BINDING_DIFFERS");
	const prestart = parsePaidComputerPrestartRecord(await controller.prestartStatus(guard.permit.permitId, signal));
	if (
		!["dispatched", "retired"].includes(prestart.state) ||
		prestart.intent.permitId !== guard.permit.permitId ||
		prestart.intent.allocationId !== binding.allocationId ||
		prestart.intent.instanceSha256 !== plan.instanceSha256 ||
		prestart.intent.hostMachineIdSha256 !== machine.hostMachineIdSha256 ||
		prestart.intent.hostBootId !== machine.hostBootId ||
		!isDeepStrictEqual(guard.permit.prestart, {
			guardIncarnationId: prestart.guardIncarnationId,
			prepareSha256: prestart.intent.prepareSha256,
		})
	)
		throw new Error("OFFICE_COMPUTER_OUTAGE_PRESTART_DIFFERS");
	const proof = {
		permit: guard.permit,
		hostMachineIdSha256: machine.hostMachineIdSha256,
		physicalInstanceId: machine.physicalInstanceId,
		startOperationId: guard.startReference!.operationId,
		startDispatched: true,
		startSettled: true,
		startSucceeded: true,
		stopReceipt: guard.stopReceipt,
	};
	const root = policy.journal.path,
		suffix = `${binding.allocationId}-${guard.permit.permitId}`,
		requestName = `paid-outage-request-${suffix}.json`,
		receiptName = `paid-outage-receipt-${suffix}.json`;
	const optional = async (name: string) => {
		try {
			return (await readRecord(join(root, name), 65536)).value;
		} catch (error) {
			if (!code(error, "ENOENT")) throw error;
			return undefined;
		}
	};
	let retained = await optional(requestName);
	const newRequest = retained === undefined;
	if (retained === undefined) {
		if ((await optional(receiptName)) !== undefined) throw new Error("OFFICE_COMPUTER_OUTAGE_REQUEST_LOST");
		const current = officeRecord(
			await registry.call(
				"qorpera_runtime_office_provider_activation",
				{
					p_scope: {
						companyId: binding.companyId,
						environmentId: binding.environmentId,
						companyComputerId: binding.companyComputerId,
						logicalComputerId: binding.logicalComputerId,
					},
					p_computer_generation: binding.computerGeneration,
					p_provider_id: binding.providerId,
					p_provider_policy_sha256: binding.providerPolicySha256,
				},
				signal,
			),
			["schema", "officeState", "activation"],
		);
		if (current.schema !== "qorpera.office-provider-activation/v1")
			throw new Error("OFFICE_COMPUTER_OUTAGE_ACTIVATION_UNCONFIRMED");
		if (current.activation === null) return false;
		retained = {
			schema: "qorpera.office-computer-outage-request/v1",
			requestId: randomUUID(),
			activation: current.activation,
			guard: proof,
		};
	}
	const request = officeRecord(retained, ["schema", "requestId", "activation", "guard"]),
		activation = officeRecord(request.activation, ["activationId", "providerId", "providerPolicySha256", "startup"]),
		identity = parseCompanyComputerLifecycleRequest({
			schema: "qorpera.office-lifecycle-request/v1",
			transitionId: request.requestId,
			action: "power_off",
			...activation,
		});
	// Reuse the closed identity parser only; this is never submitted as an
	// orderly lifecycle action or treated as a guest stop acknowledgement.
	if (
		request.schema !== "qorpera.office-computer-outage-request/v1" ||
		!isDeepStrictEqual(request.guard, proof) ||
		identity.providerId !== binding.providerId ||
		identity.providerPolicySha256 !== binding.providerPolicySha256 ||
		identity.startup.allocationId !== binding.allocationId ||
		identity.startup.computerGeneration !== binding.computerGeneration ||
		identity.startup.instanceSha256 !== plan.instanceSha256 ||
		identity.startup.imageSha256 !== binding.imageFingerprint ||
		identity.startup.bootstrapSha256 !== binding.bootstrapSha256 ||
		(guard.permit.guestBootId !== null && identity.startup.bootId !== guard.permit.guestBootId) ||
		!isDeepStrictEqual(identity.startup.scope, {
			companyId: binding.companyId,
			environmentId: binding.environmentId,
			companyComputerId: binding.companyComputerId,
			logicalComputerId: binding.logicalComputerId,
		})
	)
		throw new Error("OFFICE_COMPUTER_OUTAGE_REQUEST_DIFFERS");
	signal.throwIfAborted();
	if (newRequest) await publish(root, requestName, Buffer.from(`${JSON.stringify(request)}\n`));
	if (!isDeepStrictEqual(await optional(requestName), request))
		throw new Error("OFFICE_COMPUTER_OUTAGE_REQUEST_CHANGED");
	let receipt = await optional(receiptName);
	const newReceipt = receipt === undefined;
	if (receipt === undefined) receipt = await control.call(OFFICE_COMPUTER_OUTAGE_RPC, { p_request: request }, signal);
	const checked = officeRecord(receipt, ["schema", "request", "state", "officeRevision", "registeredAtMs"]);
	if (
		checked.schema !== "qorpera.office-computer-outage/v1" ||
		(checked.state !== "held" && checked.state !== "orderly") ||
		!isDeepStrictEqual(checked.request, request) ||
		!Number.isSafeInteger(checked.officeRevision) ||
		Number(checked.officeRevision) < 1 ||
		!Number.isSafeInteger(checked.registeredAtMs) ||
		Number(checked.registeredAtMs) < 1
	)
		throw new Error("OFFICE_COMPUTER_OUTAGE_RECEIPT_UNCONFIRMED");
	signal.throwIfAborted();
	if (newReceipt) await publish(root, receiptName, Buffer.from(`${JSON.stringify(checked)}\n`));
	if (!isDeepStrictEqual(await optional(receiptName), checked))
		throw new Error("OFFICE_COMPUTER_OUTAGE_RECEIPT_CHANGED");
	return checked.state === "held";
}
