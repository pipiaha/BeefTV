package handler

import (
	"encoding/json"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/agentops"
)

func TestAgentClientSetupWorksForServerAndDesktopWorkspaces(t *testing.T) {
	reg := agentops.ClientRegistration{ID: "new-agent", Mode: agentops.ClientReadWrite}
	for _, baseURL := range []string{"", "http://127.0.0.1:23456/api"} {
		for _, kind := range []agentops.ClientKind{agentops.ClientKindCodex, agentops.ClientKindClaude, agentops.ClientKindClaudeDesktop, agentops.ClientKindCursor, agentops.ClientKindOther} {
			setup := clientSetup(kind, "/app/cli/beeftv", "/work space/data", reg, "client-token", baseURL)
			if command, ok := setup["command"].(string); ok {
				if !strings.Contains(command, "mcp serve") || !strings.Contains(command, "client-token") {
					t.Fatalf("invalid command for %s", kind)
				}
				if strings.Contains(command, "BEEFTV_BASE_URL") != (baseURL != "") {
					t.Fatalf("wrong runtime discovery for %s: %s", kind, command)
				}
				continue
			}
			var config struct {
				MCPServers map[string]struct {
					Command string            `json:"command"`
					Args    []string          `json:"args"`
					Env     map[string]string `json:"env"`
				} `json:"mcpServers"`
			}
			if err := json.Unmarshal([]byte(setup["json"].(string)), &config); err != nil {
				t.Fatal(err)
			}
			server := config.MCPServers["beeftv"]
			if server.Command != "/app/cli/beeftv" || len(server.Args) != 2 || server.Env["BEEFTV_BASE_URL"] != baseURL || server.Env["BEEFTV_CLIENT_ID"] != reg.ID {
				t.Fatalf("incomplete portable MCP config: %+v", server)
			}
			if _, exists := server.Env["BEEFTV_OWNER_TOKEN"]; exists {
				t.Fatal("owner token exposed")
			}
		}
	}
}
