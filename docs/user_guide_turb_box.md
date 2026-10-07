# 用户指南：部署你的第一个湍流模拟（turb_box）

本文档指导你在 kratos + universal pgen + kratos_frontend 工具链上，从零部署一个
**周期边界盒中的驱动湍流**流体力学模拟。所有命令与参考数字均来自实际验证运行
（见 §2.4），可直接复制执行。

- 目标配置：32×16×16 均匀网格、六面周期边界、γ=1.4 理想气体、
  微弱白噪声初速 + `post` 模块湍流驱动（edot=0.1，每周期**精确**注入
  edot·dt 的单位质量动能）。
- 参考运行（RTX 3080 Ti，CUDA）：73 周期到 t=0.5，计算循环 0.016 s
  （3.8×10⁷ cell/s，整进程 wall 0.29 s）。

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
cycle = 73, t = 5.000000e-01
Duration = 1.59e-02 s, Speed = 3.82e+07 cell/s
```

输出两个文件：`turb_00000.bin`（t=0 初始场，v_rms=0.0082 为种子扰动）与
`turb_00001.bin`（t=0.5 末态，各 323 KB）。末态：

| 量 | 值 | 判据 |
|---|---|---|
| ΔE（总能量增量） | 0.05000000 | **= edot·M·T = 0.1×1×0.5，精确到 5×10⁻¹⁰** |
| M（总质量） | 1.00000000 | 守恒 |
| v_rms | 0.2568 | 从 0.0082 的种子增长 |
| KE(T) | 0.032945 | ≤ edot·T·M = 0.05（其余已耗散为热） |
| ρ 范围 | 0.6896 … 1.3788 | 出现可压缩结构 |

同样配置 + 同一 GPU + 同一 seed 重复运行得到**逐位一致**的结果
（约化求和已做成确定性顺序；`cmp` 实测相同）。

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
vel0 = 0 0 0               # 均匀静止基态

# 驱动器静止时奇异（见 §6），必须播种初始速度扰动：
[ic.seed]
vel_x = 0.01 * ( 2 * rand( i, j, k, 42 ) - 1 )
vel_y = 0.01 * ( 2 * rand( i, j, k, 43 ) - 1 )

# --- 模块装配（universal 容器语法） ---
[module.flow]
type = hydro               # 纯流体模块
order = 0                  # 执行顺序

[module.subgrid]
type = post                # 通用后处理模块（冷却/湍流驱动/...）
order = 1                  # 必须排在 dyn 目标之后（容器会硬错）

[coupling.subgrid]
dyn = flow                 # 耦合槽：post 需要一个名为 dyn 的流体模块

# --- 湍流驱动参数 ---
[post.turb]
enabled = 1                # 布尔只能是 0/1（写 true 会被读成 0！）
edot = 0.1                 # 单位质量动能注入率（代码单位 L²/T³）
mode_max = 2               # 每周期随机平面波模的 |k| 上限（单位 2π/L）
seed = 42                  # 驱动随机序列种子（固定可复现）
n_cycle_off = -1           # -1 = 一直驱动；n = 前 n 个周期驱动后关闭（衰减流）
```

要点：
- **不写 `[ic.*]` 区域**时，`[init]` 的 rho0/pre0/vel0 作用于全域（kh 风格）；
  本例 `[ic.seed]` 只覆写 vel_x/vel_y 两个通道。
- **驱动湍流必须播种初速**（`[ic.seed]` 或 `[init] vel0 ≠ 0`）：
  静止流体上驱动器的振幅方程无解，GUI 校验器会对 `enabled=1` +
  零初速组合给出警告。
- `[post.cooling]` 不写 = 冷却关闭；`[post.turb] enabled=0` 或整个
  `[post.*]` 都不写 = post 模块跳过自身 step（打印提示），开销为零。
- `post` 模块的 `order` 必须**大于**其 `dyn` 目标，否则容器启动时硬错
  （校验器在 GUI 侧同文本报错）。
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
#   time=0.5  cycle=73  dt=9.6e-04
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

驱动器为**随机平面波 kick**（`usr_ext/turb_chem` 同款算法）：每个周期
rank-0 抽取一个波模 `k = 2π/L · k_i`（|k_i| ≤ mode_max，不全为零）与
随机单位方向 `v_test`，广播后全场加

```
Δu = conv · v_test · cos(k·(x − x₀)) · ρ
```

振幅 `conv` 由能量条件**解析**解出：设 `amp = cos(k·(x−x₀))`，
`A = ∫ρ·amp²/2 dV`、`B = ∫ρ·amp·(v_test·v) dV`、`M = ∫ρ dV`，
解二次方程 `A·conv² + B·conv = edot·dt·M`。因此**每个周期注入的
总能量恰为 edot·dt·M**（动量与总能量同步更新，无漂移；实测 73 周期
累计误差 5×10⁻¹⁰，即浮点舍入水平）。

| 参数 | 含义 | 调参建议 |
|---|---|---|
| `edot` | 单位质量动能注入率（L²/T³） | 期望的 v_rms ~ (edot·L)^(1/3)（Kolmogorov 估计：本例 0.1 → ~0.46，实测 0.26，含可压缩耗散） |
| `mode_max` | 抽取波数整数分量上限（单位 2π/L） | 1 = 纯盒尺度；2–3 增大随机性 |
| `seed` | 驱动随机序列种子 | 换 seed = 换驱动序列（逐位可复现不变） |
| `n_cycle_off` | 关闭驱动的周期号 | -1 = 持续驱动；设为 n 得到 n 周期驱动后的**衰减湍流** |

**两个硬约束**：

1. **post 必须排在 dyn 之后**（`order` 更大）：驱动要在动力学步
   之后修改动量/能量，容器对此硬错。
2. **初速不能为零**：静止流体上 B=0 且注入前 A 项对应的解退化
   （kick 平方可正可负、二次方程取根方向无意义）；实际表现为
   湍流永不启动。务必像本例一样用 `[ic.seed]` 播种
   `0.01·(2·rand−1)` 量级的白噪声。

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

## 8. 物理单位（CGS）变体：`ism_turb.par`

turb_box 用的是 code units（ρ=1、L=32）。做物理设置时，请用
`usr_ext/universal/pars/ism_turb.par`：**所有物理量以 CGS 输入**（`_cgs`
后缀），pgen 读参数时换算为 code unit——天体物理典型的
`10 pc / 1 Myr / 1e-24 g/cm³` 单位制：

```ini
[unit]
length   = 3.0857e19     # 10 pc
time     = 3.1557e13     # 1 Myr
density  = 1.0e-24       # g/cm^3 (~0.6 particles/cm^3)

[init]
rho0_cgs = 1.0e-24       # → rho0 = 1
pre0_cgs = 3.856e-13     # → ~T 300 K（μ 0.6）

[ic.seed]
vel_x_cgs = 1.0e4 * ( 2 * rand( i, j, k, 42 ) - 1 )   # 0.1 km/s 白噪声

[subgrid.post.turb]
edot_cgs  = 1.515e-3     # erg/g/s → 0.05 code units
```

注意（完整规则见 `universal_pgen_reference.md` §7）：

- `edot_cgs`（erg/g/s）的换算是 **`l0²/t0³`**（比能功率，不含 ρ 因子）；
  本单位制下 = 3.03e-2，故 1.515e-3 → 0.05。**校准 edot 时用对公式**
  ——这是真实踩过的坑（配 3e-27 会得到 1e-25 的无效驱动）。
- 表达式里 `x/y/z/t` 仍是 code units（本例 [0,1]³）；通道数值才是 CGS。
- 同通道裸键与 `_cgs` 互斥；`_cgs` 必须有 `[unit]`；GUI 会守卫 FP32
  动态范围（换算值距 3.4e38/1.2e-38 不到 3 个数量级时告警）。

参考结果（64³、8×32³ 块、t=2 Myr、343 周期、~1 s GPU）：
**dE = 0.100005 = edot·M·T = 0.05×1×2（精确到 5×10⁻⁵）**；v_rms 从
0.0084（种子）涨到 **0.366 code = 3.6 km/s**（其余注入能量经激波耗散
为热——E 精确增加 0.1，KE 只保留 0.067）；M=1.000000 守恒。

---

## 9. 常见问题（全部来自真实踩坑）

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
10. **驱动湍流不启动（v_rms 一直是种子量级）**：初速为零时驱动器的
    振幅方程退化。检查 `[ic.*]` 是否真的定义了 vel 通道、
    `[init] vel0` 是否非零（GUI 校验器会警告）。

---

## 10. 相关文档

- `docs/kratos_internals.md` — 已核验的 kratos 内部事实（含全部陷阱）
- `docs/regulations.md` — 模块添加 / 超参数 / 网格调整三节规程
- `docs/implementation.md` — 里程碑与实现记录
- `docs/rand_verification.md` — rand() 噪声检验方法与诚信约定
- `docs/universal_pgen_reference.md` — 容器语法与 IC 表达式完整参考
- 表达式文法权威：`usr_ext/universal/expr.h` 顶部文法注释
