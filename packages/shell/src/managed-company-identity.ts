import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMPANY_MANIFEST_RELATIVE_PATH, readCompanyManifest } from "@qorpera/pi-coding-agent/company";

function requiredCompanyName(value: string): string {
	if (value !== value.trim() || !value || value.includes("\0") || Buffer.byteLength(value, "utf-8") > 160) {
		throw new Error("Cloud profile name is invalid");
	}
	return value;
}

/**
 * A managed cache is scaffolded before it is moved into its final path. The
 * hosted profile name is the company identity; a temporary folder basename
 * must never leak into the durable local manifest or UI.
 */
export function alignCloudCompanyManifestName(root: string, profileName: string): boolean {
	const name = requiredCompanyName(profileName);
	const manifest = readCompanyManifest(root);
	if (manifest.name === name) return false;
	const path = join(root, COMPANY_MANIFEST_RELATIVE_PATH);
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify({ ...manifest, name }, null, "\t")}\n`, {
			encoding: "utf-8",
			mode: 0o600,
			flag: "wx",
		});
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
	return true;
}
