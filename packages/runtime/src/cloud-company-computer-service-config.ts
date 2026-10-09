import { isIP } from "node:net";
import type { CompanyComputerScope } from "@qorpera/cloud-client/cloud-company-computer-contract";
import { assertCompanyComputerScope } from "@qorpera/cloud-client/cloud-company-computer-contract";
import { isCompanyComputerScreenTimeZone } from "./cloud-company-computer-desktop.ts";
import { parseCompanyComputerGuestLayout } from "./cloud-company-computer-layout.ts";
import type { CompanyComputerLinuxOfficeServiceOptions } from "./cloud-company-computer-linux-service.ts";

/** Provider-owned configuration. No identity, provider secret, executable,
 * environment override or client-controlled callback can be supplied here. */
export interface CompanyComputerServiceConfig {
	schema: "qorpera.company-computer-service/v1";
	scope: CompanyComputerScope;
	computerGeneration: number;
	registryUrl: string;
	/** Unused since company objects are gone (legacy removal, step C); the orchestrator writes it until it drops it. */
	captureObjectGatewayUrl: string;
	native: { host: string; port: number };
	viewer: { host: string; port: number; origins: string[] };
	linux: CompanyComputerLinuxOfficeServiceOptions["linux"];
}

function record(value: unknown, keys: string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype ||
		Object.keys(value).sort().join() !== keys.sort().join()
	)
		throw new Error("INVALID_OFFICE_SERVICE_CONFIG");
	return value as Record<string, unknown>;
}

function strings(value: unknown, keys: string[]): void {
	if (Object.values(record(value, keys)).some((item) => typeof item !== "string" || !item))
		throw new Error("INVALID_OFFICE_SERVICE_CONFIG");
}

function positive(value: unknown, maximum = Number.MAX_SAFE_INTEGER): void {
	if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum)
		throw new Error("INVALID_OFFICE_SERVICE_CONFIG");
}

function endpoint(value: unknown): void {
	if (typeof value !== "string" || value.length > 2048) throw new Error("INVALID_OFFICE_SERVICE_CONFIG");
	const url = new URL(value);
	if (url.protocol !== "https:" || url.origin !== value) throw new Error("INVALID_OFFICE_SERVICE_CONFIG");
}

/** The provider-authored desktop zone is validated by the parser but is not part of the
 * physical binding; comparisons against preparation-derived sections drop it. */
export function companyComputerLinuxBinding<T extends { desktopTimeZone?: string }>(
	linux: T,
): Omit<T, "desktopTimeZone"> {
	const { desktopTimeZone: _zone, ...binding } = linux;
	return binding;
}

/** Parses a bounded closed document; the physical boundary subsequently checks
 * every Linux path, mount and attestation before any listener can serve. */
export function parseCompanyComputerServiceConfig(text: string): CompanyComputerServiceConfig {
	try {
		if (Buffer.byteLength(text) > 16384) throw new Error("oversized");
		const value = record(JSON.parse(text), [
			"schema",
			"scope",
			"computerGeneration",
			"registryUrl",
			"captureObjectGatewayUrl",
			"native",
			"viewer",
			"linux",
		]);
		if (value.schema !== "qorpera.company-computer-service/v1") throw new Error("schema");
		strings(value.scope, ["companyId", "environmentId", "companyComputerId", "logicalComputerId"]);
		assertCompanyComputerScope(value.scope as CompanyComputerScope, value.scope as CompanyComputerScope);
		positive(value.computerGeneration);
		endpoint(value.registryUrl);
		endpoint(value.captureObjectGatewayUrl);
		const native = record(value.native, ["host", "port"]);
		const viewer = record(value.viewer, ["host", "port", "origins"]);
		for (const listener of [native, viewer]) {
			if (typeof listener.host !== "string" || !isIP(listener.host)) throw new Error("host");
			positive(listener.port, 65535);
		}
		// Distinct ports also prevent overlapping IPv4/IPv6 wildcard listeners.
		if (native.port === viewer.port) throw new Error("ports");
		if (
			!Array.isArray(viewer.origins) ||
			viewer.origins.length < 1 ||
			viewer.origins.length > 16 ||
			new Set(viewer.origins).size !== viewer.origins.length
		)
			throw new Error("origins");
		for (const origin of viewer.origins) endpoint(origin);
		const optional =
			value.linux && typeof value.linux === "object" && "desktopTimeZone" in value.linux ? ["desktopTimeZone"] : [];
		const linux = record(value.linux, [
			"layout",
			"limits",
			"workbenchMount",
			"privateWorkbenchMount",
			"displayRuntimeRoot",
			"browserRuntimeRoot",
			"captureRoot",
			"attestation",
			...optional,
		]);
		if (optional.length && !isCompanyComputerScreenTimeZone(linux.desktopTimeZone)) throw new Error("time zone");
		parseCompanyComputerGuestLayout(linux.layout);
		for (const item of Object.values(record(linux.limits, ["memoryBytes", "pids", "cpuQuota", "cpuPeriod"])))
			positive(item);
		for (const mount of [linux.workbenchMount, linux.privateWorkbenchMount])
			strings(mount, ["filesystem", "mountPoint", "root", "source"]);
		strings(linux.attestation, [
			"allocationId",
			"instanceSha256",
			"imageSha256",
			"bootstrapSha256",
			"bootId",
			"adoptionReceiptPath",
			"adoptionReceiptSha256",
		]);
		for (const root of [linux.displayRuntimeRoot, linux.browserRuntimeRoot, linux.captureRoot])
			if (typeof root !== "string" || !root) throw new Error("runtime root");
		return value as unknown as CompanyComputerServiceConfig;
	} catch {
		throw new Error("INVALID_OFFICE_SERVICE_CONFIG");
	}
}
