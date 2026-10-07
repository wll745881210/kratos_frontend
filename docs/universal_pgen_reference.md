# universal pgen 容器语法参考

本文档是 `usr_ext/universal/`（universal pgen）的**完整语法参考**，
面向使用者与维护者。每条规则都对应代码事实（出处见文中标注）；
与代码不符时以代码为准并修订本文档。kratos 内部机制背景见
`docs/kratos_internals.md`；变更流程见 `docs/regulations.md` §1。

---

## 1. 总览

universal pgen 把"问题装配"从 C++ `usr.cpp` 移到 par 文件：
**模块声明 + 耦合声明 + 表达式初场/边界**，全部在 par 中完成，无需重新编译。

注册的模块类型（`usr.cpp`）：

| `type` | 类 | 说明 |
|---|---|---|
| `hydro` | `univ::hydro_inflow_t` | 纯流体（内置 `expr_inflow` 边界） |
| `mhd` | `univ::mhd_t` | MHD |
| `multigrid` | `univ::mg_t` | 多重网格（引力泊松等） |
| `chemistry` | `univ::chem_t` | 化学（被动 species 亦可） |
| `chem_hydro` | `univ::chem_hydro_t` | 化学-流体耦合 |
| `post` | `univ::post_t` | 通用后处理（冷却/湍流驱动） |

---

## 2. 容器语法（registry.h + univ_mesh.h）

### 2.1 模块声明 `[module.<role>]`

```ini
[module.flow]
type = hydro
order = 0          # 可选；缺省 = 按节名字典序
```

- `<role>` 是模块实例名（任意合法节名后缀）；裸 `[module]` 的 role 为
  空串 `''`（与裸 `[coupling]` 配对）。
- `type` 必填，取值见上表；未知 type → 运行期 throw 并列出可用类型。
- `order` 决定 init/step 槽位（显式整数；重复 → 报错）。建议多模块时
  显式写出。
- `[module.<role>]` **只接受 `type` 和 `order` 两个键**；其他任何键
  （包括带点的键）→ 运行期 throw：
  `univ: [module.flow] key 'xxx' is not accepted here; [module.<role>] takes only 'type' and 'order'.  Put module parameters in section [flow.<section>]`
- 保留 role 名（与原生节名冲突）会被拒绝：`module coupling device
  unit mesh boundary cycle file init ic bc species_init dynamics
  chemistry multigrid post cooling`。

### 2.1a 模块参数 `[<role>.<section>]`（作用域节）

模块参数**不再写在 `[module.<role>]` 里**，而是写成以 role 为前缀的
节（univ_mesh.h `scoped_input` 在模块读参前把 `[R.<section>]` 重映射为
原生节名，仅该模块可见）：

```ini
[flow.dynamics]
gamma = 1.4
cfl    = 0.4

[flow.ic.left]
mask = x < 0.5
rho  = 1
```

- **继承 + 覆盖**：全局原生节（如 `[dynamics]`、`[ic.left]`、
  `[init]`）是所有模块的共享缺省；`[R.<section>]` 按**键**覆盖
  （同名键后写者胜）。因此可以"全局打底 + 单模块微调"。
- 隔离性来自前缀本身：其他 role 的键保持 `[R'.<sec>]` 形式，任何模块
  都不会以该名字读取 → 惰性（无需删除）。
- 模块类型能读哪些节见 §1 表格（hydro/mhd：`dynamics init ic.*`；
  chem_hydro 另有 `species_init`；chemistry：`chemistry`；multigrid：
  `multigrid`；post：`post post.cooling post.turb`）。GUI 的 Diagram
  inspector 就是按这个清单渲染的。
- init 阶段同样走作用域（`[flow.init]` 在 `init()` 时也重映射）。

### 2.2 耦合声明 `[coupling.<role>]`

```ini
[coupling.chem]
parasite = flow        # 寄生耦合（互相设置 q_mod），最多 1 个
[coupling.subgrid]
dyn = flow             # 命名耦合槽：值 = 空白分隔的 role 列表
```

- `parasite`：等价于 cmz 风格的 `q->parasite(p)`（chemistry 的 parasite
  是双向的，容器只调一次）。
- 其他键 = 命名槽（由目标模块的 `couple_slots()` 定义，如 post 的 `dyn`）。
- 未知 role / 未知槽 / 槽数超上限 → throw 并列出现有 role 与合法槽。
- 装配时打印计划：`[univ] module[0] role='flow' type='hydro'` 等。
- **自动接线**（univ_proxy.h）：dynamics 派生模块 → `prx_unv_t::p_dyn`、
  chemistry 派生 → `p_che`、multigrid → `p_mg[n]`（n<4）。同类多个
  dynamics/chemistry → 报错。

### 2.3 缺省回退

par 中没有任何 `[module.*]` 节 → 装配单个 hydro（role `dyn`，槽位 0），
即"旧式 par"（如 `std_tst/sod`）可直接跑。

---

## 3. 初始条件：三条通道（univ_hydro.h ic_t）

按叠加顺序：**① 底场文件 → ② 均匀场 + 层叠区域 → ③ 扰动表达式**。

### 3.1 通道 ①：`[init] base_file`

```ini
[init]
base_file = /path/to/snapshot.bin
```

从 kratos bin 文件读取本块守恒量作为底场（尺寸不符 → throw
"Invalid read size"）。hydro/mhd 支持在其上继续叠加通道②；
chem_hydro 暂不支持 ①+② 组合（会报错）。

### 3.2 通道 ②：均匀场 + `[ic.<name>]` 层叠区域

```ini
[init]
rho0 = 1  pre0 = 1  vel0 = 0 0 0    # 全域底（kh 风格）

[ic.left]                            # 区域按节名字典序依次叠加
mask = x < 0.5                       # 缺省 "1" = 全域
rho  = 1
pre  = 1

[ic.right]
mask = x geq 0.5                     # 词运算符（par 不能有 '='）
rho  = 0.125
pre  = 0.1
```

- 区域只覆盖它**显式设置**的场；其余场保留前一层值。
- 可设场：hydro `rho pre vel_x vel_y vel_z`；mhd 另加 `b_x b_y b_z`
  （面中心磁场，自动加到能量）；chem_hydro 另加 `x.<species>`（数密度分数）。
- 表达式可用变量：`x y z t i j k`（`t` 取 `[cycle] t_0`；`i j k` 为全局
  整数单元索引）。
- mhd 的 `b_*` 在面网格上采样（与 std_tst/mhd_st 相同的 clamp-cc 约定，
  保证连续法向 B → 离散 divB=0）。
- 多模块时 IC 也可作用域化：`[flow.ic.left]` 只作用于 `flow`（覆盖同名
  全局 `[ic.left]` 的键）；全局 `[ic.*]` 节对所有会读它的模块生效。

### 3.3 通道 ③：扰动 = 表达式

无独立机制——直接用 `rand()` 等函数写进任何表达式：

```ini
[ic.pert]
mask = 1
vel_y = 0.01 * (rand(i,j,k,42) - 0.5)
```

`rand(i,j,k,seed)`：splitmix64 链 `sm64(seed)→+i→+j→+k` → `[0,1)` 均匀。
**按块布局+分辨率确定**（改变布局/分辨率得到新噪声实现，统计等价但不
逐位一致；见 `docs/rand_verification.md` 与 regulations §3）。

---

## 4. 表达式文法（expr.h，唯一权威）

```
or    := and   ( ('||'|'or')  and )*
and   := cmp   ( ('&&'|'and') cmp )*
cmp   := add   ( cmpop add )?
cmpop := '<'|'<='|'>'|'>='|'=='|'!=' |
         'lt'|'leq'|'gt'|'geq'|'eq'|'ne'|'neq'
add   := mul   ( ('+'|'-') mul )*
mul   := unary ( ('*'|'/') unary )*
unary := ('-'|'!'|'not') unary | pow
pow   := prim  ( '^' unary )?              （右结合）
prim  := number | ident | func '(' args ')' | '(' or ')'
```

- 常量：`pi`、`e`。变量：`x y z t i j k`（下标 0..6）。
- 函数：`sqrt exp log sin cos tan asin acos atan abs step floor
  tanh sinh cosh erf`（一元）；`min max pow atan2`（二元）；
  `clamp(x,lo,hi)`（三元）；`rand(i,j,k,seed)`（四元）。
  `step(a) = a>=0 ? 1 : 0`。
- 比较/逻辑产出 1.0/0.0。
- **词运算符**（`lt leq gt geq eq ne neq and or not`）是保留字，
  因为 par 文件值**不能含 `=`**、且 `get<string>` 截断于空白——
  par 中一律写 `x geq 0.5` 而非 `x >= 0.5`。
- 同一文法有三端实现（C++/Python `expr.py`/JS `expr.ts`），共享
  golden vectors（`tests/expr_vectors/`，`kratos-front bindings` 重新生成）。

---

## 5. 边界条件

`[boundary] kinds` 顺序固定：**`x- x+ y- y+ z- z+`**。

| kind | 含义 |
|---|---|
| `per` | 周期 |
| `out` | 出流（零梯度） |
| `fre` | 自由（kratos 内置 free） |
| `ref` | 反射 |
| `inf` | **表达式入流**（universal 扩展，见下） |

### `inf` = expr_inflow（univ_inflow.h）

```ini
[boundary]
kinds = inf out per per per per

[bc.expr_inflow]
rho   = 2
pre   = 1
vel_x = 1 + 0*t        # t 可用：当前模拟时间（每步更新）
```

- 未设置的场 = 零梯度（拷贝邻近内部行）。
- 表达式在**鬼单元**坐标上求值（`x y z` 为鬼单元中心）；变量 `t` 为
  `mesh.p_cyc->t`。
- 多模块时可作用域化：`[flow.bc.expr_inflow]` 只作用于 `flow` 模块
  （覆盖全局 `[bc.expr_inflow]` 的键）。
- 仅 `hydro` 类型内置此 keeper；`inf` 用于其他模块类型 → 运行期报错。

---

## 6. 模块键表

### 6.1 `hydro`

| 节 | 键 | 默认 | 说明 |
|---|---|---|---|
| `[dynamics]` | `riemann` / `reconstruct` / `integrator` | `hllc`/`plm`/`rk2` | 本构建仅此组合；其他值 → throw 并列可用项 |
| `[dynamics]` | `gamma` `cfl` 等 | — | trunk 原生键（见 `src/modules/dynamics/`） |
| `[init]` | `rho0 pre0 vel0` | 0/0/0 | 均匀底场（通道②基础） |
| `[init]` | `base_file` | `""` | 通道① |
| `[ic.*]` | 见 §3.2 | — | 通道② |

### 6.2 `mhd`

同 hydro（默认组合 `hlld/plm/rk2`），另加 `[init] b0 = bx by bz`；
IC 区域可设 `b_x b_y b_z`（面中心，见 §3.2）。

### 6.3 `multigrid`

全部 trunk `[multigrid]` 键原样生效（`n_iter n_smooth dtol thread_limit
print_info phy_bnd_type` 等，见 `src/modules/multigrid/multigrid.cpp`）。
**注意**：多重网格 V 循环在退化轴（n_cell=1）上会 SIGFPE——含 mg 的
测试网格所有轴 ≥32（kratos_internals §调试清单）。

### 6.4 `chemistry`

| 节 | 键 | 说明 |
|---|---|---|
| `[chemistry]` | `species` | 物种列表，如 `H2 H H+ e`；命名规则：`*` 前缀剥离、`+/-` 计电荷、`(...)` 忽略、`e`=电子、元素按 `[A-Z][a-z]*`+可选计数（`H2`=2 个 H） |
| `[chemistry]` | `reaction_file` | 空 = 跳过标准反应（**被动 species** 合法） |
| `[chemistry]` | `Tmin` / `Tmax` | 默认 2.7 / 1e7 K——**单位自由模拟必须显式设 `Tmin=1e-30`**，否则能量被钳制放大（internals §6） |
| `[species_init]` | `<species>` | 初始数密度分数，缺省 1e-20，自动归一化 |

### 6.5 `chem_hydro`

= hydro 全集 + 化学耦合。求解器组合由化学固定（chem rec/rie，无
`[dynamics] riemann` 等选择）。必须：化学模块经 `parasite` 耦合
（单向声明即可，chemistry 自动反向绑定）。IC 区域支持 `x.<species>`
通道；物种守恒量位于 `u[n_hvar+n]`。

### 6.6 `post`

| 节 | 键 | 默认 | 说明 |
|---|---|---|---|
| `[post]` | `thread_limit` | 64 | — |
| `[post.cooling]` | `enabled` | 0 | 开关（0/1） |
| | `file` | — | 冷却表：3 列 `log10T, log10Λ0, log10Λ1`，lnT 均匀网格，`#` 注释行 |
| | `mu_amu` | 0.6 | 平均分子量 |
| | `z_z0` | 0 | 金属度（加热项系数） |
| | `T_cut` | 10 | 截止温度（K），低于则不冷却 |
| | `heat0_cgs` | 0 | 加热项 |
| | `n_sub` | 8 | 子循环数（改进后向 Euler，lnT 上） |
| `[post.turb]` | `enabled` | 0 | 开关 |
| | `edot` | 0.1 | 单位质量动能注入率（L²/T³，>0）；每周期精确注入 edot·dt·M |
| | `mode_max` | 1 | 每周期随机平面波波数分量上限（单位 2π/L，≥0） |
| | `seed` | 42 | 驱动随机序列种子（确定性） |
| | `n_cycle_off` | -1 | -1 持续驱动；n = 前 n 个周期驱动后关闭 |

- 冷却在 CGS 下内部计算：需要 `[unit]` 提供 `length/time/density`
  （`density` 可写 `mp`）。γ 取自耦合动力学模块的 eos。
- 湍流驱动：随机平面波 kick（turb_chem 同款），振幅由能量条件解析解出
  （`A·conv² + B·conv = edot·dt·M`）。**两个硬约束**：post 的 `order`
  必须大于其 dyn 目标（容器硬错）；初速必须非零（静止时振幅方程退化，
  GUI 校验器警告）。详见 `docs/user_guide_turb_box.md` §6。
- `[post.cooling]`/`[post.turb]` 全关 → step 直接跳过（打印提示），
  开销为零。

---

## 7. 单位与精度

- 单位自由的模拟不需要 `[unit]`；涉及 CGS 物理（冷却表、化学 T0 等）
  时必须提供。`[unit]` 派生量以 FP32 存储：l0+m0+t0+ene0+vel0 溢出
  3.4e38 → kratos 直接报错（如 `kpc + mp`；换 `pc + Myr`）。
- universal pgen 全部遵守 kratos 混合精度约定：**`float_t`（默认 FP32）
  用于一切非守恒量计算；`float2_t`（默认 FP64）只用于守恒量及其
  加减**（PRECISION 构建开关见 `src/types.h`）。

---

## 8. 错误行为

| 场景 | 行为 |
|---|---|
| 未知 `type` / 未知耦合 role / 未知槽 | 运行期 throw，信息列出可用项 |
| 重复显式 `order` | throw |
| 求解器组合不可用 | throw，列出本构建可用组合 |
| `base_file` 尺寸不符 | throw "Invalid read size" |
| 表达式语法错 | throw，含字节位置 |
| 前端校验（`kratos-front validate` / GUI） | 核心节未知键 error、模块节未知键 warning、跨字段规则（xchecks）error/warning——error 不阻止保存，由用户负责 |

---

## 9. 示例索引

| 文件 | 演示 |
|---|---|
| `usr_ext/universal/pars/sod_univ.par` | 最小 hydro + 两段 IC |
| `usr_ext/universal/pars/briowu_univ.par` | mhd + `b_*` IC |
| `usr_ext/universal/pars/chem_sod_univ.par` | chem_hydro + species IC（`x.H2`） |
| `usr_ext/universal/pars/turb_box.par` | hydro + post 湍流驱动（教程 §3） |
| `usr_ext/universal/pars/mg2_hydro.par` | 多模块 + order + 作用域节覆盖 |
| `usr_ext/universal/pars/role_sections.par` | 作用域节传导验证（mg_a 静默 / mg_b 打印） |
| `usr_ext/universal/pars/cmz_shape.par` | cmz 接线的容器语法表达性工件（不可运行） |
| 表达式入流 | 见 `docs/implementation.md` M1-B 与 §5 |
