import type { SessionRuntimeSnapshot, SessionRuntimeView } from "./app-server.ts";

const INFRASTRUCTURE_GROUP_PREFIX = "infrastructure:";

export function isPublicSessionGroup(group: string | undefined): boolean {
	return !group?.startsWith(INFRASTRUCTURE_GROUP_PREFIX);
}

export function publicSessionRuntimeSnapshot(snapshot: SessionRuntimeSnapshot): SessionRuntimeSnapshot {
	const sessions = snapshot.sessions.filter((session) => isPublicSessionGroup(session.group));
	return sessions.length === snapshot.sessions.length ? snapshot : { ...snapshot, sessions };
}

export function isPublicSessionRuntime(session: SessionRuntimeView): boolean {
	return isPublicSessionGroup(session.group);
}
