import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isDeepStrictEqual } from "node:util";
import { ObjectDependencyError } from "./dependency.ts";
import type { MemberCompanyFileOptions } from "./member-company-file.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function closed(value: unknown, keys: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys)
		throw new ObjectDependencyError(503);
	return value as Record<string, unknown>;
}
/** Only an exact, completed shared export selected by the member. No raw
 * profile object, office path or artifact from another realm is accepted. */
export async function serveMemberFileExport(
	request: IncomingMessage,
	response: ServerResponse,
	options: Pick<MemberCompanyFileOptions, "authority" | "store" | "readLegacyObject">,
): Promise<void> {
	const match = /^\/v1\/member-file-exports\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/([0-9a-f]{64})$/.exec(
		request.url ?? "",
	);
	if (!match || !UUID.test(match[1]) || !UUID.test(match[2])) throw new ObjectDependencyError(404);
	if (request.method !== "GET") throw new ObjectDependencyError(405);
	const header = request.headers.authorization;
	if (!header || !/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(header)) throw new ObjectDependencyError(401);
	const [, environmentId, assetId, sha256] = match,
		controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 30_000),
		signal = controller.signal;
	try {
		const authorize = async () => {
			const value = closed(
				await options.authority.member(
					"qorpera_member_file_export_source",
					header.slice(7),
					{ p_environment_id: environmentId, p_source: { realm: "object_storage", assetId, sha256 } },
					signal,
				),
				"asset,companyId,environmentId",
			);
			const asset = closed(value.asset, "assetId,bytes,destination,mediaType,schema,sha256,source");
			const source = closed(asset.source, "companyComputerId,path,realm,screenId"),
				destination = closed(asset.destination, "realm");
			if (
				typeof value.companyId !== "string" ||
				!UUID.test(value.companyId) ||
				value.environmentId !== environmentId ||
				asset.schema !== "qorpera.file-transfer-asset/v1" ||
				asset.assetId !== assetId ||
				asset.sha256 !== sha256 ||
				!Number.isSafeInteger(asset.bytes) ||
				(asset.bytes as number) < 0 ||
				(asset.bytes as number) > 8 * 1024 * 1024 ||
				typeof asset.mediaType !== "string" ||
				asset.mediaType.length > 256 ||
				!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(asset.mediaType) ||
				destination.realm !== "object_storage" ||
				source.realm !== "company_computer" ||
				[source.companyComputerId, source.screenId].some((id) => typeof id !== "string" || !UUID.test(id)) ||
				typeof source.path !== "string" ||
				Buffer.byteLength(source.path) > 1024 ||
				source.path
					.split("/")
					.some((part) => !part || part === "." || part === ".." || Buffer.byteLength(part) > 255) ||
				source.path.split("/").length > 32 ||
				/[\\\x00-\x1f\x7f]/.test(source.path)
			)
				throw new ObjectDependencyError(503);
			return { value, companyId: value.companyId, bytes: asset.bytes as number };
		};
		const access = await authorize();
		let bytes: Uint8Array = new Uint8Array();
		if (access.bytes) {
			try {
				bytes = await options.store.get(access.companyId, sha256, access.bytes);
			} catch (error) {
				if (
					!(error instanceof Error) ||
					(error.message !== "Object not found" && !(error instanceof ObjectDependencyError && error.unavailable))
				)
					throw error;
				bytes = await options.readLegacyObject(access.companyId, sha256);
			}
		}
		if (bytes.length !== access.bytes || createHash("sha256").update(bytes).digest("hex") !== sha256)
			throw new ObjectDependencyError(503);
		if (!isDeepStrictEqual(await authorize(), access)) throw new ObjectDependencyError(403);
		signal.throwIfAborted();
		response.writeHead(200, {
			"content-type": "application/octet-stream",
			"content-length": bytes.length,
			"cache-control": "private, no-store",
			"x-content-type-options": "nosniff",
			"x-qorpera-access-mode": "live-export-authority",
		});
		response.end(bytes);
	} finally {
		clearTimeout(timer);
	}
}
