# Object kit: what is the thing?

Use it for a physical thing the company makes, sells or weighs up: a product, a candidate device, a part, a box.
The page shows the thing large; the member turns it with a hand, and its parts are pointed out on it, each tied to
its name beside it. Big facts sit under it. You write only `object.json` and render the pictures on a machine.

## Pictures

- `turntable`: one picture holding N frames (24 to 72; 48 is good) of the thing turned once around its upright
  axis in equal steps, on a transparent background, in a grid: `columns` frames per row, left to right, top to
  bottom. Frame 0 opens the page: a three-quarter view that shows the thing best. Each next frame turns the thing
  360/N degrees so its front moves to the viewer's right. Turn the thing, not the camera; keep camera, light and
  scale the same in every frame; the axis runs through the frame's middle; the thing fills about 90 % of the frame
  height and stands on the frame's lower edge. Frames about 500 to 640 px; WebP with alpha; the sheet under 4 MB.
- A thing too abstract to read alone (a band, a ring) reads better worn or held by a plain matte stand-in.
- Draw only what you know. A model you made yourself says so in `line` ("Illustrative model of ...").

## Fields

- `lang`: such as `"da"`. `title` up to 60, read only by screen readers. `line` up to 60: the one quiet line the page draws, over the thing. `source`: a `folder:` or `https:` link, not drawn.
- `name` up to 22: the thing's name on its chip when there are variants.
- `turntable`: `{"picture", "frames", "columns", "frameWidth", "frameHeight"}`. Or `picture` alone: a still that
  does not turn.
- `parts`: up to 12 (8 reads best), each:
  - `id`, `name` up to 22, `value` up to 16 (optional, such as `"4 kanaler"`), `note` up to 90 (shown when tapped),
    `source` (optional).
  - `state`: `known` (solid dot), `assumed` (hollow dashed dot and a tag), `unknown` (dashed "?" dot, no value).
  - `track`: one `[x, y, v]` per frame. x and y place the part in that frame as fractions (0 to 1, from the top
    left); v is 1 when the part faces the viewer and nothing hides it, else 0. Give x and y also when v is 0. A
    still has one entry. Write tracks with your render script: project each part's 3D point in every frame, v from
    a facing test and a ray test. Never type them.
- `facts`: up to 5 figures that describe it, each `{"label"` up to 18, `"value"` up to 14, `"state"`, `"source"`?`}`.
  An unknown fact has no value: it draws a hatched "?".
- `variants`: up to 6 other candidates or colours, each `{"id", "name", "line"?, "turntable" or "picture",
  "parts"?, "facts"?}`. Render them with the same camera and frame size. Leave out `parts`/`facts` to keep the main
  ones (their tracks must then fit the variant's frames).
- `words`: the page's own words in your language: `assumed`, `unknown`, `drag` ("Drag to turn"), `close`,
  `source`, `turn` (the turntable's name for screen readers), `empty`, `tell`, `told`.

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
  "turntable": { "picture": "pictures/box.webp", "frames": 4, "columns": 4, "frameWidth": 560, "frameHeight": 560 },
  "parts": [
    { "id": "lid", "name": "Lid", "value": "Magnet", "state": "assumed", "note": "Closes with a magnet; its hold is not measured.",
      "track": [[0.5, 0.21, 1], [0.52, 0.2, 1], [0.5, 0.21, 1], [0.48, 0.2, 1]] }
  ],
  "facts": [
    { "label": "Weight", "value": "320 g", "state": "known" },
    { "label": "Price each", "state": "unknown" }
  ]
}
```
