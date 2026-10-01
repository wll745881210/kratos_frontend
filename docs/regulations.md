# kratos_frontend 规程（regulations）

本文件是前端/universal pgen 的**正式工作规程**：每节给出规则、违反时工具的行为
（error / warn / 拒绝保存），以及变更流程。规则的唯一依据是已验证的代码事实
（`docs/kratos_internals.md`）与已记录的决策（`docs/implementation.md`、
`docs/m2_plan.md`）。

- §1 新模块添加（本节已定稿）
- §2 超参数列表调整（本节已定稿）
- §3 分辨率与网格/块布局调整（本节已定稿）

---

## §1 新模块添加规程

适用范围：向 universal pgen 增加一个可在 `[module.<role>]` 中通过
`type = <name>` 实例化的模块（含对 trunk 已有模块的包装，以及 univ 自有模块
如 `post`）。

### 1.1 准入条件

新增模块**必须**满足以下全部条件，缺一不予合入：

1. **不改动 kratos 主干 `src/`。** universal pgen 全部代码位于
   `usr_ext/universal/`（该目录在主干 repo 中被 gitignore，版本记录以前端
   repo 文档为准）。若确需主干改动，**必须先停下与用户确认**（见
   `DEVELOPMENT.md` 主干纪律）。
2. **混合精度纪律**：除守恒变量本身及其加减运算外一律 `type::float_t`；
   仅守恒量读写/能量组装用 `type::float2_t`（依据：`src/types.h`
   PRECISION 语义；违例先例已在 M1 精度清扫中全部修复）。
3. 模块必须能回答三个问题（在 wrapper 注释中写明）：
   - 需要哪些**共同工作的模块**（如 chem_hydro 需要 chemistry 提供
     `q_che`/species）？
   - 暴露哪些**耦合槽**（couplable_t 槽名与期望目标类型）？
   - 未配置任何子功能时是否为**空操作**（参照 post：全关 → step 直接返回）？

### 1.2 必备工件清单（Definition of Done）

一个"新模块添加"提交**必须**同时包含以下工件；缺任一项视为未完成：

| # | 工件 | 位置 | 说明 |
|---|---|---|---|
| 1 | C++ wrapper | trunk `usr_ext/universal/univ_<name>.h` | 继承 trunk 模块基类 + `couplable_t` + `role_aware_t`；`read()` 先 `scoped_args()` 再走 trunk 读入链；**不得复制** trunk 的参数解析 |
| 2 | 注册 | trunk `usr_ext/universal/usr.cpp` | `register_module_t<T>("<name>")`；type 名小写、与 trunk 类族一致 |
| 3 | 参数描述文件 | 前端 `descriptors/modules/<name>.yaml` | section 名、键类型/默认值/文档；未知键政策 = warning |
| 4 | 块库条目 | `web/client/src/model/graph.ts` 的 `MODULE_TYPES` | 当前手工维护（TODO：收敛到单一 yaml 后由 bindings 生成） |
| 5 | 测试 par | trunk `usr_ext/universal/pars/<case>.par` | 能真实运行的最小用例 |
| 6 | 验证脚本 | `~/scratch/tst_kratos_frontend/<case>/` 或前端 `tests/` | 有明确数值判据；**每个数字必须可追溯到实际产物**（反例见 `docs/rand_verification.md` 诚信事件记录） |
| 7 | 回归 | 既有测试全部通过 | pytest / vitest / sod·briowu·inflow·chem·kh·base_chain 物理回归 |
| 8 | 文档 | `docs/implementation.md` 新增小节；学到新的 trunk 事实时同步 `docs/kratos_internals.md` | |

若模块涉及表达式新语法（新函数/新变量）：另需同步三端实现
（C++ `expr.h` / Python `ic_eval.py` / JS 经 server）并扩充
`descriptors/expr_grammar.yaml` golden vectors。

### 1.3 接口约定

1. **耦合**：槽名小写、语义命名（如 `"dyn"`）；`couple_slots()` 声明期望目标
   类型；容器对"槽目标类型不符"报 error 并列出可用角色。双向绑定
   （chemistry::parasite 模式）由容器只调一侧，wrapper 注释标明调哪侧。
2. **role 覆盖**：wrapper 通过 `role_aware_t` 接收 `[module.<role>]` 内
   `<section>.<key> = value` 覆盖（在最后一个 `.` 处拆分）；非 role_aware
   模块收到覆盖键 → error。
3. **错误信息**：所有"未知类型/未知槽/缺少共模块"错误必须列出当前可用项
   （参照 `registry.h` / `couplable_t` 既有风格）。
4. **调度**：模块默认按 `[module.<role>]` 的 `order`（缺省 = 字典序位次）
   决定 init/step 槽位；显式 `order` 重复 → error。post 类模块覆写
   `update()`/`sync_streams()` 为空操作时必须注释原因（不拥有块数据）。

### 1.4 提交流程

1. 工件 1–2、5 位于主干（usr_ext/universal/，gitignored → Seafile 同步）；
   工件 3、4、6–8 位于前端 repo，**一次前端提交**完成，提交信息格式：
   `Add module <name>: <一句话物理功能>`。
2. 提交前必须通过：CUDA 构建（GPU1，sm_86）+ 该模块测试 par 的数值判据 +
   全部回归。构建/测试纪律见 `~/apps/kratos_frontend_dev/DEVELOPMENT.md`。
3. 提交后在 `docs/implementation.md` 里程碑表中登记。

### 1.5 违反时的工具行为

- 描述文件缺失或键类型错误 → server `validate` 报 error，前端表单标红，
  不阻止保存（保存的是 par，合法性以 kratos 运行为准）。
- 块库未注册该 type → Diagram 页无法拖出该模块；手写 par 中含该 type 时
  画 ghost 节点（红虚线），不静默吞掉。
- 运行期错误（未知 type/槽/共模块缺失）→ universal 容器抛异常，信息中
  必须列出可用项（见 1.3.3）。

---

## §2 超参数列表调整规程（本节已定稿）

### 2.1 定义与权威来源

1. **超参数** = 决定模拟"身份与规模"的参数，仅限：
   - 四个核心节 `[device]` / `[unit]` / `[mesh]`（含块布局）/ `[cycle]` 的全部键；
   - 各模块的**开关类键**（如 `[post.cooling] enabled`——这类键归模块所有，
     其增删走 §1 模块流程，本节不管辖）。
2. 物理/算法参数**不是**超参数（dynamics 参数归 dynamics 模块；用户存在
   无 dynamics 的配置如 `usr_ext/line_rt`，故 dynamics 不进核心集）。
3. 权威定义 = 前端 `descriptors/core/*.yaml`（四个核心节各一文件）。
   **每个键的 `doc` 必须注明 trunk 出处**（文件:行 或读取点）；默认值与
   类型以 trunk 实际读入为准，描述文件与 trunk 不符 = bug，以 trunk 为准修正。
4. Globals 视图（M2.6）是超参数的 GUI 呈现；描述文件变更而 Globals 未同步
   = bug，须在同一提交内修复（自动生成 Globals 是 TODO，目前手工维护）。

### 2.2 变更类型与规则

| 变更 | 是否允许 | 流程 |
|---|---|---|
| **新增键** | 允许 | ① 核对 trunk 事实（默认值/类型/读取点，写进 doc）→ ② 描述文件 → ③ 属四核心节则同步 GlobalsView → ④ 涉及跨字段约束则加 xchecks 规则 → ⑤ 测试（test_xchecks / GlobalsView.test）。五项一次提交 |
| **废弃键** | 允许 | 不删除；描述文件标 `deprecated: true` → validate 报 warning（"deprecated，建议改用 …"）；至少保留一个里程碑周期后才可删除 |
| **重命名键** | 禁止 | 以"新增 + 废弃旧键"两步代替 |
| **改键类型** | 禁止 | 同上（类型变更破坏 par 往返） |
| **改默认值** | 原则禁止 | 会静默改变旧 par 行为；确需时须用户批准并在 implementation.md 记录理由 |

### 2.3 版本与迁移

1. Spec `version`（当前 1）：描述文件保持向后兼容时不变；发生不兼容变更
   （应极力避免）→ version +1，且 `core/` 必须提供
   `migrate(spec_dict, from_v, to_v)` 迁移函数并配测试。
2. **bundle 覆盖白名单**：只有规模类键允许在 import 时经 JSON Merge Patch
   覆盖。权威定义 = `core/kratos_spec/project.py` 的 `DEFAULT_OVERRIDABLE`
   （新项目的 manifest 复制此默认；既有项目以自身 manifest 的 `overridable`
   字段为准）。当前默认：`mesh.n_cell_global`、`mesh.x_min`、`mesh.x_max`、
   `cycle.t_lim`、`cycle.n_cycle_lim`。`[unit]` 与 `[device]` 的键**禁止**
   进入白名单（改变物理身份/运行环境，必须用户手工修改）。修改
   `DEFAULT_OVERRIDABLE` 视同修改本规程，需用户批准。
3. 旧项目文件打开时：核心节缺键 → 按描述文件默认值补齐并在 status 提示；
   出现已废弃键 → warning 列表展示，不自动改写用户文件。

### 2.4 工具行为（违反时）

1. **核心节出现未知键 → error**（疑似笔误；模块节未知键仍 warning，
   保留前向兼容）。 —— 注：当前实现对所有节均为 warning，升级为核心节
   error 是本次规程的配套代码改动，与 §2 定稿同提交落地。
2. unit FP32 溢出 / mesh 块布局不整除 → error（M2.6 已落地，xchecks）。
3. bundle import 携带白名单外键 → 拒绝并列出被拒键（现有行为，固化）。

## §3 分辨率与网格/块布局调整规程（本节已定稿）

### 3.1 原则

1. 网格四元组（`x_min`/`x_max`、`n_cell_global`、`n_cell_block`、
   `refine_region_*`）加 `dist_mode`/`balance_coef` 是模拟的"地基"；
   其变更视同重大事项，必须显式、可追溯、先过校验（error 未清零不得运行）。
2. **bundle 覆盖白名单是唯一的"自动"调整通道**（见 §2.3）。允许经 bundle
   导入时覆盖的网格键仅：`mesh.n_cell_global`、`mesh.x_min`、`mesh.x_max`。
   `n_cell_block`、`dist_mode`、`balance_coef`、`geo_regenerate`、
   `refine_region_*` 一律只能手工编辑，**禁止**进入白名单。
3. 每次网格变更后，用户必须被告知 §3.2 矩阵中对应行的全部后果。

### 3.2 变更类型矩阵

| 变更 | 渠道 | 后果声明 |
|---|---|---|
| **分辨率缩放** `n_cell_global` | bundle 白名单 / 手工 | ① `rand(i,j,k,seed)` 噪声实现改变（噪声按块布局+分辨率定义，见 internals §9）——新实现统计等价但**不逐位一致**；② `[init] base_file` 失效（`dat_3d::read` 尺寸不符即 throw），须按新网格重新生成；③ 旧输出 bin 不能用于续算重启（同理尺寸不符）；④ 收敛性研究必须经 bundle 派生项目，保证其余键逐位一致（见 §3.4.2） |
| **块布局** `n_cell_block` | 仅手工（不入白名单） | ① `rand` 噪声实现改变（同上）；② 仅影响性能与并行粒度，物理结果统计等价；③ bin 输出的块编号重排（按块索引的下游后处理需注意）；④ 必须整除 `n_cell_global`（xchecks error，镜像 trunk "Mesh size indivisible by sub-mesh."） |
| **几何缩放** `x_min`/`x_max` | bundle 白名单 / 手工 | ① IC 表达式按物理坐标工作，表达式文本不必改，但区域语义随之改变，须人工复核；② 所有 `refine_region_*` 的 `loc`/`x_min`/`x_max` 必须同步检查——越界时 kratos 在 meshgen 阶段 throw "Incorrect SMR region"（xchecks 已镜像为 error） |
| **`refine_region_*` 增删 / level 调整** | 仅手工 | ① `level <= 0` → 区域被 kratos **静默忽略**（xchecks warning）；② 坐标越界 → error（已镜像 trunk）；③ 区域粒度 = 该 level 层的块（索引网格为 `i_logic_lim << level`）；④ level 上限：trunk meshgen 无显式校验（已核验），工具端暂不限制，核验更深层约束列为 TODO |
| **`dist_mode` / `balance_coef`** | 自由 | 仅影响负载均衡/性能，无物理影响；`balance_coef` 不足 3 分量按 1 补齐并归一化（trunk 行为） |
| **`geo_regenerate`** | 自由 | 一次性开关：强制重建网格树、忽略缓存；网格几何变更后重开旧工作目录时使用 |

### 3.3 工具行为

已落地：
1. 块布局整除 / 零尺寸 → error（xchecks，M2.6）。
2. unit FP32 溢出 → error、下溢 → warning（xchecks，M2.6；背景见 internals §6）。
3. bin 分辨率护栏：level-0-only 的输出 bin 与 spec 的 `n_cell_global` 不符 →
   预览器警告横幅（M2.6）；含 AMR 块的 bin 跳过比较并提示。
4. `refine_region` 坐标越界 → error、`level<=0` → warning（本节配套，已落地）。

TODO（不阻塞本节定稿）：
- **base_file 预检**（p2）：spec 引用可读的 `[init] base_file` 时，读其
  `n_cell_global` 与 spec 比对，不符 → error。当前依赖运行期
  `dat_3d::read` 的 throw，信息不友好。
- **refine level 上限的 trunk 事实核验**（p2）：若有上限，镜像为 xchecks
  规则；若无，删除 3.2 表中相应 TODO 语。

### 3.4 可复现性政策

1. 同一（块布局, 分辨率, seed）→ `rand` 噪声逐位可复现；任一变更 →
   新噪声实现。跨布局/跨分辨率的**逐点比较无效**，科学结论只能用统计量
   比较（见 docs/rand_verification.md 的检验方法）。
2. 分辨率收敛性研究 = 用 bundle 派生项目（白名单仅覆盖 `n_cell_global`），
   派生链在 manifest 的 `spec_history` 中可追溯。
3. 分辨率/几何变更后，旧 `base_file` 必须经显式重采样重新生成
   （重采样工具暂无，TODO p2），**禁止**静默沿用。

### 3.5 本节配套代码改动（与定稿同提交）

- `xchecks._check_refine`：refine_region 越界 error（镜像 trunk 报错文本
  "Incorrect SMR region"）、`level<=0` warning（附"region silently
  ignored"说明）。测试 3 例（越界 / level 0 / 合法）。
- §2 配套（同提交）：核心节未知键 error、模块节保持 warning；
  `deprecated: true` 键 warning；`meta.schema.yaml` 增补 `deprecated` 字段
  说明。
