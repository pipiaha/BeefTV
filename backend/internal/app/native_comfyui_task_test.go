package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/platform"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestNativeComfyConfirmedCancellationIsPersistedWithoutHistory(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/jobs/original-prompt/cancel" {
			t.Errorf("confirmed cancellation should not wait for history: %s", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		w.Write([]byte(`{"cancelled":true}`))
	}))
	defer server.Close()
	db, err := gorm.Open(sqlite.Open("file:"+newID()+"?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(database.LocalModels()...); err != nil {
		t.Fatal(err)
	}
	task := model.Task{ID: newID(), UserID: "user", Type: "canvas_video", Status: model.TaskStatusCancelled,
		ProviderRequestID: "original-prompt", InputJSON: mustJSON(map[string]any{"mode": "video", "config": map[string]any{
			"interfaceType": "comfyui-video", "baseUrl": server.URL, "authType": "none",
		}})}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	service := &Service{repo: repository.New(db), coordinator: platform.NewLocalCoordinator()}
	if err := service.requestProviderCancellation(context.Background(), &task); err != nil {
		t.Fatal(err)
	}
	stored, err := service.repo.TaskForUser(task.UserID, task.ID)
	if err != nil || stored.ProviderCancelStatus != model.ProviderCancelStatusConfirmed || stored.ProviderCancelledAt == nil {
		t.Fatalf("cancellation receipt was not durable: task=%+v err=%v", stored, err)
	}
}

func TestNativeComfyTaskCapabilityAllowsAllModesWithoutPromptOrKey(t *testing.T) {
	for _, mode := range []string{"image", "video", "audio"} {
		input := map[string]any{
			"mode": mode,
			"config": map[string]any{
				"interfaceType": "comfyui-" + mode,
				"baseUrl":       "http://127.0.0.1:18188",
				"authType":      "none",
				"comfyui": map[string]any{
					"graph": map[string]any{
						"1":    map[string]any{"class_type": "Source", "inputs": map[string]any{"value": "fixed"}},
						"save": map[string]any{"class_type": "Save", "inputs": map[string]any{"value": []any{"1", 0}}},
					},
					"outputNodeId": "save",
					"outputField":  "images",
				},
			},
		}
		if err := (&Service{}).ValidateTaskCapability(input); err != nil {
			t.Fatalf("mode %s: %v", mode, err)
		}
	}
}

func TestNativeComfyTaskAdmissionPersistsGraphInput(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:"+newID()+"?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(database.LocalModels()...); err != nil {
		t.Fatal(err)
	}
	input := map[string]any{
		"mode": "image",
		"config": map[string]any{
			"interfaceType": "comfyui-image",
			"baseUrl":       "http://127.0.0.1:18188",
			"authType":      "none",
			"comfyui": map[string]any{
				"graph": map[string]any{
					"save": map[string]any{"class_type": "SaveImage", "inputs": map[string]any{"images": []any{}}},
				},
				"outputNodeId": "save",
				"outputField":  "images",
			},
		},
	}
	task, err := (&Service{repo: repository.New(db)}).CreateTask("user", CreateTaskRequest{
		Type: "canvas_image", Input: input,
	})
	if err != nil {
		t.Fatal(err)
	}
	if task.Status != model.TaskStatusQueued || task.InputJSON == "" {
		t.Fatalf("task = %#v", task)
	}
}
