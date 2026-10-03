"""Fixed D-Bus metadata calls and non-mutating polkit permission checks."""

import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from jeepney import HeaderFields, MessageType
from personal_cloud.observer import systemd
from personal_cloud.observer.transport import ObserverError


def response(body, *, error=None):
    return SimpleNamespace(
        body=body,
        header=SimpleNamespace(
            message_type=MessageType.error if error else MessageType.method_return,
            fields={HeaderFields.error_name: error} if error else {},
        ),
    )


class SystemdTests(unittest.TestCase):
    def connection(self, observations):
        connection = Mock(conn=SimpleNamespace(unique_name=":1.42"))
        grants = [response(((False, True, {}),)) for _ in systemd.MANAGEMENT_ACTIONS]
        connection.send_and_get_reply.side_effect = [*grants, *observations]
        return connection

    def test_only_fixed_properties_are_read_after_no_management_authorization(self):
        connection = self.connection(
            [
                response(("/org/freedesktop/systemd1/unit/k3s_2eservice",)),
                response((("s", "loaded"),)),
                response((("s", "active"),)),
            ]
        )
        with patch.object(systemd, "open_dbus_router") as open_bus:
            open_bus.return_value.__enter__.return_value = connection
            self.assertEqual(systemd.daemon("k3s"), {"state": "active"})
        open_bus.assert_called_once_with(
            "unix:path=/host-system-bus/socket", enable_fds=False
        )
        messages = [
            call.args[0] for call in connection.send_and_get_reply.call_args_list
        ]
        self.assertEqual(
            [message.header.fields[HeaderFields.member] for message in messages],
            ["CheckAuthorization"] * 4 + ["GetUnit", "Get", "Get"],
        )
        self.assertEqual(messages[4].body, ("k3s.service",))
        self.assertEqual(messages[5].body, (systemd.UNIT_INTERFACE, "LoadState"))
        self.assertEqual(messages[6].body, (systemd.UNIT_INTERFACE, "ActiveState"))
        for message in messages[:4]:
            self.assertEqual(
                message.body[0], ("system-bus-name", {"name": ("s", ":1.42")})
            )
            self.assertEqual(message.body[3], 0)
        open_bus.return_value.__exit__.assert_called_once()

    def test_unloaded_or_unreadable_unit_is_unknown_instead_of_assumed_missing(self):
        connection = self.connection(
            [response((), error=systemd.BUS_NAME + ".NoSuchUnit")]
        )
        with patch.object(systemd, "open_dbus_router") as open_bus:
            open_bus.return_value.__enter__.return_value = connection
            self.assertEqual(systemd.daemon("ssh"), {"state": "unknown"})
        with patch.object(
            systemd, "open_dbus_router", side_effect=OSError("private detail")
        ):
            self.assertEqual(systemd.daemon("ssh"), {"state": "unknown"})

    def test_management_grant_refuses_all_observation_without_mutating_systemd(self):
        connection = Mock(conn=SimpleNamespace(unique_name=":1.42"))
        connection.send_and_get_reply.return_value = response(((True, False, {}),))
        with (
            patch.object(systemd, "open_dbus_router") as open_bus,
            self.assertRaisesRegex(ObserverError, "unsafe_system_bus_authorization"),
        ):
            open_bus.return_value.__enter__.return_value = connection
            systemd.daemon("k3s")
        self.assertEqual(connection.send_and_get_reply.call_count, 1)
        message = connection.send_and_get_reply.call_args.args[0]
        self.assertEqual(
            message.header.fields[HeaderFields.member], "CheckAuthorization"
        )
        open_bus.return_value.__exit__.assert_called_once()

    def test_unavailable_polkit_reports_unknown_without_reading_units(self):
        connection = Mock(conn=SimpleNamespace(unique_name=":1.42"))
        connection.send_and_get_reply.return_value = response(
            (), error="org.freedesktop.DBus.Error.ServiceUnknown"
        )
        with patch.object(systemd, "open_dbus_router") as open_bus:
            open_bus.return_value.__enter__.return_value = connection
            self.assertEqual(systemd.daemon("k3s"), {"state": "unknown"})
        self.assertEqual(connection.send_and_get_reply.call_count, 1)


if __name__ == "__main__":
    unittest.main()
