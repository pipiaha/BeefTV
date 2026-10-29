package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestOnboardingDiscoversCurrentWorkspaceWithoutReturningCredentials(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var data any
		switch r.URL.Path {
		case "/ops":
			data = map[string]any{"ops": []any{map[string]any{"id": "canvas.search", "readOnly": true}, map[string]any{"id": "canvas.nodes.create", "readOnly": false}}}
		case "/ops/canvas.search":
			data = map[string]any{"result": map[string]any{"total": 1, "projects": []any{map[string]any{"id": "current-canvas", "title": "Current", "revision": 3, "nodeCount": 2, "private": "unexpected-secret"}}}}
		case "/workspace/model-config":
			data = map[string]any{"config": map[string]any{"apiKey": "provider-secret", "channels": []any{map[string]any{"id": "lan", "enabled": true, "models": []string{"qwen"}, "modelProfiles": []any{
				map[string]any{"model": "qwen", "protocol": "comfyui-image", "displayName": "Local image", "authType": "none", "apiKey": "profile-secret"},
				map[string]any{"model": "disabled", "protocol": "comfyui-video"},
			}}}}}
		default:
			t.Errorf("unexpected request: %s", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": data})
	}))
	defer server.Close()
	t.Setenv("BEEFTV_BASE_URL", server.URL)
	c, err := newClient()
	if err != nil {
		t.Fatal(err)
	}
	result, err := c.onboardingContext(context.Background(), []businessTool{{ID: "business_get_workspace_model_config", ReadOnly: true}}, false)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(result)
	for _, secret := range []string{"provider-secret", "profile-secret", "unexpected-secret", "disabled"} {
		if strings.Contains(string(raw), secret) {
			t.Fatalf("onboarding exposed a secret or disabled profile: %s", secret)
		}
	}
	if !strings.Contains(string(raw), "current-canvas") || !strings.Contains(string(raw), "qwen") || result["readOnly"] != false {
		t.Fatalf("missing live state: %s", raw)
	}
}

func TestServerReadOnlyIdentityNarrowsMCPDiscovery(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"code":0,"data":{"readOnly":true,"ops":[{"id":"canvas.get","readOnly":true},{"id":"canvas.nodes.create","readOnly":false}]}}`))
	}))
	defer server.Close()
	t.Setenv("BEEFTV_BASE_URL", server.URL)
	c, err := newClient()
	if err != nil {
		t.Fatal(err)
	}
	ops, err := c.listOps(false)
	if err != nil || len(ops) != 1 || ops[0].ID != "canvas.get" || !c.readOnly {
		t.Fatalf("server identity was not respected: ops=%+v err=%v", ops, err)
	}
}
