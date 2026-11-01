"""在 GDB Python 中把真实调试值转为有界序列；不解析 pretty-printer 文本。"""
import gdb


def element(value, index, coordinates):
    item = {"index": index, "coordinates": coordinates, "state": "ok", "value": None, "note": None}
    try:
        if value.is_optimized_out or value.is_unavailable:
            raise gdb.error("调试值不可用或已被优化")
        item["value"] = value.format_string(raw=True, max_elements=8)
    except (gdb.error, RuntimeError) as error:
        item.update(state="unavailable", note="读取失败：" + str(error))
    return item


def describe(value, window):
    """窗口按行优先的线性下标定位；始终只解引用窗口内元素。"""
    kind = value.type.strip_typedefs()
    if kind.code in (gdb.TYPE_CODE_REF, gdb.TYPE_CODE_RVALUE_REF):
        value = value.referenced_value()
        kind = value.type.strip_typedefs()
    name = str(kind)
    view = {"kind": None, "shape": [], "lowerBounds": [], "total": 0,
            "offset": 0, "limit": window.get("limit", 50), "elements": [],
            "hidden": 0, "state": "ok", "note": None}
    try:
        if kind.code == gdb.TYPE_CODE_ARRAY:
            dimensions, lower = [], []
            while kind.code == gdb.TYPE_CODE_ARRAY:
                start, end = kind.range()
                dimensions.append(int(end - start + 1))
                lower.append(int(start))
                kind = kind.target().strip_typedefs()
            view.update(kind="matrix" if len(dimensions) == 2 else "array",
                        shape=dimensions, lowerBounds=lower)
            if len(dimensions) > 2:
                raise gdb.error("暂不展开三维及以上数组")
            total = dimensions[0] * (dimensions[1] if len(dimensions) == 2 else 1)

            def read(index):
                coords = ([index // dimensions[1] + lower[0], index % dimensions[1] + lower[1]]
                          if len(dimensions) == 2 else [index + lower[0]])
                current = value
                for coordinate in coords:
                    current = current[coordinate]
                return current, coords
        elif name.startswith(("std::vector<", "std::__debug::vector<")):
            view["kind"] = "vector"
            # libstdc++ 的调试字段，同其现成 printer 的长度/元素来源；不调用 inferior 方法。
            if str(kind.template_argument(0)).strip() == "bool":
                raise gdb.error("vector<bool> 为位压缩特化，暂不可靠展开")
            start = value["_M_impl"]["_M_start"]
            finish = value["_M_impl"]["_M_finish"]
            total = int(finish - start)
            view["shape"], view["lowerBounds"] = [total], [0]

            def read(index):
                return (start + index).dereference(), [index]
        elif ("basic_string<char," in name or name in ("std::string", "std::__cxx11::string")):
            view["kind"] = "string"
            printer = gdb.default_visualizer(value)
            if printer is not None:
                lazy = printer.to_string()
                if not isinstance(lazy, gdb.LazyString):
                    raise gdb.error("string 格式化器未返回可按长度读取的字符序列")
                total = int(lazy.length)
                start = gdb.Value(lazy.address).cast(lazy.type)
            else:
                # 本机 GCC 未安装 Python printers，复用 libstdc++ 可读的长度和数据指针。
                total = int(value["_M_string_length"])
                start = value["_M_dataplus"]["_M_p"]
            if total < 0:
                raise gdb.error("string 长度不可确认")
            view["shape"], view["lowerBounds"] = [total], [0]
            view["note"] = "按 char 字节显示；UTF-8 中文占多个格子，保留内嵌空字符"

            def read(index):
                return (start + index).dereference(), [index]
        else:
            return None
        if total < 0 or total > 2 ** 53 - 1:
            raise gdb.error("元素数量异常，未读取")
        offset = min(max(0, window.get("offset", 0)), max(0, total - 1))
        view.update(total=total, offset=offset)
        for index in range(offset, min(total, offset + view["limit"])):
            try:
                current, coords = read(index)
                item = element(current, index, coords)
            except (gdb.error, RuntimeError) as error:
                coords = ([index // view["shape"][1] + view["lowerBounds"][0],
                           index % view["shape"][1] + view["lowerBounds"][1]]
                          if view["kind"] == "matrix" else [index + view["lowerBounds"][0]])
                item = {"index": index, "coordinates": coords, "state": "unavailable",
                        "value": None, "note": "读取失败：" + str(error)}
            view["elements"].append(item)
        view["hidden"] = total - len(view["elements"])
    except (gdb.error, RuntimeError, ValueError, TypeError) as error:
        view.update(state="unavailable", note="无法可靠展开：" + str(error))
    return view
