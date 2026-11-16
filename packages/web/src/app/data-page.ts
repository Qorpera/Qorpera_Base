export const DATA_PAGE = "data";

let wanted: { readonly profileId: string; readonly at: string } | undefined;

export function wantDataList(profileId: string, at: string): void {
	wanted = { profileId, at };
}

export function takeWantedDataList(profileId: string): string | undefined {
	if (wanted?.profileId !== profileId) return undefined;
	const { at } = wanted;
	wanted = undefined;
	return at;
}

export const DATA_INTERFACE = `format = "qorpera.interface/v0"

[interface]
id = "c96d2de2-598d-4422-a10a-4ac3e31cbe36"
name = "Data"
about = "The company's databases, one table at a time as a list of rows."
emblem = "box"
colour = "purple"
status = "active"

[access]
members = "all"
agents = "all"
edit = "anyone"

[[view]]
name = "Tables"

[[view.block]]
id = "data"
kind = "text"
text = "The company's databases."
`;
