"""GDB/MI 管道与原始日志；命令执行和进程清理由会话 Transport 管理。"""
import json
from pathlib import Path


def save_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


class Tee:
    """在 pygdbmi 读取管道时旁路保存原字节，不自行切分或解析 MI。"""

    def __init__(self, source, destination):
        self.source = source
        self.destination = destination

    def __getattr__(self, name):
        return getattr(self.source, name)

    def readline(self, *args):
        data = self.source.readline(*args)
        if data:
            self.destination.write(data)
            self.destination.flush()
        return data

    def read(self, *args):
        data = self.source.read(*args)
        if data:
            self.destination.write(data)
            self.destination.flush()
        return data


class Session:
    """创建 pygdbmi 控制器与日志句柄，交由具体会话提供 command/close。"""

    def __init__(self, gdb, directory):
        from pygdbmi.gdbcontroller import GdbController

        self.files = []
        self.controller = None
        self.token = 0
        self.directory = directory
        self.stdout = self.open("stdout.mi", "wb")
        self.stderr = self.open("stderr.mi", "wb")
        self.commands = self.open("commands.txt", "w", encoding="utf-8")
        self.parsed = self.open("parsed.jsonl", "w", encoding="utf-8")
        try:
            data = Path(gdb).absolute().parent.parent / "share/gdb"
            self.controller = GdbController(
                command=[gdb, *(["--data-directory=" + str(data)] if data.is_dir() else []),
                         "--nx", "--quiet", "--interpreter=mi2"],
                time_to_check_for_additional_output_sec=0.02,
            )
            io = self.controller.io_manager
            io.stdout = Tee(io.stdout, self.stdout)
            io.stderr = Tee(io.stderr, self.stderr)
        except Exception:
            self.close()
            raise

    def open(self, name, mode, **kwargs):
        handle = (self.directory / name).open(mode, **kwargs)
        self.files.append(handle)
        return handle
