import type { ExecuteSurfaceOpsActionInput, ExecuteSurfaceOpsActionResult } from "./orchestrator.ts";
import type { SurfaceCompanyFolderPort, SurfaceExecutionBridgePorts } from "./surface-execution-bridge.ts";

const MAX_OPS_FILE_WRITE_BYTES = 512 * 1024;
const BLOCKED_OPS_PREFIXES = ["qorperaos/", "code/", "hooks/", "bank/", "digital-post/", "members/"];

export interface OpsActionControlPlane {
	executeSurfaceOpsAction?(
		input: ExecuteSurfaceOpsActionInput,
		signal?: AbortSignal,
	): Promise<ExecuteSurfaceOpsActionResult>;
}

export interface OpsActionExecutorPorts {
	readonly controlPlane: OpsActionControlPlane;
	readonly folder?: SurfaceCompanyFolderPort;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeSafeOpsFilePath(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim().replace(/^\/+/, "");
	if (!trimmed || trimmed.length > 512 || /[\0-\x1f\x7f\\]/.test(trimmed)) return null;
	const parts = trimmed.split("/");
	if (parts.some((part) => !part || part === "." || part === "..")) return null;
	const lowered = trimmed.toLowerCase();
	if (BLOCKED_OPS_PREFIXES.some((prefix) => lowered === prefix.slice(0, -1) || lowered.startsWith(prefix))) {
		return null;
	}
	return parts.join("/");
}

export function createOpsActionExecutor(
	ports: OpsActionExecutorPorts,
): NonNullable<SurfaceExecutionBridgePorts["runOpsActionJob"]> {
	return async (job, signal) => {
		const changes = job.approvedChanges ?? [];
		for (const change of changes) {
			const manifest = isPlainObject(change.patchManifest) ? change.patchManifest : null;
			const actionKind = typeof manifest?.actionKind === "string" ? manifest.actionKind.trim() : "";
			if (!actionKind) {
				return { status: "failed", errorDetail: `Missing actionKind on ops change ${change.changeId}` };
			}
			const normalizedKind = actionKind.toLowerCase();
			if (normalizedKind === "noop") {
				continue;
			}
			const actionPayload = isPlainObject(manifest?.actionPayload) ? manifest.actionPayload : {};
			if (normalizedKind === "file.write" || normalizedKind === "file.delete") {
				const safePath = normalizeSafeOpsFilePath(actionPayload.path);
				if (!safePath) {
					return {
						status: "failed",
						errorDetail: `Invalid or protected path for ${actionKind} on change ${change.changeId}`,
					};
				}
				if (normalizedKind === "file.write") {
					if (!ports.folder?.writeFile) {
						return {
							status: "failed",
							errorDetail: "Company folder write is not configured on this orchestrator",
						};
					}
					if (typeof actionPayload.content !== "string") {
						return { status: "failed", errorDetail: "file.write action requires string content" };
					}
					if (Buffer.byteLength(actionPayload.content, "utf8") > MAX_OPS_FILE_WRITE_BYTES) {
						return { status: "failed", errorDetail: "file.write content exceeds 512 KiB limit" };
					}
					await ports.folder.writeFile(
						{ profileId: job.profileId, path: safePath, content: actionPayload.content },
						signal,
					);
					continue;
				}
				if (!ports.folder?.deleteFile) {
					return { status: "failed", errorDetail: "Company folder delete is not configured on this orchestrator" };
				}
				await ports.folder.deleteFile({ profileId: job.profileId, path: safePath }, signal);
				continue;
			}
			if (typeof ports.controlPlane.executeSurfaceOpsAction !== "function") {
				return {
					status: "failed",
					errorDetail: `Ops action kind "${actionKind}" is not enabled on this orchestrator`,
				};
			}
			try {
				const outcome = await ports.controlPlane.executeSurfaceOpsAction(
					{
						profileId: job.profileId,
						jobId: job.jobId,
						changeId: change.changeId,
						...(job.leaseToken ? { leaseToken: job.leaseToken } : {}),
					},
					signal,
				);
				if (outcome.status !== "landed") {
					return {
						status: "failed",
						errorDetail: outcome.errorDetail ?? `Ops action "${actionKind}" did not complete`,
					};
				}
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				return {
					status: "failed",
					errorDetail: detail || `Ops action "${actionKind}" failed`,
				};
			}
		}
		return { status: "landed" };
	};
}
