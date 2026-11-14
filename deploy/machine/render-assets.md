# The starter set for renders

Light, materials and a few pieces of furniture that somebody photographed and modelled, so a render starts from a
real room and not from plain colours in a dark, empty world. Everything here is from Poly Haven (polyhaven.com) and is
CC0: use it in anything, for anyone, with no credit owed. `SOURCES.tsv` names where each file came from; get more
there (the 4k and 8k versions too) with curl. `preview.jpg` shows every item once, eight to a row: the things, then
the materials, then the lights, each in the order of the tables below.

Blender is installed: `blender -b -t 0 --python-exit-code 1 -P your-script.py` (4.3, Cycles with OpenImageDenoise).
`-t 0` gives it every processor the machine has. Without `--python-exit-code 1` a script that failed still ends as
if it had worked, so always pass it and read the output. Sizes are in metres.

## Things: `models/<name>/<name>_2k.gltf`

| Name | Thing | Width, depth, height, m |
| --- | --- | --- |
| `alarm_clock_01` | An alarm clock with two bells | 0.13, 0.07, 0.17 |
| `book_encyclopedia_set_01` | A row of leather-bound books | 0.55, 0.16, 0.24 |
| `fancy_picture_frame_01` | A painting in a gilded frame | 0.60, 0.02, 0.46 |
| `modern_arm_chair_01` | An armchair, wood and black leather | 0.82, 0.99, 1.02 |
| `potted_plant_02` | A leafy plant in a clay pot | 0.70, 0.66, 0.84 |
| `potted_plant_04` | A small succulent in a white pot | 0.17, 0.19, 0.27 |
| `round_wooden_table_01` | A round table of dark wood | 1.40, 1.40, 1.01 |
| `sofa_02` | A sofa of dark leather | 1.81, 0.82, 0.71 |
| `tea_set_01` | A tea set, its pots and cups set apart | 0.92, 0.48, 0.17 |
| `wooden_table_02` | A plain wooden table | 1.13, 0.71, 0.80 |

```python
bpy.ops.import_scene.gltf(filepath="/opt/qorpera-assets/models/wooden_table_02/wooden_table_02_2k.gltf")
```

A thing arrives standing on the ground at the middle of the scene, at its real size: move it, never scale it. Glass
arrives as a plain sheet (the clock's front): give that material Transmission 1 and Roughness 0.

## Materials: `textures/<name>/<name>_2k.gltf`

Each is a surface with its colour, roughness and relief. Its `.gltf` holds one flat piece of the surface at its real
size with the material ready on it: import it, take the material, delete the piece.

| Name | Surface | One tile, m |
| --- | --- | --- |
| `beige_wall_001` | A beige plastered wall | 3.0 |
| `brown_leather` | Brown leather | 0.4 |
| `concrete_floor_worn_001` | A worn concrete floor | 3.0 |
| `dark_wood` | Dark red wood | 2.0 |
| `fabric_pattern_07` | Red and white checked cloth | 0.4 |
| `laminate_floor_02` | A light laminate floor | 1.7 |
| `marble_01` | Pale marble tiles | 1.5 |
| `metal_plate` | Worn checker plate | 0.5 |
| `oak_veneer_01` | Oak veneer | 1.84 |
| `painted_plaster_wall` | A painted plaster wall | 2.0 |
| `plywood` | Plywood | 1.0 |
| `white_plaster_02` | Rough white plaster | 1.0 |
| `wood_floor` | An oak plank floor | 1.7 |
| `wood_table_001` | Polished dark table wood | 1.5 |

```python
before = set(bpy.data.objects)
bpy.ops.import_scene.gltf(filepath="/opt/qorpera-assets/textures/laminate_floor_02/laminate_floor_02_2k.gltf")
piece = [obj for obj in bpy.data.objects if obj not in before]
floor_material = piece[0].data.materials[0]
for obj in piece: bpy.data.objects.remove(obj)
```

On a surface larger than one tile, repeat the pictures: put a Mapping node before the material's image nodes and
scale by the surface's size divided by the tile's.

## Light: `hdris/<name>_2k.exr`

An HDRI is a photograph of all the light in a place. Use it as the world and the scene is lit the way that place is.

| Name | The place |
| --- | --- |
| `artist_workshop` | A workshop at midday, daylight through windows |
| `brown_photostudio_02` | A warm studio, lamps and daylight |
| `cayley_interior` | A living room at dusk, lamps on, high contrast |
| `kloofendal_48d_partly_cloudy_puresky` | Outdoors at midday, sun and some cloud, sky only |
| `lebombo` | A plain room in the afternoon, soft |
| `moonless_golf` | Outdoors at night |
| `photo_studio_loft_hall` | A daylight studio with large windows: soft, a good first choice for a product |
| `spruit_sunrise` | Outdoors at sunrise, low warm sun |
| `studio_small_08` | A photo studio with soft boxes, even and low in contrast |
| `studio_small_09` | The same kind of studio, with more shape |

```python
world = bpy.data.worlds.new("world"); world.use_nodes = True; scene.world = world
light = world.node_tree.nodes.new("ShaderNodeTexEnvironment")
light.image = bpy.data.images.load("/opt/qorpera-assets/hdris/photo_studio_loft_hall_2k.exr")
world.node_tree.links.new(light.outputs["Color"], world.node_tree.nodes["Background"].inputs["Color"])
```

Turn the light around the scene with a Mapping node's Z rotation, and set how strong it is with the Background's
Strength (1 is as photographed; a lamp of your own shows better at 0.3 to 0.6). Render four turns small and keep
the one that shapes the thing best.

## A frame that holds up

- Build the product yourself; borrow the room. Real sizes, a floor, a wall, and two or three things around it.
- Look through a real lens: 50 to 85 mm, the camera at eye or table height, a little depth of field.
- 64 samples with the denoiser is enough for a still; noise in a film shows, so use more there.
- Render small first (960 px), look at it, fix the weakest thing, render again. Then render the full frame.
- Pictures afterwards: ffmpeg joins frames into a film; ImageMagick (`convert`, `montage`), `cwebp` and Python's
  Pillow cut, join and convert them.
