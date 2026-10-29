# Fork 项目现状与跨机器交接

本文是新 Agent 接手本 fork 的入口。后文实机记录来自历史功能基线 `710aa9c`，不能替代当前版本验收。接手时分别核对 Git 源码提交、运行产物身份和 MCP 业务状态；上游 VERSION、fork 源码和本机进程不是同一个版本事实。

## Fork 维护与上游同步约定

### 远端、分支和运行版各自负责什么

| 对象 | 维护职责 |
| --- | --- |
| `origin` | 本 fork `pipiaha/BeefTV`，保存团队自己的源码与发布历史 |
| `upstream` | 官方 `glanderness/BeefTV`，用于获取官方改动、核对问题和提交贡献 |
| `origin/main` | fork 经评审和验收的稳定产品主线，包含已接受的 fork 能力；不能长期停在旧镜像而让使用者默认克隆到旧版 |
| `upstream/main` | 官方主线的远端跟踪引用；不把本机运行修补直接堆到这里 |
| 同步集成分支 | 固定一个上游 SHA，合并官方改动和已验收的 fork 差异，完成冲突处理、构建和数据副本验收，再进入 fork 自己的 PR |
| 功能／Bug 分支 | 从明确基线出发，单一目的、独立测试、可单独回馈上游；不夹带本机部署脚本或其他功能 |
| 本机部署 | 消费一套已构建、可识别的后端和前端产物；数据、凭据、端口和进程状态不进入源码提交 |
| 发行身份 | fork tag、官方基线 SHA、fork commit、补丁清单、产物哈希和验收记录共同确定，不能只看页面上的官方版本号 |

官方更新的正常路径是：`fetch upstream` → 固定同步目标 → 集成分支与 fork 差异合并 → fork PR／验收 → fork main → 构建同版本前后端 → 工作区副本验证 → 制作实例切换。同步本地跟踪引用不等于更新了 GitHub fork，也不等于更新了正在运行的实例。

已发布或被多人使用的 fork 历史保留，通过 merge 整合上游；不以 reset、force push 或整份文件覆盖代替冲突处理。独立、尚未发布的贡献分支可以对齐官方基线后提交评审。

### 当前热修必须按类别收敛

| 改动 | 性质与证据 | 归属与后续 |
| --- | --- | --- |
| 成功任务恢复仍回放完整绑定结果 | 仓库性能 Bug。恢复定时器每 5 秒重复构建已提交操作的画布结果；回归测试覆盖完成回执、参数冲突和调用方限制。修复跳过已完成结果重建，恢复定时器和未完成绑定保留 | 独立提交 `da9ff9f`，位于 `fix/canvas-idle-cpu-20261029`；需要按官方当前端口适配、验证后单独回馈 |
| 画布 SSE 每 250 毫秒完整读取 JSON | 仓库性能 Bug。只为 revision 检查加载整张画布；回归测试覆盖 ready、更新、删除断开、用户归属和不存在画布 | 独立提交 `ecf4809`，与恢复补丁可分别评审；不能把旧 app.Service 接口直接覆盖到官方已经拆分的窄端口 |
| Bun 开发服务改为 Node 静态构建预览 | 本机部署调整。移除开发服务的监听／现场转换负担；不能据此宣称修复了 Bun 长期资源增长的全部根因 | 私有启动配置与产物保存在 `.local`；需要可复现的部署说明和产物清单，不能并入通用性能 Bug PR，也不能当成主版本升级 |
| 原生 ComfyUI、模型用途、MCP 指南 | fork 功能增量，需要维护执行合同和与官方的差异 | 各自独立评审和回归；当前适配候选 PR #198 保留原范围，不夹带性能热修或界面重做 |
| 无关的已有本地修改 | 其他工作或未归档功能 | 保留原文件和归属，另列验收；不借本次提交顺带收走 |

这两个性能修复最初在本机热修生效，之后才整理为独立提交，当前尚未推送或提交官方 PR。它们的存在不能把原本未提交的运行状态追认为一个已经发布的 fork 版本。

迁移前核对得到的状态：fork `main` 在 `ddaf5f9`，完整功能分支在 `4bc049d`，两者相差 11 个 fork 提交；官方迁移目标固定为版本 `v2.0.5` 的 `d9f6ac7`。隔离集成分支目前存在 12 个文件冲突，尚未通过合并验收，不能替换制作实例。

### 控制长期差异，而不只是解开冲突标记

- 每项 fork 差异登记原始目的、修改模块、测试、官方是否已有等价实现、对应 Issue／PR 和维护状态。
- 缓存 revision 对账先与官方当前实现和测试核对，避免保留两套相近规则。
- 模型设置优先复用官方通用服务、凭据与参数校验；原生 ComfyUI 的工作流表单和音频用途保留明确入口，避免长期复制整份通用设置页面。
- 种子组件、固定参考计数等历史原型按既有审查记录处理；未接线或口径不准的实现不能因 merge 无冲突就记为已验收能力。
- 原生 ComfyUI 的内部接入与官方拟采用的扩展宿主分开记录；#198 是候选，不代表官方已接受完整 fork 的内置渠道和 UI。
- 官方吸收某项修复后，记录官方 merge SHA，并在后续集成中消解重复实现；保留历史和来源，不永久维护重复兼容层。

### 发行和切换的完成标准

1. 源码进入明确提交；热修、功能增量、文档和本机部署可以分别审核，没有未识别的 runtime-only 源码差异。
2. 同一 fork commit 构建后端、前端与 CLI；记录官方版本／SHA、fork tag／commit、保留补丁、依赖锁文件和产物 SHA-256。构建中间产物不提交 Git。
3. fork tag 使用独立命名空间，例如 `fork-v2.0.5-1`；这只是发行身份示例，未授权发布前不创建或宣称该发行版。官方 VERSION 不能替代 fork 身份。
4. 桌面 fork 发行必须核对更新源、签名与下载产物。官方发行工作流限制官方仓库，不能直接当作 fork 的发布通道；本机网页部署不等于已完成桌面更新渠道。
5. 在 SQLite 一致性备份、媒体和配置副本上跑迁移，核对项目、画布节点与连线、素材、模型连接及加密材料。密钥不进入公共清单。
6. 复验 MCP 发现与读写、历史媒体、原生 ComfyUI 受理／恢复／输出绑定；付费生成、代码测试、画质验收分别记证据。重复提交、取消和失败恢复不能只靠健康检查代替。
7. 用同一探针检查空闲、多通知连接和大画布；短窗口 CPU 下降不等于长期内存稳定性已通过。
8. 切换时前后端产物成套，保留代码产物与数据回滚点，记录实际进程使用的产物身份。未通过验收的同步分支不连接原始制作数据，不因页面可打开就标记完成。

开始新的生产批次或准备发布时核对官方差异，安全修复优先进入集成；普通更新以固定 SHA 批次推进，不在长任务运行中不断追逐移动的 main。Git 提交、fork PR、官方贡献、打 tag 和发布是不同动作；没有授权时不代替维护者合并或发版。

## 接手先做什么

1. **参与开发**：拉取下述 fork 分支，阅读根 [AGENTS.md](../AGENTS.md)、[协作约定](human-agent-workbench.md)，检查当前工作区和用户交付的任务范围。完成标准：确认分支、已有修改和负责文件。
2. **操作现有项目**：按[外部 Agent 接入](agent-onboarding.md)取得独立客户端配置，连接后调用 `beeftv_get_started`。完成标准：能发现目标画布、启用工作流和当前权限。
3. **从其他机器操作同一实例**：先完成本文“跨机器参与”中的连接验证。克隆源码并不会连接原工作区，也不会带来原项目、模型配置或客户端凭据。

## 项目定位

用户与 Agent 共同完成媒体业务。Agent 理解需求、准备资产、编排执行、评审返工并面向用户交付；用户参与选择、修改和验收。BeefTV 承载双方可见的项目、画布、材料、任务和结果，ComfyUI 执行媒体生成，FFmpeg 执行本地拼接与导出。

本 fork 保持独立界面。当前实机验证使用本地网页前端和独立 Go 后端，不是 ComfyUI 内部工作流或插件。本轮没有安装或发布包含 fork 功能的桌面应用；仓库上游仍有自己的 Wails 桌面产品与发行版。

外部 Agent 的日常入口已经收敛为 **MCP stdio**。CLI 启动同一个 MCP 服务并承担维护诊断；HTTP API 是底层业务接口。内置聊天模型不作为外部 Agent 工作的前提。

## 源码与贡献状态

| 对象 | 位置与含义 |
| --- | --- |
| 上游 | [glanderness/BeefTV](https://github.com/glanderness/BeefTV) |
| 完整 fork | [pipiaha/BeefTV](https://github.com/pipiaha/BeefTV)，分支 `codex/comfyui-native-media` |
| 上游贡献分支 | `codex/contrib-comfyui-extension`，与完整 fork 分支独立 |
| 上游贡献 PR | [#198](https://github.com/glanderness/BeefTV/pull/198)：交接时为 OPEN / Draft，仅提供后端原生适配候选及测试，尚未完成上游扩展集成 |
| 本轮 UI 贡献 | 已进入完整 fork，尚未另开上游 PR，也未自动进入 #198 |
| 发布状态 | 完整 fork 已推送；不等于上游已合并或已发布安装包 |

新机器获取完整代码：

```sh
git clone --branch codex/comfyui-native-media https://github.com/pipiaha/BeefTV.git
cd BeefTV
git status --short
git log -6 --oneline
```

主要提交：

| 提交 | 内容 |
| --- | --- |
| `bc113c9` | 用户原有缓存修复，按 revision 对账，避免旧浏览器缓存覆盖后端新画布 |
| `1f4ce4d` | 原生 ComfyUI 图片、视频、音频接入，以及多格式媒体导出 |
| `7826de6` | 人机协作工作台定位与职责约定 |
| `2e9bd8c` | MCP 自描述接入、首次指南、doctor 和全新客户端验收 |
| `015b538` | README 与工作台中的常驻 Agent 接入说明 |
| `710aa9c` | 模型设置重排、直接接入入口、音乐／配音／音效用途分类 |

后续贡献的讨论方向是：继续完善 #198 的扩展接入合同，设置界面另作依赖该接入能力的后续 PR。#198 当前不是可供用户直接使用的完整 ComfyUI 功能；它不注册内置渠道、HTTP 路由、MCP 工具或设置 UI。完整 fork 的内置接入方式不能直接等同于上游已接受的扩展方式。新 Agent 修改贡献分支前应重新读取 PR 描述与维护者反馈。

## 已完成的改造

| 模块 | 当前实现 |
| --- | --- |
| 原生生成 | `comfyui-image`、`comfyui-video`、`comfyui-audio` 接入既有持久任务与结果入库链路 |
| 工作流 | ComfyUI API JSON、标量与媒体字段映射、明确输出节点／字段、目标 `object_info` 预检 |
| 素材上传 | 先上传到 BeefTV 资源库；适配器将归属校验后的真实图片、视频、音频或 mask 字节上传到目标 ComfyUI，绑定相对文件名 |
| 恢复 | 保存已受理的 `prompt_id`；重连或重启后查询原任务；提交结果不确定时明确报告，不盲目重投 |
| 取消 | 优先精确取消；旧版本针对原排队 ID 删除并核实，不使用共享实例的全局中断 |
| 结果回填 | 沿用任务、resource、asset、画布绑定与引用关系，不把下载文件当成脱离项目的唯一成果 |
| 合成导出 | MP4 图像／视频拼接及音轨组合；WAV／MP3 音频处理；恰好两张静态图的 PNG／JPEG 联系表 |
| MCP 接入 | 首次握手说明、`beeftv_get_started`、内置操作指南、独立客户端身份与只读自检 |
| 模型设置 | 服务接入与默认模型分开；外层直接显示 API／ComfyUI 添加入口和用途筛选；连接、工作流、常用参数、输出、高级映射分层 |
| 音频用途 | 输出媒体仍为 `audio`；`audioUses` 独立记录 `music`、`speech`、`sound`，可多选，未分类显示为其他音频 |

音频用途不等于新执行协议。Music3 属于音乐，不据此声称配音、声音克隆或音效已经跑通。新音乐／音效配置不会默认套用配音的 `/audio/speech` 协议；未知用途保留待分类，而非按模型名猜测。

保存工作流名称时保留已有模型标识；共享连接保留其他工作流和连接信息。原有缓存修复的两个文件在本次 fork 改造中保持未改：`web/src/services/local-workspace-repository.ts`、`web/src/stores/canvas/use-canvas-store.ts`。

## 验证到了哪里

以下是既有实机验证记录，不代表新机器已经复验：

| 范围 | 证据与边界 |
| --- | --- |
| Qwen Image 2.1 | ComfyUI 0.37，参考图真实上传、生成、下载、入库及画布回填成功 |
| H3 图生视频 | ComfyUI 0.33，两段不同种子成功；每段 384×256、24 fps、39 帧，约 1.625 秒，4 步链路测试规格 |
| Music3 | 两段约 4 秒音乐生成成功；包含后端中断后继续同一远端 prompt 的恢复验证 |
| 参考音频／视频 | 真实上传、loader 读取、保存和结果取回成功；此项传输验证与新媒体生成分别记录 |
| 组合导出 | 15 秒 MP4 含真实 Qwen、H3 和 Music3；WAV／MP3、两图 PNG／JPEG 也通过完整媒体解码 |
| 全新 MCP 客户端 | 仅使用普通客户端配置，完成指南发现、上传登记、真实 Qwen 生成、重连原任务、结果绑定、MP4 导出、下载解码与评审回填 |
| 最新设置界面 | 实际保存、刷新恢复、JSON 错误、用途预选、明暗主题和窄窗口检查；Music3 音乐用途持久化；未额外调用 GPU |
| 代码验证 | 生成与任务相关后端专项、MCP／handler 测试、前端专项及正式构建有通过记录；最新用途调整针对 5 个前端文件执行 73 项测试通过 |

全新 MCP 客户端的一次贯穿验收使用的是“图片生成 → MP4 导出”，没有在同一轮重跑所有视频与音频生成；相关媒体生成由先前独立实机验收覆盖。CLI／MCP 的标准工具数量会随版本变化，以 `tools/list` 为准。

没有宣称全仓测试全绿或生产画质已验收。当前仍有本机 FFmpeg 缺少 subtitles/libass 导致的字幕验证缺口，以及部分测试依赖外部模型目录而发生网络超时。

## 关键代码与文档

| 要处理的工作 | 先读 |
| --- | --- |
| Agent 接入与任务操作 | [接入说明](agent-onboarding.md)、[编译内置指南](../backend/cmd/beeftv/agent-guide.md)、`backend/cmd/beeftv/onboarding.go` |
| 原生协议与恢复 | [后端合同](refactor/native-comfyui-contract.md)、`backend/internal/provider/workflow/native_comfyui.go`、`backend/internal/provider/comfyui/` |
| 服务检查 | `backend/internal/handler/native_comfyui.go`、`web/src/services/api/native-comfyui.ts` |
| 设置与用途 | [模型设置](model-settings.md)、`web/src/pages/settings/`、`web/src/lib/model-settings-catalog.ts`、`web/src/lib/native-comfyui.ts` |
| 合成导出 | `backend/internal/app/task_timeline.go`、`backend/internal/operations/canvas_render.go`、`backend/internal/mediatools/` |
| 配置持久化与凭据 | [持久化说明](local-model-config-persistence.md)、`backend/internal/workspace/provider_config.go` |
| 产品与交付 | [协作约定](human-agent-workbench.md)、根 [PRODUCT.md](../PRODUCT.md) |

生成任务应从实时模型配置复制实际 `graph`、`fields`、`outputNodeId`、`outputField`。任务的尺寸、帧数、步数和时长由实际图与映射决定；仅改显示名称或任务文案不会改变固定图参数。视频输出可能位于 `images` 或 `gifs` 字段，以节点真实返回值为准。

## 跨机器参与

### 只参与代码开发

新机器使用独立 checkout／分支，按模块约定文件范围。Git 同步源码、测试和文档；项目数据库、资源、模型配置、凭据和生成媒体不随 Git 同步。Go 与前端依赖以 `backend/go.mod`、Bun 锁文件和构建脚本为准；FFmpeg 能力另行检查。保留 Seal 移植部分的现有 NOTICE 与 MIT 归属。

改动提交到 fork 的协作分支再评审整合；每次交接记录基线 commit、负责范围、变更、验证与剩余问题。多个机器不能靠同步同一份 SQLite 或整份旧画布来协作。编辑运行中的画布前读取最新 revision，冲突时合并用户改动。

### 操作当前机器上的同一个工作区

现有验证部署只监听其主机的 loopback。远端 Agent 的 `127.0.0.1` 指向远端 Agent 自己；原连接 JSON 中的命令路径、数据目录也属于 BeefTV 主机，不能直接复制后期待生效。ComfyUI 主机和 BeefTV 主机是两个角色，连接 GPU 服务不等于连接到 BeefTV 的项目。

可评估 **SSH 承载 MCP stdio**：在 BeefTV 主机上运行既有 `beeftv mcp serve`，让另一台机器通过已授权 SSH 连接读写标准输入输出。下例仅为连接形状，跨机器路径尚未完成端到端实机验收：

```json
{
  "mcpServers": {
    "beeftv": {
      "command": "ssh",
      "args": ["-T", "BEEFTV_HOST_ALIAS", "/absolute/path/on/beeftv-host/run-beeftv-mcp"]
    }
  }
}
```

远端私有启动脚本应使用工作台为该 Agent 签发的独立客户端身份，设置正确的 `BEEFTV_BASE_URL`、`BEEFTV_DATA_DIR`，最后 `exec` 启动主机上的 CLI。凭据保留在主机私有配置中，不写进 SSH 参数、Git 或交接文档。MCP stdout 只传协议消息，诊断走 stderr。

此模式下 `filePath` 由 BeefTV 主机上的 MCP 进程读取；上传另一台机器的素材时，使用工具提供的 base64 文件参数、分片上传，或经授权先传到主机，不能把远端机器的文件路径当成本机路径。

跨机器完成标准：新机器完成握手、读取目标画布与权限；经用户授权上传一份素材、写一个独立测试节点、执行一个低开销生成／导出任务、下载检查，并确认用户界面可见。只做到 SSH 连通或 doctor 成功不能记为全流程通过。

### 在新机器独立部署

新实例有自己的数据目录、客户端身份和模型服务连接。按[接入部署说明](agent-onboarding.md)构建后端与相邻 `cli/beeftv`，按仓库开发／发行脚本启动，配置能从该机器访问的 ComfyUI。需要原项目时，使用受支持的导入导出或协调完整数据迁移；原目录名不能代替数据迁移。

原机器的便捷启动器、Vite 本机身份代理、验收工作流和证据属于部署材料，未作为通用安装器发布。另一台机器只克隆代码不保证拥有这些私有材料；通过授权读取现有工作区配置，或由用户单独交付所需材料。

## 数据与运行边界

- 开发数据位于 checkout 下的 `.local/project-workbench-debug`，是实际业务数据。迁移应同时处理 SQLite、资源文件、模型配置和必要的加密材料；停写／一致性备份后再迁移，凭据另行签发或安全迁移。
- 已验证工作流以无鉴权 LAN ComfyUI 为主；带鉴权服务和任意第三方节点组合仍需按对应目标验证。
- 历史上经用户明确批准，为 H3 实例增加了 `--lowvram` 并把内存／内存加交换空间限额提高到 28g/32g。不是原有限额下自然跑通，也不是今后任意改服务的授权。
- 一次 Compose 标签冲突曾影响另一图片实例，已恢复原代码与挂载、必要运行依赖，并通过真实 Qwen 再生成。这是已经发生的运维影响；后续操作应先核对各实例归属、挂载、队列及回滚材料。
- 共享 GPU 的服务按串行验证；生产分辨率、时长和并发会改变资源需求。配置模型缓存释放与服务重启是不同操作。

实际服务地址、现有画布 ID、启停脚本和凭据位置由实例持有人私下交付；本文不保存真实凭据或开发者绝对目录。连接后优先从 MCP 发现实时状态。

## 尚未完成与后续顺序

1. **跨机器接入验收**：建立每个 Agent 的独立身份，验证上述远程通道及素材路径，先只读再按授权执行最小业务链路。
2. **配音与音效**：选择实际模型／工作流，验证必要的文本、音色、参考音频等输入与结果质量。用途入口存在不等于已接入模型。
3. **生产规格与质量**：用代表性镜头验证更高分辨率、更多步数和更长时长；先评估显存／内存，生成成功与业务验收分别记录。
4. **统一导出体验**：补齐五种格式的前端选择与参数，验证 libass 字幕环境；图片导出的多图与版式能力另行设计。
5. **大媒体与恢复边界**：当前输入单文件最多 128 MiB、单次输出响应最多 256 MiB，使用内存与内联结果；MCP 简单上传上限为 64 MiB。需推进受管流式传输，并完善不确定取消的核对体验。
6. **业务可视化交付**：持续补齐需求、资产来源、版本比较、Agent 评审、用户反馈和下一步，让双方在同一画布对齐，而非只把技术任务成功作为最终交付。
7. **上游集成与发行**：先确认扩展宿主合同，整理底层与 UI 的贡献边界；桌面安装包、跨平台和迁移仍需独立构建验收。

## 按改动选择验证

仅文档变更检查引用和事实，不触发真实 GPU 任务。设置／协议／MCP 修改分别选择已有测试；以下命令从相应目录执行：

```sh
# web/
bun test test/model-settings-catalog.test.ts test/native-comfyui.test.ts test/model-service-presets.test.ts test/channel-model-catalog.test.ts test/workspace-model-config-persistence.test.ts
bun run build

# backend/
go test ./internal/provider/comfyui ./internal/provider/workflow ./internal/modelcatalog ./internal/task -count=1
go test ./cmd/beeftv ./internal/handler -count=1
```

真实新 Agent 验收入口是 `backend/cmd/beeftv/onboarding_live_test.go` 中的 `TestNewAgentFromMCPConfigOnly`。仅在用户授权真实生成、且提供有效私有 `BEEFTV_ONBOARDING_CONFIG` 后运行；缺少该变量时跳过。它会写入独立验收画布并消耗已配置模型资源。

该实机测试当前针对本机进程配置，检查配置内的客户端身份并上传测试进程本机的文件。SSH 样例不能原样套用此测试；远程验收需适配身份检查与文件传递，或用标准 MCP 客户端按上述完成标准逐项执行。

本机历史样片与运行回执由实例持有人保存，未上传 Git。拿不到原证据时，把对应结论记作既有验收记录，并对当前改动自行复验，不能改称新机器已验证。
