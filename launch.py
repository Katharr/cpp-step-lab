"""Windows 课堂入口：检查依赖、托管进程、自动打开页面与完整清理。"""
from __future__ import annotations

import argparse
import atexit
import ctypes
from ctypes import wintypes
from importlib import metadata
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
import webbrowser
from urllib.request import Request, urlopen, ProxyHandler, build_opener

ROOT = Path(__file__).resolve().parent
STATE = ROOT / ".local/service.json"
OPENER = build_opener(ProxyHandler({}))
VERSION = "1.0.0"


def ascii_temp_base():
    base = Path(tempfile.gettempdir())
    if not str(base).isascii():
        base = Path(os.environ.get("PUBLIC", "C:/Users/Public")) / "CodeLabTemp"
    if not str(base).isascii():
        raise RuntimeError("系统临时目录和 PUBLIC 均含非 ASCII 字符，请将 TEMP 设置为可写的英文路径。")
    base.mkdir(parents=True, exist_ok=True)
    return base


def remove_alias(directory):
    if directory:
        # junction 必须用 rmdir 仅移除入口，绝不递归操作其目标。
        try:
            (Path(directory) / "ucrt64").rmdir()
            Path(directory).rmdir()
        except OSError:
            pass


def configure():
    # 不继承其它 Python 环境，也不修改系统 PATH。
    os.environ.pop("PYTHONHOME", None)
    os.environ.pop("PYTHONPATH", None)
    tool = ROOT / "runtime/ucrt64/bin"
    if not tool.exists():
        tool = Path("C:/msys64/ucrt64/bin")
    if tool.exists():
        alias = None
        if os.name == "nt" and not str(tool).isascii():
            import _winapi
            alias = Path(tempfile.mkdtemp(prefix="code-lab-tools-", dir=ascii_temp_base()))
            _winapi.CreateJunction(str(tool.parent), str(alias / "ucrt64"))
            atexit.register(remove_alias, alias)
            tool = alias / "ucrt64/bin"
        os.environ["PATH"] = str(tool) + os.pathsep + os.environ.get("PATH", "")
        os.environ["CXX"] = str(tool / "g++.exe")
        # GCC 链接器会解析 junction 的真实中文路径，显式给出英文搜索目录。
        prefix = tool.parent / "lib/gcc"
        os.environ["GCC_EXEC_PREFIX"] = prefix.as_posix() + "/"
        libraries = [tool.parent / "lib", *prefix.glob("*/*")]
        os.environ["LIBRARY_PATH"] = os.pathsep.join(str(path) for path in libraries if path.is_dir())
        return alias
    return None


def check():
    if sys.version_info < (3, 10):
        raise RuntimeError("需要 Python 3.10 及以上；推荐本包附带的 Python 3.14.3。")
    required = (ROOT / "requirements.txt").read_text(encoding="utf-8").splitlines()
    for line in required:
        name, expected = line.split("==")
        try:
            actual = metadata.version(name)
        except metadata.PackageNotFoundError:
            actual = "未安装"
        if actual != expected:
            raise RuntimeError(f"{name} 需要 {expected}，当前 {actual}。\n"
                               f'安装："{sys.executable}" -m pip install -r "{ROOT / "requirements.txt"}"\n'
                               f'离线安装："{sys.executable}" -m pip install --no-index --find-links "{ROOT / "wheelhouse"}" -r "{ROOT / "requirements.txt"}"')
    report = {"app": "code-lab", "version": VERSION, "python": sys.version.split()[0]}
    for name in ("g++", "gdb"):
        executable = os.environ.get("CXX") if name == "g++" else shutil.which(name)
        if not executable:
            raise RuntimeError("缺少 GCC/GDB。请在 MSYS2 UCRT64 终端执行：\n"
                               "pacman -S mingw-w64-ucrt-x86_64-gcc mingw-w64-ucrt-x86_64-gdb\n"
                               "也可使用发布包中完整的 runtime 目录。")
        result = subprocess.run([executable, "--version"], capture_output=True, timeout=15)
        if result.returncode:
            raise RuntimeError(f"{name} 无法启动，请保留 runtime 的完整目录结构。")
        report[name] = result.stdout.decode("utf-8", errors="replace").splitlines()[0]
    gdb = Path(shutil.which("gdb"))
    data = gdb.parent.parent / "share/gdb"
    result = subprocess.run([str(gdb), *(["--data-directory=" + str(data)] if data.is_dir() else []),
                             "--nx", "--batch", "-ex",
                             "python import sys, gdb; print('CODE_LAB_PYTHON_OK')"],
                            capture_output=True, timeout=15)
    if result.returncode or b"CODE_LAB_PYTHON_OK" not in result.stdout:
        raise RuntimeError("GDB 内置 Python 不可用，请使用发布包的完整 UCRT64 工具链。")
    sys.path.insert(0, str(ROOT / "运行器"))
    from runner import compile_source
    with tempfile.TemporaryDirectory(prefix="code-lab-check-", dir=ascii_temp_base()) as directory:
        work = Path(directory)
        source = work / "check.cpp"
        source.write_text('#include <iostream>\nint main() { std::cout << 7; return 0; }\n', encoding="utf-8")
        compiled, executable = compile_source(os.environ.get("CXX") or shutil.which("g++"), source, work, 30, "c++14")
        if executable is None:
            raise RuntimeError("编译器自检失败：" + compiled.get("stderr", "编译超时"))
        ran = subprocess.run([str(executable)], capture_output=True, timeout=5)
        if ran.returncode or ran.stdout != b"7":
            raise RuntimeError("编译器运行库自检失败，请保留 runtime 完整目录。")
    report["compileRun"] = "passed"
    return report


def job_guard():
    """窗口被关闭或入口被强制终止时，Windows 自动终止所属子进程树。"""
    if os.name != "nt":
        return None
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    class Basic(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                    ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD),
                    ("SchedulingClass", wintypes.DWORD)]
    class IO(ctypes.Structure):
        _fields_ = [(name, ctypes.c_uint64) for name in
                    ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                     "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]
    class Extended(ctypes.Structure):
        _fields_ = [("BasicLimitInformation", Basic), ("IoInfo", IO),
                    ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    handle = kernel.CreateJobObjectW(None, None)
    limits = Extended()
    limits.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not handle or not kernel.SetInformationJobObject(handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
        raise ctypes.WinError(ctypes.get_last_error())
    if not kernel.AssignProcessToJobObject(handle, kernel.GetCurrentProcess()):
        raise RuntimeError("无法建立进程清理保护，请在普通 PowerShell 或双击 start.bat 启动。")
    # 不能在清理前 CloseHandle：会连同入口自身一起结束。由系统退出时关闭。
    return handle


def state():
    try:
        return json.loads(STATE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def request(url, data=None):
    req = Request(url, data=json.dumps(data).encode() if data is not None else None,
                  headers={"Content-Type": "application/json"})
    with OPENER.open(req, timeout=3) as response:
        return json.load(response)


def alive(saved):
    try:
        return saved and request(saved["url"] + "api/health").get("app") == "code-lab"
    except (OSError, ValueError, KeyError):
        return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--stop", action="store_true")
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    if args.check:
        configure()
        print(json.dumps(check(), ensure_ascii=False, indent=2))
        return 0
    saved = state()
    if args.stop:
        if not alive(saved):
            print("服务未运行。")
            return 0
        request(saved["url"] + "api/shutdown", {"token": saved["token"]})
        deadline = time.monotonic() + 45
        while (state() or {}).get("token") == saved["token"] and time.monotonic() < deadline:
            time.sleep(0.1)
        if (state() or {}).get("token") == saved["token"]:
            raise RuntimeError("停止等待超时，请查看启动窗口；尚未确认清理完成。")
        print("服务已停止，所属进程和临时文件已清理。")
        return 0
    if alive(saved):
        print("已有实验台正在运行：" + saved["url"])
        if not args.no_browser:
            webbrowser.open(saved["url"])
        return 0
    alias = configure()
    check()
    # 所有调试与编译临时文件放入本次入口的目录；硬关闭后的目录在下次启动回收。
    base = ascii_temp_base()
    if saved:
        old = Path(saved.get("workDir", "")).resolve()
        if old.parent == base.resolve() and old.name.startswith("code-lab-owned-"):
            shutil.rmtree(old, ignore_errors=True)
        old_alias = Path(saved.get("aliasDir") or ".").absolute()
        if old_alias.parent == base.absolute() and old_alias.name.startswith("code-lab-tools-"):
            remove_alias(old_alias)
    work = Path(tempfile.mkdtemp(prefix="code-lab-owned-", dir=base))
    os.environ["TEMP"] = os.environ["TMP"] = str(work)
    tempfile.tempdir = str(work)
    sys.path.insert(0, str(ROOT / "运行器"))
    from server import LabServer
    server = None
    token = uuid.uuid4().hex
    try:
        try:
            server = LabServer(("127.0.0.1", args.port))
        except OSError as error:
            raise RuntimeError(f"端口 {args.port} 被占用，未停止其它程序。可运行 start.bat --port 8766。") from error
        server.shutdown_token = token
        url = f"http://127.0.0.1:{server.server_port}/"
        STATE.parent.mkdir(exist_ok=True)
        STATE.write_text(json.dumps({"pid": os.getpid(), "token": token, "url": url,
                                    "workDir": str(work), "aliasDir": str(alias) if alias else None}), encoding="utf-8")
        print(f"代码实验台 {VERSION} 已启动：{url}\n保持此窗口开启；下课后按 Ctrl+C 或双击 stop.bat。", flush=True)
        if not args.no_browser:
            # 先打开系统浏览器，再把服务自身加入 Job，避免连浏览器一起回收。
            try:
                os.startfile(url) if os.name == "nt" else webbrowser.open(url)
            except OSError:
                print("未能自动打开浏览器，请复制以上地址到 Edge；服务继续运行。", flush=True)
        guard = job_guard()
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        if server:
            server.server_close()
        shutil.rmtree(work, ignore_errors=True)
        if (state() or {}).get("token") == token:
            STATE.unlink(missing_ok=True)
        print("已停止，所属调试进程和临时文件已清理。", flush=True)
    return 0


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"启动失败：{error}", file=sys.stderr)
        raise SystemExit(1)
