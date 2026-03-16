# Slisic 状态机重构蓝图（执行方案）

> 目标：在**不推翻现有项目实现**、不一次性大改的前提下，逐步把当前“前端大 store + 后端命令/事件 + 隐式任务状态”的结构，重构为更清晰、更可推理的前后端一致状态模型。

这份蓝图严格基于当前仓库现状与 `fsm-analysis.md`，强调：
- 最小破坏
- 前后端一致建模
- 阶段化迁移
- 每一步都可验证、可回滚

---

## 一、总原则

## 1. 不做“一次性总重写”
当前项目已经有真实用户流程：
- 创建/编辑 playlist
- 本地导入 / web link 下载
- web list 更新
- 播放与 shuffle
- loudness normalization

这些流程耦合很深，直接全面改造成单一 XState 大图风险极高。

因此策略必须是：

### 先抽“边界最模糊但局部可收敛”的 FSM
优先级建议：
1. **修语义 bug / 保护 invariant**
2. **抽 TaskFSM**
3. **抽 EntryLifecycleFSM**
4. **拆分 selectedListName / PlaybackFSM**
5. **统一 persistSlot 语义**
6. **类型化 processMsg / task events**
7. **再考虑更大范围 FSM 显式化**

---

## 2. 每一阶段只做一种“状态收敛”
不要在同一阶段同时做：
- 命名修正
- UI 重构
- 后端事件协议升级
- 持久化 schema 改动

一阶段只收敛一种状态问题，否则验证会失控。

---

## 3. 先建立兼容层，再删旧逻辑
这个项目有很多现有 UI 与命令接口已经依赖老字段：
- `selectedListName`
- `processMsg`
- `downloaded_ok`
- review arrays

因此迁移策略应该是：
- 先新增结构化状态
- 再通过 adapter 派生旧字段
- UI 切换完后再删旧字段

而不是直接替换。

---

## 二、重构优先级总览

## P0：立即修语义破坏 / invariant 漏洞
### 目标
优先修“当前就可能制造非法状态”的地方。

### 范围
1. `recheck_folder()` 保留 metadata 语义
2. metadata schema 增加 version（可选但建议）
3. 明确 reload 对 metadata-backed entry 的语义

### 原因
这些属于“现在就会把数据改错”的问题，不应等到大重构后再修。

---

## P1：TaskFSM（最先抽）
### 目标
把现在散落的：
- `linkReviews`
- `folderReviews`
- `weblistReviews`
- `processMsg`

统一为前端任务状态注册表（task registry）。

### 为什么先做它
因为它：
- 不需要先改 repo schema
- 不需要先改 audio engine
- 是最明显的“状态分散源”
- 一旦收敛，很多 UI / 交互 / 异步回流都会清晰很多

---

## P2：EntryLifecycleFSM
### 目标
替代当前隐式组合：
- `url`
- `downloaded_ok`
- `entry_type`
- `musics`

建立一个显式 lifecycle。

### 为什么第二阶段做
因为 TaskFSM 搭起来后，entry 的下载/更新/分析过程更容易映射成显式生命周期。

---

## P3：PlaybackFSM + `selectedListName` 拆分
### 目标
把：
- 当前查看列表
- 当前编辑锚点
- 当前播放列表
从一个字段里拆开。

### 为什么第三阶段做
因为 playback 是高耦合区域，最好在任务/entry 状态已经清楚后再动，否则调试非常难。

---

## P4：统一 persistSlot create/edit 保存语义
### 目标
让 create/edit 的保存行为一致。

### 为什么放后面
因为这一步会影响产品感知，容易牵涉 UI 反馈与任务状态展示，最好等 TaskFSM 建好后统一设计。

---

## P5：类型化后端任务事件 / processMsg 退场
### 目标
把字符串事件流升级成 typed task events。

### 为什么放偏后
因为它需要前后端一起动，且会波及 Specta 生成类型、前端事件绑定、UI 任务展示。

---

## 三、阶段化执行方案

---

# 阶段 0：修复语义破坏点（P0）

## 目标
先修掉已经确认的“会制造非法状态”的函数。

## 重点问题
### 问题 1：`recheck_folder()` 会把 metadata-backed entry 变成 `Local`
当前后端：
- `url` 保留
- `entry_type` 强制写 `Local`

这会制造非法组合：
- `url != null && entry_type = Local`

## 建议做法
### 后端
改 `src-tauri/src/domain/music/service.rs`
- `recheck_folder()` 不要强制写 `EntryType::Local`
- 优先级建议：
  1. 若根目录有 metadata，读 metadata 的 `entry_type/url`
  2. 否则保留传入 `entry` 的 `url/entry_type`
  3. 真正纯本地目录才落 `Local`

### 配套
改 `src-tauri/src/utils/file.rs`
- 暴露一个内部 helper：`read_entry_metadata(folder)` 已有，可直接复用

## 可选增强
给 metadata JSON 加：
- `schema_version`

例如：
```json
{
  "schema_version": 1,
  "url": "...",
  "entry_type": "WebList"
}
```

这样未来可以平滑扩展。

## 风险
- 极低
- 只影响 reload path
- 主要是要确认“以 metadata 为准”是否符合预期

## 验证
### 测试
- 增加 Rust 单测 / 集成测试：
  - 传入 metadata-backed folder entry，reload 后仍保持 web 类型

### 手工验证
- 下载 web list -> 形成 metadata 目录
- 本地 add 进 playlist
- 点击 Reload
- 确认 entry_type 不变、url 不丢

## 回滚边界
- 仅后端函数行为修正，可单独回滚

---

# 阶段 1：抽 TaskFSM（P1）

## 目标
统一所有“进行中任务 / 完成 / 失败”的前端状态。

## 现状问题
当前前端任务状态散落在：
- `linkReviews: string[]`
- `folderReviews: string[]`
- `weblistReviews: string[]`
- `processMsg: ProcessMsg | null`

这会导致：
- 状态分散
- 缺少任务 identity
- 无法表达 progress/error/result
- UI 只能靠 includes 查 key

## 目标结构
在 `src/flow/music/store.ts` 中新增：

```ts
type TaskKind =
  | "link-review"
  | "folder-reload"
  | "weblist-update"
  | "download"
  | "normalization";

type TaskStatus = "idle" | "running" | "success" | "error";

interface TaskRecord {
  id: string;
  kind: TaskKind;
  targetKey: string;
  status: TaskStatus;
  message?: string;
  error?: string;
  startedAt?: number;
  endedAt?: number;
}
```

并在 `MusicState` 中新增：

```ts
tasks: Record<string, TaskRecord>
```

## 迁移策略
### 第一步：建立兼容层，不删旧字段
- 保留 `linkReviews/folderReviews/weblistReviews/processMsg`
- 新增 `tasks`
- 写 adapter：
  - `useIsReview()` 可先从 `tasks` 派生
  - 旧字段先继续维护，直到 UI 全换完

### 第二步：让下列函数同时写新任务状态
改 `src/flow/music/store.ts`：
- `addLink`
- `reloadEntry`
- `updateWeblist`
- `ensureEvents` 中的 `processMsg/processResult`

## 建议新增 helper
- `startTask(kind, targetKey, message?)`
- `finishTask(...)`
- `failTask(...)`
- `clearTask(...)`
- `findRunningTask(kind, targetKey)`

## 对 UI 的第一轮影响
改 `src/components/music/info.tsx`
- “in progress” 判定先切到 `tasks`
- 但 UI 外观先不改，保持产品不变

## 风险
- 中等
- 主要风险是“双写一段时间”可能不同步

## 验证
### 测试
新增 store 单测：
- addLink/reloadEntry/updateWeblist 启动任务时 tasks 正确写入
- 成功/失败后 tasks 结束

### 手工验证
- 贴 link
- Reload entry
- Update web list
- 看 UI 按钮 loading 状态是否与以前一致

## 回滚边界
- 只新增状态与 adapter，不破坏旧逻辑
- 可整体回滚到旧 arrays 模式

---

# 阶段 2：EntryLifecycleFSM（P2）

## 目标
让 entry 的来源与生命周期不再靠隐式字段组合推理。

## 当前问题
entry 现在主要靠这些字段组合表达：
- `url`
- `downloaded_ok`
- `entry_type`
- `musics`

但这些字段组合不能稳定区分：
- 待下载
- 下载失败
- 已物化
- 需要更新
- metadata 重导入的 web-origin local-root entry

## 建议方案
### 2.1 不先改持久化 schema，先加前端派生模型
在 `src/flow/music/logic.ts` 或新增 `src/flow/music/entryLifecycle.ts`：

```ts
type EntrySource = "local" | "remote" | "imported-remote";
type EntryAvailability = "pending" | "ready" | "failed";
type EntryRefreshability = "reloadable" | "remote-updatable" | "static";

interface EntryLifecycleView {
  source: EntrySource;
  availability: EntryAvailability;
  canReload: boolean;
  canUpdateWeblist: boolean;
  hasSemanticMismatch: boolean;
}
```

提供：
- `deriveEntryLifecycle(entry)`

### 2.2 然后逐步把 UI 逻辑从 raw fields 切到 lifecycle view
改文件：
- `src/components/music/info.tsx`
- 可能还有列表展示相关组件

### 2.3 第二步才考虑后端 schema 明确化
等前端派生模型稳定后，再决定是否在 Rust `Entry` 上新增字段，例如：
- `origin_kind`
- `lifecycle_status`

我建议不要太早直接动 repo schema。

## 风险
- 中等偏低（先只做派生模型）
- 若直接改后端 schema，风险会明显升高

## 验证
- 单测 `deriveEntryLifecycle(entry)` 覆盖关键组合
- 标出非法组合检测（例如 `url!=null && entry_type=Local`）

## 回滚边界
- 纯派生层可完全回滚
- 不会影响现有数据

---

# 阶段 3：PlaybackFSM + 拆 `selectedListName`（P3）

## 目标
解决当前最核心的字段过载问题。

## 当前问题
`selectedListName` 同时承担：
- 当前浏览列表
- 当前编辑锚点
- 当前播放列表
- `updateWeblist` 的目标 playlist

这会使多个 transition 的定义域模糊。

## 建议分拆
在前端 `MusicState` 中逐步引入：

```ts
focusedListName: string | null;
editingListName: string | null;
playback: {
  listName: string | null;
  nowPlaying: Music | null;
  judge: Judge;
  epoch: number;
}
```

### 迁移策略
#### 第一步：兼容层双写
- 保留 `selectedListName`
- 同时新增 `focusedListName/editingListName/playback.listName`
- 用 adapter 保证旧代码不立刻崩

#### 第二步：先迁移明确的函数
改 `src/flow/music/store.ts`：
- `startPlayByList`
- `safeStop`
- `action.play`
- `action.next`
- `chooseAndPlayNextTask`
- `action.edit`
- `persistSlot`
- `updateWeblist`

#### 第三步：迁移 hooks
- `useCurList`
- `useCurPlay`
- `useJudge`
- `useIsPlaying`

#### 第四步：删 `selectedListName`
等 UI 全部切完再删。

## 额外建议
PlaybackFSM 可以先不强上 XState。
更现实的做法是：
- 保留 `PlaybackCoordinator`
- 把 playback state 收敛成一个嵌套对象
- 减少散落字段

## 风险
- 高于前两个阶段
- 因为会影响：
  - 播放逻辑
  - 编辑逻辑
  - updateWeblist 逻辑
  - hooks

## 验证
### 测试
重点增加：
- play / stop / next / unstar 相关单测
- mode 切换与 playback 不串状态

### 手工验证
- 播放 playlist
- 编辑 playlist
- update web list
- back/save/delete
- 检查是否还有“选中列表”和“正在播放列表”错位

## 回滚边界
- 最好分 2~3 个 PR 做
- 不建议一次提交全部拆分

---

# 阶段 4：统一 persistSlot 语义（P4）

## 目标
消除 create/edit 保存路径语义不一致。

## 当前问题
- create：同步等待后端 create 完成
- edit：本地乐观退出，然后后台 update

## 建议方案
### 方案优先级
我建议最终统一成：

### **统一为“先提交，再退出编辑态”**
原因：
- 对用户心智更稳定
- 和任务状态显示更一致
- 出错时不需要大范围 refresh 回滚 UI

但这要等 TaskFSM 先落地，因为需要好的“saving in progress”反馈。

## 实施方式
改 `src/flow/music/store.ts`：
- `persistSlot()` 内的 create/edit 分支统一
- 新增一个明确 saving task 或 saving state

可能新增字段：
```ts
savingMission: boolean;
```
或直接纳入 TaskFSM。

## 风险
- 中等
- 影响用户感知，但技术风险可控

## 验证
- 创建保存
- 编辑保存
- 失败路径
- 成功后是否都统一回到同一状态

## 回滚边界
- 局限在 persistSlot/save 逻辑，可单独回滚

---

# 阶段 5：类型化后端任务事件（P5）

## 目标
替代 `ProcessMsg { playlist, str }` 这种宽事件。

## 当前问题
`processMsg` 同时表示：
- downloading...
- analyzing...
- failed...

这使前端无法构建强类型任务 FSM。

## 建议协议
Rust 侧新增更明确的 event enum/struct（Specta 可导出）：

```rust
pub enum TaskEventKind {
    DownloadStarted,
    DownloadCompleted,
    DownloadFailed,
    AnalysisStarted,
    AnalysisProgress,
    AnalysisCompleted,
    AnalysisFailed,
}

pub struct TaskEvent {
    pub task_id: String,
    pub kind: TaskEventKind,
    pub playlist: String,
    pub target_key: String,
    pub message: Option<String>,
    pub current: Option<u32>,
    pub total: Option<u32>,
    pub error: Option<String>,
}
```

## 迁移策略
### 第一步：新增 event，不删旧 `ProcessMsg`
- 前端同时监听新旧事件
- TaskFSM 优先消费新事件
- UI 维持原样

### 第二步：把 download/normalization 流逐步切到新事件
改：
- `src-tauri/src/domain/music/service.rs`
- `src-tauri/src/domain/music/normalization.rs`
- `src-tauri/src/utils/ytdlp.rs`
- `src-tauri/src/lib.rs`
- `src/flow/music/store.ts`

### 第三步：删 `processMsg` / 简化旧兼容层

## 风险
- 中高
- 涉及 Specta 生成与前后端同步升级

## 验证
- dev 重新生成 commands.ts
- 前端任务展示与原行为一致
- 任务失败/成功可分辨

## 回滚边界
- 可保留旧 `ProcessMsg` 一段时间，兼容回滚

---

# 阶段 6：收尾清理 / 删除旧逻辑（P6）

## 目标
在前几阶段稳定后，真正删除旧字段与旧适配器。

## 可删除候选
### 前端
- `linkReviews`
- `folderReviews`
- `weblistReviews`
- `processMsg`（若新事件已完全替代）
- `selectedListName`（若已拆分）

### 后端
- 旧宽字符串任务事件
- 依赖老字段组合的判断逻辑

## 风险
- 中等
- 但此时应已建立完整替代层，风险可控

## 验证
- 全量测试
- 手工走主要用户流

---

## 四、建议的实际里程碑顺序

### Milestone 1：Invariant 修正
- 修 `recheck_folder` 语义
- metadata version（可选）
- 增加相关测试

### Milestone 2：TaskFSM 兼容层
- 新增 task registry
- addLink/reloadEntry/updateWeblist 接入
- UI 先只换 loading 来源

### Milestone 3：EntryLifecycle 派生层
- 新增 `deriveEntryLifecycle`
- UI 改为看 lifecycle view
- 增加非法组合检测测试

### Milestone 4：Playback state 拆分（第一段）
- 新增 `playback` 嵌套对象
- 双写 `selectedListName`
- 播放相关函数迁移

### Milestone 5：selectedListName 彻底退场
- editing / browsing / playback 分离
- hooks 迁移

### Milestone 6：统一 save 语义
- create/edit 一致化
- saving task 显式化

### Milestone 7：后端 typed task events
- 新事件协议
- 前后端双监听
- 删除旧 `processMsg`

### Milestone 8：清理旧状态字段
- 删 arrays / 删旧适配器 / 删过时判断逻辑

---

## 五、每阶段的验证策略

## 1. 单元测试优先
现有仓库已经有：
- `src/flow/music/store.interaction.test.ts`
- 逻辑测试
- Rust repo/normalization 测试

应继续按这个风格扩展。

### 前端重点测试
- playback guards
- task registry 状态变换
- entry lifecycle 派生
- save 流程一致性

### 后端重点测试
- metadata-backed reload 保持语义
- repo mutation invariant
- normalization partial success semantics

---

## 2. 用户流回归测试
每个里程碑至少手工跑这几条：

1. 新建 playlist + 本地文件夹导入 + 保存
2. 新建 playlist + web link 导入 + 保存 + 下载完成
3. 重新导入带 metadata 的目录
4. 编辑 playlist + Reload entry
5. 播放 / 下一首 / unstar / stop
6. Update web list
7. 首次启动 / 工具安装 / save path 修改

---

## 3. 编译/类型检查策略
每一阶段都至少跑：
- `bun run typecheck`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- 受影响的 bun test

若改了 Specta 导出的事件/命令：
- 需要走一次 `bun tauri dev` 触发生成
- 然后立刻结束进程

---

## 六、我对实施顺序的最终建议

如果按“收益 / 风险比”排序，我建议你真的执行时按下面顺序：

### 最佳执行顺序
1. **修 `recheck_folder`**
2. **TaskFSM 兼容层**
3. **EntryLifecycle 派生层**
4. **selectedListName 拆分 + Playback 子状态收敛**
5. **统一 save 语义**
6. **typed task events**
7. **删旧状态**

这是目前最贴合这个项目、最不容易把产品打坏的路线。

---

## 七、关键判断总结

- **不要先全盘 XState 化**，现在时机不对
- **先收敛任务状态**，收益最大、侵入最小
- **entry lifecycle 要先做派生模型，再决定是否动后端 schema**
- **播放状态拆分必须做，但不该是第一刀**
- **`persistSlot()` 统一语义应该在任务状态清楚之后做**
- **typed events 是后期清理和真正前后端一致的关键一步**

---

## 八、可直接执行的下一步

如果马上开干，我建议第一刀就做这个：

### 下一步实施任务
**Milestone 1：修复 `recheck_folder` 对 metadata entry 的语义破坏，并补测试。**

理由：
- 风险最小
- 价值明确
- 已经与当前新增 metadata 功能发生直接冲突
- 修完后能作为整个 FSM 重构的第一个“invariant 修复”样板
