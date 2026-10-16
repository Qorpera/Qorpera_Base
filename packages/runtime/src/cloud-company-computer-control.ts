import {
	assertCompanyComputerLease,
	assertCompanyComputerScope,
	type CompanyComputerDriver,
	type CompanyComputerScope,
	type CompanyComputerScreenLease,
} from "@qorpera/cloud-client/cloud-company-computer-contract";
import {
	CompanyComputerScreenAdmissionRefusedError,
	type CompanyComputerScreenLeaseControl,
} from "./cloud-company-computer-leases.ts";
import { type CompanyComputerCloudEndpoint, createCompanyComputerTools } from "./cloud-company-computer-tools.ts";
import { type CloudNativeToolRun, cloudToolRequest } from "./cloud-native-tool-authority.ts";
import type { CloudNativeToolOperations } from "./cloud-native-tool-operations.ts";

/** Host composition only; scope and endpoint come from the office service's
 * authenticated descriptor, never the execution payload or model arguments.
 */
export function createCloudCompanyComputerSession(options: {
	run: CloudNativeToolRun;
	operations: CloudNativeToolOperations;
	scope: CompanyComputerScope;
	control: CompanyComputerRegistryControl;
	endpoint: CompanyComputerCloudEndpoint;
	/** The run's own offline commands, shared with its action review (F3 4d). */
	offlineShells?: Set<string>;
}): ReturnType<typeof createCompanyComputerTools> {
	return createCompanyComputerTools({
		...options,
		screens: new CloudCompanyComputerScreenControl(options),
	});
}

export type CloudCompanyComputerSessionFactory = (
	run: CloudNativeToolRun,
	operations: CloudNativeToolOperations,
	/** offlineShells: the run's own offline commands, which the computer tools add to and its action review reads. */
	options?: { offlineShells?: Set<string> },
) => Promise<
	| (ReturnType<typeof createCloudCompanyComputerSession> & {
			captures?: import("./cloud-native-capture-images.ts").CloudNativeCaptureImages;
			/** The run's desktop folder reports (F3 4f-2b), for its tool results. */
			folderReports?: import("./cloud-native-tool-boundary.ts").CloudNativeFolderReports;
	  })
	| undefined
>;

export interface CompanyComputerRegistryControl {
	call(method: "qorpera_native_office_screen", args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}

function record(value: unknown, keys: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys) {
		throw new Error("INVALID_OFFICE_REGISTRY_RESPONSE");
	}
	return value as Record<string, unknown>;
}

/** Trusted runtime adapter. The database re-derives all principals from the full
 * native binding; the model and the desktop never receive this transport.
 * In particular, an error message resembling an occupancy refusal is not one.
 */
export class CloudCompanyComputerScreenControl implements CompanyComputerScreenLeaseControl {
	readonly #run: CloudNativeToolRun;
	readonly #control: CompanyComputerRegistryControl;
	readonly #scope: CompanyComputerScope;
	readonly #driver: CompanyComputerDriver;

	constructor(options: {
		run: CloudNativeToolRun;
		scope: CompanyComputerScope;
		control: CompanyComputerRegistryControl;
	}) {
		assertCompanyComputerScope(options.scope, options.scope);
		if (
			options.scope.companyId !== options.run.identity.companyId ||
			options.scope.environmentId !== options.run.identity.environmentId
		) {
			throw new Error("COMPUTER_RUN_MISMATCH");
		}
		this.#run = options.run;
		this.#scope = Object.freeze({ ...options.scope });
		this.#control = options.control;
		this.#driver = Object.freeze({
			kind: "agent",
			runId: options.run.identity.runId,
			staffAgentId: options.run.identity.staffAgentId,
		});
	}

	async #call(action: string, lease: CompanyComputerScreenLease | null, signal: AbortSignal): Promise<unknown> {
		if (lease) {
			assertCompanyComputerScope(lease.binding, this.#scope);
			assertCompanyComputerLease(lease, lease.binding, this.#driver);
		}
		// Cleanup has its own exact, non-effect authority and survives run abort.
		const requestLease = lease ? structuredClone(lease) : null;
		return cloudToolRequest(
			(requestSignal) =>
				this.#control.call(
					"qorpera_native_office_screen",
					{
						p_binding: this.#run.binding,
						p_scope: this.#scope,
						p_action: action,
						p_lease: requestLease,
					},
					requestSignal,
				),
			action === "release" ? signal : AbortSignal.any([signal, this.#run.signal]),
		);
	}

	#lease(value: unknown, previous?: CompanyComputerScreenLease): CompanyComputerScreenLease {
		const response = record(value, "lease,state");
		if (response.state !== "admitted") throw new Error("OFFICE_LEASE_NOT_ADMITTED");
		const lease = record(response.lease, "binding,driver,epoch,leaseId,validForMs");
		record(
			lease.binding,
			"companyComputerId,companyId,computerGeneration,environmentId,logicalComputerId,screenGeneration,screenId,screenOrdinal,staffAgentId",
		);
		record(lease.driver, "kind,runId,staffAgentId");
		const parsed = lease as unknown as CompanyComputerScreenLease;
		assertCompanyComputerScope(parsed.binding, this.#scope);
		assertCompanyComputerLease(parsed, previous?.binding ?? parsed.binding, this.#driver);
		if (previous && (parsed.leaseId !== previous.leaseId || parsed.epoch !== previous.epoch)) {
			throw new Error("OFFICE_LEASE_CHANGED");
		}
		return structuredClone(parsed);
	}

	async acquire(scope: CompanyComputerScope, signal: AbortSignal): Promise<CompanyComputerScreenLease> {
		assertCompanyComputerScope(scope, this.#scope);
		const result = await this.#call("acquire", null, signal);
		if (
			result &&
			typeof result === "object" &&
			!Array.isArray(result) &&
			"state" in result &&
			result.state === "refused"
		) {
			const refusal = record(result, "reason,state");
			if (refusal.reason !== "SCREEN_OCCUPIED" && refusal.reason !== "SCREEN_CAPACITY_EXHAUSTED") {
				throw new Error("INVALID_OFFICE_REGISTRY_REFUSAL");
			}
			throw new CompanyComputerScreenAdmissionRefusedError(refusal.reason);
		}
		return this.#lease(result);
	}

	async renew(lease: CompanyComputerScreenLease, signal: AbortSignal): Promise<CompanyComputerScreenLease> {
		return this.#lease(await this.#call("renew", lease, signal), lease);
	}

	async check(lease: CompanyComputerScreenLease, signal: AbortSignal): Promise<CompanyComputerScreenLease> {
		return this.#lease(await this.#call("check", lease, signal), lease);
	}

	async release(lease: CompanyComputerScreenLease, signal: AbortSignal): Promise<void> {
		const result = record(await this.#call("release", lease, signal), "state");
		if (result.state !== "released") throw new Error("OFFICE_RELEASE_UNCONFIRMED");
	}
}
