#!/usr/bin/env python3
"""Rasterform's isolated Blender project exporter.

Run only through a newly spawned Blender process, for example::

    Blender --background --factory-startup --disable-autoexec \
        --python-exit-code 1 --python export_blend.py -- manifest.json

The manifest, binary mesh inputs, and output all live in one private job
directory.  This script never discovers, opens, saves, or modifies a user's
Blender project.  Machine-readable status is emitted as prefixed JSON so the
Electron main process does not need to interpret Blender's console output.
"""

from __future__ import annotations

import array
import hashlib
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


MANIFEST_VERSION = 1
MAX_VERTICES = 2_000_000
MAX_INDICES = 12_000_000
MAX_MESH_BYTES = 256 * 1024 * 1024
MAX_MANIFEST_BYTES = 128 * 1024
STATUS_PREFIX = "RASTERFORM_"
COLOR_ATTRIBUTE_NAME = "RasterformColor"
UV_LAYER_NAME = "UVMap"
ZSTD_MAGIC = b"\x28\xb5\x2f\xfd"

ROOT_KEYS = {
    "version",
    "jobId",
    "mesh",
    "colorMode",
    "appearance",
    "settings",
    "output",
}
MESH_KEYS = {
    "positions",
    "indices",
    "colors",
    "uvs",
    "vertexCount",
    "indexCount",
    "uvCount",
    "width",
    "height",
    "mode",
}


class ManifestError(ValueError):
    """Raised when the native boundary supplied an invalid export job."""


def emit(kind: str, payload: dict[str, Any]) -> None:
    print(
        f"{STATUS_PREFIX}{kind} "
        f"{json.dumps(payload, separators=(',', ':'), sort_keys=True)}",
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


def expect_hex(value: Any, name: str) -> str:
    text = expect_string(value, name)
    if re.fullmatch(r"#[0-9A-Fa-f]{6}", text) is None:
        fail(f"{name} must be a six-digit hex color.")
    return text


def resolve_inside(root: Path, relative: Any, name: str, *, must_exist: bool) -> Path:
    text = expect_string(relative, name)
    relative_path = Path(text)
    if relative_path.is_absolute() or "\x00" in text:
        fail(f"{name} must be a relative path inside the export job.")
    try:
        candidate = (root / relative_path).resolve(strict=must_exist)
    except (OSError, RuntimeError) as error:
        raise ManifestError(f"{name} could not be resolved: {error}") from error
    try:
        candidate.relative_to(root)
    except ValueError as error:
        raise ManifestError(f"{name} escapes the export job directory.") from error
    if must_exist:
        if not candidate.is_file():
            fail(f"{name} is not a regular file.")
    else:
        try:
            parent = candidate.parent.resolve(strict=True)
        except (OSError, RuntimeError) as error:
            raise ManifestError(f"{name} does not have a valid parent: {error}") from error
        try:
            parent.relative_to(root)
        except ValueError as error:
            raise ManifestError(f"{name} escapes the export job directory.") from error
        if not parent.is_dir():
            fail(f"{name} does not have a valid parent directory.")
    return candidate


def parse_manifest(path: Path) -> dict[str, Any]:
    try:
        root = path.parent.resolve(strict=True)
        resolved_manifest = path.resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise ManifestError(f"The export manifest could not be resolved: {error}") from error
    try:
        resolved_manifest.relative_to(root)
    except ValueError as error:
        raise ManifestError("The manifest path is outside its job directory.") from error
    if not resolved_manifest.is_file():
        fail("The export manifest is not a regular file.")
    if resolved_manifest.stat().st_size > MAX_MANIFEST_BYTES:
        fail("The export manifest is unexpectedly large.")
    try:
        manifest = json.loads(resolved_manifest.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ManifestError(f"The export manifest could not be read: {error}") from error
    manifest = expect_object(manifest, "manifest", ROOT_KEYS)

    version = expect_integer(manifest["version"], "version", 1, MANIFEST_VERSION)
    if version != MANIFEST_VERSION:
        fail("The export manifest version is unsupported.")
    job_id = expect_string(manifest["jobId"], "jobId")
    if len(job_id) > 128 or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", job_id) is None:
        fail("jobId is invalid.")
    manifest["colorMode"] = expect_string(
        manifest["colorMode"], "colorMode", {"original", "height", "clay"}
    )

    mesh = expect_object(manifest["mesh"], "mesh", MESH_KEYS)
    vertex_count = expect_integer(mesh["vertexCount"], "mesh.vertexCount", 3, MAX_VERTICES)
    index_count = expect_integer(mesh["indexCount"], "mesh.indexCount", 3, MAX_INDICES)
    uv_count = expect_integer(mesh["uvCount"], "mesh.uvCount", 3, MAX_VERTICES)
    width = expect_integer(mesh["width"], "mesh.width", 1, 16_384)
    height = expect_integer(mesh["height"], "mesh.height", 1, 16_384)
    if index_count % 3 != 0:
        fail("mesh.indexCount must describe complete triangles.")
    if uv_count != vertex_count:
        fail("mesh.uvCount must equal mesh.vertexCount for Rasterform's vertex UVs.")
    mesh["mode"] = expect_string(mesh["mode"], "mesh.mode", {"plane", "centered", "solid"})
    mesh["vertexCount"] = vertex_count
    mesh["indexCount"] = index_count
    mesh["uvCount"] = uv_count
    mesh["width"] = width
    mesh["height"] = height

    paths = {
        "positions": resolve_inside(root, mesh["positions"], "mesh.positions", must_exist=True),
        "indices": resolve_inside(root, mesh["indices"], "mesh.indices", must_exist=True),
        "colors": resolve_inside(root, mesh["colors"], "mesh.colors", must_exist=True),
        "uvs": resolve_inside(root, mesh["uvs"], "mesh.uvs", must_exist=True),
    }
    expected_sizes = {
        "positions": vertex_count * 3 * 4,
        "indices": index_count * 4,
        "colors": vertex_count * 3 * 4,
        "uvs": uv_count * 2 * 4,
    }
    if sum(expected_sizes.values()) > MAX_MESH_BYTES:
        fail("The mesh exceeds Rasterform's native memory boundary.")
    for key, binary_path in paths.items():
        if binary_path.stat().st_size != expected_sizes[key]:
            fail(f"mesh.{key} has the wrong byte length.")
    mesh["resolvedPaths"] = paths

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

    settings = expect_object(manifest["settings"], "settings", {"topology"})
    settings["topology"] = expect_string(
        settings["topology"], "settings.topology", {"exact", "balanced", "lightweight"}
    )

    output = resolve_inside(root, manifest["output"], "output", must_exist=False)
    if output.suffix.lower() != ".blend":
        fail("output must use the .blend extension.")
    if output == resolved_manifest or output in paths.values():
        fail("output must be separate from the manifest and mesh inputs.")
    manifest["root"] = root
    manifest["resolvedOutput"] = output
    return manifest


def load_array(path: Path, typecode: str, expected_items: int) -> array.array:
    values = array.array(typecode)
    try:
        with path.open("rb") as binary:
            values.fromfile(binary, expected_items)
            if binary.read(1):
                fail(f"{path.name} contains trailing bytes.")
    except (EOFError, OSError) as error:
        raise ManifestError(f"{path.name} could not be read: {error}") from error
    if values.itemsize != 4 or len(values) != expected_items:
        fail(f"{path.name} could not be decoded as 32-bit values.")
    if sys.byteorder != "little":
        values.byteswap()
    return values


def validate_floats(
    values: array.array,
    name: str,
    *,
    minimum: float = -1e9,
    maximum: float = 1e9,
) -> None:
    for value in values:
        if not math.isfinite(value) or not minimum <= value <= maximum:
            fail(f"{name} contains a non-finite or out-of-range value.")


def srgb_channel_to_linear(value: float) -> float:
    return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4


def hex_to_linear(value: str) -> tuple[float, float, float, float]:
    components = tuple(int(value[offset:offset + 2], 16) / 255.0 for offset in (1, 3, 5))
    return tuple(srgb_channel_to_linear(component) for component in components) + (1.0,)


def load_mesh_data(manifest: dict[str, Any]) -> dict[str, array.array]:
    mesh_spec = manifest["mesh"]
    paths = mesh_spec["resolvedPaths"]
    vertex_count = mesh_spec["vertexCount"]
    index_count = mesh_spec["indexCount"]
    uv_count = mesh_spec["uvCount"]
    positions = load_array(paths["positions"], "f", vertex_count * 3)
    indices = load_array(paths["indices"], "I", index_count)
    colors = load_array(paths["colors"], "f", vertex_count * 3)
    uvs = load_array(paths["uvs"], "f", uv_count * 2)
    validate_floats(positions, "mesh.positions")
    validate_floats(colors, "mesh.colors", minimum=0.0, maximum=1.0)
    validate_floats(uvs, "mesh.uvs", minimum=-1e6, maximum=1e6)
    if any(index >= vertex_count for index in indices):
        fail("mesh.indices contains an out-of-range vertex index.")
    for offset in range(0, len(indices), 3):
        if len({indices[offset], indices[offset + 1], indices[offset + 2]}) != 3:
            fail("mesh.indices contains a triangle with repeated vertices.")
    return {"positions": positions, "indices": indices, "colors": colors, "uvs": uvs}


def set_active_object(object_: bpy.types.Object) -> None:
    if bpy.context.object is not None and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.select_all(action="DESELECT")
    object_.select_set(True)
    bpy.context.view_layer.objects.active = object_


def structured_grid_layout(
    manifest: dict[str, Any],
    indices: array.array,
) -> tuple[int, int, int] | None:
    """Recognize Rasterform's image-grid index contract, never by counts alone."""
    mesh_spec = manifest["mesh"]
    columns = mesh_spec["width"]
    rows = mesh_spec["height"]
    layer_count = 2 if mesh_spec["mode"] == "solid" else 1
    grid_vertices = (columns + 1) * (rows + 1)
    if mesh_spec["vertexCount"] != grid_vertices * layer_count:
        return None
    expected_indices = columns * rows * 6 * layer_count
    if layer_count == 2:
        expected_indices += (2 * columns + 2 * rows) * 6
    if len(indices) != expected_indices:
        return None

    cursor = 0

    def matches(expected: tuple[int, ...]) -> bool:
        nonlocal cursor
        for value in expected:
            if cursor >= len(indices) or indices[cursor] != value:
                return False
            cursor += 1
        return True

    for y in range(rows):
        for x in range(columns):
            a = y * (columns + 1) + x
            b = a + 1
            c = a + columns + 1
            d = c + 1
            if not matches((a, c, b, b, c, d)):
                return None
            if layer_count == 2:
                offset = grid_vertices
                if not matches((a + offset, b + offset, c + offset,
                                b + offset, d + offset, c + offset)):
                    return None

    if layer_count == 2:
        perimeter: list[int] = []
        perimeter.extend(range(columns + 1))
        perimeter.extend(y * (columns + 1) + columns for y in range(1, rows + 1))
        perimeter.extend(rows * (columns + 1) + x for x in range(columns - 1, -1, -1))
        perimeter.extend(y * (columns + 1) for y in range(rows - 1, 0, -1))
        for edge_index, current in enumerate(perimeter):
            next_vertex = perimeter[(edge_index + 1) % len(perimeter)]
            current_bottom = current + grid_vertices
            next_bottom = next_vertex + grid_vertices
            if not matches((current, next_vertex, next_bottom,
                            current, next_bottom, current_bottom)):
                return None
    return (columns, rows, layer_count) if cursor == len(indices) else None


def optimized_grid_dimensions(columns: int, rows: int, topology: str) -> tuple[int, int]:
    draw_triangle_ratio = 0.5 if topology == "balanced" else 0.25
    scale = math.sqrt(draw_triangle_ratio)

    def scaled(source: int) -> int:
        minimum = 2 if source >= 2 else 1
        return max(minimum, min(source, round(source * scale)))

    return scaled(columns), scaled(rows)


def sample_grid_attribute(
    source: array.array,
    components: int,
    columns: int,
    rows: int,
    layer: int,
    u: float,
    v: float,
) -> tuple[float, ...]:
    grid_vertices = (columns + 1) * (rows + 1)
    x = u * columns
    y = v * rows
    x0 = min(columns, math.floor(x))
    y0 = min(rows, math.floor(y))
    x1 = min(columns, x0 + 1)
    y1 = min(rows, y0 + 1)
    tx = x - x0
    ty = y - y0

    def component(vertex: int, channel: int) -> float:
        return source[((layer * grid_vertices) + vertex) * components + channel]

    a = y0 * (columns + 1) + x0
    b = y0 * (columns + 1) + x1
    c = y1 * (columns + 1) + x0
    d = y1 * (columns + 1) + x1
    result: list[float] = []
    for channel in range(components):
        top = component(a, channel) * (1.0 - tx) + component(b, channel) * tx
        bottom = component(c, channel) * (1.0 - tx) + component(d, channel) * tx
        result.append(top * (1.0 - ty) + bottom * ty)
    return tuple(result)


def sample_feature_preserving_position(
    positions: array.array,
    columns: int,
    rows: int,
    layer: int,
    target_x: int,
    target_y: int,
    target_columns: int,
    target_rows: int,
) -> tuple[float, float, float]:
    u = target_x / target_columns
    v = target_y / target_rows
    sampled = list(sample_grid_attribute(
        positions, 3, columns, rows, layer, u, v
    ))
    # The lower layer of a solid relief is intentionally flat. For the visible
    # surface, assign every source vertex to its nearest output vertex and keep
    # the height with the largest local approximation error. Unlike plain
    # bilinear decimation, this cannot silently drop a narrow peak or groove
    # that happens to fall between the lower-density sample coordinates.
    if layer != 0 or (columns == target_columns and rows == target_rows):
        return (sampled[0], sampled[1], sampled[2])

    source_x = u * columns
    source_y = v * rows
    radius_x = columns / target_columns * 0.5
    radius_y = rows / target_rows * 0.5
    x_start = max(0, math.ceil(source_x - radius_x))
    x_end = min(columns, math.floor(source_x + radius_x))
    y_start = max(0, math.ceil(source_y - radius_y))
    y_end = min(rows, math.floor(source_y + radius_y))
    grid_width = columns + 1
    grid_vertices = grid_width * (rows + 1)
    best_height = sampled[2]
    best_error = 0.0
    for source_grid_y in range(y_start, y_end + 1):
        for source_grid_x in range(x_start, x_end + 1):
            vertex = source_grid_y * grid_width + source_grid_x
            height = positions[((layer * grid_vertices) + vertex) * 3 + 2]
            error = abs(height - sampled[2])
            if error > best_error:
                best_height = height
                best_error = error
    sampled[2] = best_height
    return (sampled[0], sampled[1], sampled[2])


def rebuild_structured_grid(
    values: dict[str, array.array],
    layout: tuple[int, int, int],
    topology: str,
) -> tuple[dict[str, array.array], array.array, tuple[int, int]]:
    columns, rows, layer_count = layout
    target_columns, target_rows = optimized_grid_dimensions(columns, rows, topology)
    positions = array.array("f")
    colors = array.array("f")
    uvs = array.array("f")

    for layer in range(layer_count):
        for y in range(target_rows + 1):
            v = y / target_rows
            for x in range(target_columns + 1):
                u = x / target_columns
                positions.extend(sample_feature_preserving_position(
                    values["positions"], columns, rows, layer,
                    x, y, target_columns, target_rows
                ))
                colors.extend(sample_grid_attribute(
                    values["colors"], 3, columns, rows, layer, u, v
                ))
                uvs.extend(sample_grid_attribute(
                    values["uvs"], 2, columns, rows, layer, u, v
                ))

    loops = array.array("I")
    polygon_sizes = array.array("i")
    target_grid_vertices = (target_columns + 1) * (target_rows + 1)
    for y in range(target_rows):
        for x in range(target_columns):
            a = y * (target_columns + 1) + x
            b = a + 1
            c = a + target_columns + 1
            d = c + 1
            loops.extend((a, c, d, b))
            polygon_sizes.append(4)
            if layer_count == 2:
                offset = target_grid_vertices
                loops.extend((a + offset, b + offset, d + offset, c + offset))
                polygon_sizes.append(4)

    if layer_count == 2:
        perimeter: list[int] = []
        perimeter.extend(range(target_columns + 1))
        perimeter.extend(
            y * (target_columns + 1) + target_columns for y in range(1, target_rows + 1)
        )
        perimeter.extend(
            target_rows * (target_columns + 1) + x
            for x in range(target_columns - 1, -1, -1)
        )
        perimeter.extend(y * (target_columns + 1) for y in range(target_rows - 1, 0, -1))
        for edge_index, current in enumerate(perimeter):
            next_vertex = perimeter[(edge_index + 1) % len(perimeter)]
            loops.extend((
                current,
                next_vertex,
                next_vertex + target_grid_vertices,
                current + target_grid_vertices,
            ))
            polygon_sizes.append(4)

    return (
        {"positions": positions, "indices": loops, "colors": colors, "uvs": uvs},
        polygon_sizes,
        (target_columns, target_rows),
    )


def create_mesh_object(
    manifest: dict[str, Any],
    values: dict[str, array.array],
    polygon_sizes: array.array | None = None,
) -> bpy.types.Object:
    mesh_spec = manifest["mesh"]
    positions = values["positions"]
    indices = values["indices"]
    colors = values["colors"]
    uvs = values["uvs"]
    vertex_count = len(positions) // 3
    index_count = len(indices)
    if len(colors) != vertex_count * 3 or len(uvs) != vertex_count * 2:
        raise RuntimeError("Rasterform's rebuilt mesh attributes are incomplete.")
    if polygon_sizes is None:
        polygon_sizes = array.array("i", [3]) * (index_count // 3)
    if sum(polygon_sizes) != index_count or any(size < 3 for size in polygon_sizes):
        raise RuntimeError("Rasterform's rebuilt mesh has invalid polygon loops.")

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
    face_count = len(polygon_sizes)
    mesh.polygons.add(face_count)
    loop_starts = array.array("i")
    loop_start = 0
    for size in polygon_sizes:
        loop_starts.append(loop_start)
        loop_start += size
    mesh.polygons.foreach_set("loop_start", loop_starts)
    mesh.polygons.foreach_set("loop_total", polygon_sizes)
    # The low-level construction intentionally omits edge records; Blender's
    # validator reports that routine edge reconstruction as a correction.
    # Indices and polygon loops were validated above, so verify their counts
    # after normalization instead of treating that expected return as failure.
    mesh.validate(clean_customdata=False)
    if (len(mesh.vertices) != vertex_count
            or len(mesh.loops) != index_count
            or len(mesh.polygons) != face_count):
        fail("The source mesh contains invalid topology.")
    mesh.update(calc_edges=True)

    rgba = array.array("f")
    for offset in range(0, len(colors), 3):
        rgba.extend((colors[offset], colors[offset + 1], colors[offset + 2], 1.0))
    color_attribute = mesh.color_attributes.new(
        name=COLOR_ATTRIBUTE_NAME,
        type="FLOAT_COLOR",
        domain="POINT",
    )
    color_attribute.data.foreach_set("color", rgba)
    mesh.color_attributes.active_color = color_attribute
    mesh.color_attributes.default_color_name = COLOR_ATTRIBUTE_NAME

    uv_layer = mesh.uv_layers.new(name=UV_LAYER_NAME, do_init=False)
    loop_uvs = array.array("f")
    for vertex_index in indices:
        uv_offset = vertex_index * 2
        loop_uvs.extend((uvs[uv_offset], uvs[uv_offset + 1]))
    uv_layer.uv.foreach_set("vector", loop_uvs)
    mesh.uv_layers.active = uv_layer
    mesh.uv_layers.active_render = uv_layer
    mesh.update(calc_edges=True)

    object_ = bpy.data.objects.new("Rasterform_Model", mesh)
    bpy.context.scene.collection.objects.link(object_)
    object_.visible_camera = True
    object_.visible_shadow = True
    object_.show_wire = False
    object_.show_all_edges = False
    object_.display_type = "TEXTURED"
    object_["rasterform_mesh_mode"] = mesh_spec["mode"]
    object_["rasterform_topology"] = manifest["settings"]["topology"]
    set_active_object(object_)
    return object_


def create_material(manifest: dict[str, Any]) -> bpy.types.Material:
    material = bpy.data.materials.new("Rasterform_Material")
    material.use_nodes = True
    material.use_backface_culling = False
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    output.name = "Rasterform Material Output"
    shader = nodes.new("ShaderNodeBsdfPrincipled")
    shader.name = "Rasterform Surface"
    links.new(shader.outputs["BSDF"], output.inputs["Surface"])

    clay = manifest["appearance"]["clay"]
    if manifest["colorMode"] == "clay":
        base_color = hex_to_linear(clay["color"])
        shader.inputs["Base Color"].default_value = base_color
        material.diffuse_color = base_color
        roughness, metallic = {
            "matte": (0.88, 0.0),
            "glossy": (0.16, 0.02),
            "metallic": (0.26, 1.0),
        }[clay["finish"]]
    else:
        vertex_color = nodes.new("ShaderNodeVertexColor")
        vertex_color.name = "Rasterform Vertex Color"
        vertex_color.layer_name = COLOR_ATTRIBUTE_NAME
        links.new(vertex_color.outputs["Color"], shader.inputs["Base Color"])
        material.diffuse_color = (1.0, 1.0, 1.0, 1.0)
        roughness, metallic = 0.66, 0.04
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Metallic"].default_value = metallic
    shader.inputs["IOR"].default_value = 1.45
    material["rasterform_color_mode"] = manifest["colorMode"]
    return material


def shade_smooth_by_angle(object_: bpy.types.Object) -> None:
    set_active_object(object_)
    result = bpy.ops.object.shade_smooth_by_angle(
        angle=math.radians(45.0),
        keep_sharp_edges=True,
    )
    if "FINISHED" not in result:
        raise RuntimeError("Blender could not configure smooth-by-angle shading.")


def target_quads(source_faces: int, topology: str) -> int:
    # QuadriFlow's target is a quad count while Rasterform's source is
    # triangular.  These targets yield approximately 76% and 36% of the
    # source's render triangles before any unavoidable boundary adjustment.
    if topology == "balanced":
        return max(4, min(250_000, round(source_faces * 0.38)))
    if topology == "lightweight":
        return max(4, min(100_000, round(source_faces * 0.18)))
    raise ValueError(f"No QuadriFlow target exists for {topology}.")


def retopologize(object_: bpy.types.Object, topology: str, source_faces: int) -> None:
    set_active_object(object_)
    # Mark meaningful hard transitions before remeshing. QuadriFlow can then
    # honor both these edges and the open boundary of plane/centered meshes.
    shade_smooth_by_angle(object_)
    result = bpy.ops.object.quadriflow_remesh(
        use_mesh_symmetry=False,
        use_preserve_sharp=True,
        use_preserve_boundary=True,
        preserve_attributes=True,
        smooth_normals=True,
        mode="FACES",
        target_faces=target_quads(source_faces, topology),
        seed=0,
    )
    if "FINISHED" not in result:
        raise RuntimeError("Blender QuadriFlow could not retopologize this mesh.")
    object_.data.name = "Rasterform_Mesh"
    object_.data.update(calc_edges=True)
    if len(object_.data.polygons) == 0:
        raise RuntimeError("Blender QuadriFlow returned an empty mesh.")
    color_attribute = object_.data.color_attributes.get(COLOR_ATTRIBUTE_NAME)
    if color_attribute is None:
        raise RuntimeError("Blender QuadriFlow did not preserve Rasterform's color attribute.")
    if color_attribute.domain != "POINT" or color_attribute.data_type != "FLOAT_COLOR":
        raise RuntimeError("Blender QuadriFlow changed Rasterform's color attribute format.")
    if len(color_attribute.data) != len(object_.data.vertices):
        raise RuntimeError("Blender QuadriFlow returned incomplete Rasterform colors.")


def unwrap_smart_uv(object_: bpy.types.Object) -> None:
    set_active_object(object_)
    mesh = object_.data
    while len(mesh.uv_layers):
        mesh.uv_layers.remove(mesh.uv_layers[0])
    uv_layer = mesh.uv_layers.new(name=UV_LAYER_NAME, do_init=False)
    mesh.uv_layers.active = uv_layer
    mesh.uv_layers.active_render = uv_layer

    bpy.ops.object.mode_set(mode="EDIT")
    try:
        bpy.ops.mesh.select_all(action="SELECT")
        result = bpy.ops.uv.smart_project(
            angle_limit=math.radians(66.0),
            margin_method="FRACTION",
            rotate_method="AXIS_ALIGNED_Y",
            island_margin=0.02,
            area_weight=0.25,
            correct_aspect=True,
            scale_to_bounds=True,
        )
        if "FINISHED" not in result:
            raise RuntimeError("Blender could not create the optimized UV map.")
    finally:
        if bpy.context.object is not None and bpy.context.object.mode != "OBJECT":
            bpy.ops.object.mode_set(mode="OBJECT")
    mesh.update(calc_edges=True)
    uv_layer = mesh.uv_layers.get(UV_LAYER_NAME)
    if uv_layer is None:
        raise RuntimeError("Blender removed the optimized UV map.")
    if len(uv_layer.uv) != len(mesh.loops):
        raise RuntimeError("Blender created an incomplete optimized UV map.")
    coordinates = array.array("f", [0.0]) * (len(uv_layer.uv) * 2)
    uv_layer.uv.foreach_get("vector", coordinates)
    if any(not math.isfinite(value) or value < -1e-5 or value > 1.00001 for value in coordinates):
        raise RuntimeError("Blender created invalid optimized UV coordinates.")


def disable_viewport_grids() -> None:
    # Grid/floor overlays are editor state rather than scene geometry. Keep
    # them disabled in any workspace serialized by this background process so
    # opening the result presents only the model.
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type != "VIEW_3D":
                continue
            for space in area.spaces:
                if space.type != "VIEW_3D":
                    continue
                overlay = space.overlay
                for property_name in (
                    "show_floor",
                    "show_ortho_grid",
                    "show_axis_x",
                    "show_axis_y",
                    "show_axis_z",
                    "show_cursor",
                    "show_relationship_lines",
                    "show_object_origins",
                    "show_stats",
                    "show_text",
                ):
                    if hasattr(overlay, property_name):
                        setattr(overlay, property_name, False)
                space.shading.type = "MATERIAL"


def verify_clean_scene(object_: bpy.types.Object) -> None:
    scene_objects = list(bpy.context.scene.objects)
    if scene_objects != [object_] or object_.type != "MESH":
        raise RuntimeError("The Blender export scene must contain exactly one mesh object.")
    if any(item.type in {"CAMERA", "LIGHT"} for item in bpy.data.objects):
        raise RuntimeError("The Blender export unexpectedly contains a camera or light.")
    bpy.context.scene.camera = None


def topology_counts(mesh: bpy.types.Mesh) -> tuple[int, int, int, int]:
    triangles = sum(1 for polygon in mesh.polygons if len(polygon.vertices) == 3)
    quads = sum(1 for polygon in mesh.polygons if len(polygon.vertices) == 4)
    ngons = sum(1 for polygon in mesh.polygons if len(polygon.vertices) > 4)
    output_triangle_count = sum(
        max(1, len(polygon.vertices) - 2) for polygon in mesh.polygons
    )
    return quads, triangles, ngons, output_triangle_count


def save_compressed(manifest: dict[str, Any]) -> tuple[int, str]:
    output = manifest["resolvedOutput"]
    temporary = output.with_name(f".{output.stem}.partial-{os.getpid()}.blend")
    try:
        preferences = bpy.context.preferences.filepaths
        if hasattr(preferences, "save_version"):
            preferences.save_version = 0
        if hasattr(preferences, "use_auto_save_temporary_files"):
            preferences.use_auto_save_temporary_files = False
        result = bpy.ops.wm.save_as_mainfile(
            filepath=str(temporary),
            check_existing=False,
            compress=True,
            relative_remap=False,
            copy=True,
        )
        if "FINISHED" not in result or not temporary.is_file():
            raise RuntimeError("Blender did not save the private project file.")
        with temporary.open("rb") as handle:
            magic = handle.read(7)
            handle.flush()
            os.fsync(handle.fileno())
        # Blender 5.2 uses a Zstandard frame for compressed .blend files;
        # uncompressed Blender versions begin directly with ``BLENDER``.
        if magic != b"BLENDER" and not magic.startswith(ZSTD_MAGIC):
            raise RuntimeError("Blender saved an invalid project file.")
        reopened = bpy.ops.wm.open_mainfile(
            filepath=str(temporary),
            load_ui=False,
            use_scripts=False,
            display_file_selector=False,
        )
        if "FINISHED" not in reopened:
            raise RuntimeError("Blender could not reopen the saved private project.")
        mesh_objects = [item for item in bpy.context.scene.objects if item.type == "MESH"]
        if len(mesh_objects) != 1:
            raise RuntimeError("The reopened Blender project did not contain exactly one mesh.")
        reopened_model = mesh_objects[0]
        verify_clean_scene(reopened_model)
        reopened_uv = reopened_model.data.uv_layers.get(UV_LAYER_NAME)
        if reopened_uv is None or len(reopened_uv.uv) != len(reopened_model.data.loops):
            raise RuntimeError("The reopened Blender project did not retain its UV map.")
        os.replace(temporary, output)
        os.chmod(output, 0o600)
        digest = hashlib.sha256()
        with output.open("rb") as saved:
            for chunk in iter(lambda: saved.read(1024 * 1024), b""):
                digest.update(chunk)
        return output.stat().st_size, digest.hexdigest()
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def export_blend(manifest_path: Path) -> None:
    started = time.monotonic()
    if bpy.app.version < (5, 2, 0):
        raise RuntimeError("Rasterform Blender export requires Blender 5.2 LTS or newer.")
    manifest = parse_manifest(manifest_path)
    job_id = manifest["jobId"]
    topology = manifest["settings"]["topology"]
    emit("PROGRESS", {"jobId": job_id, "phase": "preparing"})
    values = load_mesh_data(manifest)
    source_vertices = manifest["mesh"]["vertexCount"]
    source_faces = manifest["mesh"]["indexCount"] // 3
    structured_layout = structured_grid_layout(manifest, values["indices"])

    # Defense in depth: even if the caller omitted --factory-startup, discard
    # startup objects and preferences before creating the private scene.
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for object_ in list(bpy.data.objects):
        bpy.data.objects.remove(object_, do_unlink=True)

    if topology == "exact":
        model = create_mesh_object(manifest, values)
        model["rasterform_retopology_method"] = "exact"
    else:
        emit("PROGRESS", {"jobId": job_id, "phase": "retopologizing"})
        if structured_layout is not None:
            rebuilt, polygon_sizes, target_grid = rebuild_structured_grid(
                values, structured_layout, topology
            )
            model = create_mesh_object(manifest, rebuilt, polygon_sizes)
            model["rasterform_retopology_method"] = "structured_grid"
            model["rasterform_grid_width"] = target_grid[0]
            model["rasterform_grid_height"] = target_grid[1]
        else:
            model = create_mesh_object(manifest, values)
            retopologize(model, topology, source_faces)
            model["rasterform_retopology_method"] = "quadriflow"
        emit("PROGRESS", {"jobId": job_id, "phase": "unwrapping"})
        unwrap_smart_uv(model)
    shade_smooth_by_angle(model)
    model.data.materials.clear()
    model.data.materials.append(create_material(manifest))
    model.data.update(calc_edges=True)
    disable_viewport_grids()
    verify_clean_scene(model)

    uv_layer = model.data.uv_layers.get(UV_LAYER_NAME)
    if uv_layer is None or len(uv_layer.uv) != len(model.data.loops):
        raise RuntimeError("The Blender project does not contain a complete UV map.")
    color_attribute = model.data.color_attributes.get(COLOR_ATTRIBUTE_NAME)
    color_name = color_attribute.name if color_attribute is not None else None
    output_vertices = len(model.data.vertices)
    output_faces = len(model.data.polygons)
    uv_layer_name = uv_layer.name
    uv_loop_count = len(uv_layer.uv)
    quads, triangles, ngons, output_triangle_count = topology_counts(model.data)

    emit("PROGRESS", {"jobId": job_id, "phase": "saving"})
    output_bytes, output_sha256 = save_compressed(manifest)
    elapsed = time.monotonic() - started
    emit("COMPLETE", {
        "jobId": job_id,
        "file": manifest["output"],
        "topology": topology,
        "sourceVertices": source_vertices,
        "sourceFaces": source_faces,
        "outputVertices": output_vertices,
        "outputFaces": output_faces,
        "outputTriangleCount": output_triangle_count,
        "quads": quads,
        "triangles": triangles,
        "ngons": ngons,
        "uvLayerName": uv_layer_name,
        "uvLoops": uv_loop_count,
        "colorAttributeName": color_name,
        "blenderVersion": bpy.app.version_string,
        "elapsedSeconds": round(elapsed, 3),
        "outputBytes": output_bytes,
        "outputSha256": output_sha256,
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
        export_blend(manifest_argument(sys.argv))
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
