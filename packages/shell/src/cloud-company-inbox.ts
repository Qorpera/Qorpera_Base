import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type CloudCompanyTreeReference, currentCloudCompanyTreeReference } from "./cloud-company-snapshot.ts";
import type { CloudRealtimeChange } from "./cloud-realtime-sync.ts";
import { type CloudSyncHealth, DurableCloudSyncLoop } from "./cloud-sync-loop.ts";
import type { HostedCompanySnapshot, HostedCompanyWorkspace } from "./hosted-primary.ts";

const COMPANY_INBOX_SCHEMA = "qorpera.cloud-company-inbox/v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface CloudCompanyInboxHead {
	snapshotId: string;
	parentSnapshotId?: string;
	createdAt: string;
	tree: CloudCompanyTreeReference;
}

export interface CloudCompanyInboxEntry {
	workspaceId: string;
	clientWorkspaceId: string;
	name: string;
	isLocal: boolean;
	updatedAt: string;
	head?: CloudCompanyInboxHead;
}

export interface CloudCompanyInbox {
	schema: typeof COMPANY_INBOX_SCHEMA;
	profileId: string;
	environmentId: string;
	localClientWorkspaceId: string;
	refreshedAt: string;
	workspaces: CloudCompanyInboxEntry[];
}

export interface CompanyWorkspaceInboxPrimary {
	listCompanyWorkspaces(environmentId: string): Promise<HostedCompanyWorkspace[]>;
	getCompanySnapshot(snapshotId: string): Promise<HostedCompanySnapshot>;
}

export interface CloudCompanyWorkspaceInboxOptions {
	userData: string;
	companyRoot: string;
	profileId: string;
	environmentId: string;
	localClientWorkspaceId: string;
	primary: CompanyWorkspaceInboxPrimary;
	steadyDelayMs?: number;
	onHealth?: (health: CloudSyncHealth) => void;
	onInbox?: (inbox: CloudCompanyInbox) => void;
	now?: () => number;
}

function timestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validTree(value: unknown): value is CloudCompanyTreeReference {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const tree = value as Partial<CloudCompanyTreeReference>;
	return (
		SHA256_PATTERN.test(tree.manifestSha256 ?? "") &&
		Number.isSafeInteger(tree.manifestBytes) &&
		(tree.manifestBytes ?? -1) > 0 &&
		(tree.contractVersion === 1 || tree.contractVersion === 2) &&
		Number.isSafeInteger(tree.fileCount) &&
		(tree.fileCount ?? -1) >= 0 &&
		Number.isSafeInteger(tree.totalBytes) &&
		(tree.totalBytes ?? -1) >= 0
	);
}

export function cloudCompanyInboxPath(userData: string, profileId: string, environmentId: string): string {
	if (!UUID_PATTERN.test(profileId) || !UUID_PATTERN.test(environmentId)) {
		throw new Error("Cloud company inbox identity must use UUIDs");
	}
	return join(userData, "cloud-company-inbox", `${profileId}-${environmentId}.json`);
}

function parseInbox(value: unknown, profileId: string, environmentId: string): CloudCompanyInbox | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Partial<CloudCompanyInbox>;
	if (
		input.schema !== COMPANY_INBOX_SCHEMA ||
		input.profileId !== profileId ||
		input.environmentId !== environmentId ||
		!UUID_PATTERN.test(input.localClientWorkspaceId ?? "") ||
		!timestamp(input.refreshedAt) ||
		!Array.isArray(input.workspaces)
	) {
		return undefined;
	}
	const workspaces: CloudCompanyInboxEntry[] = [];
	const ids = new Set<string>();
	for (const value of input.workspaces) {
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		const workspace = value as Partial<CloudCompanyInboxEntry>;
		if (
			!UUID_PATTERN.test(workspace.workspaceId ?? "") ||
			ids.has(workspace.workspaceId ?? "") ||
			!UUID_PATTERN.test(workspace.clientWorkspaceId ?? "") ||
			typeof workspace.name !== "string" ||
			!workspace.name.trim() ||
			workspace.name.length > 160 ||
			typeof workspace.isLocal !== "boolean" ||
			!timestamp(workspace.updatedAt)
		) {
			return undefined;
		}
		ids.add(workspace.workspaceId as string);
		let head: CloudCompanyInboxHead | undefined;
		if (workspace.head !== undefined) {
			if (
				!workspace.head ||
				!UUID_PATTERN.test(workspace.head.snapshotId) ||
				(workspace.head.parentSnapshotId !== undefined && !UUID_PATTERN.test(workspace.head.parentSnapshotId)) ||
				!timestamp(workspace.head.createdAt) ||
				!validTree(workspace.head.tree)
			) {
				return undefined;
			}
			head = workspace.head;
		}
		workspaces.push({
			workspaceId: workspace.workspaceId as string,
			clientWorkspaceId: workspace.clientWorkspaceId as string,
			name: workspace.name,
			isLocal: workspace.isLocal,
			updatedAt: workspace.updatedAt,
			...(head ? { head } : {}),
		});
	}
	return { ...input, workspaces } as CloudCompanyInbox;
}

export function readCloudCompanyInbox(
	userData: string,
	profileId: string,
	environmentId: string,
): CloudCompanyInbox | undefined {
	try {
		return parseInbox(
			JSON.parse(readFileSync(cloudCompanyInboxPath(userData, profileId, environmentId), "utf-8")),
			profileId,
			environmentId,
		);
	} catch {
		return undefined;
	}
}

function writeInbox(userData: string, inbox: CloudCompanyInbox): void {
	const path = cloudCompanyInboxPath(userData, inbox.profileId, inbox.environmentId);
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(temporary, `${JSON.stringify(inbox, null, "\t")}\n`, {
			encoding: "utf-8",
			mode: 0o600,
			flag: "wx",
		});
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

export async function refreshCloudCompanyInbox(options: CloudCompanyWorkspaceInboxOptions): Promise<CloudCompanyInbox> {
	const workspaces = await options.primary.listCompanyWorkspaces(options.environmentId);
	const entries = await Promise.all(
		workspaces.map(async (workspace): Promise<CloudCompanyInboxEntry> => {
			let head: CloudCompanyInboxHead | undefined;
			if (workspace.headSnapshotId) {
				const snapshot = await options.primary.getCompanySnapshot(workspace.headSnapshotId);
				if (
					snapshot.snapshotId !== workspace.headSnapshotId ||
					snapshot.profileId !== options.profileId ||
					snapshot.environmentId !== options.environmentId
				) {
					throw new Error("Cloud company inbox head is outside its profile environment");
				}
				head = {
					snapshotId: snapshot.snapshotId,
					...(snapshot.parentSnapshotId ? { parentSnapshotId: snapshot.parentSnapshotId } : {}),
					createdAt: snapshot.createdAt,
					tree: currentCloudCompanyTreeReference(snapshot.tree),
				};
			}
			return {
				workspaceId: workspace.workspaceId,
				clientWorkspaceId: workspace.clientWorkspaceId,
				name: workspace.name,
				isLocal: workspace.clientWorkspaceId === options.localClientWorkspaceId,
				updatedAt: workspace.updatedAt,
				...(head ? { head } : {}),
			};
		}),
	);
	entries.sort((left, right) => {
		if (left.isLocal !== right.isLocal) return left.isLocal ? -1 : 1;
		return right.updatedAt.localeCompare(left.updatedAt) || left.workspaceId.localeCompare(right.workspaceId);
	});
	const inbox: CloudCompanyInbox = {
		schema: COMPANY_INBOX_SCHEMA,
		profileId: options.profileId,
		environmentId: options.environmentId,
		localClientWorkspaceId: options.localClientWorkspaceId,
		refreshedAt: new Date((options.now ?? Date.now)()).toISOString(),
		workspaces: entries,
	};
	writeInbox(options.userData, inbox);
	return inbox;
}

export class CloudCompanyWorkspaceInboxSync {
	readonly #options: CloudCompanyWorkspaceInboxOptions;
	readonly #loop: DurableCloudSyncLoop;
	#inbox?: CloudCompanyInbox;

	constructor(options: CloudCompanyWorkspaceInboxOptions) {
		this.#options = options;
		this.#inbox = readCloudCompanyInbox(options.userData, options.profileId, options.environmentId);
		this.#loop = new DurableCloudSyncLoop({
			root: options.companyRoot,
			userData: options.userData,
			profileId: options.profileId,
			channel: "workspace-inbox",
			steadyDelayMs: options.steadyDelayMs ?? 60_000,
			now: options.now,
			onHealth: options.onHealth,
			sync: async () => {
				this.#inbox = await refreshCloudCompanyInbox(this.#options);
				this.#options.onInbox?.(this.inbox() as CloudCompanyInbox);
			},
		});
	}

	inbox(): CloudCompanyInbox | undefined {
		return this.#inbox ? structuredClone(this.#inbox) : undefined;
	}

	health(): CloudSyncHealth {
		return this.#loop.health();
	}

	start(): void {
		this.#loop.start();
	}

	stop(): void {
		this.#loop.stop();
	}

	handleRealtimeChange(change: CloudRealtimeChange): void {
		if (change.resource === "workspace") void this.#loop.trigger();
	}

	refreshNow(): Promise<CloudSyncHealth> {
		return this.#loop.syncNow();
	}
}
