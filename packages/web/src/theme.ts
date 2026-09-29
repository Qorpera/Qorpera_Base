/* A classic head script: restore appearance before paint so neither theme
 * nor interface size flashes its default while main.js loads. It imports
 * appearance.ts, never preferences.ts, so the Danish dictionary stays out of
 * this render-blocking file (scripts/bundle.test.mjs holds it under 2 KB). */
import { applyComposerColor, applyTheme, applyUiSize } from "./ui/appearance.ts";

applyTheme();
applyComposerColor();
applyUiSize();
