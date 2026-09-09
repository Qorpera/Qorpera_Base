import { officeVmOperationHttpFixture } from "./office-vm-operation-http.ts";
/** Synthetic VM shutdown behind actual Unix HTTP and provider journals. */
export function officePowerOffHttpFixture(root: string) {
	return officeVmOperationHttpFixture(root, "stop", "abababab-abab-4bab-8bab-abababababab");
}
