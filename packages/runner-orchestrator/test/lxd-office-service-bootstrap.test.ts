import { describe, expect, it } from "vitest";
import {
	type LxdOfficeServiceBootstrap,
	OFFICE_SERVICE_CREDENTIALS,
	parseLxdOfficeServiceBootstrap,
} from "../src/lxd-office-service-bootstrap.ts";
import { lxdOfficeProviderBindingSha256 } from "../src/lxd-office-start-control.ts";
import { officePhysicalFixture } from "./fixtures/office-physical-policy.ts";

function fixture() {
	const { binding } = officePhysicalFixture();
	const plan: LxdOfficeServiceBootstrap = {
		schema: "qorpera.lxd-office-service-bootstrap/v1",
		providerBindingSha256: lxdOfficeProviderBindingSha256(binding),
		registryUrl: "https://registry.invalid",
		captureObjectGatewayUrl: "https://objects.invalid",
		native: { host: "0.0.0.0", port: 9443 },
		viewer: { host: "::", port: 9444, origins: ["https://app.invalid"] },
		credentials: Object.fromEntries(
			OFFICE_SERVICE_CREDENTIALS.map((name) => [
				name,
				{ path: `/etc/qorpera-provider/${name}`, bytes: 43, sha256: "a".repeat(64) },
			]),
		) as LxdOfficeServiceBootstrap["credentials"],
	};
	return { plan, binding };
}
describe("protected provider service bootstrap", () => {
	it("binds one complete allocation and returns independent configuration", () => {
		const { plan, binding } = fixture();
		const parsed = parseLxdOfficeServiceBootstrap(plan, binding);
		expect(parsed).toEqual(plan);
		plan.viewer.origins.push("https://changed.invalid");
		plan.credentials.native.path = "/changed";
		expect(parsed.viewer.origins).toEqual(["https://app.invalid"]);
		expect(parsed.credentials.native.path).toBe("/etc/qorpera-provider/native");
	});
	it.each([
		"http://registry.invalid",
		"https://user:secret@registry.invalid",
		"https://registry.invalid/",
		"https://registry.invalid/path",
		"https://registry.invalid?token=secret",
		"https://registry.invalid#secret",
		"https://registry.invalid:443",
		"file:///etc/secret",
		"invalid",
	])("refuses noncanonical or unprotected endpoint %s", (url) => {
		const { plan, binding } = fixture();
		for (const key of ["registryUrl", "captureObjectGatewayUrl"] as const)
			expect(() => parseLxdOfficeServiceBootstrap({ ...plan, [key]: url }, binding)).toThrow(
				"INVALID_OFFICE_SERVICE_BOOTSTRAP",
			);
		expect(() =>
			parseLxdOfficeServiceBootstrap({ ...plan, viewer: { ...plan.viewer, origins: [url] } }, binding),
		).toThrow();
	});
	it.each([
		"providerId",
		"companyId",
		"environmentId",
		"companyComputerId",
		"logicalComputerId",
		"allocationId",
	] as const)("refuses another %s", (key) => {
		const { plan, binding } = fixture();
		expect(() =>
			parseLxdOfficeServiceBootstrap(plan, { ...binding, [key]: "ffffffff-ffff-4fff-8fff-ffffffffffff" }),
		).toThrow();
	});
	it.each(["bootstrapSha256", "imageFingerprint", "providerPolicySha256"] as const)("refuses changed %s", (key) => {
		const { plan, binding } = fixture();
		expect(() => parseLxdOfficeServiceBootstrap(plan, { ...binding, [key]: "1".repeat(64) })).toThrow();
	});
	it.each([0, -1, 1.5, 65536, NaN, Infinity])("refuses invalid listener port %s", (port) => {
		const { plan, binding } = fixture();
		plan.native.port = port;
		expect(() => parseLxdOfficeServiceBootstrap(plan, binding)).toThrow();
	});
	it("refuses ambiguous listeners, origins, paths, credentials and open schema fields", () => {
		const { plan, binding } = fixture();
		const invalid = [
			{ ...plan, command: ["/bin/sh"] },
			{ ...plan, schema: "old" },
			{ ...plan, native: { ...plan.native, host: "host.invalid" } },
			{ ...plan, native: { ...plan.native, port: plan.viewer.port } },
			{ ...plan, viewer: { ...plan.viewer, origins: [] } },
			{ ...plan, viewer: { ...plan.viewer, origins: ["https://app.invalid", "https://app.invalid"] } },
			...[
				{ path: "relative" },
				{ path: "/etc/../secret" },
				{ path: plan.credentials.registry.path },
				{ bytes: 0 },
				{ bytes: 129 },
				{ sha256: "bad" },
				{ raw: "secret" },
			].map((change) => ({
				...plan,
				credentials: { ...plan.credentials, native: { ...plan.credentials.native, ...change } },
			})),
		];
		for (const value of invalid) expect(() => parseLxdOfficeServiceBootstrap(value, binding)).toThrow();
	});
});
