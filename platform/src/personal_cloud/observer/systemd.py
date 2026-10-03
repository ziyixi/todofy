"""Read fixed systemd unit properties through the non-root system D-Bus."""

from jeepney import (
    AuthenticationError,
    DBusAddress,
    DBusErrorResponse,
    MessageType,
    SizeLimitError,
    new_method_call,
)
from jeepney.io.threading import open_dbus_router

from .transport import ObserverError

UNITS = {
    "k3s": "k3s.service",
    "cloudflared": "cloudflared.service",
    "ssh": "ssh.service",
    "cloudflared_platform": "cloudflared-platform.service",
}
BUS_ADDRESS = "unix:path=/host-system-bus/socket"
BUS_NAME = "org.freedesktop.systemd1"
UNIT_INTERFACE = "org.freedesktop.systemd1.Unit"
ACTIVE_STATES = {"active", "inactive", "failed", "activating", "deactivating"}
MANAGEMENT_ACTIONS = (
    "manage-units",
    "manage-unit-files",
    "set-environment",
    "reload-daemon",
)


def readonly_authority(connection):
    """Query authorization with interaction disabled; never attempt a mutation."""
    authority = DBusAddress(
        "/org/freedesktop/PolicyKit1/Authority",
        bus_name="org.freedesktop.PolicyKit1",
        interface="org.freedesktop.PolicyKit1.Authority",
    )
    for action in MANAGEMENT_ACTIONS:
        subject = ("system-bus-name", {"name": ("s", connection.conn.unique_name)})
        reply = connection.send_and_get_reply(
            new_method_call(
                authority,
                "CheckAuthorization",
                "(sa{sv})sa{ss}us",
                (subject, BUS_NAME + "." + action, {}, 0, ""),
            ),
            timeout=2,
        )
        if (
            reply.header.message_type != MessageType.method_return
            or len(reply.body) != 1
        ):
            return False
        result = reply.body[0]
        if (
            not isinstance(result, tuple)
            or len(result) != 3
            or type(result[0]) is not bool
            or type(result[1]) is not bool
            or not isinstance(result[2], dict)
        ):
            return False
        if result[0]:
            raise ObserverError("unsafe_system_bus_authorization")
    return True


def property_value(connection, path, name):
    address = DBusAddress(
        path,
        bus_name=BUS_NAME,
        interface="org.freedesktop.DBus.Properties",
    )
    reply = connection.send_and_get_reply(
        new_method_call(address, "Get", "ss", (UNIT_INTERFACE, name)), timeout=2
    )
    if reply.header.message_type != MessageType.method_return or len(reply.body) != 1:
        return None
    variant = reply.body[0]
    if not isinstance(variant, tuple) or len(variant) != 2 or variant[0] != "s":
        return None
    return variant[1] if isinstance(variant[1], str) and len(variant[1]) <= 64 else None


def daemon(name):
    """Only GetUnit and Properties.Get. Management is denied by host polkit."""
    if name not in UNITS:
        return {"state": "unknown"}
    try:
        with open_dbus_router(BUS_ADDRESS, enable_fds=False) as connection:
            if not readonly_authority(connection):
                return {"state": "unknown"}
            manager = DBusAddress(
                "/org/freedesktop/systemd1",
                bus_name=BUS_NAME,
                interface=BUS_NAME + ".Manager",
            )
            reply = connection.send_and_get_reply(
                new_method_call(manager, "GetUnit", "s", (UNITS[name],)), timeout=2
            )
            if reply.header.message_type == MessageType.error:
                # GetUnit observes loaded units only. NoSuchUnit does not prove
                # that its installed unit file is missing, so remain unknown.
                return {"state": "unknown"}
            if (
                reply.header.message_type != MessageType.method_return
                or len(reply.body) != 1
            ):
                return {"state": "unknown"}
            path = reply.body[0]
            if (
                not isinstance(path, str)
                or len(path) > 512
                or not path.startswith("/org/freedesktop/systemd1/unit/")
            ):
                return {"state": "unknown"}
            load_state = property_value(connection, path, "LoadState")
            if load_state == "not-found":
                return {"state": "missing"}
            if load_state is None:
                return {"state": "unknown"}
            state = property_value(connection, path, "ActiveState")
            return {"state": state if state in ACTIVE_STATES else "unknown"}
    except (
        OSError,
        TimeoutError,
        ValueError,
        TypeError,
        AttributeError,
        EOFError,
        AuthenticationError,
        DBusErrorResponse,
        SizeLimitError,
    ):
        return {"state": "unknown"}
