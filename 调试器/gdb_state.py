"""由 GDB 内置 Python 执行；只读取调试符号，不求值用户表达式。"""
import json
import os
import sys

import gdb
sys.path.insert(0, os.getcwd())
from structures import describe


def collect(destination, windows_path="windows.json"):
    with open(windows_path, encoding="utf-8") as handle:
        windows = json.load(handle)
    frames = []
    variables = []
    frame = gdb.newest_frame()
    globals_seen = set()
    level = 0
    while frame is not None:
        location = frame.find_sal()
        filename = location.symtab.fullname() if location.symtab else None
        try:
            base = str(frame.read_register("fp"))
        except gdb.error:
            base = str(frame.read_register("sp"))
        key = f"{frame.name()}:{base}"
        user = bool(filename and os.path.basename(filename) == "main.cpp")
        frames.append({"level": level, "key": key, "function": frame.name(),
                       "file": filename, "line": location.line or None,
                       "pc": str(frame.pc()), "user": user})
        if user:
            block = frame.block()
            depth = 0
            while block is not None:
                global_scope = block.is_global or block.is_static
                for symbol in block:
                    if not (symbol.is_variable or symbol.is_argument) or symbol.is_artificial:
                        continue
                    if not symbol.symtab or os.path.basename(symbol.symtab.fullname()) != "main.cpp":
                        continue
                    scope = f"{block.start}:{block.end}"
                    owner = "global" if global_scope else key
                    identity = f"{owner}:{scope}:{symbol.line}:{symbol.name}"
                    if global_scope and identity in globals_seen:
                        continue
                    globals_seen.add(identity)
                    item = {"rawId": identity, "name": symbol.name, "type": str(symbol.type),
                            "frameKey": owner, "frame": None if global_scope else level,
                            "declaration": symbol.line, "scope": scope, "depth": depth,
                            "kind": "global" if global_scope else (
                                "argument" if symbol.is_argument else "local"),
                            "staticStorage": symbol.addr_class == gdb.SYMBOL_LOC_STATIC,
                            "rawValue": None, "readError": None}
                    try:
                        value = symbol.value(frame)
                        item["data"] = describe(value, windows.get(identity, {}))
                        if not item["data"]:
                            if value.is_optimized_out or value.is_unavailable:
                                raise gdb.error("调试值不可用或已被优化")
                            item["rawValue"] = value.format_string(raw=True, max_elements=200)
                    except (gdb.error, RuntimeError) as error:
                        item["readError"] = str(error)
                    variables.append(item)
                block = block.superblock
                depth += 1
        frame = frame.older()
        level += 1
    try:
        input_available = bool(gdb.parse_and_eval(
            "*code_lab_io::input_slot == &code_lab_io::input_buffer"))
    except gdb.error:
        input_available = False
    try:
        # 只读实际流状态；不在被调试程序中额外调用 fail()/rdstate()。
        input_succeeded = input_available and bool(gdb.parse_and_eval(
            "(*code_lab_io::input_state & code_lab_io::input_failure_bits) == 0"))
    except gdb.error:
        input_succeeded = False
    with open(destination, "w", encoding="utf-8") as handle:
        json.dump({"frames": frames, "variables": variables,
                   "inputTraceAvailable": input_available,
                   "inputSucceeded": input_succeeded}, handle, ensure_ascii=False)
