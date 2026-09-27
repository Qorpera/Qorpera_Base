import type {
	NativeExecutionConnections,
	NativeProviderHarness,
	SessionTurnRequestResult,
} from "@qorpera/cloud-client/cloud-native-subscription-control";
import { withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import { SESSION_PROMPT_SCHEMA } from "./api.ts";
import type { Cloud } from "./client.ts";
import { createWebNativeSubscription } from "./native-subscription.ts";
import { UUID_PATTERN } from "./parse.ts";
import { createWebRoomMessages } from "./room-messages.ts";
import { createWebSessionAttachments, sessionAttachmentIssue } from "./session-attachments.ts";
/** A user-selected, observed member sponsorship. Scalars are retained for exact replay. */
export interface SessionExecutionSponsor {
	readonly connectionId: string;
	readonly provider: string;
	readonly nativeHarness: NativeProviderHarness;
	readonly sponsorBindingId: string;
	readonly sponsorVersion: number;
	readonly computeIdentityId: string;
	readonly workerClass: "managed_sandbox";
}

export function selectSessionExecutionSponsor(
	observed: NativeExecutionConnections,
	connectionId: string,
	memberId: string,
): SessionExecutionSponsor {
	const identity = observed.computeIdentity;
	const connection = observed.connections.find((item) => item.connectionId === connectionId);
	if (
		!identity ||
		identity.status !== "active" ||
		identity.ownerUserId !== memberId ||
		!UUID_PATTERN.test(identity.computeIdentityId) ||
		!connection ||
		connection.provider !== "openai" ||
		connection.nativeHarness !== "codex-cli" ||
		connection.connectionStatus !== "active" ||
		connection.authorizationState !== "active" ||
		connection.policy.implementationStatus !== "supported" ||
		connection.policy.enablementStatus !== "enabled" ||
		!connection.sponsorBindingId ||
		!UUID_PATTERN.test(connection.sponsorBindingId) ||
		!Number.isSafeInteger(connection.sponsorVersion) ||
		connection.sponsorVersion! < 1
	)
		throw new Error("The selected model account is unavailable for execution.");
	return Object.freeze({
		connectionId: connection.connectionId,
		provider: connection.provider,
		nativeHarness: connection.nativeHarness,
		sponsorBindingId: connection.sponsorBindingId,
		sponsorVersion: connection.sponsorVersion!,
		computeIdentityId: identity.computeIdentityId,
		workerClass: "managed_sandbox",
	});
}

export interface RoomMessageTarget {
	readonly roomId: string;
	readonly environmentId: string;
	/** True for an agent's shared thread (one bound agent). */
	readonly agentThread: boolean;
	/** Whether the room takes images: an agent's thread always, a group chat since 20260927170000. */
	readonly images: boolean;
}

export type SessionInputWriter = (
	sessionId: string,
	clientInputId: string,
	text: string,
	signal: AbortSignal,
	files?: readonly File[],
	executionSponsor?: SessionExecutionSponsor,
	roomTarget?: RoomMessageTarget,
) => Promise<Pick<SessionTurnRequestResult, "inputId">>;

/** Only queues member input. A tab never executes the resulting staff work. */
export function createWebSessionInputWriter(
	cloud: Cloud,
	memberId: string,
	companySignal: AbortSignal,
	current: (sessionId: string) => void,
	profileId: string,
): SessionInputWriter {
	const origin = new URL(cloud.config.projectUrl);
	if (
		origin.protocol !== "https:" ||
		origin.username ||
		origin.password ||
		origin.pathname !== "/" ||
		origin.search ||
		origin.hash ||
		!UUID_PATTERN.test(memberId) ||
		!UUID_PATTERN.test(profileId)
	)
		throw new Error("Invalid member input configuration.");
	return (sessionId, clientInputId, text, signal, files = [], executionSponsor, roomTarget) => {
		const room = roomTarget ? { ...roomTarget } : undefined;
		return withCloudDeadline(
			async (deadline) => {
				if (
					!UUID_PATTERN.test(sessionId) ||
					!UUID_PATTERN.test(clientInputId) ||
					(!text.trim() && !files.length) ||
					new TextEncoder().encode(text).length > 65536
				)
					throw new Error("Message is empty or too large.");
				if (
					!executionSponsor ||
					!UUID_PATTERN.test(executionSponsor.sponsorBindingId) ||
					!UUID_PATTERN.test(executionSponsor.computeIdentityId) ||
					!Number.isSafeInteger(executionSponsor.sponsorVersion) ||
					executionSponsor.sponsorVersion < 1 ||
					executionSponsor.workerClass !== "managed_sandbox"
				)
					throw new Error("Select an active model account before sending.");
				const sponsor = { ...executionSponsor };
				const issue = sessionAttachmentIssue(files);
				if (issue) throw new Error(issue);
				const check = () => {
					deadline.throwIfAborted();
					current(sessionId);
				};
				check();
				if (room && !room.images && files.length)
					throw new Error("Images are not supported in team rooms. Use Company File.");
				const images: { objectSha256: string; bytes: number; mediaType: string }[] = [];
				if (files.length) {
					const client = createWebSessionAttachments(cloud, memberId, deadline, check);
					// Read every selected file before staging any upload. File objects are
					// immutable; retries retain these exact selections and the input ID.
					const selected: { bytes: Uint8Array<ArrayBuffer>; mediaType: string }[] = [];
					for (const file of files) {
						const bytes = new Uint8Array(await file.arrayBuffer());
						check();
						if (bytes.length !== file.size) throw new Error("The selected image changed.");
						selected.push({ bytes, mediaType: file.type });
					}
					for (const file of selected) {
						check();
						const image = await client.upload(sessionId, clientInputId, file.bytes, file.mediaType, deadline);
						check();
						images.push({ objectSha256: image.sha256, bytes: image.bytes, mediaType: image.mediaType });
					}
				}
				if (room) {
					return createWebRoomMessages(cloud, profileId, memberId, companySignal, () => check()).post(
						{
							roomId: room.roomId,
							environmentId: room.environmentId,
							sessionId,
							clientInputId,
							text,
							...(images.length ? { images } : {}),
							sponsorBindingId: sponsor.sponsorBindingId,
							sponsorVersion: sponsor.sponsorVersion,
						},
						deadline,
					);
				}
				const control = createWebNativeSubscription(cloud, profileId, memberId, companySignal, () => check());
				const receipt = await control.requestSessionTurn(
					{
						sessionId,
						clientInputId,
						clientRequestId: clientInputId,
						body: { schema: SESSION_PROMPT_SCHEMA, text, images },
						sponsorMode: "member_connection",
						sponsorBindingId: sponsor.sponsorBindingId,
						sponsorVersion: sponsor.sponsorVersion,
						computeIdentityId: sponsor.computeIdentityId,
						workerClass: sponsor.workerClass,
					},
					deadline,
				);
				check();
				return receipt;
			},
			files.length ? 75000 : 15000,
			AbortSignal.any([companySignal, signal]),
		);
	};
}
