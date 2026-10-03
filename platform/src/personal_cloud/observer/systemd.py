"""Read fixed systemd unit properties through the non-root system D-Bus."""

from jeepney import (
    AuthenticationError,
    DBusAddress,
    DBusErrorResponse,
    MessageType,
    SizeLimitError,
    new_method_call,
)
from jeepney.io.common import RouterClosed
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
DIAGNOSTIC_STAGES = {"BUS", "POLKIT", "GET_UNIT", "LOAD_STATE", "ACTIVE_STATE"}
DIAGNOSTIC_CODES = {
    "OK",
    "UNREADABLE",
    "TIMEOUT",
    "AUTH_FAILED",
    "DBUS_DENIED",
    "APPARMOR_DENIED",
    "SERVICE_UNAVAILABLE",
    "POLKIT_FAILED",
    "NO_SUCH_UNIT",
    "INVALID_REPLY",
    "UNSUPPORTED_STATE",
    "UNSAFE_AUTHORIZATION",
    "CONNECTION_CLOSED",
    "ERROR",
}
ERROR_NAMES = {
    "org.freedesktop.DBus.Error.AccessDenied": "DBUS_DENIED",
    "org.freedesktop.DBus.Error.AuthFailed": "AUTH_FAILED",
    "org.freedesktop.DBus.Error.ServiceUnknown": "SERVICE_UNAVAILABLE",
    "org.freedesktop.DBus.Error.NameHasNoOwner": "SERVICE_UNAVAILABLE",
    "org.freedesktop.DBus.Error.NoReply": "TIMEOUT",
    "org.freedesktop.DBus.Error.Timeout": "TIMEOUT",
    "org.freedesktop.PolicyKit1.Error.Failed": "POLKIT_FAILED",
    "org.freedesktop.PolicyKit1.Error.NotAuthorized": "DBUS_DENIED",
    BUS_NAME + ".NoSuchUnit": "NO_SUCH_UNIT",
}
# dbus upstream bus/apparmor.c: only classify this fixed prefix in memory.
# https://gitlab.freedesktop.org/dbus/dbus/-/blob/dbus-1.14.10/bus/apparmor.c
APPARMOR_PREFIX = "An AppArmor policy prevents this sender from sending this message to this recipient;"


def error_code(error):
    if (
        error.name == "org.freedesktop.DBus.Error.AccessDenied"
        and isinstance(error.data, tuple)
        and len(error.data) == 1
        and isinstance(error.data[0], str)
        and error.data[0].startswith(APPARMOR_PREFIX)
    ):
        return "APPARMOR_DENIED"
    return ERROR_NAMES.get(error.name, "ERROR")


def check_error(reply):
    if reply.header.message_type == MessageType.error:
        raise DBusErrorResponse(reply)


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
        check_error(reply)
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
    check_error(reply)
    if reply.header.message_type != MessageType.method_return or len(reply.body) != 1:
        return None
    variant = reply.body[0]
    if not isinstance(variant, tuple) or len(variant) != 2 or variant[0] != "s":
        return None
    return variant[1] if isinstance(variant[1], str) and len(variant[1]) <= 64 else None


def daemon(name, *, diagnostic=None):
    """Only GetUnit and Properties.Get. Management is denied by host polkit."""
    stage = "BUS"

    def result(state, code):
        if diagnostic is not None:
            diagnostic.update(unit=name, state=state, stage=stage, code=code)
        return {"state": state}

    if name not in UNITS:
        return {"state": "unknown"}
    try:
        with open_dbus_router(BUS_ADDRESS, enable_fds=False) as connection:
            stage = "POLKIT"
            if not readonly_authority(connection):
                return result("unknown", "INVALID_REPLY")
            manager = DBusAddress(
                "/org/freedesktop/systemd1",
                bus_name=BUS_NAME,
                interface=BUS_NAME + ".Manager",
            )
            stage = "GET_UNIT"
            reply = connection.send_and_get_reply(
                new_method_call(manager, "GetUnit", "s", (UNITS[name],)), timeout=2
            )
            # NoSuchUnit observes loaded units, not installed unit files.
            check_error(reply)
            if (
                reply.header.message_type != MessageType.method_return
                or len(reply.body) != 1
            ):
                return result("unknown", "INVALID_REPLY")
            path = reply.body[0]
            if (
                not isinstance(path, str)
                or len(path) > 512
                or not path.startswith("/org/freedesktop/systemd1/unit/")
            ):
                return result("unknown", "INVALID_REPLY")
            stage = "LOAD_STATE"
            load_state = property_value(connection, path, "LoadState")
            if load_state == "not-found":
                return result("missing", "OK")
            if load_state is None:
                return result("unknown", "INVALID_REPLY")
            stage = "ACTIVE_STATE"
            state = property_value(connection, path, "ActiveState")
            if state is None:
                return result("unknown", "INVALID_REPLY")
            return (
                result(state, "OK")
                if state in ACTIVE_STATES
                else result("unknown", "UNSUPPORTED_STATE")
            )
    except ObserverError:
        result("unknown", "UNSAFE_AUTHORIZATION")
        raise
    except DBusErrorResponse as error:
        return result("unknown", error_code(error))
    except TimeoutError:
        return result("unknown", "TIMEOUT")
    except AuthenticationError:
        return result("unknown", "AUTH_FAILED")
    except (EOFError, RouterClosed):
        return result("unknown", "CONNECTION_CLOSED")
    except OSError:
        return result("unknown", "UNREADABLE")
    except (
        ValueError,
        TypeError,
        AttributeError,
        SizeLimitError,
    ):
        return result("unknown", "ERROR")
