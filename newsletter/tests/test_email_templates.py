"""Versioned HTML contracts and hostile templates, entirely offline."""

import copy
import importlib.resources as resources

import jinja2.runtime as runtime
import pytest
import yaml

import newsletter.adapters as adapters
import newsletter.editor as editor
import newsletter.email_templates as email_templates
import newsletter.rendering as newsletter_rendering
import newsletter.store as newsletter_store
import newsletter.todofy as todofy
import newsletter.usage as newsletter_usage
import newsletter.worker as newsletter_worker
import newsletter.workflow.definition as newsletter_workflow_definition
import newsletter.workflow.repository as newsletter_workflow_repository
import tests.support.publication_delivery as publication_delivery
import tests.support.rendering as rendering
import tests.support.usage as usage


@pytest.fixture
def source():
    return (
        resources.files("newsletter")
        .joinpath("templates/edition.html.j2")
        .read_text(encoding="utf-8")
    )


def config(source, revision="fixture-a"):
    return {
        "content_config": {
            "schema_version": 1,
            "revision": revision,
            "digest": "fixture-digest",
            "editorial": {},
            "files": {"templates/edition.html.j2": source},
        }
    }


@pytest.mark.parametrize("full", [False, True])
def test_packaged_source_in_sandbox_has_identical_frozen_bytes(source, full):
    draft, packets = (
        copy.deepcopy(rendering.SAMPLE_DRAFT),
        copy.deepcopy(rendering.SAMPLE_PACKETS),
    )
    packets[0]["is_fixture"] = False
    if not full:
        draft.pop("chart")
        draft.pop("recommended_reading")
    args = {
        "draft": draft,
        "packets": packets,
        "issue_date": "2026-09-05",
        "personal_digest": todofy.unavailable_digest() if full else None,
        "usage": newsletter_usage.summarize_usage(usage.record_one())
        if full
        else None,
    }
    assert newsletter_rendering.render_edition(
        **args, template_source=source
    ) == newsletter_rendering.render_edition(**args)


def test_external_layout_preserves_graph_sources_sections_personal_and_usage(
    source,
):
    packets = copy.deepcopy(rendering.SAMPLE_PACKETS)
    packets[0]["is_fixture"] = False
    changed = source.replace("视野", "新版晨报")
    rendered = newsletter_rendering.render_edition(
        rendering.SAMPLE_DRAFT,
        packets,
        "2026-09-05",
        personal_digest=todofy.unavailable_digest(),
        usage=newsletter_usage.summarize_usage(usage.record_one()),
        template_source=changed,
    )
    parsed = rendering.ParsedEmail(rendered["html"])
    visible = "".join(parsed.text)
    assert "新版晨报" in visible
    assert (
        len(parsed.images) == 1
        and parsed.images[0]["src"] == "cid:newsletter-chart"
    )
    assert (
        parsed.images[0]["alt"] == rendering.SAMPLE_DRAFT["chart"]["alt_text"]
    )
    for section in rendering.SAMPLE_DRAFT["sections"]:
        assert section["heading"] in visible
        for paragraph in section["paragraphs"]:
            assert paragraph["text"] in visible
    assert "https://example.org/research/methods" in parsed.links
    assert visible.index("TODOFY / 与你有关") > visible.index(
        rendering.SAMPLE_DRAFT["chart"]["question"]
    )
    assert visible.index("Codex 已记录 120 tokens") > visible.index(
        "TODOFY / 与你有关"
    )
    assert rendered["chart_png"]


def test_template_cache_keys_the_immutable_source_not_one_global_template(
    source,
):
    first, second = (
        source.replace("视野", "缓存版本甲"),
        source.replace("视野", "缓存版本乙"),
    )
    email_templates._compiled.cache_clear()
    first_html = email_templates.render_template(
        first, email_templates._fixture_context(full=True)
    )
    second_html = email_templates.render_template(
        second, email_templates._fixture_context(full=True)
    )
    assert first_html != second_html
    assert "缓存版本甲" in first_html and "缓存版本乙" not in first_html
    assert "缓存版本乙" in second_html and "缓存版本甲" not in second_html
    assert (
        email_templates.render_template(
            first, email_templates._fixture_context(full=True)
        )
        == first_html
    )
    assert email_templates._compiled.cache_info().currsize == 2


@pytest.mark.parametrize(
    "fragment",
    [
        "{{ self.__init__.__globals__ }}",
        "{{ _email_literal }}",
        "{% macro _email_literal(value) %}literal{% endmacro %}",
        "{% set _email_literal = 'replace internal budget' %}",
        "{{ draft['__class__'] }}",
        "{{ draft[issue_date] }}",
        "{{ cycler.__init__.__globals__.os.popen('id').read() }}",
        "{{ range(1000000000) }}",
        "{% include '/etc/passwd' %}",
        "{% extends '/etc/passwd' %}",
        "{% import '/etc/passwd' as other %}",
        "{% autoescape false %}{{ draft.title }}{% endautoescape %}",
        "{{ draft.title|safe }}",
        "{{ draft|attr('__class__') }}",
        "{{ draft.clear() }}",
        "{{ draft.title.format() }}",
        "{{ draft.title.split('x') }}",
        "{{ 'x' * 1000000000 }}",
        "{{ 2 ** 1000000000 }}",
        "{{ '%1000000000d'|format(1) }}",
        "{{ draft.title|format(1) }}",
        "{% macro recurse() %}{{ recurse() }}{% endmacro %}{{ recurse() }}",
        "{% macro a() %}{{ b() }}{% endmacro %}{% macro b() %}{{ a() }}{% "
        "endmacro %}{{ a() }}",
        "{% for ref in references recursive %}{{ ref.title }}{% endfor %}",
        "{% set bomb = 'many' %}{% for letter in bomb %}{{ letter }}{% "
        "endfor %}",
        "{% for letter in 'many' %}{{ letter }}{% endfor %}",
        "{% set draft = 'overwrite' %}",
        "{{ unrecognized_context }}",
        "{% if issue_date == '1999-01-01' %}{{ credentials }}{% endif %}",
    ],
)
def test_template_language_cannot_escape_or_allocate_without_bound(
    source, fragment
):
    with pytest.raises(email_templates.TemplateValidationError):
        email_templates.validate_template(source + fragment)


@pytest.mark.parametrize(
    "fragment",
    [
        "<script>alert(1)</script>",
        "<iframe src='https://example.org/'></iframe>",
        "<svg onload='alert(1)'></svg>",
        "<object data='https://example.org/'></object>",
        "<form action='https://example.org/'></form>",
        "<meta http-equiv='refresh' content='0;url=https://example.org/'>",
        "<link rel='stylesheet' href='https://example.org/style.css'>",
        "<img src='https://example.org/tracker.png' alt='tracker'>",
        "<img src='data:image/png;base64,AA==' alt='inline'>",
        "<p onclick='alert(1)'>example</p>",
        "<a href='javascript:alert(1)'>example</a>",
        "<a href='http://127.0.0.1/private'>example</a>",
        "<a href='https://example.org/' ping='https://example.org/track'>ex"
        "ample</a>",
        "<style>@import 'https://example.org/style.css';</style>",
        "<p style='background:url(https://example.org/tracker)'>example</p>",
        "<p style='background:u\\72l(https://example.org/tracker)'>example</p>",
        "<p style='background:u/**/rl(https://example.org/tracker)'>example"
        "</p>",
        "<p style='background:image-set(\"https://example.org/tracker\")'>e"
        "xample</p>",
        "<p style='behavior:expression(alert(1))'>example</p>",
        "<!--[if mso]><script>alert(1)</script><![endif]-->",
        "<!--[if mso]><img src='https://example.org/tracker'><![endif]-->",
        "<p title='one' title='two'>example</p>",
    ],
)
def test_email_markup_cannot_execute_or_fetch_remote_resources(
    source, fragment
):
    with pytest.raises(email_templates.TemplateValidationError):
        email_templates.validate_template(source + fragment)


@pytest.mark.parametrize(
    "expression",
    [
        "{{ draft.title }}",
        "{{ lines(paragraph.text) }}",
        "{{ chart.caption }}",
        "{{ row.label }}",
        "{{ lines(item.detail) }}",
        "{{ usage_footer }}",
    ],
)
def test_validation_catches_accidentally_dropped_content(source, expression):
    assert expression in source
    with pytest.raises(
        email_templates.TemplateValidationError, match="omits required"
    ):
        email_templates.validate_template(source.replace(expression, ""))


def test_unknown_nested_property_fails_strictly_and_errors_never_expose_content(
    source,
):
    private = "secret-context-value-never-log"
    with pytest.raises(email_templates.TemplateValidationError) as failure:
        email_templates.validate_template(
            source + "{{ personal.nonexistent_" + private + " }}"
        )
    assert private not in str(failure.value)


def test_content_cannot_inject_html_through_external_template(source):
    context = email_templates._fixture_context(full=True)
    context["draft"]["title"] = "<script>alert('not markup')</script>"
    html = email_templates.render_template(source, context)
    assert "<script>" not in html and "&lt;script&gt;" in html


def test_bounded_iterations_include_data_loops_even_without_output(source):
    email_templates.validate_template(source)
    context = email_templates._fixture_context(full=False)
    # The supported language cannot manufacture a range; data-driven nesting
    # also has a per-render budget, including loops producing no HTML chunks.
    fragment = (
        "{% for a in references %}{% for b in references %}{% for c in "
        "references %}{% endfor %}{% endfor %}{% endfor %}"
    )
    source += fragment
    email_templates.validate_template(source)
    context["references"] *= 20
    with pytest.raises(
        email_templates.TemplateValidationError, match="iteration limit"
    ):
        email_templates.render_template(source, context)


def test_source_and_output_sizes_are_bounded(source):
    with pytest.raises(
        email_templates.TemplateValidationError, match="source is too large"
    ):
        email_templates.validate_template(
            source + " " * email_templates.MAX_TEMPLATE_BYTES
        )
    context = email_templates._fixture_context(full=False)
    context["draft"]["introduction"] = (
        "x" * email_templates.MAX_TEMPLATE_OUTPUT_BYTES
    )
    with pytest.raises(
        email_templates.TemplateValidationError, match="output is too large"
    ):
        email_templates.render_template(source, context)


def test_optional_chart_and_alt_text_must_match_frozen_data(source):
    with pytest.raises(
        email_templates.TemplateValidationError, match="chart and description"
    ):
        email_templates.validate_template(
            source.replace('alt="{{ chart.alt_text }}"', 'alt="wrong"')
        )
    with pytest.raises(email_templates.TemplateValidationError):
        email_templates.validate_template(
            source.replace(
                'src="{{ chart_cid }}"', 'src="https://example.org/plot"'
            )
        )


@pytest.mark.parametrize(
    "link",
    [
        "https://example.org/collect?q={{ personal.summary if personal "
        "else 'none' }}",
        "{{ references[0].url }}?private={{ personal.summary if personal "
        "else 'none' }}",
        "https://example.org/other-public-but-unreferenced",
    ],
)
def test_template_cannot_embed_personal_data_or_tracking_in_even_public_links(
    source, link
):
    with pytest.raises(
        email_templates.TemplateValidationError, match="preserve source URLs"
    ):
        email_templates.validate_template(
            source + '<a href="' + link + '">extra link</a>'
        )


def test_runtime_link_allowlist_also_guards_unexercised_date_branch(source):
    changed = (
        source + "{% if issue_date == '2026-09-08' %}\n"
        '        <a href="https://example.org/collect?q={{ '
        'personal.summary }}">extra link</a>\n'
        "        {% endif %}"
    )
    email_templates.validate_template(changed)
    context = email_templates._fixture_context(full=True)
    context["issue_date"] = "2026-09-08"
    context["personal"]["summary"] = "synthetic_private_marker"
    with pytest.raises(
        email_templates.TemplateValidationError, match="preserve source URLs"
    ) as failure:
        email_templates.render_template(changed, context)
    assert "synthetic_private_marker" not in str(failure.value)


def test_macros_cannot_multiply_buffers_by_calling_other_macros(source):
    fragment = (
        "{% macro a() %}" + "x" * 2000 + "{% endmacro %}"
        "{% macro b() %}{{ a() }}{{ a() }}{% endmacro %}"
        "{% macro c() %}{{ b() }}{{ b() }}{% endmacro %}{{ c() }}"
    )
    with pytest.raises(
        email_templates.TemplateValidationError,
        match="macros cannot call other macros",
    ):
        email_templates.validate_template(source + fragment)


def test_literal_budget_stops_expansion_before_single_macro_buffer_returns(
    source, monkeypatch
):
    monkeypatch.setattr(
        "newsletter.email_templates.MAX_TEMPLATE_WORK_BYTES", 200_000
    )
    fragment = (
        "{% macro expand() %}{% for ref in references %}"
        + "x" * 40000
        + "{% endfor %}{% endmacro %}{{ expand() }}"
    )
    changed = source + fragment
    email_templates.validate_template(changed)
    entered, returned = [], []
    original = runtime.Macro._invoke

    def record(self, *args, **kwargs):
        if self.name == "expand":
            entered.append(True)
        result = original(self, *args, **kwargs)
        if self.name == "expand":
            returned.append(True)
        return result

    monkeypatch.setattr(runtime.Macro, "_invoke", record)
    context = email_templates._fixture_context(full=False)
    context["references"] *= 4
    with pytest.raises(
        email_templates.TemplateValidationError, match="expansion budget"
    ):
        email_templates.render_template(changed, context)
    assert entered == [True] and returned == []


def test_absent_config_is_legacy_but_partial_config_cannot_fall_back(
    source,
):
    assert email_templates.template_from_inputs({"model": "fixture"}) is None
    assert email_templates.template_from_inputs(config(source)) == source
    for value in (
        {},
        {"schema_version": 2},
        {"schema_version": 1, "files": {}},
        None,
    ):
        with pytest.raises(email_templates.TemplateValidationError):
            email_templates.template_from_inputs({"content_config": value})


@pytest.mark.asyncio
async def test_worker_freezes_a_during_b_activation_and_keeps_old_ready_bytes(
    source, tmp_path
):
    store = newsletter_store.Store(tmp_path / "newsletter.sqlite3", "mock")
    try:
        worker = newsletter_worker.Worker(
            store,
            editor.MockEditor(),
            adapters.DisabledNotion(),
            tmp_path / "jobs",
            10,
        )
        repository = newsletter_workflow_repository.WorkflowRepository(store)
        definition = newsletter_workflow_definition.parse_definition(
            yaml.safe_load(
                resources.files("newsletter")
                .joinpath("workflows/daily.yaml")
                .read_text()
            )
        )
        first_source = source.replace("视野", "冻结版本甲")
        second_source = source.replace("视野", "更新版本乙")
        live_file = tmp_path / "edition.html.j2"
        live_file.write_text(first_source)
        first, _, _, binding = publication_delivery.queue(
            store, key="template-run-a"
        )
        repository.start(
            binding["run_id"], definition, config(live_file.read_text(), "a")
        )
        # Activate B after run A is frozen but before its rendering tail starts.
        live_file.write_text(second_source)
        assert await worker.step()
        frozen_first = store.get(first["id"])["rendered"]
        assert (
            "冻结版本甲" in frozen_first["html"]
            and "更新版本乙" not in frozen_first["html"]
        )
        second, _, _, binding = publication_delivery.queue(
            store, key="template-run-b"
        )
        repository.start(
            binding["run_id"], definition, config(live_file.read_text(), "b")
        )
        assert await worker.step()
        assert "更新版本乙" in store.get(second["id"])["rendered"]["html"]
        assert store.get(first["id"])["rendered"] == frozen_first
        assert store.db.execute("SELECT COUNT(*) FROM sends").fetchone()[0] == 0
    finally:
        store.close()


@pytest.mark.asyncio
async def test_worker_invalid_frozen_template_does_not_substitute_packaged_html(
    source, tmp_path
):
    store = newsletter_store.Store(tmp_path / "newsletter.sqlite3", "mock")
    try:
        worker = newsletter_worker.Worker(
            store,
            editor.MockEditor(),
            adapters.DisabledNotion(),
            tmp_path / "jobs",
            10,
        )
        repository = newsletter_workflow_repository.WorkflowRepository(store)
        definition = newsletter_workflow_definition.parse_definition(
            yaml.safe_load(
                resources.files("newsletter")
                .joinpath("workflows/daily.yaml")
                .read_text()
            )
        )
        edition, _, _, binding = publication_delivery.queue(store)
        repository.start(
            binding["run_id"],
            definition,
            config(source + "<script>bad</script>"),
        )
        assert await worker.step()
        finished = store.get(edition["id"])
        assert finished["state"] == "failed"
        assert "rendered" not in finished
        assert finished["delivery_state"] == "not_requested"
    finally:
        store.close()
