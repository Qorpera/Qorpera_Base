/* A classic head script: restore appearance before paint so neither theme
 * nor interface size flashes its default while main.js loads. */
import { applyComposerColor, applyTheme, applyUiSize } from "./ui/preferences.ts";

applyTheme();
applyComposerColor();
applyUiSize();
