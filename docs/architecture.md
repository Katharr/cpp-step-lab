# 架构与扩展

本项目保持原生 JavaScript、Python 标准库 HTTP 服务和真实 GCC/GDB。源码模块使用英文路径，课例、文档和交付目录可使用中文；项目根路径必须支持中文和空格。

## 入口与依赖

`start.bat` → `launch.ps1` → `launch.py` → `code_lab.bootstrap`。根入口只引导一次 `src` 包路径。启动、停止、进程保护、中文工具链路径适配和浏览器打开由 bootstrap 统一管理。`.venv` 和依赖锁仍在根目录；便携包优先选择 `runtime`。

后端调用顺序是 `server` → `debugger` → `execution` / `snapshots`。`execution` 不导入 HTTP 或调试会话；`snapshots` 不依赖 HTTP，不启动 GDB。公共路径与限额分别由 `paths.py`、`config.py` 提供，不允许各模块依据当前工作目录推算资源。

`debugger/gdb_agent` 在 GDB 内置 Python 中执行，随会话复制到 ASCII 临时工作目录。它只依赖 GDB 和标准库，不能导入应用环境的 tree-sitter 或 pygdbmi。

## 前端功能与状态

网页通过本机 HTTP 服务加载原生 ES modules，无构建步骤。`app.js` 负责装配，`core` 负责 API、统一状态与存储；`features` 分别负责执行、代码、变量、数组、输入输出、历史和课例。`presentation` 管布局、主题和动效，功能专属样式随功能维护。

真实程序的最新快照与正在回看的快照分别保存。历史回看只切换展示位置；继续执行必须回到最新状态。代码、变量、数组和 I/O 一起消费同一快照。变量和调用帧使用后端稳定身份，数值字符串不能经过 JavaScript Number 转换。

各功能通过装配时传入的状态和 actions 协作，避免模块相互导入形成环。公共工具只有在存在实际共用时才进入 shared；不将业务逻辑放进通用工具文件。

## 内容与资源

`课例/*.json` 是内置课例的唯一内容来源，`index.json` 管理菜单和顺序。新增课例时同步索引、发布清单与课例验收。浏览器保存的自定义课例仍使用版本 1，不保存运行进程和历史。

`server/static_files.py` 只提供允许的网页模块、样式与课例 JSON；不开放源码、测试、依赖目录或任意文件访问。发布脚本使用显式应用文件清单，不能递归打包整个开发工作区。

## 测试与产物

`tests/unit` 验证纯逻辑；`tests/integration` 验证真实 GCC/GDB 和 HTTP；`tests/browser` 验证页面行为、布局和视觉；`tests/delivery` 验证发布范围、离线和进程清理。C++ 样例统一放在 `tests/fixtures/cpp`，测试共用工具放在 `tests/support`。

运行状态和诊断写入 `.local`，验收报告与截图写入 `验收输出`，编译工作目录由会话管理并清理。运行日志、学生程序、缓存、依赖和二进制交付物不提交。

## 新功能的落点

- 新增展示：放入相应 `web/features`，消费结构化快照，不在网页解析 C++ 语义。
- 新增调试动作：在 debugger 编排，server 仅增加请求校验和动作映射。
- 新增容器：在 gdb_agent 读取真实结构，在 snapshots 统一身份、状态和差异，再接入 data 展示。
- 新增快照字段：先更新 contracts 与 API 文档，再增加真实调试和网页覆盖。
- 移动资源：同步静态映射、发布清单、入口和文档，重新运行相关真实验收。
