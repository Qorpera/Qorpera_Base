import {
	companyComputerLinuxBinding,
	parseCompanyComputerServiceConfig,
} from "@qorpera/runtime/cloud-company-computer-service-config";
import { describe, expect, it } from "vitest";
import { computerServiceConfig } from "./fixtures/company-computer-service.ts";

describe("protected office process configuration", () => {
	it("parses the complete headless guest binding without caller-owned objects", () => {
		const config = computerServiceConfig();
		const parsed = parseCompanyComputerServiceConfig(JSON.stringify(config));
		expect(parsed).toEqual(config);
		config.linux.layout.workbenchRoot = "/other";
		expect(parsed.linux.layout.workbenchRoot).toBe("/srv/workbench");
	});
	it("binds the physical linux section without the provider-authored desktop zone", () => {
		const config = computerServiceConfig();
		const zoned = parseCompanyComputerServiceConfig(
			JSON.stringify({ ...config, linux: { ...config.linux, desktopTimeZone: "Europe/Copenhagen" } }),
		);
		expect(companyComputerLinuxBinding(zoned.linux)).toEqual(config.linux);
		expect(companyComputerLinuxBinding(config.linux)).toEqual(config.linux);
		expect(zoned.linux.desktopTimeZone).toBe("Europe/Copenhagen");
	});
	it("admits an optional IANA desktop zone and refuses anything else there", () => {
		const config = computerServiceConfig();
		const zoned = { ...config, linux: { ...config.linux, desktopTimeZone: "Europe/Copenhagen" } };
		expect(parseCompanyComputerServiceConfig(JSON.stringify(zoned)).linux.desktopTimeZone).toBe("Europe/Copenhagen");
		expect(parseCompanyComputerServiceConfig(JSON.stringify(config)).linux.desktopTimeZone).toBeUndefined();
		for (const zone of ["", "Europe/Copenhagen\n", "../zoneinfo", 42, null])
			expect(() =>
				parseCompanyComputerServiceConfig(
					JSON.stringify({ ...config, linux: { ...config.linux, desktopTimeZone: zone } }),
				),
			).toThrow("INVALID_OFFICE_SERVICE_CONFIG");
	});
	it.each([
		["schema", "old"],
		["computeIdentityId", "forbidden"],
		["providerKey", "secret"],
		["environment", {}],
		["computerGeneration", 0],
		["computerGeneration", 1.5],
		["registryUrl", "http://registry.invalid"],
		["registryUrl", "https://user:secret@registry.invalid"],
		["registryUrl", "https://registry.invalid/"],
		["captureObjectGatewayUrl", "http://127.0.0.1"],
		["captureObjectGatewayUrl", "https://objects.invalid/?token=secret"],
	])("rejects top-level %s=%s", (key, value) => {
		expect(() =>
			parseCompanyComputerServiceConfig(JSON.stringify({ ...computerServiceConfig(), [key]: value })),
		).toThrow("INVALID_OFFICE_SERVICE_CONFIG");
	});
	it.each([
		(config: ReturnType<typeof computerServiceConfig>) => {
			config.native.port = 0;
		},
		(config: ReturnType<typeof computerServiceConfig>) => {
			config.viewer.port = config.native.port;
		},
		(config: ReturnType<typeof computerServiceConfig>) => {
			config.native.host = "attacker.invalid";
		},
		(config: ReturnType<typeof computerServiceConfig>) => {
			config.viewer.origins = ["null"];
		},
		(config: ReturnType<typeof computerServiceConfig>) => {
			config.viewer.origins = ["https://app.invalid", "https://app.invalid"];
		},
		(config: ReturnType<typeof computerServiceConfig>) => {
			config.viewer.origins = [];
		},
		(config: ReturnType<typeof computerServiceConfig>) => {
			config.linux.limits.memoryBytes = Infinity;
		},
		(config: ReturnType<typeof computerServiceConfig>) => {
			config.linux.layout.desktopHome = config.linux.layout.workbenchRoot;
		},
		(config: ReturnType<typeof computerServiceConfig>) => {
			config.linux.layout.workbenchRoot = "/qorpera/company-live";
		},
		(config: ReturnType<typeof computerServiceConfig>) => {
			Object.assign(config.scope, { token: "secret" });
		},
		(config: ReturnType<typeof computerServiceConfig>) => {
			Object.assign(config.linux, { launch: "arbitrary-command" });
		},
		(config: ReturnType<typeof computerServiceConfig>) => {
			Object.assign(config.linux.attestation, { state: "active" });
		},
	])("rejects malformed nested authority or configuration %#", (change) => {
		const config = computerServiceConfig();
		change(config);
		expect(() => parseCompanyComputerServiceConfig(JSON.stringify(config))).toThrow("INVALID_OFFICE_SERVICE_CONFIG");
	});
	it.each(["null", "[]", '{"secret":', " ".repeat(16385)])("redacts malformed or oversized documents %#", (text) => {
		expect(() => parseCompanyComputerServiceConfig(text)).toThrow("INVALID_OFFICE_SERVICE_CONFIG");
	});
});
