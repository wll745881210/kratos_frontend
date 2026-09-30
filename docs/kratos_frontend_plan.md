# Kratos 框图式前端系统：调研报告与实现方案规划

> 面向学生部署与使用的可视化 problem generator 替代方案
> 版本：v2.0（整合版：全功能通用 pgen、多实例与容器选定语法、表达式引擎、工程文件与迁移、预览器、描述符驱动架构）

---

## 0. 设计决策速览

| 决策点 | 结论 | 详见 |
|--------|------|------|
| 总体形态 | 图形化方案 = **通用 Pgen + 参数文件生成器**（Track A），代码生成轨兜底新物理（Track B） | §4.2、§4.3 |
| 通用 Pgen 基座 | 默认 chem_hydro / chem_mhd（0 组分 = 纯流体/MHD 效率），全模块注册、`enabled` 跳过 | §4.2 |
| 同类模块多实例 | 角色注册表 + 角色作用域 par section + 命名耦合槽位（不改 `src/`） | §4.2.1 |
| 跨模块数据访问 | 构建期由描述符生成联合 proxy 视图；槽位按耦合语义命名（同型多实例 = 命名槽位/小数组+运行期计数）；运行期仅 host 侧指针接线 | §4.2.5 |
| 容器组装 | 模块工厂注册表 + par 的 `[module.<role>]`/`[coupling]` 声明式选定语法 | §4.2.2 |
| 初始/边界条件 | 自带表达式引擎（host 编译为字节码 + 设备端栈式 VM，零第三方依赖）；IC 三通道 + 组分数分数字典 + 表达式内流边界 | §4.2.3、§4.2.4 |
| 唯一中间表示 | Problem Spec（JSON/YAML），Schema 由模块描述符汇编生成 | §4.4、§4.6 |
| 工程文件 | JSON 清单 + 目录制工程（不用 XML）；tar.gz bundle 跨设备迁移，支持变尺度覆写 | §4.5.1、§4.5.2 |
| 预览器 | 2D 截面 + Canvas 2D（无 WebGL）；表达式文法三实现共享 golden 测试向量防漂移 | §4.5.3 |
| 可维护性 | 模块描述符为唯一事实源，增删改模块不动前端代码 | §4.6 |
| LLM | 可插拔增强（NL→Spec、错误诊断、参数顾问），Schema 约束防幻觉 | §4.8 |
| Agent 接口 | REST + OpenAPI 与 CLI 镜像为唯一程序化入口；结构化错误、幂等、审计；MCP 为可选薄适配层 | §4.8 |

---

## 1. 背景与目标

Kratos 目前通过 **problem generator**（每个算例一个 `usr_ext/<problem>/usr.cpp` C++ 文件）定义物理问题。这要求学生掌握：现代 C++（模板元编程 / CRTP）、CUDA/HIP 设备代码写法、Kratos 内部的模块注册与数据代理机制。学习曲线对天文背景的学生过于陡峭。

**目标**：为学生提供一个**基于框图（block-diagram）的前端界面**，通过拖拽与连接图块完成问题定义，后端自动生成可编译运行的 Kratos 输入（参数文件或 problem generator 代码），并可选地接入 LLM 提供自然语言辅助。

**核心约束**：
1. 方案必须与 Kratos 代码本体**相对独立**——不侵入 `src/` 核心框架，对 Kratos 的修改最小化且可选。
2. **Kratos 模块仍在快速演进与增补中**——前端架构必须是**数据（描述符）驱动**的：新增/修改/删除一个模块时，只动一份声明式描述文件，前端面板、校验规则、代码生成模板随之自动更新，而不是改前端代码。
3. **工程化与可迁移性**——模拟设置应有自描述的工程文件（可被学生、AI agent 与 harness 理解与接管），支持跨设备打包迁移与"本地小测 → 集群大算"的变尺度放大，并提供零重型依赖的初始/边界条件预览。

---

## 2. Kratos Problem Generator 机制剖析（代码分析结论）

对 `kratos.tar.gz` 源码与 Wang (2025, ApJS, 277, 63) 方法论文的分析表明，一个 problem generator（以 `usr_ext/kh_gas/usr.cpp`，1636 行为典型）实际承担 **五类职责**：

| # | 职责 | 代码体现 | 性质 |
|---|------|----------|------|
| 1 | **模块与算法注册** | `prob::run()` 中 `mesh.enroll_device/comm/binary_io/module<>()`；模块内 `enroll<proxy, stepper, eos, reconstructor, riemann>()` | 编译期选择 |
| 2 | **自定义物理** | CRTP 继承：`eos_t : adiabatic_t<eos_t>`、`hllc_t : riemann::hllc_t<hllc_t>`、冷却函数 `cool_t::solve()` 等 `__device__` 代码 | 编译期、含设备代码 |
| 3 | **初始条件** | host 端预计算（平衡曲线、ODE 积分建表）+ `init_cond(dual_t&)` 逐网格块填充 | 编译期、host+device |
| 4 | **边界条件** | `.par` 中 `[boundary] kinds = per per per per out out`，或自定义代码 | 运行期参数 / 编译期 |
| 5 | **运行参数** | `.par` 文件（INI 风格 `[section] key = value`），由 `input::get<T>(section, key, default)` 读取 | **纯运行期** |

### 2.1 关键架构事实

1. **编译期多态是硬约束**。论文 §2.4 明确指出 Kratos 刻意使用 CRTP/模板元编程而非虚函数（虚表在 GPU 上可致约 10² 倍性能损失）。**前端无法做成"纯运行时配置器"**——自定义物理最终必须落到：① 预先编译好的选项组合，或 ② 生成 C++ 代码再编译。
2. **参数系统已是声明式的**。`input` 类支持 section.key 查询、默认值、类型转换、多文件依次覆盖。`.par` 天然就是一个"低阶 IR"，可直接作为前端产物的落地格式。
3. **模块-网格单向依赖 + data proxy 耦合**。前端框图中的"连线"在语义上正好映射为**模块间的数据代理依赖**（如 `prx_hyd_t` 引用 multigrid 数据；`chemistry::hydro::base_t` 通过 `weak_ptr<chemistry::base_t> q_che` 耦合化学模块）。
4. **"注册但运行期跳过"是代码库中已有的惯用法**。例如 kh_gas 中 `grav_conv < 0` 即关闭自引力；化学流体模块的组分表 `x_spe` 是在 `read_chem()` 中**运行期**从 par 循环读取构建的 `std::vector`——**组分数本身是运行期量**，0 组分意味着所有组分循环体为空。这为"全功能通用 problem generator"提供了直接的架构依据（见 §4.2）。
5. **构建入口稳定**：`make USRDIR=usr_ext/<prob> ARCH=CUDA|HIP|HIPCPU|MUSA` → `bin/kratos`。这是前端后端唯一需要调用的构建契约。
6. **已有可复用资产**：`usr/extension/`（algo、chem_therm、hydro、phys、radiation 等头文件库）、`visual/`（Python 后处理）、`test/` 与各 `usr_ext/` 算例。

---

## 3. 调研：可类比系统与设计模式

### 3.1 框图/节点式科学计算环境（文献）

| 系统 | 模式 | 对本案的启示 |
|------|------|--------------|
| **SCIRun**（Parker & Johnson 1995；被引 460+） | 数据流可视编程 + computational steering | 科学仿真可视编程的经典范式 |
| **AVS**（Upson et al. 1989；被引 1200+） | 数据流网络搭建可视化应用 | 节点=功能模块、边=数据流的抽象沿用至今 |
| **Simulink / OpenModelica 连接编辑器** | 框图建模 → 代码生成 | "图 → 声明式模型 → 代码"三段式是工程上最成熟的路线 |
| **ComfyUI** 及其智能体化研究（Li et al. 2026） | JSON 工作流 ↔ 节点图双向映射；社区分享工作流 | 证明"节点图 + JSON IR"对非程序员极其友好；工作流可直接作为课程作业分发 |
| 节点式 ODE 建模器（Dos Santos et al. 2025, PLOS ONE） | GUI 节点编辑器 + **模板式代码生成器** | 与本案"框图 → usr.cpp 模板"的路线同构 |

### 3.2 块式编程的教育学证据

- Weintrop & Wilensky（2015/2017/2019；合计被引 1200+）：块式界面显著降低初学者门槛，且**双模态（blocks ↔ 文本代码双向查看）**最有利于学生过渡到真实编程。→ 前端应提供"查看生成的 par / usr.cpp"面板。
- Xu et al.（2019, meta-analysis）确认块式环境对初学者学习成效有正效应。

### 3.3 LLM 辅助仿真配置（2023–2026 前沿）

- **NAMD-Agent**（2025）：LLM 自动完成 MD 模拟搭建、运行与分析；**AUToFLUKA**（2025）：领域知识嵌入的 LLM agent 配置 MC 核工程仿真；**ChronoLLM**（2026）：为仿真代码生成定制 LLM。
- 化工过程模拟 LLM agent 实践与综述（Liang et al. 2026；Du & Yang 2025）指出主要风险是"接口不稳定、幻觉参数"——**缓解办法正是用结构化 schema 约束 LLM 输出**。

### 3.4 开源技术选型

| 组件 | 推荐 | 理由 |
|------|------|------|
| 节点图编辑器 | **React Flow**（或 Vue Flow） | 事实标准；自定义节点/连线/校验完备 |
| IR 校验 | JSON Schema / Pydantic | LLM 输出约束 + 前端校验共用一份 schema |
| 代码生成 | **Jinja2**（模板 + 片段组合） | 模板即"可审计的代码契约"；片段化组合适配模块增删 |
| 后端服务 | Python **FastAPI** | 与 `visual/` 现有 Python 生态一致 |
| 任务编排 | 子进程 + 可选 SSH/Slurm 适配器 | 覆盖本地、服务器、超算三类部署 |

---

## 4. 总体方案

### 4.1 架构总览

```
┌─────────────────────────────────────────────────────────┐
│  前端（浏览器）                                           │
│  React Flow 节点图 + 参数表单 + LLM 对话侧栏              │
│  块库面板 ← 由模块描述符自动生成（非硬编码）                 │
└──────────────┬──────────────────────────────────────────┘
               │  Problem Spec（JSON，唯一 IR）
┌──────────────▼──────────────────────────────────────────┐
│  后端服务（FastAPI）                                      │
│  ├─ Schema 校验（由描述符汇编生成，前后端共享）             │
│  ├─ 编译器 A：Spec → .par        （Track A，零代码）       │
│  ├─ 编译器 B：Spec → usr.cpp     （Track B，Jinja2 片段）  │
│  ├─ 构建/运行编排（make USRDIR=…；本地/SSH/Slurm）         │
│  └─ LLM 网关（结构化输出、错误诊断修复回路）                 │
└──────────────┬──────────────────────────────────────────┘
               │  接口契约（仅此三项，Kratos 本体不动）
┌──────────────▼──────────────────────────────────────────┐
│  Kratos 本体（不改 src/）                                 │
│  ① .par 文件格式   ② usr_ext/ 目录与 make USRDIR 契约     │
│  ③ 一个新增的 usr_ext/universal/ 全功能 problem generator │
│    （唯一新增代码，独立目录）                               │
└──────────────────────────────────────────────────────────┘
```

**解耦关键**：前端系统对 Kratos 的全部依赖收敛为三个契约——par 文件语法、`usr_ext/<dir>/usr.cpp + make USRDIR` 构建约定、universal probgen 的参数词汇表。Kratos 内部如何重构都不影响前端，只要契约不破；而契约变化由描述符版本机制消化（§4.6）。

### 4.2 Track A：全功能通用 problem generator（`usr_ext/universal/`）

Track A 不做"裁剪版"generic probgen，而是做**全功能 universal probgen**：

**设计原则：默认全注册，非启用即跳过。**

- **动力学基座**：默认使用 `chemistry::chem_hydro` / `chemistry::chem_mhd`（带化学/核反应组分的流体、磁流体模块）作为默认流体模块，**默认 0 个化学变量**。代码事实支持此设计：组分表 `x_spe` 在运行期由 par 读取（`read_chem()` 循环 `args.get` 直到键缺失），组分数不是编译期模板参数；0 组分时所有组分循环体为空、平均分子量退化为常数，算术路径与纯流体/MHD 完全一致。
- **其余模块类推**：multigrid 自引力、辐射、粒子等模块全部在 `prob::run()` 中注册（或按 par 中的 `enabled` 键条件注册——注册发生在 host 侧、evolve 之前，先读 par 再条件注册是完全合法的）。未启用的模块在 host 侧调度时直接跳过，**零设备端开销**。"注册但运行期跳过"正是代码库已有惯用法（如 `grav_conv < 0` 关闭自引力）。
- **数值算法选择**：CRTP 组合（Riemann solver × 重造格式 × 积分器）是编译期模板参数，universal probgen 用一个**受控的实例化矩阵**解决：预先实例化一小组精选组合（如 riemann ∈ {hll, hllc, (mhd: hlld)} × reconstruction ∈ {plm, ppm} × integrator ∈ {rk2, rk3}），host 侧工厂按 par 中 `[dynamics] riemann = hllc` 等键**运行期分发**到对应的编译期实例。host 侧虚函数/分支无性能问题（论文的性能警告只针对设备端虚表）。矩阵保持小（≤ 8–12 个组合）以控制编译时间。
- **初值库**：内置可组合的初值原语（均匀介质、层/柱/球/壳、Sod、Sedov、KH、RT、风/注入、扰动叠加……），全部 par 选择；`[prob]` 词汇表从现有 `usr_ext/*` 移植归一化。
- **输出**：前端在 Track A 只生成 `.par`，学生使用**预编译的 universal 二进制**直接运行——零编译、零 C++。

**性能等价性（设计主张 + 验证项）**：universal（0 组分、未启用模块跳过）相对纯 hydro/MHD 二进制的运行时开销应为零或可忽略（host 侧分支 + 空循环）。需一个基准验证项：同一 Sod/KH 算例分别用 `usr_ext` 原生 problem generator 与 universal 运行，逐 kernel 计时对比，要求差异 < 1%。唯一的固有差异是 `chemistry::hydro::block_data_t` 多出的 `T_hyd` 场（仅内存占用，不进 kernel 则无时间开销）；若需消除，可将其改为按启用状态惰性分配——这是一个**可选的、极小的** Kratos 侧优化，不做也不影响正确性。

**Track A 的维护面**：universal probgen 是系统中唯一与 Kratos 耦合的代码 artifact。其内部同样按"一个初值/一个文件、自动发现注册"组织，增补初值或适配模块演进时只动对应小文件。

#### 4.2.1 多实例模块注册（同一模块类型注册多次）

**问题**：名义上同功能的模块可能需要注册两次乃至多次、分别用于不同目的——典型例子：multigrid 实例 ① 求解引力场泊松方程，实例 ② 求解某些组分的隐式扩散方程。

**代码事实（已核实）**：

1. **容器层天然支持多实例**。`mesh_t::enroll_module<T>(i_init, i_step)` 内部是 `mods.push_back(p_mod)`（`std::vector<shared_ptr<mod_base_t>>`），每次调用创建独立实例并返回句柄；调度槽位 `steps`/`inits` 是 `std::map<int, std::function>`，按槽位序号决定 init/演化顺序。无参重载自动递增槽位，显式槽位号则可精确控制执行顺序。
2. **已有完全对口的先例**。`usr_ext/cmz/usr.cpp` 注册了两个 multigrid 模块：`mg_sta_t`（静态背景引力，槽位 0）与 `mg_dyn_t`（动态自引力，槽位 1），再加 hydro（2）、chemistry（3，经 `q->parasite(p)` 寄生于 hydro）、sink（4，`s->p_hyd = p` 直接持有 hydro 实例句柄）。注意该先例的做法是"同一基类、两个派生类"，而非字面上同一个类注册两次。
3. **三个摩擦点**及在 universal probgen 中的解法（均无需改 `src/`）：

| 摩擦点 | 成因 | universal probgen 解法 |
|--------|------|------------------------|
| **par 命名空间冲突** | 模块 `read()` 内硬编码 section 前缀（如 `[multigrid]`），两实例读到同一组键 | 引入**角色作用域 section**：`[multigrid.grav]` / `[multigrid.diff]`。universal 用模板包装类 `role_mod_t<T>` 拦截虚函数 `read(args)`，先把角色 section 的键覆盖合并进基础 section 构造出实例视图，再调 `T::read()`——`input` 类本身支持任意 section 字符串与 `merge()`，包装层在用户侧即可完成 |
| **data proxy 区分实例** | kh_gas 式问题生成器用单个静态 `weak_ptr` 指模块，两实例会互相覆盖 | universal 维护**角色注册表** `std::map<std::string, weak_ptr<mod_base_t>>`：注册时按角色名（`gravity`/`diffusion`…）登记 `enroll_module` 返回的句柄；消费方（如 hydro 的引力源项、化学模块的扩散项）按角色名查表接线。代理**类型**是编译期的（两实例同型），代理**实例**是运行期的（weak_ptr 指向谁），因此运行期角色接线与 CRTP 完全兼容；`parasite()` 寄生语义同理按角色指定宿主 |
| **编译期耦合槽位** | hydro"使用引力"的代码路径在编译期写成访问某个 proxy | universal 预定义一组**命名耦合槽位**（如 `gravity_source`、`species_diffusion`、`radiation_coupling`），每个槽位对应一段已编译的代理访问代码，运行期按角色名把实例接到槽位上。槽位清单写在模块描述符中（`coupling_slots`），框图上的"连线"即"把该实例接入该槽位" |

4. **限制与边界**：
   - 多实例只对**已编译进 universal 二进制**的模块类型有效（Track A 默认全注册，故不构成实际限制）；
   - 同类型多实例共享同一套编译期算法组合（实例化矩阵是全局的）；实例间差异必须落在运行期参数（收敛阈值、迭代次数、平滑次数、系数等）——对"泊松 vs 隐式扩散"这类需求恰好足够；
   - 若两个实例需要**不同的 CRTP 组合**（如不同的通量离散），则退化为 cmz 先例的"两个派生类"做法，属于 Track B 代码生成轨的职责，模板片段按角色实例化两份即可。

**对前端/Spec 的影响**（详见 §4.4、§4.6）：框图上的模块块即**实例**，可多次拖入同一模块类型并赋予角色标签；连线连接到具体实例（及其耦合槽位）；Spec 中 `modules` 从"以模块名为键"改为**实例列表** `{type, role, enabled, params}`；描述符增加 `multi_instance` 与 `coupling_slots` 字段；LLM 的 Schema 约束同样按实例数组生成。

#### 4.2.2 模块容器的声明式选定语法（Track A 的进一步泛化）

**动机**：§4.2 的"默认全注册 + enabled 跳过"仍把"容器里能装什么"固定在 universal 的 C++ 注册代码里。更进一步：把**容器的内容、顺序、耦合关系本身**变成数据驱动——universal 的 `prob::run()` 不再包含任何具体模块名，而是一个解释"容器组合配置"的通用启动器。这本质上是把 cmz 式 `prob::run()` 中的注册代码"反汇编"为声明式语法。

**机制：模块工厂注册表 + 启动时解释。**

```cpp
// universal/prob::run() 的全部逻辑（示意）
mesh.enroll_device<device_t>();  /* comm / io / cycle 同前 */
auto args = read_par(argc, argv);
for (auto & inst : parse_module_sections(args))        // [module.<role>] 段
{
    auto p = factory[inst.type]                        // map<string, factory>
               ( mesh, inst.slot, args );              // 创建+槽位+read
    roles[inst.role] = p;                              // 角色注册表（§4.2.1）
}
wire_coupling(args, roles);   // [coupling] 段：槽位←角色、parasite 关系
mesh.init(args);  mesh.evolve();
```

工厂注册表在编译期填入全部已编译模块类型（每模块一行注册宏，随模块增删），**运行期按 `type` 字符串查表创建实例**——模块选择从编译期决策变为运行期决策，而 CRTP 性能特性不受影响（每个工厂内部仍是编译期特化的具体类型）。

**语法设计（两层）**：表达层在前端 Spec / YAML；落地层编译为 par 的 `[module.*]` 段——C++ 侧**复用现有 `input` 解析器，零新增语法解析器**：

```ini
# ---- 由后端从 Problem Spec 自动生成 ----
[module.gravity]               # 实例段：role = gravity
type     = multigrid           # 保留键：类型（须在工厂表中）
slot     = 0                   # 保留键：调度槽位（可选，默认按声明顺序）
enabled  = 1
equation = poisson             # 其余键 → 角色作用域，等价 [multigrid.gravity]
n_iter   = 100

[module.diffusion]
type     = multigrid
equation = implicit_diffusion
dtol     = 1e-8

[module.fluid]
type     = chem_mhd
riemann  = hlld

[module.chem]
type     = chemistry
parasite = fluid               # 保留键：寄生宿主（对应 q->parasite(p)）

[coupling]                     # 耦合段：消费方的命名槽位 ← 提供者角色
fluid.gravity_source      = gravity
fluid.species_diffusion   = diffusion
```

**语法规则（形式化语义）**：

1. **实例段** `[module.<role>]`：`role` 全局唯一；`type` 必须存在于工厂注册表（由描述符集决定合法值）；
2. **槽位推断**：显式 `slot` 优先；缺省按段出现顺序递增；槽位冲突报错（对应 `map<int, function>` 的覆盖语义，冲突即静默丢失，必须前端拦截）；
3. **参数作用域映射**：实例段内除保留键（`type/slot/enabled/parasite`）外的键，等价于写入 `[<type>.<role>]` 角色作用域 section，缺省回退 `[<type>]` 基础 section（§4.2.1 的 `role_mod_t` 包装在此统一实现）；
4. **耦合段**：左值 = `<消费实例role>.<耦合槽位>`，槽位名须在消费方描述符的 `coupling_slots` 中；右值 = 提供方实例 `role`；`parasite` 表达寄生语义（对应 cmz 的 chemistry→hydro）；
5. **条件包含**：`enabled = 0` 时**不创建实例**（比"创建但跳过"更彻底），同时模块内部的运行期开关语义保留不变。

**校验全部前置到描述符层**（不依赖运行失败才发现）：type 合法性、role 唯一性、槽位冲突、耦合槽位存在性、依赖闭包（被引用的实例必须存在且 enabled）、`multi_instance: false` 的类型只出现一次。

**表达力验收标准**：现有 `usr_ext/cmz/usr.cpp` 的 `prob::run()` 能用该语法**无损表达**（两个 multigrid + hydro + 寄生 chemistry + sink 接线）——这同时成为 M1 的验收项之一。同类先例：OpenFOAM 的 run-time selection table（字典配置 + 工厂注册表，是 C++ CFD 中运行期容器组合的成熟实践）。**注**：Athena++ 并非此例——它在 configure 时选定单一 pgen 编译进二进制；Kratos 的 pgen 机制刻意对齐 Athena++ 以方便用户迁移，而本方案恰好是在 pgen 机制之上叠加一层运行期组合，与 pgen 使用习惯兼容而非冲突。

**与 Track B 的边界**：该语法只表达"容器组合与接线"，不表达新物理；语法中 `type` 的合法集合 = universal 二进制中已编译的模块 = 描述符集，三者由 `make bindings` 保持一致。

#### 4.2.3 初始条件生成机制（三通道设计）

**用户三选项的统一架构**：(1) 常见均匀场（流体变量、磁矢势等）；(2) 由 `visual/binary_io.py` 生成的二进制文件读入；(3) 参数文件中的函数字符串表达式（常数是其特例）。三者在 universal pgen 内部统一为一条**分层叠加的初始化流水线**：

```
二进制基底（可选） → 表达式区域层（按序叠加） → 扰动层（可选）
```

par 中的形态（示例）：

```ini
[ic]
base  = file:ic_bin.dat        # 可选：二进制基底（通道 2）
[ic.region.0]                  # 表达式区域，按编号顺序叠加（通道 3，常数即通道 1）
when   = x < 0                 # 可选谓词；缺省 = 全域
rho    = 1.0
p      = 1.0 / gamma_          # gamma_ 为内建常量（来自 [dynamics]）
a_z    = B0_ * x               # 磁矢势（见下"磁场特殊处理"）
[ic.region.1]
when   = else
rho    = 0.125
[ic.perturb]                   # 可选扰动层
vx     = pert_amp_ * sin( 8 * pi_ * y )
```

**通道 3 的核心机制：运行期表达式编译 + 设备端微型栈式虚拟机（C++ 无反射机制，此为等价能力的合理实现）。**

C++ 确无反射，但此处需要的并非真正的反射——只是把"字符串形式的点态函数 f(x,y,z) → 场值"搬进 kernel。合理实现是**自带一个微型表达式编译器**（tokenizer + 递归下降 parser + 字节码生成，host 侧约 300–400 行）与一个**设备端栈式 VM**（约 100 行），全程纯 C++17 标量浮点运算，**零第三方依赖**，CUDA/HIP/HIP-CPU 通吃：

1. **编译时机**：模块 `read()` 阶段在 host 把每个表达式编译为字节码序列（操作码 + 常数池索引），拷贝进设备内存；
2. **执行**：`init_cond` kernel 中逐 cell 调用 VM（入参 = 坐标与上下文常量，出参 = 场值）。VM 开销相对原生代码约 10–50 倍，但初始化只执行一次（512³ × 数十操作 ≈ 亚秒级），可忽略；
3. **语法**（允许定制语法，因此以工程稳健性优先设计）：中缀表达式、标准优先级；内建变量 `x y z r_cyl r_sph t`（代码单位）与内建常量 `pi_`、`gamma_`、`B0_` 之类以下划线结尾的"参数引用"（指向 par 中其他键，便于前端/LLM 生成时保持符号化）；白名单函数 `exp log sqrt sin cos tanh cosh abs min max clamp step smoothstep`（映射到代码库已有的 `__exp1` 等快速设备函数）；比较与布尔运算、三元 `?:`；
4. **错误策略**：host 编译期对未知标识符/语法错误给出带定位的明确报错（LLM 修复回路友好）；运行期出现非有限结果时按块原子计数，IC 结束后 root 汇总报错中止，绝不让 NaN 静默进入演化；
5. **AMR 兼容**：字节码常驻设备内存，`init_cond` 对任何时刻创建的块（包括演化中细化的块）可用同一语义，这是"host 侧预计算填满网格再上传"方案做不到的，也是选择设备端 VM 而非 host 求值的决定性理由；
6. **LHS 词汇表**（`rho`、`vx vy vz`、`p` 或 `e`、`a_x a_y a_z`、`trc_*`、`spe_*`……）由启用模块的描述符声明，`make bindings` 时注入 Schema——前端表单与 LLM 的可填字段自动与模块集合同步。

**磁场特殊处理**：表达式只定义**磁矢势** `a_x a_y a_z`，universal pgen 在设备端以交错网格差分取 `B = ∇×A`——从机制上保证 ∇·B = 0（含通道 1 的均匀磁场：`a_z = B0_*x` 之类预设）。通道 2 的二进制若直接给 B，则在读取后做一次散度检查并告警。

**通道 2（二进制基底）**：直接复用 Kratos 自有的 binary_io 格式（首字节声明端序与 size_t 宽度，随后是 命名数据集→数组 的键值映射；`visual/binary_io.py` 已具备完整读写能力）。规则：v1 要求数组维度/次序与基础网格严格一致（错误即明确报错）；v2 可再加最近邻/线性重采样以支持分辨率不匹配。一个自然的延伸是**直接接受 Kratos 输出文件作为 IC**——restart/分支算例（"从 t=5 的快照改参数继续跑"）由此免费获得。MPI 构建下走 `binary_io::mpi_t` 并行读。

**通道 1（均匀场）**：不做独立实现，作为通道 3 的退化形式（常数表达式）+ 前端预设（均匀密度/压强/速度/均匀矢势），UI 上是独立选项，机制上零新增代码。

**与原生 IC 库的分工**：需要 host 预计算（平衡曲线求根、ODE 积分建表、查冷却表等）的复杂 IC 保留为原生编译组件（§4.2 初值库）；表达式机制覆盖一切**点态可写**的场——两者并集之外才真正落入 Track B。

**LLM 契合点**：表达式 DSL 是 LLM structured output 的理想目标——白名单 + host 编译期校验使幻觉在生成 par 的瞬间即被拒绝并带定位报错，可进修复回路。

#### 4.2.4 组分浓度与边界条件的表达式赋值

**（a）化学/核反应组分初始化：按粒子数分数的字典赋值。**

- **语法**：Spec 层为天然字典 `x: {h: 0.9, he: 0.1, …}`；编译到 par 层为点分键 `x.h = 0.9`、`x.c12 = …`。值**同样是完整表达式**——组分可以是位置的函数（如电离度梯度、核燃烧产物的球对称分布），这是"字典"相对固定表格的关键优势。
- **合法性校验**：物种名必须在化学/核反应模块描述符声明的物种表中（`make bindings` 注入 Schema，未知物种名在前端/编译期即报错）；未列出的物种隐含为 0。
- **归一化策略**：数分数物理上须满足 Σxᵢ = 1（kratos 现有 `read_chem` 已做归一化）。universal pgen 在每个网格点求值后自动归一化并**按块汇总报告**实际偏离度（便于发现表达式写错）；同时提供 `x_strict = 1` 选项改为"不归一化、Σxᵢ≠1 即报错"的严格模式，供调试使用。
- **平均分子量**等派生量完全复用化学模块既有代码路径，不产生第二套语义。

**（b）表达式边界条件（以内流边界为典型）。**

- **机制可行性（已核实）**：kratos 的物理边界是逐面的仿函数（`phys_base_t` 的 CRTP 派生，`__device__` 填充 ghost 层），由 `boundary::keeper_t::holder_phys` 按名字注册——`free_t / outflow_t / reflect_t` 等内建边界即此模式。因此 universal pgen 可在用户层新增一个 `expr_inflow_t` 仿函数：持有设备端 VM 字节码指针，每次边界更新时在 ghost cell 坐标上求值。**不改 `src/`**。
- **par 形态**：

```ini
[bc.x_lo]
type = expr_inflow         # 表达式内流；缺省字段语义见下
rho  = 1.0
vx   = v_inj_ * ( 1 + 0.1 * sin( 2 * pi_ * t / t_per_ ) )   # t 可用：时间相关内流
x.h  = 0.9                  # 组分字典与 IC 完全同构
x.he = 0.1
```

- **与 IC 引擎统一**：BC 与 IC 共用同一表达式编译器/VM（统称 universal pgen 的**表达式引擎**组件），上下文变量为 `x y z r_cyl r_sph` **加 `t`**（IC 时 t=0）及面标识；组分字典赋值语义逐点一致——内流注入的丰度与初始场用同一套写法。
- **缺省字段语义**：未在 `[bc.<face>]` 中赋值的字段默认"零梯度拷贝自内域"（等价对该字段施加 outflow 行为），也可显式写 `p = *`；这样部分指定（只给定 rho 与 vx 的内流）不会留下未定义行为。
- **校验**：面名限于 `x_lo/x_hi/y_lo/y_hi/z_lo/z_hi` 中与几何一致的六个；表达式边界不得施加于周期面对（前端与编译器双重拦截）；每步在 ghost 面上执行 VM，开销为 O（面积 × 表达式长度），相对体更新可忽略，但需在设计文档中注明"表达式边界是每步执行的"，与 IC 的一次性语义不同。
- **边界**：只覆盖"值可写成 (x,y,z,t) 点态函数"的边界（绝大多数内流/注入/风场景）；与内部物理过程耦合反馈的边界（如依赖出流积分的回流）仍属 Track B。

**前端与 Schema**：启用化学/核反应模块时，组分赋值控件自动从描述符的物种表生成字典编辑器（键受限、值可表达式）；边界块按六个面呈现，`type` 下拉含 `expr_inflow`，选中后展开与 IC 相同的表达式编辑器。两者均随模块演进自动同步。

#### 4.2.5 跨模块数据访问：构建期生成的联合 proxy

**问题**：universal pgen 原则上应让各模块都能访问其他模块经 proxy 提供的数据（proxy 模式的本意），但需要优雅的实现——"全局 proxy"与"字典查找"两条显而易见的路线各有疑虑。

**先澄清性能疑虑（字典查找无妨）**：proxy 的浅拷贝本来就发生在 host 侧、每次 GPU job 启动前（论文图 2 的机制）。`std::map` 按角色查找实例指针是 O(log n) 纳秒–微秒级操作，而单次 kernel launch 本身约 5–10 μs——查找开销完全淹没在启动开销中。**真正的难点不在运行效率，而在编译期类型**：设备端 kernel 访问组合结构体的字段是编译期决议的，"任意模块访问任意模块数据"不可能是完全运行期动态的类型。

**解法：两级分离——构建期生成联合视图类型，运行期只做指针接线。**

1. **编译期：联合视图（union view）自动生成**。每个模块家族注册两样东西：其 `block_data_t` 类型 + 一个浅拷贝函数 `view(block_base&) -> view_t`（现有 `prx_base_t::d_hyd(reg)` 等即此物，只是从静态函数改为注册项）。`make bindings` 依据描述符集**生成** `univ_proxy.gen.h`：以变参继承把所有已注册视图组合成单一 `univ_view_t`。**"全局 proxy 不可行"仅对运行期 any 类型成立**；universal 的模块集合在构建期是固定的，因此联合类型可以、也应当由代码生成器自动产出——新增模块 = 描述符加一行 + 重新生成该头文件，无手工组合代码。
2. **运行期：角色→槽位指针接线**。`univ_view_t` 按**命名耦合槽位**（§4.2.1 的 `gravity_source`、`species_diffusion`……）持有提供者实例的数据指针；init 期由 `[coupling]` 配置经角色注册表解析后填入。所有 `std::map` 查找与 `dynamic_cast`（现有代码本就在 host 侧做）都发生在这一阶段。未接线的槽位为空指针。
3. **完整性校验前置到 init**：各模块描述符声明其启用代码路径需要哪些槽位；universal 在 init 期（host）校验接线完备性，缺失即明确报错——kernel 内不做逐 cell 空指针分支，最多随结构体按值传入一个有效性位掩码。

**开销核算**：相比手写 pgen，仅多出 host 侧的若干次 map 查找与略大的浅拷贝结构体（数十个指针、数百字节）——均为 launch 主导场景下的可忽略项；设备端与手写 proxy 完全一致（kernel 按值接收结构体，未用成员不进寄存器压力）。

**注册次数不固定时的类型稳定性（关键细化）**：联合视图的成员若"按模块类型"组织，多实例会造成歧义，需区分两种情形：

- **情形 A：模块自身的 job 访问自身实例的数据**——不构成问题。浅拷贝是每次 job 启动前现组装的（论文图 2 的机制）：结构体**类型**不变，实例 #2 的 step 发起 launch 时往同一视图成员中填入实例 #2 的指针即可。**实例多寡是"值"层面的事，不是"类型"层面的事。**
- **情形 B：单次 kernel 需同时看到同类型的多个实例**（如 hydro 源项同时需要 mg-引力势场与 mg-扩散场）。解法是槽位**按耦合语义命名而非按类型命名**（即 §4.2.1 的耦合槽位设计）：`gravity_source` 槽与 `species_diffusion` 槽各持一份同型的 mg 视图，编译期类型完全确定。对"同质集合消费"的 kernel（叠加任意多个引力源），槽位进一步泛化为**小数组 + 运行期计数**：`mg_view_t mg_slots[MAX]; uint8 n_mg;`，kernel 按 `n_mg` 循环累加——**实例个数由此也变为运行期量**，唯一的编译期常数是同类槽位容量上限 `MAX`（生成头文件中的可配置值，默认如 4；接线时超容量即明确报错，需要更大容量则改值重新生成头文件）。
- **真正的边界**：kernel 语义以非集合方式依赖实例个数（每个实例走不同代码路径）属物理语义问题，归 Track B。

槽位的"单槽 / 集合"属性与容量上限写入模块描述符（`coupling_slots` 条目扩展为 `{name, view, collection: false, max: 4}`），由 `make bindings` 统一生成——槽位词汇表随模块演进自动更新，而 kernel 代码只面向稳定的槽位名编程。

**与描述符体系的协同**：联合视图的头文件、槽位词汇表、`requires` 校验规则全部由 `make bindings` 从描述符生成——"哪些模块能互相看见数据"成为数据而非代码，随模块演进而自动更新。

### 4.3 Track B：代码生成轨（仅面向真正的新物理）

Track A 的全功能化使 Track B 的范围收窄为：**universal 初值库之外的初值泛函形式、新源项、新示踪剂行为**等真正需要新设备代码的场景。

1. 框图 → **Problem Spec**（JSON），自定义函数以**表达式节点**表示（如 `rho(z) = rho0 / cosh((z-z0)/H)^(2/(γ-1))`，限制为白名单数学函数、无副作用的表达式子集）。
2. 后端用 **Jinja2 模板**渲染 `usr.cpp`：模板由**逐模块片段（partials）** 组合而成，片段与模块描述符一一对应（§4.6）——模块增删时只增删片段，不动主模板。
3. 生成代码在**沙箱容器**中编译；失败时错误日志连同模板上下文送 LLM **自动修复回路**（限次重试），对学生只呈现解释后的错误。
4. 生成产物（Spec + usr.cpp + par）完整保存，支持"导出为原生 problem generator 项目"——框图是通向真实代码的桥梁（双模态，有教育学文献支持）。

### 4.4 Problem Spec：系统的唯一中间表示

无论哪条轨，框图的唯一序列化形式是 Problem Spec（JSON/YAML），建议顶层结构：

```yaml
spec_version: "1"
kratos_version: ">=2025.04"        # 与描述符集版本协商（见 §4.6）
problem: { name: kh_slab, description: … }
units:   { length: 3.086e18, time: 3.156e13, density: mp }
mesh:    { geometry: cartesian, x_min: [-1,-0.25,-4], x_max: [1,0.25,4],
           n_cell_global: [256,64,512] }
modules:                              # 框图中的模块块 = 实例列表（同类型可多实例）
  - { type: chem_mhd, role: fluid, enabled: true,
      eos: {type: adiabatic, gamma: 1.6667},
      riemann: hlld, reconstruction: plm, integrator: rk2,
      species: [] }                    # 空 = 0 化学变量，纯 MHD 效率
  - { type: multigrid, role: gravity, enabled: true,
      equation: poisson, n_iter: 100, dtol: 1e-6 }       # → [multigrid.gravity]
  - { type: multigrid, role: diffusion, enabled: true,
      equation: implicit_diffusion, n_iter: 50, dtol: 1e-8 } # → [multigrid.diffusion]
  - { type: cooling, role: cooling, enabled: true,
      table: cool.dat, heat0_cgs: 2.0e-26, z: 1.0 }
coupling:                             # 边 = data proxy / parasite，指向具体实例的角色
  - { from: gravity,   to: fluid, slot: gravity_source }
  - { from: diffusion, to: fluid, slot: species_diffusion }
boundary: { kinds: [per,per,per,per,out,out] }
initial_conditions:
  - { type: slab, axis: z, z0: 0, rho0_amu: 100, rho_ambient_amu: 1, T0: 50 }
  - { type: perturbation, modes: 32, amplitude: 0.05, seed: 42 }
cycle:   { t_lim: 20, cfl: 0.3, dt_output: 0.2, prefix_output: slab_eq }
custom_code: []                       # Track B 专有：表达式节点
```

- 图块 ↔ Spec 字段一一对应，连线 = `modules` 共存关系 + `coupling` 数据依赖，天然映射 Kratos 的模块容器/代理语义。
- **Spec 的 schema 不手写**——由模块描述符汇编生成（§4.6），这是可维护性的核心。

### 4.5 工程文件、跨设备迁移与预览器

#### 4.5.1 工程文件格式：JSON 清单 + 目录制工程（不建议 XML）

**结论：不使用 XML。** 理由：

1. **避免第二套数据模型**。全系统的 IR（Problem Spec）、校验（JSON Schema）、LLM structured output、前端表单生成已经全部长在 JSON/YAML 生态上；引入 XML 意味着再维护一套解析器与 schema 语言（XSD），且两者语义需人工保持同步——这正是"库引入风险小但架构成本大"的情形。
2. **agent/harness 友好性**。JSON 键值结构是 LLM 最熟悉、token 效率最高的格式，且可直接用 JSON Schema 约束解码；XML 的混合内容/命名空间/XSLT 优势在本场景完全用不上。
3. **教学场景的可维护性**。学生的工程应能进 git——JSON/YAML 的逐行 diff 友好，XML 冗长标签使 diff 噪音大。
4. **解析成本**：JS 原生、Python 标准库、C++ 侧如确需读取也有单头文件方案（甚至可直接复用 kratos 自己的 `input`）——全程无第三方库问题。

**形态：工程 = 目录 + 清单，而非单一文件**（因为工程包含二进制资产：冷却表、IC 二进制、输出快照）。清单 `kratos.project.json` 建议字段：

```json
{
  "format_version": "1",
  "spec": { "…": "内联 Problem Spec，或引用 spec.yaml" },
  "environment": { "kratos_version": ">=2025.04",
                   "descriptor_set": "v0.3+git:abc123",
                   "arch": "HIPCPU", "mpi": false },
  "provenance": { "created_by": "…", "created_at": "…",
                  "parent": null, "history": [] },
  "assets": [ { "path": "cool.dat", "sha256": "…",
                "role": "cooling_table", "required": true },
              { "path": "ic_bin.dat", "sha256": "…",
                "role": "ic_base", "required": false,
                "regenerable_from": "spec.initial_conditions" } ],
  "runs": [ { "par_snapshot": "run/001.par", "outputs": [],
              "target": "local", "finished_at": "…" } ]
}
```

面向 agent/harness 的设计原则：**自描述**（内嵌 `$schema` 指针）、**键名稳定**（变更只增不改）、**派生物可再生**（par 等由 Spec 重新生成，清单只存快照用于比对）、**资产带校验和**。这样一个 AI agent 拿到工程目录即可完整理解问题界定、复现输入、接续二次开发。

#### 4.5.2 跨设备迁移：bundle 打包与"变尺度"覆写

- **打包格式**：`tar.gz` bundle = 工程目录原样打包（清单 + Spec + par 快照 + 资产 + Track B 生成代码 + 作业脚本模板）。zip 亦可，tar.gz 与 Linux 集群生态更顺。
- **目标端流程**：导入 → 按目标机的描述符集做版本协商与校验 → **从 Spec 重新生成 par**（Spec 是唯一权威，par 快照仅用于 diff 确认一致）→ 资产 sha256 校验 → 构建/运行。
- **变尺度迁移（本地小测 → 服务器大算）**：清单声明"迁移时可覆写参数"白名单（典型为 `n_cell_global`、`x_min/x_max`、`t_lim`、`n_cycle_lim`），覆写以 JSON Merge Patch 表达并在导入 UI 中呈现为显式选项（如"分辨率 ×2"）；其余参数默认锁定，防止无声改动物理。
- **大资产策略**：`required` 资产（观测数据、冷却表）必须随包；`regenerable` 资产（由表达式可再生的 IC 基底）可不随包、在目标端重建，控制包体积。
- **集群落地**：后端按模板生成 Slurm/PBS 作业脚本；传输走 rsync/SSH 适配器；或 bundle 自含 `run.sh` 由学生手动提交。

#### 4.5.3 初始条件与内流边界预览器（2D 截面、零重型依赖）

设计原则：避免三维渲染与重型库依赖、规避库缺失与性能受限风险——

1. **渲染技术栈：Canvas 2D 光栅热力图**，不用 WebGL/three.js/VTK——切片就是一张二维标量图，`ImageData` 直写像素即可，任意现代浏览器零依赖；色标用几行插值代码；矢量场叠加箭头（quiver）或 SVG 流线，AMR 块边界以 SVG 线条叠加。全部无重型库。
2. **求值位置：前端 Web Worker**。表达式 DSL 在 JS 中复刻一份求值器（tokenizer+parser+求值约 200 行），在用户选定截面（轴 + 位置 + 面内范围 + 分辨率 256²/512²）上异步求值，不卡 UI；预览管线与运行时一致：二进制基底切片（后端用 `visual/binary_io.py` 抽取返回）→ 区域按序叠加 → 扰动层。
3. **语义漂移防护（工程上最关键的一条）**：表达式文法定义为**一份数据文件**，C++ VM、JS 求值器、Python 校验器三个实现共享一组 **golden 测试向量**（固定表达式 × 固定坐标 → 期望值，CI 中容差比对）。这样"预览看到的"与"kratos 算到的"不会在实现演进中悄悄分叉；UI 上仍注明预览为指示性。
4. **内流边界预览器**：复用同一截面机制——边界即"面内二维切片 + `t` 滑块"；时间相关内流可拖动 t 或逐帧播放，直接看到注入剖面随时间变化；组分以数分数字典逐物种切换显示。
5. **单位切换**：预览轴与色标可在代码单位 / CGS 间切换（清单中 `[unit]` 换算因子本就齐备），帮助学生建立物理尺度直觉。

### 4.6 描述符驱动：适配模块快速演进的可维护架构

Kratos 模块在快速增补中，因此前端系统的每一处"认识某个模块"的地方都必须从**同一份声明式描述**派生，禁止各自硬编码：

**（a）模块描述符（Module Descriptor）——唯一事实源。** 每个模块一个 YAML（存放于前端系统的 registry 仓库，与 Kratos 仓库分离）：

```yaml
# descriptors/chem_mhd.yaml
module: chem_mhd
label: 磁流体（可带化学/核反应组分）
kratos_versions: [">=2025.04"]
category: dynamics
multi_instance: false                 # 动力学基座唯一
provides: [mhd_fields]                # 数据代理：我能给别人什么
requires: []                          # 我依赖谁（连线合法性校验的依据）
coupling_slots:                       # 可被接入的命名耦合槽位（§4.2.5）
  - { name: gravity_source,    view: potential_field, collection: false }
  - { name: species_diffusion, view: potential_field, collection: false }
enable_key: enabled
parameters:                           # 直接对应 par 词汇表
  - { key: dynamics.gamma,  type: float, default: 1.6667, doc: 绝热指数 }
  - { key: dynamics.riemann, type: enum, values: [hll, hllc, hlld], default: hlld }
  - { key: chemistry.species, type: list, default: [], doc: 组分与丰度；空=纯MHD }
ic_hooks: [uniform, slab, sphere, kh, rt, sedov, perturbation, wind]
track_b_template: templates/chem_mhd/*.j2   # 代码生成片段（可选）
---
# descriptors/multigrid.yaml
module: multigrid
label: 多重网格求解器
kratos_versions: [">=2025.04"]
category: solver
multi_instance: true                  # 允许同类型多实例（泊松/隐式扩散/…）
role_namespace: "multigrid.{role}"    # 实例的角色作用域 par section
provides: [potential_field]
requires: []
parameters:
  - { key: n_iter, type: int, default: 100, doc: 最大迭代次数 }
  - { key: dtol,   type: float, default: 1.0e-6, doc: 残差收敛阈值 }
  - { key: equation, type: enum, values: [poisson, implicit_diffusion],
      default: poisson, doc: 该实例求解的方程类型 }
```

**（b）一次编写、四处生成。** 一个 `make bindings` 步骤从描述符集生成：
1. **JSON Schema**（Problem Spec 校验；同时约束 LLM structured output）；
2. **前端块库与表单配置**（React Flow 面板、参数表单、连线合法性规则 = provides/requires 匹配）——前端代码里没有任何模块名硬编码；
3. **Spec→par 编译器的键映射表**；
4. **文档**（参数手册、教学模板注释）。

**（c）增删改一个模块的成本**：新增 = 加一个描述符（+ 可选 Track B 模板片段）+ universal probgen 中对应注册行；修改参数 = 改描述符条目；删除 = 移除描述符。前端、校验、编译器、文档**零改动**。

**（d）版本协商与回归防护**：
- 描述符声明 `kratos_versions` 兼容范围；后端按学生所用 Kratos 版本加载对应描述符集，新旧版本学生可同时受支持；
- CI 黄金测试：每个教学模板的 Spec→par 产物做逐键字节对比；Track B 模板对 Kratos HEAD 做编译冒烟测试（nightly），契约被破坏时自动报警并定位到具体描述符条目。

### 4.7 前端界面设计

- **块库面板**：由描述符自动生成，按类别分组（动力学 / 重力 / 化学 / 辐射 / 粒子 / 边界 / 初值 / 输出）；Kratos 加了新模块，描述符入库后面板自动出现新块。
- **画布**：React Flow；模块块连线表示数据耦合（provides/requires 校验，连错即时报）；选中块右侧出现由描述符生成的参数表单，带单位提示（`_cgs` 语义）与物理量纲检查。
- **模块默认启用状态**：`enabled` 开关直接呈现在块上，对应 universal probgen 的"注册但跳过"语义，学生能直观看到"加了一个模块但没开"与"没加"的区别。
- **多实例块**：`multi_instance: true` 的模块（如 multigrid）可多次拖入画布，每个实例块必须命名角色标签（`gravity`、`diffusion`…），连线接到具体实例的具体耦合槽位；表单顶部显示该实例的角色作用域 section（如 `[multigrid.gravity]`），与双模态视图中的 par 一一对应。
- **模板画廊**：内置 Sod、KH、Sedov、slab 等教学算例（从现有 `usr_ext/*` 与 `test/` 移植），一键载入。
- **双模态视图**：底部面板实时显示生成的 `.par`（Track A）或 `usr.cpp` 差异高亮（Track B）。
- **运行面板**：选择运行目标（本地 HIP-CPU / 服务器 CUDA / 集群），日志流与进度，输出直达 `visual/` 后处理。

### 4.8 LLM 与 Agent 接口（后端可插拔）

LLM 不作为必需依赖，作为三项增强：

1. **自然语言 → Spec 草稿**：学生描述需求，LLM 以 **structured output（由描述符汇编的 JSON Schema 约束解码）** 产出 Spec 草稿落到画布上可继续手动编辑——框图是 LLM 输出的"可检查、可修正"载体；模块集合变化时约束 schema 自动随之更新，LLM 永远不会"幻觉出不存在的模块"。
2. **编译/运行错误诊断**：错误日志 → LLM 解释成因与修复建议；Track B 下可自动修补表达式节点（限 2–3 次重试，全程留痕）。
3. **参数顾问**：RAG over 方法论文 + 描述符文档 + 算例库，回答参数合理性类问题。

工程要点：LLM 网关独立于核心业务（环境变量配置 endpoint/key，任意 OpenAI 兼容接口）；所有 LLM 输出必须过 Schema 校验后才写入系统；无 key 时系统功能完整可用。

**面向未来 agent/harness 的编程接口（与 LLM 增强解耦，属基础设施）**：

1. **REST + OpenAPI 作为唯一程序化入口**：后端全部能力以 REST 暴露——描述符注册表查询、Spec 校验（dry-run）、编译（Spec→par）、构建、运行、状态/日志、预览切片、bundle 导入导出、工程 CRUD。FastAPI 自动产出 OpenAPI 文档，agent 可**机器发现**全部工具；API 版本化（`/v1`），键名只增不改。
2. **CLI 镜像**：`kratos-fe validate / compile / build / run / preview / bundle …` 与 REST 一一对应——沙箱中的 agent 往往更适合 CLI；两者共用同一核心库，杜绝行为分叉。
3. **机器可读的 grounding 语料**：描述符注册表本身经 endpoint 暴露（agent 查询"当前有哪些模块/参数/合法值"）；registry 仓库附带一组**经校验的示例 Spec cookbook**（few-shot 语料，随版本演进）。
4. **结构化错误**：一切错误带错误码、JSON 上下文、源码定位（par 键 / 表达式字符区间）与 machine-actionable 提示——为自动修复回路设计，而非仅为人阅读。
5. **确定性与幂等**：同一 Spec 编译出的 par 字节稳定（agent 可自行验证复现性）；构建/运行以 job handle 幂等追踪。
6. **审计与安全**：agent 的每次操作写入工程清单的 `provenance.history`（§4.5.1）；Track B 构建一律沙箱化；任何外部输入先过 Schema 校验门，LLM/agent 输出永不直接触碰 kratos。
7. **未来适配层**：需要时可在 REST 之上包一层 MCP server（薄适配，无核心改动），使各类 agent 框架以原生工具调用接入；核心保持 REST/CLI 优先，不绑定特定 agent 生态。

### 4.9 部署形态

| 场景 | 形态 |
|------|------|
| 学生个人电脑（无 GPU） | Docker 一体化镜像（前端 + 后端 + HIP-CPU 预编译 universal 二进制），浏览器打开即用 |
| 课题组服务器 | docker-compose；后端经 SSH 构建/运行 |
| 超算 | 后端生成 Spec/par/usr.cpp + Slurm 脚本，学生提交；或 SSH 适配器代提交 |

---

## 5. 路线图（建议按里程碑交付）

| 里程碑 | 内容 | 验收标准 |
|--------|------|----------|
| **M0 契约与描述符固化**（2–3 周） | 盘点 `usr_ext/*` par 词汇表；定义模块描述符格式并覆盖现有模块；`make bindings` 生成 Schema/键映射；Spec→par 编译器 CLI | 现有 ≥3 个算例的 par 可由 Spec 重新生成且逐键一致 |
| **M1 universal probgen + 表单 UI**（4–5 周） | 实现 `usr_ext/universal/`（chem_hydro/chem_mhd 基座、模块工厂注册表与容器选定语法、角色注册表与耦合接线、联合 proxy 视图生成、算法实例化矩阵、表达式引擎与三通道 IC、表达式内流边界、初值库首批 6–8 个）；**性能等价基准**；表单式前端先跑通全流程 | 学生不写代码跑通 Sod + KH；universal vs 原生 probgen 计时差 < 1%；cmz 的 `prob::run()` 可由容器选定语法无损表达；表达式 IC/BC 与组分数分数赋值通过单元测试（含归一化报告与严格模式） |
| **M2 框图编辑器与工程化**（4–6 周） | React Flow 节点图（块库由描述符驱动）、连线校验、模板画廊、双模态 par 视图；工程文件格式与 bundle 打包/导入；IC/BC 截面预览器（Canvas 2D + 共享 golden 向量） | 框图 ↔ Spec 双向无损；新增一个演示模块只加描述符即上面板；bundle 在第二台机器导入后位级复现 par |
| **M3 Track B 代码生成**（4–6 周） | 逐模块 Jinja2 片段 + 组合器、表达式节点、沙箱构建、LLM 修复回路 | 自定义密度轮廓算例从框图到出图全通 |
| **M4 LLM/Agent 与部署打磨**（3–4 周） | NL→Spec、错误诊断、RAG 参数顾问；REST/OpenAPI + CLI 程序化接口固化（结构化错误、幂等、审计）；Docker 镜像与文档 | 无 GPU 学生 30 分钟从镜像到第一个模拟；外部 agent 经 CLI 独立完成"校验→编译→运行→取回结果"闭环 |

每个里程碑结束都是可用产品；风险最高的 Track B 推迟到 M3 且不影响主线。

## 6. 风险与缓解

| 风险 | 缓解 |
|------|------|
| Kratos 演进破坏契约 | 契约仅 par 语法 + USRDIR 约定 + 描述符声明的参数词汇；描述符带版本范围；CI 黄金测试 + Track B 编译冒烟测试（nightly 对 HEAD）自动报警定位 |
| universal probgen 性能不等价 | 设计依据是运行期组分数与 host 侧跳过（§4.2）；M1 设硬性基准验收（< 1%）；不达标项（如 `T_hyd` 惰性分配）作为极小的 Kratos 侧可选优化跟进 |
| 算法实例化矩阵膨胀编译时间 | 矩阵受控（≤ 8–12 组合）；冷门组合保留给 Track B；矩阵本身是描述符数据而非代码 |
| 生成 C++ 编译错误暴露给学生 | 沙箱构建 + LLM 修复回路 + 错误翻译；表达式节点限白名单数学函数 |
| LLM 幻觉参数/模块 | structured output 的 schema 由描述符汇编生成，不存在的模块/键在解码层即被拒绝；LLM 全程可选 |
| 预览与运行语义漂移 | 表达式文法即数据，C++/JS/Python 三实现共享 golden 测试向量，CI 容差比对；UI 注明预览为指示性 |
| 框图过度简化物理理解 | 双模态视图 + 导出原生 problem generator；课程按"框图 → 读生成代码 → 改代码"进阶 |
| 描述符与 Kratos 实际参数漂移 | 描述符条目附带"溯源指针"（对应源码中 `args.get` 的位置）；提供静态扫描脚本比对描述符与源码中的 par 键，漂移即报警 |

## 7. 参考文献与调研来源

1. Wang, L. 2025, ApJS, 277, 63（Kratos 方法论文；§2.4 编译期多态设计）
2. Parker, S. G. & Johnson, C. R. 1995, ACM/IEEE Supercomputing（SCIRun）
3. Upson, C. et al. 1989, IEEE CG&A（AVS）
4. Dos Santos, B. L. M. et al. 2025, PLOS ONE（节点编辑器 + 模板代码生成）
5. Li, Z. et al. 2026（ComfyUI 节点工作流的智能体生成）
6. Weintrop, D. & Wilensky, U. 2015/2017/2019（块式 vs 文本编程双模态研究）
7. Xu, Z. et al. 2019（块式编程环境 meta-analysis）
8. Chandrasekhar, A. & Farimani, A. B. 2025, arXiv:2507.07887（NAMD-Agent）
9. Ndum, Z. N. et al. 2025, Energy and AI（AUToFLUKA）
10. Wang, J. et al. 2026, Multibody System Dynamics（ChronoLLM）
11. Liang, J. et al. 2026, Digital Chemical Engineering；Du & Yang 2025（LLM 配置过程模拟的实践与风险）
12. 开源生态：React Flow / Vue Flow、Jinja2、FastAPI、JSON Schema、OpenModelica、Simulink
