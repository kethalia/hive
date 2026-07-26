---
name: blender-asset-pipeline
description: Create, inspect, optimize, and export game-ready 3D assets with Blender for Unity. Use for .blend files, Blender Python automation, modeling, UVs, baking, materials, rigging, animation, LODs, glTF/FBX exports, or diagnosing scale, axis, normals, texture, and import problems.
---

# Blender Asset Pipeline

Build a reversible source pipeline: keep `.blend` sources and texture masters outside Unity's generated state, and export deterministic interchange assets into the Unity project.

## Workflow

1. Establish the target render pipeline, unit scale, polygon/texture budgets, rig requirements, and export format before changing the asset.
2. Use meters in Blender and verify real dimensions. Apply rotation and scale before export unless the rig or animation workflow explicitly requires otherwise.
3. Fix topology, normals, pivots, naming, UVs, and material slots in the source file. Keep modifiers non-destructive until the export requires them applied.
4. Use glTF for interoperable static/PBR assets when the Unity pipeline supports it. Use FBX for established Unity humanoid, animation, or toolchain requirements. Do not rely on Unity importing `.blend` files directly.
5. Keep texture inputs lossless. Pack metallic/smoothness/occlusion channels only to match the chosen Unity shader convention.
6. Export to a staging directory, inspect the result, then copy the final artifact and textures into `Assets/` while preserving Unity `.meta` files on subsequent updates.
7. Record export settings in a Blender Python script or preset when the asset will be regenerated.

## Automation and inspection

Use Blender headlessly for deterministic checks and exports:

```bash
blender --background source.blend --python export_for_unity.py
```

Scripts must fail loudly, use explicit object/collection names, set export axes and units, and verify the expected output exists. Open the exported asset in a clean Blender scene or inspect it in Unity before declaring the pipeline valid.

## Unity handoff checklist

- Scale and orientation match the project convention.
- Origin/pivot placement is intentional.
- Transforms and normals are correct; mirrored geometry has no inverted faces.
- Mesh, armature, bones, actions, materials, and textures have stable names.
- UV0 supports materials; UV1 exists when baked lighting requires it.
- LODs, colliders, and rig/avatar configuration are defined on the Unity side when appropriate.
- Texture color spaces and normal-map import types are correct.

## Remote-workspace limits

Prefer Blender's CPU render or workbench checks when no GPU is exposed. Do not claim viewport, shader, bake, or frame-time quality from software rendering alone; identify the checks that still need a GPU-enabled machine.
