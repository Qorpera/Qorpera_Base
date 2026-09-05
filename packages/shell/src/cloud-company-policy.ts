import { createHash } from "node:crypto";
import { parse } from "smol-toml";
import type { CloudCompanyPathGateway } from "./cloud-company-path-gateway.ts";

const KEYS = ["spending", "external_communication", "hard_to_reverse_changes", "information_sharing"] as const;
type PolicyMode = "ask" | "act" | "auto";
export interface CloudCompanyPolicy {
	path: "authority.toml";
	version: string | null;
	sourceSha256: string | null;
	readObservationIds: string[];
	choices: Record<(typeof KEYS)[number], PolicyMode>;
}

/** Read a bounded, single-version policy through the normal member + agent ACL.
 * Only four validated enums enter context; other TOML content is never promoted
 * into runtime instructions. Unreadable or malformed policy stops composition.
 */
export async function readCloudCompanyPolicy(
	gateway: Pick<CloudCompanyPathGateway, "read">,
	signal: AbortSignal,
): Promise<CloudCompanyPolicy> {
	const policy: CloudCompanyPolicy = {
		path: "authority.toml",
		version: null,
		sourceSha256: null,
		readObservationIds: [],
		choices: {
			spending: "ask",
			external_communication: "ask",
			hard_to_reverse_changes: "ask",
			information_sharing: "ask",
		},
	};
	let source = "";
	let offset = 0;
	let totalBytes: number | undefined;
	for (let page = 0; page < 9; page++) {
		signal.throwIfAborted();
		const result = await gateway.read(policy.path, offset, 4096, signal);
		signal.throwIfAborted();
		if (result.path !== policy.path || (result.version !== null && typeof result.version !== "string"))
			throw new Error("Company policy read scope changed");
		if (page === 0) policy.version = result.version;
		if (result.version !== policy.version) throw new Error("Company policy changed during composition");
		policy.readObservationIds.push(result.readObservationId);
		if (result.kind === "absent" && page === 0) return policy;
		if (
			result.kind !== "file" ||
			result.offset !== offset ||
			typeof result.text !== "string" ||
			typeof result.totalBytes !== "number" ||
			!Number.isSafeInteger(result.totalBytes) ||
			result.totalBytes < 0 ||
			result.totalBytes > 32768 ||
			typeof result.bytesRead !== "number" ||
			result.bytesRead !== Buffer.byteLength(result.text) ||
			result.bytesRead > 4096 ||
			(totalBytes !== undefined && result.totalBytes !== totalBytes)
		)
			throw new Error("Company policy is not a supported text file");
		totalBytes = result.totalBytes;
		source += result.text;
		offset += result.bytesRead;
		if (result.nextOffset === null) {
			if (offset !== totalBytes) throw new Error("Company policy read is incomplete");
			const section = parse(source).policy;
			if (section && typeof section === "object" && !Array.isArray(section)) {
				for (const key of KEYS) {
					const value = (section as Record<string, unknown>)[key];
					if (value === "ask" || value === "act" || value === "auto") policy.choices[key] = value;
				}
			}
			policy.sourceSha256 = createHash("sha256").update(source).digest("hex");
			return policy;
		}
		if (result.nextOffset !== offset || result.bytesRead === 0 || offset >= totalBytes)
			throw new Error("Company policy read did not advance");
	}
	throw new Error("Company policy exceeds its read budget");
}
