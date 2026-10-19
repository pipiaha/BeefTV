# 外部 Agent 接入

外部 Agent 的日常创作入口统一使用标准 MCP stdio。CLI 是同一个 MCP 服务的启动程序，也用于诊断维护；HTTP API 是底层业务接口。Agent 不需要了解源码或先前聊天记录。

## 一次性连接

1. 启动 BeefTV，保持后端运行。浏览器用于查看和参与业务；内置聊天模型无需配置。
2. 打开「BeefTV MCP」，为新 Agent 添加连接。Codex、Claude Code 可使用生成的命令；其他客户端使用通用 MCP JSON。连接只持有自己的客户端身份。
3. 将 beeftv 服务项合并到 Agent 的 MCP 配置，保留已有服务。让客户端加载或重启该 MCP 连接。
4. 让 Agent 调用 beeftv_get_started。握手 instructions 和工具说明都会提示这个第一步。

标准配置形状如下，实际路径和凭据使用界面生成值：

```json
{
  "mcpServers": {
    "beeftv": {
      "command": "/absolute/path/to/cli/beeftv",
      "args": ["mcp", "serve"],
      "env": {
        "BEEFTV_DATA_DIR": "/absolute/path/to/workspace",
        "BEEFTV_CLIENT_ID": "由工作台签发",
        "BEEFTV_CLIENT_TOKEN": "由工作台签发"
      }
    }
  }
}
```

桌面应用通过工作区的运行时发现文件找到动态端口。本地 server 形态没有该文件，界面生成配置时会额外带上 BEEFTV_BASE_URL，使用当前后端地址；无需 Agent 猜端口。服务地址变化后重新生成配置。

MCP 进程在本机启动，读取本机文件并连接本机工作区。因此这里的“任意 Agent”指支持标准 MCP stdio、能运行该 MCP 程序并使用已授权身份的客户端。远端纯云 Agent 没有自动获得本机网络和文件访问能力；该部署不向公网开放。

## 新 Agent 从哪里开始

给 Agent 一句话即可：

> 连接 BeefTV，先调用 beeftv_get_started，读取当前项目、画布和可用工作流。按用户当前需求推进工作，把材料、结果和评审意见持续回填到工作台。已有任务先查询状态，写入前读取最新版本。

beeftv_get_started 只读，返回实时画布摘要、当前启用的原生 ComfyUI 模型、访问模式和完整操作指南。模型清单不返回渠道凭据。更完整的图和输入映射可用现有 business_get_workspace_model_config 读取，后端继续按外部身份脱敏。

完整指南编译在 MCP 程序中：[Agent 操作指南](../backend/cmd/beeftv/agent-guide.md)。它包括素材上传与登记、画布编辑、原生生成、幂等与恢复、结果绑定、导出下载，以及用户可见的评审记录。连接后即可获取，无需 Agent 先读仓库文件。

## 连接自检

使用连接配置中的同一组环境变量，运行：

```sh
/absolute/path/to/cli/beeftv mcp doctor --json
```

doctor 使用官方 MCP 客户端启动真正的 stdio 服务，完成握手、工具发现和 get_started 调用。它输出 ok、工具数、访问模式、画布数和工作流摘要，不创建任务或修改工作区。ok=true 证明当前连接可读；创作能力还应做实际写入和媒体任务验收。

常见问题：

| 现象 | 检查 |
|---|---|
| 找不到运行工作区 | BeefTV 是否启动；server 配置是否包含正确 BEEFTV_BASE_URL；桌面配置是否指向正确 BEEFTV_DATA_DIR |
| 未登记或凭据失效 | 在工作台重新签发该客户端连接，不使用 owner 或桌面令牌替代 |
| 只有只读能力 | 检查客户端登记模式及 mcp serve 是否带 --read-only；重新授权由工作台处理 |
| 没有 get_started 工具 | 更新 MCP 程序并重启该连接；旧的已启动进程不会自动替换 |
| 没有原生工作流 | 在模型配置中添加 API JSON 工作流并启用模型；然后重新调用 get_started |
| 安装文件不完整 | 检查随包 cli/beeftv 程序；源码开发按下文构建，不靠 PATH 猜其他程序 |

## 本地源码部署

后端程序同目录下应有 cli/beeftv，Windows 为 cli/beeftv.exe。这样桌面与网页形态使用相同的配置生成合同。开发时从 backend 目录构建：

```sh
go build -o ../.local/bin/beeftv-server ./cmd/server
go build -o ../.local/bin/cli/beeftv ./cmd/beeftv
```

使用独立开发数据目录和已有启动方式启动后端。网页形态的同源身份由部署代理处理，外部 Agent 继续使用界面签发的独立客户端凭据。连接 JSON 含客户端凭据，作为本机私有配置保存，不提交到 Git。

## 验收

最小验收是一个全新客户端只获得普通 MCP 配置，经由 MCP 完成：指南与模型发现、读取画布、上传并登记素材、编辑画布、提交持久任务、查询并绑定结果、导出下载，以及回填检查结论。用户界面应能读取同一组对象。

仓库提供 TestNewAgentFromMCPConfigOnly 可选实机测试：设置 BEEFTV_ONBOARDING_CONFIG 指向界面生成的通用配置后运行该测试。它使用已配置的无鉴权本地 ComfyUI 图片工作流做一次真实生成，再导出一秒 MP4 并完整解码。此测试会写入独立验收画布；未设置该变量时跳过，不调用真实模型。

协作定位见[人机协作工作台约定](human-agent-workbench.md)。任务执行成功与业务验收通过分别记录；接入协议不能代替 Agent 对用户需求的理解和评审责任。
