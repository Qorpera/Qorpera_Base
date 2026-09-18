import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function cloudCompanyDisplayRoot(
	userData: string,
	accountId: string,
	profileId: string,
	environmentId: string,
): string {
	if (![accountId, profileId, environmentId].every((id) => UUID.test(id)))
		throw new Error("Invalid company display identity");
	return join(resolve(userData), "cloud-company-display", accountId, profileId, environmentId);
}

/** A per-human host projection, not a Company File checkout. Never adopt or
 * migrate an existing whole-company cache, including its private file bytes. */
export function prepareCloudCompanyDisplay(
	userData: string,
	accountId: string,
	profileId: string,
	environmentId: string,
): string {
	const root = cloudCompanyDisplayRoot(userData, accountId, profileId, environmentId);
	const marker = join(root, ".qorpera-display-owner.json");
	const identity = JSON.stringify({ schema: "qorpera.company-display/v1", accountId, profileId, environmentId });
	if (!existsSync(root)) {
		mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
		mkdirSync(root, { mode: 0o700 });
		writeFileSync(marker, identity, { encoding: "utf8", flag: "wx", mode: 0o600 });
	}
	if (
		!lstatSync(root).isDirectory() ||
		!lstatSync(marker).isFile() ||
		lstatSync(marker).nlink !== 1 ||
		readFileSync(marker, "utf8") !== identity
	)
		throw new Error("The company display path belongs to different data");
	return root;
}
