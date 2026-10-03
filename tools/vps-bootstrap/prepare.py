"""Render public bootstrap resources from one verified commit and two immutable images."""

import argparse
import ast
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools/vps-release"))
from firewall import rules
from release_identity import verified_images
from render import render

from config import BootstrapError, checksum, require

CONTROLLED = {
    "NEWSLETTER_DATA_DIR",
    "CODEX_HOME",
    "NEWSLETTER_CODEX_HOME",
    "NEWSLETTER_CONTENT_CONFIG_DIR",
    "NEWSLETTER_BOOTSTRAP_DRAIN_KEY",
    "NEWSLETTER_RELEASE_REQUEST_ID",
}


def allowed_keys(root):
    tree = ast.parse((root / "newsletter/src/newsletter/settings.py").read_text())
    names = set()
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Call)
            and node.args
            and isinstance(node.args[0], ast.Constant)
        ):
            function = node.func
            accepted = isinstance(function, ast.Name) and function.id in {
                "_number_env",
                "_boolean_env",
            }
            accepted |= (
                isinstance(function, ast.Attribute) and function.attr == "getenv"
            )
            name = node.args[0].value
            if accepted and isinstance(name, str) and name.isupper():
                names.add(name)
    blocked = {"PATH", "HOME", "PYTHONPATH", "OPENAI_API_KEY"} | CONTROLLED
    names = {
        name for name in names if name not in blocked and not name.startswith("LD_")
    }
    return {
        "newsletter": sorted(names),
        "trigger": [
            "NEWSLETTER_EDITOR_TOKEN",
            "NEWSLETTER_SEND_TOKEN",
            "NEWSLETTER_TIME_ZONE",
        ],
        "platform": ["PLATFORM_DEPLOY_TOKEN"],
        "controlled": sorted(CONTROLLED),
    }


def foundation(root, profile):
    import yaml

    items = []
    for name in (
        "namespace.yaml",
        "rbac.yaml",
        "storage.yaml",
    ):
        items.extend(
            yaml.safe_load_all((root / "platform/k3s/bootstrap" / name).read_text())
        )
    namespace = profile["vps"]["namespace"]
    state_root = profile["vps"]["state_root"]
    for item in items:
        if item["kind"] == "Namespace":
            item["metadata"]["name"] = namespace
        if "namespace" in item["metadata"]:
            item["metadata"]["namespace"] = namespace
        for subject in item.get("subjects", []):
            subject["namespace"] = namespace
        if item["kind"] == "PersistentVolume":
            item["spec"]["claimRef"]["namespace"] = namespace
            item["spec"]["hostPath"]["path"] = item["spec"]["hostPath"]["path"].replace(
                "/srv/todofy/", state_root + "/", 1
            )
    return {"apiVersion": "v1", "kind": "List", "items": items}


def prepare(root, sha, images, output):
    profile, _ = verified_images(root, sha, images)
    require(not output.exists(), "OUTPUT_ALREADY_EXISTS")
    runtime = render(root, sha, images)
    for item in runtime["items"]:
        if item["kind"] == "CronJob" and item["metadata"]["name"] == "newsletter-daily":
            item["spec"]["suspend"] = True
    output.mkdir(parents=True)
    (output / "units").mkdir()

    def write(name, value):
        (output / name).write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")

    write("foundation.json", foundation(root, profile))
    write("runtime.json", runtime)
    write("allowedkeys.json", allowed_keys(root))
    shutil.copyfile(root / "platform/versions.json", output / "versions.json")
    templates = {
        "k3s.service": """[Unit]
Description=Personal cloud K3s server
Wants=network-online.target
After=network-online.target
[Service]
Type=notify
ExecStartPre=-/usr/sbin/iptables -w 5 -D INPUT -j PCLOUD-K3S
ExecStartPre=/usr/sbin/iptables-restore --noflush --wait 5 /etc/rancher/k3s/firewall.v4
ExecStartPre=-/usr/sbin/ip6tables -w 5 -D INPUT -j PCLOUD-K3S
ExecStartPre=/usr/sbin/ip6tables-restore --noflush --wait 5 /etc/rancher/k3s/firewall.v6
ExecStart=/usr/local/bin/k3s server --config /etc/rancher/k3s/config.yaml
Restart=always
RestartSec=5
Delegate=yes
KillMode=process
LimitNOFILE=1048576
TasksMax=infinity
[Install]
WantedBy=multi-user.target
""",
        "k3s-config.yaml": json.dumps(
            {
                "disable": ["traefik", "servicelb"],
                "secrets-encryption": True,
                "write-kubeconfig-mode": "0600",
                "node-name": profile["vps"]["observer_node_key"],
                "cluster-cidr": "10.42.0.0/16",
                "bind-address": "0.0.0.0",
            },
            indent=2,
        )
        + "\n",
        "cloudflared-platform.service": """[Unit]
Description=Personal cloud runtime Cloudflare Tunnel
Wants=network-online.target
After=network-online.target k3s.service
[Service]
Type=notify
TimeoutStartSec=15
DynamicUser=true
LoadCredential=connector-token:/etc/cloudflared/platform-token
ExecStart=@CLOUDFLARED@ --no-autoupdate tunnel run --token-file %d/connector-token
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
[Install]
WantedBy=multi-user.target
""",
    }
    for name, text in templates.items():
        (output / "units" / name).write_text(text)
    for name, ipv6 in (("firewall.v4", False), ("firewall.v6", True)):
        (output / "units" / name).write_bytes(rules(ipv6, include_jump=True))
    (output / "installer").mkdir()
    for path in Path(__file__).parent.glob("*.py"):
        if path.name != "prepare.py":
            shutil.copyfile(path, output / "installer" / path.name)
    files = {
        path.relative_to(output).as_posix(): checksum(path)
        for path in sorted(output.rglob("*"))
        if path.is_file()
    }
    write(
        "manifest.json",
        {
            "schema_version": 1,
            "source_sha": sha,
            "images": images,
            "files": files,
            "profile": {
                **{
                    key: profile["vps"][key]
                    for key in ("namespace", "state_root", "observer_node_key")
                },
                "fleet_host": profile["platform_hostname"],
                "runtime_host": profile["vps"]["platform_runtime_host"],
                "repository": profile["repository"],
            },
        },
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--newsletter-image", required=True)
    parser.add_argument("--platform-image", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        prepare(
            ROOT,
            args.sha,
            {"newsletter": args.newsletter_image, "platform": args.platform_image},
            args.output,
        )
    except (BootstrapError, OSError, ValueError, KeyError):
        print(json.dumps({"event": "bootstrap_prepare", "status": "failed"}))
        return 1
    print(json.dumps({"event": "bootstrap_prepare", "status": "prepared"}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
