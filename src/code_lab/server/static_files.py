"""只提供项目网页资源与内置课例；不开放目录浏览或源码访问。"""
from urllib.parse import unquote

from code_lab.paths import WEB, LESSONS

WEB_FOLDERS = ("core", "features", "presentation", "shared", "styles")
WEB_ROOT_FILES = ("index.html", "app.js")
MIME_TYPES = {".html": "text/html", ".js": "text/javascript", ".css": "text/css",
              ".json": "application/json"}


def static_files():
    files = {}
    for name in WEB_ROOT_FILES:
        path = WEB / name
        if path.is_file() and path.resolve().is_relative_to(WEB.resolve()):
            files["/" + name] = (path, MIME_TYPES[path.suffix])
    for folder in WEB_FOLDERS:
        for path in (WEB / folder).rglob("*"):
            if (path.is_file() and path.suffix in (".js", ".css")
                    and path.resolve().is_relative_to(WEB.resolve())):
                files["/" + path.relative_to(WEB).as_posix()] = (path, MIME_TYPES[path.suffix])
    for path in LESSONS.glob("*.json"):
        if path.is_file() and path.resolve().is_relative_to(LESSONS.resolve()):
            files["/课例/" + path.name] = (path, MIME_TYPES[".json"])
    if "/index.html" in files:
        files["/"] = files["/index.html"]
    return files


def resolve_static(route):
    # 仅从已知资源映射取文件，编码后的路径穿越同样无法匹配。
    return static_files().get(unquote(route))
