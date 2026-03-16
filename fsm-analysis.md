# Slisic 前后端统一 FSM / 交互架构分析（完整深化稿）

> 本稿在前两版基础上，继续补充：
> 1. 关键函数统一模板表
> 2. 全程序非法状态全集（当前可枚举版本）
> 3. 更接近“整个程序”的总状态空间说明

---

## A. 全程序函数级 FSM 表（关键函数统一模板）

> 字段说明：
> - **所属 FSM**：该函数主要服务于哪个状态机
> - **输入定义域**：函数正常语义成立时允许的输入状态/参数范围
> - **输出值域**：函数执行后可能落入的状态集合
> - **副作用**：命令、持久化、事件、toast、文件系统等
> - **非法状态风险**：该函数最容易制造或传播的不合理状态

---

### 1. App / Bootstrap / Updater

| 函数 | 所属 FSM | 输入定义域 | 输出值域 | 副作用 | 非法状态风险 |
|---|---|---|---|---|---|
| `useBootstrapDecision()` | AppBootstrapFSM | App 首次渲染 | `pending / resolved / error` 派生决策 | 调 `crab.getWindowKind()` | `error -> still start app` 可能掩盖 prewarm 问题 |
| `deriveBootstrapDecision(state)` | AppBootstrapFSM | `pending/error/resolved` | `shouldRenderApp/shouldStartApp` | 无 | 失败即继续的容错语义可能过宽 |
| `ensureUpdaterStarted()` | UpdaterFSM | 任意，但应只启动一次 | actor started | 启动 XState actor | 无明显非法状态 |
| `action.run()`（updater） | UpdaterFSM | actor 已启动 | `idle -> check -> ok/err` | 调 updater plugin | `ok` 是 final，长期运行时不再复查 |
| `checkForUpdate()` | UpdaterFSM | Tauri updater 可用 | `available / up_to_date` | download, install, relaunch toast | 下载完成但用户不重启时状态无后续显式表达 |

---

### 2. Music store 基础函数

| 函数 | 所属 FSM | 输入定义域 | 输出值域 | 副作用 | 非法状态风险 |
|---|---|---|---|---|---|
| `setState(next)` | 全局前端状态 | 任意 | 任意 `MusicState` | emit listeners | 可直接制造任意非法组合 |
| `patchState(patch)` | 全局前端状态 | 任意 partial | 局部修改态 | emit listeners | 局部字段合法但组合非法 |
| `patchSlot(mutator)` | EditingMissionFSM | `slot != null` | 仅替换 slot | emit listeners | `mode != create/edit` 时仍可存在 slot 修改 |
| `refreshLists()` | WorkspaceFSM | repo 可读 | playlists 刷新，模式派生 | `crab.readAll()` | 回拉覆盖本地乐观态 |
| `refreshTools()` | ToolingFSM | 工具命令可访问 | `ytdlp/ffmpeg/savePath` 刷新 | `checkExists/ffmpegCheckExists/resolveSavePath` | 无显式 checking/installing 状态 |
| `ensureEvents()` | 事件桥接 FSM | 一次性初始化时 | listeners registered | 订阅后端事件 | processMsg/processResult 过于泛化 |

---

### 3. Music 初始化 / 生命周期函数

| 函数 | 所属 FSM | 输入定义域 | 输出值域 | 副作用 | 非法状态风险 |
|---|---|---|---|---|---|
| `action.run()`（music） | WorkspaceFSM | bootstrap 允许启动 app | `Initializing -> Ready / PartialFailed` | appReady, refreshTools, bootstrapNormalization, refreshLists | 部分初始化成功但 `initialized=false` |
| `action.dispose()` | WorkspaceFSM / PlaybackFSM | 组件卸载 | 停止运行态、取消订阅 | interruptCurrent, unsub events | 不清空全部业务状态，可能保留旧上下文 |

---

### 4. Playback 相关函数

| 函数 | 所属 FSM | 输入定义域 | 输出值域 | 副作用 | 非法状态风险 |
|---|---|---|---|---|---|
| `bumpPlaybackEpoch()` | PlaybackFSM | 任意 | `epoch+1` | patchState | 只是 token，不是真状态 |
| `isPlaybackContextActive(epoch, expectedList?)` | PlaybackFSM | 任意 snapshot | bool | 无 | 只能判断局部 invariants |
| `safeStop()` | PlaybackFSM | 任意 | 前端清空播放上下文 | interruptCurrent, `audioStop` | 前端先停、后端未必真停 |
| `startPlayByList(name)` | PlaybackFSM | playlist 名存在或用户触发 | toggle stop / prepare session | scheduleNextPlayback | `selectedListName` 过载 |
| `chooseAndPlayNextTask(epoch)` | PlaybackFSM | `mode=play && selectedListName!=null && epoch active` | no-op / clear / optimistic chosen / rollback | `audioPlay` | `nowPlaying` 先写后播，乐观播放态 |
| `scheduleNextPlayback(epoch)` | PlaybackFSM | 任意 epoch | 替换 fiber | replaceWith | 没有显式 queued state |
| `action.next()` | PlaybackFSM | `mode=play && list selected` | 进入下一曲流程 | fatigue + scheduleNextPlayback | “下一首”默认施加 fatigue |
| `action.play(playlist)` | PlaybackFSM | playlist 存在 | same as `startPlayByList` | see above | 同上 |
| `shouldHandleAudioEnded(...)` | PlaybackFSM guard | `mode/list/nowPlaying` | bool | 无 | guard 只覆盖一部分竞态 |
| `shouldAdvanceOnUnstar(...)` | PlaybackFSM guard | 当前 list/music 上下文 | bool | 无 | 播放切换逻辑与排除逻辑耦合 |
| `action.unstar(music)` | PlaybackFSM + PlaylistFSM | currentList 存在 | 乐观排除 + 可能切歌 | audioStop, repo unstar, refreshLists on fail | 同时改播放和列表，耦合高 |

---

### 5. Editing / Mission 相关函数

| 函数 | 所属 FSM | 输入定义域 | 输出值域 | 副作用 | 非法状态风险 |
|---|---|---|---|---|---|
| `defaultMission()` | EditingMissionFSM | 无 | 空 mission | 无 | 无 |
| `missionFromPlaylist(playlist)` | EditingMissionFSM | playlist snapshot | edit mission | 无 | mission identity 依赖 playlist 当前快照 |
| `action.addNew()` | EditingMissionFSM | 任意 | `NoMission -> CreatingMissionClean` | safeStop | 无脏状态标记 |
| `action.edit(playlist)` | EditingMissionFSM | playlist 存在 | `NoMission -> EditingMissionClean` | safeStop | `selectedListName` 被当作编辑锚点 |
| `action.back()` | EditingMissionFSM | 任意，但 review 不在进行中 | `Editing -> Browsing` | safeStop | 无 unsaved changes guard |
| `setSlot(slot)` | EditingMissionFSM | 任意 slot | 强行替换 mission | patchState | 可把不合法 mission 直接写入 |
| `canPersistMission(slot)` | EditingMissionFSM guard | mission/null | `ok/err` | 无 | 只校验最低条件 |
| `persistSlot()` | EditingMissionFSM | `slot != null`, no review, mission valid | create/edit 分叉保存流程 | create/update, refreshLists, stop, toast | create/edit 语义不对称 |
| `action.save()` | EditingMissionFSM | 同 persistSlot | 同 persistSlot | 同 persistSlot | 同 persistSlot |
| `buildOptimisticPlaylistFromSlot(slot, anchor?)` | EditingMissionFSM | mission | optimistic playlist | 无 | 不代表后端最终真相 |
| `applyOptimisticEditSave(...)` | EditingMissionFSM | anchor 在 playlists 中 | 替换后的 local playlists | 无 | 仅 edit 路径使用，create 不对称 |
| `deriveRefreshPatch(...)` | WorkspaceFSM | playlists snapshot | 新 mode/selection/nowPlaying | 无 | 规则简单但覆盖隐式状态丰富 |
| `buildPostSavePatch(...)` | EditingMissionFSM | hasData + idleEpoch | 退出编辑态 patch | 无 | 依赖调用方保证 context 完整 |

---

### 6. Entry 导入 / 编辑相关函数

| 函数 | 所属 FSM | 输入定义域 | 输出值域 | 副作用 | 非法状态风险 |
|---|---|---|---|---|---|
| `action.addFolder(path)` | EntryIngestionFSM | `slot!=null`, path 非空 | `folders += ...` 或 `entries += ...` | `collectImportFolderEntries` | 同动作多值域，语义分叉 |
| `mapImportFolderEntryToEntry(item)` | EntryLifecycleFSM | metadata-backed folder result | web-origin or local entry object | 无 | 仅靠 item.url 决定分支，没更深 invariant |
| `action.removeFolder(path)` | EditingMissionFSM | path 在 folders 中 | folders 删除 | 无 | 若 path 同时对应 entry 无联动 |
| `action.addLink(url)` | LinkReviewFSM | `slot!=null`, valid url, not dup | pending -> reviewed ok/err | `lookMedia` | link.status 和 linkReviews 双重表示状态 |
| `action.removeLink(url)` | LinkReviewFSM | url 存在 | 移除 link | 无 | review 中删除只是不回写，不是真取消 |
| `action.toggleLinkTracking(url)` | LinkReviewFSM | url 存在 | tracking 取反 | 无 | tracking 与下载生命周期无统一建模 |
| `action.addExistingEntry(entry)` | EditingMissionFSM | `slot!=null` | entries append if not dup | 无 | identity 依赖 `entryKey` |
| `action.removeEntry(entry)` | EditingMissionFSM | entry exists | entries remove | 无 | 仅删 mission，不处理 related folder state |
| `action.removeExclude(path)` | EditingMissionFSM | path exists in exclude | exclude remove | 无 | 无明显问题 |
| `action.reloadEntry(entry)` | FolderReloadFSM | `entry.path!=null` | reloading -> updated/failed | `recheckFolder` | 后端可能把语义洗成 Local |
| `action.updateWeblist(entry)` | WeblistUpdateFSM | `selectedListName!=null && entry.url!=null` | updating -> updated/failed | `updateWeblist` | 目标 playlist 依赖 overloaded `selectedListName` |

---

### 7. Taste / preference 相关函数

| 函数 | 所属 FSM | 输入定义域 | 输出值域 | 副作用 | 非法状态风险 |
|---|---|---|---|---|---|
| `applyNextFatigue(music)` | TasteFSM | music 非空 | fatigue +0.1 | `crab.fatigue` | 与 skip/ended 语义绑定需确认 |
| `action.up(music)` | TasteFSM | music 存在 | user_boost +=0.1 | repo update | 无显式上限状态，只是 clamp |
| `action.down(music)` | TasteFSM | music 存在 | fatigue +=0.1, boost -=0.1 | repo update | `down` 同时改变两个维度 |
| `action.cancleUp(music)` | TasteFSM | music 存在 | boost -=0.1 | repo update | 命名不稳定 |
| `action.cancleDown(music)` | TasteFSM | music 存在 | fatigue -=0.1 | repo update | 命名不稳定 |
| `action.resetLogits()` | TasteFSM | 任意 | 所有 music logits reset | repo reset + refreshLists | 广播更新，可能很重 |

---

### 8. Tooling / config 相关函数

| 函数 | 所属 FSM | 输入定义域 | 输出值域 | 副作用 | 非法状态风险 |
|---|---|---|---|---|---|
| `action.installYtdlp()` | ToolingFSM | 任意 | unavailable -> available / fail | download/install binary | 无 installing 中间态 |
| `action.installFfmpeg()` | ToolingFSM | 任意 | unavailable -> available / fail | download/install binary | 同上 |
| `action.updateSavePath(path)` | ToolingFSM / GlobalConfigFSM | path 合法 | savePath 更新 | persisted config update | 改变未来 entry path identity 生成规则 |

---

### 9. Rust `service.rs`

| 函数 | 所属 FSM | 输入定义域 | 输出值域 | 副作用 | 非法状态风险 |
|---|---|---|---|---|---|
| `create(app, data)` | PlaylistPersistFSM + IngestionFSM + NormalizationFSM | mission valid | playlist persisted + local analysis + deferred downloads launched | repo.create, analyze, spawn_downloads | “create 成功”不代表所有任务完成 |
| `update(app, data, anchor)` | PlaylistPersistFSM + IngestionFSM + NormalizationFSM | anchor exists | playlist replaced + analysis + deferred downloads | repo.replace, analyze, spawn_downloads | replace 是全量快照替换 |
| `delete(name)` | PlaylistPersistFSM | playlist exists | playlist removed | repo.delete | 若当前播放/编辑引用未同步处理会悬空 |
| `delete_music(music)` | RepoMusicFSM | path exists/任意 | 全局删 path | repo remove_music_by_path | path 是全局 identity 假设 |
| `fatigue/boost/cancle_*` | TasteFSM | music path exists/任意 | 全局更新该 path music | repo.update_music_by_path | 广播更新隐含“同路径即同实体” |
| `unstar(list, music)` | PlaylistExcludeFSM | playlist exists | exclude += music | repo.add_exclude | 与前端乐观切歌耦合 |
| `rmexclude(list, music)` | PlaylistExcludeFSM | playlist exists | exclude remove | repo.remove_exclude | 无明显问题 |
| `recheck_folder(app, entry)` | FolderReloadFSM | `entry.path!=null` | updated entry + reanalysis | scan dir, update repo, analyze | **强制 entry_type=Local** |
| `update_weblist(app, entry, playlist)` | WeblistUpdateFSM | `entry.url!=null`, playlist exists | updated materialized entry | download, upsert, analyze, emit ProcessResult | 巨型复合 transition |
| `spawn_downloads(app, playlist, pending)` | BackgroundTaskFSM | pending 非空 | queued -> downloading -> success/fail | event emit, repo upsert, analyze | 无 typed task id |
| `build_playlist_from_mission(...)` | CompilerFSM（mission -> durable snapshot） | 任意 mission | `(Playlist, pendingEntries)` | 无直接 IO | durable state 与 runtime queue 混合输出 |
| `normalize_existing_entry(...)` | EntryNormalizeFSM | any entry | normalized existing entry | 无 | 传播上游非法组合 |
| `normalize_folder_entry(...)` | EntryNormalizeFSM | local folder sample | Local entry | maybe rescan | 较干净 |
| `normalize_link_entry(...)` | EntryNormalizeFSM | reviewed/partially-reviewed link | remote pending entry | 无 | `Unknown -> WebVideo` 默认塌缩 |
| `load_music_index_if_needed(...)` | Helper | mission | index or empty map | repo read | 只按 mission.folders 判断是否加载，remote entries 不触发 |

---

### 10. Rust `repo.rs`

| 函数 | 所属 FSM | 输入定义域 | 输出值域 | 副作用 | 非法状态风险 |
|---|---|---|---|---|---|
| `snapshot()` | RepositorySnapshotFSM | repo initialized | playlists snapshot | store load | 无 |
| `music_index()` | RepositorySnapshotFSM | repo initialized | path -> music map | store load | 多 playlist 同 path 合并 |
| `read_playlist(name)` | RepositorySnapshotFSM | name exists | playlist | store load | not found error |
| `create_playlist(playlist)` | RepositoryMutationFSM | name unique | snapshot appended | save data | 无 |
| `replace_playlist(anchor, playlist)` | RepositoryMutationFSM | anchor exists | snapshot replaced | save data | 全量替换、非增量 |
| `delete_playlist(name)` | RepositoryMutationFSM | name exists | snapshot removed | save data | 无 |
| `upsert_entry_in_playlist(name, entry)` | RepositoryMutationFSM | playlist exists | entry replace-or-insert | save data | identity 依赖 path/url/name |
| `update_entry_everywhere(entry)` | RepositoryMutationFSM | any entry | all matching slots replaced | save data | 广播污染风险 |
| `update_music_by_path(path, updater)` | RepositoryMutationFSM | path | all matching musics updated | save data | 广播污染风险 |
| `update_music_batch(musics)` | RepositoryMutationFSM | list of musics | batch updated | save data | partial semantics 不显式 |
| `remove_music_by_path(path)` | RepositoryMutationFSM | path | all matching musics removed | save data | 全局影响大 |
| `add_exclude/remove_exclude` | RepositoryMutationFSM | playlist exists | exclude set changed | save data | 无明显问题 |
| `reset_logits()` | RepositoryMutationFSM | 任意 | global reset | save data | 粗粒度广播 |
| `mutate(mutator)` | RepositoryMutationFSM core | any closure | saved snapshot | write lock + save | 闭包内可制造任意非法数据 |
| `init_repository(app)` | RepositoryBootstrapFSM | startup | repo initialized | open store, import legacy | singleton init 语义 |
| `bootstrap_from_legacy_json_if_needed(...)` | RepositoryBootstrapFSM | empty current store | imported or no-op | read legacy json | 旧数据迁移策略单向 |
| `prepare_legacy_data_for_store(data)` | DataRepairFSM | legacy snapshot | repaired snapshot | recompute/dedup | 修复范围有限 |

---

### 11. Rust `normalization.rs`

| 函数 | 所属 FSM | 输入定义域 | 输出值域 | 副作用 | 非法状态风险 |
|---|---|---|---|---|---|
| `bootstrap_library_normalization(app)` | NormalizationFSM | repo ready | stale paths analyzed | analyze blocking | 启动期耦合过强 |
| `analyze_paths_blocking(app, paths, playlist, label)` | NormalizationTaskFSM | paths list | `Ok(total)` / `Err(first_error)` | emit progress, batch persist | 返回值无法表达部分成功 |
| `resolve_playback_normalization(app, path)` | PlaybackNormalizationFSM | path string | target/integrated/tp tuple | repo read | path 不存在时依赖 current index/default music |
| `collect_stale_paths(playlists)` | StalenessFSM | playlists snapshot | stale paths | none | 无 |
| `dedup_paths(paths)` | Helper | any paths | deduped paths | none | 无 |
| `analysis_parallelism_for(cpu,total)` | ResourceFSM | cpu/total >=1 | concurrency value | none | 无 |
| `flush_analysis_batch(batch)` | PersistBatchFSM | batch maybe empty | saved/no-op | repo batch update | error only first/whole-level |
| `spawn_analysis_task(...)` | TaskSpawnFSM | queue item | in-flight worker | tokio task | 无 explicit task ids |
| `is_analysis_fresh(music)` | StalenessGuardFSM | music | bool | filesystem stat | 文件缺失即 stale |
| `refresh_analysis_for_path(app,music)` | PerTrackNormalizationFSM | file exists | Ready or Failed music | ffmpeg analyze | 失败会抹掉旧分析值 |
| `source_fingerprint(path)` | Helper | path exists | `(mtime,size)` | fs metadata | 无 |

---

### 12. Rust `ytdlp.rs` / `file.rs` / `ffmpeg.rs`

| 函数 | 所属 FSM | 输入定义域 | 输出值域 | 副作用 | 非法状态风险 |
|---|---|---|---|---|---|
| `look_media(app,url)` | LinkReviewFSM backend | valid url | MediaInfo | yt-dlp metadata fetch | unknown item_type fallback 偏保守 |
| `download_entry_for_library(...)` | EntryMaterializationFSM | `entry.url!=null` | DownloadOutcome | yt-dlp, fs, metadata write | path identity 受 savePath/playlist/name 影响 |
| `spawn_ytdlp_auto_update(app)` | ToolingFSM | startup | detached update attempt | install/update ytdlp, emit version changed | 后台静默更新策略 |
| `collect_import_folder_entries_inner(folder)` | FolderImportFSM | folder exists | local folder import or metadata entry groups | fs scan, metadata read | 根目录同时含普通音频和 metadata 子目录时语义固定为优先子目录 |
| `write_entry_metadata(folder,metadata)` | MetadataFSM | folder writable | metadata persisted | fs write | 无版本号字段，未来 schema 演化弱 |
| `read_entry_metadata(folder)` | MetadataFSM | folder path | none/some metadata | fs read | metadata 损坏直接报错 |
| `ffmpeg_check_exists/check_update/download_and_install` | ToolingFSM | 任意 | exists/check/install result | http, archive, fs | 无 installing 态 |
| `ensure_ffmpeg(app)` | ToolingGuardFSM | app context | ffmpeg path / error | PATH or bundled lookup | 工具来源（bundled/system）语义未显式暴露 |

---

### 13. Rust `audio/mod.rs`

| 函数 | 所属 FSM | 输入定义域 | 输出值域 | 副作用 | 非法状态风险 |
|---|---|---|---|---|---|
| `engine_slot()` | AudioEngineFSM | singleton runtime | sender slot | global OnceLock | 无 |
| `spawn_engine(app)` | AudioEngineFSM | app context | tx sender | spawn thread | crash recovery depends on reset path |
| `ensure_engine(app)` | AudioEngineFSM | app context | existing/new sender | maybe spawn thread | engine singleton 与 app lifecycle 松耦合 |
| `run_engine_loop(app,rx)` | AudioEngineFSM core | receiver alive | loop over engine states | emit AudioState/AudioEnded | runtime state only partially exposed to frontend |
| `audio_play(app,req)` | PlaybackFSM backend | playable path | play ack/error | normalization resolve + send cmd | 播放和归一化耦合 |
| `audio_pause/resume/stop/status` | PlaybackFSM backend | engine available | pause/resume/stop/status | send cmd | frontend并未完整消费 status 作为真源 |
| `emit_state_and_maybe_end(...)` | AudioEngineFSM | state | emitted current status / maybe ended | emit events | 事件是后端真相，但前端没有完全采用 |

---

## B. 全程序非法状态全集（当前可枚举版本）

> 这里列的是“从系统语义看不合理 / 极可能是 bug / 应尽量禁止”的状态组合。
> 有些当前代码已经可能产生；有些是潜在风险；有些则应在未来 FSM 化时明确禁止。

---

## B1. 前端 Workspace / Editing 非法状态

### 编辑态不变量相关
1. `mode = edit && slot = null`
2. `mode = create && slot = null`
3. `mode = play && slot != null`（若非明确允许后台保留编辑稿）
4. `mode = new_guide && playlists.length > 0`
5. `mode = play && playlists.length = 0 && selectedListName != null`

### 选择态不变量相关
6. `selectedListName != null && playlists 中不存在该 name`
7. `nowPlaying != null && selectedListName = null`
8. `nowPlaying != null && mode != play`
9. `nowJudge != null && nowPlaying = null`
10. `mode = edit && nowPlaying != null`

### 初始化不变量相关
11. `initialized = false && 事件监听已经建立`
12. `loading = false && run 尚未完成但部分数据已加载`
13. `initialized = true && ytdlp/ffmpeg/savePath 全部未知，但 UI 仍假定工具检查完成`

---

## B2. 任务 / review 非法状态

14. `link.status = Ok 但 linkReviews 仍包含该 url`（完成态与进行中态重叠）
15. `link.status = Err 但 linkReviews 仍包含该 url`
16. `folderReviews 包含某 path，但 slot.entries 中已无该 path 对应 entry`
17. `weblistReviews 包含某 url，但 slot.entries 中已无该 url 对应 entry`
18. `hasReviewInProgress = false 但某个异步任务实际上仍未结束`

这些都来自“任务状态分散存储”。

---

## B3. Entry 语义非法状态

19. `entry.url = Some(...) && entry.entry_type = Local`
20. `entry.url = None && entry.entry_type in {WebList, WebVideo}`
21. `entry.downloaded_ok = Some(true) && entry.musics = []`
22. `entry.downloaded_ok = Some(false) && entry.musics 非空但已可播放`（语义模糊）
23. `entry.path = None && entry.musics 非空`（通常意味着物化了但没有根路径）
24. `entry.path = Some(...) && entry.name 为空/仅空白`
25. `entry.entry_type = Unknown && entry.downloaded_ok = Some(true)`
26. `entry.entry_type = WebList && entry.url = None`
27. `entry.entry_type = WebVideo && musics.len() > 1` 若产品不允许该语义
28. `entry.tracking = Some(true) && entry.url = None`

其中 **19** 是当前最关键的实际风险项。

---

## B4. Metadata 导入相关非法状态

29. metadata 文件存在，但：
   - `url = ""`
   - `entry_type = Local`
30. metadata 根目录无音频文件，但被当作有效 imported entry
31. 用户添加大根目录，里面既有普通音频又有 metadata 子目录，而系统只导入 metadata 子目录，导致普通音频被静默忽略（这不一定是 bug，但应定义）
32. metadata 与目录实际内容语义冲突：
   - metadata says `WebVideo` 但目录里有很多音频
   - metadata says `WebList` 但目录里只有单曲

这些属于“语义不一致状态”，未必一定禁止，但应该有修正策略。

---

## B5. Playback 非法状态

33. 前端 `nowPlaying = X` 但后端 `audio_status.path != X`
34. 前端认为播放中（`selectedListName && nowPlaying`），但后端实际 stopped
35. `playbackEpoch` 已变化，但旧的 play 结果仍回写当前状态
36. `selectedListName != null` 但当前列表所有 playable tracks = 0，且 UI 仍显示好像在可播放状态
37. `nowJudge != null` 属于上一曲，但 `nowPlaying` 已切到下一曲
38. `mode != play` 但 `PlaybackCoordinator.isActive(...) = true`（理论上 guard 应防住）
39. `safeStop()` 后后端 stop 失败，但前端未回滚，造成长期错位

---

## B6. Playlist / repo 快照非法状态

40. 同一个 playlist 中存在两个 `entryKey` 相同的 entry
41. playlist `avg_db` 与 entries 实际平均值不一致
42. entry `avg_db` 与 musics 实际平均值不一致
43. exclude 中 music path 不存在于系统任何 entry，但 UI 仍假定可恢复上下文
44. `selectedListName` 指向已删除 playlist
45. 某 playlist 被 replace 后，前端 slot 仍基于旧 anchor 继续编辑

---

## B7. Normalization 非法状态

46. `normalization_status = Ready` 但 `integrated_lufs = None`
47. `normalization_status = Ready` 但 `true_peak_dbtp = None`
48. `analysis_version = current` 但 source fingerprint 不匹配
49. `normalization_status = Failed` 但 `normalization_error = None`
50. 分析失败覆盖掉 last known good 数据，导致回退能力缺失
51. `bootstrapNormalization` 部分成功，但前端只看到整体 error

---

## B8. Tooling 非法状态

52. `ffmpeg = null` 但实际上系统 PATH 有 ffmpeg，只是前端未 refresh
53. `ytdlp = null` 但后台 auto update/install 已完成，前端未 refresh
54. 用户点击 install 多次，实际并发安装，但前端没有 installing guard
55. `savePath` 已更新，但旧 entry path identity 仍被新逻辑误认为同一族资源

---

## B9. 事件协议非法状态

56. `processMsg` 表示的任务与当前 UI 上展示的任务不是同一个对象
57. `processResult` 到来时，前端无法知道是哪一个 entry 完成，只能全量 refresh
58. `AudioEnded` 到来时，对应 track 已经不是当前 playback session 的成员
59. `YtdlpVersionChanged` 到来时，前端工具状态仍停留旧值

---

## C. 更接近“整个程序”的总状态空间模型

如果把上面的函数和非法状态综合，可以把程序当前真实运行空间理解成：

### C1. 顶层系统状态
- `AppHiddenPrewarm`
- `AppBootstrapping`
- `AppReady`
- `AppPartiallyReady`

### C2. Workspace 状态
- `NoLibrary`
- `BrowsingLibrary`
- `EditingMission`
- `PersistingMission`
- `ReconcilingAfterPersist`

### C3. Playback 子状态
- `Idle`
- `PreparingContext`
- `SelectingTrack`
- `StartingTrack`
- `Playing`
- `Paused`
- `Stopping`
- `OutOfSync`

### C4. Entry 子状态（每个 entry）
- `LocalDraft`
- `RemoteDraft`
- `RemoteReviewed`
- `PersistedPendingDownload`
- `Downloading`
- `Downloaded`
- `Analyzing`
- `Ready`
- `Failed`
- `SemanticallyCorrupted`

### C5. Tooling 子状态
- `Unknown`
- `Checking`
- `Unavailable`
- `Installing`
- `Available`
- `InstallFailed`

### C6. Repo 一致性子状态
- `SnapshotStable`
- `LocallyOptimistic`
- `BackendMutating`
- `Reconciled`
- `PartiallyFailed`

最关键的一点是：
**当前代码没有显式区分 `SnapshotStable`、`LocallyOptimistic` 和 `Reconciled`。**
这就是为什么很多地方需要 `refreshLists()` 作为兜底。

---

## D. 当前最值得优先修复/重构的 10 个点

1. `recheck_folder()` 保留 metadata 语义，不要强制改成 `Local`
2. 把 `selectedListName` 拆成：
   - `focusedListName`
   - `playbackListName` 或 `playbackSession.listName`
3. 把 `processMsg` / review arrays 重构为统一 task registry
4. 把 `downloaded_ok/url/musics/entry_type` 提升为显式 entry lifecycle enum
5. 统一 `persistSlot()` 在 create/edit 下的保存语义
6. 给工具安装引入 `installing` 状态
7. 前端定期/关键点用 `audio_status` 校正播放真相
8. 将 `processResult` 从“全局 refresh trigger”改为“typed task completion event`
9. 给 metadata json 加 schema/version 字段
10. 给 mission 增加 dirty state，避免 `back()` 无提示丢失修改

---

## E. 建议的下一轮深化方向

如果还要继续往“整个程序完整 FSM”走，下一轮最合适的是：

1. **把这些函数表继续扩展到更多辅助函数**（例如 logic.ts、window 状态、bootstrap 更多细节）
2. **正式画状态图**：
   - 使用 Mermaid / PlantUML
   - 按 App / Workspace / Entry / Playback / Task 五层画
3. **建立 invariant checklist**，并逐条映射到代码里的 guard 或缺失 guard
4. **选 1 个 FSM 先做重构蓝图**，建议从 TaskFSM 或 EntryLifecycleFSM 开始

---

## F. 与前一版结论的合并说明

前面版本中关于：
- create/edit 保存不对称
- `selectedListName` 过载
- `recheck_folder` 语义破坏
- `processMsg` 泛化
- playback 与 backend 真源重复建模

这些结论在本版中都得到了更细化的函数级支撑，没有被推翻，反而更明确了。
