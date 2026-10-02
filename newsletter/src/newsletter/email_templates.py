"""Bounded, offline templates with no loader or ambient application objects.

Templates are reviewed configuration, not general-purpose Jinja programs. The
small supported language keeps the packaged layout useful while excluding
imports, arbitrary calls, recursive macros and allocation-heavy expressions.
"""

from __future__ import annotations

from collections.abc import Iterator
import contextvars
import functools
import hashlib
import html.parser as parser
import logging
import re
from typing import Any, cast

import jinja2
import jinja2.meta as meta
import jinja2.nodes as nodes
import jinja2.runtime as runtime
import jinja2.sandbox as sandbox
import jinja2.visitor as visitor
import markupsafe

import newsletter.contracts as contracts
import newsletter.diagnostics as diagnostics

MAX_TEMPLATE_BYTES = 64 * 1024
MAX_TEMPLATE_OUTPUT_BYTES = 1024 * 1024
MAX_TEMPLATE_ITERATIONS = 2048
MAX_TEMPLATE_WORK_BYTES = 4 * MAX_TEMPLATE_OUTPUT_BYTES
_LOGGER = logging.getLogger(__name__)
_CONTEXT_KEYS = frozenset(
    {
        "draft",
        "sections",
        "references",
        "chart",
        "chart_cid",
        "reading",
        "issue_date",
        "date_label",
        "weekday_label",
        "is_fixture",
        "personal",
        "usage_footer",
    }
)
_FILTERS = frozenset(
    {"escape", "e", "default", "length", "lower", "upper", "trim", "format"}
)
_TESTS = frozenset(
    {
        "none",
        "defined",
        "undefined",
        "boolean",
        "true",
        "false",
        "string",
        "number",
    }
)
_NODE_TYPES = (
    nodes.Template,
    nodes.Output,
    nodes.TemplateData,
    nodes.Name,
    nodes.Const,
    nodes.Getattr,
    nodes.Getitem,
    nodes.Compare,
    nodes.Operand,
    nodes.If,
    nodes.For,
    nodes.Assign,
    nodes.Tuple,
    nodes.Macro,
    nodes.Call,
    nodes.Filter,
    nodes.Test,
    nodes.Not,
    nodes.And,
    nodes.Or,
    nodes.CondExpr,
    nodes.Keyword,
)


class TemplateValidationError(ValueError):
    """Safe diagnostics exclude template source and private context values."""


class _Budget:
    def __init__(self) -> None:
        self.remaining = MAX_TEMPLATE_ITERATIONS
        self.work_bytes = 0

    def tick(self) -> None:
        self.remaining -= 1
        if self.remaining < 0:
            raise TemplateValidationError(
                "Email template iteration limit exceeded"
            )

    def output(self, value: str) -> None:
        self.work_bytes += len(value.encode("utf-8"))
        if self.work_bytes > MAX_TEMPLATE_WORK_BYTES:
            raise TemplateValidationError(
                "Email template expansion budget exceeded"
            )


_BUDGET: contextvars.ContextVar[_Budget] = contextvars.ContextVar(
    "email_template_budget"
)


class _BoundedList(list[Any]):
    def __iter__(self) -> Iterator[Any]:
        for value in super().__iter__():
            _BUDGET.get().tick()
            yield value


class _BoundedString(str):
    def __iter__(self) -> Iterator[str]:
        for value in super().__iter__():
            _BUDGET.get().tick()
            yield value


def _plain_context(value: Any, *, depth: int = 0) -> Any:
    if depth > 24:
        raise TemplateValidationError(
            "Email template context is too deeply nested"
        )
    if isinstance(value, dict):
        if any(type(key) is not str for key in value):
            raise TemplateValidationError(
                "Email template context must use text keys"
            )
        return {
            key: _plain_context(item, depth=depth + 1)
            for key, item in value.items()
        }
    if isinstance(value, list | tuple):
        return _BoundedList(
            _plain_context(item, depth=depth + 1) for item in value
        )
    if type(value) is str:
        return _BoundedString(value)
    if value is None or type(value) in {int, float, bool}:
        return value
    raise TemplateValidationError(
        "Email template context must contain only data"
    )


class _EmailEnvironment(sandbox.ImmutableSandboxedEnvironment):
    def is_safe_callable(self, obj: Any) -> bool:
        return (
            obj is _literal
            or isinstance(obj, runtime.Macro)
            or (
                getattr(obj, "__name__", "") == "split"
                and type(getattr(obj, "__self__", None))
                in {str, _BoundedString}
            )
        )

    def call(self, context: Any, obj: Any, *args: Any, **kwargs: Any) -> Any:
        _BUDGET.get().tick()
        if (
            obj is not _literal
            and not isinstance(obj, runtime.Macro)
            and (args != ("\n",) or kwargs)
        ):
            raise TemplateValidationError(
                "Email templates only support newline splitting"
            )
        result = super().call(context, obj, *args, **kwargs)
        if isinstance(result, list):
            return _BoundedList(result)
        if (
            isinstance(result, str)
            and len(result.encode("utf-8")) > MAX_TEMPLATE_OUTPUT_BYTES
        ):
            raise TemplateValidationError("Email template output is too large")
        return result


def _literal(value: str) -> markupsafe.Markup:
    # Instrument trusted TemplateData nodes after validating user syntax. The
    # charge happens before Jinja adds a literal to a macro's temporary buffer.
    _BUDGET.get().output(value)
    return markupsafe.Markup(value)


@jinja2.pass_context
def _finalize(context: Any, value: Any) -> Any:
    del context
    if value is not None and not isinstance(value, str | int | float | bool):
        raise TemplateValidationError(
            "Email template cannot print whole data containers"
        )
    _BUDGET.get().output(str(value))
    return value


class _BoundedLiterals(visitor.NodeTransformer):
    # Jinja dispatches visitors by their exact AST class name.
    def visit_TemplateData(  # noqa: N802
        self, node: nodes.TemplateData, *args: Any, **kwargs: Any
    ) -> nodes.Call:
        call = nodes.Call(
            nodes.Name("_email_literal", "load"),
            [nodes.Const(node.data)],
            [],
            None,
            None,
        )
        call.set_lineno(node.lineno)
        return call


def _number_format(pattern: str, value: Any) -> str:
    if (
        pattern not in {"%02d", "%d"}
        or type(value) is not int
        or not 0 <= value <= 100000
    ):
        raise TemplateValidationError(
            "Email template numeric format is unsupported"
        )
    return pattern % value


def _environment() -> _EmailEnvironment:
    environment = _EmailEnvironment(
        autoescape=jinja2.select_autoescape(
            default=True, default_for_string=True
        ),
        undefined=jinja2.StrictUndefined,
        trim_blocks=True,
        lstrip_blocks=True,
        keep_trailing_newline=True,
        finalize=_finalize,
    )
    environment.globals.clear()
    environment.globals["_email_literal"] = _literal
    environment.filters = {
        name: function
        for name, function in environment.filters.items()
        if name in _FILTERS
    }
    environment.filters["format"] = _number_format
    environment.tests = {
        name: function
        for name, function in environment.tests.items()
        if name in _TESTS
    }
    return environment


def _check_node(node: nodes.Node, macros: dict[str, nodes.Macro]) -> None:
    if isinstance(node, nodes.Name | nodes.Macro) and node.name.startswith("_"):
        raise TemplateValidationError(
            "Email template private names are forbidden"
        )
    if isinstance(node, nodes.Getattr) and node.attr.startswith("_"):
        raise TemplateValidationError(
            "Email template private attributes are forbidden"
        )
    if isinstance(node, nodes.Getitem) and (
        not isinstance(node.arg, nodes.Const)
        or not isinstance(node.arg.value, str | int)
        or (isinstance(node.arg.value, str) and node.arg.value.startswith("_"))
    ):
        raise TemplateValidationError(
            "Email template dynamic access is forbidden"
        )
    if isinstance(node, nodes.For) and node.recursive:
        raise TemplateValidationError(
            "Email template recursive loops are forbidden"
        )
    if isinstance(node, nodes.For) and not (
        (
            isinstance(node.iter, nodes.Name)
            and node.iter.name in {"sections", "references"}
        )
        or isinstance(node.iter, nodes.Getattr | nodes.Getitem)
        or (
            isinstance(node.iter, nodes.Call)
            and isinstance(node.iter.node, nodes.Getattr)
            and node.iter.node.attr == "split"
        )
    ):
        raise TemplateValidationError(
            "Email template loops must iterate bounded context data"
        )
    if isinstance(node, nodes.Assign) and (
        not isinstance(node.target, nodes.Name)
        or node.target.name in _CONTEXT_KEYS
        or node.target.name in macros
    ):
        raise TemplateValidationError(
            "Email template context cannot be overwritten"
        )
    if isinstance(node, nodes.Test) and node.name not in _TESTS:
        raise TemplateValidationError("Email template test is unsupported")
    if isinstance(node, nodes.Filter):
        if node.name not in _FILTERS:
            raise TemplateValidationError(
                "Email template filter is unsupported"
            )
        if node.name == "format" and (
            not isinstance(node.node, nodes.Const)
            or node.node.value not in {"%02d", "%d"}
        ):
            raise TemplateValidationError(
                "Email template numeric format is unsupported"
            )
    if isinstance(node, nodes.Call):
        if node.dyn_args is not None or node.dyn_kwargs is not None:
            raise TemplateValidationError(
                "Email template dynamic calls are forbidden"
            )
        macro_call = (
            isinstance(node.node, nodes.Name) and node.node.name in macros
        )
        split_call = (
            isinstance(node.node, nodes.Getattr)
            and node.node.attr == "split"
            and len(node.args) == 1
            and isinstance(node.args[0], nodes.Const)
            and node.args[0].value == "\n"
            and not node.kwargs
        )
        if not macro_call and not split_call:
            raise TemplateValidationError(
                "Email template callable is unsupported"
            )


def _check_ast(tree: nodes.Template) -> None:
    all_nodes: list[nodes.Node] = []

    def walk(node: nodes.Node, depth: int = 0, loops: int = 0) -> None:
        all_nodes.append(node)
        loops += isinstance(node, nodes.For)
        if len(all_nodes) > 2500 or depth > 32 or loops > 4:
            raise TemplateValidationError("Email template is too complex")
        if not isinstance(node, _NODE_TYPES):
            raise TemplateValidationError(
                "Email template operation is unsupported"
            )
        for child in node.iter_child_nodes():
            walk(child, depth + 1, loops)

    walk(tree)
    macros = {
        node.name: node for node in all_nodes if isinstance(node, nodes.Macro)
    }
    for node in all_nodes:
        _check_node(node, macros)

    for macro in macros.values():
        if any(
            isinstance(call.node, nodes.Name)
            for call in macro.find_all(nodes.Call)
        ):
            raise TemplateValidationError(
                "Email template macros cannot call other macros"
            )
    if meta.find_undeclared_variables(tree) - _CONTEXT_KEYS:
        raise TemplateValidationError(
            "Email template uses an unknown context variable"
        )


@functools.lru_cache(maxsize=16)
def _compiled(digest: str, source: str) -> jinja2.Template:
    # Both immutable source and its digest are cache keys. Never key by a live
    # file path or one global template: another issue may use an older revision.
    del digest
    environment = _environment()
    try:
        tree = environment.parse(source)
        _check_ast(tree)
        return environment.from_string(_BoundedLiterals().visit(tree))
    except TemplateValidationError:
        raise
    # Jinja compilation can invoke implementation-dependent parser failures.
    except Exception as error:  # noqa: BLE001
        diagnostics.record_failure(
            _LOGGER, phase="template_compile", error=error
        )
        raise TemplateValidationError(
            "Email template syntax is invalid"
        ) from None


def _compile(source: str) -> jinja2.Template:
    if type(source) is not str or not source.strip():
        raise TemplateValidationError("Email template must contain text")
    if len(source.encode("utf-8")) > MAX_TEMPLATE_BYTES:
        raise TemplateValidationError("Email template source is too large")
    return _compiled(hashlib.sha256(source.encode("utf-8")).hexdigest(), source)


_TAGS = frozenset(
    "html head meta title body style div span table thead tbody tfoot tr "
    "td th p h1 h2 h3 "
    "h4 a sup sub br hr strong em b i u small ul ol li blockquote xml "
    "o:officedocumentsettings o:pixelsperinch".split()
)
_ATTRIBUTES = frozenset(
    "class id style lang title role aria-label aria-hidden dir width "
    "height align valign "
    "cellpadding cellspacing border bgcolor scope colspan rowspan xmlns "
    "xmlns:o".split()
)


def _check_css(value: str) -> None:
    if (
        any(ord(char) < 32 and char not in "\t\r\n" for char in value)
        or "\\" in value
        or "/*" in value
        or "*/" in value
        or "<" in value
        or ">" in value
        or re.search(
            "url\\s*\\(|@import|@font-face|expression\\s*\\(|behavior\\s*:|"
            "binding\\s*:|image-set\\s*\\(",
            value,
            re.I,
        )
    ):
        raise TemplateValidationError(
            "Email template CSS cannot load resources or execute code"
        )


class _EmailHTML(parser.HTMLParser):
    def __init__(
        self, allowed_links: frozenset[str], *, comment_depth: int = 0
    ) -> None:
        super().__init__(convert_charrefs=True)
        self.comment_depth = comment_depth
        self.tags: list[str] = []
        self.visible: list[str] = []
        self.in_style = False
        self.in_title = False
        self.count = 0
        self.images: list[dict[str, str | None]] = []
        self.allowed_links = allowed_links

    def handle_starttag(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> None:
        self.count += 1
        if self.count > 10000 or tag not in _TAGS | {"img"}:
            raise TemplateValidationError(
                "Email template HTML element is unsupported"
            )
        self.tags.append(tag)
        self.in_style = tag == "style" or self.in_style
        self.in_title = tag == "title" or self.in_title
        names = [name for name, _ in attrs]
        if len(set(names)) != len(names):
            raise TemplateValidationError(
                "Email template has duplicate HTML attributes"
            )
        for name, value in attrs:
            if value is None:
                raise TemplateValidationError(
                    "Email template has an unsupported HTML attribute"
                )
            if name in _ATTRIBUTES:
                if name == "style":
                    _check_css(value)
                continue
            if tag == "a" and name == "href":
                if value not in self.allowed_links:
                    raise TemplateValidationError(
                        "Email template links must preserve source URLs"
                    )
                try:
                    contracts.validate_public_url(value)
                except ValueError:
                    raise TemplateValidationError(
                        "Email template contains an unsafe link"
                    ) from None
                continue
            if tag == "a" and name == "rel" and value == "noopener noreferrer":
                continue
            if tag == "img" and (
                name == "alt"
                or (name == "src" and value == "cid:newsletter-chart")
            ):
                continue
            if tag == "meta" and name in {"charset", "name", "content"}:
                continue
            raise TemplateValidationError(
                "Email template has an unsupported HTML attribute"
            )
        if tag == "img" and dict(attrs).get("src") != "cid:newsletter-chart":
            raise TemplateValidationError(
                "Email template images must use the frozen chart CID"
            )
        if tag == "img":
            self.images.append(dict(attrs))

    def handle_endtag(self, tag: str) -> None:
        if tag not in _TAGS | {"img"}:
            raise TemplateValidationError(
                "Email template HTML element is unsupported"
            )
        if tag == "style":
            self.in_style = False
        if tag == "title":
            self.in_title = False

    def handle_data(self, data: str) -> None:
        if self.in_style:
            _check_css(data)
        elif not self.in_title:
            self.visible.append(data)

    def handle_comment(self, data: str) -> None:
        # Outlook can execute conditional-comment markup. Inspect it too; never
        # assume an HTMLParser comment is invisible in every email client.
        if self.comment_depth >= 4:
            raise TemplateValidationError(
                "Email template comments are too deeply nested"
            )
        nested = _EmailHTML(
            self.allowed_links, comment_depth=self.comment_depth + 1
        )
        nested.feed(data)
        nested.close()


def _render(template: jinja2.Template, context: dict[str, Any]) -> str:
    if set(context) != _CONTEXT_KEYS:
        raise TemplateValidationError(
            "Email template context version is incompatible"
        )
    token = _BUDGET.set(_Budget())
    try:
        chunks = []
        length = 0
        for chunk in template.generate(**_plain_context(context)):
            length += len(chunk.encode("utf-8"))
            if length > MAX_TEMPLATE_OUTPUT_BYTES:
                raise TemplateValidationError(
                    "Email template output is too large"
                )
            chunks.append(chunk)
        html = "".join(chunks)
        parsed = _EmailHTML(
            frozenset(reference["url"] for reference in context["references"])
        )
        parsed.feed(html)
        parsed.close()
        if not {"html", "body", "table"}.issubset(parsed.tags):
            raise TemplateValidationError(
                "Email template must provide a complete table-based email"
            )
        chart = context["chart"]
        if len(parsed.images) != (1 if chart else 0) or (
            chart and parsed.images[0].get("alt") != chart["alt_text"]
        ):
            raise TemplateValidationError(
                "Email template must preserve its chart and description"
            )
        return html
    except TemplateValidationError:
        raise
    # Keep every renderer failure behind a content-free configuration error.
    except Exception as error:  # noqa: BLE001
        diagnostics.record_failure(
            _LOGGER, phase="template_render", error=error
        )
        raise TemplateValidationError(
            "Email template rendering failed"
        ) from None
    finally:
        _BUDGET.reset(token)


def _fixture_context(*, full: bool) -> dict[str, Any]:
    """Exercise the renderer contract with synthetic markers, not live data."""
    reference = {
        "number": 1,
        "citation": "fixture/source",
        "title": "VALIDATE_SOURCE",
        "url": "https://example.org/template-fixture",
        "published_at": "2026-01-01",
        "access_scope": "全文",
    }
    return {
        "draft": {
            "subject": "VALIDATE_SUBJECT",
            "title": "VALIDATE_TITLE",
            "introduction": "VALIDATE_INTRODUCTION",
            "limitations": [],
        },
        "sections": [
            {
                "kind": "world",
                "label": "世界简报",
                "heading": "VALIDATE_HEADING",
                "limitations": ["VALIDATE_LIMITATION"] if full else [],
                "paragraphs": [
                    {"text": "VALIDATE_PARAGRAPH", "references": [reference]}
                ],
            }
        ],
        "references": [reference],
        "chart": {
            "kind": "bar",
            "question": "VALIDATE_CHART_QUESTION",
            "metric": "VALIDATE_CHART_METRIC",
            "unit": "%",
            "period": "模拟",
            "caption": "VALIDATE_CHART_CAPTION",
            "alt_text": "VALIDATE_CHART_ALT",
            "metadata": "VALIDATE_CHART_METADATA",
            "source_note": "VALIDATE_CHART_SOURCE",
            "limitations": ["VALIDATE_CHART_LIMITATION"],
            "rows": [
                {
                    "label": "VALIDATE_POINT",
                    "value": "12",
                    "missing_reason": "",
                    "references": [reference],
                },
                {
                    "label": "VALIDATE_MISSING",
                    "value": None,
                    "missing_reason": "VALIDATE_MISSING_REASON",
                    "references": [],
                },
            ],
        }
        if full
        else None,
        "chart_cid": "cid:newsletter-chart",
        "reading": {
            "reference": reference,
            "supporting_references": [reference],
            "reason": "VALIDATE_READING",
            "paragraphs": ["VALIDATE_READING"],
        }
        if full
        else None,
        "issue_date": "2026-01-01",
        "date_label": "2026 / 01 / 01",
        "weekday_label": "星期四",
        "is_fixture": full,
        "personal": {
            "title": "VALIDATE_PERSONAL_TITLE",
            "meta": "VALIDATE_PERSONAL_META",
            "summary": "VALIDATE_PERSONAL_SUMMARY",
            "limitations": "VALIDATE_PERSONAL_LIMITATION",
            "provenance": "VALIDATE_PERSONAL_PROVENANCE",
            "items": [
                {
                    "rank": 1,
                    "title": "VALIDATE_PERSONAL_ITEM",
                    "detail": "VALIDATE_PERSONAL_DETAIL",
                }
            ],
        }
        if full
        else None,
        "usage_footer": "VALIDATE_TOKEN_FOOTER" if full else "",
    }


@functools.lru_cache(maxsize=16)
def validate_template(source: str) -> None:
    """Compile and exercise required and optional layout branches offline."""
    template = _compile(source)
    for full in (False, True):
        context = _fixture_context(full=full)
        html = _render(template, context)
        parsed = _EmailHTML(
            frozenset(reference["url"] for reference in context["references"])
        )
        parsed.feed(html)
        visible = "".join(parsed.visible)
        required = [
            "VALIDATE_TITLE",
            "VALIDATE_INTRODUCTION",
            "VALIDATE_HEADING",
            "VALIDATE_PARAGRAPH",
            "VALIDATE_SOURCE",
        ]
        if full:
            required += [
                "VALIDATE_LIMITATION",
                "VALIDATE_CHART_QUESTION",
                "VALIDATE_CHART_CAPTION",
                "VALIDATE_CHART_METADATA",
                "VALIDATE_CHART_SOURCE",
                "VALIDATE_POINT",
                "VALIDATE_MISSING_REASON",
                "VALIDATE_CHART_LIMITATION",
                "VALIDATE_READING",
                "VALIDATE_PERSONAL_TITLE",
                "VALIDATE_PERSONAL_SUMMARY",
                "VALIDATE_PERSONAL_ITEM",
                "VALIDATE_PERSONAL_DETAIL",
                "VALIDATE_TOKEN_FOOTER",
            ]
            if (
                'src="cid:newsletter-chart"' not in html
                and "src='cid:newsletter-chart'" not in html
            ):
                raise TemplateValidationError(
                    "Email template must retain the frozen chart image"
                )
        if any(marker not in visible for marker in required):
            raise TemplateValidationError(
                "Email template omits required edition content"
            )
        if full and (
            visible.index("VALIDATE_PERSONAL_TITLE")
            < visible.index("VALIDATE_READING")
            or visible.index("VALIDATE_TOKEN_FOOTER")
            < visible.index("VALIDATE_PERSONAL_DETAIL")
        ):
            raise TemplateValidationError(
                "Email template must keep personal events and usage last"
            )


def render_template(source: str, context: dict[str, Any]) -> str:
    """Validate frozen source and render it under work and output budgets.

    The caller supplies only normalized, bounded render data. Invalid source,
    unsafe output, and exhausted budgets raise TemplateValidationError without
    including the template or its private context in the error.
    """
    validate_template(source)
    return _render(_compile(source), context)


def template_from_inputs(inputs: dict[str, Any]) -> str | None:
    """Read the frozen per-run snapshot, not the server's current pointer."""
    if "content_config" not in inputs:
        return None
    config = inputs["content_config"]
    if not isinstance(config, dict) or config.get("schema_version") != 1:
        raise TemplateValidationError(
            "Frozen email template configuration is incompatible"
        )
    files = config.get("files")
    if (
        not isinstance(files, dict)
        or type(files.get("templates/edition.html.j2")) is not str
    ):
        raise TemplateValidationError("Frozen email template is missing")
    return cast(str, files["templates/edition.html.j2"])
