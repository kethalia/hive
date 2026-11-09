# Test-only process-universe projection for the existing unprivileged fixture.
# Keep real kernel inspection for every descendant of its dedicated subreaper,
# including the outer, C guardian, worker and transient inspection helpers.
# Unrelated primary processes are excluded from this test universe.
_fixture_original_iterdir = Path.iterdir


def _fixture_process_inventory(path):
    if path != Path("/proc"):
        return _fixture_original_iterdir(path)
    root = int(Path("/fixture/driver-pid").read_text())
    parents = {}
    for process in _fixture_original_iterdir(path):
        if not process.name.isdigit():
            continue
        try:
            text = (process / "stat").read_text()
            fields = text[text.rindex(") ") + 2:].split()
            parents[int(process.name)] = int(fields[1])
        except (FileNotFoundError, ProcessLookupError):
            pass
    selected = {root}
    for _ in range(32):
        children = {pid for pid, parent in parents.items() if parent in selected}
        if children.issubset(selected):
            break
        selected.update(children)
    Path("/fixture/last-process-inventory.json").write_text(json.dumps(sorted(selected)))
    return iter(path / str(pid) for pid in sorted(selected))


Path.iterdir = _fixture_process_inventory
