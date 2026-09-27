export const OFFICE_RESET_TIMING_SCHEMA: "qorpera.office-acceptance-reset-timing/v1";
export const OFFICE_RESET_TIMING_STAGES: readonly string[];
export interface OfficeResetTimingRow {
	stage: string;
	atMs: number;
	elapsedMs: number;
	outcome: "fulfilled" | "rejected";
	parentAborted: boolean;
	operationAborted: boolean | null;
	physicalAborted: boolean | null;
	physicalLease: number | null;
	physicalRemainingMs: number | null;
}
export interface OfficeResetTiming {
	schema: typeof OFFICE_RESET_TIMING_SCHEMA;
	attempt: number;
	elapsedMs: number;
	outcome: "fulfilled" | "rejected";
	parentAborted: boolean;
	total: number;
	omitted: number;
	pendingAtSettlement: number;
	records: OfficeResetTimingRow[];
}
export function projectOfficeResetTiming(value: unknown): OfficeResetTiming | null;
export function officeResetTimingHistory(): {
	accept(value: unknown): boolean;
	snapshot(): {
		schema: string;
		total: number;
		rejected: number;
		omitted: number;
		first: OfficeResetTiming[];
		recent: OfficeResetTiming[];
		clock: string;
		uninstrumented: string[];
		signals: string;
		physicalRemaining: string;
		stageMeaning: string;
	};
};
