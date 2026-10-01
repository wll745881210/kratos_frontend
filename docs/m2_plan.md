# M2 Web 编辑器计划（kratos_frontend）

> 版本 v1.0 · 2026-09-30 · 状态：已确认技术选型，待开工
> 上层文档：[kratos_frontend_plan.md](kratos_frontend_plan.md)（§0 决策表、M2 里程碑）
> 进度跟踪：[implementation.md](implementation.md)

## 1. 技术选型（已与用户确认）

| 决策点 | 选择 | 理由 |
|---|---|---|
| 应用架构 | **FastAPI + 浏览器 SPA** | Python core（par 解析/校验/描述符/visual 二进制读取）保持唯一事实源，避免 JS 重实现漂移；REST API 即 M4 agent/LLM 接口；可读本机 .bin 输出做 AMR 预览 |
| 前端栈 | **React 18 + TypeScript + Vite + React Flow** | 计划文档原定；React Flow 承担模块框图；CodeMirror 6 承担 par 文本；Canvas 2D 承担预览（§0 已定：不用 WebGL） |
| 首个切片 | **单 par 表单编辑器** | 最小 UI 复杂度打通 server→schema→往返全链路；直接服务"单 par"使用场景 |
| 样式 | 手写 CSS（CSS 变量） | 个人工具，不引 UI 框架 |
| 状态 | React 内置 state + 轻量 store | Spec JSON 为单一状态；server 为权威校验方 |

环境事实：node v22.22.1 / npm 9.2.0 已就绪；fastapi/uvicorn 需装入仓库 `.venv`（uv 可用）。server 只绑 127.0.0.1，无鉴权（个人本地工具）。

## 2. 仓库布局（新增 web/）

```
kratos_frontend/
  core/kratos_spec/          # 已有：纯 Python core（不引 web 依赖）
  descriptors/               # 已有：模块描述符（唯一事实源）
  web/
    server/kratos_server/    # FastAPI 薄壳：app.py + routes_*.py
    client/                  # Vite + React + TS
      src/
        api/                 # 类型化 fetch client
        state/               # Spec store
        views/ParEditor/     # M2.1 单 par 模式
        views/GraphEditor/   # M2.2 框图模式
        views/Preview/       # M2.3 Canvas2D 预览
        components/          # 描述符驱动的表单控件
  docs/m2_plan.md            # 本文档
```

启动：`kratos-front serve`（uvicorn，同时托管 client 构建产物）；开发时 `npm run dev`，Vite 把 `/api` 代理到 server。

## 3. Server API（v1）

| 端点 | 说明 |
|---|---|
| `GET /api/health` | 存活检查 |
| `GET /api/descriptors` | 区块库 JSON（section/key 规格、类型、doc、发射顺序）——前端表单与框图的唯一数据来源 |
| `POST /api/par/parse` | `{text}` → `{spec, issues}` |
| `POST /api/spec/emit` | `{spec}` → `{text, issues}` |
| `POST /api/spec/validate` | `{spec}` → `{issues}`（表达式字段走 expr 校验） |
| `GET /api/fs/read` `POST /api/fs/write` `GET /api/fs/list` | 本地文件读写，限制在白名单根目录（cwd、kratos usr_ext、~/scratch/tst_kratos_frontend） |
| `POST /api/preview/mesh` | Spec → 域/区域几何 + 估计 AMR block 图（M2.3） |
| `POST /api/preview/ic` | Spec + 切片 → 场数组（Python 移植 expr 引擎，与 C++ 共享 golden vectors）（M2.3） |
| `GET /api/preview/bin` | .bin → 精确 block 列表（level/xf0/dx0）+ 场切片（包 visual/hydro_data）（M2.4） |
| `POST /api/run` + `GET /api/run/{id}/log` | 启动 kratos + 尾随日志（M2.4，可选） |

错误一律结构化 `{code, message, section?, key?}`，与 M0 `Issue` 对齐。

## 4. 单 par 视角（M2.1，第一切片）

场景：直接打开任意 `.par`（如 sod_univ.par），无项目仪式。

- **布局**：左 = section 树（按发射顺序，未知 section 沉底）；中 = 描述符驱动表单（int/float 带 doc 提示、bool→0/1 勾选、ivec3/fvec3→三输入行、str[]→token 列表、`any`→文本）；右 = issues 面板 + 原始文本页（CodeMirror 6）。
- **未知 section**（[prob]、[cooling] 等遗留区）：通用 key-value 表格，仍可编辑（raw 透传）。
- **表达式字段**（mask/rho/pre/…）：专用输入框，debounce 调 `/api/spec/validate` 实时校验；placeholder 提示词法（**word 运算符 `geq/leq/and/or/…`，par 值禁止出现 `=`**——M1 踩坑结论，写进 UI 提示与文档）。
- **双向同步**：表单改 → 更新 Spec state；文本改 → 保存/失焦时 re-parse；冲突以 server parse 为准。
- **保存**：emit → 写文件。M0 的 key-identical 往返保证为安全网；发射器确定性格式。
- **验收**：sod_univ.par 与 kh.par（含 refine_region）打开→编辑→保存后 key-identical；植入错误能内联显示。

## 5. 网格加密（AMR）视角

par 侧事实：`[mesh]`（x_min/x_max/n_cell_global/n_cell_block）+ `[refine_region_XX]`（`level` + `x_min`/`x_max` 盒体，码单位）。bin 侧事实：每 block 存 `level`/`xf0`/`dx0`，可精确重建 AMR 结构；`read_args` 还能从输出恢复 par。

1. **编辑期（M2.1 表单 + M2.3 预览）**
   - refine_region_* 专属区域列表编辑器（增删复制；level 整数 + 两个 vec3 行）。
   - 2D 切片预览（xy/xz/yz 轴对选择）：域轮廓、base 网格、block 网格（n_cell_block）、按 level 着色的区域矩形、**估计** AMR block 叠加（block 与 level≥L 区域相交则细化到 L；实现前对照 src/mesh/tree 核实语义，界面标注"估计"）。
   - server 校验增补：`n_cell_global % n_cell_block == 0`（逐轴）、区域须落在域内、重叠区域 level 冲突提示。
2. **结果期（M2.4）**：打开 .bin → 精确 AMR block 图（按 level 着色）+ 场切片热图叠加；一键"从输出恢复 par"。

## 6. 里程碑切片（对齐计划 M2 共 4–6 周）

| 切片 | 内容 | 验收 |
|---|---|---|
| M2.0（2–3 天） | `.venv` + FastAPI 骨架：descriptors/parse/emit/validate/fs 五组端点；`kratos-front serve` | pytest+httpx 全过；curl 可 parse/emit 一个 par |
| M2.1（约 1 周） | 单 par 表单编辑器 + 原文页 + issues + 保存 | §4 验收 |
| M2.2（约 1–1.5 周） | React Flow 框图：[module.*] 节点 + 耦合边，与 Spec 双向同步；节点属性面板复用描述符表单 | 拖出 dyn hydro + 保存 → par 含正确 [module.*] |
| M2.3（约 1 周） | 预览窗：网格/区域/估计 AMR + IC 区域分层预览（Python expr 移植 + golden vectors） | kh.par 区域图与估计 block 图正确；IC 预览与 t=0 输出一致 |
| M2.4（约 1 周） | .bin 输出预览（精确 AMR + 场切片）+ 项目清单/bundle + 可选运行器 | 打开 sod_univ_00000.bin 渲染正确 |
| M2.5（已完成） | REST/CLI 收尾：bin 预览端点（vendored binary_io）+ `kratos-front bin` + OpenAPI + Docker | 容器内 health/bin/UI 冒烟通过 |
| M2.6（已完成） | Globals 超参数视图 + 跨字段校验（unit FP32 溢出、mesh 块布局整除）+ bin 分辨率护栏 | validate 对 kpc+mp 与 512/100 布局各返回一条 error；GlobalsView 测试通过 |

## 7. 测试策略

- server：pytest + httpx TestClient；API 级往返测试复用 M0 语料。
- client：vitest 测 Spec store 与值类型转换；ParEditor 组件测试；e2e 暂缓。
- expr golden vectors：C++/Python 双语种共享用例（计划 §0 已定，JS 端暂缓——M2 校验由 server 承担）。

## 8. 已记录决策

1. server 为权威校验方；client 不做 par 解析重实现（JS 只持有 Spec JSON）。
2. IC/网格预览由 server 端 Python 求值（无需 GPU、无需跑 kratos）；精确结构以 .bin 为准。
3. `make bindings` 仍推迟：M2 由 `/api/descriptors` 运行时下发等价信息。
4. 运行器（spawn kratos）列为 M2.4 可选项，不阻塞主线。
5. `GET /api/fs/list?dir=` 用 query-param（偏离最初 POST 草案）；fs 白名单默认根 =
   server 启动 cwd + `~/scratch/tst_kratos_frontend` + `KRATOS_FRONT_ROOTS`。
6. 文件关联：`kratos-front open FILE.par` + `?file=` 深链 + `POST /api/app/set-cwd`
   运行时白名单扩展；`scripts/install.sh` 注册 `application/x-par` 与
   KratosParEditor.desktop（per-user，无需 sudo）。白名单定位为防误触，非安全边界。
7. M2.1 前端样式为手写 CSS（不引框架）；文本页用 CodeMirror 6。
8. M2.2 块图用 React Flow **v11**（非 @xyflow v12）；节点坐标不持久化（列式
   自动布局，持久化留到 M2.4 项目文件）；coupling 中指向不存在角色的引用画
   ghost 节点（红虚线，可删边修复）而非静默吞掉；前端图模型（graph.ts）的角色
   语义与 C++ `registry.h` 一致（裸 `[module]`/`[coupling]` 的 role 为空串且互相
    配对）；`[ic.*]` 等区域不进块图（表单页编辑）；双击模块节点跳表单对应
    section（type/order 等属性在表单页改）。
9. M2.3 预览为单页 Preview tab（field/法向轴/切片滑块）；表达式三端保真
   （C++ grammar 注释 = 唯一语法真源；Python `expr.py` 逐字节移植；JS 端不
   再单独移植，预览由 server 求值）；黄金向量 88 条放 `tests/golden/`
   随仓库分发，C++ 对比需手动跑 `tests/golden/check_cpp.py`（依赖 g++ 与
   kratos 树，不进默认 pytest）。Spec 中多 token par 值是字符串列表，
   求值前 join（镜像 `get_expr_str`）。AMR block 估计图（§5 视角）未做，
   仅基网格切片——挪入 M2.4 一并评估。
10. M2.4/M2.5 完成项：bin 输出预览（`core/kratos_spec/binread.py` +
    `vendor/binary_io.py` 逐字复制自 kratos 主干，仅依赖 numpy；服务端
    `/api/preview/bin`；客户端 Preview tab 内 IC/BIN 模式切换）；项目清单
    + bundle（whitelist 尺度覆盖，JSON Merge Patch）；图布局持久化进
    `spec.meta.diagram_positions`（`onNodeDragStop` 整体写回）；OpenAPI
    增加描述；`KRATOS_FRONT_DESCRIPTORS` / `KRATOS_FRONT_DIST` 环境变量
    覆盖（非 editable 安装/Docker 用）；根目录 Dockerfile 多阶段镜像
    （本机经镜像源构建并冒烟验证）。基镜像可用 build-arg 覆盖。
11. M2.6 跨字段校验放后端 `xchecks.py`（与 trunk throw 镜像），前端只做即时
   提示镜像（unit 派生量/FP32 范围、块布局整除）——单一权威校验仍在 server；
   Globals 视图复用 mutate/Spec store，新增键时先确保 section 存在。
