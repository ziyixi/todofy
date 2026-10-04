"""Read only the exact legacy objects selected by the committed/private inventory."""

from __future__ import annotations

from cloud_api import request
from private_input import BootstrapError
from flowday_policy_guard import matches

GITHUB = "cloudflare_zero_trust_access_identity_provider.github[0]"
EMAIL = "cloudflare_zero_trust_access_identity_provider.email[0]"
MAIL_RULE = "cloudflare_email_routing_rule.mail_hero[0]"


def prepare(private: dict, resources: dict, zone: str, mode: str, fetch=request) -> None:
    values = private.get("infra_values")
    if not isinstance(values, dict):
        raise BootstrapError("INFRA_PRIVATE_INPUT_INVALID")
    if mode == "fresh":
        oauth = values.get("access_github_oauth", {})
        if not isinstance(oauth, dict) or not oauth.get("client_id") or not oauth.get("client_secret"):
            raise BootstrapError("GITHUB_OAUTH_INPUT_REQUIRED")
        values.setdefault("legacy_mail_hero_backup", False)
        values.setdefault("mail_route_ready", False)
        address = values.get("mail_receive_address", private.get("github_secrets", {}).get("MAIL_HERO_RECEIVE_ADDRESS", ""))
        validate_address(address, zone)
        values["mail_receive_address"] = address
        return
    token, account = private["cloudflare_api_token"], values["account_id"]
    imports = {**resources.get("managed_ids", {}), **private.get("adopt_ids", {})}
    github_id = imports.get(GITHUB, values.get("access_github_idp_id"))
    if not github_id:
        raise BootstrapError("ADOPT_GITHUB_ID_REQUIRED")
    github = fetch(token, f"/accounts/{account}/access/identity_providers/{github_id}")
    if github.get("type") != "github" or not github.get("config", {}).get("client_id"):
        raise BootstrapError("ADOPT_GITHUB_IDENTITY_MISMATCH")
    oauth = dict(values.get("access_github_oauth") or {})
    oauth.update({"client_id": github["config"]["client_id"], "name": github["name"]})
    values["access_github_oauth"] = oauth
    imports[GITHUB] = github_id
    email_id = imports.get(EMAIL)
    allowed = [email_id] if email_id else [item for item in values.get("access_allowed_idp_ids", []) if item != github_id]
    matches = []
    for identifier in allowed:
        email = fetch(token, f"/accounts/{account}/access/identity_providers/{identifier}")
        if email.get("type") == "onetimepin":
            matches.append((identifier, email.get("name")))
    if len(matches) != 1 or not isinstance(matches[0][1], str):
        raise BootstrapError("ADOPT_EMAIL_IDENTITY_AMBIGUOUS")
    imports[EMAIL], values["access_email_idp_name"] = matches[0]
    names, options = {}, {}
    for name in ("flowday", "flowday-bypass"):
        address = 'cloudflare_zero_trust_access_policy.flowday["' + name + '"]'
        identifier = imports.get(address, resources.get("referenced_policy_ids", {}).get(name))
        if not identifier:
            raise BootstrapError("ADOPT_FLOWDAY_POLICY_ID_REQUIRED")
        policy = fetch(token, f"/accounts/{account}/access/policies/{identifier}")
        _flowday_shape(policy, name, values, github_id)
        names[name] = policy["name"]
        options[name] = {"session_duration": policy.get("session_duration"), "connection_rules": policy.get("connection_rules")}
        imports[address] = identifier
    values["flowday_policy_names"] = names
    values["flowday_policy_options"] = options
    if MAIL_RULE in imports:
        rule = fetch(token, "/zones/" + resources["zone_id"] + "/email/routing/rules/" + imports[MAIL_RULE])
        if (rule.get("actions") != [{"type": "worker", "value": ["mail-hero"]}]
                or len(rule.get("matchers", [])) != 1 or rule.get("enabled") is not True
                or rule.get("priority") != 0 or rule.get("source", "api") != "api"):
            raise BootstrapError("ADOPT_MAIL_RULE_MISMATCH")
        matcher = rule["matchers"][0]
        if matcher.get("type") != "literal" or matcher.get("field") != "to":
            raise BootstrapError("ADOPT_MAIL_RULE_MISMATCH")
        validate_address(matcher.get("value"), zone)
        values.update({"mail_route_ready": True, "mail_receive_address": matcher["value"], "mail_route_name": rule["name"]})
    private["adopt_ids"] = imports


def validate_address(address: object, zone: str) -> None:
    if (not isinstance(address, str) or address.count("@") != 1
            or not address.endswith("@inbox." + zone) or not address.split("@", 1)[0]
            or any(c.isspace() for c in address)):
        raise BootstrapError("RECEIVE_ADDRESS_REQUIRES_DEDICATED_SUBDOMAIN")


def _flowday_shape(policy: dict, name: str, values: dict, github_id: str) -> None:
    if (not isinstance(policy, dict) or not isinstance(policy.get("name"), str)
            or not matches(policy, name, values["access_owner_emails"], github_id)):
        raise BootstrapError("ADOPT_FLOWDAY_POLICY_MISMATCH")
