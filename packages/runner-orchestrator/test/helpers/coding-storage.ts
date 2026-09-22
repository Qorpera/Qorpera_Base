import { createCloudCodingStorageBinding } from "@qorpera/contracts";
export function codingStorageFixture(scope: { workerId: string; companyId: string; environmentId: string }) {
	return createCloudCodingStorageBinding(
		{
			schema: "qorpera.coding-nas-policy/v1",
			mountPoint: "/nas",
			rootPath: "/nas/coding",
			source: "10.0.0.2:/coding",
			serverAddress: "10.0.0.2",
		},
		{ ...scope, writerGeneration: 1, machineIdSha256: "d".repeat(64) },
	);
}
