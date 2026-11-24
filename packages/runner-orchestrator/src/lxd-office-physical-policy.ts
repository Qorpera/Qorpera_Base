import { resolve } from "node:path";

export interface LxdOfficeMountPolicy {
	mountPoint: string;
	root: "/";
	filesystem: string;
	source: string;
}

export function officePhysicalPath(value: unknown): string {
	if (
		typeof value !== "string" ||
		value === "/" ||
		value.length > 4096 ||
		resolve(value) !== value ||
		/[\x00-\x20\x7f\\]/.test(value)
	)
		throw new Error("INVALID_OFFICE_PHYSICAL_PATH");
	return value;
}
