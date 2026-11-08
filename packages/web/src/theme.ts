/* A classic head script: restore appearance before paint so neither theme
 * nor interface size flashes its default while main.js loads. It imports
 * appearance.ts, never preferences.ts, so the Danish dictionary stays out of
 * this render-blocking file (scripts/bundle.test.mjs holds it under 3.5 KB).
 * It also picks which of index.html's static first screens stands until
 * main.js draws (ui/boot.ts). */
import { applyComposerColor, applyTheme, applyUiSize } from "./ui/appearance.ts";
import { applyBoot } from "./ui/boot.ts";

applyTheme();
applyComposerColor();
applyUiSize();
applyBoot();
