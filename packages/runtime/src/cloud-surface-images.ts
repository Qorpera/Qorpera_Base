import { createHash } from "node:crypto";
import {
	isUuid,
	type JsonValue,
	parseClosedRecord,
	parseInteger,
	parseRecord,
	parseSha256Hex,
	parseUuid,
	SURFACE_IMAGE_MAX_TOTAL_BYTES,
	SURFACE_IMAGE_MEDIA_TYPES,
} from "@qorpera/contracts";
import type { CloudCompanyFolderClient } from "./cloud-company-folder-client.ts";
import { FolderImageRefusal, folderImageView, oneImageAtATime } from "./cloud-folder-images.ts";
import {
	type CloudNativeTool,
	CloudToolArgumentRefusal,
	type CloudToolContext,
	CloudToolRefusal,
} from "./cloud-native-tool-boundary.ts";

export const NATIVE_SURFACE_SESSION_IMAGES_SCHEMA = "qorpera.native-surface-session-images/v1";
export const CODING_ATTACHMENT_VIEW_SCHEMA = "qorpera.coding-attachment-view/v1";

export interface SurfaceMemberImage {
	readonly clientInputId: string;
	readonly sha256: string;
	readonly bytes: number;
	readonly mediaType: string;
	readonly path: string;
	readonly latest: boolean;
}

export type SurfaceAttachmentReader = (image: SurfaceMemberImage, signal: AbortSignal) => Promise<Uint8Array>;

export function parseNativeSurfaceSessionImages(value: unknown, sessionId: string): SurfaceMemberImage[] {
	const raw = parseClosedRecord(value, "sessionImages", ["schema", "sessionId", "latestMemberMessageId", "messages"]);
	if (
		raw.schema !== NATIVE_SURFACE_SESSION_IMAGES_SCHEMA ||
		raw.sessionId !== sessionId ||
		!Array.isArray(raw.messages)
	)
		throw new Error("Surface session images could not be loaded");
	return raw.messages.flatMap((item, index) => {
		const message = parseClosedRecord(item, `sessionImages.messages[${index}]`, [
			"messageId",
			"clientInputId",
			"latest",
			"images",
		]);
		parseUuid(message.messageId, "messageId");
		const clientInputId = parseUuid(message.clientInputId, "clientInputId");
		if (typeof message.latest !== "boolean" || !Array.isArray(message.images))
			throw new Error("Surface session images could not be loaded");
		const latest = message.latest;
		return message.images.map((image, slot) => {
			const entry = parseRecord(image, `sessionImages.messages[${index}].images[${slot}]`);
			const mediaType = entry.mediaType;
			if (
				typeof mediaType !== "string" ||
				!(SURFACE_IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType) ||
				typeof entry.path !== "string" ||
				!entry.path.startsWith("QorperaOS/surfaces/")
			)
				throw new Error("Surface session images could not be loaded");
			return {
				clientInputId,
				sha256: parseSha256Hex(entry.sha256, "sha256"),
				bytes: parseInteger(entry.bytes, "bytes", 1, SURFACE_IMAGE_MAX_TOTAL_BYTES),
				mediaType,
				path: entry.path,
				latest,
			};
		});
	});
}

export function surfaceMemberImagesSection(
	images: readonly SurfaceMemberImage[],
	opener: "company_read" | "coding_view_attachment",
): string | null {
	if (images.length === 0) return null;
	const line = (image: SurfaceMemberImage) =>
		opener === "company_read"
			? `- ${image.path}`
			: `- clientInputId ${image.clientInputId}, sha256 ${image.sha256} (${image.mediaType})`;
	const latest = images.filter((image) => image.latest).map(line);
	const earlier = images.filter((image) => !image.latest).map(line);
	const how =
		opener === "company_read"
			? "open each with company_read on its path"
			: "open each with coding_view_attachment {clientInputId, sha256}";
	return [
		`## Images the member attached (${how})`,
		...(latest.length > 0 ? ["With the latest member message:", ...latest] : []),
		...(earlier.length > 0 ? ["With earlier messages:", ...earlier] : []),
	].join("\n");
}

export async function readSurfaceMemberImage(
	folder: Pick<CloudCompanyFolderClient, "read" | "readRange">,
	image: SurfaceMemberImage,
	signal: AbortSignal,
): Promise<Uint8Array> {
	const found = await folder.read(image.path, signal);
	const entry = found.entry;
	if (!entry || entry.kind !== "file" || entry.file.fileSha256 !== image.sha256 || entry.file.bytes !== image.bytes)
		throw new CloudToolRefusal("CODING_ATTACHMENT_UNAVAILABLE: the image is no longer in the company folder.");
	const bytes = await folder.readRange(entry, 0, entry.file.bytes, signal);
	if (createHash("sha256").update(bytes).digest("hex") !== image.sha256)
		throw new CloudToolRefusal("CODING_ATTACHMENT_UNAVAILABLE: the image changed in the company folder.");
	return bytes;
}

export function createCodingViewAttachmentTool(
	images: readonly SurfaceMemberImage[],
	read: SurfaceAttachmentReader,
): CloudNativeTool {
	return {
		name: "coding_view_attachment",
		source: "worker",
		images: true,
		parallelRead: true,
		description:
			"View one image the member attached to this Surface session, named by the clientInputId and sha256 the context lists under Images the member attached.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["clientInputId", "sha256"],
			properties: {
				clientInputId: { type: "string", description: "The image's clientInputId from the context." },
				sha256: { type: "string", description: "The image's sha256 from the context." },
			},
		},
		parseArguments(value: JsonValue): JsonValue {
			let raw: Record<string, unknown>;
			try {
				raw = parseClosedRecord(value, "coding_view_attachment", ["clientInputId", "sha256"]);
			} catch (error) {
				throw new CloudToolArgumentRefusal(error instanceof Error ? error.message : "Invalid arguments");
			}
			if (!isUuid(raw.clientInputId) || typeof raw.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.sha256))
				throw new CloudToolArgumentRefusal("clientInputId must be a UUID and sha256 64 lower-case hex characters");
			return { clientInputId: raw.clientInputId, sha256: raw.sha256 };
		},
		async execute(argumentsValue: JsonValue, context: CloudToolContext) {
			const { clientInputId, sha256 } = argumentsValue as { clientInputId: string; sha256: string };
			const image = images.find((item) => item.clientInputId === clientInputId && item.sha256 === sha256);
			if (!image)
				throw new CloudToolRefusal(
					"CODING_ATTACHMENT_UNKNOWN: no image the member attached to this session has that clientInputId and sha256.",
				);
			const view = await oneImageAtATime(context.signal, async () => {
				const bytes = await read(image, context.signal);
				try {
					return folderImageView(bytes);
				} catch (error) {
					if (!(error instanceof FolderImageRefusal)) throw error;
					throw new CloudToolRefusal(`CODING_ATTACHMENT_UNREADABLE: ${error.message}.`);
				}
			});
			return {
				kind: "json",
				value: {
					schema: CODING_ATTACHMENT_VIEW_SCHEMA,
					kind: "image",
					clientInputId,
					sha256,
					mediaType: `image/${view.format}`,
					totalBytes: image.bytes,
					width: view.width,
					height: view.height,
					shownWidth: view.shownWidth,
					shownHeight: view.shownHeight,
					imageSha256: view.sha256,
				},
				image: { png: view.png, sha256: view.sha256 },
			};
		},
	};
}
