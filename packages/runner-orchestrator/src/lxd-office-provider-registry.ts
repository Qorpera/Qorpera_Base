import type { LxdOfficeActivationRegistry } from "./lxd-office-activation-control.ts";
import type { LxdOfficeBootIntentRegistry } from "./lxd-office-boot-intent-control.ts";
import type { LxdOfficeBootSuccessorRegistry } from "./lxd-office-boot-successor-control.ts";
import type { LxdOfficeCodePackageRegistry } from "./lxd-office-code-package-control.ts";
import type { OfficeFleetMethod } from "./lxd-office-fleet.ts";
import type { LxdOfficeHostRebootRegistry } from "./lxd-office-host-reboot.ts";
import type { LxdOfficeIdleRegistry } from "./lxd-office-idle-policy.ts";
import type { LxdOfficeLifecycleControlRegistry } from "./lxd-office-lifecycle-control.ts";
import type { LxdOfficeProviderRegistry } from "./lxd-office-provider-control.ts";
import type { LxdOfficeResetRegistry, LxdOfficeResetSuccessorRegistry } from "./lxd-office-reset-control.ts";
import type { LxdOfficeRetirementRegistry } from "./lxd-office-retirement-control.ts";
import type { LxdOfficeSoftwareRegistry } from "./lxd-office-software-control.ts";
import type { LxdOfficeSoftwareInvocationRegistry } from "./lxd-office-software-invocation-control.ts";
import type { LxdOfficeStartRegistry } from "./lxd-office-start-control.ts";
import type { LxdOfficeStopRegistry } from "./lxd-office-stop-control.ts";
import type { LxdOfficeSuccessorRegistry } from "./lxd-office-successor-control.ts";

export type LxdOfficeProviderMethod =
	| Parameters<LxdOfficeIdleRegistry["call"]>[0]
	| Parameters<LxdOfficeHostRebootRegistry["call"]>[0]
	| Parameters<LxdOfficeCodePackageRegistry["call"]>[0]
	| Parameters<LxdOfficeProviderRegistry["call"]>[0]
	| Parameters<LxdOfficeStartRegistry["call"]>[0]
	| Parameters<LxdOfficeLifecycleControlRegistry["call"]>[0]
	| Parameters<LxdOfficeStopRegistry["call"]>[0]
	| Parameters<LxdOfficeSuccessorRegistry["call"]>[0]
	| Parameters<LxdOfficeBootSuccessorRegistry["call"]>[0]
	| Parameters<LxdOfficeBootIntentRegistry["call"]>[0]
	| Parameters<LxdOfficeActivationRegistry["call"]>[0]
	| Parameters<LxdOfficeResetRegistry["call"]>[0]
	| Parameters<LxdOfficeResetSuccessorRegistry["call"]>[0]
	| Parameters<LxdOfficeRetirementRegistry["call"]>[0]
	| Parameters<LxdOfficeSoftwareRegistry["call"]>[0]
	| Parameters<LxdOfficeSoftwareInvocationRegistry["call"]>[0];
export interface LxdOfficeLifecycleRegistry {
	call(method: LxdOfficeProviderMethod, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}
/** The closed RPC allowlist. It is a record over the full method type, so a method any
 * lifecycle registry can call but this list omits is a compile error, not a runtime
 * refusal (2026-09-23: #229 added the node suspension call and the provider refused it). */
type OfficeProviderHttpMethod = LxdOfficeProviderMethod | OfficeFleetMethod;
const ALLOWED: Record<OfficeProviderHttpMethod, true> = {
	qorpera_runtime_office_fleet_status: true,
	qorpera_offer_runtime_office_fleet: true,
	qorpera_place_runtime_office_fleet: true,
	qorpera_reconcile_runtime_office_idle: true,
	qorpera_enroll_office_package_provision: true,
	qorpera_check_office_package_provision: true,
	qorpera_check_office_package_provision_observation: true,
	qorpera_ack_office_package_provision: true,
	qorpera_office_package_provision_status: true,
	qorpera_check_office_package_invocation: true,
	qorpera_ack_office_package_invocation: true,
	qorpera_reserve_runtime_node_machine: true,
	qorpera_runtime_office_provider_status: true,
	qorpera_runtime_office_provider_activation: true,
	qorpera_begin_runtime_office_host_reboot: true,
	qorpera_record_runtime_office_host_reboot_resume: true,
	qorpera_reserve_runtime_office_start: true,
	qorpera_check_runtime_office_start: true,
	qorpera_check_runtime_office_adoption: true,
	qorpera_prepare_runtime_office_activation: true,
	qorpera_runtime_office_activation_status: true,
	qorpera_activate_runtime_office: true,
	qorpera_begin_runtime_office_lifecycle: true,
	qorpera_runtime_office_lifecycle_status: true,
	qorpera_prepare_runtime_office_stop: true,
	qorpera_ack_runtime_office_stop: true,
	qorpera_runtime_office_stop_status: true,
	qorpera_prepare_runtime_office_successor: true,
	qorpera_runtime_office_successor_status: true,
	qorpera_check_runtime_office_successor: true,
	qorpera_activate_runtime_office_successor: true,
	qorpera_prepare_runtime_office_boot_successor: true,
	qorpera_runtime_office_boot_successor_status: true,
	qorpera_check_runtime_office_boot_successor: true,
	qorpera_activate_runtime_office_boot_successor: true,
	qorpera_prepare_runtime_office_boot_intent: true,
	qorpera_runtime_office_boot_intent_status: true,
	qorpera_check_runtime_office_boot_intent: true,
	// Governed same-allocation root reset: begin/status, bounded per-phase
	// challenges and the reset successor handoff.
	qorpera_begin_runtime_office_reset: true,
	qorpera_runtime_office_reset_status: true,
	qorpera_prepare_runtime_office_reset_phase: true,
	qorpera_check_runtime_office_reset_phase: true,
	qorpera_ack_runtime_office_reset_phase: true,
	qorpera_prepare_runtime_office_reset_successor: true,
	qorpera_runtime_office_reset_successor_status: true,
	qorpera_check_runtime_office_reset_successor: true,
	qorpera_activate_runtime_office_reset_successor: true,
	// Governed service-only software revisions; every call also carries the
	// separate provider capability, which SQL requires and never returns.
	qorpera_enroll_office_software: true,
	qorpera_begin_office_software: true,
	qorpera_check_office_software_install: true,
	qorpera_ack_office_software_install: true,
	qorpera_office_software_status: true,
	qorpera_check_office_software_invocation: true,
	qorpera_ack_office_software_invocation: true,
	qorpera_suspend_runtime_node_machine: true,
	// A deleted company's powered-off computer: retirement, its delete window
	// and the release (20260929320000).
	qorpera_runtime_office_retirement: true,
	qorpera_prepare_runtime_office_retirement: true,
	qorpera_retire_runtime_office: true,
};
const METHODS = new Set(Object.keys(ALLOWED) as OfficeProviderHttpMethod[]);
const LIMIT = 65536;

/** Node 22's web Response/Headers load Undici's WASM parser even when fetch
 * is unused. Keep the production transport entirely on native HTTPS so the
 * service can retain --jitless and its memory execution protections. */
function nativeRpc(url: string, key: string, body: string, signal: AbortSignal): Promise<unknown> {
	return new Promise((resolve, reject) => {
		signal.throwIfAborted();
		const request = httpsRequest(
			url,
			{
				method: "POST",
				signal,
				headers: {
					apikey: key,
					authorization: `Bearer ${key}`,
					"content-type": "application/json",
					accept: "application/json",
					"content-length": Buffer.byteLength(body),
				},
			},
			(response) => {
				response.once("error", reject);
				const fail = () => {
					response.destroy();
					request.destroy();
					reject(new Error("unconfirmed"));
				};
				const length = response.headers["content-length"];
				if (
					response.statusCode !== 200 ||
					!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers["content-type"] ?? "") ||
					(length !== undefined && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > LIMIT))
				) {
					fail();
					return;
				}
				const chunks: Buffer[] = [];
				let size = 0;
				response.on("data", (chunk: Buffer) => {
					size += chunk.length;
					if (size > LIMIT) {
						fail();
						return;
					}
					chunks.push(chunk);
				});
				response.once("end", () => {
					try {
						signal.throwIfAborted();
						if (!response.complete || (length !== undefined && Number(length) !== size)) throw new Error();
						resolve(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks))));
					} catch {
						fail();
					}
				});
			},
		);
		request.once("error", reject);
		request.end(body);
	});
}

/** Infrastructure credential boundary, separate from the guest registry.
 * Closed lifecycle/admission and staged fleet-offer RPCs; no infrastructure
 * enrollment, cancellation, deletion, arbitrary REST,
 * redirects or automatic replay after an uncertain response. SQL remains the
 * authority for every bound request. Errors never expose credentials/bodies. */
export class LxdOfficeProviderHttpRegistry implements LxdOfficeLifecycleRegistry {
	readonly #origin: string;
	readonly #key: string;
	readonly #fetch: typeof fetch | undefined;
	#pending = false;
	constructor(registryUrl: string, serviceKey: string, fetchImplementation?: typeof fetch) {
		try {
			const url = new URL(registryUrl);
			if (
				url.protocol !== "https:" ||
				url.username ||
				url.password ||
				url.search ||
				url.hash ||
				url.pathname !== "/" ||
				registryUrl !== url.origin ||
				typeof serviceKey !== "string" ||
				!/^[A-Za-z0-9_.-]{32,4096}$/.test(serviceKey)
			)
				throw new Error();
			this.#origin = url.origin;
			this.#key = serviceKey;
			this.#fetch = fetchImplementation;
		} catch {
			throw new Error("INVALID_OFFICE_PROVIDER_REGISTRY");
		}
	}
	async call(method: OfficeProviderHttpMethod, args: Record<string, unknown>, caller: AbortSignal): Promise<unknown> {
		caller.throwIfAborted();
		if (!METHODS.has(method)) throw new Error("OFFICE_PROVIDER_RPC_FORBIDDEN");
		if (this.#pending) throw new Error("OFFICE_PROVIDER_RPC_PENDING");
		let body: string;
		try {
			if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error();
			body = JSON.stringify(args);
			if (Buffer.byteLength(body) > LIMIT) throw new Error();
		} catch {
			throw new Error("INVALID_OFFICE_PROVIDER_RPC");
		}
		const signal = AbortSignal.any([caller, AbortSignal.timeout(5000)]);
		this.#pending = true;
		let abort = () => {};
		const stopped = new Promise<never>((_, reject) => {
			abort = () => reject(new Error("OFFICE_PROVIDER_RPC_UNCONFIRMED"));
			signal.addEventListener("abort", abort, { once: true });
		});
		const operation = (async () => {
			signal.throwIfAborted();
			if (!this.#fetch) return nativeRpc(`${this.#origin}/rest/v1/rpc/${method}`, this.#key, body, signal);
			const response = await this.#fetch(`${this.#origin}/rest/v1/rpc/${method}`, {
				method: "POST",
				redirect: "error",
				signal,
				headers: {
					apikey: this.#key,
					authorization: `Bearer ${this.#key}`,
					"content-type": "application/json",
					accept: "application/json",
				},
				body,
			});
			const reader = response.body?.getReader();
			try {
				signal.throwIfAborted();
				const length = response.headers.get("content-length");
				if (
					response.status !== 200 ||
					response.redirected ||
					!reader ||
					!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get("content-type") ?? "") ||
					(length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > LIMIT))
				)
					throw new Error();
				const chunks: Uint8Array[] = [];
				let size = 0;
				for (;;) {
					const { value, done } = await reader.read();
					signal.throwIfAborted();
					if (done) break;
					size += value.byteLength;
					if (size > LIMIT) throw new Error();
					chunks.push(value);
				}
				if (length !== null && Number(length) !== size) throw new Error();
				return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks)));
			} finally {
				await reader?.cancel().catch(() => {});
				reader?.releaseLock();
			}
		})()
			.catch(() => {
				throw new Error("OFFICE_PROVIDER_RPC_UNCONFIRMED");
			})
			.finally(() => {
				this.#pending = false;
			});
		try {
			return await Promise.race([operation, stopped]);
		} finally {
			signal.removeEventListener("abort", abort);
		}
	}
}

import { request as httpsRequest } from "node:https";
