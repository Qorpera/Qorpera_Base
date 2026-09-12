export interface RemovedMainSymbol {
	symbol: string;
	reason: string;
}

export const removedLocalLaneModules: readonly string[];
export const removedAgentRuntimeExports: readonly string[];
export const removedMainSymbols: readonly RemovedMainSymbol[];
export function checkCloudRuntimeBoundaries(repositoryRoot: string): string[];
