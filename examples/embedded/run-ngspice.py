"""Run two DC operating points with the installed ngspice shared library.

API reference: https://ngspice.sourceforge.io/shared.html
No third-party Python package is required. The caller supplies the library path.
"""
import argparse
import ctypes as c
import hashlib
import json
import math
import os
from pathlib import Path
import sys


class VectorInfo(c.Structure):
    _fields_ = [("name", c.c_char_p), ("type", c.c_int), ("flags", c.c_short),
                ("real", c.POINTER(c.c_double)), ("complex", c.c_void_p),
                ("length", c.c_int)]


def simulate(library, netlist):
    library = Path(library).resolve(strict=True)
    # Keep the handle alive while ctypes loads adjacent dependent DLLs.
    dll_directory = os.add_dll_directory(str(library.parent)) if os.name == "nt" else None
    try:
        lib = c.CDLL(str(library))
        messages = []
        exits = []
        send_type = c.CFUNCTYPE(c.c_int, c.c_char_p, c.c_int, c.c_void_p)
        exit_type = c.CFUNCTYPE(c.c_int, c.c_int, c.c_bool, c.c_bool, c.c_int, c.c_void_p)

        def send(message, _identity, _data):
            messages.append(message.decode("utf-8", "replace"))
            return 0

        def controlled_exit(status, _immediate, quitting, _identity, _data):
            if not quitting:
                exits.append(status)
            return 0

        send_callback = send_type(send)
        exit_callback = exit_type(controlled_exit)
        lib.ngSpice_Init.argtypes = [c.c_void_p] * 7
        lib.ngSpice_Init.restype = c.c_int
        lib.ngSpice_Command.argtypes = [c.c_char_p]
        lib.ngSpice_Command.restype = c.c_int
        lib.ngSpice_Circ.argtypes = [c.POINTER(c.c_char_p)]
        lib.ngSpice_Circ.restype = c.c_int
        lib.ngGet_Vec_Info.argtypes = [c.c_char_p]
        lib.ngGet_Vec_Info.restype = c.POINTER(VectorInfo)
        lib.ngSpice_Init(send_callback, None, exit_callback, None, None, None, None)

        def command(text):
            if lib.ngSpice_Command(text.encode("ascii")) != 0 or exits:
                raise RuntimeError(f"ngspice command failed: {text}; {messages[-5:]}")

        command("set nomoremode")
        command("version")
        version_log = list(messages)
        content = netlist.read_bytes()
        lines = [line.encode("utf-8") for line in content.decode("utf-8").splitlines()]
        circuit = (c.c_char_p * (len(lines) + 1))(*lines, None)
        if lib.ngSpice_Circ(circuit) != 0 or exits:
            raise RuntimeError(f"Unable to load circuit: {messages[-5:]}")

        def value(name):
            pointer = lib.ngGet_Vec_Info(name.encode("ascii"))
            if not pointer or pointer.contents.length != 1 or not pointer.contents.real:
                raise RuntimeError(f"No scalar result for {name}")
            result = pointer.contents.real[0]
            if not math.isfinite(result):
                raise RuntimeError(f"Non-finite circuit result for {name}")
            return result

        points = []
        for state, control in [("on", 3.3), ("off", 0)]:
            command(f"alter VCONTROL {control}")
            command("op")
            points.append({"state": state, "current_a": -value("vsupply#branch"),
                           "drain_v": value("drain")})
        on, off = points
        if not (0.099 < on["current_a"] < 0.100 and 0.004 < on["drain_v"] < 0.006
                and 0 <= off["current_a"] < 20e-9):
            raise RuntimeError(f"Circuit acceptance failed: {points}")
        return {"check_id": "EM-CHECK-005", "status": "passed", "method": "spice-simulation",
                "library": str(library), "library_sha256": hashlib.sha256(library.read_bytes()).hexdigest(),
                "netlist_sha256": hashlib.sha256(content).hexdigest(),
                "version_log": version_log, "operating_points": points,
                "log": messages, "limitations": ["Ideal switch and nominal resistive load only.",
                                                  "No physical hardware or transient validation."]}
    finally:
        if dll_directory:
            dll_directory.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--library", required=True, help="Installed ngspice DLL/shared library path")
    parser.add_argument("--netlist", type=Path, default=Path(__file__).with_name("load-switch.cir"))
    args = parser.parse_args()
    try:
        print(json.dumps(simulate(args.library, args.netlist), indent=2))
    except (OSError, ValueError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
