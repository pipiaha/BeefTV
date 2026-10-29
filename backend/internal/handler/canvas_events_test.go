package handler

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"gorm.io/gorm"
)

func TestCanvasEventsPollsRevisionWithoutLoadingDocument(t *testing.T) {
	env := newAssistantTestEnv(t, nil)
	RegisterUserDataRoutes(env.router.Group("/api"), env.service)
	db := env.service.Database()
	var fullReads atomic.Int64
	if err := db.Callback().Query().Before("gorm:query").Register("canvas_event_payload_reads", func(tx *gorm.DB) {
		if tx.Statement.Schema != nil && tx.Statement.Schema.Name == "CanvasProject" && len(tx.Statement.Selects) == 0 {
			fullReads.Add(1)
		}
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Callback().Query().Remove("canvas_event_payload_reads") })
	server := httptest.NewServer(env.router)
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+"/api/canvas-projects/"+env.canvasID+"/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("SSE status = %d", response.StatusCode)
	}
	reader := bufio.NewReader(response.Body)
	readEvent := func() string {
		t.Helper()
		var event strings.Builder
		for {
			line, readErr := reader.ReadString('\n')
			if readErr != nil {
				t.Fatal(readErr)
			}
			event.WriteString(line)
			if line == "\n" {
				return event.String()
			}
		}
	}
	if ready := readEvent(); !strings.Contains(ready, "event: ready\n") || !strings.Contains(ready, `"revision":1`) {
		t.Fatalf("ready event = %q", ready)
	}
	time.Sleep(600 * time.Millisecond)
	if reads := fullReads.Load(); reads != 0 {
		t.Fatalf("idle SSE loaded the full canvas %d times", reads)
	}
	owner, err := env.service.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := env.service.UserCanvasProject(owner.ID, env.canvasID)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	doc["title"] = "Updated during stream"
	updated, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := env.service.UpsertUserCanvasProject(owner.ID, updated); err != nil {
		t.Fatal(err)
	}
	if event := readEvent(); !strings.Contains(event, "event: canvas.updated\n") || !strings.Contains(event, `"revision":2`) {
		t.Fatalf("update event = %q", event)
	}
	if _, err := env.service.UserCanvasProjectRevision("other-owner", env.canvasID); err == nil {
		t.Fatal("revision query exposed another owner's canvas")
	}
	if _, err := env.service.UserCanvasProjectRevision(owner.ID, "missing-canvas"); err == nil {
		t.Fatal("missing canvas did not return an error")
	}
	if err := env.service.CanvasService().DeleteUserCanvasProject(owner.ID, env.canvasID); err != nil {
		t.Fatal(err)
	}
	if _, err := reader.ReadString('\n'); err != io.EOF {
		t.Fatalf("deleted canvas stream should close, got %v", err)
	}
}
