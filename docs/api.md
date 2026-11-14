# HTTP 与数据约定

服务只监听 `127.0.0.1`，网页和 API 同源。安装及日常操作以根 README 为准。服务不是隔离沙箱，仅运行可信 C++ 代码。

## 接口

| 方法与路径 | 请求 | 作用 |
| --- | --- | --- |
| `GET /api/health` | 无 | 服务与环境状态 |
| `POST /api/start` | `sessionId, source, input, standard` | 编译并启动新运行 |
| `POST /api/command` | `sessionId, runId, command` | `next/step/finish/stop` |
| `POST /api/window` | `sessionId, runId, variableId, offset, limit` | 刷新数组窗口 |
| `POST /api/ping` | `sessionId` | 页面会话心跳 |
| `POST /api/close` | `sessionId` | 关闭页面所属会话 |
| `POST /api/shutdown` | `token` | 启动器关闭本次服务 |

每页独立 `sessionId`，每次重新运行生成新的 `runId`。旧运行请求不得控制新运行。执行和窗口读取在同一会话内串行；停止先通知取消，再完成资源清理。

`GET /课例/index.json` 获取内置课例菜单，`GET /课例/<文件名>.json` 获取版本 1 课例。正式入口为 `start.bat`，不使用直接打开 HTML 的方式加载模块。

## 快照

结构见 `contracts/snapshot.schema.json`。Schema 描述公共快照字段，允许添加诊断字段；执行错误可附带 `compile/error`。示例保存在 `contracts/examples`。

- `line` 是下一条待执行语句；变量值是暂停时已经形成的状态。
- `runId/step` 定位运行和步骤；`frames[].id`、`variables[].id` 区分递归、遮蔽和不同调用实例。
- `value/previousValue` 为字符串或 null，64 位整数不经过浮点转换。
- `state` 区分 `ok/uninitialized/unavailable/out_of_scope`，无法确认的值不能显示为 0。
- 数组结构可确认时，变量及 `data.state` 可以为 `ok`，即使部分或全部元素尚未初始化。元素是否可信必须分别检查 `data.elements[].state/value`；未赋值元素为 `uninitialized/null`，不能由整体 `ok` 推断元素可用。
- `data` 包含结构类型、形状、下界、总长度、当前窗口及元素；仅窗口内元素被读取。
- `arrayAccess.reads/writes/uses` 通过 `variableId/coordinates` 定位确认的访问；`uses` 表示实参使用，不能冒充确定读取。
- `indexAssociations` 将一维数组稳定身份映射到自动关联的下标变量身份列表。关联依据为词法声明、数组访问和不含调用或数组读取的标量计算，不依赖变量名或数值范围；复杂 C++ 语义可能需要手动纠正。
- `variables[].indexColor` 为本次运行中稳定的颜色序号，同一身份跨数组共用。
- `indexPreviousValues` 保存执行顺序前一步的变量值字符串或 null；历史回看直接使用该字段，窗口刷新保持不变。未确认或离开作用域的当前值不绘制箭头。
- `output` 为累计 I/O，`outputDelta` 为本步增量，`inputTrace` 为可以确认的输入消费范围。
- 刷新窗口不执行代码、不增加历史、不重置本步访问标记或 I/O 增量。
- 历史快照独立保存，回看不改变真实程序，也不重播当步动画。

关于初始化证据、三元和短路路径、函数调用、标准输出及未知状态的完整限制，见开发说明与信奥常用函数支持。

## 课例

结构见 `contracts/lesson.schema.json`。`version` 为 1，`code` 保存 C++，`input` 保存预置输入，`display` 保存标准、展示方式和布局等设置。新增可选展示设置应兼容旧课例。课例不包含真实身份信息、临时进程和执行历史。
