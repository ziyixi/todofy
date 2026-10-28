"""Pin the single K3s node to one fixed host-local address that never follows DHCP.

Without node-ip, K3s takes the node and API endpoint address from the default route once, at
startup. A later DHCP lease leaves the Node InternalIP and default/kubernetes on an address the host
no longer has: host kubectl on 127.0.0.1 still works, every in-cluster client fails. A dummy
interface holds one fixed /32 instead. Nothing outside the host routes to it, and Pod egress still
masquerades through whatever the default route is at the time.
"""

import argparse
import ipaddress
import json
import os
import platform
import time
from pathlib import Path

import cluster
import host
from runner import command

from config import BootstrapError, load_bundle, read_json, require

INTERFACE = "pcloud0"
# One RFC 1918 /32 outside K3s's 10.42/16 Pod and 10.43/16 Service CIDRs, Docker's default pools
# (172.17-31/16, then 192.168/16), the shared CGNAT/Tailscale range 100.64/10, link-local, and the
# 192.168/16 and low 10.x networks home routers hand out. The last octet avoids the usual .1/.254
# gateway: even a LAN that someday uses 10.254/16 could lose one peer, never its router.
ADDRESS = "10.254.0.42"
UNIT = "personal-cloud-node-address.service"
NETWORK_MANAGER = "networkmanager-node-address.conf"
# Appended to the K3s configuration; node-external-ip stays unset, so no LAN address is advertised.
SETTINGS = {
    "node-ip": ADDRESS,
    "advertise-address": ADDRESS,
    "flannel-iface": INTERFACE,
}
K3S_DEPENDENCY = "Requires=" + UNIT + "\nAfter=" + UNIT + "\n"
FIREWALL_DESTINATION = " -d " + ADDRESS + "/32"
# Create-or-keep, exact address, link up. numdummies=0 avoids a stray dummy0 when the module first
# loads. No ExecStop: stopping the unit never removes the address.
UNIT_TEXT = f"""[Unit]
Description=Personal cloud fixed K3s node address
Before=k3s.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/modprobe dummy numdummies=0
ExecStart=-/usr/sbin/ip link add {INTERFACE} type dummy
ExecStart=/usr/sbin/ip address replace {ADDRESS}/32 dev {INTERFACE}
ExecStart=/usr/sbin/ip link set dev {INTERFACE} up
[Install]
WantedBy=multi-user.target
"""
NETWORK_MANAGER_TEXT = f"""[device-personal-cloud-node-address]
match-device=interface-name:{INTERFACE}
managed=0
"""
SYSTEMD = Path("/etc/systemd/system")
K3S = Path("/etc/rancher/k3s")
NETWORK_MANAGER_DIRECTORY = Path("/etc/NetworkManager/conf.d")
# Embedded etcd stores peer URLs by address; this single node uses the default SQLite datastore.
ETCD = Path("/var/lib/rancher/k3s/server/db/etcd")
DEADLINE = 180
# Runs inside the daemon's own container: the same identity, DNS name, Service NAT and firewall
# path as its normal client. It prints nothing and reads one control ConfigMap it may already read.
PROBE = """
import http.client, os, ssl, sys
root = "/var/run/secrets/kubernetes.io/serviceaccount/"
token = open(os.environ.get("KUBERNETES_TOKEN_FILE", root + "token")).read().strip()
context = ssl.create_default_context(cafile=os.environ.get("KUBERNETES_CA_FILE", root + "ca.crt"))
connection = http.client.HTTPSConnection("kubernetes.default.svc", 443, context=context, timeout=5)
path = "/api/v1/namespaces/" + sys.argv[1] + "/configmaps/platform-release"
connection.request("GET", path, headers={"Authorization": "Bearer " + token})
sys.exit(connection.getresponse().status != 200)
"""


def event(phase, status):
    print(
        json.dumps({"event": "node_address", "phase": phase, "status": status}),
        flush=True,
    )


def k3s_files():
    """Bundle file, installed path and mode, as cluster.start and recover write them."""
    return (
        ("k3s.service", SYSTEMD / "k3s.service", 0o644),
        ("k3s-config.yaml", K3S / "config.yaml", 0o600),
        ("firewall.v4", K3S / "firewall.v4", 0o600),
        ("firewall.v6", K3S / "firewall.v6", 0o600),
    )


def legacy(name, content):
    """The same bundle file as rendered before this address; hosts installed earlier hold it."""
    if name == "k3s-config.yaml":
        value = json.loads(content)
        require(
            isinstance(value, dict)
            and all(value.get(key) == item for key, item in SETTINGS.items()),
            "NODE_ADDRESS_BUNDLE_INVALID",
        )
        kept = {key: item for key, item in value.items() if key not in SETTINGS}
        return (json.dumps(kept, indent=2) + "\n").encode()
    markers = {"k3s.service": K3S_DEPENDENCY, "firewall.v4": FIREWALL_DESTINATION}
    if name not in markers:
        return content
    marker = markers[name].encode()
    require(marker in content, "NODE_ADDRESS_BUNDLE_INVALID")
    return content.replace(marker, b"")


def accepted(name, current, desired):
    """The bundle's host file, or exactly its pre-address form; any other change needs review."""
    return current in (desired, legacy(name, desired))


def own_files(bundle):
    """This address's systemd unit and, where NetworkManager runs, its unmanaged-device drop-in."""
    listed = read_json(Path(bundle) / "manifest.json")["files"]
    files = [(UNIT, SYSTEMD / UNIT)]
    if host.real_path(NETWORK_MANAGER_DIRECTORY).is_dir():
        files.append(
            (
                NETWORK_MANAGER,
                NETWORK_MANAGER_DIRECTORY / "personal-cloud-node-address.conf",
            )
        )
    selected = []
    for name, destination in files:
        require("units/" + name in listed, "BUNDLE_FILES_MISSING")
        selected.append((destination, (Path(bundle) / "units" / name).read_bytes()))
    return selected


def ip_links(argv):
    """iproute2 JSON for the queried links, or None when the named link does not exist."""
    result = command(argv, check=False)
    if result.returncode:
        return None
    try:
        value = json.loads(result.stdout)
    except ValueError:
        raise BootstrapError("NODE_ADDRESS_STATUS_INVALID") from None
    require(isinstance(value, list), "NODE_ADDRESS_STATUS_INVALID")
    return value


def interface():
    """None when absent; otherwise its kind, UP flag and IPv4 interface addresses."""
    links = ip_links(["ip", "-j", "-d", "address", "show", "dev", INTERFACE])
    if links is None:
        return None
    require(len(links) == 1, "NODE_ADDRESS_STATUS_INVALID")
    link = links[0]
    return {
        "kind": link.get("linkinfo", {}).get("info_kind"),
        "up": "UP" in link.get("flags", []),
        "addresses": sorted(
            item["local"] + "/" + str(item["prefixlen"])
            for item in link.get("addr_info", [])
            if item.get("family") == "inet"
        ),
    }


def ready():
    state = interface()
    return (
        state is not None
        and state["kind"] == "dummy"
        and state["up"]
        and state["addresses"] == [ADDRESS + "/32"]
    )


def preflight(bundle, *, restore=False):
    """No writes: the interface is ours or absent, and no other network contains the address."""
    require(not ETCD.exists(), "NODE_ADDRESS_ETCD_UNSUPPORTED")
    for destination, content in own_files(bundle):
        destination = host.real_path(destination)
        if destination.exists() and not restore:
            require(
                destination.is_file() and destination.read_bytes() == content,
                "NODE_ADDRESS_UNIT_CONFLICT",
            )
    state = interface()
    require(
        state is None
        or (state["kind"] == "dummy" and set(state["addresses"]) <= {ADDRESS + "/32"}),
        "NODE_ADDRESS_INTERFACE_CONFLICT",
    )
    links = ip_links(["ip", "-j", "-4", "address", "show"])
    require(links is not None, "NODE_ADDRESS_STATUS_INVALID")
    fixed = ipaddress.ip_address(ADDRESS)
    for link in links:
        if link.get("ifname") == INTERFACE:
            continue
        for item in link.get("addr_info", []):
            if item.get("family") == "inet":
                network = ipaddress.ip_interface(
                    item["local"] + "/" + str(item["prefixlen"])
                ).network
                require(fixed not in network, "NODE_ADDRESS_CONFLICT")


def install(bundle, *, restore=False):
    """Write the unit, then create-or-keep the address before K3s needs it."""
    for destination, content in own_files(bundle):
        host.write_file(destination, content, mode=0o644, replace=restore)
    command(["systemctl", "daemon-reload"])
    command(["systemctl", "enable", UNIT], timeout=30)
    command(["systemctl", "start", UNIT], timeout=30)
    if not ready():
        # Active from an earlier run but the address was removed by hand: apply it again.
        command(["systemctl", "restart", UNIT], timeout=30)
        require(ready(), "NODE_ADDRESS_UNAVAILABLE")


def succeeds(check):
    """A check that times out while K3s restarts is simply not true yet."""
    try:
        return check()
    except BootstrapError:
        return False


def until(check, code):
    deadline = time.monotonic() + DEADLINE
    while time.monotonic() < deadline:
        if succeeds(check):
            return
        time.sleep(2)
    raise BootstrapError(code)


def json_output(result):
    if result.returncode or len(result.stdout) > 1024 * 1024:
        return None
    try:
        value = json.loads(result.stdout)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def advertised(node_name):
    """Node InternalIP and the API Service endpoints both name only the fixed address."""
    node = json_output(
        cluster.kubectl(
            ["get", "node", node_name, "-o", "json"], check=False, timeout=10
        )
    )
    slices = json_output(
        cluster.kubectl(
            [
                "-n",
                "default",
                "get",
                "endpointslices",
                "-l",
                "kubernetes.io/service-name=kubernetes",
                "-o",
                "json",
            ],
            check=False,
            timeout=10,
        )
    )
    if node is None or slices is None:
        return False
    internal = [
        item.get("address")
        for item in node.get("status", {}).get("addresses", [])
        if item.get("type") == "InternalIP"
    ]
    endpoints, ports = set(), set()
    for item in slices.get("items", []):
        for endpoint in item.get("endpoints") or []:
            endpoints.update(endpoint.get("addresses", []))
        ports.update(port.get("port") for port in item.get("ports") or [])
    return internal == [ADDRESS] and endpoints == {ADDRESS} and ports == {6443}


def api_ready():
    return (
        cluster.kubectl(["get", "--raw=/readyz"], check=False, timeout=10).returncode
        == 0
    )


def wait_cluster(node_name):
    until(api_ready, "NODE_ADDRESS_CLUSTER_UNAVAILABLE")
    until(lambda: advertised(node_name), "NODE_ADDRESS_NOT_ADVERTISED")


def in_cluster_read(namespace):
    """The daemon reaches https://kubernetes.default.svc from its own Pod, as in normal releases."""

    def probe():
        result = cluster.kubectl(
            [
                "-n",
                namespace,
                "exec",
                "deployment/platform-runtime",
                "-c",
                "platform-runtime",
                "--",
                "python",
                "-I",
                "-B",
                "-c",
                PROBE,
                namespace,
            ],
            check=False,
            timeout=30,
        )
        return result.returncode == 0

    until(probe, "NODE_ADDRESS_IN_CLUSTER_READ_FAILED")


def supported():
    require(platform.system() == "Linux", "PLATFORM_UNSUPPORTED")
    distribution = platform.freedesktop_os_release()
    require(
        distribution.get("ID") == "ubuntu"
        and distribution.get("VERSION_ID") == "24.04",
        "DISTRIBUTION_UNSUPPORTED",
    )


def reviewed(bundle):
    """Root on an installed host, this bundle's own script, and only reviewed K3s host files."""
    require(os.geteuid() == 0, "ROOT_REQUIRED_FOR_NODE_ADDRESS")
    supported()
    public = load_bundle(bundle)
    require(
        Path(__file__).resolve()
        == (Path(bundle) / "installer/node_address.py").resolve(),
        "NODE_ADDRESS_SCRIPT_NOT_IN_BUNDLE",
    )
    require(host.completion_marker() is not None, "NODE_ADDRESS_HOST_NOT_INSTALLED")
    files = []
    for name, destination, mode in k3s_files():
        desired = (Path(bundle) / "units" / name).read_bytes()
        destination = host.real_path(destination)
        require(
            destination.is_file() and accepted(name, destination.read_bytes(), desired),
            "NODE_ADDRESS_HOST_CONFIGURATION_REVIEW_REQUIRED",
        )
        files.append((name, destination, desired, mode))
    return public, files


def restart_k3s(planned):
    for path, content, mode in planned:
        host.write_file(path, content, mode=mode, replace=True)
    command(["systemctl", "daemon-reload"])
    # KillMode=process: existing containers keep running while K3s restarts.
    command(["systemctl", "restart", "k3s.service"], timeout=120)
    event("k3s", "restarted")


def migrate(bundle):
    """Move an installed host onto the fixed address with one K3s restart; repeat runs verify only."""
    public, files = reviewed(bundle)
    preflight(bundle)
    event("inputs", "verified")
    install(bundle)
    event("interface", "ready")
    node_name = public["profile"]["observer_node_key"]
    planned = [(path, desired, mode) for _, path, desired, mode in files]
    # Written files with K3s still on the old address (an interrupted run) also restart.
    restarted = any(path.read_bytes() != content for path, content, _ in planned)
    restarted = restarted or not succeeds(lambda: advertised(node_name))
    if restarted:
        restart_k3s(planned)
    wait_cluster(node_name)
    event("cluster", "advertised")
    in_cluster_read(public["profile"]["namespace"])
    return {
        "event": "node_address",
        "status": "stable",
        "interface": INTERFACE,
        "address": ADDRESS,
        "restarted": restarted,
    }


def rollback(bundle):
    """Restore the DHCP-derived K3s files; the unused unit and interface stay."""
    _, files = reviewed(bundle)
    event("inputs", "verified")
    planned = [
        (path, legacy(name, desired), mode) for name, path, desired, mode in files
    ]
    restarted = any(path.read_bytes() != content for path, content, _ in planned)
    if restarted:
        restart_k3s(planned)
    until(api_ready, "NODE_ADDRESS_CLUSTER_UNAVAILABLE")
    return {"event": "node_address", "status": "rolled_back", "restarted": restarted}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument(
        "--rollback",
        action="store_true",
        help="restore the previous DHCP-derived K3s configuration and restart K3s once",
    )
    args = parser.parse_args()
    try:
        result = rollback(args.bundle) if args.rollback else migrate(args.bundle)
        print(json.dumps(result), flush=True)
        return 0
    except BootstrapError as error:
        code = str(error)
    except (OSError, ValueError, KeyError, TypeError):
        code = "NODE_ADDRESS_INPUT_OR_STATE_INVALID"
    print(json.dumps({"event": "node_address", "status": "failed", "error_code": code}))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
