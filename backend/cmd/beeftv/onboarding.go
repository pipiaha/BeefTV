package main

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

//go:embed agent-guide.md
var agentGuide string

const agentInstructions = `BeefTV is the shared workbench for you and the user. You own requirements, materials, execution planning, review and delivery. Start with beeftv_get_started for the live workspace and operating guide. Use this MCP server's tools for all creative operations. Read current revisions before editing, preserve user changes, and reuse stable operation IDs when retrying. canvas.generation.propose only proposes; business_post_tasks executes authorized generation. Persist outputs and review findings back to the shared canvas. No knowledge from a previous chat is required.`

func registerOnboardingMCP(server *mcp.Server, c *client, business []businessTool, readOnly bool) {
	server.AddTool(&mcp.Tool{
		Name: "beeftv_get_started", Description: "新 Agent 首先调用：获取当前画布、已配置的原生工作流和完整操作指南；只读，不生成、不修改工作区。",
		InputSchema: map[string]any{"type": "object", "properties": map[string]any{}, "additionalProperties": false},
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true},
	}, func(ctx context.Context, _ *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		result, err := c.onboardingContext(ctx, business, readOnly)
		if err != nil {
			return toolError(err), nil
		}
		data, err := json.Marshal(result)
		if err != nil {
			return toolError(err), nil
		}
		return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: string(data)}}}, nil
	})
}

func (c *client) onboardingContext(ctx context.Context, business []businessTool, readOnly bool) (map[string]any, error) {
	// Refresh authorization even when the MCP session was opened before revocation.
	currentOps, err := c.listOpsCtx(ctx, readOnly)
	if err != nil {
		return nil, err
	}
	toolSet := map[string]bool{}
	canWrite := false
	for _, op := range currentOps {
		toolSet[op.ID] = true
		canWrite = canWrite || !op.ReadOnly
	}
	for _, tool := range business {
		if !readOnly || tool.ReadOnly {
			toolSet[tool.ID] = true
		}
	}
	result := map[string]any{"contractVersion": 1, "guide": agentGuide, "readOnly": !canWrite, "transport": "stdio", "canvases": []any{}, "nativeWorkflows": []any{}}
	if toolSet["canvas.search"] {
		raw, err := c.callOpCtx(ctx, "canvas.search", "", mustJSON(map[string]any{"page": 1, "pageSize": 5}))
		if err != nil {
			return nil, err
		}
		var payload struct {
			Result struct {
				Projects []map[string]any `json:"projects"`
				Total    int              `json:"total"`
			} `json:"result"`
		}
		if err := json.Unmarshal(raw, &payload); err != nil {
			return nil, err
		}
		canvases := make([]map[string]any, 0, len(payload.Result.Projects))
		for _, p := range payload.Result.Projects {
			canvases = append(canvases, map[string]any{"id": p["id"], "title": p["title"], "projectId": p["projectId"], "revision": p["revision"], "nodeCount": p["nodeCount"]})
		}
		result["canvases"], result["canvasCount"] = canvases, payload.Result.Total
	}
	if toolSet["business_get_workspace_model_config"] {
		raw, err := c.do(ctx, "GET", "/workspace/model-config", nil)
		if err != nil {
			return nil, err
		}
		var payload struct {
			Config struct {
				Channels []struct {
					ID       string   `json:"id"`
					Enabled  bool     `json:"enabled"`
					Models   []string `json:"models"`
					Profiles []struct {
						Model       string `json:"model"`
						DisplayName string `json:"displayName"`
						Protocol    string `json:"protocol"`
						AuthType    string `json:"authType"`
					} `json:"modelProfiles"`
				} `json:"channels"`
			} `json:"config"`
		}
		if err := json.Unmarshal(raw, &payload); err != nil {
			return nil, err
		}
		profiles := []map[string]any{}
		for _, ch := range payload.Config.Channels {
			if !ch.Enabled {
				continue
			}
			for _, p := range ch.Profiles {
				if !strings.HasPrefix(p.Protocol, "comfyui-") {
					continue
				}
				for _, enabled := range ch.Models {
					if enabled == p.Model {
						profiles = append(profiles, map[string]any{"channelId": ch.ID, "model": p.Model, "displayName": p.DisplayName, "protocol": p.Protocol, "authType": p.AuthType})
						break
					}
				}
			}
		}
		result["nativeWorkflows"] = profiles
	}
	return result, nil
}

// Doctor exercises the actual stdio connection with the official MCP client.
// It reads current workspace state and never creates a task or changes data.
func runMCPDoctor(args []string) error {
	fs := flag.NewFlagSet("mcp doctor", flag.ContinueOnError)
	_ = fs.Bool("json", false, "输出结构化自检结果")
	if err := fs.Parse(args); err != nil {
		return flagError(err)
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, executable, "mcp", "serve")
	var stderr bytes.Buffer
	command.Stderr = &stderr
	client := mcp.NewClient(&mcp.Implementation{Name: "beeftv-connection-doctor", Version: "1"}, nil)
	session, err := client.Connect(ctx, &mcp.CommandTransport{Command: command}, nil)
	if err != nil {
		return fmt.Errorf("MCP 连接自检失败：%w；%s", err, strings.TrimSpace(stderr.String()))
	}
	defer session.Close()
	tools, err := session.ListTools(ctx, nil)
	if err != nil {
		return err
	}
	guide, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "beeftv_get_started", Arguments: map[string]any{}})
	if err != nil {
		return err
	}
	if guide.IsError {
		var message strings.Builder
		for _, content := range guide.Content {
			if text, ok := content.(*mcp.TextContent); ok {
				message.WriteString(text.Text)
			}
		}
		return fmt.Errorf("MCP 使用指南自检失败：%s", message.String())
	}
	var contextInfo map[string]any
	for _, content := range guide.Content {
		if text, ok := content.(*mcp.TextContent); ok {
			if err := json.Unmarshal([]byte(text.Text), &contextInfo); err != nil {
				return err
			}
		}
	}
	if contextInfo["contractVersion"] != float64(1) {
		return fmt.Errorf("MCP 使用指南缺少有效 contractVersion")
	}
	return emitJSON(map[string]any{"ok": true, "transport": "stdio", "server": session.InitializeResult().ServerInfo, "instructionsAvailable": session.InitializeResult().Instructions != "", "toolCount": len(tools.Tools), "readOnly": contextInfo["readOnly"], "canvasCount": contextInfo["canvasCount"], "nativeWorkflows": contextInfo["nativeWorkflows"]})
}
