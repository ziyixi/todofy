"""Model configuration is pure Python and can be checked without a Worker."""

from types import ModuleType, SimpleNamespace

import pytest


@pytest.fixture
def config() -> ModuleType:
    # Collecting host tests must not retain runtime/ before its Pyodide-stubbing fixtures run.
    from todofy.runtime import config

    return config


@pytest.mark.parametrize("email_models", [None, "", " , "])
def test_missing_email_order_inherits_the_configured_shared_order(config, email_models):
    env = SimpleNamespace(GEMINI_MODELS=" Flash-A, flash-B ", GEMINI_EMAIL_MODELS=email_models)
    assert config.gemini_email_models(env) == config.gemini_models(env) == ["flash-a", "flash-b"]


def test_email_order_is_normalised_and_independent_of_the_shared_order(config):
    env = SimpleNamespace(GEMINI_MODELS="flash-a,flash-b", GEMINI_EMAIL_MODELS=" Lite, Flash-A, Flash-B ")
    assert config.gemini_email_models(env) == ["lite", "flash-a", "flash-b"]
    assert config.gemini_models(env) == ["flash-a", "flash-b"]


def test_old_empty_configuration_inherits_the_existing_defaults_without_sharing_a_list(config):
    env = SimpleNamespace()
    emails = config.gemini_email_models(env)
    assert emails == list(config.DEFAULT_GEMINI_MODELS)
    emails.clear()
    assert config.gemini_models(env) == config.gemini_email_models(env) == list(config.DEFAULT_GEMINI_MODELS)
