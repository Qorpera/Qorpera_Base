import { array, record, timestamp, uuid } from "./parse.ts";

/* A member's picture is a private storage object named after its content:
 * <account UUID>/<sha256>.<webp|jpg|png> (migration 20260924150000). The cloud
 * decides who may read it; the web app downloads it with the member's token and
 * shows it through a blob: URL, the only image source the page policy admits
 * besides data: and its own origin. */

export const MEMBER_PICTURE_BUCKET = "qorpera-member-pictures";

const OBJECT_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/[0-9a-f]{64}\.(webp|jpg|png)$/;

export type MemberPictureExtension = "webp" | "jpg" | "png";

export interface MemberPicture {
	userId: string;
	objectName: string;
	updatedAt: string;
}

export interface MemberPictureObject {
	objectName: string;
	createdAt: string;
}

export interface MemberPictureChange {
	/** The picture this change replaced or removed; its owner deletes it. */
	previousObjectName?: string;
}

export function memberPictureName(userId: string, sha256: string, extension: MemberPictureExtension): string {
	const name = `${userId.toLowerCase()}/${sha256}.${extension}`;
	if (!OBJECT_NAME.test(name)) throw new Error("Invalid picture name.");
	return name;
}

export function isMemberPictureName(value: string, userId?: string): boolean {
	const match = OBJECT_NAME.exec(value);
	return Boolean(match) && (userId === undefined || match![1] === userId.toLowerCase());
}

function objectName(value: unknown, label: string, userId?: string): string {
	if (typeof value !== "string" || !isMemberPictureName(value, userId)) throw new Error(`Invalid ${label}`);
	return value;
}

export function parseMemberPictures(value: unknown): MemberPicture[] {
	return array(value, "member pictures").map((item) => {
		const input = record(item, "member picture");
		const userId = uuid(input.user_id, "picture account id");
		return {
			userId,
			objectName: objectName(input.object_name, "picture name", userId),
			updatedAt: timestamp(input.updated_at, "picture time"),
		};
	});
}

export function parseMemberPictureChange(value: unknown): MemberPictureChange {
	const input = record(value, "picture change");
	const previous = input.previous_object_name;
	if (previous === null || previous === undefined) return {};
	return { previousObjectName: objectName(previous, "replaced picture name") };
}

export function parseMemberPictureObjects(value: unknown): MemberPictureObject[] {
	return array(value, "picture folder").map((item) => {
		const input = record(item, "picture object");
		return {
			objectName: objectName(input.object_name, "picture object name"),
			createdAt: timestamp(input.created_at, "picture object time"),
		};
	});
}
