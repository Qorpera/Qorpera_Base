import { CloudSessionAttachments } from "@qorpera/cloud-client/cloud-session-attachments";
import type { Cloud } from "./client.ts";

export const SESSION_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function sessionAttachmentIssue(files: readonly File[]): string | undefined {
	if (files.some((file) => !SESSION_IMAGE_TYPES.has(file.type)))
		return "Messages support PNG, JPEG, GIF and WebP images. Upload other files through Company File.";
	if (files.length > 5 || files.reduce((total, file) => total + file.size, 0) > 8 * 1024 * 1024)
		return "Choose up to 5 images totaling no more than 8 MiB.";
	if (files.some((file) => !(file instanceof File) || file.size < 1)) return "Choose nonempty image files.";
	return undefined;
}

/** Product account/route lifetime around shared canonical attachment transport. */
export function createWebSessionAttachments(
	cloud: Cloud,
	memberId: string,
	signal: AbortSignal,
	current: () => void,
): CloudSessionAttachments {
	const check = () => {
		signal.throwIfAborted();
		current();
	};
	return new CloudSessionAttachments({
		objectGatewayUrl: cloud.config.objectGatewayUrl,
		accessToken: async (deadline) => {
			check();
			deadline.throwIfAborted();
			const { data, error } = await cloud.supabase.auth.getSession();
			check();
			deadline.throwIfAborted();
			if (error || !data.session || data.session.user.id !== memberId)
				throw new Error("Sign in again to access this attachment.");
			return data.session.access_token;
		},
		fetch: async (input, init) => {
			check();
			const response = await fetch(input, {
				...init,
				signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
			});
			try {
				check();
			} catch (error) {
				void response.body?.cancel().catch(() => undefined);
				throw error;
			}
			return response;
		},
	});
}
