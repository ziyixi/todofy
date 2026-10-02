"""Prevent numeric config errors from echoing accidentally pasted secrets."""

import math
import traceback

import pytest

import newsletter.settings as settings

FIELDS = (
    ("NEWSLETTER_JOB_TIMEOUT_SECONDS", "job_timeout_seconds", float, 900.0),
    (
        "NEWSLETTER_COLLECTION_TIMEOUT_SECONDS",
        "collection_timeout_seconds",
        float,
        600.0,
    ),
    ("NEWSLETTER_TODOFY_TOP", "todofy_top", int, 5),
)


@pytest.fixture(autouse=True)
def isolated_environment(monkeypatch):
    # No real .env or ambient environment is consulted.
    monkeypatch.setattr(settings.os, "environ", {})


@pytest.mark.parametrize("name,attribute,parse,default", FIELDS)
def test_numeric_defaults_are_unchanged(name, attribute, parse, default):
    assert getattr(settings.Settings.from_env(), attribute) == default


@pytest.mark.parametrize("name,attribute,parse,default", FIELDS)
@pytest.mark.parametrize("value", [" 12 ", "+2", "-3", "0"])
def test_accepted_numeric_strings_preserve_builtin_semantics(
    name, attribute, parse, default, value
):
    settings.os.environ[name] = value
    assert getattr(settings.Settings.from_env(), attribute) == parse(value)


@pytest.mark.parametrize("name,attribute,parse,default", FIELDS)
def test_bad_numeric_value_is_absent_from_message_and_formatted_traceback(
    name, attribute, parse, default
):
    sentinel = "synthetic-private-value-NEVER-LOG-THIS"
    settings.os.environ[name] = sentinel
    with pytest.raises(
        ValueError, match=f"Set a valid numeric value for {name}"
    ) as caught:
        settings.Settings.from_env()
    error = caught.value
    assert str(error) == f"Set a valid numeric value for {name}"
    assert error.__cause__ is None and error.__suppress_context__ is True
    assert sentinel not in "".join(traceback.format_exception(error))


@pytest.mark.parametrize("name,attribute,parse,default", FIELDS)
def test_empty_numeric_values_remain_invalid(name, attribute, parse, default):
    settings.os.environ[name] = ""
    with pytest.raises(ValueError, match=name):
        settings.Settings.from_env()


@pytest.mark.parametrize("name,attribute,parse,default", FIELDS[:2])
@pytest.mark.parametrize("value", ["1.25", "1e2", "nan", "inf"])
def test_float_parsing_still_leaves_range_and_finiteness_to_validation(
    name, attribute, parse, default, value
):
    settings.os.environ[name] = value
    actual = getattr(settings.Settings.from_env(), attribute)
    assert math.isnan(actual) if value == "nan" else actual == float(value)


def test_integer_field_still_rejects_fractional_strings():
    settings.os.environ["NEWSLETTER_TODOFY_TOP"] = "1.5"
    with pytest.raises(ValueError, match="NEWSLETTER_TODOFY_TOP"):
        settings.Settings.from_env()
