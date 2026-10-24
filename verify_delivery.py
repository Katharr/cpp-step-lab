"""Spec 06 Windows 发布验收：隔离 PATH、正常停止、硬关闭和编译子进程回收。"""
from concurrent.futures import ThreadPoolExecutor
import ctypes
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
from urllib.request import Request, build_opener, ProxyHandler
import uuid

ROOT = Path(__file__).resolve().parent
PACKAGE = ROOT / "发布/代码实验台-1.0.0-Windows-x64"
OUTPUT = ROOT / "验收输出"
STATE = PACKAGE / ".local/service.json"
BASE = "http://127.0.0.1:8765"
OPENER = build_opener(ProxyHandler({}))
checks = []


def http(route, data=None):
    request = Request(BASE + route, data=json.dumps(data).encode() if data is not None else None,
                      headers={"Content-Type": "application/json"})
    with OPENER.open(request, timeout=40) as response:
        return json.load(response)


def wait_for(predicate, seconds=15):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.1)
    raise AssertionError("等待验收条件超时")


def state():
    try:
        return json.loads(STATE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def running(pid):
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
    handle = kernel.OpenProcess(0x100000, False, pid)
    if not handle:
        return False
    try:
        return kernel.WaitForSingleObject(handle, 0) == 258
    finally:
        kernel.CloseHandle(handle)


def descendants(pid):
    command = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress"
    result = subprocess.run(["powershell.exe", "-NoProfile", "-Command", command],
                            capture_output=True, text=True, timeout=15)
    rows = json.loads(result.stdout)
    owned, found = {pid}, []
    for _ in range(10):
        for row in rows:
            if row["ParentProcessId"] in owned and row["ProcessId"] not in owned:
                owned.add(row["ProcessId"])
                found.append(row)
    return found


def run_bat(name, *args, wait=True):
    env = os.environ.copy()
    # 发布包必须独立于系统 Python、MSYS2 和项目虚拟环境。
    system = Path(os.environ["SystemRoot"])
    env["PATH"] = os.pathsep.join(str(p) for p in (system / "System32", system,
        system / "System32/WindowsPowerShell/v1.0"))
    env.pop("PYTHONHOME", None)
    env.pop("PYTHONPATH", None)
    command = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
               str(PACKAGE / "launch.ps1"), *args]
    # 同 start.bat 调用的唯一入口；bat 外壳另在命令行实测。
    process = subprocess.Popen(command, env=env, cwd=PACKAGE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if wait:
        output = process.communicate(timeout=50)[0].decode("utf-8", errors="replace")
        assert process.returncode == 0, output
        return output
    return process


def start():
    process = run_bat("start", "--no-browser", wait=False)
    def ready():
        saved = state()
        if not saved or not running(saved["pid"]):
            return False
        try:
            return http("/api/health")["app"] == "code-lab"
        except OSError:
            return False
    wait_for(ready)
    return process, state()


def begin(code="int main() {\n int x = 1; // x = 示例的数\n return 0;\n}\n"):
    identity = uuid.uuid4().hex
    snapshot = http("/api/start", {"sessionId": identity, "source": code})
    assert snapshot["status"] == "paused", snapshot
    return identity, snapshot


def record(name, fn):
    started = time.monotonic()
    detail = fn()
    checks.append({"name": name, "seconds": round(time.monotonic() - started, 3), "detail": detail})
    print("通过：" + name, flush=True)


def dependencies():
    report = json.loads(run_bat("start", "--check"))
    assert report["compileRun"] == "passed"
    return report


def lifecycle():
    process, saved = start()
    try:
        again = run_bat("start", "--no-browser")
        assert "已有实验台" in again and state()["pid"] == saved["pid"]
        identity, snapshot = begin()
        children = descendants(saved["pid"])
        assert any(row["Name"] == "gdb.exe" for row in children), children
        assert any(row["Name"] == "main.exe" for row in children), children
        http("/api/close", {"sessionId": identity})
        wait_for(lambda: all(not running(row["ProcessId"]) for row in children))
        identity, snapshot = begin('int main() {\n while (true) { }\n}\n')
        children = descendants(saved["pid"])
        with ThreadPoolExecutor() as executor:
            pending = executor.submit(http, "/api/command", {"sessionId": identity,
                "runId": snapshot["runId"], "command": "next"})
            time.sleep(0.3)
            run_bat("stop", "--stop")
            assert pending.result(timeout=15)["status"] == "stopped"
        process.communicate(timeout=20)
        assert process.returncode == 0
        assert not STATE.exists() and not Path(saved["workDir"]).exists()
        assert not Path(saved["aliasDir"]).exists()
        assert all(not running(row["ProcessId"]) for row in children)
        return {"servicePid": saved["pid"], "ownedProcesses": children, "allExited": True,
                "tempRemoved": True, "pageCloseReleasedDebugger": True}
    finally:
        if process.poll() is None:
            run_bat("stop", "--stop")
            process.communicate(timeout=20)


def hard_close():
    process, saved = start()
    begin()
    children = descendants(saved["pid"])
    # 只终止服务 Python，自身 Job 必须负责结束 GDB 和 inferior。
    subprocess.run(["taskkill", "/PID", str(saved["pid"]), "/F"], capture_output=True, check=True)
    process.communicate(timeout=20)
    wait_for(lambda: all(not running(row["ProcessId"]) for row in children))
    fresh, current = start()
    try:
        assert not Path(saved["workDir"]).exists()
        assert not Path(saved["aliasDir"]).exists()
        begin()
    finally:
        run_bat("stop", "--stop")
        fresh.communicate(timeout=20)
    return {"servicePid": saved["pid"], "ownedProcesses": children,
            "allExited": True, "staleTempRecovered": True}


def compiler_cancel():
    sys.path.insert(0, str(ROOT / "运行器"))
    from runner import compile_source
    with tempfile.TemporaryDirectory(prefix="code-lab-compiler-test-") as directory:
        work = Path(directory)
        compiler = work / "fake-compiler.cmd"
        compiler.write_text("@echo off\nping -t 127.0.0.1 >nul\n", encoding="ascii")
        source = work / "source.cpp"
        source.write_text("int main() {}", encoding="ascii")
        cancellation = threading.Event()
        with ThreadPoolExecutor() as executor:
            future = executor.submit(compile_source, str(compiler), source, work, 20, "c++14",
                                     cancellation=cancellation)
            time.sleep(0.3)
            children = [row for row in descendants(os.getpid()) if row["Name"] in ("cmd.exe", "PING.EXE", "ping.exe")]
            assert len(children) >= 2, children
            cancellation.set()
            try:
                future.result(timeout=15)
                raise AssertionError("编译未取消")
            except InterruptedError:
                pass
            assert all(not running(row["ProcessId"]) for row in children)
    return {"cancelled": True, "compilerTreeExited": True}


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    OUTPUT.mkdir(exist_ok=True)
    try:
        record("隔离系统 PATH：发布包依赖检查、编译与执行", dependencies)
        record("页面会话清理、重复启动、执行中停止服务", lifecycle)
        record("强制关闭：所属进程回收与下次启动清理", hard_close)
        record("编译中取消：编译器子进程树回收", compiler_cancel)
    finally:
        (OUTPUT / "lifecycle.json").write_text(json.dumps({"status": "passed" if len(checks) == 4 else "failed",
            "checks": checks}, ensure_ascii=False, indent=2), encoding="utf-8")
