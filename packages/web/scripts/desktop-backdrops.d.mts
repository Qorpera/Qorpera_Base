export interface DesktopBackdrop {
	transform: string;
	evenodd: boolean;
	paths: { d: string; transform: string }[];
}
export const BACKDROP_SOURCES: Readonly<Record<string, string>>;
export function backdropFromSource(html: string): DesktopBackdrop;
export function desktopBackdrops(): Record<string, DesktopBackdrop>;
