import type { CompanyComputerServiceConfig } from "@qorpera/runtime/cloud-company-computer-service-config";
import { computerId, computerScope } from "./company-computer.ts";

export function computerServiceConfig(): CompanyComputerServiceConfig {
	return {
		schema: "qorpera.company-computer-service/v1",
		scope: computerScope(),
		computerGeneration: 1,
		registryUrl: "https://registry.invalid",
		captureObjectGatewayUrl: "https://objects.invalid",
		native: { host: "127.0.0.1", port: 9443 },
		viewer: { host: "127.0.0.1", port: 9444, origins: ["https://app.invalid"] },
		linux: {
			layout: {
				workbenchRoot: "/srv/workbench",
				desktopHome: "/srv/desktop",
				screenStateRoot: "/srv/screens",
				browserProfilesRoot: "/srv/profiles",
			},
			limits: { memoryBytes: 2147483648, pids: 256, cpuQuota: 200000, cpuPeriod: 100000 },
			workbenchMount: { filesystem: "virtiofs", source: "office", root: "/", mountPoint: "/srv" },
			privateWorkbenchMount: { filesystem: "tmpfs", source: "tmpfs", root: "/", mountPoint: "/run/office-private" },
			displayRuntimeRoot: "/run/office-display",
			browserRuntimeRoot: "/run/office-browser",
			captureRoot: "/run/office-capture",
			attestation: {
				allocationId: computerId(70),
				bootId: computerId(71),
				instanceSha256: "a".repeat(64),
				imageSha256: "b".repeat(64),
				bootstrapSha256: "c".repeat(64),
				adoptionReceiptPath: "/etc/qorpera-office/adoption.json",
				adoptionReceiptSha256: "d".repeat(64),
			},
		},
	};
}
