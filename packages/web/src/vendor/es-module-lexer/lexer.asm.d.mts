export interface ImportSpecifier {
	readonly n: string | undefined;
	readonly t: number;
	readonly s: number;
	readonly e: number;
	readonly ss: number;
	readonly se: number;
	readonly d: number;
	readonly a: number;
	readonly at: readonly (readonly [string, string])[] | null;
}

export interface ExportSpecifier {
	readonly n: string;
	readonly ln: string | undefined;
	readonly s: number;
	readonly e: number;
	readonly ls: number;
	readonly le: number;
}

export function parse(
	source: string,
	name?: string,
): readonly [readonly ImportSpecifier[], readonly ExportSpecifier[], boolean, boolean];
