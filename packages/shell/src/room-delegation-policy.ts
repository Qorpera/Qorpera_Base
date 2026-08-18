export const MAX_ROOM_DELEGATION_DEPTH = 3;
export const MAX_ROOM_DELEGATION_FANOUT = 8;

export interface RoomDelegationContext {
	depth: number;
	ancestorStaffAgentIds: ReadonlySet<string>;
	delegatedStaffAgentIds: ReadonlySet<string>;
}

export interface PlannedRoomDelegation {
	source: RoomDelegationContext;
	target: RoomDelegationContext;
}

export function rootRoomDelegationContext(staffAgentId: string): RoomDelegationContext {
	return {
		depth: 0,
		ancestorStaffAgentIds: new Set([staffAgentId]),
		delegatedStaffAgentIds: new Set(),
	};
}

export function planRoomDelegation(
	context: RoomDelegationContext,
	sourceStaffAgentId: string,
	targetStaffAgentId: string,
): PlannedRoomDelegation {
	if (targetStaffAgentId === sourceStaffAgentId) throw new Error("Agent Manager cannot delegate to itself");
	if (context.depth >= MAX_ROOM_DELEGATION_DEPTH) {
		throw new Error(`delegation is limited to ${MAX_ROOM_DELEGATION_DEPTH} hops`);
	}
	if (context.ancestorStaffAgentIds.has(targetStaffAgentId)) throw new Error("delegation cannot create a cycle");
	if (context.delegatedStaffAgentIds.has(targetStaffAgentId)) {
		throw new Error("this manager already delegated to that participant during the current turn");
	}
	if (context.delegatedStaffAgentIds.size >= MAX_ROOM_DELEGATION_FANOUT) {
		throw new Error(`one manager turn can delegate to at most ${MAX_ROOM_DELEGATION_FANOUT} participants`);
	}
	return {
		source: {
			...context,
			delegatedStaffAgentIds: new Set([...context.delegatedStaffAgentIds, targetStaffAgentId]),
		},
		target: {
			depth: context.depth + 1,
			ancestorStaffAgentIds: new Set([...context.ancestorStaffAgentIds, targetStaffAgentId]),
			delegatedStaffAgentIds: new Set(),
		},
	};
}
