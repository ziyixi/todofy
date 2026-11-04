"""Pure review parsing and evidence checks; no providers or durable writes."""

from collections.abc import Mapping
import dataclasses
from typing import cast
import urllib.parse as parse

import newsletter.contracts as contracts
import newsletter.errors as errors
import newsletter.model_io as model_io
import newsletter.types as types
import newsletter.workflow.components as components
import newsletter.workflow.feed_excerpts as feed_excerpts
import newsletter.workflow.types as newsletter_workflow_types


@dataclasses.dataclass(frozen=True)
class ReviewEvidence:
    """Code-observed sources and job identities for one reviewer invocation.

    ``excerpts`` maps a citation to its outlet for code-built feed excerpts
    that still match the sha256 pinned at fetch time.
    """

    sources: types.Payload
    opened: set[str]
    searched: bool
    round_name: str
    writer_job: str
    reviewer_job: str
    excerpts: Mapping[str, str] = dataclasses.field(default_factory=dict)


def _pinned(
    component: types.Payload, name: str, evidence: ReviewEvidence
) -> dict[str, str]:
    """Return the cited pinned excerpts a signal may treat as read."""
    if name != "signal":
        return {}
    return {
        ref: evidence.excerpts[ref]
        for ref in components.component_citations(component, name)
        if ref in evidence.excerpts
    }


def valid_strings(value: object) -> bool:
    """Check the bounded string-list shape accepted from a reviewer."""
    return (
        isinstance(value, list)
        and len(value) <= 16
        and all(isinstance(s, str) and len(s) <= 2000 for s in value)
    )


def parse_review(text: str) -> types.Payload:
    """Validate the outer model envelope before interpreting any approval."""
    review = model_io.load_json(text)
    if not isinstance(review, dict) or set(review) not in (
        {"assessments", "issues"},
        {"assessments", "issues", "prior_withdrawal"},
    ):
        raise errors.EditorError("invalid_output")
    records, issues = review["assessments"], review["issues"]
    if (
        not isinstance(records, list)
        or len(records) != 4
        or not isinstance(issues, list)
        or len(issues) > 24
    ):
        raise errors.EditorError("invalid_output")
    return review


def _evidence_findings(
    component: types.Payload, name: str, evidence: ReviewEvidence
) -> tuple[list[str], newsletter_workflow_types.ReviewIssue | None]:
    sources, opened = evidence.sources, evidence.opened
    searched, round_name = evidence.searched, evidence.round_name
    refs = components.component_citations(component, name)
    # Every other citation keeps the must-open rule.
    pinned = _pinned(component, name, evidence)
    required = [ref for ref in refs if ref not in pinned]
    required_urls = {
        parse.urldefrag(sources[ref]["url"])[0] for ref in required
    }
    missing_urls = sorted(required_urls - opened)
    metadata_refs = [
        ref for ref in refs if sources[ref]["access_scope"] == "metadata"
    ]
    checks: list[tuple[str, list[str], str]] = []
    if not searched:
        checks.append(
            (
                "missing_review_search: 未观测到本轮公开搜索，不能批准此组件。",
                [],
                "research",
            )
        )
    if not refs:
        checks.append(
            (
                "missing_review_citations: 此组件没有可核对的引用来源。",
                [],
                "research",
            )
        )
    if pinned and not required and len(set(pinned.values())) < 2:
        checks.append(
            (
                "single_outlet_excerpt_signal: 一家媒体的冻结摘要不能单独确认"
                "事件；须再引用另一家媒体的摘要或本轮打开的原文。",
                list(pinned)[:16],
                "research",
            )
        )
    if missing_urls:
        missing_refs = [
            ref
            for ref in required
            if parse.urldefrag(sources[ref]["url"])[0] not in opened
        ]
        details = [
            url
            if len(url) <= 1800
            else "URL过长，请按引用ID读取材料中完整source.url"
            for url in missing_urls[:4]
        ]
        checks.extend(
            (
                "missing_review_open_url: " + url,
                missing_refs[:16],
                "research",
            )
            for url in details
        )
        if len(missing_urls) > 4:
            checks.append(
                (
                    "missing_review_open_urls_remaining: "
                    f"还有{len(missing_urls) - 4}个来源未独立打开，"
                    "请逐项核对材料完整URL。",
                    missing_refs[:16],
                    "research",
                )
            )
    if metadata_refs:
        checks.append(
            (
                "metadata_citations_not_publishable: "
                + ", ".join(metadata_refs[:8])
                + (
                    "。只可使用已实际读取的非metadata证据，不能抬高"
                    "access_scope；无法支持的出版信息或细节应省略。"
                ),
                metadata_refs[:16],
                "remove",
            )
        )
    if not checks:
        return [], None
    issue: newsletter_workflow_types.ReviewIssue = {
        "round": round_name,
        "component": name,
        "claim": "",
        "reason": "; ".join(
            dict.fromkeys(message.split(":", 1)[0] for message, _, _ in checks)
        )
        + "。详见本组件findings中的精确URL和引用IDs。",
        "evidence": list(
            dict.fromkeys(ref for _, evidence, _ in checks for ref in evidence)
        )[:16],
        "action": "remove" if metadata_refs else "research",
    }
    return [message for message, _, _ in checks], issue


def assess_component(
    record: types.Payload,
    value: types.Payload,
    seen: set[str],
    evidence: ReviewEvidence,
) -> tuple[
    newsletter_workflow_types.Assessment,
    newsletter_workflow_types.ReviewIssue | None,
]:
    """Bind a component approval to the exact content and observed evidence."""
    opened = evidence.opened
    searched, round_name = evidence.searched, evidence.round_name
    writer_job, job = evidence.writer_job, evidence.reviewer_job
    if (
        not isinstance(record, dict)
        or set(record) != {"component", "status", "findings"}
        or not isinstance(record["component"], str)
        or record["component"] not in components.COMPONENTS
        or record["component"] in seen
        or not isinstance(record["status"], str)
        or record["status"] not in {"approved", "blocked", "not_present"}
        or not valid_strings(record["findings"])
    ):
        raise errors.EditorError("invalid_output")
    name = record["component"]
    seen.add(name)
    component = components.component_content(
        value["content"], value["signal"], name
    )
    status = cast(newsletter_workflow_types.AssessmentStatus, record["status"])
    findings = list(record["findings"])
    if component is None:
        status = "not_present"
    elif status == "not_present":
        status = "blocked"
        findings.append("Review omitted a present component.")
    issue = None
    if component is not None and status == "approved":
        evidence_findings, issue = _evidence_findings(component, name, evidence)
        if issue is not None:
            status = "blocked"
            findings.extend(evidence_findings)
    assessment: newsletter_workflow_types.Assessment = {
        "round": round_name,
        "component": name,
        "status": status,
        "findings": findings,
        "content_hash": contracts.content_hash(component)
        if component is not None
        else "",
        "searched": searched,
        "opened": bool(opened),
        "opened_urls": sorted(opened),
        "writer_job_id": writer_job,
        "reviewer_job_id": job,
    }
    if component is not None and (pinned := _pinned(component, name, evidence)):
        # The receipt binds each excerpt read from its frozen text, not from
        # an observed open, to the exact text's sha256.
        assessment["excerpts"] = sorted(
            (
                {
                    "url": evidence.sources[ref]["url"],
                    "sha256": feed_excerpts.digest(
                        evidence.sources[ref]["excerpt"]
                    ),
                    "outlet": outlet,
                }
                for ref, outlet in pinned.items()
            ),
            key=lambda item: (item["url"], item["sha256"]),
        )
    return assessment, issue


def apply_issues(
    issues: list[types.Payload],
    output: newsletter_workflow_types.ReviewReceipt,
    round_name: str,
    sources: types.Payload,
) -> None:
    """Retain factual issues and block contradictory component approvals."""
    for issue in issues:
        if (
            not isinstance(issue, dict)
            or set(issue)
            != {"component", "claim", "reason", "evidence", "action"}
            or not isinstance(issue["component"], str)
            or issue["component"] not in components.COMPONENTS
            or not isinstance(issue["action"], str)
            or issue["action"]
            not in {"correct", "remove", "clarify", "research"}
            or not all(
                isinstance(issue[name], str) and len(issue[name]) <= 2000
                for name in ("claim", "reason")
            )
            or not valid_strings(issue["evidence"])
            or any(ref not in sources for ref in issue["evidence"])
        ):
            raise errors.EditorError("invalid_output")
        output["issues"].append(
            {
                "component": issue["component"],
                "claim": issue["claim"],
                "reason": issue["reason"],
                "evidence": issue["evidence"],
                "action": issue["action"],
                "round": round_name,
            }
        )
        for assessment in output["assessments"]:
            if (
                assessment["component"] == issue["component"]
                and assessment["status"] == "approved"
            ):
                assessment["status"] = "blocked"
                assessment["findings"].append(
                    "Component still has an unresolved factual issue."
                )
