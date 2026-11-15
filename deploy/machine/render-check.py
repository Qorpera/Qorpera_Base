# The image build's render check (deploy/machine/build-machine-image.sh runs it as its last word on Blender):
#
#   blender -b --factory-startup --python-exit-code 1 -P /opt/qorpera-machine/render-check.py -- \
#       /opt/qorpera-assets /tmp/render-check.png
#
# One small frame the way an agent would make one: Cycles on the processors, OpenImageDenoise, a room from the
# starter set (an HDRI as the world, a textured floor, a table that somebody modelled). It fails, with one line that
# says why, when Blender is not the pinned version, when the denoiser is not built in, when a file of the set does
# not load, or when the frame comes out black or flat (a world that lights nothing). Blender ends well after a script
# that raised unless it is told otherwise (--python-exit-code), so everything here runs inside one try as well.
import os
import sys

import bpy
from mathutils import Vector

assets, out = sys.argv[sys.argv.index("--") + 1 :]
EXPECTED = os.environ.get("BLENDER_VERSION", "")


def fail(why):
	print(f"render-check: {why}", file=sys.stderr)
	sys.exit(1)


def main():
	if EXPECTED and bpy.app.version_string != EXPECTED:
		fail(f"Blender is {bpy.app.version_string}, not {EXPECTED}")
	bpy.ops.wm.read_factory_settings(use_empty=True)
	scene = bpy.context.scene
	scene.render.engine = "CYCLES"
	scene.cycles.device = "CPU"
	scene.cycles.samples = 16
	scene.cycles.use_adaptive_sampling = False
	scene.cycles.use_denoising = True
	try:
		scene.cycles.denoiser = "OPENIMAGEDENOISE"
	except TypeError:
		fail("this Blender has no OpenImageDenoise")
	scene.render.resolution_x, scene.render.resolution_y = 320, 180
	scene.render.image_settings.file_format = "PNG"
	scene.render.filepath = out

	world = bpy.data.worlds.new("world")
	world.use_nodes = True
	scene.world = world
	environment = world.node_tree.nodes.new("ShaderNodeTexEnvironment")
	environment.image = bpy.data.images.load(os.path.join(assets, "hdris", "photo_studio_loft_hall_2k.exr"))
	world.node_tree.links.new(environment.outputs["Color"], world.node_tree.nodes["Background"].inputs["Color"])

	floor = bpy.data.materials.new("floor")
	floor.use_nodes = True
	bsdf = floor.node_tree.nodes["Principled BSDF"]
	folder = os.path.join(assets, "textures", "laminate_floor_02", "textures")
	for kind, space, socket in (("diff", "sRGB", "Base Color"), ("rough", "Non-Color", "Roughness")):
		picture = floor.node_tree.nodes.new("ShaderNodeTexImage")
		picture.image = bpy.data.images.load(os.path.join(folder, f"laminate_floor_02_{kind}_2k.jpg"))
		picture.image.colorspace_settings.name = space
		floor.node_tree.links.new(picture.outputs["Color"], bsdf.inputs[socket])
	bpy.ops.mesh.primitive_plane_add(size=6)
	bpy.context.object.data.materials.append(floor)

	bpy.ops.import_scene.gltf(filepath=os.path.join(assets, "models", "wooden_table_02", "wooden_table_02_2k.gltf"))
	table = [obj for obj in bpy.data.objects if obj.type == "MESH" and obj.name != "Plane"]
	if not table:
		fail("the table of the starter set brought no mesh")
	height = max((obj.matrix_world @ Vector(corner)).z for obj in table for corner in obj.bound_box)
	if not 0.6 < height < 1.0:
		fail(f"the table of the starter set is {height:.2f} m high: the set is not in metres")

	camera = bpy.data.objects.new("camera", bpy.data.cameras.new("camera"))
	camera.location = (1.6, -2.4, 1.3)
	camera.rotation_euler = (Vector((0, 0, 0.6)) - camera.location).to_track_quat("-Z", "Y").to_euler()
	scene.collection.objects.link(camera)
	scene.camera = camera
	bpy.ops.render.render(write_still=True)

	frame = bpy.data.images.load(out)
	pixels = list(frame.pixels)
	light = [0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2] for i in range(0, len(pixels), 4)]
	mean = sum(light) / len(light)
	spread = (sum((value - mean) ** 2 for value in light) / len(light)) ** 0.5
	if not 0.08 < mean < 0.9 or spread < 0.03:
		fail(f"the frame is black or flat (mean {mean:.3f}, spread {spread:.3f}): the world lights nothing")
	print(f"render-check: Blender {bpy.app.version_string}, Cycles with OpenImageDenoise, the starter set loads (mean {mean:.3f})")


try:
	main()
except SystemExit:
	raise
except Exception as error:
	fail(f"{type(error).__name__}: {str(error).strip()[:300]}")
