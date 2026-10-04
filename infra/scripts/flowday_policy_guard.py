"""Check actual FlowDay rules while provider 5.25 cannot round-trip an empty login_method selector."""

from __future__ import annotations

GITHUB = "cloudflare_zero_trust_access_identity_provider.github[0]"
PREFIX = "cloudflare_zero_trust_access_policy.flowday"


def matches(policy: object, name: str, emails: list[str], github_id: str) -> bool:
    if not isinstance(policy, dict) or policy.get("require") or policy.get("exclude"):
        return False
    rules = policy.get("include")
    if name == "flowday-bypass":
        return policy.get("decision") == "bypass" and rules == [{"everyone": {}}]
    if policy.get("decision") != "allow" or not isinstance(rules, list):
        return False
    expected = [{"login_method": {"id": github_id}}, *({"email": {"email": email}} for email in emails)]
    return len(rules) == len(expected) and all(rule in rules for rule in expected)


def verify(plan: dict, values: dict, fetch) -> list[str]:
    resources = plan.get("planned_values", {}).get("root_module", {}).get("resources", [])
    actual = {item.get("address"): item.get("values", {}) for item in resources}
    github_id = actual.get(GITHUB, {}).get("id") or values.get("access_github_idp_id")
    problems = []
    for name in ("flowday", "flowday-bypass"):
        address = PREFIX + '["' + name + '"]'
        identifier = actual.get(address, {}).get("id")
        if not identifier:
            continue  # A fresh create has no live object to compare yet; its verify plan will check it.
        policy = fetch("/accounts/" + values["account_id"] + "/access/policies/" + identifier)
        if not matches(policy, name, values["access_owner_emails"], github_id):
            problems.append("FLOWDAY_INCLUDE_MISMATCH:" + name)
    return problems
