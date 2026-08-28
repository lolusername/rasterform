#!/usr/bin/env python3
"""Rasterform's isolated Blender Cycles still-image renderer.

Run only through Blender, for example:

    Blender --background --factory-startup --python render.py -- manifest.json

The manifest and every referenced file live inside one private job directory.
Status is emitted as newline-delimited JSON prefixed with ``RASTERFORM_*`` so
Electron never needs to interpret Blender's human-readable console output.
"""

from __future__ import annotations

import array
import json
import math
import os
from pathlib import Path
import re
import sys
import time
import traceback
from typing import Any, NoReturn

import bpy
from mathutils import Quaternion


MANIFEST_VERSION = 1
MAX_IMAGE_EDGE = 4096
MAX_VERTICES = 2_000_000
MAX_INDICES = 12_000_000
MAX_MESH_BYTES = 256 * 1024 * 1024
STATUS_PREFIX = "RASTERFORM_"
SAMPLE_PATTERN = re.compile(r"\bSample\s+(\d+)\s*/\s*(\d+)(?:\s+samples?)?", re.I)

ROOT_KEYS = {
    "version",
    "jobId",
    "mesh",
    "camera",
    "colorMode",
    "appearance",
    "width",
    "height",
    "background",
    "studioBackground",
    "settings",
    "environment",
    "outputs",
}
MESH_KEYS = {
    "positions",
    "indices",
    "colors",
    "heights",
    "vertexCount",
    "indexCount",
    "mode",
}
CAMERA_KEYS = {
    "fov",
    "near",
    "far",
    "zoom",
    "filmGauge",
    "filmOffset",
    "position",
    "quaternion",
    "up",
}
SETTINGS_KEYS = {
    "maxSamples",
    "minSamples",
    "noiseThreshold",
    "maxBounces",
    "denoise",
}


class ManifestError(ValueError):
    """Raised when the native boundary supplied an invalid render job."""


def emit(kind: str, payload: dict[str, Any]) -> None:
    print(
        f"{STATUS_PREFIX}{kind} {json.dumps(payload, separators=(',', ':'), sort_keys=True)}",
        flush=True,
    )


def fail(message: str) -> NoReturn:
    raise ManifestError(message)


def expect_object(value: Any, name: str, keys: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        fail(f"{name} must contain exactly: {', '.join(sorted(keys))}.")
    return value


def expect_string(value: Any, name: str, allowed: set[str] | None = None) -> str:
    if not isinstance(value, str) or not value:
        fail(f"{name} must be a non-empty string.")
    if allowed is not None and value not in allowed:
        fail(f"{name} is unsupported.")
    return value


def expect_integer(value: Any, name: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        fail(f"{name} must be an integer from {minimum} through {maximum}.")
    return value


def expect_number(value: Any, name: str, minimum: float, maximum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        fail(f"{name} must be a finite number.")
    result = float(value)
    if not math.isfinite(result) or not minimum <= result <= maximum:
        fail(f"{name} must be between {minimum} and {maximum}.")
    return result


def expect_vector(
    value: Any,
    name: str,
    length: int,
    *,
    nonzero: bool = False,
) -> tuple[float, ...]:
    if not isinstance(value, list) or len(value) != length:
        fail(f"{name} must have {length} components.")
    result = tuple(expect_number(component, f"{name}[{index}]", -1e9, 1e9)
                   for index, component in enumerate(value))
    if nonzero and math.sqrt(sum(component * component for component in result)) <= sys.float_info.epsilon:
        fail(f"{name} must not have zero length.")
    return result


def expect_hex(value: Any, name: str) -> str:
    text = expect_string(value, name)
    if re.fullmatch(r"#[0-9A-Fa-f]{6}", text) is None:
        fail(f"{name} must be a six-digit hex color.")
    return text


def resolve_inside(root: Path, relative: Any, name: str, *, must_exist: bool) -> Path:
    text = expect_string(relative, name)
    candidate_text = Path(text)
    if candidate_text.is_absolute() or "\x00" in text:
        fail(f"{name} must be a relative path inside the render job.")
    try:
        candidate = (root / candidate_text).resolve(strict=must_exist)
    except (OSError, RuntimeError) as error:
        raise ManifestError(f"{name} could not be resolved: {error}") from error
    try:
        candidate.relative_to(root)
    except ValueError as error:
        raise ManifestError(f"{name} escapes the render job directory.") from error
    if must_exist and not candidate.is_file():
        fail(f"{name} is not a regular file.")
    if not must_exist:
        parent = candidate.parent.resolve(strict=True)
        try:
            parent.relative_to(root)
        except ValueError as error:
            raise ManifestError(f"{name} escapes the render job directory.") from error
        if not parent.is_dir():
            fail(f"{name} does not have a valid parent directory.")
    return candidate


def parse_manifest(path: Path) -> dict[str, Any]:
    root = path.parent.resolve(strict=True)
    resolved_manifest = path.resolve(strict=True)
    try:
        resolved_manifest.relative_to(root)
    except ValueError as error:
        raise ManifestError("The manifest path is outside its job directory.") from error
    if resolved_manifest.stat().st_size > 128 * 1024:
        fail("The render manifest is unexpectedly large.")
    try:
        manifest = json.loads(resolved_manifest.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ManifestError(f"The render manifest could not be read: {error}") from error
    manifest = expect_object(manifest, "manifest", ROOT_KEYS)

    if manifest["version"] != MANIFEST_VERSION:
        fail("The render manifest version is unsupported.")
    job_id = expect_string(manifest["jobId"], "jobId")
    if len(job_id) > 128 or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", job_id) is None:
        fail("jobId is invalid.")
    manifest["width"] = expect_integer(manifest["width"], "width", 1, MAX_IMAGE_EDGE)
    manifest["height"] = expect_integer(manifest["height"], "height", 1, MAX_IMAGE_EDGE)
    manifest["background"] = expect_string(
        manifest["background"], "background", {"transparent", "studio"}
    )
    manifest["studioBackground"] = expect_string(
        manifest["studioBackground"], "studioBackground", {"white", "dark-gray", "black"}
    )
    manifest["colorMode"] = expect_string(
        manifest["colorMode"], "colorMode", {"original", "height", "clay"}
    )

    mesh = expect_object(manifest["mesh"], "mesh", MESH_KEYS)
    vertex_count = expect_integer(mesh["vertexCount"], "mesh.vertexCount", 3, MAX_VERTICES)
    index_count = expect_integer(mesh["indexCount"], "mesh.indexCount", 3, MAX_INDICES)
    if index_count % 3 != 0:
        fail("mesh.indexCount must describe complete triangles.")
    mesh["mode"] = expect_string(mesh["mode"], "mesh.mode", {"plane", "centered", "solid"})
    mesh["vertexCount"] = vertex_count
    mesh["indexCount"] = index_count

    paths = {
        "positions": resolve_inside(root, mesh["positions"], "mesh.positions", must_exist=True),
        "indices": resolve_inside(root, mesh["indices"], "mesh.indices", must_exist=True),
        "colors": resolve_inside(root, mesh["colors"], "mesh.colors", must_exist=True),
        "heights": resolve_inside(root, mesh["heights"], "mesh.heights", must_exist=True),
    }
    expected_sizes = {
        "positions": vertex_count * 3 * 4,
        "indices": index_count * 4,
        "colors": vertex_count * 3 * 4,
        "heights": vertex_count * 4,
    }
    total_bytes = sum(expected_sizes.values())
    if total_bytes > MAX_MESH_BYTES:
        fail("The mesh exceeds Rasterform's native memory boundary.")
    for key, binary_path in paths.items():
        if binary_path.stat().st_size != expected_sizes[key]:
            fail(f"mesh.{key} has the wrong byte length.")
    mesh["resolvedPaths"] = paths

    camera = expect_object(manifest["camera"], "camera", CAMERA_KEYS)
    camera["fov"] = expect_number(camera["fov"], "camera.fov", 0.001, 179.999)
    camera["near"] = expect_number(camera["near"], "camera.near", 1e-9, 1e9)
    camera["far"] = expect_number(camera["far"], "camera.far", camera["near"] + 1e-9, 1e12)
    camera["zoom"] = expect_number(camera["zoom"], "camera.zoom", 1e-9, 1e9)
    camera["filmGauge"] = expect_number(camera["filmGauge"], "camera.filmGauge", 1e-9, 1e9)
    camera["filmOffset"] = expect_number(camera["filmOffset"], "camera.filmOffset", -1e9, 1e9)
    camera["position"] = expect_vector(camera["position"], "camera.position", 3)
    camera["quaternion"] = expect_vector(
        camera["quaternion"], "camera.quaternion", 4, nonzero=True
    )
    camera["up"] = expect_vector(camera["up"], "camera.up", 3, nonzero=True)

    appearance = expect_object(manifest["appearance"], "appearance", {"heightGradient", "clay"})
    gradient = expect_object(
        appearance["heightGradient"],
        "appearance.heightGradient",
        {"low", "mid", "high", "midpoint"},
    )
    for key in ("low", "mid", "high"):
        gradient[key] = expect_hex(gradient[key], f"appearance.heightGradient.{key}")
    gradient["midpoint"] = expect_number(
        gradient["midpoint"], "appearance.heightGradient.midpoint", 0.0, 1.0
    )
    clay = expect_object(appearance["clay"], "appearance.clay", {"color", "finish"})
    clay["color"] = expect_hex(clay["color"], "appearance.clay.color")
    clay["finish"] = expect_string(
        clay["finish"], "appearance.clay.finish", {"matte", "glossy", "metallic"}
    )

    settings = expect_object(manifest["settings"], "settings", SETTINGS_KEYS)
    settings["maxSamples"] = expect_integer(settings["maxSamples"], "settings.maxSamples", 64, 8192)
    settings["minSamples"] = expect_integer(
        settings["minSamples"], "settings.minSamples", 64, settings["maxSamples"]
    )
    settings["noiseThreshold"] = expect_number(
        settings["noiseThreshold"], "settings.noiseThreshold", 0.001, 0.05
    )
    settings["maxBounces"] = expect_integer(settings["maxBounces"], "settings.maxBounces", 2, 16)
    if not isinstance(settings["denoise"], bool):
        fail("settings.denoise must be a boolean.")

    manifest["resolvedEnvironment"] = resolve_inside(
        root, manifest["environment"], "environment", must_exist=True
    )
    outputs = expect_object(manifest["outputs"], "outputs", {"png", "exr"})
    manifest["resolvedOutputs"] = {
        "png": resolve_inside(root, outputs["png"], "outputs.png", must_exist=False),
        "exr": resolve_inside(root, outputs["exr"], "outputs.exr", must_exist=False),
    }
    if manifest["resolvedOutputs"]["png"].suffix.lower() != ".png":
        fail("outputs.png must use the .png extension.")
    if manifest["resolvedOutputs"]["exr"].suffix.lower() != ".exr":
        fail("outputs.exr must use the .exr extension.")
    if manifest["resolvedOutputs"]["png"] == manifest["resolvedOutputs"]["exr"]:
        fail("PNG and EXR outputs must be different files.")
    return manifest


def load_array(path: Path, typecode: str, expected_items: int) -> array.array:
    values = array.array(typecode)
    with path.open("rb") as binary:
        values.fromfile(binary, expected_items)
        if binary.read(1):
            fail(f"{path.name} contains trailing bytes.")
    if values.itemsize != 4 or len(values) != expected_items:
        fail(f"{path.name} could not be decoded as 32-bit values.")
    if sys.byteorder != "little":
        values.byteswap()
    return values


def validate_floats(values: array.array, name: str, *, unit_interval: bool = False) -> None:
    for value in values:
        if not math.isfinite(value):
            fail(f"{name} contains a non-finite value.")
        if unit_interval and not 0.0 <= value <= 1.0:
            fail(f"{name} contains a value outside zero through one.")


def srgb_channel_to_linear(value: float) -> float:
    return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4


def hex_to_linear(value: str) -> tuple[float, float, float, float]:
    components = tuple(int(value[offset:offset + 2], 16) / 255.0 for offset in (1, 3, 5))
    return tuple(srgb_channel_to_linear(component) for component in components) + (1.0,)


def gradient_colors(heights: array.array, appearance: dict[str, Any]) -> array.array:
    gradient = appearance["heightGradient"]
    low = hex_to_linear(gradient["low"])
    middle = hex_to_linear(gradient["mid"])
    high = hex_to_linear(gradient["high"])
    midpoint = min(0.95, max(0.05, gradient["midpoint"]))
    colors = array.array("f")
    for height in heights:
        if height <= midpoint:
            start, end, amount = low, middle, height / midpoint
        else:
            start, end, amount = middle, high, (height - midpoint) / (1.0 - midpoint)
        colors.extend(start[channel] + (end[channel] - start[channel]) * amount for channel in range(3))
    return colors


def create_mesh(manifest: dict[str, Any]) -> bpy.types.Object:
    mesh_spec = manifest["mesh"]
    paths = mesh_spec["resolvedPaths"]
    vertex_count = mesh_spec["vertexCount"]
    index_count = mesh_spec["indexCount"]
    positions = load_array(paths["positions"], "f", vertex_count * 3)
    indices = load_array(paths["indices"], "I", index_count)
    source_colors = load_array(paths["colors"], "f", vertex_count * 3)
    heights = load_array(paths["heights"], "f", vertex_count)
    validate_floats(positions, "mesh.positions")
    validate_floats(source_colors, "mesh.colors", unit_interval=True)
    validate_floats(heights, "mesh.heights", unit_interval=True)
    if any(index >= vertex_count for index in indices):
        fail("mesh.indices contains an out-of-range vertex index.")

    # Three.js is Y-up and Blender is Z-up. This +90 degree X rotation has a
    # positive determinant, preserving triangle winding: (x, y, z) -> (x, -z, y).
    for offset in range(0, len(positions), 3):
        y = positions[offset + 1]
        z = positions[offset + 2]
        positions[offset + 1] = -z
        positions[offset + 2] = y

    mesh = bpy.data.meshes.new("Rasterform_Mesh")
    mesh.vertices.add(vertex_count)
    mesh.vertices.foreach_set("co", positions)
    mesh.loops.add(index_count)
    mesh.loops.foreach_set("vertex_index", indices)
    face_count = index_count // 3
    mesh.polygons.add(face_count)
    mesh.polygons.foreach_set("loop_start", array.array("i", range(0, index_count, 3)))
    mesh.polygons.foreach_set("loop_total", array.array("i", [3]) * face_count)
    mesh.polygons.foreach_set("use_smooth", array.array("b", [True]) * face_count)
    mesh.validate(clean_customdata=False)
    mesh.update(calc_edges=True)

    if manifest["colorMode"] == "height":
        source_colors = gradient_colors(heights, manifest["appearance"])
    rgba = array.array("f")
    for offset in range(0, len(source_colors), 3):
        rgba.extend((source_colors[offset], source_colors[offset + 1], source_colors[offset + 2], 1.0))
    color_attribute = mesh.color_attributes.new(
        name="RasterformColor", type="FLOAT_COLOR", domain="POINT"
    )
    color_attribute.data.foreach_set("color", rgba)

    object_ = bpy.data.objects.new("Rasterform_Model", mesh)
    bpy.context.collection.objects.link(object_)
    object_.visible_shadow = True
    object_.visible_camera = True
    return object_


def create_material(manifest: dict[str, Any]) -> bpy.types.Material:
    material = bpy.data.materials.new("Rasterform_Material")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    shader = nodes.new("ShaderNodeBsdfPrincipled")
    links.new(shader.outputs["BSDF"], output.inputs["Surface"])

    mode = manifest["colorMode"]
    clay = manifest["appearance"]["clay"]
    if mode == "clay":
        shader.inputs["Base Color"].default_value = hex_to_linear(clay["color"])
        roughness, metallic = {
            "matte": (0.88, 0.0),
            "glossy": (0.16, 0.02),
            "metallic": (0.26, 1.0),
        }[clay["finish"]]
    else:
        attribute = nodes.new("ShaderNodeAttribute")
        attribute.attribute_name = "RasterformColor"
        links.new(attribute.outputs["Color"], shader.inputs["Base Color"])
        roughness, metallic = 0.66, 0.04
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Metallic"].default_value = metallic
    shader.inputs["IOR"].default_value = 1.45
    return material


def create_camera(manifest: dict[str, Any]) -> bpy.types.Object:
    source = manifest["camera"]
    camera_data = bpy.data.cameras.new("Rasterform_Camera")
    camera_data.type = "PERSP"
    camera_data.sensor_fit = "VERTICAL"
    camera_data.sensor_height = 36.0
    effective_fov = 2.0 * math.atan(math.tan(math.radians(source["fov"]) / 2.0) / source["zoom"])
    camera_data.lens = camera_data.sensor_height / (2.0 * math.tan(effective_fov / 2.0))
    camera_data.clip_start = source["near"]
    camera_data.clip_end = source["far"]
    aspect = manifest["width"] / manifest["height"]
    film_width = source["filmGauge"] * min(aspect, 1.0)
    camera_data.shift_x = (
        source["filmOffset"]
        * source["zoom"]
        / (film_width * 2.0 * math.tan(math.radians(source["fov"]) / 2.0))
    )

    camera = bpy.data.objects.new("Rasterform_Camera", camera_data)
    bpy.context.collection.objects.link(camera)
    x, y, z = source["position"]
    camera.location = (x, -z, y)
    qx, qy, qz, qw = source["quaternion"]
    source_rotation = Quaternion((qw, qx, qy, qz)).normalized()
    y_up_to_z_up = Quaternion((1.0, 0.0, 0.0), math.pi / 2.0)
    camera.rotation_mode = "QUATERNION"
    camera.rotation_quaternion = y_up_to_z_up @ source_rotation
    return camera


def point_light_at(light: bpy.types.Object, target: tuple[float, float, float]) -> None:
    light.rotation_euler = (light.location - type(light.location)(target)).to_track_quat("-Z", "Y").to_euler()


def add_area_light(
    name: str,
    color: tuple[float, float, float, float],
    energy: float,
    size: float,
    location: tuple[float, float, float],
    target: tuple[float, float, float],
    size_y: float | None = None,
) -> bpy.types.Object:
    data = bpy.data.lights.new(name, "AREA")
    data.color = color[:3]
    data.energy = energy
    data.shape = "RECTANGLE" if size_y is not None else "DISK"
    data.size = size
    if size_y is not None:
        data.size_y = size_y
    object_ = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(object_)
    object_.location = location
    point_light_at(object_, target)
    return object_


def create_studio_lights() -> None:
    # Locations are the same Y-up rig used by the live renderer, rotated into
    # Blender's Z-up world. Large emitters provide soft, controlled gradients.
    add_area_light(
        "Rasterform_Key",
        hex_to_linear("#fff7ed"),
        850.0,
        3.2,
        (-3.2, -5.8, 3.8),
        (0.0, -0.12, 0.0),
    )
    add_area_light(
        "Rasterform_Fill",
        hex_to_linear("#c9ddff"),
        520.0,
        4.5,
        (3.6, -3.8, 0.8),
        (0.0, -0.1, 0.0),
        4.5,
    )
    add_area_light(
        "Rasterform_Rim",
        hex_to_linear("#ffc8a8"),
        720.0,
        3.0,
        (-1.4, 3.2, 2.6),
        (0.0, -0.15, 0.0),
        4.0,
    )


def create_world(manifest: dict[str, Any]) -> None:
    world = bpy.data.worlds.new("Rasterform_StudioWorld")
    bpy.context.scene.world = world
    world.use_nodes = True
    nodes = world.node_tree.nodes
    links = world.node_tree.links
    nodes.clear()

    output = nodes.new("ShaderNodeOutputWorld")
    environment_texture = nodes.new("ShaderNodeTexEnvironment")
    environment_texture.image = bpy.data.images.load(
        str(manifest["resolvedEnvironment"]), check_existing=False
    )
    environment_background = nodes.new("ShaderNodeBackground")
    environment_background.inputs["Strength"].default_value = 0.45
    links.new(environment_texture.outputs["Color"], environment_background.inputs["Color"])

    background_colors = {
        "white": "#ffffff",
        "dark-gray": "#343434",
        "black": "#000000",
    }
    solid_background = nodes.new("ShaderNodeBackground")
    solid_background.inputs["Color"].default_value = hex_to_linear(
        background_colors[manifest["studioBackground"]]
    )
    solid_background.inputs["Strength"].default_value = 1.0
    light_path = nodes.new("ShaderNodeLightPath")
    mix = nodes.new("ShaderNodeMixShader")
    links.new(light_path.outputs["Is Camera Ray"], mix.inputs[0])
    links.new(environment_background.outputs["Background"], mix.inputs[1])
    links.new(solid_background.outputs["Background"], mix.inputs[2])
    links.new(mix.outputs["Shader"], output.inputs["Surface"])


def configure_cycles(manifest: dict[str, Any]) -> tuple[str, str]:
    scene = bpy.context.scene
    settings = manifest["settings"]
    scene.render.engine = "CYCLES"
    preferences = bpy.context.preferences.addons["cycles"].preferences
    device_kind = "CPU"
    device_name = "CPU"
    try:
        preferences.compute_device_type = "METAL"
        preferences.refresh_devices()
        metal_devices = [device for device in preferences.devices if device.type == "METAL"]
        for device in preferences.devices:
            device.use = device in metal_devices
        if metal_devices:
            scene.cycles.device = "GPU"
            device_kind = "METAL"
            device_name = ", ".join(device.name for device in metal_devices)
        else:
            scene.cycles.device = "CPU"
    except Exception:
        scene.cycles.device = "CPU"

    scene.cycles.samples = settings["maxSamples"]
    scene.cycles.use_adaptive_sampling = True
    scene.cycles.adaptive_min_samples = settings["minSamples"]
    scene.cycles.adaptive_threshold = settings["noiseThreshold"]
    scene.cycles.max_bounces = settings["maxBounces"]
    scene.cycles.diffuse_bounces = settings["maxBounces"]
    scene.cycles.glossy_bounces = settings["maxBounces"]
    scene.cycles.transmission_bounces = settings["maxBounces"]
    scene.cycles.transparent_max_bounces = settings["maxBounces"]
    scene.cycles.volume_bounces = min(4, settings["maxBounces"])
    scene.cycles.use_denoising = settings["denoise"]
    scene.cycles.denoiser = "OPENIMAGEDENOISE"
    scene.cycles.denoising_quality = "HIGH"
    scene.cycles.denoising_input_passes = "RGB_ALBEDO_NORMAL"
    scene.cycles.denoising_prefilter = "ACCURATE"
    scene.cycles.denoising_use_gpu = False
    scene.cycles.seed = 0
    scene.cycles.use_animated_seed = False

    view_layer = bpy.context.view_layer
    view_layer.cycles.use_denoising = settings["denoise"]
    view_layer.cycles.denoising_store_passes = settings["denoise"]
    view_layer.use_pass_normal = True
    view_layer.use_pass_diffuse_color = True
    return device_kind, device_name


def configure_scene(manifest: dict[str, Any]) -> None:
    scene = bpy.context.scene
    scene.render.resolution_x = manifest["width"]
    scene.render.resolution_y = manifest["height"]
    scene.render.resolution_percentage = 100
    scene.render.pixel_aspect_x = 1.0
    scene.render.pixel_aspect_y = 1.0
    scene.render.film_transparent = manifest["background"] == "transparent"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.use_file_extension = False
    scene.render.use_compositing = True
    scene.render.use_sequencer = False
    scene.render.dither_intensity = 1.0
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = math.log2(1.15)
    scene.view_settings.gamma = 1.0
    scene.camera = create_camera(manifest)

    object_ = create_mesh(manifest)
    object_.data.materials.append(create_material(manifest))
    create_studio_lights()
    create_world(manifest)


class ProgressReporter:
    def __init__(self, target_samples: int) -> None:
        self.target_samples = target_samples
        self.last_samples = -1

    def stats(self, *arguments: Any) -> None:
        # Blender 5.2 passes the statistics string first and a nullable legacy
        # argument second. Older releases used a different handler signature,
        # so select the string defensively instead of depending on argument
        # positions. A missing string is a harmless skipped progress update.
        statistics = next((value for value in arguments if isinstance(value, str)), None)
        if statistics is None:
            return
        if os.environ.get("RASTERFORM_DEBUG_STATS") == "1":
            print(f"BLENDER_STATS {statistics}", flush=True)
        match = SAMPLE_PATTERN.search(statistics)
        if match is None:
            return
        samples = min(self.target_samples, max(0, int(match.group(1))))
        if samples <= self.last_samples:
            return
        self.last_samples = samples
        emit("PROGRESS", {
            "phase": "rendering",
            "progress": samples / self.target_samples,
            "tile": 0,
            "tiles": 1,
            "samples": samples,
            "targetSamples": self.target_samples,
        })


def save_outputs(manifest: dict[str, Any]) -> None:
    scene = bpy.context.scene
    result = bpy.data.images.get("Render Result")
    if result is None:
        raise RuntimeError("Cycles did not create a Render Result.")
    outputs = manifest["resolvedOutputs"]
    nonce = f".partial-{os.getpid()}"
    temporary_exr = outputs["exr"].with_name(outputs["exr"].name + nonce + ".exr")
    temporary_png = outputs["png"].with_name(outputs["png"].name + nonce + ".png")
    try:
        # In Blender 5.2 the available format enum depends on media_type. Set
        # that first so save_render retains the enabled view-layer passes.
        scene.render.image_settings.media_type = "MULTI_LAYER_IMAGE"
        scene.render.image_settings.file_format = "OPEN_EXR_MULTILAYER"
        scene.render.image_settings.color_mode = "RGBA"
        scene.render.image_settings.color_depth = "16"
        scene.render.image_settings.exr_codec = "PIZ"
        result.save_render(filepath=str(temporary_exr), scene=scene)

        scene.render.image_settings.media_type = "IMAGE"
        scene.render.image_settings.file_format = "PNG"
        scene.render.image_settings.color_mode = "RGBA"
        scene.render.image_settings.color_depth = "8"
        scene.render.image_settings.compression = 35
        result.save_render(filepath=str(temporary_png), scene=scene)
        os.replace(temporary_exr, outputs["exr"])
        os.replace(temporary_png, outputs["png"])
    finally:
        for temporary in (temporary_exr, temporary_png):
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass


def render(manifest_path: Path) -> None:
    started = time.monotonic()
    emit("VERSION", {
        "version": bpy.app.version_string,
        "versionTuple": list(bpy.app.version),
    })
    manifest = parse_manifest(manifest_path)
    target_samples = manifest["settings"]["maxSamples"]
    emit("PROGRESS", {
        "phase": "preparing",
        "progress": 0.05,
        "tile": 0,
        "tiles": 1,
        "samples": 0,
        "targetSamples": target_samples,
    })
    emit("PROGRESS", {
        "phase": "preparing",
        "progress": 0.35,
        "tile": 0,
        "tiles": 1,
        "samples": 0,
        "targetSamples": target_samples,
    })

    bpy.ops.wm.read_factory_settings(use_empty=True)
    device_kind, device_name = configure_cycles(manifest)
    emit("DEVICE", {"device": device_kind, "name": device_name})
    configure_scene(manifest)
    emit("PROGRESS", {
        "phase": "preparing",
        "progress": 1.0,
        "tile": 0,
        "tiles": 1,
        "samples": 0,
        "targetSamples": target_samples,
    })

    reporter = ProgressReporter(target_samples)
    bpy.app.handlers.render_stats.append(reporter.stats)
    try:
        bpy.ops.render.render()
    finally:
        try:
            bpy.app.handlers.render_stats.remove(reporter.stats)
        except ValueError:
            pass

    emit("PROGRESS", {
        "phase": "finishing",
        "progress": 1.0,
        "tile": 1,
        "tiles": 1,
        "samples": target_samples,
        "targetSamples": target_samples,
    })
    save_outputs(manifest)
    elapsed = time.monotonic() - started
    emit("COMPLETE", {
        "device": device_kind,
        "elapsedSeconds": round(elapsed, 3),
        "exr": manifest["outputs"]["exr"],
        "height": manifest["height"],
        "jobId": manifest["jobId"],
        "maxSamples": target_samples,
        "noiseThreshold": manifest["settings"]["noiseThreshold"],
        "png": manifest["outputs"]["png"],
        "width": manifest["width"],
    })


def manifest_argument(argv: list[str]) -> Path:
    if "--" not in argv:
        fail("Expected a manifest path after --.")
    arguments = argv[argv.index("--") + 1:]
    if len(arguments) != 1:
        fail("Expected exactly one manifest path after --.")
    return Path(arguments[0])


def main() -> int:
    try:
        render(manifest_argument(sys.argv))
        return 0
    except Exception as error:
        emit("ERROR", {
            "message": str(error) or error.__class__.__name__,
            "type": error.__class__.__name__,
        })
        traceback.print_exc(file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
