#!/usr/bin/env python3
"""Hotfix edge-tts 7.2.8 for Microsoft's synthesis 403 rollout.

Since October 2026 speech.platform.bing.com answers the synthesis WebSocket
with 403 for an increasing share of clients (US datacenter IPs, e.g. GitHub
runners, since 12 Oct 2026), so every CI short died at the voice stage with
"voice.mp3 is empty". Upstream fix: https://github.com/rany2/edge-tts/pull/491
— synthesize through api.msedgeservices.com (the host real Edge 155 uses,
which accepts the legacy token) + locale-independent server-date parsing.

Until that ships as a release, this script applies the vendored patch (the
exact diff between the 7.2.8 tag and PR head 8a5844c) to the installed
package. It runs in .github/workflows/short-factory.yml right after pip
installs edge-tts and becomes a no-op automatically as soon as pip installs
a fixed version (7.2.9+), because the patch only applies to 7.2.8.

Idempotent: re-running on an already-patched install is a no-op.
"""

import subprocess
import sys
from importlib import metadata
from pathlib import Path

# The only released version needing the hotfix; a future 7.2.9+ (with the
# fix merged upstream) skips patching entirely.
PATCHED_VERSIONS = {"7.2.8"}
FIXED_HOST = "api.msedgeservices.com"


def main() -> int:
    try:
        installed = metadata.version("edge-tts")
    except metadata.PackageNotFoundError:
        sys.exit("edge-tts is not installed")

    if installed not in PATCHED_VERSIONS:
        print(f"edge-tts {installed}: outside {sorted(PATCHED_VERSIONS)} — no 403 hotfix needed")
        return 0

    import edge_tts  # only imported after the version check

    pkg_dir = Path(edge_tts.__file__).resolve().parent
    if FIXED_HOST in (pkg_dir / "constants.py").read_text(encoding="utf-8"):
        print(f"edge-tts {installed}: already patched for {FIXED_HOST}")
        return 0

    patch_file = (
        Path(__file__).resolve().parent.parent
        / "patches"
        / "edge-tts-7.2.8-msedgeservices.patch"
    )
    if not patch_file.is_file():
        sys.exit(f"missing vendored patch: {patch_file}")

    # `git apply` runs fine outside a repository; git itself is guaranteed
    # (actions/checkout, and locally for anyone running the pipeline by hand).
    site_packages = pkg_dir.parent
    proc = subprocess.run(
        ["git", "apply", "-p1", "--whitespace=nowarn", str(patch_file)],
        cwd=site_packages,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr)
        sys.exit(
            f"edge-tts {installed}: hotfix patch failed to apply against {site_packages}"
        )

    print(f"edge-tts {installed}: patched synthesis endpoint -> {FIXED_HOST}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
