package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Opt-in real-workspace acceptance. The only connection input is an ordinary
// MCP client config, with a separately registered client and no chat history.
// It uploads its own fixture and uses a configured no-auth local image workflow.
func TestNewAgentFromMCPConfigOnly(t *testing.T) {
	configPath := os.Getenv("BEEFTV_ONBOARDING_CONFIG")
	if configPath == "" {
		t.Skip("set BEEFTV_ONBOARDING_CONFIG for real local generation acceptance")
	}
	var config struct {
		MCPServers map[string]struct {
			Command string            `json:"command"`
			Args    []string          `json:"args"`
			Env     map[string]string `json:"env"`
		} `json:"mcpServers"`
	}
	raw, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &config); err != nil {
		t.Fatal(err)
	}
	connection, found := config.MCPServers["beeftv"]
	if !found || connection.Command == "" || connection.Env["BEEFTV_CLIENT_ID"] == "" {
		t.Fatal("ordinary MCP client configuration required")
	}
	if connection.Env["BEEFTV_OWNER_TOKEN"] != "" || connection.Env["BEEFTV_DESKTOP_TOKEN"] != "" {
		t.Fatal("test requires external-client-only identity")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Minute)
	defer cancel()
	command := exec.CommandContext(ctx, connection.Command, connection.Args...)
	for _, value := range os.Environ() {
		key, _, _ := strings.Cut(value, "=")
		if !strings.HasPrefix(key, "BEEFTV_") && !strings.HasPrefix(key, "CANVAS_") {
			command.Env = append(command.Env, value)
		}
	}
	for key, value := range connection.Env {
		command.Env = append(command.Env, key+"="+value)
	}
	client := mcp.NewClient(&mcp.Implementation{Name: "fresh-generic-agent", Version: "1"}, nil)
	session, err := client.Connect(ctx, &mcp.CommandTransport{Command: command}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	if !strings.Contains(session.InitializeResult().Instructions, "beeftv_get_started") {
		t.Fatal("missing first-step instruction")
	}
	tools, err := session.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	available := map[string]bool{}
	for _, tool := range tools.Tools {
		available[tool.Name] = true
	}
	call := func(name string, args map[string]any) map[string]any {
		t.Helper()
		if !available[name] {
			t.Fatalf("guide refers to unavailable tool %s", name)
		}
		result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: args})
		if err != nil {
			t.Fatalf("%s transport: %v", name, err)
		}
		if result.IsError {
			t.Fatalf("%s: %s", name, toolText(result))
		}
		var decoded map[string]any
		if err := json.Unmarshal([]byte(toolText(result)), &decoded); err != nil {
			t.Fatalf("%s response: %v", name, err)
		}
		return decoded
	}
	started := call("beeftv_get_started", map[string]any{})
	if started["readOnly"] != false || started["contractVersion"] != float64(1) {
		t.Fatal("read-write onboarding not ready")
	}
	catalog := call("business_get_workspace_model_config", map[string]any{})
	var selectedChannel, selectedProfile map[string]any
	for _, rawChannel := range catalog["config"].(map[string]any)["channels"].([]any) {
		channel := rawChannel.(map[string]any)
		if channel["enabled"] != true {
			continue
		}
		profiles, _ := channel["modelProfiles"].([]any)
		models, _ := channel["models"].([]any)
		for _, rawProfile := range profiles {
			profile := rawProfile.(map[string]any)
			if profile["protocol"] != "comfyui-image" || profile["authType"] != "none" {
				continue
			}
			for _, model := range models {
				if model == profile["model"] {
					selectedChannel, selectedProfile = channel, profile
				}
			}
		}
	}
	if selectedProfile == nil {
		t.Fatal("real test needs an enabled no-auth local ComfyUI image workflow")
	}
	inspection := call("business_post_configured_providers_comfyui_inspect", map[string]any{"body": map[string]any{"baseUrl": selectedChannel["baseUrl"], "authType": "none"}})
	if inspection["nodes"] == nil {
		t.Fatal("selected ComfyUI service cannot be inspected")
	}
	tag := fmt.Sprintf("%d", time.Now().UnixNano())
	canvasID := "mcp-new-agent-" + tag
	resumed := false
	// A new process can resume a previous partial acceptance using only live
	// MCP discovery. It never loads the previous process's receipts or history.
	if candidates, ok := started["canvases"].([]any); ok {
		for _, candidate := range candidates {
			p := candidate.(map[string]any)
			id, _ := p["id"].(string)
			if !strings.HasPrefix(id, "mcp-new-agent-") {
				continue
			}
			doc := call("canvas.get", map[string]any{"canvasId": id})["result"].(map[string]any)["canvas"].(map[string]any)
			hasInput, hasOutput := false, false
			for _, value := range doc["nodes"].([]any) {
				n := value.(map[string]any)
				m, _ := n["metadata"].(map[string]any)
				if n["title"] == "02 · 自动上传参考图" && m["assetId"] != nil {
					hasInput = true
				}
				if n["title"] == "04 · 自动导出 MP4" && m["storageKey"] != nil {
					hasOutput = true
				}
			}
			if hasInput && !hasOutput {
				canvasID = id
				tag = strings.TrimPrefix(id, "mcp-new-agent-")
				resumed = true
				break
			}
		}
	}
	if !resumed {
		call("business_put_canvas_projects_id", map[string]any{"path": map[string]string{"id": canvasID}, "body": map[string]any{"project": map[string]any{"id": canvasID, "title": "新 Agent MCP 接入自检", "revision": 0, "nodes": []any{}, "connections": []any{}}}})
	}
	canvas := func() map[string]any {
		t.Helper()
		return call("canvas.get", map[string]any{"canvasId": canvasID})["result"].(map[string]any)["canvas"].(map[string]any)
	}
	if !resumed {
		call("canvas.nodes.create", map[string]any{"canvasId": canvasID, "expectedRevision": canvas()["revision"], "operationId": "new-agent-nodes-" + tag, "nodes": []any{
			map[string]any{"type": "text", "title": "01 · 接入与评审记录"}, map[string]any{"type": "image", "title": "02 · 自动上传参考图"}, map[string]any{"type": "image", "title": "03 · 原生 ComfyUI 新生成"}, map[string]any{"type": "video", "title": "04 · 自动导出 MP4"},
		}})
	}
	nodeIDs := map[string]string{}
	for _, value := range canvas()["nodes"].([]any) {
		node := value.(map[string]any)
		nodeIDs[node["title"].(string)] = node["id"].(string)
	}
	inputNode, imageNode, videoNode, reviewNode := nodeIDs["02 · 自动上传参考图"], nodeIDs["03 · 原生 ComfyUI 新生成"], nodeIDs["04 · 自动导出 MP4"], nodeIDs["01 · 接入与评审记录"]
	rid := ""
	if resumed {
		for _, v := range canvas()["nodes"].([]any) {
			n := v.(map[string]any)
			if n["id"] == inputNode {
				rid = strings.TrimPrefix(n["metadata"].(map[string]any)["storageKey"].(string), "resource:")
			}
		}
	} else {
		fixture := image.NewRGBA(image.Rect(0, 0, 384, 256))
		for y := 0; y < 256; y++ {
			for x := 0; x < 384; x++ {
				c := color.RGBA{uint8(30 + x/3), uint8(60 + y/3), 160, 255}
				if x > 145 && x < 240 && y > 60 && y < 200 {
					c = color.RGBA{240, 175, 70, 255}
				}
				fixture.SetRGBA(x, y, c)
			}
		}
		inputPath := filepath.Join(t.TempDir(), "reference.png")
		file, err := os.Create(inputPath)
		if err != nil {
			t.Fatal(err)
		}
		if err := png.Encode(file, fixture); err != nil {
			t.Fatal(err)
		}
		file.Close()
		upload := call("business_post_resources", map[string]any{"body": map[string]any{"kind": "image"}, "filePath": inputPath})
		resource, ok := upload["resource"].(map[string]any)
		if !ok {
			resource = upload
		}
		rid, _ = resource["id"].(string)
		if rid == "" {
			t.Fatal("upload did not return resource")
		}
		assetID := "new-agent-reference-" + tag
		inputInfo, err := os.Stat(inputPath)
		if err != nil {
			t.Fatal(err)
		}
		call("business_put_assets_id", map[string]any{"path": map[string]string{"id": assetID}, "body": map[string]any{"asset": map[string]any{"id": assetID, "kind": "image", "title": "新 Agent 自检参考图", "coverUrl": "/api/resources/" + rid + "/file", "tags": []string{}, "data": map[string]any{"storageKey": "resource:" + rid, "width": 384, "height": 256, "bytes": inputInfo.Size(), "mimeType": "image/png"}}}})
		call("canvas.node.bind_asset", map[string]any{"canvasId": canvasID, "nodeId": inputNode, "assetId": assetID, "expectedRevision": canvas()["revision"], "operationId": "new-agent-reference-" + tag})
	}
	prompt := "<image1> Keep the central golden object, use warm studio lighting and a clean cinematic blue background. No text."
	request := map[string]any{"projectId": canvasID, "type": "canvas_image", "provider": "comfyui", "model": selectedProfile["model"], "prompt": prompt, "input": map[string]any{
		"mode": "image", "prompt": prompt, "config": map[string]any{"apiFormat": "openai", "interfaceType": selectedProfile["protocol"], "baseUrl": selectedChannel["baseUrl"], "authType": "none", "model": selectedProfile["model"], "comfyui": selectedProfile["comfyui"]},
		"referenceImages": []any{map[string]any{"id": rid, "storageKey": "resource:" + rid, "mimeType": "image/png"}}, "metadata": map[string]any{"source": "canvas", "nodeId": imageNode, "clientOperationId": "new-agent-generation-" + tag},
	}}
	created := call("business_post_tasks", map[string]any{"body": request})
	taskID := created["id"].(string)
	trackTask := func(taskID, nodeID string) {
		t.Helper()
		doc := canvas()
		for _, v := range doc["nodes"].([]any) {
			n := v.(map[string]any)
			if n["id"] != nodeID {
				continue
			}
			m, _ := n["metadata"].(map[string]any)
			if m == nil {
				m = map[string]any{}
				n["metadata"] = m
			}
			if m["taskId"] == taskID {
				return
			}
			if current, _ := m["taskId"].(string); current != "" {
				t.Fatal("will not overwrite a different task")
			}
			m["taskId"] = taskID
			m["status"] = "loading"
		}
		call("canvas.document.commit", map[string]any{"canvasId": canvasID, "expectedRevision": doc["revision"], "document": doc, "operationId": "new-agent-track-" + taskID})
	}
	trackTask(taskID, imageNode)
	replay := call("business_post_tasks", map[string]any{"body": request})
	if replay["id"] != taskID {
		t.Fatal("generation replay created another task")
	}
	waitTask := func(id string) map[string]any {
		t.Helper()
		for {
			task := call("business_get_tasks_id", map[string]any{"path": map[string]string{"id": id}})
			switch task["status"] {
			case "succeeded":
				return task
			case "failed", "cancelled":
				t.Fatalf("task %s: %v", id, task["error"])
			}
			select {
			case <-ctx.Done():
				t.Fatal("generation/render timeout")
			case <-time.After(2 * time.Second):
			}
		}
	}
	generated := waitTask(taskID)
	bind := func(taskID, nodeID string) {
		t.Helper()
		call("canvas.task.bind", map[string]any{"canvasId": canvasID, "taskId": taskID, "nodeId": nodeID, "outputIndex": 0, "operationId": "attach-node:" + taskID + ":" + nodeID + ":0"})
	}
	bind(taskID, imageNode)
	generatedOutput := generated["outputs"].([]any)[0].(map[string]any)
	generatedRID := generatedOutput["resourceId"].(string)
	renderBody := map[string]any{"projectId": canvasID, "clientOperationId": "new-agent-render-" + tag, "timeline": map[string]any{"version": 2, "tracks": []any{map[string]any{"id": "v", "kind": "video", "visible": true}}, "clips": []any{map[string]any{"id": "c1", "nodeId": imageNode, "kind": "image", "trackId": "v", "startMs": 0, "durationMs": 1000, "directMedia": map[string]any{"id": "c1", "kind": "image", "storageKey": "resource:" + generatedRID}}}}, "options": map[string]any{"output": "video", "format": "mp4", "width": 384, "height": 256, "fps": 24, "burnSubtitles": false}}
	renderCreated := call("business_post_timeline_renders", map[string]any{"body": renderBody})
	renderID := renderCreated["id"].(string)
	trackTask(renderID, videoNode)
	rendered := waitTask(renderID)
	bind(renderID, videoNode)
	outputRID := rendered["outputs"].([]any)[0].(map[string]any)["resourceId"].(string)
	download := call("business_get_resources_id_file", map[string]any{"path": map[string]string{"id": outputRID}})
	data, err := base64.StdEncoding.DecodeString(download["data"].(string))
	if err != nil || len(data) == 0 {
		t.Fatal("MCP binary download failed")
	}
	outputPath := filepath.Join(t.TempDir(), "new-agent.mp4")
	if evidence := os.Getenv("BEEFTV_ONBOARDING_EVIDENCE"); evidence != "" {
		outputPath = filepath.Join(filepath.Dir(evidence), "beeftv-new-agent.mp4")
	}
	if err := os.WriteFile(outputPath, data, 0600); err != nil {
		t.Fatal(err)
	}
	if result, err := exec.CommandContext(ctx, "ffmpeg", "-v", "error", "-xerror", "-i", outputPath, "-f", "null", "-").CombinedOutput(); err != nil {
		t.Fatalf("full decode failed: %v %s", err, result)
	}
	for i, pair := range [][2]string{{inputNode, imageNode}, {imageNode, videoNode}} {
		call("canvas.edge.create", map[string]any{"canvasId": canvasID, "fromNodeId": pair[0], "toNodeId": pair[1], "expectedRevision": canvas()["revision"], "operationId": fmt.Sprintf("new-agent-edge-%s-%d", tag, i)})
	}
	call("canvas.node.update", map[string]any{"canvasId": canvasID, "nodeId": reviewNode, "expectedRevision": canvas()["revision"], "patch": map[string]any{"content": "接入自检通过：全程仅用标准 MCP 配置；发现工作区与工作流、上传、原生生图、回填、MP4 导出及完整解码均成功。此测试验证技术链路，不代表生产画质验收。"}, "operationId": "new-agent-review-" + tag})
	final := canvas()
	if len(final["nodes"].([]any)) != 4 {
		t.Fatal("canvas lost nodes")
	}
	if evidence := os.Getenv("BEEFTV_ONBOARDING_EVIDENCE"); evidence != "" {
		record := map[string]any{"client": "official MCP SDK; ordinary generated config only", "toolCount": len(tools.Tools), "canvasId": canvasID, "generationTaskId": taskID, "renderTaskId": renderID, "nativeModel": selectedProfile["model"], "resumedPriorMCPWorkFromWorkspace": resumed, "generationIdempotent": true, "fullDecodeSucceeded": true, "outputFile": outputPath, "guideContractVersion": started["contractVersion"], "allBusinessActionsViaMCP": true, "canvasNodeCount": len(final["nodes"].([]any)), "canvasConnectionCount": len(final["connections"].([]any))}
		body, _ := json.MarshalIndent(record, "", "  ")
		if err := os.WriteFile(evidence, body, 0600); err != nil {
			t.Fatal(err)
		}
	}
	t.Logf("MCP client verified %s output and completed canvas binding -> MP4 export -> download/decode/review; resumed prior MCP work=%v; canvas=%s", selectedProfile["model"], resumed, canvasID)
}
