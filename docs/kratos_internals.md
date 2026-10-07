# Kratos 内核机制备忘（frontend 开发用）

本文只记录**已亲自验证**的事实（附 `src` 文件:行号），供 universal pgen
与前端开发查考，避免重复踩坑。行号可能随 trunk 演进漂移——**依据本文
做任何修改前，先重读对应源码确认**。

## 1. 构建系统

- `make USRDIR=usr_ext/<prob> ARCH=CUDA|HIPCPU|HIP|MUSA SM=sm_XX DEBUG=0|1`。
- `USRSRC = find -L $(USRDIR) -name '*.cpp'`（递归）；**省略 USRDIR 会静默
  编译 stub `usr/`**，不会报错。
- `obj/` 跨 ARCH 共享 → 切换 ARCH 必须先 `make clean` 再全量编译；
  `make remake -j` 有 clean/编译并发的竞争，clean 与 build 要分开跑。
- HIPCPU = CPU 串行后端；shim 只有 device 0（`idx_device` 必须为 0，
  否则 `hipErrorInvalidDevice`）；`DEBUG=1` 定义 `__CPU_DEBUG__` /
  `__GPU_DEBUG__`。
- HIPCPU 的"设备内存"就是主机堆 → 设备端越界写会踩坏任意主机内存，
  表现为莫名其妙的堆损坏。

## 2. par 解析器（`src/io/args/input.{h,cpp}`）

- `#` 起到行尾全部丢弃（在任何解析之前）。
- `key = value` 按第一个 `=` 切分；value 在**第二个 `=` 处截断**
  （input.cpp 的 `getline(ss, value, '=')`）→ **value 永远不能含 `=`**。
  表达式比较运算用单词形式：`geq leq neq ge le eq ne lt gt`、
  `and or not`（univ expr 引擎支持）。
- `get<std::string>` 只返回第一个空白分隔 token（`assign` 用 `ss>>t`）
  → 含空格的表达式要用 `get<std::vector<std::string>>` 再 join
  （univ 的 `ic_t::get_expr_str`）。
- bool 只认 `0/1`（无 boolalpha；写 `true` 得 0）。
- 重复 key 后写覆盖；多个 par 文件按序 merge；内部 key 格式
  `section|key`；`item_map` 公开；`get_prefixes()` 返回有序 section 集合。
- 前端 `core/kratos_spec/parfile.py` 镜像 item_map 语义（保留完整
  字符串），与 `get<string>` 的截断行为**不同**——比较时要注意。

## 3. 模块与网格生命周期

- `prob::run` 是 weak symbol（`src/user/probgen.cpp` 提供默认）；
  默认 `prob::cmd` 把全部 argv 当 par 顺序读入。
- enroll 顺序：`enroll_device` → [MPI: `enroll_comm` + `enroll_binary_io`]
  → `input` → `cmd` → 模块 → `mesh.init`。
- `mesh_enroll.h`: `enroll_module<T>(i_init, i_step)` 显式槽位；无参重载
  自增；`steps`/`inits` 是 `std::map<int, fn>` —— **槽位冲突 = 静默
  覆盖**，容器必须自己校验。
- `mod_base_t::parasite(q)` 设置 `q_mod` + 共享 `p_blk_local` +
  `need_update=false` —— 有副作用、非幂等。`chemistry::base_t::parasite`
  是**双向**的（会回调 `q->parasite(self)`），容器只需调一个方向；
  `chem_hydro::parasite` 只设 `q_che`。
- `mod_base_t::update(news)`：`setup()` → `init_cond(host)` →
  `copy_h2d()`，恰好一次。
- **作用域输入（univ_mesh.h）**：`mesh.h:39-43` 的 `reads`
  （`vector<fn(input)>`）与 `inits`（`map<int,fn>`）是 protected 且
  `enroll_module` 恰好 push 一个读取 lambda（含 order_max 更新）——
  universal 容器据此在 `enroll_module_scoped` 中改写 `reads.back()` 与
  `inits[i_init]`，把 `scoped_input(args, role)`（input 副本 + 把
  `[R.<sec>]` 键 `set()` 为原生节名）传给模块的 `read`/`init`。
  `input::set` 用 `operator<<` 存完整字符串；`item_map` 是 protected，
  但拷贝构造可用。全局原生节保持原名传递 → 所有模块共享（继承 +
  逐键覆盖语义）。

## 4. 块数据模型（`src/mesh/block/`）

- `hyd_data_t`（hyd_data.cpp:28-29）：`w`（原始量）有 `n_gh` ghost；
  **`u`（守恒量）没有 ghost**（`u.init(f_new, geo.n_ceff, zero, n_fld,
  n_stp)`）。
- `u` 布局：`dat[cell * n_int + fld]` 交错，slot 偏移 `step * n_ctot`；
  cell{0,0,0} → 偏移 0。**用调试器读 `u` 时绝对不要加 ghost 偏移**。
- `w` 布局：`w[idx::rho]=0` 密度、`w[idx::ene]=1` **压力**、
  `w[idx::mom+a]` 速度；`i<0` 为 ghost slot，`d(n)` = 首条内部线
  （zero-gradient 数据源）。
- `copy_input` 的 `cp[tgt]` 拷贝链（block_data.h:74-80）：编译期反射收集
  `dual_t<float2_t>` / `dual_t<float3_t>` 成员，f2/f3 分类、hyd 按 f3
  占位对齐 → `hyd/q0..q2/c0..c2` 在 hydro 与 mhd 派生布局间对齐；
  **`x_el/y_el/z_el` 与 `rot_bc` 不对齐**（hydro-only 源拷向 mhd 派生
  目标时 x_el 数据会落进 rot_bc——已确认的 trunk 隐患，纯 hydro 路径
  不读这些字段故无害）。
- `n_fld = intra_order()`；chem_hydro 覆盖为 `n_hvar(5) + n_species`。

## 5. cycle 与 dt（`src/mesh/cycle/cycle.cpp`）

- `p_dt` 是**设备端** `atomic_min` 累积器；`p_dt_h[0]` 当前 dt，
  `p_dt_h[1]` 下一周期 cap。
- **`p_dt` 在 `cycle::evolve()` 开头初始化**（cycle.cpp:149-152：dt_init，
  若 < FLT_MIN 则 FLT_MAX/10），**不在 `init()`** —— 曾因只读 `init()`
  误判为未初始化 bug。读代码要看完整个类的生命周期。
- `redc_dt_start`：p_dt→p_dt_h[0] + MPI min；`redc_dt_finish`：
  `min(dt, t_lim − t)`、t 前进、`p_dt ← dt·dt_expand` 作下周期 cap。
- **t 在 `redc_dt_finish` 内前进**（cycle 中段）→ 物理 functor 取时间
  用 `mesh.p_cyc->t`。
- **`t_lim − t` 夹紧**：t 接近 t_lim 时 dt 被夹到 `t_lim − t`。probe par
  若令 `t_lim = dt_init`，"dt 塌缩"纯属此夹紧的假象；且 t_lim 以 double
  读入、t 是 float，舍入会产生 2.5e-12 之类的诡异差值。
- `cycle::step` 打印的 dt 是 `mesh.step` 之后的 `p_dt_h[0]`。

## 6. EoS / dt / 化学温度

- **单位制 `phys::unit_t<f_T>`（`src/utilities/phys/unit.h`）**：
  `[unit]` 支持 length/time + density（数字或 `"mp"`/`"mh"`）或 mass；
  派生 `m0=ρ₀l₀³`、`vel0=l₀/t₀`、`ene0=ρ₀l₀²t₀⁻²`，任一为 nan/inf
  即抛 "Unit sys overflow"。**dynamics eos 里的实例是
  `unit_t<type::float_t>`（FP32，`prototypes/eos.h:35`）**——默认
  PRECISION=1 下 `[unit]` 组合若使 m0 > 3.4e38（例：
  length=1 kpc + density=mp → m0≈5e40 g）直接溢出。选单位时先心算
  `ρ₀·l₀³`；GUI 的 [unit] 编辑框应实时预检（M2.6 需求，用户
  m01306 提出）。
- c2p 地板：`d_floor`、`pre_floor = t_floor·rho`。
- 单点 `dt = cfl·dx/(cs+|v|)`；eos `operator()` 在 `step==0` 时
  block_reduce min → `atomic_min(p_dt)`。
- **chem eos `temp()`（chem_hydro/eos.h:255-288）把 T 夹到
  `[Tmin, Tmax]`（默认 2.7 K / 1e7 K，来自 `[chemistry] Tmin/Tmax`）并
  重标定能量 `y[i_en] *= T_clamped/T`**。无量纲单位制（[unit] 全 1）下
  气体温度按 CGS 解读 ≈ 1e-8 K << Tmin → 每轮能量被放大 ~1e8 → dt
  塌缩。**chem 测试必须显式设 `[chemistry] Tmin = 1e-30`**（或使用真实
  CGS 温度，如 cmz）。
- chem_hydro 的 cv 与组分相关：`cv = Σx·gm1i / Σx`（gm1i：H2=2.5，
  H=1.5），`u[ene] = pre·cv(x, T) + ½ρ|v|²`。

## 7. 边界（`src/mesh/boundary/`、`src/modules/dynamics/hydro/boundary/`）

- hydro keeper 构造注册 `"ref"/"out"/"fre"`；univ 扩展 `"inf"`
  （expr_inflow）。
- `[boundary] kinds` 共 6 项，顺序 `side = 2*axis + i`（i=0 左/1 右）。
- `phys_base_t::launch` **按值**把 functor 传给 kernel —— functor 必须
  trivially copyable（含裸设备指针没问题）。
- `act_bnd(mesh, step)` 每子步调用；keeper `init` 在 `p_dev` 就绪后执行。
- `device::base_t::free(p, host=true)` **默认 host free** → 设备指针必须
  显式 `free_device()`，否则 finalize 时 `cudaFreeHost` 报
  invalid argument。

## 8. 二进制输出与 `visual/hydro_data`

- `dat_3d_t::write`（dat_3d.h:220-224）：`dat.n()==0` 时**什么都不写**
  （连 header 都没有）→ init 时刻的 bin_0 只有 mesh 数据，
  `get_field(...,'hydro_cons')` 报 KeyError 是正常的。
- 用法：`with hydro_data(file, read_now=False) as hd: hd.prep_block();
  hd.read_block_geometry('block_0'); hd.get_field('block_0','hydro_cons')`
  → shape `(n_fields, z, y, x)`，已去 ghost。`hd.keys` 是**方法**不是
  属性。
- 字段顺序 hyd：`rho, ene, mom_x, mom_y, mom_z[, species...]`；mhd 另有
  `field_bf`。

## 9. 化学模块（`src/modules/chemistry/`）

- `[chemistry] species = H2 H H+ e`；解析：去 `*`、计 `+/-` 电荷、去
  `(...)`，`e`=电子，元素按 `[A-Z][a-z]*`+可选数字计数（`H2`=2 个 H）。
- `[species_init]` 各物种数分数（缺省 1e-20），自动归一。
- `reaction_file` 为空 → 打印 "Skipping std reactions"，0 反应 = 合法
  被动模式（Rosenbrock 恒等，不动能量/组分）。
- 物种场位于 `u[n_hvar + n]`；`u_sp = rho·ma/mu·x_n`。**数分数恢复 =
  `sp_n / Σsp`，不要乘质量**（乘了会得到 0.947=18/19 之类的假异常）。
- chem_hydro 无 riemann/reconstruct 运行时选择（`enroll_chem_hyd` 固定
  chem 版 rec/rie）。

## 10. 调试陷阱清单（实际踩过的坑）

1. gdb 读 `u` 加了 ghost 偏移 → 读到幻影"全零"（u 无 ghost，§4）。
2. probe par 缺 `[init]` → `rho0/pre0` 默认 0 → 全场零（hydro.cpp
   的默认值！）。chem probe 必须显式给 `[init]`。
3. probe par `t_lim = dt_init` → dt 被 `t_lim − t` 夹紧 → 假"塌缩"（§5）。
4. bin_0 没有 hyd 字段（init 输出早于模块数据建立）→ KeyError 正常（§8）。
5. `idx_device=1` 在 HIPCPU build 必崩（§1）。
6. 切 ARCH 不 clean → 链接混乱；`make remake -j` 竞争（§1）。
7. `pkill -f "kratos_spec.cli.*serve"` 会匹配到自己的 shell 命令行并把
   自己杀掉 → 先 `pgrep -af` 看清单，按 PID 杀。
8. zsh：`rm -f *.bin` 无匹配时报 "no matches found" 并中断 `&&` 链。
9. 验证脚本本身可能是 bug 源（Sod 教训：`u* = 0.5*(f_R − f_L)` 不是 `+`；
   canonical 表值 0.30313/0.92745 对应 ρ_R=**0.125** 不是 0.1）。先在
   验证器里自检 canonical 值。
10. 数分数恢复乘质量 → 假异常（§9）。
11. 怀疑 trunk 有 bug 前，先排除自己 par/脚本/读数方式的问题——本次
    "p_dt 未初始化"与"设备数组全零"两个"trunk bug"最终都是误读。
