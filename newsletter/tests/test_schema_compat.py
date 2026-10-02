"""Test strict endpoint schema rejection without provider calls."""

import copy

import pytest

import newsletter.editor as newsletter_editor
import newsletter.errors as errors
import newsletter.schema_compat as schema_compat
import newsletter.usage as usage
import newsletter.workflow.story_editor as story_editor
import tests.support.editor as editor


def test_every_production_schema_passes_before_any_model_work():
    schemas = schema_compat.production_output_schemas()
    assert set(schemas) == {
        "discovery",
        "planning",
        "gaps",
        "research",
        "legacy_editor",
        "legacy_review",
        "story_review",
        "story_brief",
        "story_brief_repair",
        "story_deep",
        "story_deep_repair",
    }
    for schema in schemas.values():
        schema_compat.validate_output_schema(schema)
    schema_compat.check_production_output_schemas()


@pytest.mark.parametrize("mode", ["brief", "deep"])
@pytest.mark.parametrize("repair", [False, True])
def test_empty_and_input_scoped_writer_schemas_are_compatible(mode, repair):
    schema_compat.validate_output_schema(
        story_editor.story_writer_schema(mode, repair=repair)
    )


@pytest.mark.parametrize(
    "keyword",
    [
        "uniqueItems",
        "allOf",
        "oneOf",
        "not",
        "if",
        "then",
        "else",
        "dependentSchemas",
        "patternProperties",
        "unevaluatedProperties",
        "contains",
        "default",
        "newUnknownConstraint",
    ],
)
def test_unprobed_constraint_is_rejected_even_inside_nested_component(keyword):
    schema = story_editor.story_writer_schema("brief")
    citations = schema["properties"]["content"]["anyOf"][0]["properties"][
        "paragraphs"
    ]["items"]["properties"]["citations"]
    citations[keyword] = True
    with pytest.raises(errors.EditorError) as error:
        schema_compat.validate_output_schema(schema)
    assert error.value.code == "configuration"
    assert keyword not in str(error.value)


def test_schema_property_names_and_descriptions_are_not_keywords():
    schema_compat.validate_output_schema(
        {
            "type": "object",
            "additionalProperties": False,
            "required": ["uniqueItems"],
            "properties": {
                "uniqueItems": {
                    "type": "string",
                    "description": "allOf is ordinary text",
                }
            },
        }
    )


@pytest.mark.parametrize(
    "change",
    [
        {"additionalProperties": True},
        {"required": []},
        {"required": ["content", "content"]},
        {"type": "unknown"},
        {"anyOf": []},
    ],
)
def test_unclosed_or_malformed_schema_is_configuration_failure(change):
    schema = story_editor.story_writer_schema("brief")
    schema.update(change)
    with pytest.raises(errors.EditorError) as error:
        schema_compat.validate_output_schema(schema)
    assert error.value.code == "configuration"


async def test_unsupported_schema_fails_before_sdk_or_usage(
    monkeypatch, tmp_path, fake_sdk
):
    schema = story_editor.story_writer_schema("brief")
    schema["properties"]["supplemental_packets"]["uniqueItems"] = True

    def unexpected(*args, **kwargs):
        raise AssertionError(
            "No usage context may start for rejected configuration"
        )

    monkeypatch.setattr(usage, "codex_usage", unexpected)
    with pytest.raises(errors.EditorError) as error:
        await editor.live_editor(tmp_path).execute(
            "{}", schema, "fixture", tmp_path / "workspace"
        )
    assert error.value.code == "configuration"
    assert not fake_sdk.started and fake_sdk.thread_starts == 0


_PROVIDER_SCHEMA_ERROR = {
    "message": (
        "Invalid schema for response_format 'codex_output_schema': "
        "In context=('properties', 'content', 'anyOf', '0', "
        "'properties', 'paragraphs', 'items', 'properties', "
        "'citations'), 'uniqueItems' is not permitted."
    ),
    "type": "invalid_request_error",
    "code": "invalid_json_schema",
    "param": "text.format.schema",
}


@pytest.mark.parametrize(
    "failure",
    [
        _PROVIDER_SCHEMA_ERROR,
        RuntimeError(str(_PROVIDER_SCHEMA_ERROR)),
        {
            "message": (
                "Invalid schema for text.format 'codex_output_schema': "
                "schema keyword rejected"
            )
        },
    ],
)
def test_real_shaped_schema_rejection_fatal_config_without_raw_details(
    failure,
):
    error = newsletter_editor._vendor_failure(failure)
    assert error.code == "configuration"
    assert "uniqueItems" not in str(error) and "codex_output_schema" not in str(
        error
    )


@pytest.mark.parametrize(
    ("failure", "code"),
    [
        (
            {"message": "Generated output failed schema validation"},
            "unavailable",
        ),
        ({"message": "HTTP 400 bad request"}, "unavailable"),
        ({"message": "temporary connection failure"}, "unavailable"),
        ({"message": "rate_limit_exceeded"}, "rate_limit"),
        ({"message": "not logged in"}, "authentication"),
    ],
)
def test_schema_classification_does_not_absorb_unrelated_failures(
    failure, code
):
    assert newsletter_editor._vendor_failure(failure).code == code


async def test_provider_schema_rejection_has_no_provenance_retry(
    tmp_path, fake_sdk
):
    # A valid local schema can still be rejected by a changed provider. The
    # upstream configuration error must reach the existing fatal workflow path.
    fake_sdk.turn = editor.FakeTurn(
        {}, research=False, failure=copy.deepcopy(_PROVIDER_SCHEMA_ERROR)
    )
    with pytest.raises(errors.EditorError) as error:
        await editor.live_editor(tmp_path).execute(
            "{}",
            story_editor.story_writer_schema("brief"),
            "fixture",
            tmp_path / "workspace",
        )
    assert error.value.code == "configuration"
    assert len(fake_sdk.prompts) == 1 and fake_sdk.closed
