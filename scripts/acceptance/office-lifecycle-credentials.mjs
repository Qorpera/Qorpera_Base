import { randomBytes } from "node:crypto";

// Native and object endpoints require the exact 32-byte, unpadded base64url
// format pinned by CompanyComputerConfigurationMaterial.
export function officeLifecycleBearerToken() {
	return randomBytes(32).toString("base64url");
}
