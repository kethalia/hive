# Guardian build and optional packaging

The build tool compiles the reviewed C source into a Linux x64 position-independent
ELF with stack protection, fortified libc calls, immediate symbol binding and a
read-only relocation section. It records source, builder, recipe and ELF digests,
compiler identity/digest/target, and the GitHub run identity when run in Actions.
The build rejects a changed source/compiler and refuses an existing output directory.
Two builds with the same local toolchain produce the same ELF; this does not claim
identical binaries across compiler versions or operating systems.

`build-native-guardian.yml` builds and tests the exact artifact on pull requests
and uploads it with fourteen-day retention. It has read-only repository permission,
does not publish a release or deploy, and requires no runtime credentials. The
artifact consists of `codex-native-guardian` and `guardian-build.json`.

The host bundle includes it only when `HIVE_GUARDIAN_ARTIFACT_DIR` explicitly selects
a verified artifact directory. The builder checks the current source and build
recipe, ELF format/architecture and bytes. Its manifest binds the selected build
metadata and ELF hash. The installer checks that exact binary/metadata pair and
copies bytes with mode 0500 into the private versioned package; it neither compiles
nor starts the guardian. Default template archives still omit the binary. Including
an artifact alone does not enable a launcher or grant cleanup authority.

These hashes prove consistency, not independent compilation provenance. The primary
must select an artifact from the reviewed repository, commit and successful workflow
run, verify the returned artifact identity, and pin the resulting complete host
archive. Compiler and CI fields inside an arbitrary supplied JSON file are not
cryptographic attestation. Runtime trust comes from the reviewed pinned package
and exclusion of its binaries, code, journals and keys from model writes.

Parent and independent review each passed five build/package tests and nine Python
installer tests: repeatability, changed source/recipe/ELF rejection, symlink
rejection, opt-in inclusion, malformed/mismatched binary metadata, private modes,
no installer subprocess and preservation of prior packages. No remote artifact
has yet been installed by this checkpoint. The composed launcher, native session,
tmux/PTY ownership, durable barrier, receipt import and test-workspace validation
remain separate gates.

The foundation CI run exposed ignored C error-pipe writes under Ubuntu's default
fortification. Commit `fe7f9a1` handles their return values explicitly; a clean
source export passes thirty guardian/template tests plus an explicit
`-D_FORTIFY_SOURCE=3 -Werror` compile. No compiler diagnostic was disabled.
