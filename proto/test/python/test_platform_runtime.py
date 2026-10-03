"""Shared platform runtime wire types, HTTP metadata and safe protocol errors; synthetic only."""
import copy
import json
import re
import unittest

from proto_test_support import PROTO, REPO
from ziyixi_proto.http_routes import decode_json_body, decode_request, match_path
from ziyixi_proto.platform.runtime.v1 import runtime_pb as pb, runtime_service_pb as service
from ziyixi_proto.rpc_status import CODE, HTTP_STATUS, RpcError, status_body
from ziyixi_proto.wire_json import WireJsonError, from_wire, to_wire

FIXTURES = REPO / "contracts/platform-runtime-v1/fixtures"
REQUEST_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
RELEASE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"


def create_body():
    return {"targets": [{"workload_key": "newsletter", "source_sha": "a" * 40,
                         "image_digest": "sha256:" + "b" * 64, "request_id": REQUEST_ID}]}


class RuntimeWire(unittest.TestCase):
    def test_synthetic_ready_unknown_and_missing_fixtures_round_trip(self):
        for path in sorted(FIXTURES.glob("*.json")):
            value = json.loads(path.read_text())
            with self.subTest(fixture=path.name):
                message = from_wire(pb.NodeStatus, value, strict=True).message
                self.assertEqual(to_wire(message), value)
        unknown = json.loads((FIXTURES / "node-unknown.json").read_text())
        self.assertIsNone(unknown["workloads"][0]["release"]["actual"])
        self.assertNotIn("observed_generation", unknown["workloads"][0]["release"])

    def test_strict_bounds_and_release_identities_reject_invalid_or_private_values(self):
        value = json.loads((FIXTURES / "node-ready.json").read_text())
        mutations = [lambda node: node.update(hostname="synthetic.private"),
                     lambda node: node.update(workloads=node["workloads"] * 17),
                     lambda node: node["workloads"][0].update(logs="not permitted"),
                     lambda node: node["workloads"][0].update(process_state="invented"),
                     lambda node: node["workloads"][0]["release"].update(observed_generation=0),
                     lambda node: node["workloads"][0]["release"]["actual"].update(source_sha="a" * 39),
                     lambda node: node["workloads"][0]["release"]["actual"].update(image_digest="latest"),
                     lambda node: node["workloads"][0]["release"]["actual"].update(request_id="not-a-uuid"),
                     lambda node: node["workloads"][0]["release"]["actual"].update(workload_key="../private")]
        for mutate in mutations:
            invalid = copy.deepcopy(value)
            mutate(invalid)
            with self.subTest(mutation=mutate), self.assertRaises(WireJsonError):
                from_wire(pb.NodeStatus, invalid, strict=True)

    def test_generated_schema_has_same_bounds_and_states(self):
        schema = json.loads((FIXTURES.parent / "platform-runtime-v1.schema.json").read_text())["$defs"]
        self.assertEqual(schema["NodeStatus"]["properties"]["workloads"]["maxItems"], 16)
        self.assertIn("missing", schema["ReleaseStatus"]["properties"]["state"]["enum"])
        self.assertEqual(schema["ReleaseStatus"]["properties"]["observed_generation"]["minimum"], 1)
        self.assertFalse(schema["WorkloadStatus"]["additionalProperties"])

    def test_operation_summary_is_lightweight_and_closed(self):
        value = json.loads((FIXTURES / "node-ready.json").read_text())
        summary = {"name": "releases/" + RELEASE_ID, "request_id": REQUEST_ID, "phase": "held",
                   "etag": "revision-3", "update_time": value["observed_at"], "error_code": "DRAIN_UNKNOWN"}
        value["current_release"] = summary
        self.assertEqual(to_wire(from_wire(pb.NodeStatus, value, strict=True).message), value)
        for key, item in (("targets", create_body()["targets"]), ("phase", "automatic_resume"),
                          ("error_code", "/private/path"), ("update_time", None)):
            invalid = {**summary, key: item}
            with self.subTest(field=key), self.assertRaises(WireJsonError):
                from_wire(pb.ReleaseSummary, invalid, strict=True)


class HttpMetadata(unittest.TestCase):
    def test_bindings_use_generated_request_and_response_classes(self):
        routes = {binding.rpc: binding for binding in service.HTTP_BINDINGS}
        self.assertEqual(set(routes), {"GetNodeStatus", "ListWorkloads", "GetWorkload", "CreateRelease", "GetRelease", "ResumeRelease"})
        for binding in (routes[name] for name in ("GetNodeStatus", "ListWorkloads", "GetWorkload", "GetRelease")):
            self.assertEqual(binding.method, "GET")
            self.assertEqual(binding.body, "")
        self.assertEqual(routes["GetNodeStatus"].response, pb.NodeStatus)
        self.assertEqual(routes["GetWorkload"].response, pb.WorkloadStatus)
        request = decode_request(routes["GetWorkload"], "/api/v1/workloads/newsletter", [])
        self.assertIsInstance(request, service.GetWorkloadRequest)
        self.assertEqual(request.name, "workloads/newsletter")
        request = decode_request(routes["ListWorkloads"], "/api/v1/workloads", [("page_size", "8")])
        self.assertEqual(request.page_size, 8)

    def test_named_body_and_whole_body_use_the_generated_requests(self):
        routes = {binding.rpc: binding for binding in service.HTTP_BINDINGS}
        request = decode_request(routes["CreateRelease"], "/api/v1/releases",
                                 [("release_id", RELEASE_ID), ("request_id", REQUEST_ID)], create_body())
        self.assertIsInstance(request, service.CreateReleaseRequest)
        self.assertEqual(to_wire(request), {"release_id": RELEASE_ID, "request_id": REQUEST_ID, "release": create_body()})
        path = "/api/v1/releases/" + RELEASE_ID + ":resume"
        request = decode_request(routes["ResumeRelease"], path, [], {"request_id": REQUEST_ID, "etag": "revision-3"})
        self.assertIsInstance(request, service.ResumeReleaseRequest)
        self.assertEqual(request.name, "releases/" + RELEASE_ID)
        self.assertEqual(request.etag, "revision-3")

    def test_mutations_reject_missing_body_unknown_fields_and_overrides(self):
        routes = {binding.rpc: binding for binding in service.HTTP_BINDINGS}
        query = [("release_id", RELEASE_ID), ("request_id", REQUEST_ID)]
        for body in (None, {**create_body(), "commands": ["unsafe"]}, {"targets": create_body()["targets"] * 17}):
            with self.subTest(body=body), self.assertRaises(WireJsonError):
                decode_request(routes["CreateRelease"], "/api/v1/releases", query, body)
        for bad_query in (query + [("request_id", REQUEST_ID)], query + [("release", "override")],
                          [("release_id", "not-a-uuid"), ("request_id", REQUEST_ID)]):
            with self.subTest(query=bad_query), self.assertRaises(WireJsonError):
                decode_request(routes["CreateRelease"], "/api/v1/releases", bad_query, create_body())
        path = "/api/v1/releases/" + RELEASE_ID + ":resume"
        for query, body in (([], {"name": "releases/" + RELEASE_ID, "request_id": REQUEST_ID, "etag": "x"}),
                            ([("etag", "x")], {"request_id": REQUEST_ID, "etag": "x"}),
                            ([], {"request_id": REQUEST_ID}),
                            ([], {"request_id": REQUEST_ID, "etag": "x", "targets": []})):
            with self.subTest(query=query, body=body), self.assertRaises(WireJsonError):
                decode_request(routes["ResumeRelease"], path, query, body)
        with self.assertRaises(WireJsonError):
            decode_request(routes["GetNodeStatus"], "/api/v1/nodeStatus", [], {})

    def test_bounded_json_parser_rejects_duplicate_keys_before_information_is_lost(self):
        self.assertEqual(decode_json_body(b'{"targets":[]}'), {"targets": []})
        for raw in (b'{"etag":"old","etag":"new"}', b'{"release":{"phase":"held","phase":"ready"}}',
                    b'{"value":NaN}', b'[]', b'null', b'\xff', b'{"etag":"' + b'x' * 16384 + b'"}'):
            with self.subTest(raw=raw[:60]), self.assertRaises(WireJsonError):
                decode_json_body(raw)

    def test_duplicate_unknown_out_of_range_query_and_path_overrides_fail(self):
        routes = {binding.rpc: binding for binding in service.HTTP_BINDINGS}
        for query in ([('page_size', '1'), ('page_size', '2')], [('page_size', '17')],
                      [('page_size', '1.0')], [('page_size', 'true')], [('logs', 'private')],
                      [('page_token', 'a' * 129)]):
            with self.subTest(query=query), self.assertRaises(WireJsonError):
                decode_request(routes['ListWorkloads'], '/api/v1/workloads', query)
        with self.assertRaises(WireJsonError):
            decode_request(routes['GetWorkload'], '/api/v1/workloads/newsletter', [('name', 'workloads/other')])
        for path in ('/api/v1/workloads/a%2fb', '/api/v1/workloads/%ff', '/api/v1/workloads/a\\b'):
            self.assertIsNone(match_path(routes['GetWorkload'], path))


class RpcStatus(unittest.TestCase):
    def test_google_code_and_http_tables_match_the_shared_typescript_runtime(self):
        source = (PROTO / 'ts/rpc-status.ts').read_text()
        for name, expected in (('Code', CODE), ('HTTP_STATUS', HTTP_STATUS)):
            block = re.search(r'export const ' + name + r'[^=]*= \{(.*?)\}', source, re.S).group(1)
            actual = {key: int(value) for key, value in re.findall(r'(\w+): (\d+)', block)}
            self.assertEqual(actual, expected)
        body = status_body(RpcError('NOT_FOUND', 'WORKLOAD_NOT_FOUND', 'Configured workload was not found.'))
        self.assertEqual(body['error']['code'], 404)
        self.assertEqual(body['error']['status'], 'NOT_FOUND')
        self.assertEqual(body['error']['details'][0]['@type'], 'type.googleapis.com/google.rpc.ErrorInfo')
        self.assertNotIn('metadata', body['error']['details'][0])

    def test_protocol_errors_have_fixed_safe_identity_and_method_override(self):
        error = RpcError('UNIMPLEMENTED', 'METHOD_NOT_ALLOWED', 'Only GET is supported.', http_status=405)
        self.assertEqual(status_body(error)['error']['code'], 405)
        for kwargs in ({'code': 'invented'}, {'reason': 'private path'}, {'message': 'line\nbreak'},
                       {'domain': 'not a domain'}, {'http_status': 301}):
            values = {'code': 'UNAVAILABLE', 'reason': 'STATUS_UNAVAILABLE', 'message': 'Runtime status is unavailable.'}
            values.update(kwargs)
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                RpcError(**values)
