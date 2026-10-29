package handler

import (
	"net/http"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestNativeComfyInspectIsReadOnlyBusinessTool(t *testing.T) {
	catalog := NewBusinessCatalog(gin.RoutesInfo{{
		Method: http.MethodPost,
		Path:   "/api/configured-providers/comfyui/inspect",
	}})
	if len(catalog.Tools) != 1 {
		t.Fatalf("tools = %#v", catalog.Tools)
	}
	tool := catalog.Tools[0]
	if !tool.ReadOnly || tool.SubmitsGeneration || tool.ID != "business_post_configured_providers_comfyui_inspect" {
		t.Fatalf("tool = %#v", tool)
	}
}
