"""从本机已验证的运行时生成可复制、无需联网安装的 Windows x64 发布目录。"""
import argparse
import hashlib
from importlib import metadata
import json
from pathlib import Path
import shutil
import sys
import zipfile

ROOT = Path(__file__).resolve().parent

# 只打包运行模块、内置课例和当前文档，不从开发目录批量收集文件。
APPLICATION_FILES = (
    "start.bat", "stop.bat", "launch.ps1", "launch.py", "VERSION", "requirements.txt", "README.md",
    "web/index.html", "web/app.js", "web/syntax.js", "web/lab.css", "web/site.css", "web/data-visuals.css",
    "运行器/runner.py", "运行器/server.py",
    "调试器/session.py", "调试器/snapshot.py", "调试器/gdb_state.py", "调试器/structures.py",
    "调试器/io_trace.py", "调试器/access_trace.py", "调试器/mi_transport.py",
    "课例/README.md", "课例/adjacent.json", "课例/array.json", "课例/containers.json", "课例/function.json",
    "课例/matrix.json", "课例/prefix.json", "课例/recursive.json", "课例/swap.json",
    "docs/README.md", "docs/代码实验台-老师使用说明.md", "docs/代码实验台-故障处理.md", "docs/开发说明.md",
    "docs/images/prefix-access.png", "发布/README.md",
)


def digest(path):
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def application(target):
    target = target.resolve()
    if target == ROOT.resolve():
        raise RuntimeError("发布目录不能是源码根目录")
    # 刷新已组装目录时，回收旧清单中已退出发布范围的应用文件。
    old_manifest = target / "manifest.json"
    if old_manifest.exists():
        old_files = json.loads(old_manifest.read_text(encoding="utf-8")).get("files", [])
        obsolete = []
        for entry in old_files:
            name = entry["path"]
            owned = name.startswith(("web/", "运行器/", "调试器/", "探针/", "调研/", "docs/", "课例/")) or name in ("故障处理.md", "验收记录.md")
            if not owned or name in APPLICATION_FILES:
                continue
            path = (target / name).resolve()
            if not path.is_relative_to(target):
                raise RuntimeError("旧发布清单包含目录外路径")
            obsolete.append(path)
        for path in obsolete:
            path.unlink(missing_ok=True)
            parent = path.parent
            while parent != target:
                try:
                    parent.rmdir()
                except OSError:
                    break
                parent = parent.parent
    for name in APPLICATION_FILES:
        source, destination = ROOT / name, target / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)


def publication_files(target):
    """清单和压缩包共用同一范围，避免夹带本地附加文件。"""
    paths = [target / name for name in APPLICATION_FILES]
    for folder in ("runtime", "wheelhouse"):
        paths.extend(path for path in (target / folder).rglob("*")
                     if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc")
    return sorted(paths)


def manifest(target, versions):
    files = []
    for path in publication_files(target):
        files.append({"path": path.relative_to(target).as_posix(), "bytes": path.stat().st_size,
                      "sha256": digest(path)})
    data = {"version": versions, "platform": "Windows x64", "files": files}
    (target / "manifest.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"发布目录已生成：{target}（{sum(item['bytes'] for item in files) / 1024**2:.1f} MB）", flush=True)


def build(target):
    if target.exists():
        raise RuntimeError(f"目标已存在，请选一个新目录：{target}")
    from launch import configure, check
    configure()
    versions = check()
    target.mkdir(parents=True)
    application(target)
    shutil.copytree(ROOT / "wheelhouse", target / "wheelhouse")
    python = Path(sys.base_prefix)
    destination = target / "runtime/python"
    destination.mkdir(parents=True)
    for path in python.iterdir():
        if path.is_file() and (path.suffix in (".exe", ".dll") or path.name == "LICENSE.txt"):
            shutil.copy2(path, destination / path.name)
    for folder in ("DLLs", "Lib"):
        shutil.copytree(python / folder, destination / folder,
                        ignore=shutil.ignore_patterns("__pycache__", "site-packages", "test", "tests",
                                                     "idlelib", "tkinter", "turtledemo"))
    site = destination / "Lib/site-packages"
    site.mkdir()
    for name in ("pygdbmi", "tree-sitter", "tree-sitter-cpp"):
        dist = metadata.distribution(name)
        for file in dist.files:
            if ".." in file.parts or "__pycache__" in file.parts or file.suffix == ".pyc":
                continue
            source, dest = Path(dist.locate_file(file)), site / file
            if source.is_file():
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, dest)
    # 完整复制工具链以保留 GCC 搜索目录、GDB 内置 Python 和第三方许可。
    toolchain = Path(shutil.which("gdb")).parent.parent
    print("复制 UCRT64 工具链（约 1 GB）…", flush=True)
    shutil.copytree(toolchain, target / "runtime/ucrt64",
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    manifest(target, versions)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "发布/代码实验台-1.0.0-Windows-x64")
    parser.add_argument("--zip-only", action="store_true", help="验收后仅将已有发布目录压缩")
    parser.add_argument("--refresh", action="store_true", help="停止服务后同步应用文件并更新清单，保留原有运行时")
    args = parser.parse_args()
    if args.refresh:
        target = args.output.resolve()
        if not (target / "runtime/ucrt64/bin/gdb.exe").exists() or not (target / "VERSION").exists():
            raise RuntimeError("目标不是已组装的发布目录")
        if (target / ".local/service.json").exists():
            raise RuntimeError("请先停止发布目录内的服务")
        application(target)
        versions = json.loads((target / "manifest.json").read_text(encoding="utf-8"))["version"]
        manifest(target, versions)
    elif args.zip_only:
        target = args.output.resolve()
        if (target / ".local/service.json").exists():
            raise RuntimeError("请先停止发布目录内的服务")
        archive = target.with_name(target.name + ".zip")
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=5) as output:
            for item in [*publication_files(target), target / "manifest.json"]:
                output.write(item, str(item.relative_to(target.parent)))
        checksum = digest(archive)
        archive.with_suffix(".zip.sha256").write_text(checksum + "  " + archive.name + "\n", encoding="utf-8")
        print(archive)
    else:
        build(args.output.resolve())
