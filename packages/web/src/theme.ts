/* A classic script in the document head: it sets the theme before the first
 * paint, so a dark page never flashes light while main.js loads. */
import { applyComposerColor, applyTheme } from "./ui/preferences.ts";

applyTheme();
applyComposerColor();
