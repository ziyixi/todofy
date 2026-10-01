"""Protobuf IDL of the cross-app contracts, as stdlib-only Python (proto/README.md).

``ziyixi_proto.wire_json`` is the hand-written wire JSON codec; every subpackage (``ziyixi_proto.todofy``,
...) is generated from proto/ by proto/tools/gen_py.py when the package is built (``uv sync``) and is never
committed.
"""
