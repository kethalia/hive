---
name: unity-development
description: Build, debug, test, and maintain Unity projects using C#, Unity packages, scenes, prefabs, ScriptableObjects, shaders, and batch-mode tooling. Use for Unity project setup, gameplay systems, editor tooling, test automation, performance work, or changes under Assets/, Packages/, and ProjectSettings/.
---

# Unity Development

Work from the project files first. Treat Unity-generated state as disposable and preserve asset metadata.

## Workflow

1. Read `ProjectSettings/ProjectVersion.txt`, `Packages/manifest.json`, assembly definitions, and the affected scripts before choosing APIs or packages.
2. Keep runtime, editor-only, and test code in separate assemblies. Put editor code under an `Editor/` folder or an editor-only assembly.
3. Preserve every `.meta` file and its GUID. Move or rename assets together with their `.meta` files; never regenerate metadata to resolve a reference problem.
4. Prefer small MonoBehaviours plus plain C# domain objects. Use ScriptableObjects for authored shared data, not mutable per-instance runtime state.
5. Avoid scene and prefab YAML edits unless the format and reference impact are fully understood. Prefer editor scripts for structural asset changes.
6. Add Edit Mode tests for pure logic and Play Mode tests for scene/lifecycle behavior.
7. Run the narrowest available validation, then expand to batch-mode tests or a build when the installed Editor and license permit it.

## Validation

Locate the project Editor version instead of assuming a path. With Unity Hub, Editors normally live below `~/Unity/Hub/Editor/<version>/Editor/Unity`.

Use batch mode when an Editor is installed:

```bash
UNITY_EDITOR="${UNITY_EDITOR:?set this to the Unity executable}"
"$UNITY_EDITOR" -batchmode -nographics -quit -projectPath "$PWD" \
  -runTests -testPlatform EditMode -testResults /tmp/unity-editmode.xml
```

Run Play Mode separately so failures remain attributable. Capture the Editor log and report when validation is blocked by login, licensing, unavailable graphics, or a missing target module.

## Guardrails

- Do not edit `Library/`, `Temp/`, `Logs/`, `obj/`, or generated IDE solution files.
- Do not upgrade the Unity Editor or packages unless the task requests it.
- Do not silently change render pipelines, input systems, serialization modes, or API compatibility levels.
- Do not assume GPU acceleration in a remote workspace; favor batch tests and lightweight scenes, and state when visual or performance verification needs a GPU workstation.
