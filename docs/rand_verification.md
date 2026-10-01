# rand() 均匀性 / 块间独立性 验证记录

> 结论：验证**发现并修复了一个真实缺陷** —— `rand(i,j,k,seed)`
> 原本使用**块内局部索引**，导致所有块的噪声场逐位相同
> （多块问题上完全相关的"噪声"）。修复：IC/BC 处传入
> `global_ijk()` 计算的**全局索引**（块自身层级下
> `i_loc + llround(xf0/dx0)`）。修复后全部检验通过。

## 缺陷与修复

| | 修复前 | 修复后 |
|---|---|---|
| 各块噪声模式 | **逐位相同**（min pairwise max\|Δρ\| = 0，跨块相关 = 1.0000） | 全部不同（min pairwise max\|Δρ\| ≈ 0.088） |
| 原因 | i,j,k = 块内局部索引 → hash 输入相同 | i,j,k = 全局索引（`global_ijk`，见 `univ_hydro.h`） |

注意语义：噪声场对给定的块布局/分辨率确定，但**不是布局不变**
（细化区域会以自身层级的全局索引重新播种）。IC 与 inflow BC
（ghost 单元）使用同一约定。

## 方法与复现

探针：`tools/check_rand.py`（本仓库，纯 numpy + 内置 binread）。

```bash
# 用例生成（usr_ext/universal 构建的 bin/kratos）：
cd ~/scratch/tst_kratos_frontend/rand_check/unif && kratos rand_unif.par
cd ~/scratch/tst_kratos_frontend/rand_check/ref  && kratos rand_ref.par
# 检验：
.venv/bin/python tools/check_rand.py <case_dir> [...]
```

用例：`rho = 1 + 0.1*rand(i,j,k,42)` 纯噪声 IC，t=0 初始 dump。
`rand_unif.par`：24³，n_cell_block=8³（27 个同尺寸块）。
`rand_ref.par`：同上加 `refine_region_00`（中心半域 level=1，
216 块，混合层级）。

检验量（每块、每轴）：cell-center 坐标与 ρ 的 Pearson r；
Bonferroni 校正（α=0.05/N_tests）。跨块：同层级同形状块两两
模式相关 + 最小成对 max|Δ|。

## 实测结果（CUDA sm_86, GPU1, 修复后）

| 用例 | 块数 | 检验数 | min p（阈值） | 跨块 max\|corr\| | min pair max\|Δ\| | 判定 |
|---|---|---|---|---|---|---|
| unif | 27 | 81 | 0.0134 (6.2e-4) | 0.137 | 0.0884 | **PASS** |
| ref  | 216 | 648 | 0.00467 (7.7e-5) | 0.168 | 0.0859 | **PASS** |

- 512 样本下零假设 E\|r\| ≈ 0.035；跨块 max|corr| ≈ 0.14–0.17 与
  数百对噪声相关的极值一致（σ≈0.044）。
- 探针在修复前的 bin 上正确判 FAIL（max|corr|=1.0000, min diff=0），
  即检验本身具备检出能力。

## 历史教训（流程）

本文档首版曾基于压缩摘要中的**未执行**"结果"写成（伪造表格），
被用户要求的可复现性检查发现（artifacts 不存在）。当前版本所有
数字来自上述可复现命令的真实输出（2026-10-01, GPU1）。教训：
**文档中的每个数字必须能追溯到实际运行的产物**；压缩摘要仅作
线索，不作证据。
