package workflow

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

func TestNativeComfyPollWaitsForHistoryPublication(t *testing.T) {
	for _, queuedBetweenGaps := range []bool{false, true} {
		name := "history appears after queue removal"
		if queuedBetweenGaps {
			name = "visible queue resets missing streak"
		}
		t.Run(name, func(t *testing.T) {
			historyReads := 0
			lastMissing := 5
			if queuedBetweenGaps {
				lastMissing = 18
			}
			exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
				if req.Method != http.MethodGet {
					t.Fatalf("resume must never submit or upload: %s %s", req.Method, req.URL)
				}
				switch {
				case strings.HasSuffix(req.URL, "/history/existing-id"):
					historyReads++
					if historyReads <= lastMissing {
						return []byte(`{}`), "application/json", nil
					}
					return []byte(`{"existing-id":{"status":{"status_str":"success","completed":true},"outputs":{"save":{"images":[{"filename":"out.png","subfolder":"","type":"output"}]}}}}`), "application/json", nil
				case strings.HasSuffix(req.URL, "/queue"):
					if queuedBetweenGaps && historyReads == 9 {
						return []byte(`{"queue_running":[[1,"existing-id"]],"queue_pending":[]}`), "application/json", nil
					}
					return []byte(`{"queue_running":[],"queue_pending":[]}`), "application/json", nil
				case strings.Contains(req.URL, "/view?"):
					return testPNG, "image/png", nil
				default:
					t.Fatalf("unexpected request: %s", req.URL)
					return nil, "", nil
				}
			}}
			input := Input{Mode: "image", LocalWorkspace: true, ResumedRequestID: "existing-id",
				Config: nativeComfyTestConfig("http://127.0.0.1:18188", "image", map[string]any{
					"save": map[string]any{"class_type": "SaveImage", "inputs": map[string]any{}},
				}, nil, "images")}
			result, err := productionClient(exec).RunNativeComfy(context.Background(), input)
			if err != nil {
				t.Fatalf("completed remote image was lost: %v", err)
			}
			if historyReads != lastMissing+1 {
				t.Fatalf("did not reach published history: %d", historyReads)
			}
			nativeComfyAssertResultBytes(t, result, "image", testPNG)
		})
	}
}
