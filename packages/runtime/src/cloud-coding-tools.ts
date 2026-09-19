import {
	type JsonValue,
	parseCloudCodingDispatch,
	parseCloudCodingFollowup,
	parseCloudCodingWorker,
} from "@qorpera/contracts";
import {
	type CloudNativeToolBinding,
	type CloudNativeToolIdentity,
	cloudToolRequest,
	parseCloudNativeToolBinding,
} from "./cloud-native-tool-authority.ts";
import { type CloudNativeTool, type CloudToolContext, cloudToolJsonText } from "./cloud-native-tool-boundary.ts";

export const CLOUD_CODING_RPCS = [
	"qorpera_dispatch_coding_worker",
	"qorpera_read_coding_worker",
	"qorpera_followup_coding_worker",
	"qorpera_cancel_coding_worker",
] as const;
export interface CloudCodingControl {
	call(
		method: (typeof CLOUD_CODING_RPCS)[number],
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown>;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const idSchema = { type: "string", pattern: UUID.source };
const keySchema = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$" };
const versionSchema = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
function objectSchema(properties: Record<string, JsonValue>): Record<string, JsonValue> {
	return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}

/** Optional parent tools. SQL owns durable admission, receipts and current
 * delegation authority; no local scheduler, credential or VM is exposed here. */
export function cloudCodingTools(
	binding: CloudNativeToolBinding,
	identity: CloudNativeToolIdentity,
	control: CloudCodingControl,
): readonly CloudNativeTool[] {
	const admitted = parseCloudNativeToolBinding(binding);
	const expected = Object.freeze({ ...identity });
	if (
		Object.entries(admitted).some(
			([key, value]) => key !== "credentialCapsuleId" && expected[key as keyof CloudNativeToolIdentity] !== value,
		)
	)
		throw new Error("Coding binding differs");
	const assertContext = (context: CloudToolContext): void => {
		if (
			context.companyId !== expected.companyId ||
			context.runId !== expected.runId ||
			!context.identity ||
			Object.entries(expected).some(
				([key, value]) => context.identity![key as keyof CloudNativeToolIdentity] !== value,
			)
		)
			throw new Error("Coding tool identity differs");
		context.signal.throwIfAborted();
	};
	const invoke = async (
		method: (typeof CLOUD_CODING_RPCS)[number],
		args: Record<string, unknown>,
		context: CloudToolContext,
		workerId?: string,
		repository?: JsonValue,
	) => {
		assertContext(context);
		const worker = parseCloudCodingWorker(
			await cloudToolRequest(
				(signal) => control.call(method, { p_binding: admitted, ...args }, signal),
				context.signal,
			),
		);
		if (
			worker.companyId !== expected.companyId ||
			worker.parentAgentId !== expected.staffAgentId ||
			(workerId !== undefined && worker.id !== workerId) ||
			(repository !== undefined &&
				(worker.parentRunId !== expected.runId ||
					cloudToolJsonText(worker.repository as unknown as JsonValue) !== cloudToolJsonText(repository)))
		)
			throw new Error("Coding worker response differs");
		return { kind: "text" as const, value: cloudToolJsonText(worker) };
	};
	const dispatch: CloudNativeTool = {
		name: "dispatch_coding_worker",
		source: "runtime",
		description:
			"Dispatch one coherent coding stream to an isolated cloud VM. Supply a complete goal, definition of done, bounded context, confirmed sourceReadIds and an existing authorized Company File todoPath. The company must have a coding executor and an explicit repository grant. Admission returns a durable queued handle, not a running VM or completed work. Retain workerId and steer that worker for follow-ups. Repository credentials never belong in context. Publication is a draft PR only. Keep operationKey stable; an uncertain response must not be retried with a new key. Workers report to their parent, never directly to a human.",
		inputSchema: objectSchema({
			operationKey: keySchema,
			repository: objectSchema({
				host: { type: "string", enum: ["github.com"] },
				owner: { type: "string", minLength: 1, maxLength: 39 },
				name: { type: "string", minLength: 1, maxLength: 100 },
				baseBranch: { type: "string", minLength: 1, maxLength: 200 },
			}),
			goal: { type: "string", minLength: 1, maxLength: 8192 },
			definitionOfDone: { type: "string", minLength: 1, maxLength: 8192 },
			context: { type: "string", maxLength: 32768 },
			sourceReadIds: { type: "array", items: idSchema, uniqueItems: true, maxItems: 64 },
			todoPath: { type: "string", minLength: 1, maxLength: 4096 },
			cancellationPolicy: { type: "string", enum: ["retain-workspace"] },
			completionPolicy: { type: "string", enum: ["notify-parent"] },
			publication: { type: "string", enum: ["draft-pr"] },
		}),
		parseArguments(value) {
			return JSON.parse(JSON.stringify(parseCloudCodingDispatch(value))) as JsonValue;
		},
		async execute(value, context) {
			const input = parseCloudCodingDispatch(value);
			return invoke(
				"qorpera_dispatch_coding_worker",
				{ p_dispatch: input },
				context,
				undefined,
				input.repository as unknown as JsonValue,
			);
		},
	};
	const followup: CloudNativeTool = {
		name: "followup_coding_worker",
		source: "runtime",
		description:
			"Continue the same coding worker, VM, repository and branch. Read its current version first. Supply only the new bounded goal; identity and repository cannot be retargeted. The cloud serializes work and rejects stale versions or workers requiring recovery. Reuse the same operationKey only with identical arguments. A queued follow-up is not completion.",
		inputSchema: objectSchema({
			operationKey: keySchema,
			workerId: idSchema,
			expectedVersion: versionSchema,
			goal: { type: "string", minLength: 1, maxLength: 8192 },
		}),
		parseArguments(value) {
			return { ...parseCloudCodingFollowup(value) };
		},
		async execute(value, context) {
			const input = parseCloudCodingFollowup(value);
			return invoke("qorpera_followup_coding_worker", { p_followup: input }, context, input.workerId);
		},
	};
	const parseHandle = (
		value: unknown,
		cancel: boolean,
	): { workerId: string; expectedVersion?: number; operationKey?: string } => {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid coding worker handle");
		const input = value as Record<string, unknown>;
		if (
			Object.keys(input).sort().join() !== (cancel ? "expectedVersion,operationKey,workerId" : "workerId") ||
			typeof input.workerId !== "string" ||
			!UUID.test(input.workerId)
		)
			throw new Error("Invalid coding worker handle");
		if (!cancel) return { workerId: input.workerId };
		const followup = parseCloudCodingFollowup({ ...input, goal: "Cancel and retain workspace" });
		return {
			workerId: followup.workerId,
			expectedVersion: followup.expectedVersion,
			operationKey: followup.operationKey,
		};
	};
	const read: CloudNativeTool = {
		name: "read_coding_worker",
		source: "runtime",
		description:
			"Read one coding worker owned by this parent. Its state and draft PR are durable metadata, not proof that a VM is currently executing. Completion uses a durable listener; do not busy-poll in model turns.",
		inputSchema: objectSchema({ workerId: idSchema }),
		parseArguments(value) {
			return { workerId: parseHandle(value, false).workerId };
		},
		async execute(value, context) {
			const input = parseHandle(value, false);
			return invoke("qorpera_read_coding_worker", { p_worker_id: input.workerId }, context, input.workerId);
		},
	};
	const cancel: CloudNativeTool = {
		name: "cancel_coding_worker",
		source: "runtime",
		description:
			"Request cancellation of this parent's coding worker at its current version. Preserve the worker, repository, branch and unmerged work. A cancellation request does not prove that a VM stopped or capacity was released; physical cancellation requires executor confirmation.",
		inputSchema: objectSchema({ workerId: idSchema, expectedVersion: versionSchema, operationKey: keySchema }),
		parseArguments(value) {
			return parseHandle(value, true) as JsonValue;
		},
		async execute(value, context) {
			const input = parseHandle(value, true);
			return invoke(
				"qorpera_cancel_coding_worker",
				{
					p_worker_id: input.workerId,
					p_expected_version: input.expectedVersion,
					p_operation_key: input.operationKey,
				},
				context,
				input.workerId,
			);
		},
	};
	return [dispatch, read, followup, cancel];
}
