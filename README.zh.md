# dsh-codex-style-computer-use · Codex 风格桌面操控

给 **DeepSeek Harness** 用的 Windows 桌面操控插件：18 个桌面工具加一个 Agent 激活入口，通过一个 C# worker
观察并驱动原生 Windows 应用。发布包已包含编译好的原生组件，无需安装 PowerShell 7、SDK 或执行编译命令。

[English](README.md) | 中文

仅支持 Windows（`os: win32`）。需要 Node.js ≥ 22 与 Windows 自带的 .NET Framework 4.x。

**1.2.1 提醒修复：**补齐 crypto 导入，修复 1.2.0 原生 `probe` / `raise` 请求还未发送就抛错的问题。这次是运行时代码修复，需要从 1.2.0 更新；重复安装 1.2.0 无效。新版本先发布到 npm 的 `next`，再提升为 `latest`，市场普通更新跟随 `latest`。详见 [1.2.1 验证和发布状态](docs/RELEASE-1.2.1.md)。

## 它能做什么

- **观察** —— 窗口列表、截图（区域 / JPEG / PNG / 降采样）、可点元素的 Set-of-Marks 编号图，
  以及带精确 `AutomationId` 的 UI Automation 树。
- **操作** —— 点击、移动、拖拽、滚动、选中文本区间、键入、按键，并可走控件**自身的 UI
  Automation 模式**，而不是盲猜坐标。
- **批量** —— 一次 `computer_batch` 串行执行一组动作，遇错即停，因此一段已知流程只花一轮模型往返。
- **提问** —— `computer_ask` 把问题发到 DSH 与 `ask_user_question` 相同的那张聊天卡片上，且没有倒计时。
- **能传到模型的人为刹车** —— 停止事件被推入正在运行的会话，agent 当场知道自己被打断，
  而不是等到下一轮才发现。

工具读的是桌面，不读你的文件。插件自己只写三处：worker 二进制
（`%LOCALAPPDATA%\dsh-computer-use\worker\`）、审计日志与截图（`$DSH_HOME/data/computer-use/`）。

## 在 dsh-market 安装和更新

市场收录同步后，搜索 **computer-use**，选择 **dsh-codex-style-computer-use**，作者 **ltmroberthk915**（npm 维护者 **ltmroberthk**），点击**安装**。以后通过市场的**更新**或**全部更新**安装符合宿主发布策略的版本。两份原生组件都已随包提供，无需 PowerShell 7、SDK 或构建白名单。

目录尚未同步时，可在 **设置 → 插件 → 添加插件** 输入 `dsh-codex-style-computer-use`。默认非严格 pnpm 11.7.0 配置可以直接安装这个已发布的包；宿主显式启用严格策略时，才可能需要按下节等待冷却。首次新增 bundle 在官方桌面端可热加载；确认工具与 skill 已出现即可使用。替换已经加载的版本、客户端界面未刷新或界面明确提示 **restart-required / 需要重启** 时，再从托盘完整退出 DSH 并重新打开。

### 发布未满 24 小时

默认非严格 pnpm 11.7.0 配置会自动记录单版本例外并完成安装；“这台能装”不能推断另一台也允许安装新版本。

只有在 `minimumReleaseAgeStrict: true`（或宿主显式启用严格冷却）、版本未满配置的冷却时间且没有匹配例外时，才会在插件代码运行前被拒绝。已实测在该策略下，裸包名、`dsh-codex-style-computer-use@1.2.0` 和 npm 的 tgz 下载地址都会报 `ERR_PNPM_NO_MATURE_MATCHING_VERSION`。在 pnpm 11.7.0 中，显式设置 `minimumReleaseAge: 1440` 也会启用严格行为，除非另行设置 `minimumReleaseAgeStrict: false`。重启 DSH、反复重装或安装 PowerShell 都不能解决严格策略的拒绝。官方桌面桥接不接受额外 pnpm 参数。

**如果被严格策略拦截，无需改配置的做法是等待该版本满冷却时间后，再安装或更新。** 1.2.0 的 npm 发布时刻为 2026-10-03 11:50:11.586（北京时间），24 小时门槛在 **2026-10-04 11:50:12** 后满足。自定义更长冷却或镜像同步延迟仍以宿主提示为准。默认非严格配置的用户安装本包不需要等待，也不需要手动修改配置。

若明确要在冷却期内安装，经确认后可在目标 profile 的 `pnpm-workspace.yaml` 中，将下面的**单个版本**合并进现有列表，再回到市场重试；不要覆盖原有项，也不需要把全局冷却设为 0：

```yaml
minimumReleaseAgeExclude:
  - dsh-codex-style-computer-use@1.2.0
```

默认 desktop 文件位于 `%USERPROFILE%\.dsh\profiles\desktop\pnpm-workspace.yaml`；设置过 `DSH_HOME` 时以实际目录为准。例外仅限这个版本，过了冷却可删除该项。

此前文档和发布检查修正没有改变 1.2.0 运行时，因此无需重装；**1.2.1 的原生提醒修复则需要更新版本**。某些安装路径重复添加同一来源会触发宿主的 `ambiguous-install`；重复安装 1.2.0 不会得到 1.2.1 的修复。

**已有本仓库旧 Git/tgz 版本：**在市场卸载旧的 **dsh-computer-use**，再安装 **dsh-codex-style-computer-use**。npm 上的无 scope 包 `dsh-computer-use` 属于另一仓库，不能用作本插件的更新。旧 Git 依赖不会因仓库改名自动迁移；完成这一次界面内迁移后，后续使用普通市场更新即可。原有 `computer_*` 工具名与 `computer-use` 设置命名空间保留。

**旧配置也要迁移：**先备份目标 profile 的 `cordis.patch.yml`，仅把 `id: computer-use` 覆盖项里的 `name: dsh-computer-use` 改为 `name: dsh-codex-style-computer-use`，保留整段 `config` 和 `disabled`。只保留设置命名空间并不足够：旧 name 不匹配时，DSH 会跳过覆盖项，连 `read-only`、`dryRun`、禁用状态也可能失效。不要全文替换其他插件或共享 home 层配置。可使用仓库的 `scripts/migrate-profile.mjs`：默认预览，`--apply` 才备份并原子写入，且会拒绝并发修改。

也可下载 [配置迁移工具](https://github.com/ltmroberthk915/dsh-computer-use/releases/download/v1.2.0/computer-use-profile-migration.zip)，解压后双击 `migrate-profile.cmd`。它自动寻找已安装的官方 DSH，使用 Windows 自带的 PowerShell 5.1 和 DSH 自带的 Node，修复默认 desktop profile；新包未安装或旧 bundle 仍在时会停止。它不改变发布冷却策略。自定义 profile 可通过 `migrate-profile.ps1 -ProfileDirectory <完整目录>` 预览，确认后追加 `-Apply`。

GitHub Release 仍提供 `dsh-computer-use.tgz`，供离线或手动安装。市场自动更新优先使用 npm 包。

网页版的命令行安装方式：

```sh
dsh plugin --profile web add dsh-codex-style-computer-use
```

桌面版排障必须使用**官方桌面自带的入口**。例如默认安装目录可这样查询：

```powershell
$CuDshInstall = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'
& "$CuDshInstall\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop why dsh-codex-style-computer-use
```

若安装在 D 盘等自定义位置，先将 `$CuDshInstall` 改成桌面快捷方式实际指向的安装目录。PATH 上旧 npm CLI 的 `dsh` 可能拒绝 desktop profile；不要把 `resources/runtime/bin` 加到全局 PATH，也无需自己安装 pnpm。GUI 安装仍是首选。

## 随包 skill

驱动类工具会被锁住，直到会话给出那句只存在于 `skills/computer-use/SKILL.md` 里的回执短语。
这是刻意的——没有任何工具层能"看见"模型是否读过文档，这是"先读规程再动手"最诚实的一种实现。

插件在宿主提供 skills 服务时通过 `ctx.skills.register()` 注册随包规程。服务缺失时，`computer_use_activate` 也能返回同一份规程、源文件绝对路径及当前 Agent 的工具列表。回执门禁和既有审批、刹车检查仍然有效。

## 1.2.0-rc.2 的人机共用输入

本预发布版采用“立即让权 → 持续输入 2 秒进入等待 → 静默 3 秒后继续”。等待由本地事件完成，不消耗模型轮询。中途被打断的写入先读回实际结果，避免重复执行。宿主取消任务时释放自动化实际按下的输入，不新增持续暂停。此前 DSH Pet 主窗口识别和原有置顶位恢复修复均保留。

已配置的 GLM 5.3 Max、GLM 5.3 Flash 和 DeepSeek Flash 通过受控续作协议测试；原生操作与实体热键另行验证。这些结果不代表任意真实桌面或视觉任务的成功率，详见[发布验证说明](docs/RELEASE-1.2.0-rc.2.md)。

## 1.1 的按需控制

- **按 Agent 加载：**未激活时暴露 `computer_use_activate`、`computer_ctrl`、`computer_ask`。成功读取 computer-use skill、确认规程或调用激活入口后，该 Agent 获得原有 18 个工具，加入口共 19 个。其他 Agent 和子 Agent 独立启用，支持原生调用和 Node `run_code`。激活本身不启动控制，也不释放人为刹车。
- **已观察的 UIA 目标：**指定窗口和 name/id 的聚焦查询默认生成 target 句柄。控件重建时，显式 `rebind:true` 才允许在同一窗口内进行唯一身份或语义匹配。上下文变化、歧义、扫描不完整时拒绝动作。宽查询需 `targets:true` 才生成恢复句柄，避免普通观察承担额外开销。
- **增量观察：**重复相同查询并传入上一 observation 的 `since`，返回新增、变化、删除及顺序信息。每 Agent 保留最近 64 份完整快照，`snapshot` 可取回确切的历史结果。缺少基线、范围变化、证据不完整或增量更大时自动回退全量。

保留的是提供器实际返回的完整字段，沿用原有提供器限制；历史快照不代替动作后的新验证。缓存上限和恢复边界见[详细协议](skills/computer-use/references/progressive-control.md)。

## 工具

| 分组 | 工具 |
|---|---|
| 激活 | `computer_use_activate` |
| 观察 | `computer_state` `computer_shot` `computer_marks` `computer_uia` |
| 操作 | `computer_click` `computer_move` `computer_drag` `computer_scroll` `computer_select` `computer_key` `computer_type` `computer_uia_act` `computer_window` `computer_clip` |
| 流程 | `computer_wait` `computer_batch` |
| 元 | `computer_ask` `computer_ctrl` |

`computer_marks` 返回屏幕上元素的编号列表；`computer_marks {shot:true}` 额外保存对应的标注图。`computer_shot` 返回普通截图，在支持图片输入的模型路由上直接附带图片。mark 是一次**快照
ID**：派发输入前会核对窗口身份与采样像素，因此过期的 mark 会被拒绝，而不是点到错误的位置。

## 审批模式

`automationMode` 在插件设置里配置，默认 `standard`：

| 模式 | 观察 | 操作 |
|---|---|---|
| `read-only` | 允许 | 拒绝 |
| `standard` | 允许 | 每个动作都经宿主审批卡确认 |
| `autonomous` | 允许 | 允许，高危动作仍需确认 |
| `unrestricted` | 允许 | 允许（worker 自身的失效保护与限速仍在） |

高危动作（关闭窗口、`alt+f4`、`win+r` 等）在任何模式下都要确认。
密码框通过 UI Automation 的 `IsPassword` 识别，默认拒绝输入。

## 安全模型

- **人机共用输入** —— 实体键盘、滚轮、鼠标移动或按钮操作立即让出控制。持续输入或按住键/按钮 2 秒进入自动等待；全部松开并静默 3 秒后，重新观察目标并继续已授权任务。短暂触碰也等待 3 秒静默。人操作时显示温和的淡黄色边缘渐变。
- **人工暂停** —— 只有实体 `Ctrl+Esc` 触发持续输入刹车，`Ctrl+Alt+R` 恢复。普通 Esc、打字、滚动、鼠标距离/频率和屏幕左上角不再触发这种暂停；显式提问、诊断暂停保持独立。
- **退出** —— `Ctrl+Alt+Q` 结束会话：覆盖层消失、监听全部拆除，后续注入被拒，直到之后某一轮重新开启。
- **刹车是关于机器的事实，不属于某一个进程** —— 闩锁状态落盘，每个 worker 都会遵守，包括之后从命令行启动的。
- **审计** —— 每次操作连同脱敏后的参数追加到 `$DSH_HOME/data/computer-use/audit.jsonl`。
- **插件级开关** —— `DSH_COMPUTER_USE_KILL=1` 让插件拒绝启动；`dryRun: true` 只模拟并记录。

## 配置

| 键 | 默认 | 含义 |
|---|---:|---|
| `automationMode` | `standard` | 审批模式（见上） |
| `progressiveTools` | `true` | 按 Agent 激活；设为 `false` 可保留原有 18 个全局工具 |
| `dryRun` | `false` | 只模拟操作并记录 |
| `maxActionsPerMinute` | `60` | 核心层操作限速 |
| `annotateMarks` | `true` | 在截图上绘制 Set-of-Marks 方框 |
| `workerExe` | `""` | 显式指定 worker 路径；留空则自动发现或编译 |
| `snapshotDir` | `""` | 截图目录；留空为 `$DSH_HOME/data/computer-use/shots` |

## MCP 服务

`mcp/` 是建立在同一核心之上的零依赖 MCP stdio 服务，供只讲 MCP、不讲 Cordis 的客户端使用：

```sh
node mcp/src/index.js
```

## 开发

发布者检查默认查询 npm 官方源。若本地无法访问，可用 `CU_REGISTRY` 为只读的 `check` 命令指定镜像；JSON 输出会注明 `registry` 和 `authoritative`。PowerShell 示例（只影响当前终端）：

```powershell
$env:CU_REGISTRY = 'https://registry.npmmirror.com'
node scripts/release-channel.mjs check 1.2.0
Remove-Item Env:CU_REGISTRY
```

退出码 `0` 表示通过发布者的 24 小时检查，`2` 表示仍在冷却，`1` 表示检查失败。网络失败不代表版本未发布，镜像也可能尚未同步。`promote` 会忽略 `CU_REGISTRY`，始终向 `https://registry.npmjs.org` 重新检查并写入 `latest`，因此需要能访问官方源，必要时使用 npm 的代理配置。本工具只供发布者使用，普通用户安装不需要运行它。详见 [发布流程](docs/RELEASE-1.2.0.md)。

仓库自带守卫套件，保护上面这些不变量——循环生命周期、提问/刹车协议、操作分类、skill 门禁，
以及随包 skill 的注册接线：

```sh
pwsh -NoProfile -ExecutionPolicy Bypass -File build/run-guards.ps1   # 全部守卫
node build/verify-tools-schema.mjs                                   # 工具 schema 加载守卫
```

工具定义走真实的 `@deepseek-ai/dsh-tools` DSL 编译，因此 schema 写错会在这里失败，
而不是在宿主重启时把整棵插件树带崩。部分守卫会编译原生 worker，仅 Windows 可跑。

## 许可

MIT —— 见 [LICENSE](LICENSE)。

---

## 已知限制与验收状态

详见 README.md 的 Known limitations 章节（四项均为 NOT VERIFIED / NOT EXECUTED / UNKNOWN，不含 PASS）。

---

## 上游项目、署名与改动说明

本仓库是**衍生作品**，并非原创项目。它以上述开源项目为起点，并针对 DeepSeek Harness
集成、安全加固与浏览器自动化工具面做了大量修改。

| 项目 | 值 |
|---|---|
| **上游项目** | https://github.com/ltmroberthk915/dsh-computer-use |
| **上游 npm 包** | `dsh-codex-style-computer-use` |
| **上游许可证** | MIT |
| **上游版权** | Copyright (c) 2026 ltmroberthk915 |
| **本仓库** | https://github.com/CXKSWEZA-eng/dsh-codex-style-computer-use |

上游 MIT 许可证原文完整保留在 [`LICENSE`](./LICENSE) 中（含原始版权持有者）。MIT 允许修改与
再分发，前提是保留版权与许可声明；保持 `LICENSE` 不变即满足该义务。

改动范围详见英文 README 的 “Scope of the changes made here” 一节。

`lib/core/worker.cs`、`mcp/` 与两个预编译 `.exe` 的第三方来源**未独立核实**；`.exe` 无版本
元数据且未纳入本仓库，使用前需从 `lib/core/worker.cs` 重新构建。
