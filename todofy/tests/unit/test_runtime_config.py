"""Model configuration is pure Python and can be checked without a Worker."""

from types import SimpleNamespace

import pytest

from todofy.runtime.config import DEFAULT_GEMINI_MODELS, gemini_email_models, gemini_models


@pytest.mark.parametrize("email_models", [None, "", " , "])
def test_missing_email_order_inherits_the_configured_shared_order(email_models):
    env = SimpleNamespace(GEMINI_MODELS=" Flash-A, flash-B ", GEMINI_EMAIL_MODELS=email_models)
    assert gemini_email_models(env) == gemini_models(env) == ["flash-a", "flash-b"]


def test_email_order_is_normalised_and_independent_of_the_shared_order():
    env = SimpleNamespace(GEMINI_MODELS="flash-a,flash-b", GEMINI_EMAIL_MODELS=" Lite, Flash-A, Flash-B ")
    assert gemini_email_models(env) == ["lite", "flash-a", "flash-b"]
    assert gemini_models(env) == ["flash-a", "flash-b"]


def test_old_empty_configuration_inherits_the_existing_defaults_without_sharing_a_list():
    env = SimpleNamespace()
    emails = gemini_email_models(env)
    assert emails == list(DEFAULT_GEMINI_MODELS)
    emails.clear()
    assert gemini_models(env) == gemini_email_models(env) == list(DEFAULT_GEMINI_MODELS)
