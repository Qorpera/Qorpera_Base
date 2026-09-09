# Approved designs

Self-contained pages. Open one in a browser; it needs no server and no network.

## `cofounder-first-run.html`

What the founder lands on after creating a company: the Co-Founder is already
seeded, and this screen is where they give it a face. Approved 2026-09-02.

What it is built from, so a rebuild does not drift:

- **The rail** is the approved V24 product preview (`Qorpera/Qorpera_Website`,
  `landing/src/ProductPreview.jsx` and `v24.css`): its surface, search field,
  add-agent plus, blue selection and owner footer. Its width is the macOS
  Messages ratio, a third of the window, and the search sits at the top with
  the plus beside it. There is no title bar and no thread header: neither
  belongs in a browser.
- **The Co-Founder card** is low, with the 64 px figure standing on it and
  rising above its top edge, a contact shadow at its feet, the presence dot at
  its lower right, and the name and status below.
- **The characters** are the vector figures from the visual workspace
  (`Qorpera_Base-step2/.artifacts/qorpera-avatar-assets`, Vector design), built
  from the baked traces and driven by the shared rig with **part motion 0**, so
  the body holds still and the life is in the eyes. Nothing follows the pointer.
  The six scripts are inlined verbatim from the website's `public/avatars`.
- **The selector** is the approved geometry: seven figures in one row, each in
  its own native shade, then the eleven-colour palette in centred rows of six
  and five. Figure and colour are independent settings.
- **The selection animation** is the approved creation burst
  (`motion-visuals.js`): strokes gather behind the figure and release in front
  at the spring, at 0.8 playback with 1.725 stroke width. The orbiting lanes
  are not ported here; the gather and release are.
- **Type** is the system face, as the V24 shell uses, not the web client's
  Source Sans 3.

The dark bar at the top is review chrome and is not part of the design.
