# 实施进度 (Implementation Status)

对应 `docs/kratos_frontend_plan.md` v2.0 的路线图。本文件只记录**状态与决策落点**，设计细节以计划文档为准。

## 里程碑状态

| 里程碑 | 内容 | 状态 |
|---|---|---|
| **M0** | 描述符目录 + `make bindings` + Spec→par CLI | ✅ **完成** (2026-09-30) |
| M0.5 | REST/CLI 骨架 (FastAPI) | ✅ **完成** (2026-09-30，即 M2.0，见下) |
| **M1** | `usr_ext/universal`（注册表 + 角色 + 接线 + 表达式 + IC + inflow BC） | 🔨 切片 A 完成：expr 引擎（word ops）+ univ_hydro + registry + sod_univ.par；**Sod 经典解验证通过**（CUDA/sm_86, L1(ρ)=1.3e-3，p\*/u\*/平台四位有效数字全对） |
| **M2** | 图形编辑器 + 项目文件 + Canvas2D 预览 | 🔨 M2.0/M2.1 完成（详案见 `docs/m2_plan.md`） |
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

## 使用

```bash
cd kratos_frontend
.venv/bin/python -m pytest                 # 61 个测试
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
