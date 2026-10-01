# 用户指南：部署你的第一个湍流模拟（turb_box）

本文档指导你在 kratos + universal pgen + kratos_frontend 工具链上，从零部署一个
**周期边界盒中的驱动湍流**流体力学模拟。所有命令与参考数字均来自实际验证运行
（见 §2.4），可直接复制执行。

- 目标配置：32×16×16 均匀网格、六面周期边界、γ=1.4 理想气体、
  静止均匀初始场 + `post` 模块湍流驱动（v_turb=0.5）。
- 参考运行（RTX 3080 Ti，CUDA）：140 周期到 t=0.5，耗时 0.037 s。

---

## 1. 一次性环境准备

### 1.1 构建 kratos（含 universal pgen）

kratos 采用"开发目录 = 主干符号链接"布局（见 `~/apps/kratos_frontend_dev/DEVELOPMENT.md`）：

```bash
cd ~/apps/kratos_frontend_dev
nvidia-smi            # 选一块空闲 GPU，记录其计算能力（3080 Ti/3090 → sm_86）
make USRDIR=usr_ext/universal ARCH=CUDA SM=sm_86 -j$(nproc)
# 产物：bin/kratos
```

- **GPU 选择**：`nvidia-smi` 查看占用；本机 GPU1（3080 Ti）通常空闲。
- **无 GPU / 调试**：`make clean && make USRDIR=usr_ext/universal ARCH=HIPCPU -j$(nproc)`。
  CPU 构建下 par 里 `idx_device` 必须为 **0**。
- **改代码后**：HIPCPU 调试用 `make remake USRDIR=... ARCH=HIPCPU DEBUG=1`；
  之后回 CUDA 必须 `make clean && make`（obj/ 跨 ARCH 不共享）。

### 1.2 安装前端

```bash
cd ~/Seafile/seafile_sync/code/kratos_frontend
uv venv && uv pip install -e '.[test,server]'   # 或 pip install -e '.[test,server]'
.venv/bin/kratos-front --help                   # 验证安装
```

主要子命令：`validate / lift / emit / diff / serve / open / bin / bindings`。

---

## 2. 最小工作流（三步）

### 2.1 拿到 par 文件

示例 par 已随 universal pgen 附带：
`kratos/usr_ext/universal/pars/turb_box.par`（全文见 §3，可直接复制）。

### 2.2 校验

```bash
.venv/bin/kratos-front validate \
    ~/apps/kratos_frontend_dev/usr_ext/universal/pars/turb_box.par
# 期望：0 errors（warning 可接受，会逐条列出）
```

### 2.3 运行

```bash
mkdir -p ~/scratch/my_turb && cd ~/scratch/my_turb
~/apps/kratos_frontend_dev/bin/kratos \
    ~/apps/kratos_frontend_dev/usr_ext/universal/pars/turb_box.par
```

> ⚠️ **必须传 par 的完整路径**。`kratos turb_box.par` 在当前目录没有该文件时
> **不会报错**，而是静默使用全默认参数，直到下游才抛出莫名其妙的异常。

### 2.4 参考结果（本次验证运行的真实输出）

```
cycle = 140, t = 5.000000e-01, dt = 9.57e-04
Duration = 3.71e-02 s, Speed = 3.11e+07 cell/s
```

输出两个文件：`turb_00000.bin`（t=0 初始场，v_rms=0、ρ≡1）与
`turb_00001.bin`（t=0.5 末态，各 322 KB）。末态：

| 量 | 值 | 判据 |
|---|---|---|
| v_rms | 2.4539 | 与 v_turb=0.5 同量级（驱动-耗散平衡，不必相等） |
| ⟨KE⟩ | 2.6551 | 从 0 增长后饱和 |
| ρ 范围 | 0.1058 … 5.4208 | 出现可压缩结构 |

同样配置 + 同一 GPU + 同一 seed 重复运行应得到**逐位一致**的结果。

---

## 3. par 全文与逐节讲解

```ini
[device]
idx_device = 1            # 选空闲 GPU；HIPCPU/CPU 构建必须为 0

[mesh]
x_min = 0 0 0
x_max = 1 1 1
n_cell_global = 32 16 16

[boundary]
kinds = per per per per per per   # 顺序固定：x- x+ y- y+ z- z-

[dynamics]
gamma = 1.4
cfl   = 0.4

[cycle]
t_0 = 0
t_lim = 0.5
dt_init = 1e-3
dt_expand = 1.2            # 每周期 dt 增长上限倍数
n_cycle_lim = 100000
dt_output = 1              # 输出间隔（时间单位）；> t_lim 则中途不输出
final_output = 1           # 结束时强制写一次（布尔只接受 0/1！）
prefix_output = turb       # 前缀：turb_00000.bin=初始, turb_00001.bin=末态
n_display_freq = 100
t_display_prec = 6

[init]
rho0 = 1
pre0 = 1
vel0 = 0 0 0               # 静止均匀气体；不写 [ic.*] 时整个域都是这个状态

# --- 模块装配（universal 容器语法） ---
[module.flow]
type = hydro               # 纯流体模块
order = 0                  # 执行顺序

[module.post]
type = post                # 通用后处理模块（冷却/湍流驱动/...）
order = 1                  # 在 hydro 之后执行

[coupling.post]
dyn = flow                 # 耦合槽：post 需要一个名为 dyn 的流体模块

# --- 湍流驱动参数 ---
[post.turb]
enabled = 1                # 布尔只能是 0/1（写 true 会被读成 0！）
v_turb = 0.5               # 目标速度色散量级
k_turb = 6.283185307179586 # 驱动波数 = 2π/L_box（盒尺度驱动）
n_modes = 8                # 随机模数（≤16）
seed = 42                  # 模式种子（固定可复现）
t_corr = 1                 # 相关时间 ≈ 盒穿越时间 L/v_turb 的量级
```

要点：
- **不写 `[ic.*]` 区域**时，`[init]` 的 rho0/pre0/vel0 作用于全域（kh 风格）。
- `[post.cooling]` 不写 = 冷却关闭；`[post.turb] enabled=0` 或整个
  `[post.*]` 都不写 = post 模块跳过自身 step（打印提示），开销为零。
- 本例不需要 `[unit]`（单位自由，代码单位）。需要物理单位（CGS 转换、
  冷却表）时再写——注意单位组合的 FP32 范围（见 §6 FAQ-5）。

---

## 4. 用 GUI 完成同样的事

```bash
cd ~/scratch/my_turb        # 服务器默认把这个目录加进文件白名单
~/Seafile/seafile_sync/code/kratos_frontend/.venv/bin/kratos-front serve
# 打开 http://localhost:8620
```

1. **打开**：文件浏览器定位 par；或 `kratos-front open <file.par>` 一条命令
   （自动拉起服务器 + 打开浏览器）。
2. **Globals 标签页**：`[unit]/[mesh]/[cycle]/[device]` 卡片式编辑，
   单位组合溢出、块布局整除等错误**实时**标红。
3. **Diagram 标签页**：应看到 `flow`(hydro) 与 `post` 两个节点及一条
   `dyn` 耦合边；拖拽布局会记入 `meta.diagram_positions`。
4. **Preview 标签页**：IC 模式可预览 `[ic.*]` 表达式初场（本例为均匀场，
   图像是平的——正常）；运行后切到 **BIN 模式**，输入 `turb_00000.bin`
   路径 → Load → 选字段/分量/切片即可看图。
5. **保存**：表单视图与 par 文本保证 key-identical 往返。

---

## 5. 检查与分析输出

```bash
# 快速一览（无需 Python 环境之外的东西）
kratos-front bin turb_00001.bin
#   time=0.5  cycle=140  dt=9.6e-04
#   block_0: level=0 n_cell=[32,16,16] ...
#     hydro_cons: shape=[5,16,16,32] min=-8.82 max=47.39
# （turb_00000.bin 是 t=0 的初始场；编号随输出次数递增）
```

Python 分析（前端自带 `kratos_spec.binread`，只依赖 numpy）：

```python
import sys, numpy as np
sys.path.insert(0, 'kratos_frontend/core')          # 指向你的前端仓库
from kratos_spec.binread import BinFile

bf = BinFile('turb_00001.bin')
b = bf.blocks()[0]
u = bf.read_field(b, 'hydro_cons')   # (5, nz, ny, nx): rho, ene, mom_x/y/z
rho, mom = u[0], u[2:5]
v2 = (mom[0]**2 + mom[1]**2 + mom[2]**2) / rho**2
print('v_rms =', np.sqrt(v2.mean()))
```

---

## 6. 湍流驱动：参数含义与预期

驱动器为**算子分裂随机kick**（固定模式集，种子可复现）：
每步振幅 `A = v_turb · sqrt(dt/t_corr) · sqrt(M/S)`，其中
`M=Σρ`、`S=Σρ|dv|²`（dv 为模式叠加的方向场）。能量注入是精确的
（同时更新动量与总能量）。

| 参数 | 含义 | 调参建议 |
|---|---|---|
| `v_turb` | 速度色散目标量级 | 饱和 v_rms 与其同量级（本例 0.5 → 实测 2.45，比值依赖耗散） |
| `k_turb` | 驱动波数 | 大尺度驱动取 2π/L；更小尺度取整数倍 |
| `n_modes` | 叠加模式数 | 8–16；模式集由 seed 确定性生成 |
| `seed` | 模式种子 | 换 seed = 换一组模式（实现级可复现性不变） |
| `t_corr` | 相关时间 | ≈ 盒穿越时间；过小→高频抖动，过大→漂移 |

---

## 7. 放大到生产规模

- 改 `n_cell_global = 128 128 128` 即可；粗估耗时
  `wall ≈ 单元数 × 周期数 / Speed`（Speed 以你 run.log 实测值为准）。
- **规程提醒**（`docs/regulations.md` §3）：
  - 分辨率/块布局变更后，`rand(i,j,k,seed)` 噪声是**新实现**
    （统计等价、不逐位一致）；本例的湍流驱动模式与布局无关，不受影响。
  - 收敛性研究：用 `kratos-front bundle` 派生项目（白名单只覆盖
    `n_cell_global`），保证其余键逐位一致。
  - `n_cell_block` 切分块布局时须整除（校验器会报 error）。

---

## 8. 常见问题（全部来自真实踩坑）

1. **par 值里不能有 `=`**：`mask = x >= 0.5` 会被截断成 `x >`。
   比较/逻辑请用词运算符：`geq leq neq gt lt eq ne and or not`。
2. **布尔只能写 0/1**：`enabled = true` 会被读成 **0**。
3. **`idx_device`**：HIPCPU/CPU 构建只能为 0；CUDA 构建选空闲卡。
4. **par 路径**：运行时必须传存在的完整路径，否则静默默认参数。
5. **单位溢出**：`[unit]` 派生量以 FP32 存储（trunk 事实）——
   `length=kpc + density=mp` 会得到 m0≈5e40 > 3.4e38 直接报错；
   改用 pc/Myr 即可（Globals 卡片有实时检查）。
6. **dt 突然变得极小**：检查是否探针 par 里 `t_lim` 接近当前 t
   （`min(dt, t_lim−t)` 钳制是设计行为，不是 bug）。
7. **输出文件编号**：`turb_00000.bin` 是 cycle 0 的初始输出
   （`t_output_next` 默认从 t_0 起排程），末态是编号最大的那个；
   `final_output=1` 会在结束时额外写一次——若它恰好与计划输出同时刻，
   会得到两个内容相同的文件。
8. **`[boundary] kinds` 顺序**：固定 `x- x+ y- y+ z- z+`，写错不报错。
9. **zsh**：`rm *.bin` 在无匹配时会中断 `&&` 链（先 `ls` 确认）。

---

## 9. 相关文档

- `docs/kratos_internals.md` — 已核验的 kratos 内部事实（含全部陷阱）
- `docs/regulations.md` — 模块添加 / 超参数 / 网格调整三节规程
- `docs/implementation.md` — 里程碑与实现记录
- `docs/rand_verification.md` — rand() 噪声检验方法与诚信约定
- 通用容器语法与 IC 表达式：`docs/implementation.md` M1 各节 +
  `usr_ext/universal/expr.h` 顶部文法注释
