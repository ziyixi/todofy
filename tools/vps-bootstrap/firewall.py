"""Own one standard INPUT chain; atomic restore never flushes existing host firewall chains."""

from runner import command

from config import require

CHAIN = "PCLOUD-K3S"
COMMENT = "personal-cloud-bootstrap"


def rules(ipv6=False, include_jump=False):
    commands = ["*filter", ":" + CHAIN + " - [0:0]", "-F " + CHAIN]
    for protocol, ports in (
        ("tcp", "-m multiport --dports 6443,10250"),
        ("udp", "--dport 8472"),
    ):
        prefix = "-A " + CHAIN + " -p " + protocol + " " + ports
        suffix = " -m comment --comment " + COMMENT
        commands.append(prefix + " -i lo" + suffix + " -j ACCEPT")
        if not ipv6:
            commands.append(prefix + " -i cni0 -s 10.42.0.0/16" + suffix + " -j ACCEPT")
        commands.append(prefix + suffix + " -j DROP")
    if include_jump:
        commands.append("-I INPUT 1 -j " + CHAIN)
    commands += [
        "-A " + CHAIN + " -m comment --comment " + COMMENT + " -j RETURN",
        "COMMIT",
        "",
    ]
    return "\n".join(commands).encode()


def install():
    for binary, ipv6 in (("iptables", False), ("ip6tables", True)):
        existing = command([binary, "-w", "5", "-S", CHAIN], check=False)
        if existing.returncode == 0:
            lines = existing.stdout.decode().splitlines()
            require(
                all(not line.startswith("-A ") or COMMENT in line for line in lines),
                "FOREIGN_FIREWALL_CHAIN",
            )
        payload = rules(ipv6)
        command(
            [binary + "-restore", "--test", "--noflush", "--wait", "5"], data=payload
        )
        command([binary + "-restore", "--noflush", "--wait", "5"], data=payload)
        exists = command([binary, "-w", "5", "-C", "INPUT", "-j", CHAIN], check=False)
        if exists.returncode:
            command([binary, "-w", "5", "-I", "INPUT", "1", "-j", CHAIN])
