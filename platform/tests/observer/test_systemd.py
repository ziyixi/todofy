"""Fixed D-Bus metadata calls and non-mutating polkit permission checks."""

import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from jeepney import (
    AuthenticationError,
    DBusAddress,
    HeaderFields,
    Message,
    new_error,
    new_method_call,
    new_method_return,
)
from jeepney.io.common import RouterClosed
from personal_cloud.observer import systemd
from personal_cloud.observer.transport import ObserverError


def response(body=(), *, signature=None, error=None):
    call = new_method_call(
        DBusAddress(
            "/fixture", bus_name="fixture.service", interface="fixture.Interface"
        ),
        "Fixture",
    )
    call.header.serial = 1
    reply = (
        new_error(call, error, "s", ("private fixture response",))
        if error
        else new_method_return(call, signature, body)
    )
    return Message.from_buffer(reply.serialise(serial=2))


class SystemdTests(unittest.TestCase):
    def connection(self, observations):
        connection = Mock(conn=SimpleNamespace(unique_name=":1.42"))
        grants = [
            response(((False, True, {}),), signature="(bba{ss})")
            for _ in systemd.MANAGEMENT_ACTIONS
        ]
        connection.send_and_get_reply.side_effect = [*grants, *observations]
        return connection

    def test_only_fixed_properties_are_read_after_no_management_authorization(self):
        connection = self.connection(
            [
                response(
                    ("/org/freedesktop/systemd1/unit/k3s_2eservice",), signature="o"
                ),
                response((("s", "loaded"),), signature="v"),
                response((("s", "active"),), signature="v"),
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
        for message in messages:
            self.assertEqual(
                Message.from_buffer(message.serialise(serial=1)).body, message.body
            )
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
        connection.send_and_get_reply.return_value = response(
            ((True, False, {"private": "fixture details"}),), signature="(bba{ss})"
        )
        diagnostic = {}
        with (
            patch.object(systemd, "open_dbus_router") as open_bus,
            self.assertRaisesRegex(ObserverError, "unsafe_system_bus_authorization"),
        ):
            open_bus.return_value.__enter__.return_value = connection
            systemd.daemon("k3s", diagnostic=diagnostic)
        self.assertEqual(diagnostic["code"], "UNSAFE_AUTHORIZATION")
        self.assertEqual(diagnostic["stage"], "POLKIT")
        self.assertEqual(connection.send_and_get_reply.call_count, 1)
        message = connection.send_and_get_reply.call_args.args[0]
        self.assertEqual(
            message.header.fields[HeaderFields.member], "CheckAuthorization"
        )
        self.assertNotIn("private", repr(diagnostic))
        open_bus.return_value.__exit__.assert_called_once()

    def test_real_dbus_error_replies_only_emit_fixed_codes(self):
        for error, expected in (
            ("org.freedesktop.DBus.Error.AccessDenied", "DBUS_DENIED"),
            ("org.freedesktop.DBus.Error.ServiceUnknown", "SERVICE_UNAVAILABLE"),
            ("org.freedesktop.PolicyKit1.Error.Failed", "POLKIT_FAILED"),
            ("fixture.private.Error", "ERROR"),
        ):
            with self.subTest(error=error):
                connection = Mock(conn=SimpleNamespace(unique_name=":1.42"))
                connection.send_and_get_reply.return_value = response(error=error)
                diagnostic = {}
                with patch.object(systemd, "open_dbus_router") as open_bus:
                    open_bus.return_value.__enter__.return_value = connection
                    self.assertEqual(
                        systemd.daemon("k3s", diagnostic=diagnostic),
                        {"state": "unknown"},
                    )
                self.assertEqual(diagnostic["stage"], "POLKIT")
                self.assertEqual(diagnostic["code"], expected)
                self.assertNotIn("private", repr(diagnostic))
                self.assertEqual(connection.send_and_get_reply.call_count, 1)

    def test_auth_timeout_and_closed_connection_do_not_include_exception_text(self):
        for error, expected in (
            (TimeoutError("private fixture"), "TIMEOUT"),
            (AuthenticationError(b"private fixture"), "AUTH_FAILED"),
            (PermissionError("private fixture"), "UNREADABLE"),
            (RouterClosed("private fixture"), "CONNECTION_CLOSED"),
        ):
            with self.subTest(expected=expected):
                diagnostic = {}
                with patch.object(systemd, "open_dbus_router", side_effect=error):
                    self.assertEqual(
                        systemd.daemon("ssh", diagnostic=diagnostic),
                        {"state": "unknown"},
                    )
                self.assertEqual(diagnostic["stage"], "BUS")
                self.assertEqual(diagnostic["code"], expected)
                self.assertNotIn("private", repr(diagnostic))

    def test_real_wire_unit_property_denial_and_unloaded_unit_are_distinct(self):
        for observations, stage, code in (
            (
                [response(error=systemd.BUS_NAME + ".NoSuchUnit")],
                "GET_UNIT",
                "NO_SUCH_UNIT",
            ),
            (
                [
                    response(
                        ("/org/freedesktop/systemd1/unit/ssh_2eservice",), signature="o"
                    ),
                    response(error="org.freedesktop.DBus.Error.AccessDenied"),
                ],
                "LOAD_STATE",
                "DBUS_DENIED",
            ),
        ):
            diagnostic = {}
            connection = self.connection(observations)
            with patch.object(systemd, "open_dbus_router") as open_bus:
                open_bus.return_value.__enter__.return_value = connection
                self.assertEqual(
                    systemd.daemon("ssh", diagnostic=diagnostic), {"state": "unknown"}
                )
            self.assertEqual((diagnostic["stage"], diagnostic["code"]), (stage, code))

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
