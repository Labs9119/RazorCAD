# Releasing a version

A release is made on GitHub when a version tag is pushed. The workflow is `.github/workflows/release.yml`, and it runs only for tags like `v0.14.0-beta`, never for ordinary pushes.

1. Set the version in `version.txt`, e.g. `0.14.0-beta`. The tag must match it, with a `v` in front.
   Rebuild the user manual PDF (`python Manual/build_manual.py`) and commit it with the version: the release attaches the PDF from git, and refuses one older than `Manual/manual_source.md`.
2. Commit, then tag and push the tag:

   ```
   git tag v0.14.0-beta
   git push origin v0.14.0-beta
   ```

3. On GitHub (Actions ▸ Release), the workflow then:
   - checks that the tag matches `version.txt`, and that the manual PDF is no older than `Manual/manual_source.md`;
   - runs the regression tests (`tests/run_tests.py`, the Tests workflow's 6 machines side by side, some 15 minutes); the release stops if one fails;
   - builds `RazorCAD.exe` and `RazorCAD-Setup-<version>.exe` (`installer/build_installer.bat`), signed when signing is set up;
   - drafts a release named "RazorCAD <version>" with the setup, the user manual (`RazorCAD-User-Manual-<version>.pdf`), `Read-me-first.txt` and `SHA256SUMS.txt` attached. A version with a `-` (a beta) is marked as a pre-release. The notes come from `CHANGELOG.md`: the entries added since the previous tag (`tools/release_notes.py`).
4. Read the draft over, edit the notes if needed, and publish it. Nothing is published until you do.

The built files are also kept with the workflow run, under Artifacts.

## Code signing

Signing is optional (see `SIGNING.md`). To sign in the workflow, add two repository secrets (Settings ▸ Secrets and variables ▸ Actions):
- `RAZORCAD_SIGN_PFX_BASE64`: the `.pfx` file, base64-encoded (`[Convert]::ToBase64String([IO.File]::ReadAllBytes('cert.pfx'))` in PowerShell);
- `RAZORCAD_SIGN_PASSWORD`: its password.

Without them, the files are built unsigned. A certificate kept on a USB token cannot be used on GitHub's machines. With one of those, build and sign on your own PC (`installer\build_installer.bat`) and attach the setup to the draft yourself.

## Release notes by hand

```
python tools/release_notes.py 0.14.0-beta --since v0.13.0-beta
```
