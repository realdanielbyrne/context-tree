#!/usr/bin/env python3
"""Self-verifying generator for sw-6-ripple (the cross-cutting-migration
long-horizon task).

sw-5-dozen forces a big trace through twelve fully INDEPENDENT modules
(read one, fix it, move on, forget it). This scenario forces the OTHER
long-horizon texture: a cross-cutting migration that RIPPLES. A shared core
module (`record.py`, a tiny schema-validated record builder) must move to a
new documented contract — keyword-only constructors, renamed dict keys, a
new validation error type, changed return shapes — and TEN independent
dependent modules that all call into it must each be updated to match,
while every dependent's OWN documented output format stays byte-identical.
That forces long dependency-following chains (read core, read a dependent,
edit both ends of the call, re-run, repeat x10) rather than sw-5's
throwaway-context module-at-a-time pattern — plus, with eleven files each
60-100+ lines, another big trace.

Same self-verification contract as build-refactor-scenario.py, scaled to
eleven files instead of five:
  - the shipped v1 (legacy) core + all ten dependents must FAIL the hidden
    v2 suite, and smoke.py must fail (not print "MIGRATION OK");
  - the migrated v2 reference (core + all ten dependents) must PASS the
    hidden suite fully, and smoke.py must print "MIGRATION OK";
  - total shipped+hidden content must exceed 45,000 characters.
Only then does the row get upserted into the scenarios-long JSONL
(append-or-replace by id, rows sorted by id, so re-running the two
scenarios-long builders in either order is byte-identical).
"""

import json
import pathlib
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
JSONL = (
    HERE.parent
    / "scenarios-long"
    / "deepswe-agents-last-exam"
    / "agents-last-exam.jsonl"
)

DEPENDENT_NAMES = (
    "person",
    "product",
    "address",
    "event",
    "invoice",
    "employee",
    "vehicle",
    "ticket",
    "booking",
    "device",
)

# ------------------------------------------------------------- shipped (v1)

V1_RECORD = '''\
"""minirecord — schema-validated record builder (v1 API; see MIGRATION.md
for the v2 API every dependent module in this project must migrate to).

v1 record shape: {"type": str, "fields": dict, "errors": list[str]}

Contract (v1, as currently shipped):
- define_schema(name, required, optional=None) -> schema dict
  {"name": name, "required": list(required), "optional": list(optional
  or [])}. `name` is a positional string; `required` and `optional` are
  positional iterables of field-name strings.
- make_record(schema, data) -> a record built from the dict `data`:
  every required field present in `data` is copied into "fields"; every
  required field ABSENT from `data` adds a message to "errors" instead
  of raising (missing required fields are collected, not fatal); every
  optional field present in `data` is copied into "fields" too. Any key
  in `data` that isn't part of the schema (neither required nor
  optional) is silently dropped, never copied into "fields".
- is_valid(record) -> bool: True iff record["errors"] is empty.
- get_field(record, key, default=None) -> record["fields"].get(key,
  default).

Examples:
    schema = define_schema("widget", ["sku", "name"], ["note"])
    r = make_record(schema, {"sku": "w1", "name": "Widget"})
    is_valid(r)               -> True
    get_field(r, "sku")       -> "w1"
    get_field(r, "note", "-") -> "-"

    r2 = make_record(schema, {"sku": "w2"})
    is_valid(r2)              -> False
    r2["errors"]              -> ["missing required field: name"]

Rationale:
Callers historically preferred a "collect every error, then let the
caller decide what to do" style over raising, since some call sites
render a form back to a user with every missing field highlighted at
once rather than stopping at the first problem encountered. MIGRATION.md
documents exactly why and how that design has changed for v2 across
every module in this project — this docstring describes only what is
CURRENTLY shipped, not the target.

Notes:
- Every dependent module in this project defines its own schema once,
  at import time, and reuses it for every call to make_record.
- Field values are copied by reference, not deep-copied; a mutable value
  placed in `data` and later mutated by the caller will also appear to
  change inside any record already built from it.
"""


def define_schema(name, required, optional=None):
    """Build a schema dict from a name plus required/optional field lists."""
    return {"name": name, "required": list(required), "optional": list(optional or [])}


def make_record(schema, data):
    """Build a record from `data`, collecting missing-required errors."""
    errors = []
    fields = {}
    for key in schema["required"]:
        if key not in data:
            errors.append("missing required field: %s" % key)
        else:
            fields[key] = data[key]
    for key in schema["optional"]:
        if key in data:
            fields[key] = data[key]
    return {"type": schema["name"], "fields": fields, "errors": errors}


def is_valid(record):
    """True iff `record` has no missing-required-field errors."""
    return len(record["errors"]) == 0


def get_field(record, key, default=None):
    """Look up `key` in record["fields"], with a default if absent."""
    return record["fields"].get(key, default)
'''

_DEP_DOC = {
    "person": (
        "Person",
        ["name", "email"],
        ["age"],
        "Name: %s | Email: %s | Age: %s",
        ("name", "email", "age"),
    ),
    "product": (
        "Product",
        ["sku", "name", "price"],
        ["description"],
        "SKU: %s | Name: %s | Price: %s | Description: %s",
        ("sku", "name", "price", "description"),
    ),
    "address": (
        "Address",
        ["street", "city", "zip_code"],
        ["country"],
        "Street: %s | City: %s | Zip: %s | Country: %s",
        ("street", "city", "zip_code", "country"),
    ),
    "event": (
        "Event",
        ["title", "start_date"],
        ["end_date", "location"],
        "Title: %s | Start: %s | End: %s | Location: %s",
        ("title", "start_date", "end_date", "location"),
    ),
    "invoice": (
        "Invoice",
        ["invoice_id", "amount"],
        ["due_date"],
        "Invoice: %s | Amount: %s | Due: %s",
        ("invoice_id", "amount", "due_date"),
    ),
    "employee": (
        "Employee",
        ["emp_id", "name", "department"],
        ["manager"],
        "ID: %s | Name: %s | Dept: %s | Manager: %s",
        ("emp_id", "name", "department", "manager"),
    ),
    "vehicle": (
        "Vehicle",
        ["vin", "make", "model"],
        ["year"],
        "VIN: %s | Make: %s | Model: %s | Year: %s",
        ("vin", "make", "model", "year"),
    ),
    "ticket": (
        "Ticket",
        ["ticket_id", "subject", "priority"],
        ["assignee"],
        "Ticket: %s | Subject: %s | Priority: %s | Assignee: %s",
        ("ticket_id", "subject", "priority", "assignee"),
    ),
    "booking": (
        "Booking",
        ["booking_id", "guest_name", "checkin"],
        ["checkout", "room"],
        "Booking: %s | Guest: %s | Checkin: %s | Checkout: %s | Room: %s",
        ("booking_id", "guest_name", "checkin", "checkout", "room"),
    ),
    "device": (
        "Device",
        ["device_id", "device_type"],
        ["firmware", "location"],
        "Device: %s | Type: %s | Firmware: %s | Location: %s",
        ("device_id", "device_type", "firmware", "location"),
    ),
}

_DEP_TEST_DATA = {
    "person": (
        {"name": "Alice", "email": "alice@example.com", "age": 30},
        "Name: Alice | Email: alice@example.com | Age: 30",
        {"name": "Alice"},
        {"name": "Bob", "email": "b@x.com"},
        "Name: Bob | Email: b@x.com | Age: N/A",
    ),
    "product": (
        {"sku": "p1", "name": "Widget", "price": 999, "description": "nice"},
        "SKU: p1 | Name: Widget | Price: 999 | Description: nice",
        {"sku": "p1", "name": "Widget"},
        {"sku": "p2", "name": "Gadget", "price": 500},
        "SKU: p2 | Name: Gadget | Price: 500 | Description: N/A",
    ),
    "address": (
        {"street": "1 Main St", "city": "Springfield", "zip_code": "12345", "country": "US"},
        "Street: 1 Main St | City: Springfield | Zip: 12345 | Country: US",
        {"street": "1 Main St", "zip_code": "12345"},
        {"street": "2 Elm St", "city": "Shelbyville", "zip_code": "54321"},
        "Street: 2 Elm St | City: Shelbyville | Zip: 54321 | Country: N/A",
    ),
    "event": (
        {"title": "Standup", "start_date": "2026-01-05", "end_date": "2026-01-05", "location": "Room A"},
        "Title: Standup | Start: 2026-01-05 | End: 2026-01-05 | Location: Room A",
        {"title": "Standup"},
        {"title": "Retro", "start_date": "2026-01-06"},
        "Title: Retro | Start: 2026-01-06 | End: N/A | Location: N/A",
    ),
    "invoice": (
        {"invoice_id": "INV-1", "amount": 250, "due_date": "2026-02-01"},
        "Invoice: INV-1 | Amount: 250 | Due: 2026-02-01",
        {"invoice_id": "INV-1"},
        {"invoice_id": "INV-2", "amount": 100},
        "Invoice: INV-2 | Amount: 100 | Due: N/A",
    ),
    "employee": (
        {"emp_id": "E1", "name": "Chris", "department": "Eng", "manager": "Dana"},
        "ID: E1 | Name: Chris | Dept: Eng | Manager: Dana",
        {"emp_id": "E1", "name": "Chris"},
        {"emp_id": "E2", "name": "Sam", "department": "Sales"},
        "ID: E2 | Name: Sam | Dept: Sales | Manager: N/A",
    ),
    "vehicle": (
        {"vin": "1HGCM82633A004352", "make": "Honda", "model": "Accord", "year": 2003},
        "VIN: 1HGCM82633A004352 | Make: Honda | Model: Accord | Year: 2003",
        {"vin": "1HGCM82633A004352", "make": "Honda"},
        {"vin": "2T1BURHE0JC014906", "make": "Toyota", "model": "Corolla"},
        "VIN: 2T1BURHE0JC014906 | Make: Toyota | Model: Corolla | Year: N/A",
    ),
    "ticket": (
        {"ticket_id": "T1", "subject": "Bug", "priority": "high", "assignee": "Jo"},
        "Ticket: T1 | Subject: Bug | Priority: high | Assignee: Jo",
        {"ticket_id": "T1", "subject": "Bug"},
        {"ticket_id": "T2", "subject": "Feature", "priority": "low"},
        "Ticket: T2 | Subject: Feature | Priority: low | Assignee: N/A",
    ),
    "booking": (
        {"booking_id": "B1", "guest_name": "Lee", "checkin": "2026-03-01", "checkout": "2026-03-03", "room": "204"},
        "Booking: B1 | Guest: Lee | Checkin: 2026-03-01 | Checkout: 2026-03-03 | Room: 204",
        {"booking_id": "B1", "guest_name": "Lee"},
        {"booking_id": "B2", "guest_name": "Kim", "checkin": "2026-04-01"},
        "Booking: B2 | Guest: Kim | Checkin: 2026-04-01 | Checkout: N/A | Room: N/A",
    ),
    "device": (
        {"device_id": "D1", "device_type": "sensor", "firmware": "1.2.0", "location": "Roof"},
        "Device: D1 | Type: sensor | Firmware: 1.2.0 | Location: Roof",
        {"device_id": "D1"},
        {"device_id": "D2", "device_type": "camera"},
        "Device: D2 | Type: camera | Firmware: N/A | Location: N/A",
    ),
}

_DEP_RATIONALE = {
    "person": (
        "A person's age is the one field routinely unknown at signup time —\n"
        "treating it as optional (rather than requiring a placeholder value)\n"
        "keeps the signup form free to ask for it later without a schema\n"
        "change."
    ),
    "product": (
        "description is optional because bulk-imported catalog rows from\n"
        "some supplier feeds simply don't include one; every other field is\n"
        "required because pricing and lookup logic elsewhere in the wider\n"
        "system assume sku, name, and price always exist."
    ),
    "address": (
        "country defaults to \"N/A\" rather than a hardcoded country code,\n"
        "because this module is shared across catalogs for multiple\n"
        "countries and silently defaulting to any one of them would be\n"
        "wrong for the others."
    ),
    "event": (
        "Both end_date and location are optional because a freshly created,\n"
        "still-being-scheduled event legitimately has neither yet; only\n"
        "title and start_date are required to reserve a calendar slot at\n"
        "all."
    ),
    "invoice": (
        "due_date is optional because some invoices are due on receipt and\n"
        "simply have no distinct due date to record."
    ),
    "employee": (
        "manager is optional because the most senior role in an org chart\n"
        "has no manager at all, and this module must still be able to\n"
        "represent that person."
    ),
    "vehicle": (
        "year is optional because it is sometimes unknown for older or\n"
        "heavily modified vehicles logged by this system."
    ),
    "ticket": (
        "assignee is optional because a newly filed ticket is legitimately\n"
        "unassigned until triage happens."
    ),
    "booking": (
        "checkout and room are both optional because a booking can be\n"
        "reserved (checkin locked in) before a specific room is assigned or\n"
        "a checkout date is finalized."
    ),
    "device": (
        "firmware and location are optional because a freshly provisioned\n"
        "device may not have reported either yet."
    ),
}


def _build_v1_dependent(key):
    label, required, optional, fmt, field_order = _DEP_DOC[key]
    valid, valid_out, missing, partial, partial_out = _DEP_TEST_DATA[key]
    omitted = sorted(set(required) - set(missing.keys()))[0]
    cls_line = "Schema: required %s; optional %s." % (
        ", ".join('"%s"' % f for f in required),
        ", ".join('"%s"' % f for f in optional),
    )
    getters = "\n".join(
        '    %s = get_field(record, "%s")' % (f, f) for f in required
    ) + (
        ("\n" + "\n".join(
            '    %s = get_field(record, "%s", "N/A")' % (f, f) for f in optional
        ))
        if optional
        else ""
    )
    fmt_args = ", ".join(field_order)
    required_list = ", ".join('"%s"' % f for f in required)
    optional_list = ", ".join('"%s"' % f for f in optional)
    a_or_an = "n" if label[0] in "AEIOU" else ""
    optional_notes = (
        "- Every optional field this module has (%s) falls back to the\n"
        "  literal string \"N/A\" in summarize_%s's output, never to an\n"
        "  empty string or the Python value None, so the output is always\n"
        "  safe to print directly."
        % (", ".join('"%s"' % f for f in optional), key)
        if optional
        else "- This module has no optional fields; every field in its schema\n"
        "  must be present in `data` or build_%s raises/records an error." % key
    )
    return '''\
"""%s.py — %s records built on minirecord (v1 API; see MIGRATION.md for
the v2 API this module must migrate to).

%s

Contract (must hold before AND after the record.py migration to v2 —
only the calls into minirecord change here; this module's own external
behavior, including its exact summarize format, does not change):
- build_%s(data) -> a minirecord record built from `data` using this
  module's schema.
- summarize_%s(record) -> one "Field: value" segment per schema field,
  in the fixed order shown below, joined by " | ", using "N/A" in place
  of any missing optional field.

Examples:
    summarize_%s(build_%s(%r))
        -> %r
    summarize_%s(build_%s(%r))
        -> %r

Rationale:
%s

Notes:
- Field order in the output never changes and never depends on the
  order of keys in `data` — it always follows this module's own
  documented order, listed above.
%s
- This module never imports from any of the other dependent modules in
  this project; it only depends on record.py.
- Any key in `data` that isn't part of this module's schema is silently
  ignored by build_%s — it never ends up in the built record and never
  appears in summarize_%s's output.
- A required field present in `data` with a falsy value (0, "", False)
  still counts as present; only an outright MISSING key triggers the
  missing-required-field behavior documented in record.py.
"""

from record import define_schema, get_field, make_record

SCHEMA = define_schema("%s", [%s], [%s])


def build_%s(data):
    """Build a minirecord record for a%s %s from `data`."""
    return make_record(SCHEMA, data)


def summarize_%s(record):
    """Format a %s record per this module's documented field order."""
%s
    return "%s" %% (%s)
''' % (
        key,
        label,
        cls_line,
        key,
        key,
        key,
        key,
        valid,
        valid_out,
        key,
        key,
        partial,
        partial_out,
        _DEP_RATIONALE[key],
        optional_notes,
        key,
        key,
        key,
        required_list,
        optional_list,
        key,
        a_or_an,
        label.lower(),
        key,
        label.lower(),
        getters,
        fmt,
        fmt_args,
    )


V1_DEPENDENTS = {name + ".py": _build_v1_dependent(name) for name in DEPENDENT_NAMES}

# ------------------------------------------------------------ reference (v2)

FIXED_RECORD = '''\
class SchemaError(Exception):
    pass


def define_schema(*, name, required, optional=()):
    return {"name": name, "required": tuple(required), "optional": tuple(optional)}


def make_record(schema, *, values):
    missing = [key for key in schema["required"] if key not in values]
    if missing:
        raise SchemaError(
            "%s: missing required field(s): %s" % (schema["name"], ", ".join(missing))
        )
    kept = tuple(schema["required"]) + tuple(schema["optional"])
    record_values = {key: values[key] for key in kept if key in values}
    return {"schema": schema["name"], "values": record_values}


def get_value(record, *, key, default=None):
    return record["values"].get(key, default)
'''


def _build_v2_dependent(key):
    label, required, optional, fmt, field_order = _DEP_DOC[key]
    required_kw = ", ".join('"%s"' % f for f in required)
    optional_kw = ", ".join('"%s"' % f for f in optional)
    getters = "\n".join(
        '    %s = get_value(record, key="%s")' % (f, f) for f in required
    ) + (
        ("\n" + "\n".join(
            '    %s = get_value(record, key="%s", default="N/A")' % (f, f)
            for f in optional
        ))
        if optional
        else ""
    )
    fmt_args = ", ".join(field_order)
    return '''\
from record import define_schema, get_value, make_record

SCHEMA = define_schema(name="%s", required=(%s), optional=(%s))


def build_%s(data):
    return make_record(SCHEMA, values=data)


def summarize_%s(record):
%s
    return "%s" %% (%s)
''' % (
        key,
        required_kw + ("," if len(required) == 1 else ""),
        optional_kw + ("," if len(optional) == 1 else ""),
        key,
        key,
        getters,
        fmt,
        fmt_args,
    )


V2_DEPENDENTS = {name + ".py": _build_v2_dependent(name) for name in DEPENDENT_NAMES}

# ------------------------------------------------------------------ MIGRATION

MIGRATION = """\
# minirecord v2 migration guide

v2 replaces v1 completely across every module in this project. After the
migration NO public minirecord function may accept a positional call for
any parameter documented below as keyword-only, and NO record dict may
carry the old "type"/"fields"/"errors" keys. `python3 smoke.py` must
print "MIGRATION OK" once every module below is migrated.

## record.py (the core module)

### Record shape

    v1: {"type": str, "fields": dict, "errors": list[str]}
    v2: {"schema": str, "values": dict}

### define_schema

    v1: define_schema(name, required, optional=None)
    v2: define_schema(*, name, required, optional=())

- all three parameters become keyword-only; a positional call must raise
  TypeError.
- returns {"name": name, "required": tuple(required), "optional":
  tuple(optional)} (tuples now, not lists — callers must not rely on
  the return value being mutable).

### make_record

    v1: make_record(schema, data)
    v2: make_record(schema, *, values)

- `values` becomes keyword-only.
- if any field in schema["required"] is missing from `values`, raise
  `SchemaError` (a new exception class defined in record.py, a subclass
  of Exception) instead of collecting an errors list. There is no more
  "invalid but returned anyway" record — construction either succeeds
  or raises.
- on success, the returned record's "values" dict contains every key
  from schema["required"] + schema["optional"] that is present in
  `values` — exactly as v1 did for "fields" — and drops any key in
  `values` that isn't part of the schema. Field values are still copied
  by reference, unchanged from v1.

### is_valid — REMOVED

v1's `is_valid(record)` has no v2 equivalent and must not be called
anywhere after the migration: a record that would have been "invalid"
in v1 now simply never gets constructed, because make_record raises
instead. Any caller that used `is_valid` must switch to a
try/except SchemaError around its make_record call.

### get_field -> get_value (renamed)

    v1: get_field(record, key, default=None)
    v2: get_value(record, *, key, default=None)

- same lookup behavior (record["values"].get(key, default) instead of
  record["fields"].get(key, default)); `key` and `default` become
  keyword-only.

## Every dependent module (person.py, product.py, address.py, event.py,
## invoice.py, employee.py, vehicle.py, ticket.py, booking.py, device.py)

Each dependent module defines its own schema once at import time and
exposes exactly two functions, `build_<entity>(data)` and
`summarize_<entity>(record)`. Neither function's name, parameters, or
documented output format changes in this migration — only how each
talks to record.py changes, in exactly three places per module:

1. The module-level `SCHEMA = define_schema(...)` line must switch from
   positional args to `define_schema(name=..., required=(...),
   optional=(...))`.
2. `build_<entity>` must switch its `make_record(SCHEMA, data)` call to
   `make_record(SCHEMA, values=data)`. No try/except is needed inside
   build_<entity> itself: a SchemaError raised by make_record for a
   missing required field should propagate straight out to the caller
   unchanged — that propagation, not a caught-and-reported error, is
   the intended v2 behavior for every dependent.
3. `summarize_<entity>` must switch every `get_field(record, key[,
   default])` call to `get_value(record, key=key[, default=default])`,
   preserving each field's exact position and separator in that
   module's own documented output format — the "N/A" fallback text for
   a missing optional field is a convention every dependent module
   already documents in its own docstring and does not change here.

Each dependent module's own docstring is the authoritative spec for
its required/optional field names and its exact summarize format —
this guide intentionally does not repeat them, since the two must never
drift out of sync and only one of them (the module's own docstring)
should ever need to change if a field is ever added.

## Verifying your work

`python3 smoke.py` runs one check against record.py directly (that its
constructors are now keyword-only and make_record raises SchemaError)
plus one check per dependent module (a valid build+summarize round trip,
plus a missing-required-field call that must raise SchemaError). It
prints "MIGRATION OK" only once every one of those eleven checks passes.
"""

SMOKE = '''\
"""Quick sanity check that the v1 -> v2 minirecord migration is complete.

Run: python3 smoke.py
Prints one OK/FAIL line for record.py itself, then one per dependent
module, then a summary. DO NOT EDIT this file — migrate the eleven
modules instead.
"""

results = []


def check(name, fn):
    try:
        fn()
        results.append((name, True, ""))
    except Exception as e:
        results.append((name, False, "%s: %s" % (type(e).__name__, e)))


def check_record():
    from record import SchemaError, define_schema, make_record

    try:
        define_schema("x", ["a"], [])
    except TypeError:
        pass
    else:
        raise AssertionError("define_schema should be keyword-only")

    schema = define_schema(name="x", required=("a",), optional=())
    try:
        make_record(schema, values={})
    except SchemaError:
        pass
    else:
        raise AssertionError("make_record should raise SchemaError for a missing field")


def check_person():
    from record import SchemaError
    from person import build_person, summarize_person

    rec = build_person({"name": "Alice", "email": "alice@example.com", "age": 30})
    assert summarize_person(rec) == "Name: Alice | Email: alice@example.com | Age: 30", rec
    try:
        build_person({"name": "Alice"})
    except SchemaError:
        pass
    else:
        raise AssertionError("build_person should raise SchemaError when email is missing")


def check_product():
    from record import SchemaError
    from product import build_product, summarize_product

    rec = build_product({"sku": "p1", "name": "Widget", "price": 999, "description": "nice"})
    assert summarize_product(rec) == "SKU: p1 | Name: Widget | Price: 999 | Description: nice", rec
    try:
        build_product({"sku": "p1", "name": "Widget"})
    except SchemaError:
        pass
    else:
        raise AssertionError("build_product should raise SchemaError when price is missing")


def check_address():
    from record import SchemaError
    from address import build_address, summarize_address

    rec = build_address(
        {"street": "1 Main St", "city": "Springfield", "zip_code": "12345", "country": "US"}
    )
    assert summarize_address(rec) == "Street: 1 Main St | City: Springfield | Zip: 12345 | Country: US", rec
    try:
        build_address({"street": "1 Main St", "zip_code": "12345"})
    except SchemaError:
        pass
    else:
        raise AssertionError("build_address should raise SchemaError when city is missing")


def check_event():
    from record import SchemaError
    from event import build_event, summarize_event

    rec = build_event(
        {"title": "Standup", "start_date": "2026-01-05", "end_date": "2026-01-05", "location": "Room A"}
    )
    assert summarize_event(rec) == "Title: Standup | Start: 2026-01-05 | End: 2026-01-05 | Location: Room A", rec
    try:
        build_event({"title": "Standup"})
    except SchemaError:
        pass
    else:
        raise AssertionError("build_event should raise SchemaError when start_date is missing")


def check_invoice():
    from record import SchemaError
    from invoice import build_invoice, summarize_invoice

    rec = build_invoice({"invoice_id": "INV-1", "amount": 250, "due_date": "2026-02-01"})
    assert summarize_invoice(rec) == "Invoice: INV-1 | Amount: 250 | Due: 2026-02-01", rec
    try:
        build_invoice({"invoice_id": "INV-1"})
    except SchemaError:
        pass
    else:
        raise AssertionError("build_invoice should raise SchemaError when amount is missing")


def check_employee():
    from record import SchemaError
    from employee import build_employee, summarize_employee

    rec = build_employee({"emp_id": "E1", "name": "Chris", "department": "Eng", "manager": "Dana"})
    assert summarize_employee(rec) == "ID: E1 | Name: Chris | Dept: Eng | Manager: Dana", rec
    try:
        build_employee({"emp_id": "E1", "name": "Chris"})
    except SchemaError:
        pass
    else:
        raise AssertionError("build_employee should raise SchemaError when department is missing")


def check_vehicle():
    from record import SchemaError
    from vehicle import build_vehicle, summarize_vehicle

    rec = build_vehicle({"vin": "1HGCM82633A004352", "make": "Honda", "model": "Accord", "year": 2003})
    assert summarize_vehicle(rec) == "VIN: 1HGCM82633A004352 | Make: Honda | Model: Accord | Year: 2003", rec
    try:
        build_vehicle({"vin": "1HGCM82633A004352", "make": "Honda"})
    except SchemaError:
        pass
    else:
        raise AssertionError("build_vehicle should raise SchemaError when model is missing")


def check_ticket():
    from record import SchemaError
    from ticket import build_ticket, summarize_ticket

    rec = build_ticket({"ticket_id": "T1", "subject": "Bug", "priority": "high", "assignee": "Jo"})
    assert summarize_ticket(rec) == "Ticket: T1 | Subject: Bug | Priority: high | Assignee: Jo", rec
    try:
        build_ticket({"ticket_id": "T1", "subject": "Bug"})
    except SchemaError:
        pass
    else:
        raise AssertionError("build_ticket should raise SchemaError when priority is missing")


def check_booking():
    from record import SchemaError
    from booking import build_booking, summarize_booking

    rec = build_booking(
        {"booking_id": "B1", "guest_name": "Lee", "checkin": "2026-03-01", "checkout": "2026-03-03", "room": "204"}
    )
    assert (
        summarize_booking(rec)
        == "Booking: B1 | Guest: Lee | Checkin: 2026-03-01 | Checkout: 2026-03-03 | Room: 204"
    ), rec
    try:
        build_booking({"booking_id": "B1", "guest_name": "Lee"})
    except SchemaError:
        pass
    else:
        raise AssertionError("build_booking should raise SchemaError when checkin is missing")


def check_device():
    from record import SchemaError
    from device import build_device, summarize_device

    rec = build_device({"device_id": "D1", "device_type": "sensor", "firmware": "1.2.0", "location": "Roof"})
    assert summarize_device(rec) == "Device: D1 | Type: sensor | Firmware: 1.2.0 | Location: Roof", rec
    try:
        build_device({"device_id": "D1"})
    except SchemaError:
        pass
    else:
        raise AssertionError("build_device should raise SchemaError when device_type is missing")


CHECKS = [
    ("record", check_record),
    ("person", check_person),
    ("product", check_product),
    ("address", check_address),
    ("event", check_event),
    ("invoice", check_invoice),
    ("employee", check_employee),
    ("vehicle", check_vehicle),
    ("ticket", check_ticket),
    ("booking", check_booking),
    ("device", check_device),
]

for _name, _fn in CHECKS:
    check(_name, _fn)

_ok_count = 0
for _name, _ok, _reason in results:
    if _ok:
        _ok_count += 1
        print("%s: OK" % _name)
    else:
        print("%s: FAIL (%s)" % (_name, _reason))

if _ok_count == len(results):
    print("MIGRATION OK")
else:
    print("%d/%d checks OK" % (_ok_count, len(results)))
'''

README = """\
# minirecord

A tiny schema-validated record-building library, mid-migration:

- core library: `record.py`
- ten independent dependents, each built on record.py: `person.py`,
  `product.py`, `address.py`, `event.py`, `invoice.py`, `employee.py`,
  `vehicle.py`, `ticket.py`, `booking.py`, `device.py`

All eleven modules still implement the legacy v1 minirecord API.
`MIGRATION.md` is the authoritative spec for the v2 API they must all
move to; `smoke.py` exercises v2 through every dependent and prints
"MIGRATION OK" only once the migration is complete.

Each dependent's own docstring is the full spec for that module's field
names and output format — those never change in this migration, only how
each module talks to record.py does.
"""

TASK = """\
The working directory contains `minirecord`, a small schema-validated
record-building library (`record.py`), plus TEN independent modules that
each build on it: person.py, product.py, address.py, event.py, invoice.py,
employee.py, vehicle.py, ticket.py, booking.py, and device.py. Each
dependent exposes exactly two functions, build_<entity>(data) and
summarize_<entity>(record), documented in its own docstring.

All eleven modules currently implement the legacy v1 minirecord API:
positional define_schema/make_record calls, an errors-list validation
style instead of exceptions, and get_field lookups. `MIGRATION.md` is the
authoritative spec for the v2 API record.py must move to: keyword-only
constructors, renamed dict keys and functions, and a new SchemaError
exception raised by make_record instead of a collected errors list.

Migrate record.py to v2 exactly as MIGRATION.md specifies. Then migrate
each of the ten dependent modules to call the new v2 API. Only how each
module talks to record.py should change — never a dependent's own field
names, its exact "Field: value | ..." summarize format, or any other
behavior documented in that module's own docstring.

Work in this order: read MIGRATION.md fully, migrate record.py, then
migrate the ten dependents one at a time, in any order, re-running
`python3 smoke.py` after each one to watch its check turn from FAIL to
OK. Do not modify smoke.py or MIGRATION.md.

You are done when `python3 smoke.py` prints "MIGRATION OK". Then reply
DONE.
"""

# --------------------------------------------------------------- hidden tests

_CASES = []


def _case(group, expr, expected):
    _CASES.append((group, expr, expected))


# record.py itself
_case(
    "record",
    'define_schema(name="p", required=("a",), optional=("b",))',
    {"name": "p", "required": ("a",), "optional": ("b",)},
)
_case("record", 'define_schema("p", ["a"], ["b"])', "raised TypeError")
_case(
    "record",
    'make_record(define_schema(name="s", required=("x",), optional=()), values={})',
    "raised SchemaError",
)
_case(
    "record",
    'make_record(define_schema(name="s", required=("x",), optional=("y",)), '
    'values={"x": 1, "y": 2, "z": 9})',
    {"schema": "s", "values": {"x": 1, "y": 2}},
)
_case("record", 'get_value({"schema": "s", "values": {"x": 1}}, key="x")', 1)
_case(
    "record",
    'get_value({"schema": "s", "values": {"x": 1}}, key="z", default=None)',
    None,
)

for _dep in DEPENDENT_NAMES:
    _valid, _valid_out, _missing, _partial, _partial_out = _DEP_TEST_DATA[_dep]
    _case(_dep, "summarize_%s(build_%s(%r))" % (_dep, _dep, _valid), _valid_out)
    _case(_dep, "build_%s(%r)" % (_dep, _missing), "raised SchemaError")
    _case(_dep, "summarize_%s(build_%s(%r))" % (_dep, _dep, _partial), _partial_out)


def build_hidden_test() -> str:
    lines = ["import sys", "from record import *"]
    for name in DEPENDENT_NAMES:
        lines.append("from %s import *" % name)
    lines.append("")
    lines.append("failures = 0")
    for group, expr, expected in _CASES:
        lines.append("try:")
        lines.append("    got = %s" % expr)
        lines.append("except Exception as e:")
        lines.append("    got = 'raised %s' % type(e).__name__")
        lines.append("if got != %r:" % (expected,))
        lines.append(
            "    print('FAIL [%s] %%r -> %%r (want %%r)' %% (%r, got, %r))"
            % (group, expr, expected)
        )
        lines.append("    failures += 1")
    lines.append("")
    lines.append("if failures:")
    lines.append("    print('%d case(s) failed' % failures)")
    lines.append("    sys.exit(1)")
    lines.append("print('all %d cases passed')" % len(_CASES))
    return "\n".join(lines) + "\n"


# ------------------------------------------------------------------- helpers


def write_files(root: pathlib.Path, files: dict) -> None:
    for name, content in files.items():
        (root / name).write_text(content, encoding="utf-8")


def run(root: pathlib.Path, script: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, script], capture_output=True, text=True, cwd=str(root)
    )


def upsert_row(row: dict) -> None:
    """Append-or-replace this script's row by id; rows stay sorted by id so
    the scenarios-long builders can run in any order and stay byte-identical
    across re-runs."""
    JSONL.parent.mkdir(parents=True, exist_ok=True)
    rows = []
    if JSONL.exists():
        for line in JSONL.read_text(encoding="utf-8").splitlines():
            if line.strip():
                rows.append(json.loads(line))
    rows = [r for r in rows if r.get("id") != row["id"]]
    rows.append(row)
    rows.sort(key=lambda r: r["id"])
    JSONL.write_text(
        "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows),
        encoding="utf-8",
    )


# ------------------------------------------------------------------------ main


def main() -> None:
    hidden = build_hidden_test()

    row = {
        "id": "sw-6-ripple",
        "task": TASK,
        "files": {
            "record.py": V1_RECORD,
            **V1_DEPENDENTS,
            "smoke.py": SMOKE,
            "MIGRATION.md": MIGRATION,
            "README.md": README,
        },
        "judge_command": "python3 run_hidden_tests.py",
        "judge_files": {"run_hidden_tests.py": hidden},
    }

    print("line counts:")
    for name, content in row["files"].items():
        if name.endswith(".py"):
            print("  %-14s %d lines" % (name, len(content.splitlines())))

    fixed_files = {
        "record.py": FIXED_RECORD,
        **V2_DEPENDENTS,
    }

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = pathlib.Path(tmp)

        write_files(tmp_path, {**row["files"], **row["judge_files"]})
        buggy = run(tmp_path, "run_hidden_tests.py")
        print("=== V1 judge exit=%s ===" % buggy.returncode)
        print((buggy.stdout + buggy.stderr)[-2000:])
        assert buggy.returncode != 0, "legacy v1 files should FAIL the hidden v2 suite"

        buggy_smoke = run(tmp_path, "smoke.py")
        print("=== V1 smoke ===")
        print(buggy_smoke.stdout[-800:])
        assert "MIGRATION OK" not in buggy_smoke.stdout, "smoke.py should not pass against v1"

        write_files(tmp_path, fixed_files)
        fixed = run(tmp_path, "run_hidden_tests.py")
        print("=== V2 judge exit=%s ===" % fixed.returncode)
        print((fixed.stdout + fixed.stderr)[-400:])
        assert fixed.returncode == 0, "migrated v2 reference should PASS the hidden suite"
        assert ("all %d cases passed" % len(_CASES)) in fixed.stdout

        fixed_smoke = run(tmp_path, "smoke.py")
        print("=== V2 smoke ===")
        print(fixed_smoke.stdout[-800:])
        assert "MIGRATION OK" in fixed_smoke.stdout, "smoke.py should print MIGRATION OK on v2"

    total_chars = (
        len(row["task"])
        + sum(len(c) for c in row["files"].values())
        + sum(len(c) for c in row["judge_files"].values())
    )
    print("sw-6-ripple total content: %d chars" % total_chars)
    assert total_chars > 45000, "sw-6-ripple content must exceed 45,000 chars, got %d" % total_chars

    upsert_row(row)
    print(
        "OK: sw-6-ripple upserted; v1 FAILS (%d cases) / v2 PASSES / smoke.py MIGRATION OK / "
        "%d chars total" % (len(_CASES), total_chars)
    )


if __name__ == "__main__":
    main()
