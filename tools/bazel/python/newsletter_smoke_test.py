"""Run an existing synthetic Newsletter smoke script through the test runtime."""

import importlib
import os


def test_existing_smoke_script():
    importlib.import_module(os.environ["NEWSLETTER_SMOKE_MODULE"]).main()
