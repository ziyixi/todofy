"""Synthetic fixed node address and DNS: files, firewall, migration, recovery; no host writes."""

import contextlib
import io
import ipaddress
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import Mock, patch

ROOT = Path(__file__).absolute().parents[3]
sys.path.insert(0, str(ROOT / "tools/vps-bootstrap"))

import firewall
import host
import node_address
import prepare
import recover

import config

SHA = "a" * 40
IMAGES = {
    "newsletter": "ghcr.io/ziyixi/todofy-newsletter@sha256:" + "b" * 64,
    "platform": "ghcr.io/ziyixi/todofy-platform@sha256:" + "c" * 64,
}
# Synthetic DHCP address (TEST-NET-1); the fixed address must not depend on it.
LAN = "192.0.2.10"
UNIT = node_address.UNIT
# Exactly what bundles rendered before the fixed address installed on existing hosts.
LEGACY_K3S_UNIT = """[Unit]
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
"""
LEGACY_FIREWALL_V4 = """*filter
:PCLOUD-K3S - [0:0]
-F PCLOUD-K3S
-A PCLOUD-K3S -p tcp -m multiport --dports 6443,10250 -i lo -m comment --comment personal-cloud-bootstrap -j ACCEPT
-A PCLOUD-K3S -p tcp -m multiport --dports 6443,10250 -i cni0 -s 10.42.0.0/16 -m comment --comment personal-cloud-bootstrap -j ACCEPT
-A PCLOUD-K3S -p tcp -m multiport --dports 6443,10250 -m comment --comment personal-cloud-bootstrap -j DROP
-A PCLOUD-K3S -p udp --dport 8472 -i lo -m comment --comment personal-cloud-bootstrap -j ACCEPT
-A PCLOUD-K3S -p udp --dport 8472 -i cni0 -s 10.42.0.0/16 -m comment --comment personal-cloud-bootstrap -j ACCEPT
-A PCLOUD-K3S -p udp --dport 8472 -m comment --comment personal-cloud-bootstrap -j DROP
-I INPUT 1 -j PCLOUD-K3S
-A PCLOUD-K3S -m comment --comment personal-cloud-bootstrap -j RETURN
COMMIT
"""


def verdict(ruleset, *, interface, source, destination, protocol, port):
    """First matching PCLOUD-K3S rule for one inbound packet, as iptables evaluates it."""
    for line in ruleset.decode().splitlines():
        if not line.startswith("-A " + firewall.CHAIN + " "):
            continue
        words = line.split()
        option = {
            words[index]: words[index + 1]
            for index in range(len(words) - 1)
            if words[index].startswith("-")
        }
        ports = option.get("--dports", option.get("--dport"))
        if (
            ("-p" in option and option["-p"] != protocol)
            or (ports and str(port) not in ports.split(","))
            or ("-i" in option and option["-i"] != interface)
            or (
                "-s" in option
                and ipaddress.ip_address(source)
                not in ipaddress.ip_network(option["-s"])
            )
            or (
                "-d" in option
                and ipaddress.ip_address(destination)
                not in ipaddress.ip_network(option["-d"])
            )
        ):
            continue
        return option["-j"]
    return "RETURN"


def link(name, kind, *addresses):
    return {
        "ifname": name,
        "flags": ["BROADCAST", "NOARP", "UP", "LOWER_UP"],
        "linkinfo": {"info_kind": kind},
        "addr_info": [
            {
                "family": "inet",
                "local": value.split("/")[0],
                "prefixlen": int(value.split("/")[1]),
            }
            for value in addresses
        ],
    }


class FakeHost:
    """Synthetic ip/systemctl/kubectl: K3s advertises the DHCP address until restarted.

    `running` is the node-ip K3s last started with; a restart reads it and resolv-conf from
    `config`. With `lag`, the Node addresses follow it after that many reads, as the cloud
    controller's periodic sync does. `kubelet` is the DNS the running kubelet hands new Pods and
    `coredns` the DNS the current CoreDNS Pod got when it was created; `blocked` drops public DNS.
    `pod_exec` lets exec reach the daemon's Pod even while the Node still advertises the LAN.
    """

    def __init__(
        self,
        node,
        *,
        interface=None,
        lan=LAN + "/24",
        advertised=None,
        running=None,
        lag=None,
        config=None,
        coredns=None,
        marker=None,
        blocked=False,
        pod_exec=False,
    ):
        self.node = node
        self.interface = interface
        self.lan = lan
        self.advertised = advertised or LAN
        self.running = running or self.advertised
        self.lag = lag
        self.config = config
        self.kubelet = "fixed" if self.running == node_address.ADDRESS else "dhcp"
        self.coredns = coredns or self.kubelet
        self.marker = marker
        self.blocked = blocked
        self.pod_exec = pod_exec
        self.calls = []
        self.kubectl_calls = []
        self.log = []
        self.restarts = 0
        self.recreations = 0

    @staticmethod
    def reply(value, returncode=0):
        return CompletedProcess([], returncode, json.dumps(value).encode(), b"")

    def command(self, argv, **options):
        self.calls.append(argv)
        self.log.append(argv)
        if argv[:2] == ["ip", "-j"] and argv[-1] == node_address.INTERFACE:
            if self.interface is None:
                return CompletedProcess(argv, 1, b"", b"")
            return self.reply([self.interface])
        if argv[:2] == ["ip", "-j"]:
            links = [
                link("lo", None, "127.0.0.1/8"),
                link("wlan0", None, self.lan),
                link("cni0", "bridge", "10.42.0.1/24"),
                link("docker0", "bridge", "172.17.0.1/16"),
            ]
            return self.reply(links + ([self.interface] if self.interface else []))
        if argv == ["systemctl", "start", UNIT] and self.interface is None:
            self.interface = link(
                node_address.INTERFACE, "dummy", node_address.ADDRESS + "/32"
            )
        if argv == ["systemctl", "restart", "k3s.service"]:
            self.restarts += 1
            settings = (
                json.loads(self.config.read_text())
                if self.config
                else node_address.SETTINGS
            )
            self.advertised = self.running = settings.get("node-ip", LAN)
            self.kubelet = "fixed" if settings.get("resolv-conf") else "dhcp"
        return CompletedProcess(argv, 0, b"", b"")

    def kubectl(self, args, **options):
        self.kubectl_calls.append(args)
        self.log.append(args)
        if args[:2] == ["get", "node"]:
            if self.lag:
                self.lag -= 1
            elif self.lag == 0:
                self.advertised = self.running
            return self.reply(
                {
                    "metadata": {
                        "annotations": {node_address.RUNNING_ADDRESS: self.running}
                    },
                    "status": {
                        "addresses": [
                            {"type": "InternalIP", "address": self.advertised},
                            {"type": "Hostname", "address": self.node},
                        ]
                    },
                }
            )
        if "endpointslices" in args:
            return self.reply(
                {
                    "items": [
                        {
                            "endpoints": [{"addresses": [self.advertised]}],
                            "ports": [{"name": "https", "port": 6443}],
                        }
                    ]
                }
            )
        if args[2:5] == ["get", "deployment", "coredns"]:
            marker = {node_address.UPSTREAM_MARKER: self.marker} if self.marker else {}
            return self.reply(
                {"spec": {"template": {"metadata": {"annotations": marker}}}}
            )
        if "patch" in args:
            change = json.loads(args[-1])["spec"]["template"]["metadata"]
            marker = change["annotations"][node_address.UPSTREAM_MARKER]
            if marker != self.marker:
                # The rolling update's new Pod gets what the running kubelet hands out.
                self.marker, self.coredns = marker, self.kubelet
                self.recreations += 1
            return CompletedProcess(args, 0, b"", b"")
        if "exec" in args and node_address.UPSTREAM_PROBE in args:
            # Direct UDP from the Pod network: 3 is the script's definite "no reply".
            if not (self.pod_exec or self.advertised == node_address.ADDRESS):
                return CompletedProcess(args, 1, b"", b"")
            return CompletedProcess(args, 3 if self.blocked else 0, b"", b"")
        if "exec" in args and node_address.LOOKUP in args:
            healthy = not (self.blocked and self.coredns == "fixed")
            return CompletedProcess(args, 0 if healthy else 1, b"", b"")
        if "exec" in args:
            # The Pod path only works once K3s advertises an address the host still has.
            healthy = self.advertised == node_address.ADDRESS
            return CompletedProcess(args, 0 if healthy else 1, b"", b"")
        return CompletedProcess(args, 0, b"", b"")


class NodeAddressTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.bundle = Path(cls.directory.name).resolve() / "bundle"
        prepare.prepare(ROOT, SHA, IMAGES, cls.bundle)
        cls.public = config.load_bundle(cls.bundle)
        cls.node = cls.public["profile"]["observer_node_key"]

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.systemd = self.root / "etc/systemd/system"
        self.k3s = self.root / "etc/rancher/k3s"
        self.network_manager = self.root / "etc/NetworkManager/conf.d"
        for directory in (self.systemd, self.k3s, self.network_manager):
            directory.mkdir(parents=True)

    def unit(self, name):
        return (self.bundle / "units" / name).read_bytes()

    def fake(self, **state):
        return FakeHost(self.node, config=self.k3s / "config.yaml", **state)

    def install_host(self, *, legacy=True):
        for name, destination, _ in self.paths():
            content = self.unit(name)
            destination.write_bytes(
                node_address.legacy(name, content) if legacy else content
            )

    def paths(self):
        with self.synthetic_paths():
            return tuple(node_address.k3s_files())

    @contextlib.contextmanager
    def synthetic_paths(self):
        with (
            patch.object(node_address, "SYSTEMD", self.systemd),
            patch.object(node_address, "K3S", self.k3s),
            patch.object(
                node_address, "NETWORK_MANAGER_DIRECTORY", self.network_manager
            ),
            patch.object(node_address, "ETCD", self.root / "var/lib/etcd"),
        ):
            yield

    @contextlib.contextmanager
    def synthetic_host(self, fake):
        with (
            self.synthetic_paths(),
            patch.object(node_address, "command", side_effect=fake.command),
            patch.object(node_address.cluster, "kubectl", side_effect=fake.kubectl),
            patch.object(node_address.time, "sleep"),
            patch.object(os, "geteuid", return_value=0),
            patch.object(os, "fchown"),
            patch.object(node_address.platform, "system", return_value="Linux"),
            patch.object(
                node_address.platform,
                "freedesktop_os_release",
                return_value={"ID": "ubuntu", "VERSION_ID": "24.04"},
            ),
            patch.object(
                node_address,
                "__file__",
                str(self.bundle / "installer/node_address.py"),
            ),
            patch.object(
                host,
                "completion_marker",
                return_value={"schema_version": 1, "bundle_sha256": "e" * 64},
            ),
            contextlib.redirect_stdout(io.StringIO()) as output,
        ):
            yield output

    def test_bundle_pins_k3s_to_the_fixed_address_and_never_the_lan(self):
        settings = json.loads(self.unit("k3s-config.yaml"))
        self.assertEqual(settings["node-ip"], node_address.ADDRESS)
        self.assertEqual(settings["advertise-address"], node_address.ADDRESS)
        self.assertEqual(settings["flannel-iface"], node_address.INTERFACE)
        self.assertNotIn("node-external-ip", settings)
        self.assertEqual(settings["bind-address"], "0.0.0.0")
        self.assertEqual(settings["resolv-conf"], "/etc/rancher/k3s/resolv.conf")
        self.assertEqual(
            Path(settings["resolv-conf"]),
            node_address.K3S / "resolv.conf",
        )
        # Appended keys keep the earlier rendering byte-identical once they are removed.
        self.assertEqual(
            node_address.legacy("k3s-config.yaml", self.unit("k3s-config.yaml")),
            (
                json.dumps(
                    {
                        "disable": ["traefik", "servicelb"],
                        "secrets-encryption": True,
                        "write-kubeconfig-mode": "0600",
                        "node-name": self.node,
                        "cluster-cidr": "10.42.0.0/16",
                        "bind-address": "0.0.0.0",
                    },
                    indent=2,
                )
                + "\n"
            ).encode(),
        )
        service = self.unit("k3s.service").decode()
        self.assertEqual(service.count("Requires=" + UNIT + "\n"), 1)
        self.assertEqual(service.count("After=" + UNIT + "\n"), 1)
        self.assertLess(service.index("After=" + UNIT), service.index("[Service]"))
        self.assertEqual(
            node_address.legacy("k3s.service", service.encode()),
            LEGACY_K3S_UNIT.encode(),
        )
        self.assertEqual(
            node_address.legacy("firewall.v4", self.unit("firewall.v4")),
            LEGACY_FIREWALL_V4.encode(),
        )
        self.assertEqual(
            node_address.legacy("firewall.v6", self.unit("firewall.v6")),
            self.unit("firewall.v6"),
        )
        oneshot = self.unit(UNIT).decode().splitlines()
        self.assertIn("Type=oneshot", oneshot)
        self.assertIn("RemainAfterExit=yes", oneshot)
        self.assertIn("Before=k3s.service", oneshot)
        self.assertIn("WantedBy=multi-user.target", oneshot)
        self.assertFalse([line for line in oneshot if line.startswith("ExecStop")])
        self.assertEqual(
            [line for line in oneshot if line.startswith("ExecStart")],
            [
                "ExecStart=/usr/sbin/modprobe dummy numdummies=0",
                "ExecStart=-/usr/sbin/ip link add pcloud0 type dummy",
                "ExecStart=/usr/sbin/ip address replace "
                + node_address.ADDRESS
                + "/32 dev pcloud0",
                "ExecStart=/usr/sbin/ip link set dev pcloud0 up",
            ],
        )
        self.assertEqual(
            self.unit(node_address.NETWORK_MANAGER).decode().splitlines()[1:],
            ["match-device=interface-name:pcloud0", "managed=0"],
        )
        for name in (UNIT, node_address.NETWORK_MANAGER, node_address.RESOLV_CONF):
            self.assertEqual(
                self.public["files"]["units/" + name],
                config.checksum(self.bundle / "units" / name),
            )

    def test_bundle_gives_the_kubelet_fixed_public_ipv4_resolvers(self):
        text = self.unit(node_address.RESOLV_CONF).decode()
        # As the kubelet parses it: comments skipped, nameservers in order, no search or options.
        fields = [
            line.split()
            for line in text.splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        ]
        self.assertEqual({field[0] for field in fields}, {"nameserver"})
        servers = [field[1] for field in fields]
        self.assertEqual(servers, ["1.1.1.1", "1.0.0.1", "8.8.8.8"])
        self.assertEqual(tuple(servers), node_address.RESOLVERS)
        self.assertLessEqual(len(servers), 3)  # the kubelet passes at most three
        for server in servers:
            address = ipaddress.ip_address(server)
            self.assertEqual(address.version, 4)  # the Pod network has no IPv6 egress
            self.assertTrue(address.is_global)
        # Two operators: Cloudflare's 1.0.0.0/24 and 1.1.1.0/24, then Google's 8.8.8.0/24.
        self.assertEqual(
            {ipaddress.ip_network(server + "/24", strict=False) for server in servers},
            {
                ipaddress.ip_network("1.1.1.0/24"),
                ipaddress.ip_network("1.0.0.0/24"),
                ipaddress.ip_network("8.8.8.0/24"),
            },
        )
        self.assertEqual(node_address.UPSTREAMS, " ".join(servers))

    def test_fixed_address_stays_clear_of_cluster_and_common_networks(self):
        fixed = ipaddress.ip_address(node_address.ADDRESS)
        self.assertTrue(fixed.is_private)
        self.assertFalse(fixed.is_loopback or fixed.is_link_local)
        self.assertNotIn(fixed.packed[-1], {0, 1, 254, 255})
        for network in (
            "10.42.0.0/16",  # K3s Pods
            "10.43.0.0/16",  # K3s Services
            "10.0.0.0/16",
            "10.1.0.0/16",
            "10.10.0.0/16",
            "100.64.0.0/10",  # CGNAT and Tailscale
            "172.16.0.0/12",  # Docker default pools
            "192.168.0.0/16",  # home routers and Docker's later pools
            "198.18.0.0/15",
            "169.254.0.0/16",
        ):
            self.assertNotIn(fixed, ipaddress.ip_network(network))

    def test_firewall_admits_pods_only_at_the_fixed_address(self):
        fixed = node_address.ADDRESS
        rules = firewall.rules(False, include_jump=True)
        for packet, expected in (
            (("cni0", "10.42.0.9", fixed, "tcp", 6443), "ACCEPT"),
            (("cni0", "10.42.0.9", fixed, "tcp", 10250), "ACCEPT"),
            (("lo", "127.0.0.1", fixed, "tcp", 6443), "ACCEPT"),
            (("lo", LAN, fixed, "tcp", 10250), "ACCEPT"),
            (("cni0", "10.42.0.9", "10.42.0.1", "tcp", 6443), "DROP"),
            (("cni0", "10.42.0.9", LAN, "tcp", 6443), "DROP"),
            (("wlan0", "192.0.2.50", fixed, "tcp", 6443), "DROP"),
            (("wlan0", "10.42.0.9", fixed, "tcp", 6443), "DROP"),
            (("wlan0", "192.0.2.50", LAN, "tcp", 10250), "DROP"),
            (("wlan0", "192.0.2.50", fixed, "udp", 8472), "DROP"),
            (("wlan0", "192.0.2.50", fixed, "tcp", 22), "RETURN"),
        ):
            with self.subTest(packet=packet):
                interface, source, destination, protocol, port = packet
                self.assertEqual(
                    verdict(
                        rules,
                        interface=interface,
                        source=source,
                        destination=destination,
                        protocol=protocol,
                        port=port,
                    ),
                    expected,
                )
        # CoreDNS reaches its upstreams as forwarded Pod traffic; this INPUT-only chain never
        # sees it and opens nothing for DNS.
        for ruleset in (rules, firewall.rules(True, include_jump=True)):
            lines = ruleset.decode().splitlines()
            self.assertEqual(
                [line for line in lines if line.startswith("-I ")],
                ["-I INPUT 1 -j " + firewall.CHAIN],
            )
            self.assertFalse(
                [line for line in lines if "FORWARD" in line or "OUTPUT" in line]
            )
            self.assertNotIn(b" 53 ", ruleset)
        ipv6 = firewall.rules(True, include_jump=True)
        self.assertNotIn(fixed.encode(), ipv6)
        self.assertEqual(
            verdict(
                ipv6,
                interface="cni0",
                source="2001:db8::9",
                destination="2001:db8::1",
                protocol="tcp",
                port=6443,
            ),
            "DROP",
        )

    def test_existing_host_moves_with_one_k3s_restart_and_repeats_as_a_noop(self):
        self.install_host()
        fake = self.fake(pod_exec=True)
        self.assertEqual((fake.kubelet, fake.coredns), ("dhcp", "dhcp"))
        with self.synthetic_host(fake) as output:
            result = node_address.migrate(self.bundle)
        self.assertEqual(
            result,
            {
                "event": "node_address",
                "status": "stable",
                "interface": "pcloud0",
                "address": node_address.ADDRESS,
                "upstream_dns": ["1.1.1.1", "1.0.0.1", "8.8.8.8"],
                "restarted": True,
                "coredns_recreated": True,
            },
        )
        for name, destination, mode in self.paths():
            self.assertEqual(destination.read_bytes(), self.unit(name))
            self.assertEqual(destination.stat().st_mode & 0o777, mode)
        self.assertEqual((self.systemd / UNIT).read_bytes(), self.unit(UNIT))
        resolver = self.k3s / "resolv.conf"
        self.assertEqual(resolver.read_bytes(), self.unit(node_address.RESOLV_CONF))
        self.assertEqual(resolver.stat().st_mode & 0o777, 0o644)
        # CoreDNS is recreated once, by its own Deployment, after K3s runs the new resolv-conf.
        self.assertEqual((fake.coredns, fake.recreations), ("fixed", 1))
        restart = fake.log.index(["systemctl", "restart", "k3s.service"])
        patches = [index for index, argv in enumerate(fake.log) if "patch" in argv]
        self.assertEqual(len(patches), 1)
        self.assertGreater(patches[0], restart)
        self.assertEqual(
            fake.log[patches[0]][:-1],
            [
                "-n",
                "kube-system",
                "patch",
                "deployment",
                "coredns",
                "--type=merge",
                "--field-manager=personal-cloud",
                "-p",
            ],
        )
        self.assertEqual(
            json.loads(fake.log[patches[0]][-1]),
            {
                "spec": {
                    "template": {
                        "metadata": {
                            "annotations": {
                                "personal-cloud/upstream-dns": "1.1.1.1 1.0.0.1 8.8.8.8"
                            }
                        }
                    }
                }
            },
        )
        rollout = fake.log.index(
            [
                "-n",
                "kube-system",
                "rollout",
                "status",
                "deployment/coredns",
                "--timeout=300s",
            ]
        )
        self.assertGreater(rollout, patches[0])
        self.assertEqual(
            (self.network_manager / "personal-cloud-node-address.conf").read_bytes(),
            self.unit(node_address.NETWORK_MANAGER),
        )
        systemctl = [argv for argv in fake.calls if argv[0] == "systemctl"]
        self.assertEqual(
            systemctl,
            [
                ["systemctl", "daemon-reload"],
                ["systemctl", "enable", UNIT],
                ["systemctl", "start", UNIT],
                ["systemctl", "daemon-reload"],
                ["systemctl", "restart", "k3s.service"],
            ],
        )
        # The upstream probe runs before any write; both checks run after CoreDNS is replaced.
        upstreams, read, lookup = [
            (index, argv) for index, argv in enumerate(fake.log) if "exec" in argv
        ][:3]
        self.assertLess(upstreams[0], fake.log.index(["systemctl", "daemon-reload"]))
        self.assertEqual(
            upstreams[1][-5:],
            [
                node_address.UPSTREAM_PROBE,
                self.public["profile"]["fleet_host"] + ".",
                "1.1.1.1",
                "1.0.0.1",
                "8.8.8.8",
            ],
        )
        self.assertGreater(read[0], rollout)
        namespace = self.public["profile"]["namespace"]
        for _, probe in (upstreams, read, lookup):
            self.assertEqual(
                probe[:6],
                [
                    "-n",
                    namespace,
                    "exec",
                    "deployment/platform-runtime",
                    "-c",
                    "platform-runtime",
                ],
            )
        self.assertEqual(read[1][-2:], [node_address.PROBE, namespace])
        self.assertEqual(
            lookup[1][-2:],
            [node_address.LOOKUP, self.public["profile"]["fleet_host"] + "."],
        )
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(
            [event["phase"] for event in events],
            ["inputs", "upstreams", "interface", "k3s", "cluster", "dns"],
        )
        self.assertEqual(events[1]["status"], "reachable")
        with self.synthetic_host(fake):
            again = node_address.migrate(self.bundle)
        self.assertFalse(again["restarted"])
        self.assertFalse(again["coredns_recreated"])
        self.assertEqual((fake.restarts, fake.recreations), (1, 1))

    def test_interrupted_migration_restarts_k3s_on_the_next_run(self):
        # Files already written, K3s not yet restarted: still advertising the DHCP address.
        self.install_host(legacy=False)
        fake = self.fake()
        with self.synthetic_host(fake):
            result = node_address.migrate(self.bundle)
        self.assertTrue(result["restarted"])
        self.assertTrue(result["coredns_recreated"])
        self.assertEqual((fake.restarts, fake.recreations), (1, 1))
        self.assertEqual(fake.coredns, "fixed")

    def test_a_rerun_waits_for_k3s_already_started_on_the_fixed_address(self):
        # An earlier run restarted K3s and timed out before the Node addresses followed, so
        # CoreDNS still forwards to the DHCP servers it was created with.
        self.install_host(legacy=False)
        fake = self.fake(running=node_address.ADDRESS, lag=3, coredns="dhcp")
        with self.synthetic_host(fake):
            result = node_address.migrate(self.bundle)
        self.assertFalse(result["restarted"])
        self.assertTrue(result["coredns_recreated"])
        self.assertEqual((fake.restarts, fake.recreations), (0, 1))
        self.assertEqual(fake.advertised, node_address.ADDRESS)
        self.assertEqual(fake.coredns, "fixed")

    def test_a_rerun_after_the_coredns_update_only_waits_for_its_rollout(self):
        # An earlier run timed out while the new CoreDNS Pod was starting.
        self.install_host(legacy=False)
        (self.k3s / "resolv.conf").write_bytes(self.unit(node_address.RESOLV_CONF))
        fake = self.fake(advertised=node_address.ADDRESS, marker=node_address.UPSTREAMS)
        with self.synthetic_host(fake):
            result = node_address.migrate(self.bundle)
        self.assertEqual(
            (result["restarted"], result["coredns_recreated"]), (False, False)
        )
        self.assertFalse([argv for argv in fake.log if "patch" in argv])
        self.assertTrue([argv for argv in fake.kubectl_calls if "rollout" in argv])
        self.assertEqual((fake.restarts, fake.recreations), (0, 0))

    def test_an_interrupted_rollback_restarts_k3s_on_the_next_run(self):
        # Previous files already restored, K3s still started on the fixed address.
        self.install_host()
        fake = self.fake(advertised=node_address.ADDRESS, marker=node_address.UPSTREAMS)
        with self.synthetic_host(fake):
            result = node_address.rollback(self.bundle)
        self.assertTrue(result["restarted"])
        self.assertTrue(result["coredns_recreated"])
        self.assertEqual(
            (fake.running, fake.kubelet, fake.coredns), (LAN, "dhcp", "dhcp")
        )
        self.assertEqual((fake.restarts, fake.recreations), (1, 1))
        with self.synthetic_host(fake):
            again = node_address.rollback(self.bundle)
        self.assertFalse(again["restarted"])
        self.assertFalse(again["coredns_recreated"])
        self.assertEqual((fake.restarts, fake.recreations), (1, 1))

    def test_unreachable_public_dns_fails_the_migration_and_rollback_restores_it(self):
        self.install_host()
        fake = self.fake(blocked=True)
        with (
            self.synthetic_host(fake),
            patch.object(node_address, "DEADLINE", 0.05),
            self.assertRaisesRegex(config.BootstrapError, "CLUSTER_DNS_LOOKUP_FAILED"),
        ):
            node_address.migrate(self.bundle)
        self.assertEqual((fake.restarts, fake.coredns), (1, "fixed"))
        with self.synthetic_host(fake):
            result = node_address.rollback(self.bundle)
        self.assertEqual(
            result,
            {
                "event": "node_address",
                "status": "rolled_back",
                "restarted": True,
                "coredns_recreated": True,
            },
        )
        # K3s and CoreDNS are back on the DHCP-provided servers; the unused file stays for K3s.
        self.assertEqual(
            (fake.kubelet, fake.coredns, fake.marker), ("dhcp", "dhcp", None)
        )
        self.assertEqual((fake.restarts, fake.recreations), (2, 2))
        self.assertTrue((self.k3s / "resolv.conf").is_file())
        restarts = [
            index
            for index, argv in enumerate(fake.log)
            if argv == ["systemctl", "restart", "k3s.service"]
        ]
        removal = [
            index
            for index, argv in enumerate(fake.log)
            if "patch" in argv and "null" in argv[-1]
        ]
        self.assertEqual(len(removal), 1)
        self.assertGreater(removal[0], restarts[-1])

    def test_pods_without_public_dns_stop_the_migration_before_any_change(self):
        self.install_host()
        before = {path: path.read_bytes() for _, path, _ in self.paths()}
        fake = self.fake(blocked=True, pod_exec=True)
        with (
            self.synthetic_host(fake),
            self.assertRaisesRegex(
                config.BootstrapError, "CLUSTER_DNS_UPSTREAM_UNREACHABLE"
            ),
        ):
            node_address.migrate(self.bundle)
        self.assertEqual({path: path.read_bytes() for path in before}, before)
        self.assertFalse((self.k3s / "resolv.conf").exists())
        self.assertFalse((self.systemd / UNIT).exists())
        self.assertFalse([argv for argv in fake.calls if argv[0] == "systemctl"])
        self.assertFalse([argv for argv in fake.log if "patch" in argv])
        self.assertEqual((fake.restarts, fake.recreations), (0, 0))

    def test_an_unavailable_pod_leaves_the_upstream_check_to_the_lookup(self):
        for failure in (
            CompletedProcess([], 1, b"", b""),
            config.BootstrapError("SYSTEM_COMMAND_UNAVAILABLE"),
        ):
            with (
                self.subTest(failure=type(failure).__name__),
                patch.object(node_address.cluster, "kubectl", side_effect=[failure]),
            ):
                self.assertFalse(node_address.upstreams_reachable("platform", "x.test"))

    def test_unreviewed_host_configuration_is_refused_before_any_change(self):
        for name, change in (
            ("k3s-config.yaml", b'  "node-external-ip": "' + LAN.encode() + b'",\n'),
            ("k3s.service", b"Environment=EXTRA=1\n"),
            ("firewall.v4", b"-A PCLOUD-K3S -i wlan0 -j ACCEPT\n"),
        ):
            with self.subTest(name=name):
                self.install_host()
                destination = next(
                    path for unit, path, _ in self.paths() if unit == name
                )
                content = destination.read_bytes()
                lines = content.splitlines(keepends=True)
                destination.write_bytes(b"".join([lines[0], change, *lines[1:]]))
                fake = self.fake()
                with (
                    self.synthetic_host(fake),
                    self.assertRaisesRegex(
                        config.BootstrapError,
                        "NODE_ADDRESS_HOST_CONFIGURATION_REVIEW_REQUIRED",
                    ),
                ):
                    node_address.migrate(self.bundle)
                self.assertEqual(fake.log, [])
                self.assertFalse((self.k3s / "resolv.conf").exists())
                self.assertFalse((self.systemd / UNIT).exists())

    def test_interface_network_and_datastore_conflicts_stop_before_writes(self):
        cases = (
            ("lan", {"lan": "10.254.0.7/16"}, "NODE_ADDRESS_CONFLICT"),
            (
                "bridge",
                {"interface": link("pcloud0", "bridge", node_address.ADDRESS + "/32")},
                "NODE_ADDRESS_INTERFACE_CONFLICT",
            ),
            (
                "extra_address",
                {"interface": link("pcloud0", "dummy", "10.254.0.5/32")},
                "NODE_ADDRESS_INTERFACE_CONFLICT",
            ),
            ("unit", {}, "NODE_ADDRESS_FILE_CONFLICT"),
            ("resolver", {}, "NODE_ADDRESS_FILE_CONFLICT"),
            ("etcd", {}, "NODE_ADDRESS_ETCD_UNSUPPORTED"),
        )
        resolver = self.k3s / "resolv.conf"
        for case, state, code in cases:
            with self.subTest(case=case):
                (self.systemd / UNIT).unlink(missing_ok=True)
                resolver.unlink(missing_ok=True)
                shutil.rmtree(self.root / "var", ignore_errors=True)
                if case == "unit":
                    (self.systemd / UNIT).write_text("[Service]\nExecStart=/bin/true\n")
                if case == "resolver":
                    resolver.write_text("nameserver 192.0.2.1\n")
                if case == "etcd":
                    (self.root / "var/lib/etcd").mkdir(parents=True)
                self.install_host()
                fake = self.fake(**state)
                with (
                    self.synthetic_host(fake),
                    self.assertRaisesRegex(config.BootstrapError, code),
                ):
                    node_address.migrate(self.bundle)
                self.assertFalse(
                    [argv for argv in fake.calls if argv[0] == "systemctl"]
                )
                for name, destination, _ in self.paths():
                    self.assertEqual(
                        destination.read_bytes(),
                        node_address.legacy(name, self.unit(name)),
                    )

    def test_advertisement_needs_only_the_fixed_address_on_node_and_endpoints(self):
        fake = FakeHost(self.node, advertised=node_address.ADDRESS)
        with patch.object(node_address.cluster, "kubectl", side_effect=fake.kubectl):
            self.assertTrue(node_address.advertised(self.node))
            fake.advertised = LAN
            self.assertFalse(node_address.advertised(self.node))

        def both(args, **options):
            if "endpointslices" in args:
                return fake.reply(
                    {
                        "items": [
                            {
                                "endpoints": [
                                    {"addresses": [LAN]},
                                    {"addresses": [node_address.ADDRESS]},
                                ],
                                "ports": [{"port": 6443}],
                            }
                        ]
                    }
                )
            return fake.kubectl(args, **options)

        fake.advertised = node_address.ADDRESS
        with (
            patch.object(node_address.cluster, "kubectl", side_effect=both),
            patch.object(node_address, "DEADLINE", 0.01),
            patch.object(node_address.time, "sleep"),
            self.assertRaisesRegex(
                config.BootstrapError, "NODE_ADDRESS_NOT_ADVERTISED"
            ),
        ):
            node_address.wait_cluster(self.node)

    def test_rollback_restores_the_previous_files_with_one_restart(self):
        self.install_host(legacy=False)
        fake = self.fake(advertised=node_address.ADDRESS, marker=node_address.UPSTREAMS)
        with self.synthetic_host(fake):
            result = node_address.rollback(self.bundle)
        self.assertEqual(
            result,
            {
                "event": "node_address",
                "status": "rolled_back",
                "restarted": True,
                "coredns_recreated": True,
            },
        )
        for name, destination, _ in self.paths():
            self.assertEqual(
                destination.read_bytes(), node_address.legacy(name, self.unit(name))
            )
        self.assertEqual(
            fake.calls,
            [["systemctl", "daemon-reload"], ["systemctl", "restart", "k3s.service"]],
        )
        self.assertFalse((self.systemd / UNIT).exists())
        self.assertEqual(fake.coredns, "dhcp")

    def test_fresh_host_gets_the_resolver_list_before_k3s_first_starts(self):
        shutil.rmtree(self.root / "etc/rancher")
        fake = self.fake()
        with self.synthetic_host(fake), patch.object(os, "chown") as chown:
            node_address.install(self.bundle)
        self.assertEqual(self.k3s.stat().st_mode & 0o777, 0o700)
        chown.assert_called_once_with(self.k3s, 0, 0)
        resolver = self.k3s / "resolv.conf"
        self.assertEqual(resolver.read_bytes(), self.unit(node_address.RESOLV_CONF))
        self.assertEqual(resolver.stat().st_mode & 0o777, 0o644)

    def test_a_command_timeout_during_the_restart_is_retried(self):
        replies = iter([config.BootstrapError("SYSTEM_COMMAND_UNAVAILABLE"), False])

        def check():
            reply = next(replies, True)
            if isinstance(reply, Exception):
                raise reply
            return reply

        with patch.object(node_address.time, "sleep") as sleep:
            node_address.until(check, "SYNTHETIC_TIMEOUT")
        self.assertEqual(sleep.call_count, 2)

    def installed_before_address(self):
        """A copy of the bundle as rendered before the address and the observer profile."""
        installed = self.root / "installed"
        shutil.copytree(self.bundle, installed)
        manifest = config.read_json(installed / "manifest.json")
        for name in ("k3s.service", "k3s-config.yaml", "firewall.v4"):
            path = installed / "units" / name
            path.write_bytes(node_address.legacy(name, path.read_bytes()))
        for name in (
            UNIT,
            node_address.NETWORK_MANAGER,
            node_address.RESOLV_CONF,
            "personal-cloud-systemd-observer-v1",
            "observer-apparmor-license.txt",
        ):
            (installed / "units" / name).unlink()
            del manifest["files"]["units/" + name]
        for relative in manifest["files"]:
            manifest["files"][relative] = config.checksum(installed / relative)
        (installed / "manifest.json").write_text(json.dumps(manifest))
        config.load_bundle(installed)
        return installed

    @contextlib.contextmanager
    def recovery_host(self, order):
        token = Mock()
        token.is_file.return_value = True
        token.stat.return_value = Mock(st_uid=0, st_mode=0o100600)
        versions = config.read_json(self.bundle / "versions.json")

        def record(name, result=None):
            def call(*args, **options):
                order.append((name, args, options))
                return result

            return call

        with (
            patch.object(
                recover,
                "checksum",
                return_value=versions["k3s"]["linux_amd64_sha256"],
            ),
            patch.object(
                recover.binaries, "connector_preflight", return_value="/opt/cloudflared"
            ),
            patch.object(recover.host, "real_path", return_value=token),
            patch.object(recover.host, "write_file", side_effect=record("write")),
            patch.object(recover.observer_policy, "install"),
            patch.object(
                recover,
                "command",
                side_effect=record("command", CompletedProcess([], 0, b"", b"")),
            ),
            patch.object(
                recover.cluster,
                "kubectl",
                return_value=CompletedProcess([], 0, b"", b""),
            ),
            patch.object(node_address, "preflight", side_effect=record("preflight")),
            patch.object(node_address, "install", side_effect=record("install")),
            patch.object(
                node_address, "wait_cluster", side_effect=record("wait_cluster")
            ),
            patch.object(
                node_address, "upstream_dns", side_effect=record("upstream_dns")
            ),
        ):
            yield

    def test_recovery_moves_a_host_installed_before_the_fixed_address(self):
        installed = self.installed_before_address()
        order = []
        with self.recovery_host(order):
            recover.host_services(installed, self.bundle)
        self.assertEqual(
            [(name, args, options) for name, args, options in order[:2]],
            [
                ("preflight", (self.bundle,), {"restore": True}),
                ("install", (self.bundle,), {"restore": True}),
            ],
        )
        restart = next(
            index
            for index, (name, args, _) in enumerate(order)
            if name == "command" and args[0] == ["systemctl", "restart", "k3s.service"]
        )
        self.assertEqual(order[restart + 1][:2], ("wait_cluster", (self.node,)))
        # CoreDNS is recreated under the restarted K3s's fixed resolv-conf.
        self.assertEqual(order[restart + 2][:2], ("upstream_dns", ()))
        written = {str(args[0]): args[1] for name, args, _ in order if name == "write"}
        self.assertEqual(
            written["/etc/rancher/k3s/config.yaml"], self.unit("k3s-config.yaml")
        )
        self.assertEqual(
            written["/etc/rancher/k3s/firewall.v4"], self.unit("firewall.v4")
        )

    def test_recovery_still_refuses_any_other_host_configuration_change(self):
        installed = self.installed_before_address()
        path = installed / "units/k3s-config.yaml"
        settings = json.loads(path.read_text())
        settings["node-external-ip"] = LAN
        path.write_text(json.dumps(settings, indent=2) + "\n")
        order = []
        with (
            self.recovery_host(order),
            self.assertRaisesRegex(
                config.BootstrapError, "RECOVERY_HOST_CONFIGURATION_REVIEW_REQUIRED"
            ),
        ):
            recover.host_services(installed, self.bundle)
        self.assertEqual(order, [])


if __name__ == "__main__":
    unittest.main()
