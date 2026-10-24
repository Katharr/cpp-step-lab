# 离线便携包

Git 仓库包含构建与验收脚本，不包含已组装的发布目录、ZIP、Python、GCC/GDB 或离线 wheel。克隆项目后先按[根目录 README](../README.md)准备源码环境，课堂操作见[老师使用说明](../docs/代码实验台-老师使用说明.md)。

## 准备与构建

在项目内准备完整的 `runtime/ucrt64` 工具链及与构建 Python 匹配的 `wheelhouse`。使用根目录 `.venv` 安装锁定依赖并通过 `start.bat --check`；构建时从当前 Python 环境复制 Python 和依赖，从本项目准备的工具链复制 GCC/GDB。

停止服务后，在项目根目录执行：

```powershell
& ./.venv/Scripts/python.exe build_release.py --output 发布/代码实验台-1.0.0-Windows-x64
```

目标必须是新目录，不覆盖正在使用的版本。已组装且已停止服务的默认发布目录可用 `build_release.py --refresh` 更新应用资源与校验清单；自定义目录需同时传入 `--output`。

发布包包含 Python、GCC/GDB、锁定的 Python 包、离线 wheel、网页、8 个课例、当前说明、截图、版本号、逐文件 SHA-256 清单及第三方原有许可证。源码测试与开发中间记录不进入便携包。大小取决于实际准备的运行时，不以历史构建结果为准。

## 验收与打包

默认发布目录构建完成后，先保持源码和发布服务均已停止，再运行：

```powershell
& ./.venv/Scripts/python.exe verify_delivery.py
```

随后启动发布目录里的 `start.bat`，在源码项目根目录执行断网网页验收：

```powershell
npm run test:delivery
```

交付验收脚本以默认发布目录和本机 8765 端口为目标。自定义发布目录需另行核对脚本目标，不能把默认目录的结果当成自定义包的验收。确认中文路径、断网、服务启停、单步、数组、历史、课例载入和进程清理后，用包内 `stop.bat` 停止服务，再生成 ZIP 与 SHA-256：

```powershell
& ./.venv/Scripts/python.exe build_release.py --zip-only
```

自定义目录的打包同样需传入 `--output`。发布目录、ZIP 和校验文件由 `.gitignore` 排除；不要将本机运行状态、日志、临时代码或学生身份信息放入发布包。

## 交付使用

将实际生成的 ZIP 复制到目标 Windows x64 电脑，完整解压到可写目录，双击包内 `start.bat`；下课使用 `stop.bat`。完整便携包无需联网、Node.js 或系统 Python。保留 `runtime` 完整结构、`manifest.json`、ZIP 旁的 `.sha256` 及第三方许可文件。
