# 资料发布台（OKF Catalog Release Gate）

从零实现的数据发布系统：**构建 → 质量检查 ∥ 业务审阅 → 绑定批准 → 原子发布 / 回滚 / 召回**。
所有商品、品牌、人员均为本地虚构数据；这是演示系统，**不是**电子签章、CA 或实名认证服务。

- 零 npm 依赖：只用 Node.js 内置模块（`node:http`、`node:crypto`、`node:sqlite`、`node:zlib`）。
- 无构建步骤：服务端渲染 HTML，一份本地 CSS/JS。
- 单一可核验的“当前发布”，由数据库约束保证，而不是靠应用层自觉。

---

## 快速开始

```bash
node --version        # 需要 >= 22.5（用到内置 node:sqlite）
npm run seed          # 初始化 data/app.db，写入虚构人员与演示场景
npm start             # 默认 http://127.0.0.1:8787
npm test              # 48 个测试：构建/检查、批准有效性、发布并发、页面渲染、样例
```

打开 <http://127.0.0.1:8787> 后先选一个虚构身份（无密码）。建议按下面的“演示路径”走一遍。

| 身份 | 角色 | 能做什么 |
| --- | --- | --- |
| 林舟 `@lin-zhou` | 资料管理员 | 上报/更正数据、重试构建 |
| 沈禾 `@shen-he` | 业务审阅 | 批准/拒绝/撤回（按域） |
| 顾青 `@gu-qing` | 合规审阅 | 批准、强制撤回他人批准、召回 |
| 陆行 `@lu-xing` | 发布经理 | 发布、回滚、召回 |
| 颜述 `@yan-shu` | 审计员 | 只读、核验回执、看审计日志 |

重置演示：`rm -rf data && npm run seed`。

---

## 核心模型

### 三层概念严格分开

1. **批准有效性**：一条批准绑定 `(版本, 检查记录, 规则集, 各域输入指纹, 各域结果指纹, 审阅序号, 有效期)`。
   有效性是**每次读取时实时计算**的，不信任写入时的状态字段。
2. **审阅完整性**：规则集要求的域是否都被**当前有效**的批准覆盖；域可由不同审阅人分别覆盖。
3. **可发布性**：完整性 + 版本可发布状态 + 检查仍是当前检查且通过 + 无阻断项 + 未过期。

页面上的“当前有效 / 已失效”都来自同一套实时判定；不存在“页面上还挂着旧批准”的状态。

### 指纹与绑定

- `canonicalJson`（递归键排序）→ SHA-256。
- 输入数据指纹：规范化快照（去空白、键序无关，但未知字段同样参与指纹——**不能悄悄加字段还视为同一份数据**）。
- 每域输入指纹、每域结果指纹：只改库存时，其他域指纹逐字节不变，这是“按影响补审”的前提。
- 规则内容指纹：质量规则与审阅策略都计入；规则一变，旧检查与旧批准立即失效。
- 批准集合指纹：覆盖每条批准的全部绑定、逐域指纹与有效期；任何撤回/过期/新增都会改变它。

### 数据模型（SQLite）

- 追加式：`versions`、`approvals`、`releases`、`release_artifacts`、`audit_log`。
  触发器禁止 UPDATE 绑定列/删除；批准只允许改状态与失效说明。
- `releases` 上有**部分唯一索引**：`CREATE UNIQUE INDEX releases_one_current ON releases(sku) WHERE status='published'`。
  任何路径都不可能同时存在两个当前发布，即使应用层写错。
- `versions` 的输入列（`sku/seq/source/raw_json/raw_hash/base_version_id/reason`）不可变：更正必须新建版本。
- 所有写路径走 `BEGIN IMMEDIATE` 单写事务。

### 状态机

```
version: building → {ready | build_failed | check_failed}
         ready → published（发布）
         ready/build_failed/... → retired（被上游更正退役，或召回）
release: published → {superseded | rolled_back | recalled}
task:    queued → running → {published | blocked | failed}
approval:approved → {withdrawn | invalidated | expired}
```

---

## 更正：全审还是按影响补审？

更正永远产生**新版本**（旧版本与旧批准保留为证据）。系统对新版本与基线做字段级 diff，再按规则集里的
`fieldDomains` 映射到需要重审的域：

- **补审（targeted）**：只有部分域受影响。受影响域必须由人重审；未受影响域，若其**输入指纹与结果指纹都未变**，
  可由人**显式承继**基线版本上仍然有效的域级批准。
- **全审（full）**：以下任一情况发生，则禁止任何承继，四个域全部重审。

### 必然使批准失效的变更（不可承继）

| 变更 | 为什么必须全审 |
| --- | --- |
| `sku / price / currency / markets / status / allergen_note / origin_country / labels` | 跨域耦合，无法只为局部背书（价格牵动税务与合规披露；市场牵动定价与合规） |
| 规则集内容变化（含审阅策略变化） | 旧批准依据的放行阈值已不存在 |
| 输入未变但检查结论变化（引擎修复等） | 结论本身变了，必须重新看结果 |
| 基线缺失 / 无字段差异 | 无法界定影响，保守全审 |
| 已过期 / 已撤回 / 被新检查替代 | 有效性实时判定失败 |
| 基线是未发布版本却被更正 | 基线立即退役（`retired`），其批准与在途发布任务一并作废 |

V2 规则集进一步把 `description` 列为强制全审字段，并把交期上限收紧为 90 天、要求所有市场填写原产国；
切换到 V2 会改变规则指纹，使既有批准全部失效。

### 承继不是“复制签名”

承继只记录 `carried_approval_id`，发布时**再次逐条复验**源批准：状态仍为 approved、未过期、源版本事实可重建、
该域输入/结果指纹与本次逐字节一致。任一不满足，承继链即失效。链式承继同样如此。

失效按**域**判定，不搞连坐：若一条批准里库存域是本人重审、其余域是承继，而某个承继源后来被撤回，
只有对应的承继域失效；本人重审的库存域仍然有效，页面会显示“部分域失效”并逐个域标出原因。
只有版本状态、批准状态、有效期、当前检查、数据/规则/结果指纹等**全局条件**不成立时，整条批准才整体失效。

### 等待成本 vs 误放风险

页面“影响范围与审阅策略”面板同时展示两侧代价：

| 策略 | 等待成本 | 误放风险 |
| --- | --- | --- |
| 全审 | 4 个域，约 80 分钟（规则集可按域配置） | 最低 |
| 补审 | 仅受影响域（如 1 个域约 20 分钟） | 仅当未变域输入/结果逐字节一致时才可承继；否则承继在提交或发布时被拒 |

原则：**能用指纹证明“没变”的域才允许承继；证明不了就重审。** 承继必须由具名审阅人显式选择，
不会默认沿用，也不允许“顺手全选”。

---

## 并发：只有一个可核验的当前版本

1. **数据库层**：部分唯一索引保证同一 SKU 最多一个 `published` 行。任何并发写事务最终只能有一个成功。
2. **任务固定预期**：发布/回滚任务在创建时记录
   `expected_current_release_id`、`base_generation`、`expected_approval_set_hash`，
   以及 `{dataHash, rulesHash, resultHash, reviewSerial}`。执行时在**同一写事务内**重新读取并逐项比对，
   任何不符 → 任务 `blocked`，绝不覆盖别人的决定。
3. **撤回推进审阅序号**：撤回/失效使 `versions.review_serial + 1`。任务记录了创建时的序号，
   执行时不一致 → `blocked`。因此**旧发布任务永远不能越过新撤回**。
4. **领取任务原子化**：`UPDATE ... WHERE id=? AND status='queued'`；`changes !== 1` 即视为已被他人领取。
5. **回滚不改历史**：当前发布 → `rolled_back`；以旧发布的同一份不可变产物插入**新代号**的 `published` 行，
   记录 `restores_release_id`。历史回执与产物字节不改。
6. **召回**：当前发布 → `recalled`，SKU 当前发布置空，版本 `retired` 且 `review_serial + 1`，在途任务全部 `blocked`。
   被召回的产物**禁止**再通过回滚上线。

对应测试：`test/releases.test.js`（重复任务、撤回阻止在途发布、回滚与发布交错、召回、篡改检测）。

---

## 发布包与核验

发布成功时生成四个不可变产物并写入 `release_artifacts`：

- `data.json`：规范化快照
- `checks.json`：检查项、规则指纹、结果指纹
- `approvals.json`：批准集合、逐域指纹、承继来源
- `manifest.json`：代次、发布人、各项哈希、文件哈希表

下载：

- `/download/:releaseId.zip`（手写 ZIP，store 方式，无第三方库；逐字节等于数据库中的产物）
- `/download/:releaseId/:name`（单文件）

“核验”会重新计算每个产物哈希、manifest 自哈希与交叉引用、批准绑定与当前有效性，并写入 `verifications` 与审计。
即使批准后来过期，发布回执本身仍可核验——审计看到的是“当时依据了什么”，而不是“现在是否仍然有效”。

---

## 演示路径

1. `npm run seed && npm start`。
2. 以 **沈禾** 登录，进入 `OKF-1001 v2`：库存 120→80 的更正。页面显示“按影响范围补审（1 个域）”，
   并列出可承继的基线批准。勾选库存域、为其余三个域各选一条承继，填写意见后批准。
3. 以 **陆行** 登录，进入 `OKF-1001`，点击发布 → 生成第 2 代；打开回执，核验、下载 ZIP。
4. 以 **陆行** 回滚到第 1 代 → 生成第 3 代，第 2 代变 `rolled_back`，产物哈希与第 1 代一致。
5. 以 **顾青** 召回第 3 代 → 线上归零，SKU 当前发布为空。
6. 访问 **演示样例** 页：
   - **构建失败与恢复**：首次构建注入可重试异常（无数据快照、不可批准）→ 同版本重试成功 → 待审阅。
   - **审批过期**：批准在 100 小时前提交（TTL 72h）→ 清扫为 `expired` → 发布被阻止 → 必须重新审阅。
   两个样例都在专用 SKU 上运行，每次新建独立版本，可重复执行且不改既有回执。
7. 以 **颜述** 打开 **审计**：查看创建、构建、批准、撤回、过期、发布、回滚、召回、核验的全量留痕。

---

## 目录结构

```
server.js                 路由与 HTTP（页面 + 表单 API + JSON API）
src/db.js                 模式、触发器、部分唯一索引、迁移与规则播种
src/canonical.js          规范化 JSON 与 SHA-256
src/domain/catalog.js     字段归属、规范化快照、域指纹、diff
src/domain/rules.js       两版规则集（质量规则 + 审阅/失效策略）
src/domain/pipeline.js    建版、构建、检查、重试、重检
src/domain/approvals.js   绑定、实时有效性、影响评估、批准/撤回/失效、覆盖
src/domain/releases.js    可发布性、发布任务、产物、回滚、召回、核验
src/views/*.js            服务端渲染页面与查询层
src/samples.js            两个演示样例 + 手写 ZIP
scripts/seed.js           种子数据
test/*.test.js            node:test（内存库，串行）：pipeline / approvals / releases / pages / samples
```

## API 摘要

| 方法与路径 | 作用 |
| --- | --- |
| `POST /api/skus/:sku/versions` | 建版（构建 + 检查） |
| `POST /api/versions/:id/retry` | 重试构建（仅 `build_failed`） |
| `POST /api/versions/:id/decision` | 批准/拒绝；回传四项指纹 + 审阅序号 |
| `POST /api/approvals/:id/withdraw` | 撤回（本人或合规） |
| `POST /api/skus/:sku/publish` | 排队并执行发布（带预期） |
| `POST /api/skus/:sku/rollback` | 回滚到指定历史发布 |
| `POST /api/skus/:sku/recall` | 召回当前发布 |
| `POST /api/releases/:id/verify` | 核验回执与产物 |
| `GET /api/versions/:id`、`GET /api/releases/:id`、`GET /api/status` | JSON 查询 |
| `POST /api/samples/run` | 运行样例（JSON） |

## 明确的边界

- 身份是本地角色扮演，Cookie 只是签名会话；**没有密码、短信、CA、电子签章或实名认证**。
- 批准不具法律效力，不能作为合规签署凭证。
- SQLite 单机演示：单写事务足够保证并发不变量；跨机部署需要换成具备同等约束的数据库与锁策略。
- 不自动替任何人批准；补审与承继都需要具名操作者显式提交。
