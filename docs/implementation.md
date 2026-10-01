# 实施进度 (Implementation Status)

对应 `docs/kratos_frontend_plan.md` v2.0 的路线图。本文件只记录**状态与决策落点**，设计细节以计划文档为准。

## 里程碑状态

| 里程碑 | 内容 | 状态 |
|---|---|---|
| **M0** | 描述符目录 + `make bindings` + Spec→par CLI | ✅ **完成** (2026-09-30) |
| M0.5 | REST/CLI 骨架 (FastAPI) | ✅ **完成** (2026-09-30，即 M2.0，见下) |
| **M1** | `usr_ext/universal`（注册表 + 角色 + 接线 + 表达式 + IC + inflow BC） | ✅ **完成** (2026-10-01)：切片 A–D + 收尾（表达式扩展 tanh/rand/i,j,k、IC 通道 1/3、7 个原语配方、make bindings）；Sod/Brio-Wu/inflow/chem Sod/base_file/KH 全部验证通过 |
| **M2** | 图形编辑器 + 项目文件 + Canvas2D 预览 | ✅ M2.0–M2.5 完成（详案见 `docs/m2_plan.md`） |
| M3 | Track B 代码生成 | ⬜ 未开始 |
| M4 | LLM/Agent 接口 | ⬜ 未开始 |

## M0 验收

计划文档验收标准：**用工具重新生成至少 3 个现有 `usr_ext/*/pars/*.par`，逐 key 一致**。

实际：测试语料 8 个 par（sod / kh / rt / lw / mhd_ot / mhd_lw_alfven / mhd_st_briowu /
kh_gas_slab_eq，复制自 kratos 仓库 `usr_ext/*/pars/`）全部 **key-identical round-trip**；
`lift → emit → diff` = IDENTICAL；52/52 pytest 通过。

## M0 交付物

```
core/kratos_spec/
  parfile.py      # par 读写，与 src/io/args/input.cpp 逐行为对齐
  values.py       # 值推断/格式化/比较；format_float 大数用科学计数法
  descriptors.py  # 描述符注册表（YAML 目录，尾-* 通配，类型校验）
  spec.py         # Problem Spec（JSON）：lift/emit/validate
  diff.py         # key-identical 比较（M0 验收口径）
  cli.py          # lift / emit / validate / diff / roundtrip
descriptors/
  meta.schema.yaml  # 描述符格式说明
  core/*.yaml       # device, unit, mesh, refine_region*, boundary, cycle, init
  modules/*.yaml    # dynamics, multigrid, chemistry
tests/
  corpus/*.par      # 8 个真实 par 语料
  test_roundtrip.py # 语料 round-trip + 校验
  test_core.py      # 解析器/值/类型单元测试
pyproject.toml      # 包 kratos-spec，脚本入口 kratos-front
```

## M0 关键决策（落点记录）

1. **`make bindings` 暂缓**：M0 只交付了其核心产物（描述符目录 + Spec→par CLI）；
   Makefile 目标在 M1 需要生成 `univ_proxy.gen.h` 时一并落地。
2. **遗留 section 原样透传**：`[prob]`、`[cooling]` 等 per-problem section 在 M0
   不做描述符化，lift 时保留原值原序，emit 时原样写回（保证 round-trip 不丢信息）。
   它们随 M1 通用 pgen 的 IC/BC/冷却描述符化而消解。
3. **`vel0`/`b0` 用 `float[]` 而非 `fvec3`**：kratos C++ 端 `read_ivec3`/`read_fvec3`
   对短数组零填充，语料中存在 `vel0 = 0` 标量写法；`float[]` 兼容标量与向量，
   vec3 专用 UI 控件留到 M1。
4. **`refine_region_00` 通配**：section 描述符用尾 `*` 前缀匹配（`refine_region*`），
   不是 `.*`。
5. **`unit.density` 允许 `"mp"`**：类型 `any` 透传，匹配 kratos 端特判。
6. **par 值不允许含 `=`**：input.cpp 在第二个 `=` 处截断，工具链复刻此行为。
7. **浮点格式化**：`|x| >= 1e12` 或 `< 1e-4` 用裁尾科学计数法（`3.156e+13`），
   其余用 Python repr（恒含 `.` 或 `e`，浮点视觉上仍是浮点）。

## M2.0 交付物（REST 骨架，= M0.5）

```
web/server/kratos_server/
  __init__.py
  app.py          # create_app(): /api/health, /api/descriptors,
                  # /api/par/parse, /api/spec/emit, /api/spec/validate,
                  # /api/fs/read|write|list（白名单根目录）
                  # 静态托管 web/client/dist（存在时）；CORS 放行 Vite :5173
core/kratos_spec/
  cli.py          # 新增 `serve` 子命令（lazy import kratos_server）
  descriptors.py  # Registry.all_descriptors()（供 /api/descriptors）
tests/test_server.py   # 9 个 API 测试（httpx TestClient）
```

- 依赖隔离：仓库根 `.venv`（`uv venv` + `uv pip install -e '.[test,server]'`），
  已 gitignore；core 本体仍只依赖 pyyaml。
- 修复一个 M0 潜伏 bug：`Spec.to_par` 现在保留空 section（`[device]`
  只含注释的 section 原先在 emit 时丢失）。
- 白名单根目录默认 = server 启动 cwd + `~/scratch/tst_kratos_frontend`，
  可用环境变量 `KRATOS_FRONT_ROOTS`（os.pathsep 分隔）追加；越界 → 403。
- 启动：`.venv/bin/kratos-front serve [--host 127.0.0.1] [--port 8620]`。
- 验收（m2_plan §6）：61/61 pytest；curl 实测 parse/emit/list/403 全通。

## M2.1 交付物（单 par 表单编辑器）

```
web/client/                 # React 18 + TS + Vite（npm 工程，dist 由 server 托管）
  src/model/types.ts        #   API 线类型（Spec/Issue/SectionDescriptor/...）
  src/model/coerce.ts       #   Value <-> 文本框转换（镜像 values.py）
  src/api/client.ts         #   fetch 封装（ApiError{status}）
  src/components/           #   FieldInput / SectionCard / IssuesPanel /
                            #   TextEditor(CodeMirror 6) / FileBrowser(模态)
  src/views/ParEditor.tsx   #   单 par 视图：Form/Text 双页互转、防抖校验、保存
tests: vitest 18/18（coerce 12 + SectionCard 6）；后端 pytest 64/64
```

- 集成验证：dev server(:5173, proxy /api→8620) 与 build 后 server 直开均
  打开 `tests/corpus/*.par` 与 `usr_ext/universal/pars/sod_univ.par`，
  编辑→emit **key-identical**（`kratos-front diff` = IDENTICAL）。
- par 文件关联（桌面集成）：
  - `kratos-front open FILE.par`：无 server 则以文件所在目录为 cwd 后台拉起
    （自动进入白名单）；有 server 则 `POST /api/app/set-cwd` 扩展白名单；
    打印并 `xdg-open` `http://127.0.0.1:8620/?file=<abs>`。
  - 客户端启动读 `?file=` 深链；403 时自动 set-cwd 父目录后重试一次
    （个人本地工具，白名单是防误触而非安全边界）。
  - `scripts/install.sh`：注册 `application/x-par` MIME + KratosParEditor.desktop
    + `~/.local/bin/kratos-front-open` wrapper（`--remove` 卸载）。
  - 新端点：`GET /api/app/cwd`、`POST /api/app/set-cwd`（运行时扩展白名单）。

## M2.2 交付物（块图编辑器）

```
web/client/src/model/graph.ts        # Spec <-> 图模型 + 全部编辑变更（纯 TS）
web/client/src/views/DiagramView.tsx # React Flow v11 画布：列式自动布局、
                                     # 连线→coupling 对话框、删除节点/边、
                                     # 双击节点跳表单对应 section
ParEditor.tsx                        # 第三页 Diagram；form↔diagram 直通；
                                     # 跳转 = 切 form + scrollIntoView
tests: vitest 31/31（graph 9 + DiagramView 4 + 旧 18）；tsc + vite build clean
```

- 节点：`[module.<role>]`（含 `type`/`order`）+ core 固定节点
  （device/unit/mesh/boundary/cycle，存在才画）；coupling 引用不存在角色时
  画红色虚线 ghost 节点（不静默吞错）。
- 边：`parasite` 虚线独占边（唯一目标）；其余键=命名 slot，值为角色列表。
- 角色语义与 C++ `registry.h` 严格一致：裸 `[module]` → role `""`（与裸
  `[coupling]` 配对）；前端改图只写回 Spec，服务端 parse/emit 仍为权威。
- 布局为列式自动布局；**拖拽后的节点坐标持久化到 `spec.meta.diagram_positions`**
  （M2.4 实装，`onNodeDragStop` 时整体写回，emit par 时随 meta 序列化）；`[ic.*]`
  等区域节点不进图（在表单页编辑）。
- 实测：构建产物含 reactflow；`/api/par/parse` 解析 `chem_sod_univ.par` 得到
  `module.flow(type=chem_hydro)`/`module.chem`/`coupling.chem(parasite=flow)`
  —— 即图渲染输入。jsdom 冒烟（ResizeObserver/DOMMatrixReadOnly mock）通过。

## M2.3 交付物（IC/mesh Canvas2D 预览）

```
core/kratos_spec/expr.py             # C++ expr.h 的逐字节 Python 移植
                                     # （33 个 op、同优先级、word ops、
                                     #  IEEE 语义手工对齐，错误信息格式一致）
core/kratos_spec/ic_eval.py          # 基网格 IC 求值：base + [ic.*] 分层 +
                                     #  零填充 + 物种归一化 → 2D 切片 JSON
                                     #  （max_dim 封顶，默认 384）
web/server/kratos_server/app.py      # POST /api/preview/ic
web/client/src/views/PreviewView.tsx # 第四页 Preview：field/法向轴/切片
                                     # 滑块，防抖 400ms，Canvas2D 伪彩渲染
                                     # （v 轴向上、非有限值灰色、min/max 读数）
tests/golden/expr_vectors.json       # 88 条三端共享黄金向量（值+错误）
tests/golden/expr_cpp_harness.cpp    # C++ 端 harness（TSV 驱动）
tests/golden/check_cpp.py            # g++ 编译 + 88/88 逐条对比（非默认
                                     # pytest，改语法后手动跑）
tests/test_expr.py (89) + tests/test_ic_eval.py (11)
```

- **保真口径**：Python 端与 `usr_ext/universal/expr.h` 同一份语法定义；
  黄金向量对 C++ harness **88/88 一致**（含 inf/nan/除零/溢出、
  `-2^2=-4`、`1++2=3` 等边界）。改表达式语法 = 改 C++ grammar 注释 +
  expr.py + 向量，三者同步。
- Spec 中多 token par 值是**字符串列表**（如 `mask = x geq 0.5` →
  `["x","geq","0.5"]`）；求值前用空格 join（镜像 C++ `get_expr_str`）。
- 分层语义与 univ pgen 一致：`[ic.*]` 按字典序应用，后者覆盖前者；
  region 只覆盖它设置的通道；物种通道 `x.<name>` 归一化到和为 1。
- 实测：`sod_univ.par` 经 parse → preview 得到 rho 1.0|0.125、pre 1.0|0.1
  的 Sod 初态；`chem_sod_univ.par` 物种通道可预览。
- 测试：vitest 33/33（含 PreviewView 2 个 jsdom 冒烟）；pytest 164/164。

## M2.4 交付物（项目文件 + bundle + 图布局持久化）

```
core/kratos_spec/project.py          # kratos.project.json manifest
                                     # （$schema=kratos.project/v1：spec、
                                     #  environment、provenance、assets、runs、
                                     #  overridable、par_snapshot、ui）
core/kratos_spec/bundle.py           # tar.gz bundle 导出/导入 +
                                     #  JSON Merge Patch 白名单 override
web/server/kratos_server/app.py      # /api/project/{init,save,check}
                                     #  /api/bundle/{export,import}
web/client/src/components/ProjectDialog.tsx   # 编辑器 "Project…" 对话框
                                     # （init/save/check/export/import +
                                     #  override JSON 文本框）
```

- 项目 = 目录 + manifest；`init` 接受 par 文本（`text` 字段），`save` 重生成
  par 快照，`check` 校验 manifest/par 一致性。
- bundle：tar.gz 打包 manifest + assets；`import` 支持 scale override
  （JSON Merge Patch，仅白名单键如 `mesh.n_cell_global`，服务端强制）。
- 实测（curl 全流程）：init（从 sod.par 文本解析出 n_cell_global=[512,2,1]）
  → export → import（override → [256,2,1]，issues 为空）→ check 通过。
  注意 init 的字段是 `text` 不是 `par_path`（我的第一次 curl 传错字段，
  得到默认最小 spec 64,64,1——服务端行为正确，调用方传错）。
- 图布局持久化：React Flow `onNodesChange` 追踪 position/remove 变更 +
  `onNodeDragStop` 写回 `spec.meta.diagram_positions`；重新打开时优先使用
  持久化坐标，否则回退列式自动布局。
- 测试：vitest 33/33；pytest 178/178。

## M2.5 交付物（bin 预览 + REST/CLI 完善 + Docker）

- **bin 读取器**：`core/kratos_spec/vendor/binary_io.py` —— 从 kratos 主干
  `visual/binary_io.py` **逐字复制**的低层读取器（避免 scipy 依赖，仅需 numpy）；
  `core/kratos_spec/binread.py` —— `BinFile`：`blocks()` / `block_info()` /
  `fields()` / `read_field()`（剥 ghost，形状 `(n_int,nz,ny,nx)`）/
  `slice2d(axis,index)`（rows=v cols=u，返回 extent/min/max）/
  `read_args()`（二进制 item_map → dict）/ `globals()`（time/dt/cycle/i_out）。
  注意：vendor 的 `open()` 不能用 `instant_close=True`（`__getitem__` 需要流保持打开）。
- **服务端**：`POST /api/preview/bin {path, field?, block?, component?, axis?, index?}`
  —— 无 field 时返回结构（globals/blocks/fields），有 field 时返回切片；
  路径经白名单校验。FastAPI app 增加 description（/docs 与 /openapi.json 可读）。
- **CLI**：`kratos-front bin FILE [--field f]` 打印 time/cycle/dt、每 block 几何
  与各字段 shape/min/max。
- **客户端**：PreviewView 顶部模式切换「IC (spec) / BIN (output)」；BIN 面板
  （路径输入 → 结构 → block/field/分量/法向/切片滑块，防抖 300 ms，extent/min/max
  读数）；画布渲染抽出共享 `drawHeat()`（行=v 列=u，null/NaN→灰）。
- **环境变量**（Docker 友好）：`KRATOS_FRONT_DESCRIPTORS`（描述符目录，
  `descriptors.default_root()` 优先读它）；`KRATOS_FRONT_DIST`（客户端 dist 目录）。
  所有 Registry 访问都走 `load_default()` → `default_root()`，单点覆盖即可。
- **Docker**：根目录 `Dockerfile`（多阶段：node 构建 dist → python slim
  `pip install '.[server]'`；ENV 三个路径变量；EXPOSE 8620；
  `CMD kratos-front serve --host 0.0.0.0`）+ `.dockerignore`；
  基础镜像可用 `--build-arg NODE_IMAGE=/PY_IMAGE=` 覆盖（镜像源受限网络）。
  本机验证（daocloud 镜像源）：容器内 health OK、`/api/preview/bin` 挂载
  `/data` 读取 fixture 正确（time=0.2、block 几何正确）、`/` 返回构建后的 UI。
  教训：容器里别忘了装 `[server]` extra（否则 CLI 报 "server extras not
  installed" 直接退出）。
- `pyproject.toml`：dependencies 增加 `numpy>=1.26`；packages 增加
  `kratos_spec.vendor`（+ vendor/`__init__.py`）。
- 测试：pytest **188/188**（+6 binread、+4 preview/bin 服务端）；vitest 33/33；
  测试 fixture `tests/fixtures/sod_univ_00000.bin`（Sod 末态 t=0.2，42 KB）。

## M1 进展记录（usr_ext/universal，在 kratos 仓库内）

切片 A 交付：`expr.h`（表达式→字节码，host/device 双端 eval，word 运算符
`geq/leq/neq/eq/ne/lt/gt/ge/le/and/or/not`）、`univ_hydro.h`（`ic_t` 分层 IC +
`univ::hydro_t`，按 par 字符串选 riemann/reconstruct/integrator）、
`registry.h`（`[module.*]` section → 模块注册表，无 module section 时回退单
hydro）、`usr.cpp`、`pars/sod_univ.par`（经典 Sod，ρ_R=0.125）。

**par 表达式的两条硬约束**（kratos `src/io/args/input.cpp` 行为，前端 grammar
与校验必须复刻）：
1. 值在第二个 `=` 处截断 → 表达式禁止出现 `=`（`>=`/`==` 用 word 运算符替代）。
2. `get<std::string>` 只取首个空白 token → C++ 端必须 `get<vector<string>>`
   后重连（`univ_hydro.h` 的 `get_expr_str` 已如此）；Python `parfile.py` 镜像
   item_map 存全串，两端语义一致由 `ic_t` 重连保证。

**Sod 调试教训**：模拟一直是物理自洽的；最终根因是验证脚本本身——
`u* = 0.5*(f_L + f_R)`（实为残差≈0）应为 `0.5*(f_R - f_L)`，且 canonical
表值对应 ρ_R=0.125 而非 0.1。验证脚本现内建 canonical 自检
（`assert |p*-0.30313|<1e-4`），位于 `~/scratch/tst_kratos_frontend/sod_univ/verify_sod.py`。

**性能基准（M1 验收 <1%）**：同一 Sod（512×2×1, t_lim=2, CUDA/sm_86, GPU1）
各跑 4 次——native `std_tst/sod` 7.15–7.38e6 cell/s，universal 7.13–7.39e6
cell/s，分布完全重叠，开销在噪声内（**<1% 验收通过**）。

**切片 B（mhd + 表达式流入边界）已交付**：
- `univ_mhd.h`：`univ::mhd_t`，par 选择 riemann/reconstruct/integrator
  （当前 src 只有 hlld/plm/rk2，选了别的会报错并列出可用组合）；IC 为
  分层 `[ic.*]` 区域（mask + rho/pre/vel_x..z/b_x..z 表达式，逐 region
  覆盖），bf 按面网格写、cc 能量加 |b|²/2，与 `mhd_st` 相同的 clamped-cc
  采样保证离散 divB=0。
- `univ_inflow.h`：`expr_inflow_t`（phys functor，kind 名 `inf`），
  `[bc.expr_inflow]` 中 rho/pre/vel_x/vel_y/vel_z 表达式，变量含
  `{x,y,z,t}`；未设置的分量退化为零梯度。`keeper_inflow_t` 每步
  `act_bnd` 前从 `mesh.p_cyc->t` 盖时间戳；`univ::hydro_t` 新增
  `enroll_keeper()` 钩子，`hydro_inflow_t` 以此在 `enroll<>()` 之前
  替换 keeper（usr.cpp 中 "hydro" 现在注册为 hydro_inflow_t）。
- 验证：Brio-Wu（512×2×2, t=0.1）与 native `mhd_st` 逐 cell 一致
  （hydro_cons max|Δ|=4.4e-7、field_bf 3.3e-7，同为 557 cycles、
  dt0=1.903795e-04，roundoff 级）；常值超声速流入测试（rho=2 注入
  v=1 流动气体，t=0.3 接触面应在 x=0.3）实测 front=0.287、两侧状态
  精确（PASS）；Sod 回归 PASS（L1 不变）。
- 教训：`device::base_t::free(p)` 默认 `host=true`（host 释放），设备
  指针必须显式 `free_device(p)`，否则 finalize 时 CUDA invalid argument。

**切片 C（多实例角色 + 耦合 + 通用 proxy）已交付**：
- `couplable.h`：`couplable_t` 接口（`couple_slots()` 默认空、
  `couple(slot, idx, target)` 默认抛错并列出可用槽）。
- `role_aware.h`：`role_aware_t`（`set_role(role, overrides)`）+
  `scoped_args(args, overrides)`：把 `[module.<role>]` 内含 `.` 的键
  （按最后一个点拆成 `<section>.<key>`）以 `input::set` 覆写到私有副本，
  模块 `read` 只见覆写后的 args。
- `univ_proxy.h`：`prx_unv_t` 内联静态槽 `p_dyn` / `p_che` /
  `p_mg[4]` + `n_mg` + `d_dyn(reg)` / `d_mg(i,reg)` 访问器；容器按
  `dynamic_cast` 自动接线（dynamics::base_t→p_dyn 单例，chemistry::base_t
  →p_che 单例，multigrid::base_t→p_mg 数组）；多个 dynamics 报错。
  这是将来生成版 `univ_proxy.gen.h` 的手写替身。
- `univ_mg.h`：`univ::mg_t`（multigrid::base_t + couplable + role_aware）。
- `registry.h` 重写为 `assemble_modules()`：`[module.<role>]` 必需 `type`，
  可选 `order`（默认按 section 名字典序；显式 order 重复报错）；按
  (order, 名字) 排序后以显式槽位 enroll（i_init=i_step=序号）；
  `[coupling.<role>]`：`parasite = <role>`（单向，容器调用）+ 其余键为
  命名槽（值=角色列表）；未知角色/未知类型/非 couplable 模块均报错并
  列出可选项；启动时打印装配计划 `[univ] module[i] role=... type=...`。
  无 `[module.*]` 时回退单 hydro（role 'dyn'，打印标注 legacy fallback）。
- `univ_hydro.h`/`univ_mhd.h`：两模块均继承 couplable_t + role_aware_t，
  `read` 先过 `scoped_args`。
- `pars/mg2_hydro.par`：双 multigrid 实例 + hydro 冒烟测试（角色乱序命名
  + 显式 order + mg_b 覆写 n_iter=2/print_info=1）。验证：装配顺序
  0/1/2 正确；mg_a 见 (print_info=0, n_iter=1)，mg_b 见 (1, 2) ——
  覆写隔离确认（用 stderr 探针验证后已移除探针）。
- `pars/cmz_shape.par`：cmz usr.cpp 装配（mg_sta 0 / mg_dyn 1 / hydro 2 /
  chem 3 parasite→hydro / sink 4 p_hyd→hydro）的纯容器语法表达（文档性
  产物；cmz 专用类型未注册，暂不可运行）。
- 教训：multigrid 的 V-cycle 粗化对退化轴（n_cell=1）SIGFPE，mg 测试
  网格需三维 ≥32³ 量级；kratos 布尔 par 值只认 0/1（`true` 解析为 0）；
  负路径（未知耦合角色/缺 type/重复 order）均干净报错。
- 回归：Sod（容器路径 + legacy 回退路径）PASS，Brio-Wu 容器路径 PASS。

### M1-D 进展记录（chem_hydro + chemistry）

- 新增 `univ_chem.h`：`univ::chem_t`（chemistry 包装，role-aware）与
  `univ::chem_hydro_t`（分层 IC 含 `x.<species>` 数分数字段）；`ic_t`
  扩展物种通道（`[ic.*] x.H2 = ...`）；usr.cpp 注册 `chemistry` /
  `chem_hydro`。
- **验证通过**（CPU）：chem Sod（H2/H 被动标量、无反应网络、
  `[chemistry] Tmin = 1e-30`）608 步到 t=0.2；组分相关 cv 精确一致
  （左 e=2.4 / 右 e=0.16），物种数分数 0.9/0.1 随接触间断正确平流。
- **chem 关键结论**：kratos chem 模块默认 Tmin=2.7 K 并对温度做
  clamp + 能量重标定 → 无量纲单位制下必须显式
  `[chemistry] Tmin = 1e-30`，否则 dt 塌缩（`docs/kratos_internals.md`
  §6）。
- **两个"疑似 trunk bug"最终均为误读**：(1) `p_dt` 其实在
  `cycle::evolve()` 开头初始化（cycle.cpp:149-152），不在 `init()`；
  (2) "设备数组全零"是 probe par 缺 `[init]` + 调试器读数误加 ghost
  偏移（`u` 本就无 ghost）。教训已写入 `docs/kratos_internals.md` §10。
- **发现的真正 trunk 隐患（仅记录，未改动）**：`copy_input` 的
  `cp[tgt]` 反射拷贝链在 hydro-only 源 → mhd 派生目标时
  `x_el/y_el/z_el` 与 `rot_bc` 不对齐（纯 hydro 路径不读这些字段，
  实际无害）。
- trunk 纪律：除 `usr_ext/universal/`（本项目新增）与用户自己的 mhd
  工作外保持干净；调试期临时 print 已全部回退；今后 trunk 改动一律
  先征求用户同意（DEVELOPMENT.md §5）。
- **CUDA 终验（pristine trunk, sm_86/GPU1）**：chem Sod 608 步到 t=0.2，
  与 CPU 逐周期一致，内能 2.4/0.16、x_H2 0.9/0.1 精确；回归 Sod
  （L1(ρ)=1.32e-3）、Brio-Wu、inflow（rho=2 精确，front x=0.299≈0.3）
  全部通过。

### M1 收尾切片（2026-10-01）：表达式扩展 + IC 通道 + 原语 + bindings

- **表达式引擎扩展**（`usr_ext/universal/expr.h`，语义真源）：
  新函数 `tanh/sinh/cosh/erf`（1 参）与 `rand(i,j,k,seed)`（4 参，
  splitmix64 链 `sm64(seed)→+i→+j→+k`，`(h>>11)·2⁻⁵³` ∈ [0,1)，
  参数 llrint 为 int64，host/device/Python 逐位一致）；新变量
  `i/j/k` = **全局**单元索引（序号 4–6；`univ_hydro.h` 的
  `global_ijk` = 局部索引 + llround(xf0/dx0)，IC 与 inflow BC 同一
  约定；块布局/分辨率确定但非布局不变）；IC 处 `t` =
  `[cycle] t_0`，inflow BC 处 `t` = 当前时刻。
  Python 端口 `core/kratos_spec/expr.py` 同步扩展；黄金向量 88→104 条
  全部两端一致（`tests/golden/check_cpp.py`）。
  **块间独立性曾真实出错**（局部索引 → 所有块噪声逐位相同），由
  `tools/check_rand.py` 检出并修复；方法与实测数字见
  `docs/rand_verification.md`。
- **IC 通道 1（二进制底场文件）**：`[init] base_file = <bin>`；
  逐块 `d.read(bio)`（`dat_3d::read` 自带尺寸校验，分辨率/布局不符
  立即报错）；有 `[ic.*]` 区域时区域在文件状态之上**覆盖**叠加
  （表达式读不到底场值；hydro 经 γ-law 原语回读，mhd 含 bf 回读，
  chem_hydro 因成分依赖能量回读有歧义 → base_file 与区域并用直接
  报错）。**验证**：sod t=0.2 末态作底场 + `x∈[0.6,0.7]` 带 rho=3
  区域 → 带外逐位一致（max|Δ|=0.0）、带内精确 3.0、t₀=0.2 延续。
- **IC 通道 3（扰动层）**：零新增机制 —— 扰动就是含 `rand()` 的
  表达式（配方见 `white_noise`；区域语义为覆盖，结构性底场加噪
  请写进同一区域表达式，见 `kh` 配方）。
- **命名 IC 原语库** = 表达式配方而非 C++：`descriptors/ic/recipes.yaml`
  收录 uniform / sod / briowu / kh / blast / linear_wave / white_noise
  共 7 个；**RT 暂缓**（std_tst/rt 用带 gz 的自定义积分器，重力槽
  属未来工作）。**验证**：kh_expr.par（tanh 剪切 + 余弦模 +
  rand 噪声）GPU 跑通，初态 ρ/vx 对解析 tanh 剖面
  max|Δ| = 7.1e-8 / 1.4e-8（PRECISION=1 的 FP32 存储下限）。
- **`make bindings` 代码生成**：`kratos-front bindings [outdir]` →
  `blocklib.json`（模块块 + IC 通道 + 表达式语法 + 配方）、
  `schema.json`（Spec IR 的 JSON Schema，x-known-sections）、
  `univ_proxy.gen.h`（当前为 trunk `univ_proxy.h` 的生成副本 + 横幅；
  槽位静态）、`descriptors.md`（参数参考）。语法展示真源 =
  新增 `descriptors/expr_grammar.yaml`；`load_registry` 现跳过
  无 `section:` 的数据 yaml。`generated/` 已入 .gitignore。
- **回归（同一 CUDA 二进制）**：sod_univ PASSED、briowu EXIT=0、
  chem_sod EXIT=0、legacy fallback（无 [module.*]）EXIT=0。
  pytest 209/209（含 bindings 冒烟与 JSON Schema 校验）。

- M1 余项（仍在计划外暂缓）：重力槽（RT 等需要）、chem_mhd 通用
  包装（chem_mhd 需要反应网络，暂沿用 chem_hydro 被动模式）。

### 混合精度纪律与 rand 修复（2026-10-01 下午）

- **精度纪律**（用户明确，见 `src/types.h:12-26`）：kratos 默认
  PRECISION=1（float_t=FP32, float2_t=FP64）；PRECISION=2 全 FP64，
  PRECISION=0 全 FP32。规则：**一切不直接涉及守恒变量加减的量用
  `type::float_t`**（位置、原语、冷却全程、模表、约减缓冲），
  **只有守恒量本身及其加减用 `type::float2_t`**（ene−ke、
  u += du、最终写回）。已全量清扫 univ_hydro/mhd/chem/inflow
  （expr.h 引擎内部 double 属设计：double 字节码常量 + 模板化
  eval<f_T>）。
- 清扫后 CUDA 重建 + 全回归：sod（verify_sod PASSED）、briowu、
  inflow、chem（608 步，x_H2 0.9/0.1）、kh（≤7.1e-8）、base_chain、
  rand 检验全部通过。
- **trunk pars/chem_sod_univ.par 补回 `[chemistry] Tmin = 1e-30`**
  （此前只在 scratch 副本里有，导致 trunk 版回归时 dt 崩塌复发；
  教训：修复必须落到权威文件，不能留在临时副本）。
- `usr_ext/universal/univ_post.h`（冷却 + 湍流注入后处理模块）
  已按上述精度纪律写好，尚未编译/接入 usr.cpp（M1-E 进行中）。

## 使用

```bash
cd kratos_frontend
.venv/bin/python -m pytest                 # 209 个测试
.venv/bin/kratos-front lift  runs/a.par -o spec.json
.venv/bin/kratos-front validate spec.json
.venv/bin/kratos-front emit  spec.json -o runs/a.regen.par
.venv/bin/kratos-front diff  runs/a.par runs/a.regen.par   # IDENTICAL
.venv/bin/kratos-front serve               # REST + 将来的 web 编辑器 @127.0.0.1:8620
```

## 下一步（M1 启动清单）

- 在 `~/apps/kratos_frontend_dev/usr_ext/universal/` 建通用 pgen 骨架
  （构建验证用 `make USRDIR=usr_ext/universal ARCH=HIPCPU`，**不在 trunk 构建**）；
- 模块工厂注册表（静态注册，产物 `usr/univ_registry.gen.inc`）；
- 角色注册表 + 容器装配（`[module.<role>]` + `[coupling]`）；
- 表达式引擎（host 编译 → device 栈式 VM）+ IC 三通道 + `expr_inflow`；
- 实例化矩阵 ≤ 8–12 组（riemann×recon×integ）；
- 性能基准：纯 hydro 双 vs 原生 pgen 差 < 1%；
- 用容器语法跑通 `usr_ext/cmz` 的 `prob::run` 语义。
