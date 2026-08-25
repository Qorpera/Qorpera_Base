export interface SystemdCredentialMetadata {
	isFile: boolean;
	size: number;
	uid: number;
	gid: number;
	mode: number;
}

export function systemdCredentialMetadataIsSafe(
	metadata: SystemdCredentialMetadata,
	currentUid: number | undefined,
	maximumBytes: number,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (!metadata.isFile || metadata.size > maximumBytes) return false;
	if (platform !== "linux") return true;
	if (currentUid === undefined) return false;
	const permissions = metadata.mode & 0o777;
	const serviceOwned = metadata.uid === currentUid && (permissions & 0o077) === 0;
	const systemdOwned =
		metadata.uid === 0 && metadata.gid === 0 && (permissions & 0o440) !== 0 && (permissions & 0o337) === 0;
	return serviceOwned || systemdOwned;
}
