# Object kit: what is the thing?

Use it for a physical thing the company makes, sells or weighs up: a product, a candidate device, a part, a box.
The page shows the thing large, turned by the member's hand, its parts pointed out on it and named beside it, big
facts under it. You write only `object.json` and make the model or pictures on a machine.

## Model

`model`: a `.glb` in the app's folder, which the member's browser draws live in real light, turned and tilted by
hand. Make it in Blender (metres, real materials, each part a named object) and export it:
`blender -b thing.blend --python-exit-code 1 --python-expr "import bpy; bpy.ops.export_scene.gltf(filepath='/company/apps/<app>/thing.glb', export_format='GLB', export_apply=True)"`.
No Draco or meshopt compression. Keep it light enough to open quickly on a phone (a test machine, not a phone, drew
5 and 32 MB models in 2 and 3 s). `view` `{"yaw", "pitch"}` in degrees: where it opens, else three-quarter;
`environment`: your own `.hdr` light in the folder.

## Pictures

- Keep `turntable` or `picture` beside `model`: it is shown while the model arrives and where 3D cannot run.
- `turntable`: one picture of N frames (24 to 72; 48 is good) of the thing turned once around its upright axis in
  equal steps, on a transparent background, `columns` frames per row, left to right, top to bottom. Frame 0 is the
  three-quarter view that shows it best; each next frame turns the thing 360/N degrees, its front to the viewer's
  right. Turn the thing, not the camera; same camera, light and scale in every frame; the axis in the frame's middle;
  the thing fills about 90 % of the frame height, on the frame's lower edge. Frames 500 to 640 px; WebP with alpha;
  the sheet under 4 MB.
- A thing too abstract to read alone (a band, a ring) reads better worn or held by a plain matte stand-in.
- Draw only what you know. A model you made yourself says so in `line` ("Illustrative model of ...").

## Fields

- `lang`: such as `"da"`. `title` up to 60, read only by screen readers. `line` up to 60: the one quiet line the page draws, over the thing. `source`: a `folder:` or `https:` link, not drawn.
- `name` up to 22: the thing's name on its chip when there are variants.
- `turntable`: `{"picture", "frames", "columns", "frameWidth", "frameHeight"}`. Or `picture` alone: a still.
- `parts`: up to 12 (8 reads best), each:
  - `id`, `name` up to 22, `value` up to 16 (optional, such as `"4 kanaler"`), `note` up to 90 (shown when tapped),
    `source` (optional).
  - `state`: `known` (solid dot), `assumed` (hollow dashed dot and a tag), `unknown` (dashed "?" dot, no value).
  - `node`: with `model`, the part's object name in Blender; the page finds it.
  - `track`, for pictures: one `[x, y, v]` per frame: x and y as fractions (0 to 1, from the top left), v 1 when the
    part faces the viewer unhidden, else 0 (x and y also then). A still has one. Compute them in your render script
    (project each part's point, a facing test and a ray test); never type them.
- `facts`: up to 5 figures that describe it, each `{"label"` up to 18, `"value"` up to 14, `"state"`, `"source"`?`}`.
  An unknown fact has no value: it draws a hatched "?".
- `variants`: up to 6 other candidates or colours, each `{"id", "name", "line"?, "model"?, "turntable" or "picture",
  "parts"?, "facts"?}`, made with the same camera and size. Without `parts`/`facts` they keep the main ones
  (whose tracks must fit their frames).
- `words`: the page's own words in your language: `assumed`, `unknown`, `drag` ("Drag to turn"), `close`,
  `source`, `turn` (its name for screen readers), `empty`, `nomodel`, `tell`, `told`.

The page turns slowly by itself until touched. Tapping a part or its name turns the thing the short way to where that
part faces the viewer best, and shows its note. Never invent a value: a figure the documents do not give is
`unknown`.

## Example

```json
{
  "lang": "en",
  "title": "The box",
  "line": "Illustrative model of the proposed box",
  "source": "folder:product/packaging.md",
  "name": "Box A",
  "model": "box.glb",
  "turntable": { "picture": "pictures/box.webp", "frames": 4, "columns": 4, "frameWidth": 560, "frameHeight": 560 },
  "parts": [
    { "id": "lid", "name": "Lid", "value": "Magnet", "state": "assumed", "node": "Lid", "note": "Closes with a magnet; its hold is not measured.",
      "track": [[0.5, 0.21, 1], [0.52, 0.2, 1], [0.5, 0.21, 1], [0.48, 0.2, 1]] }
  ],
  "facts": [
    { "label": "Weight", "value": "320 g", "state": "known" },
    { "label": "Price each", "state": "unknown" }
  ]
}
```
