const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PROFILE_INVITATION_PROTOCOL = "qorpera";
export const PROFILE_INVITATION_HOST = "profile-invitation";

export function profileInvitationProtocolUrl(invitationId: string): string {
	if (!UUID_PATTERN.test(invitationId)) throw new Error("Invalid profile invitation id");
	return `${PROFILE_INVITATION_PROTOCOL}://${PROFILE_INVITATION_HOST}/${invitationId.toLowerCase()}`;
}

export function profileInvitationIdFromProtocolUrl(value: string): string | undefined {
	if (value.length > 512) return undefined;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return undefined;
	}
	if (
		url.protocol !== `${PROFILE_INVITATION_PROTOCOL}:` ||
		url.hostname !== PROFILE_INVITATION_HOST ||
		url.username ||
		url.password ||
		url.port ||
		url.search ||
		url.hash
	) {
		return undefined;
	}
	const match = url.pathname.match(/^\/([0-9a-f-]+)$/i);
	if (!match || !UUID_PATTERN.test(match[1])) return undefined;
	return match[1].toLowerCase();
}

export function profileInvitationIdFromArgv(argv: readonly string[]): string | undefined {
	for (const argument of argv) {
		const invitationId = profileInvitationIdFromProtocolUrl(argument);
		if (invitationId) return invitationId;
	}
	return undefined;
}
