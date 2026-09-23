#!/usr/bin/env python3
"""Send the backend the tool schema the client wrote, and never crash building it.

THE MEASUREMENT (2026-09-23, live, forge 0.9.5). One tool, one parameter
declared ``{"type": ["string", "number"]}`` — a JSON Schema type LIST, which
MCP servers emit for any union — sent through forge::

    {"error": {"message": "unhashable type: 'list'", "type": "proxy_error"}}

HTTP 502, and llama-server never saw the request. The same body sent straight
to llama-server returned three well-formed tool calls. Any MCP tool with such a
parameter takes the whole turn down with it, on every request that carries it.

WHERE IT COMES FROM

``ToolSpec.from_json_schema`` turns every client schema into a pydantic model,
through ``_json_schema_to_type``, which does ``if json_type in type_map`` — a
dict lookup, and a list is unhashable. The same function has a second, SILENT
defect that the crash was hiding. It knows five shapes (enum, the four scalar
types, object, array) and maps everything else to ``str``, because a property
with no ``type`` key defaults to ``"string"``. Measured on the same image, each
of these came back from ``get_json_schema()`` as ``{"type": "string"}``::

    anyOf / oneOf / allOf / $ref / const / {"description": "..."}

and tuple-form ``items`` (a list) raised ``AttributeError``.

WHY THE SILENT ONE MATTERS MORE THAN IT LOOKS

``get_json_schema()`` is what reaches the backend whenever forge does not
forward the client's tools verbatim: always on the Anthropic protocol
(``handler.py`` sets ``raw_tools_for_backend = None`` for it), and on the OpenAI
protocol in prompt mode and on retries. llama-server compiles the parameter
schema into the sampling GRAMMAR. So an ``anyOf: [string, integer]`` parameter
became a string-only grammar, and the model could not emit the integer the tool
asked for — not "was not told to", could not.

WHAT THIS PATCH DOES

1. ``from_json_schema`` keeps a private deep copy of the client's schema, and
   ``get_json_schema()`` returns a copy of it. The backend gets exactly what the
   client authored, on every path — the same thing the OpenAI native
   passthrough already does on the paths it covers. A spec forge builds itself
   (``ToolSpec(parameters=Model)``, e.g. the respond tool) has no client schema
   and keeps upstream's ``model_json_schema()``.
2. ``_json_schema_to_type`` understands every shape above instead of guessing
   ``str``: a type list and anyOf/oneOf become a ``Union`` (``"null"`` becomes
   ``None``), a single-member allOf is that member, ``const`` is a one-value
   ``Literal``, tuple-form items is a plain ``list``, and anything it cannot
   express — a ``$ref``, an untyped property, a multi-member allOf — is
   ``Any``. ``Any`` is the honest answer: the schema, not the model, is now the
   source of truth for the backend, so the model only has to not lie.

WHAT IT DELIBERATELY DOES NOT DO

**It does not validate arguments against the schema.** forge 0.9.5 does not
either (``response_validator.py`` only checks that args are a dict); the model
built here is not on the argument path at all. Adding validation would be a new
guardrail, not a fix.

**It does not resolve ``$ref``.** The client's ``$defs`` travel with the
verbatim schema, which is where llama-server resolves them.
"""

from __future__ import annotations

import sys
from pathlib import Path

WORKFLOW_REL = "forge/core/workflow.py"

MARKER = "_forge_raw_schema"

IMPORT_OLD = "from pydantic import BaseModel, ConfigDict, Field, create_model\n"
IMPORT_NEW = (
    "import copy as _forge_copy\n"
    "from typing import Union as _ForgeUnion\n"
    "\n"
    "from pydantic import BaseModel, ConfigDict, Field, PrivateAttr, create_model\n"
)

# Everything between the enum branch and the scalar lookup: the line that
# crashes on a list and the default that turns an untyped property into str.
TYPE_OLD = (
    '    json_type = prop.get("type", "string")\n'
    "\n"
    "    type_map: dict[str, type] = {\n"
)
TYPE_NEW = (
    "    # patches/forge_tool_schema.py: the shapes upstream mapped to str or\n"
    "    # crashed on. The backend is sent the client's schema verbatim now, so\n"
    "    # this model only has to not lie about it.\n"
    '    if "const" in prop:\n'
    "        try:\n"
    '            return Literal[prop["const"]]  # type: ignore[valid-type]\n'
    "        except TypeError:\n"
    "            return Any  # type: ignore[return-value]\n"
    '    for _forge_key in ("anyOf", "oneOf"):\n'
    "        if isinstance(prop.get(_forge_key), list):\n"
    "            return _forge_union(\n"
    "                [_json_schema_to_type(m, field_name, model_name_prefix)\n"
    "                 for m in prop[_forge_key] if isinstance(m, dict)]\n"
    "            )\n"
    '    if isinstance(prop.get("allOf"), list):\n'
    '        if len(prop["allOf"]) == 1 and isinstance(prop["allOf"][0], dict):\n'
    '            return _json_schema_to_type(prop["allOf"][0], field_name, model_name_prefix)\n'
    "        return Any  # type: ignore[return-value]\n"
    '    if "type" not in prop:\n'
    "        return Any  # type: ignore[return-value]\n"
    '    if isinstance(prop["type"], list):\n'
    "        return _forge_union(\n"
    "            [_json_schema_to_type({**prop, \"type\": t}, field_name, model_name_prefix)\n"
    '             for t in prop["type"] if isinstance(t, str)]\n'
    "        )\n"
    "\n"
    '    json_type = prop["type"]\n'
    '    if json_type == "null":\n'
    "        return type(None)\n"
    "\n"
    "    type_map: dict[str, type] = {\n"
)

# Tuple-form items is a list of schemas; upstream calls .get on it.
ITEMS_OLD = (
    '        items = prop.get("items", {})\n'
    "        if items:\n"
)
ITEMS_NEW = (
    '        items = prop.get("items", {})\n'
    "        if items and isinstance(items, dict):\n"
)

HELPER_ANCHOR = "def _json_schema_to_type(\n"
HELPER = '''def _forge_union(members: list) -> type:
    """Union of converted schema members, deduplicated; Any if there are none.

    patches/forge_tool_schema.py. Any member that is Any makes the union Any.
    """
    unique: list = []
    for m in members:
        if m is Any:
            return Any  # type: ignore[return-value]
        if m not in unique:
            unique.append(m)
    if not unique:
        return Any  # type: ignore[return-value]
    if len(unique) == 1:
        return unique[0]
    return _ForgeUnion[tuple(unique)]  # type: ignore[return-value]


'''

FIELDS_OLD = (
    "    name: str\n"
    "    description: str\n"
    "    parameters: type[BaseModel]\n"
)
FIELDS_NEW = (
    "    name: str\n"
    "    description: str\n"
    "    parameters: type[BaseModel]\n"
    "    # patches/forge_tool_schema.py: the client's schema, verbatim, when this\n"
    "    # spec was built from one. None for specs forge authors itself.\n"
    "    _forge_raw_schema: dict[str, Any] | None = PrivateAttr(default=None)\n"
)

FROM_OLD = (
    "        params_cls = _build_model(properties, required, model_name)\n"
    "        return cls(name=name, description=description, parameters=params_cls)\n"
)
FROM_NEW = (
    "        params_cls = _build_model(properties, required, model_name)\n"
    "        spec = cls(name=name, description=description, parameters=params_cls)\n"
    "        spec._forge_raw_schema = _forge_copy.deepcopy(schema)\n"
    "        return spec\n"
)

GET_OLD = (
    '        """Return JSON Schema dict for this tool\'s parameters."""\n'
    "        return self.parameters.model_json_schema()\n"
)
GET_NEW = (
    '        """Return JSON Schema dict for this tool\'s parameters."""\n'
    "        # The client's own schema when there is one: the model is lossy.\n"
    "        if self._forge_raw_schema is not None:\n"
    "            return _forge_copy.deepcopy(self._forge_raw_schema)\n"
    "        return self.parameters.model_json_schema()\n"
)

EDITS = (
    ("pydantic import", IMPORT_OLD, IMPORT_NEW),
    ("type lookup", TYPE_OLD, TYPE_NEW),
    ("array items", ITEMS_OLD, ITEMS_NEW),
    ("_json_schema_to_type anchor", HELPER_ANCHOR, HELPER + HELPER_ANCHOR),
    ("ToolSpec fields", FIELDS_OLD, FIELDS_NEW),
    ("from_json_schema return", FROM_OLD, FROM_NEW),
    ("get_json_schema body", GET_OLD, GET_NEW),
)


def fail(message: str) -> None:
    print(f"forge_tool_schema: {message}", file=sys.stderr)
    raise SystemExit(1)


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        fail("usage: forge_tool_schema.py <site-packages-dir>")
    root = Path(argv[0])
    if not root.is_dir():
        fail(f"{root} is not a directory")

    path = root / WORKFLOW_REL
    if not path.is_file():
        fail(f"{path} not found — is this a forge install?")

    source = path.read_text()
    if MARKER in source:
        print(f"forge_tool_schema: {WORKFLOW_REL} already patched")
        return 0

    for label, old, _new in EDITS:
        count = source.count(old)
        if count != 1:
            fail(
                f"expected 1 occurrence of the {label} in {WORKFLOW_REL}, found "
                f"{count}. forge changed it — re-read the file before shipping."
            )

    for _label, old, new in EDITS:
        source = source.replace(old, new)
    path.write_text(source)
    print(f"forge_tool_schema: patched {WORKFLOW_REL} "
          f"(client tool schemas reach the backend verbatim)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
