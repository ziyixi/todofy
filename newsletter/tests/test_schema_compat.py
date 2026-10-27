"""Test strict endpoint schema rejection without provider calls."""

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
    monkeypatch, tmp_path, fake_router
):
    schema = story_editor.story_writer_schema("brief")
    schema["properties"]["supplemental_packets"]["uniqueItems"] = True

    def unexpected(*args, **kwargs):
        raise AssertionError(
            "No usage context may start for rejected configuration"
        )

    monkeypatch.setattr(usage, "model_usage", unexpected)
    with pytest.raises(errors.EditorError) as error:
        await editor.live_editor(tmp_path).execute(
            "{}", schema, "fixture", tmp_path / "workspace"
        )
    assert error.value.code == "configuration"
    assert not fake_router.started and fake_router.thread_starts == 0


@pytest.mark.parametrize(
    "code,category",
    [
        ("INVALID_ARGUMENT", "configuration"),
        ("RESOURCE_EXHAUSTED", "rate_limit"),
        ("UNAUTHENTICATED", "authentication"),
        ("UNAVAILABLE", "unavailable"),
    ],
)
def test_normalized_error_classification(code, category):
    assert newsletter_editor._error_category(code) == category


async def test_router_schema_rejection_has_no_provenance_retry(
    tmp_path, fake_router
):
    fake_router.turn = editor.FakeTurn({}, research=False, failure={"code": 3})
    with pytest.raises(errors.EditorError) as error:
        await editor.live_editor(tmp_path).execute(
            "{}",
            story_editor.story_writer_schema("brief"),
            "fixture",
            tmp_path / "workspace",
        )
    assert error.value.code == "configuration"
    assert len(fake_router.prompts) == 1 and fake_router.closed
