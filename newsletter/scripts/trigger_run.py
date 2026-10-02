"""Run the installed trigger directly from a source checkout."""

import pathlib
import runpy

if __name__ == "__main__":
    runpy.run_path(
        str(
            pathlib.Path(__file__).resolve().parents[1]
            / "src"
            / "newsletter"
            / "trigger.py"
        ),
        run_name="__main__",
    )
