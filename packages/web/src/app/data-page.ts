export const DATA_PAGE = "data";

const WANTED_MS = 15_000;

let wanted: { readonly profileId: string; readonly at: string; readonly until: number } | undefined;

export function wantDataList(profileId: string, at: string | undefined): void {
	wanted = at === undefined ? undefined : { profileId, at, until: Date.now() + WANTED_MS };
}

export function takeWantedDataList(profileId: string): string | undefined {
	const taken = wanted;
	wanted = undefined;
	return taken?.profileId === profileId && Date.now() <= taken.until ? taken.at : undefined;
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
