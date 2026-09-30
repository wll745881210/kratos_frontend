# 实施进度 (Implementation Status)

对应 `docs/kratos_frontend_plan.md` v2.0 的路线图。本文件只记录**状态与决策落点**，设计细节以计划文档为准。

## 里程碑状态

| 里程碑 | 内容 | 状态 |
|---|---|---|
| **M0** | 描述符目录 + `make bindings` + Spec→par CLI | ✅ **完成** (2026-09-30) |
| M0.5 | REST/CLI 骨架 (FastAPI) | ⬜ 未开始（fastapi 未安装，服务器需求后置） |
| **M1** | `usr_ext/universal`（注册表 + 角色 + 接线 + 表达式 + IC + inflow BC） | ⬜ 未开始 |
| **M2** | 图形编辑器 + 项目文件 + Canvas2D 预览 | ⬜ 未开始（按计划与 M1 并行） |
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

## 使用

```bash
cd kratos_frontend
python3 -m pytest tests/                 # 52 个测试
export PYTHONPATH=core                   # 或 pip install -e .
python3 -m kratos_spec.cli lift  runs/a.par -o spec.json
python3 -m kratos_spec.cli validate spec.json
python3 -m kratos_spec.cli emit  spec.json -o runs/a.regen.par
python3 -m kratos_spec.cli diff  runs/a.par runs/a.regen.par   # IDENTICAL
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
